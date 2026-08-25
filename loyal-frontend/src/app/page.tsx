"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useChain } from "@/lib/useChain";
import { Definition } from "@/components/Definition";
import { Live } from "@/components/Live";
import { Button } from "@/components/ui/button";
import { LOYAL, EXPLORER, LOYAL_TAX_BPS_FALLBACK, explorerAddr } from "@/lib/chain";
import { bpsToPct } from "@/lib/format";

/**
 * ## Order of the page
 *
 * The offer comes second, right under the word. An earlier cut put four panels
 * of explanation between the headline and the thing you can actually do, which
 * is a brochure — you had to scroll past the mechanism, the risks and the live
 * numbers before reaching a button. Now: what the word means, what you get,
 * then the proof, then the small print.
 *
 * The explanation did not get deleted, it got compressed. Two cards of prose
 * became six lines, because the detail belongs to the reader who has already
 * decided to care and was in the way of the one who has not.
 */
export default function Page() {
  /**
   * One read, shared by every section.
   *
   * Two pollers meant two sources for the same figure, briefly disagreeing
   * after each refresh — and the tax rate was hardcoded on top of that, so the
   * prose said 4% while the live readout on the same screen said 2%. Reading
   * once and passing down means the page can only be wrong in one place, and
   * only when the chain is unreachable.
   */
  const { snap, error } = useChain();

  const tax = snap?.curve.taxBps != null ? Number(snap.curve.taxBps) : LOYAL_TAX_BPS_FALLBACK;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-28 pt-12 sm:px-8">
      <div id="top" className="space-y-20">
        <Definition tax={tax} snap={snap} />

        {/*
          The route to the offer.

          Staking moved to its own page, which left the home page making a case
          and giving nobody anywhere to take it. This is that door, and it says
          the terms on it — a reader should know what they are walking into
          before they click, not after.
        */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <Button asChild size="lg" variant="solid">
            <Link href="/stake">
              Stake LOYAL
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <p className="text-[11px] uppercase tracking-[0.18em] text-ash">
            <span className="text-bone">0.5×</span> no lock ·{" "}
            <span className="text-bone">1×</span> a day ·{" "}
            <span className="neon-magenta">3×</span> a week
          </p>
        </div>

        <Live snap={snap} error={error} />

        {/* ---- the small print, as lines rather than paragraphs ---- */}
        <section>
          <h2 className="text-xs uppercase tracking-[0.22em] text-ash">Before you do</h2>
          <dl className="mt-5 divide-y divide-edge border-y border-edge">
            {[
              [
                "The floor is not guaranteed",
                "The operator can withdraw reserve ETH to deploy it. The figure shows what backs each token right now, not a level the contract can hold. Every withdrawal is logged.",
              ],
              [
                "A round trip costs you twice",
                `${bpsToPct(tax)} in and ${bpsToPct(tax)} out — ${bpsToPct(tax * 2)} before the price moves at all.`,
              ],
              [
                "Locked means locked",
                "While a lock stands you cannot withdraw or transfer. That is what the multiplier is paying for.",
              ],
              [
                "Rewards are ETH, not more LOYAL",
                "So staking does not dilute you, and the share price never moves — one stLOYAL is one LOYAL, always.",
              ],
              [
                "Burning is a one-way door",
                "Redeeming destroys your LOYAL at the moment you ask, not when you collect. There is no cancel and no re-mint.",
              ],
              [
                "Not a bank, a fund, or advice",
                "It is a tax, a pot, and a queue — all three readable from the chain.",
              ],
            ].map(([k, v]) => (
              <div key={k} className="grid gap-1 py-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6">
                <dt className="text-sm text-bone">{k}</dt>
                <dd className="text-xs leading-relaxed text-ash">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="pt-2">
          <p className="max-w-2xl text-sm leading-relaxed text-ash">
            Loyalty here is not a feeling. It is a number of days you were willing to be held
            to, and it is priced accordingly — <span className="neon-cyan">0.5×</span> if you
            keep the door open, <span className="text-bone">1×</span> for a day,{" "}
            <span className="neon-magenta">3×</span> for a week.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3 text-[11px] text-ash/70">
            <span>chain 4663 · robinhood</span>
            <a
              className="transition-colors hover:text-cyan"
              href={explorerAddr(LOYAL.token)}
              target="_blank"
              rel="noreferrer"
            >
              contract
            </a>
            <a
              className="transition-colors hover:text-cyan"
              href={EXPLORER}
              target="_blank"
              rel="noreferrer"
            >
              explorer
            </a>
            <span className="text-ash/40">verified on-chain, or it does not appear here</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
