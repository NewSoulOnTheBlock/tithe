"use client";

import { Glyph, type GlyphName } from "./Glyph";
import { cn } from "@/lib/utils";
import type { WinId, Wm } from "@/lib/wm";

/**
 * A window, built to read as an instrument rather than as software chrome.
 *
 * ## What was avoided, on purpose
 *
 * The reference is a Windows 98 desktop, and almost every affordance in that
 * language carries the era with it. So none of it is here:
 *
 * | 98 does it with | this does it with |
 * |---|---|
 * | raised bevels, `outset` borders | one 1px hairline, and light |
 * | a gradient blue title bar | an unfilled bar over a lit rule |
 * | square 3D buttons with glyph bitmaps | stroked vectors in a hover ring |
 * | grey `#c0c0c0` everywhere | near-black glass, cyan only where it means something |
 * | a resize grip | nothing — these are fixed panels that move |
 *
 * **Focus is shown with emission, not with colour swapping.** The focused
 * window keeps the same palette and simply generates more light: the border
 * brightens, corner brackets appear, a scan crawls under the title. An
 * unfocused window is never greyed out — it is legible, just not lit.
 *
 * ## Corner brackets
 *
 * Four L-shapes, drawn only on the focused window. They are what makes a panel
 * read as *targeted* — the visual grammar of a viewfinder rather than of a
 * document. They are also the cheapest possible focus indicator: no layout
 * shift, no border-width change, nothing that could nudge the content.
 */
export function Window({
  id,
  wm,
  title,
  index,
  icon,
  width,
  maxH,
  home,
  accent = "cyan",
  floating,
  field,
  children,
}: {
  id: WinId;
  wm: Wm;
  title: string;
  /** Shown as a system-ish handle before the title, e.g. `0x02`. */
  index: string;
  icon: GlyphName;
  width: number;
  /** Ceiling on total height. The client area scrolls inside it, so a long
      window can never grow past the field and hide its own controls. */
  maxH: number;
  /** Home position on the desktop, in px from the top-left of the field. */
  home: { x: number; y: number };
  accent?: "cyan" | "magenta";
  /** False on narrow screens: the window stops positioning and just stacks. */
  floating: boolean;
  /** Measured size of the field. `{0,0}` before the first observation. */
  field: { w: number; h: number };
  children: React.ReactNode;
}) {
  const s = wm.state[id];
  if (!s.open) return null;

  const isFocused = wm.focused === id;
  const lit = accent === "magenta" ? "magenta" : "cyan";

  /**
   * Clamped geometry.
   *
   * The width shrinks to fit a narrow field rather than overflowing it, and the
   * position is bounded so a window can never be dragged somewhere it cannot be
   * dragged back from. The bottom bound keeps `TITLE_KEEP` px on screen — enough
   * that the title bar, and therefore the drag handle and the close button, are
   * always reachable.
   *
   * Before the first ResizeObserver callback `field` is `{0,0}`; falling back to
   * the authored values means the first paint is correct on a normal desktop
   * instead of collapsing every window to zero width.
   */
  const TITLE_KEEP = 44;
  const measured = field.w > 0 && field.h > 0;
  const w = measured ? Math.min(width, Math.max(280, field.w - 16)) : width;
  const left = measured
    ? Math.min(Math.max(8, home.x + s.dx), Math.max(8, field.w - w - 8))
    : home.x + s.dx;
  const topPx = measured
    ? Math.min(Math.max(0, home.y + s.dy), Math.max(0, field.h - TITLE_KEEP))
    : home.y + s.dy;
  const cap = measured ? Math.max(TITLE_KEEP, Math.min(maxH, field.h - topPx - 8)) : maxH;

  return (
    <section
      onPointerDown={() => wm.focus(id)}
      aria-label={title}
      className={cn(
        "cut group/win relative flex flex-col border backdrop-blur-md transition-[border-color,box-shadow] duration-300",
        "bg-[#06080f]/92",
        floating ? "absolute" : "relative w-full",
        isFocused
          ? lit === "cyan"
            ? "border-cyan/45 shadow-[0_0_90px_-30px_rgba(0,229,255,0.85)]"
            : "border-magenta/45 shadow-[0_0_90px_-30px_rgba(255,43,209,0.8)]"
          : "border-edge shadow-[0_24px_60px_-40px_rgba(0,0,0,0.9)]"
      )}
      style={
        floating
          ? {
              left,
              top: topPx,
              width: w,
              maxHeight: cap,
              zIndex: s.z,
            }
          : // Stacked: no ceiling. Capping the height here would nest a
            // scroller inside the page scroller, which on a phone means a
            // panel that eats the swipe you meant for the document.
            undefined
      }
    >
      {/* ---- corner brackets: a viewfinder, not a border ---- */}
      {isFocused && (
        <span aria-hidden className={cn("pointer-events-none absolute inset-0", lit === "cyan" ? "text-cyan" : "text-magenta")}>
          <span className="absolute -left-px -top-px h-3 w-3 border-l border-t border-current" />
          <span className="absolute -right-px -top-px h-3 w-3 border-r border-t border-current" />
          <span className="absolute -bottom-px -left-px h-3 w-3 border-b border-l border-current" />
          <span className="absolute -bottom-px -right-px h-3 w-3 border-b border-r border-current" />
        </span>
      )}

      {/* ---- title bar ---- */}
      <header
        onPointerDown={(e) => wm.beginDrag(id, e)}
        onDoubleClick={() => wm.home(id)}
        title={floating ? "Drag to move · double-click to reset" : undefined}
        className={cn(
          "relative flex h-10 shrink-0 select-none items-center gap-3 pl-4 pr-2",
          floating && "cursor-grab active:cursor-grabbing"
        )}
      >
        <span className={cn("shrink-0 transition-colors", isFocused ? (lit === "cyan" ? "text-cyan" : "text-magenta") : "text-ash")}>
          <Glyph name={icon} size={15} />
        </span>

        <span className="readout shrink-0 text-[10px] tracking-[0.18em] text-ash/45">{index}</span>

        <h2
          className={cn(
            "min-w-0 flex-1 truncate text-[10px] uppercase tracking-[0.3em] transition-colors",
            isFocused ? "text-bone" : "text-ash"
          )}
        >
          {title}
        </h2>

        {/* Controls. Hit areas are 28px; the strokes inside are 14px, so they
            stay comfortably clickable without drawing boxes around themselves. */}
        <div className="flex shrink-0 items-center">
          {floating && (
            <button
              onClick={() => wm.home(id)}
              aria-label={`Reset ${title} position`}
              className="grid h-7 w-7 place-items-center text-ash/60 transition-colors hover:text-bone"
            >
              <Glyph name="min" size={14} />
            </button>
          )}
          <button
            onClick={() => wm.close(id)}
            aria-label={`Close ${title}`}
            className="grid h-7 w-7 place-items-center text-ash/60 transition-colors hover:text-magenta"
          >
            <Glyph name="close" size={14} />
          </button>
        </div>

        {/* The lit rule under the title. On the focused window a brighter
            segment crawls along it — the only motion in the chrome, and it
            marks which panel is live without adding a single word. */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 bottom-0 h-px",
            isFocused
              ? lit === "cyan"
                ? "bg-gradient-to-r from-cyan/70 via-cyan/20 to-transparent"
                : "bg-gradient-to-r from-magenta/70 via-magenta/20 to-transparent"
              : "bg-edge"
          )}
        />
        {isFocused && (
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
            <span className={cn("os-crawl absolute inset-y-0 w-24", lit === "cyan" ? "bg-cyan/80" : "bg-magenta/80")} />
          </span>
        )}
      </header>

      {/* ---- client area ---- */}
      <div
        className={cn(
          "min-h-0 flex-1 px-6 pb-6 pt-5",
          floating ? "os-client overflow-y-auto" : "overflow-visible"
        )}
      >
        {children}
      </div>
    </section>
  );
}
