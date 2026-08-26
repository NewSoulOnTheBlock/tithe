"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { Stake } from "@/components/Stake";
import { Live } from "@/components/Live";
import { useChain } from "@/lib/useChain";
import { LOYAL_TAX_BPS_FALLBACK } from "@/lib/chain";
import { bpsToPct } from "@/lib/format";

/**
 * Staking, on its own route.
 *
 * It shared the home page until the page had four jobs — define the word, make
 * the offer, prove the numbers, list the risks — and the offer was the one
 * being scrolled past. A commitment with a lock on it deserves a screen where
 * it is the only thing being asked.
 *
 * The chain readout comes with it, because the numbers that matter *while
 * deciding* are here, not one navigation away.
 */
export default function StakePage() {
  const { snap, error } = useChain();

  const vaultLive = !!snap?.staking.deployed;
  const tax = snap?.curve.taxBps != null ? Number(snap.curve.taxBps) : LOYAL_TAX_BPS_FALLBACK;

  return (
    <div className="relative z-10">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl px-5 pb-28 pt-10 sm:px-8">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-ash transition-colors hover:text-cyan"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden="true" />
        the definition
      </Link>

      <h1 className="mt-8 text-[clamp(2.2rem,7vw,4rem)] font-bold leading-[0.9] tracking-tighter text-bone">
        Earn it.
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ash">
        Every trade pays{" "}
        <span className="neon-cyan">{bpsToPct(tax)}</span> into a shared reserve. Staking takes
        you a cut of it. The only question is how long you are willing to be held to.
      </p>

      <div className="mt-16 space-y-20">
        <Stake live={vaultLive} tax={tax} />
        <Live snap={snap} error={error} />
      </div>
      </main>
    </div>
  );
}
