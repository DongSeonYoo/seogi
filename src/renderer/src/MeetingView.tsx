import { AlertCircle, BookmarkPlus, Check, Copy, FileAudio, Info, Mic, Pause, Pencil, Play, Share, Sparkles, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveView, MeetingDetail, ModelOption, Settings, Utterance } from "../../shared/types";
import { joinSplitSentences } from "../../shared/transcript";
import { clock, duration, fullDate, groupUtterances } from "./format";
import { useI18n, useT } from "./i18n";
import { Elapsed, type Recording } from "./Toolbar";
import { IMPORT_EXTENSIONS, importAudio, readAudioFile, useImportProgress, type AudioFile } from "./importAudio";
import { Splitter } from "./Splitter";
import { SummaryDoc } from "./SummaryDoc";
import { Button, CommitInput, IconButton, Select } from "./ui";

/** The summary side pane's state: layout from the window, summarizing from the app. */
export type SummaryPane = {
  open: boolean;
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
  /** The summary model picked here; null uses the one in Settings. */
  model: string | null;
  onModel: (model: string | null) => void;
  busy: boolean;
  error: string | null;
  onSummarize: () => void;
  onExport: (format: "md" | "txt") => void;
};

/**
 * A session: the transcript with its record button and status bar, and the summary in a side pane
 * on the right that can be resized or closed.
 */
export function MeetingView({
  meeting: m,
  live,
  recording,
  systemSilent,
  summary,
  onRecord,
}: {
  meeting: MeetingDetail;
  live: LiveView | null;
  recording: Recording | null;
  systemSilent: boolean;
  summary: SummaryPane;
  onRecord: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const speakers = new Set(m.utterances.map((u) => u.track)).size;
  // An unrecorded session also takes an audio file, dropped anywhere on the transcript side.
  const canImport = m.status === "new" && !recording;
  const [file, setFile] = useState<AudioFile | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const importing = useImportProgress(m.id);
  // A [mm:ss] clicked in the summary; n makes a second click on the same time scroll again.
  const [focus, setFocus] = useState<{ sec: number; n: number } | null>(null);
  /** Appends a transcript line, with its time, to the end of the summary. */
  const stamp = (u: Utterance) => {
    const line = `- ${u.text} [${clock(u.startSec)}]`;
    void window.api.setSummaryText(m.id, m.summary?.trim() ? `${m.summary.trimEnd()}\n${line}` : line);
  };
  useEffect(() => {
    setFile(null);
    setFileError(null);
  }, [m.id]);
  async function take(f: File) {
    setFileError(null);
    setFile(null);
    setReading(true);
    try {
      setFile(await readAudioFile(f));
    } catch (e) {
      setFileError(
        e instanceof Error && e.message === "unsupported"
          ? t("import.unsupported", { types: IMPORT_EXTENSIONS.join(", ") })
          : t("import.unreadable", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
    setReading(false);
  }
  return (
    <div className="session">
      <div
        className="session__main"
        data-drop={(canImport && over) || undefined}
        onDragOver={(e) => {
          if (!canImport || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (!canImport || !f) return;
          e.preventDefault();
          void take(f);
        }}
      >
        {(m.status === "new" || recording) && (
          <div className="detail__head">
            {m.status === "new" && !recording && <SessionOptions meeting={m} />}
            <div className="capsule">
              <button
                type="button"
                className="capsule__label"
                data-recording={recording ? true : undefined}
                onClick={onRecord}
                title={`${recording ? t("action.stop") : t("action.record")} (⇧⌘R)`}
              >
                {recording ? (
                  <>
                    <Square aria-hidden />
                    <Elapsed since={recording.startedAt} />
                  </>
                ) : (
                  <>
                    <Mic aria-hidden />
                    {t("toolbar.record")}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
        {canImport && (reading || file || fileError) && (
          <div className="import-card" role="group" aria-label={t("import.title")}>
            {reading ? (
              <p className="import-card__meta">
                <span className="spinner" aria-hidden /> {t("import.reading")}
              </p>
            ) : file ? (
              <>
                <div>
                  <p className="import-card__name">{file.name}</p>
                  <p className="import-card__meta tnum">
                    {[
                      clock(file.durationSec),
                      `${(file.sampleRate / 1000).toFixed(1)} kHz`,
                      t(file.channels === 1 ? "import.mono" : "import.channels", { n: file.channels }),
                      `${(file.bytes / 1024 / 1024).toFixed(1)} MB`,
                    ].join(" · ")}
                  </p>
                </div>
                <div className="import-card__actions">
                  <Button onClick={() => setFile(null)}>{t("import.cancel")}</Button>
                  <Button
                    variant="primary"
                    icon={<FileAudio aria-hidden />}
                    onClick={() => {
                      const f = file;
                      setFile(null);
                      void importAudio(m.id, f);
                    }}
                  >
                    {t("import.start")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="import-card__meta" data-tone="error" role="alert">
                {fileError}
              </p>
            )}
          </div>
        )}
        {importing && (
          <p className="notice notice--info" role="status">
            <span className="spinner" aria-hidden />
            <span>{t("import.progress", { done: importing.done, total: importing.total })}</span>
          </p>
        )}
        {m.error && (
          <p className="notice" role="alert">
            <AlertCircle aria-hidden />
            <span>{m.error}</span>
          </p>
        )}
        {recording && systemSilent && (
          <p className="notice notice--info" role="status">
            <Info aria-hidden />
            <span>{t("detail.systemSilent")}</span>
          </p>
        )}
        <Transcript meeting={m} live={live} focus={focus} onStamp={stamp} />
        <footer className="statusbar tnum" role="status">
          <span className="statusbar__left">
            {recording ? (
              <>
                <span className="live-dot" aria-hidden />
                {t("detail.recordingFor")} <Elapsed since={recording.startedAt} />
                {live?.error && <span className="statusbar__error"> · {t("detail.liveError", { error: live.error })}</span>}
              </>
            ) : m.status === "processing" ? (
              <>
                <span className="spinner" aria-hidden />
                {t("detail.processing")}
              </>
            ) : (
              fullDate(m.startedAt, i18n)
            )}
          </span>
          <span>
            {[
              m.durationSec > 0 && duration(m.durationSec, i18n),
              t("detail.utterances", { n: m.utterances.length }),
              speakers > 1 && `${t("speaker.mic")} · ${t("speaker.system")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </footer>
      </div>
      {summary.open && (
        <>
          <Splitter
            side="right"
            at={summary.width}
            label={t("detail.resizeSummary")}
            onResize={summary.onResize}
            onReset={summary.onReset}
          />
          <aside className="session__summary" style={{ width: summary.width }} aria-label={t("detail.summary")}>
            <h2 className="session__summary-title">{t("detail.summary")}</h2>
            <SummaryView meeting={m} pane={summary} onTime={(sec) => setFocus({ sec, n: Date.now() })} />
          </aside>
        </>
      )}
    </div>
  );
}

/**
 * Before a session is recorded: its live caption model and glossary. Both start from Settings;
 * a glossary typed here replaces the shared one for this session (captions and summary).
 */
function SessionOptions({ meeting: m }: { meeting: MeetingDetail }) {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    void window.api.getSettings().then(async (s) => {
      setSettings(s);
      const r = await window.api.listModels("live", s.live.provider);
      setModels(r.ok ? r.models.filter((x) => x.available) : []);
    });
  }, []);
  if (!settings) return null;
  const saved = settings.live.model;
  const model = m.liveModel ?? saved;
  return (
    <div className="session-options">
      <Select
        aria-label={t("session.model")}
        value={model}
        onChange={(e) => void window.api.setSessionOptions(m.id, { liveModel: e.target.value === saved ? null : e.target.value })}
      >
        {!models.some((x) => x.id === model) && <option value={model}>{model}</option>}
        {models.map((x) => (
          <option key={x.id} value={x.id}>
            {x.id === saved ? t("session.modelDefault", { model: x.id }) : x.id}
          </option>
        ))}
      </Select>
      <CommitInput
        aria-label={t("session.glossary")}
        value={m.glossary}
        placeholder={settings.glossary.trim() ? t("session.glossaryShared", { glossary: settings.glossary }) : t("session.glossaryEmpty")}
        onCommit={(glossary) => void window.api.setSessionOptions(m.id, { glossary })}
      />
    </div>
  );
}

/** A transcript line; drafts are live captions whose sentence is still being spoken. */
type Line = Utterance & { key: string; draft?: boolean };

function Transcript({
  meeting: m,
  live,
  focus,
  onStamp,
}: {
  meeting: MeetingDetail;
  live: LiveView | null;
  focus: { sec: number; n: number } | null;
  onStamp: (u: Utterance) => void;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const player = usePlayer(m.id);
  const [focused, setFocused] = useState<string | null>(null);

  // A time from the summary: the line spoken then (the last to start by it) scrolls into view and
  // is marked briefly. Lines run a little behind the speech, so half a second of slack.
  useEffect(() => {
    if (!focus) return;
    const target = [...m.utterances].reverse().find((u) => u.startSec <= focus.sec + 0.5) ?? m.utterances[0];
    if (!target) return;
    const el = scroller.current?.querySelector(`[data-key="${target.id}"]`);
    stick.current = false;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFocused(String(target.id));
    const timer = setTimeout(() => setFocused(null), 2000);
    return () => clearTimeout(timer);
  }, [focus]);

  // Chat behaviour: keep following new lines only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [m.utterances.length, live]);

  const busy = m.status === "recording" || m.status === "processing";
  const lines: Line[] = [
    ...joinSplitSentences(m.utterances).map((u) => ({ ...u, key: String(u.id) })),
    ...(live?.lines ?? []).map((d, i) => ({ ...d, id: -1 - i, draft: true })),
  ].sort((a, b) => a.startSec - b.startSec);
  return (
    <div
      className="transcript selectable"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {groupUtterances(lines).map((group) => (
        <ol key={group[0].key} className="msg-group">
          {group.map((u, i) => (
            <Message key={u.key} u={u} head={i === 0} player={player} focused={focused === u.key} onStamp={onStamp} />
          ))}
        </ol>
      ))}
      {!lines.length && !busy && (
        <p className="empty">{t(m.status === "new" ? "detail.notRecorded" : "detail.emptyTranscript")}</p>
      )}
      {m.status === "recording" && (
        <p className="typing" role="status">
          <span className="spinner" aria-hidden />
          {t("detail.listening")}
        </p>
      )}
    </div>
  );
}

function Message({
  u,
  head,
  player,
  focused,
  onStamp,
}: {
  u: Line;
  head: boolean;
  player: Player;
  focused: boolean;
  onStamp: (u: Utterance) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [stamped, setStamped] = useState(false);
  const playing = player.playingId === u.id;
  return (
    <li
      className={`msg${head ? " msg--head" : ""}${u.draft ? " msg--draft" : ""}`}
      data-key={u.key}
      data-playing={playing || undefined}
      data-focused={focused || undefined}
    >
      <div className="msg__gutter">
        {head ? (
          <span className="avatar" data-speaker={u.track} aria-hidden>
            {t(u.track === "mic" ? "speaker.mic" : "speaker.system")}
          </span>
        ) : (
          <span className="msg__gutter-time tnum">{clock(u.startSec)}</span>
        )}
      </div>
      <div>
        {head && (
          <div className="msg__head">
            <span className="msg__name" data-speaker={u.track}>
              {t(u.track === "mic" ? "speaker.mic" : "speaker.system")}
            </span>
            <span className="msg__time tnum">{clock(u.startSec)}</span>
          </div>
        )}
        <p className="msg__text">{u.text}</p>
      </div>
      {!u.draft && <div className="msg__actions">
        <IconButton label={playing ? t("detail.pause") : t("detail.play")} onClick={() => player.toggle(u)}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </IconButton>
        <IconButton
          label={copied ? t("detail.copied") : t("detail.copy")}
          onClick={async () => {
            await navigator.clipboard.writeText(u.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
        <IconButton
          label={stamped ? t("detail.stamped") : t("detail.stamp")}
          onClick={() => {
            onStamp(u);
            setStamped(true);
            setTimeout(() => setStamped(false), 1200);
          }}
        >
          {stamped ? <Check aria-hidden /> : <BookmarkPlus aria-hidden />}
        </IconButton>
      </div>}
    </li>
  );
}

type Player = ReturnType<typeof usePlayer>;

/** One audio element per meeting; plays an utterance from its chunk file to the chunk's end. */
function usePlayer(meetingId: number) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);

  useEffect(() => {
    const a = new Audio();
    a.onended = a.onpause = () => setPlayingId(null);
    audio.current = a;
    return () => {
      a.pause();
      audio.current = null;
    };
  }, [meetingId]);

  async function toggle(u: Utterance) {
    const a = audio.current;
    if (!a) return;
    if (playingId === u.id) return a.pause();
    const ref = await window.api.audioFor(meetingId, u.track, u.startSec);
    if (!ref) return;
    a.src = ref.url;
    await new Promise<void>((r) => a.addEventListener("loadedmetadata", () => r(), { once: true }));
    a.currentTime = ref.offsetSec;
    await a.play();
    setPlayingId(u.id);
  }

  return { playingId, toggle };
}

/**
 * The summary pane: written only when asked (Summarize, with a model picked here), then plain
 * Markdown the user edits in place; saved as they type. Export writes the meeting to a file.
 */
function SummaryView({ meeting: m, pane, onTime }: { meeting: MeetingDetail; pane: SummaryPane; onTime: (sec: number) => void }) {
  const t = useT();
  // Read with [mm:ss] links, or edit the Markdown; a new meeting opens in reading.
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [m.id]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    void window.api.getSettings().then(async (s) => {
      setSaved(s.summary.model);
      const r = await window.api.listModels("summary", s.summary.provider);
      setModels(r.ok ? r.models.filter((x) => x.available) : []);
    });
  }, []);
  const model = pane.model ?? saved ?? "";
  const recorded = m.utterances.length > 0 && m.status !== "recording" && m.status !== "processing";
  return (
    <div className="summary-pane">
      <div className="summary-pane__bar">
        <Select
          aria-label={t("summary.model")}
          value={model}
          disabled={pane.busy}
          onChange={(e) => pane.onModel(e.target.value === saved ? null : e.target.value)}
        >
          {model && !models.some((x) => x.id === model) && <option value={model}>{model}</option>}
          {models.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === saved ? t("session.modelDefault", { model: x.id }) : x.id}
            </option>
          ))}
        </Select>
        <Button icon={<Sparkles aria-hidden />} state={pane.busy ? "loading" : undefined} disabled={!recorded} onClick={pane.onSummarize}>
          {pane.busy ? t("summary.writing") : m.summary ? t("summary.again") : t("action.summarize")}
        </Button>
        <IconButton
          label={editing ? t("summary.done") : t("summary.edit")}
          aria-pressed={editing}
          disabled={m.summary === null}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? <Check aria-hidden /> : <Pencil aria-hidden />}
        </IconButton>
        <IconButton label={t("action.export")} disabled={!recorded} onClick={() => void exportMenu(pane, t)}>
          <Share aria-hidden />
        </IconButton>
      </div>
      {pane.error && (
        <p className="connection__result" data-tone="error" role="alert">
          {pane.error}
        </p>
      )}
      {m.summary !== null && editing ? (
        <SummaryEditor key={m.id} meetingId={m.id} value={m.summary} />
      ) : m.summary !== null ? (
        <div className="summary-read" onDoubleClick={() => setEditing(true)}>
          <SummaryDoc markdown={m.summary} onTime={onTime} />
        </div>
      ) : (
        <p className="panel__pending">
          {m.status === "recording" || m.status === "new"
            ? t("summary.afterRecording")
            : recorded
              ? t("summary.none")
              : t("summary.nothing")}
        </p>
      )}
    </div>
  );
}

async function exportMenu(pane: SummaryPane, t: ReturnType<typeof useT>) {
  const chosen = await window.api.showMenu([
    { id: "md", label: t("action.exportMarkdown") },
    { id: "txt", label: t("action.exportText") },
  ]);
  if (chosen === "md" || chosen === "txt") pane.onExport(chosen);
}

/** The summary as editable Markdown; saved half a second after typing stops, and on leaving. */
function SummaryEditor({ meetingId, value }: { meetingId: number; value: string }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const pending = useRef<string | null>(null);
  const save = () => {
    if (pending.current === null) return;
    void window.api.setSummaryText(meetingId, pending.current);
    pending.current = null;
  };
  // A new summary from Summarize replaces the text, unless an edit is still unsaved.
  useEffect(() => {
    if (pending.current === null) setDraft(value);
  }, [value]);
  useEffect(() => {
    if (pending.current === null) return;
    const timer = setTimeout(save, 500);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => save, []);
  return (
    <textarea
      className="summary-editor selectable"
      aria-label={t("detail.summary")}
      value={draft}
      spellCheck={false}
      onChange={(e) => {
        pending.current = e.target.value;
        setDraft(e.target.value);
      }}
      onBlur={save}
    />
  );
}
