import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, setBalance, impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The staking vault against the REAL LOYAL token, on a fork of chain 4663.
 *
 * ## Why the mock suite is not enough on its own
 *
 * Every other test deploys `MockLoyal` — a textbook OpenZeppelin ERC-20. The
 * real token is a Pons launch, and the assumptions the vault makes about it are
 * assumptions about *that* contract, not about the standard:
 *
 *   - `transferFrom` returns true and moves exactly the amount asked for
 *     (no fee-on-transfer, which would break every 4626 accounting invariant)
 *   - no transfer hook that can revert, reenter, or block the vault
 *   - no blacklist, no pausable, no rebasing supply
 *   - 18 decimals, so the vault's 21 is underlying + 3
 *
 * A mock cannot falsify any of those, because a mock is written to satisfy
 * them. Only the deployed bytecode can.
 *
 * Run with:  FORK=1 npx hardhat test test/ForkLoyal.test.ts
 * Skipped otherwise, so the default suite stays offline and fast.
 */

const LOYAL_TOKEN = "0x1B7f9c45DfF56d8b4309f01afb4763d9C595318e";
const WAD = 10n ** 18n;
const RICH = 100n * WAD;

const forking = !!process.env.FORK;

(forking ? describe : describe.skip)("FORK 4663 — StakedLoyal against the real LOYAL", () => {
  let owner: any, alice: any, bob: any, stranger: any;
  let loyal: any, staking: any, distributor: any;
  /** An address that actually holds LOYAL on chain, impersonated. */
  let whale: any;

  before(async function () {
    this.timeout(180_000);

    // Chain 4663 has no hardfork-activation history in Hardhat's table, and a
    // call executed *at* the fork block fails with "No known hardfork for
    // execution on historical block". Mining one block moves execution past it
    // and everything after works — the declared `hardforkHistory` in
    // hardhat.config covers the rest.
    await network.provider.send("evm_mine");

    const net = await ethers.provider.getNetwork();
    expect(Number(net.chainId)).to.equal(4663);

    [owner, alice, bob, stranger] = await ethers.getSigners();
    for (const s of [owner, alice, bob, stranger]) await setBalance(s.address, RICH);

    loyal = await ethers.getContractAt(
      [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
        "function transfer(address,uint256) returns (bool)",
        "function approve(address,uint256) returns (bool)",
        "function transferFrom(address,address,uint256) returns (bool)",
      ],
      LOYAL_TOKEN
    );

    // The curve custodies the unsold supply, so it is the reliable source of
    // real tokens on a fork — no need to hunt for a holder that may have
    // moved on since the pin block.
    const curve = "0x46286E8Fb83BAAfaa7D9Af26cc6d52e3EEcA205b";
    const holder = (await loyal.balanceOf(curve)) > 0n ? curve : LOYAL_TOKEN;

    await impersonateAccount(holder);
    whale = await ethers.getSigner(holder);
    await setBalance(holder, RICH);

    staking = await (
      await ethers.getContractFactory("StakedLoyal")
    ).deploy(LOYAL_TOKEN, owner.address);

    distributor = await (
      await ethers.getContractFactory("Distributor")
    ).deploy(await staking.getAddress());
  });

  /** Move real LOYAL to `who` and stake it. */
  const fund = async (who: any, amount: bigint) => {
    await loyal.connect(whale).transfer(who.address, amount);
    await loyal.connect(who).approve(await staking.getAddress(), amount);
    await staking.connect(who).deposit(amount, who.address);
  };

  it("reads the real token's metadata, and the vault derives from it", async () => {
    expect(await loyal.symbol()).to.equal("LOYAL");
    expect(await loyal.decimals()).to.equal(18n);

    // Name and symbol are composed from the underlying at construction, so
    // this proves the vault actually bound to the right contract.
    expect(await staking.name()).to.equal("Staked Loyal");
    expect(await staking.symbol()).to.equal("stLOYAL");
    // 18 underlying + the 3-decimal virtual-share offset.
    expect(await staking.decimals()).to.equal(21n);
  });

  it("takes a deposit of real LOYAL with no transfer fee", async function () {
    this.timeout(120_000);

    const amount = 1_000_000n * WAD;
    const before = await loyal.balanceOf(await staking.getAddress());
    await fund(alice, amount);
    const after = await loyal.balanceOf(await staking.getAddress());

    // The single most important property. A fee-on-transfer token would land
    // less than `amount` here and every share-price invariant in the vault
    // would be quietly wrong from the first deposit onward.
    expect(after - before).to.equal(amount);
    expect(await staking.totalAssets()).to.equal(amount);
    expect(await staking.convertToAssets(await staking.balanceOf(alice.address))).to.equal(amount);
  });

  it("weights, pays and settles exactly as the mock suite says", async function () {
    this.timeout(120_000);

    await fund(bob, 1_000_000n * WAD);
    await staking.connect(bob).lock(2); // WEEK, 3x

    // alice is unlocked (0.5x), bob is week-locked (3x) → 1 : 6.
    await staking.connect(owner).notifyReward({ value: 7n * WAD });

    const a = await staking.pendingYield(alice.address);
    const b = await staking.pendingYield(bob.address);
    expect(b).to.equal(a * 6n);
    expect(a + b).to.equal(7n * WAD);
  });

  it("lets a real holder actually claim the ETH", async function () {
    this.timeout(120_000);

    const owed = await staking.pendingYield(alice.address);
    expect(owed).to.be.greaterThan(0n);

    const before = await ethers.provider.getBalance(alice.address);
    const rc = await (await staking.connect(alice).claim()).wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    const after = await ethers.provider.getBalance(alice.address);

    expect(after - before + gas).to.equal(owed);
    expect(await staking.pendingYield(alice.address)).to.equal(0n);
  });

  it("blocks a locked exit and releases it on time, against the real token", async function () {
    this.timeout(120_000);

    await expect(
      staking.connect(bob).redeem(await staking.balanceOf(bob.address), bob.address, bob.address)
    ).to.be.revertedWithCustomError(staking, "StillLocked");

    await time.increase(7 * 24 * 3600 + 1);

    const shares = await staking.balanceOf(bob.address);
    const expected = await staking.convertToAssets(shares);
    const before = await loyal.balanceOf(bob.address);

    await staking.connect(bob).redeem(shares, bob.address, bob.address);

    // Real tokens come back, in the amount the vault promised.
    expect((await loyal.balanceOf(bob.address)) - before).to.equal(expected);
    expect(await staking.weightOf(bob.address)).to.equal(0n);
  });

  it("routes income through the Distributor to the real vault", async function () {
    this.timeout(120_000);

    // alice is the only staker left after bob's exit.
    await distributor.connect(stranger).distribute({ value: 2n * WAD });

    expect(await staking.cumulativeRewards()).to.be.greaterThan(0n);
    expect(await staking.pendingYield(alice.address)).to.equal(2n * WAD);
    expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
  });

  it("still holds at least what it owes", async () => {
    const owed = await staking.pendingYield(alice.address);
    const held = await ethers.provider.getBalance(await staking.getAddress());
    expect(held).to.be.greaterThanOrEqual(owed);
  });
});
