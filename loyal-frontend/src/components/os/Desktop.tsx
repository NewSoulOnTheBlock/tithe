"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { useChain } from "@/lib/useChain";
import { useWallet } from "@/lib/wallet";
import { useWm, useIsDesktop, useFieldSize, type WinId } from "@/lib/wm";
import { Window } from "./Window";
import { Glyph, type GlyphName } from "./Glyph";
import { DefPane, ReservePane, NoticePane, SysPane } from "./Panes";
import { CommitPane, PositionPane } from "./StakePanes";
import { usePosition } from "@/lib/account";
import { useTx } from "@/lib/tx";
import { LOYAL, LOYAL_TAX_BPS_FALLBACK, CHAIN_ID, SOCIALS, isLive } from "@/lib/chain";
import { fmtSig, shortAddr, DASH } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The shell.
 *
 * ## The brief, and the trap in it
 *
 * "Like a computer screen, but not Windows 98." The trap is that almost every
 * desktop affordance people picture *is* Windows 98 — a Start button, a
 * taskbar of raised buttons, a system tray, beveled everything. Reskinning
 * those in neon produces Windows 98 in a costume.
 *
 * So the furniture is re-derived rather than repainted. What a desktop actually
 * needs is: somewhere to launch things, somewhere to see state, and a field to
 * put windows in. Here that is three strips with no ancestry in 1998:
 *
 * - **top — identity and wallet.** Who this is, what chain, whether you are
 *   connected. Not a menu bar; there are no menus.
 * - **left — the launcher.** Stroked glyphs in a vertical rail. Not desktop
 *   icons on a wallpaper: they never move, cannot be arranged, and are not
 *   files pretending to be on a surface.
 * - **bottom — telemetry.** A readout strip: RPC state, block, price, tax. It
 *   is explicitly *not* a taskbar — no window buttons live there, because the
 *   launcher already shows what is open and a second list of the same five
 *   things is the kind of redundancy taskbars have and instruments do not.
 *
 * ## Below 1024px it stops being a desktop
 *
 * Floating windows on a phone are a diorama. Under that width the same windows
 * render stacked in the document with identical chrome and content — the
 * metaphor is dropped rather than crippled, because a shell you cannot operate
 * is worse than no shell.
 */

type Def = {
  id: WinId;
  index: string;
  title: string;
  icon: GlyphName;
  width: number;
  maxH: number;
  home: { x: number; y: number };
  accent?: "cyan" | "magenta";
};

/**
 * Home positions are hand-placed rather than cascaded.
 *
 * A generated stagger puts every window on the same diagonal, which reads as a
 * pile. These are arranged so the two that open by default sit side by side
 * with no overlap at 1280px, and the three launchable ones land in the gaps
 * instead of on top of whatever is already there.
 */
const WINDOWS: Def[] = [
  { id: "def", index: "0x01", title: "loyalty.def", icon: "def", width: 500, maxH: 620, home: { x: 16, y: 12 } },
  // The widest of the six on purpose: it carries the axis, the chosen-tier
  // panel and the form, and the axis is the one thing here that is genuinely
  // a picture — squeezing it costs the comparison the whole pane exists to make.
  { id: "commit", index: "0x02", title: "commit.exe", icon: "commit", width: 640, maxH: 780, home: { x: 532, y: 12 } },
  { id: "position", index: "0x06", title: "position", icon: "position", width: 500, maxH: 660, home: { x: 300, y: 60 } },
  { id: "reserve", index: "0x03", title: "reserve.sys", icon: "reserve", width: 520, maxH: 480, home: { x: 92, y: 300 } },
  { id: "notice", index: "0x04", title: "notice.txt", icon: "notice", width: 480, maxH: 440, home: { x: 420, y: 210 }, accent: "magenta" },
  { id: "sys", index: "0x05", title: "system", icon: "sys", width: 520, maxH: 560, home: { x: 250, y: 130 } },
];

const OPEN_ON_LOAD: WinId[] = ["def", "commit"];

/**
 * The width at which the desktop turns on.
 *
 * Not an aesthetic round number: it is what the two default windows need to sit
 * side by side without the clamp shoving one on top of the other. 16 + 530 for
 * the first, 562 + 530 for the second, plus the 74px launcher and a margin —
 * 1180 is the first width where both fit with only a little overlap once the
 * clamp has had its say. Below it the stack is genuinely better than a desktop
 * with two windows in a pile, and iPad landscape (1024) lands there
 * deliberately.
 */
const DESKTOP_MIN = 1180;

export function Desktop() {
  const { snap, error } = useChain();
  const w = useWallet();
  const isDesktop = useIsDesktop(DESKTOP_MIN);
  const wm = useWm(OPEN_ON_LOAD, isDesktop);
  const [fieldRef, field] = useFieldSize<HTMLElement>();

  const { pos, refresh } = usePosition(w.account);
  const tx = useTx(w.getSigner, refresh);

  /**
   * Open the position window the first time an address appears.
   *
   * Claiming is the reason someone comes back, and burying it behind a rail
   * icon means the people with ETH waiting are the ones least likely to find
   * it. This fires once per connection rather than on every render — a window
   * that reopens itself after you close it is a window you fight.
   */
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (!w.account) {
      greeted.current = null;
      return;
    }
    if (greeted.current === w.account) return;
    greeted.current = w.account;
    wm.open("position");
  }, [w.account, wm]);

  const tax = snap?.curve.taxBps != null ? Number(snap.curve.taxBps) : LOYAL_TAX_BPS_FALLBACK;
  const stakeLive = isLive(LOYAL.stakedLoyal);

  const pane = (id: WinId) => {
    switch (id) {
      case "def": return <DefPane tax={tax} />;
      case "commit": return <CommitPane wallet={w} pos={pos} tx={tx} />;
      case "position": return <PositionPane wallet={w} pos={pos} tx={tx} />;
      case "reserve": return <ReservePane snap={snap} error={error} />;
      case "notice": return <NoticePane tax={tax} />;
      case "sys": return <SysPane snap={snap} tax={tax} />;
    }
  };

  const openCount = WINDOWS.filter((d) => wm.state[d.id].open).length;

  return (
    <div className={cn("relative z-10", isDesktop ? "fixed inset-0 flex flex-col" : "flex min-h-screen flex-col")}>
      {/* ================= top: identity + wallet ================= */}
      <header className="relative z-30 flex h-12 shrink-0 items-center gap-4 border-b border-edge bg-void/85 px-4 backdrop-blur">
        <div className="flex shrink-0 items-center gap-2.5">
          <Image src="/logo.webp" alt="" width={22} height={22} className="animate-drift" priority />
          <span className="text-[12px] font-bold tracking-[0.32em] text-bone">LOYAL</span>
        </div>
        <span className="hidden h-3.5 w-px bg-edge sm:block" />
        <span className="hidden text-[9px] uppercase tracking-[0.26em] text-ash/60 sm:block">reserve OS</span>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-2 border border-edge px-2.5 py-1 text-[9px] uppercase tracking-[0.18em] text-ash md:flex">
            <span className={cn("inline-block h-1.5 w-1.5", error ? "bg-magenta" : snap ? "animate-flicker bg-cyan" : "bg-ash/40")} />
            chain {CHAIN_ID}
          </span>

          {/* Three wallet states, because they have three different next
              actions. Showing an address while every write would revert is the
              failure people actually hit, and it is silent. */}
          {!w.account ? (
            <button
              onClick={w.connect}
              disabled={w.connecting}
              className="cut h-8 bg-cyan px-4 text-[10px] font-bold uppercase tracking-[0.18em] text-void transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {w.connecting ? "connecting…" : w.hasProvider ? "connect" : "no wallet"}
            </button>
          ) : !w.onCorrectChain ? (
            <button
              onClick={w.switchChain}
              className="cut h-8 bg-magenta px-4 text-[10px] font-bold uppercase tracking-[0.18em] text-void transition-opacity hover:opacity-90"
            >
              wrong network
            </button>
          ) : (
            <span className="cut flex h-8 items-center gap-2 border border-cyan/40 bg-cyan/10 px-3 text-[10px] text-cyan">
              <span className="inline-block h-1.5 w-1.5 animate-flicker bg-cyan" />
              {shortAddr(w.account)}
            </span>
          )}
        </div>
      </header>

      {w.error && <p className="border-b border-magenta/30 bg-magenta/5 px-4 py-1.5 text-[10px] text-magenta">{w.error}</p>}

      {/* ================= middle: launcher + field ================= */}
      <div className={cn("relative flex min-h-0 flex-1", !isDesktop && "flex-col")}>
        <Launcher wm={wm} horizontal={!isDesktop} />

        <main
          ref={fieldRef}
          className={cn("relative min-w-0 flex-1", isDesktop ? "overflow-hidden" : "space-y-5 px-4 py-5")}
        >
          {isDesktop && openCount === 0 && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-center text-[10px] uppercase tracking-[0.3em] text-ash/35">
              nothing open
              <br />
              <span className="mt-2 block text-[9px] tracking-[0.2em] text-ash/25">
                pick something from the rail
              </span>
            </p>
          )}

          {WINDOWS.map((d) => (
            <Window
              key={d.id}
              id={d.id}
              wm={wm}
              index={d.index}
              title={d.title}
              icon={d.icon}
              width={d.width}
              maxH={d.maxH}
              home={d.home}
              accent={d.accent}
              floating={isDesktop}
              field={field}
            >
              {pane(d.id)}
            </Window>
          ))}
        </main>
      </div>

      {/* ================= bottom: telemetry ================= */}
      <footer className="relative z-30 flex h-9 shrink-0 items-center gap-5 overflow-x-auto border-t border-edge bg-void/85 px-4 text-[9px] uppercase tracking-[0.18em] text-ash/70 backdrop-blur">
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn("inline-block h-1.5 w-1.5", error ? "bg-magenta" : "animate-flicker bg-cyan")} />
          {error ? "rpc down" : "rpc live"}
        </span>
        <Telem k="blk" v={snap?.block != null ? String(snap.block) : DASH} />
        <Telem k="tax" v={`${(tax / 100).toFixed(tax % 100 === 0 ? 0 : 2)}%`} />
        <Telem k="price" v={snap?.curve.priceWad != null ? `${fmtSig(snap.curve.priceWad, 3)} eth` : DASH} />
        <Telem k="staked" v={snap?.staking.totalAssets != null ? fmtSig(snap.staking.totalAssets, 3) : DASH} />
        <span className="ml-auto hidden shrink-0 gap-4 sm:flex">
          <a className="transition-colors hover:text-cyan" href={SOCIALS.telegram} target="_blank" rel="noreferrer">telegram</a>
          <a className="transition-colors hover:text-cyan" href={SOCIALS.x} target="_blank" rel="noreferrer">x</a>
        </span>
      </footer>
    </div>
  );
}

function Telem({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="text-ash/40">{k}</span>
      <span className="readout text-bone/75">{v}</span>
    </span>
  );
}

/**
 * The launcher rail.
 *
 * Not desktop icons: they are fixed in a rail, cannot be dragged onto a
 * wallpaper, and are not pretending to be files. An item that is open shows it
 * by being lit, so the rail doubles as the window list and the bottom strip
 * stays pure telemetry.
 */
function Launcher({ wm, horizontal }: { wm: ReturnType<typeof useWm>; horizontal: boolean }) {
  return (
    <nav
      className={cn(
        "relative z-20 flex shrink-0 gap-1 border-edge bg-void/60 backdrop-blur",
        horizontal ? "overflow-x-auto border-b px-3 py-2" : "w-[74px] flex-col border-r px-2 py-3"
      )}
    >
      {WINDOWS.map((d) => {
        const open = wm.state[d.id].open;
        const focused = wm.focused === d.id;
        return (
          <button
            key={d.id}
            onClick={() => wm.toggle(d.id)}
            aria-pressed={open}
            title={d.title}
            className={cn(
              "group relative flex shrink-0 flex-col items-center gap-1.5 px-2 py-2.5 transition-colors",
              open ? (focused ? "text-cyan" : "text-bone/85") : "text-ash/55 hover:text-bone"
            )}
          >
            {/* The open marker: a lit edge, not a pressed-in bevel. */}
            <span
              aria-hidden
              className={cn(
                "absolute transition-opacity",
                horizontal ? "inset-x-2 bottom-0 h-px" : "inset-y-2 left-0 w-px",
                open ? "bg-cyan opacity-100" : "opacity-0"
              )}
            />
            <Glyph name={d.icon} size={21} className={cn("transition-transform duration-200", "group-hover:-translate-y-0.5")} />
            <span className="text-[8px] uppercase tracking-[0.14em]">{d.title.split(".")[0]}</span>
          </button>
        );
      })}
    </nav>
  );
}
