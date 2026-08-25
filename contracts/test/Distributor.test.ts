import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Distributor — the income router, after Suits was removed.
 *
 * Losing the second sink deleted the split, the reroute logic, `suitsBps` and
 * `Ownable` with it. What is left is small enough that the tests are mostly
 * about what it *cannot* do: hold value, be redirected, or accept ETH the vault
 * behind it would reject.
 *
 * The last one is the subtle one. The vault divides rewards by **weight**, not
 * share count, so "is anybody there to receive this" has to be asked of
 * `totalWeight()`. Asking `totalSupply()` would answer yes in states where the
 * vault itself reverts, and the ETH would bounce back out of a nested call with
 * a confusing error.
 */

const RICH = 10_000_000n * 10n ** 18n;
const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;

const NONE = 0, DAY = 1, WEEK = 2;

describe("Distributor — single sink", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let loyal: any, staking: any, distributor: any;

  const stake = async (who: HardhatEthersSigner, amount: bigint) => {
    await loyal.transfer(who.address, amount);
    await loyal.connect(who).approve(await staking.getAddress(), amount);
    await staking.connect(who).deposit(amount, who.address);
  };

  beforeEach(async () => {
    [owner, alice, bob, stranger] = await ethers.getSigners();
    for (const s of [owner, alice, bob, stranger]) await setBalance(s.address, RICH);

    loyal = await (await ethers.getContractFactory("MockLoyal")).deploy(SUPPLY);
    staking = await (
      await ethers.getContractFactory("StakedLoyal")
    ).deploy(await loyal.getAddress(), owner.address);
    distributor = await (
      await ethers.getContractFactory("Distributor")
    ).deploy(await staking.getAddress());
  });

  describe("routing", () => {
    it("forwards the whole amount to stLOYAL", async () => {
      await stake(alice, 1000n * WAD);

      await expect(distributor.distribute({ value: 100n * WAD }))
        .to.emit(distributor, "Distributed")
        .withArgs(100n * WAD);

      expect(await staking.pendingYield(alice.address)).to.equal(100n * WAD);
      expect(await distributor.cumulativeToLoyal()).to.equal(100n * WAD);
    });

    it("leaves nothing behind", async () => {
      await stake(alice, 1000n * WAD);
      await distributor.distribute({ value: 100n * WAD });
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
    });

    it("is permissionless", async () => {
      await stake(alice, 1000n * WAD);
      await expect(distributor.connect(stranger).distribute({ value: WAD })).to.not.be.reverted;
    });

    it("previews the whole amount, since there is nowhere else for it to go", async () => {
      expect(await distributor.preview(100n * WAD)).to.equal(100n * WAD);
    });

    it("names its destination immutably", async () => {
      expect(await distributor.stakedLoyal()).to.equal(await staking.getAddress());
      // No setter, no owner, no way to point the stream elsewhere.
      expect((distributor as any).setStakedLoyal).to.equal(undefined);
      expect((distributor as any).owner).to.equal(undefined);
    });
  });

  describe("refuses rather than strands", () => {
    it("reverts with nothing attached", async () => {
      await stake(alice, 1000n * WAD);
      await expect(distributor.distribute({ value: 0 })).to.be.revertedWithCustomError(
        distributor,
        "NothingToDistribute"
      );
    });

    it("reverts when nobody carries weight, so the caller keeps its ETH", async () => {
      await expect(
        distributor.distribute({ value: 100n * WAD })
      ).to.be.revertedWithCustomError(distributor, "NoStakers");

      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
    });

    it("checks WEIGHT, not supply — the vault would reject on weight", async () => {
      // One wei of shares. Balance is non-zero, so `totalSupply` says someone
      // is staked — but weight is `balance * 5000 / 10000`, which truncates to
      // zero. Reading supply here would forward ETH the vault then rejects.
      await loyal.transfer(alice.address, 1n);
      await loyal.connect(alice).approve(await staking.getAddress(), 1n);
      await staking.connect(alice).deposit(1n, alice.address);

      expect(await staking.totalSupply()).to.be.greaterThan(0n);
      expect(await staking.totalWeight()).to.be.greaterThan(0n); // 1000 shares → 500 weight

      // Now force the truncating case directly: a single share unit.
      const tiny = await (
        await ethers.getContractFactory("StakedLoyal")
      ).deploy(await loyal.getAddress(), owner.address);
      const d2 = await (
        await ethers.getContractFactory("Distributor")
      ).deploy(await tiny.getAddress());

      // Alice spent her wei above; fund the tiny vault's deposit separately.
      await loyal.transfer(bob.address, 1000n);
      await loyal.connect(bob).approve(await tiny.getAddress(), 1000n);
      // Mint exactly 1 share unit — below the 2 needed for a non-zero half-weight.
      await tiny.connect(bob).mint(1n, bob.address);
      expect(await tiny.totalSupply()).to.equal(1n);
      expect(await tiny.totalWeight()).to.equal(0n);

      await expect(d2.distribute({ value: WAD })).to.be.revertedWithCustomError(d2, "NoStakers");
    });
  });

  describe("flush", () => {
    it("pushes an idle balance through the same rule", async () => {
      await stake(alice, 1000n * WAD);
      await stranger.sendTransaction({
        to: await distributor.getAddress(),
        value: 5n * WAD,
      });
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(5n * WAD);

      await expect(distributor.connect(stranger).flush())
        .to.emit(distributor, "Distributed")
        .withArgs(5n * WAD);
      expect(await staking.pendingYield(alice.address)).to.equal(5n * WAD);
    });

    it("reverts on an empty balance", async () => {
      await expect(distributor.flush()).to.be.revertedWithCustomError(
        distributor,
        "NothingToDistribute"
      );
    });

    it("cannot take a shortcut past the weight check", async () => {
      // A stray transfer with nobody staked must not become distributable.
      await stranger.sendTransaction({ to: await distributor.getAddress(), value: WAD });
      await expect(distributor.flush()).to.be.revertedWithCustomError(distributor, "NoStakers");
      // And the ETH stays put rather than vanishing into the vault.
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(WAD);
    });
  });

  describe("conservation", () => {
    it("delivers exactly what it received, across mixed tiers", async () => {
      await stake(alice, 1000n * WAD);
      await stake(bob, 1000n * WAD);
      await staking.connect(bob).lock(WEEK);

      let sent = 0n;
      for (const amount of [WAD, 3n * WAD, 7n * WAD / 3n, 11n * WAD]) {
        await distributor.distribute({ value: amount });
        sent += amount;
      }

      expect(await distributor.cumulativeToLoyal()).to.equal(sent);
      expect(await staking.cumulativeRewards()).to.equal(sent);

      const owed =
        (await staking.pendingYield(alice.address)) +
        (await staking.pendingYield(bob.address));
      // Dust rounds down and stays in the vault; it can never exceed what came in.
      expect(owed).to.be.lessThanOrEqual(sent);
      expect(sent - owed).to.be.lessThan(100n);
    });

    it("has no withdrawal path at all", () => {
      const fns = Object.keys(distributor.interface.fragments || {});
      const names = distributor.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      // Nothing that could send value to a caller-chosen address.
      for (const bad of ["withdraw", "sweep", "rescue", "transfer", "setStakedLoyal"]) {
        expect(names).to.not.include(bad);
      }
      expect(fns).to.be.an("array");
    });
  });
});
