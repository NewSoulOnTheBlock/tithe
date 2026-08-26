"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A window manager, in about a hundred lines.
 *
 * ## Why hand-rolled
 *
 * The libraries for this (react-rnd, dnd-kit) solve resizing, snapping,
 * collision and touch gestures. None of that is wanted here: these windows are
 * fixed-size panels that move, and the whole point of the metaphor is that it
 * feels like a system rather than a widget. Two pointer handlers and a z
 * counter is the entire requirement.
 *
 * ## What it deliberately does not do
 *
 * **It does not run below 1024px.** A floating desktop on a phone is a museum
 * piece you cannot use: windows land off-screen, drag fights the scroll, and
 * every panel is wider than the viewport. Under that width the same windows
 * render as a plain vertical stack — same chrome, same content, no positioning.
 * `useIsDesktop` is what the shell branches on, and it starts `false` so the
 * server and the first client paint agree.
 */

export type WinId = "def" | "commit" | "position" | "chart" | "reserve" | "notice" | "sys";

export type WinState = {
  open: boolean;
  z: number;
  /** Offset from the window's declared home position, in px. */
  dx: number;
  dy: number;
};

export type Wm = {
  state: Record<WinId, WinState>;
  /** Highest z, so the shell can tell which window is focused. */
  focused: WinId | null;
  open: (id: WinId) => void;
  close: (id: WinId) => void;
  toggle: (id: WinId) => void;
  focus: (id: WinId) => void;
  /** Reset a window to its home position (double-click its title bar). */
  home: (id: WinId) => void;
  beginDrag: (id: WinId, e: React.PointerEvent) => void;
};

const IDS: WinId[] = ["def", "commit", "position", "chart", "reserve", "notice", "sys"];

export function useWm(initiallyOpen: WinId[], enabled: boolean): Wm {
  const [state, setState] = useState<Record<WinId, WinState>>(() => {
    const out = {} as Record<WinId, WinState>;
    IDS.forEach((id, i) => {
      out[id] = { open: initiallyOpen.includes(id), z: initiallyOpen.indexOf(id) + 1, dx: 0, dy: 0 };
    });
    return out;
  });

  const top = useRef(IDS.length);

  /**
   * A mirror of `state`, kept for one reason: the drag handler needs the
   * window's current offset at pointer-down, and reading it by calling
   * `setState(s => { base = ...; return s })` runs that closure **twice** under
   * StrictMode. Here it happens to be idempotent, but the same shape has
   * already caused a real double-increment bug in a sibling project — so the
   * read goes through a ref and the updater stays pure.
   */
  const ref = useRef(state);
  ref.current = state;

  const focus = useCallback((id: WinId) => {
    setState((s) => {
      // Already on top: nothing to do. Skipping the write keeps a click on the
      // focused window from re-rendering the whole shell.
      const max = Math.max(...IDS.map((k) => s[k].z));
      if (s[id].z === max) return s;
      top.current += 1;
      return { ...s, [id]: { ...s[id], z: top.current } };
    });
  }, []);

  const open = useCallback(
    (id: WinId) => {
      setState((s) => {
        top.current += 1;
        return { ...s, [id]: { ...s[id], open: true, z: top.current } };
      });
    },
    []
  );

  const close = useCallback((id: WinId) => {
    setState((s) => ({ ...s, [id]: { ...s[id], open: false } }));
  }, []);

  const toggle = useCallback(
    (id: WinId) => {
      setState((s) => {
        const isOpen = s[id].open;
        const max = Math.max(...IDS.map((k) => (s[k].open ? s[k].z : 0)));
        // A dock click on an open-but-buried window should raise it, not close
        // it. Only a click on the window that is already on top closes it.
        if (isOpen && s[id].z < max) {
          top.current += 1;
          return { ...s, [id]: { ...s[id], z: top.current } };
        }
        top.current += 1;
        return { ...s, [id]: { ...s[id], open: !isOpen, z: top.current } };
      });
    },
    []
  );

  const home = useCallback((id: WinId) => {
    setState((s) => ({ ...s, [id]: { ...s[id], dx: 0, dy: 0 } }));
  }, []);

  /**
   * Drag, via pointer capture.
   *
   * Capture is what makes this survive the pointer leaving the title bar — and
   * leaving the document entirely. Without it a fast drag drops the window
   * wherever the cursor happened to exit, which feels broken in exactly the way
   * a real window manager never does.
   */
  const beginDrag = useCallback(
    (id: WinId, e: React.PointerEvent) => {
      if (!enabled) return;
      // Never start a drag from a control inside the title bar.
      if ((e.target as HTMLElement).closest("button")) return;

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const base = { dx: ref.current[id].dx, dy: ref.current[id].dy };

      const move = (ev: PointerEvent) => {
        setState((s) => ({
          ...s,
          [id]: { ...s[id], dx: base.dx + ev.clientX - startX, dy: base.dy + ev.clientY - startY },
        }));
      };
      const up = () => {
        el.releasePointerCapture?.(e.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);

      focus(id);
    },
    [enabled, focus]
  );

  const openIds = IDS.filter((i) => state[i].open);
  const focused =
    openIds.length === 0
      ? null
      : openIds.reduce((a, b) => (state[a].z >= state[b].z ? a : b));

  return { state, focused, open, close, toggle, focus, home, beginDrag };
}

/**
 * The window field's live size.
 *
 * Home positions are authored against a comfortable desktop, and without
 * measuring, a 1024px viewport clips the right-hand window straight off — its
 * home x plus its width is wider than the field. Dragging has the same failure
 * in the other direction: a window pushed past the edge is simply gone.
 *
 * So the field is measured and every window is clamped into it. `ResizeObserver`
 * rather than a window resize listener, because the field also changes size when
 * the launcher wraps or the error strip appears, neither of which resizes the
 * window.
 */
export function useFieldSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}

/** True only once mounted AND wide enough for floating windows to be usable. */
export function useIsDesktop(min = 1024): boolean {
  const [is, setIs] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${min}px)`);
    const on = () => setIs(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [min]);
  return is;
}
