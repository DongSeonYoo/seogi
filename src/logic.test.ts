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

test("joinSplitSentences rejoins a sentence cut at a chunk boundary, and nothing else", async () => {
  const { joinSplitSentences } = await import("./shared/transcript.ts");
  const u = (id: number, track: "mic" | "system", startSec: number, text: string) => ({ id, track, startSec, text });

  const joined = joinSplitSentences([
    u(1, "system", 32, "쿠폰 문제는 동선님이 이번 주 수요일까지"),
    u(2, "system", 35, "수정하기로 했습니다."),
    u(3, "system", 38, "다음 안건입니다."),
  ]);
  assert.deepEqual(joined.map((x) => x.text), ["쿠폰 문제는 동선님이 이번 주 수요일까지 수정하기로 했습니다.", "다음 안건입니다."]);
  assert.equal(joined[0].id, 1); // keeps the first piece's id and start time for playback
  assert.equal(joined[0].startSec, 32);

  // A different speaker in between, finished sentences, and a long gap all stay separate.
  assert.equal(joinSplitSentences([u(1, "system", 32, "말이 끊겼는데"), u(2, "mic", 33, "네.")]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "끝난 문장입니다."), u(2, "system", 35, "새 문장.")]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "끝맺음 없음"), u(2, "system", 90, "한참 뒤.")]).length, 2);
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

test("live drafts leave only once successful chunks cover their whole span", async () => {
  const { LiveCaptions } = await import("./main/live.ts");
  const c = new LiveCaptions(() => ({ audio() {}, stop() {} }), () => {});
  const seg = (id: string, startSec: number, endSec: number) =>
    c.onEvent("system", { type: "segment", id, text: id, startSec, endSec });
  const keys = () => c.view().lines.map((l) => l.text);

  seg("a", 2, 6); // inside chunk 0-30
  seg("b", 28, 33); // straddles the 30 s cut
  seg("c", 40, 44); // inside chunk 30-60
  c.onEvent("system", { type: "delta", id: "d", text: "말하는 중", atSec: 61 }); // still open

  c.settle("system", 30, 60); // out of order: the later chunk lands first
  assert.deepEqual(keys(), ["a", "b", "말하는 중"]); // b keeps its 28-30 s part until chunk 0 lands
  c.settle("mic", 0, 30); // the other track settles nothing here
  assert.deepEqual(keys(), ["a", "b", "말하는 중"]);
  c.settle("system", 0, 30);
  assert.deepEqual(keys(), ["말하는 중"]);
  seg("e", 50, 55); // a draft finishing after its chunk already landed never shows
  assert.deepEqual(keys(), ["말하는 중"]);
  c.settle("system", 60, 90); // a delta that never got its segment leaves once a segment's span is covered
  assert.deepEqual(keys(), []);

  // GPT-Live: one long turn of timed deltas. Covered pieces leave; the rest continues as a fresh draft.
  const d = (text: string, atSec: number, endSec: number) => c.onEvent("mic", { type: "delta", id: "t1", text, atSec, endSec });
  d("첫 문장", 102, 105);
  d(" 둘째", 125, 129);
  assert.deepEqual(keys(), ["첫 문장 둘째"]);
  c.settle("mic", 100, 130);
  assert.deepEqual(keys(), []);
  d(" 이미 받아쓴 부분", 128, 129.5); // arrived late, inside the settled chunk: dropped
  d(" 셋째", 131, 134);
  assert.deepEqual(keys(), ["셋째"]);
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
    const ids = async (role: "live" | "transcription" | "summary", provider: string) => {
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
    assert.deepEqual((await ids("transcription", "openai")).map((m) => m.id), ["gpt-4o-transcribe", "whisper-1"]);
    assert.deepEqual((await ids("live", "openai")).map((m) => m.id), ["gpt-4o-transcribe", "gpt-realtime-whisper", "whisper-1"]);
    assert.deepEqual((await ids("summary", "openai")).map((m) => m.id), ["gpt-6-luna"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("library changes undo and redo, deletes purge for real, and a resummary keeps a typed title", async () => {
  const { openDb } = await import("./main/db.ts");
  const { History, perform } = await import("./main/library.ts");
  const { translator } = await import("./shared/i18n.ts");
  const db = openDb(":memory:");
  const history = new History();
  const run = (op: Parameters<typeof perform>[2]) => perform(db, history, op, translator("ko"));
  const titles = () => db.listMeetings("all").map((m) => m.title);
  const summary = { title: "요약 제목", overview: "", decisions: [], actionItems: [], topics: [] };

  const a = db.createMeeting("회의 A");
  const b = db.createMeeting("회의 B");
  assert.deepEqual(run({ type: "delete", ids: [a] }), { ok: false, error: "녹음하거나 정리 중인 회의는 삭제할 수 없습니다" });
  db.setStatus(a, "done");
  db.setStatus(b, "done");

  run({ type: "rename", id: a, title: "내 제목" });
  db.setSummary(a, summary);
  assert.equal(db.getMeeting(a)?.title, "내 제목");
  history.undo();
  assert.equal(db.getMeeting(a)?.title, "회의 A");

  const folder = run({ type: "createFolder", name: "고객사" });
  assert.ok(folder.ok && folder.id);
  run({ type: "move", ids: [a, b], folderId: folder.id! });
  run({ type: "star", ids: [b], starred: true });
  assert.deepEqual(db.listFolders(), [{ id: folder.id, name: "고객사", count: 2 }]);
  assert.equal(db.counts().starred, 1);
  assert.equal(history.undo(), "즐겨찾기");
  assert.equal(history.undo(), "폴더 이동");
  assert.equal(db.listMeetings(folder.id!).length, 0);
  assert.equal(history.redo(), "폴더 이동");
  assert.equal(db.listMeetings(folder.id!).length, 2);

  run({ type: "deleteFolder", id: folder.id! });
  assert.equal(db.listFolders().length, 0);
  assert.equal(db.listMeetings("all").every((m) => m.folderId === null), true); // unfiled while deleted
  history.undo();

  run({ type: "delete", ids: [a] });
  assert.deepEqual(titles(), ["회의 B"]);
  assert.equal(db.counts().all, 1);
  history.undo();
  assert.equal(db.counts().all, 2);
  history.redo();
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
