import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import qgrid from "@cartanova/qgrid-ai-sdk";
import { generateText, Output, transcribe, type LanguageModel } from "ai";
import { z } from "zod";
import type { Summary } from "../shared/types";
import type { SettingsStore } from "./settings";

export type Transcript = { text: string; words: { startSecond: number }[]; durationSec: number };

export async function transcribeWav(store: SettingsStore, wav: Uint8Array): Promise<Transcript> {
  const s = store.get();
  const { provider, model: id } = s.transcription;
  const prompt = s.glossary.trim() ? `용어: ${s.glossary}` : undefined;

  const model =
    provider === "qgrid"
      ? qgrid.transcription(id as Parameters<typeof qgrid.transcription>[0], {
          serverUrl: s.qgridUrl,
        })
      : createOpenAI({ apiKey: store.key("openai") }).transcription(id);

  const providerOptions: Record<string, Record<string, string>> = id.startsWith("grok/")
    ? { xai: { language: s.language } }
    : { openai: { language: s.language, ...(prompt && { prompt }) } };

  const r = await transcribe({ model, audio: wav, providerOptions, maxRetries: 2 });
  const text = prompt && isPromptEcho(r.text, prompt) ? "" : r.text.trim();
  return { text, words: r.segments, durationSec: r.durationInSeconds ?? 0 };
}

/**
 * On noise without speech, prompted models read the glossary prompt back as the transcript.
 * Treats a transcript that is only a piece of the prompt as empty. A lone glossary word that
 * was really spoken is dropped too.
 */
export function isPromptEcho(text: string, prompt: string): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, "");
  const t = norm(text);
  return t.length > 0 && norm(prompt).includes(t);
}

/**
 * Splits a chunk transcript into sentences and dates each one. Word timings (when the provider
 * returns them) place a sentence by its character position; without them it is interpolated
 * over the chunk length.
 */
export function splitUtterances(t: Transcript, chunkStartSec: number, chunkSec: number) {
  const sentences = t.text.split(/(?<=[.?!。])\s+/).filter((x) => x.trim());
  const total = t.text.length || 1;
  let offset = 0;
  return sentences.map((text) => {
    const frac = offset / total;
    offset += text.length + 1;
    const rel = t.words.length
      ? t.words[Math.min(t.words.length - 1, Math.floor(frac * t.words.length))].startSecond
      : frac * chunkSec;
    return { startSec: chunkStartSec + rel, text };
  });
}

const SummarySchema = z.object({
  title: z.string().describe("회의를 대표하는 짧은 제목"),
  overview: z.string().describe("회의 전체를 3~5문장으로 요약"),
  decisions: z.array(z.string()).describe("회의에서 확정된 결정사항"),
  actionItems: z
    .array(
      z.object({
        owner: z.string().describe("담당자. 불명확하면 '미정'"),
        task: z.string(),
        due: z.string().describe("기한. 언급이 없으면 '미정'"),
      }),
    )
    .describe("후속 작업"),
  topics: z
    .array(z.object({ title: z.string(), points: z.array(z.string()) }))
    .describe("논의된 주제별 핵심 내용"),
}) satisfies z.ZodType<Summary>;

function summaryModel(store: SettingsStore, s: ReturnType<SettingsStore["get"]>): LanguageModel {
  const { provider, model } = s.summary;
  if (provider === "qgrid") return qgrid(model as never, { serverUrl: s.qgridUrl });
  if (provider === "openai") return createOpenAI({ apiKey: store.key("openai") })(model);
  return createAnthropic({ apiKey: store.key("anthropic") })(model);
}

export async function summarize(store: SettingsStore, transcript: string): Promise<Summary> {
  const s = store.get();
  const { output } = await generateText({
    model: summaryModel(store, s),
    output: Output.object({ schema: SummarySchema }),
    system: [
      "너는 회의록 작성자다. 전사본을 읽고 한국어로 구조화된 회의록을 만든다.",
      "'나'는 녹음한 사용자, '상대'는 통화 상대방이다. 상대가 여러 명일 수 있다.",
      "전사 오류로 보이는 단어는 문맥과 용어집에 맞춰 바로잡는다.",
      "전사본에 없는 내용은 지어내지 않는다.",
      s.glossary.trim() && `용어집: ${s.glossary}`,
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: transcript,
    maxRetries: 2,
  });
  return output;
}
