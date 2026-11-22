import { app, nativeTheme, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { translator } from "../shared/i18n";
import { DEFAULT_MODELS, type KeyName, type Settings, type StoredSettings } from "../shared/types";

const DEFAULTS: StoredSettings = {
  locale: "en",
  theme: "system",
  style: "seogi",
  depth: 50,
  qgridUrl: "http://localhost:44900",
  // On this Mac: works with no account or key (macOS 26).
  live: { provider: "local", model: DEFAULT_MODELS.live.local },
  // The signed-in ChatGPT plan: no key; until signed in, summaries ask for it.
  summary: { provider: "chatgpt", model: DEFAULT_MODELS.summary.chatgpt },
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
  // Not awaited: decrypting asks the keychain, which can show a prompt (after the app's signature
  // changes, for one) and waits for an answer; the window must not wait with it.
  let keys: Partial<Record<KeyName, string>> = {};
  const keysLoaded = readKeys(keysFile).then((k) => {
    keys = k;
  });

  // CSS prefers-color-scheme follows themeSource, so one switch re-themes every window.
  nativeTheme.themeSource = settings.theme;

  const chatgptEmail = () => {
    if (!keys.chatgpt) return null;
    const a: { email: string; refreshToken: string } = JSON.parse(keys.chatgpt);
    return a.refreshToken ? { email: a.email } : null; // a refused refresh token means signed out
  };
  const view = (): Settings => ({
    ...settings,
    hasKey: { openai: !!keys.openai, anthropic: !!keys.anthropic },
    chatgpt: chatgptEmail(),
  });

  return {
    get(): StoredSettings {
      return settings;
    },

    view,

    /** A stored secret, or undefined. */
    secret(name: KeyName): string | undefined {
      return keys[name];
    },

    /** Text in the app's language, for errors made in the main process. */
    t: ((key, vars) => translator(settings.locale)(key, vars)) as ReturnType<typeof translator>,

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
      await keysLoaded; // or the write would drop the keys not yet read
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
  if (!app.isPackaged) return JSON.parse(readFileSync(file, "utf8"));
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

/**
 * No keys, no file: the keychain is asked only once a key exists (qgrid needs none). Development
 * builds (their own Seogi-dev folder) keep keys as plain JSON, so they never prompt either.
 */
async function writeKeys(file: string, keys: Partial<Record<KeyName, string>>) {
  if (!Object.keys(keys).length) return rmSync(file, { force: true });
  writeFileSync(file, app.isPackaged ? await safeStorage.encryptStringAsync(JSON.stringify(keys)) : JSON.stringify(keys));
}
