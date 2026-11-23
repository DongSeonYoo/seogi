import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { INTL_LOCALE, translator, type Locale } from "../shared/i18n";
import { snippet } from "../shared/search";
import { clock, clockSeconds, meetingDocument, shownNames, speakerName } from "../shared/summary";
import type { Utterance } from "../shared/types";
import { readDb } from "./db";

/**
 * The seogi command: the meeting library for agents and scripts, read only. The app installs it
 * (Seogi menu) as a script that runs this file with the app's own Electron as Node.
 */
const HELP = `seogi: read your Seogi meetings.

  seogi list [--project NAME] [--limit N]   meetings, newest first
  seogi search WORDS...                     meetings and lines that hold all the words
  seogi show ID [--from 12:00] [--to 20:00] summary and transcript (a range: lines only)
  seogi follow [ID]                         new lines of the meeting being recorded, as they come

IDs are the #numbers in the app. --json prints the data instead of text.
Link a line as seogi://meeting/ID?t=12:34 to open it in the app.
SEOGI_DATA sets the data folder (default ~/Library/Application Support/Seogi).`;

const FOLLOW_POLL_MS = 1000;

const dir = process.env.SEOGI_DATA ?? path.join(homedir(), "Library", "Application Support", "Seogi");
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    limit: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
if (!command || opts.help) {
  console.log(HELP);
  process.exit(0);
}

const file = path.join(dir, "seogi.db");
if (!existsSync(file)) fail(`No Seogi library at ${dir}.`);
const db = readDb(file);
const settingsFile = path.join(dir, "settings.json");
const locale: Locale = (existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf8")).locale) || "en";
const t = translator(locale);
const date = (iso: string) => new Date(iso).toLocaleString(INTL_LOCALE[locale], { dateStyle: "medium", timeStyle: "short" });
const out = (data: unknown, text: () => string) => console.log(opts.json ? JSON.stringify(data, null, 2) : text());
const idOf = (arg?: string) => (/^#?\d+$/.test(arg ?? "") ? Number(arg!.replace("#", "")) : fail(`Not a meeting ID: ${arg ?? "(none)"}`));
const meeting = (id: number) => db.getMeeting(id) ?? fail(`No meeting #${id}.`);
const projects = new Map(db.listFolders().map((f) => [f.id, f.name]));

switch (command) {
  case "list": {
    const project = opts.project && db.listFolders().find((f) => f.name.toLowerCase() === opts.project!.toLowerCase());
    if (opts.project && !project) fail(`No project "${opts.project}". Projects: ${[...projects.values()].join(", ") || "none"}.`);
    const rows = db.listMeetings(project ? project.id : "all").slice(0, Number(opts.limit ?? 20));
    const shown = rows.map((m) => ({ ...m, project: m.folderId === null ? null : projects.get(m.folderId) ?? null }));
    out(shown, () =>
      shown
        .map((m) =>
          [`#${m.id}`, date(m.startedAt), clock(m.durationSec), m.project ?? "-", m.status === "done" ? m.title : `${m.title} (${m.status})`].join("\t"),
        )
        .join("\n"),
    );
    break;
  }
  case "search": {
    const r = db.search(args.join(" "));
    out(r, () =>
      [
        ...r.meetings.map((m) => `#${m.id}\t${date(m.startedAt)}\t${m.title}`),
        ...r.lines.map((l) => `#${l.meetingId} @${clock(l.startSec)}\t${l.meetingTitle}\t${snippet(l.text, l.ranges, 40, 200)[0]}`),
      ].join("\n") || "No match.",
    );
    break;
  }
  case "show": {
    const m = meeting(idOf(args[0]));
    const [from, to] = [opts.from ? clockSeconds(opts.from) : 0, opts.to ? clockSeconds(opts.to) : Infinity];
    const ranged = opts.from !== undefined || opts.to !== undefined;
    const shown = { ...m, summary: ranged ? null : m.summary, utterances: m.utterances.filter((u) => u.startSec >= from && u.startSec <= to) };
    out(shown, () => meetingDocument(shown, "md", t, `#${m.id} · ${date(m.startedAt)}`).trimEnd());
    break;
  }
  case "follow": {
    const id = args[0] ? idOf(args[0]) : (db.listMeetings("all").find((m) => m.status === "recording")?.id ?? fail("No meeting is being recorded."));
    let seen = Math.max(0, ...meeting(id).utterances.map((u) => u.id));
    const print = (u: Utterance, names: ReturnType<typeof shownNames>) =>
      console.log(opts.json ? JSON.stringify(u) : `- \`${clock(u.startSec)}\` **${speakerName(u, t, names)}**: ${u.text}`);
    console.error(`Following #${id}; stops when the recording has ended and been processed.`);
    for (;;) {
      const m = meeting(id);
      const names = shownNames(m, t);
      for (const u of m.utterances.filter((u) => u.id > seen).sort((a, b) => a.id - b.id)) print(u, names);
      seen = Math.max(seen, ...m.utterances.map((u) => u.id));
      // The last lines are written while the stopped meeting is processed.
      if (m.status !== "recording" && m.status !== "processing") break;
      await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
    }
    break;
  }
  default:
    fail(`Unknown command "${command}".\n\n${HELP}`);
}
