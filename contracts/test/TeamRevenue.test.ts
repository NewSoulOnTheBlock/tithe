import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Team revenue — the third destination for trade tax.
 *
 * ## What is being protected
 *
 * The team's cut and the corpus live in the same contract balance, and the
 * corpus is what `floorPerToken()` is computed from. So the danger is not that
 * the team gets paid — it is that team money could be *counted* as backing the
 * token on its way out. That would mean a redeemer quoted against a floor
 * partly made of payroll, and a floor chart that drops on every payday.
 *
 * Every test here is some form of the same question: can the team's ETH ever be
 * mistaken for corpus, and can corpus ever be mistaken for the team's?
 *
 * ## The configured split
 *
 * 2% trade tax, divided 1.5% to stakers and 0.5% to the team:
 *
 *   incomeShareBps = 7500   (75% of the tax)
 *   teamShareBps   = 2500   (25% of the tax)
 *   corpus         =    0   (the remainder)
 */

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const RICH = 10_000_000n * WAD;

/** The production split, as deployed. */
const INCOME_BPS = 7_500;
const TEAM_BPS = 2_500;

describe("Team revenue: the third slice of the tax", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // staker
  let team: HardhatEthersSigner; // revenue recipient
  let carol: HardhatEthersSigner; // unrelated caller / donor

  let loyal: any, escrow: any;
  let treasury: any, feeSink: any, staking: any, distributor: any, redeemer: any;

  beforeEach(async () => {
    [owner, alice, team, carol] = await ethers.getSigners();
    for (const s of [owner, alice, team, carol]) await setBalance(s.address, RICH);

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

    await loyal.transfer(alice.address, 1000n * WAD);
    await loyal.connect(alice).approve(await staking.getAddress(), 1000n * WAD);
    await staking.connect(alice).deposit(1000n * WAD, alice.address);
  });

  /** Credit the sink in the escrow and pull it through to the Treasury. */
  const taxIn = async (eth: string) => {
    await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther(eth) });
    await feeSink.collect();
  };

  const configure = async () => {
    await treasury.setIncomeShareBps(INCOME_BPS);
    await treasury.setTeamShareBps(TEAM_BPS);
    await treasury.setTeamRecipient(team.address);
  };

  // =========================================================================
  describe("the split", () => {
    it("starts at zero — no team cut until someone configures one", async () => {
      expect(await treasury.teamShareBps()).to.equal(0);
      expect(await treasury.teamRecipient()).to.equal(ethers.ZeroAddress);

      await taxIn("100");
      expect(await treasury.pendingTeam()).to.equal(0n);
      expect(await treasury.nav()).to.equal(ethers.parseEther("100"));
    });

    it("divides tax 1.5% / 0.5% / nothing, as configured", async () => {
      await configure();
      await taxIn("100");

      // 100 ETH of tax is what a 2% tax collects on 5000 ETH of volume. Of it:
      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("75")); // 1.5%
      expect(await treasury.pendingTeam()).to.equal(ethers.parseEther("25")); //   0.5%
      expect(await treasury.nav()).to.equal(0n); //                                corpus
    });

    it("leaves the balance fully accounted for — no wei unassigned", async () => {
      await configure();
      await taxIn("100");

      const bal = await ethers.provider.getBalance(await treasury.getAddress());
      const nav = await treasury.nav();
      const income = await treasury.pendingIncome();
      const teamOwed = await treasury.pendingTeam();

      // The invariant that makes the floor trustworthy: everything in this
      // contract is either corpus, owed to stakers, or owed to the team.
      expect(nav + income + teamOwed).to.equal(bal);
    });

    it("gives the corpus the remainder when the shares do not sum to 100%", async () => {
      await treasury.setIncomeShareBps(5_000);
      await treasury.setTeamShareBps(1_000);
      await treasury.setTeamRecipient(team.address);
      await taxIn("100");

      expect(await treasury.pendingIncome()).to.equal(ethers.parseEther("50"));
      expect(await treasury.pendingTeam()).to.equal(ethers.parseEther("10"));
      expect(await treasury.nav()).to.equal(ethers.parseEther("40"));
    });

    it("never skims a donation — only tax is split", async () => {
      await configure();
      await treasury.connect(carol).fund({ value: ethers.parseEther("100") });

      expect(await treasury.pendingTeam()).to.equal(0n);
      expect(await treasury.pendingIncome()).to.equal(0n);
      expect(await treasury.nav()).to.equal(ethers.parseEther("100"));
    });

    it("keeps the cut as corpus while no recipient exists, rather than stranding it", async () => {
      // Earmarking against address(0) would put the ETH in a liability nobody
      // can claim: out of nav() so it stops backing the floor, out of
      // pendingIncome so stakers cannot have it either. It stays corpus.
      await treasury.setTeamShareBps(TEAM_BPS);
      await taxIn("100");

      expect(await treasury.pendingTeam()).to.equal(0n);
      expect(await treasury.nav()).to.equal(ethers.parseEther("100"));

      // And starts accruing the moment an address exists — without retroactively
      // claiming the tax that arrived before it.
      await treasury.setTeamRecipient(team.address);
      await taxIn("100");
      expect(await treasury.pendingTeam()).to.equal(ethers.parseEther("25"));
      expect(await treasury.nav()).to.equal(ethers.parseEther("175"));
    });
  });

  // =========================================================================
  describe("team money is not corpus", () => {
    it("is invisible to the floor", async () => {
      await configure();
      await taxIn("100");
      const floorWithTeamOwed = await treasury.floorPerToken();

      await treasury.connect(carol).claimTeam();

      // Paying the team must not move the floor by a single wei, because the
      // ETH was never part of it. This is the whole reason for the earmark.
      expect(await treasury.floorPerToken()).to.equal(floorWithTeamOwed);
    });

    it("cannot be withdrawn by the owner", async () => {
      // withdraw() is the operator's route into the corpus. It spends
      // liquidEth(), which excludes both liabilities — so the single most
      // privileged key in the system still cannot reach the team's earmark
      // (or the stakers').
      await configure();
      await taxIn("100");

      expect(await treasury.liquidEth()).to.equal(0n);
      await expect(treasury.withdraw(1n)).to.be.revertedWithCustomError(
        treasury,
        "InsufficientLiquidEth"
      );
    });

    it("cannot be paid out to a redeemer", async () => {
      await configure();
      await taxIn("100");

      // The Treasury holds 100 ETH but owes all of it. A redemption cannot be
      // settled out of money that belongs to someone else.
      const addr = await redeemer.getAddress();
      await setBalance(addr, WAD);
      const signer = await ethers.getImpersonatedSigner(addr);
      await expect(
        treasury.connect(signer).payout(carol.address, 1n)
      ).to.be.revertedWithCustomError(treasury, "InsufficientLiquidEth");
    });

    it("does not inflate what the sleeve is allowed to take", async () => {
      await configure();
      await taxIn("100");
      // nav() is 0 here, so any sleeve percentage of it is also 0. If team ETH
      // counted, a sleeve could be funded out of payroll.
      expect(await treasury.nav()).to.equal(0n);
    });
  });

  // =========================================================================
  describe("claimTeam", () => {
    it("pays the recipient, and only the recipient", async () => {
      await configure();
      await taxIn("100");

      const before = await ethers.provider.getBalance(team.address);
      // Permissionless: carol has no relationship to the team, and the money
      // still goes to the team. There is no destination argument to abuse.
      await treasury.connect(carol).claimTeam();

      expect(await ethers.provider.getBalance(team.address)).to.equal(
        before + ethers.parseEther("25")
      );
      expect(await treasury.pendingTeam()).to.equal(0n);
      expect(await treasury.cumulativeTeamPaid()).to.equal(ethers.parseEther("25"));
    });

    it("reverts with nothing accrued", async () => {
      await configure();
      await expect(treasury.claimTeam()).to.be.revertedWithCustomError(
        treasury,
        "NoTeamRevenue"
      );
    });

    it("reverts when there is nowhere to send it", async () => {
      await expect(treasury.claimTeam()).to.be.revertedWithCustomError(
        treasury,
        "TeamRecipientNotSet"
      );
    });

    it("accumulates across collections and pays once", async () => {
      await configure();
      await taxIn("40");
      await taxIn("60");
      expect(await treasury.pendingTeam()).to.equal(ethers.parseEther("25"));

      await expect(treasury.claimTeam())
        .to.emit(treasury, "TeamPaid")
        .withArgs(team.address, ethers.parseEther("25"));
    });

    it("survives a re-entrant recipient", async () => {
      const attacker = await (
        await ethers.getContractFactory("ReentrantTeam")
      ).deploy(await treasury.getAddress());

      await treasury.setIncomeShareBps(INCOME_BPS);
      await treasury.setTeamShareBps(TEAM_BPS);
      await treasury.setTeamRecipient(await attacker.getAddress());
      await taxIn("100");

      await attacker.attack();

      // Paid exactly once. `pendingTeam` is zeroed before the transfer and
      // `nonReentrant` refuses the second entry, so neither ordering nor the
      // guard alone has to be perfect.
      expect(await attacker.received()).to.equal(ethers.parseEther("25"));
      expect(await attacker.reenteredTimes()).to.equal(0n);
      expect(await treasury.pendingTeam()).to.equal(0n);
    });
  });

  // =========================================================================
  describe("a bad recipient cannot break the protocol", () => {
    it("does not brick fee collection", async () => {
      // fund() is the hot path every single fee collection runs through. If the
      // team's cut were PUSHED there, a recipient that rejects ETH would revert
      // the whole inflow and no tax could reach the Treasury at all. Holding
      // and letting them pull is what makes this test pass.
      const rejecter = await (await ethers.getContractFactory("EthRejecter")).deploy();

      await treasury.setIncomeShareBps(INCOME_BPS);
      await treasury.setTeamShareBps(TEAM_BPS);
      await treasury.setTeamRecipient(await rejecter.getAddress());

      await expect(taxIn("100")).to.not.be.reverted;
      expect(await treasury.pendingTeam()).to.equal(ethers.parseEther("25"));

      // Only the claim fails, and only for the team.
      await expect(treasury.claimTeam()).to.be.revertedWithCustomError(
        treasury,
        "EthTransferFailed"
      );

      // Stakers are entirely unaffected by the team's broken wallet.
      await expect(treasury.distributeIncome()).to.not.be.reverted;
      expect(await staking.cumulativeRewards()).to.equal(ethers.parseEther("75"));
    });

    it("is recoverable by repointing", async () => {
      const rejecter = await (await ethers.getContractFactory("EthRejecter")).deploy();
      await treasury.setIncomeShareBps(INCOME_BPS);
      await treasury.setTeamShareBps(TEAM_BPS);
      await treasury.setTeamRecipient(await rejecter.getAddress());
      await taxIn("100");

      // NOTE: `pendingTeam` is one pot, not a per-address ledger, so repointing
      // hands the ALREADY-ACCRUED balance to the new address. That is the point
      // here — it is how a stuck payout is rescued — but it also means the
      // owner can redirect accrued team revenue at will. It is the team's own
      // declared share either way, and it can never reach corpus or stakers.
      await treasury.setTeamRecipient(team.address);
      const before = await ethers.provider.getBalance(team.address);
      await treasury.connect(carol).claimTeam();
      expect(await ethers.provider.getBalance(team.address)).to.equal(
        before + ethers.parseEther("25")
      );
    });
  });

  // =========================================================================
  describe("bounds", () => {
    it("caps the team at 0.5% of a trade, permanently", async () => {
      // 2500 bps of a 200 bps tax is 50 bps of the trade. No owner call can
      // raise it, so this is a property a holder can check rather than trust.
      expect(await treasury.MAX_TEAM_SHARE_BPS()).to.equal(2_500);
      await expect(treasury.setTeamShareBps(2_501)).to.be.revertedWithCustomError(
        treasury,
        "TeamShareTooLarge"
      );
    });

    it("rejects a zero recipient", async () => {
      await expect(treasury.setTeamRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAddress"
      );
    });

    it("is owner-only on both dials", async () => {
      await expect(treasury.connect(carol).setTeamShareBps(100)).to.be.reverted;
      await expect(treasury.connect(carol).setTeamRecipient(carol.address)).to.be.reverted;
    });

    it("never over-allocates on amounts that do not divide evenly", async () => {
      await configure();
      const odd = 7n; // 7 wei of tax, split 7500/2500
      await escrow.credit(await feeSink.getAddress(), { value: odd });
      await feeSink.collect();

      const income = await treasury.pendingIncome();
      const teamOwed = await treasury.pendingTeam();
      // Both round down, so the truncated remainder falls to the corpus. It can
      // never exceed the inflow, which is what would let a later claim fail.
      expect(income + teamOwed).to.be.lessThanOrEqual(odd);
      expect(income).to.equal(5n); // 7 * 7500 / 10000
      expect(teamOwed).to.equal(1n); // 7 * 2500 / 10000
      expect(await treasury.nav()).to.equal(1n); // the dust
    });
  });

  // =========================================================================
  describe("end to end", () => {
    it("routes one tax collection to all three destinations", async () => {
      await configure();
      await taxIn("100");

      await treasury.distributeIncome();
      await treasury.connect(carol).claimTeam();

      expect(await staking.cumulativeRewards()).to.equal(ethers.parseEther("75"));
      expect(await treasury.cumulativeTeamPaid()).to.equal(ethers.parseEther("25"));
      expect(await treasury.cumulativeTaxReceived()).to.equal(ethers.parseEther("100"));

      // Nothing left over and nothing double-counted.
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(0n);
      expect(await treasury.nav()).to.equal(0n);

      // Alice is the only staker, so she is owed all of the staker share.
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("75"));
    });
  });
});
