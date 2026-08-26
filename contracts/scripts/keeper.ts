/**
 * The crank, on a loop.
 *
 *   npx hardhat run scripts/keeper.ts --network robinhood
 *
 * Nothing in this protocol moves money on a schedule. Fees accrue in the Pons
 * escrow, sit there, and stakers see a claimable balance of zero until somebody
 * sends three transactions. All three are permissionless — this process holds no
 * privilege, and anyone could run it instead. What it buys is punctuality, not
 * permission.
 *
 * ## What it does each tick
 *
 *   FeeSink.collect()             escrow + curve → Treasury, split on arrival
 *   Treasury.distributeIncome()   the stakers' earmark → the vault
 *   Treasury.claimTeam()          the team's earmark → teamRecipient
 *
 * ## Why there are thresholds
 *
 * Every call costs gas whether it moves 10 ETH or 10 wei, so cranking on every
 * tick would spend real money to move dust. Nothing is lost by waiting: an
 * uncollected fee is not an expiring one. The thresholds are the point at which
 * moving the money is worth more than the gas to move it.
 *
 * ## It is designed not to die
 *
 * A keeper that exits on the first RPC hiccup is worse than no keeper, because
 * you stop watching it. Every tick is wrapped; failures are logged and the loop
 * continues. The only thing that stops it is running out of gas, which it says
 * loudly rather than retrying into an empty wallet.
 *
 * Tunable from .env:
 *   KEEPER_INTERVAL_SEC   seconds between ticks           (default 600)
 *   KEEPER_MIN_COLLECT    ETH below which collect() waits (default 0.002)
 *   KEEPER_MIN_TEAM       ETH below which claimTeam waits (default 0.005)
 *   KEEPER_MIN_GAS        ETH below which it refuses      (default 0.0005)
 *   KEEPER_ONCE=1         run a single tick and exit (for cron)
 */
import { ethers } from "hardhat";

const SINK = "0x7A17e812Aa7470fAEB99BfaA0408487CE849ed8D";
const TREASURY = "0x87ED7A77894Ed43d15987d6A2ECd3Ad41455Cf0C";
const VAULT = "0x8280762BD502abFaC909db9202604C4422703596";

const env = (k: string, d: string) => process.env[k] ?? d;
const INTERVAL = Number(env("KEEPER_INTERVAL_SEC", "600")) * 1000;
const MIN_COLLECT = ethers.parseEther(env("KEEPER_MIN_COLLECT", "0.002"));
const MIN_TEAM = ethers.parseEther(env("KEEPER_MIN_TEAM", "0.005"));
const MIN_GAS = ethers.parseEther(env("KEEPER_MIN_GAS", "0.0005"));
const ONCE = !!process.env.KEEPER_ONCE;

const E = (v: bigint) => ethers.formatEther(v);
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);

async function tick(signer: any, sink: any, t: any, vault: any) {
  const gas = await ethers.provider.getBalance(signer.address);
  if (gas < MIN_GAS) {
    log(`GAS LOW — ${E(gas)} ETH, need ${E(MIN_GAS)}. Skipping. Fund ${signer.address}.`);
    return;
  }

  let acted = false;

  // ---- 1. collect -------------------------------------------------------
  const [esc, cur, held] = await sink.collectable();
  const available = esc + cur + held;
  if (available >= MIN_COLLECT) {
    const tx = await sink.collect();
    await tx.wait();
    acted = true;
    log(`collect()          ${E(available)} ETH → Treasury   ${tx.hash}`);
  }

  // ---- 2. distribute to stakers -----------------------------------------
  // No threshold: this ETH is already earmarked and out of the corpus, so the
  // only question is whether it reaches the vault. `totalWeight` must be
  // non-zero or notifyReward divides by zero and reverts `NoStakers`, which
  // leaves the earmark intact — correct, but not worth paying gas to discover.
  const income = await t.pendingIncome();
  const weight = await vault.totalWeight();
  if (income > 0n && weight > 0n) {
    const tx = await t.distributeIncome();
    await tx.wait();
    acted = true;
    log(`distributeIncome() ${E(income)} ETH → stakers      ${tx.hash}`);
  } else if (income > 0n) {
    log(`distributeIncome() ${E(income)} ETH earmarked but nobody is staked — holding`);
  }

  // ---- 3. pay the team ---------------------------------------------------
  const team = await t.pendingTeam();
  const to = await t.teamRecipient();
  if (team >= MIN_TEAM && to !== ethers.ZeroAddress) {
    const tx = await t.claimTeam();
    await tx.wait();
    acted = true;
    log(`claimTeam()        ${E(team)} ETH → ${to}   ${tx.hash}`);
  }

  if (!acted) {
    log(
      `idle · collectable ${E(available)} · income ${E(income)} · team ${E(team)} · gas ${E(gas)}`
    );
  }
}

async function main() {
  const [signer] = await ethers.getSigners();
  const sink = await ethers.getContractAt("FeeSink", SINK, signer);
  const t = await ethers.getContractAt("Treasury", TREASURY, signer);
  const vault = await ethers.getContractAt("StakedLoyal", VAULT, signer);

  log(`keeper up · ${signer.address}`);
  log(
    `every ${INTERVAL / 1000}s · collect ≥ ${E(MIN_COLLECT)} · team ≥ ${E(MIN_TEAM)} · gas floor ${E(MIN_GAS)}`
  );

  for (;;) {
    try {
      await tick(signer, sink, t, vault);
    } catch (e: any) {
      // Never exit on a bad tick. A transient RPC failure, a reorg, a nonce
      // clash — all of them resolve by trying again in ten minutes.
      log(`tick failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
