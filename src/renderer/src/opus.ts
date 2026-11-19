const RATE = 16000;
const FRAME_US = 20000;
const FRAME_SAMPLES = 960; // Ogg Opus granules always count at 48 kHz.
const text = new TextEncoder();

function oggPage(packets: Uint8Array[], flags: number, granule: number, serial: number, sequence: number) {
  const lacing: number[] = [];
  let bytes = 0;
  for (const packet of packets) {
    bytes += packet.length;
    for (let n = packet.length; n >= 255; n -= 255) lacing.push(255);
    lacing.push(packet.length % 255);
  }
  if (lacing.length > 255) throw new Error("Ogg page too large");
  const page = new Uint8Array(27 + lacing.length + bytes);
  const view = new DataView(page.buffer);
  page.set(text.encode("OggS"));
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  }
  view.setUint32(22, crc, true);
  return page;
}

/** Muxes mono 20 ms packets. The final granule trims encoder padding to the original PCM length. */
export function muxOpus(packets: Uint8Array[], samples: number, preSkip: number): Uint8Array<ArrayBuffer> {
  const end = preSkip + samples * 3;
  const count = Math.ceil(end / FRAME_SAMPLES);
  if (!count || packets.length < count) throw new Error("Incomplete Opus stream");
  const head = new Uint8Array(19);
  head.set(text.encode("OpusHead"));
  head[8] = head[9] = 1;
  const header = new DataView(head.buffer);
  header.setUint16(10, preSkip, true);
  header.setUint32(12, RATE, true);
  const tags = new Uint8Array(21);
  tags.set(text.encode("OpusTags"));
  tags[8] = 5;
  tags.set(text.encode("Seogi"), 12);

  const serial = crypto.getRandomValues(new Uint32Array(1))[0];
  const pages = [oggPage([head], 2, 0, serial, 0), oggPage([tags], 0, 0, serial, 1)];
  // Half-second pages give the demuxer seek points without a page header per packet.
  for (let i = 0; i < count; i += 25) {
    const next = Math.min(i + 25, count);
    const last = next === count;
    pages.push(oggPage(packets.slice(i, next), last ? 4 : 0, last ? end : next * FRAME_SAMPLES, serial, pages.length));
  }
  const file = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const page of pages) {
    file.set(page, offset);
    offset += page.length;
  }
  return file;
}

/** Returns null to keep this chunk as WAV when the encoder cannot supply a complete stream. */
export async function encodeOpus(pcm: Int16Array): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof AudioEncoder === "undefined" || !(pcm.buffer instanceof ArrayBuffer)) return null;
  let encoder: AudioEncoder | undefined;
  try {
    const packets: Uint8Array[] = [];
    let preSkip: number | undefined;
    encoder = new AudioEncoder({
      output(chunk, metadata) {
        const description = metadata?.decoderConfig?.description;
        if (description && description.byteLength >= 19) {
          const header = ArrayBuffer.isView(description)
            ? new DataView(description.buffer, description.byteOffset, description.byteLength)
            : new DataView(description);
          const skip = header.getUint16(10, true);
          // Chromium writes libopus's 16 kHz lookahead (104) here; Ogg uses 48 kHz (312).
          preSkip = skip === 104 ? 312 : skip;
        }
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        packets.push(packet);
      },
      error() {}, // flush rejects on a codec failure.
    });
    const config = {
      codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: 24000,
      opus: { frameDuration: FRAME_US, application: "voip", signal: "voice" },
    };
    encoder.configure(config);
    const data = new AudioData({
      format: "s16", sampleRate: RATE, numberOfChannels: 1, numberOfFrames: pcm.length,
      timestamp: 0, data: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
    await encoder.flush();
    return preSkip === undefined ? null : muxOpus(packets, pcm.length, preSkip);
  } catch {
    return null;
  } finally {
    if (encoder && encoder.state !== "closed") encoder.close();
  }
}
