import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODELS, type Settings, type SettingsUpdate } from "../shared/types";

type Keys = { openai?: string; anthropic?: string };
type Stored = Omit<Settings, "hasKey">;

const DEFAULTS: Stored = {
  qgridUrl: "http://localhost:44900",
  transcription: { provider: "openai", model: DEFAULT_MODELS.transcription.openai },
  summary: { provider: "openai", model: DEFAULT_MODELS.summary.openai },
  language: "ko",
  glossary: "",
};

export type SettingsStore = ReturnType<typeof openSettings>;

/** Plain settings in settings.json; API keys encrypted with the OS keychain in keys.bin. */
export function openSettings(dir: string) {
  const settingsFile = path.join(dir, "settings.json");
  const keysFile = path.join(dir, "keys.bin");

  let settings: Stored = existsSync(settingsFile)
    ? { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, "utf8")) }
    : DEFAULTS;
  let keys: Keys = existsSync(keysFile)
    ? JSON.parse(safeStorage.decryptString(readFileSync(keysFile)))
    : {};

  return {
    get(): Stored {
      return settings;
    },

    view(): Settings {
      return { ...settings, hasKey: { openai: !!keys.openai, anthropic: !!keys.anthropic } };
    },

    key(name: keyof Keys): string {
      const k = keys[name];
      if (!k) throw new Error(`${name} API key가 없습니다. 설정에서 입력해 주세요.`);
      return k;
    },

    save({ keys: keyUpdate, ...next }: SettingsUpdate) {
      settings = next;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      if (!keyUpdate) return;
      for (const name of ["openai", "anthropic"] as const) {
        const v = keyUpdate[name];
        if (v === undefined) continue;
        if (v) keys[name] = v.trim();
        else delete keys[name];
      }
      writeFileSync(keysFile, safeStorage.encryptString(JSON.stringify(keys)));
    },
  };
}
