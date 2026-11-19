# Seogi

Electron + React meeting recorder for macOS: records mic and system audio, writes the transcript from live captions as people speak, summarizes when the meeting ends. Providers go through the AI SDK (OpenAI, Anthropic, or a qgrid server).

# Toolchain

- The root `mise.toml` pins Node and pnpm. Run raw `node`, `npm`, `npx`, or `pnpm` commands with `mise exec -- <command>`; never use the host Node.js toolchain.
- `mise run dev` starts the app with hot reload. `mise run check` runs typecheck, tests, and build; run it before committing.
- Electron 45 downloads its binary on first run, not at install time.
- `pnpm dist` signs the app with a fixed self-signed certificate (`scripts/sign-mac.sh`, made once in its own keychain) so macOS keeps Screen & System Audio Recording permission across reinstalls; ad-hoc signing changed identity every build.

# Layout

- `src/main/`: main process (recording sessions, live caption streams, SQLite via `node:sqlite`, settings and keychain-encrypted API keys).
- `src/preload/`: the `window.api` bridge; its contract is `Api` in `src/shared/types.ts`.
- `src/renderer/`: React UI. `src/renderer/src/recorder.ts` captures audio and cuts the chunks saved for playback; `src/renderer/src/gptLive.ts` runs GPT-Live captions.

# Design system

- `design.md` is the design system (macOS-native look, Tower-style three panes); `src/renderer/src/styles/tokens.css` holds the values.
- Use tokens only: no raw colours or font families outside `tokens.css`, spacing from the `--space-*` scale.
- Commands live once in the `actions` map in `App.tsx`; the menu bar (`src/main/menu.ts`), toolbar, context menus and ⌘K call them.
- Library changes go through `perform` in `src/main/library.ts` so they can be undone. Deletes stay restorable until quit, then are purged with their audio.
- Every interactive element needs default, hover, focus-visible, active, disabled, loading, error, and success states. Check new components in the dev style guide (`⌘⇧D`).
- After changing colour tokens, re-check WCAG contrast for the pairs listed in `design.md`.
- `pnpm dev` uses its own data folder (`~/Library/Application Support/Seogi-dev`); never point it at the installed app's data.

# Language

- Write commit messages, code comments, README, and other docs in English, e.g. `feat(recorder): detect pauses with a noise-floor estimate`.
- UI copy lives in `src/shared/i18n.ts` with every string in English and Korean; the app defaults to English and the user picks the language in Settings › General. Never hard-code UI text in components or the main process.
