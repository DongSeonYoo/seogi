import assert from "node:assert/strict";
import { test } from "node:test";
import { isPromptEcho } from "./main/transcription.ts";
import { Chunker } from "./renderer/src/recorder.ts";

const RATE = 16000;
const frame = (amp: number) => new Float32Array(1600).fill(amp); // 0.1 s

test("diarization and transcription preserve the selected PCM interval", async () => {
  const { toFloat32, toWav } = await import("./main/wav.ts");
  const pcm = Int16Array.of(8, -32768, 0, 32767, 8).subarray(1, 4);
  assert.deepEqual([...toFloat32(pcm)], [-1, 0, 32767 / 32768]);
  const wav = Buffer.from(toWav(pcm));
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual([...wav.subarray(44)], [0, 128, 0, 0, 255, 127]);
});

test("a failed import turn rolls back every utterance in that turn", async () => {
  const { openDb } = await import("./main/db.ts");
  const db = openDb(":memory:");
  const id = db.createMeeting("Import", null);
  db.raw.exec("CREATE TRIGGER fail BEFORE INSERT ON utterances WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'test'); END");
  assert.throws(() => db.addUtterances(id, "system", [{ startSec: 0, text: "first" }, { startSec: 1, text: "fail" }]));
  assert.deepEqual(db.getMeeting(id)?.utterances, []);
  db.raw.close();
});

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
  // A pause resumes from the audio recorded, silence included.
  assert.ok(Math.abs(c.recordedSec - (26.5 + 36 + 40)) < 1e-9);
});

test("isPromptEcho drops a transcript that only repeats the glossary prompt", () => {
  const prompt = "용어: 동선, 큐그리드, 회의록 앱, PG사";
  assert.ok(isPromptEcho("용어: 동선, 큐그리드, 회의록 앱, PG사.", prompt));
  assert.ok(isPromptEcho("동선, 큐그리드, 회의록 앱, PG사.", prompt));
  assert.ok(!isPromptEcho("큐그리드 대시보드 개편 일정입니다.", prompt));
  assert.ok(!isPromptEcho("", prompt));
});

test("joinSplitSentences rejoins a sentence cut at a chunk boundary, and nothing else", async () => {
  const { joinSplitSentences } = await import("./shared/transcript.ts");
  const u = (id: number, track: "mic" | "system", startSec: number, text: string, speaker: number | null = null) => ({ id, track, startSec, text, speaker });

  const joined = joinSplitSentences([
    u(1, "system", 32, "쿠폰 문제는 동선님이 이번 주 수요일까지"),
    u(2, "system", 35, "수정하기로 했습니다."),
    u(3, "system", 38, "다음 안건입니다."),
  ]);
  assert.deepEqual(joined.map((x) => x.text), ["쿠폰 문제는 동선님이 이번 주 수요일까지 수정하기로 했습니다.", "다음 안건입니다."]);
  assert.equal(joined[0].id, 1); // keeps the first piece's id and start time for playback
  assert.equal(joined[0].startSec, 32);
  assert.deepEqual(joined[0].joined, [2]); // removed when the shown line is edited

  // A different speaker in between, finished sentences, and a long gap all stay separate.
  assert.equal(joinSplitSentences([u(1, "system", 32, "말이 끊겼는데"), u(2, "mic", 33, "네.")]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "말이 끊겼는데", 1), u(2, "system", 33, "네.", 2)]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "끝난 문장입니다."), u(2, "system", 35, "새 문장.")]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "끝맺음 없음"), u(2, "system", 90, "한참 뒤.")]).length, 2);
});

test("a named voice is named on every line, in the export too, and an empty name restores the default", async () => {
  const { openDb } = await import("./main/db.ts");
  const { meetingDocument } = await import("./shared/summary.ts");
  const { translator } = await import("./shared/i18n.ts");
  const db = openDb(":memory:");
  const id = db.createMeeting("Sync");
  db.addUtterances(id, "system", [{ startSec: 1, text: "시작하죠.", speaker: 2 }, { startSec: 5, text: "좋아요.", speaker: 1 }]);
  db.setSpeakerName(id, "2", "대표님");
  const m = db.getMeeting(id)!;
  assert.deepEqual(m.speakerNames, { 2: "대표님" });
  const doc = meetingDocument(m, "md", translator("en"), "Nov 20");
  assert.ok(doc.includes("**대표님**: 시작하죠.") && doc.includes("**Speaker 1**: 좋아요."));
  db.setSpeakerName(id, "2", "");
  assert.deepEqual(db.getMeeting(id)!.speakerNames, {});
});

test("the voice ring keeps the last minutes by stretch time, and a voice takes a name only when alike enough", async () => {
  const { AudioRing, matchVoice } = await import("./main/speakers.ts");
  const ring = new AudioRing();
  const sec = (n: number, v: number) => new Int16Array(16000 * n).fill(v);
  ring.push(sec(200, 100));
  ring.push(sec(200, 200)); // the first 100 s have been overwritten
  assert.equal(ring.slice(10, 12), null);
  assert.equal(ring.slice(150, 150.5), null); // under a second: too little voice
  const s = ring.slice(390, 420)!;
  assert.equal(s.length, 16000 * 8); // at most 8 s of a line
  assert.ok(Math.abs(s[0] - 200 / 32768) < 1e-9);
  const unit = (...v: number[]) => Float32Array.from(v, (x) => x / Math.hypot(...v));
  const voices = new Map([[1, [unit(1, 0, 0)]], [2, [unit(0, 1, 0)]]]);
  assert.equal(matchVoice(unit(0.9, 0.2, 0), voices), 1);
  assert.equal(matchVoice(unit(0.4, 0.4, 0.82), voices), null); // like neither enough
});

test("captions lose sound tags, and a line with no letter or digit is dropped", async () => {
  const { cleanCaption } = await import("./shared/text.ts");
  assert.equal(cleanCaption("[sigh ]한국어 억양으로 해볼래"), "한국어 억양으로 해볼래");
  assert.equal(cleanCaption("[chuckle]그럼 이렇게 가볼게요."), "그럼 이렇게 가볼게요.");
  assert.equal(cleanCaption("."), "");
  assert.equal(cleanCaption(" … "), "");
  assert.equal(cleanCaption("[1] 항목"), "[1] 항목"); // not a sound tag
});

test("a hand edit replaces a shown line's text and removes the pieces joined to it", async () => {
  const { openDb } = await import("./main/db.ts");
  const db = openDb(":memory:");
  const id = db.createMeeting("Sync");
  const [a, b] = db.addUtterances(id, "system", [{ startSec: 1, text: "큐 그리드는" }, { startSec: 3, text: "목요일 배포." }]);
  db.editUtterance(id, a.id, "큐그리드는 목요일 배포.", [b.id]);
  assert.deepEqual(db.getMeeting(id)!.utterances.map((u) => [u.id, u.startSec, u.text]), [[a.id, 1, "큐그리드는 목요일 배포."]]);
});

test("caption inserts merge with a snapshot in time and id order, once per stored row", async () => {
  const { openDb } = await import("./main/db.ts");
  const { mergeUtterances } = await import("./shared/transcript.ts");
  const db = openDb(":memory:");
  const id = db.createMeeting("Sync");
  const [first] = db.addUtterances(id, "mic", [{ startSec: 8, text: "First." }]);
  const snapshot = db.getMeeting(id)!.utterances;
  const [tie, earlier] = db.addUtterances(id, "system", [
    { startSec: 8, text: "Second.", speaker: 2 }, { startSec: 3, text: "Earlier.", speaker: 1 },
  ]);
  const merged = mergeUtterances(snapshot, [tie, first, earlier, tie]);
  assert.deepEqual(merged, [earlier, first, tie]);
  assert.deepEqual(merged, db.getMeeting(id)!.utterances);
  assert.equal(mergeUtterances(merged, [tie]), merged);
});

test("drafts split and bridge speaker groups in time order and leave distant groups intact", async () => {
  const { groupUtterances, insertDrafts } = await import("./renderer/src/format.ts");
  const u = (id: number, track: "mic" | "system", startSec: number) => ({ id, track, startSec, text: ".", speaker: null });
  const rows = [u(1, "mic", 1), u(2, "system", 12), u(3, "system", 16), u(4, "system", 160)];
  const drafts = [u(-1, "mic", 12), u(-2, "system", 110)];
  const groups = groupUtterances(rows);
  const mixed = insertDrafts(groups, drafts);
  assert.deepEqual(mixed.map((g) => g.map((row) => row.id)), [[1], [2], [-1], [3, -2, 4]]);
  assert.equal(mixed[0], groups[0]);
});

test("SilenceWatch flags a long run of exact zeros and clears on the first sound", async () => {
  const { SilenceWatch } = await import("./renderer/src/recorder.ts");
  const events: boolean[] = [];
  const w = new SilenceWatch(4000, (s) => events.push(s));
  for (let i = 0; i < 2; i++) w.push(new Float32Array(1600)); // 3200 zeros: not yet
  assert.deepEqual(events, []);
  w.push(new Float32Array(1600)); // 4800 zeros: flagged once
  w.push(new Float32Array(1600));
  assert.deepEqual(events, [true]);
  const sound = new Float32Array(1600);
  sound[10] = 0.001;
  w.push(sound); // any non-zero sample clears it
  assert.deepEqual(events, [true, false]);
});

test("streamed pieces become sentence lines: an unfinished end waits for the next piece and is flushed on stop", async () => {
  const { LiveCaptions } = await import("./main/live.ts");
  const stored: { startSec: number; text: string }[] = [];
  const c = new LiveCaptions(() => ({ audio() {}, stop: async () => {} }), () => {}, (_t, s) => stored.push(s), true);
  // Cut at a short pause mid-sentence: "그래서 좀 그" | "했을 때 좋았어요. 다음은"
  c.onEvent("system", { type: "segment", id: "1", text: "첫 문장입니다. 그래서 좀 그", startSec: 10, endSec: 14 });
  assert.deepEqual(stored.map((s) => s.text), ["첫 문장입니다."]);
  assert.deepEqual(c.view().lines.map((l) => l.text), ["그래서 좀 그"]); // still shown while it waits
  c.onEvent("system", { type: "segment", id: "2", text: "했을 때 좋았어요. 다음은", startSec: 15, endSec: 18 });
  assert.deepEqual(stored.map((s) => s.text), ["첫 문장입니다.", "그래서 좀 그 했을 때 좋았어요."]);
  assert.equal(stored[0].startSec, 10);
  assert.ok(stored[1].startSec > 11 && stored[1].startSec < 14); // where "그래서" was spoken in piece 1
  await c.stop();
  assert.equal(stored.at(-1)!.text, "다음은");
});

test("a line corrected while spoken keeps the correction, held back if it finishes during the edit", async () => {
  const { LiveCaptions } = await import("./main/live.ts");
  const stored: string[] = [];
  const c = new LiveCaptions(() => ({ audio() {}, stop: async () => {} }), () => {}, (_t, s) => stored.push(s.text));
  // Corrected mid-sentence; the model keeps adding words, then finishes with its own spelling.
  c.onEvent("system", { type: "delta", id: "a", text: "큐 그리드는", atSec: 1 });
  assert.ok(c.fix("system:a", 0, "큐", "큐그리드"));
  c.onEvent("system", { type: "delta", id: "a", text: " 목요일", atSec: 2 });
  assert.equal(c.view().lines[0].text, "큐그리드 그리드는 목요일");
  c.onEvent("system", { type: "segment", id: "a", text: "큐 그리드는 목요일 배포.", startSec: 1, endSec: 3 });
  assert.deepEqual(stored, ["큐그리드 그리드는 목요일 배포."]);
  // Finished while being edited: held on screen, stored once the correction is saved.
  c.onEvent("system", { type: "delta", id: "b", text: "동선님이", atSec: 4 });
  c.hold("system:b");
  c.onEvent("system", { type: "segment", id: "b", text: "동선님이 맡아요.", startSec: 4, endSec: 5 });
  assert.equal(stored.length, 1);
  assert.equal(c.view().lines.length, 1);
  c.fix("system:b", 0, "동선님이", "동선 님이");
  assert.deepEqual(stored.at(-1), "동선 님이 맡아요.");
  assert.equal(c.fix("system:gone", 0, "a", "b"), false);
});

test("live captions store finished segments, show what is still spoken, and flush it on stop", async () => {
  const { LiveCaptions } = await import("./main/live.ts");
  const stored: { track: string; startSec: number; text: string }[] = [];
  const c = new LiveCaptions(() => ({ audio() {}, stop: async () => {} }), () => {}, (track, s) => stored.push({ track, ...s }));
  const lines = () => c.view().lines.map((l) => l.text);

  c.onEvent("mic", { type: "delta", id: "a", text: "첫 문장", atSec: 1 });
  c.onEvent("mic", { type: "delta", id: "a", text: "입니다.", atSec: 2 });
  assert.deepEqual(lines(), ["첫 문장입니다."]);
  c.onEvent("mic", { type: "segment", id: "a", text: "첫 문장입니다.", startSec: 1, endSec: 3 });
  assert.deepEqual(lines(), []);
  assert.deepEqual(stored, [{ track: "mic", startSec: 1, text: "첫 문장입니다.", endSec: 3 }]);

  c.onEvent("system", { type: "reconnect" });
  c.onEvent("system", { type: "delta", id: "b", text: "말하는 중", atSec: 5 });
  await c.stop();
  assert.equal(c.drops, 1);
  assert.deepEqual(stored.at(-1), { track: "system", startSec: 5, text: "말하는 중" });
  assert.deepEqual(lines(), []);

  // Without a store (the settings test) finished lines stay in the view.
  const t = new LiveCaptions(() => ({ audio() {}, stop: async () => {} }), () => {}, null);
  t.onEvent("mic", { type: "segment", id: "x", text: "시험", startSec: 0, endSec: 1 });
  t.onEvent("mic", { type: "delta", id: "y", text: "중", atSec: 2 });
  await t.stop();
  assert.deepEqual(t.view().lines.map((l) => l.text), ["시험", "중"]);
});

test("the mic test keeps the latest 50 finished lines, including drafts finalized on a drop", async () => {
  const { LiveCaptions } = await import("./main/live.ts");
  const c = new LiveCaptions(() => { throw Error("unused"); }, () => {}, null);
  for (let i = 0; i < 60; i++) c.onEvent("mic", { type: "segment", id: String(i), text: String(i), startSec: i, endSec: i + 1 });
  c.onEvent("mic", { type: "delta", id: "tail", text: "60", atSec: 60 });
  c.onEvent("mic", { type: "reconnect" });
  c.onEvent("mic", { type: "segment", id: "opening", text: "late opening", startSec: 0, endSec: 1 });
  await c.stop();
  assert.deepEqual(c.view().lines.map((line) => line.text), Array.from({ length: 50 }, (_, i) => String(i + 11)));
});

test("caption sockets retain 30 s on their original clock and ignore stale callbacks after stop", async (t) => {
  const { openLiveStream } = await import("./main/live.ts");
  const { translator } = await import("./shared/i18n.ts");
  const sockets: Socket[] = [];
  class Socket {
    bufferedAmount = 0;
    audioBytes = 0;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: (e: { code: number; reason: string }) => void;
    constructor() { sockets.push(this); }
    send(data: string) {
      const msg = JSON.parse(data);
      const pcm = msg.audio ?? msg.data?.pcm;
      if (pcm) this.audioBytes += Buffer.byteLength(pcm, "base64");
    }
    receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    close() { this.onclose?.({ code: 1000, reason: "" }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const provider of ["qgrid", "openai"] as const) {
      const events: Parameters<Parameters<typeof openLiveStream>[1]>[0][] = [];
      const stream = openLiveStream({ provider, url: "http://fixture", apiKey: "", model: "fixture", t: translator("en") }, (e) => events.push(e));
      for (let i = 0; i < 32; i++) stream.audio(new Int16Array(RATE).fill(i < 22 ? 3000 : 0));
      const old = sockets.at(-1)!;
      old.close();
      t.mock.timers.tick(1000);
      const ws = sockets.at(-1)!;
      assert.notEqual(ws, old);
      ws.onopen?.();
      assert.equal(ws.audioBytes, 0);
      ws.bufferedAmount = 512 * 1024;
      ws.receive(provider === "qgrid" ? { event: "ready" } : { type: "session.updated" });
      assert.equal(ws.audioBytes, 0);
      ws.bufferedAmount = 0;
      t.mock.timers.tick(25);
      if (provider === "qgrid") {
        ws.receive({ event: "segment", data: { segmentId: 1, text: "words", startMs: 0, endMs: 30000 } });
      } else {
        ws.receive({ type: "input_audio_buffer.committed", item_id: "1" });
        ws.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "1", transcript: "words" });
      }
      assert.equal(ws.audioBytes, 30 * 2 * (provider === "qgrid" ? RATE : 24000));
      assert.deepEqual(events.filter((e) => e.type === "gap").map((e) => e.message), ["Captions missed audio from 0.0 s to 2.0 s."]);
      assert.deepEqual(events.filter((e) => e.type === "segment").map((e) => [e.startSec, e.endSec]), [[2, provider === "qgrid" ? 32 : 22]]);
      ws.close();
      const count = sockets.length;
      await stream.stop();
      t.mock.timers.tick(15000);
      assert.equal(sockets.length, count);
      const seen = events.length;
      ws.receive(provider === "qgrid" ? { event: "error", data: { message: "stale" } } : { type: "error" });
      assert.equal(events.length, seen);
    }
  } finally {
    globalThis.WebSocket = original;
  }
});

test("GPT-Live turns are cut into segments at sentence ends, pauses and on demand", async () => {
  const { Segmenter } = await import("./renderer/src/gptLive.ts");
  const out: string[] = [];
  const s = new Segmenter("g1", (e) => e.type === "segment" && out.push(`${e.id}@${e.startSec}:${e.text}`));
  s.add("t", "오늘은 큐그리드", 0, 1);
  s.add("t", " 2.", 1, 1.5);
  s.add("t", "23을 봅니다.", 1.5, 3); // "2." mid-number is not a sentence end
  s.add("t", "서기 앱", 3.2, 4);
  s.add("t", " 시험", 7, 8); // 3 s pause ends "서기 앱"
  s.add("t", "합니다.회의는", 8, 9); // one piece ends a sentence and starts the next
  s.cut();
  assert.deepEqual(out, ["g1:t:0@0:오늘은 큐그리드 2.23을 봅니다.", "g1:t:1@3.2:서기 앱", "g1:t:2@7:시험합니다.", "g1:t:3@8:회의는"]);
});

test("finishing one turn releases its sequence and preserves the other turn's draft", async () => {
  const { Segmenter } = await import("./renderer/src/gptLive.ts");
  const out: string[] = [];
  const s = new Segmenter("g", (e) => e.type === "segment" && out.push(`${e.id} ${e.text}`));
  s.add("a", "First.", 0, 1);
  s.add("b", "Another", 0, 1);
  s.add("a", "Second", 1, 2);
  s.finish("a");
  s.finish("a");
  s.add("a", "Fresh", 3, 4);
  s.add("b", " voice", 1, 2);
  s.cut();
  assert.deepEqual(out, ["g:a:0 First.", "g:a:1 Second", "g:b:0 Another voice", "g:a:0 Fresh"]);
});

test("a palette query limits matching meetings while a library view lists every meeting", async () => {
  const { openDb } = await import("./main/db.ts");
  const db = openDb(":memory:");
  try {
    for (let i = 0; i < 54; i++) db.createMeeting(`회의 ${i}`);
    db.createMeeting("Other");
    assert.equal(db.listMeetings("all").length, 55);
    assert.equal(db.listMeetings("all", "").length, 50);
    const matches = db.listMeetings("all", "회의");
    assert.equal(matches.length, 50);
    assert.ok(matches.every((m) => m.title.includes("회의")));
  } finally {
    db.raw.close();
  }
});

test("a failed import is usable only if some utterances were stored", async () => {
  const { openDb } = await import("./main/db.ts");
  const db = openDb(":memory:");
  try {
    const id = db.createMeeting("Import");
    db.startImport(id);
    assert.equal(db.hasUtterances(id), false);
    db.finishImport(id, 20, "failed turn");
    assert.equal(db.getMeeting(id)?.status, "error");
    db.addUtterances(id, "system", [{ startSec: 0, text: "One turn" }]);
    assert.equal(db.hasUtterances(id), true);
    db.finishImport(id, 20, "failed turn");
    assert.equal(db.getMeeting(id)?.status, "done");
  } finally {
    db.raw.close();
  }
});

test("meeting date formatters keep the locale and date style of each field", async () => {
  const { fullDate, listDate, timeOfDay } = await import("./renderer/src/format.ts");
  const { translator } = await import("./shared/i18n.ts");
  const d = new Date(2026, 10, 1, 13, 23);
  const iso = d.toISOString();
  for (const intl of ["en-US", "ko-KR"]) {
    const f = { intl, t: translator(intl === "en-US" ? "en" : "ko") };
    assert.equal(timeOfDay(iso, f), d.toLocaleTimeString(intl, { hour: "numeric", minute: "2-digit" }));
    assert.equal(fullDate(iso, f), d.toLocaleString(intl, { dateStyle: "long", timeStyle: "short" }));
    assert.equal(listDate(iso, f, new Date(2026, 10, 5)), d.toLocaleDateString(intl, { weekday: "long" }));
    assert.equal(listDate(iso, f, new Date(2026, 10, 9)), d.toLocaleDateString(intl, { year: "2-digit", month: "numeric", day: "numeric" }));
  }
});

test("listModels maps qgrid's catalog per role and filters OpenAI's list by task", async () => {
  const { listModels } = await import("./main/models.ts");
  const store = { get: () => ({ qgridUrl: "http://q", locale: "en" }), key: () => "sk-test" } as never;
  const catalog = {
    text: [{ id: "openai/gpt-6-luna", available: true, pricing: { input: 0.1, output: 0.5, cachedInput: 0.01 }, efforts: ["low", "high"] }],
    transcription: [{ id: "openai/gpt-transcribe", available: true, usdPerMinute: 0.0045, prompt: true, liveDraft: false }],
    transcriptionStream: [{ id: "openai/gpt-live-transcribe", available: false, usdPerMinute: 0.017, prompt: true, liveDraft: true }],
  };
  const openaiIds = ["gpt-6-luna", "gpt-4o-transcribe", "gpt-realtime-whisper", "whisper-1", "tts-1", "gpt-image-2"];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    Response.json(String(url).startsWith("http://q") ? catalog : { data: openaiIds.map((id) => ({ id })) })) as typeof fetch;
  try {
    const ids = async (role: "live" | "summary", provider: string) => {
      const r = await listModels(store, role, provider);
      assert.ok(r.ok);
      return r.models;
    };
    const [live] = await ids("live", "qgrid");
    assert.deepEqual(live, { id: "openai/gpt-live-transcribe", available: false, detail: "$0.017/min · Glossary · Shows text while you speak" });
    assert.deepEqual((await ids("summary", "qgrid"))[0].efforts, ["low", "high"]);
    // GPT-Live joins the live list, usable when qgrid serves any OpenAI model.
    assert.deepEqual((await ids("live", "qgrid")).at(-1)?.id, "openai/gpt-live-1");
    assert.equal((await ids("live", "qgrid")).at(-1)?.available, true);
    assert.deepEqual((await ids("live", "openai")).map((m) => m.id), ["gpt-4o-transcribe", "gpt-realtime-whisper", "whisper-1"]);
    assert.deepEqual((await ids("summary", "openai")).map((m) => m.id), ["gpt-6-luna"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a pending audio deletion survives restart without reusing its meeting id", async () => {
  const { openDb } = await import("./main/db.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "seogi-purge-"));
  const file = join(dir, "test.db");
  let db = openDb(file);
  try {
    const kept = db.createMeeting("Undo");
    db.setMeetingDeleted(kept, true);
    db.setMeetingDeleted(kept, false);
    const gone = db.createMeeting("Delete");
    db.setMeetingDeleted(gone, true);
    assert.deepEqual(db.purgeDeleted(), [gone]);
    db.raw.close();
    db = openDb(file);
    assert.deepEqual(db.purgeDeleted(), [gone]);
    db.audioRemoved(gone);
    assert.deepEqual(db.purgeDeleted(), []);
    assert.ok(db.createMeeting("New") > gone);
    assert.equal(db.getMeeting(kept)?.title, "Undo");
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model cleanup waits for active downloads and removes only abandoned temp folders", async (t) => {
  const { cleanModelDownloads } = await import("./main/modelFiles.ts");
  const { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "seogi-model-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const active = mkdtempSync(join(dir, `download-${process.pid}-`));
  const stale = mkdtempSync(join(dir, "download-"));
  writeFileSync(join(stale, "unfinished.part"), "incomplete");
  mkdirSync(join(dir, "speaker-model"));
  writeFileSync(join(dir, "download-abcdef"), "keep");
  cleanModelDownloads(dir);
  assert.equal(readdirSync(dir).length, 4);
  rmSync(active, { recursive: true });
  cleanModelDownloads(dir);
  assert.deepEqual(readdirSync(dir).sort(), ["download-abcdef", "speaker-model"]);
});

test("library changes undo and redo, deletes purge for real, and a resummary keeps a typed title", async () => {
  const { openDb } = await import("./main/db.ts");
  const { History, perform } = await import("./main/library.ts");
  const { translator } = await import("./shared/i18n.ts");
  const db = openDb(":memory:");
  const history = new History();
  const run = (op: Parameters<typeof perform>[2]) => perform(db, history, op, translator("ko"));
  const titles = () => db.listMeetings("all").map((m) => m.title);

  const a = db.createMeeting("회의 A");
  const b = db.createMeeting("회의 B");
  assert.ok(db.startRecording(a));
  assert.ok(!db.startRecording(a)); // only a new session starts recording
  assert.deepEqual(run({ type: "delete", ids: [a] }), { ok: false, error: "녹음하거나 정리 중인 회의는 삭제할 수 없습니다" });
  db.setStatus(a, "done");
  db.setStatus(b, "done");

  run({ type: "rename", id: a, title: "내 제목" });
  db.setSummary(a, "요약 제목", "## 개요\n\n요약 본문");
  assert.equal(db.listMeetings("all").find((m) => m.id === a)?.preview, "요약 본문");
  assert.equal(db.getMeeting(a)?.title, "내 제목");
  history.undo(translator("ko"));
  assert.equal(db.getMeeting(a)?.title, "회의 A");

  const folder = run({ type: "createFolder", name: "고객사" });
  assert.ok(folder.ok && folder.id);
  run({ type: "move", ids: [a, b], folderId: folder.id! });
  run({ type: "star", ids: [b], starred: true });
  assert.deepEqual(db.listFolders(), [{ id: folder.id, name: "고객사", count: 2 }]);
  assert.equal(db.counts().starred, 1);
  assert.equal(history.undo(translator("ko")), "즐겨찾기");
  assert.equal(history.undo(translator("ko")), "폴더 이동");
  assert.equal(db.listMeetings(folder.id!).length, 0);
  assert.equal(history.redo(translator("ko")), "폴더 이동");
  assert.equal(db.listMeetings(folder.id!).length, 2);

  run({ type: "deleteFolder", id: folder.id! });
  assert.equal(db.listFolders().length, 0);
  assert.equal(db.listMeetings("all").every((m) => m.folderId === null), true); // unfiled while deleted
  history.undo(translator("ko"));

  run({ type: "delete", ids: [a] });
  assert.deepEqual(titles(), ["회의 B"]);
  assert.equal(db.counts().all, 1);
  history.undo(translator("ko"));
  assert.equal(db.counts().all, 2);
  history.redo(translator("ko"));
  assert.deepEqual(db.purgeDeleted(), [a]);
  assert.equal(db.getMeeting(a), null);
  assert.equal(Number(db.raw.prepare("SELECT COUNT(*) AS n FROM meetings").get()?.n), 1);
});

test("every Korean string fills the same placeholders as its English source", async () => {
  const { translator, MESSAGE_KEYS } = await import("./shared/i18n.ts");
  const en = translator("en");
  const ko = translator("ko");
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of MESSAGE_KEYS) {
    assert.ok(ko(key).trim(), `ko ${key} is empty`);
    assert.equal(placeholders(ko(key)), placeholders(en(key)), `placeholders differ for ${key}`);
  }
  assert.equal(en("list.count", { n: 3 }), "3");
  assert.equal(ko("undo.deleteMany", { n: 2 }), "회의 2개 삭제");
});

test("appendDelta spaces a new sentence but not a decimal or a delta that brings its own space", async () => {
  const { appendDelta } = await import("./shared/text.ts");
  assert.equal(appendDelta("이야기합니다.", "서기 앱에서"), "이야기합니다. 서기 앱에서");
  assert.equal(appendDelta("버전 2.", "23"), "버전 2.23");
  assert.equal(appendDelta("Hello.", " World"), "Hello. World");
  assert.equal(appendDelta("오늘은", " 큐그리드"), "오늘은 큐그리드");
});

test("summary time links read both total minutes and hours", async () => {
  const { clock, TIME_LINK, clockSeconds, summaryPreview } = await import("./shared/summary.ts");
  const line = "First [60:00]. Second [100:00]. Last [1:40:00].";
  assert.deepEqual([...line.matchAll(TIME_LINK)].map((m) => clockSeconds(m[1])), [3600, 6000, 6000]);
  assert.deepEqual([3599.9, 3600, 6000].map(clock), ["59:59", "1:00:00", "1:40:00"]);
  assert.equal(summaryPreview(line), "First. Second. Last.");
});

test("legacy summary migration converts only complete old summaries and runs once", async () => {
  const { openDb } = await import("./main/db.ts");
  const { translator } = await import("./shared/i18n.ts");
  const db = openDb(":memory:");
  try {
    const summary = { title: "Original", overview: "First.", decisions: [], topics: [], actionItems: [] };
    const valid = JSON.stringify(summary);
    const entries = [" \n" + valid, "{my notes", '{"hello":"world"}', JSON.stringify({ ...summary, actionItems: [null] })];
    const ids = entries.map((entry) => {
      const id = db.createMeeting("Edited title");
      db.setSummaryText(id, entry);
      return id;
    });
    db.migrateSummaries(translator("en"));
    assert.deepEqual(ids.map((id) => db.getMeeting(id)?.summary), ["## Overview\n\nFirst.", ...entries.slice(1)]);
    assert.equal(db.getMeeting(ids[0])?.title, "Edited title");
    db.setSummaryText(ids[0], valid);
    db.migrateSummaries(translator("en"));
    assert.equal(db.getMeeting(ids[0])?.summary, valid);
  } finally {
    db.raw.close();
  }
});

test("summaries become editable Markdown, export as Markdown or plain text", async () => {
  const { summaryMarkdown, summaryPreview, meetingDocument } = await import("./shared/summary.ts");
  const { translator } = await import("./shared/i18n.ts");
  const t = translator("en");
  const md = summaryMarkdown(
    { title: "T", overview: "We shipped.", decisions: ["Ship Friday"], actionItems: [{ owner: "Lee", task: "Tag release", due: "Fri" }], topics: [{ title: "Infra", points: ["Load test"] }] },
    t,
  );
  assert.equal(md, "## Overview\n\nWe shipped.\n\n## Decisions\n\n- Ship Friday\n\n## Action Items\n\n- [ ] Tag release — Lee, Fri\n\n## Topics\n\n### Infra\n- Load test");
  assert.equal(summaryPreview(md), "We shipped.");
  assert.equal(summaryPreview("## Overview\n\nWe shipped [01:05]. Then left [1:02:03]."), "We shipped. Then left.");
  const m = { title: "Sync", startedAt: "", summary: md, utterances: [{ id: 1, track: "mic" as const, startSec: 65, text: "Hello.", speaker: null }] };
  const doc = meetingDocument(m, "md", t, "Nov 19");
  assert.ok(doc.startsWith("# Sync\n\nNov 19\n\n## Summary\n\n### Overview"));
  assert.ok(doc.includes("- `01:05` **Me**: Hello."));
  const txt = meetingDocument(m, "txt", t, "Nov 19");
  assert.ok(txt.startsWith("Sync\n\nNov 19\n\nSummary\n\nOverview"));
  assert.ok(txt.includes("☐ Tag release — Lee, Fri"));
  assert.ok(txt.includes("• 01:05 Me: Hello."));
});

test("speaker turns join a voice's close segments, cap their length, and number voices by first appearance", async () => {
  const { speakerTurns } = await import("./main/speakers.ts");
  const turns = speakerTurns([
    { start: 5, end: 7, speaker: 4 },
    { start: 0, end: 2, speaker: 7 },
    { start: 2.5, end: 4, speaker: 7 }, // 0.5 s pause: same turn
    { start: 7.2, end: 20, speaker: 4 },
    { start: 20.5, end: 40, speaker: 4 }, // would make a 35 s turn: a new one
  ]);
  assert.deepEqual(turns, [
    { start: 0, end: 4, speaker: 1 },
    { start: 5, end: 20, speaker: 2 },
    { start: 20.5, end: 40, speaker: 2 },
  ]);
});

test("recorded lines take the voice that talks most during them, the nearest one in silence, renumbered by first line", async () => {
  const { assignSpeakers } = await import("./main/speakers.ts");
  const turns = [
    { start: 0, end: 3, speaker: 2 },
    { start: 3, end: 10, speaker: 3 },
    { start: 20, end: 25, speaker: 1 },
  ];
  const lines = [
    { id: 11, startSec: 2 }, // 2–9: 1 s of voice 2, 6 s of voice 3
    { id: 10, startSec: 0 }, // 0–2: voice 2
    { id: 12, startSec: 9 }, // 9–12: voice 3
    { id: 13, startSec: 16 }, // 16–46 overlaps voice 1 only
    { id: 14, startSec: 50 }, // in no stretch: nearest is voice 1
  ];
  assert.deepEqual([...assignSpeakers(lines, turns)], [[10, 1], [11, 2], [12, 2], [13, 3], [14, 3]]);
  assert.equal(assignSpeakers(lines, []).size, 0);
});

test("Ogg Opus pages round-trip headers, packet lacing, CRCs and trimmed 48 kHz granules", async () => {
  const { muxOpus } = await import("./renderer/src/opus.ts");
  const packets = Array.from({ length: 26 }, (_, i) => new Uint8Array(i ? 30 : 255).fill(i + 1));
  const bytes = muxOpus(packets, 8160, 312);
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
    return value >>> 0;
  });
  const parsed: Uint8Array[] = [];
  const flags = [], granules = [], serials = [];
  for (let at = 0; at < bytes.length;) {
    const view = new DataView(bytes.buffer, at);
    assert.equal(new TextDecoder().decode(bytes.subarray(at, at + 4)), "OggS");
    assert.equal(view.getUint8(4), 0);
    assert.equal(view.getUint32(18, true), flags.length);
    flags.push(view.getUint8(5));
    granules.push(Number(view.getBigUint64(6, true)));
    serials.push(view.getUint32(14, true));
    const lacing = bytes.subarray(at + 27, at + 27 + view.getUint8(26));
    let pos = at + 27 + lacing.length;
    let start = pos;
    for (const n of lacing) {
      pos += n;
      if (n < 255) {
        parsed.push(bytes.subarray(start, pos));
        start = pos;
      }
    }
    assert.equal(start, pos);
    const expected = view.getUint32(22, true);
    const page = bytes.slice(at, pos);
    page.fill(0, 22, 26);
    const crc = page.reduce((sum, n) => ((sum << 8) ^ table[(sum >>> 24) ^ n]) >>> 0, 0);
    assert.equal(crc, expected);
    at = pos;
  }
  assert.equal(new Set(serials).size, 1);
  assert.deepEqual(flags, [2, 0, 0, 4]);
  assert.deepEqual(granules, [0, 0, 24000, 24792]);
  const [head, tags, ...audio] = parsed;
  assert.equal(Buffer.from(head.subarray(0, 8)).toString(), "OpusHead");
  assert.deepEqual([...head.subarray(8, 12)], [1, 1, 56, 1]);
  assert.equal(Buffer.from(head).readUInt32LE(12), 16000);
  assert.equal(Buffer.from(tags.subarray(0, 8)).toString(), "OpusTags");
  assert.equal(Buffer.from(tags).readUInt32LE(8), 5);
  assert.equal(Buffer.from(tags.subarray(12, 17)).toString(), "Seogi");
  assert.equal(Buffer.from(tags).readUInt32LE(17), 0);
  assert.deepEqual(audio, packets);
});

test("playback serves file-backed WAV and Ogg ranges for seeking", async (t) => {
  const { CHUNK_FILE, playbackResponse } = await import("./main/playback.ts");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "seogi-range-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, mime] of [["mic-0.0.wav", "audio/wav"], ["system-30.0.ogg", "audio/ogg"]]) {
    assert.ok(CHUNK_FILE.test(name));
    const file = join(dir, name);
    writeFileSync(file, Uint8Array.of(1, 2, 3, 4));
    const response = await playbackResponse(file, "bytes=1-2");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(response.headers.get("content-range"), "bytes 1-2/4");
    assert.deepEqual(await response.bytes(), Uint8Array.of(2, 3));
    assert.deepEqual(await (await playbackResponse(file, "bytes=-2")).bytes(), Uint8Array.of(3, 4));
    assert.equal((await playbackResponse(file, null)).status, 200);
    assert.equal((await playbackResponse(file, "bytes=4-")).status, 416);
  }
  assert.equal((await playbackResponse(join(dir, "absent.wav"), null)).status, 404);
});

test("the chunk index finds the preceding chunk on each track and refreshes on save", async (t) => {
  const { ChunkIndex } = await import("./main/playback.ts");
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "seogi-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "1"));
  for (const name of ["mic-20.0.ogg", "mic-5.0.wav", "system-4.0.ogg"]) writeFileSync(join(dir, "1", name), "");
  const index = new ChunkIndex();
  assert.equal(index.find(dir, 1, "mic", 3), null);
  assert.equal(index.find(dir, 1, "mic", 19.96)?.start, 20);
  assert.equal(index.find(dir, 1, "system", 20)?.start, 4);
  writeFileSync(join(dir, "1", "mic-10.0.wav"), "");
  assert.equal(index.find(dir, 1, "mic", 12)?.start, 5);
  index.invalidate(1);
  assert.equal(index.find(dir, 1, "mic", 12)?.start, 10);
  assert.equal(index.find(dir, 2, "mic", 12), null);
});

test("unavailable Opus encoding selects the PCM fallback", async () => {
  const { encodeOpus } = await import("./renderer/src/opus.ts");
  // The Node test environment has no AudioEncoder.
  assert.equal(await encodeOpus(new Int16Array(320)), null);
});

test("stored messages are worded in the language current when shown; plain text passes through", async () => {
  const { storedMessage, showStored, translator } = await import("./shared/i18n.ts");
  const saved = storedMessage("error.captionsDropped", { n: 2 });
  assert.equal(showStored(saved, translator("en")), translator("en")("error.captionsDropped", { n: 2 }));
  assert.equal(showStored(saved, translator("ko")), translator("ko")("error.captionsDropped", { n: 2 }));
  assert.equal(showStored("qgrid 502: bad gateway", translator("ko")), "qgrid 502: bad gateway");
});

const summaryRow = (id: number, startSec: number, text: string) =>
  ({ id, startSec, text, track: "mic" as const, speaker: null });
const citedOverview = (text: string, ...ids: number[]) => ({
  title: "Release", overview: [{ text, ids }], decisions: [], actionItems: [], topics: [],
});

test("summary splitting accounts for UTF-8, labels and newlines without breaking source ids or characters", async () => {
  const { splitRows } = await import("./main/summaryParts.ts");
  const rows = ["가🙂나다🙂라", "끝"].map((text, i) => ({ text, label: `[${i + 1}] Me`, ids: [i + 1] }));
  const parts = splitRows(rows, 17);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.map((r) => `${r.label}: ${r.text}`).join("\n")) <= 17);
  }
  for (const row of rows) {
    const fragments = parts.flat().filter((r) => r.label === row.label);
    assert.ok(fragments.every((r) => r.ids[0] === row.ids[0] && !/[\uD800-\uDFFF]/u.test(r.text)));
    assert.equal(fragments.map((r) => r.text).join(""), row.text);
  }
});

test("a short transcript takes one call and only valid source ids produce time links", async () => {
  const { summarizeParts } = await import("./main/summaryParts.ts");
  const lines = [summaryRow(71, 8.3, "First"), summaryRow(83, 6000.1, "Final"), summaryRow(97, 6000.8, "Agreed")];
  let calls = 0;
  const result = await summarizeParts(lines, 1000, async (stage, prompt) => {
    calls++;
    assert.equal(stage, "transcript");
    assert.match(prompt, /\[1\] Me: First/);
    assert.doesNotMatch(prompt, /1:40:00|\[71\]/);
    return { ...citedOverview("Published [55:55]", 3, 83, 2, 1, 2), decisions: [{ text: "Invented", ids: [99] }] };
  });
  assert.equal(calls, 1);
  assert.equal(result.overview, "Published [00:08] [1:40:00]");
  assert.deepEqual(result.decisions, []);
});

test("the merge model receives ordered, cited decisions and actions and can cite only its child notes", async () => {
  const { summarizeParts } = await import("./main/summaryParts.ts");
  const lines = [
    summaryRow(10, 5, "Plan A. " + "a".repeat(300)),
    summaryRow(20, 11, "No decision."),
    summaryRow(30, 15, "Plan B replaces A. " + "b".repeat(300)),
  ];
  const stages: string[] = [];
  const result = await summarizeParts(lines, 430, async (stage, prompt) => {
    stages.push(stage);
    if (stage === "transcript") {
      const later = prompt.includes("Plan B");
      const id = later ? 3 : 1;
      return {
        ...citedOverview("Release discussed", id),
        decisions: [{ text: later ? "Use B" : "Use A", ids: [id] }],
        actionItems: later ? [{ task: "Ship", owner: "Jin", due: "Friday", ids: [3] }] : [],
        topics: later ? [{ title: "QA", points: [{ text: "Run tests", ids: [3] }] }] : [],
      };
    }
    assert.ok(prompt.indexOf("Use A") >= 0 && prompt.indexOf("Use A") < prompt.indexOf("Use B"));
    assert.equal(prompt.match(/Release discussed/g)?.length, 2);
    for (const field of ["Ship", "Jin", "Friday", "QA", "Run tests"]) assert.ok(prompt.includes(field));
    assert.doesNotMatch(prompt, /\[2\]/);
    return {
      ...citedOverview("Release discussed", 1, 2, 3),
      decisions: [{ text: "Superseded: use A", ids: [1] }, { text: "Final: use B", ids: [3] }],
      actionItems: [{ task: "Ship", owner: "Jin", due: "Friday", ids: [3] }],
      topics: [{ title: "QA", points: [{ text: "Run tests", ids: [3] }] }],
    };
  });
  assert.deepEqual(stages, ["transcript", "transcript", "merge"]);
  assert.equal(result.overview, "Release discussed [00:05] [00:15]");
  assert.deepEqual(result.decisions, ["Superseded: use A [00:05]", "Final: use B [00:15]"]);
  assert.deepEqual(result.actionItems, [{ task: "Ship [00:15]", owner: "Jin", due: "Friday" }]);
  assert.deepEqual(result.topics, [{ title: "QA", points: ["Run tests [00:15]"] }]);
});

test("provider length errors shrink the failing part with bounded retries; unrelated errors propagate", async () => {
  const { summarizeParts } = await import("./main/summaryParts.ts");
  const lines = [summaryRow(10, 65, "a".repeat(6000))];
  const sizes: number[] = [];
  const result = await summarizeParts(lines, 8000, async (stage, prompt) => {
    if (stage === "transcript") {
      sizes.push(Buffer.byteLength(prompt));
      if (sizes.length === 1) throw Object.assign(new Error("Rejected"), { responseBody: '{"code":"context_length_exceeded"}' });
    }
    return citedOverview("Ready", 1);
  });
  assert.ok(sizes.length > 1 && sizes.slice(1).every((n) => n < sizes[0]));
  assert.equal(result.overview, "Ready [01:05]");
  const generic = new Error("Context window metadata unavailable");
  let attempts = 0;
  await assert.rejects(summarizeParts(lines, 8000, async () => { attempts++; throw generic; }), (e) => e === generic);
  assert.equal(attempts, 1);
  const tooLarge = Object.assign(new Error("Rejected"), { statusCode: 413 });
  attempts = 0;
  await assert.rejects(summarizeParts(lines, 8000, async () => { attempts++; throw tooLarge; }), (e) => e === tooLarge);
  assert.ok(attempts > 1 && attempts <= 5);
});

test("the worklet transfers thirteen owned blocks and acknowledges the last partial batch in order", async () => {
  const { TAP_WORKLET } = await import("./renderer/src/tapWorklet.ts");
  const { runInNewContext } = await import("node:vm");
  type Batch = { samples: Float32Array; blockSize: number };
  const sent: (Batch | string)[] = [];
  const port = {
    onmessage: (_e: { data: string }) => {},
    postMessage(value: Batch | string, transfer: ArrayBuffer[] = []) {
      if (typeof value !== "string") assert.equal(transfer[0], value.samples.buffer);
      sent.push(structuredClone(value, { transfer }));
    },
  };
  const tap = runInNewContext(TAP_WORKLET, {
    AudioWorkletProcessor: class { port = port; },
    registerProcessor: (_name: string, Processor: new () => object) => new Processor(),
  }) as { process(inputs: Float32Array[][]): boolean };
  const block = new Float32Array(128);
  for (let i = 0; i < 14; i++) tap.process([[block.fill(i)]]);
  tap.process([[new Float32Array(64).fill(14)]]);
  port.onmessage({ data: "drain" });
  assert.equal(tap.process([[block]]), false);
  assert.deepEqual(sent.map((x) => typeof x === "string" ? x : [x.blockSize, x.samples.length]), [
    [128, 1664], [128, 128], [64, 64], "drained",
  ]);
  const first = (sent[0] as Batch).samples;
  for (let i = 0; i < 13; i++) assert.ok(first.subarray(i * 128, (i + 1) * 128).every((n) => n === i));
});

test("GPT-Live waits for the opening boundary and stops converting at that boundary or 30 seconds", async () => {
  const { OpeningAudio } = await import("./renderer/src/gptLive.ts");
  const received: number[] = [];
  const collect = () => new OpeningAudio((pcm) => received.push(pcm.length));
  const block = new Int16Array(1664).fill(4096);
  let reads = 0;
  const read = () => { reads++; return block; };
  const beforeDelivery = collect();
  beforeDelivery.push(read);
  beforeDelivery.opened(0.125); // 2,000 samples; the second batch is still on the port.
  assert.deepEqual(received, []);
  beforeDelivery.push(read);
  beforeDelivery.push(read);
  beforeDelivery.stop();
  assert.deepEqual(received, [2000]);
  assert.equal(reads, 2);

  const late = collect();
  for (let i = 0; i < 310; i++) late.push(read);
  late.opened(40);
  late.stop();
  assert.deepEqual(received, [2000, 480000]);
  assert.equal(reads, 2 + Math.ceil(480000 / block.length));

  const stoppedEarly = collect();
  stoppedEarly.opened(1);
  stoppedEarly.push(read);
  stoppedEarly.stop();
  assert.deepEqual(received, [2000, 480000, 1664]);
});

test("caption times past a recording's end are pulled back inside it", async () => {
  const { openDb } = await import("./main/db.ts");
  const db = openDb(":memory:");
  const id = db.createMeeting("t");
  db.startRecording(id);
  db.raw.prepare("UPDATE meetings SET started_at = '2026-01-01T00:00:00.000Z', ended_at = '2026-01-01T00:00:07.505Z' WHERE id = ?").run(id);
  db.addUtterances(id, "mic", [{ startSec: 2, text: "a" }, { startSec: 7.911, text: "b" }]);
  db.clampUtterances(id);
  const times = db.getMeeting(id)!.utterances.map((u) => Math.round(u.startSec * 1000) / 1000);
  assert.deepEqual(times, [2, 7.005]);
});
