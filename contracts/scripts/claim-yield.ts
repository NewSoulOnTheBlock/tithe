/**
 * Claim your accrued staking yield to the signing wallet.
 *
 *   npx hardhat run scripts/claim-yield.ts --network robinhood
 *
 * This pays out income you have already earned as a staker. It does NOT touch
 * the corpus, so NAV and the reported floor are unchanged — the ETH was never
 * counted as backing in the first place.
 *
 * Prefer this over `withdraw.ts` when you need funds: withdrawing takes money
 * out of the reserve and drops the floor, whereas claiming only moves what is
 * already yours.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, ethers.provider);
  const dist = await ethers.getContractAt("Distributor", await t.distributor(), ethers.provider);

  const loyalVault = await ethers.getContractAt("StakedLoyal", await dist.stakedLoyal(), signer);

  const before = await ethers.provider.getBalance(signer.address);
  const navBefore = await t.nav();
  const floorBefore = await t.floorPerToken();

  line();
  console.log("CLAIM STAKING YIELD");
  line();
  console.log(`  wallet            ${signer.address}`);
  console.log(`  balance           ${eth(before)} ETH`);

  const fromLoyal = await loyalVault.pendingYield(signer.address);
  console.log(`  claimable stLOYAL ${eth(fromLoyal)} ETH`);

  // The tier the wallet is on, since it decides the share of the next reward.
  const tier = await loyalVault.effectiveTier(signer.address);
  const label = ["NONE (0.5x)", "DAY (1x)", "WEEK (3x)"][Number(tier)] ?? String(tier);
  console.log(`  loyalty tier      ${label}`);

  if (fromLoyal === 0n) {
    console.log("\nNothing to claim.");
    return;
  }

  console.log(`\nclaiming ${eth(fromLoyal)} ETH from stLOYAL…`);
  const tx = await loyalVault.claim();
  await tx.wait();
  console.log(`  ${tx.hash}`);

  line();
  const after = await ethers.provider.getBalance(signer.address);
  console.log(`  balance now       ${eth(after)} ETH  (+${eth(after - before)} net of gas)`);
  console.log(`  nav               ${eth(await t.nav())} ETH  ${(await t.nav()) === navBefore ? "← untouched" : ""}`);
  console.log(`  floorPerToken     ${eth(await t.floorPerToken())} ETH ${(await t.floorPerToken()) === floorBefore ? "← untouched" : ""}`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
