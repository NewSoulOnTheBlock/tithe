// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGate {
    function check(address account) external view returns (bool);
}

/**
 * @title StakedLoyal (stLOYAL)
 * @notice ERC-4626 vault over LOYAL. Stakers receive the protocol's income
 *         stream; passive holders keep the redemption floor (spec §9).
 *
 * ## Why staking rather than per-holder reflection
 *
 * Eligible supply for income is simply `totalSupply()` of this vault. That is
 * the entire reason the design stakes instead of reflecting: no transfer-hook
 * checkpoints on LOYAL (which has no hooks at all and cannot gain any), no
 * exclusion set to get wrong, no rebasing, and nothing downstream broken by a
 * balance that changes without a Transfer event.
 *
 * ## Rewards are ETH, not more LOYAL
 *
 * The corpus is ETH-denominated, so income arrives as ETH. That means share
 * price does **not** grow: `totalAssets()` is just the LOYAL held here, so
 * shares stay ~1:1 with deposits. Yield is tracked separately in a MasterChef-
 * style accumulator and claimed pull-wise.
 *
 * Keeping rewards out of `totalAssets()` is deliberate. If ETH income inflated
 * the share price, `convertToAssets` would report LOYAL that the vault does not
 * hold, and every 4626 integrator downstream would be misled.
 *
 * ## Why the Distributor was folded in
 *
 * Spec §3.1 lists a separate `Distributor`. With native-ETH income there is
 * nothing for it to do but forward value and re-derive per-share accounting
 * this contract already maintains, so it would add an address to wire, a hop to
 * fund, and a failure point — for no benefit. `notifyReward()` takes ETH
 * directly. If income ever becomes multi-asset, split it back out.
 *
 * ## Share transfers settle rewards first
 *
 * stLOYAL is itself an ERC-20. `_update` settles both parties' accrued rewards
 * before any balance moves, so buying shares never buys someone else's unclaimed
 * yield, and selling them never forfeits your own.
 *
 * ## Loyalty tiers — the reason this vault is not a plain MasterChef
 *
 * Income is split by **weight**, not by share count. Weight is your balance
 * times a multiplier you choose by committing to a lock:
 *
 *     NONE   no lock      0.5x    withdraw whenever you like
 *     DAY    1 day        1.0x
 *     WEEK   7 days       3.0x
 *
 * So `totalAssets()` and the share price are untouched — a share is still one
 * LOYAL, `convertToAssets` still tells the truth, and every 4626 integrator
 * downstream still works. Only the *reward accumulator* is weighted, which is
 * the one number that is ours to define.
 *
 * ### The expiry problem, and why `kick` exists
 *
 * A multiplier is only honest while the lock it was bought with is still
 * standing. But weight cannot update itself: nothing runs at the moment a lock
 * expires, so an expired 3x staker keeps diluting everyone else until some
 * transaction touches their account.
 *
 * Rather than pretend that window does not exist, it is made cheap to close.
 * `kick(account)` is permissionless and demotes any expired lock to NONE. Every
 * other staker is paid to call it — removing a stale 3x weight raises their own
 * share of the next reward — so the incentive to clean up sits with the people
 * being diluted, which is where it belongs.
 *
 * The window is bounded by attention, not by code, and that is stated rather
 * than hidden. The alternatives were worse: keeping 3x forever after one week's
 * lock is a permanent subsidy, and auto-renewing the lock is a trap that never
 * lets anyone leave.
 *
 * ### Locked shares do not move
 *
 * `transfer` and `withdraw` are blocked while a lock is standing. Otherwise a
 * 3x position could be sold to someone who never committed to anything, and the
 * lock would mean nothing.
 */
contract StakedLoyal is ERC4626, Ownable, ReentrancyGuard {
    /// @dev High precision: share supply can reach ~1e27 while a reward may be
    ///      a fraction of an ETH, and a smaller scalar would truncate to zero.
    uint256 private constant ACC_PRECISION = 1e30;

    /// @notice Cumulative ETH per unit of WEIGHT, scaled by ACC_PRECISION.
    uint256 public accRewardPerWeight;

    /// @notice Total ETH ever delivered to stakers.
    uint256 public cumulativeRewards;

    /// @notice Total ETH claimed so far.
    uint256 public cumulativeClaimed;

    mapping(address => uint256) private _rewardDebt;
    mapping(address => uint256) private _accrued;

    // -----------------------------------------------------------------------
    // Loyalty tiers
    // -----------------------------------------------------------------------

    enum Tier {
        NONE, // 0.5x — no commitment, withdraw any time
        DAY,  // 1.0x — the baseline
        WEEK  // 3.0x
    }

    uint256 public constant TIER_BPS_NONE = 5_000;
    uint256 public constant TIER_BPS_DAY = 10_000;
    uint256 public constant TIER_BPS_WEEK = 30_000;

    uint256 public constant LOCK_DAY = 1 days;
    uint256 public constant LOCK_WEEK = 7 days;

    /// @notice The tier each account is currently weighted at.
    mapping(address => Tier) public tierOf;

    /// @notice When the account's lock ends. Zero means unlocked.
    mapping(address => uint256) public lockedUntil;

    /// @notice Sum of every account's weight. The accumulator's denominator.
    uint256 public totalWeight;

    /// @notice Weight currently credited to `account`.
    mapping(address => uint256) public weightOf;

    /**
     * @notice Optional eligibility gate. Zero address = open to everyone.
     * @dev Spec §11 puts any allowlist or geofence HERE and on the Redeemer —
     *      never on LOYAL itself, which has no transfer hooks and must stay a
     *      plain composable ERC-20. Pluggable so no policy is baked in now.
     */
    IGate public gate;

    event RewardNotified(uint256 amount, uint256 accRewardPerWeight);
    event Claimed(address indexed account, uint256 amount);
    event GateSet(address indexed gate);
    event Locked(address indexed account, Tier tier, uint256 until_);
    event Kicked(address indexed account, address indexed by);

    error NoStakers();
    error StillLocked(uint256 until_);
    error NotExpired();
    error CannotDowngradeWhileLocked();
    error NothingToClaim();
    error NothingToNotify();
    error EthTransferFailed();
    error NotAllowed(address account);

    constructor(IERC20 loyal_, address owner_)
        ERC20(
            string.concat("Staked ", IERC20Metadata(address(loyal_)).name()),
            string.concat("st", IERC20Metadata(address(loyal_)).symbol())
        )
        ERC4626(loyal_)
        Ownable(owner_)
    {}

    /// @dev Virtual-share offset against the classic 4626 first-depositor
    ///      donation attack. Cheap here because share price never legitimately
    ///      moves — rewards live outside `totalAssets()`.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // -----------------------------------------------------------------------
    // Rewards
    // -----------------------------------------------------------------------

    /**
     * @notice Deliver ETH income to stakers. Permissionless.
     * @dev Reverts when nobody is staked rather than silently swallowing the
     *      ETH — the caller keeps its funds and can retry once there are shares.
     */
    function notifyReward() external payable {
        if (msg.value == 0) revert NothingToNotify();
        // Weight, not supply. A vault holding shares that are ALL at 0.5x still
        // pays out the whole reward — the multipliers only decide how it is
        // divided between stakers, never how much leaves the contract.
        uint256 weight = totalWeight;
        if (weight == 0) revert NoStakers();

        accRewardPerWeight += (msg.value * ACC_PRECISION) / weight;
        cumulativeRewards += msg.value;

        emit RewardNotified(msg.value, accRewardPerWeight);
    }

    /// @dev Accept plain transfers, but they only count once notified.
    receive() external payable {}

    /// @notice ETH currently claimable by `account`.
    function pendingYield(address account) public view returns (uint256) {
        return
            _accrued[account] +
            ((weightOf[account] * accRewardPerWeight) / ACC_PRECISION) -
            _rewardDebt[account];
    }

    /// @notice Multiplier in basis points for a tier. 10_000 = 1x.
    function tierBps(Tier t) public pure returns (uint256) {
        if (t == Tier.WEEK) return TIER_BPS_WEEK;
        if (t == Tier.DAY) return TIER_BPS_DAY;
        return TIER_BPS_NONE;
    }

    /// @notice Lock duration for a tier, in seconds.
    function tierLock(Tier t) public pure returns (uint256) {
        if (t == Tier.WEEK) return LOCK_WEEK;
        if (t == Tier.DAY) return LOCK_DAY;
        return 0;
    }

    /// @notice True when the account committed to a lock that has not run out.
    function isLocked(address account) public view returns (bool) {
        return lockedUntil[account] > block.timestamp;
    }

    /**
     * @notice The tier an account SHOULD be at right now.
     * @dev Differs from `tierOf` exactly in the window between a lock expiring
     *      and someone calling `kick`. `pendingYield` deliberately keeps using
     *      the stale `weightOf`, because the accumulator already divided past
     *      rewards by a `totalWeight` that included it — rewriting history here
     *      would pay out ETH the contract never received.
     */
    function effectiveTier(address account) public view returns (Tier) {
        if (tierOf[account] != Tier.NONE && !isLocked(account)) return Tier.NONE;
        return tierOf[account];
    }

    // -----------------------------------------------------------------------
    // Locking
    // -----------------------------------------------------------------------

    /**
     * @notice Commit to a lock and take its multiplier.
     * @dev A lock may be lengthened or upgraded at any time. It may not be
     *      shortened or downgraded while it is standing — that is the whole
     *      point of committing.
     */
    function lock(Tier t) external {
        Tier current = effectiveTier(msg.sender);
        if (isLocked(msg.sender) && t < current) revert CannotDowngradeWhileLocked();

        _settle(msg.sender);
        tierOf[msg.sender] = t;

        uint256 until_ = t == Tier.NONE ? 0 : block.timestamp + tierLock(t);
        // Never shorten an existing commitment, even when re-locking at the
        // same tier: that would let a staker refresh downward.
        if (until_ < lockedUntil[msg.sender]) until_ = lockedUntil[msg.sender];
        lockedUntil[msg.sender] = until_;

        _syncWeight(msg.sender);
        emit Locked(msg.sender, t, until_);
    }

    /**
     * @notice Demote an account whose lock has run out. Permissionless.
     * @dev Anyone may call this and everyone else is paid to: removing a stale
     *      multiplier shrinks `totalWeight`, which raises every remaining
     *      staker's share of the next reward.
     */
    function kick(address account) external {
        if (tierOf[account] == Tier.NONE) revert NotExpired();
        if (isLocked(account)) revert StillLocked(lockedUntil[account]);

        _settle(account);
        tierOf[account] = Tier.NONE;
        lockedUntil[account] = 0;
        _syncWeight(account);

        emit Kicked(account, msg.sender);
    }

    /// @notice Claim accrued ETH. Pull-based, so no loop can be griefed.
    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);

        amount = _accrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _accrued[msg.sender] = 0;
        cumulativeClaimed += amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit Claimed(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Gate
    // -----------------------------------------------------------------------

    function setGate(address gate_) external onlyOwner {
        gate = IGate(gate_);
        emit GateSet(gate_);
    }

    function _requireAllowed(address account) internal view {
        if (address(gate) != address(0) && !gate.check(account)) revert NotAllowed(account);
    }

    // -----------------------------------------------------------------------
    // ERC-4626 / ERC-20 plumbing
    // -----------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        _requireAllowed(receiver);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        _requireAllowed(receiver);
        return super.mint(shares, receiver);
    }

    /**
     * @dev Settle rewards for both sides before any balance change, so accrual
     *      always reflects the balance actually held over the period, then
     *      re-derive both weights from the new balances.
     *
     *      Shares leaving a locked account are refused. A lock that could be
     *      transferred away, or withdrawn out from under, is not a lock — and
     *      `withdraw`/`redeem` both burn, so blocking `from` covers every exit
     *      in one place rather than three.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && isLocked(from)) revert StillLocked(lockedUntil[from]);

        if (from != address(0)) _settle(from);
        if (to != address(0)) _settle(to);

        super._update(from, to, value);

        if (from != address(0)) _syncWeight(from);
        if (to != address(0)) _syncWeight(to);
    }

    function _settle(address account) internal {
        _accrued[account] = pendingYield(account);
        _syncDebt(account);
    }

    function _syncDebt(address account) internal {
        _rewardDebt[account] = (weightOf[account] * accRewardPerWeight) / ACC_PRECISION;
    }

    /**
     * @dev Recompute one account's weight and fold the delta into `totalWeight`.
     *
     *      MUST be preceded by `_settle`, always. Weight is the multiplier the
     *      accumulator has already been dividing by; changing it without first
     *      banking what was earned at the old weight would silently re-price
     *      the past.
     */
    function _syncWeight(address account) internal {
        uint256 next = (balanceOf(account) * tierBps(effectiveTier(account))) / 10_000;
        uint256 prev = weightOf[account];
        if (next == prev) return;

        weightOf[account] = next;
        totalWeight = totalWeight + next - prev;

        _syncDebt(account);
    }
}
