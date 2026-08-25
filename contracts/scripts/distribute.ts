/**
 * Push earmarked income out to stakers.
 *
 *   npx hardhat run scripts/distribute.ts --network robinhood
 *
 * Permissionless — `distributeIncome()` takes no arguments and its destination
 * is fixed, so anyone may crank it. It moves `Treasury.pendingIncome` to the
 * Distributor, which splits it between the two staking vaults.
 *
 * Reverts if NEITHER vault has stakers, in which case the income stays
 * earmarked rather than being stranded or quietly reclassified as corpus.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, signer);
  const dist = await ethers.getContractAt("Distributor", await t.distributor(), ethers.provider);
  const stLoyal = await ethers.getContractAt("StakedLoyal", await dist.stakedLoyal(), ethers.provider);

  const [income, nav, floor, shares, weight] = await Promise.all([
    t.pendingIncome(), t.nav(), t.floorPerToken(),
    stLoyal.totalSupply(), stLoyal.totalWeight(),
  ]);

  line();
  console.log("DISTRIBUTE INCOME");
  line();
  console.log(`  earmarked income  ${eth(income)} ETH`);
  console.log(`  stLOYAL staked    ${eth(shares)} shares`);
  // Weight is what the reward is actually divided by, so it is the number
  // that decides what a staker gets — shares alone would mislead.
  console.log(`  total weight      ${eth(weight)}`);
  console.log(`  nav (untouched)   ${eth(nav)} ETH`);

  if (income === 0n) { console.log("\nNothing earmarked."); return; }

  const toLoyal = await dist.preview(income);
  console.log(`\n  → stLOYAL         ${eth(toLoyal)} ETH`);

  console.log("\nsimulating…");
  await t.distributeIncome.staticCall();
  console.log("  ✓ simulates cleanly");

  const tx = await t.distributeIncome();
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  line();
  console.log("AFTER");
  const [income2, nav2, floor2, loyalRewards] = await Promise.all([
    t.pendingIncome(), t.nav(), t.floorPerToken(),
    stLoyal.cumulativeRewards(),
  ]);
  console.log(`  earmarked income  ${eth(income2)} ETH`);
  console.log(`  paid to stLOYAL   ${eth(loyalRewards)} ETH (cumulative)`);
  console.log(`  nav               ${eth(nav2)} ETH   ${nav2 === nav ? "← unchanged, as designed" : "← CHANGED, investigate"}`);
  console.log(`  floorPerToken     ${eth(floor2)} ETH ${floor2 === floor ? "← unchanged" : ""}`);

  const you = await stLoyal.pendingYield(signer.address);
  if (you > 0n) console.log(`\n  claimable by ${signer.address.slice(0, 10)}…  ${eth(you)} ETH`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
