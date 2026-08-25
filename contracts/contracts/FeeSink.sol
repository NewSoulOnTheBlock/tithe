// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITreasuryFund {
    function fund() external payable;
}

/// @dev Pons V2FeeEscrow. Verified on chain 4663 — these signatures are read
///      from the published ABI, not inferred from bytecode.
interface IV2FeeEscrow {
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

/// @dev Pons bonding curve. NOT verified on chain 4663 — `sweepFees` was
///      recovered from bytecode. Its authorization was proven empirically:
///      a staticCall succeeds only from the curve's own `deployer`.
interface IPonsCurve {
    function sweepFees(uint256 amount) external;
    function creatorTaxBalance() external view returns (uint256);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title FeeSink
 * @notice The address registered as LOYAL's `creatorFeeRecipient` **at launch**.
 *
 * ## Why v2 exists
 *
 * The first version had only `receive()` and `sweep()`. That was not enough, and
 * the gap was structural rather than cosmetic:
 *
 *   - Pons fees are **pull-based**. `V2FeeEscrow.claim()` pays `msg.sender`, so
 *     the registered recipient must be able to *call* it. A contract with no
 *     `claim()` forwarder can be named as recipient and still never collect.
 *   - Pre-graduation, tax accrues on the bonding curve and only the curve's
 *     `deployer` — which is the creator-fee recipient — may call `sweepFees()`.
 *     Same problem.
 *
 * So a recipient contract must be able to reach *both* paths. v1 could reach
 * neither. This version forwards to both, and to nothing else.
 *
 * ## Trust model
 *
 * `treasury` and `escrow` are `immutable`; `curve` is write-once and, once set,
 * `owner` is automatically renounced. After `setCurve()` the contract has **no
 * privileged caller at all** and every remaining function is permissionless.
 *
 * Nothing here takes a destination parameter. ETH can only ever reach
 * `treasury`; tokens can only ever reach `treasury`. There is no path by which
 * any caller — including the owner, during the one call they have — can direct
 * value anywhere else. That is what makes the collectors safe to expose openly.
 *
 * ## The hot path is still empty
 *
 * `receive()` remains a no-op. The Pons payout may forward only a **2300-gas
 * stipend**, and any storage write (~20k gas) would revert — losing the fee or
 * bricking the swap that produced it. All logic lives in explicitly-called
 * functions, never in the fallback.
 */
contract FeeSink {
    /// @notice Immutable destination for every asset this contract touches.
    ITreasuryFund public immutable treasury;

    /// @notice Pons V2FeeEscrow, the post-graduation fee path.
    IV2FeeEscrow public immutable escrow;

    /// @notice The bonding curve. Unknown until launch, so write-once.
    IPonsCurve public curve;

    /// @notice Cleared permanently by `setCurve`. No other function uses it.
    address public owner;

    event Swept(uint256 amount);
    event ClaimedEth(uint256 amount);
    event ClaimedToken(address indexed token, uint256 amount);
    event CurveSwept(uint256 requested, uint256 received);
    event CurveSet(address indexed curve);
    event OwnerRenounced();
    event TokenForwarded(address indexed token, uint256 amount);

    error ZeroAddress();
    error NothingToSweep();
    error NotOwner();
    error CurveAlreadySet(address current);
    error CurveNotSet();
    error NotAContract(address target);
    error TransferFailed();

    constructor(address treasury_, address escrow_, address owner_) {
        if (treasury_ == address(0) || escrow_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        treasury = ITreasuryFund(treasury_);
        escrow = IV2FeeEscrow(escrow_);
        owner = owner_;
    }

    // -----------------------------------------------------------------------
    // Hot path — must stay free of storage writes
    // -----------------------------------------------------------------------

    receive() external payable {}
    fallback() external payable {}

    // -----------------------------------------------------------------------
    // One-time wiring
    // -----------------------------------------------------------------------

    /**
     * @notice Bind the bonding curve, then renounce ownership forever.
     * @dev The curve address only exists after `launchToken`, which is why this
     *      cannot be a constructor argument. Renouncing in the same call means
     *      the privileged window is exactly one transaction wide.
     */
    function setCurve(address curve_) external {
        if (msg.sender != owner) revert NotOwner();
        if (curve_ == address(0)) revert ZeroAddress();
        if (address(curve) != address(0)) revert CurveAlreadySet(address(curve));
        if (curve_.code.length == 0) revert NotAContract(curve_);

        curve = IPonsCurve(curve_);
        owner = address(0);

        emit CurveSet(curve_);
        emit OwnerRenounced();
    }

    // -----------------------------------------------------------------------
    // Collectors — all permissionless, all single-destination
    // -----------------------------------------------------------------------

    /// @notice Pull ETH credited to this contract in the Pons fee escrow.
    function claimFromEscrow() external returns (uint256 amount) {
        amount = escrow.claim();
        emit ClaimedEth(amount);
    }

    /**
     * @notice Pull a token credited to this contract in the Pons fee escrow.
     * @dev The hook emits fees for **both** swap legs, so a token leg can exist
     *      even though `sweepPoolFees` normally converts it to quote first.
     */
    function claimTokenFromEscrow(address token) external returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        amount = escrow.claimToken(token);
        emit ClaimedToken(token, amount);
    }

    /**
     * @notice Sweep accrued creator tax off the bonding curve.
     * @dev Only the curve's `deployer` may call `sweepFees`, and launching with
     *      `params.creatorFeeRecipient = address(this)` makes that this
     *      contract. Passing 0 sweeps the full accrued balance.
     */
    function sweepCurve(uint256 amount) external returns (uint256 received) {
        if (address(curve) == address(0)) revert CurveNotSet();

        uint256 before = address(this).balance;
        curve.sweepFees(amount == 0 ? curve.creatorTaxBalance() : amount);
        received = address(this).balance - before;

        emit CurveSwept(amount, received);
    }

    /// @notice Forward the full ETH balance to the Treasury.
    function sweep() public returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        treasury.fund{value: amount}();
        emit Swept(amount);
    }

    /**
     * @notice Forward an ERC-20 balance to the Treasury.
     * @dev Destination is hard-coded, so this grants no discretion. The Treasury
     *      marks LOYAL at zero, so forwarding the token leg parks it out of
     *      circulation rather than inflating NAV.
     */
    function forwardToken(address token) external returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        if (!IERC20Min(token).transfer(address(treasury), amount)) revert TransferFailed();
        emit TokenForwarded(token, amount);
    }

    /**
     * @notice Run the whole ETH path in one transaction: claim, sweep, forward.
     * @dev Each leg is attempted independently — a keeper should not lose the
     *      curve sweep because the escrow happened to be empty, or vice versa.
     *      Reverts only if there is genuinely nothing to move anywhere.
     */
    function collect() external returns (uint256 delivered) {
        try escrow.claim() returns (uint256 a) {
            if (a != 0) emit ClaimedEth(a);
        } catch {}

        if (address(curve) != address(0)) {
            try curve.creatorTaxBalance() returns (uint256 bal) {
                if (bal != 0) {
                    uint256 before = address(this).balance;
                    try curve.sweepFees(bal) {
                        emit CurveSwept(bal, address(this).balance - before);
                    } catch {}
                }
            } catch {}
        }

        delivered = address(this).balance;
        if (delivered == 0) revert NothingToSweep();
        treasury.fund{value: delivered}();
        emit Swept(delivered);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice ETH claimable from the escrow, plus tax accrued on the curve.
    function collectable() external view returns (uint256 inEscrow, uint256 onCurve, uint256 held) {
        try escrow.balanceOf(address(this)) returns (uint256 a) { inEscrow = a; } catch {}
        if (address(curve) != address(0)) {
            try curve.creatorTaxBalance() returns (uint256 b) { onCurve = b; } catch {}
        }
        held = address(this).balance;
    }
}
