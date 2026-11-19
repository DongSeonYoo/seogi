import { translator, type Translate } from "../shared/i18n.ts";
import { GPT_LIVE_MODEL, type ModelList, type ModelOption, type ModelRole } from "../shared/types.ts";
import type { SettingsStore } from "./settings";

// qgrid's GET /api/qgrid/models: every served model by task, with prices.
type CatalogText = {
  id: string;
  available: boolean;
  pricing: { input: number; output: number; cachedInput: number };
  efforts: string[];
};
type CatalogSpeech = { id: string; available: boolean; usdPerMinute?: number; prompt: boolean; liveDraft: boolean };
type Catalog = { text: CatalogText[]; transcription: CatalogSpeech[]; transcriptionStream: CatalogSpeech[] };

const usd = (n: number) => `$${Number(n.toPrecision(3))}`;

function speechOption(m: CatalogSpeech, t: Translate): ModelOption {
  const parts = [
    m.usdPerMinute !== undefined && t("model.perMinute", { price: usd(m.usdPerMinute) }),
    m.prompt ? t("model.glossary") : t("model.noGlossary"),
    m.liveDraft && t("model.liveDraft"),
  ];
  return { id: m.id, available: m.available, detail: parts.filter(Boolean).join(" · ") };
}

function textOption(m: CatalogText, t: Translate): ModelOption {
  const { input, cachedInput, output } = m.pricing;
  return {
    id: m.id,
    available: m.available,
    detail: t("model.tokens", { input: usd(input), cached: usd(cachedInput), output: usd(output) }),
    efforts: m.efforts,
  };
}

/**
 * The models a provider offers for a role. qgrid answers from its catalog; OpenAI and Anthropic
 * list what the stored key can use, filtered by name because their lists carry no task or price.
 */
export async function listModels(store: SettingsStore, role: ModelRole, provider: string): Promise<ModelList> {
  const t = translator(store.get().locale);
  try {
    if (provider === "qgrid") {
      const catalog: Catalog = await getJson(`${store.get().qgridUrl.replace(/\/$/, "")}/api/qgrid/models`);
      const models =
        role === "summary"
          ? catalog.text.map((x) => textOption(x, t))
          : catalog.transcriptionStream.map((x) => speechOption(x, t));
      // Not a transcription model in qgrid's catalog: the conversational GPT-Live, kept for its transcript.
      if (role === "live") {
        const openai = catalog.text.some((x) => x.id.startsWith("openai/") && x.available);
        models.push({ id: GPT_LIVE_MODEL, available: openai, detail: t("model.gptLive") });
      }
      return { ok: true, models };
    }
    if (provider === "openai") {
      const { data } = await getJson<{ data: { id: string }[] }>("https://api.openai.com/v1/models", {
        authorization: `Bearer ${store.key("openai")}`,
      });
      const speech = (id: string) => /transcribe|whisper/.test(id);
      const keep =
        role === "summary"
          ? (id: string) => /^(gpt-|o\d)/.test(id) && !/transcribe|whisper|tts|realtime|audio|image|search|embedding/.test(id)
          : speech;
      return { ok: true, models: data.map((m) => m.id).filter(keep).sort().map((id) => ({ id, available: true })) };
    }
    const { data } = await getJson<{ data: { id: string; display_name?: string }[] }>(
      "https://api.anthropic.com/v1/models?limit=100",
      { "x-api-key": store.key("anthropic"), "anthropic-version": "2023-06-01" },
    );
    return { ok: true, models: data.map((m) => ({ id: m.id, available: true, detail: m.display_name })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}
