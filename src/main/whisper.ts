import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LiveEvent } from "../shared/types";
import { CommitPolicy, LONG_SEC, quietestCut, type LiveStream } from "./live";
import { toWav } from "./wav";

/**
 * Whisper on this Mac: whisper.cpp's server (built by scripts/build-whisper.sh, Metal) with
 * large-v3-turbo, downloaded once from Settings. Live captions come a stretch at a time, cut at
 * pauses: Whisper reads whole stretches, it does not stream. On the lab meeting (seogi-lab/stt) it
 * was as accurate as GPT-Live; the compressed q5_0 model was clearly worse, so it is not offered.
 */
export const WHISPER_MODEL = {
  file: "ggml-large-v3-turbo.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  bytes: 1_624_555_275,
};

const binary = () =>
  app.isPackaged ? path.join(process.resourcesPath, "bin", "whisper-server") : path.join(app.getAppPath(), "build", "bin", "whisper-server");

/** The data folder's models directory, set once at startup. */
let modelsDir = "";
export const setWhisperDir = (dir: string) => void (modelsDir = dir);
const whisperModelPath = () => path.join(modelsDir, WHISPER_MODEL.file);
export const whisperReady = () => existsSync(whisperModelPath());

/** Downloads the model, reporting the fraction done; a second call while one runs joins it. */
let downloading: Promise<void> | undefined;
export function downloadWhisper(progress: (done: number) => void): Promise<void> {
  return (downloading ??= (async () => {
    mkdirSync(modelsDir, { recursive: true });
    const part = `${whisperModelPath()}.part`;
    try {
      const res = await fetch(WHISPER_MODEL.url);
      if (!res.ok || !res.body) throw new Error(`Whisper model download failed: ${res.status}`);
      const total = Number(res.headers.get("content-length")) || WHISPER_MODEL.bytes;
      let got = 0;
      let shown = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          got += chunk.length;
          if (got - shown > total / 200) progress((shown = got) / total);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(part));
      renameSync(part, whisperModelPath());
      progress(1);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
  })().finally(() => (downloading = undefined)));
}

/** One server for the app, started on first use with the model loaded; it stays until quit. */
let server: { url: Promise<string>; child?: ChildProcess } | undefined;
function serverUrl(): Promise<string> {
  if (server && (!server.child || server.child.exitCode === null)) return server.url;
  if (!whisperReady()) return Promise.reject(new Error("The Whisper model is not downloaded (Settings › Transcription)."));
  const s: { url: Promise<string>; child?: ChildProcess } = { url: Promise.resolve("") };
  s.url = (async () => {
    const port = await freePort();
    const child = (s.child = spawn(binary(), ["-m", whisperModelPath(), "--host", "127.0.0.1", "--port", String(port), "-t", "4"], { stdio: "ignore" }));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error("Whisper could not start.");
      if (await fetch(base).then(() => true, () => false)) return base;
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error("Whisper did not start in time.");
  })();
  s.url.catch(() => {
    if (server === s) server = undefined;
  });
  return (server = s).url;
}
export const stopWhisper = () => server?.child?.kill();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

type Segment = { text: string; start: number; end: number };

/**
 * Whisper writes in the style of its prompt: a bare list of terms made it drop sentence ends, so
 * the terms go inside a sentence.
 */
export function whisperPrompt(language: string, terms: string[]) {
  if (!terms.length) return "";
  // A "Terms:" label leaked into the text ("용어: 그렇게 많을…"); a plain sentence did not.
  return language === "ko" ? `${terms.join(", ")} 같은 말이 나오는 회의입니다.` : `A meeting where words like ${terms.join(", ")} come up.`;
}

/** A WAV's transcript and its timed pieces; `prompt` (glossary terms) steers the spelling. */
export async function transcribeWhisper(wav: Uint8Array, language: string, prompt = "") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "piece.wav");
  form.append("response_format", "verbose_json");
  form.append("language", language === "auto" ? "auto" : language);
  if (prompt) form.append("prompt", prompt);
  const res = await fetch(`${await serverUrl()}/inference`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Whisper failed: ${res.status} ${await res.text()}`);
  const r: { text?: string; segments?: Segment[] } = await res.json();
  const segments = (r.segments ?? []).map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
  return {
    text: segments.map((s) => s.text).join(" "),
    words: segments.map((s) => ({ text: s.text, startSecond: s.start, endSecond: s.end })),
  };
}

/** One track's live captions: each stretch of speech, cut at a pause, read whole when it ends. */
export function openWhisperStream(language: string, prompt: string, emit: (e: LiveEvent) => void): LiveStream {
  void serverUrl().catch(() => {}); // load the model while the first words are said
  const policy = new CommitPolicy();
  let pcm = new Int16Array(0); // the stretch being gathered
  let from = 0; // its first sample
  let n = 0;
  let queue = Promise.resolve();
  const send = (upTo = pcm.length) => {
    const piece = pcm.slice(0, upTo);
    const [startSec, endSec] = [from / 16000, (from + upTo) / 16000];
    const id = `w${n++}`;
    pcm = pcm.slice(upTo);
    from += upTo;
    queue = queue
      .then(() => transcribeWhisper(toWav(piece), language, prompt))
      .then((r) =>
        r.words.forEach((w, k) =>
          emit({ type: "segment", id: `${id}:${k}`, text: w.text, startSec: startSec + w.startSecond, endSec: Math.min(endSec, startSec + w.endSecond) }),
        ),
      )
      .catch((e) => emit({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  return {
    audio(chunk) {
      const grown = new Int16Array(pcm.length + chunk.length);
      grown.set(pcm);
      grown.set(chunk, pcm.length);
      pcm = grown;
      const decision = policy.push(chunk);
      if (decision === "commit") {
        policy.reset();
        send();
      } else if (decision === "clear") {
        policy.reset();
        from += pcm.length;
        pcm = new Int16Array(0);
      } else if (pcm.length >= LONG_SEC * 16000) send(quietestCut(pcm));
    },
    async stop() {
      if (policy.hasSpeech && pcm.length) send();
      await queue;
    },
  };
}
