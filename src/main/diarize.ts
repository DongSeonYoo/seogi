import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import workerPath from "./diarize-worker?modulePath";
import type { SpeakerSegment } from "./speakers.ts";

/**
 * Speaker diarization ("who spoke when") on this Mac with sherpa-onnx: pyannote segmentation 3.0
 * (MIT) and a 3D-Speaker ERes2Net embedding (Apache-2.0), downloaded once into the data folder.
 */
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const SEGMENTATION = { archive: `${RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, file: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx" };
const EMBEDDING = { url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, file: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" };
/**
 * How alike two voices must be to count as one speaker. Tried on a real 3-person discussion:
 * 0.8 found every speaker; 0.7 split one person in two. Synthetic voices differ more.
 */
const THRESHOLD = 0.8;

/** Fetches the two models into `dir` unless they are there; resolves to their paths. */
export async function ensureModels(dir: string) {
  const segmentation = path.join(dir, SEGMENTATION.file);
  const embedding = path.join(dir, EMBEDDING.file);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(segmentation)) {
    const archive = path.join(dir, "segmentation.tar.bz2");
    await download(SEGMENTATION.archive, archive);
    await promisify(execFile)("tar", ["xjf", archive, "-C", dir]);
    rmSync(archive);
  }
  if (!existsSync(embedding)) await download(EMBEDDING.url, embedding);
  return { segmentation, embedding };
}

async function download(url: string, to: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${url}`);
  // Written beside the target first, so an interrupted download never looks finished.
  writeFileSync(`${to}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${to}.part`, to);
}

/** Runs in a worker thread: an hour of audio takes minutes of CPU, which must not stall the app. */
export function diarize(samples: Float32Array, models: { segmentation: string; embedding: string }) {
  return new Promise<SpeakerSegment[]>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { samples, models, threshold: THRESHOLD } });
    worker.once("message", (r: { segments?: SpeakerSegment[]; error?: string }) =>
      r.segments ? resolve(r.segments) : reject(new Error(r.error)),
    );
    worker.once("error", reject);
  });
}

