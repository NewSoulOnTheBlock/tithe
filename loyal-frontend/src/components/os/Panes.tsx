"use client";

import type { Snapshot } from "@/lib/reads";
import { fmtSig, fmtCompact, pctOfSupply, DASH, shortAddr } from "@/lib/format";
import { LOYAL, EXPLORER, SOCIALS, isLive, explorerAddr, CHAIN_ID } from "@/lib/chain";
import { Copyable } from "@/components/Copyable";
import { Glyph } from "./Glyph";
import { cn } from "@/lib/utils";

/**
 * Window contents.
 *
 * ## Why these are not the page components
 *
 * `Definition`, `Stake` and `Live` were written for a single column as wide as
 * the viewport, and two things break when they are dropped into a 600px panel.
 *
 * The first is scale: a `clamp(3.2rem, 14vw, 10rem)` headline is sized against
 * the *window*, not the panel, so it blows straight through the frame.
 *
 * The second is subtler and would have been a long afternoon to debug.
 * Tailwind's `sm:` / `lg:` prefixes are **viewport** queries, not container
 * queries — so a `sm:grid-cols-2` inside a 560px panel still goes to two
 * columns, because the browser window is 1440px. Every responsive rule in those
 * components is answering a question about the wrong box.
 *
 * So the panes below use fixed layouts chosen for their panel's width, and the
 * page components stay untouched for the stacked mobile shell that still wants
 * them.
 */

/* ==========================================================================
   0x01 — LOYALTY.DEF
   ========================================================================== */
export function DefPane({ tax }: { tax: number }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="glitch text-[3.4rem] font-bold leading-[0.85] tracking-tighter text-bone" data-text="loyalty">
          loyalty
        </h1>
        <span className="text-xs text-ash">/ˈlɔɪ.əl.ti/</span>
        <span className="text-[11px] italic text-magenta">noun</span>
      </div>

      <div className="mt-7 space-y-5">
        <div className="flex gap-3">
          <span className="mt-0.5 w-4 shrink-0 text-[13px] text-cyan">1.</span>
          <p className="text-[13.5px] leading-relaxed text-ash">
            the quality of staying faithful to someone or something; strong support that does
            not depend on convenience.
          </p>
        </div>

        <div className="flex gap-3">
          <span className="mt-0.5 w-4 shrink-0 text-[13px] text-cyan">2.</span>
          <div>
            <p className="text-[13.5px] leading-relaxed text-bone">
              <span className="text-ash">(finance)</span> a duration a holder agrees to be held
              to, priced in multiples of a share of income.
            </p>

            {/*
              The usage example — the one slot on a dictionary page where a
              sentence belongs. In a callout it reads as marketing; here, in
              italics under the sense it illustrates, it reads as evidence that
              the word means what the contract says it means.
            */}
            <blockquote className="mt-3 border-l border-magenta/60 pl-3.5">
              <p className="text-[13.5px] italic leading-relaxed text-bone/90">
                &ldquo;Give me <span className="not-italic neon-cyan">1 Day</span> to earn your
                loyalty. I&apos;ll ask again tomorrow, because loyalty is something you{" "}
                <span className="not-italic neon-magenta">earn every day</span>.&rdquo;
              </p>
            </blockquote>
          </div>
        </div>
      </div>

      <p className="mt-6 border-t border-edge pt-5 text-[11px] leading-relaxed text-ash/70">
        <span className="text-magenta">Origin:</span> Old French{" "}
        <em className="not-italic text-bone/60">loial</em>, from Latin{" "}
        <em className="not-italic text-bone/60">legalis</em> — &ldquo;of the law&rdquo;. It has
        always meant something you can be held to.
      </p>

      <p className="mt-4 text-[13px] leading-relaxed text-bone/90">
        Every trade pays <span className="neon-cyan">{(tax / 100).toFixed(tax % 100 === 0 ? 0 : 2)}%</span>,
        and a share of it goes to the people who staked. How big a share is decided by how long
        you are willing to be held to it.
      </p>
    </div>
  );
}

/* ==========================================================================
   0x03 — RESERVE.SYS
   ========================================================================== */
function Row({ label, value, unit, pct, note, accent }: {
  label: string;
  value: string | null;
  unit?: string;
  /** Rendered in parentheses after the unit, e.g. a share of supply. */
  pct?: string | null;
  note?: string;
  accent?: "cyan" | "magenta";
}) {
  // `null` is not `0`. A value the chain did not answer says so; collapsing the
  // two would turn an absence into a measurement.
  const missing = value === null || value === DASH;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-5 border-b border-edge py-3">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-[0.16em] text-ash">{label}</p>
        {note && <p className="mt-0.5 truncate text-[10px] text-ash/50">{note}</p>}
      </div>
      <span
        className={cn(
          "readout justify-self-end text-base font-bold tracking-tight",
          missing
            ? "text-xs font-normal italic text-ash/40"
            : accent === "magenta" ? "neon-magenta" : accent === "cyan" ? "neon-cyan" : "text-bone"
        )}
      >
        {missing ? "unavailable" : value}
        {!missing && unit && (
          <span className="ml-1 text-[9px] font-normal uppercase tracking-[0.16em] text-ash">{unit}</span>
        )}
        {!missing && pct && (
          <span className="ml-1.5 text-[10px] font-normal text-ash/70">({pct})</span>
        )}
      </span>
    </div>
  );
}

export function ReservePane({ snap, error }: { snap: Snapshot | null; error: string | null }) {
  const c = snap?.curve;
  const t = snap?.token;
  const s = snap?.staking;
  const circulating = t?.totalSupply != null && t?.burned != null ? t.totalSupply - t.burned : null;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-[9px] uppercase tracking-[0.2em] text-ash/70">
        <span className={cn("inline-block h-1.5 w-1.5", error ? "bg-magenta" : snap ? "animate-flicker bg-cyan" : "bg-ash/40")} />
        {error ? "rpc unreachable" : snap ? `block ${snap.block ?? DASH}` : "reading…"}
      </div>

      <div className="border-t border-edge">
        <Row label="Market price" value={c?.priceWad != null ? fmtSig(c.priceWad, 4) : null} unit="ETH" note="off the bonding curve" accent="cyan" />
        <Row
          label="Raised"
          value={c?.raised != null ? fmtSig(c.raised, 4) : null}
          unit="ETH"
          note={c?.progressPct != null ? `${c.progressPct.toFixed(2)}% to graduation` : "threshold unavailable"}
          accent="magenta"
        />
        <Row label="Circulating" value={circulating != null ? fmtCompact(circulating) : null} unit="LOYAL" note="fixed supply, burn-only" />
        {/*
          Reserve and floor-per-token used to sit here and both read a hard 0.

          Not a display bug — a structural one. The whole trade tax is allocated
          the moment it arrives, so the corpus receives nothing and
          `floorPerToken()` can never move off zero. A row that is correct,
          live, and permanently zero teaches a reader that the numbers on this
          page do not mean anything. Removed rather than dressed up.
        */}
        <Row
          label="Total staked"
          value={s?.totalAssets != null ? fmtCompact(s.totalAssets) : null}
          unit="LOYAL"
          pct={pctOfSupply(s?.totalAssets, t?.totalSupply)}
          note={s?.deployed ? "custodied by the vault" : "vault unreachable"}
          accent="cyan"
        />
        <Row label="Paid to stakers" value={s?.cumulativeRewards != null ? fmtSig(s.cumulativeRewards, 4) : null} unit="ETH" note="all time" />
      </div>

      {error && <p className="mt-4 text-[11px] text-magenta">{error}</p>}
    </div>
  );
}

/* ==========================================================================
   0x04 — NOTICE.TXT
   ========================================================================== */
export function NoticePane({ tax }: { tax: number }) {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const items: [string, string][] = [
    ["A round trip costs you twice", `${pct(tax)} in and ${pct(tax)} out — ${pct(tax * 2)} before the price moves at all.`],
    ["Locked means locked", "While a lock stands you cannot withdraw or transfer. That is what the multiplier is paying for."],
    ["Rewards are ETH, not more LOYAL", "So staking does not dilute you, and the share price never moves — one stLOYAL is one LOYAL, always."],
    ["Burning is a one-way door", "Redeeming destroys your LOYAL at the moment you ask, not when you collect. There is no cancel and no re-mint."],
    ["Not a bank, a fund, or advice", "It is a tax, a pot, and a queue — all three readable from the chain."],
  ];

  return (
    <div>
      <p className="mb-4 text-[10px] uppercase tracking-[0.22em] text-magenta">Read before committing</p>
      <dl className="divide-y divide-edge border-y border-edge">
        {items.map(([k, v]) => (
          <div key={k} className="py-3.5">
            <dt className="text-[12.5px] text-bone">{k}</dt>
            <dd className="mt-1 text-[11.5px] leading-relaxed text-ash">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ==========================================================================
   0x05 — SYSTEM
   ========================================================================== */
export function SysPane({ snap, tax }: { snap: Snapshot | null; tax: number }) {
  const rows: [string, React.ReactNode][] = [
    ["System", <span key="s" className="text-bone">LOYAL // loyalty OS</span>],
    ["Chain", `Robinhood Chain · ${CHAIN_ID}`],
    ["Block", snap?.block != null ? String(snap.block) : DASH],
    ["Launchpad", "Pons bonding curve"],
    ["Trade tax", `${(tax / 100).toFixed(tax % 100 === 0 ? 0 : 2)}% on every buy and sell`],
    ["Vault token", `stLOYAL · 21 decimals`],
  ];

  const contracts: [string, string][] = [
    ["token", LOYAL.token],
    ["curve", LOYAL.curve],
    ["treasury", LOYAL.treasury],
    ["staking", LOYAL.stakedLoyal],
    ["redeemer", LOYAL.redeemer],
    ["distributor", LOYAL.distributor],
    ["fee sink", LOYAL.feeSink],
  ];

  return (
    <div>
      <div className="flex items-start gap-5">
        <div className="grid h-16 w-16 shrink-0 place-items-center border border-cyan/30 bg-cyan/[0.05]">
          <span className="text-cyan"><Glyph name="sys" size={30} /></span>
        </div>
        <dl className="min-w-0 flex-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 border-b border-edge py-1.5">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-ash">{k}</dt>
              <dd className="readout truncate text-right text-[11.5px] text-bone/85">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-6 text-[10px] uppercase tracking-[0.22em] text-ash">Contracts</p>
      <div className="mt-3 space-y-2">
        {contracts.map(([label, addr]) =>
          isLive(addr) ? (
            <Copyable key={label} label={label} address={addr} />
          ) : (
            <p key={label} className="text-[11px] text-ash/50">
              {label} <span className="italic">not deployed</span>
            </p>
          )
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-edge pt-5 text-[11px]">
        <a className="flex items-center gap-1.5 text-ash transition-colors hover:text-cyan" href={EXPLORER} target="_blank" rel="noreferrer">
          <Glyph name="link" size={13} /> explorer
        </a>
        <a className="flex items-center gap-1.5 text-ash transition-colors hover:text-cyan" href={SOCIALS.telegram} target="_blank" rel="noreferrer">
          <Glyph name="link" size={13} /> telegram
        </a>
        <a className="flex items-center gap-1.5 text-ash transition-colors hover:text-cyan" href={SOCIALS.x} target="_blank" rel="noreferrer">
          <Glyph name="link" size={13} /> x
        </a>
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-ash/45">
        Every address above was read back off chain 4663 after deployment, one binding at a time —
        not copied from a deploy log.
      </p>
    </div>
  );
}
