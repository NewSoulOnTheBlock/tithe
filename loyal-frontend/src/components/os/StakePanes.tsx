"use client";

import { useState } from "react";
import { parseUnits, formatUnits } from "ethers";
import { LOYAL, TIERS, tierByIndex, type TierKey, isLive, explorerTx } from "@/lib/chain";
import { ST_LOYAL_DECIMALS } from "@/lib/chain";
import { VAULT_ABI, ERC20_ABI, type Position } from "@/lib/account";
import { writable, type TxRunner } from "@/lib/tx";
import { fmtGrouped, fmtSig, fmtDuration, fmtDateTime, DASH } from "@/lib/format";
import { useNow } from "@/lib/clock";
import type { Wallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

/**
 * The two panes that touch the wallet.
 *
 * ## Why staking and position are separate windows
 *
 * They are different activities with different questions. Staking asks *how
 * long will you commit*; the position asks *what do I have and what do I get*.
 * Putting them in one panel means the person who came back to claim has to
 * scroll past the offer they already accepted, and the person deciding has a
 * balance sheet in the way.
 *
 * In a stack that would be a compromise. In a windowed shell it is free: open
 * both, or one, and put them where you like.
 */

/* ==========================================================================
   Shared: amount entry with a real balance and fractions of it
   ========================================================================== */

/**
 * Typing an exact token balance by hand is a mistake generator — people
 * transpose digits, miss a zero, and leave dust behind because they rounded.
 * The fractions remove the arithmetic; MAX removes it exactly, using the raw
 * integer rather than a formatted string parsed back, so "all of it" really is
 * all of it down to the last wei.
 */
function AmountField({
  value,
  onChange,
  max,
  decimals,
  unit,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Raw on-chain maximum. `null` while unread — never treated as zero. */
  max: bigint | null;
  decimals: number;
  unit: string;
  label: string;
  disabled?: boolean;
}) {
  const set = (pct: number) => {
    if (max === null) return;
    // MAX takes the exact integer. The fractions divide before formatting, so
    // the rounding happens once, in the direction of "less than you have".
    const raw = pct === 100 ? max : (max * BigInt(pct)) / 100n;
    onChange(formatUnits(raw, decimals));
  };

  const has = max !== null;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[9px] uppercase tracking-[0.2em] text-ash">{label}</span>
        <button
          type="button"
          onClick={() => set(100)}
          disabled={!has || disabled}
          title={has ? "Use all of it" : undefined}
          className={cn(
            "readout text-[11px] transition-colors",
            has ? "text-bone/80 hover:text-cyan" : "italic text-ash/40"
          )}
        >
          {has ? `${fmtGrouped(max, 2, decimals)} ${unit}` : "unavailable"}
        </button>
      </div>

      <div className="relative">
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={label}
          className="cut h-12 w-full border border-edge bg-void px-4 pr-20 text-lg text-bone outline-none transition-colors placeholder:text-ash/30 focus:border-cyan/60 disabled:opacity-40"
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.18em] text-ash">
          {unit}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {[25, 50, 75, 100].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => set(p)}
            disabled={!has || disabled}
            className="border border-edge py-1.5 text-[10px] uppercase tracking-[0.14em] text-ash transition-colors hover:border-cyan/50 hover:text-cyan disabled:cursor-not-allowed disabled:opacity-30"
          >
            {p === 100 ? "max" : `${p}%`}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Parse user input to a raw integer. Returns null on anything unusable. */
function toRaw(v: string, decimals: number): bigint | null {
  const t = v.trim();
  if (!t) return null;
  try {
    const raw = parseUnits(t, decimals);
    return raw > 0n ? raw : null;
  } catch {
    return null;
  }
}

/** Transaction feedback: one line, never a modal. */
function TxLine({ tx }: { tx: TxRunner }) {
  if (tx.error) return <p className="mt-3 text-[11px] leading-relaxed text-magenta">{tx.error}</p>;
  if (tx.busy)
    return (
      <p className="mt-3 flex items-center gap-2 text-[11px] text-cyan">
        <span className="inline-block h-1.5 w-1.5 animate-flicker bg-cyan" />
        {tx.busy}…
        {tx.hash && (
          <a className="underline decoration-dotted" href={explorerTx(tx.hash)} target="_blank" rel="noreferrer">
            view
          </a>
        )}
      </p>
    );
  if (tx.done)
    return (
      <p className="mt-3 flex items-center gap-2 text-[11px] text-cyan">
        {tx.done} confirmed
        {tx.hash && (
          <a className="underline decoration-dotted" href={explorerTx(tx.hash)} target="_blank" rel="noreferrer">
            view
          </a>
        )}
      </p>
    );
  return null;
}

/* ==========================================================================
   0x02 — COMMIT.EXE
   ========================================================================== */

const HEIGHT: Record<TierKey, string> = { NONE: "16%", DAY: "32%", WEEK: "96%" };

export function CommitPane({
  wallet,
  pos,
  tx,
}: {
  wallet: Wallet;
  pos: Position;
  tx: TxRunner;
}) {
  const [selected, setSelected] = useState<TierKey>("DAY");
  const [amount, setAmount] = useState("");
  const tier = TIERS.find((t) => t.key === selected)!;
  const now = useNow(30_000);

  /**
   * The date this commitment would run to, shown before signing rather than
   * after. "1 week" is an abstraction people routinely underestimate; a date is
   * something you can check against a calendar, and this is the one screen
   * where changing your mind is still free.
   *
   * Labelled "about" because the contract stamps `block.timestamp` at
   * execution, not now.
   */
  const wouldLockUntil = tier.lockSeconds > 0 && now > 0 ? now + tier.lockSeconds : 0;

  const live = isLive(LOYAL.stakedLoyal);
  const raw = toRaw(amount, 18);
  const overBalance = raw !== null && pos.balance !== null && raw > pos.balance;
  const needsApproval = raw !== null && pos.allowance !== null && pos.allowance < raw;
  const currentTier = pos.tier;

  /**
   * Approve → deposit → lock, as one intent.
   *
   * Three signatures, because that is genuinely what the chain requires: an
   * ERC-20 cannot be pulled without an allowance, and `lock` is a separate
   * function from `deposit` so an existing staker can change tier without
   * moving tokens. Hiding that behind one button and letting the wallet pop
   * three times unannounced is worse than naming the step in flight, which is
   * what `tx.busy` renders.
   *
   * The lock step is skipped when the tier is already right — re-locking at the
   * same tier would extend the commitment, which nobody asked for.
   */
  const submit = async () => {
    if (raw === null) return;

    if (needsApproval) {
      const ok = await tx.run("approving LOYAL", async (s) =>
        writable(LOYAL.token, ERC20_ABI, s).approve(LOYAL.stakedLoyal, raw)
      );
      if (!ok) return;
    }

    const staked = await tx.run("staking", async (s) =>
      writable(LOYAL.stakedLoyal, VAULT_ABI, s).deposit(raw, await s.getAddress())
    );
    if (!staked) return;

    if (currentTier !== tier.index) {
      await tx.run(`committing ${tier.label}`, async (s) =>
        writable(LOYAL.stakedLoyal, VAULT_ABI, s).lock(tier.index)
      );
    }
    setAmount("");
  };

  // The button says the next real step, not a generic verb.
  const cta = !wallet.account
    ? { label: "Connect wallet", act: wallet.connect }
    : !wallet.onCorrectChain
      ? { label: "Switch network", act: wallet.switchChain }
      : raw === null
        ? { label: "Enter an amount", act: undefined }
        : overBalance
          ? { label: "More than you hold", act: undefined }
          : needsApproval
            ? { label: `Approve, then stake`, act: submit }
            : { label: `Stake · commit ${tier.label}`, act: submit };

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <p className="text-[10px] uppercase tracking-[0.25em] text-ash">How long will you stay</p>
        <p className="text-[9px] uppercase tracking-[0.2em] text-ash/50">share = balance × multiplier</p>
      </div>

      {/*
        Bar height IS the multiplier — 3x is six times 0.5x — and horizontal
        position is the lock. Three equal cards would say the options are peers;
        they are not. The unlocked bar flickers and the week bar is solid, so
        commitment reads as stability without a sentence.
      */}
      <div className="grid h-[180px] grid-cols-3 items-end gap-3">
        {TIERS.map((t) => {
          const on = t.key === selected;
          return (
            <button
              key={t.key}
              onClick={() => setSelected(t.key)}
              aria-pressed={on}
              className="group relative flex h-full flex-col justify-end text-left"
            >
              <div className="relative flex flex-col justify-end transition-all duration-500" style={{ height: HEIGHT[t.key] }}>
                <span
                  className={cn(
                    "readout absolute -top-7 left-0 text-[26px] font-bold tracking-tighter transition-colors",
                    on ? "neon-cyan" : "text-bone/70 group-hover:text-bone"
                  )}
                >
                  {t.multiplier}
                </span>
                <div
                  className={cn(
                    "h-full w-full border-t-2 transition-all duration-500",
                    t.key === "NONE" && "animate-flicker",
                    on
                      ? "border-cyan bg-gradient-to-t from-cyan/35 to-cyan/[0.06] shadow-[0_0_50px_-12px_rgba(0,229,255,0.9)]"
                      : "border-ash/40 bg-gradient-to-t from-ash/[0.14] to-transparent group-hover:border-ash/70 group-hover:from-ash/25"
                  )}
                  style={{ clipPath: "polygon(9px 0, 100% 0, 100% 100%, 0 100%, 0 9px)" }}
                />
              </div>
            </button>
          );
        })}
      </div>

      <div className="h-px w-full bg-gradient-to-r from-ash/20 via-ash/40 to-ash/20" />

      <div className="grid grid-cols-3 gap-3 pt-3">
        {TIERS.map((t) => {
          const on = t.key === selected;
          const held = currentTier === t.index;
          return (
            <button key={t.key} onClick={() => setSelected(t.key)} className="text-left" tabIndex={-1} aria-hidden="true">
              <p className={cn("flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] transition-colors", on ? "text-cyan" : "text-ash")}>
                {t.label}
                {on && <span className="text-[8px] tracking-[0.2em]">▸ sel</span>}
              </p>
              <p className="mt-0.5 text-[9px] text-ash/50">
                {held ? <span className="text-bone/70">your tier</span> : t.lockLabel}
              </p>
            </button>
          );
        })}
      </div>

      {/* Keyed on the tier so the panel remounts on every change — without it
          nothing told a reader that clicking a bar had done anything. */}
      <div key={tier.key} className="mt-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div className="cut border border-cyan/25 bg-cyan/[0.04] p-5">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[9px] uppercase tracking-[0.22em] text-ash">You chose</span>
            <span className="text-[13px] font-bold uppercase tracking-[0.14em] text-cyan">{tier.label}</span>
            <span className="text-[9px] uppercase tracking-[0.18em] text-ash/60">
              · {tier.multiplier} share · {tier.lockLabel}
            </span>
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-bone/90">{tier.line}</p>

          {/* What you are actually agreeing to, as a date. */}
          <div className="mt-4 flex items-baseline justify-between gap-3 border-y border-cyan/15 py-2.5">
            <span className="text-[9px] uppercase tracking-[0.2em] text-ash">
              {tier.lockSeconds > 0 ? "Locked until about" : "Lock"}
            </span>
            <span className={cn("readout text-[11.5px]", tier.lockSeconds > 0 ? "text-bone" : "text-cyan")}>
              {tier.lockSeconds > 0 ? fmtDateTime(wouldLockUntil) : "none — leave whenever"}
            </span>
          </div>

          <div className="mt-5">
            <AmountField
              value={amount}
              onChange={setAmount}
              max={wallet.account ? pos.balance : null}
              decimals={18}
              unit="LOYAL"
              label="In your wallet"
              disabled={!live || !wallet.account}
            />
          </div>

          <button
            onClick={cta.act}
            disabled={!live || !cta.act || tx.busy !== null}
            className="cut mt-4 h-12 w-full bg-cyan text-[11px] font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {tx.busy ?? cta.label}
          </button>

          <TxLine tx={tx} />

          {currentTier !== null && currentTier !== tier.index && pos.shares !== null && pos.shares > 0n && (
            <p className="mt-3 text-[11px] leading-relaxed text-ash">
              You are currently on{" "}
              <span className="text-bone">{tierByIndex(currentTier).label}</span>. Staking here also
              moves you to {tier.label} — a lock can be extended or upgraded at any time, but never
              shortened while it stands.
            </p>
          )}
        </div>
      </div>

      <div className="mt-7 space-y-5 border-t border-edge pt-6">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan">
            The multiplier divides — it does not mint
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ash">
            Income is split by weight, not by share count. A vault where everyone is unlocked
            still pays out every wei; the multipliers only decide who gets which part. Your share
            price never moves either — one stLOYAL is one LOYAL, always.
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-magenta">
            Rewards are pull, not push
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ash">
            Nothing lands in your wallet on its own. ETH accrues to you inside the vault and sits
            there until you call <code className="text-cyan">claim()</code> — which is what the
            position window is for. It cannot expire and nobody else can take it.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   0x06 — POSITION
   ========================================================================== */
export function PositionPane({
  wallet,
  pos,
  tx,
}: {
  wallet: Wallet;
  pos: Position;
  tx: TxRunner;
}) {
  const [amount, setAmount] = useState("");
  // Ticks every second so the countdown moves; 0 until mounted so the server
  // and the first client render agree.
  const now = useNow(1_000);

  if (!wallet.account) {
    return (
      <div className="py-6 text-center">
        <p className="text-[12px] text-ash">Connect a wallet to read your position.</p>
        <button
          onClick={wallet.connect}
          className="cut mt-4 h-10 bg-cyan px-6 text-[10px] font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90"
        >
          connect
        </button>
      </div>
    );
  }

  const staked = pos.staked;
  const hasStake = staked !== null && staked > 0n;
  const locked = pos.lockedUntil !== null && pos.lockedUntil > now;
  const remaining = pos.lockedUntil !== null ? Math.max(0, pos.lockedUntil - now) : 0;
  const tier = pos.tier !== null ? tierByIndex(pos.tier) : null;

  /** Expired but not yet demoted — still weighted at the old multiplier. */
  const stale = pos.tier !== null && pos.effective !== null && pos.tier !== pos.effective;

  const shareRaw = toRaw(amount, ST_LOYAL_DECIMALS);
  const canUnstake = !locked && shareRaw !== null && pos.shares !== null && shareRaw <= pos.shares;

  /**
   * Re-commit without depositing.
   *
   * `lock` is a separate function from `deposit` precisely so an existing
   * staker can change tier without moving tokens — but the staking pane only
   * called it after a deposit, which meant a holder whose week had run out
   * could not commit again without buying more. That is the exact moment the
   * product is asking them to decide, so the decision belongs here.
   *
   * The contract's own rule: a standing lock may be extended or upgraded, never
   * shortened. Once it has expired, every tier is open again — including NONE,
   * which drops to 0.5x immediately and frees the tokens for good.
   */
  const relock = (index: number) =>
    tx.run("committing", async (s) => writable(LOYAL.stakedLoyal, VAULT_ABI, s).lock(index));

  const claim = () =>
    tx.run("claiming", async (s) => writable(LOYAL.stakedLoyal, VAULT_ABI, s).claim());

  const unstake = async () => {
    if (shareRaw === null) return;
    const ok = await tx.run("unstaking", async (s) =>
      writable(LOYAL.stakedLoyal, VAULT_ABI, s).redeem(shareRaw, await s.getAddress(), await s.getAddress())
    );
    if (ok) setAmount("");
  };

  return (
    <div>
      {/* ---- what you hold ---- */}
      <div className="grid grid-cols-2 gap-px border border-edge bg-edge">
        <Cell
          label="Staked"
          value={staked !== null ? fmtGrouped(staked, 2, 18) : null}
          unit="LOYAL"
        />
        <Cell
          label="Your multiplier"
          value={tier ? tier.multiplier : null}
          note={stale ? "lock expired — see below" : tier?.label}
          accent="cyan"
        />
      </div>

      {/* ---- the lock ---- */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[9px] uppercase tracking-[0.2em] text-ash">
            {locked ? "Locked until" : "Lock"}
          </span>
          <span className={cn("readout text-[11px]", locked ? "text-magenta" : "text-cyan")}>
            {pos.lockedUntil === null
              ? DASH
              : locked
                ? fmtDateTime(pos.lockedUntil)
                : "open — you can leave"}
          </span>
        </div>
        {locked && (
          <p className="mt-1 text-right text-[10px] text-ash/60">{fmtDuration(remaining)} left</p>
        )}
        <div className="mt-2 h-1 w-full bg-edge">
          <div
            className={cn("h-full transition-all duration-1000", locked ? "bg-magenta" : "bg-cyan")}
            style={{
              width:
                locked && tier && tier.lockSeconds > 0
                  ? `${Math.min(100, Math.max(0, (1 - remaining / tier.lockSeconds) * 100))}%`
                  : "100%",
            }}
          />
        </div>
      </div>

      {stale && (
        <p className="mt-4 border border-magenta/30 bg-magenta/5 p-3 text-[11px] leading-relaxed text-ash">
          <span className="text-magenta">Your lock has run out.</span> You are still weighted at{" "}
          {tier?.multiplier} until somebody calls <code className="text-bone">kick()</code> on you —
          nothing runs on its own at expiry. You can withdraw right now without waiting for that,
          and what you already earned at {tier?.multiplier} stays yours.
        </p>
      )}

      {/* ---- claim ---- */}
      <div className="cut mt-6 border border-cyan/25 bg-cyan/[0.04] p-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[9px] uppercase tracking-[0.2em] text-ash">Claimable</span>
          <span className="text-[9px] uppercase tracking-[0.18em] text-ash/50">ETH, not LOYAL</span>
        </div>
        <p className={cn("readout mt-1.5 text-3xl font-bold tracking-tighter", pos.pending && pos.pending > 0n ? "neon-cyan" : "text-bone/50")}>
          {pos.pending !== null ? fmtSig(pos.pending, 6) : <span className="text-base italic text-ash/40">unavailable</span>}
        </p>

        <button
          onClick={claim}
          disabled={!pos.pending || pos.pending === 0n || tx.busy !== null || !wallet.onCorrectChain}
          className="cut mt-4 h-11 w-full bg-cyan text-[11px] font-bold uppercase tracking-[0.2em] text-void transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {pos.pending && pos.pending > 0n ? "claim" : "nothing to claim"}
        </button>

        <p className="mt-3 text-[11px] leading-relaxed text-ash">
          This never expires and nobody else can take it. It only grows when a reward is pushed
          into the vault — which is a transaction somebody has to send, not a schedule.
        </p>
      </div>

      {/* ---- commit / re-commit ---- */}
      {hasStake && (
        <div className="mt-6">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-ash">
              {locked ? "Extend or upgrade" : "Commit again"}
            </p>
            <p className="text-[9px] uppercase tracking-[0.18em] text-ash/50">no tokens move</p>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-ash">
            {locked
              ? "A standing lock can be lengthened or raised, never shortened — that is what the multiplier is paying for."
              : "Nothing happened when your lock ran out, and nothing will. Pick a term to start earning at its multiplier again, or leave it and drop to 0.5× the next time anyone kicks you."}
          </p>

          <div className="grid grid-cols-3 gap-1.5">
            {TIERS.map((t) => {
              // While locked the contract refuses any tier below the current
              // one, so the button is disabled rather than left to revert.
              const blocked = locked && t.index < (pos.effective ?? 0);
              const current = pos.tier === t.index && (locked || t.index === 0);
              return (
                <button
                  key={t.key}
                  onClick={() => relock(t.index)}
                  disabled={blocked || tx.busy !== null || !wallet.onCorrectChain}
                  title={blocked ? "A standing lock cannot be shortened" : undefined}
                  className={cn(
                    "border py-2 text-[10px] uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-25",
                    current
                      ? "border-cyan/50 bg-cyan/10 text-cyan"
                      : "border-edge text-ash hover:border-cyan/50 hover:text-cyan"
                  )}
                >
                  <span className="block font-bold">{t.multiplier}</span>
                  <span className="block text-[9px] text-ash/60">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- unstake ---- */}
      <div className="mt-6">
        <p className="mb-3 text-[10px] uppercase tracking-[0.2em] text-ash">Unstake</p>

        {!hasStake ? (
          <p className="text-[11.5px] text-ash">You have nothing staked.</p>
        ) : locked ? (
          <p className="text-[11.5px] leading-relaxed text-ash">
            Locked for another <span className="text-magenta">{fmtDuration(remaining)}</span>. The
            multiplier is what that promise is paying for, so the contract refuses every exit —
            transfer included — until it runs out. Nothing to do but wait; it opens on its own.
          </p>
        ) : (
          <>
            <AmountField
              value={amount}
              onChange={setAmount}
              max={pos.shares}
              decimals={ST_LOYAL_DECIMALS}
              unit="stLOYAL"
              label="Your vault shares"
              disabled={tx.busy !== null}
            />
            <button
              onClick={unstake}
              disabled={!canUnstake || tx.busy !== null || !wallet.onCorrectChain}
              className="cut mt-4 h-11 w-full border border-cyan/40 text-[11px] font-bold uppercase tracking-[0.2em] text-cyan transition-colors hover:bg-cyan/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              unstake
            </button>
            <p className="mt-2 text-[10px] leading-relaxed text-ash/60">
              Shares are 21 decimals and LOYAL is 18 — the percentages above work off the raw share
              balance, so MAX withdraws every last one rather than leaving dust.
            </p>
          </>
        )}
      </div>

      <TxLine tx={tx} />

      {!wallet.onCorrectChain && (
        <button
          onClick={wallet.switchChain}
          className="cut mt-4 h-10 w-full bg-magenta text-[10px] font-bold uppercase tracking-[0.2em] text-void"
        >
          switch to Robinhood Chain
        </button>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  unit,
  note,
  accent,
}: {
  label: string;
  value: string | null;
  unit?: string;
  note?: string;
  accent?: "cyan";
}) {
  return (
    <div className="bg-[#06080f] p-4">
      <p className="text-[9px] uppercase tracking-[0.2em] text-ash">{label}</p>
      <p
        className={cn(
          "readout mt-1.5 text-xl font-bold tracking-tight",
          value === null ? "text-sm font-normal italic text-ash/40" : accent === "cyan" ? "neon-cyan" : "text-bone"
        )}
      >
        {value ?? "unavailable"}
        {value !== null && unit && (
          <span className="ml-1 text-[9px] font-normal uppercase tracking-[0.16em] text-ash">{unit}</span>
        )}
      </p>
      {note && <p className="mt-0.5 truncate text-[10px] text-ash/50">{note}</p>}
    </div>
  );
}
