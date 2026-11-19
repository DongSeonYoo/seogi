import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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
  if (!existsSync(segmentation) || !existsSync(embedding)) {
    const temp = mkdtempSync(path.join(dir, "download-"));
    try {
      if (!existsSync(segmentation)) {
        const archive = path.join(temp, "segmentation.tar.bz2");
        const license = path.join(path.dirname(SEGMENTATION.file), "LICENSE");
        await download(SEGMENTATION.archive, archive);
        await promisify(execFile)("tar", ["xjf", archive, "-C", temp, SEGMENTATION.file, license]);
        mkdirSync(path.dirname(segmentation), { recursive: true });
        renameSync(path.join(temp, license), path.join(dir, license));
        renameSync(path.join(temp, SEGMENTATION.file), segmentation);
      }
      if (!existsSync(embedding)) {
        const part = path.join(temp, `${EMBEDDING.file}.part`);
        await download(EMBEDDING.url, part);
        renameSync(part, embedding);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return { segmentation, embedding };
}

async function download(url: string, to: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(to));
}

/** Runs in a worker thread: an hour of audio takes minutes of CPU, which must not stall the app. */
export function diarize(samples: Float32Array<ArrayBuffer>, models: { segmentation: string; embedding: string }) {
  return new Promise<SpeakerSegment[]>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { samples, models, threshold: THRESHOLD },
      transferList: [samples.buffer],
    });
    worker.once("message", (r: { segments?: SpeakerSegment[]; error?: string }) =>
      r.segments ? resolve(r.segments) : reject(new Error(r.error)),
    );
    worker.once("error", reject);
  });
}

