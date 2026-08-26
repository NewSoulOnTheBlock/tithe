import { formatUnits } from "ethers";

export const DASH = "—";

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) =>
  String(n).split("").map((d) => SUBSCRIPTS[Number(d)]).join("");

/**
 * Significant figures, not fixed decimals.
 *
 * A fresh token's price is a long run of zeros, and `0.00` tells the reader
 * nothing. Four or more leading zeros collapse into a subscript count —
 * `0.0₈7392` — which is the convention DEX interfaces settled on for exactly
 * this, and which keeps the unit honestly in ETH rather than quietly switching
 * to gwei.
 *
 * Everything is computed from the exact decimal string `formatUnits` produces,
 * so no float rounding creeps in on the way.
 */
export function fmtSig(v: bigint | null | undefined, sig = 4, decimals = 18): string {
  if (v === null || v === undefined) return DASH;

  let s: string;
  try {
    s = formatUnits(v, decimals);
  } catch {
    return DASH;
  }

  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const sign = neg ? "-" : "";

  const [int, frac = ""] = s.split(".");

  if (int !== "0") {
    const whole = BigInt(int).toLocaleString("en-US");
    const d = frac.slice(0, sig).replace(/0+$/, "");
    return sign + (d ? `${whole}.${d}` : whole);
  }

  let zeros = (frac.match(/^0*/)?.[0] ?? "").length;
  const rest = frac.slice(zeros).replace(/0+$/, "");
  if (!rest) return "0";

  let digits = rest.slice(0, sig);
  if (Number(rest[sig] ?? "0") >= 5) {
    const bumped = (BigInt(digits) + 1n).toString();
    if (bumped.length > digits.length) {
      // 0.00009999 → 0.0001: the carry shortens the zero run by one. Missing
      // this prints a number ten times too small.
      zeros -= 1;
      digits = bumped.slice(0, sig);
    } else {
      digits = bumped.padStart(digits.length, "0");
    }
  }
  digits = digits.replace(/0+$/, "") || "0";

  if (zeros >= 4) return `${sign}0.0${subscript(zeros)}${digits}`;
  return `${sign}0.${"0".repeat(zeros)}${digits}`;
}

/** Grouped decimal with fixed places. `decimals` is not optional in spirit —
 *  stLOYAL is 21dp and formatting it as 18 prints 1000x too large. */
export function fmtGrouped(
  v: bigint | null | undefined,
  frac = 2,
  decimals = 18
): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(formatUnits(v, decimals));
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

export function shortAddr(a?: string | null): string {
  if (!a) return DASH;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function bpsToPct(bps: number | bigint | null | undefined): string {
  if (bps === null || bps === undefined) return DASH;
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

/**
 * A unix timestamp as an absolute local date and time.
 *
 * A countdown alone ("6d 4h left") is not something anyone can plan around — it
 * answers "how long" but never "when", and a week-long commitment is exactly
 * the kind of thing people want to hold next to a calendar. Both are shown,
 * because they answer different questions.
 *
 * Only ever called after mount (see `useNow`), so locale formatting here cannot
 * produce a hydration mismatch.
 */
export function fmtDateTime(unix: number | null | undefined): string {
  if (unix === null || unix === undefined || unix === 0) return DASH;
  return new Date(unix * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Seconds → the largest sensible unit. Used for lock countdowns. */
export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}


/**
 * Compact notation for figures that are read, not audited.
 *
 * A billion-token supply printed in full is fourteen characters and overflows
 * any card it is put in — it clipped its own unit label on first render. `1.00B`
 * carries the same meaning at a glance and the exact figure is a click away on
 * the explorer, which is where anyone checking it would go anyway.
 */
export function fmtCompact(v: bigint | null | undefined, decimals = 18): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(formatUnits(v, decimals));
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
