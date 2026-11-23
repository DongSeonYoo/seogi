---
name: seogi
description: Read the user's meetings recorded in Seogi (a macOS meeting-notes app) with the read-only `seogi` command. Use when the user refers to a meeting by its Seogi ID ("#51"), asks what was said or decided in a meeting, wants a meeting summarized, searched or turned into notes or tasks, or wants to follow a meeting being recorded now.
---

# Seogi meetings

`seogi` reads the Seogi library on this Mac. It only reads; it never changes a meeting.
If `seogi` is not on PATH, run `~/.local/bin/seogi`.

```
seogi list [--project NAME] [--limit N]    # meetings, newest first: #id, date, length, project, title
seogi search WORDS...                      # meetings and lines holding all the words (any order; Korean initials like ㅎㅂ work)
seogi show ID                              # summary, then the transcript
seogi show ID --from 12:00 --to 20:00      # only the lines in that span (no summary)
seogi follow [ID]                          # new lines of the meeting being recorded, until it stops
```

Every command takes `--json` for the data instead of text.

## How to work

- The user names meetings as `#51`, often followed by the title. Pass the number.
- Find, then read: `search` or `list` to locate the meeting, `show` with `--from/--to` around the
  hits for long meetings instead of reading every line. An hour is about 600 lines.
- Transcript lines read ``- `12:34` **Speaker**: text``. Lines come from live speech recognition:
  expect misheard words, especially names and terms. Speakers are the names the user gave, or
  "화자 1"/"Speaker 1" for voices told apart automatically, which can be wrong. When a fact hinges
  on who said it or on an exact word, say how sure the transcript lets you be.
- Summaries were written by a model from the transcript; the transcript is the source.
- `follow` runs until the recording ends and is processed. Run it in the background and read its
  output as it grows; it prints only lines said after it starts, so `show` the meeting first for
  what came before. Its speaker names are provisional (voices are placed after a line arrives);
  `show` has the settled ones.

## Citing

Cite each claim with its meeting and time, as a link that opens that line in Seogi:
`[#51 12:34](seogi://meeting/51?t=12:34)`.
