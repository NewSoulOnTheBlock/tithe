"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TIERS, type TierKey, LOYAL, isLive } from "@/lib/chain";
import { cn } from "@/lib/utils";

/**
 * The staking panel, and the sentence the whole product is built around.
 *
 * ## Why the tiers are cards and not a dropdown
 *
 * The choice being made is not a setting, it is a commitment of a specific
 * length for a specific multiple. Three cards side by side make the trade
 * legible at a glance — half, full, triple — where a select box would hide two
 * thirds of the offer behind a click.
 *
 * ## The line under it
 *
 * That sentence is the product. It is placed directly beneath the tiers,
 * unattributed and unexplained, because it is the argument for the middle
 * option: a day is short enough to say yes to and long enough to mean
 * something, and it is asked again tomorrow.
 */
export function Stake({ live, tax }: { live: boolean; tax: number }) {
  const [selected, setSelected] = useState<TierKey>("DAY");
  const [amount, setAmount] = useState("");

  const tier = TIERS.find((t) => t.key === selected)!;

  return (
    <section id="stake" className="scroll-mt-24">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-bone">Prove it</h2>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-ash">
            choose how long you will stay
          </p>
        </div>
        <span className="hidden text-[10px] uppercase tracking-[0.2em] text-ash sm:block">
          weight = balance × multiplier
        </span>
      </div>

      {/* ---- the three commitments ---- */}
      <div className="grid gap-4 md:grid-cols-3">
        {TIERS.map((t) => {
          const on = t.key === selected;
          return (
            <button
              key={t.key}
              onClick={() => setSelected(t.key)}
              aria-pressed={on}
              className={cn(
                "cut panel group relative p-5 text-left transition-all",
                on
                  ? "border-cyan/60 shadow-[0_0_40px_-16px_rgba(0,229,255,0.9)]"
                  : "hover:border-ash/40"
              )}
            >
              {/* The multiplier is the headline — it is what the reader is
                  actually choosing between. */}
              <div className="flex items-baseline justify-between">
                <span
                  className={cn(
                    "readout text-4xl font-bold tracking-tighter",
                    on ? "neon-cyan" : "text-bone/80"
                  )}
                >
                  {t.multiplier}
                </span>
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-[0.18em]",
                    on ? "text-cyan" : "text-ash"
                  )}
                >
                  {t.label}
                </span>
              </div>

              <div className="mt-4 h-px w-full bg-edge" />

              <p className="mt-4 text-xs leading-relaxed text-ash">{t.line}</p>

              <p className="mt-4 text-[10px] uppercase tracking-[0.18em] text-ash/60">
                lock · {t.lockLabel}
              </p>
            </button>
          );
        })}
      </div>

      {/* ---- THE LINE ---- */}
      <blockquote className="relative mt-8 border-l-2 border-magenta pl-6">
        <p className="text-base leading-relaxed text-bone sm:text-lg">
          “Give me <span className="neon-cyan">1 Day</span> to Earn your loyalty, I&apos;ll ask
          again tomorrow because loyalty is something you{" "}
          <span className="neon-magenta">earn every day</span>.”
        </p>
      </blockquote>

      {/* ---- the form ---- */}
      <Card className="mt-8" lit={false}>
        <CardHeader>
          <CardTitle>Stake LOYAL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!live}
                className="cut h-12 w-full border border-edge bg-void px-4 pr-20 text-lg text-bone outline-none transition-colors placeholder:text-ash/40 focus:border-cyan/60 disabled:opacity-40"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.18em] text-ash">
                LOYAL
              </span>
            </div>
            <Button size="lg" variant="solid" disabled={!live}>
              Lock {tier.label}
            </Button>
          </div>

          {!live && (
            <p className="mt-4 text-xs leading-relaxed text-ash">
              <span className="text-magenta">Not deployed yet.</span> The staking vault is
              written and tested — 61 tests covering the tiers, the lock, reentrancy on the
              payout and the reward accounting — but it is not on chain, so there is nothing
              to sign. This form is wired against the real ABI and turns on the moment it
              lands.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- how the multiplier actually works ---- */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card lit="magenta">
          <CardHeader>
            <CardTitle>The multiplier divides, it does not mint</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs leading-relaxed text-ash">
              Income is split by <span className="text-bone">weight</span>, not by share count.
              A vault where every staker is unlocked still pays out every wei — the tiers only
              decide who gets which part of it. Your share price never moves either: one
              stLOYAL is one LOYAL, always, because rewards are ETH and live outside the
              vault&apos;s assets.
            </p>
          </CardContent>
        </Card>

        <Card lit="magenta">
          <CardHeader>
            <CardTitle>When a lock runs out</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs leading-relaxed text-ash">
              You drop to <span className="text-bone">0.5×</span> — the multiplier was only
              ever true while the promise was standing. Nothing runs at the moment a lock
              expires, so <span className="text-bone">anyone</span> can call{" "}
              <code className="text-cyan">kick()</code> to demote a stale one, and every other
              staker is paid to: removing it raises their own share. Rewards you already
              earned at 3× stay yours.
            </p>
          </CardContent>
        </Card>
      </div>

      {isLive(LOYAL.stakedLoyal) && (
        <p className="mt-4 text-[10px] text-ash/60">vault · {LOYAL.stakedLoyal}</p>
      )}
    </section>
  );
}
