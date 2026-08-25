/**
 * Read-only pre-flight for the bind step. Prints nothing secret: it resolves the
 * signer from DEPLOYER_PRIVATE_KEY and reports only its address and balance,
 * then checks every address in .env actually holds the contract it claims to.
 */
import { ethers, network } from "hardhat";

const line = () => console.log("─".repeat(66));

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — DEPLOYER_PRIVATE_KEY missing or malformed.");
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(signer.address);

  line();
  console.log("PRE-FLIGHT");
  line();
  console.log(`network   ${network.name}  chainId ${net.chainId}`);
  console.log(`signer    ${signer.address}`);
  console.log(`balance   ${ethers.formatEther(bal)} ETH`);
  if (bal < ethers.parseEther("0.005")) {
    console.log("          ⚠ low — bind deploys 4 contracts and sends 2 txs");
  }

  const want = {
    TOKEN: "curve()",
    CURVE: "deployer()",
    TREASURY: "feeSink()",
    FEE_SINK: "treasury()",
    SUITS_NFT: "totalSupply()",
  } as const;

  line();
  for (const [key, probe] of Object.entries(want)) {
    const addr = process.env[key];
    if (!addr) { console.log(`${key.padEnd(10)} MISSING from .env`); continue; }
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") { console.log(`${key.padEnd(10)} ${addr}  ✗ NO CONTRACT`); continue; }
    let extra = "";
    try {
      const c = new ethers.Contract(addr, [`function ${probe} view returns (${probe === "totalSupply()" ? "uint256" : "address"})`], ethers.provider);
      extra = `→ ${probe.replace("()", "")} = ${await c[probe.replace("()", "")]()}`;
    } catch { extra = "(probe failed)"; }
    console.log(`${key.padEnd(10)} ${addr}  ✓ ${extra}`);
  }

  line();
  const owner = process.env.TREASURY_OWNER?.trim();
  console.log(`TREASURY_OWNER  ${owner || "(blank → the deploying EOA owns the treasury)"}`);
  const t = new ethers.Contract(process.env.TREASURY!, [
    "function owner() view returns (address)",
    "function loyal() view returns (address)",
  ], ethers.provider);
  const onChainOwner = await t.owner();
  console.log(`on-chain owner  ${onChainOwner}`);
  console.log(
    onChainOwner.toLowerCase() === signer.address.toLowerCase()
      ? "                ✓ the signer can run setLoyal/setRedeemer/setDistributor directly"
      : "                ⚠ signer is NOT the owner — bind will print calldata for governance"
  );
  const bound = await t.loyal();
  console.log(`Treasury.loyal  ${bound}  ${bound === ethers.ZeroAddress ? "(unbound — bind will set it)" : "(ALREADY BOUND — bind will skip)"}`);
  line();
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
