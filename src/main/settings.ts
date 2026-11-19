import { nativeTheme, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { translator } from "../shared/i18n";
import { DEFAULT_MODELS, type KeyName, type Settings, type StoredSettings } from "../shared/types";

const DEFAULTS: StoredSettings = {
  locale: "en",
  theme: "system",
  qgridUrl: "http://localhost:44900",
  live: { provider: "openai", model: DEFAULT_MODELS.live.openai },
  summary: { provider: "openai", model: DEFAULT_MODELS.summary.openai },
  language: "ko",
  glossary: "",
  recording: { micDeviceId: "", systemAudio: true },
};

export type SettingsStore = Awaited<ReturnType<typeof openSettings>>;

/** Plain settings in settings.json; API keys encrypted with the OS keychain in keys.bin. */
export async function openSettings(dir: string) {
  const settingsFile = path.join(dir, "settings.json");
  const keysFile = path.join(dir, "keys.bin");

  const { transcription, ...stored }: Partial<StoredSettings> & { transcription?: { provider: "qgrid" | "openai" } } =
    existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  let settings: StoredSettings = { ...DEFAULTS, ...stored };
  // Settings from when chunk transcription wrote the record: live captions write it now, and on
  // qgrid that means GPT-Live, the default. Saved once, so a later choice is never overridden.
  if (transcription) {
    const provider = stored.live?.provider ?? transcription.provider;
    settings.live = { provider, model: DEFAULT_MODELS.live[provider] };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }
  const keys = await readKeys(keysFile);

  // CSS prefers-color-scheme follows themeSource, so one switch re-themes every window.
  nativeTheme.themeSource = settings.theme;

  const view = (): Settings => ({
    ...settings,
    hasKey: { openai: !!keys.openai, anthropic: !!keys.anthropic },
  });

  return {
    get(): StoredSettings {
      return settings;
    },

    view,

    key(name: KeyName): string {
      const k = keys[name];
      if (!k) throw new Error(translator(settings.locale)("error.noKey", { name: name === "openai" ? "OpenAI" : "Anthropic" }));
      return k;
    },

    patch(patch: Partial<StoredSettings>): Settings {
      settings = { ...settings, ...patch };
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      nativeTheme.themeSource = settings.theme;
      return view();
    },

    async setKey(name: KeyName, value: string): Promise<Settings> {
      if (value.trim()) keys[name] = value.trim();
      else delete keys[name];
      await writeKeys(keysFile, keys);
      return view();
    },
  };
}

/**
 * The keychain secret is tied to the app name, so a rename, a wiped keychain item, or a copied data
 * folder leaves keys.bin undecryptable. Start without keys instead of failing to launch; the user
 * re-enters them and the next save overwrites the file.
 */
async function readKeys(file: string): Promise<Partial<Record<KeyName, string>>> {
  if (!existsSync(file)) return {};
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(file));
    const keys = JSON.parse(result);
    // The keychain secret was rotated; store the keys under the current one.
    if (shouldReEncrypt) await writeKeys(file, keys);
    return keys;
  } catch (e) {
    console.warn("[seogi] stored API keys could not be decrypted; starting without keys:", e);
    return {};
  }
}

async function writeKeys(file: string, keys: Partial<Record<KeyName, string>>) {
  writeFileSync(file, await safeStorage.encryptStringAsync(JSON.stringify(keys)));
}
