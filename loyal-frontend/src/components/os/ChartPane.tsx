"use client";

import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "@/lib/reads";
import { useFieldSize } from "@/lib/wm";
import { fmtSig, DASH } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Price, drawn rather than embedded.
 *
 * ## Why not a chart library, and why not an iframe
 *
 * An embedded GeckoTerminal or DexScreener widget is one line and looks like
 * somebody else's product bolted onto this one — their type, their palette,
 * their chrome, inside a window that spent some care not looking generic. A
 * charting library (lightweight-charts, recharts) is ~50KB to draw rectangles
 * and comes with its own opinions about axes and tooltips.
 *
 * Candles are rectangles and lines. The whole renderer below is about eighty
 * lines of SVG and inherits the palette for free: up is cyan, down is magenta,
 * the same two accents as everything else.
 *
 * ## It works before graduation
 *
 * That was the open question. GeckoTerminal indexes the **Pons bonding curve
 * itself** as a `LOYAL / WETH` pool — the pool address and the curve address
 * are the same contract — so there is real OHLCV from the first trade, with no
 * DEX and no graduation required. The progress bar underneath is not a
 * substitute for a chart; it is the other half of the story, and it stops being
 * interesting on the day the curve fills.
 */

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Frame = "5m" | "1h" | "4h" | "1d";
const FRAMES: Frame[] = ["5m", "1h", "4h", "1d"];

/**
 * A price of 0.0000102 has no useful "two decimal places".
 *
 * Fixed precision either rounds the whole number to zero or floods it with
 * padding, so the decimal count is derived from the magnitude: enough digits to
 * carry four significant figures, and never fewer than two.
 */
function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (n === 0) return "$0";
  const dp = Math.min(12, Math.max(2, Math.ceil(-Math.log10(Math.abs(n))) + 3));
  return `$${n.toFixed(dp)}`;
}

function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const timeLabel = (t: number, f: Frame) =>
  new Date(t * 1000).toLocaleString("en-GB",
    f === "1d"
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
  );

export function ChartPane({ snap }: { snap: Snapshot | null }) {
  const [frame, setFrame] = useState<Frame>("1h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [ref, size] = useFieldSize<HTMLDivElement>();

  useEffect(() => setBox(size), [size]);

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setError(null);
    const go = () =>
      fetch(`/api/ohlcv?tf=${frame}`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setCandles(d.candles ?? []);
          setError(d.error ?? null);
        })
        .catch((e) => alive && setError(String(e?.message ?? e)));
    go();
    // The upstream caches for 60s; polling faster only spends rate limit.
    const t = setInterval(go, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [frame]);

  // ---- geometry ------------------------------------------------------------
  const W = Math.max(280, box.w || 440);
  const PAD_R = 58;
  const H_PRICE = 172;
  const H_VOL = 40;
  const GAP = 10;
  const H = H_PRICE + GAP + H_VOL;
  const plotW = W - PAD_R;

  const view = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const lo = Math.min(...candles.map((c) => c.l));
    const hi = Math.max(...candles.map((c) => c.h));
    const span = hi - lo || hi || 1;
    const pad = span * 0.08;
    const min = Math.max(0, lo - pad);
    const max = hi + pad;
    const vMax = Math.max(...candles.map((c) => c.v), 1);

    const n = candles.length;
    const step = plotW / n;
    const body = Math.max(1, Math.min(9, step * 0.62));

    const y = (p: number) => H_PRICE - ((p - min) / (max - min)) * H_PRICE;
    const x = (i: number) => i * step + step / 2;

    return { min, max, vMax, step, body, y, x, n };
  }, [candles, plotW]);

  const last = candles && candles.length ? candles[candles.length - 1] : null;
  const first = candles && candles.length ? candles[0] : null;
  const change = last && first && first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null;
  const shown = hover !== null && candles ? candles[hover] : last;
  const volTotal = candles ? candles.reduce((a, c) => a + c.v, 0) : 0;

  const curve = snap?.curve;
  const pct = curve?.progressPct ?? null;

  return (
    <div>
      {/* ---- readout + timeframe ---- */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <p className="text-[9px] uppercase tracking-[0.22em] text-ash">
            LOYAL / WETH{hover !== null && shown ? ` · ${timeLabel(shown.t, frame)}` : ""}
          </p>
          <p className="readout mt-1 text-3xl font-bold tracking-tighter neon-cyan">
            {usd(shown?.c)}
          </p>
          <p className="mt-0.5 text-[10px] text-ash">
            {change !== null ? (
              <span className={change >= 0 ? "text-cyan" : "text-magenta"}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
              </span>
            ) : (
              DASH
            )}
            <span className="ml-2 text-ash/50">over {candles?.length ?? 0} candles</span>
            {volTotal > 0 && <span className="ml-2 text-ash/50">· vol {compactUsd(volTotal)}</span>}
          </p>
        </div>

        <div className="flex gap-1">
          {FRAMES.map((f) => (
            <button
              key={f}
              onClick={() => setFrame(f)}
              className={cn(
                "border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors",
                f === frame
                  ? "border-cyan/50 bg-cyan/10 text-cyan"
                  : "border-edge text-ash hover:border-cyan/40 hover:text-bone"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* ---- the chart ---- */}
      <div ref={ref} className="relative w-full">
        {candles === null ? (
          <div style={{ height: H }} className="grid place-items-center text-[11px] text-ash/50">
            reading the pool…
          </div>
        ) : candles.length === 0 ? (
          <div style={{ height: H }} className="grid place-items-center px-6 text-center text-[11px] leading-relaxed text-ash/60">
            {error === "rate-limited"
              ? "GeckoTerminal is rate-limiting — this retries on its own."
              : "No candles for this range yet. The pool is young; try a shorter timeframe."}
          </div>
        ) : (
          <svg
            width={W}
            height={H}
            className="block select-none"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              if (!view) return;
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const i = Math.floor(((e.clientX - r.left) / plotW) * view.n);
              setHover(i >= 0 && i < view.n ? i : null);
            }}
          >
            {/* horizontal guides + price axis */}
            {view &&
              [0, 0.25, 0.5, 0.75, 1].map((f) => {
                const p = view.min + (view.max - view.min) * (1 - f);
                const y = f * H_PRICE;
                return (
                  <g key={f}>
                    <line x1={0} x2={plotW} y1={y} y2={y} stroke="#151b2b" strokeWidth={1} />
                    <text x={plotW + 6} y={y + 3} fill="#7c88a8" fontSize={8} fontFamily="ui-monospace, monospace">
                      {usd(p)}
                    </text>
                  </g>
                );
              })}

            {/* candles */}
            {view &&
              candles.map((c, i) => {
                const up = c.c >= c.o;
                const col = up ? "#00e5ff" : "#ff2bd1";
                const x = view.x(i);
                const yO = view.y(c.o);
                const yC = view.y(c.c);
                const top = Math.min(yO, yC);
                // A doji would render as nothing without a floor on the height.
                const h = Math.max(1, Math.abs(yC - yO));
                return (
                  <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.55}>
                    <line x1={x} x2={x} y1={view.y(c.h)} y2={view.y(c.l)} stroke={col} strokeWidth={1} />
                    <rect x={x - view.body / 2} y={top} width={view.body} height={h} fill={col} />
                    <rect
                      x={x - view.body / 2}
                      y={H_PRICE + GAP + (H_VOL - (c.v / view.vMax) * H_VOL)}
                      width={view.body}
                      height={(c.v / view.vMax) * H_VOL}
                      fill={col}
                      opacity={0.35}
                    />
                  </g>
                );
              })}

            {/* crosshair */}
            {view && hover !== null && candles[hover] && (
              <g pointerEvents="none">
                <line x1={view.x(hover)} x2={view.x(hover)} y1={0} y2={H} stroke="#7c88a8" strokeWidth={1} strokeDasharray="2 3" />
                <line x1={0} x2={plotW} y1={view.y(candles[hover].c)} y2={view.y(candles[hover].c)} stroke="#7c88a8" strokeWidth={1} strokeDasharray="2 3" />
              </g>
            )}

            <line x1={0} x2={plotW} y1={H_PRICE} y2={H_PRICE} stroke="#151b2b" strokeWidth={1} />
          </svg>
        )}
      </div>

      {/* hovered candle detail — OHLC is the reason to have candles at all */}
      {hover !== null && shown && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ash">
          {(["o", "h", "l", "c"] as const).map((k) => (
            <span key={k}>
              <span className="text-ash/50">{k.toUpperCase()}</span>{" "}
              <span className="readout text-bone/85">{usd(shown[k])}</span>
            </span>
          ))}
          <span>
            <span className="text-ash/50">VOL</span>{" "}
            <span className="readout text-bone/85">{compactUsd(shown.v)}</span>
          </span>
        </div>
      )}

      {/* ---- graduation ---- */}
      <div className="mt-6 border-t border-edge pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[9px] uppercase tracking-[0.2em] text-ash">Bonding curve</span>
          <span className={cn("readout text-[11px]", pct != null ? "text-magenta" : "text-ash/40")}>
            {pct != null ? `${pct.toFixed(2)}%` : DASH}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full bg-edge">
          <div
            className="h-full bg-gradient-to-r from-cyan to-magenta transition-all duration-1000"
            style={{ width: `${Math.min(100, pct ?? 0)}%` }}
          />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-ash/60">
          {curve?.raised != null && curve?.graduationThreshold != null ? (
            <>
              <span className="text-bone/80">{fmtSig(curve.raised, 4)} ETH</span> of{" "}
              {fmtSig(curve.graduationThreshold, 3)} ETH raised. Every candle above is priced off
              this curve — there is no DEX pool yet, and the curve is what graduates into one.
            </>
          ) : (
            "Graduation threshold unavailable."
          )}
        </p>
      </div>
    </div>
  );
}
