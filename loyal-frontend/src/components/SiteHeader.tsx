"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Send, Wallet, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet";
import { shortAddr } from "@/lib/format";
import { SOCIALS } from "@/lib/chain";
import { cn } from "@/lib/utils";

/** X has no lucide glyph; this is the mark as a path. */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/**
 * The site header: identity, navigation, community, wallet.
 *
 * ## The wallet button says three different things
 *
 * Not connected, connected but on the wrong chain, and connected correctly are
 * three states with three different next actions, so they get three different
 * buttons. Collapsing the middle one — showing an address while every write
 * would revert — is the failure people actually hit, and it is silent.
 */
export function SiteHeader() {
  const path = usePathname();
  const w = useWallet();

  const nav = [
    { href: "/", label: "Definition" },
    { href: "/stake", label: "Stake" },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-void/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-4 px-5 py-3 sm:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-3">
          <Image src="/logo.webp" alt="" width={30} height={30} className="animate-drift" priority />
          <span className="text-sm font-bold tracking-[0.3em] text-bone">LOYAL</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] transition-colors",
                path === n.href ? "text-cyan" : "text-ash hover:text-bone"
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <a
            href={SOCIALS.telegram}
            target="_blank"
            rel="noreferrer"
            title="Telegram"
            className="p-2 text-ash transition-colors hover:text-cyan"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Telegram</span>
          </a>
          <a
            href={SOCIALS.x}
            target="_blank"
            rel="noreferrer"
            title="X"
            className="p-2 text-ash transition-colors hover:text-cyan"
          >
            <XIcon className="h-3.5 w-3.5" />
            <span className="sr-only">X</span>
          </a>

          {/* The three wallet states. */}
          {!w.account ? (
            <Button size="sm" variant="solid" onClick={w.connect} disabled={w.connecting}>
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              {w.connecting ? "Connecting…" : w.hasProvider ? "Connect" : "No wallet"}
            </Button>
          ) : !w.onCorrectChain ? (
            <Button size="sm" variant="magenta" onClick={w.switchChain}>
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Wrong network
            </Button>
          ) : (
            <span className="cut flex h-8 items-center gap-2 border border-cyan/40 bg-cyan/10 px-3 text-[11px] text-cyan">
              <span className="inline-block h-1.5 w-1.5 animate-flicker bg-cyan" />
              {shortAddr(w.account)}
            </span>
          )}
        </div>
      </div>

      {w.error && (
        <p className="mx-auto max-w-5xl px-5 pb-2 text-[11px] text-magenta sm:px-8">{w.error}</p>
      )}
    </header>
  );
}
