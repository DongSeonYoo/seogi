import { app, BrowserWindow, desktopCapturer, ipcMain, nativeTheme, protocol, session, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppInfo, AudioRef, Chunk, ConnectionRole, KeyName, StorageInfo, StoredSettings, Track } from "../shared/types";
import { splitUtterances, summarize, testConnection, transcribeWav } from "./ai";
import { openDb } from "./db";
import { openSettings } from "./settings";
import { toWav, SAMPLE_RATE } from "./wav";

const dataDir = app.getPath("userData");
const audioDir = path.join(dataDir, "meetings");
let win: BrowserWindow | null = null;

// Chunk WAVs are served to the renderer as seogi-audio://audio/<meetingId>/<file>.
const AUDIO_SCHEME = "seogi-audio";
const CHUNK_FILE = /^(mic|system)-(\d+(?:\.\d+)?)\.wav$/;
protocol.registerSchemesAsPrivileged([
  { scheme: AUDIO_SCHEME, privileges: { stream: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  const db = openDb(path.join(dataDir, "seogi.db"));
  const settings = openSettings(dataDir);
  const dbMeetings = () => db.listMeetings("").length;
  const notify = (id: number) => win?.webContents.send("meeting-changed", id);

  // Transcription requests in flight per meeting; stop waits for them before summarizing.
  const pending = new Map<number, Set<Promise<void>>>();
  const failures = new Map<number, { count: number; last: string }>();

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
      if (!t.text) return;
      db.addUtterances(meetingId, track, splitUtterances(t, startSec, pcm.length / SAMPLE_RATE));
    } catch (e) {
      const last = e instanceof Error ? e.message : String(e);
      const count = (failures.get(meetingId)?.count ?? 0) + 1;
      failures.set(meetingId, { count, last });
      // Shown while still recording, so a wrong key or model surfaces before the meeting ends.
      db.setError(meetingId, `전사 실패 ${count}건: ${last}`);
      console.error(`[seogi] transcription failed (${track} @${startSec}s):`, e);
    }
    notify(meetingId);
  }

  async function finish(id: number) {
    db.setStatus(id, "processing");
    notify(id);
    await Promise.allSettled(pending.get(id) ?? []);
    pending.delete(id);
    const failed = failures.get(id);
    failures.delete(id);
    try {
      const m = db.getMeeting(id);
      if (!m?.utterances.length)
        throw new Error(`전사된 내용이 없습니다${failed ? ` (${failed.last})` : ""}`);
      const transcript = m.utterances
        .map((u) => `[${clock(u.startSec)}] ${u.track === "mic" ? "나" : "상대"}: ${u.text}`)
        .join("\n");
      db.setSummary(id, await summarize(settings, transcript));
      db.setOpened(id, false);
      db.setStatus(
        id,
        "done",
        failed ? `${failed.count}개 구간의 전사에 실패했습니다: ${failed.last}` : null,
      );
    } catch (e) {
      db.setStatus(id, "error", e instanceof Error ? e.message : String(e));
    }
    notify(id);
  }

  ipcMain.handle("listMeetings", (_e, q: string) => db.listMeetings(q));
  ipcMain.handle("getMeeting", (_e, id: number) => {
    const m = db.getMeeting(id);
    return m && { ...m, pendingChunks: pending.get(id)?.size ?? 0 };
  });
  ipcMain.handle("startMeeting", () => {
    const title = `회의 ${new Date().toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}`;
    return db.createMeeting(title);
  });
  ipcMain.on("sendChunk", (_e, chunk: Chunk) => {
    const set = pending.get(chunk.meetingId) ?? new Set();
    pending.set(chunk.meetingId, set);
    const p = handleChunk(chunk).finally(() => set.delete(p));
    set.add(p);
    notify(chunk.meetingId);
  });
  ipcMain.handle("stopMeeting", (_e, id: number) => finish(id));
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
  ipcMain.handle("patchSettings", (_e, patch: Partial<StoredSettings>) => settings.patch(patch));
  ipcMain.handle("setKey", (_e, name: KeyName, value: string) => settings.setKey(name, value));
  ipcMain.handle("testConnection", (_e, role: ConnectionRole) => testConnection(settings, role));
  ipcMain.handle("storageInfo", (): StorageInfo => {
    const db = readdirSync(dataDir).filter((f) => f.startsWith("seogi.db"));
    const bytes = dirSize(audioDir) + db.reduce((n, f) => n + statSync(path.join(dataDir, f)).size, 0);
    return { path: dataDir, bytes, meetings: dbMeetings() };
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

  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    title: "Seogi",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    // Matches --color-chrome so the window never flashes white before CSS loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1c1a" : "#f3f1eb",
    webPreferences: { preload: path.join(import.meta.dirname, "../preload/index.cjs"), sandbox: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
});

app.on("window-all-closed", () => app.quit());

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
