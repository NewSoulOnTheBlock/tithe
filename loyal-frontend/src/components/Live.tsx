"use client";

import type { Snapshot } from "@/lib/reads";
import { fmtSig, fmtCompact, bpsToPct, DASH } from "@/lib/format";
import { LOYAL, LOYAL_TAX_BPS_FALLBACK } from "@/lib/chain";
import { Copyable } from "@/components/Copyable";
import { cn } from "@/lib/utils";

/**
 * The chain state, set as a ledger rather than a dashboard.
 *
 * ## Why rows and not cards
 *
 * A grid of stat cards is the default crypto layout and it flattens everything
 * into equal importance — price, supply and an undeployed contract all get the
 * same box. A ledger has a reading order and a column of values that line up,
 * so the eye runs down the numbers and the labels stay out of the way. It also
 * looks like what it is: a printout of what the chain said, which is the claim
 * this section is making.
 *
 * ## One rule
 *
 * A value that could not be read renders as **unavailable**, never as zero.
 * `null` means the chain did not answer; `0n` means it answered zero. Most of
 * this stack is genuinely not deployed yet, so collapsing those two would turn
 * an absence into a measurement — a confident dashboard describing a protocol
 * that is not there.
 */

function Row({
  label,
  value,
  unit,
  note,
  accent,
}: {
  label: string;
  value: string | null;
  unit?: string;
  note?: string;
  accent?: "cyan" | "magenta";
}) {
  const missing = value === null || value === DASH;
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 border-b border-edge py-4 sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
      <span className="text-[11px] uppercase tracking-[0.18em] text-ash">{label}</span>

      <span className="order-3 text-[11px] leading-relaxed text-ash/60 sm:order-none">
        {note}
      </span>

      <span
        className={cn(
          "readout justify-self-end text-lg font-bold tracking-tight sm:text-xl",
          missing
            ? "text-sm font-normal italic text-ash/40"
            : accent === "magenta"
              ? "neon-magenta"
              : accent === "cyan"
                ? "neon-cyan"
                : "text-bone"
        )}
      >
        {missing ? "unavailable" : value}
        {!missing && unit && (
          <span className="ml-1.5 text-[10px] font-normal uppercase tracking-[0.18em] text-ash">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

export function Live({ snap, error }: { snap: Snapshot | null; error: string | null }) {
  const err = error;

  const c = snap?.curve;
  const r = snap?.reserve;
  const t = snap?.token;

  const circulating =
    t?.totalSupply != null && t?.burned != null ? t.totalSupply - t.burned : null;

  return (
    <section id="live" className="scroll-mt-24">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-xs uppercase tracking-[0.25em] text-ash">
          What the chain says
        </h2>
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-ash/70">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5",
              err ? "bg-magenta" : snap ? "animate-flicker bg-cyan" : "bg-ash/40"
            )}
          />
          {err ? "rpc unreachable" : snap ? `block ${snap.block ?? DASH}` : "reading…"}
        </span>
      </div>

      <div className="border-t border-edge">
        <Row
          label="Market price"
          value={c?.priceWad != null ? fmtSig(c.priceWad, 4) : null}
          unit="ETH"
          note="priced off the bonding curve"
          accent="cyan"
        />
        <Row
          label="Raised"
          value={c?.raised != null ? fmtSig(c.raised, 4) : null}
          unit="ETH"
          note={
            c?.progressPct != null
              ? `${c.progressPct.toFixed(2)}% of the way to graduation`
              : "threshold unavailable"
          }
          accent="magenta"
        />
        <Row
          label="Circulating"
          value={circulating != null ? fmtCompact(circulating) : null}
          unit="LOYAL"
          note="fixed supply, burn-only — none can ever be created"
        />
        <Row
          label="Trade tax"
          value={c?.taxBps != null ? bpsToPct(c.taxBps) : bpsToPct(LOYAL_TAX_BPS_FALLBACK)}
          note="on every buy and every sell"
          accent="magenta"
        />
        <Row
          label="Reserve"
          value={r?.nav != null ? fmtSig(r.nav, 4) : null}
          unit="ETH"
          note={r?.deployed ? "what the tax has collected" : "Treasury not deployed yet"}
        />
        <Row
          label="Floor per token"
          value={r?.floorPerToken != null ? fmtSig(r.floorPerToken, 4) : null}
          unit="ETH"
          note={r?.deployed ? "reserve ÷ eligible supply" : "needs the Treasury"}
        />
        <Row
          label="Share to stakers"
          value={r?.incomeShareBps != null ? bpsToPct(r.incomeShareBps) : null}
          note={r?.deployed ? "the rest compounds into the floor" : "set after deployment"}
        />
        <Row
          label="Paid out"
          value={
            snap?.staking.cumulativeRewards != null
              ? fmtSig(snap.staking.cumulativeRewards, 4)
              : null
          }
          unit="ETH"
          note={snap?.staking.deployed ? "all time, to stakers" : "vault not deployed yet"}
        />
      </div>

      {/* ---- the addresses, copyable ---- */}
      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3">
        <Copyable label="token" address={LOYAL.token} />
        <Copyable label="curve" address={LOYAL.curve} />
        <span className="text-[11px] text-ash/50">
          treasury <span className="italic">awaiting deployment</span>
        </span>
        <span className="text-[11px] text-ash/50">
          vault <span className="italic">awaiting deployment</span>
        </span>
      </div>
    </section>
  );
}
