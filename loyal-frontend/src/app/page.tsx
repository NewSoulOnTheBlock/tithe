"use client";

import Image from "next/image";
import { useState } from "react";
import { Definition } from "@/components/Definition";
import { Live } from "@/components/Live";
import { Stake } from "@/components/Stake";
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
  // The staking form turns itself on when the vault appears on chain. Held
  // here rather than in `Stake` so one read serves both panels.
  const [vaultLive, setVaultLive] = useState(false);

  /**
   * The tax rate, lifted from the same read the panel below uses.
   *
   * It was hardcoded at first, and wrongly: the prose said 4% while the live
   * readout on the same screen said 2%. Two numbers for one fact, both visible
   * at once. Reading it once and passing it down means the page can only be
   * wrong in one place, and only when the chain is unreachable.
   */
  const [taxBps, setTaxBps] = useState<number | null>(null);
  const tax = taxBps ?? LOYAL_TAX_BPS_FALLBACK;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-28 pt-8 sm:px-8">
      <nav className="mb-12 flex items-center justify-between">
        <a href="#top" className="flex items-center gap-3">
          <Image src="/logo.webp" alt="" width={32} height={32} className="animate-drift" priority />
          <span className="text-sm font-bold tracking-[0.3em] text-bone">LOYAL</span>
        </a>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <a href="#live">On chain</a>
          </Button>
          <Button asChild size="sm" variant="solid">
            <a href="#stake">Stake</a>
          </Button>
        </div>
      </nav>

      <div id="top" className="space-y-20">
        <Definition tax={tax} />

        {/* The offer, immediately. Everything else on this page is evidence for
            it, and evidence goes after the claim. */}
        <Stake live={vaultLive} tax={tax} />

        <Live onLive={setVaultLive} onTax={setTaxBps} />

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
