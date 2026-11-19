import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, protocol, session, shell, systemPreferences } from "electron";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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
  Settings,
  StoredSettings,
  Track,
} from "../shared/types";
import { INTL_LOCALE, showStored, storedMessage, translator, type Locale } from "../shared/i18n";
import { meetingDocument, summaryMarkdown } from "../shared/summary";
import { joinSplitSentences } from "../shared/transcript";
import { glossaryPrompt, isPromptEcho, splitUtterances } from "./transcription";
import { openDb } from "./db";
import { History, perform } from "./library";
import { diarize } from "./diarize";
import { cleanModelDownloads, ensureModels } from "./modelFiles";
import { speakerTurns } from "./speakers";
import { LiveCaptions, openLiveStream } from "./live";
import { appMenu } from "./menu";
import { listModels } from "./models";
import { openSettings } from "./settings";
import { CHUNK_FILE, ChunkIndex, playbackResponse } from "./playback";
import { SAMPLE_RATE, toFloat32, toWav } from "./wav";

// Pinned to the original name so meetings and keys survive any change to the display name.
// Unpackaged runs (pnpm dev) get their own folder so they never touch the installed app's data.
const dataDir = path.join(app.getPath("appData"), app.isPackaged ? "Seogi" : "Seogi-dev");
app.setPath("userData", dataDir);
const audioDir = path.join(dataDir, "meetings");
const chunkIndex = new ChunkIndex();
const modelsDir = path.join(dataDir, "models");
let aiModule: Promise<typeof import("./ai")> | undefined;
const loadAI = () => aiModule ??= import("./ai");
let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

/** Shared settings and library events go to both windows. */
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
  const db = openDb(path.join(dataDir, "seogi.db"), storedMessage("error.appQuit"));
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
  const pendingAudio = db.purgeDeleted();
  async function removeAudio(ids: number[], quitting = false) {
    for (const id of ids) {
      try {
        const dir = path.join(audioDir, String(id));
        const options = { recursive: true, force: true };
        if (quitting) rmSync(dir, options);
        else await rm(dir, options);
        db.audioRemoved(id);
      } catch (error) {
        console.warn("[seogi] audio deletion will be retried:", id, error);
      }
    }
  }
  app.on("before-quit", () => void removeAudio(db.purgeDeleted(), true));

  /** `tailMs`: how long a stop waits for captions the renderer still sends (GPT-Live). */
  type LiveSession = {
    captions: LiveCaptions; tailMs: number; token?: number;
    openings: Set<Promise<void>>; abort: AbortController; openingError: string | null;
    stopping?: Promise<void>;
  };
  const live = new Map<number, LiveSession>();
  let testToken = 0;
  const sessionFor = (id: number, token?: number) => {
    const entry = live.get(id);
    return entry?.token === token ? entry : undefined;
  };
  function openSettingsWindow() {
    showSettingsWindow(() => {
      live.get(LIVE_TEST_ID)?.abort.abort();
      void stopLive(LIVE_TEST_ID);
    });
  }
  const sendLive = (id: number, token?: number) => {
    const entry = sessionFor(id, token);
    if (!entry) return;
    const view = entry.captions.view();
    if (entry.openingError) view.error = showStored(entry.openingError, tr());
    (id === LIVE_TEST_ID ? settingsWin : win)?.webContents.send("live", id, view, token);
  };

  /**
   * Live captions are the meeting record: each finished segment is stored as it comes. The settings
   * test (LIVE_TEST_ID) stores nothing. `override` picks another live model for that test.
   */
  function startLive(id: number, override?: Settings["live"], token?: number) {
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
      () => sendLive(id, token),
      id === LIVE_TEST_ID
        ? null
        : (track, segment) => {
            // GPT-Live gets no transcription prompt, so it has nothing to echo.
            if (prompt && !rendererDriven && isPromptEcho(segment.text, prompt)) return;
            storeUtterances(id, track, [segment]);
          },
    );
    live.set(id, {
      captions, token, tailMs: rendererDriven ? GPT_LIVE_TAIL_MS + 1000 : 0,
      openings: new Set(), abort: new AbortController(), openingError: null,
    });
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
    chunkIndex.invalidate(meetingId);
  }

  /** A provider can hang even after cancellation. Ignore its late result once the deadline passes. */
  async function drainOpenings(entry: LiveSession) {
    if (!entry.openings.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(entry.openings),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            entry.openingError = storedMessage("error.openingTimeout");
            entry.abort.abort();
            resolve();
          }, 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function stopLive(id: number) {
    const entry = live.get(id);
    if (!entry) return null;
    await (entry.stopping ??= Promise.all([entry.captions.stop(entry.tailMs), drainOpenings(entry)]).then(() => {
      if (live.get(id) !== entry) return;
      sendLive(id, entry.token);
      live.delete(id);
      if (id !== LIVE_TEST_ID) win?.webContents.send("live", id, { lines: [], error: null });
    }));
    return entry.openingError ?? entry.captions.lastGap ?? (entry.captions.drops ? storedMessage("error.captionsDropped", { n: entry.captions.drops }) : null);
  }

  /** Ends a recording once its last captions are stored; summarizing is a separate step. */
  async function finish(id: number) {
    db.setStatus(id, "processing");
    notify(id);
    const error = await stopLive(id);
    if (db.hasUtterances(id)) db.setStatus(id, "done", error);
    else db.setStatus(id, "error", error ?? storedMessage("error.nothingTranscribed"));
    notify(id);
  }

  /** Writes the summary on request, with `model` or the one in Settings. */
  async function summarizeMeeting(id: number, model?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const m = db.getMeeting(id);
      if (!m?.utterances.length) throw new Error(tr()("error.nothingTranscribed"));
      const transcript = joinSplitSentences(m.utterances);
      const { summarize } = await loadAI();
      const s = await summarize(settings, transcript, glossaryFor(id), model);
      db.setSummary(id, s.title, summaryMarkdown(s, tr()));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: showStored(e instanceof Error ? e.message : String(e), tr()) };
    } finally {
      notify(id);
    }
  }

  db.migrateSummaries(tr());

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
      const models = await (loadingModels ??= ensureModels(modelsDir).finally(() => {
        loadingModels = undefined;
        cleanModelDownloads(modelsDir);
      }));
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
          const { transcribeFile } = await loadAI();
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
  ipcMain.handle("transcribeOpening", async (_e, id: number, track: Track, pcm: Int16Array, token?: number) => {
    const entry = sessionFor(id, token);
    if (!entry || entry.stopping) return;
    const work = loadAI().then(({ transcribeFile }) =>
      transcribeFile(settings, toWav(pcm), glossaryFor(id), undefined, entry.abort.signal))
      .then((t) => {
        if (!t.text || live.get(id) !== entry || entry.abort.signal.aborted) return;
        const lines = splitUtterances(t, 0, pcm.length / SAMPLE_RATE);
        if (id !== LIVE_TEST_ID) return storeUtterances(id, track, lines);
        lines.forEach((line, i) => entry.captions.onEvent(track, {
          type: "segment", id: `opening-${i}`, ...line, endSec: lines[i + 1]?.startSec ?? pcm.length / SAMPLE_RATE,
        }));
      })
      .catch((e) => {
        if (entry.abort.signal.aborted) return;
        entry.openingError = storedMessage("error.openingAudio", { reason: e instanceof Error ? e.message : String(e) });
        sendLive(id, token);
      });
    entry.openings.add(work);
    try { await work; } finally { entry.openings.delete(work); }
  });
  ipcMain.handle("abortMeeting", async (_e, id: number) => {
    await stopLive(id);
    db.setStatus(id, "new");
    notify(id);
  });
  ipcMain.handle("startLiveTest", (_e, model?: Settings["live"]) => {
    const previous = live.get(LIVE_TEST_ID);
    previous?.abort.abort();
    void stopLive(LIVE_TEST_ID);
    const token = ++testToken;
    startLive(LIVE_TEST_ID, model, token);
    return token;
  });
  ipcMain.handle("stopLiveTest", async (_e, token: number) => {
    if (sessionFor(LIVE_TEST_ID, token)) await stopLive(LIVE_TEST_ID);
  });
  ipcMain.handle("liveView", (_e, id: number) => id === LIVE_TEST_ID ? null : live.get(id)?.captions.view() ?? null);
  ipcMain.on("liveAudio", (_e, id: number, track: Track, pcm: Int16Array, token?: number) => sessionFor(id, token)?.captions.audio(track, pcm));
  ipcMain.on("liveEvent", (_e, id: number, track: Track, event: LiveEvent, token?: number) => sessionFor(id, token)?.captions.onEvent(track, event));
  ipcMain.handle("setSessionOptions", (_e, id: number, o: { liveModel?: string | null; glossary?: string }) => {
    db.setSessionOptions(id, o);
    notify(id);
  });
  ipcMain.handle("liveCall", async (_e, sdp: string, meetingId: number, token?: number) => {
    const entry = sessionFor(meetingId, token);
    if (!entry || entry.stopping) return { ok: false, error: tr()("error.nothingTranscribed") };
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
        signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(15_000)]),
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
    const best = chunkIndex.find(audioDir, id, track, startSec);
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
    return playbackResponse(full, req.headers.get("range"));
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
  ipcMain.handle("testConnection", async (_e, role: ConnectionRole) => (await loadAI()).testConnection(settings, role));
  ipcMain.handle("listModels", (_e, role: ModelRole, provider: string) => listModels(settings, role, provider));
  ipcMain.handle("storageInfo", (): StorageInfo => {
    const dbFiles = readdirSync(dataDir).filter((f) => f.startsWith("seogi.db"));
    const database = dbFiles.reduce((n, f) => n + (statSync(path.join(dataDir, f), { throwIfNoEntry: false })?.size ?? 0), 0);
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
  win.once("ready-to-show", () => {
    void removeAudio(pendingAudio);
    if (!loadingModels) cleanModelDownloads(modelsDir);
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
function showSettingsWindow(onClose: () => void) {
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
  settingsWin.on("closed", () => {
    settingsWin = null;
    onClose();
  });
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

function dirSize(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
      const p = path.join(dir, e.name);
      return n + (e.isDirectory() ? dirSize(p) : statSync(p, { throwIfNoEntry: false })?.size ?? 0);
    }, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}
