import assert from "node:assert/strict";
import { test } from "node:test";
import { isPromptEcho, splitUtterances } from "./main/ai.ts";
import { Chunker } from "./renderer/src/recorder.ts";

const RATE = 16000;
const frame = (amp: number) => new Float32Array(1600).fill(amp); // 0.1 s

test("Chunker cuts at a pause after 25 s, forces a cut at 35 s, and drops silence", () => {
  const out: { start: number; sec: number }[] = [];
  const c = new Chunker((start, pcm) => out.push({ start, sec: pcm.length / RATE }));

  for (let i = 0; i < 260; i++) c.push(frame(0.2)); // 26 s speech
  for (let i = 0; i < 5; i++) c.push(frame(0)); // 0.5 s pause -> cut at 26.4 s
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
  assert.ok(Math.abs(out[0].sec - 26.4) < 1e-9);

  for (let i = 0; i < 360; i++) c.push(frame(0.2)); // continuous speech -> forced cut at 35 s
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[1].start - 26.4) < 1e-9);
  assert.ok(Math.abs(out[1].sec - 35) < 1e-9);

  for (let i = 0; i < 400; i++) c.push(frame(0)); // silent chunk is not emitted
  c.flush();
  assert.equal(out.length, 3); // the 1 s of speech left over from the forced cut
});

test("splitUtterances dates sentences by word timing, else by interpolation", () => {
  const text = "첫 문장입니다. 두 번째 문장이에요?";
  const words = [0.5, 1.0, 2.0, 2.5, 3.0].map((startSecond) => ({ startSecond }));

  const timed = splitUtterances({ text, words, durationSec: 4 }, 30, 4);
  assert.deepEqual(timed.map((u) => u.text), ["첫 문장입니다.", "두 번째 문장이에요?"]);
  assert.equal(timed[0].startSec, 30.5);
  assert.equal(timed[1].startSec, 32); // 9/20 of the text -> word index 2

  const untimed = splitUtterances({ text, words: [], durationSec: 0 }, 30, 4);
  assert.equal(untimed[0].startSec, 30);
  assert.equal(untimed[1].startSec, 30 + (9 / text.length) * 4);
});

test("isPromptEcho drops a transcript that only repeats the glossary prompt", () => {
  const prompt = "용어: 동선, 큐그리드, 회의록 앱, PG사";
  assert.ok(isPromptEcho("용어: 동선, 큐그리드, 회의록 앱, PG사.", prompt));
  assert.ok(isPromptEcho("동선, 큐그리드, 회의록 앱, PG사.", prompt));
  assert.ok(!isPromptEcho("큐그리드 대시보드 개편 일정입니다.", prompt));
  assert.ok(!isPromptEcho("", prompt));
});
