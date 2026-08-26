// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";

interface IDistributor {
    function distribute() external payable;
}

/**
 * @title Treasury
 * @notice The collective balance sheet behind LOYAL's redemption floor.
 *         **ETH-denominated corpus** (spec §4.1, option 1).
 *
 * ## What ETH-denomination buys, and what it costs
 *
 * The corpus is held as native ETH, so:
 *
 *   nav()          = address(this).balance + Σ adapter.totalAssets()
 *   floorPerToken  = nav * 1e18 / eligibleSupply
 *
 * Both sides of that equation are already in wei, which means **v1 needs no
 * price oracle at all**. That matters more on this chain than it sounds: no
 * Chainlink ETH/USD aggregator has been verified on chain 4663, so a
 * USD-denominated corpus would have had to invent a price source for the one
 * number that sets the redemption price. Spec §6.4 requires every NAV read to be
 * oracle-gated for staleness and sequencer uptime — with an ETH corpus and no
 * adapters, there is no oracle to gate, and `nav()` cannot go stale.
 *
 * The cost is honest and should not be papered over: **the floor is denominated
 * in ETH, so its dollar value moves with ETH.** A floor of 0.000001 ETH/LOYAL is
 * a hard floor in ether and a soft one in dollars. Spec §4.1 recommended USDG
 * for exactly this reason. That trade was made deliberately.
 *
 * ## The floor invariant
 *
 * With no adapters, `nav()` only moves in ways that are safe for the floor:
 *   - tax inflow raises it,
 *   - redemption pays out at a 5% haircut that *stays* in the corpus, so each
 *     redemption is accretive to everyone who did not redeem (spec §7),
 *   - LOYAL's supply is fixed and burn-only, so `eligibleSupply` only shrinks.
 * Floor is therefore monotonically non-decreasing in v1. `floorHighWaterMark`
 * records that, and `FloorRegression` fires if it is ever violated — which can
 * only happen once a yield sleeve exists and takes impermanent loss.
 *
 * A regression **emits rather than reverts** on purpose. Reverting on a falling
 * floor would brick redemption at precisely the moment holders most want out,
 * converting an accounting problem into a trapped-funds problem.
 *
 * ## LOYAL is never corpus
 *
 * LOYAL held by this contract is marked at **zero** in `nav()`, and the same
 * balance is removed from `eligibleSupply()` so numerator and denominator agree
 * (spec §6.1). A token that backs itself makes the floor self-referentially
 * inflatable.
 *
 * Consequence worth understanding: donating LOYAL to this contract shrinks the
 * denominator and therefore *raises* reported `floorPerToken` without adding any
 * value. It is not profitable to do (you give up more redemption value than you
 * gain), but it does mean `floorPerToken()` is not manipulation-proof against a
 * donor. The Redeemer must price against a **lagged** NAV per spec §6.3, and the
 * exclusion list is an explicit owner-set list rather than "any contract" so the
 * set is predictable rather than inferred.
 *
 * ## The owner CAN withdraw corpus ETH — read this before trusting the floor
 *
 * `withdraw()` lets the owner send corpus ETH to a single `operator` address, so
 * that it can be deployed into yield-generating activity off-contract. This is a
 * deliberate product decision and it has a direct consequence:
 *
 * > **`floorPerToken()` is advisory, not enforceable.** It reports what backs
 * > each token *at this moment*. It is not a level the contract can hold,
 * > because corpus ETH can leave without a redemption.
 *
 * Do not describe this token as having a guaranteed or hard floor. The honest
 * description is a *reported* floor that ratchets with tax and redemptions and
 * falls when the operator withdraws — every withdrawal emits `Withdrawn` with
 * the resulting NAV and fires `FloorRegression`, so the history is auditable
 * from events alone.
 *
 * ## What is still structurally guaranteed
 *
 * - **No arbitrary call.** There is no `execute(address,bytes)`, no
 *   `delegatecall`, and no upgradeability. `withdraw()` takes an amount but no
 *   destination, so funds can only reach `operator` — a compromised owner key
 *   bounds where corpus ETH lands, though not whether it leaves.
 * - **Staker income is untouchable.** Withdrawal is limited to `liquidEth()`,
 *   which excludes `pendingIncome`. ETH already earmarked for stLOYAL and staked
 *   Income is owed to stakers, not corpus, and the owner cannot reach it.
 * - **Redemption still settles honestly.** `Redeemer` pays
 *   `min(snapshotFloor, currentFloor)`, so a withdrawal between request and
 *   execution reduces the payout rather than letting anyone claim value that is
 *   no longer there — and it can never make a matured request revert.
 * - Redemption remains the only path by which a *holder* can extract value:
 *   `payout` is callable solely by `redeemer`.
 */
contract Treasury is Ownable, ReentrancyGuard {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;

    /// @notice Hard ceiling on the yield sleeve. The corpus core never leaves ETH.
    uint16 public constant MAX_SLEEVE_BPS = 5_000;

    /// @notice Delay before a queued adapter may be activated (spec §10).
    uint256 public constant ADAPTER_TIMELOCK = 2 days;

    /// @notice Conventional burn address, always excluded from eligible supply.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // -----------------------------------------------------------------------
    // Write-once state
    // -----------------------------------------------------------------------

    /**
     * @notice The LOYAL token. Marked at zero in NAV, always.
     * @dev Set **once**, after launch, via `setLoyal()` — not in the constructor.
     *
     *      This is what lets the entire contract set be deployed BEFORE the
     *      token exists, which in turn lets the token be launched with
     *      `params.creatorFeeRecipient` already pointing at the FeeSink. That
     *      ordering removes the post-launch `transferCreatorFeeRecipient` step
     *      entirely — and that step is exactly where the first deployment sent
     *      the fee stream to an address that could not collect it.
     *
     *      Trading immutability for a one-shot setter is a deliberate, narrow
     *      trade: `setLoyal` reverts once set, so the window is a single call.
     */
    IERC20 public loyal;

    // -----------------------------------------------------------------------
    // Mutable state
    // -----------------------------------------------------------------------

    /// @notice The logic-free ETH receiver registered with Pons.
    address public feeSink;

    /// @notice The only address permitted to move ETH out of this contract.
    address public redeemer;

    /// @notice Routes income to stLOYAL stakers.
    address public distributor;

    /**
     * @notice ETH earmarked for stakers, awaiting `distributeIncome()`.
     * @dev **Excluded from `nav()`.** This is the income/principal separation
     *      spec §6 requires, and getting it wrong is subtly destructive:
     *
     *      If earmarked income counted as corpus, realizing yield would spike
     *      the floor and paying it out would drop the floor straight back —
     *      firing `FloorRegression` on every single distribution and making the
     *      floor chart a sawtooth of false alarms. Worse, redemptions in between
     *      would be priced against ETH that belongs to stakers.
     *
     *      So income never enters the floor calculation at all, and `payout()`
     *      and `depositToAdapter()` both spend only `liquidEth()`.
     */
    uint256 public pendingIncome;

    /**
     * @notice Share of incoming TAX earmarked for stakers rather than corpus, in bps.
     * @dev Originally 0, because spec §9 said tax is corpus and only *realized*
     *      surplus is distributable. Removing the yield sleeve removed the only
     *      thing that realized surplus, so leaving this at 0 would mean stakers
     *      earn nothing at all — the tiers would divide zero forever.
     *
     *      The cap is 7500 so the intended 1.5%-of-a-2%-tax split is reachable
     *      exactly. It is deliberately not 10000: `teamShareBps` has to fit
     *      alongside it, and a single dial able to consume the entire tax is a
     *      sharper instrument than this needs.
     */
    uint16 public incomeShareBps;

    /// @notice Cap on `incomeShareBps`. See `MAX_TEAM_SHARE_BPS` — they sum to 100%.
    uint16 public constant MAX_INCOME_SHARE_BPS = 7_500;

    /// @notice Cumulative ETH sent onward to the Distributor.
    uint256 public cumulativeIncomeDistributed;

    // -----------------------------------------------------------------------
    // Team revenue
    // -----------------------------------------------------------------------

    /**
     * @notice Share of incoming TAX earmarked for `teamRecipient`, in bps.
     * @dev This exists so team revenue is a **declared line item** rather than
     *      an owner reaching into the corpus.
     *
     *      It could have been done with `withdraw()`: let the cut land in the
     *      corpus and have the operator take it out. That is worse in a way
     *      that shows. Corpus ETH is what `floorPerToken()` is computed from,
     *      so every payday would spike the floor and then drop it — firing
     *      `FloorRegression` on schedule and making the floor chart a sawtooth
     *      driven by payroll. Worse, anyone redeeming in the window between
     *      would be quoted a floor partly backed by money already spoken for.
     *
     *      Earmarking at the moment of inflow avoids all of it: the team's cut
     *      is never corpus, never counted in `nav()`, and never redeemable —
     *      so the floor only ever moves for reasons a holder can explain.
     */
    uint16 public teamShareBps;

    /// @notice Cap on `teamShareBps`. 2500 of a 2% tax is 0.5% of a trade, and
    ///         no owner can ever raise the team's take above that.
    uint16 public constant MAX_TEAM_SHARE_BPS = 2_500;

    /// @notice The only address `claimTeam()` can pay.
    address public teamRecipient;

    /**
     * @notice Team revenue accrued and not yet claimed.
     * @dev Excluded from `liquidEth()` for the same reason as `pendingIncome`:
     *      it is owed to a third party and is not corpus. Held rather than
     *      pushed so that `fund()` — the hot path every fee collection runs
     *      through — cannot be made to revert by a recipient that rejects ETH.
     */
    uint256 public pendingTeam;

    /// @notice Cumulative ETH paid out to `teamRecipient`.
    uint256 public cumulativeTeamPaid;

    /**
     * @notice The ONLY address treasury ETH can be withdrawn to.
     * @dev Defaults to the owner at construction. `withdraw()` takes no
     *      destination argument, so a compromised owner key can move corpus ETH
     *      to this one address and nowhere else. That does not make withdrawal
     *      safe — it bounds where the funds can land, not whether they leave.
     */
    address public operator;

    /// @notice Cumulative ETH withdrawn from the corpus by the operator.
    uint256 public cumulativeWithdrawn;

    /// @notice Fraction of NAV allowed in the yield sleeve. Starts at 0.
    uint16 public sleeveBps;

    /// @notice Wei received from `feeSink` — the tax, cumulatively.
    uint256 public cumulativeTaxReceived;

    /// @notice Wei received from anywhere else. Counted separately so the tax
    ///         figure the UI shows is actually the tax.
    uint256 public cumulativeDonated;

    /// @notice Wei paid out through `payout`, cumulatively.
    uint256 public cumulativePaidOut;

    /// @notice Highest `floorPerToken()` ever observed, in wei per whole LOYAL.
    uint256 public floorHighWaterMark;

    address[] private _adapters;
    mapping(address => bool) public isAdapter;
    mapping(address => uint256) public adapterQueuedAt;

    /// @dev Holders whose LOYAL is excluded from `eligibleSupply()`. DEAD is
    ///      always excluded and is NOT stored here.
    address[] private _excluded;
    mapping(address => bool) public isExcluded;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted on every state change, so the floor chart needs no indexer.
    event FloorUpdated(uint256 nav, uint256 eligibleSupply, uint256 timestamp);

    /// @notice The floor invariant was violated. Only possible with a live sleeve.
    event FloorRegression(uint256 highWaterMark, uint256 current, uint256 timestamp);

    event Funded(address indexed from, uint256 amount, bool isTax);
    event PaidOut(address indexed to, uint256 amount);
    event LoyalSet(address indexed loyal);
    event IncomeAccrued(uint256 amount, uint256 pendingIncome);
    event IncomeDistributed(uint256 amount);
    event DistributorSet(address indexed previous, address indexed current);
    event OperatorSet(address indexed previous, address indexed current);
    /// @dev navAfter is logged so the corpus is auditable from events alone.
    event Withdrawn(address indexed to, uint256 amount, uint256 navAfter);
    event IncomeShareBpsSet(uint16 previous, uint16 current);
    event TeamShareBpsSet(uint16 previous, uint16 current);
    event TeamRecipientSet(address indexed previous, address indexed current);
    event TeamAccrued(uint256 amount, uint256 pendingTeam);
    event TeamPaid(address indexed to, uint256 amount);
    event FeeSinkSet(address indexed previous, address indexed current);
    event RedeemerSet(address indexed previous, address indexed current);
    event SleeveBpsSet(uint16 previous, uint16 current);
    event AdapterQueued(address indexed adapter, uint256 executableAt);
    event AdapterQueueCancelled(address indexed adapter);
    event AdapterAdded(address indexed adapter);
    event AdapterRemoved(address indexed adapter);
    event ExclusionSet(address indexed account, bool excluded);
    event DepositedToAdapter(address indexed adapter, uint256 amount);
    event WithdrawnFromAdapter(address indexed adapter, uint256 requested, uint256 received);
    event SurplusRealized(address indexed adapter, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error NotRedeemer();
    error NothingToFund();
    error SleeveTooLarge(uint16 requested, uint16 max);
    error SleeveCapExceeded(uint256 wouldBe, uint256 cap);
    error InsufficientLiquidEth(uint256 requested, uint256 available);
    error AdapterAlreadyActive();
    error AdapterNotActive();
    error AdapterNotQueued();
    error TimelockNotElapsed(uint256 executableAt);
    error AdapterStillFunded(uint256 assets);
    error EthTransferFailed();
    error CannotExcludeDead();
    error LoyalAlreadySet(address current);
    error NotAContract(address target);
    error DistributorNotSet();
    error OperatorNotSet();
    error NoIncome();
    error IncomeShareTooLarge(uint16 requested, uint16 max);
    error TeamShareTooLarge(uint16 requested, uint16 max);
    error TeamRecipientNotSet();
    error NoTeamRevenue();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /**
     * @param owner_ Governance. Should be a multisig or timelock, NOT the
     *               deploying EOA — see spec §10/§11. The deploy script warns
     *               loudly if these are the same address.
     * @dev Takes no token: this contract is deployed BEFORE the token exists.
     *      Call `setLoyal()` once after launch.
     */
    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();

        // Withdrawals default to the deploying owner. Repoint with setOperator.
        operator = owner_;
        emit OperatorSet(address(0), owner_);

        // The Treasury's own LOYAL is never corpus, so exclude it from day one.
        _excluded.push(address(this));
        isExcluded[address(this)] = true;
        emit ExclusionSet(address(this), true);
    }

    /**
     * @notice Bind this Treasury to the launched token. Callable exactly once.
     * @dev Reverts if already set, so the binding cannot be swapped later — a
     *      re-pointable `loyal` would let governance rewrite `eligibleSupply()`
     *      and therefore the floor.
     */
    function setLoyal(address loyal_) external onlyOwner {
        if (loyal_ == address(0)) revert ZeroAddress();
        if (address(loyal) != address(0)) revert LoyalAlreadySet(address(loyal));
        if (loyal_.code.length == 0) revert NotAContract(loyal_);

        loyal = IERC20(loyal_);
        emit LoyalSet(loyal_);
        _touch();
    }

    // -----------------------------------------------------------------------
    // NAV accounting (spec §6)
    // -----------------------------------------------------------------------

    /**
     * @notice Liquid corpus ETH — the balance minus everything owed to others.
     * @dev Both `pendingIncome` (stakers) and `pendingTeam` (team revenue) are
     *      liabilities sitting in this contract's balance. Corpus is what is
     *      left after them, and it is corpus alone that `nav()`, the floor,
     *      redemptions and `withdraw()` are allowed to see.
     */
    function liquidEth() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 owed = pendingIncome + pendingTeam;
        return bal > owed ? bal - owed : 0;
    }

    /// @notice Liquid ETH held directly, available for redemption immediately.
    function ethBuffer() public view returns (uint256) {
        return liquidEth();
    }

    /**
     * @notice USDG held by the Treasury.
     * @dev Always 0 in ETH mode. This exists because the frontend read layer is
     *      written against a superset ABI that also covers a USDG-denominated
     *      corpus. Returning a hard zero is accurate — the Treasury holds no
     *      USDG — and is preferable to wiring in a USDG address that has not
     *      been verified on chain 4663.
     */
    function usdgBalance() public pure returns (uint256) {
        return 0;
    }

    /**
     * @notice One adapter's reported value, and whether it answered at all.
     * @dev Wrapped in try/catch because a single misbehaving adapter must not be
     *      able to take the whole Treasury down with it. Beefy deprecates vaults
     *      routinely (spec §4.3), so an adapter going unreadable is an expected
     *      operational event, not a hypothetical.
     */
    function adapterAssets(address adapter) public view returns (uint256 assets, bool healthy) {
        try IYieldAdapter(adapter).totalAssets() returns (uint256 a) {
            return (a, true);
        } catch {
            return (0, false);
        }
    }

    /**
     * @notice Total value across every active adapter, in wei.
     * @dev An unreadable adapter contributes **zero** rather than reverting.
     *
     *      That choice is deliberate and it is a trade, not a free win: it means
     *      a broken adapter *understates* NAV and drops the floor, which fires
     *      `FloorRegression`. The alternative — propagating the revert — would
     *      make `nav()` revert, and because `payout()` touches `nav()`, that
     *      would brick redemption permanently and trap every holder's claim.
     *      A visibly wrong floor is recoverable; a frozen treasury is not.
     *
     *      Monitor `unhealthyAdapters()` so a zero-contribution adapter is never
     *      mistaken for a genuine loss of value.
     *
     *      Note the limit of this defense: try/catch survives a revert, but an
     *      adapter that consumes all forwarded gas can still make `nav()`
     *      unusable. Calling untrusted code cannot be made fully safe — the
     *      allowlist and the 2-day timelock are the real mitigations.
     */
    function sleeveAssets() public view returns (uint256 total) {
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            (uint256 a, ) = adapterAssets(_adapters[i]);
            total += a;
        }
    }

    /**
     * @notice The CORPUS value of one adapter: `min(totalAssets, principal)`.
     * @dev Appreciation above the high-water mark is income owed to stakers, so
     *      it is excluded from NAV; depreciation below it is a genuine loss of
     *      corpus, so it is included. Without this the floor would sawtooth —
     *      rising as yield accrued and falling the moment it was realized and
     *      paid out, firing FloorRegression on every distribution.
     */
    function adapterCorpus(address adapter) public view returns (uint256) {
        (uint256 assets, bool healthy) = adapterAssets(adapter);
        if (!healthy) return 0;
        try IYieldAdapter(adapter).principal() returns (uint256 p) {
            return assets < p ? assets : p;
        } catch {
            // An adapter that cannot report principal is valued at its full
            // assets — conservative only if it is underwater, so treat a broken
            // reading as zero rather than trusting an unbacked number.
            return 0;
        }
    }

    /// @notice Corpus value across the sleeve — the figure `nav()` uses.
    function sleeveCorpus() public view returns (uint256 total) {
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            total += adapterCorpus(_adapters[i]);
        }
    }

    /// @notice Unrealized appreciation across the sleeve — income in waiting.
    function unrealizedSurplus() external view returns (uint256 total) {
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            (uint256 assets, bool healthy) = adapterAssets(_adapters[i]);
            if (!healthy) continue;
            try IYieldAdapter(_adapters[i]).principal() returns (uint256 p) {
                if (assets > p) total += assets - p;
            } catch {}
        }
    }

    /// @notice Active adapters that currently fail to report their value.
    function unhealthyAdapters() external view returns (address[] memory list) {
        uint256 n = _adapters.length;
        address[] memory buf = new address[](n);
        uint256 count;
        for (uint256 i; i < n; ++i) {
            (, bool healthy) = adapterAssets(_adapters[i]);
            if (!healthy) buf[count++] = _adapters[i];
        }
        list = new address[](count);
        for (uint256 i; i < count; ++i) list[i] = buf[i];
    }

    /// @notice The sleeve cap, in basis points of NAV.
    function sleeveCapBps() public view returns (uint256) {
        return sleeveBps;
    }

    /// @notice Absolute sleeve cap in wei, at current NAV.
    function sleeveCapWei() public view returns (uint256) {
        return (nav() * sleeveBps) / BPS;
    }

    /**
     * @notice Net asset value in wei. LOYAL is marked at zero, always.
     * @dev No oracle is involved: both terms are natively ETH-denominated.
     */
    function nav() public view returns (uint256) {
        return liquidEth() + sleeveCorpus();
    }

    /**
     * @notice Supply the floor is spread across: total minus burned minus
     *         protocol-owned LOYAL (spec §6).
     * @dev Do NOT add the staking vault to the exclusion list. It *custodies*
     *      user LOYAL rather than owning it, and stakers must keep their floor
     *      backing. Exclude only LOYAL the protocol itself owns.
     */
    function eligibleSupply() public view returns (uint256) {
        // Before `setLoyal`, there is no supply to spread the floor across.
        // Returning 0 rather than reverting keeps every read — and therefore
        // `payout()`, which touches them — alive during the pre-launch window.
        if (address(loyal) == address(0)) return 0;

        uint256 supply = loyal.totalSupply();
        uint256 excluded = loyal.balanceOf(DEAD);

        uint256 n = _excluded.length;
        for (uint256 i; i < n; ++i) {
            excluded += loyal.balanceOf(_excluded[i]);
        }

        return supply > excluded ? supply - excluded : 0;
    }

    /// @notice Wei of NAV backing each whole LOYAL. Zero when supply is zero.
    function floorPerToken() public view returns (uint256) {
        uint256 supply = eligibleSupply();
        if (supply == 0) return 0;
        return (nav() * WAD) / supply;
    }

    /// @notice Active adapter addresses.
    function adapters() external view returns (address[] memory) {
        return _adapters;
    }

    /// @notice Accounts excluded from eligible supply, not counting DEAD.
    function exclusions() external view returns (address[] memory) {
        return _excluded;
    }

    // -----------------------------------------------------------------------
    // Inflow
    // -----------------------------------------------------------------------

    /**
     * @notice Receive ETH into the corpus. Permissionless.
     * @dev Inflow from `feeSink` counts as tax; anything else counts as a
     *      donation. Both raise the floor identically — the split exists so the
     *      UI's "cumulative tax" figure is not inflated by gifts.
     */
    function fund() external payable {
        if (msg.value == 0) revert NothingToFund();

        bool isTax = msg.sender == feeSink && feeSink != address(0);
        if (isTax) {
            cumulativeTaxReceived += msg.value;

            // Only tax is ever split. Donations are unambiguously gifts to the
            // corpus, and skimming them for stakers would surprise the giver.
            if (incomeShareBps != 0) {
                uint256 toIncome = (msg.value * incomeShareBps) / BPS;
                if (toIncome != 0) {
                    pendingIncome += toIncome;
                    emit IncomeAccrued(toIncome, pendingIncome);
                }
            }

            // The team's cut is only taken if there is somewhere to send it.
            // Earmarking against an unset recipient would strand the ETH in a
            // liability no one can claim — outside the corpus, so it would not
            // back the floor, and outside `pendingIncome`, so stakers could not
            // have it either. Better it stays corpus until the address exists.
            if (teamShareBps != 0 && teamRecipient != address(0)) {
                uint256 toTeam = (msg.value * teamShareBps) / BPS;
                if (toTeam != 0) {
                    pendingTeam += toTeam;
                    emit TeamAccrued(toTeam, pendingTeam);
                }
            }
        } else {
            cumulativeDonated += msg.value;
        }

        emit Funded(msg.sender, msg.value, isTax);
        _touch();
    }

    // -----------------------------------------------------------------------
    // Income — the route from corpus yield to stakers
    // -----------------------------------------------------------------------

    /**
     * @notice Forward all earmarked income to the Distributor. Permissionless.
     * @dev The Distributor forwards it to stLOYAL
     *      and reverts if neither side has stakers — in which case this reverts
     *      too and the income simply stays earmarked here until someone stakes.
     *      It is never silently reclassified as corpus, because it was already
     *      excluded from `nav()` and quietly folding it back in would move the
     *      floor for reasons no chart could explain.
     */
    function distributeIncome() external nonReentrant returns (uint256 amount) {
        if (distributor == address(0)) revert DistributorNotSet();

        amount = pendingIncome;
        if (amount == 0) revert NoIncome();
        if (amount > address(this).balance) revert InsufficientLiquidEth(amount, address(this).balance);

        pendingIncome = 0;
        cumulativeIncomeDistributed += amount;

        IDistributor(distributor).distribute{value: amount}();

        emit IncomeDistributed(amount);
        _touch();
    }

    /**
     * @notice Pay accrued team revenue to `teamRecipient`. Permissionless.
     * @dev Permissionless because it has exactly one destination and no
     *      discretion: whoever calls it, the money goes to `teamRecipient` and
     *      nowhere else. Gating it behind the owner would add a key to the
     *      trust surface without adding a decision for that key to make.
     *
     *      Nothing here can touch corpus. `pendingTeam` only ever grows by the
     *      declared share of an actual tax inflow, so this cannot pay out more
     *      than the team was earmarked, and the floor is unaffected either way
     *      because the earmarked ETH was never in `nav()` to begin with.
     */
    function claimTeam() external nonReentrant returns (uint256 amount) {
        address to = teamRecipient;
        if (to == address(0)) revert TeamRecipientNotSet();

        amount = pendingTeam;
        if (amount == 0) revert NoTeamRevenue();
        if (amount > address(this).balance) revert InsufficientLiquidEth(amount, address(this).balance);

        pendingTeam = 0;
        cumulativeTeamPaid += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit TeamPaid(to, amount);
        _touch();
    }

    /**
     * @notice Accept bare ETH transfers.
     * @dev Empty on purpose: this must survive a 2300-gas stipend in case a fee
     *      path ever pays the Treasury directly instead of the FeeSink. The
     *      inflow is still corpus and still backs the floor; it just is not
     *      counted or announced until someone calls `poke()`.
     */
    receive() external payable {}

    /// @notice Re-emit `FloorUpdated` from current state. Permissionless.
    function poke() external {
        _touch();
    }

    // -----------------------------------------------------------------------
    // Outflow — redemption only
    // -----------------------------------------------------------------------

    /**
     * @notice Pay `amount` wei to `to`. The ONLY path ETH can leave by.
     * @dev Restricted to `redeemer`. Pays exclusively from liquid ETH, so a
     *      redemption wave can never force a loss-making liquidation of the
     *      yield sleeve (spec §7). If the buffer is short, this reverts and the
     *      owner must unwind sleeve positions first — deliberately a manual,
     *      visible step rather than an automatic fire sale.
     */
    function payout(address to, uint256 amount) external nonReentrant returns (uint256) {
        if (msg.sender != redeemer) revert NotRedeemer();
        if (to == address(0)) revert ZeroAddress();

        // liquidEth(), not the raw balance: redemption must never be paid out of
        // ETH already earmarked for stakers.
        uint256 available = liquidEth();
        if (amount > available) revert InsufficientLiquidEth(amount, available);

        cumulativePaidOut += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit PaidOut(to, amount);
        _touch();
        return amount;
    }

    // -----------------------------------------------------------------------
    // Governance — enumerated and bounded
    // -----------------------------------------------------------------------

    function setFeeSink(address feeSink_) external onlyOwner {
        if (feeSink_ == address(0)) revert ZeroAddress();
        emit FeeSinkSet(feeSink, feeSink_);
        feeSink = feeSink_;
    }

    function setRedeemer(address redeemer_) external onlyOwner {
        if (redeemer_ == address(0)) revert ZeroAddress();
        emit RedeemerSet(redeemer, redeemer_);
        redeemer = redeemer_;
    }

    /**
     * @notice Withdraw corpus ETH to the operator wallet, to be deployed into
     *         yield-generating activity off-contract.
     *
     * @dev **This is the mechanism that makes the floor advisory rather than
     *      enforceable.** Corpus ETH can leave without a redemption, so
     *      `floorPerToken()` describes what is backing the token *right now*,
     *      not a level the contract can hold. Withdrawal fires `FloorRegression`
     *      for exactly that reason: the drop is real and is announced.
     *
     *      What the design still guarantees:
     *
     *      - Funds can only reach `operator`. There is no destination argument,
     *        so this is not a general-purpose escape hatch to any address.
     *      - Only `liquidEth()` is reachable, so **income already earmarked for
     *        stakers cannot be taken.** That ETH is owed to
     *        third parties, not corpus, and remains outside the owner's reach.
     *      - Every withdrawal is logged with the resulting NAV, so the corpus
     *        can be audited from events alone with no indexer.
     *
     *      Redeemers are not defenceless against a withdrawal: `Redeemer` pays
     *      `min(snapshotFloor, currentFloor)`, so a queued redemption settles at
     *      the *lower* of the two. A withdrawal between request and execution
     *      reduces what they receive — it does not let them claim value that is
     *      no longer there, and it cannot make the payout revert.
     */
    function withdraw(uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        if (operator == address(0)) revert OperatorNotSet();
        if (amount == 0) revert NothingToFund();

        uint256 available = liquidEth();
        if (amount > available) revert InsufficientLiquidEth(amount, available);

        cumulativeWithdrawn += amount;

        (bool ok, ) = operator.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit Withdrawn(operator, amount, nav());
        _touch();
        return amount;
    }

    /// @notice Change the single address withdrawals may reach.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, operator_);
        operator = operator_;
    }

    function setDistributor(address distributor_) external onlyOwner {
        if (distributor_ == address(0)) revert ZeroAddress();
        emit DistributorSet(distributor, distributor_);
        distributor = distributor_;
    }

    /**
     * @notice Route a share of incoming tax to stakers instead of the corpus.
     * @dev 0 (the default) is the specified behaviour. Raising it trades floor
     *      growth for staker income — an economic choice, capped at 50% so the
     *      floor can never be starved entirely.
     */
    function setIncomeShareBps(uint16 bps) external onlyOwner {
        if (bps > MAX_INCOME_SHARE_BPS) revert IncomeShareTooLarge(bps, MAX_INCOME_SHARE_BPS);
        emit IncomeShareBpsSet(incomeShareBps, bps);
        incomeShareBps = bps;
    }

    /**
     * @notice Set the team's share of incoming tax.
     * @dev Capped at `MAX_TEAM_SHARE_BPS` in the contract, not by policy, so
     *      "the team can never take more than 0.5% of a trade" is a fact a
     *      holder can verify rather than a promise they have to accept.
     */
    function setTeamShareBps(uint16 bps) external onlyOwner {
        if (bps > MAX_TEAM_SHARE_BPS) revert TeamShareTooLarge(bps, MAX_TEAM_SHARE_BPS);
        emit TeamShareBpsSet(teamShareBps, bps);
        teamShareBps = bps;
    }

    /**
     * @notice Set the single address team revenue can be paid to.
     * @dev Re-pointable, unlike `loyal` — the team's payout address is an
     *      operational detail that may legitimately need to change, and it can
     *      only ever redirect the team's own declared share. It cannot reach
     *      corpus, staker income, or anything already claimed.
     */
    function setTeamRecipient(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit TeamRecipientSet(teamRecipient, to);
        teamRecipient = to;
    }

    function setSleeveBps(uint16 sleeveBps_) external onlyOwner {
        if (sleeveBps_ > MAX_SLEEVE_BPS) revert SleeveTooLarge(sleeveBps_, MAX_SLEEVE_BPS);
        emit SleeveBpsSet(sleeveBps, sleeveBps_);
        sleeveBps = sleeveBps_;
    }

    /**
     * @notice Exclude or re-include an account's LOYAL in `eligibleSupply()`.
     * @dev DEAD is unconditionally excluded and cannot be listed here — listing
     *      it would double-count and understate eligible supply, overstating the
     *      floor.
     */
    function setExclusion(address account, bool excluded) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (account == DEAD) revert CannotExcludeDead();
        if (isExcluded[account] == excluded) return;

        isExcluded[account] = excluded;
        if (excluded) {
            _excluded.push(account);
        } else {
            uint256 n = _excluded.length;
            for (uint256 i; i < n; ++i) {
                if (_excluded[i] == account) {
                    _excluded[i] = _excluded[n - 1];
                    _excluded.pop();
                    break;
                }
            }
        }
        emit ExclusionSet(account, excluded);
        _touch();
    }

    // -----------------------------------------------------------------------
    // Adapters — timelocked in, immediate out
    // -----------------------------------------------------------------------

    /**
     * @notice Start the clock on adding a yield adapter.
     * @dev Adding an adapter is the single most dangerous action available to
     *      governance: an adapter can hold the corpus. Spec §10 rates adapter
     *      exploit as Critical, so activation is delayed by `ADAPTER_TIMELOCK`
     *      to give holders time to exit at the current floor first.
     */
    function queueAdapter(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (isAdapter[adapter]) revert AdapterAlreadyActive();

        adapterQueuedAt[adapter] = block.timestamp;
        emit AdapterQueued(adapter, block.timestamp + ADAPTER_TIMELOCK);
    }

    function cancelQueuedAdapter(address adapter) external onlyOwner {
        if (adapterQueuedAt[adapter] == 0) revert AdapterNotQueued();
        delete adapterQueuedAt[adapter];
        emit AdapterQueueCancelled(adapter);
    }

    function activateAdapter(address adapter) external onlyOwner {
        uint256 queuedAt = adapterQueuedAt[adapter];
        if (queuedAt == 0) revert AdapterNotQueued();
        if (isAdapter[adapter]) revert AdapterAlreadyActive();

        uint256 executableAt = queuedAt + ADAPTER_TIMELOCK;
        if (block.timestamp < executableAt) revert TimelockNotElapsed(executableAt);

        delete adapterQueuedAt[adapter];
        isAdapter[adapter] = true;
        _adapters.push(adapter);
        emit AdapterAdded(adapter);
    }

    /**
     * @notice Remove an adapter. Immediate — no timelock.
     * @dev Removal is always safe and sometimes urgent (Beefy deprecates vaults
     *      routinely, spec §4.3), so it must never be delayed. A funded adapter
     *      cannot be removed, otherwise its assets would silently vanish from
     *      `nav()` and drop the floor.
     *
     *      An **unreadable** adapter, however, must always be removable. It
     *      already contributes zero to `nav()`, so leaving it listed preserves
     *      the fault forever — and if the emptiness check itself called into the
     *      broken adapter, the removal path would revert too and the Treasury
     *      would have no way out. Recovering value stranded in a broken adapter
     *      is necessarily an off-contract operation.
     */
    function removeAdapter(address adapter) external onlyOwner {
        if (!isAdapter[adapter]) revert AdapterNotActive();

        (uint256 assets, bool healthy) = adapterAssets(adapter);
        if (healthy && assets != 0) revert AdapterStillFunded(assets);

        isAdapter[adapter] = false;
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            if (_adapters[i] == adapter) {
                _adapters[i] = _adapters[n - 1];
                _adapters.pop();
                break;
            }
        }
        emit AdapterRemoved(adapter);
        _touch();
    }

    /// @notice Move ETH from the buffer into an adapter, within the sleeve cap.
    function depositToAdapter(address adapter, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (!isAdapter[adapter]) revert AdapterNotActive();
        if (amount == 0) revert NothingToFund();

        // Earmarked income must not be put at risk in a yield venue either.
        uint256 available = liquidEth();
        if (amount > available) revert InsufficientLiquidEth(amount, available);

        // NAV is unchanged by the move itself, so the cap is checked against it
        // directly: ETH simply relocates from the buffer into the sleeve.
        uint256 cap = sleeveCapWei();
        uint256 wouldBe = sleeveAssets() + amount;
        if (wouldBe > cap) revert SleeveCapExceeded(wouldBe, cap);

        IYieldAdapter(adapter).deposit{value: amount}();

        emit DepositedToAdapter(adapter, amount);
        _touch();
    }

    /// @notice Pull ETH back out of an adapter into the liquid buffer.
    function withdrawFromAdapter(address adapter, uint256 amount)
        external
        onlyOwner
        nonReentrant
        returns (uint256 received)
    {
        if (!isAdapter[adapter]) revert AdapterNotActive();

        uint256 before = address(this).balance;
        IYieldAdapter(adapter).withdraw(amount);
        received = address(this).balance - before;

        emit WithdrawnFromAdapter(adapter, amount, received);
        _touch();
    }

    /**
     * @notice Realize an adapter's surplus above its high-water mark.
     * @dev Permissionless: it can only move value from an adapter into this
     *      contract, which raises the floor. The Distributor pulls from here.
     */
    function realizeSurplus(address adapter) external nonReentrant returns (uint256 received) {
        if (!isAdapter[adapter]) revert AdapterNotActive();

        uint256 before = address(this).balance;
        IYieldAdapter(adapter).realizeSurplus();
        received = address(this).balance - before;

        // Realized surplus is INCOME, not corpus (spec §9). Earmarking it here
        // is what makes `distributeIncome()` possible at all — without this the
        // yield would silently become corpus and stakers could never be paid.
        if (received != 0) {
            pendingIncome += received;
            emit IncomeAccrued(received, pendingIncome);
        }

        emit SurplusRealized(adapter, received);
        _touch();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /// @dev Recompute the floor, track its high-water mark, announce both.
    function _touch() internal {
        uint256 n = nav();
        uint256 supply = eligibleSupply();
        uint256 floor = supply == 0 ? 0 : (n * WAD) / supply;

        if (floor > floorHighWaterMark) {
            floorHighWaterMark = floor;
        } else if (floor < floorHighWaterMark) {
            emit FloorRegression(floorHighWaterMark, floor, block.timestamp);
        }

        emit FloorUpdated(n, supply, block.timestamp);
    }
}
