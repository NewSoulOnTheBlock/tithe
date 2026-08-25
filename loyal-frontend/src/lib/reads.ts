import { Contract } from "ethers";
import { provider, LOYAL, isLive } from "./chain";

/**
 * Every read resolves to `null` on failure rather than throwing.
 *
 * Most of this protocol is not deployed yet, and a page whose whole claim is
 * that its numbers are checkable has to render "unknown" honestly instead of a
 * zero that looks like a measurement. A `null` here means *we could not read
 * it*; a `0n` means the chain said zero. Those are different facts and the UI
 * shows them differently.
 */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export type TokenInfo = {
  name: string | null;
  symbol: string | null;
  totalSupply: bigint | null;
  burned: bigint | null;
};

const DEAD = "0x000000000000000000000000000000000000dEaD";

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

export async function readToken(): Promise<TokenInfo> {
  const c = new Contract(LOYAL.token, ERC20, provider);
  const [name, symbol, totalSupply, burned] = await Promise.all([
    safe(() => c.name() as Promise<string>),
    safe(() => c.symbol() as Promise<string>),
    safe(async () => BigInt(await c.totalSupply())),
    safe(async () => BigInt(await c.balanceOf(DEAD))),
  ]);
  return { name, symbol, totalSupply, burned };
}

export type CurveInfo = {
  /** ETH raised on the curve so far. */
  raised: bigint | null;
  graduationThreshold: bigint | null;
  graduated: boolean | null;
  /** Price of one LOYAL in ETH, as a WAD. */
  priceWad: bigint | null;
  taxBps: bigint | null;
  /** 0–100. */
  progressPct: number | null;
};

/**
 * The Pons bonding curve.
 *
 * The ABI was recovered by selector-scraping on a sibling deployment rather
 * than published, so every field is read defensively: a getter this contract
 * turns out not to have resolves to `null` and the row says so, instead of the
 * whole panel failing.
 */
const CURVE = [
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function creatorTaxBps() view returns (uint256)",
];

export async function readCurve(): Promise<CurveInfo> {
  const c = new Contract(LOYAL.curve, CURVE, provider);

  const [reserves, raised, threshold, graduated, taxBps] = await Promise.all([
    safe(() => c.getReserves() as Promise<[bigint, bigint]>),
    safe(async () => BigInt(await c.realQuoteReserve())),
    safe(async () => BigInt(await c.graduationThreshold())),
    safe(() => c.graduated() as Promise<boolean>),
    safe(async () => BigInt(await c.creatorTaxBps())),
  ]);

  let priceWad: bigint | null = null;
  if (reserves) {
    const [quote, token] = [BigInt(reserves[0]), BigInt(reserves[1])];
    if (token > 0n) priceWad = (quote * 10n ** 18n) / token;
  }

  const progressPct =
    raised !== null && threshold !== null && threshold > 0n
      ? Math.min(100, (Number(raised) / Number(threshold)) * 100)
      : null;

  return { raised, graduationThreshold: threshold, graduated, priceWad, taxBps, progressPct };
}

export type ReserveInfo = {
  deployed: boolean;
  nav: bigint | null;
  floorPerToken: bigint | null;
  eligibleSupply: bigint | null;
  pendingIncome: bigint | null;
  incomeShareBps: bigint | null;
  cumulativeTax: bigint | null;
};

const TREASURY = [
  "function nav() view returns (uint256)",
  "function floorPerToken() view returns (uint256)",
  "function eligibleSupply() view returns (uint256)",
  "function pendingIncome() view returns (uint256)",
  "function incomeShareBps() view returns (uint16)",
  "function cumulativeTaxReceived() view returns (uint256)",
];

export async function readReserve(): Promise<ReserveInfo> {
  if (!isLive(LOYAL.treasury)) {
    return {
      deployed: false, nav: null, floorPerToken: null, eligibleSupply: null,
      pendingIncome: null, incomeShareBps: null, cumulativeTax: null,
    };
  }
  const c = new Contract(LOYAL.treasury, TREASURY, provider);
  const [nav, floor, supply, income, share, tax] = await Promise.all([
    safe(async () => BigInt(await c.nav())),
    safe(async () => BigInt(await c.floorPerToken())),
    safe(async () => BigInt(await c.eligibleSupply())),
    safe(async () => BigInt(await c.pendingIncome())),
    safe(async () => BigInt(await c.incomeShareBps())),
    safe(async () => BigInt(await c.cumulativeTaxReceived())),
  ]);
  return {
    deployed: true, nav, floorPerToken: floor, eligibleSupply: supply,
    pendingIncome: income, incomeShareBps: share, cumulativeTax: tax,
  };
}

export type StakingInfo = {
  deployed: boolean;
  totalAssets: bigint | null;
  totalWeight: bigint | null;
  cumulativeRewards: bigint | null;
};

const STAKING = [
  "function totalAssets() view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function cumulativeRewards() view returns (uint256)",
  "function tierOf(address) view returns (uint8)",
  "function effectiveTier(address) view returns (uint8)",
  "function lockedUntil(address) view returns (uint256)",
  "function weightOf(address) view returns (uint256)",
  "function pendingYield(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

export async function readStaking(): Promise<StakingInfo> {
  if (!isLive(LOYAL.stakedLoyal)) {
    return { deployed: false, totalAssets: null, totalWeight: null, cumulativeRewards: null };
  }
  const c = new Contract(LOYAL.stakedLoyal, STAKING, provider);
  const [assets, weight, rewards] = await Promise.all([
    safe(async () => BigInt(await c.totalAssets())),
    safe(async () => BigInt(await c.totalWeight())),
    safe(async () => BigInt(await c.cumulativeRewards())),
  ]);
  return { deployed: true, totalAssets: assets, totalWeight: weight, cumulativeRewards: rewards };
}

export type Snapshot = {
  block: number | null;
  token: TokenInfo;
  curve: CurveInfo;
  reserve: ReserveInfo;
  staking: StakingInfo;
};

export async function readAll(): Promise<Snapshot> {
  const [block, token, curve, reserve, staking] = await Promise.all([
    safe(() => provider.getBlockNumber()),
    readToken(),
    readCurve(),
    readReserve(),
    readStaking(),
  ]);
  return { block, token, curve, reserve, staking };
}
