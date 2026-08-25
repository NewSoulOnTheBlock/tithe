"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TIERS, type TierKey, LOYAL, isLive } from "@/lib/chain";
import { cn } from "@/lib/utils";

/**
 * The commitment axis.
 *
 * ## Why this is not three cards
 *
 * Three equal cards is the default shape for "pick one of three", and it throws
 * away the only interesting thing about this particular three: they are not
 * peers. They sit on an axis — **time** — and the reward rises along it. Cards
 * of equal size say the options are equivalent. They are not: one is six times
 * another.
 *
 * So the multiplier is drawn as height and the lock as horizontal position.
 * The bar for 3× is six times the bar for 0.5× because it is six times the
 * payout, and it sits at the far end because it costs seven days. The picture
 * *is* the offer, and a reader who never reads a word of copy still leaves
 * knowing the trade.
 *
 * ## Stability as a visual, not an ornament
 *
 * The glitch on this page is otherwise decoration. Here it earns its place: the
 * unlocked bar flickers, the day bar is steady, the week bar is solid and lit.
 * Commitment reads as *stability* — which is the argument the product is
 * actually making, made without a sentence.
 */

/** Bar heights, normalised so 0.5x is the unit. Height IS the multiplier. */
const HEIGHT: Record<TierKey, string> = {
  NONE: "16%",
  DAY: "32%",
  WEEK: "96%",
};

export function Stake({ live, tax }: { live: boolean; tax: number }) {
  const [selected, setSelected] = useState<TierKey>("DAY");
  const [amount, setAmount] = useState("");

  const tier = TIERS.find((t) => t.key === selected)!;

  return (
    <section id="stake" className="scroll-mt-24">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-xs uppercase tracking-[0.25em] text-ash">
          How long will you stay
        </h2>
        <span className="text-[10px] uppercase tracking-[0.2em] text-ash/60">
          pick one ↓ · share = balance × multiplier
        </span>
      </div>

      {/* ---- the axis ---- */}
      <div className="relative">
        <div className="grid h-[210px] grid-cols-3 items-end gap-3 sm:h-[240px]">
          {TIERS.map((t) => {
            const on = t.key === selected;
            return (
              <button
                key={t.key}
                onClick={() => setSelected(t.key)}
                aria-pressed={on}
                className="group relative flex h-full flex-col justify-end text-left"
              >
                {/* Multiplier, sitting on top of its own bar. */}
                <div
                  className="relative flex flex-col justify-end transition-all duration-500"
                  style={{ height: HEIGHT[t.key] }}
                >
                  <span
                    className={cn(
                      "readout absolute -top-8 left-0 text-3xl font-bold tracking-tighter transition-colors sm:text-4xl",
                      on ? "neon-cyan" : "text-bone/70 group-hover:text-bone"
                    )}
                  >
                    {t.multiplier}
                  </span>

                  {/* Unselected bars still have to be legible — the first cut
                      faded them to nothing, which made the 3x offer the least
                      visible thing on the page. Every bar keeps an outline and
                      a floor of fill; selection adds light, it does not grant
                      existence. */}
                  <div
                    className={cn(
                      "h-full w-full border-t-2 transition-all duration-500",
                      // Less commitment, less stable — the flicker is the point.
                      t.key === "NONE" && "animate-flicker",
                      on
                        ? "border-cyan bg-gradient-to-t from-cyan/35 to-cyan/[0.06] shadow-[0_0_60px_-12px_rgba(0,229,255,0.9)]"
                        : "border-ash/40 bg-gradient-to-t from-ash/[0.14] to-transparent group-hover:border-ash/70 group-hover:from-ash/25"
                    )}
                    style={{
                      // A cut top-left corner, so the bars read as machined
                      // rather than as a chart library's rectangles.
                      clipPath: "polygon(10px 0, 100% 0, 100% 100%, 0 100%, 0 10px)",
                    }}
                  />
                </div>


              </button>
            );
          })}
        </div>

        {/* The axis line itself, running under all three. */}
        <div className="h-px w-full bg-gradient-to-r from-ash/20 via-ash/40 to-ash/20" />

        {/* Axis labels — time, increasing left to right. */}
        <div className="grid grid-cols-3 gap-3 pt-3">
          {TIERS.map((t) => {
            const on = t.key === selected;
            return (
              <button
                key={t.key}
                onClick={() => setSelected(t.key)}
                className="text-left"
                tabIndex={-1}
                aria-hidden="true"
              >
                {/* A selected tier says so in words as well as in light — a
                    glow alone is ambiguous when three bars glow slightly
                    differently. It lives on the axis label, where there is room;
                    over the multiplier it collided with the number itself. */}
                <p
                  className={cn(
                    "flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] transition-colors",
                    on ? "text-cyan" : "text-ash"
                  )}
                >
                  {t.label}
                  {on && <span className="text-[9px] tracking-[0.2em]">▸ selected</span>}
                </p>
                <p className="mt-1 text-[10px] text-ash/50">{t.lockLabel}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/*
        ---- the consequence of the choice ----

        The first cut left the selection and the form as two unrelated blocks,
        so nothing told a reader that clicking a bar had changed anything below
        it. Three things now do: the panel is keyed on the tier so it animates
        in on every change, it restates the choice in its own header, and the
        button says which commitment it is about to make.
      */}
      <div
        key={tier.key}
        className="mt-10 animate-in fade-in slide-in-from-bottom-2 duration-500"
      >
        <div className="cut border border-cyan/25 bg-cyan/[0.04] p-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-ash">
              You chose
            </span>
            <span className="text-sm font-bold uppercase tracking-[0.14em] text-cyan">
              {tier.label}
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-ash/60">
              · {tier.multiplier} share · {tier.lockLabel}
            </span>
          </div>

          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-bone/90">
            {tier.line}
          </p>

      {/* ---- the form ---- */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!live}
            aria-label="Amount of LOYAL to stake"
            className="cut h-14 w-full border border-edge bg-void px-5 pr-24 text-xl text-bone outline-none transition-colors placeholder:text-ash/30 focus:border-cyan/60 disabled:opacity-40"
          />
          <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-[11px] uppercase tracking-[0.2em] text-ash">
            LOYAL
          </span>
        </div>
        <Button size="lg" variant="solid" disabled={!live} className="h-14 sm:w-56">
          Commit {tier.label}
        </Button>
      </div>

          {!live && (
            <p className="mt-4 max-w-3xl text-xs leading-relaxed text-ash">
              <span className="text-magenta">Not deployed yet.</span> The vault is written and
              tested — 68 tests, including seven run against the real LOYAL token on a fork of
              chain 4663. It is not on chain, so there is nothing to sign. This form is wired
              against the real ABI and turns on the moment it lands.
            </p>
          )}
        </div>
      </div>

      {/* ---- the two things that surprise people ---- */}
      <div className="mt-12 grid gap-x-12 gap-y-6 border-t border-edge pt-8 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-cyan">
            The multiplier divides — it does not mint
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ash">
            Income is split by weight, not by share count. A vault where everyone is unlocked
            still pays out every wei; the multipliers only decide who gets which part. Your
            share price never moves either — one stLOYAL is one LOYAL, always, because rewards
            are ETH and live outside the vault&apos;s assets.
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-magenta">
            When a lock runs out
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ash">
            You drop to 0.5× — the multiplier was only true while the promise was standing.
            Nothing runs at the moment a lock expires, so <span className="text-bone">anyone</span>{" "}
            can call <code className="text-cyan">kick()</code> to demote a stale one, and every
            other staker is paid to: removing it raises their own share. What you already
            earned at 3× stays yours.
          </p>
        </div>
      </div>

      {isLive(LOYAL.stakedLoyal) && (
        <p className="mt-6 text-[10px] text-ash/50">vault · {LOYAL.stakedLoyal}</p>
      )}
    </section>
  );
}
