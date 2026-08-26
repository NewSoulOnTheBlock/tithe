/**
 * Move one collection of fees all the way through: curve/escrow → Treasury →
 * stakers and team.
 *
 *   npx hardhat run scripts/crank.ts --network robinhood
 *
 * Three permissionless calls that nothing runs automatically:
 *
 *   1. FeeSink.collect()            claim the escrow, sweep the curve, forward
 *                                   the lot to the Treasury, which splits it at
 *                                   the moment of inflow
 *   2. Treasury.distributeIncome()  push the stakers' earmark into the vault,
 *                                   which credits every staker by weight
 *   3. Treasury.claimTeam()         pay the team's earmark to `teamRecipient`
 *
 * Ordering is not a preference: 2 and 3 revert with `NoIncome` / `NoTeamRevenue`
 * until 1 has run, because until then there is nothing earmarked to move.
 *
 * Each step is preceded by a read that decides whether it is worth sending, and
 * followed by a read of what actually changed — the point of a crank is that the
 * money arrived, not that a transaction succeeded.
 */
import { ethers } from "hardhat";

const SINK = "0x7A17e812Aa7470fAEB99BfaA0408487CE849ed8D";
const TREASURY = "0x87ED7A77894Ed43d15987d6A2ECd3Ad41455Cf0C";
const VAULT = "0x8280762BD502abFaC909db9202604C4422703596";

const E = (v: bigint) => ethers.formatEther(v);
const line = () => console.log("─".repeat(72));

async function main() {
  const [signer] = await ethers.getSigners();
  const sink = await ethers.getContractAt("FeeSink", SINK, signer);
  const t = await ethers.getContractAt("Treasury", TREASURY, signer);
  const vault = await ethers.getContractAt("StakedLoyal", VAULT, signer);

  const gas0 = await ethers.provider.getBalance(signer.address);
  line();
  console.log(`cranking from ${signer.address}`);
  console.log(`gas balance   ${E(gas0)} ETH`);
  line();

  if (gas0 < 500_000n * ((await ethers.provider.getFeeData()).gasPrice ?? 1n)) {
    throw new Error(`Not enough gas in ${signer.address}.`);
  }

  // ---------------------------------------------------------------- step 1 --
  const [esc, cur, held] = await sink.collectable();
  const available = esc + cur + held;
  console.log(`1. FeeSink.collect()`);
  console.log(`   escrow ${E(esc)} · curve ${E(cur)} · held ${E(held)}`);

  if (available === 0n) {
    console.log(`   nothing to collect — skipping`);
  } else {
    const tx = await sink.collect();
    const r = await tx.wait();
    console.log(`   ✓ ${tx.hash}  (gas ${r?.gasUsed})`);
    console.log(`   Treasury now holds:`);
    console.log(`     pendingIncome ${E(await t.pendingIncome())} ETH   (stakers)`);
    console.log(`     pendingTeam   ${E(await t.pendingTeam())} ETH   (team)`);
    console.log(`     nav           ${E(await t.nav())} ETH   (corpus)`);
    console.log(`     cumulativeTax ${E(await t.cumulativeTaxReceived())} ETH`);
  }

  // ---------------------------------------------------------------- step 2 --
  console.log(`\n2. Treasury.distributeIncome()`);
  const income = await t.pendingIncome();
  const weight = await vault.totalWeight();
  console.log(`   pendingIncome ${E(income)} ETH · vault totalWeight ${weight}`);

  if (income === 0n) {
    console.log(`   nothing earmarked — skipping`);
  } else if (weight === 0n) {
    // notifyReward divides by totalWeight, so with nobody staked this reverts
    // and the ETH stays earmarked rather than being quietly reclassified.
    console.log(`   nobody is staked — would revert NoStakers, leaving it earmarked. Skipping.`);
  } else {
    const before = await vault.cumulativeRewards();
    const tx = await t.distributeIncome();
    const r = await tx.wait();
    console.log(`   ✓ ${tx.hash}  (gas ${r?.gasUsed})`);
    console.log(`   vault cumulativeRewards ${E(before)} → ${E(await vault.cumulativeRewards())} ETH`);
    console.log(`   Treasury.pendingIncome now ${E(await t.pendingIncome())} ETH`);
  }

  // ---------------------------------------------------------------- step 3 --
  console.log(`\n3. Treasury.claimTeam()`);
  const team = await t.pendingTeam();
  const to = await t.teamRecipient();
  console.log(`   pendingTeam ${E(team)} ETH → ${to}`);

  if (team === 0n) {
    console.log(`   nothing earmarked — skipping`);
  } else if (to === ethers.ZeroAddress) {
    console.log(`   no teamRecipient set — skipping`);
  } else {
    const before = await ethers.provider.getBalance(to);
    const tx = await t.claimTeam();
    const r = await tx.wait();
    console.log(`   ✓ ${tx.hash}  (gas ${r?.gasUsed})`);
    console.log(`   recipient ${E(before)} → ${E(await ethers.provider.getBalance(to))} ETH`);
    console.log(`   cumulativeTeamPaid ${E(await t.cumulativeTeamPaid())} ETH`);
  }

  // ---------------------------------------------------------------- result --
  line();
  console.log("AFTER, READ BACK FROM CHAIN");
  line();
  const [e2, c2, h2] = await sink.collectable();
  console.log(`FeeSink.collectable()        ${E(e2 + c2 + h2)} ETH`);
  console.log(`Treasury.pendingIncome()     ${E(await t.pendingIncome())} ETH`);
  console.log(`Treasury.pendingTeam()       ${E(await t.pendingTeam())} ETH`);
  console.log(`Treasury.nav()               ${E(await t.nav())} ETH`);
  console.log(`Treasury.cumulativeTax()     ${E(await t.cumulativeTaxReceived())} ETH`);
  console.log(`Treasury.cumulativeTeamPaid()${E(await t.cumulativeTeamPaid())} ETH`);
  console.log(`Vault.cumulativeRewards()    ${E(await vault.cumulativeRewards())} ETH`);
  console.log(`\ngas spent                    ${E(gas0 - (await ethers.provider.getBalance(signer.address)))} ETH (net of team payout)`);
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
