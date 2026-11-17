# Seogi design system

The locked design system for the Seogi (서기) meeting-notes app. New screens use these tokens and patterns rather than inventing their own. Source of truth for values: `src/renderer/src/styles/tokens.css`. Living reference: the dev-only style guide (`⌘⇧D` in `pnpm dev`).

## Direction

- **Structure from Linear.** Inverted-L chrome: sidebar and header frame an inset main surface. Layers are separated by lightness steps and 1px lines, not shadows. UI text is dense (13px). One accent.
- **Colour from Claude.** Warm oat and charcoal neutrals (every grey carries a small warm chroma). One terracotta accent.
- **Interaction patterns from Discord**, mapped to meetings:

| Discord | Seogi |
| --- | --- |
| Channel list with categories | Meetings grouped as 오늘 / 어제 / 지난 7일 / month |
| Unread pill on the left edge | Summary finished but not opened yet |
| Message groups | Consecutive lines from one speaker within 2 minutes share one header |
| Hover timestamp in the gutter, hover toolbar | Continuation lines show the time on hover; play-from-here and copy |
| Member list | Collapsible summary panel on the right (auto-collapses while recording) |
| Voice-connected panel | Recorder dock at the bottom of the sidebar |
| Quick switcher | `⌘K` search across titles, summaries and transcript text |
| User settings | `⌘,` swaps the whole window to settings: category list in the sidebar, grouped rows on the right, changes apply instantly |

## Colour

All colours are OKLCH tokens. Light and dark use the same token names; only lightness and chroma move. The theme follows the macOS appearance.

| Role | Tokens |
| --- | --- |
| Surfaces (low → high) | `chrome` → `main` → `raised`; `hover`, `selected` for item states |
| Lines | `line` (dividers), `line-strong` (button edges, scrollbars), `line-control` (form-control boundary, ≥ 3:1) |
| Text | `ink` (primary), `ink-2` (secondary), `ink-3` (meta, placeholders) |
| Accent | `accent` fills, `accent-text` for accent-coloured text, `accent-soft` washes, `on-accent` for text on fills, `focus` for rings |
| Status | `danger` / `danger-soft`, `success` / `success-soft` |

The accent marks only these: the record button, live recording state, the "나" speaker, and focus rings. It stays under ~3% of any view.

### Contrast (WCAG 2.x, computed from the tokens)

All pairs pass in both themes. Text ≥ 4.5:1, focus rings and control boundaries ≥ 3:1.

| Pair | Light | Dark |
| --- | --- | --- |
| ink / main | 16.3 | 13.0 |
| ink-3 / hover (weakest text pair) | 4.5 | 4.8 |
| on-accent / accent | 5.0 | 6.2 |
| accent-text / main | 6.1 | 6.6 |
| focus / chrome | 4.5 | 6.7 |
| line-control / chrome | 3.0 | 3.8 |

`line` and `line-strong` are decorative and intentionally below 3:1.

## Type

- **Pretendard Variable** for everything (bundled, OFL). One family on purpose: app UI, Linear-style. Korean text breaks between words (`word-break: keep-all`).
- Scale: `xs` 11 · `sm` 12 · `base` 13 (UI) · `read` 15 (transcript and summary) · `lg` 16 · `xl` 20 · `2xl` 24.
- Weights: 400 (380 in dark), 510, 620. Numbers that change in place (timers, timestamps) use tabular figures (`.tnum`).
- Headings are always upright; no italic display type.

## Space, shape, motion

- 4pt spacing scale `--space-1…10`, plus `--space-half` (2px) for dense message rows only.
- Radii: 4 (kbd) · 6 (controls, items) · 8 (main surface) · 12 (dialogs).
- Control height 30px (36px for `btn--lg`). Inputs and adjacent buttons share the height.
- Easings `--ease-out / in / in-out`; durations 120 / 200 / 320 ms. Only `transform`, `opacity` and colours animate. Reduced motion shortens everything to 150ms.

## Components

`src/renderer/src/ui.tsx` + `styles/components.css`:

- **Button**: `primary` (one per area), `secondary`, `ghost`, `danger`; states default · hover · focus · active · disabled · loading · error · success.
- **IconButton**: 28px with an enlarged hit area; `aria-pressed` for toggles.
- **Field**: label above, helper below on a reserved line, error replaces helper (`aria-invalid`, `aria-describedby`). Border width never changes between states; focus is a 2px outline.
- **Select**: native select with a Lucide chevron.
- **Switch** (`role="switch"`) for on/off settings; **Segmented** (radio group, arrow keys move the choice) for 2–4 exclusive options.
- **CommitInput**: text input for instant-save settings; commits on blur or Enter, reverts on Esc.
- **Dialog**: native `<dialog>` in modal mode (focus trap, Esc, inert background); state syncs on the platform `close` event.
- **Kbd**, **Spinner**, **Avatar** (`data-speaker="mic"` uses the accent wash).

Icons come from `lucide-react` only.

## Deliberate deviations from Hallmark defaults

- **Single family, no display face.** Hallmark wants a distinctive display face for pages; this is a dense app UI where Linear's single-family discipline reads better. Pretendard's Latin glyphs derive from Inter, which Hallmark lists as a banned *display* default.
- **App type scale** (11–24px) instead of the 1.25 marketing scale.
- **Tight measure is not enforced** on the transcript; it follows the column width like a chat log.
