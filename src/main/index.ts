import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, protocol, session, shell, systemPreferences } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GPT_LIVE_MODEL, GPT_LIVE_TAIL_MS, IMPORT_CHUNK_SEC, LIVE_TEST_ID, type LiveEvent } from "../shared/types";
import type {
  AppInfo,
  AudioRef,
  Chunk,
  ConnectionRole,
  KeyName,
  LibraryOp,
  LibraryView,
  MenuSpec,
  ModelRole,
  ImportProgress,
  StorageInfo,
  Summary,
  Settings,
  StoredSettings,
  Track,
} from "../shared/types";
import { INTL_LOCALE, translator, type Locale } from "../shared/i18n";
import { meetingDocument, summaryMarkdown } from "../shared/summary";
import { joinSplitSentences } from "../shared/transcript";
import { glossaryPrompt, isPromptEcho, splitUtterances, summarize, testConnection, transcribeFile } from "./ai";
import { openDb } from "./db";
import { History, perform } from "./library";
import { diarize, ensureModels } from "./diarize";
import { speakerTurns } from "./speakers";
import { LiveCaptions, openLiveStream } from "./live";
import { appMenu } from "./menu";
import { listModels } from "./models";
import { openSettings } from "./settings";
import { CHUNK_FILE, playbackResponse } from "./playback";
import { SAMPLE_RATE, toFloat32, toWav } from "./wav";

// Pinned to the original name so meetings and keys survive any change to the display name.
// Unpackaged runs (pnpm dev) get their own folder so they never touch the installed app's data.
const dataDir = path.join(app.getPath("appData"), app.isPackaged ? "Seogi" : "Seogi-dev");
app.setPath("userData", dataDir);
const audioDir = path.join(dataDir, "meetings");
const modelsDir = path.join(dataDir, "models");
let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

/** Every window hears library and live-caption events (the settings window runs its own test). */
const broadcast = (channel: string, ...args: unknown[]) =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args));

// Playback chunks are served to the renderer as seogi-audio://audio/<meetingId>/<file>.
const AUDIO_SCHEME = "seogi-audio";
/** Imported files are transcribed this many turns at once. */
const IMPORT_PARALLEL = 5;
/** Audio added either side of a speaker turn before it is transcribed. */
const TURN_PAD_SEC = 0.2;
/** How far before a line's time its playback starts. */
const PLAYBACK_LEAD_SEC = 1;
protocol.registerSchemesAsPrivileged([
  { scheme: AUDIO_SCHEME, privileges: { stream: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  const settings = await openSettings(dataDir);
  /** Messages in the UI language the user picked; read each time so a change applies at once. */
  const tr = () => translator(settings.get().locale);
  const db = openDb(path.join(dataDir, "seogi.db"), tr()("error.appQuit"));
  const history = new History();
  const notify = (id: number) => broadcast("meeting-changed", id);
  function storeUtterances(id: number, track: Track, segments: Parameters<typeof db.addUtterances>[2]) {
    const rows = db.addUtterances(id, track, segments);
    if (rows.length) win?.webContents.send("utterances-added", id, rows);
  }
  let menuState: { disabled: Set<string>; labels: Record<string, string> } = { disabled: new Set(), labels: {} };
  const rebuildMenu = () =>
    Menu.setApplicationMenu(appMenu(history, sendAction, openSettingsWindow, tr(), menuState.disabled, menuState.labels));
  ipcMain.on("menuState", (_e, disabled: string[], labels: Record<string, string>) => {
    const same =
      disabled.length === menuState.disabled.size &&
      disabled.every((id) => menuState.disabled.has(id)) &&
      JSON.stringify(labels) === JSON.stringify(menuState.labels);
    if (same) return;
    menuState = { disabled: new Set(disabled), labels };
    rebuildMenu();
  });
  /** -1: a library change (folders, stars, deletes) that any list may show. */
  const libraryChanged = () => {
    notify(-1);
    rebuildMenu();
  };

  // Deleted meetings stay restorable (⌘Z) until quit; then rows and audio go for good.
  const purge = () => {
    for (const id of db.purgeDeleted()) rmSync(path.join(audioDir, String(id)), { recursive: true, force: true });
  };
  purge();
  app.on("before-quit", purge);

  /** `tailMs`: how long a stop waits for captions the renderer still sends (GPT-Live). */
  const live = new Map<number, { captions: LiveCaptions; tailMs: number }>();
  const sendLive = (id: number) => broadcast("live", id, live.get(id)?.captions.view() ?? { lines: [], error: null });

  /**
   * Live captions are the meeting record: each finished segment is stored as it comes. The settings
   * test (LIVE_TEST_ID) stores nothing. `override` picks another live model for that test.
   */
  function startLive(id: number, override?: Settings["live"]) {
    const s = settings.get();
    const { provider, model } = override ?? { provider: s.live.provider, model: liveModelFor(id) };
    const glossary = glossaryFor(id);
    const language = s.language === "auto" ? undefined : s.language;
    // Whisper models take no prompt (qgrid rejects it for gpt-realtime-whisper).
    const prompt = glossary.trim() && !model.includes("whisper") ? glossaryPrompt(s.language, glossary) : undefined;
    // GPT-Live runs over WebRTC in the renderer, which sends its events here (liveEvent).
    const rendererDriven = provider === "qgrid" && model === GPT_LIVE_MODEL;
    const captions = new LiveCaptions(
      (onEvent) =>
        openLiveStream(
          provider === "qgrid"
            ? { provider: "qgrid", url: s.qgridUrl, model, language, prompt, t: tr() }
            : { provider: "openai", apiKey: settings.key("openai"), model, language, prompt, t: tr() },
          onEvent,
        ),
      () => sendLive(id),
      id === LIVE_TEST_ID
        ? null
        : (track, segment) => {
            // GPT-Live gets no transcription prompt, so it has nothing to echo.
            if (prompt && !rendererDriven && isPromptEcho(segment.text, prompt)) return;
            storeUtterances(id, track, [segment]);
          },
    );
    live.set(id, { captions, tailMs: rendererDriven ? GPT_LIVE_TAIL_MS + 1000 : 0 });
  }

  /** A session's glossary overrides the shared one; the settings test uses the shared one. */
  function glossaryFor(id: number) {
    return (id !== LIVE_TEST_ID && db.sessionOptions(id).glossary) || settings.get().glossary;
  }
  function liveModelFor(id: number) {
    return (id !== LIVE_TEST_ID && db.sessionOptions(id).liveModel) || settings.get().live.model;
  }

  /** Audio is kept for playback only; the transcript comes from the live captions. */
  function saveChunk(chunk: Chunk) {
    const { meetingId, track, startSec } = chunk;
    const dir = path.join(audioDir, String(meetingId));
    mkdirSync(dir, { recursive: true });
    const name = `${track}-${startSec.toFixed(1)}`;
    if ("ogg" in chunk) writeFileSync(path.join(dir, name + ".ogg"), chunk.ogg);
    else writeFileSync(path.join(dir, name + ".wav"), toWav(chunk.pcm));
  }

  /** Stops a meeting's captions once they have stored the last words; resolves the drops seen. */
  async function stopLive(id: number) {
    const entry = live.get(id);
    if (!entry) return 0;
    await entry.captions.stop(entry.tailMs);
    live.delete(id);
    sendLive(id);
    return entry.captions.drops;
  }

  /** Ends a recording once its last captions are stored; summarizing is a separate step. */
  async function finish(id: number) {
    db.setStatus(id, "processing");
    notify(id);
    const drops = await stopLive(id);
    if (db.hasUtterances(id))
      db.setStatus(id, "done", drops ? tr()("error.captionsDropped", { n: drops }) : null);
    else db.setStatus(id, "error", tr()("error.nothingTranscribed"));
    notify(id);
  }

  /** Writes the summary on request, with `model` or the one in Settings. */
  async function summarizeMeeting(id: number, model?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const m = db.getMeeting(id);
      if (!m?.utterances.length) throw new Error(tr()("error.nothingTranscribed"));
      const transcript = joinSplitSentences(m.utterances)
        .map((u) => `[${clock(u.startSec)}] ${u.speaker ? `Speaker ${u.speaker}` : u.track === "mic" ? "Me" : "Others"}: ${u.text}`)
        .join("\n");
      const s = await summarize(settings, transcript, glossaryFor(id), model);
      db.setSummary(id, s.title, summaryMarkdown(s, tr()));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      notify(id);
    }
  }

  // Summaries saved as the model's JSON before they became editable Markdown.
  for (const { id, json } of db.legacySummaries()) {
    const s = JSON.parse(json) as Summary;
    db.setSummaryText(id, summaryMarkdown(s, tr()));
  }

  ipcMain.handle("listMeetings", (_e, view: LibraryView, query?: string) => db.listMeetings(view, query));
  ipcMain.handle("library", () => ({ counts: db.counts(), folders: db.listFolders() }));
  ipcMain.handle("perform", (_e, op: LibraryOp) => {
    const result = perform(db, history, op, tr());
    if (result.ok) libraryChanged();
    return result;
  });
  for (const kind of ["undo", "redo"] as const)
    ipcMain.handle(kind, () => {
      const label = history[kind](tr());
      if (label) libraryChanged();
      return label;
    });
  ipcMain.handle("showMenu", (e, items: MenuSpec[]) => popupMenu(e.sender, items));
  ipcMain.on("openSettings", () => openSettingsWindow());
  ipcMain.handle("accentColor", accentColor);
  ipcMain.handle("getMeeting", (_e, id: number) => db.getMeeting(id));
  ipcMain.handle("createMeeting", (_e, folderId?: number | null) => {
    const { locale } = settings.get();
    const date = new Date().toLocaleString(INTL_LOCALE[locale], { dateStyle: "short", timeStyle: "short" });
    const id = db.createMeeting(translator(locale)("meeting.defaultTitle", { date }), folderId ?? null);
    notify(id);
    return id;
  });
  ipcMain.handle("startMeeting", (_e, id: number) => {
    if (!db.startRecording(id)) return false;
    startLive(id);
    notify(id);
    return true;
  });
  // An audio file dropped on an unrecorded session, decoded by the renderer to 16 kHz mono. It is
  // one mixed track, kept as "system" (the other side), since nobody in it is the person at this
  // Mac. Speakers are told apart first and each speaker turn is transcribed on its own, so every
  // line gets its voice and the time that voice started; without diarization (no models, no
  // network) it falls back to plain 30 s windows with no speakers.
  const importProgress = (id: number, p: ImportProgress | null) => broadcast("import-progress", id, p);
  let loadingModels: ReturnType<typeof ensureModels> | undefined;
  async function importFile(id: number, pcm: Int16Array, language: string, ogg: (Uint8Array | null)[]) {
    const durationSec = pcm.length / SAMPLE_RATE;
    const chunkSamples = IMPORT_CHUNK_SEC * SAMPLE_RATE;
    for (let at = 0; at < pcm.length; at += chunkSamples) {
      const encoded = ogg[at / chunkSamples];
      const data = encoded ? { ogg: encoded } : { pcm: pcm.subarray(at, at + chunkSamples) };
      saveChunk({ meetingId: id, track: "system", startSec: at / SAMPLE_RATE, ...data });
    }

    let turns: { start: number; end: number; speaker?: number }[];
    try {
      importProgress(id, { phase: "models" });
      const models = await (loadingModels ??= ensureModels(modelsDir).finally(() => { loadingModels = undefined; }));
      importProgress(id, { phase: "speakers" });
      turns = speakerTurns(await diarize(toFloat32(pcm), models));
    } catch (e) {
      console.warn("[seogi] diarization unavailable, importing without speakers:", e);
      turns = [];
      for (let t = 0; t < durationSec; t += IMPORT_CHUNK_SEC) turns.push({ start: t, end: Math.min(durationSec, t + IMPORT_CHUNK_SEC) });
    }

    let done = 0;
    let error: string | null = null;
    const glossary = glossaryFor(id);
    const worker = async () => {
      for (let turn = turns.shift(); turn; turn = turns.shift()) {
        // A little audio either side, so the first and last words are not clipped.
        const from = Math.max(0, Math.floor((turn.start - TURN_PAD_SEC) * SAMPLE_RATE));
        const to = Math.min(pcm.length, Math.ceil((turn.end + TURN_PAD_SEC) * SAMPLE_RATE));
        try {
          const t = await transcribeFile(settings, toWav(pcm.subarray(from, to)), glossary, language);
          if (t.text)
            storeUtterances(
              id,
              "system",
              splitUtterances(t, from / SAMPLE_RATE, (to - from) / SAMPLE_RATE).map((u) => ({ ...u, speaker: turn.speaker })),
            );
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        importProgress(id, { phase: "transcribe", done: ++done, total });
      }
    };
    const total = turns.length;
    importProgress(id, { phase: "transcribe", done, total });
    await Promise.all(Array.from({ length: IMPORT_PARALLEL }, worker));
    db.finishImport(id, durationSec, error);
    importProgress(id, null);
    notify(id);
  }
  ipcMain.handle("importFile", (_e, id: number, pcm: Int16Array, language: string, ogg: (Uint8Array | null)[]) => {
    if (!db.startImport(id)) return false;
    notify(id);
    void importFile(id, pcm, language, ogg);
    return true;
  });
  ipcMain.on("transcribeOpening", async (_e, id: number, track: Track, pcm: Int16Array) => {
    try {
      const t = await transcribeFile(settings, toWav(pcm), glossaryFor(id));
      if (t.text) storeUtterances(id, track, splitUtterances(t, 0, pcm.length / SAMPLE_RATE));
    } catch (e) {
      console.warn("[seogi] opening audio not transcribed:", e);
    }
  });
  ipcMain.handle("abortMeeting", async (_e, id: number) => {
    await stopLive(id);
    db.setStatus(id, "new");
    notify(id);
  });
  ipcMain.handle("startLiveTest", (_e, model?: Settings["live"]) => {
    void live.get(LIVE_TEST_ID)?.captions.stop();
    startLive(LIVE_TEST_ID, model);
    sendLive(LIVE_TEST_ID);
  });
  // The test's lines stay on screen after it stops, so its captions are not dropped here.
  ipcMain.handle("stopLiveTest", async () => {
    const entry = live.get(LIVE_TEST_ID);
    await entry?.captions.stop(entry.tailMs);
  });
  ipcMain.on("liveAudio", (_e, id: number, track: Track, pcm: Int16Array) => live.get(id)?.captions.audio(track, pcm));
  ipcMain.on("liveEvent", (_e, id: number, track: Track, event: LiveEvent) => live.get(id)?.captions.onEvent(track, event));
  ipcMain.handle("setSessionOptions", (_e, id: number, o: { liveModel?: string | null; glossary?: string }) => {
    db.setSessionOptions(id, o);
    notify(id);
  });
  ipcMain.handle("liveCall", async (_e, sdp: string, meetingId: number) => {
    try {
      const res = await fetch(`${settings.get().qgridUrl.replace(/\/$/, "")}/api/qgrid/liveCall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          params: {
            sdp,
            instructions: gptLiveInstructions(settings.get().language, glossaryFor(meetingId)),
            projectName: "seogi",
            // ponytail: not logged in qgrid, like the other caption streams; turn on to see usage there.
            logger: false,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `qgrid ${res.status}`);
      return { ok: true, sdp: String(body.sdp) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.on("sendChunk", (_e, chunk: Chunk) => saveChunk(chunk));
  ipcMain.handle("stopMeeting", (_e, id: number) => {
    // Only a real stop fixes the length; a resummary of an older meeting must not stamp "now".
    db.setEnded(id);
    return finish(id);
  });
  ipcMain.handle("summarize", (_e, id: number, model?: string) => summarizeMeeting(id, model));
  ipcMain.handle("setSummaryText", (_e, id: number, markdown: string) => db.setSummaryText(id, markdown));
  ipcMain.handle("exportMeeting", async (_e, id: number, format: "md" | "txt") => {
    const m = db.getMeeting(id);
    if (!m || !win) return false;
    const { locale } = settings.get();
    const date = new Date(m.startedAt).toLocaleString(INTL_LOCALE[locale], { dateStyle: "long", timeStyle: "short" });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${m.title.replace(/[/:\\]/g, "-")}.${format}`,
      filters: [format === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "Plain Text", extensions: ["txt"] }],
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, meetingDocument(m, format, tr(), date));
    return true;
  });
  ipcMain.handle("markOpened", (_e, id: number) => db.setOpened(id, true));
  ipcMain.handle("audioFor", (_e, id: number, track: Track, startSec: number): AudioRef | null => {
    const dir = path.join(audioDir, String(id));
    if (!existsSync(dir)) return null;
    // The chunk that contains startSec is the last one of this track starting at or before it.
    let best: { file: string; start: number } | null = null;
    for (const file of readdirSync(dir)) {
      const m = CHUNK_FILE.exec(file);
      if (!m || m[1] !== track) continue;
      const start = Number(m[2]);
      if (start <= startSec + 0.05 && (!best || start > best.start)) best = { file, start };
    }
    // Caption times run up to a second behind the speech, so playback starts a little early.
    return (
      best && {
        url: `${AUDIO_SCHEME}://audio/${id}/${best.file}`,
        offsetSec: Math.max(0, startSec - PLAYBACK_LEAD_SEC - best.start),
        chunkStartSec: best.start,
      }
    );
  });
  protocol.handle(AUDIO_SCHEME, (req) => {
    const [, id, file] = new URL(req.url).pathname.split("/");
    if (!/^\d+$/.test(id ?? "") || !CHUNK_FILE.test(file ?? "")) return new Response(null, { status: 404 });
    const full = path.join(audioDir, id, file);
    if (!existsSync(full)) return new Response(null, { status: 404 });
    return playbackResponse(readFileSync(full), file, req.headers.get("range"));
  });
  ipcMain.handle("getSettings", () => settings.view());
  ipcMain.handle("patchSettings", (_e, patch: Partial<StoredSettings>) => {
    const before: Locale = settings.get().locale;
    const view = settings.patch(patch);
    if (view.locale !== before) {
      rebuildMenu();
      broadcast("locale", view.locale);
    }
    return view;
  });
  ipcMain.handle("setKey", (_e, name: KeyName, value: string) => settings.setKey(name, value));
  ipcMain.handle("testConnection", (_e, role: ConnectionRole) => testConnection(settings, role));
  ipcMain.handle("listModels", (_e, role: ModelRole, provider: string) => listModels(settings, role, provider));
  ipcMain.handle("storageInfo", (): StorageInfo => {
    const dbFiles = readdirSync(dataDir).filter((f) => f.startsWith("seogi.db"));
    const database = dbFiles.reduce((n, f) => n + statSync(path.join(dataDir, f)).size, 0);
    const audio = dirSize(audioDir);
    const models = dirSize(modelsDir);
    return { path: dataDir, bytes: audio + database + models, audio, database, models, meetings: db.counts().all };
  });
  ipcMain.handle("openDataFolder", () => shell.openPath(dataDir).then(() => undefined));
  ipcMain.handle("appInfo", (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `macOS ${process.getSystemVersion()}`,
  }));

  // getDisplayMedia in the renderer gets system audio through Core Audio tap (Electron 39+,
  // macOS 14.2+). Chromium requires a video source too; the renderer stops it immediately.
  // Without Screen & System Audio Recording permission getSources fails; answering with nothing
  // rejects getDisplayMedia, where an unanswered request would leave recording waiting forever.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const [screen] = await desktopCapturer.getSources({ types: ["screen"] });
      if (!screen) throw new Error("no screen source");
      callback({ video: screen, audio: "loopback" });
    } catch (e) {
      console.warn("[seogi] system audio unavailable:", e);
      // Electron has no explicit deny: an empty answer rejects getDisplayMedia but throws here too.
      try {
        callback({});
      } catch {
        // expected
      }
    }
  });

  // macOS accent colour (System Settings › Appearance) drives selection and default buttons.
  systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", () =>
    broadcast("accent-color", accentColor()),
  );

  rebuildMenu();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 520,
    title: "Seogi",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 22 },
    // The sidebar is translucent like Finder's; the content panes paint their own background.
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(import.meta.dirname, "../preload/index.cjs"), sandbox: true },
  });
  load(win);
  win.on("closed", () => (win = null));
});

app.on("window-all-closed", () => app.quit());

/**
 * GPT-Live is a conversational model; Seogi only wants its transcript of what people say. It has no
 * language setting, and without a hint it has written Korean speech out in Japanese (probe
 * 2026-11-19), so the meeting language and glossary go into its instructions.
 */
function gptLiveInstructions(language: string, glossary: string) {
  const name = { ko: "Korean", en: "English", ja: "Japanese" }[language];
  return [
    "You are listening to a meeting only so it can be transcribed. Stay completely silent: never speak, never answer, never ask anything, and never hand anything off.",
    name && `The meeting is in ${name}. Transcribe what people say in ${name}, exactly as spoken; do not translate.`,
    glossary.trim() && `Names and terms that come up: ${glossary.trim()}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function load(w: BrowserWindow, hash?: string) {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash ? `#${hash}` : ""}`);
  else void w.loadFile(path.join(import.meta.dirname, "../renderer/index.html"), { hash });
}

/** macOS-style settings window: one instance, toolbar tabs, no zoom or full screen. */
function openSettingsWindow() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: "Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(import.meta.dirname, "../preload/index.cjs"), sandbox: true },
  });
  load(settingsWin, "settings");
  settingsWin.on("closed", () => (settingsWin = null));
}

/**
 * App-menu commands run in the main window, which owns the action list; undo and redo go to the
 * focused window so typing in the settings window can be undone there.
 */
function sendAction(id: string) {
  const edit = id === "undo" || id === "redo";
  const target = edit ? (BrowserWindow.getFocusedWindow() ?? win) : win;
  if (!edit && target && !target.isFocused()) target.focus();
  target?.webContents.send("menu-action", id);
}

function accentColor() {
  return `#${systemPreferences.getAccentColor().slice(0, 6)}`;
}

/** A native context menu built from the renderer's spec; resolves to the chosen id. */
function popupMenu(sender: Electron.WebContents, items: MenuSpec[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (id: string | null) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };
    const build = (specs: MenuSpec[]): Electron.MenuItemConstructorOptions[] =>
      specs.map((s) =>
        "type" in s
          ? { type: "separator" }
          : "submenu" in s
            ? { label: s.label, submenu: build(s.submenu) }
            : {
                label: s.label,
                enabled: s.enabled ?? true,
                type: s.checked === undefined ? "normal" : "checkbox",
                checked: s.checked,
                accelerator: s.accelerator,
                registerAccelerator: false,
                click: () => done(s.id),
              },
      );
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    // The close callback can run before the click handler, so it only settles a dismissal, later.
    Menu.buildFromTemplate(build(items)).popup({ window, callback: () => setTimeout(() => done(null), 200) });
  });
}

function clock(sec: number) {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    const p = path.join(dir, e.name);
    return n + (e.isDirectory() ? dirSize(p) : statSync(p).size);
  }, 0);
}
