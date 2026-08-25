// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITreasuryRedeem {
    function nav() external view returns (uint256);
    function floorPerToken() external view returns (uint256);
    function eligibleSupply() external view returns (uint256);
    function payout(address to, uint256 amount) external returns (uint256);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

interface IGate {
    function check(address account) external view returns (bool);
}

/**
 * @title Redeemer
 * @notice Burn LOYAL, receive a pro-rata share of the corpus at a haircut
 *         (spec §7). This is what turns an accumulating treasury into an actual
 *         price floor.
 *
 * ## The mechanism
 *
 * ```
 * requestRedeem(amount):
 *     snapshot floorPerToken            // BEFORE the burn — see below
 *     pull LOYAL and burn it now        // supply drops now → floor rises now
 *     enqueue(caller, amount, snapshot)
 *
 * execute(id) after redeemDelay:
 *     payFloor = min(snapshot, current) // no gaming a NAV move either way
 *     pay caller: amount × payFloor × (1 − haircut)
 * ```
 *
 * ## Snapshot before burn — this ordering is load-bearing
 *
 * Burning shrinks `eligibleSupply`, which *raises* `floorPerToken` for everyone
 * left. If the redeemer's own burn were included before their snapshot, they
 * would be paid at the very floor their exit created, and early redeemers would
 * drain more than their share: paying every holder at their post-burn floor
 * costs strictly more than the corpus holds. Snapshotting first pays exactly
 * `amount × nav / supply`, so full redemption of the entire supply drains the
 * corpus to precisely zero and no further.
 *
 * ## Why the haircut makes it a floor rather than a run
 *
 * The 5% stays in the corpus while the burned supply leaves. Every redemption
 * is therefore *accretive* to everyone who did not redeem — the floor ratchets
 * up as people exit. A run makes the remaining position stronger, which is the
 * opposite of a bank run and the entire point of the design.
 *
 * ## Burn is irreversible and there is no cancel
 *
 * Tokens are destroyed at request time, not at execution. That is what makes
 * the benefit to holders immediate and makes abandoning the queue non-free.
 * A `cancel()` would require re-minting, which LOYAL cannot do — its supply is
 * fixed by the Pons factory and there is no mint function.
 */
contract Redeemer is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;

    /// @notice Ceiling on the haircut, so governance cannot confiscate.
    uint16 public constant MAX_HAIRCUT_BPS = 2_000; // 20%

    /// @notice Ceiling on the delay, so governance cannot trap redeemers.
    uint256 public constant MAX_REDEEM_DELAY = 30 days;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable loyal;
    ITreasuryRedeem public immutable treasury;

    struct Request {
        address owner;
        uint128 amount;        // LOYAL burned
        uint128 snapshotFloor; // wei per whole LOYAL at request time
        uint64 requestedAt;
        bool executed;
    }

    Request[] private _queue;

    /// @notice Haircut retained by the corpus, in bps. Spec default 500 = 5%.
    uint16 public haircutBps = 500;

    /// @notice Delay between request and execution.
    uint256 public redeemDelay = 1 days;

    /// @notice Max fraction of NAV payable per epoch (spec §7 per-epoch cap).
    uint16 public epochCapBps = 2_000; // 20%
    uint256 public epochLength = 7 days;
    uint256 public epochStart;
    uint256 public epochPaidOut;

    uint256 public totalBurned;
    uint256 public totalPaidOut;

    /// @notice Optional eligibility gate (spec §11). Zero = open.
    IGate public gate;

    /// @notice Emergency stop for new requests. Never blocks `execute`.
    bool public requestsPaused;

    event RedeemRequested(
        uint256 indexed id,
        address indexed owner,
        uint256 amount,
        uint256 snapshotFloor,
        uint256 executableAt
    );
    event RedeemExecuted(
        uint256 indexed id,
        address indexed owner,
        uint256 amount,
        uint256 payFloor,
        uint256 paid
    );
    event BurnedViaDeadAddress(uint256 amount);
    event HaircutSet(uint16 previous, uint16 current);
    event RedeemDelaySet(uint256 previous, uint256 current);
    event EpochPolicySet(uint16 capBps, uint256 length);
    event GateSet(address indexed gate);
    event RequestsPausedSet(bool paused);

    error ZeroAmount();
    error ZeroAddress();
    error Paused();
    error NotAllowed(address account);
    error NoFloorYet();
    error AlreadyExecuted(uint256 id);
    error TooEarly(uint256 executableAt);
    error EpochCapReached(uint256 wouldBe, uint256 cap);
    error HaircutTooLarge(uint16 requested, uint16 max);
    error DelayTooLong(uint256 requested, uint256 max);
    error AmountTooLarge();

    constructor(address loyal_, address treasury_, address owner_) Ownable(owner_) {
        if (loyal_ == address(0) || treasury_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        loyal = IERC20(loyal_);
        treasury = ITreasuryRedeem(treasury_);
        epochStart = block.timestamp;
    }

    // -----------------------------------------------------------------------
    // Redemption
    // -----------------------------------------------------------------------

    /**
     * @notice Burn `amount` LOYAL and join the payout queue.
     * @dev The snapshot is taken BEFORE the burn — see the contract notes.
     */
    function requestRedeem(uint256 amount) external nonReentrant returns (uint256 id) {
        if (requestsPaused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (address(gate) != address(0) && !gate.check(msg.sender)) {
            revert NotAllowed(msg.sender);
        }

        // Snapshot first. Burning would raise the floor and overpay the redeemer.
        uint256 snapshotFloor = treasury.floorPerToken();
        if (snapshotFloor == 0) revert NoFloorYet();
        if (snapshotFloor > type(uint128).max) revert AmountTooLarge();

        loyal.safeTransferFrom(msg.sender, address(this), amount);
        _burn(amount);
        totalBurned += amount;

        id = _queue.length;
        _queue.push(
            Request({
                owner: msg.sender,
                amount: uint128(amount),
                snapshotFloor: uint128(snapshotFloor),
                requestedAt: uint64(block.timestamp),
                executed: false
            })
        );

        emit RedeemRequested(id, msg.sender, amount, snapshotFloor, block.timestamp + redeemDelay);
    }

    /**
     * @notice Execute a matured request. Permissionless — pays the owner, not
     *         the caller, so anyone may crank the queue.
     */
    function execute(uint256 id) external nonReentrant returns (uint256 paid) {
        Request storage r = _queue[id];
        if (r.executed) revert AlreadyExecuted(id);

        uint256 executableAt = uint256(r.requestedAt) + redeemDelay;
        if (block.timestamp < executableAt) revert TooEarly(executableAt);

        uint256 payFloor = _payFloor(r.snapshotFloor);
        uint256 gross = (uint256(r.amount) * payFloor) / WAD;
        paid = (gross * (BPS - haircutBps)) / BPS;

        _chargeEpoch(paid);

        r.executed = true;
        totalPaidOut += paid;

        if (paid != 0) treasury.payout(r.owner, paid);

        emit RedeemExecuted(id, r.owner, r.amount, payFloor, paid);
    }

    /**
     * @dev The price a request settles at.
     *
     *      `min(snapshot, current)` blocks BOTH "request during a spike, execute
     *      after" and its mirror. In practice `current` is usually higher,
     *      because burns ratchet the floor up, so this only bites when NAV
     *      genuinely fell.
     *
     *      The exception matters: once `eligibleSupply` hits zero — the last
     *      holder redeeming everything — `floorPerToken()` reports 0, because a
     *      per-token price over zero tokens is undefined rather than worthless.
     *      Taking the min against that would pay the final redeemer **nothing**
     *      and strand the entire corpus. The min rule exists to protect the
     *      holders who remain; with none remaining there is nobody to protect,
     *      so the snapshot stands.
     */
    function _payFloor(uint256 snapshotFloor) internal view returns (uint256) {
        if (treasury.eligibleSupply() == 0) return snapshotFloor;
        uint256 current = treasury.floorPerToken();
        return current < snapshotFloor ? current : snapshotFloor;
    }

    /// @dev Roll the epoch if it has elapsed, then enforce the cap.
    function _chargeEpoch(uint256 amount) internal {
        if (block.timestamp >= epochStart + epochLength) {
            epochStart = block.timestamp;
            epochPaidOut = 0;
        }
        uint256 cap = (treasury.nav() * epochCapBps) / BPS;
        uint256 wouldBe = epochPaidOut + amount;
        if (wouldBe > cap) revert EpochCapReached(wouldBe, cap);
        epochPaidOut = wouldBe;
    }

    /**
     * @dev Burn if the token supports it, otherwise send to the dead address.
     *      LOYAL is deployed by the Pons factory, so `burn()` is verified to
     *      exist but not something this contract controls. The Treasury excludes
     *      DEAD from `eligibleSupply`, so the fallback is economically identical
     *      — only `totalSupply()` stops being self-describing.
     */
    function _burn(uint256 amount) internal {
        try IBurnable(address(loyal)).burn(amount) {
            return;
        } catch {
            loyal.safeTransfer(DEAD, amount);
            emit BurnedViaDeadAddress(amount);
        }
    }

    // -----------------------------------------------------------------------
    // Views — names match the frontend's REDEEMER_ABI
    // -----------------------------------------------------------------------

    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    function requests(uint256 id) external view returns (Request memory) {
        return _queue[id];
    }

    /// @notice What a request would pay right now, and when it matures.
    function preview(uint256 id) external view returns (uint256 paid, uint256 executableAt, bool ready) {
        Request memory r = _queue[id];
        uint256 payFloor = _payFloor(r.snapshotFloor);
        uint256 gross = (uint256(r.amount) * payFloor) / WAD;
        paid = r.executed ? 0 : (gross * (BPS - haircutBps)) / BPS;
        executableAt = uint256(r.requestedAt) + redeemDelay;
        ready = !r.executed && block.timestamp >= executableAt;
    }

    /// @notice What `amount` would fetch if requested this instant.
    function quote(uint256 amount) external view returns (uint256) {
        uint256 gross = (amount * treasury.floorPerToken()) / WAD;
        return (gross * (BPS - haircutBps)) / BPS;
    }

    /// @notice Remaining payout capacity in the current epoch.
    function epochRemaining() external view returns (uint256) {
        uint256 cap = (treasury.nav() * epochCapBps) / BPS;
        uint256 used = block.timestamp >= epochStart + epochLength ? 0 : epochPaidOut;
        return cap > used ? cap - used : 0;
    }

    // -----------------------------------------------------------------------
    // Governance — bounded
    // -----------------------------------------------------------------------

    function setHaircutBps(uint16 bps) external onlyOwner {
        if (bps > MAX_HAIRCUT_BPS) revert HaircutTooLarge(bps, MAX_HAIRCUT_BPS);
        emit HaircutSet(haircutBps, bps);
        haircutBps = bps;
    }

    function setRedeemDelay(uint256 delay) external onlyOwner {
        if (delay > MAX_REDEEM_DELAY) revert DelayTooLong(delay, MAX_REDEEM_DELAY);
        emit RedeemDelaySet(redeemDelay, delay);
        redeemDelay = delay;
    }

    function setEpochPolicy(uint16 capBps, uint256 length) external onlyOwner {
        if (capBps > BPS) revert EpochCapReached(capBps, BPS);
        epochCapBps = capBps;
        epochLength = length;
        emit EpochPolicySet(capBps, length);
    }

    function setGate(address gate_) external onlyOwner {
        gate = IGate(gate_);
        emit GateSet(gate_);
    }

    /**
     * @notice Pause NEW requests. Cannot block `execute`.
     * @dev Deliberately asymmetric: already-burned tokens must always be able to
     *      complete their claim. A pause that trapped matured requests would
     *      turn an emergency stop into confiscation.
     */
    function setRequestsPaused(bool paused) external onlyOwner {
        requestsPaused = paused;
        emit RequestsPausedSet(paused);
    }
}
