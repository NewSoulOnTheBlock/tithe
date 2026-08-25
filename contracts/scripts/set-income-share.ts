/**
 * Set the share of incoming TAX routed to stakers instead of the corpus.
 *
 *   INCOME_SHARE_BPS=3000 npx hardhat run scripts/set-income-share.ts --network robinhood
 *
 * BASIS POINTS, not percent: 3000 = 30%, 30 = 0.3%. The script prints the
 * percentage it is about to set and refuses to run without an explicit value,
 * because the two are easy to confuse and the difference is 100x.
 *
 * Simulates before sending. Contract cap is 50%.
 */
import { ethers, network } from "hardhat";

const line = () => console.log("─".repeat(68));

async function main() {
  const raw = process.env.INCOME_SHARE_BPS?.trim();
  if (!raw) {
    throw new Error(
      "Set INCOME_SHARE_BPS (basis points). 3000 = 30%, 30 = 0.3%."
    );
  }
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`INCOME_SHARE_BPS must be an integer 0..10000, got ${raw}`);
  }

  const TREASURY = process.env.TREASURY?.trim();
  if (!TREASURY) throw new Error("TREASURY not set in .env");

  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", TREASURY, signer);

  const [current, cap, owner, pending, taxSoFar] = await Promise.all([
    t.incomeShareBps(),
    t.MAX_INCOME_SHARE_BPS(),
    t.owner(),
    t.pendingIncome(),
    t.cumulativeTaxReceived(),
  ]);

  line();
  console.log("SET INCOME SHARE");
  line();
  console.log(`network    ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`treasury   ${TREASURY}`);
  console.log(`signer     ${signer.address}`);
  console.log(`owner      ${owner}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("\nSigner is not the owner. Execute this from governance instead:");
    console.log(`  to:   ${TREASURY}`);
    console.log(`  data: ${t.interface.encodeFunctionData("setIncomeShareBps", [bps])}`);
    return;
  }

  line();
  console.log(`current    ${current} bps  (${Number(current) / 100}% of tax to stakers)`);
  console.log(`new        ${bps} bps  →  \x1b[1m${bps / 100}% of tax to stakers\x1b[0m`);
  console.log(`cap        ${cap} bps  (${Number(cap) / 100}%)`);
  if (bps > Number(cap)) throw new Error(`Above the contract cap of ${cap} bps.`);

  line();
  console.log("effect on every 1 ETH of trade tax from here on:");
  console.log(`  → corpus (raises the floor)    ${(1 - bps / 10000).toFixed(4)} ETH`);
  console.log(`  → stLOYAL stakers              ${(bps / 10000).toFixed(4)} ETH`);
  console.log(`      of which stLOYAL      90%  ${((bps / 10000) * 0.9).toFixed(4)} ETH`);
  console.log("");
  console.log("This is NOT retroactive — tax already collected stays corpus.");
  console.log(`  tax collected so far  ${ethers.formatEther(taxSoFar)} ETH`);
  console.log(`  income already owed   ${ethers.formatEther(pending)} ETH`);

  line();
  console.log("simulating…");
  await t.setIncomeShareBps.staticCall(bps);
  console.log("  ✓ simulates cleanly");

  const tx = await t.setIncomeShareBps(bps);
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  const now = await t.incomeShareBps();
  line();
  console.log(`confirmed — incomeShareBps is now ${now} (${Number(now) / 100}%)`);
  if (Number(now) !== bps) {
    console.log("  ⚠ on-chain value does not match what was requested");
    process.exitCode = 1;
  }
  line();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
