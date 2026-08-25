/**
 * Step 2 of the relaunch: launch the token with the FeeSink already set as
 * `creatorFeeRecipient`.
 *
 *   npx hardhat run scripts/launch.ts --network robinhood            # dry run
 *   LAUNCH_EXECUTE=1 npx hardhat run scripts/launch.ts --network robinhood
 *
 * DRY RUN BY DEFAULT. Without LAUNCH_EXECUTE=1 this only simulates via
 * staticCall and prints what it would send. The launch is irreversible and
 * costs the launch fee, so it should never happen as a side effect.
 *
 * Two params are not documented anywhere we can read, so the script resolves
 * them empirically rather than guessing:
 *
 *   expectedEconomics (bytes32) — a commitment to the pool economics, to stop a
 *       launch landing under config that changed after you quoted it. We try
 *       several candidates and keep whichever SIMULATES successfully. This is
 *       the same discriminating dry-run technique that pinned the UniversalRouter
 *       encoding and the curve's buy() parameter order.
 *
 *   launchConfigId — probed against previewLaunchEconomics.
 */
import { ethers, network } from "hardhat";

const FACTORY = process.env.PONS_FACTORY ?? "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ETH = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "00".repeat(32);

const NAME = process.env.TOKEN_NAME ?? "Loyal";
const SYMBOL = process.env.TOKEN_SYMBOL ?? "LOYAL";
const LOGO = process.env.TOKEN_LOGO ?? "";
const DESCRIPTION = process.env.TOKEN_DESCRIPTION ?? "";
const TAX_BPS = Number(process.env.CREATOR_TAX_BPS ?? 400);

const line = () => console.log("─".repeat(72));

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const feeSink = process.env.FEE_SINK?.trim();
  if (!feeSink) throw new Error("FEE_SINK not set — run scripts/deploy.ts first.");

  line();
  console.log("LOYAL — step 2/3: launch the token");
  line();
  console.log(`network   ${network.name} (chainId ${net.chainId})`);
  console.log(`launcher  ${deployer.address}`);
  console.log(`factory   ${FACTORY}`);
  console.log(`name/sym  ${NAME} / ${SYMBOL}`);
  console.log(`tax       ${TAX_BPS} bps (${TAX_BPS / 100}%)`);
  console.log(`recipient ${feeSink}   ← THE FEESINK, set at launch`);

  // Guard: the recipient must be a contract that can actually collect.
  const sinkCode = await ethers.provider.getCode(feeSink);
  if (sinkCode === "0x") throw new Error(`FEE_SINK ${feeSink} has no code.`);
  const sink = await ethers.getContractAt("FeeSink", feeSink);
  for (const [fn, label] of [
    ["claimFromEscrow", "escrow claim"],
    ["sweepCurve", "curve sweep"],
  ] as const) {
    if (!sink.interface.hasFunction(fn)) {
      throw new Error(`FEE_SINK cannot ${label} — refusing to launch into a dead-end.`);
    }
  }
  console.log(`          ↳ sink can claim from escrow AND sweep the curve ✓`);

  const abi = [
    "function launchToken((string,string,string,string,(string,string,string),address,uint16,bool,bytes32,bytes32) params, uint256 launchConfigId, address pairToken) payable returns (address)",
    "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (uint256,uint256,uint8)",
    "function launchFee() view returns (uint256)",
    "function launchEnabled() view returns (bool)",
    "function maxCreatorTaxBps() view returns (uint256)",
  ];
  const f = new ethers.Contract(FACTORY, abi, deployer);

  const [fee, enabled, maxTax] = await Promise.all([
    f.launchFee(),
    f.launchEnabled(),
    f.maxCreatorTaxBps(),
  ]);
  console.log(`fee       ${ethers.formatEther(fee)} ETH   enabled=${enabled}   maxTax=${maxTax}`);
  if (!enabled) throw new Error("Launching is disabled on the factory.");
  if (BigInt(TAX_BPS) > maxTax) throw new Error(`tax ${TAX_BPS} exceeds max ${maxTax}`);

  console.log("\nprobing launch configs…");
  const configs: number[] = [];
  for (let id = 0; id < 8; id++) {
    try {
      const p = await f.previewLaunchEconomics(id, ETH);
      console.log(`  [${id}] phantomQuote=${ethers.formatEther(p[0])} graduation=${ethers.formatEther(p[1])} decimals=${p[2]}`);
      configs.push(id);
    } catch { /* not a valid config */ }
  }
  if (!configs.length) throw new Error("No usable launch config for the ETH pair.");
  const configId = Number(process.env.LAUNCH_CONFIG_ID ?? configs[0]);
  console.log(`  using launchConfigId=${configId}`);

  const socials: [string, string, string] = [
    process.env.TOKEN_TWITTER ?? "",
    process.env.TOKEN_TELEGRAM ?? "",
    process.env.TOKEN_WEBSITE ?? "",
  ];
  const salt = process.env.LAUNCH_SALT ?? ethers.hexlify(ethers.randomBytes(32));

  const build = (expectedEconomics: string) =>
    [NAME, SYMBOL, LOGO, DESCRIPTION, socials, feeSink, TAX_BPS, false, expectedEconomics, salt] as const;

  // Resolve expectedEconomics by simulation instead of guessing.
  console.log("\nresolving expectedEconomics by simulation…");
  const preview = await f.previewLaunchEconomics(configId, ETH);
  const candidates: Array<[string, string]> = [
    ["zero (no commitment)", ZERO32],
    [
      "keccak(abi.encode(phantomQuote, graduationThreshold, decimals))",
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint8"],
          [preview[0], preview[1], preview[2]]
        )
      ),
    ],
    [
      "keccak(abi.encode(phantomQuote, graduationThreshold))",
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [preview[0], preview[1]]
        )
      ),
    ],
  ];

  let chosen: string | null = null;
  for (const [label, value] of candidates) {
    try {
      await f.launchToken.staticCall(build(value), configId, ETH, { value: fee });
      console.log(`  \x1b[32mSIMULATES OK\x1b[0m  ${label}`);
      if (!chosen) chosen = value;
    } catch (e: any) {
      const r = String(e.revert?.name ?? e.shortMessage ?? e.message).slice(0, 52);
      console.log(`  reverts       ${label.padEnd(52)} ${r}`);
    }
  }
  if (!chosen) {
    throw new Error(
      "No expectedEconomics candidate simulated successfully. Do NOT send this " +
        "transaction — resolve the commitment format first."
    );
  }

  const params = build(chosen);
  const predicted = await f.launchToken.staticCall(params, configId, ETH, { value: fee });

  line();
  console.log("SIMULATED LAUNCH");
  line();
  console.log(`predicted token address  ${predicted}`);
  console.log(`creatorFeeRecipient      ${feeSink}`);
  console.log(`creatorTaxBps            ${TAX_BPS}`);
  console.log(`launchConfigId           ${configId}`);
  console.log(`pairToken                ${ETH} (native ETH)`);
  console.log(`salt                     ${salt}`);
  console.log(`expectedEconomics        ${chosen}`);
  console.log(`value                    ${ethers.formatEther(fee)} ETH`);

  if (process.env.LAUNCH_EXECUTE !== "1") {
    line();
    console.log("DRY RUN — nothing was sent.");
    console.log("Re-run with LAUNCH_EXECUTE=1 to launch for real.");
    console.log(`Keep this salt if you want the same address: LAUNCH_SALT=${salt}`);
    line();
    return;
  }

  console.log("\nLAUNCHING FOR REAL…");
  const tx = await f.launchToken(params, configId, ETH, { value: fee });
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  mined in block ${rc?.blockNumber}`);

  line();
  console.log("NEXT — step 3: bind the contracts to the launched token");
  line();
  console.log(`  TOKEN=${predicted}`);
  console.log("  npx hardhat run scripts/bind.ts --network robinhood");
  console.log("");
  console.log("Verify BEFORE trading that the recipient really is the sink.");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
