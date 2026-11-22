import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import qgrid from "@cartanova/qgrid-ai-sdk";
import { generateText, Output, transcribe, type LanguageModel } from "ai";
import { z } from "zod";
import type { ConnectionResult, ConnectionRole, SpeakerNames, Summary, Utterance } from "../shared/types";
import { glossaryPrompt, glossaryTerms, isPromptEcho, type Transcript } from "./transcription.ts";
import { transcribeLocalFile } from "./localSpeech.ts";
import type { SettingsStore } from "./settings";
import { summarizeParts, SUMMARY_INPUT, SUMMARY_OUTPUT, type CitedNotes } from "./summaryParts.ts";

/** Imported audio files go through a file transcriber of the live caption provider: faster than real time. */
const FILE_MODEL = { qgrid: "openai/gpt-transcribe", openai: "gpt-4o-transcribe" } as const;

/** One piece of an imported file, with the meeting's glossary; `lang` "auto" lets the model detect it. */
export async function transcribeFile(store: SettingsStore, wav: Uint8Array, glossary: string, lang = store.get().language, abortSignal?: AbortSignal): Promise<Transcript> {
  const s = store.get();
  if (s.live.provider === "local") return transcribeLocalFile(wav, lang, glossaryTerms(glossary));
  const id = FILE_MODEL[s.live.provider];
  // Detecting the language, a hint in another language (Korean names under "용어:") pulls short
  // lines toward it, so the glossary goes only with a chosen language, prefixed in that language.
  const prompt = glossary.trim() && lang !== "auto" ? glossaryPrompt(lang, glossary) : undefined;
  const model =
    s.live.provider === "qgrid"
      ? qgrid.transcription(id as Parameters<typeof qgrid.transcription>[0], { serverUrl: s.qgridUrl })
      : createOpenAI({ apiKey: store.key("openai") }).transcription(id);
  // "auto" leaves language detection to the model.
  const language = lang === "auto" ? {} : { language: lang };
  const r = await transcribe({ model, audio: wav, providerOptions: { openai: { ...language, ...(prompt && { prompt }) } }, maxRetries: 2, abortSignal });
  const text = prompt && isPromptEcho(r.text, prompt) ? "" : r.text.trim();
  return { text, words: r.segments };
}

const ids = z.array(z.number().int());
const point = z.object({ text: z.string(), ids });
const SummarySchema = z.object({
  title: z.string().describe("A short title that captures the meeting"),
  overview: z.array(point).describe("Three to five concise overview points"),
  decisions: z.array(point).describe("Decisions in order, identifying earlier decisions later superseded"),
  actionItems: z
    .array(
      z.object({
        owner: z.string().describe("Who owns it; if unclear, the word for 'undecided' in the notes' language"),
        task: z.string(),
        ids,
        due: z.string().describe("When it is due; if never mentioned, the word for 'undecided' in the notes' language"),
      }),
    )
    .describe("Follow-up work"),
  topics: z
    .array(z.object({ title: z.string(), points: z.array(point) }))
    .describe("Key points per topic discussed"),
}) satisfies z.ZodType<CitedNotes>;

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
  transcript: Utterance[],
  glossary = store.get().glossary,
  model = store.get().summary.model,
  names: SpeakerNames = {},
): Promise<Summary> {
  const s = store.get();
  const languageModel = summaryModel(store, s, model);
  const instructions = [
    LANGUAGE_NAMES[s.language] ? `Write every field in ${LANGUAGE_NAMES[s.language]}.`
      : "Use the language of the meeting throughout the notes.",
    "Use only supplied material. Put supporting numeric source ids in each ids array. Never put citations or times in prose.",
    "Keep decisions in chronological order. Explicitly identify superseded decisions and the final choice. Preserve task owners and deadlines.",
    glossary.trim() && `Glossary: ${glossary}`,
  ].filter(Boolean).join("\n");
  const prompts = {
    transcript: instructions + "\nSummarize the numbered transcript. Me is the recorder, Others is the remote track, numbered speakers are distinct voices, and any other label is that voice's name. Use the glossary to correct transcription errors.",
    merge: instructions + "\nCombine these chronological partial notes. Consolidate duplicate facts and actions, keeping their supporting ids. Keep reversals and distinct speakers separate. Only cite ids attached to these notes.",
  };
  const budget = SUMMARY_INPUT - Math.max(Buffer.byteLength(prompts.transcript), Buffer.byteLength(prompts.merge));
  return summarizeParts(transcript, budget, async (stage, prompt) => {
    const { output } = await generateText({
      model: languageModel,
      ...(s.summary.provider === "qgrid" && model === s.summary.model && s.summary.effort &&
        { providerOptions: { qgrid: { effort: s.summary.effort } } }),
      output: Output.object({ schema: SummarySchema }), system: prompts[stage], prompt,
      maxOutputTokens: SUMMARY_OUTPUT, maxRetries: 2,
    });
    return output;
  }, names);
}

/** Translation is per line as lines settle, so the quickest model and tier: about 1.5 s a line on qgrid. */
const TRANSLATE_MODEL = "openai/gpt-6-luna";
const TranslationSchema = z.object({ lines: z.array(z.string()) });

/** `lines` in `lang`, in order; `before` are the lines just before them, for context only. */
export async function translateLines(store: SettingsStore, lines: string[], before: string[], lang: string, glossary: string): Promise<string[]> {
  const s = store.get();
  const qgridModel = s.summary.provider === "qgrid";
  const { output } = await generateText({
    model: summaryModel(store, s, qgridModel ? TRANSLATE_MODEL : s.summary.model),
    ...(qgridModel && { providerOptions: { qgrid: { effort: "none", serviceTier: "fast" } } }),
    output: Output.object({ schema: TranslationSchema }),
    system: [
      `Translate each line of a live meeting transcript into natural spoken ${LANGUAGE_NAMES[lang] ?? lang}.`,
      "Return exactly one translation per line, in order. Keep names and product terms as they are.",
      "Use one polite, neutral speech level for every line, whoever speaks.",
      glossary.trim() && `Glossary: ${glossary}`,
    ].filter(Boolean).join("\n"),
    prompt: JSON.stringify({ context: before, lines }),
    maxRetries: 1,
  });
  return output.lines;
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
