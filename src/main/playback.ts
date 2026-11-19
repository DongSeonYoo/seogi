import { openAsBlob, readdirSync } from "node:fs";
import path from "node:path";
import type { Track } from "../shared/types";

export const CHUNK_FILE = /^(mic|system)-(\d+(?:\.\d+)?)\.(wav|ogg)$/;

type ChunkFile = { file: string; start: number };

/** Playback only needs the current meeting's index; older meetings are read on selection. */
export class ChunkIndex {
  private meeting: { id: number; tracks: Record<Track, ChunkFile[]> } | undefined;

  invalidate(id: number) {
    if (this.meeting?.id === id) this.meeting = undefined;
  }

  find(dir: string, id: number, track: Track, at: number): ChunkFile | null {
    if (this.meeting?.id !== id) {
      const tracks: Record<Track, ChunkFile[]> = { mic: [], system: [] };
      let names: string[];
      try {
        names = readdirSync(path.join(dir, String(id)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        names = [];
      }
      for (const file of names) {
        const match = CHUNK_FILE.exec(file);
        if (match) tracks[match[1] as Track].push({ file, start: Number(match[2]) });
      }
      for (const chunks of Object.values(tracks)) chunks.sort((a, b) => a.start - b.start || b.file.localeCompare(a.file));
      this.meeting = { id, tracks };
    }
    const chunks = this.meeting.tracks[track];
    let lo = 0, hi = chunks.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (chunks[mid].start <= at + 0.05) lo = mid + 1;
      else hi = mid;
    }
    return chunks[lo - 1] ?? null;
  }
}

/** Chromium seeks by byte range. File-backed Blob slices read just the selected bytes. */
export async function playbackResponse(file: string, range: string | null): Promise<Response> {
  let body: Blob;
  try {
    body = await openAsBlob(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
  const size = body.size;
  const headers = new Headers({
    "content-type": file.endsWith(".ogg") ? "audio/ogg" : "audio/wav",
    "content-length": String(size),
    "accept-ranges": "bytes",
  });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
  if (!match || (!match[1] && !match[2])) return new Response(body, { headers });
  const from = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const to = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (from > to) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  headers.set("content-range", `bytes ${from}-${to}/${size}`);
  headers.set("content-length", String(to - from + 1));
  return new Response(body.slice(from, to + 1), { status: 206, headers });
}
