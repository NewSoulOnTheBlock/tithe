import { JsonRpcProvider } from "ethers";

/**
 * Chain 4663 — Robinhood Chain, where LOYAL actually lives.
 *
 * Verified live: `Loyal (LOYAL)`, 1,000,000,000 supply, 18 decimals, launched
 * on Pons with its own bonding curve. Everything here was read off the chain
 * rather than copied from a deploy log.
 */

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";

/**
 * The public endpoint, deliberately over a keyed one: nothing here needs a key,
 * so shipping one would put a secret in the bundle to buy nothing.
 */
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

export const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });

export const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * ## What is live, and what is not
 *
 * The token and its curve exist. The reserve stack — Treasury, staking,
 * Redeemer, Distributor — is written and tested but **not deployed yet**, so
 * those stay at the zero address.
 *
 * That is not a placeholder to be filled in with something plausible. A read
 * against `address(0)` resolves to `null` and the interface says "not deployed"
 * in as many words. The alternative — pointing at the previous token's
 * contracts because they happen to exist — would render a complete, confident
 * dashboard describing a protocol that has nothing to do with LOYAL.
 */
export const LOYAL = {
  /** Verified: name() == "Loyal", symbol() == "LOYAL". */
  token: "0x1B7f9c45DfF56d8b4309f01afb4763d9C595318e",
  /** The Pons bonding curve this token launched on, read from `token.curve()`. */
  curve: "0x46286E8Fb83BAAfaa7D9Af26cc6d52e3EEcA205b",
  /** `token.deployer()`. */
  deployer: "0x16E7C1B229d5701e75Cccb68C13fcbf98FE5c027",

  treasury: ZERO,
  feeSink: ZERO,
  stakedLoyal: ZERO,
  redeemer: ZERO,
  distributor: ZERO,
} as const;

export const isLive = (addr: string) => !!addr && addr !== ZERO;

/**
 * stLOYAL carries **21** decimals, not 18.
 *
 * `StakedLoyal._decimalsOffset()` returns 3 — OpenZeppelin's virtual-share
 * defence against the 4626 first-depositor donation attack — and ERC-4626
 * defines `decimals() = underlying + offset`. One whole stLOYAL is `1e21`, and
 * it is still worth exactly one LOYAL, because the share price never moves:
 * rewards are ETH and live outside `totalAssets()`.
 *
 * Formatting a share balance through `formatEther` therefore prints it **1000x
 * too large**. That was a live display bug on a sibling deployment before it
 * was caught, so it is written down here rather than rediscovered.
 */
export const ST_LOYAL_DECIMALS = 21;

/**
 * The creator tax, read live from the curve: `creatorTaxBps() == 200`.
 *
 * This is a **fallback**, not the source of truth. It is 2% here and it was 4%
 * on a sibling launch, and hardcoding the wrong one put "4%" in the prose while
 * the live readout on the same page said 2% — the page contradicting itself in
 * two places a reader can see at once. Anything user-facing should prefer the
 * value from `readCurve()` and fall back to this only when the read fails.
 */
export const LOYAL_TAX_BPS_FALLBACK = 200;

/** Flap/Pons's own cut, separate from the creator tax. `feeBps() == 100`. */
export const CURVE_FEE_BPS_FALLBACK = 100;

// ---------------------------------------------------------------------------
// Loyalty tiers — the contract's own numbers
// ---------------------------------------------------------------------------

export type TierKey = "NONE" | "DAY" | "WEEK";

/**
 * Mirrors `StakedLoyal.Tier` exactly: index, multiplier in bps, lock length.
 *
 * Rewards are divided by **weight**, not share count — weight is your balance
 * times this multiplier. So the tiers decide how income is split between
 * stakers and never how much leaves the Treasury: a vault where everyone is
 * unlocked still pays out every wei.
 */
export const TIERS: {
  key: TierKey;
  index: number;
  bps: number;
  multiplier: string;
  lockSeconds: number;
  label: string;
  lockLabel: string;
  line: string;
}[] = [
  {
    key: "NONE",
    index: 0,
    bps: 5_000,
    multiplier: "0.5×",
    lockSeconds: 0,
    label: "No lock",
    lockLabel: "leave whenever",
    line: "Stay as long as you feel like. You get half a share of every payout, because half a promise is what you made.",
  },
  {
    key: "DAY",
    index: 1,
    bps: 10_000,
    multiplier: "1×",
    lockSeconds: 86_400,
    label: "1 day",
    lockLabel: "24 hours",
    line: "Give me one day. A full share of every payout, and tomorrow you decide again.",
  },
  {
    key: "WEEK",
    index: 2,
    bps: 30_000,
    multiplier: "3×",
    lockSeconds: 604_800,
    label: "1 week",
    lockLabel: "7 days",
    line: "Seven days, no exit. Triple share — the most this contract can pay anyone.",
  },
];

export const tierByIndex = (i: number) => TIERS.find((t) => t.index === i) ?? TIERS[0];

export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
