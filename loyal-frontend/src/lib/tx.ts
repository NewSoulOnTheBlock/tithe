"use client";

import { Contract, type JsonRpcSigner } from "ethers";
import { useCallback, useState } from "react";

/**
 * One transaction at a time, with the three states that actually matter.
 *
 * ## Why the errors are translated
 *
 * These contracts revert with custom errors, and ethers surfaces them as
 * `execution reverted (unknown custom error)` plus a selector. That string
 * tells a holder nothing, and the underlying conditions are ones they can
 * usually fix — the lock has not run out, there is nothing to claim yet. So the
 * known ones are named, and anything unrecognised falls through with its
 * original message rather than being swallowed behind a generic apology.
 *
 * ## Rejection is not failure
 *
 * Code 4001 is someone closing their wallet, which is a decision. Rendering it
 * in red as an error scolds them for it, so it clears the state silently.
 */

const REVERTS: Record<string, string> = {
  StillLocked: "Your lock is still standing — you committed to it, so it holds.",
  NothingToClaim: "Nothing to claim yet.",
  CannotDowngradeWhileLocked: "A standing lock can be extended, never shortened.",
  NotExpired: "That lock has not run out yet.",
  NotAllowed: "This address is not allowed by the vault's gate.",
  NoStakers: "There is nobody staked to pay.",
  NothingToNotify: "No reward was sent.",
  ERC20InsufficientAllowance: "The vault is not approved for that much yet.",
  ERC20InsufficientBalance: "You do not hold that much LOYAL.",
  ERC4626ExceededMaxRedeem: "That is more than you have staked.",
  ERC4626ExceededMaxWithdraw: "That is more than you have staked.",
};

function explain(e: any): string | null {
  // The user closed the wallet. Not an error.
  if (e?.code === 4001 || e?.code === "ACTION_REJECTED") return null;

  const name: string | undefined = e?.revert?.name ?? e?.errorName;
  if (name && REVERTS[name]) return REVERTS[name];
  if (name) return name;

  const msg: string = e?.shortMessage ?? e?.reason ?? e?.message ?? "Transaction failed.";
  if (/insufficient funds/i.test(msg)) return "Not enough ETH to pay for gas.";
  return msg;
}

export type TxRunner = {
  /** Label of the step in flight, e.g. "approve". Null when idle. */
  busy: string | null;
  hash: string | null;
  error: string | null;
  /** Set once a transaction has confirmed, so the UI can say so. */
  done: string | null;
  clear: () => void;
  run: (
    label: string,
    build: (signer: JsonRpcSigner) => Promise<any>
  ) => Promise<boolean>;
};

export function useTx(getSigner: () => Promise<JsonRpcSigner>, onConfirmed?: () => void): TxRunner {
  const [busy, setBusy] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const clear = useCallback(() => {
    setError(null);
    setDone(null);
    setHash(null);
  }, []);

  const run = useCallback(
    async (label: string, build: (signer: JsonRpcSigner) => Promise<any>) => {
      setBusy(label);
      setError(null);
      setDone(null);
      setHash(null);
      try {
        const signer = await getSigner();
        const tx = await build(signer);
        setHash(tx.hash);
        await tx.wait();
        setDone(label);
        onConfirmed?.();
        return true;
      } catch (e: any) {
        setError(explain(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [getSigner, onConfirmed]
  );

  return { busy, hash, error, done, clear, run };
}

/** A contract bound to the signer, for writes. */
export function writable(address: string, abi: string[], signer: JsonRpcSigner) {
  return new Contract(address, abi, signer);
}
