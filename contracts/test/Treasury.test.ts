import { expect } from "chai";
import { ethers } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/// One network is shared across test FILES, so accounts that fund the corpus in
/// every `beforeEach` drain. Top them up rather than trusting the start balance.
const RICH = 10_000_000n * 10n ** 18n;

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD; // 1B, matching the live LOYAL
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = ethers.ZeroAddress;

describe("Treasury (ETH-denominated corpus)", () => {
  let owner: HardhatEthersSigner;
  let redeemer: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let loyal: any;
  let treasury: any;
  let feeSink: any;
  let escrow: any;

  // Mirrors the real relaunch order: contracts first, token last.
  beforeEach(async () => {
    [owner, redeemer, holder, stranger] = await ethers.getSigners();
    for (const s of [owner, redeemer, holder, stranger]) await setBalance(s.address, RICH);

    escrow = await (await ethers.getContractFactory("MockEscrow")).deploy();
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
    feeSink = await (
      await ethers.getContractFactory("FeeSink")
    ).deploy(await treasury.getAddress(), await escrow.getAddress(), owner.address);

    await treasury.setFeeSink(await feeSink.getAddress());
    await treasury.setRedeemer(redeemer.address);

    // ...and only now does the token exist.
    loyal = await (await ethers.getContractFactory("MockLoyal")).deploy(SUPPLY);
    await treasury.setLoyal(await loyal.getAddress());
  });

  // -------------------------------------------------------------------------
  describe("NAV is oracle-free", () => {
    it("starts at zero NAV with full eligible supply", async () => {
      expect(await treasury.nav()).to.equal(0n);
      expect(await treasury.eligibleSupply()).to.equal(SUPPLY);
      expect(await treasury.floorPerToken()).to.equal(0n);
      expect(await treasury.usdgBalance()).to.equal(0n);
    });

    it("nav equals the raw ETH balance when there is no sleeve", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("1") });
      expect(await treasury.nav()).to.equal(ethers.parseEther("1"));
      expect(await treasury.ethBuffer()).to.equal(ethers.parseEther("1"));
      expect(await treasury.sleeveAssets()).to.equal(0n);
    });

    it("computes floorPerToken as nav/eligibleSupply in wei", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("1000") });
      // 1000 ETH over 1e9 tokens = 1e-6 ETH per token
      expect(await treasury.floorPerToken()).to.equal(ethers.parseEther("0.000001"));
    });

    it("excludes burned supply from the denominator, raising the floor", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("1000") });
      const before = await treasury.floorPerToken();

      // Burn half the supply to the dead address.
      await loyal.transfer(DEAD, SUPPLY / 2n);

      expect(await treasury.eligibleSupply()).to.equal(SUPPLY / 2n);
      expect(await treasury.floorPerToken()).to.equal(before * 2n);
    });

    it("marks LOYAL held by the Treasury at zero and removes it from supply", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("1000") });
      const navBefore = await treasury.nav();

      await loyal.transfer(await treasury.getAddress(), SUPPLY / 4n);

      // NAV unchanged — LOYAL is never corpus.
      expect(await treasury.nav()).to.equal(navBefore);
      // ...and the same balance leaves the denominator, so the two agree.
      expect(await treasury.eligibleSupply()).to.equal(SUPPLY - SUPPLY / 4n);
    });

    it("returns zero floor rather than reverting when eligible supply is zero", async () => {
      await loyal.transfer(DEAD, SUPPLY);
      expect(await treasury.eligibleSupply()).to.equal(0n);
      expect(await treasury.floorPerToken()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  describe("inflow accounting", () => {
    it("counts ETH from the FeeSink as tax", async () => {
      await stranger.sendTransaction({
        to: await feeSink.getAddress(),
        value: ethers.parseEther("2"),
      });
      await feeSink.connect(stranger).sweep();

      expect(await treasury.cumulativeTaxReceived()).to.equal(ethers.parseEther("2"));
      expect(await treasury.cumulativeDonated()).to.equal(0n);
    });

    it("counts ETH from anywhere else as a donation, not tax", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("3") });
      expect(await treasury.cumulativeTaxReceived()).to.equal(0n);
      expect(await treasury.cumulativeDonated()).to.equal(ethers.parseEther("3"));
      // Both still back the floor.
      expect(await treasury.nav()).to.equal(ethers.parseEther("3"));
    });

    it("emits FloorUpdated on every funding", async () => {
      await expect(treasury.connect(stranger).fund({ value: ethers.parseEther("1") }))
        .to.emit(treasury, "FloorUpdated")
        .withArgs(ethers.parseEther("1"), SUPPLY, (t: bigint) => t > 0n);
    });

    it("rejects a zero-value fund", async () => {
      await expect(treasury.fund({ value: 0 })).to.be.revertedWithCustomError(
        treasury,
        "NothingToFund"
      );
    });

    it("accepts a bare transfer into the corpus without counting it", async () => {
      await stranger.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("1"),
      });
      // Still corpus, still backs the floor...
      expect(await treasury.nav()).to.equal(ethers.parseEther("1"));
      // ...just unannounced until someone pokes.
      await expect(treasury.poke()).to.emit(treasury, "FloorUpdated");
    });
  });

  // -------------------------------------------------------------------------
  describe("FeeSink survives a 2300-gas stipend (spec §5)", () => {
    it("accepts ETH sent via transfer(), which forwards only 2300 gas", async () => {
      const sender = await (await ethers.getContractFactory("StipendSender")).deploy();
      await stranger.sendTransaction({
        to: await sender.getAddress(),
        value: ethers.parseEther("1"),
      });

      // This is the exact call shape that would brick a logic-bearing receiver.
      await expect(
        sender.send(await feeSink.getAddress(), ethers.parseEther("1"))
      ).to.not.be.reverted;

      expect(
        await ethers.provider.getBalance(await feeSink.getAddress())
      ).to.equal(ethers.parseEther("1"));
    });

    it("has no way to repoint its treasury", () => {
      expect(feeSink.interface.hasFunction("setTreasury")).to.equal(false);
      expect(feeSink.interface.hasFunction("transferOwnership")).to.equal(false);
    });

    it("lets anyone sweep, and reverts when empty", async () => {
      await expect(feeSink.connect(stranger).sweep()).to.be.revertedWithCustomError(
        feeSink,
        "NothingToSweep"
      );

      await stranger.sendTransaction({
        to: await feeSink.getAddress(),
        value: ethers.parseEther("1"),
      });
      await expect(feeSink.connect(stranger).sweep()).to.emit(feeSink, "Swept");
      expect(await ethers.provider.getBalance(await feeSink.getAddress())).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  describe("outflow is redemption-only", () => {
    beforeEach(async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("10") });
    });

    it("lets the redeemer pay out", async () => {
      const before = await ethers.provider.getBalance(holder.address);
      await treasury.connect(redeemer).payout(holder.address, ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(holder.address)).to.equal(
        before + ethers.parseEther("1")
      );
      expect(await treasury.cumulativePaidOut()).to.equal(ethers.parseEther("1"));
    });

    it("blocks the OWNER from paying out", async () => {
      await expect(
        treasury.connect(owner).payout(owner.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(treasury, "NotRedeemer");
    });

    it("blocks a stranger from paying out", async () => {
      await expect(
        treasury.connect(stranger).payout(stranger.address, 1n)
      ).to.be.revertedWithCustomError(treasury, "NotRedeemer");
    });

    it("refuses to pay more than the liquid buffer", async () => {
      await expect(
        treasury.connect(redeemer).payout(holder.address, ethers.parseEther("11"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");
    });

    it("exposes no arbitrary-call escape hatch", () => {
      // `withdraw` exists by design, but takes no destination — see below.
      for (const fn of ["execute", "call", "delegatecall", "sweepTo", "rescue"]) {
        expect(treasury.interface.hasFunction(fn), `unexpected ${fn}()`).to.equal(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("operator withdrawal", () => {
    beforeEach(async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
    });

    it("defaults the operator to the owner", async () => {
      expect(await treasury.operator()).to.equal(owner.address);
    });

    it("sends corpus ETH to the operator", async () => {
      const before = await ethers.provider.getBalance(holder.address);
      await treasury.setOperator(holder.address);
      await treasury.withdraw(ethers.parseEther("10"));

      expect(await ethers.provider.getBalance(holder.address)).to.equal(
        before + ethers.parseEther("10")
      );
      expect(await treasury.cumulativeWithdrawn()).to.equal(ethers.parseEther("10"));
      expect(await treasury.nav()).to.equal(ethers.parseEther("90"));
    });

    it("takes NO destination argument — funds can only reach the operator", () => {
      const fn = treasury.interface.getFunction("withdraw");
      expect(fn!.inputs).to.have.length(1);
      expect(fn!.inputs[0].type).to.equal("uint256");
    });

    it("blocks everyone but the owner", async () => {
      await expect(
        treasury.connect(stranger).withdraw(1n)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(
        treasury.connect(redeemer).withdraw(1n)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("announces the drop rather than hiding it", async () => {
      await expect(treasury.withdraw(ethers.parseEther("10")))
        .to.emit(treasury, "Withdrawn")
        .and.to.emit(treasury, "FloorRegression");
    });

    it("cannot take income owed to stakers", async () => {
      await treasury.setIncomeShareBps(5000);
      await treasury.setFeeSink(stranger.address); // make the next fund() count as tax
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });

      // 50 ETH of that is earmarked; total balance 200, corpus 150.
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("50"));
      expect(await treasury.liquidEth()).to.equal(ethers.parseEther("150"));

      await expect(
        treasury.withdraw(ethers.parseEther("151"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");

      await expect(treasury.withdraw(ethers.parseEther("150"))).to.not.be.reverted;

      // The stakers' 50 ETH is still sitting there, untouched.
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("50")
      );
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("50"));
    });

    it("cannot exceed the corpus", async () => {
      await expect(
        treasury.withdraw(ethers.parseEther("101"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");
    });

    it("rejects a zero operator", async () => {
      await expect(treasury.setOperator(ZERO)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAddress"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("adapter timelock", () => {
    let adapter: any;

    beforeEach(async () => {
      adapter = await (await ethers.getContractFactory("MockAdapter")).deploy();
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
      await treasury.setSleeveBps(2000); // 20%
    });

    it("will not activate an unqueued adapter", async () => {
      await expect(
        treasury.activateAdapter(await adapter.getAddress())
      ).to.be.revertedWithCustomError(treasury, "AdapterNotQueued");
    });

    it("will not activate before the delay elapses", async () => {
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 - 60);
      await expect(
        treasury.activateAdapter(await adapter.getAddress())
      ).to.be.revertedWithCustomError(treasury, "TimelockNotElapsed");
    });

    it("activates after the delay", async () => {
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await expect(treasury.activateAdapter(await adapter.getAddress())).to.emit(
        treasury,
        "AdapterAdded"
      );
      expect(await treasury.isAdapter(await adapter.getAddress())).to.equal(true);
    });

    it("lets governance cancel a queued adapter", async () => {
      await treasury.queueAdapter(await adapter.getAddress());
      await treasury.cancelQueuedAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await expect(
        treasury.activateAdapter(await adapter.getAddress())
      ).to.be.revertedWithCustomError(treasury, "AdapterNotQueued");
    });

    it("blocks non-owners from queueing", async () => {
      await expect(
        treasury.connect(stranger).queueAdapter(await adapter.getAddress())
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  describe("sleeve cap", () => {
    let adapter: any;

    beforeEach(async () => {
      adapter = await (await ethers.getContractFactory("MockAdapter")).deploy();
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await adapter.getAddress());
    });

    it("defaults sleeveBps to zero, so no deposit is possible", async () => {
      expect(await treasury.sleeveBps()).to.equal(0);
      await expect(
        treasury.depositToAdapter(await adapter.getAddress(), 1n)
      ).to.be.revertedWithCustomError(treasury, "SleeveCapExceeded");
    });

    it("caps deposits at sleeveBps of NAV", async () => {
      await treasury.setSleeveBps(1000); // 10% of 100 ETH = 10 ETH
      await expect(
        treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("10.1"))
      ).to.be.revertedWithCustomError(treasury, "SleeveCapExceeded");

      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("10"));
      expect(await treasury.sleeveAssets()).to.equal(ethers.parseEther("10"));
    });

    it("keeps NAV constant when ETH moves into the sleeve", async () => {
      await treasury.setSleeveBps(1000);
      const navBefore = await treasury.nav();
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("10"));
      expect(await treasury.nav()).to.equal(navBefore);
      expect(await treasury.ethBuffer()).to.equal(ethers.parseEther("90"));
    });

    it("rejects a sleeve above the hard maximum", async () => {
      await expect(treasury.setSleeveBps(5001)).to.be.revertedWithCustomError(
        treasury,
        "SleeveTooLarge"
      );
    });

    it("refuses to remove an adapter that still holds assets", async () => {
      await treasury.setSleeveBps(1000);
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("10"));
      await expect(
        treasury.removeAdapter(await adapter.getAddress())
      ).to.be.revertedWithCustomError(treasury, "AdapterStillFunded");
    });

    it("removes an emptied adapter immediately, with no timelock", async () => {
      await expect(treasury.removeAdapter(await adapter.getAddress())).to.emit(
        treasury,
        "AdapterRemoved"
      );
      expect(await treasury.isAdapter(await adapter.getAddress())).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("floor invariant", () => {
    let adapter: any;

    beforeEach(async () => {
      adapter = await (await ethers.getContractFactory("MockAdapter")).deploy();
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await adapter.getAddress());
      await treasury.setSleeveBps(2000);
    });

    it("tracks a high-water mark that only rises on inflow", async () => {
      const floor1 = await treasury.floorHighWaterMark();
      expect(floor1).to.equal(await treasury.floorPerToken());

      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
      expect(await treasury.floorHighWaterMark()).to.be.greaterThan(floor1);
    });

    it("emits FloorRegression — and does NOT revert — when the sleeve loses value", async () => {
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("20"));
      const mark = await treasury.floorHighWaterMark();

      await adapter.simulateLoss(ethers.parseEther("5"));

      // The floor really did fall...
      expect(await treasury.floorPerToken()).to.be.lessThan(mark);
      // ...and the contract reports it rather than locking up.
      await expect(treasury.poke()).to.emit(treasury, "FloorRegression");
    });

    it("still permits redemption while the floor is regressed", async () => {
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("20"));
      await adapter.simulateLoss(ethers.parseEther("5"));

      // This is the whole reason regression emits instead of reverting.
      await expect(
        treasury.connect(redeemer).payout(holder.address, ethers.parseEther("1"))
      ).to.not.be.reverted;
    });

    it("leaves the floor untouched when sleeve surplus is realized", async () => {
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("20"));
      await adapter.simulateYield({ value: ethers.parseEther("5") });

      const navBefore = await treasury.nav();
      await treasury.realizeSurplus(await adapter.getAddress());

      // NAV is constant across the whole journey: the 5 ETH of yield was never
      // corpus (it sat above the adapter's high-water mark), and realizing it
      // just moves it into `pendingIncome`, which NAV also excludes.
      expect(await treasury.nav()).to.equal(navBefore);
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("5"));

      // The raw balance is 85, but only 80 of it is corpus — the rest is owed
      // to stakers and must not be spendable on redemption.
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("85")
      );
      expect(await treasury.ethBuffer()).to.equal(ethers.parseEther("80"));
    });

    it("survives an adapter that reverts on totalAssets()", async () => {
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("20"));
      const navBefore = await treasury.nav();

      const bad = await (await ethers.getContractFactory("RevertingAdapter")).deploy();
      await treasury.queueAdapter(await bad.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await bad.getAddress());

      // nav() must keep working: a broken adapter contributes zero, it does not
      // propagate its revert. Anything else would brick redemption permanently.
      expect(await treasury.nav()).to.equal(navBefore);
      expect(await treasury.unhealthyAdapters()).to.deep.equal([await bad.getAddress()]);

      const [assets, healthy] = await treasury.adapterAssets(await bad.getAddress());
      expect(assets).to.equal(0n);
      expect(healthy).to.equal(false);
    });

    it("keeps redemption alive while an adapter is unreadable", async () => {
      const bad = await (await ethers.getContractFactory("RevertingAdapter")).deploy();
      await treasury.queueAdapter(await bad.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await bad.getAddress());

      await expect(
        treasury.connect(redeemer).payout(holder.address, ethers.parseEther("1"))
      ).to.not.be.reverted;
    });

    it("can always remove an unreadable adapter", async () => {
      const bad = await (await ethers.getContractFactory("RevertingAdapter")).deploy();
      await treasury.queueAdapter(await bad.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await bad.getAddress());

      // The emptiness check must not call into the broken adapter, or the only
      // recovery path would revert too.
      await expect(treasury.removeAdapter(await bad.getAddress())).to.emit(
        treasury,
        "AdapterRemoved"
      );
      expect(await treasury.unhealthyAdapters()).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("exclusion list", () => {
    it("cannot list DEAD, which would double-count and overstate the floor", async () => {
      await expect(treasury.setExclusion(DEAD, true)).to.be.revertedWithCustomError(
        treasury,
        "CannotExcludeDead"
      );
    });

    it("excludes and re-includes an account", async () => {
      await treasury.connect(stranger).fund({ value: ethers.parseEther("100") });
      await loyal.transfer(holder.address, SUPPLY / 10n);

      const full = await treasury.eligibleSupply();
      await treasury.setExclusion(holder.address, true);
      expect(await treasury.eligibleSupply()).to.equal(full - SUPPLY / 10n);

      await treasury.setExclusion(holder.address, false);
      expect(await treasury.eligibleSupply()).to.equal(full);
    });

    it("has the Treasury itself excluded from construction", async () => {
      const list = await treasury.exclusions();
      expect(list).to.deep.equal([await treasury.getAddress()]);
    });

    it("blocks non-owners", async () => {
      await expect(
        treasury.connect(stranger).setExclusion(holder.address, true)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  describe("deploy-before-token ordering", () => {
    let bare: any;

    beforeEach(async () => {
      bare = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
    });

    it("every read survives with no token bound yet", async () => {
      expect(await bare.loyal()).to.equal(ZERO);
      expect(await bare.eligibleSupply()).to.equal(0n);
      expect(await bare.floorPerToken()).to.equal(0n);
      expect(await bare.nav()).to.equal(0n);
    });

    it("accepts funding before the token exists", async () => {
      await expect(bare.connect(stranger).fund({ value: ethers.parseEther("1") })).to.not.be
        .reverted;
      expect(await bare.nav()).to.equal(ethers.parseEther("1"));
    });

    it("binds the token exactly once", async () => {
      await expect(bare.setLoyal(await loyal.getAddress())).to.emit(bare, "LoyalSet");
      expect(await bare.eligibleSupply()).to.equal(SUPPLY);

      await expect(
        bare.setLoyal(await loyal.getAddress())
      ).to.be.revertedWithCustomError(bare, "LoyalAlreadySet");
    });

    it("refuses a non-contract or zero token", async () => {
      await expect(bare.setLoyal(ZERO)).to.be.revertedWithCustomError(bare, "ZeroAddress");
      await expect(bare.setLoyal(holder.address)).to.be.revertedWithCustomError(
        bare,
        "NotAContract"
      );
    });

    it("blocks non-owners from binding", async () => {
      await expect(
        bare.connect(stranger).setLoyal(await loyal.getAddress())
      ).to.be.revertedWithCustomError(bare, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  describe("FeeSink can actually collect (the v1 failure)", () => {
    let curve: any;

    beforeEach(async () => {
      // Launching with creatorFeeRecipient = feeSink makes the sink the curve's
      // deployer, which is what authorizes sweepFees.
      curve = await (
        await ethers.getContractFactory("MockCurve")
      ).deploy(await feeSink.getAddress());
      await treasury.setFeeSink(await feeSink.getAddress());
    });

    it("claims pull-based ETH from the escrow", async () => {
      await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther("2") });
      expect(await escrow.balanceOf(await feeSink.getAddress())).to.equal(
        ethers.parseEther("2")
      );

      await feeSink.connect(stranger).claimFromEscrow();

      expect(await ethers.provider.getBalance(await feeSink.getAddress())).to.equal(
        ethers.parseEther("2")
      );
    });

    it("sweeps creator tax off the bonding curve", async () => {
      await feeSink.setCurve(await curve.getAddress());
      await curve.accrue({ value: ethers.parseEther("3") });

      await feeSink.connect(stranger).sweepCurve(0); // 0 = sweep everything

      expect(await curve.creatorTaxBalance()).to.equal(0n);
      expect(await ethers.provider.getBalance(await feeSink.getAddress())).to.equal(
        ethers.parseEther("3")
      );
    });

    it("cannot sweep a curve it is not the deployer of", async () => {
      const foreign = await (
        await ethers.getContractFactory("MockCurve")
      ).deploy(stranger.address);
      await feeSink.setCurve(await foreign.getAddress());
      await foreign.accrue({ value: ethers.parseEther("1") });

      await expect(feeSink.sweepCurve(0)).to.be.revertedWithCustomError(
        foreign,
        "NotDeployer"
      );
    });

    it("runs the whole path end to end and lands ETH in the Treasury", async () => {
      await feeSink.setCurve(await curve.getAddress());
      await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther("2") });
      await curve.accrue({ value: ethers.parseEther("3") });

      await feeSink.connect(stranger).collect();

      expect(await treasury.nav()).to.equal(ethers.parseEther("5"));
      expect(await treasury.cumulativeTaxReceived()).to.equal(ethers.parseEther("5"));
      expect(await ethers.provider.getBalance(await feeSink.getAddress())).to.equal(0n);
    });

    it("collect() does not lose one leg because the other is empty", async () => {
      await feeSink.setCurve(await curve.getAddress());
      await curve.accrue({ value: ethers.parseEther("3") }); // escrow stays empty

      await expect(feeSink.collect()).to.not.be.reverted;
      expect(await treasury.nav()).to.equal(ethers.parseEther("3"));
    });

    it("reverts collect() only when there is genuinely nothing anywhere", async () => {
      await feeSink.setCurve(await curve.getAddress());
      await expect(feeSink.collect()).to.be.revertedWithCustomError(
        feeSink,
        "NothingToSweep"
      );
    });

    it("reports what is collectable without moving anything", async () => {
      await feeSink.setCurve(await curve.getAddress());
      await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther("2") });
      await curve.accrue({ value: ethers.parseEther("3") });

      const [inEscrow, onCurve, held] = await feeSink.collectable();
      expect(inEscrow).to.equal(ethers.parseEther("2"));
      expect(onCurve).to.equal(ethers.parseEther("3"));
      expect(held).to.equal(0n);
    });

    it("forwards a claimed token leg to the Treasury", async () => {
      await loyal.transfer(await feeSink.getAddress(), 1000n);
      await feeSink.connect(stranger).forwardToken(await loyal.getAddress());

      expect(await loyal.balanceOf(await treasury.getAddress())).to.equal(1000n);
      // ...and the Treasury still marks it at zero.
      expect(await treasury.nav()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  describe("FeeSink trust model", () => {
    it("renounces ownership the moment the curve is bound", async () => {
      const curve = await (
        await ethers.getContractFactory("MockCurve")
      ).deploy(await feeSink.getAddress());

      expect(await feeSink.owner()).to.equal(owner.address);
      await feeSink.setCurve(await curve.getAddress());
      expect(await feeSink.owner()).to.equal(ZERO);

      // No second chance, for anyone.
      await expect(
        feeSink.setCurve(await curve.getAddress())
      ).to.be.revertedWithCustomError(feeSink, "NotOwner");
    });

    it("blocks non-owners from binding the curve", async () => {
      const curve = await (
        await ethers.getContractFactory("MockCurve")
      ).deploy(await feeSink.getAddress());
      await expect(
        feeSink.connect(stranger).setCurve(await curve.getAddress())
      ).to.be.revertedWithCustomError(feeSink, "NotOwner");
    });

    it("refuses a non-contract curve", async () => {
      await expect(feeSink.setCurve(holder.address)).to.be.revertedWithCustomError(
        feeSink,
        "NotAContract"
      );
    });

    it("has no function that can send value to a caller-chosen address", () => {
      for (const fn of ["setTreasury", "rescue", "withdraw", "execute", "call", "transferOwnership"]) {
        expect(feeSink.interface.hasFunction(fn), `unexpected ${fn}()`).to.equal(false);
      }
    });

    it("still survives a 2300-gas stipend after gaining logic", async () => {
      const sender = await (await ethers.getContractFactory("StipendSender")).deploy();
      await stranger.sendTransaction({
        to: await sender.getAddress(),
        value: ethers.parseEther("1"),
      });
      await expect(sender.send(await feeSink.getAddress(), ethers.parseEther("1"))).to.not.be
        .reverted;
    });
  });

  // -------------------------------------------------------------------------
  describe("construction guards", () => {
    it("rejects a zero owner", async () => {
      const T = await ethers.getContractFactory("Treasury");
      await expect(T.deploy(ZERO)).to.be.reverted;
    });

    it("rejects a FeeSink with any zero constructor arg", async () => {
      const F = await ethers.getContractFactory("FeeSink");
      const t = await treasury.getAddress();
      const e = await escrow.getAddress();
      await expect(F.deploy(ZERO, e, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(t, ZERO, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(t, e, ZERO)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });
});
