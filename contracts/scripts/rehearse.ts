/**
 * Local-only: rehearse the exact 3-step relaunch order end to end, with mocks
 * standing in for the Pons escrow and bonding curve.
 *
 *   npx hardhat node
 *   npx hardhat run scripts/rehearse.ts --network localhost
 *
 * Proves the sequence itself — deploy → launch-with-recipient → bind → collect —
 * rather than just the individual contracts. The failure this guards against is
 * a fee recipient that cannot collect, which unit tests alone did not catch the
 * first time because the ordering was never exercised.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(66));

async function main() {
  const [me, stranger] = await ethers.getSigners();

  line();
  console.log("STEP 1 — deploy contracts (token does not exist yet)");
  line();
  const escrow = await (await ethers.getContractFactory("MockEscrow")).deploy();
  await escrow.waitForDeployment();
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(me.address);
  await treasury.waitForDeployment();
  const feeSink = await (
    await ethers.getContractFactory("FeeSink")
  ).deploy(await treasury.getAddress(), await escrow.getAddress(), me.address);
  await feeSink.waitForDeployment();
  await (await treasury.setFeeSink(await feeSink.getAddress())).wait();

  console.log(`  Treasury         ${await treasury.getAddress()}`);
  console.log(`  FeeSink          ${await feeSink.getAddress()}`);
  console.log(`  Treasury.loyal() ${await treasury.loyal()}  (unset)`);
  console.log(`  nav()            ${ethers.formatEther(await treasury.nav())} ETH — reads work with no token ✓`);

  line();
  console.log("STEP 2 — launch with creatorFeeRecipient = FeeSink");
  line();
  const loyal = await (
    await ethers.getContractFactory("MockLoyal")
  ).deploy(1_000_000_000n * 10n ** 18n);
  await loyal.waitForDeployment();
  // The curve names the FeeSink as its deployer — this is what launching with
  // params.creatorFeeRecipient produces on the real factory.
  const curve = await (
    await ethers.getContractFactory("MockCurve")
  ).deploy(await feeSink.getAddress());
  await curve.waitForDeployment();

  const isSink =
    (await curve.deployer()).toLowerCase() === (await feeSink.getAddress()).toLowerCase();
  console.log(`  token            ${await loyal.getAddress()}`);
  console.log(`  curve.deployer() ${await curve.deployer()}`);
  console.log(`  is the FeeSink?  ${isSink ? "YES ✓" : "NO ✗"}`);
  if (!isSink) throw new Error("recipient did not carry through — abort");

  line();
  console.log("STEP 3 — bind");
  line();
  await (await treasury.setLoyal(await loyal.getAddress())).wait();
  await (await feeSink.setCurve(await curve.getAddress())).wait();
  console.log(`  Treasury.loyal() ${await treasury.loyal()}`);
  console.log(`  FeeSink.curve()  ${await feeSink.curve()}`);
  console.log(
    `  FeeSink.owner()  ${await feeSink.owner()}  ${
      (await feeSink.owner()) === ethers.ZeroAddress ? "(renounced ✓)" : "(STILL OWNED ✗)"
    }`
  );
  console.log(`  eligibleSupply   ${ethers.formatEther(await treasury.eligibleSupply())}`);

  line();
  console.log("SIMULATE TRADING — tax accrues on both fee paths");
  line();
  await (await curve.accrue({ value: ethers.parseEther("3") })).wait();
  await (
    await escrow.credit(await feeSink.getAddress(), { value: ethers.parseEther("2") })
  ).wait();
  const [inEscrow, onCurve, held] = await feeSink.collectable();
  console.log(
    `  collectable: escrow=${ethers.formatEther(inEscrow)} curve=${ethers.formatEther(
      onCurve
    )} held=${ethers.formatEther(held)}`
  );

  line();
  console.log("COLLECT — called by a stranger, proving it needs no privilege");
  line();
  await (await (feeSink.connect(stranger) as any).collect()).wait();

  const nav = await treasury.nav();
  console.log(`  Treasury.nav()                 ${ethers.formatEther(nav)} ETH`);
  console.log(
    `  Treasury.cumulativeTaxReceived ${ethers.formatEther(await treasury.cumulativeTaxReceived())} ETH`
  );
  console.log(
    `  Treasury.floorPerToken()       ${ethers.formatEther(await treasury.floorPerToken())} ETH`
  );
  console.log(
    `  FeeSink balance                ${ethers.formatEther(
      await ethers.provider.getBalance(await feeSink.getAddress())
    )} ETH`
  );

  line();
  if (nav === ethers.parseEther("5")) {
    console.log("PASS — all 5 ETH of fees reached the Treasury via a permissionless call.");
  } else {
    console.log(`FAIL — expected 5.0 ETH in the Treasury, got ${ethers.formatEther(nav)}`);
    process.exitCode = 1;
  }
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
