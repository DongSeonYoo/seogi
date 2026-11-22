# Seogi design system

The design system for the Seogi (서기) meeting-notes app. New screens use these tokens and patterns rather than inventing their own. Source of truth for values: `src/renderer/src/styles/tokens.css`. Living reference: the dev-only style guide (View › 스타일 가이드, `⌘⇧D` in `pnpm dev`).

## Direction

- **Look like a Mac app.** Pretendard (bundled), Apple's label and separator greys, the user's macOS accent colour, AppKit control shapes and sizes, window vibrancy behind the sidebar, native menus. Nothing should read as a web page: no pointer cursors, no hover fills on list rows, selection greys out when the list loses focus or the window goes to the background.
- **Structure from Tower** (git-tower.com). Three panes under one toolbar:

| Tower | Seogi |
| --- | --- |
| Floating sidebar with sections and counts (Workspace, Branches) | 보관함 (모든 회의, 읽지 않음, 즐겨찾기, 오류) and 폴더, each with a count |
| History list | Meeting list: title, date, two-line summary preview, length, status |
| Detail with a segmented switch (Staged / Unstaged) | Detail with 요약 / 받아쓰기 (`⌘1` / `⌘2`) |
| Status bar with counts | Status bar: date or live recording time, length, utterance count |
| Toolbar capsules | 녹음 · (즐겨찾기, 다시 요약) · 찾기 |
| Undo anything (`⌘Z`) | Rename, star, move, delete and folder changes undo and redo |
| Drag onto sidebar sections | Drag a meeting onto a folder (or 모든 회의 to unfile it) |
| Quick actions | `⌘K` runs commands and searches every meeting |

- **One action list.** The menu bar, toolbar, right-click menus and `⌘K` run the same actions (`actions` in `App.tsx`, ids in `ActionId`). Add a command there once.
- **Settings is its own window** (`⌘,`) with toolbar tabs, like System Settings panes in other Mac apps. Changes apply immediately.

## Colour

Light and dark use the same token names. The accent is `--system-accent`, set at runtime from System Settings › Appearance and updated when the user changes it.

| Role | Tokens |
| --- | --- |
| Surfaces | `window` (content panes), `chrome` (status bar, toolbar of the settings window), `raised` (popovers), `control` (buttons, fields), `sidebar` (the floating card over the vibrancy) |
| States | `hover`, `selected` (sidebar selection, unfocused list selection) |
| Lines | `line`, `line-strong`, `line-control` (control boundary, ≥ 3:1) |
| Text | `ink`, `ink-2`, `ink-3` |
| Accent | `accent`, `accent-text`, `accent-soft`, `on-accent`, `focus` (the focus halo) |
| Status | `record` (record control, live dot), `danger` / `danger-soft`, `success` / `success-soft`, `warning` (star) |

The accent fills focused list selection, the default button, switches, the palette selection and sidebar symbols. Red is only for recording and errors.

### Contrast (WCAG 2.x, default accent)

Text ≥ 4.5:1 and control boundaries ≥ 3:1, both themes.

| Pair | Light | Dark |
| --- | --- | --- |
| ink / window | 16.8 | 15.3 |
| ink-2 / window | 6.4 | 7.7 |
| ink-3 / window | 5.5 | 6.5 |
| ink-3 / selected (weakest text pair) | 4.6 | 4.8 |
| danger / window | 5.4 | 5.9 |
| line-control / window | 3.4 | 4.0 |
| on-accent / accent | 4.0 | 3.6 |

`on-accent / accent` is below 4.5 on purpose: it is AppKit's own selected-row and default-button pairing with the system blue, and matching the platform wins here. The label stays at 13px or larger. `line` and `line-strong` are decorative.

## Type

- Pretendard Variable 1.3.9, bundled (`assets/fonts`, SIL Open Font License); the system font is the fallback.
- One step above AppKit's sizes: `xs` 12 (section headers, badges) · `sm` 13 (meta, status bar) · `base` 14 (UI) · `read` 15 (transcript and summary) · `lg` 16 (toolbar title) · `xl` 21 · `2xl` 25 (style guide only).
- Weights 400, 500, 600. Changing numbers use tabular figures (`.tnum`). Korean breaks between words (`word-break: keep-all`).

## Space, shape, motion

- 4pt scale `--space-1…10`, plus `--space-half` (2px).
- Radii: 4 (kbd, inline fields) · 6 (controls, sidebar items) · 10 (list rows) · 14 (sidebar card, dialogs) · full (toolbar capsules, switches).
- Controls are 26px high (32px for `btn--lg`); sidebar rows 28px; toolbar 52px; status bar 28px.
- Durations 100 / 180 ms. Only transforms, opacity and colours animate. Reduced motion shortens everything.

## Components

`src/renderer/src/ui.tsx` + `styles/components.css`:

- **Button**: push button (`secondary`), default button (`primary`), `ghost`, `danger`; states default · hover · focus · active · disabled · loading · error · success.
- **IconButton**: borderless, 26px; `aria-pressed` for toggles. **Capsule**: a pill that groups toolbar buttons.
- **Field**, **CommitInput** (instant-save text), **Select** (popup button), **Switch**, **Segmented**.
- **Dialog**: native `<dialog>` drawn as a sheet; used for `⌘K`.
- Context menus and the menu bar are native Electron menus, never HTML.

Icons come from `lucide-react` only.
