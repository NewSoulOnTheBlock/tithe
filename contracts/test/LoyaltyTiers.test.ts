import { expect } from "chai";
import { ethers } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * StakedLoyal — the loyalty tiers, and the invariants they must not break.
 *
 * Two halves. The first proves the tier arithmetic does what the product says:
 * 0.5x / 1x / 3x, locks that hold, and an expiry anybody can enforce. The
 * second is adversarial — the things that would actually lose money, several of
 * which the original suite never touched: the 4626 donation attack, reentrancy
 * on the ETH payout, and whether the accumulator can ever promise more ETH than
 * the contract was given.
 */

const RICH = 10_000_000n * 10n ** 18n;
const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;

const NONE = 0, DAY = 1, WEEK = 2;

describe("StakedLoyal — loyalty tiers", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let loyal: any, staking: any;

  /** Give `who` LOYAL and stake `amount` of it. */
  const stake = async (who: HardhatEthersSigner, amount: bigint) => {
    await loyal.transfer(who.address, amount);
    await loyal.connect(who).approve(await staking.getAddress(), amount);
    await staking.connect(who).deposit(amount, who.address);
  };

  const notify = (amount: bigint) =>
    staking.connect(owner).notifyReward({ value: amount });

  beforeEach(async () => {
    [owner, alice, bob, carol, stranger] = await ethers.getSigners();
    for (const s of [owner, alice, bob, carol, stranger]) await setBalance(s.address, RICH);

    loyal = await (await ethers.getContractFactory("MockLoyal")).deploy(SUPPLY);
    staking = await (
      await ethers.getContractFactory("StakedLoyal")
    ).deploy(await loyal.getAddress(), owner.address);
  });

  // =======================================================================
  // The multipliers
  // =======================================================================
  describe("multipliers", () => {
    it("weights an unlocked staker at half", async () => {
      await stake(alice, 1000n * WAD);
      // Shares carry the vault's 3-decimal offset, so weight is derived from
      // the share balance rather than from the assets deposited.
      const shares = await staking.balanceOf(alice.address);
      expect(await staking.weightOf(alice.address)).to.equal(shares / 2n);
      expect(await staking.totalWeight()).to.equal(shares / 2n);
    });

    it("weights a 1-day lock at one, and a 1-week lock at three", async () => {
      await stake(alice, 1000n * WAD);
      const shares = await staking.balanceOf(alice.address);

      await staking.connect(alice).lock(DAY);
      expect(await staking.weightOf(alice.address)).to.equal(shares);

      await staking.connect(alice).lock(WEEK);
      expect(await staking.weightOf(alice.address)).to.equal(shares * 3n);
    });

    it("splits a reward 1 : 2 : 6 across the three tiers", async () => {
      // Equal stakes, different commitments. 0.5 : 1 : 3 normalises to 1 : 2 : 6.
      for (const who of [alice, bob, carol]) await stake(who, 1000n * WAD);
      await staking.connect(bob).lock(DAY);
      await staking.connect(carol).lock(WEEK);

      await notify(9n * WAD);

      const a = await staking.pendingYield(alice.address);
      const b = await staking.pendingYield(bob.address);
      const c = await staking.pendingYield(carol.address);

      expect(b).to.equal(a * 2n);
      expect(c).to.equal(a * 6n);
      // And the whole reward is handed out — multipliers divide, they do not mint.
      expect(a + b + c).to.equal(9n * WAD);
    });

    it("pays out the full reward even when every staker is at half", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 3000n * WAD);
      await notify(WAD);

      const total =
        (await staking.pendingYield(alice.address)) +
        (await staking.pendingYield(bob.address));
      expect(total).to.equal(WAD);
    });

    it("scales weight when a locked staker adds more", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      const before = await staking.weightOf(alice.address);

      await stake(alice, 1000n * WAD);
      expect(await staking.weightOf(alice.address)).to.equal(before * 2n);
      expect(await staking.tierOf(alice.address)).to.equal(WEEK);
    });
  });

  // =======================================================================
  // The lock
  // =======================================================================
  describe("the lock holds", () => {
    it("blocks withdrawal while locked, and allows it after", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(DAY);

      await expect(
        staking.connect(alice).withdraw(1n * WAD, alice.address, alice.address)
      ).to.be.revertedWithCustomError(staking, "StillLocked");

      await time.increase(24 * 3600 + 1);
      await expect(staking.connect(alice).withdraw(1n * WAD, alice.address, alice.address))
        .to.not.be.reverted;
    });

    it("blocks redeem too — both exits burn, so both are covered", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      const shares = await staking.balanceOf(alice.address);

      await expect(
        staking.connect(alice).redeem(shares, alice.address, alice.address)
      ).to.be.revertedWithCustomError(staking, "StillLocked");
    });

    it("blocks transfer, so a 3x position cannot be sold to someone who never committed", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);

      await expect(
        staking.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(staking, "StillLocked");
    });

    it("still lets a locked staker RECEIVE shares and claim rewards", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      await notify(WAD);

      // Incoming transfer: allowed, because only `from` is restricted.
      await expect(staking.connect(bob).transfer(alice.address, 1n * WAD)).to.not.be.reverted;
      await expect(staking.connect(alice).claim()).to.not.be.reverted;
    });

    it("refuses to downgrade a standing lock", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);

      await expect(
        staking.connect(alice).lock(DAY)
      ).to.be.revertedWithCustomError(staking, "CannotDowngradeWhileLocked");
      await expect(
        staking.connect(alice).lock(NONE)
      ).to.be.revertedWithCustomError(staking, "CannotDowngradeWhileLocked");
    });

    it("permits an upgrade mid-lock", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(DAY);
      await expect(staking.connect(alice).lock(WEEK)).to.not.be.reverted;
      expect(await staking.tierOf(alice.address)).to.equal(WEEK);
    });

    it("never shortens an existing commitment", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      const until = await staking.lockedUntil(alice.address);

      // Six days in, re-locking at WEEK must extend rather than reset shorter.
      await time.increase(6 * 24 * 3600);
      await staking.connect(alice).lock(WEEK);
      expect(await staking.lockedUntil(alice.address)).to.be.greaterThan(until);
    });
  });

  // =======================================================================
  // Expiry, and the kick that enforces it
  // =======================================================================
  describe("expiry", () => {
    it("reports the effective tier as NONE once the lock runs out", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(DAY);
      expect(await staking.effectiveTier(alice.address)).to.equal(DAY);

      await time.increase(24 * 3600 + 1);
      // The stored tier is stale; the effective one is honest.
      expect(await staking.tierOf(alice.address)).to.equal(DAY);
      expect(await staking.effectiveTier(alice.address)).to.equal(NONE);
    });

    it("lets a stranger kick an expired lock", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      const heavy = await staking.totalWeight();

      await time.increase(7 * 24 * 3600 + 1);
      await expect(staking.connect(stranger).kick(alice.address))
        .to.emit(staking, "Kicked")
        .withArgs(alice.address, stranger.address);

      expect(await staking.tierOf(alice.address)).to.equal(NONE);
      expect(await staking.totalWeight()).to.equal(heavy / 6n); // 3x → 0.5x
    });

    it("refuses to kick a lock that is still standing", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      await expect(
        staking.connect(stranger).kick(alice.address)
      ).to.be.revertedWithCustomError(staking, "StillLocked");
    });

    it("refuses to kick someone who is already at NONE", async () => {
      await stake(alice, 1000n * WAD);
      await expect(
        staking.connect(stranger).kick(alice.address)
      ).to.be.revertedWithCustomError(staking, "NotExpired");
    });

    it("pays every other staker more once a stale multiplier is removed", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);

      await notify(WAD);
      const bobBefore = await staking.pendingYield(bob.address);

      await time.increase(7 * 24 * 3600 + 1);
      await staking.connect(bob).kick(alice.address);

      await notify(WAD);
      const bobGain = (await staking.pendingYield(bob.address)) - bobBefore;

      // Before: 0.5 of 3.5 total weight. After: 0.5 of 1.0. Bob's share of the
      // second reward is the larger one, which is the incentive to kick at all.
      expect(bobGain).to.be.greaterThan(bobBefore);
    });

    it("does NOT rewrite history — rewards earned at 3x survive the kick", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);

      await notify(WAD);
      const earnedAt3x = await staking.pendingYield(alice.address);

      await time.increase(7 * 24 * 3600 + 1);
      await staking.connect(stranger).kick(alice.address);

      // The accumulator already divided that reward by a totalWeight that
      // included the 3x. Clawing it back would owe out ETH that was never sent.
      expect(await staking.pendingYield(alice.address)).to.equal(earnedAt3x);
    });

    it("demotes on the account's own next action, without needing a kick", async () => {
      await stake(alice, 1000n * WAD);
      await staking.connect(alice).lock(WEEK);
      await time.increase(7 * 24 * 3600 + 1);

      // Withdrawing is allowed now, and it re-derives weight on the way through.
      await staking.connect(alice).withdraw(1n * WAD, alice.address, alice.address);
      const shares = await staking.balanceOf(alice.address);
      expect(await staking.weightOf(alice.address)).to.equal(shares / 2n);
    });
  });

  // =======================================================================
  // Adversarial
  // =======================================================================
  describe("adversarial", () => {
    it("carries 21 decimals, and converts round-trip", async () => {
      // The 3-decimal offset is the donation defence. It also means a share
      // balance formatted as 18dp reads 1000x too large — a live display bug on
      // the other chain before it was caught.
      expect(await staking.decimals()).to.equal(21);

      await stake(alice, 1000n * WAD);
      const shares = await staking.balanceOf(alice.address);
      expect(shares).to.equal(1000n * WAD * 1000n);
      expect(await staking.convertToAssets(shares)).to.equal(1000n * WAD);
    });

    it("neutralises the classic first-depositor donation attack", async () => {
      // Attacker deposits 1 wei, then donates a large amount directly, hoping
      // the next depositor's shares round to zero.
      await loyal.transfer(alice.address, 1000n * WAD);
      await loyal.connect(alice).approve(await staking.getAddress(), 1000n * WAD);
      await staking.connect(alice).deposit(1n, alice.address);
      await loyal.connect(alice).transfer(await staking.getAddress(), 100n * WAD);

      await stake(bob, 100n * WAD);

      // Bob must not be wiped out: with the offset he still receives shares
      // worth close to what he put in.
      const bobShares = await staking.balanceOf(bob.address);
      expect(bobShares).to.be.greaterThan(0n);
      const bobAssets = await staking.convertToAssets(bobShares);
      expect(bobAssets).to.be.greaterThan((100n * WAD * 90n) / 100n);
    });

    it("survives a reentrant claim", async () => {
      const attacker = await (
        await ethers.getContractFactory("ReentrantClaimer")
      ).deploy(await staking.getAddress());

      await loyal.transfer(await attacker.getAddress(), 1000n * WAD);
      await attacker.stake(await loyal.getAddress(), 1000n * WAD);
      await stake(bob, 1000n * WAD);

      await notify(2n * WAD);
      const owed = await staking.pendingYield(await attacker.getAddress());

      const before = await ethers.provider.getBalance(await attacker.getAddress());
      await attacker.attack();
      const after = await ethers.provider.getBalance(await attacker.getAddress());

      // Paid exactly once, and the re-entry never landed.
      expect(after - before).to.equal(owed);
      expect(await attacker.reenteredTimes()).to.equal(0n);
      expect(await staking.pendingYield(await attacker.getAddress())).to.equal(0n);
    });

    it("treats a self-transfer as a no-op for accounting", async () => {
      await stake(alice, 1000n * WAD);
      await notify(WAD);
      const before = await staking.pendingYield(alice.address);
      const weight = await staking.weightOf(alice.address);

      await staking.connect(alice).transfer(alice.address, 500n * WAD);

      expect(await staking.pendingYield(alice.address)).to.equal(before);
      expect(await staking.weightOf(alice.address)).to.equal(weight);
      expect(await staking.totalWeight()).to.equal(weight);
    });

    it("never promises more ETH than it was given", async () => {
      // A deliberately messy sequence: mixed tiers, transfers, partial exits,
      // a kick, and rewards landing between each. The invariant has to hold at
      // the end regardless of the path taken to get there.
      await stake(alice, 1000n * WAD);
      await stake(bob, 2500n * WAD);
      await stake(carol, 700n * WAD);

      await staking.connect(bob).lock(DAY);
      await staking.connect(carol).lock(WEEK);
      await notify(3n * WAD);

      await staking.connect(alice).transfer(bob.address, 250n * WAD);
      await notify(WAD);

      await staking.connect(alice).claim();
      await notify(2n * WAD);

      await time.increase(8 * 24 * 3600);
      await staking.connect(stranger).kick(carol.address);
      await staking.connect(stranger).kick(bob.address);
      await notify(WAD);

      await staking.connect(bob).withdraw(100n * WAD, bob.address, bob.address);
      await notify(WAD);

      const outstanding =
        (await staking.pendingYield(alice.address)) +
        (await staking.pendingYield(bob.address)) +
        (await staking.pendingYield(carol.address));

      const notified: bigint = await staking.cumulativeRewards();
      const claimed: bigint = await staking.cumulativeClaimed();

      // Everything still owed, plus everything already paid, can never exceed
      // what was actually delivered. Dust rounds DOWN and stays behind.
      expect(outstanding + claimed).to.be.lessThanOrEqual(notified);

      // And the contract holds at least what it still owes.
      const held = await ethers.provider.getBalance(await staking.getAddress());
      expect(held).to.be.greaterThanOrEqual(outstanding);
    });

    it("strands only dust, not a meaningful share, across many rewards", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 3333n * WAD);
      await staking.connect(bob).lock(WEEK);

      let notified = 0n;
      for (let i = 0; i < 25; i++) {
        const amount = WAD / 7n + BigInt(i);
        await notify(amount);
        notified += amount;
      }

      const owed =
        (await staking.pendingYield(alice.address)) +
        (await staking.pendingYield(bob.address));

      // Rounding-down in the accumulator strands a little on every notify. It
      // must stay negligible rather than accumulating into real money.
      const stranded = notified - owed;
      expect(stranded).to.be.lessThan(1000n); // wei, across 25 rounds
    });

    it("reverts a reward when nobody carries any weight", async () => {
      await expect(notify(WAD)).to.be.revertedWithCustomError(staking, "NoStakers");

      await stake(alice, 1000n * WAD);
      await staking.connect(alice).redeem(
        await staking.balanceOf(alice.address), alice.address, alice.address
      );
      // Everyone has left again — the ETH is refused rather than swallowed.
      await expect(notify(WAD)).to.be.revertedWithCustomError(staking, "NoStakers");
    });

    it("keeps the share price at 1:1 no matter how much ETH arrives", async () => {
      await stake(alice, 1000n * WAD);
      const before = await staking.convertToAssets(await staking.balanceOf(alice.address));

      await staking.connect(alice).lock(WEEK);
      await notify(500n * WAD);

      // Rewards live outside totalAssets, so convertToAssets must not move —
      // otherwise it would report LOYAL the vault does not hold.
      expect(await staking.convertToAssets(await staking.balanceOf(alice.address)))
        .to.equal(before);
    });
  });

  // =======================================================================
  // Invariants — the accounting must not drift, whatever the path
  // =======================================================================
  describe("invariants", () => {
    /**
     * `totalWeight` is a running sum maintained by deltas rather than
     * recomputed, which is the cheap way and the way that can silently drift.
     * Every path that touches a balance or a tier has to leave it equal to the
     * sum of its parts — if it ever does not, every reward after that point is
     * divided by the wrong denominator.
     */
    const assertWeightSums = async (who: HardhatEthersSigner[]) => {
      let sum = 0n;
      for (const w of who) sum += await staking.weightOf(w.address);
      expect(await staking.totalWeight()).to.equal(sum);
    };

    it("keeps totalWeight equal to the sum of weights through a messy sequence", async () => {
      const cast = [alice, bob, carol];

      await stake(alice, 1000n * WAD);
      await assertWeightSums(cast);

      await stake(bob, 2500n * WAD);
      await staking.connect(bob).lock(DAY);
      await assertWeightSums(cast);

      await stake(carol, 700n * WAD);
      await staking.connect(carol).lock(WEEK);
      await assertWeightSums(cast);

      await notify(3n * WAD);
      await staking.connect(alice).transfer(carol.address, 250n * WAD);
      await assertWeightSums(cast);

      await staking.connect(alice).lock(DAY);
      await assertWeightSums(cast);

      await time.increase(2 * 24 * 3600);
      await staking.connect(stranger).kick(alice.address);
      await staking.connect(stranger).kick(bob.address);
      await assertWeightSums(cast);

      await staking.connect(bob).withdraw(500n * WAD, bob.address, bob.address);
      await assertWeightSums(cast);

      await time.increase(8 * 24 * 3600);
      await staking.connect(stranger).kick(carol.address);
      await staking
        .connect(carol)
        .redeem(await staking.balanceOf(carol.address), carol.address, carol.address);
      await assertWeightSums(cast);

      expect(await staking.weightOf(carol.address)).to.equal(0n);
    });

    it("drops an account's weight to zero on a full exit", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      const bobWeight = await staking.weightOf(bob.address);

      await staking
        .connect(alice)
        .redeem(await staking.balanceOf(alice.address), alice.address, alice.address);

      expect(await staking.weightOf(alice.address)).to.equal(0n);
      expect(await staking.totalWeight()).to.equal(bobWeight);
    });

    it("lets an account lock before it has any shares, and weights it on arrival", async () => {
      await staking.connect(alice).lock(WEEK);
      expect(await staking.weightOf(alice.address)).to.equal(0n);
      expect(await staking.totalWeight()).to.equal(0n);

      await stake(alice, 1000n * WAD);
      const shares = await staking.balanceOf(alice.address);
      expect(await staking.weightOf(alice.address)).to.equal(shares * 3n);
    });

    it("permits lock(NONE) when nothing is standing", async () => {
      await stake(alice, 1000n * WAD);
      await expect(staking.connect(alice).lock(NONE)).to.not.be.reverted;
      expect(await staking.lockedUntil(alice.address)).to.equal(0n);
    });

    it("keeps unclaimed yield safe across a full exit and re-entry", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      await notify(2n * WAD);

      const owed = await staking.pendingYield(alice.address);
      await staking
        .connect(alice)
        .redeem(await staking.balanceOf(alice.address), alice.address, alice.address);

      // Leaving the vault must not forfeit what was already earned.
      expect(await staking.pendingYield(alice.address)).to.equal(owed);

      await notify(WAD); // bob alone now
      expect(await staking.pendingYield(alice.address)).to.equal(owed);

      await expect(staking.connect(alice).claim()).to.not.be.reverted;
      expect(await staking.pendingYield(alice.address)).to.equal(0n);
    });

    it("holds at least the ETH it still owes, at every step", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 4000n * WAD);
      await staking.connect(bob).lock(WEEK);

      for (let i = 0; i < 6; i++) {
        await notify(WAD + BigInt(i) * 7n);
        const owed =
          (await staking.pendingYield(alice.address)) +
          (await staking.pendingYield(bob.address));
        const held = await ethers.provider.getBalance(await staking.getAddress());
        expect(held).to.be.greaterThanOrEqual(owed);
      }

      await staking.connect(alice).claim();
      const owed = await staking.pendingYield(bob.address);
      const held = await ethers.provider.getBalance(await staking.getAddress());
      expect(held).to.be.greaterThanOrEqual(owed);
    });

    it("honours the gate on deposit without touching tiers or exits", async () => {
      const gate = await (await ethers.getContractFactory("MockGate")).deploy();
      await gate.allow(alice.address, true);
      await staking.connect(owner).setGate(await gate.getAddress());

      await stake(alice, 1000n * WAD);
      await loyal.transfer(bob.address, 1000n * WAD);
      await loyal.connect(bob).approve(await staking.getAddress(), 1000n * WAD);
      await expect(
        staking.connect(bob).deposit(1000n * WAD, bob.address)
      ).to.be.revertedWithCustomError(staking, "NotAllowed");

      // A gate must never be able to trap someone already inside.
      await staking.connect(owner).setGate(ethers.ZeroAddress);
      await gate.allow(alice.address, false);
      await staking.connect(owner).setGate(await gate.getAddress());
      await expect(staking.connect(alice).lock(WEEK)).to.not.be.reverted;
      await time.increase(8 * 24 * 3600);
      await expect(
        staking.connect(alice).withdraw(1n * WAD, alice.address, alice.address)
      ).to.not.be.reverted;
    });
  });
});
