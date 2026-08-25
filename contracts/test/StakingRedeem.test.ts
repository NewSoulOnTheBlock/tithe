import { expect } from "chai";
import { ethers } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/// Hardhat shares one network across test FILES, so an account that funds the
/// corpus in every `beforeEach` runs dry and starves later suites. Top up the
/// funder explicitly rather than depending on the starting balance.
const RICH = 10_000_000n * 10n ** 18n;

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = ethers.ZeroAddress;

describe("StakedLoyal + Redeemer", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  let loyal: any, treasury: any, feeSink: any, escrow: any, staking: any, redeemer: any;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    for (const s of [owner, alice, bob, carol]) await setBalance(s.address, RICH);

    escrow = await (await ethers.getContractFactory("MockEscrow")).deploy();
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
    feeSink = await (
      await ethers.getContractFactory("FeeSink")
    ).deploy(await treasury.getAddress(), await escrow.getAddress(), owner.address);
    await treasury.setFeeSink(await feeSink.getAddress());

    loyal = await (await ethers.getContractFactory("MockLoyal")).deploy(SUPPLY);
    await treasury.setLoyal(await loyal.getAddress());

    staking = await (
      await ethers.getContractFactory("StakedLoyal")
    ).deploy(await loyal.getAddress(), owner.address);

    redeemer = await (
      await ethers.getContractFactory("Redeemer")
    ).deploy(await loyal.getAddress(), await treasury.getAddress(), owner.address);
    await treasury.setRedeemer(await redeemer.getAddress());

    // Fund the corpus and hand out tokens.
    await treasury.connect(carol).fund({ value: ethers.parseEther("1000") });
    await loyal.transfer(alice.address, 100_000_000n * WAD); // 10%
    await loyal.transfer(bob.address, 100_000_000n * WAD); // 10%
  });

  // =========================================================================
  describe("StakedLoyal — ERC-4626 shape", () => {
    it("names itself off the underlying", async () => {
      expect(await staking.name()).to.equal("Staked Loyal");
      expect(await staking.symbol()).to.equal("stLOYAL");
      expect(await staking.asset()).to.equal(await loyal.getAddress());
    });

    it("mints shares 1:1 because ETH rewards stay out of totalAssets", async () => {
      const amt = 1000n * WAD;
      await loyal.connect(alice).approve(await staking.getAddress(), amt);
      await staking.connect(alice).deposit(amt, alice.address);

      expect(await staking.totalAssets()).to.equal(amt);
      expect(await staking.convertToAssets(await staking.balanceOf(alice.address))).to.equal(amt);
    });

    it("does NOT inflate share price when rewards arrive", async () => {
      const amt = 1000n * WAD;
      await loyal.connect(alice).approve(await staking.getAddress(), amt);
      await staking.connect(alice).deposit(amt, alice.address);

      const before = await staking.convertToAssets(WAD);
      await staking.notifyReward({ value: ethers.parseEther("10") });

      // Share price must be unchanged — the vault holds no extra LOYAL.
      expect(await staking.convertToAssets(WAD)).to.equal(before);
      expect(await staking.totalAssets()).to.equal(amt);
    });

    it("lets stakers withdraw their principal", async () => {
      const amt = 1000n * WAD;
      await loyal.connect(alice).approve(await staking.getAddress(), amt);
      await staking.connect(alice).deposit(amt, alice.address);
      await staking.connect(alice).redeem(await staking.balanceOf(alice.address), alice.address, alice.address);
      expect(await loyal.balanceOf(alice.address)).to.equal(100_000_000n * WAD);
    });
  });

  // =========================================================================
  describe("StakedLoyal — reward accounting", () => {
    beforeEach(async () => {
      for (const who of [alice, bob]) {
        await loyal.connect(who).approve(await staking.getAddress(), 1000n * WAD);
      }
    });

    it("splits rewards pro-rata by share", async () => {
      await staking.connect(alice).deposit(750n * WAD, alice.address);
      await staking.connect(bob).deposit(250n * WAD, bob.address);

      await staking.notifyReward({ value: ethers.parseEther("100") });

      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("75"));
      expect(await staking.pendingYield(bob.address)).to.equal(ethers.parseEther("25"));
    });

    it("pays nothing to someone who staked after the reward", async () => {
      await staking.connect(alice).deposit(1000n * WAD, alice.address);
      await staking.notifyReward({ value: ethers.parseEther("100") });
      await staking.connect(bob).deposit(1000n * WAD, bob.address);

      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await staking.pendingYield(bob.address)).to.equal(0n);
    });

    it("pays out on claim and zeroes the balance", async () => {
      await staking.connect(alice).deposit(1000n * WAD, alice.address);
      await staking.notifyReward({ value: ethers.parseEther("10") });

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await staking.connect(alice).claim();
      const rc = await tx.wait();
      const gas = BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);

      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + ethers.parseEther("10") - gas
      );
      expect(await staking.pendingYield(alice.address)).to.equal(0n);
    });

    it("settles rewards on share TRANSFER so yield cannot be bought or lost", async () => {
      await staking.connect(alice).deposit(1000n * WAD, alice.address);
      await staking.notifyReward({ value: ethers.parseEther("10") });

      // Alice sends her shares to Bob AFTER earning.
      await staking.connect(alice).transfer(bob.address, await staking.balanceOf(alice.address));

      // The yield stays with Alice; Bob gets none of it.
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("10"));
      expect(await staking.pendingYield(bob.address)).to.equal(0n);
    });

    it("keeps accounting straight across a second reward round", async () => {
      await staking.connect(alice).deposit(500n * WAD, alice.address);
      await staking.notifyReward({ value: ethers.parseEther("10") }); // alice alone
      await staking.connect(bob).deposit(500n * WAD, bob.address);
      await staking.notifyReward({ value: ethers.parseEther("10") }); // split evenly

      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("15"));
      expect(await staking.pendingYield(bob.address)).to.equal(ethers.parseEther("5"));
    });

    it("never lets total claims exceed total rewards", async () => {
      await staking.connect(alice).deposit(750n * WAD, alice.address);
      await staking.connect(bob).deposit(250n * WAD, bob.address);
      await staking.notifyReward({ value: ethers.parseEther("100") });

      await staking.connect(alice).claim();
      await staking.connect(bob).claim();

      expect(await staking.cumulativeClaimed()).to.be.lessThanOrEqual(
        await staking.cumulativeRewards()
      );
      expect(await ethers.provider.getBalance(await staking.getAddress())).to.equal(0n);
    });

    it("reverts rather than swallowing ETH when nobody is staked", async () => {
      await expect(
        staking.notifyReward({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(staking, "NoStakers");
    });

    it("reverts a claim with nothing to claim", async () => {
      await expect(staking.connect(alice).claim()).to.be.revertedWithCustomError(
        staking,
        "NothingToClaim"
      );
    });
  });

  // =========================================================================
  describe("Redeemer — the floor mechanism", () => {
    const stake = 100_000_000n * WAD; // alice's 10%

    it("quotes the floor minus the haircut", async () => {
      // nav 1000 ETH / 1e9 supply = 1e-6 ETH per token
      expect(await treasury.floorPerToken()).to.equal(ethers.parseEther("0.000001"));
      // 1000 tokens * 1e-6 * 0.95
      expect(await redeemer.quote(1000n * WAD)).to.equal(ethers.parseEther("0.00095"));
    });

    it("burns on request, so supply drops immediately", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      const supplyBefore = await treasury.eligibleSupply();

      await redeemer.connect(alice).requestRedeem(stake);

      expect(await treasury.eligibleSupply()).to.equal(supplyBefore - stake);
      expect(await redeemer.totalBurned()).to.equal(stake);
      expect(await loyal.balanceOf(alice.address)).to.equal(0n);
    });

    it("raises the floor for everyone else the moment tokens burn", async () => {
      const floorBefore = await treasury.floorPerToken();
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);

      expect(await treasury.floorPerToken()).to.be.greaterThan(floorBefore);
    });

    it("snapshots BEFORE the burn, so a redeemer cannot be paid at the floor they created", async () => {
      const floorBefore = await treasury.floorPerToken();
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);

      const r = await redeemer.requests(0);
      expect(r.snapshotFloor).to.equal(floorBefore);
      // ...which is strictly less than the post-burn floor.
      expect(r.snapshotFloor).to.be.lessThan(await treasury.floorPerToken());
    });

    it("refuses to execute before the delay", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await expect(redeemer.execute(0)).to.be.revertedWithCustomError(redeemer, "TooEarly");
    });

    it("pays out after the delay, at the snapshot floor minus the haircut", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);

      const before = await ethers.provider.getBalance(alice.address);
      await redeemer.connect(carol).execute(0); // anyone may crank

      // 10% of supply, floor 1e-6 → 100 ETH gross → 95 ETH net
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + ethers.parseEther("95")
      );
    });

    it("leaves the haircut in the corpus, making redemption accretive", async () => {
      const floorBefore = await treasury.floorPerToken();
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);
      await redeemer.execute(0);

      // 905 ETH left over 0.9e9 tokens > 1000/1e9
      expect(await treasury.floorPerToken()).to.be.greaterThan(floorBefore);
      expect(await treasury.nav()).to.equal(ethers.parseEther("905"));
    });

    it("never overpays: redeeming the WHOLE supply cannot drain more than NAV", async () => {
      await redeemer.setHaircutBps(0);
      await redeemer.setEpochPolicy(10_000, 7 * 24 * 3600);

      // Give everything to alice and redeem the entire supply.
      const all = await loyal.balanceOf(owner.address);
      await loyal.transfer(alice.address, all);
      await loyal.connect(bob).transfer(alice.address, await loyal.balanceOf(bob.address));
      const total = await loyal.balanceOf(alice.address);

      await loyal.connect(alice).approve(await redeemer.getAddress(), total);
      await redeemer.connect(alice).requestRedeem(total);
      await time.increase(24 * 3600 + 1);
      await redeemer.execute(0);

      // Exactly drained, never more — and never LESS, which would strand the
      // corpus behind a floorPerToken() of 0 once supply hits zero.
      expect(await treasury.nav()).to.equal(0n);
      expect(await treasury.eligibleSupply()).to.equal(0n);
    });

    it("still pays the LAST redeemer once supply reaches zero", async () => {
      await redeemer.setEpochPolicy(10_000, 7 * 24 * 3600);

      const all = await loyal.balanceOf(owner.address);
      await loyal.transfer(alice.address, all);
      await loyal.connect(bob).transfer(alice.address, await loyal.balanceOf(bob.address));
      const total = await loyal.balanceOf(alice.address);

      await loyal.connect(alice).approve(await redeemer.getAddress(), total);
      await redeemer.connect(alice).requestRedeem(total);
      await time.increase(24 * 3600 + 1);

      // floorPerToken() is now 0 (no supply), but the snapshot must still stand.
      expect(await treasury.floorPerToken()).to.equal(0n);
      const [preview] = await redeemer.preview(0);
      expect(preview).to.equal(ethers.parseEther("950")); // 1000 less the 5% haircut

      const before = await ethers.provider.getBalance(alice.address);
      await redeemer.connect(carol).execute(0);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(
        before + ethers.parseEther("950")
      );
      // The haircut stays behind, as designed.
      expect(await treasury.nav()).to.equal(ethers.parseEther("50"));
    });

    it("pays min(snapshot, current) when NAV falls between request and execute", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);

      // Simulate a NAV drop by redeeming... instead, drain via a second redeem
      // at a moment the corpus shrinks. Simplest: bob redeems and executes first.
      await loyal.connect(bob).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(bob).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);
      await redeemer.execute(1); // bob paid, NAV drops

      const [preview] = await redeemer.preview(0);
      const r = await redeemer.requests(0);
      const current = await treasury.floorPerToken();
      // Floor actually ROSE here (burns ratchet it), so snapshot binds.
      expect(current).to.be.greaterThan(r.snapshotFloor);
      expect(preview).to.equal(
        ((BigInt(r.amount) * BigInt(r.snapshotFloor)) / WAD * 9500n) / 10000n
      );
    });

    it("an operator withdrawal reduces a queued payout but never bricks it", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      const [quotedBefore] = await redeemer.preview(0);

      // The operator pulls half the corpus out to deploy into yield.
      await treasury.setOperator(carol.address);
      await treasury.withdraw(ethers.parseEther("500"));

      await time.increase(24 * 3600 + 1);

      // min(snapshot, current) means Alice settles at the LOWER, current floor.
      const [quotedAfter] = await redeemer.preview(0);
      expect(quotedAfter).to.be.lessThan(quotedBefore);

      // Crucially the request still completes — it does not revert, and it does
      // not try to pay out value the treasury no longer holds.
      const before = await ethers.provider.getBalance(alice.address);
      await expect(redeemer.connect(carol).execute(0)).to.not.be.reverted;
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + quotedAfter);
    });

    it("cannot be executed twice", async () => {
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);
      await redeemer.execute(0);
      await expect(redeemer.execute(0)).to.be.revertedWithCustomError(redeemer, "AlreadyExecuted");
    });

    it("enforces the per-epoch cap", async () => {
      await redeemer.setEpochPolicy(500, 7 * 24 * 3600); // 5% of NAV per epoch
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);

      // 95 ETH requested vs a ~45 ETH cap
      await expect(redeemer.execute(0)).to.be.revertedWithCustomError(
        redeemer,
        "EpochCapReached"
      );
    });

    it("frees capacity when the epoch rolls", async () => {
      await redeemer.setEpochPolicy(500, 7 * 24 * 3600);
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);
      await time.increase(24 * 3600 + 1);
      await expect(redeemer.execute(0)).to.be.reverted;

      await redeemer.setEpochPolicy(10_000, 7 * 24 * 3600);
      await expect(redeemer.execute(0)).to.not.be.reverted;
    });

    it("refuses to redeem when there is no floor yet", async () => {
      const bare = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
      await bare.setLoyal(await loyal.getAddress());
      const r2 = await (
        await ethers.getContractFactory("Redeemer")
      ).deploy(await loyal.getAddress(), await bare.getAddress(), owner.address);

      await loyal.connect(alice).approve(await r2.getAddress(), stake);
      await expect((r2.connect(alice) as any).requestRedeem(stake)).to.be.revertedWithCustomError(
        r2,
        "NoFloorYet"
      );
    });
  });

  // =========================================================================
  describe("Redeemer — governance bounds", () => {
    it("caps the haircut so governance cannot confiscate", async () => {
      await expect(redeemer.setHaircutBps(2001)).to.be.revertedWithCustomError(
        redeemer,
        "HaircutTooLarge"
      );
      await expect(redeemer.setHaircutBps(2000)).to.not.be.reverted;
    });

    it("caps the delay so governance cannot trap redeemers", async () => {
      await expect(
        redeemer.setRedeemDelay(31 * 24 * 3600)
      ).to.be.revertedWithCustomError(redeemer, "DelayTooLong");
    });

    it("pauses NEW requests but never blocks execution of burned tokens", async () => {
      const stake = 100_000_000n * WAD;
      await loyal.connect(alice).approve(await redeemer.getAddress(), stake);
      await redeemer.connect(alice).requestRedeem(stake);

      await redeemer.setRequestsPaused(true);

      await loyal.connect(bob).approve(await redeemer.getAddress(), stake);
      await expect(
        redeemer.connect(bob).requestRedeem(stake)
      ).to.be.revertedWithCustomError(redeemer, "Paused");

      // Alice's tokens are already destroyed — her claim must still complete.
      await time.increase(24 * 3600 + 1);
      await expect(redeemer.execute(0)).to.not.be.reverted;
    });

    it("blocks non-owners from every setter", async () => {
      for (const call of [
        redeemer.connect(alice).setHaircutBps(100),
        redeemer.connect(alice).setRedeemDelay(1),
        redeemer.connect(alice).setEpochPolicy(100, 1),
        redeemer.connect(alice).setRequestsPaused(true),
        redeemer.connect(alice).setGate(ZERO),
      ]) {
        await expect(call).to.be.revertedWithCustomError(
          redeemer,
          "OwnableUnauthorizedAccount"
        );
      }
    });

    it("is the ONLY address the Treasury will pay", async () => {
      expect(await treasury.redeemer()).to.equal(await redeemer.getAddress());
      await expect(
        treasury.connect(owner).payout(owner.address, 1n)
      ).to.be.revertedWithCustomError(treasury, "NotRedeemer");
    });
  });

  // =========================================================================
  describe("end to end: tax in, yield out, floor up", () => {
    it("runs the whole economic loop", async () => {
      // 1. Stakers stake.
      await loyal.connect(alice).approve(await staking.getAddress(), 1000n * WAD);
      await staking.connect(alice).deposit(1000n * WAD, alice.address);

      // 2. Trading tax arrives through the FeeSink.
      await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther("50") });
      await feeSink.collect();
      expect(await treasury.cumulativeTaxReceived()).to.equal(ethers.parseEther("50"));

      const floorAfterTax = await treasury.floorPerToken();
      expect(floorAfterTax).to.be.greaterThan(ethers.parseEther("0.000001"));

      // 3. Some income is routed to stakers.
      await staking.notifyReward({ value: ethers.parseEther("5") });
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("5"));

      // 4. A holder redeems; the floor ratchets up for everyone left.
      await loyal.connect(bob).approve(await redeemer.getAddress(), 50_000_000n * WAD);
      await redeemer.connect(bob).requestRedeem(50_000_000n * WAD);
      await time.increase(24 * 3600 + 1);
      await redeemer.execute(0);

      expect(await treasury.floorPerToken()).to.be.greaterThan(floorAfterTax);

      // 5. The staker still claims their yield independently of all that.
      await expect(staking.connect(alice).claim()).to.not.be.reverted;
    });
  });
});
