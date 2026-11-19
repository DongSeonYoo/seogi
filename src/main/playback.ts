export const CHUNK_FILE = /^(mic|system)-(\d+(?:\.\d+)?)\.(wav|ogg)$/;

/** Chromium may seek by byte range before it has buffered the whole chunk. */
export function playbackResponse(body: Uint8Array<ArrayBuffer>, file: string, range: string | null): Response {
  const size = body.byteLength;
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
  return new Response(body.subarray(from, to + 1), { status: 206, headers });
}
