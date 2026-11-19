import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, protocol, session, shell, systemPreferences } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GPT_LIVE_MODEL, LIVE_TEST_ID, type LiveEvent } from "../shared/types";
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
  StorageInfo,
  StoredSettings,
  Track,
} from "../shared/types";
import { INTL_LOCALE, translator, type Locale } from "../shared/i18n";
import { joinSplitSentences } from "../shared/transcript";
import { glossaryPrompt, splitUtterances, summarize, testConnection, transcribeWav } from "./ai";
import { openDb } from "./db";
import { History, perform } from "./library";
import { LiveCaptions, openLiveStream } from "./live";
import { appMenu } from "./menu";
import { listModels } from "./models";
import { openSettings } from "./settings";
import { toWav, SAMPLE_RATE } from "./wav";

// Pinned to the original name so meetings and keys survive any change to the display name.
// Unpackaged runs (pnpm dev) get their own folder so they never touch the installed app's data.
const dataDir = path.join(app.getPath("appData"), app.isPackaged ? "Seogi" : "Seogi-dev");
app.setPath("userData", dataDir);
const audioDir = path.join(dataDir, "meetings");
let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

/** Every window hears library and live-caption events (the settings window runs its own test). */
const broadcast = (channel: string, ...args: unknown[]) =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args));

// Chunk WAVs are served to the renderer as seogi-audio://audio/<meetingId>/<file>.
const AUDIO_SCHEME = "seogi-audio";
const CHUNK_FILE = /^(mic|system)-(\d+(?:\.\d+)?)\.wav$/;
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
  /** -1: a library change (folders, stars, deletes) that any list may show. */
  const libraryChanged = () => {
    notify(-1);
    Menu.setApplicationMenu(appMenu(history, sendAction, openSettingsWindow, tr()));
  };

  // Deleted meetings stay restorable (⌘Z) until quit; then rows and audio go for good.
  const purge = () => {
    for (const id of db.purgeDeleted()) rmSync(path.join(audioDir, String(id)), { recursive: true, force: true });
  };
  purge();
  app.on("before-quit", purge);

  // Transcription requests in flight per meeting; stop waits for them before summarizing.
  const pending = new Map<number, Set<Promise<void>>>();
  const failures = new Map<number, { count: number; last: string }>();
  const live = new Map<number, LiveCaptions>();
  const sendLive = (id: number) => broadcast("live", id, live.get(id)?.view() ?? { lines: [], error: null });

  function startLive(id: number) {
    const s = settings.get();
    const { provider, model } = s.live;
    const language = s.language === "auto" ? undefined : s.language;
    // Whisper models take no prompt (qgrid rejects it for gpt-realtime-whisper).
    const prompt = s.glossary.trim() && !model.includes("whisper") ? glossaryPrompt(s.language, s.glossary) : undefined;
    // GPT-Live runs over WebRTC in the renderer, which sends its events here (liveEvent).
    const rendererDriven = provider === "qgrid" && model === GPT_LIVE_MODEL;
    const captions = new LiveCaptions(
      (onEvent) =>
        rendererDriven
          ? { audio() {}, stop() {} }
          : openLiveStream(
          provider === "qgrid"
            ? { provider: "qgrid", url: s.qgridUrl, model, language, prompt, t: tr() }
            : { provider: "openai", apiKey: settings.key("openai"), model, language, prompt, t: tr() },
          onEvent,
        ),
      () => sendLive(id),
    );
    live.set(id, captions);
  }

  // ponytail: one global limit of 3 concurrent transcriptions; per-provider limits if needed.
  let running = 0;
  const waiters: (() => void)[] = [];
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    while (running >= 3) await new Promise<void>((r) => waiters.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiters.shift()?.();
    }
  }

  async function handleChunk({ meetingId, track, startSec, pcm }: Chunk) {
    const wav = toWav(pcm);
    const dir = path.join(audioDir, String(meetingId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${track}-${startSec.toFixed(1)}.wav`), wav);
    try {
      const t = await limited(() => transcribeWav(settings, wav));
      const chunkSec = pcm.length / SAMPLE_RATE;
      if (t.text) db.addUtterances(meetingId, track, splitUtterances(t, startSec, chunkSec));
      live.get(meetingId)?.settle(track, startSec, startSec + chunkSec);
    } catch (e) {
      const last = e instanceof Error ? e.message : String(e);
      const count = (failures.get(meetingId)?.count ?? 0) + 1;
      failures.set(meetingId, { count, last });
      // Shown while still recording, so a wrong key or model surfaces before the meeting ends.
      db.setError(meetingId, tr()("error.transcriptionFailed", { n: count, error: last }));
      console.error(`[seogi] transcription failed (${track} @${startSec}s):`, e);
    }
    notify(meetingId);
  }

  async function finish(id: number) {
    db.setStatus(id, "processing");
    notify(id);
    live.get(id)?.stop();
    await Promise.allSettled(pending.get(id) ?? []);
    pending.delete(id);
    // Every chunk has its final transcript now; drafts that never settled belong to failed chunks.
    live.delete(id);
    sendLive(id);
    const failed = failures.get(id);
    failures.delete(id);
    try {
      const m = db.getMeeting(id);
      if (!m?.utterances.length)
        throw new Error(`${tr()("error.nothingTranscribed")}${failed ? ` (${failed.last})` : ""}`);
      const transcript = joinSplitSentences(m.utterances)
        .map((u) => `[${clock(u.startSec)}] ${u.track === "mic" ? "Me" : "Others"}: ${u.text}`)
        .join("\n");
      db.setSummary(id, await summarize(settings, transcript));
      db.setOpened(id, false);
      db.setStatus(
        id,
        "done",
        failed ? tr()("error.someChunksFailed", { n: failed.count, error: failed.last }) : null,
      );
    } catch (e) {
      db.setStatus(id, "error", e instanceof Error ? e.message : String(e));
    }
    notify(id);
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
      const label = history[kind]();
      if (label) libraryChanged();
      return label;
    });
  ipcMain.handle("showMenu", (e, items: MenuSpec[]) => popupMenu(e.sender, items));
  ipcMain.on("openSettings", () => openSettingsWindow());
  ipcMain.handle("accentColor", accentColor);
  ipcMain.handle("getMeeting", (_e, id: number) => {
    const m = db.getMeeting(id);
    return m && { ...m, pendingChunks: pending.get(id)?.size ?? 0 };
  });
  ipcMain.handle("startMeeting", (_e, folderId?: number | null) => {
    const { locale } = settings.get();
    const date = new Date().toLocaleString(INTL_LOCALE[locale], { dateStyle: "short", timeStyle: "short" });
    const title = translator(locale)("meeting.defaultTitle", { date });
    const id = db.createMeeting(title, folderId ?? null);
    startLive(id);
    notify(id);
    return id;
  });
  ipcMain.handle("startLiveTest", () => {
    live.get(LIVE_TEST_ID)?.stop();
    startLive(LIVE_TEST_ID);
    sendLive(LIVE_TEST_ID);
  });
  ipcMain.handle("stopLiveTest", () => live.get(LIVE_TEST_ID)?.stop());
  ipcMain.on("liveAudio", (_e, id: number, track: Track, pcm: Int16Array) => live.get(id)?.audio(track, pcm));
  ipcMain.on("liveEvent", (_e, id: number, track: Track, event: LiveEvent) => live.get(id)?.onEvent(track, event));
  ipcMain.handle("liveCall", async (_e, sdp: string) => {
    try {
      const res = await fetch(`${settings.get().qgridUrl.replace(/\/$/, "")}/api/qgrid/liveCall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          params: {
            sdp,
            instructions: gptLiveInstructions(settings.get().language, settings.get().glossary),
            projectName: "seogi",
            // Same as the other live captions: the chunk transcripts are what gets logged.
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
  ipcMain.on("sendChunk", (_e, chunk: Chunk) => {
    const set = pending.get(chunk.meetingId) ?? new Set();
    pending.set(chunk.meetingId, set);
    const p = handleChunk(chunk).finally(() => set.delete(p));
    set.add(p);
    notify(chunk.meetingId);
  });
  ipcMain.handle("stopMeeting", (_e, id: number) => {
    // Only a real stop fixes the length; a resummary of an older meeting must not stamp "now".
    db.setEnded(id);
    return finish(id);
  });
  ipcMain.handle("resummarize", (_e, id: number) => finish(id));
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
    return best && { url: `${AUDIO_SCHEME}://audio/${id}/${best.file}`, offsetSec: Math.max(0, startSec - best.start) };
  });
  protocol.handle(AUDIO_SCHEME, (req) => {
    const [, id, file] = new URL(req.url).pathname.split("/");
    if (!/^\d+$/.test(id ?? "") || !CHUNK_FILE.test(file ?? "")) return new Response(null, { status: 404 });
    // Whole file with its length: a streamed file: response has no duration and seeks unreliably.
    // Chunks are at most ~1 MB (35 s of 16 kHz PCM16).
    const full = path.join(audioDir, id, file);
    if (!existsSync(full)) return new Response(null, { status: 404 });
    const body = readFileSync(full);
    return new Response(body, {
      headers: { "content-type": "audio/wav", "content-length": String(body.byteLength) },
    });
  });
  ipcMain.handle("getSettings", () => settings.view());
  ipcMain.handle("patchSettings", (_e, patch: Partial<StoredSettings>) => {
    const before: Locale = settings.get().locale;
    const view = settings.patch(patch);
    if (view.locale !== before) {
      Menu.setApplicationMenu(appMenu(history, sendAction, openSettingsWindow, tr()));
      broadcast("locale", view.locale);
    }
    return view;
  });
  ipcMain.handle("setKey", (_e, name: KeyName, value: string) => settings.setKey(name, value));
  ipcMain.handle("testConnection", (_e, role: ConnectionRole) => testConnection(settings, role));
  ipcMain.handle("listModels", (_e, role: ModelRole, provider: string) => listModels(settings, role, provider));
  ipcMain.handle("storageInfo", (): StorageInfo => {
    const dbFiles = readdirSync(dataDir).filter((f) => f.startsWith("seogi.db"));
    const bytes = dirSize(audioDir) + dbFiles.reduce((n, f) => n + statSync(path.join(dataDir, f)).size, 0);
    return { path: dataDir, bytes, meetings: db.counts().all };
  });
  ipcMain.handle("openDataFolder", () => shell.openPath(dataDir).then(() => undefined));
  ipcMain.handle("appInfo", (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `macOS ${process.getSystemVersion()}`,
  }));

  // getDisplayMedia in the renderer gets system audio through Core Audio tap (Electron 39+,
  // macOS 14.2+). Chromium requires a video source too; the renderer stops it immediately.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const [screen] = await desktopCapturer.getSources({ types: ["screen"] });
    callback({ video: screen, audio: "loopback" });
  });

  // macOS accent colour (System Settings › Appearance) drives selection and default buttons.
  systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", () =>
    broadcast("accent-color", accentColor()),
  );

  Menu.setApplicationMenu(appMenu(history, sendAction, openSettingsWindow, tr()));
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
