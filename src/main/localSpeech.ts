import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LiveEvent } from "../shared/types";
import type { LiveStream } from "./live";

/**
 * Transcription on this Mac with macOS 26's SpeechAnalyzer, through the seogi-speech helper
 * (native/speech/main.swift). No account or download of ours: the system fetches the language.
 */
const helper = () =>
  app.isPackaged ? path.join(process.resourcesPath, "bin", "seogi-speech") : path.join(app.getAppPath(), "build", "bin", "seogi-speech");

/** The helper takes a locale; Seogi's languages are bare codes ("auto" follows the system). */
const LOCALES: Record<string, string> = { ko: "ko-KR", en: "en-US", ja: "ja-JP" };
const localeFor = (language: string) => LOCALES[language] ?? Intl.DateTimeFormat().resolvedOptions().locale;

/** Longest a stop waits for the last words before giving up on them. */
const STOP_WAIT_MS = 10_000;

type Result = { final?: boolean; text?: string; start?: number; end?: number; ready?: boolean; error?: string };

function run(mode: "live" | "files", language: string, terms: string[]) {
  return spawn(helper(), [mode, localeFor(language)], { env: { ...process.env, SEOGI_TERMS: JSON.stringify(terms) } });
}

/**
 * One track's live captions. A changing result is the stretch being spoken (it replaces the draft);
 * a final one finishes it, with the times of its audio.
 */
export function openLocalStream(language: string, terms: string[], emit: (e: LiveEvent) => void): LiveStream {
  const child = run("live", language, terms);
  let stretch = 0;
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    emit({ type: "error", message });
  };
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.on("error", (e) => fail(e.message));
  child.on("close", () => resolve());
  child.stdin.on("error", () => {}); // a helper that quit reports why on stdout
  createInterface({ input: child.stdout }).on("line", (line) => {
    let r: Result;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.error) return fail(r.error);
    if (r.text === undefined || r.start === undefined || r.end === undefined) return;
    const id = `l${stretch}`;
    if (r.final) {
      stretch++;
      emit({ type: "segment", id, text: r.text.trim(), startSec: r.start, endSec: r.end });
    } else emit({ type: "delta", id, text: r.text, atSec: r.end, replace: true });
  });
  return {
    audio(pcm) {
      if (!failed && child.stdin.writable) child.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), STOP_WAIT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Files go through one helper that answers in order; it stays for the next import piece. */
let files: { child: ChildProcessWithoutNullStreams; key: string; waiting: ((line: string | null) => void)[] } | undefined;

/** A WAV's transcript and its timed pieces. */
export async function transcribeLocalFile(wav: Uint8Array, language: string, terms: string[]): Promise<{ text: string; words: { text: string; startSecond: number; endSecond: number }[] }> {
  const key = `${language}|${terms.join(",")}`;
  if (!files || files.key !== key || files.child.exitCode !== null) {
    files?.child.kill();
    const child = run("files", language, terms);
    const waiting: ((line: string | null) => void)[] = [];
    child.stdin.on("error", () => {});
    child.on("error", () => waiting.splice(0).forEach((w) => w(null)));
    child.on("close", () => waiting.splice(0).forEach((w) => w(null)));
    createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(line));
    files = { child, key, waiting };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "seogi-"));
  const file = path.join(dir, "piece.wav");
  writeFileSync(file, wav);
  const line = await new Promise<string | null>((resolve) => {
    files!.waiting.push(resolve);
    files!.child.stdin.write(`${file}\n`);
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
  if (line === null) throw new Error("The on-device transcriber stopped.");
  const r: Result & { segments?: Result[] } = JSON.parse(line);
  if (r.error) throw new Error(r.error);
  return {
    text: r.text?.trim() ?? "",
    // Results come by stretch (often 15 s); its words are spread over its time so sentences get their own.
    words: (r.segments ?? []).flatMap((s) => {
      const words = (s.text ?? "").trim().split(/\s+/).filter(Boolean);
      const [from, to] = [s.start ?? 0, s.end ?? s.start ?? 0];
      return words.map((text, i) => ({ text, startSecond: from + ((to - from) * i) / words.length, endSecond: from + ((to - from) * (i + 1)) / words.length }));
    }),
  };
}
