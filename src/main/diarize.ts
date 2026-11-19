import { Worker } from "node:worker_threads";
import workerPath from "./diarize-worker?modulePath";
import type { SpeakerSegment } from "./speakers.ts";

/**
 * How alike two voices must be to count as one speaker. Tried on a real 3-person discussion:
 * 0.8 found every speaker; 0.7 split one person in two. Synthetic voices differ more.
 */
const THRESHOLD = 0.8;

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

