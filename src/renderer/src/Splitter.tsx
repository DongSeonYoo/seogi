import { useEffect, useState, type CSSProperties } from "react";

/** Pane widths and which side panes are open, kept in this window's localStorage. */
export type Layout = { sidebar: boolean; sidebarW: number; listW: number; summary: boolean; summaryW: number };

const KEY = "seogi.layout";
const DEFAULT: Layout = { sidebar: true, sidebarW: 232, listW: 320, summary: true, summaryW: 380 };
const SIDEBAR_W = { min: 180, max: 360 };
const LIST_W = { min: 240, max: 560 };
const SUMMARY_W = { min: 280, max: 720 };
/** Dragging a side pane narrower than this hides it, like Finder. */
const COLLAPSE_BELOW = 120;
/** The transcript keeps at least this much room (so list + summary still fit a 900 px window). */
const DETAIL_MIN = 300;

export function useLayout() {
  const [saved, setLayout] = useState<Layout>(() => {
    try {
      return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Private or blocked storage: the layout just isn't remembered.
    }
  }, [saved]);

  // A window too narrow for every open pane hides the sidebar, then the summary, so the transcript
  // keeps DETAIL_MIN; they come back as the window widens (the saved layout is untouched).
  const [windowW, setWindowW] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowW(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const layout = { ...saved };
  const left = () => windowW - (layout.sidebar ? layout.sidebarW : 0) - layout.listW - (layout.summary ? layout.summaryW : 0);
  // The sidebar goes first: the summary pane is the one people open on purpose.
  if (left() < DETAIL_MIN) layout.sidebar = false;
  if (left() < DETAIL_MIN) layout.summary = false;

  const clamp = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)));
  /** Room left for one pane once the others and the transcript have theirs. */
  const room = (l: Layout, except: "sidebar" | "list" | "summary") =>
    window.innerWidth -
    DETAIL_MIN -
    (except !== "sidebar" && l.sidebar ? l.sidebarW : 0) -
    (except !== "list" ? l.listW : 0) -
    (except !== "summary" && l.summary ? l.summaryW : 0);

  return {
    layout,
    style: { "--sidebar-w": `${layout.sidebarW}px`, "--list-w": `${layout.listW}px` } as CSSProperties,
    // Toggles act on what is on screen, so one press always shows or hides the pane.
    toggleSidebar: () => setLayout((l) => ({ ...l, sidebar: !layout.sidebar })),
    toggleSummary: () => setLayout((l) => ({ ...l, summary: !layout.summary })),
    resizeSidebar: (w: number) =>
      setLayout((l) =>
        w < COLLAPSE_BELOW
          ? { ...l, sidebar: false }
          : { ...l, sidebar: true, sidebarW: clamp(Math.min(w, room(l, "sidebar")), SIDEBAR_W) },
      ),
    resizeList: (w: number) => setLayout((l) => ({ ...l, listW: clamp(Math.min(w, room(l, "list")), LIST_W) })),
    resizeSummary: (w: number) =>
      setLayout((l) =>
        w < COLLAPSE_BELOW
          ? { ...l, summary: false }
          : { ...l, summary: true, summaryW: clamp(Math.min(w, room(l, "summary")), SUMMARY_W) },
      ),
    resetSidebar: () => setLayout((l) => ({ ...l, sidebar: true, sidebarW: DEFAULT.sidebarW })),
    resetList: () => setLayout((l) => ({ ...l, listW: DEFAULT.listW })),
    resetSummary: () => setLayout((l) => ({ ...l, summary: true, summaryW: DEFAULT.summaryW })),
  };
}

/**
 * A vertical divider `at` px from its container's left edge, or from its right edge for a pane
 * on the right. Dragging reports the new width of that pane; double-click restores the default.
 */
export function Splitter({
  at,
  side = "left",
  label,
  className,
  onResize,
  onReset,
}: {
  at: number;
  side?: "left" | "right";
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
      data-side={side}
      style={side === "left" ? { left: at } : { right: at - 4 }}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const startX = e.clientX;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (m: PointerEvent) => onResize(at + (side === "left" ? 1 : -1) * (m.clientX - startX));
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
