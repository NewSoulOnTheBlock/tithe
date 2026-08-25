/**
 * The masthead: the word, and what it means.
 *
 * Set as an actual dictionary entry — headword, pronunciation, part of speech,
 * numbered senses — because the joke only lands if the form is right. The
 * second sense is the one the protocol is about, and it is left to sit next to
 * the real definition without a nudge; captioning it would ruin it.
 */
export function Definition({ tax }: { tax: number }) {
  return (
    <header className="relative">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <h1
          className="glitch animate-flicker text-[clamp(3rem,13vw,9rem)] font-bold leading-[0.85] tracking-tighter text-bone"
          data-text="LOYALTY"
        >
          LOYALTY
        </h1>
        <span className="mb-3 text-sm text-ash">/ˈlɔɪ.əl.ti/</span>
      </div>

      <div className="mt-6 max-w-3xl border-l border-edge pl-5">
        <p className="text-xs uppercase tracking-[0.3em] text-magenta">noun</p>

        <ol className="mt-4 space-y-3 text-sm leading-relaxed text-ash">
          <li className="flex gap-3">
            <span className="w-4 shrink-0 text-cyan">1.</span>
            <span>
              the quality of staying faithful to someone or something{" "}
              <span className="text-bone/70">— strong support that does not depend on convenience.</span>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="w-4 shrink-0 text-cyan">2.</span>
            <span className="text-bone">
              <span className="text-ash">(finance, informal)</span> the thing this contract
              measures in days, and pays for in ETH.
            </span>
          </li>
        </ol>

        <p className="mt-5 text-xs leading-relaxed text-ash/70">
          <span className="text-magenta">Origin:</span> Old French{" "}
          <em className="not-italic text-bone/60">loial</em>, from Latin{" "}
          <em className="not-italic text-bone/60">legalis</em> — “of the law”. It has always
          meant something you can be held to.
        </p>
      </div>

      {/* The whole product in one line, so nobody has to scroll to find out
          what this is before they meet the offer. */}
      <p className="mt-8 max-w-2xl text-sm leading-relaxed text-bone/90">
        Every trade pays <span className="neon-cyan">{(tax / 100).toFixed(tax % 100 === 0 ? 0 : 2)}%</span>{" "}
        into a shared reserve. Stake, and you take a cut of it — the size of your cut is
        decided by how long you are willing to be held to it.
      </p>
    </header>
  );
}
