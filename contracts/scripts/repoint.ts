/**
 * Point the Treasury back at the staking contracts users actually staked into.
 *
 *   npx hardhat run scripts/repoint.ts --network robinhood
 *
 * ## Why this exists
 *
 * `bind.ts` deploys StakedLoyal / Redeemer / Distributor
 * unconditionally and then calls setRedeemer + setDistributor. Running it twice
 * therefore deploys a SECOND, empty set and repoints the Treasury at it, while
 * the frontend keeps sending users to the first set. Income would then be paid
 * to empty vaults and real stakers would receive nothing.
 *
 * This restores the Treasury's pointers to the live set. It changes only two
 * addresses — no redeploy, no user action, no effect on anyone's balance.
 *
 * It refuses to act unless the target Distributor genuinely points at vaults
 * that hold stake, so it cannot itself repeat the mistake in reverse.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(72));
const eth = (v: bigint) => ethers.formatEther(v);

/** The set the frontend uses and users staked into. */
const TARGET = {
  redeemer: "0x6315505083eBB08ABf26CC70123D2af6D49184C0",
  distributor: "0xf422916f139CB003B0FDC36edC73a816D17B914b",
};

async function main() {
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, signer);

  const owner = await t.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("Signer is not the owner. Execute from governance:");
    for (const [fn, arg] of [["setDistributor", TARGET.distributor], ["setRedeemer", TARGET.redeemer]] as const) {
      console.log(`  ${fn}  to: ${process.env.TREASURY}`);
      console.log(`         data: ${t.interface.encodeFunctionData(fn, [arg])}`);
    }
    return;
  }

  const curDist = await t.distributor();
  const curRedeemer = await t.redeemer();

  line();
  console.log("REPOINT TREASURY");
  line();
  console.log(`  distributor  ${curDist}`);
  console.log(`            →  ${TARGET.distributor}`);
  console.log(`  redeemer     ${curRedeemer}`);
  console.log(`            →  ${TARGET.redeemer}`);

  // --- refuse unless the target actually has stake behind it ---------------
  const dist = await ethers.getContractAt("Distributor", TARGET.distributor, ethers.provider);
  const tLoyal = await dist.stakedLoyal();
  const loyalVault = await ethers.getContractAt("StakedLoyal", tLoyal, ethers.provider);
  const [shares, assets, staked] = await Promise.all([
    loyalVault.totalSupply(), loyalVault.totalAssets(), loyalVault.totalWeight(),
  ]);

  line();
  console.log("TARGET SET — what is actually in it");
  console.log(`  stLOYAL  ${tLoyal}`);
  console.log(`     ${eth(shares)} shares · ${eth(assets)} LOYAL staked`);
  console.log(`     weight ${staked}`);

  if (shares === 0n && staked === 0n) {
    throw new Error(
      "Target Distributor points at vaults with NO stake. Refusing — this would " +
      "repeat the same mistake in the other direction. Verify the addresses first."
    );
  }

  // --- also confirm the CURRENT set is the empty one, so we are not -------
  // --- abandoning real stakers by switching away from it -------------------
  const curD = await ethers.getContractAt("Distributor", curDist, ethers.provider);
  const curLoyal = await ethers.getContractAt("StakedLoyal", await curD.stakedLoyal(), ethers.provider);
  const curShares = await curLoyal.totalSupply();
  console.log(`\n  current set holds ${eth(curShares)} shares`);
  if (curShares > 0n) {
    throw new Error(
      `The CURRENT distributor's vault holds ${eth(curShares)} shares. Switching away ` +
      `would orphan those stakers. Resolve manually.`
    );
  }
  console.log("  → current set is empty, safe to switch away from");

  line();
  if (curDist.toLowerCase() !== TARGET.distributor.toLowerCase()) {
    const tx = await t.setDistributor(TARGET.distributor);
    await tx.wait();
    console.log(`setDistributor ✓ ${tx.hash}`);
  } else console.log("setDistributor — already correct");

  if (curRedeemer.toLowerCase() !== TARGET.redeemer.toLowerCase()) {
    const tx = await t.setRedeemer(TARGET.redeemer);
    await tx.wait();
    console.log(`setRedeemer    ✓ ${tx.hash}`);
  } else console.log("setRedeemer — already correct");

  line();
  console.log("VERIFY");
  const [d2, r2] = [await t.distributor(), await t.redeemer()];
  console.log(`  distributor  ${d2}  ${d2.toLowerCase() === TARGET.distributor.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  redeemer     ${r2}  ${r2.toLowerCase() === TARGET.redeemer.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  pendingIncome ${eth(await t.pendingIncome())} ETH — now payable to the real vault`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
