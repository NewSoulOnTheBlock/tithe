import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RH_RPC_URL,
  RH_CHAIN_ID,
  DEPLOYER_PRIVATE_KEY,
} = process.env;

/**
 * The signing key is read from the environment and nowhere else.
 *
 * Never paste a private key into a chat window, a commit, or a shell command
 * (shell history persists it). `.env` is gitignored at the repo root.
 *
 * Preferred, in order:
 *   1. A hardware wallet, or an encrypted keystore (`cast wallet import loyal`)
 *      with a one-off signing step.
 *   2. A freshly generated deploy-only key funded with just enough gas, kept in
 *      `.env`, and treated as disposable after deployment. Nothing in these
 *      contracts requires the deployer to retain power — ownership is handed to
 *      TREASURY_OWNER at construction time.
 */
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // The Treasury is meant to be read and audited, not just executed.
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    /**
     * `FORK=1` points the in-process node at Robinhood Chain, so the Beefy
     * adapter can be exercised against the **real** CLM vault, reward pool and
     * Uniswap v3 pool rather than mocks. Pin a block with `FORK_BLOCK` for a
     * reproducible run; leave it unset to track the chain head.
     *
     * Mocks cannot answer the questions that matter here — whether Beefy's
     * `isCalm()` gate passes, whether the in-ratio split actually mints shares,
     * how much the pool's own fee eats. Only the live state can.
     */
    hardhat: process.env.FORK
      ? {
          forking: {
            url: RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
            blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined,
          },
          chainId: 4663,
          // Chain 4663 is not in Hardhat's built-in table, so its hardfork
          // history has to be declared or every historical call reverts with
          // "No known hardfork for execution on historical block".
          chains: {
            4663: { hardforkHistory: { shanghai: 0 } },
          },
        }
      : {},
    localhost: { url: "http://127.0.0.1:8545" },
    /**
     * A `npx hardhat node --fork <RH_RPC_URL> --port 8546` instance.
     * `scripts/rehearse-beefy.ts` drives the adapter against real Beefy state
     * here — see that script's header for why mocks were not enough.
     */
    forked: { url: "http://127.0.0.1:8546" },
    robinhood: {
      url: RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: RH_CHAIN_ID ? Number(RH_CHAIN_ID) : 4663,
      accounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
