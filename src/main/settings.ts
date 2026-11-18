import { nativeTheme, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODELS, type KeyName, type Settings, type StoredSettings } from "../shared/types";

const DEFAULTS: StoredSettings = {
  theme: "system",
  qgridUrl: "http://localhost:44900",
  transcription: { provider: "openai", model: DEFAULT_MODELS.transcription.openai },
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

  let settings: StoredSettings = existsSync(settingsFile)
    ? { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, "utf8")) }
    : DEFAULTS;
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
      if (!k) throw new Error(`${name} API key가 없습니다. 설정에서 입력해 주세요.`);
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
