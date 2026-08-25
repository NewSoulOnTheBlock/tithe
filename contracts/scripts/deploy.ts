/**
 * Step 1 of the relaunch: deploy the contracts BEFORE the token exists.
 *
 *   npm run deploy:robinhood
 *
 * This ordering is the whole point. Because the FeeSink exists first, the token
 * can be launched with `params.creatorFeeRecipient` already pointing at it —
 * so there is never a post-launch `transferCreatorFeeRecipient` step to get
 * wrong. That step is what sent the first deployment's fee stream to an address
 * that could not collect it.
 *
 * Then: scripts/launch.ts (step 2), scripts/bind.ts (step 3).
 */
import { ethers, network } from "hardhat";

/// Pons V2FeeEscrow — verified on chain 4663.
const FEE_ESCROW = process.env.PONS_FEE_ESCROW ?? "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";

const line = () => console.log("─".repeat(72));

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");

  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  line();
  console.log("LOYAL — step 1/3: deploy contracts (token does NOT exist yet)");
  line();
  console.log(`network   ${network.name}  (chainId ${net.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} ETH`);
  console.log(`escrow    ${FEE_ESCROW}`);
  if (balance === 0n) throw new Error("Deployer has no ETH.");

  const escrowCode = await ethers.provider.getCode(FEE_ESCROW);
  if (escrowCode === "0x") {
    throw new Error(`No contract at PONS_FEE_ESCROW ${FEE_ESCROW} on chain ${net.chainId}.`);
  }
  console.log(`          ↳ escrow has ${(escrowCode.length - 2) / 2} bytes of code`);

  const owner = process.env.TREASURY_OWNER?.trim() || deployer.address;
  const ownerIsDeployer = owner.toLowerCase() === deployer.address.toLowerCase();
  console.log(`owner     ${owner}`);
  if (ownerIsDeployer) {
    line();
    console.log("⚠  TREASURY_OWNER is the deploying EOA — a single key will control");
    console.log("   the collective balance sheet. It cannot withdraw ETH (only the");
    console.log("   redeemer can), but it can set the redeemer. Move to a multisig");
    console.log("   with transferOwnership() before the corpus holds real value.");
    line();
  }

  console.log("\ndeploying Treasury…");
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(owner);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`  Treasury  ${treasuryAddr}`);

  console.log("deploying FeeSink…");
  const feeSink = await (
    await ethers.getContractFactory("FeeSink")
  ).deploy(treasuryAddr, FEE_ESCROW, owner);
  await feeSink.waitForDeployment();
  const feeSinkAddr = await feeSink.getAddress();
  console.log(`  FeeSink   ${feeSinkAddr}`);

  if (ownerIsDeployer) {
    console.log("\nwiring Treasury.setFeeSink…");
    const tx = await treasury.setFeeSink(feeSinkAddr);
    await tx.wait();
    console.log(`  done (${tx.hash})`);
  } else {
    const data = treasury.interface.encodeFunctionData("setFeeSink", [feeSinkAddr]);
    line();
    console.log("ACTION REQUIRED — setFeeSink is onlyOwner. Execute from governance:");
    console.log(`  to:   ${treasuryAddr}`);
    console.log(`  data: ${data}`);
    line();
  }

  // Read back rather than assume.
  line();
  console.log("post-deploy state (read from chain)");
  line();
  console.log(`Treasury.loyal()     ${await treasury.loyal()}   <- ZERO until step 3`);
  console.log(`Treasury.feeSink()   ${await treasury.feeSink()}`);
  console.log(`Treasury.redeemer()  ${await treasury.redeemer()}   <- no ETH can leave`);
  console.log(`Treasury.nav()       ${ethers.formatEther(await treasury.nav())} ETH`);
  console.log(`FeeSink.treasury()   ${await feeSink.treasury()}`);
  console.log(`FeeSink.escrow()     ${await feeSink.escrow()}`);
  console.log(`FeeSink.curve()      ${await feeSink.curve()}   <- ZERO until step 3`);
  console.log(`FeeSink.owner()      ${await feeSink.owner()}   <- auto-renounced by setCurve`);

  line();
  console.log("NEXT — step 2: launch the token with the FeeSink baked in");
  line();
  console.log("Put this in .env, then run scripts/launch.ts:");
  console.log("");
  console.log(`  TREASURY=${treasuryAddr}`);
  console.log(`  FEE_SINK=${feeSinkAddr}`);
  console.log("");
  console.log("The launch params MUST carry:");
  console.log(`  creatorFeeRecipient = ${feeSinkAddr}`);
  console.log("  creatorTaxBps       = 400");
  console.log("");
  console.log("Setting the recipient AT LAUNCH is what removes the failure mode");
  console.log("from the first attempt: there is no transfer step to misaddress,");
  console.log("and the FeeSink can reach both fee paths (escrow claim + curve");
  console.log("sweep), which the previous sink could not.");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
