/**
 * LOYAL — the whole reserve stack, in one resumable pass.
 *
 *   npx hardhat run scripts/deploy-loyal.ts --network robinhood
 *
 * ## Why this exists instead of deploy.ts → launch.ts → bind.ts
 *
 * That sequence was written for a token that did not exist yet. Its entire
 * point was ordering: deploy the FeeSink first so the token could be launched
 * with `creatorFeeRecipient` already pointing at it, and the dangerous
 * post-launch transfer would never exist.
 *
 * **LOYAL is already launched.** Its curve's fee recipient is an EOA. So the
 * transfer is unavoidable, step 2 is moot, and `bind.ts` refuses to run at all
 * because it asserts the recipient has already moved — which it cannot have,
 * since the sink it must move to is deployed by this script.
 *
 * The ordering that is actually forced here:
 *
 *   1. deploy everything and wire it   ← this script
 *   2. move the curve's fee recipient  ← the operator, through the Pons
 *                                        factory, on the timelocked route
 *
 * Step 2 is deliberately NOT automated. It is irreversible, it is the exact
 * call that stranded a previous deployment's entire fee stream, and it should
 * be made deliberately by a human reading the address off this script's output.
 *
 * ## Resumability
 *
 * Deployments are recorded to deployments/loyal-<chainId>.json as each one
 * lands. Re-running picks up where it stopped rather than deploying a second
 * copy — this matters because the wiring is spread over several transactions
 * and running out of gas halfway must be recoverable, not fatal.
 *
 * ## The key
 *
 * Read from the environment by hardhat.config.ts and nowhere else. It is never
 * logged, never passed as an argument, and never written to the record file.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Pons V2FeeEscrow on 4663 — the pull side of the fee path. */
const FEE_ESCROW = process.env.PONS_FEE_ESCROW ?? "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
/** Pons launch factory — the ONLY contract permitted to move a fee recipient. */
const PONS_FACTORY = process.env.PONS_FACTORY ?? "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

/** Gas allowance per wiring transaction. Generous; unspent gas is not charged. */
const WIRE_GAS = 80_000n;
const WIRE_TX_COUNT = 9n;
/** Estimates are a lower bound on a moving chain. Budget above them. */
const COST_BUFFER_BPS = 13_000n; // 1.3x

const line = () => console.log("─".repeat(74));
const eth = (v: bigint) => `${ethers.formatEther(v)} ETH`;

type Record_ = {
  chainId: number;
  token?: string;
  curve?: string;
  owner?: string;
  Treasury?: string;
  FeeSink?: string;
  StakedLoyal?: string;
  Redeemer?: string;
  Distributor?: string;
};

function recordPath(chainId: number) {
  return path.join(__dirname, "..", "deployments", `loyal-${chainId}.json`);
}
function load(chainId: number): Record_ {
  const p = recordPath(chainId);
  if (!fs.existsSync(p)) return { chainId };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function save(rec: Record_) {
  const p = recordPath(rec.chainId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + "\n");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — DEPLOYER_PRIVATE_KEY is not set in .env.");

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const rec = load(chainId);
  rec.chainId = chainId;

  // ---------------------------------------------------------------------
  // Preflight — every fact read from the chain, none assumed
  // ---------------------------------------------------------------------
  line();
  console.log("LOYAL — deploy the reserve stack against an ALREADY LAUNCHED token");
  line();

  const TOKEN = (process.env.LOYAL_TOKEN ?? process.env.TOKEN ?? "").trim();
  if (!TOKEN) throw new Error("Set LOYAL_TOKEN in .env.");

  if ((await ethers.provider.getCode(TOKEN)) === "0x") {
    throw new Error(`No contract at LOYAL_TOKEN ${TOKEN} on chain ${chainId}.`);
  }

  const token = new ethers.Contract(
    TOKEN,
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
      "function curve() view returns (address)",
    ],
    ethers.provider
  );

  const curveAddr: string = await token.curve();
  const curve = new ethers.Contract(
    curveAddr,
    [
      "function deployer() view returns (address)",
      "function creatorTaxBps() view returns (uint256)",
      "function creatorTaxBalance() view returns (uint256)",
      "function token() view returns (address)",
    ],
    ethers.provider
  );

  // The curve must point back at the token. If it does not, LOYAL_TOKEN is
  // wrong, and everything downstream — including the irreversible fee-recipient
  // move — would be aimed at the wrong market.
  const backRef: string = await curve.token();
  if (backRef.toLowerCase() !== TOKEN.toLowerCase()) {
    throw new Error(`curve.token() is ${backRef}, not ${TOKEN}. Refusing to continue.`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  const curveDeployer: string = await curve.deployer();
  const owner = (process.env.TREASURY_OWNER?.trim() || deployer.address);
  const ownerIsDeployer = owner.toLowerCase() === deployer.address.toLowerCase();

  console.log(`network        ${network.name} (chainId ${chainId}), block ${await ethers.provider.getBlockNumber()}`);
  console.log(`deployer       ${deployer.address}`);
  console.log(`balance        ${eth(balance)}`);
  console.log(`token          ${TOKEN}`);
  console.log(`               ${await token.name()} (${await token.symbol()}), ${await token.decimals()} dp, supply ${ethers.formatEther(await token.totalSupply())}`);
  console.log(`curve          ${curveAddr}`);
  console.log(`  taxBps       ${await curve.creatorTaxBps()}`);
  console.log(`  unswept tax  ${eth(await curve.creatorTaxBalance())}`);
  console.log(`  deployer()   ${curveDeployer}  ${(await ethers.provider.getCode(curveDeployer)) === "0x" ? "(EOA — fee rights have NOT moved yet)" : "(contract)"}`);
  console.log(`escrow         ${FEE_ESCROW}  ${((await ethers.provider.getCode(FEE_ESCROW)).length - 2) / 2} bytes`);
  console.log(`owner          ${owner}${ownerIsDeployer ? "  (= deployer)" : ""}`);

  if ((await ethers.provider.getCode(FEE_ESCROW)) === "0x") {
    throw new Error(`No contract at PONS_FEE_ESCROW ${FEE_ESCROW}.`);
  }
  if (owner !== ethers.getAddress(owner)) {
    throw new Error(`TREASURY_OWNER ${owner} is not a checksummed address — refusing to guess.`);
  }

  if (ownerIsDeployer) {
    line();
    console.log("⚠  TREASURY_OWNER is the deploying EOA. One key will hold every");
    console.log("   onlyOwner power on the Treasury, including setOperator() and");
    console.log("   withdraw(). It cannot pay anyone but the Redeemer, but it can");
    console.log("   set who the Redeemer is. Hand it to a multisig with");
    console.log("   transferOwnership() before the corpus holds real value.");
  }

  rec.token = TOKEN;
  rec.curve = curveAddr;
  rec.owner = owner;

  // ---------------------------------------------------------------------
  // Economics — resolved and validated BEFORE anything is deployed
  // ---------------------------------------------------------------------
  /**
   * The configured split of the 2% trade tax:
   *
   *   1.5% → stakers   (7500 bps of the tax)
   *   0.5% → the team  (2500 bps of the tax)
   *     0  → the corpus
   *
   * The corpus share is the remainder, and here there is none. That is a real
   * consequence, not a rounding detail: `floorPerToken()` stops growing from
   * trade tax, so the redemption floor is funded by donations or by nothing.
   * The script says so out loud at the end rather than leaving it to be
   * discovered from a chart that never moves.
   */
  const incomeBps = Number(process.env.INCOME_SHARE_BPS?.trim() || 7_500);
  const teamBps = Number(process.env.TEAM_SHARE_BPS?.trim() || 2_500);
  const teamRecipient = process.env.TEAM_RECIPIENT?.trim() || "";

  if (!Number.isInteger(incomeBps) || incomeBps < 0 || incomeBps > 7_500) {
    throw new Error(`INCOME_SHARE_BPS must be an integer in 0..7500, got "${incomeBps}".`);
  }
  if (!Number.isInteger(teamBps) || teamBps < 0 || teamBps > 2_500) {
    throw new Error(`TEAM_SHARE_BPS must be an integer in 0..2500, got "${teamBps}".`);
  }

  // A destination for money is never defaulted. Guessing it — to the deployer,
  // to the owner, to anything — is how revenue ends up at an address nobody
  // chose, and this one is re-pointable but the ETH that arrives meanwhile is
  // not recoverable from a stranger.
  if (teamBps !== 0) {
    if (!teamRecipient) {
      throw new Error(
        "TEAM_SHARE_BPS is non-zero but TEAM_RECIPIENT is not set. Set the " +
          "address team revenue should be paid to, or set TEAM_SHARE_BPS=0."
      );
    }
    if (!ethers.isAddress(teamRecipient) || teamRecipient !== ethers.getAddress(teamRecipient)) {
      throw new Error(`TEAM_RECIPIENT "${teamRecipient}" is not a checksummed address.`);
    }
  }

  const taxBps = Number(await curve.creatorTaxBps());
  const pct = (share: number) => ((taxBps * share) / 10_000 / 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  line();
  console.log("TAX SPLIT");
  line();
  console.log(`  trade tax        ${taxBps / 100}%`);
  console.log(`  → stakers        ${incomeBps} bps of tax  =  ${pct(incomeBps)}% of a trade`);
  console.log(`  → team           ${teamBps} bps of tax  =  ${pct(teamBps)}% of a trade`);
  console.log(`  → corpus/floor   ${10_000 - incomeBps - teamBps} bps of tax  =  ${pct(10_000 - incomeBps - teamBps)}% of a trade`);
  if (teamBps !== 0) console.log(`  team paid to     ${teamRecipient}`);

  // ---------------------------------------------------------------------
  // Cost — priced before a single wei is spent
  // ---------------------------------------------------------------------
  const [Treasury, FeeSink, StakedLoyal, Redeemer, Distributor] = await Promise.all([
    ethers.getContractFactory("Treasury"),
    ethers.getContractFactory("FeeSink"),
    ethers.getContractFactory("StakedLoyal"),
    ethers.getContractFactory("Redeemer"),
    ethers.getContractFactory("Distributor"),
  ]);

  // Deploy gas depends only on the bytecode and the constructor args, so it can
  // be measured now — with placeholder addresses for the not-yet-deployed ones,
  // since a constructor argument's *value* does not change the cost of storing
  // it. Anything already deployed costs nothing and is scored as zero.
  const PLACEHOLDER = deployer.address;
  const plan: Array<{ key: keyof Record_; label: string; data: string }> = [
    { key: "Treasury", label: "Treasury", data: (await Treasury.getDeployTransaction(owner)).data },
    { key: "FeeSink", label: "FeeSink", data: (await FeeSink.getDeployTransaction(PLACEHOLDER, FEE_ESCROW, owner)).data },
    { key: "StakedLoyal", label: "StakedLoyal", data: (await StakedLoyal.getDeployTransaction(TOKEN, owner)).data },
    { key: "Redeemer", label: "Redeemer", data: (await Redeemer.getDeployTransaction(TOKEN, PLACEHOLDER, owner)).data },
    { key: "Distributor", label: "Distributor", data: (await Distributor.getDeployTransaction(PLACEHOLDER)).data },
  ];

  let gasNeeded = WIRE_GAS * WIRE_TX_COUNT;
  const gasByStep: Record<string, bigint> = {};
  for (const step of plan) {
    if (rec[step.key]) continue; // already deployed on a previous run
    const g = await ethers.provider.estimateGas({ from: deployer.address, data: step.data });
    gasByStep[step.label] = g;
    gasNeeded += g;
  }

  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  if (gasPrice === 0n) throw new Error("Could not read a gas price from the node.");
  const cost = (gasNeeded * gasPrice * COST_BUFFER_BPS) / 10_000n;

  line();
  console.log("COST");
  line();
  for (const [k, v] of Object.entries(gasByStep)) console.log(`  ${k.padEnd(14)} ${v.toString().padStart(9)} gas`);
  console.log(`  ${"wiring".padEnd(14)} ${(WIRE_GAS * WIRE_TX_COUNT).toString().padStart(9)} gas  (${WIRE_TX_COUNT} txs)`);
  console.log(`  ${"total".padEnd(14)} ${gasNeeded.toString().padStart(9)} gas @ ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`  budget         ${eth(cost)}  (estimate x1.3)`);
  console.log(`  balance        ${eth(balance)}`);

  if (balance < cost) {
    line();
    console.log("STOPPING BEFORE SPENDING ANYTHING — the deployer cannot cover this.");
    console.log("");
    console.log(`  short by     ${eth(cost - balance)}`);
    console.log(`  fund         ${deployer.address}`);
    console.log("");
    console.log("Nothing has been deployed. Re-run this script once funded; it is");
    console.log("resumable, so a partial run is never wasted.");
    line();
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------------
  // Deploy
  // ---------------------------------------------------------------------
  line();
  console.log("DEPLOYING");
  line();

  async function ensure<T>(key: keyof Record_, label: string, deploy: () => Promise<any>) {
    if (rec[key]) {
      console.log(`${label.padEnd(12)} ${rec[key]}  (from a previous run)`);
      return ethers.getContractAt(label, rec[key] as string, deployer);
    }
    const c = await deploy();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    (rec as any)[key] = addr;
    save(rec); // persist before the next tx, so a failure loses nothing
    console.log(`${label.padEnd(12)} ${addr}  ${c.deploymentTransaction()?.hash ?? ""}`);
    return c;
  }

  const treasury: any = await ensure("Treasury", "Treasury", () => Treasury.deploy(owner));
  const treasuryAddr = await treasury.getAddress();

  const feeSink: any = await ensure("FeeSink", "FeeSink", () =>
    FeeSink.deploy(treasuryAddr, FEE_ESCROW, owner)
  );
  const feeSinkAddr = await feeSink.getAddress();

  const staking: any = await ensure("StakedLoyal", "StakedLoyal", () =>
    StakedLoyal.deploy(TOKEN, owner)
  );
  const stakingAddr = await staking.getAddress();

  const redeemer: any = await ensure("Redeemer", "Redeemer", () =>
    Redeemer.deploy(TOKEN, treasuryAddr, owner)
  );
  const redeemerAddr = await redeemer.getAddress();

  // No owner, no split, no second sink: nothing about the income route can be
  // changed after this line, by anyone.
  const distributor: any = await ensure("Distributor", "Distributor", () =>
    Distributor.deploy(stakingAddr)
  );
  const distributorAddr = await distributor.getAddress();

  // ---------------------------------------------------------------------
  // Wire
  // ---------------------------------------------------------------------
  line();
  console.log("WIRING");
  line();

  const pending: Array<[string, string]> = [];

  async function wire(label: string, read: () => Promise<string>, fn: string, arg: string) {
    const current = await read();
    if (current !== ethers.ZeroAddress) {
      const same = current.toLowerCase() === arg.toLowerCase();
      console.log(`${label.padEnd(24)} ${same ? "already set" : `ALREADY SET TO ${current}`}`);
      return;
    }
    if (!ownerIsDeployer) {
      pending.push([label, `to: ${treasuryAddr}  data: ${treasury.interface.encodeFunctionData(fn, [arg])}`]);
      console.log(`${label.padEnd(24)} deferred to governance`);
      return;
    }
    const tx = await treasury[fn](arg);
    await tx.wait();
    console.log(`${label.padEnd(24)} ✓ ${tx.hash}`);
  }

  await wire("Treasury.setFeeSink", () => treasury.feeSink(), "setFeeSink", feeSinkAddr);
  await wire("Treasury.setLoyal", () => treasury.loyal(), "setLoyal", TOKEN);
  await wire("Treasury.setRedeemer", () => treasury.redeemer(), "setRedeemer", redeemerAddr);
  await wire("Treasury.setDistributor", () => treasury.distributor(), "setDistributor", distributorAddr);

  /**
   * The economics, applied.
   *
   * Both dials are owner-settable afterwards, so nothing here is final — but
   * setting them during deployment means the contract is never live in a state
   * that contradicts what the frontend says it does.
   */
  async function setUint(label: string, fn: string, read: () => Promise<bigint>, want: number) {
    if (Number(await read()) === want) {
      console.log(`${label.padEnd(24)} already ${want}`);
      return;
    }
    if (!ownerIsDeployer) {
      pending.push([label, `to: ${treasuryAddr}  data: ${treasury.interface.encodeFunctionData(fn, [want])}`]);
      console.log(`${label.padEnd(24)} deferred to governance`);
      return;
    }
    const tx = await treasury[fn](want);
    await tx.wait();
    console.log(`${label.padEnd(24)} ✓ ${want}  ${tx.hash}`);
  }

  await setUint("Treasury.incomeShare", "setIncomeShareBps", () => treasury.incomeShareBps(), incomeBps);

  if (teamBps !== 0) {
    // Recipient before share: while the recipient is unset the team's cut is
    // simply left as corpus rather than earmarked into a liability nobody can
    // claim, so this ordering means no inflow can land in limbo even if the
    // second transaction fails.
    const currentRecipient: string = await treasury.teamRecipient();
    if (currentRecipient.toLowerCase() === teamRecipient.toLowerCase()) {
      console.log(`${"Treasury.teamRecipient".padEnd(24)} already ${currentRecipient}`);
    } else if (ownerIsDeployer) {
      const tx = await treasury.setTeamRecipient(teamRecipient);
      await tx.wait();
      console.log(`${"Treasury.teamRecipient".padEnd(24)} ✓ ${teamRecipient}  ${tx.hash}`);
    } else {
      pending.push(["Treasury.setTeamRecipient", `to: ${treasuryAddr}  data: ${treasury.interface.encodeFunctionData("setTeamRecipient", [teamRecipient])}`]);
    }
    await setUint("Treasury.teamShare", "setTeamShareBps", () => treasury.teamShareBps(), teamBps);
  }

  /**
   * Last, because it renounces.
   *
   * `setCurve` is the FeeSink's only privileged function, and it clears `owner`
   * in the same transaction. After this the sink has no admin at all: it can
   * pull from the escrow, sweep the curve, and push to the Treasury, and that
   * is the complete set of things anyone can ever make it do.
   *
   * The curve address is read from `token.curve()` and cross-checked against
   * `curve.token()` above, so it is not a value anyone typed.
   */
  const sinkCurve: string = await feeSink.curve();
  if (sinkCurve !== ethers.ZeroAddress) {
    console.log(`${"FeeSink.setCurve".padEnd(24)} already ${sinkCurve}`);
  } else {
    const sinkOwner: string = await feeSink.owner();
    if (sinkOwner.toLowerCase() === deployer.address.toLowerCase()) {
      const tx = await feeSink.setCurve(curveAddr);
      await tx.wait();
      console.log(`${"FeeSink.setCurve".padEnd(24)} ✓ ${tx.hash}  (owner renounced)`);
    } else {
      pending.push(["FeeSink.setCurve", `to: ${feeSinkAddr}  data: ${feeSink.interface.encodeFunctionData("setCurve", [curveAddr])}`]);
      console.log(`${"FeeSink.setCurve".padEnd(24)} deferred to ${sinkOwner}`);
    }
  }

  save(rec);

  // ---------------------------------------------------------------------
  // Read everything back. Nothing above is trusted to have worked.
  // ---------------------------------------------------------------------
  line();
  console.log("STATE, READ BACK FROM CHAIN");
  line();
  console.log(`Treasury.owner()           ${await treasury.owner()}`);
  console.log(`Treasury.loyal()           ${await treasury.loyal()}`);
  console.log(`Treasury.feeSink()         ${await treasury.feeSink()}`);
  console.log(`Treasury.redeemer()        ${await treasury.redeemer()}`);
  console.log(`Treasury.distributor()     ${await treasury.distributor()}`);
  console.log(`Treasury.operator()        ${await treasury.operator()}`);
  console.log(`Treasury.incomeShareBps()  ${await treasury.incomeShareBps()}  (stakers)`);
  console.log(`Treasury.teamShareBps()    ${await treasury.teamShareBps()}  (team)`);
  console.log(`Treasury.teamRecipient()   ${await treasury.teamRecipient()}`);
  console.log(`Treasury.pendingTeam()     ${eth(await treasury.pendingTeam())}`);
  console.log(`Treasury.nav()             ${eth(await treasury.nav())}`);
  console.log(`Treasury.eligibleSupply()  ${ethers.formatEther(await treasury.eligibleSupply())} LOYAL`);
  console.log(`Treasury.floorPerToken()   ${eth(await treasury.floorPerToken())}`);
  console.log(`FeeSink.treasury()         ${await feeSink.treasury()}`);
  console.log(`FeeSink.escrow()           ${await feeSink.escrow()}`);
  console.log(`FeeSink.curve()            ${await feeSink.curve()}`);
  console.log(`FeeSink.owner()            ${await feeSink.owner()}  ${(await feeSink.owner()) === ethers.ZeroAddress ? "(renounced — no admin)" : ""}`);
  console.log(`StakedLoyal.symbol()       ${await staking.symbol()}, ${await staking.decimals()} dp`);
  console.log(`StakedLoyal.asset()        ${await staking.asset()}`);
  console.log(`StakedLoyal.totalWeight()  ${await staking.totalWeight()}`);
  console.log(`Redeemer.loyal()           ${await redeemer.loyal()}`);
  console.log(`Redeemer.treasury()        ${await redeemer.treasury()}`);
  console.log(`  haircut ${await redeemer.haircutBps()} bps · delay ${await redeemer.redeemDelay()}s · epoch cap ${await redeemer.epochCapBps()} bps`);
  console.log(`Distributor.stakedLoyal()  ${await distributor.stakedLoyal()}`);

  const spent = balance - (await ethers.provider.getBalance(deployer.address));
  console.log(`\ngas spent                  ${eth(spent)}`);

  if (pending.length) {
    line();
    console.log("ACTION REQUIRED — these are onlyOwner and the deployer is not the owner:");
    for (const [label, call] of pending) console.log(`  ${label}\n    ${call}`);
  }

  // ---------------------------------------------------------------------
  // The one step this script will not take for you
  // ---------------------------------------------------------------------
  const stillEoa = (await curve.deployer()).toLowerCase() !== feeSinkAddr.toLowerCase();
  line();
  console.log("NEXT — move the curve's fee recipient to the FeeSink");
  line();
  if (!stillEoa) {
    console.log("Already done — curve.deployer() is the FeeSink. Nothing to do.");
  } else {
    console.log("THE FEE SINK ADDRESS:");
    console.log("");
    console.log(`    ${feeSinkAddr}`);
    console.log("");
    console.log("This is the address to set as the creator fee recipient. Read it off");
    console.log("this output rather than retyping it: whichever address goes in, the");
    console.log("entire fee stream belongs to it permanently, and there is no undo.");
    console.log("");
    console.log(`Only the Pons factory may make the change: ${PONS_FACTORY}`);
    console.log(`It is keyed by TOKEN, not by curve — passing the curve reverts.`);
    console.log("");
    console.log("  TIMELOCKED (use this one):");
    console.log(`    factory.setCreatorFeeRecipient(${TOKEN}, ${feeSinkAddr})`);
    console.log("    …wait 72h, then within the next 72h:");
    console.log(`    factory.executeCreatorFeeRecipientChange(${TOKEN})`);
    console.log("");
    console.log("  IMMEDIATE (do not):");
    console.log(`    factory.transferCreatorFeeRecipient(${TOKEN}, …)`);
    console.log("");
    console.log("Both land the same effect. The timelocked one gives three days to");
    console.log("notice a wrong address; the immediate one is the call that stranded");
    console.log("the previous deployment's fees permanently. cancelCreatorFee-");
    console.log("RecipientChange(token) aborts a pending change during the wait.");
    console.log("");
    console.log(`Signer must be the curve's current deployer: ${curveDeployer}`);
    if (curveDeployer.toLowerCase() === deployer.address.toLowerCase()) {
      console.log("  ↳ which is this deploying key.");
    }
  }

  line();
  console.log("Then, in loyal-frontend/src/lib/chain.ts:");
  line();
  console.log(`  token:       "${TOKEN}",`);
  console.log(`  curve:       "${curveAddr}",`);
  console.log(`  treasury:    "${treasuryAddr}",`);
  console.log(`  feeSink:     "${feeSinkAddr}",`);
  console.log(`  stakedLoyal: "${stakingAddr}",`);
  console.log(`  redeemer:    "${redeemerAddr}",`);
  console.log(`  distributor: "${distributorAddr}",`);
  console.log(`\nrecord written to deployments/loyal-${chainId}.json`);

  const finalIncome = Number(await treasury.incomeShareBps());
  const finalTeam = Number(await treasury.teamShareBps());
  const finalCorpus = 10_000 - finalIncome - finalTeam;

  if (finalIncome === 0) {
    line();
    console.log("⚠  incomeShareBps is 0 — STAKERS EARN NOTHING.");
    console.log("   With no yield adapter there is no other source of staker");
    console.log("   income, so the 0.5x / 1x / 3x tiers divide zero.");
    line();
  }

  if (finalCorpus === 0) {
    line();
    console.log("⚠  THE FLOOR NO LONGER GROWS.");
    console.log("");
    console.log("   The whole tax is allocated — stakers and the team take 100% of");
    console.log("   it — so nothing is left for the corpus. floorPerToken() will");
    console.log("   read 0 and stay there, and the Redeemer will burn LOYAL for");
    console.log("   nothing in return. It is not broken; it is unfunded.");
    console.log("");
    console.log("   Two ways this is honest rather than misleading:");
    console.log("     - shift some bps back to the corpus with setIncomeShareBps");
    console.log("       or setTeamShareBps, or");
    console.log("     - say plainly on the site that there is no floor and no");
    console.log("       redemption, and pause the Redeemer.");
    console.log("");
    console.log("   What must NOT happen is a page showing a floor chart against a");
    console.log("   floor that is structurally zero.");
    line();
  }

}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
