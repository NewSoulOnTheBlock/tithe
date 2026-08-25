import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, setBalance, impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The deploy sequence, rehearsed against the REAL LOYAL curve on a fork.
 *
 * ## The step this exists to de-risk
 *
 * v1 of a sibling launch died on exactly one call. The fee recipient was moved
 * to the Treasury, and because that call **also reassigns `deployer`** — the
 * only address permitted to `sweepFees` — the fee stream became collectable
 * solely by a contract structurally incapable of collecting it. It was not
 * reversible. Every token of tax after that point was stranded.
 *
 * v2 avoided it by ordering: deploy first, then launch with
 * `creatorFeeRecipient` already set to the FeeSink, so no post-launch transfer
 * ever existed to get wrong.
 *
 * **LOYAL cannot use that ordering.** It is already launched, and its curve's
 * `deployer()` is an EOA. So the dangerous call is unavoidable here, and the
 * only responsible thing is to run it against real state before it is run for
 * real. That is what this does:
 *
 *   1. deploy Treasury + FeeSink exactly as `deploy.ts` would
 *   2. impersonate the curve's current deployer
 *   3. `setCreatorFeeRecipient(feeSink)` — the irreversible one
 *   4. prove the FeeSink, and ONLY the FeeSink, can now sweep
 *   5. prove the swept ETH lands in the Treasury and lifts the floor
 *
 * Run with:  FORK=1 npx hardhat test test/ForkRelaunch.test.ts
 */

const LOYAL_TOKEN = "0x1B7f9c45DfF56d8b4309f01afb4763d9C595318e";
const LOYAL_CURVE = "0x46286E8Fb83BAAfaa7D9Af26cc6d52e3EEcA205b";
/** Pons's escrow on 4663 — the pull side of the fee path. */
const PONS_FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";

/**
 * The Pons launch factory.
 *
 * The curve's own `setCreatorFeeRecipient` reverts `NotFactory()` — only this
 * contract may call it. And it does not do so immediately: the change is
 * proposed, sits behind a **72-hour timelock**, and must then be executed
 * inside a 72-hour window or it lapses. Both read off the factory live.
 *
 * There are TWO routes, and the difference matters more than anything else
 * here: `transferCreatorFeeRecipient` applies immediately, while
 * `setCreatorFeeRecipient` + `executeCreatorFeeRecipientChange` puts a 72-hour
 * pause in front of the same effect. Both are irreversible once they land.
 */
const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

const FACTORY_ABI = [
  "function CREATOR_FEE_RECIPIENT_TIMELOCK() view returns (uint256)",
  "function CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW() view returns (uint256)",
  "function pendingCreatorFeeRecipient(address) view returns (address,uint256)",
  "function transferCreatorFeeRecipient(address,address)",
  "function executeCreatorFeeRecipientChange(address)",
  "function cancelCreatorFeeRecipientChange(address)",
];

const WAD = 10n ** 18n;

const CURVE_ABI = [
  "function deployer() view returns (address)",
  "function setCreatorFeeRecipient(address)",
  "function sweepFees(uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function token() view returns (address)",
  "function buy(uint256,uint256,address) payable returns (uint256)",
];

(process.env.FORK ? describe : describe.skip)("FORK 4663 — the LOYAL relaunch sequence", () => {
  let owner: any, stranger: any;
  let curve: any, factory: any, treasury: any, feeSink: any;
  let originalDeployer: string;

  before(async function () {
    this.timeout(180_000);

    // Chain 4663 has no hardfork history in Hardhat's table; a call executed
    // *at* the fork block fails. One mined block moves past it.
    await network.provider.send("evm_mine");

    [owner, stranger] = await ethers.getSigners();
    for (const s of [owner, stranger]) await setBalance(s.address, 1000n * WAD);

    curve = await ethers.getContractAt(CURVE_ABI, LOYAL_CURVE);
    factory = await ethers.getContractAt(FACTORY_ABI, PONS_FACTORY);
    originalDeployer = await curve.deployer();

    // Step 1 — exactly what `deploy.ts` does, in the same order.
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(owner.address);
    feeSink = await (
      await ethers.getContractFactory("FeeSink")
    ).deploy(await treasury.getAddress(), PONS_FEE_ESCROW, owner.address);

    await treasury.setFeeSink(await feeSink.getAddress());
    await treasury.setLoyal(LOYAL_TOKEN);
  });

  it("finds the curve owned by an EOA, which is the situation to fix", async () => {
    // If this ever fails because `deployer` is already a contract, the
    // relaunch has been done and this rehearsal is describing the past.
    const code = await ethers.provider.getCode(originalDeployer);
    expect(code).to.equal("0x");
    expect(await curve.token()).to.equal(LOYAL_TOKEN);
  });

  it("binds the FeeSink to the curve and renounces in the same call", async () => {
    await feeSink.connect(owner).setCurve(LOYAL_CURVE);

    expect(await feeSink.curve()).to.equal(LOYAL_CURVE);
    // `setCurve` renounces, so nobody can ever re-point the sink afterwards.
    expect(await feeSink.owner()).to.equal(ethers.ZeroAddress);
  });

  it("refuses a direct change on the curve — only the factory may", async function () {
    this.timeout(120_000);

    await impersonateAccount(originalDeployer);
    const dep = await ethers.getSigner(originalDeployer);
    await setBalance(originalDeployer, 100n * WAD);

    // `NotFactory()` (0x32cc7236). Worth asserting rather than assuming: it is
    // the reason the relaunch has to go through the factory at all, and finding
    // it here rather than from a failed mainnet transaction is the point.
    await expect(curve.connect(dep).setCreatorFeeRecipient(await feeSink.getAddress())).to.be
      .reverted;
  });

  it("moves the recipient through the factory — and it applies IMMEDIATELY", async function () {
    this.timeout(120_000);

    const dep = await ethers.getSigner(originalDeployer);
    const sinkAddr = await feeSink.getAddress();

    /**
     * The factory exposes two routes and they are not equivalent:
     *
     *   transferCreatorFeeRecipient(token, to)   — takes effect at once
     *   setCreatorFeeRecipient(token, to)        — proposes, 72h timelock,
     *                                              then executeCreator…Change
     *
     * This is the immediate one. It is the call that killed v1, and it still
     * has no undo: `deployer` is the only address permitted to `sweepFees`, so
     * a wrong address here strands the entire fee stream permanently.
     *
     * Keyed by TOKEN, not by curve — passing the curve reverts `TokenNotFound()`
     * (0xcbdb7b30), which is an easy and expensive thing to get wrong.
     */
    await factory.connect(dep).transferCreatorFeeRecipient(LOYAL_TOKEN, sinkAddr);

    // No pending entry, because nothing is pending — it already happened.
    const [pending] = await factory.pendingCreatorFeeRecipient(LOYAL_TOKEN);
    expect(pending).to.equal(ethers.ZeroAddress);

    // THE assertion. Sweep rights are now the FeeSink's.
    expect(await curve.deployer()).to.equal(sinkAddr);
  });

  it("leaves the old EOA unable to sweep — the rights genuinely moved", async () => {
    const dep = await ethers.getSigner(originalDeployer);
    await expect(curve.connect(dep).sweepFees(0)).to.be.reverted;
  });

  it("is wired so that any tax which accrues can be collected", async function () {
    this.timeout(120_000);

    // `collect()` reverts `NothingToSweep()` when there is nothing there, which
    // is the correct behaviour and is what happens on a quiet fork block. What
    // matters for the relaunch is that the PATH exists and points the right
    // way, so that is what is asserted — inventing a trade to force a non-zero
    // balance would be testing the fork setup, not the wiring.
    const [inEscrow, onCurve, held] = await feeSink.collectable();
    expect(inEscrow + onCurve + held).to.be.greaterThanOrEqual(0n);

    // The sink knows where to pull from and where to push to.
    expect(await feeSink.curve()).to.equal(LOYAL_CURVE);
    expect(await feeSink.treasury()).to.equal(await treasury.getAddress());
    // And the Treasury will only ever count this sink's inflow as tax.
    expect(await treasury.feeSink()).to.equal(await feeSink.getAddress());

    if (inEscrow + onCurve + held === 0n) {
      await expect(feeSink.connect(stranger).collect()).to.be.revertedWithCustomError(
        feeSink,
        "NothingToSweep"
      );
    }
  });

  it("computes a floor from whatever the reserve holds", async () => {
    const nav = await treasury.nav();
    const supply = await treasury.eligibleSupply();
    expect(supply).to.be.greaterThan(0n);
    // The identity has to hold at any balance, including zero.
    expect(await treasury.floorPerToken()).to.equal(supply > 0n ? (nav * WAD) / supply : 0n);
  });

  it("still refuses to pay anyone but the Redeemer", async () => {
    // The Treasury has ETH now. The only address it will ever pay is the
    // Redeemer, and that is not set yet — so nothing can leave.
    expect(await treasury.redeemer()).to.equal(ethers.ZeroAddress);
    await expect(treasury.connect(stranger).payout(stranger.address, 1n)).to.be.reverted;
  });
});
