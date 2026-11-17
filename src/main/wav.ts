export const SAMPLE_RATE = 16000;

/** 16 kHz mono PCM16 RIFF/WAVE: the one format every transcription provider here accepts. */
export function toWav(pcm: Int16Array): Uint8Array {
  const buf = Buffer.alloc(44 + pcm.byteLength);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcm.byteLength, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return new Uint8Array(buf);
}
