# Seogi

Electron + React meeting recorder for macOS: records mic and system audio, transcribes in ~30 s chunks, summarizes when the meeting ends. Providers go through the AI SDK (OpenAI, Anthropic, or a qgrid server).

# Toolchain

- The root `mise.toml` pins Node and pnpm. Run raw `node`, `npm`, `npx`, or `pnpm` commands with `mise exec -- <command>`; never use the host Node.js toolchain.
- `mise run dev` starts the app with hot reload. `mise run check` runs typecheck, tests, and build; run it before committing.
- Electron 45 downloads its binary on first run, not at install time.

# Layout

- `src/main/`: main process (recording sessions, transcription queue, SQLite via `node:sqlite`, settings and keychain-encrypted API keys).
- `src/preload/`: the `window.api` bridge; its contract is `Api` in `src/shared/types.ts`.
- `src/renderer/`: React UI. `src/renderer/src/recorder.ts` captures audio and cuts chunks.

# Design system

- `design.md` is the locked design system; `src/renderer/src/styles/tokens.css` holds the values.
- Use tokens only: no raw colours or font families outside `tokens.css`, spacing from the `--space-*` scale.
- Every interactive element needs default, hover, focus-visible, active, disabled, loading, error, and success states. Check new components in the dev style guide (`⌘⇧D`).
- After changing colour tokens, re-check WCAG contrast for the pairs listed in `design.md`.

# Language

- Write commit messages, code comments, README, and other docs in English, e.g. `feat(recorder): detect pauses with a noise-floor estimate`.
- UI copy stays Korean; it is product text, not documentation.
