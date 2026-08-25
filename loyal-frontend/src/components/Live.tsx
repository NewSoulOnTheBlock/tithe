"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readAll, type Snapshot } from "@/lib/reads";
import { fmtSig, fmtCompact, bpsToPct, shortAddr, DASH } from "@/lib/format";
import { LOYAL, explorerAddr, LOYAL_TAX_BPS_FALLBACK } from "@/lib/chain";
import { cn } from "@/lib/utils";

/**
 * The live readouts.
 *
 * One rule governs this whole file: a value that could not be read renders as
 * **unavailable**, never as zero. `null` means the chain did not answer; `0n`
 * means it answered zero. Collapsing those is how a dashboard ends up
 * confidently describing a protocol that is not there — and most of this stack
 * genuinely is not deployed yet, so the distinction is doing real work.
 */

function Stat({
  label,
  value,
  unit,
  note,
  accent = "cyan",
}: {
  label: string;
  value: string | null;
  unit?: string;
  note?: string;
  accent?: "cyan" | "magenta";
}) {
  const missing = value === null || value === DASH;
  return (
    <Card lit={accent}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "readout truncate text-2xl font-bold tracking-tight",
            missing
              ? "text-ash/40 text-base font-normal italic"
              : accent === "cyan"
                ? "neon-cyan"
                : "neon-magenta"
          )}
        >
          {missing ? "unavailable" : value}
          {!missing && unit && (
            <span className="ml-1.5 text-[10px] font-normal uppercase tracking-[0.18em] text-ash">
              {unit}
            </span>
          )}
        </div>
        {note && <p className="mt-2 text-[11px] leading-relaxed text-ash">{note}</p>}
      </CardContent>
    </Card>
  );
}

export function Live({
  onLive,
  onTax,
}: {
  onLive?: (live: boolean) => void;
  /** Lifts the live tax rate so the prose above cannot disagree with the panel. */
  onTax?: (bps: number | null) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const go = () =>
      readAll()
        .then((s) => {
          if (!alive) return;
          setSnap(s);
          setErr(null);
          onLive?.(s.staking.deployed);
          onTax?.(s.curve.taxBps != null ? Number(s.curve.taxBps) : null);
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)));

    go();
    const t = setInterval(go, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // `onLive` is a stable setter from the parent; re-subscribing on it would
    // restart the poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = snap?.token;
  const c = snap?.curve;
  const r = snap?.reserve;

  const circulating =
    t?.totalSupply != null && t?.burned != null ? t.totalSupply - t.burned : null;

  return (
    <section id="live" className="scroll-mt-24">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-bone">On chain</h2>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-ash">
            read live · nothing here is typed in
          </p>
        </div>
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-ash">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5",
              err ? "bg-magenta" : snap ? "animate-flicker bg-cyan" : "bg-ash/40"
            )}
          />
          {err ? "rpc error" : snap ? `block ${snap.block ?? DASH}` : "reading…"}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Market price"
          value={c?.priceWad != null ? fmtSig(c.priceWad, 4) : null}
          unit="ETH"
          note="priced off the bonding curve"
        />
        <Stat
          label="Raised on the curve"
          value={c?.raised != null ? fmtSig(c.raised, 4) : null}
          unit="ETH"
          note={
            c?.progressPct != null
              ? `${c.progressPct.toFixed(2)}% of the way to graduation`
              : "graduation threshold unavailable"
          }
          accent="magenta"
        />
        <Stat
          label="Circulating"
          value={circulating != null ? fmtCompact(circulating) : null}
          unit="LOYAL"
          note="fixed supply, burn-only — none can ever be created"
        />
        <Stat
          label="Trade tax"
          value={c?.taxBps != null ? bpsToPct(c.taxBps) : bpsToPct(LOYAL_TAX_BPS_FALLBACK)}
          note="taken on every buy and every sell"
          accent="magenta"
        />
      </div>

      {/* ---- the reserve, which is not there yet ---- */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Reserve"
          value={r?.nav != null ? fmtSig(r.nav, 4) : null}
          unit="ETH"
          note={r?.deployed ? "what the tax has collected" : "Treasury not deployed yet"}
        />
        <Stat
          label="Floor per token"
          value={r?.floorPerToken != null ? fmtSig(r.floorPerToken, 4) : null}
          unit="ETH"
          note={r?.deployed ? "nav ÷ eligible supply" : "needs the Treasury"}
        />
        <Stat
          label="To stakers"
          value={r?.incomeShareBps != null ? bpsToPct(r.incomeShareBps) : null}
          note={r?.deployed ? "the rest compounds into the floor" : "set after deployment"}
          accent="magenta"
        />
        <Stat
          label="Paid out"
          value={snap?.staking.cumulativeRewards != null ? fmtSig(snap.staking.cumulativeRewards, 4) : null}
          unit="ETH"
          note={snap?.staking.deployed ? "all time, to stakers" : "vault not deployed yet"}
          accent="magenta"
        />
      </div>

      {/* ---- the addresses, so any of it can be checked ---- */}
      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-[11px] text-ash">
        <a
          className="transition-colors hover:text-cyan"
          href={explorerAddr(LOYAL.token)}
          target="_blank"
          rel="noreferrer"
        >
          token <span className="text-bone/60">{shortAddr(LOYAL.token)}</span>
        </a>
        <a
          className="transition-colors hover:text-cyan"
          href={explorerAddr(LOYAL.curve)}
          target="_blank"
          rel="noreferrer"
        >
          curve <span className="text-bone/60">{shortAddr(LOYAL.curve)}</span>
        </a>
        <span>
          treasury <span className="text-ash/50">awaiting deployment</span>
        </span>
        <span>
          vault <span className="text-ash/50">awaiting deployment</span>
        </span>
      </div>
    </section>
  );
}
