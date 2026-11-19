import { useEffect, useState, type CSSProperties } from "react";

/** Pane widths and sidebar visibility, kept in this window's localStorage. */
export type Layout = { sidebar: boolean; sidebarW: number; listW: number };

const KEY = "seogi.layout";
const DEFAULT: Layout = { sidebar: true, sidebarW: 232, listW: 320 };
export const SIDEBAR_W = { min: 180, max: 360 };
export const LIST_W = { min: 240, max: 560 };
/** Dragging the sidebar narrower than this hides it, like Finder. */
const COLLAPSE_BELOW = 120;
/** The detail pane keeps at least this much room. */
const DETAIL_MIN = 360;

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      // Private or blocked storage: the layout just isn't remembered.
    }
  }, [layout]);

  const clamp = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)));
  const room = (other: number) => window.innerWidth - other - DETAIL_MIN;

  return {
    layout,
    style: { "--sidebar-w": `${layout.sidebarW}px`, "--list-w": `${layout.listW}px` } as CSSProperties,
    toggleSidebar: () => setLayout((l) => ({ ...l, sidebar: !l.sidebar })),
    resizeSidebar: (w: number) =>
      setLayout((l) =>
        w < COLLAPSE_BELOW
          ? { ...l, sidebar: false }
          : { ...l, sidebar: true, sidebarW: clamp(Math.min(w, room(l.listW)), SIDEBAR_W) },
      ),
    resizeList: (w: number) =>
      setLayout((l) => ({ ...l, listW: clamp(Math.min(w, room(l.sidebar ? l.sidebarW : 0)), LIST_W) })),
    resetSidebar: () => setLayout((l) => ({ ...l, sidebar: true, sidebarW: DEFAULT.sidebarW })),
    resetList: () => setLayout((l) => ({ ...l, listW: DEFAULT.listW })),
  };
}

/**
 * A vertical divider at `at` px from the window's left edge. Dragging reports the new width of
 * the pane to its left (`at` plus the drag distance); double-click restores the default.
 */
export function Splitter({
  at,
  label,
  className,
  onResize,
  onReset,
}: {
  at: number;
  label: string;
  className?: string;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`splitter ${className ?? ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-dragging={dragging || undefined}
      style={{ left: at }}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const startX = e.clientX;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (m: PointerEvent) => onResize(at + m.clientX - startX);
        const up = () => {
          setDragging(false);
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}
