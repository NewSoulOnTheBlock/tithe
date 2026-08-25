/**
 * Step 3 of the relaunch: bind the deployed contracts to the launched token,
 * then PROVE the fee path is collectable before any real money flows.
 *
 *   TOKEN=0x… npx hardhat run scripts/bind.ts --network robinhood
 *
 * Both bindings are write-once. `FeeSink.setCurve` also renounces the sink's
 * owner in the same call, so after this script the sink has no privileged
 * caller at all.
 */
import { ethers, network } from "hardhat";

const line = () => console.log("─".repeat(72));

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const TOKEN = process.env.TOKEN?.trim();
  const TREASURY = process.env.TREASURY?.trim();
  const FEE_SINK = process.env.FEE_SINK?.trim();
  if (!TOKEN || !TREASURY || !FEE_SINK) {
    throw new Error("Set TOKEN, TREASURY and FEE_SINK in .env.");
  }

  line();
  console.log("LOYAL — step 3/3: bind contracts to the launched token");
  line();
  console.log(`network   ${network.name} (chainId ${net.chainId})`);
  console.log(`token     ${TOKEN}`);
  console.log(`treasury  ${TREASURY}`);
  console.log(`feeSink   ${FEE_SINK}`);

  const token = new ethers.Contract(
    TOKEN,
    ["function symbol() view returns (string)", "function curve() view returns (address)"],
    ethers.provider
  );
  const symbol = await token.symbol();
  const curveAddr = await token.curve();
  console.log(`          ↳ ${symbol}, curve ${curveAddr}`);

  // ---------------------------------------------------------------------
  // The check that matters: is the FeeSink genuinely the fee recipient?
  // ---------------------------------------------------------------------
  const curve = new ethers.Contract(
    curveAddr,
    [
      "function deployer() view returns (address)",
      "function creatorTaxBps() view returns (uint256)",
      "function sweepFees(uint256)",
    ],
    ethers.provider
  );

  line();
  console.log("VERIFYING THE FEE PATH BEFORE BINDING");
  line();

  const curveDeployer = await curve.deployer();
  const isSink = curveDeployer.toLowerCase() === FEE_SINK.toLowerCase();
  console.log(`curve.deployer()   ${curveDeployer}`);
  console.log(`                   ${isSink ? "✓ IS the FeeSink" : "✗ is NOT the FeeSink"}`);
  console.log(`curve.creatorTaxBps() ${await curve.creatorTaxBps()}`);

  if (!isSink) {
    line();
    console.log("ABORTING. The curve's fee recipient is not the FeeSink, which means");
    console.log("the launch did not carry creatorFeeRecipient through. Do NOT trade");
    console.log("into this token — accrued tax would be unsweepable, exactly as in");
    console.log("the first deployment. Relaunch with the correct params instead.");
    line();
    process.exitCode = 1;
    return;
  }

  // Prove the sink can sweep, without moving anything, before committing.
  try {
    await curve.sweepFees.staticCall(0n, { from: FEE_SINK });
    console.log(`sweepFees(0) from FeeSink   ✓ ALLOWED`);
  } catch (e: any) {
    console.log(`sweepFees(0) from FeeSink   ✗ ${String(e.shortMessage ?? "").slice(0, 40)}`);
    console.log("  (may be benign if the curve rejects a zero amount — check with a");
    console.log("   small real sweep before relying on it)");
  }

  // ---------------------------------------------------------------------
  // Bind
  // ---------------------------------------------------------------------
  const treasury = await ethers.getContractAt("Treasury", TREASURY, signer);
  const feeSink = await ethers.getContractAt("FeeSink", FEE_SINK, signer);

  line();
  console.log("BINDING");
  line();

  if ((await treasury.loyal()) === ethers.ZeroAddress) {
    const tx = await treasury.setLoyal(TOKEN);
    await tx.wait();
    console.log(`Treasury.setLoyal  ✓ ${tx.hash}`);
  } else {
    console.log(`Treasury.loyal already set: ${await treasury.loyal()}`);
  }

  if ((await feeSink.curve()) === ethers.ZeroAddress) {
    const tx = await feeSink.setCurve(curveAddr);
    await tx.wait();
    console.log(`FeeSink.setCurve   ✓ ${tx.hash}  (owner renounced)`);
  } else {
    console.log(`FeeSink.curve already set: ${await feeSink.curve()}`);
  }

  // ---------------------------------------------------------------------
  // Staking + redemption. Deployed here rather than in step 1 because both
  // take the token address as a constructor arg.
  // ---------------------------------------------------------------------
  const owner = (await treasury.owner()) as string;
  const ownerIsSigner = owner.toLowerCase() === signer.address.toLowerCase();

  line();
  console.log("DEPLOYING StakedLoyal + Redeemer");
  line();

  const staking = await (
    await ethers.getContractFactory("StakedLoyal")
  ).deploy(TOKEN, owner);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log(`StakedLoyal  ${stakingAddr}  (${await staking.symbol()})`);

  const redeemer = await (
    await ethers.getContractFactory("Redeemer")
  ).deploy(TOKEN, TREASURY, owner);
  await redeemer.waitForDeployment();
  const redeemerAddr = await redeemer.getAddress();
  console.log(`Redeemer     ${redeemerAddr}`);
  console.log(`  haircut ${await redeemer.haircutBps()} bps · delay ${await redeemer.redeemDelay()}s · epoch cap ${await redeemer.epochCapBps()} bps`);

  // --- income routing ------------------------------------------------------
  // One sink. The Distributor has no owner and no split: nothing to set,
  // nothing to pause, and no address that can redirect the income stream.
  const distributor = await (
    await ethers.getContractFactory("Distributor")
  ).deploy(stakingAddr);
  await distributor.waitForDeployment();
  const distributorAddr = await distributor.getAddress();
  console.log(`\nDistributor  ${distributorAddr}`);
  console.log(`  routes 100% of income to stLOYAL ${stakingAddr}`);

  // The Redeemer is the ONLY address the Treasury will ever pay.
  if (ownerIsSigner) {
    let tx = await treasury.setRedeemer(redeemerAddr);
    await tx.wait();
    console.log(`Treasury.setRedeemer    ✓ ${tx.hash}`);
    tx = await treasury.setDistributor(distributorAddr);
    await tx.wait();
    console.log(`Treasury.setDistributor ✓ ${tx.hash}`);
  } else {
    console.log("ACTION REQUIRED — both are onlyOwner. From governance:");
    for (const [fn, arg] of [
      ["setRedeemer", redeemerAddr],
      ["setDistributor", distributorAddr],
    ] as const) {
      console.log(`  ${fn}:`);
      console.log(`    to:   ${TREASURY}`);
      console.log(`    data: ${treasury.interface.encodeFunctionData(fn, [arg])}`);
    }
  }

  const incomeShare = await treasury.incomeShareBps();
  console.log(`\nTreasury.incomeShareBps = ${incomeShare}`);
  if (incomeShare === 0n) {
    console.log("  → 0 means NO tax is routed to stakers (the specified behaviour:");
    console.log("    tax is corpus, only realized yield is income). With no yield");
    console.log("    adapter deployed there is no yield, so stakers will earn");
    console.log("    NOTHING until either an adapter ships or you");
    console.log("    call setIncomeShareBps(). That is an economic decision, so it");
    console.log("    is left off by default.");
  }

  // Staked LOYAL is CUSTODIED, not owned — it must stay in eligibleSupply so
  // stakers keep their floor backing. Deliberately NOT added to the exclusions.
  console.log(`\nnote: StakedLoyal is intentionally NOT added to Treasury exclusions —`);
  console.log(`      it custodies user LOYAL rather than owning it, so stakers`);
  console.log(`      must keep their floor backing.`);

  // ---------------------------------------------------------------------
  line();
  console.log("FINAL STATE");
  line();
  console.log(`Treasury.loyal()      ${await treasury.loyal()}`);
  console.log(`Treasury.feeSink()    ${await treasury.feeSink()}`);
  console.log(`Treasury.redeemer()   ${await treasury.redeemer()}  (no ETH can leave yet)`);
  console.log(`Treasury.nav()        ${ethers.formatEther(await treasury.nav())} ETH`);
  console.log(`Treasury.eligibleSupply() ${ethers.formatEther(await treasury.eligibleSupply())}`);
  console.log(`FeeSink.curve()       ${await feeSink.curve()}`);
  console.log(`FeeSink.owner()       ${await feeSink.owner()}  (zero = renounced)`);

  const [inEscrow, onCurve, held] = await feeSink.collectable();
  console.log(`FeeSink.collectable() escrow=${ethers.formatEther(inEscrow)} curve=${ethers.formatEther(onCurve)} held=${ethers.formatEther(held)}`);

  line();
  console.log("Wire the frontend — frontend/src/chain.ts:");
  console.log(`  token:       "${TOKEN}",`);
  console.log(`  curve:       "${curveAddr}",`);
  console.log(`  feeSink:     "${FEE_SINK}",`);
  console.log(`  treasury:    "${TREASURY}",`);
  console.log(`  stakedLoyal: "${stakingAddr}",`);
  console.log(`  redeemer:    "${redeemerAddr}",`);
  console.log(`  distributor: "${distributorAddr}",`);
  console.log("");
  console.log("Yield is distributed by calling Distributor.distribute() with ETH.");
  console.log("All of it goes to stLOYAL, split by loyalty WEIGHT: an unlocked");
  console.log("staker counts 0.5x, a 1-day lock 1x, a 1-week lock 3x.");
  console.log("");
  console.log("Then make ONE small trade and run FeeSink.collect() to prove ETH");
  console.log("reaches the Treasury end to end before anything real depends on it.");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
