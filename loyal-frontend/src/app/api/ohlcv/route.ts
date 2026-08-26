import { NextResponse } from "next/server";
import { LOYAL } from "@/lib/chain";

/**
 * GeckoTerminal OHLCV, proxied.
 *
 * ## Why this cannot be a browser fetch
 *
 * GeckoTerminal's public API sends no `access-control-allow-origin`, so a
 * direct call from the page is blocked by CORS before it leaves the browser.
 * The data is public and unauthenticated — there is no secret here — the proxy
 * exists purely because the origin will not permit cross-site reads.
 *
 * It buys two other things worth having:
 *
 * - **One upstream call serves every visitor.** The free tier is rate-limited
 *   per IP, and on a server that IP is shared by everyone. Without caching, a
 *   modest amount of traffic would 429 the endpoint for all of them at once.
 * - **The upstream shape stops leaking into the client.** GeckoTerminal returns
 *   `[timestamp, o, h, l, c, v]` tuples; the page gets named fields.
 *
 * `revalidate` matches their own `s-maxage=60`. Asking more often than the
 * source updates buys nothing but rate limit.
 */

export const revalidate = 60;

/** The pool is the Pons bonding curve itself — GeckoTerminal indexes it as
 *  `LOYAL / WETH`, which is why a chart works before graduation at all. */
const NETWORK = "robinhood";

/**
 * Allowlisted, and not just for tidiness: `tf` and `aggregate` are pasted into
 * an upstream URL, so anything a caller can put there is a request this server
 * makes on their behalf. A fixed table means the only reachable URLs are these
 * four.
 */
const FRAMES = {
  "5m": { path: "minute", aggregate: 5, limit: 288 },
  "1h": { path: "hour", aggregate: 1, limit: 168 },
  "4h": { path: "hour", aggregate: 4, limit: 180 },
  "1d": { path: "day", aggregate: 1, limit: 180 },
} as const;

// Not exported: a route module's export surface is validated by Next, and
// anything outside its known config keys is a build error. `ChartPane` declares
// the same shapes for itself — three lines duplicated rather than a shared
// module for three lines.
type Frame = keyof typeof FRAMES;
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export async function GET(req: Request) {
  const tf = (new URL(req.url).searchParams.get("tf") ?? "1h") as Frame;
  const f = FRAMES[tf] ?? FRAMES["1h"];

  const url =
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${LOYAL.curve.toLowerCase()}` +
    `/ohlcv/${f.path}?aggregate=${f.aggregate}&limit=${f.limit}&currency=usd`;

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate },
    });

    if (!res.ok) {
      // 429 is the common one and it is temporary, so it is reported as such
      // rather than as "no data" — the chart says "rate limited, retrying".
      return NextResponse.json(
        { error: res.status === 429 ? "rate-limited" : `upstream ${res.status}`, candles: [] },
        { status: 200 }
      );
    }

    const body = await res.json();
    const raw: number[][] = body?.data?.attributes?.ohlcv_list ?? [];

    // Upstream returns newest-first. Charts read left to right in time.
    const candles: Candle[] = raw
      .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
      .filter((k) => Number.isFinite(k.c) && k.c > 0)
      .sort((a, b) => a.t - b.t);

    return NextResponse.json({ candles, error: null });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), candles: [] }, { status: 200 });
  }
}
