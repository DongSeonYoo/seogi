import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker side of voices.ts: keeps one embedding model loaded and turns each stretch of audio it is
 * sent into a unit-length voice embedding (about 35 ms a line), off the main thread.
 */
type Extractor = {
  createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
  compute(stream: unknown, enableExternalBuffer?: boolean): Float32Array;
};
const { model } = workerData as { model: string };
const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const extractor: Extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2 });

parentPort?.on("message", ({ id, samples }: { id: number; samples: Float32Array }) => {
  try {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    stream.inputFinished();
    // Electron forbids external array buffers ("External buffers are not allowed"): copy out.
    const v = Float32Array.from(extractor.compute(stream, false));
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    parentPort?.postMessage({ id, embedding: v }, [v.buffer]);
  } catch (e) {
    parentPort?.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
