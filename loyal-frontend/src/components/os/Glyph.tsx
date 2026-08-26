/**
 * Icons drawn as thin strokes, not as pictures of objects.
 *
 * The reference shell used 16px pixel art, which is inseparable from the era it
 * belongs to — a pixel folder IS Windows 95, no matter what colour it is
 * painted. These are the opposite: single-weight vector line work with no fill
 * and no perspective, closer to an instrument panel than to a file manager.
 *
 * Everything is `currentColor` and 1.25 stroke, so an icon inherits whatever
 * state its container is in and glows with it rather than being recoloured.
 */
export type GlyphName = "def" | "commit" | "position" | "reserve" | "notice" | "sys" | "close" | "min" | "link";

export function Glyph({ name, size = 20, className }: { name: GlyphName; size?: number; className?: string }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  switch (name) {
    // An open entry: a spine and two ruled columns of text.
    case "def":
      return (
        <svg {...p}>
          <path d="M12 5.5v14" />
          <path d="M12 5.5C10.2 4.2 7.8 3.7 4.5 4.2v13.6c3.3-.5 5.7 0 7.5 1.3 1.8-1.3 4.2-1.8 7.5-1.3V4.2c-3.3-.5-5.7 0-7.5 1.3Z" />
          <path d="M7 8.5h2.5M7 11.5h2.5M14.5 8.5H17M14.5 11.5H17" />
        </svg>
      );
    // A rising step chart with a bolt through it — commitment and its payout.
    case "commit":
      return (
        <svg {...p}>
          <path d="M3.5 20.5h17" />
          <path d="M5.5 20.5v-3.5M11 20.5v-7M16.5 20.5V6" />
          <path d="M19.5 3.5 17 8h3l-2.5 4.5" />
        </svg>
      );
    // A wallet as a ledger card with a value bar — not a purse, which would be
    // an object again. The bar is what distinguishes it from a plain document.
    case "position":
      return (
        <svg {...p}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
          <path d="M3.5 9.5h17" />
          <path d="M7 13.5h5" />
          <path d="M15.5 13.5h2" />
        </svg>
      );
    // A stacked reserve, read as strata rather than as a cylinder.
    case "reserve":
      return (
        <svg {...p}>
          <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
          <path d="m3.5 12 8.5 4.5 8.5-4.5" />
          <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
        </svg>
      );
    // Not a yellow triangle: a bracketed exclamation, like a console warning.
    case "notice":
      return (
        <svg {...p}>
          <path d="M8 3.5H5.5v17H8M16 3.5h2.5v17H16" />
          <path d="M12 8v5" />
          <path d="M12 16.2v.3" />
        </svg>
      );
    // A die with traces — the machine the whole thing runs on.
    case "sys":
      return (
        <svg {...p}>
          <rect x="7.5" y="7.5" width="9" height="9" rx="1" />
          <path d="M10.5 4v3.5M13.5 4v3.5M10.5 16.5V20M13.5 16.5V20M4 10.5h3.5M4 13.5h3.5M16.5 10.5H20M16.5 13.5H20" />
        </svg>
      );
    case "close":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        </svg>
      );
    case "min":
      return (
        <svg {...p} strokeWidth={1.5}>
          <path d="M6 17.5h12" />
        </svg>
      );
    case "link":
      return (
        <svg {...p}>
          <path d="M14 4.5h5.5V10" />
          <path d="M19.5 4.5 11 13" />
          <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
        </svg>
      );
  }
}
