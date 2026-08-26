"use client";

import { Contract } from "ethers";
import { useCallback, useEffect, useState } from "react";
import { provider, LOYAL, isLive } from "./chain";

/**
 * Everything the connected address needs to know about its own position.
 *
 * Read on its own poller rather than folded into `useChain`, for one reason:
 * these reads have a *different lifetime*. Protocol numbers are true for
 * everyone and can tick along at 20s; a position changes the instant its owner
 * signs something, and has to be re-read on demand right after. Merging them
 * would mean either refreshing the whole protocol snapshot after every
 * approval, or making people wait up to twenty seconds to see their own stake
 * appear.
 *
 * Every field is `null` until read, never `0n` — a balance that could not be
 * fetched must not render as "you have nothing", which is a different and much
 * more alarming statement.
 */

export type Position = {
  /** LOYAL sitting in the wallet, available to stake. */
  balance: bigint | null;
  /** LOYAL the vault is allowed to pull. Below the amount ⇒ approve first. */
  allowance: bigint | null;
  /** stLOYAL held. 21 decimals — never format this with formatEther. */
  shares: bigint | null;
  /** Those shares valued back in LOYAL. This is the number people mean. */
  staked: bigint | null;
  /** Claimable ETH. */
  pending: bigint | null;
  /** `tierOf` — what the contract is weighting them at right now. */
  tier: number | null;
  /** `effectiveTier` — what they SHOULD be at. Differs only after expiry. */
  effective: number | null;
  /** Unix seconds. 0 means unlocked. */
  lockedUntil: number | null;
  weight: bigint | null;
};

const EMPTY: Position = {
  balance: null, allowance: null, shares: null, staked: null,
  pending: null, tier: null, effective: null, lockedUntil: null, weight: null,
};

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export const VAULT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function pendingYield(address) view returns (uint256)",
  "function tierOf(address) view returns (uint8)",
  "function effectiveTier(address) view returns (uint8)",
  "function lockedUntil(address) view returns (uint256)",
  "function weightOf(address) view returns (uint256)",
  "function isLocked(address) view returns (bool)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function lock(uint8 tier)",
  "function claim() returns (uint256)",
  "function kick(address account)",
];

export const ERC20_ABI = [
  ...ERC20,
  "function approve(address spender, uint256 value) returns (bool)",
];

export async function readPosition(account: string): Promise<Position> {
  if (!isLive(LOYAL.stakedLoyal) || !isLive(LOYAL.token)) return EMPTY;

  const token = new Contract(LOYAL.token, ERC20, provider);
  const vault = new Contract(LOYAL.stakedLoyal, VAULT_ABI, provider);

  const [balance, allowance, shares, pending, tier, effective, lockedUntil, weight] =
    await Promise.all([
      safe(async () => BigInt(await token.balanceOf(account))),
      safe(async () => BigInt(await token.allowance(account, LOYAL.stakedLoyal))),
      safe(async () => BigInt(await vault.balanceOf(account))),
      safe(async () => BigInt(await vault.pendingYield(account))),
      safe(async () => Number(await vault.tierOf(account))),
      safe(async () => Number(await vault.effectiveTier(account))),
      safe(async () => Number(await vault.lockedUntil(account))),
      safe(async () => BigInt(await vault.weightOf(account))),
    ]);

  // Shares are 21-decimal and assets are 18-decimal, so the conversion has to
  // come from the vault rather than from arithmetic here. Skipped entirely at
  // zero: `convertToAssets(0)` is a wasted round trip with an obvious answer.
  const staked =
    shares === null ? null : shares === 0n ? 0n : await safe(async () => BigInt(await vault.convertToAssets(shares)));

  return { balance, allowance, shares, staked, pending, tier, effective, lockedUntil, weight };
}

export function usePosition(account: string | null, intervalMs = 15_000) {
  const [pos, setPos] = useState<Position>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  /** Call after a transaction confirms — do not wait for the next tick. */
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!account) {
      setPos(EMPTY);
      return;
    }
    let alive = true;
    setLoading(true);
    const go = () =>
      readPosition(account)
        .then((p) => alive && setPos(p))
        .catch(() => {})
        .finally(() => alive && setLoading(false));

    go();
    const t = setInterval(go, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [account, intervalMs, nonce]);

  return { pos, loading, refresh };
}
