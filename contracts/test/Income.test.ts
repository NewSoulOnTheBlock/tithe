import { expect } from "chai";
import { ethers } from "hardhat";
import { time, setBalance, impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const RICH = 10_000_000n * WAD;

describe("Income route: Treasury → Distributor → stakers", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // LOYAL staker
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner; // funder / cranker

  let loyal: any, escrow: any;
  let treasury: any, feeSink: any, staking: any, distributor: any, redeemer: any;

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
    distributor = await (
      await ethers.getContractFactory("Distributor")
    ).deploy(await staking.getAddress());
    redeemer = await (
      await ethers.getContractFactory("Redeemer")
    ).deploy(await loyal.getAddress(), await treasury.getAddress(), owner.address);

    await treasury.setDistributor(await distributor.getAddress());
    await treasury.setRedeemer(await redeemer.getAddress());

    // Stakers on both sides.
    await loyal.transfer(alice.address, 1000n * WAD);
    await loyal.connect(alice).approve(await staking.getAddress(), 1000n * WAD);
    await staking.connect(alice).deposit(1000n * WAD, alice.address);

  });

  const taxIn = async (eth: string) => {
    await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther(eth) });
    await feeSink.collect();
  };

  // =========================================================================
  describe("income is not corpus", () => {
    it("defaults to routing NO tax to stakers (the specified behaviour)", async () => {
      expect(await treasury.incomeShareBps()).to.equal(0);
      await taxIn("100");
      expect(await treasury.pendingIncome()).to.equal(0n);
      expect(await treasury.nav()).to.equal(ethers.parseEther("100"));
    });

    it("earmarks a tax share once the lever is turned on", async () => {
      await treasury.setIncomeShareBps(1000); // 10%
      await taxIn("100");

      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("10"));
      // ...and that ETH is NOT part of the floor.
      expect(await treasury.nav()).to.equal(ethers.parseEther("90"));
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("100")
      );
    });

    it("never skims donations, only tax", async () => {
      await treasury.setIncomeShareBps(1000);
      await treasury.connect(carol).fund({ value: ethers.parseEther("100") });

      expect(await treasury.pendingIncome()).to.equal(0n);
      expect(await treasury.nav()).to.equal(ethers.parseEther("100"));
    });

    // The cap moved from 5000 to 7500 when the team split landed. It is no
    // longer "the floor cannot be starved" — with 7500 to stakers and 2500 to
    // the team the corpus genuinely receives nothing, which is the configured
    // economics. What the cap still guarantees is that no SINGLE dial can take
    // the whole tax: the two shares are bounded separately and sum to exactly
    // 100%, so neither side can be turned up at the other's expense.
    it("caps each share separately, and they sum to exactly the whole tax", async () => {
      const income = Number(await treasury.MAX_INCOME_SHARE_BPS());
      const team = Number(await treasury.MAX_TEAM_SHARE_BPS());
      expect(income + team).to.equal(10_000);

      await expect(treasury.setIncomeShareBps(income + 1)).to.be.revertedWithCustomError(
        treasury,
        "IncomeShareTooLarge"
      );
      await expect(treasury.setIncomeShareBps(income)).to.not.be.reverted;

      await expect(treasury.setTeamShareBps(team + 1)).to.be.revertedWithCustomError(
        treasury,
        "TeamShareTooLarge"
      );
      await expect(treasury.setTeamShareBps(team)).to.not.be.reverted;
    });
  });

  // =========================================================================
  describe("the floor does not sawtooth", () => {
    it("earning and paying income leaves the floor untouched", async () => {
      await taxIn("100"); // pure corpus
      const floorBefore = await treasury.floorPerToken();

      // Now turn on the lever and take more tax, then distribute all of it.
      await treasury.setIncomeShareBps(10_000 / 2); // 50%
      await taxIn("100");

      const floorAfterTax = await treasury.floorPerToken();
      await treasury.distributeIncome();
      const floorAfterPayout = await treasury.floorPerToken();

      // Distributing income must not move the floor AT ALL — it was never
      // counted as corpus in the first place.
      expect(floorAfterPayout).to.equal(floorAfterTax);
      expect(floorAfterPayout).to.be.greaterThan(floorBefore);
    });

    it("does not emit FloorRegression when income is paid out", async () => {
      await treasury.setIncomeShareBps(5000);
      await taxIn("100");
      await expect(treasury.distributeIncome()).to.not.emit(treasury, "FloorRegression");
    });
  });

  // =========================================================================
  describe("earmarked income is protected", () => {
    beforeEach(async () => {
      await treasury.setIncomeShareBps(5000); // 50%
      await taxIn("100"); // 50 corpus, 50 income
    });

    it("redemption cannot be paid out of stakers' ETH", async () => {
      expect(await treasury.liquidEth()).to.equal(ethers.parseEther("50"));

      // Act as the Redeemer contract itself.
      const redeemerAddr = await treasury.redeemer();
      await impersonateAccount(redeemerAddr);
      await setBalance(redeemerAddr, RICH);
      const asRedeemer = await ethers.getSigner(redeemerAddr);

      // The raw balance is 100, but only 50 is corpus and therefore spendable.
      await expect(
        (treasury.connect(asRedeemer) as any).payout(carol.address, ethers.parseEther("60"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");

      await expect(
        (treasury.connect(asRedeemer) as any).payout(carol.address, ethers.parseEther("50"))
      ).to.not.be.reverted;
    });

    it("the yield sleeve cannot be funded out of stakers' ETH", async () => {
      const adapter = await (await ethers.getContractFactory("MockAdapter")).deploy();
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await adapter.getAddress());
      await treasury.setSleeveBps(5000);

      await expect(
        treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("60"))
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");

      await expect(
        treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("25"))
      ).to.not.be.reverted;
    });

    it("ethBuffer reports the spendable corpus, not the raw balance", async () => {
      expect(await treasury.ethBuffer()).to.equal(ethers.parseEther("50"));
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("100")
      );
    });
  });

  // =========================================================================
  describe("realized sleeve surplus becomes income", () => {
    let adapter: any;

    beforeEach(async () => {
      await taxIn("100");
      adapter = await (await ethers.getContractFactory("MockAdapter")).deploy();
      await treasury.queueAdapter(await adapter.getAddress());
      await time.increase(2 * 24 * 3600 + 1);
      await treasury.activateAdapter(await adapter.getAddress());
      await treasury.setSleeveBps(5000);
      await treasury.depositToAdapter(await adapter.getAddress(), ethers.parseEther("50"));
    });

    it("does not count unrealized appreciation as corpus", async () => {
      const floorBefore = await treasury.floorPerToken();
      await adapter.simulateYield({ value: ethers.parseEther("10") });

      // Sleeve is worth more, but the corpus is not — the gain is income owed
      // to stakers, and counting it would inflate the floor only to deflate it
      // again the moment it was paid out.
      expect(await treasury.sleeveAssets()).to.equal(ethers.parseEther("60"));
      expect(await treasury.sleeveCorpus()).to.equal(ethers.parseEther("50"));
      expect(await treasury.unrealizedSurplus()).to.equal(ethers.parseEther("10"));
      expect(await treasury.floorPerToken()).to.equal(floorBefore);
    });

    it("earmarks realized yield instead of silently making it corpus", async () => {
      await adapter.simulateYield({ value: ethers.parseEther("10") });

      const floorBefore = await treasury.floorPerToken();
      await treasury.realizeSurplus(await adapter.getAddress());

      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("10"));
      // Realizing moves value from sleeve to earmarked income — the corpus, and
      // therefore the floor, is untouched at every step.
      expect(await treasury.floorPerToken()).to.equal(floorBefore);
    });

    it("DOES lower the floor when the sleeve takes a real loss", async () => {
      const floorBefore = await treasury.floorPerToken();
      await adapter.simulateLoss(ethers.parseEther("10"));

      // Depreciation below the high-water mark is a genuine loss of corpus and
      // must be reflected, unlike appreciation above it.
      expect(await treasury.sleeveCorpus()).to.equal(ethers.parseEther("40"));
      expect(await treasury.floorPerToken()).to.be.lessThan(floorBefore);
      await expect(treasury.poke()).to.emit(treasury, "FloorRegression");
    });

    it("delivers that yield to stakers", async () => {
      await adapter.simulateYield({ value: ethers.parseEther("10") });
      await treasury.realizeSurplus(await adapter.getAddress());
      await treasury.connect(carol).distributeIncome();

      // One sink now: all of it reaches stLOYAL.
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("10"));
    });
  });

  // =========================================================================
  describe("distributeIncome", () => {
    beforeEach(async () => {
      await treasury.setIncomeShareBps(1000);
      await taxIn("100"); // 10 ETH income
    });

    it("is permissionless", async () => {
      await expect(treasury.connect(carol).distributeIncome()).to.not.be.reverted;
      expect(await treasury.pendingIncome()).to.equal(0n);
      expect(await treasury.cumulativeIncomeDistributed()).to.equal(ethers.parseEther("10"));
    });

    it("routes the whole amount through the Distributor", async () => {
      await treasury.distributeIncome();
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("10"));
      expect(await distributor.cumulativeToLoyal()).to.equal(ethers.parseEther("10"));
    });

    it("reverts with nothing to send", async () => {
      await treasury.distributeIncome();
      await expect(treasury.distributeIncome()).to.be.revertedWithCustomError(
        treasury,
        "NoIncome"
      );
    });

    it("reverts when no distributor is set", async () => {
      const bare = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
      await expect(bare.distributeIncome()).to.be.revertedWithCustomError(
        bare,
        "DistributorNotSet"
      );
    });

    it("keeps income earmarked when nobody is staked", async () => {
      await staking
        .connect(alice)
        .redeem(await staking.balanceOf(alice.address), alice.address, alice.address);

      await expect(treasury.distributeIncome()).to.be.reverted;

      // Crucially it is NOT reclassified as corpus — the floor is unchanged and
      // the ETH is still owed to whoever stakes next.
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("10"));
      expect(await treasury.nav()).to.equal(ethers.parseEther("90"));
    });
  });

  // =========================================================================
  describe("full loop", () => {
    it("tax in → floor up → income out → stakers paid", async () => {
      await treasury.setIncomeShareBps(2000); // 20% income, 80% corpus

      await taxIn("1000");

      // Corpus grew by 800, income earmarked 200.
      expect(await treasury.nav()).to.equal(ethers.parseEther("800"));
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("200"));

      const floor = await treasury.floorPerToken();
      await treasury.connect(carol).distributeIncome();

      // Floor untouched by the payout.
      expect(await treasury.floorPerToken()).to.equal(floor);

      // All 200 reaches stLOYAL.
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("200"));

      // And it can actually be withdrawn.
      await expect(staking.connect(alice).claim()).to.not.be.reverted;

      // And the Treasury holds exactly the corpus, nothing more.
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("800")
      );
    });
  });
});
