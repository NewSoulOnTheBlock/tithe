"use client";

import type { Snapshot } from "@/lib/reads";
import { fmtSig, fmtCompact, DASH } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The masthead, set as a real dictionary entry.
 *
 * ## Why the client's line lives here and not in a callout
 *
 * A dictionary entry has a part nothing else has: the **usage example** — an
 * italic sentence showing the word in the wild, indented under the sense it
 * illustrates. That is exactly the shape of the sentence this product was built
 * around, so it goes there rather than into a quote box further down the page.
 *
 * Put in a box it reads as marketing. Put under sense 2, in italics, it reads
 * as evidence that the word means what the contract says it means — and the
 * reader arrives at it while still reading the definition, which is the only
 * moment they are guaranteed to be paying attention.
 *
 * ## What sits beside it
 *
 * A ticking "time on this page" counter did, briefly. It was a gimmick: it
 * measured the reader rather than the protocol and told nobody anything they
 * could act on. The slot now carries the single most consequential live number
 * — once the vault exists that is **total staked**; until then it is how close
 * the curve is to graduating, which is the only thing actually in motion.
 *
 * It never renders as dead. If a number cannot be read it says so, and the
 * headline falls through to one that can.
 */
export function Definition({ tax, snap }: { tax: number; snap: Snapshot | null }) {
  const staking = snap?.staking;
  const curve = snap?.curve;

  const vaultLive = !!staking?.deployed;

  // The headline is whichever number is load-bearing right now.
  const headline = vaultLive
    ? {
        label: "total staked",
        value: staking?.totalAssets != null ? fmtCompact(staking.totalAssets) : null,
        unit: "LOYAL",
        note: "locked in the vault, earning a share of every trade",
      }
    : {
        label: "raised on the curve",
        value: curve?.raised != null ? fmtSig(curve.raised, 4) : null,
        unit: "ETH",
        note:
          curve?.graduationThreshold != null
            ? `of ${fmtSig(curve.graduationThreshold, 3)} ETH needed to graduate`
            : "graduation threshold unavailable",
      };

  const pct = curve?.progressPct ?? null;

  return (
    <header className="relative">
      {/* Entry head: word, pronunciation, part of speech, on one baseline the
          way a printed dictionary sets them. */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h1
          className="glitch animate-flicker text-[clamp(3.2rem,14vw,10rem)] font-bold leading-[0.82] tracking-tighter text-bone"
          data-text="loyalty"
        >
          loyalty
        </h1>
        <span className="text-sm text-ash">/ˈlɔɪ.əl.ti/</span>
        <span className="text-xs italic text-magenta">noun</span>
      </div>

      <div className="mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[1.5fr_1fr]">
        {/* ---- the senses ---- */}
        <div className="space-y-7">
          <div className="flex gap-4">
            <span className="mt-0.5 w-5 shrink-0 text-sm text-cyan">1.</span>
            <p className="text-[15px] leading-relaxed text-ash">
              the quality of staying faithful to someone or something; strong support that
              does not depend on convenience.
            </p>
          </div>

          <div className="flex gap-4">
            <span className="mt-0.5 w-5 shrink-0 text-sm text-cyan">2.</span>
            <div>
              <p className="text-[15px] leading-relaxed text-bone">
                <span className="text-ash">(finance)</span> a duration a holder agrees to be
                held to, priced in multiples of a share of income.
              </p>

              {/* The usage example. This is the client&apos;s sentence, in the one
                  place on a dictionary page where a sentence belongs. */}
              <blockquote className="mt-4 border-l border-magenta/60 pl-4">
                <p className="text-[15px] italic leading-relaxed text-bone/90">
                  &ldquo;Give me <span className="not-italic neon-cyan">1 Day</span> to earn your
                  loyalty. I&apos;ll ask again tomorrow, because loyalty is something you{" "}
                  <span className="not-italic neon-magenta">earn every day</span>.&rdquo;
                </p>
              </blockquote>
            </div>
          </div>

          <p className="pl-9 text-xs leading-relaxed text-ash/70">
            <span className="text-magenta">Origin:</span> Old French{" "}
            <em className="not-italic text-bone/60">loial</em>, from Latin{" "}
            <em className="not-italic text-bone/60">legalis</em> — &ldquo;of the law&rdquo;. It has
            always meant something you can be held to.
          </p>
        </div>

        {/* ---- the live headline ---- */}
        <aside className="lg:border-l lg:border-edge lg:pl-10">
          <p className="text-[10px] uppercase tracking-[0.25em] text-ash">{headline.label}</p>

          <p
            className={cn(
              "readout mt-3 text-4xl font-bold tracking-tighter tabular-nums",
              headline.value === null ? "text-xl italic text-ash/40" : "neon-cyan"
            )}
          >
            {headline.value ?? "unavailable"}
            {headline.value !== null && (
              <span className="ml-2 text-[11px] font-normal uppercase tracking-[0.18em] text-ash">
                {headline.unit}
              </span>
            )}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-ash/70">{headline.note}</p>

          {/* Graduation is the one thing moving today, so it gets a bar. Once
              the vault ships this is where staking share would go. */}
          {!vaultLive && (
            <div className="mt-6">
              <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.2em] text-ash">
                <span>to graduation</span>
                <span className={pct != null ? "text-magenta" : "text-ash/40"}>
                  {pct != null ? `${pct.toFixed(2)}%` : DASH}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full bg-edge">
                <div
                  className="h-full bg-gradient-to-r from-cyan to-magenta transition-all duration-1000"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-6 space-y-2 border-t border-edge pt-5 text-[11px]">
            <div className="flex justify-between gap-4">
              <span className="text-ash">Supply</span>
              <span className="readout text-bone/80">
                {snap?.token.totalSupply != null ? fmtCompact(snap.token.totalSupply) : DASH}{" "}
                <span className="text-ash">LOYAL</span>
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ash">Paid to stakers</span>
              <span className="readout text-bone/80">
                {staking?.cumulativeRewards != null ? (
                  <>
                    {fmtSig(staking.cumulativeRewards, 4)} <span className="text-ash">ETH</span>
                  </>
                ) : (
                  <span className="italic text-ash/40">not yet</span>
                )}
              </span>
            </div>
          </div>

          <p className="mt-7 border-t border-edge pt-6 text-sm leading-relaxed text-bone/90">
            Every trade pays{" "}
            <span className="neon-cyan">{(tax / 100).toFixed(tax % 100 === 0 ? 0 : 2)}%</span>{" "}
            into a shared reserve. Stake, and you take a cut of it. How big a cut is decided
            by how long you are willing to be held to it.
          </p>
        </aside>
      </div>
    </header>
  );
}
