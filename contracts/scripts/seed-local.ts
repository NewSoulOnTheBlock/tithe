/**
 * Local-only helper: deploy a mock LOYAL so `deploy.ts` can be exercised
 * end-to-end against a node before it is ever pointed at mainnet.
 *
 *   npx hardhat run scripts/seed-local.ts --network localhost
 *   LOYAL_TOKEN=<printed> npx hardhat run scripts/deploy.ts --network localhost
 */
import { ethers } from "hardhat";

async function main() {
  const supply = 1_000_000_000n * 10n ** 18n;
  const mock = await (await ethers.getContractFactory("MockLoyal")).deploy(supply);
  await mock.waitForDeployment();
  console.log(await mock.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
