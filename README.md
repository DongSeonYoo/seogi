# Seogi

A macOS app that records meetings, transcribes them while they happen, and writes up a summary with action items when they end. *Seogi* (서기) is Korean for the person who takes the minutes.

- Records the microphone and system audio as separate tracks, so the transcript tells "me" from "the other side".
- Writes the transcript from live captions as people speak (GPT-Live by default on qgrid), and keeps the audio for playback.
- When the meeting ends, produces an overview, decisions, action items with owners and due dates, and per-topic notes.
- Searches past meetings by title, summary, or anything said (⌘K).

Pick the live caption and summary models in Settings (⌘,): bring your own OpenAI or Anthropic API key, or point the app at a [qgrid](https://github.com/cartanova-ai/qgrid) server. API keys are encrypted with the macOS keychain and stay on this Mac.

## Run

```sh
mise install
mise exec -- pnpm install
mise run dev
```

Requires macOS 14.2 or later for system audio capture. Allow microphone and screen & system audio recording access on the first recording.

## Develop

- `mise run check`: typecheck, tests, and build
- Design system: [`design.md`](design.md); press ⌘⇧D in dev mode for the living style guide
- App data: `~/Library/Application Support/Seogi`
