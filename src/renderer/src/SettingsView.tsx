import { Cpu, FolderOpen, HardDrive, Info, Languages, Mic, Plug, SlidersHorizontal, Square } from "lucide-react";
import { useId, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_MODELS,
  LIVE_TEST_ID,
  type LiveView,
  type AppInfo,
  type ConnectionResult,
  type ConnectionRole,
  type KeyName,
  type LiveProvider,
  type ModelList,
  type ModelOption,
  type ModelRole,
  type Settings,
  type StorageInfo,
  type StoredSettings,
  type SummaryProvider,
  type AppStyle,
  type ThemeMode,
} from "../../shared/types";
import { liveCaptionHooks } from "./gptLive";
import { startRecording } from "./recorder";
import { useT } from "./i18n";
import { LOCALES, showStored, type Locale, type MessageKey } from "../../shared/i18n";
import { Button, CommitInput, Kbd, Segmented, Select, Switch, useAppStyle } from "./ui";
import { onAccent } from "./format";

const SECTIONS = [
  { id: "general", label: "settings.general", icon: SlidersHorizontal },
  { id: "models", label: "settings.models", icon: Cpu },
  { id: "transcription", label: "settings.transcription", icon: Languages },
  { id: "recording", label: "settings.recording", icon: Mic },
  { id: "storage", label: "settings.storage", icon: HardDrive },
  { id: "about", label: "settings.about", icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** The settings window (⌘,): macOS toolbar tabs over grouped rows; changes apply at once. */
export function SettingsView() {
  const t = useT();
  const [section, setSection] = useState<SectionId>("general");
  const [s, setS] = useState<Settings | null>(null);
  const [recording, setRecording] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => void window.api.getSettings().then(setS), []);
  useEffect(() => {
    const load = () => void window.api.library().then((l) => setRecording(l.counts.recording));
    load();
    return window.api.onMeetingChanged(load);
  }, []);
  useEffect(() => {
    const apply = (hex: string) => {
      document.documentElement.style.setProperty("--system-accent", hex);
      document.documentElement.style.setProperty("--system-on-accent", onAccent(hex));
    };
    void window.api.accentColor().then(apply);
    return window.api.onAccentColor(apply);
  }, []);
  useAppStyle();
  // Edit-menu undo here only ever means a text field.
  useEffect(
    () =>
      window.api.onMenuAction((id) => {
        if (id === "undo" || id === "redo") document.execCommand(id);
      }),
    [],
  );
  // Esc closes the window unless a field or a dialog is handling it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      window.close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function patch(p: Partial<StoredSettings>) {
    try {
      setS(await window.api.patchSettings(p));
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="prefs">
      <header className="prefs__toolbar drag">
        <h1 className="prefs__title">{t(SECTIONS.find((x) => x.id === section)!.label)}</h1>
        <nav
          className="prefs__tabs"
          role="tablist"
          aria-label={t("settings.tabs")}
          // One tab stop: arrows move between tabs (and select them), Home/End jump to the ends.
          onKeyDown={(e) => {
            const i = SECTIONS.findIndex((x) => x.id === section);
            const n = SECTIONS.length;
            const next =
              e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
            if (next < 0) return;
            e.preventDefault();
            setSection(SECTIONS[next].id);
            document.getElementById(`tab-${SECTIONS[next].id}`)?.focus();
          }}
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              className="prefs__tab"
              aria-selected={id === section}
              aria-controls="settings-panel"
              tabIndex={id === section ? 0 : -1}
              onClick={() => setSection(id)}
            >
              <Icon aria-hidden />
              <span>{t(label)}</span>
            </button>
          ))}
        </nav>
      </header>
      <div className="settings selectable" id="settings-panel" role="tabpanel" aria-labelledby={`tab-${section}`}>
        <div className="settings__inner">
          {saveError && (
            <p className="notice" role="alert">
              {t("settings.saveFailed", { error: saveError })}
            </p>
          )}
          {s && section === "general" && <General s={s} patch={patch} />}
          {s && section === "models" && <Models s={s} patch={patch} setS={setS} />}
          {s && section === "transcription" && <Transcription s={s} patch={patch} />}
          {s && section === "recording" && <RecordingSection s={s} patch={patch} recording={recording} />}
          {section === "storage" && <Storage />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

type SectionProps = { s: Settings; patch: (p: Partial<StoredSettings>) => Promise<void> };

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title && <h2 className="settings-group__title">{title}</h2>}
      <div className="settings-group__rows">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  htmlFor,
  stack,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={stack ? "setting-row setting-row--stack" : "setting-row"}>
      <div className="setting-row__text">
        <label className="setting-row__label" id={`${id}-label`} htmlFor={htmlFor}>
          {label}
        </label>
        {description && <p className="setting-row__desc" id={`${id}-desc`}>{description}</p>}
      </div>
      {/* The control is named and described by this row, whatever kind of control it is. */}
      <div
        className="setting-row__control"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
      >
        {children}
      </div>
    </div>
  );
}

function General({ s, patch }: SectionProps) {
  const t = useT();
  return (
    <Group>
      <Row label={t("settings.language")} description={t("settings.languageDesc")} htmlFor="locale">
        <Select id="locale" value={s.locale} onChange={(e) => patch({ locale: e.target.value as Locale })}>
          {LOCALES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t("settings.style")} description={t("settings.styleDesc")}>
        <Segmented<AppStyle>
          label={t("settings.style")}
          value={s.style}
          onChange={(style) => patch({ style })}
          options={[
            { value: "seogi", label: t("settings.styleSeogi") },
            { value: "mac", label: t("settings.styleMac") },
          ]}
        />
      </Row>
      {s.style === "seogi" && (
        <Row label={t("settings.depth")} description={t("settings.depthDesc")} htmlFor="depth">
          <span className="slider-field">
            <span>{t("settings.depthPale")}</span>
            <input
              id="depth"
              className="slider"
              type="range"
              min={0}
              max={100}
              step={5}
              value={s.depth}
              onChange={(e) => patch({ depth: Number(e.target.value) })}
            />
            <span>{t("settings.depthDeep")}</span>
          </span>
        </Row>
      )}
      <Row label={t("settings.theme")} description={t("settings.themeDesc")}>
        <Segmented<ThemeMode>
          label={t("settings.theme")}
          value={s.theme}
          onChange={(theme) => patch({ theme })}
          options={[
            { value: "system", label: t("settings.themeSystem") },
            { value: "light", label: t("settings.themeLight") },
            { value: "dark", label: t("settings.themeDark") },
          ]}
        />
      </Row>
    </Group>
  );
}

/** Where keys are kept, as the storage really does it: a development build keeps them in a plain file. */
function KeysNote() {
  const t = useT();
  const [packaged, setPackaged] = useState(true);
  useEffect(() => void window.api.appInfo().then((i) => setPackaged(i.packaged)), []);
  return <p className="settings-group__note">{t(packaged ? "settings.keysNote" : "settings.keysNoteDev")}</p>;
}

const PROVIDER_NAME: Record<string, string> = { qgrid: "qgrid", openai: "OpenAI", anthropic: "Anthropic" };

/** Reasoning effort names as qgrid lists them; an unknown one shows as it is. */
const EFFORT_LABEL: Record<string, MessageKey> = {
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  ultra: "effort.ultra",
  max: "effort.max",
};

/** One role's provider, model and (for summary) reasoning effort, with the provider's live model list. */
function ModelGroup({
  role,
  title,
  description,
  providers,
  value,
  onChange,
  test,
  reloadKey,
  children,
}: {
  role: ModelRole;
  title: string;
  description: string;
  providers: string[];
  value: { provider: string; model: string; effort?: string };
  onChange: (v: { provider: string; model: string; effort?: string }) => void;
  test?: ConnectionRole;
  /** Changes when something the list depends on changes (qgrid URL, stored keys). */
  reloadKey: string;
  children?: ReactNode;
}) {
  const t = useT();
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    setList(null);
    void window.api.listModels(role, value.provider).then(setList);
  }, [role, value.provider, reloadKey]);

  const models = list?.ok ? list.models : [];
  const selected = models.find((m) => m.id === value.model);
  const known = !!selected || !list?.ok;
  const id = `${role}-model`;

  return (
    <Group title={title}>
      <Row label={t("settings.provider")} description={description} htmlFor={`${role}-provider`}>
        <Select
          id={`${role}-provider`}
          value={value.provider}
          onChange={(e) => {
            const provider = e.target.value;
            onChange({ provider, model: DEFAULT_MODELS[role][provider as keyof (typeof DEFAULT_MODELS)[typeof role]] });
          }}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p === "local" ? t("settings.localProvider") : p === "qgrid" ? PROVIDER_NAME[p] : t("settings.apiKeyProvider", { name: PROVIDER_NAME[p] })}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label={t("settings.model")}
        htmlFor={id}
        description={
          list === null
            ? t("settings.modelsLoading")
            : !list.ok
              ? t("settings.modelsFailed", { error: list.error })
              : selected?.detail ?? (known ? undefined : t("settings.modelUnknown"))
        }
      >
        {list?.ok ? (
          <Select id={id} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value, effort: undefined })}>
            {!selected && <option value={value.model}>{value.model}</option>}
            {Object.entries(Object.groupBy(models, (m) => m.id.split("/")[0])).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items?.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.available ? m.id : t("settings.modelUnavailable", { id: m.id })}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        ) : (
          <CommitInput id={id} value={value.model} onCommit={(model) => onChange({ ...value, model })} />
        )}
      </Row>
      {value.provider === "local" && value.model === "whisper" && <WhisperModel />}
      {!!selected?.efforts?.length && (
        <Row label={t("settings.effort")} description={t("settings.effortDesc")} htmlFor={`${role}-effort`}>
          <Select
            id={`${role}-effort`}
            value={value.effort ?? ""}
            onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
          >
            <option value="">{t("settings.effortDefault")}</option>
            {selected.efforts.map((e) => (
              <option key={e} value={e}>
                {e in EFFORT_LABEL ? t(EFFORT_LABEL[e]) : e}
              </option>
            ))}
          </Select>
        </Row>
      )}
      {test && (
        <Row label={t("settings.test")} description={t("settings.testDesc")}>
          <ConnectionTest role={test} />
        </Row>
      )}
      {children}
    </Group>
  );
}

/** Local Whisper's model: downloaded once (1.6 GB) before Whisper can be used. */
function WhisperModel() {
  const t = useT();
  const [ready, setReady] = useState<boolean | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.api.whisperReady().then(setReady);
    return window.api.onWhisperProgress(setDone);
  }, []);
  async function download() {
    setError(null);
    setDone(0);
    const failed = await window.api.downloadWhisper();
    setDone(null);
    setError(failed);
    setReady(await window.api.whisperReady());
  }
  return (
    <Row
      label={t("settings.whisperModel")}
      description={error ? t("settings.whisperFailed", { error }) : ready ? t("settings.whisperReady") : t("settings.whisperNeeded")}
    >
      {ready ? null : done !== null ? (
        <span className="tnum" role="status">{t("settings.whisperDownloading", { percent: Math.floor(done * 100) })}</span>
      ) : (
        <Button onClick={() => void download()} disabled={ready === null}>{t("settings.whisperDownload")}</Button>
      )}
    </Row>
  );
}

function Models({ s, patch, setS }: SectionProps & { setS: (s: Settings) => void }) {
  const t = useT();
  const usesQgrid = [s.live, s.summary].some((x) => x.provider === "qgrid");
  const reloadKey = `${s.qgridUrl}|${s.hasKey.openai}|${s.hasKey.anthropic}`;
  return (
    <>
      <ModelGroup
        role="live"
        title={t("settings.liveTitle")}
        description={t("settings.liveDesc")}
        providers={["local", "openai", "qgrid"]}
        value={s.live}
        onChange={(v) => patch({ live: { provider: v.provider as LiveProvider, model: v.model } })}
        reloadKey={reloadKey}
      />
      <ModelGroup
        role="summary"
        title={t("settings.summaryTitle")}
        description={t("settings.summaryDesc")}
        providers={["qgrid", "openai", "anthropic"]}
        value={s.summary}
        onChange={(v) => patch({ summary: { provider: v.provider as SummaryProvider, model: v.model, effort: v.effort } })}
        test="summary"
        reloadKey={reloadKey}
      />

      {usesQgrid && (
        <Group title="qgrid">
          <Row label={t("settings.qgridUrl")} description={t("settings.qgridUrlDesc")} htmlFor="qgrid-url">
            <CommitInput id="qgrid-url" value={s.qgridUrl} onCommit={(qgridUrl) => patch({ qgridUrl })} />
          </Row>
        </Group>
      )}

      <Group title={t("settings.apiKeys")}>
        <KeyRow name="openai" label="OpenAI" placeholder="sk-…" stored={s.hasKey.openai} onChange={setS} />
        <KeyRow name="anthropic" label="Anthropic" placeholder="sk-ant-…" stored={s.hasKey.anthropic} onChange={setS} />
        <KeysNote />
      </Group>
    </>
  );
}

function KeyRow({
  name,
  label,
  placeholder,
  stored,
  onChange,
}: {
  name: KeyName;
  label: string;
  placeholder: string;
  stored: boolean;
  onChange: (s: Settings) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(!stored);
  const [draft, setDraft] = useState("");
  useEffect(() => setEditing(!stored), [stored]);
  const id = `key-${name}`;

  async function save(value: string) {
    onChange(await window.api.setKey(name, value));
    setDraft("");
  }

  return (
    <Row label={label} htmlFor={id} description={stored ? t("settings.keySaved") : t("settings.keyNone")}>
      {editing ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save(draft);
          }}
        >
          <input
            id={id}
            className="control"
            type="password"
            autoComplete="off"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={!draft.trim()}>
            {t("settings.save")}
          </Button>
          {stored && (
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("settings.cancel")}
            </Button>
          )}
        </form>
      ) : (
        <div className="inline-form">
          <span className="key-mask" aria-label={t("settings.savedKey")}>
            ••••••••••••
          </span>
          <Button onClick={() => setEditing(true)}>{t("settings.change")}</Button>
          <Button variant="danger" onClick={() => window.confirm(t("settings.deleteKeyConfirm", { provider: label })) && save("")}>
            {t("settings.delete")}
          </Button>
        </div>
      )}
    </Row>
  );
}

function ConnectionTest({ role }: { role: ConnectionRole }) {
  const t = useT();
  const [state, setState] = useState<"loading" | ConnectionResult | null>(null);
  return (
    <div className="connection">
      <Button
        icon={<Plug aria-hidden />}
        state={state === "loading" ? "loading" : state === null ? undefined : state.ok ? "success" : "error"}
        onClick={async () => {
          setState("loading");
          setState(await window.api.testConnection(role));
        }}
      >
        {state === "loading"
          ? t("settings.testChecking")
          : state && typeof state === "object"
            ? state.ok
              ? t("settings.testOk")
              : t("settings.testAgain")
            : t("settings.testRun")}
      </Button>
      {state && typeof state === "object" && (
        <p className="connection__result" data-tone={state.ok ? "success" : "error"} role="status">
          {state.ok ? t("settings.testReplied", { sec: (state.ms / 1000).toFixed(1) }) : state.error}
        </p>
      )}
    </div>
  );
}

function Transcription({ s, patch }: SectionProps) {
  const t = useT();
  return (
    <Group>
      <Row label={t("settings.meetingLanguage")} description={t("settings.meetingLanguageDesc")} htmlFor="language">
        <Select id="language" value={s.language} onChange={(e) => patch({ language: e.target.value })}>
          <option value="ko">한국어</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="auto">{t("settings.detect")}</option>
        </Select>
      </Row>
      <Row
        stack
        label={t("settings.glossary")}
        htmlFor="glossary"
        description={t("settings.glossaryDesc")}
      >
        <CommitInput
          id="glossary"
          multiline
          rows={4}
          value={s.glossary}
          placeholder={t("settings.glossaryPlaceholder")}
          onCommit={(glossary) => patch({ glossary })}
        />
      </Row>
      <TranscriptionTest s={s} />
    </Group>
  );
}

function RecordingSection({ s, patch, recording }: SectionProps & { recording: boolean }) {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput" && x.deviceId !== "default")));
    void load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, []);
  const later = recording ? t("settings.nextRecording") : "";

  return (
    <Group>
      <Row label={t("settings.mic")} description={t("settings.micDesc", { later })} htmlFor="mic">
        <Select
          id="mic"
          value={s.recording.micDeviceId}
          onChange={(e) => patch({ recording: { ...s.recording, micDeviceId: e.target.value } })}
        >
          <option value="">{t("settings.micDefault")}</option>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t("settings.micN", { n: i + 1 })}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label={t("settings.systemAudio")}
        description={t("settings.systemAudioDesc", { later })}
        htmlFor="system-audio"
      >
        <Switch
          id="system-audio"
          label={t("settings.systemAudio")}
          checked={s.recording.systemAudio}
          onChange={(systemAudio) => patch({ recording: { ...s.recording, systemAudio } })}
        />
      </Row>
    </Group>
  );
}

function Storage() {
  const t = useT();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  useEffect(() => void window.api.storageInfo().then(setInfo), []);
  return (
    <Group>
      <Row label={t("settings.dataLocation")} description={info?.path ?? "…"}>
        <Button icon={<FolderOpen aria-hidden />} onClick={() => window.api.openDataFolder()}>
          {t("settings.showInFinder")}
        </Button>
      </Row>
      <Row label={t("settings.usage")}>
        <span className="setting-value tnum">{info ? t("settings.usageValue", { size: formatBytes(info.bytes), n: info.meetings }) : "…"}</span>
      </Row>
      {(["models", "audio", "database"] as const).map((part) => (
        <Row key={part} label={t(`storage.${part}`)}>
          <span className="setting-value tnum">{info ? formatBytes(info[part]) : "…"}</span>
        </Row>
      ))}
    </Group>
  );
}

function About() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void window.api.appInfo().then(setInfo), []);
  return (
    <>
      <Group>
        <Row label={t("app.name")} description={t("app.tagline")}>
          <span className="setting-value tnum">{info ? t("settings.version", { v: info.version }) : "…"}</span>
        </Row>
        <Row label={t("settings.environment")}>
          <span className="setting-value tnum">{info ? `Electron ${info.electron} · ${info.platform}` : "…"}</span>
        </Row>
      </Group>
      <Group title={t("settings.shortcuts")}>
        {[
          [t("action.newSession"), "⌘N"],
          [t("shortcut.record"), "⇧⌘R"],
          [t("shortcut.palette"), "⌘K"],
          [t("shortcut.undo"), "⌘Z / ⇧⌘Z"],
          [t("action.star"), "⌘D"],
          [t("action.summarize"), "⇧⌘S"],
          [t("action.exportMarkdown"), "⇧⌘E"],
          [t("action.delete"), "⌘⌫"],
          [t("action.newFolder"), "⇧⌘N"],
          [t("action.toggleSidebar"), "⌘B"],
          [t("action.toggleSummary"), "⌥⌘S"],
          [t("action.settings"), "⌘,"],
        ].map(([label, key]) => (
          <Row key={label} label={label}>
            <Kbd>{key}</Kbd>
          </Row>
        ))}
      </Group>
    </>
  );
}

function formatBytes(n: number) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Speak-and-see test for any live caption model the provider offers, streamed as in a meeting.
 * The saved model is preselected; nothing is saved.
 */
function TranscriptionTest({ s }: { s: Settings }) {
  const t = useT();
  const [model, setModel] = useState(s.live.model);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<LiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const viewToken = useRef<number | undefined>(undefined);

  useEffect(() => {
    void window.api
      .listModels("live", s.live.provider)
      .then((r) => setModels(r.ok ? r.models.filter((m) => m.available) : []));
  }, [s.live.provider, s.qgridUrl]);
  useEffect(() => setModel(s.live.model), [s.live.model]);
  useEffect(() => window.api.onLive((id, v, token) => {
    if (id === LIVE_TEST_ID && token !== undefined && token === viewToken.current) setView(v);
  }), []);
  useEffect(() => () => {
    viewToken.current = undefined;
    stopRef.current?.();
    stopRef.current = null;
  }, []);

  async function start() {
    if (stopRef.current) return;
    setRunning(true);
    setError(null);
    setView(null);
    viewToken.current = undefined;
    const live = { provider: s.live.provider, model };
    let token: number | undefined;
    let captions: ReturnType<typeof liveCaptionHooks> | undefined;
    let stopRecording: (() => Promise<unknown>) | undefined;
    const controller = new AbortController();
    async function finish() {
      const testToken = token;
      try {
        await stopRecording?.();
      } finally {
        captions?.stop();
        if (testToken !== undefined) await window.api.stopLiveTest(testToken);
      }
    }
    stopRef.current = () => {
      controller.abort();
      void finish().catch((e) => {
        if (token !== undefined && viewToken.current === token) setError(showStored(e instanceof Error ? e.message : String(e), t));
      });
    };
    try {
      token = await window.api.startLiveTest(live);
      if (controller.signal.aborted) {
        await window.api.stopLiveTest(token);
        return;
      }
      viewToken.current = token;
      captions = liveCaptionHooks(LIVE_TEST_ID, live, token);
      stopRecording = await startRecording(() => {}, {
        micDeviceId: s.recording.micDeviceId, systemAudio: false, signal: controller.signal, ...captions.options,
      });
      // Permission may arrive after Stop or after the user has left this tab.
      if (controller.signal.aborted) await stopRecording();
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        stop();
      }
    }
  }

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }

  const text = view?.lines.map((l) => l.text).join(" ") ?? "";
  return (
    <Row label={t("settings.transcribeTest")} description={t("settings.transcribeTestDesc")} stack>
      <div className="live-test">
        <div className="live-test__bar">
          <Select aria-label={t("settings.transcribeTestModel")} value={model} disabled={running} onChange={(e) => setModel(e.target.value)}>
            {/* The saved model stays selectable while the list loads or if it no longer lists it. */}
            {!models.some((m) => m.id === s.live.model) && <option value={s.live.model}>{s.live.model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </Select>
          <Button icon={running ? <Square aria-hidden /> : <Mic aria-hidden />} onClick={running ? stop : start}>
            {running ? t("settings.liveTestStop") : t("settings.transcribeTestStart")}
          </Button>
        </div>
        {(running || view) && <Column text={text} waiting={running} error={view?.error ?? null} />}
        {error && (
          <p className="connection__result" data-tone="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Row>
  );
}

function Column({ text, waiting, error }: { text: string; waiting: boolean; error: string | null }) {
  const t = useT();
  const textRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight; // follow the newest words
  }, [text]);
  return (
    <>
      <p className="live-test__text" role="status" ref={textRef} data-done={!waiting || undefined}>
        {text || (waiting ? t("settings.liveTestListening") : t("settings.transcribeTestEmpty"))}
      </p>
      {error && (
        <p className="connection__result" data-tone="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
