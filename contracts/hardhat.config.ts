import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RH_RPC_URL,
  RH_CHAIN_ID,
  DEPLOYER_PRIVATE_KEY,
  BLOCKSCOUT_API_KEY,
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
  /**
   * Verification against the chain's Blockscout instance.
   *
   * Blockscout speaks the Etherscan v1 API well enough for hardhat-verify, but
   * it has to be declared as a custom chain because 4663 is not in the plugin's
   * table. Verification itself authenticates nothing, so any non-empty string
   * satisfies the plugin's schema.
   *
   * **Two different hosts, and the key only works on one of them.**
   *
   * The instance at robinhoodchain.blockscout.com allows **ten requests**, full
   * stop — measured, and an API key on it changes nothing (query param, header
   * and bearer all return an identical 429). `hardhat verify` spends three or
   * four requests per contract (getsourcecode → verifysourcecode →
   * checkverifystatus), so five contracts exhaust the anonymous quota mid-run
   * and everything after returns 429 — indistinguishable from a rejection
   * unless you read `x-ratelimit-remaining`. The window is about ten minutes.
   *
   * A dev.blockscout.com key belongs to the **cloud proxy** at
   * api.blockscout.com/<chainId>/api instead, which speaks the same
   * Etherscan-v1 dialect, refuses anonymous callers outright (402 rather than
   * 429, which is at least honest), and rate-limits per second rather than by
   * a fixed budget. So the key selects the host as well as authorising it.
   *
   * `sourcify` is off: with it enabled the plugin tries Sourcify first and
   * reports a confusing failure for a chain Sourcify does not index.
   */
  etherscan: {
    apiKey: { robinhood: BLOCKSCOUT_API_KEY || "blockscout-needs-no-key" },
    customChains: [
      {
        network: "robinhood",
        chainId: RH_CHAIN_ID ? Number(RH_CHAIN_ID) : 4663,
        urls: {
          apiURL: BLOCKSCOUT_API_KEY
            ? `https://api.blockscout.com/${RH_CHAIN_ID ? Number(RH_CHAIN_ID) : 4663}/api`
            : "https://robinhoodchain.blockscout.com/api",
          // Always the instance: this is only ever printed for a human to click.
          browserURL: "https://robinhoodchain.blockscout.com/",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
