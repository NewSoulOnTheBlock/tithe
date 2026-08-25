// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardSink {
    function notifyReward() external payable;
    function totalWeight() external view returns (uint256);
}

/**
 * @title Distributor
 * @notice Routes protocol income to stLOYAL. One destination, fixed at
 *         construction.
 *
 * ## Why a router at all, with only one sink
 *
 * It was folded away once, on the grounds that with a single ETH-denominated
 * sink a router only forwards value and re-derives accounting the vault already
 * keeps. Then Suits arrived and a split had to live somewhere, so it came back.
 * Suits is now gone again and the split with it — but the contract stays,
 * because the Treasury calls `distributor.distribute{value: ...}()` and having
 * one address to re-point is what makes a second sink a deployment rather than
 * a Treasury upgrade.
 *
 * ## No owner, and that is the point
 *
 * Losing the second sink removed the split, `suitsBps`, the reroute logic and
 * `Ownable` with it. There is no privileged caller on this contract at all:
 * nothing to set, nothing to pause, and no address that can redirect the
 * income stream. The destination is immutable and no argument names one, so a
 * permissionless caller can only push value along the path it was always going
 * to take.
 *
 * ## Weight, not supply
 *
 * `StakedLoyal` divides rewards by **weight**, not share count — an unlocked
 * staker counts half, a week-locked one counts triple. So the "is anyone there
 * to receive this" question has to be asked of `totalWeight()`. Asking
 * `totalSupply()` would say yes in a state where the vault itself would revert.
 *
 * ## Nothing is ever parked here
 *
 * If the vault has no weight the call reverts and the caller keeps its ETH to
 * retry later. Holding an undistributable balance would quietly accrue an
 * obligation nobody can claim and no accounting elsewhere can see.
 */
contract Distributor is ReentrancyGuard {
    /// @notice The single, immutable destination for all distributed income.
    IRewardSink public immutable stakedLoyal;

    /// @notice Everything ever forwarded to stLOYAL.
    uint256 public cumulativeToLoyal;

    event Distributed(uint256 amount);

    error NothingToDistribute();
    error NoStakers();
    error ZeroAddress();

    constructor(address stakedLoyal_) {
        if (stakedLoyal_ == address(0)) revert ZeroAddress();
        stakedLoyal = IRewardSink(stakedLoyal_);
    }

    /// @notice Forward the attached ETH to stLOYAL. Permissionless.
    function distribute() external payable nonReentrant {
        uint256 total = msg.value;
        if (total == 0) revert NothingToDistribute();
        if (stakedLoyal.totalWeight() == 0) revert NoStakers();

        cumulativeToLoyal += total;
        stakedLoyal.notifyReward{value: total}();

        emit Distributed(total);
    }

    /**
     * @notice How `amount` would be routed right now.
     * @dev Kept so Treasury-side tooling has a uniform shape whether or not a
     *      second sink ever returns. With one destination the answer is always
     *      "all of it", and a caller should not have to special-case that.
     */
    function preview(uint256 amount) external pure returns (uint256 toLoyal) {
        return amount;
    }

    /// @dev Plain transfers are accepted but do nothing until `flush()`.
    receive() external payable {}

    /**
     * @notice Push any idle balance through to stLOYAL. Permissionless.
     * @dev Re-enters through the payable path so one rule governs both entries
     *      — a stray transfer cannot take a shortcut past the weight check.
     */
    function flush() external returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();
        (bool ok, ) = address(this).call{value: amount}(
            abi.encodeWithSelector(this.distribute.selector)
        );
        if (!ok) revert NoStakers();
    }
}
