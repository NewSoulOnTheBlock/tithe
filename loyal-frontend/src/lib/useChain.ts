"use client";

import { useEffect, useState } from "react";
import { readAll, type Snapshot } from "./reads";

/**
 * One poller for the whole page.
 *
 * The hero and the ledger both want live numbers, and each running its own
 * `readAll` would double the RPC traffic and let the two disagree for a few
 * seconds after every refresh — the same figure in two places, briefly
 * different, which is exactly the kind of thing that makes a reader stop
 * trusting a page.
 */
export function useChain(intervalMs = 20_000) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const go = () =>
      readAll()
        .then((s) => {
          if (!alive) return;
          setSnap(s);
          setError(null);
        })
        .catch((e) => alive && setError(String(e?.message ?? e)));

    go();
    const t = setInterval(go, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);

  return { snap, error };
}
