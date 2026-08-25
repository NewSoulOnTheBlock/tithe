"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { explorerAddr } from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * An address you can take with you.
 *
 * Two affordances, deliberately split: the text copies, the arrow opens the
 * explorer. Making the whole row do one or the other means somebody who wanted
 * the address ends up on a website, or somebody who wanted to look ends up with
 * a clipboard they did not ask for.
 *
 * The **full** address is what lands on the clipboard — the shortened form is a
 * display convenience and copying it would hand over something unusable, which
 * is a nasty way to waste somebody's afternoon.
 */
export function Copyable({
  label,
  address,
  className,
}: {
  label?: string;
  address: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  // Reset without leaving a timer behind if the row unmounts mid-flash.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard is blocked in insecure contexts and some embedded webviews.
      // Selecting the text is the fallback that always works.
      const el = document.getElementById(`addr-${address}`);
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  return (
    <span className={cn("inline-flex items-center gap-2 text-[11px]", className)}>
      {label && <span className="text-ash/70">{label}</span>}

      <button
        onClick={copy}
        title={`Copy ${address}`}
        className="group inline-flex items-center gap-1.5 text-bone/70 transition-colors hover:text-cyan"
      >
        {/* The short form is shown, the full one is copied — and is present in
            the DOM for the selection fallback above. */}
        <span id={`addr-${address}`} className="sr-only">
          {address}
        </span>
        <span aria-hidden="true">{shortAddr(address)}</span>
        {copied ? (
          <Check className="h-3 w-3 text-cyan" aria-hidden="true" />
        ) : (
          <Copy
            className="h-3 w-3 opacity-40 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
        <span className="sr-only">{copied ? "Copied" : "Copy address"}</span>
      </button>

      <a
        href={explorerAddr(address)}
        target="_blank"
        rel="noreferrer"
        title="Open on the explorer"
        className="text-ash/40 transition-colors hover:text-cyan"
      >
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Open {shortAddr(address)} on the explorer</span>
      </a>
    </span>
  );
}
