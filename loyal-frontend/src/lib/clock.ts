"use client";

import { useEffect, useState } from "react";

/**
 * Wall clock in unix seconds — **0 until mounted**.
 *
 * The zero is the whole point. `useState(() => Date.now())` runs on the server
 * too, so the server renders one timestamp and the client hydrates with
 * another, and React throws a mismatch on anything derived from it. Starting at
 * 0 means both passes render the same placeholder and the real time arrives in
 * an effect, which only ever runs on the client.
 *
 * Callers check for 0 and render a dash. That is honest anyway: before mount
 * the page genuinely does not know what time it is.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return now;
}
