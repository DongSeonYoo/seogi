import { Worker } from "node:worker_threads";
import workerPath from "./voice-worker?modulePath";

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();

/** A unit-length voice embedding of `samples`; the model stays loaded in one worker. */
export function embedVoice(samples: Float32Array<ArrayBuffer>, model: string): Promise<Float32Array> {
  if (!worker) {
    worker = new Worker(workerPath, { workerData: { model } });
    worker.on("message", (r: { id: number; embedding?: Float32Array; error?: string }) => {
      const w = waiting.get(r.id);
      waiting.delete(r.id);
      if (r.embedding) w?.resolve(r.embedding);
      else w?.reject(new Error(r.error));
    });
    worker.on("error", (e: Error) => {
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      worker = undefined;
    });
    worker.unref();
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ id, samples }, [samples.buffer]);
  });
}

