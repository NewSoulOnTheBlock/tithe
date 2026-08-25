// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";
import {
    IWETH,
    IBeefyVaultConcLiq,
    IBeefyRewardPool,
    IUniswapV3PoolMin
} from "../interfaces/IBeefyCLM.sol";
import {FullMath, TickMath} from "../libraries/UniV3Math.sol";

/**
 * @title BeefyCLMAdapter
 * @notice ETH-in / ETH-out adapter over a **Beefy Cowcentrated Liquidity
 *         Manager** vault, so corpus ETH can be deployed to Beefy without
 *         leaving the Treasury's accounting.
 *
 * ## What this replaces
 *
 * Today the route is `Treasury.withdraw()` → operator EOA → beefy.com zap →
 * the operator personally holds the position. That works, but it is manual, and
 * — more importantly — the deployed ETH **leaves `nav()` entirely**, so the
 * reported floor drops by the full amount deployed and the position backs
 * nothing on-chain. With this adapter the ETH stays inside `nav()` the whole
 * time and the floor stops lying about the corpus.
 *
 * ## Why this is not simply "the zap, on-chain"
 *
 * Beefy's own zap (`BeefyZapRouter.executeOrder`) takes a **route computed
 * off-chain** — an array of pre-encoded calls. A contract cannot produce that
 * for itself. So this adapter does the equivalent work natively:
 *
 * ```
 * deposit(ETH)
 *   → wrap to WETH
 *   → swap the correct fraction to the paired token, straight through the
 *     Uniswap v3 pool (no router, no path encoding, no off-chain route)
 *   → CLM.deposit(amount0, amount1, minShares)
 *   → RewardPool.stake(shares)
 * ```
 *
 * The split is derived from the vault's live `balances()` ratio, so the deposit
 * lands in-ratio and mints the shares it should rather than being diluted.
 *
 * ## The number that matters most: `totalAssets()`
 *
 * This feeds `Treasury.nav()`, which sets `floorPerToken()`, which sets the
 * **redemption price**. On a pool this thin (the STONKBROKER/WETH pool this was
 * built against holds ~1.8 ETH in total) spot price is cheap to move, so a
 * naive mark-to-market here would be a direct theft vector — exactly the
 * warning in spec §6.3.
 *
 * Three layers answer that:
 *
 * 1. **Valuation takes `min(spot, TWAP)`.** The paired leg is valued at both
 *    the live pool price and a `twapSeconds` TWAP, and the *lower* result wins.
 *    Pumping spot cannot raise reported assets; crashing it only understates
 *    them, which is the safe direction.
 * 2. **The Treasury already caps corpus at `min(totalAssets, principal)`**
 *    (`Treasury.adapterCorpus`), so no reading of this contract can inflate NAV
 *    above the ETH actually deployed. Upward manipulation has no payoff there.
 * 3. **`realizeSurplus()` — the one path that pays value *out* on a price
 *    reading — additionally requires Beefy's `isCalm()`** (their own TWAP
 *    deviation guard) and a cooldown. That closes the remaining vector: pump
 *    the pool, then have the permissionless `Treasury.realizeSurplus()` convert
 *    fictitious appreciation into staker income.
 *
 * ## Impermanent loss is real and is NOT hedged
 *
 * A CLM position is a concentrated two-asset LP. If the paired token falls, the
 * position converts into that token and the ETH value of the corpus falls with
 * it. `principal()` is a high-water mark, so a loss below it is reported
 * honestly: NAV drops, the floor drops, and `FloorRegression` fires. Nothing
 * here prevents that — only the sleeve cap bounds how much of the corpus is
 * exposed. Spec §4.3 says never to point this at a memecoin pair for exactly
 * this reason.
 *
 * ## Trust surface
 *
 * The venue addresses are all `immutable`: this adapter cannot be repointed at
 * a different vault or pool after deployment. To change venue, deploy a new
 * adapter and let the Treasury's 2-day `queueAdapter` timelock run. The owner
 * can only tune bounded risk parameters, and there is no path that sends value
 * anywhere except back to the Treasury.
 */
contract BeefyCLMAdapter is IYieldAdapter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 1 << 96;

    // -----------------------------------------------------------------------
    // Immutable wiring
    // -----------------------------------------------------------------------

    /// @notice The only address that may deposit, withdraw, or realize here.
    address public immutable treasury;

    IBeefyVaultConcLiq public immutable clm;

    /// @notice The `-rp` wrapper. May be `address(0)` for a bare CLM vault.
    IBeefyRewardPool public immutable rewardPool;

    /// @notice The underlying Uniswap v3 pool, used for the in-ratio swap and
    ///         as the TWAP source.
    IUniswapV3PoolMin public immutable pool;

    IWETH public immutable weth;

    /// @notice The non-WETH side of the pair.
    IERC20 public immutable paired;

    /// @notice True when WETH is `token0` of the pool.
    bool public immutable wethIsToken0;

    // -----------------------------------------------------------------------
    // Risk parameters — all bounded
    // -----------------------------------------------------------------------

    uint32 public twapSeconds = 1800;
    uint32 public constant MIN_TWAP_SECONDS = 60;
    uint32 public constant MAX_TWAP_SECONDS = 86_400;

    /// @notice Max |spot tick − TWAP tick| tolerated when trading. ~200 ≈ 2%.
    int24 public maxTickDeviation = 200;
    int24 public constant MAX_TICK_DEVIATION_LIMIT = 2_000;

    /// @notice Slippage tolerance applied to CLM mint/burn previews.
    uint16 public slippageBps = 100;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;

    /**
     * @notice Hard ceiling on this adapter's share of the CLM vault.
     * @dev Spec §4.3's second cap. The vault this was written against holds
     *      ~1.8 ETH in total, so without this the corpus becomes the pool: its
     *      own deposit collapses the APY and cannot be exited without severe
     *      slippage. Capacity, not APY, is the binding constraint here.
     */
    uint16 public maxVaultShareBps = 2_000;
    uint16 public constant MAX_VAULT_SHARE_LIMIT = 5_000;

    /// @notice Minimum spacing between surplus realizations.
    uint32 public realizeCooldown = 1 hours;
    uint256 public lastRealizeAt;

    // -----------------------------------------------------------------------
    // Accounting
    // -----------------------------------------------------------------------

    /// @dev Corpus ETH deployed here, net of withdrawals. The high-water mark
    ///      spec §9 requires: it moves only on principal flows, never on price.
    uint256 private _principal;

    /// @dev Set for the duration of our own pool swap, so the callback can
    ///      reject any call the pool did not make on our behalf.
    bool private _swapping;

    // -----------------------------------------------------------------------
    // Events / errors
    // -----------------------------------------------------------------------

    event Deployed(uint256 ethIn, uint256 sharesMinted, uint256 principalAfter);
    event Unwound(uint256 sharesBurned, uint256 ethOut, uint256 principalAfter);
    event SurplusRealized(uint256 assets, uint256 principalNow, uint256 sent);
    event RewardsClaimed();
    event RewardTokenSwept(address indexed token, uint256 amount);
    event ParamsSet(uint32 twapSeconds, int24 maxTickDeviation, uint16 slippageBps, uint16 maxVaultShareBps);
    event RealizeCooldownSet(uint32 seconds_);

    error NotTreasury();
    error NotPool();
    error UnexpectedCallback();
    error ZeroAddress();
    error NothingToDeposit();
    error PriceOutOfBand(int24 spotTick, int24 twapTick, int24 maxDeviation);
    error NotCalm();
    error VaultShareCapExceeded(uint256 wouldBeBps, uint256 capBps);
    error EthTransferFailed();
    error BadParam();
    error PairMismatch();
    error CooldownActive(uint256 readyAt);
    error CannotSweepPairToken();

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /**
     * @param treasury_   The LOYAL Treasury. Immutable — value can go nowhere else.
     * @param clm_        Beefy `BeefyVaultConcLiq` clone.
     * @param rewardPool_ Its `-rp` wrapper, or `address(0)` if the vault has none.
     * @param weth_       WETH on this chain.
     * @param owner_      Governance. Tunes bounded risk parameters only.
     */
    constructor(
        address treasury_,
        address clm_,
        address rewardPool_,
        address weth_,
        address owner_
    ) Ownable(owner_) {
        if (treasury_ == address(0) || clm_ == address(0) || weth_ == address(0)) {
            revert ZeroAddress();
        }

        treasury = treasury_;
        clm = IBeefyVaultConcLiq(clm_);
        rewardPool = IBeefyRewardPool(rewardPool_);
        weth = IWETH(weth_);

        // Derive the pool and the pair from the vault itself rather than taking
        // them as arguments: a mismatched pool would silently price the
        // position against the wrong market.
        IUniswapV3PoolMin p = IUniswapV3PoolMin(IBeefyStrategyPool(clm.strategy()).pool());
        pool = p;

        (address t0, address t1) = clm.wants();
        if (t0 != p.token0() || t1 != p.token1()) revert PairMismatch();

        if (t0 == weth_) {
            wethIsToken0 = true;
            paired = IERC20(t1);
        } else if (t1 == weth_) {
            wethIsToken0 = false;
            paired = IERC20(t0);
        } else {
            revert PairMismatch();
        }

        if (rewardPool_ != address(0) && IBeefyRewardPool(rewardPool_).stakedToken() != clm_) {
            revert PairMismatch();
        }
    }

    receive() external payable {}

    // =======================================================================
    // IYieldAdapter — principal flows
    // =======================================================================

    /**
     * @notice Deploy the attached ETH into the CLM vault.
     * @dev Reverts rather than partially deploying: a deposit that silently
     *      left ETH idle would report as deployed while earning nothing.
     */
    function deposit() external payable override onlyTreasury nonReentrant {
        uint256 amount = msg.value;
        if (amount == 0) revert NothingToDeposit();

        _principal += amount;

        weth.deposit{value: amount}();
        uint256 minted = _deployIdle();

        emit Deployed(amount, minted, _principal);
    }

    /**
     * @notice Return up to `amount` wei to the Treasury.
     * @dev May return less than requested — the interface allows it, and
     *      forcing an exact amount out of a concentrated LP would mean
     *      accepting arbitrary slippage to hit a round number.
     */
    function withdraw(uint256 amount)
        external
        override
        onlyTreasury
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 burned = _unwindToEth(amount);

        uint256 available = address(this).balance;
        withdrawn = available < amount ? available : amount;

        _principal = _principal > withdrawn ? _principal - withdrawn : 0;

        if (withdrawn != 0) {
            (bool ok, ) = treasury.call{value: withdrawn}("");
            if (!ok) revert EthTransferFailed();
        }

        // A full exit clears the high-water mark. Round-trip cost means
        // `_principal` would otherwise settle at the realized loss and sit
        // there — harmless while empty, but it would suppress the first
        // surplus of any later redeployment by that stale amount.
        if (sharesHeld() == 0 && totalAssets() == 0) _principal = 0;

        emit Unwound(burned, withdrawn, _principal);
    }

    /**
     * @notice Send appreciation above the principal high-water mark to the
     *         Treasury, which earmarks it as staker income.
     * @dev Returns 0 rather than reverting when there is nothing to realize —
     *      `Treasury.realizeSurplus()` is permissionless, and making a routine
     *      no-op revert would turn a keeper call into a failed transaction.
     *
     *      Guarded by Beefy's `isCalm()` and a cooldown, because this is the
     *      only function whose payout is a function of a price reading.
     */
    function realizeSurplus()
        external
        override
        onlyTreasury
        nonReentrant
        returns (uint256 realized)
    {
        uint256 assets = totalAssets();
        uint256 p = _principal;
        if (assets <= p) return 0;

        if (block.timestamp < lastRealizeAt + realizeCooldown) {
            revert CooldownActive(lastRealizeAt + realizeCooldown);
        }
        if (!clm.isCalm()) revert NotCalm();

        uint256 excess = assets - p;
        lastRealizeAt = block.timestamp;

        _unwindToEth(excess);

        uint256 available = address(this).balance;
        realized = available < excess ? available : excess;

        if (realized != 0) {
            (bool ok, ) = treasury.call{value: realized}("");
            if (!ok) revert EthTransferFailed();
        }

        // Principal is deliberately unchanged: it is a high-water mark, and any
        // ETH left over above `realized` stays deployed rather than being paid
        // out of corpus.
        emit SurplusRealized(assets, p, realized);
    }

    // =======================================================================
    // IYieldAdapter — views. Neither may revert.
    // =======================================================================

    /// @inheritdoc IYieldAdapter
    function principal() external view override returns (uint256) {
        return _principal;
    }

    /**
     * @notice Value of everything this adapter holds, in wei.
     * @dev Wrapped so a failed oracle or vault read returns 0 instead of
     *      reverting. `Treasury.nav()` sums this and `payout()` touches
     *      `nav()`, so a revert here would brick redemption for everyone —
     *      spec's stated reason for valuing an unreadable adapter at zero.
     *
     *      A zero here is therefore "unreadable", not "worthless". Monitor
     *      `healthy()`.
     */
    function totalAssets() public view override returns (uint256) {
        try this.grossAssets() returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }

    /// @notice True when every read `totalAssets()` depends on is answering.
    function healthy() external view returns (bool) {
        try this.grossAssets() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @notice The uncaught version of `totalAssets()`. External so the guarded
     *         version above can `try` it; not meant to be called directly.
     */
    function grossAssets() external view returns (uint256) {
        uint256 shares = sharesHeld();

        uint256 idleWeth = weth.balanceOf(address(this));
        uint256 idlePaired = paired.balanceOf(address(this));
        uint256 idleEth = address(this).balance;

        uint256 amount0;
        uint256 amount1;
        if (shares != 0) {
            (amount0, amount1) = clm.previewWithdraw(shares);
        }

        // Fold idle balances into the same two-token frame before pricing, so
        // one conversion covers the position and anything sitting loose.
        if (wethIsToken0) {
            amount0 += idleWeth;
            amount1 += idlePaired;
        } else {
            amount0 += idlePaired;
            amount1 += idleWeth;
        }

        return idleEth + _valueConservative(amount0, amount1);
    }

    /// @notice CLM shares held, staked or loose.
    function sharesHeld() public view returns (uint256) {
        uint256 loose = clm.balanceOf(address(this));
        if (address(rewardPool) == address(0)) return loose;
        return loose + rewardPool.balanceOf(address(this));
    }

    /// @notice This adapter's share of the whole CLM vault, in bps.
    function vaultShareBps() public view returns (uint256) {
        uint256 supply = clm.totalSupply();
        if (supply == 0) return 0;
        return (sharesHeld() * BPS) / supply;
    }

    /// @notice Unrealized appreciation above the high-water mark, in wei.
    function surplus() external view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > _principal ? assets - _principal : 0;
    }

    /// @notice Spot and TWAP ticks, for monitoring the band the trades require.
    function ticks() external view returns (int24 spotTick, int24 twapTick, bool inBand) {
        (, spotTick, , , , , ) = pool.slot0();
        twapTick = _twapTick();
        int24 d = spotTick > twapTick ? spotTick - twapTick : twapTick - spotTick;
        inBand = d <= maxTickDeviation;
    }

    // =======================================================================
    // Rewards
    // =======================================================================

    /**
     * @notice Pull any reward tokens the `-rp` wrapper has streamed.
     * @dev Permissionless: it can only move value toward this contract. The
     *      wrapper this was built against currently streams **nothing**
     *      (`rewardsLength() == 0`), so this is forward-cover for Beefy turning
     *      incentives on later.
     */
    function claimRewards() external {
        if (address(rewardPool) != address(0)) {
            rewardPool.getReward();
            emit RewardsClaimed();
        }
    }

    /**
     * @notice Forward a stray reward token to the Treasury.
     * @dev Destination is hard-coded, so this grants no discretion. Reward
     *      tokens are NOT auto-sold: there is no reliable on-chain route for an
     *      arbitrary incentive token, and inventing one is how adapters get
     *      drained. The Treasury marks unknown tokens at zero, so this parks
     *      them safely for a manual decision.
     *
     *      The pair tokens are excluded — they are the position, not a reward.
     */
    function sweepRewardToken(address token) external returns (uint256 amount) {
        if (token == address(weth) || token == address(paired) || token == address(clm)) {
            revert CannotSweepPairToken();
        }
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) {
            IERC20(token).safeTransfer(treasury, amount);
            emit RewardTokenSwept(token, amount);
        }
    }

    // =======================================================================
    // Governance — bounded parameters only
    // =======================================================================

    function setParams(
        uint32 twapSeconds_,
        int24 maxTickDeviation_,
        uint16 slippageBps_,
        uint16 maxVaultShareBps_
    ) external onlyOwner {
        if (twapSeconds_ < MIN_TWAP_SECONDS || twapSeconds_ > MAX_TWAP_SECONDS) revert BadParam();
        if (maxTickDeviation_ <= 0 || maxTickDeviation_ > MAX_TICK_DEVIATION_LIMIT) revert BadParam();
        if (slippageBps_ > MAX_SLIPPAGE_BPS) revert BadParam();
        if (maxVaultShareBps_ == 0 || maxVaultShareBps_ > MAX_VAULT_SHARE_LIMIT) revert BadParam();

        twapSeconds = twapSeconds_;
        maxTickDeviation = maxTickDeviation_;
        slippageBps = slippageBps_;
        maxVaultShareBps = maxVaultShareBps_;

        emit ParamsSet(twapSeconds_, maxTickDeviation_, slippageBps_, maxVaultShareBps_);
    }

    function setRealizeCooldown(uint32 seconds_) external onlyOwner {
        if (seconds_ > 7 days) revert BadParam();
        realizeCooldown = seconds_;
        emit RealizeCooldownSet(seconds_);
    }

    /**
     * @notice Push any idle WETH/ETH into the vault. Permissionless.
     * @dev Only moves value from this contract into the position it already
     *      committed to, so an open caller gains nothing. Useful when a deposit
     *      left dust, or when a withdrawal over-unwound.
     */
    function redeploy() external nonReentrant returns (uint256 minted) {
        uint256 bal = address(this).balance;
        if (bal != 0) weth.deposit{value: bal}();
        minted = _deployIdle();
    }

    // =======================================================================
    // Internals — deployment
    // =======================================================================

    /// @dev Swap idle WETH into ratio, mint CLM shares, stake them.
    function _deployIdle() internal returns (uint256 minted) {
        uint256 wethBal = weth.balanceOf(address(this));
        if (wethBal == 0 && paired.balanceOf(address(this)) == 0) return 0;

        if (!clm.isCalm()) revert NotCalm();

        uint160 sqrtP = _checkedSqrtPriceX96();

        if (wethBal != 0) {
            uint256 swapIn = _wethToSwap(wethBal, sqrtP);
            if (swapIn != 0) _swap(wethIsToken0, swapIn, sqrtP);
        }

        uint256 a0;
        uint256 a1;
        if (wethIsToken0) {
            a0 = weth.balanceOf(address(this));
            a1 = paired.balanceOf(address(this));
        } else {
            a0 = paired.balanceOf(address(this));
            a1 = weth.balanceOf(address(this));
        }
        if (a0 == 0 && a1 == 0) return 0;

        (uint256 expected, , , , ) = clm.previewDeposit(a0, a1);
        if (expected == 0) return 0;
        uint256 minShares = (expected * (BPS - slippageBps)) / BPS;

        IERC20(pool.token0()).forceApprove(address(clm), a0);
        IERC20(pool.token1()).forceApprove(address(clm), a1);

        uint256 before = clm.balanceOf(address(this));
        clm.deposit(a0, a1, minShares);
        minted = clm.balanceOf(address(this)) - before;

        if (address(rewardPool) != address(0) && minted != 0) {
            IERC20(address(clm)).forceApprove(address(rewardPool), minted);
            rewardPool.stake(minted);
        }

        uint256 shareBps = vaultShareBps();
        if (shareBps > maxVaultShareBps) revert VaultShareCapExceeded(shareBps, maxVaultShareBps);
    }

    /**
     * @dev How much WETH to sell so the resulting pair matches the vault's
     *      current `balances()` ratio.
     *
     *      With `V = b0` expressed in token1 units, holding `W` of WETH:
     *        WETH is token0 → keep  W·V/(b1+V), sell the rest
     *        WETH is token1 → keep  W·b1/(b1+V), sell the rest
     *
     *      Both collapse to the same denominator, which is why one branch
     *      differs only in the numerator.
     */
    function _wethToSwap(uint256 wethBal, uint160 sqrtP) internal view returns (uint256) {
        (uint256 b0, uint256 b1) = clm.balances();

        // An empty vault has no ratio to match; split by value so the mint is
        // balanced rather than one-sided.
        if (b0 == 0 && b1 == 0) return wethBal / 2;

        uint256 b0InToken1 = _mulPrice(b0, sqrtP);
        uint256 denom = b1 + b0InToken1;
        if (denom == 0) return wethBal / 2;

        uint256 keep = wethIsToken0
            ? FullMath.mulDiv(wethBal, b0InToken1, denom)
            : FullMath.mulDiv(wethBal, b1, denom);

        return wethBal > keep ? wethBal - keep : 0;
    }

    // =======================================================================
    // Internals — unwinding
    // =======================================================================

    /**
     * @dev Make at least `targetEth` available as native ETH here, burning as
     *      few shares as necessary. Returns the shares burned.
     */
    function _unwindToEth(uint256 targetEth) internal returns (uint256 sharesBurned) {
        if (address(this).balance >= targetEth) return 0;

        // Cheapest sources first: loose WETH, then the position.
        uint256 idleWeth = weth.balanceOf(address(this));
        if (idleWeth != 0) {
            weth.withdraw(idleWeth);
            if (address(this).balance >= targetEth) return 0;
        }

        uint256 shares = sharesHeld();
        if (shares != 0) {
            uint256 need = targetEth - address(this).balance;
            uint256 posValue = _positionValue(shares);

            if (posValue == 0 || need >= posValue) {
                sharesBurned = shares;
            } else {
                sharesBurned = FullMath.mulDiv(shares, need, posValue);
                // Round up so a rounding-down never leaves the caller one wei short.
                if (sharesBurned < shares) sharesBurned += 1;
            }

            _burnShares(sharesBurned);
        }

        // Whatever the burn produced on the paired side becomes ETH.
        _swapPairedToWeth();

        uint256 w = weth.balanceOf(address(this));
        if (w != 0) weth.withdraw(w);
    }

    function _burnShares(uint256 shares) internal {
        if (shares == 0) return;

        if (address(rewardPool) != address(0)) {
            uint256 staked = rewardPool.balanceOf(address(this));
            uint256 pull = shares > staked ? staked : shares;
            if (pull != 0) rewardPool.withdraw(pull);
        }

        (uint256 e0, uint256 e1) = clm.previewWithdraw(shares);
        uint256 min0 = (e0 * (BPS - slippageBps)) / BPS;
        uint256 min1 = (e1 * (BPS - slippageBps)) / BPS;

        clm.withdraw(shares, min0, min1);
    }

    function _swapPairedToWeth() internal {
        uint256 bal = paired.balanceOf(address(this));
        if (bal == 0) return;
        uint160 sqrtP = _checkedSqrtPriceX96();
        _swap(!wethIsToken0, bal, sqrtP);
    }

    // =======================================================================
    // Internals — swap
    // =======================================================================

    /**
     * @dev Exact-input swap straight through the pool.
     *
     *      The price limit is anchored to the **TWAP**, not to spot: a swap
     *      cannot push the pool further than `maxTickDeviation` beyond the
     *      time-averaged price, so a sandwich cannot use our own trade to walk
     *      the pool somewhere it was never trading.
     */
    function _swap(bool zeroForOne, uint256 amountIn, uint160 sqrtSpot) internal {
        if (amountIn == 0) return;

        int24 twapTick = _twapTick();
        int24 bound = zeroForOne ? twapTick - maxTickDeviation : twapTick + maxTickDeviation;
        uint160 limit = TickMath.getSqrtRatioAtTick(bound);

        // The pool rejects a limit on the wrong side of the current price. The
        // band check in `_checkedSqrtPriceX96` makes this all but unreachable;
        // the explicit revert keeps the failure legible if it ever is.
        if (zeroForOne) {
            if (limit >= sqrtSpot) revert PriceOutOfBand(twapTick, bound, maxTickDeviation);
        } else {
            if (limit <= sqrtSpot) revert PriceOutOfBand(twapTick, bound, maxTickDeviation);
        }

        _swapping = true;
        pool.swap(address(this), zeroForOne, int256(amountIn), limit, "");
        _swapping = false;
    }

    /// @dev Pay the pool what our swap owes it.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(pool)) revert NotPool();
        if (!_swapping) revert UnexpectedCallback();

        if (amount0Delta > 0) {
            IERC20(pool.token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(pool.token1()).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    // =======================================================================
    // Internals — pricing
    // =======================================================================

    /// @dev Spot sqrt price, but only if spot is close enough to the TWAP.
    function _checkedSqrtPriceX96() internal view returns (uint160 sqrtP) {
        int24 spotTick;
        (sqrtP, spotTick, , , , , ) = pool.slot0();

        int24 twapTick = _twapTick();
        int24 d = spotTick > twapTick ? spotTick - twapTick : twapTick - spotTick;
        if (d > maxTickDeviation) revert PriceOutOfBand(spotTick, twapTick, maxTickDeviation);
    }

    /// @dev Arithmetic-mean tick over `twapSeconds`.
    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapSeconds;
        ago[1] = 0;

        (int56[] memory cumulatives, ) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];

        int24 tick = int24(delta / int56(uint56(twapSeconds)));
        // Round toward negative infinity, matching Uniswap's OracleLibrary.
        if (delta < 0 && (delta % int56(uint56(twapSeconds)) != 0)) tick--;
        return tick;
    }

    /**
     * @dev Value `(amount0, amount1)` in WETH terms at the **less favourable**
     *      of spot and TWAP.
     *
     *      Taking the minimum is what makes this safe to feed into a redemption
     *      price. Which direction is "less favourable" flips with the pair's
     *      ordering, so both candidate valuations are computed in full and the
     *      smaller wins — no reasoning about orientation required.
     */
    function _valueConservative(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        (uint160 sqrtSpot, , , , , , ) = pool.slot0();
        uint160 sqrtTwap = TickMath.getSqrtRatioAtTick(_twapTick());

        uint256 a = _valueAt(amount0, amount1, sqrtSpot);
        uint256 b = _valueAt(amount0, amount1, sqrtTwap);
        return a < b ? a : b;
    }

    function _valueAt(uint256 amount0, uint256 amount1, uint160 sqrtP) internal view returns (uint256) {
        if (wethIsToken0) {
            // WETH is token0: convert the token1 leg down into token0 units.
            return amount0 + _divPrice(amount1, sqrtP);
        }
        // WETH is token1: convert the token0 leg up into token1 units.
        return amount1 + _mulPrice(amount0, sqrtP);
    }

    /// @dev `amount0 × price`, price being token1 per token0.
    function _mulPrice(uint256 amount0, uint160 sqrtP) internal pure returns (uint256) {
        uint256 step = FullMath.mulDiv(amount0, sqrtP, Q96);
        return FullMath.mulDiv(step, sqrtP, Q96);
    }

    /// @dev `amount1 ÷ price`.
    function _divPrice(uint256 amount1, uint160 sqrtP) internal pure returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 step = FullMath.mulDiv(amount1, Q96, sqrtP);
        return FullMath.mulDiv(step, Q96, sqrtP);
    }

    /// @dev Value of `shares` in WETH terms, conservatively priced.
    function _positionValue(uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        (uint256 a0, uint256 a1) = clm.previewWithdraw(shares);
        return _valueConservative(a0, a1);
    }
}

/// @dev Beefy's CLM strategy exposes the pool it manages.
interface IBeefyStrategyPool {
    function pool() external view returns (address);
}
