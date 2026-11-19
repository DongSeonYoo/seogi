import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import qgrid from "@cartanova/qgrid-ai-sdk";
import { generateText, Output, transcribe, type LanguageModel } from "ai";
import { z } from "zod";
import type { ConnectionResult, ConnectionRole, Summary } from "../shared/types";
import type { SettingsStore } from "./settings";

/** Imported audio files go through a file transcriber of the live caption provider: faster than real time. */
const FILE_MODEL = { qgrid: "openai/gpt-transcribe", openai: "gpt-4o-transcribe" } as const;

export type Transcript = { text: string; words: { startSecond: number }[] };

/** One chunk of an imported file, with the meeting's glossary. */
export async function transcribeFile(store: SettingsStore, wav: Uint8Array, glossary: string): Promise<Transcript> {
  const s = store.get();
  const id = FILE_MODEL[s.live.provider];
  const prompt = glossary.trim() ? glossaryPrompt(s.language, glossary) : undefined;
  const model =
    s.live.provider === "qgrid"
      ? qgrid.transcription(id as Parameters<typeof qgrid.transcription>[0], { serverUrl: s.qgridUrl })
      : createOpenAI({ apiKey: store.key("openai") }).transcription(id);
  // "auto" leaves language detection to the model.
  const language = s.language === "auto" ? {} : { language: s.language };
  const r = await transcribe({ model, audio: wav, providerOptions: { openai: { ...language, ...(prompt && { prompt }) } }, maxRetries: 2 });
  const text = prompt && isPromptEcho(r.text, prompt) ? "" : r.text.trim();
  return { text, words: r.segments };
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

/**
 * On noise without speech, prompted caption models read the glossary prompt back as the transcript.
 * Treats a transcript that is only a piece of the prompt as empty. A lone glossary word that
 * was really spoken is dropped too.
 */
export function isPromptEcho(text: string, prompt: string): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, "");
  const t = norm(text);
  return t.length > 0 && norm(prompt).includes(t);
}

/** Steers the spelling of names and terms; the prefix is in the meeting's language. */
export function glossaryPrompt(language: string, glossary: string) {
  return `${language === "ko" ? "용어" : "Glossary"}: ${glossary}`;
}

const SummarySchema = z.object({
  title: z.string().describe("A short title that captures the meeting"),
  overview: z.string().describe("The whole meeting in 3-5 sentences"),
  decisions: z.array(z.string()).describe("Decisions the meeting settled"),
  actionItems: z
    .array(
      z.object({
        owner: z.string().describe("Who owns it; if unclear, the word for 'undecided' in the notes' language"),
        task: z.string(),
        due: z.string().describe("When it is due; if never mentioned, the word for 'undecided' in the notes' language"),
      }),
    )
    .describe("Follow-up work"),
  topics: z
    .array(z.object({ title: z.string(), points: z.array(z.string()) }))
    .describe("Key points per topic discussed"),
}) satisfies z.ZodType<Summary>;

const LANGUAGE_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese" };

function summaryModel(store: SettingsStore, s: ReturnType<SettingsStore["get"]>, model = s.summary.model): LanguageModel {
  const { provider } = s.summary;
  if (provider === "qgrid") return qgrid(model as never, { serverUrl: s.qgridUrl });
  if (provider === "openai") return createOpenAI({ apiKey: store.key("openai") })(model);
  return createAnthropic({ apiKey: store.key("anthropic") })(model);
}

/**
 * `glossary` is the meeting's: its own, or the shared one from Settings. `model` picks another
 * model of the summary provider; the saved effort applies only to the saved model.
 */
export async function summarize(
  store: SettingsStore,
  transcript: string,
  glossary = store.get().glossary,
  model = store.get().summary.model,
): Promise<Summary> {
  const s = store.get();
  const { output } = await generateText({
    model: summaryModel(store, s, model),
    ...(s.summary.provider === "qgrid" &&
      model === s.summary.model &&
      s.summary.effort && { providerOptions: { qgrid: { effort: s.summary.effort } } }),
    output: Output.object({ schema: SummarySchema }),
    system: [
      "You write meeting notes. Read the transcript and produce structured notes.",
      // The notes follow the meeting, not the app's UI language.
      LANGUAGE_NAMES[s.language]
        ? `Write every field in ${LANGUAGE_NAMES[s.language]}.`
        : "Write every field in the language most of the meeting was held in.",
      "'Me' is the person recording; 'Others' is everyone on the other end of the call, possibly several people.",
      "Fix words that look like transcription errors, using the context and the glossary.",
      "Do not add anything the transcript does not say.",
      "End each overview sentence, decision, action item and point with the [mm:ss] time of the transcript line it comes from, as written there, e.g. 'Ship on Friday [12:05]'. Use only times that appear in the transcript.",
      glossary.trim() && `Glossary: ${glossary}`,
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: transcript,
    maxRetries: 2,
  });
  return output;
}

/** One cheap real request through the configured provider, so a bad key or model shows up now. */
export async function testConnection(store: SettingsStore, role: ConnectionRole): Promise<ConnectionResult> {
  const started = Date.now();
  try {
    if (role === "summary") await generateText({ model: summaryModel(store, store.get()), prompt: "Reply with OK.", maxRetries: 0 });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
