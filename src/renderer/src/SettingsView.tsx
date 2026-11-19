import { ArrowLeft, Cpu, FolderOpen, HardDrive, Info, Languages, Mic, Plug, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_MODELS,
  type AppInfo,
  type ConnectionResult,
  type ConnectionRole,
  type KeyName,
  type LiveProvider,
  type ModelList,
  type ModelRole,
  type Settings,
  type StorageInfo,
  type StoredSettings,
  type SummaryProvider,
  type ThemeMode,
  type TranscriptionProvider,
} from "../../shared/types";
import type { Recording } from "./Sidebar";
import { Elapsed } from "./Sidebar";
import { Button, CommitInput, Kbd, Segmented, Select, Switch } from "./ui";

const SECTIONS = [
  { id: "general", label: "일반", icon: SlidersHorizontal },
  { id: "models", label: "AI 모델", icon: Cpu },
  { id: "transcription", label: "전사", icon: Languages },
  { id: "recording", label: "녹음", icon: Mic },
  { id: "storage", label: "저장 공간", icon: HardDrive },
  { id: "about", label: "정보", icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsView({ recording, onClose }: { recording: Recording | null; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general");
  const [s, setS] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => void window.api.getSettings().then(setS), []);

  // Esc leaves settings unless a field or a dialog is handling it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function patch(p: Partial<StoredSettings>) {
    try {
      setS(await window.api.patchSettings(p));
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  const current = SECTIONS.find((x) => x.id === section)!;

  return (
    <div className="app">
      <aside className="sidebar" aria-label="설정 분류">
        <div className="sidebar__chrome drag" />
        <div className="sidebar__top">
          <button type="button" className="settings-back" onClick={onClose}>
            <ArrowLeft aria-hidden />
            <span>설정 닫기</span>
            <Kbd>esc</Kbd>
          </button>
        </div>
        <nav className="channel-list">
          <h2 className="channel-group__label">설정</h2>
          <ul>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  className="channel channel--icon"
                  aria-current={id === section || undefined}
                  onClick={() => setSection(id)}
                >
                  <Icon aria-hidden />
                  <span className="channel__title">{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {recording && (
          <div className="dock">
            <div className="dock__live" role="status">
              <span className="live-dot" aria-hidden />
              <div className="dock__live-text">
                <div className="dock__live-title">녹음 중</div>
                <div className="dock__live-meta tnum">
                  <Elapsed since={recording.startedAt} />
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>

      <main className="main">
        <header className="main__header drag">
          <h1 className="main__title">{current.label}</h1>
        </header>
        <div className="settings selectable">
          <div className="settings__inner">
            {saveError && (
              <p className="notice" role="alert">
                저장하지 못했습니다: {saveError}
              </p>
            )}
            {s && section === "general" && <General s={s} patch={patch} />}
            {s && section === "models" && <Models s={s} patch={patch} setS={setS} />}
            {s && section === "transcription" && <Transcription s={s} patch={patch} />}
            {s && section === "recording" && <RecordingSection s={s} patch={patch} recording={!!recording} />}
            {section === "storage" && <Storage />}
            {section === "about" && <About />}
          </div>
        </div>
      </main>
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
  return (
    <div className={stack ? "setting-row setting-row--stack" : "setting-row"}>
      <div className="setting-row__text">
        <label className="setting-row__label" htmlFor={htmlFor}>
          {label}
        </label>
        {description && <p className="setting-row__desc">{description}</p>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

function General({ s, patch }: SectionProps) {
  return (
    <Group>
      <Row label="테마" description="시스템을 고르면 macOS 외관 설정을 따릅니다.">
        <Segmented<ThemeMode>
          label="테마"
          value={s.theme}
          onChange={(theme) => patch({ theme })}
          options={[
            { value: "system", label: "시스템" },
            { value: "light", label: "라이트" },
            { value: "dark", label: "다크" },
          ]}
        />
      </Row>
    </Group>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  qgrid: "qgrid",
  openai: "OpenAI · API key",
  anthropic: "Anthropic · API key",
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
}) {
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
      <Row label="공급자" description={description} htmlFor={`${role}-provider`}>
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
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label="모델"
        htmlFor={id}
        description={
          list === null
            ? "모델 목록을 불러오는 중…"
            : !list.ok
              ? `목록을 불러오지 못했습니다: ${list.error}`
              : selected?.detail ?? (known ? undefined : "목록에 없는 모델입니다.")
        }
      >
        {list?.ok ? (
          <Select id={id} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value, effort: undefined })}>
            {!selected && <option value={value.model}>{value.model}</option>}
            {Object.entries(Object.groupBy(models, (m) => m.id.split("/")[0])).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items?.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.available ? m.id : `${m.id} (사용 불가)`}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        ) : (
          <CommitInput id={id} value={value.model} onCommit={(model) => onChange({ ...value, model })} />
        )}
      </Row>
      {!!selected?.efforts?.length && (
        <Row label="추론 강도" description="높을수록 꼼꼼하지만 느리고 비쌉니다." htmlFor={`${role}-effort`}>
          <Select
            id={`${role}-effort`}
            value={value.effort ?? ""}
            onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
          >
            <option value="">모델 기본값</option>
            {selected.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </Row>
      )}
      {test && (
        <Row label="연결 확인" description="짧은 요청 하나를 실제로 보내 봅니다.">
          <ConnectionTest role={test} />
        </Row>
      )}
    </Group>
  );
}

function Models({ s, patch, setS }: SectionProps & { setS: (s: Settings) => void }) {
  const usesQgrid = [s.live, s.transcription, s.summary].some((x) => x.provider === "qgrid");
  const reloadKey = `${s.qgridUrl}|${s.hasKey.openai}|${s.hasKey.anthropic}`;
  return (
    <>
      <ModelGroup
        role="live"
        title="실시간 자막"
        description="녹음하는 동안 흐린 글씨로 바로 보여 주는 초안입니다."
        providers={["qgrid", "openai"]}
        value={s.live}
        onChange={(v) => patch({ live: { provider: v.provider as LiveProvider, model: v.model } })}
        reloadKey={reloadKey}
      />
      <ModelGroup
        role="transcription"
        title="받아쓰기"
        description="30초 안팎마다 확정하는 받아쓰기입니다. 회의록과 요약은 이 결과로 만듭니다."
        providers={["qgrid", "openai"]}
        value={s.transcription}
        onChange={(v) => patch({ transcription: { provider: v.provider as TranscriptionProvider, model: v.model } })}
        test="transcription"
        reloadKey={reloadKey}
      />
      <ModelGroup
        role="summary"
        title="요약"
        description="회의가 끝난 뒤 요약과 액션아이템을 만드는 모델입니다."
        providers={["qgrid", "openai", "anthropic"]}
        value={s.summary}
        onChange={(v) => patch({ summary: { provider: v.provider as SummaryProvider, model: v.model, effort: v.effort } })}
        test="summary"
        reloadKey={reloadKey}
      />

      {usesQgrid && (
        <Group title="qgrid">
          <Row label="서버 주소" description="로컬에서 띄웠다면 http://localhost:44900" htmlFor="qgrid-url">
            <CommitInput id="qgrid-url" value={s.qgridUrl} onCommit={(qgridUrl) => patch({ qgridUrl })} />
          </Row>
        </Group>
      )}

      <Group title="API key">
        <KeyRow name="openai" label="OpenAI" placeholder="sk-…" stored={s.hasKey.openai} onChange={setS} />
        <KeyRow name="anthropic" label="Anthropic" placeholder="sk-ant-…" stored={s.hasKey.anthropic} onChange={setS} />
        <p className="settings-group__note">키는 macOS 키체인으로 암호화해 이 맥에만 저장하고, 화면에 다시 보여주지 않습니다.</p>
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
  const [editing, setEditing] = useState(!stored);
  const [draft, setDraft] = useState("");
  useEffect(() => setEditing(!stored), [stored]);
  const id = `key-${name}`;

  async function save(value: string) {
    onChange(await window.api.setKey(name, value));
    setDraft("");
  }

  return (
    <Row label={label} htmlFor={id} description={stored ? "저장됨" : "저장된 키가 없습니다."}>
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
            저장
          </Button>
          {stored && (
            <Button variant="ghost" onClick={() => setEditing(false)}>
              취소
            </Button>
          )}
        </form>
      ) : (
        <div className="inline-form">
          <span className="key-mask" aria-label="저장된 키">
            ••••••••••••
          </span>
          <Button onClick={() => setEditing(true)}>변경</Button>
          <Button variant="danger" onClick={() => save("")}>
            삭제
          </Button>
        </div>
      )}
    </Row>
  );
}

function ConnectionTest({ role }: { role: ConnectionRole }) {
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
        {state === "loading" ? "확인 중" : state && typeof state === "object" ? (state.ok ? "연결됨" : "다시 확인") : "확인"}
      </Button>
      {state && typeof state === "object" && (
        <p className="connection__result" data-tone={state.ok ? "success" : "error"} role="status">
          {state.ok ? `${(state.ms / 1000).toFixed(1)}초 만에 응답했습니다.` : state.error}
        </p>
      )}
    </div>
  );
}

function Transcription({ s, patch }: SectionProps) {
  return (
    <Group>
      <Row label="언어" description="회의에서 주로 쓰는 언어입니다. 섞여 있으면 자동 감지를 고르세요." htmlFor="language">
        <Select id="language" value={s.language} onChange={(e) => patch({ language: e.target.value })}>
          <option value="ko">한국어</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="auto">자동 감지</option>
        </Select>
      </Row>
      <Row
        stack
        label="용어집"
        htmlFor="glossary"
        description="사람 이름, 제품명을 쉼표로 구분해 적으면 받아 적을 때와 요약할 때 표기를 맞춥니다. ⌘↵로 저장합니다."
      >
        <CommitInput
          id="glossary"
          multiline
          rows={4}
          value={s.glossary}
          placeholder="동선, 큐그리드, 회의록 앱"
          onCommit={(glossary) => patch({ glossary })}
        />
      </Row>
    </Group>
  );
}

function RecordingSection({ s, patch, recording }: SectionProps & { recording: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput" && x.deviceId !== "default")));
    void load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, []);
  const later = recording ? " 지금 녹음에는 적용되지 않고 다음 녹음부터 적용됩니다." : "";

  return (
    <Group>
      <Row label="마이크" description={`내 목소리를 녹음할 입력 장치입니다.${later}`} htmlFor="mic">
        <Select
          id="mic"
          value={s.recording.micDeviceId}
          onChange={(e) => patch({ recording: { ...s.recording, micDeviceId: e.target.value } })}
        >
          <option value="">시스템 기본값</option>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `마이크 ${i + 1}`}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label="상대방 소리 녹음"
        description={`화상 회의에서 스피커로 나오는 소리를 따로 녹음해 '상대'로 구분합니다. 대면 회의라면 끄세요. 끄면 모든 목소리가 '나'로 기록됩니다.${later}`}
      >
        <Switch
          label="상대방 소리 녹음"
          checked={s.recording.systemAudio}
          onChange={(systemAudio) => patch({ recording: { ...s.recording, systemAudio } })}
        />
      </Row>
    </Group>
  );
}

function Storage() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  useEffect(() => void window.api.storageInfo().then(setInfo), []);
  return (
    <Group>
      <Row label="데이터 위치" description={info?.path ?? "…"}>
        <Button icon={<FolderOpen aria-hidden />} onClick={() => window.api.openDataFolder()}>
          Finder에서 열기
        </Button>
      </Row>
      <Row label="사용량" description="녹음 파일과 회의 데이터베이스를 합친 크기입니다.">
        <span className="setting-value tnum">{info ? `${formatBytes(info.bytes)} · 회의 ${info.meetings}개` : "…"}</span>
      </Row>
    </Group>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void window.api.appInfo().then(setInfo), []);
  return (
    <>
      <Group>
        <Row label="Seogi" description="회의를 녹음하고 받아 적고 정리합니다.">
          <span className="setting-value tnum">{info ? `버전 ${info.version}` : "…"}</span>
        </Row>
        <Row label="환경">
          <span className="setting-value tnum">{info ? `Electron ${info.electron} · ${info.platform}` : "…"}</span>
        </Row>
      </Group>
      <Group title="단축키">
        {[
          ["회의 검색", "⌘K"],
          ["설정 열기·닫기", "⌘,"],
          ["설정·대화상자 닫기", "esc"],
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
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
