import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

/** Worker side of diarize(): one run, then the result or the error goes back to the app. */
const { samples, models, threshold } = workerData as {
  samples: Float32Array;
  models: { segmentation: string; embedding: string };
  threshold: number;
};
try {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models.segmentation } },
    embedding: { model: models.embedding },
    // -1: the number of speakers is not known; the threshold decides.
    clustering: { numClusters: -1, threshold },
    minDurationOn: 0.2,
    minDurationOff: 0.3,
  });
  const segments = sd.process(samples) as { start: number; end: number; speaker: number }[];
  parentPort?.postMessage({ segments: segments.map(({ start, end, speaker }) => ({ start, end, speaker })) });
} catch (e) {
  parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
