import assert from "node:assert/strict";
import { test } from "node:test";
import { isPromptEcho } from "./main/ai.ts";
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

  // A different speaker in between, finished sentences, and a long gap all stay separate.
  assert.equal(joinSplitSentences([u(1, "system", 32, "말이 끊겼는데"), u(2, "mic", 33, "네.")]).length, 2);
  assert.equal(joinSplitSentences([u(1, "system", 32, "말이 끊겼는데", 1), u(2, "system", 33, "네.", 2)]).length, 2);
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
  assert.deepEqual(stored, [{ track: "mic", startSec: 1, text: "첫 문장입니다." }]);

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

test("appendDelta spaces a new sentence but not a decimal or a delta that brings its own space", async () => {
  const { appendDelta } = await import("./shared/text.ts");
  assert.equal(appendDelta("이야기합니다.", "서기 앱에서"), "이야기합니다. 서기 앱에서");
  assert.equal(appendDelta("버전 2.", "23"), "버전 2.23");
  assert.equal(appendDelta("Hello.", " World"), "Hello. World");
  assert.equal(appendDelta("오늘은", " 큐그리드"), "오늘은 큐그리드");
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
