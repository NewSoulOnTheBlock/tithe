// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IYieldAdapter
 * @notice The ONLY integration surface between the Treasury and any external
 *         yield venue (spec §3.1). Every adapter is ETH-in / ETH-out, because
 *         the corpus is ETH-denominated — an adapter that needs a price oracle
 *         to report `totalAssets` in ETH is out of scope for v1.
 *
 * Implementation rules, all of which exist because the corpus IS the token's
 * value (spec §10, "adapter exploit — Critical"):
 *
 *  1. `totalAssets()` MUST be denominated in wei and MUST NOT revert. The
 *     Treasury sums it inside `nav()`, and a reverting adapter would brick
 *     redemption for everyone.
 *  2. `totalAssets()` MUST NOT be trusted as a redemption price on its own.
 *     LP/CLM share prices are manipulable within a block (spec §6.3), so the
 *     Redeemer applies the lag — not the adapter.
 *  3. `realizeSurplus()` MUST only return value above a principal high-water
 *     mark it maintains itself (spec §9). a yield venue auto-compounds, so there is no
 *     harvest; unrealized appreciation must stay in the corpus and raise the
 *     floor rather than being paid to stakers. Impermanent loss below the mark
 *     pays zero — it never funds distribution out of principal.
 *  4. `withdraw()` MUST send ETH to `msg.sender` (the Treasury) and MUST
 *     return the amount actually received, which may be less than requested.
 */
interface IYieldAdapter {
    /// @notice Deposit the attached ETH into the venue.
    function deposit() external payable;

    /// @notice Withdraw up to `amount` wei back to the caller (the Treasury).
    /// @return withdrawn Amount of wei actually returned. May be < `amount`.
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Realize appreciation above the adapter's principal high-water
    ///         mark and send it to the caller. Returns 0 when underwater.
    function realizeSurplus() external returns (uint256 realized);

    /// @notice Current value of this adapter's position, in wei. Must not revert.
    function totalAssets() external view returns (uint256);

    /**
     * @notice Corpus principal deployed here — the high-water mark. Must not revert.
     * @dev The Treasury values the sleeve at `min(totalAssets, principal)` when
     *      computing NAV, which is what keeps the floor honest in both
     *      directions:
     *
     *      - Appreciation **above** the mark is income owed to stakers, not
     *        corpus. Counting it would inflate the floor and then deflate it the
     *        moment the surplus was realized and paid out.
     *      - Depreciation **below** the mark is a real loss of corpus, and the
     *        floor must fall to reflect it.
     *
     *      So the mark must only move on deposits and withdrawals of principal,
     *      never on price movement.
     */
    function principal() external view returns (uint256);
}
