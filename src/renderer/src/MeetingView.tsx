import { AlertCircle, BookmarkPlus, Check, Copy, FileAudio, Info, Mic, Pause, Pencil, Play, Share, Sparkles, Square } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveView, MeetingDetail, ModelOption, Settings, Utterance } from "../../shared/types";
import { clock, speakerName } from "../../shared/summary";
import { joinSplitSentences } from "../../shared/transcript";
import { duration, fullDate, groupUtterances, insertDrafts } from "./format";
import { useI18n, useT } from "./i18n";
import { showStored } from "../../shared/i18n";
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
  onSave: (id: number, markdown: string) => void;
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
  recordingElsewhere,
}: {
  meeting: MeetingDetail;
  live: LiveView | null;
  recording: Recording | null;
  systemSilent: boolean;
  summary: SummaryPane;
  onRecord: () => void;
  /** Another session is recording: this one's Record would stop that one, so it waits. */
  recordingElsewhere: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const speakers = useMemo(() => [...new Set(m.utterances.map((u) => speakerName(u, t)))], [m.utterances, t]);
  // An unrecorded session also takes an audio file, dropped anywhere on the transcript side.
  const importing = useImportProgress(m.id);
  const canImport = m.status === "new" && !recording && !importing;
  const [file, setFile] = useState<AudioFile | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // A file is often not in the meeting language set for live captions, so it is asked per file.
  const [fileLanguage, setFileLanguage] = useState("auto");
  // Each file starts from the meeting language in Settings: detection misreads short lines
  // (Korean turns came back as Japanese), so it is the fallback, not the default.
  // A [mm:ss] clicked in the summary; n makes a second click on the same time scroll again.
  const [focus, setFocus] = useState<{ sec: number; n: number } | null>(null);
  /** Appends a transcript line, with its time, to the end of the summary. */
  const stamp = useCallback((u: Utterance) => {
    const line = `- ${u.text} [${clock(u.startSec)}]`;
    summary.onSave(m.id, m.summary?.trim() ? `${m.summary.trimEnd()}\n${line}` : line);
  }, [m.id, m.summary, summary.onSave]);
  useEffect(() => {
    setFile(null);
    setFileError(null);
  }, [m.id]);
  async function take(f: File) {
    setFileError(null);
    setFile(null);
    setReading(true);
    // Read now, not when the session opened: the setting may have changed since.
    setFileLanguage((await window.api.getSettings()).language);
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
        {(canImport || recording) && (
          <div className="detail__head">
            {m.status === "new" && !recording && <SessionOptions meeting={m} />}
            <div className="capsule">
              <button
                type="button"
                className="capsule__label"
                data-recording={recording ? true : undefined}
                disabled={recordingElsewhere}
                onClick={onRecord}
                title={recordingElsewhere ? t("detail.recordingElsewhere") : `${recording ? t("action.stop") : t("action.record")} (⇧⌘R)`}
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
                      t(file.channels === 1 ? "import.mono" : "import.channels", { n: file.channels }),
                      `${(file.bytes / 1024 / 1024).toFixed(1)} MB`,
                    ].join(" · ")}
                  </p>
                </div>
                <div className="import-card__actions">
                  <Select aria-label={t("import.language")} value={fileLanguage} onChange={(e) => setFileLanguage(e.target.value)}>
                    <option value="auto">{t("import.languageAuto")}</option>
                    <option value="ko">한국어</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                  </Select>
                  <Button onClick={() => setFile(null)}>{t("import.cancel")}</Button>
                  <Button
                    variant="primary"
                    icon={<FileAudio aria-hidden />}
                    onClick={() => {
                      const f = file;
                      setFile(null);
                      void importAudio(m.id, f, fileLanguage);
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
            <span>
              {importing.phase === "transcribe"
                ? t("import.progress", { done: importing.done, total: importing.total })
                : t(importing.phase === "audio" ? "import.audio" : importing.phase === "models" ? "import.models" : "import.speakers")}
            </span>
          </p>
        )}
        {m.error && (
          <p className="notice" role="alert">
            <AlertCircle aria-hidden />
            <span>{showStored(m.error, t)}</span>
          </p>
        )}
        {recording && systemSilent && (
          <p className="notice notice--info" role="status">
            <Info aria-hidden />
            <span>{t("detail.systemSilent")}</span>
          </p>
        )}
        <Transcript meeting={m} live={live} focus={focus} onStamp={stamp} importing={!!importing} />
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
              speakers.length > 1 && speakers.join(" · "),
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

/** Colours: the person at this Mac, the other side, or one of up to five told-apart voices. */
const speakerKey = (u: { track: string; speaker: number | null }) => (u.speaker ? `s${(u.speaker - 1) % 5}` : u.track);

/** A transcript line; drafts are live captions whose sentence is still being spoken. */
type Line = Utterance & { key?: string; draft?: boolean };
const lineKey = (u: Line) => u.key ?? u.id;

function Transcript({
  meeting: m,
  live,
  focus,
  onStamp,
  importing,
}: {
  meeting: MeetingDetail;
  live: LiveView | null;
  focus: { sec: number; n: number } | null;
  onStamp: (u: Utterance) => void;
  importing: boolean;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const player = usePlayer(m.id);
  // Every line in the named second is marked: two lines can share a start time to the second.
  const [focused, setFocused] = useState<Set<number>>(new Set());
  const confirmed = useMemo(() => joinSplitSentences(m.utterances), [m.utterances]);
  const grouped = useMemo(() => groupUtterances<Line>(confirmed), [confirmed]);
  const groups = useMemo(() => {
    const drafts = (live?.lines ?? []).map((d, i) => ({ ...d, id: -1 - i, speaker: null, draft: true }));
    return insertDrafts(grouped, drafts);
  }, [grouped, live]);

  // A time from the summary: the line it names scrolls into view and is marked briefly. Times are
  // written as whole seconds (a line at 24.89 s reads [00:24]), so a line in that second wins,
  // else the nearest one.
  useEffect(() => {
    if (!focus) return;
    const target =
      confirmed.find((u) => Math.floor(u.startSec) === focus.sec) ??
      confirmed.reduce<Utterance | undefined>((best, u) => (!best || Math.abs(u.startSec - focus.sec) < Math.abs(best.startSec - focus.sec) ? u : best), undefined);
    if (!target) return;
    const el = scroller.current?.querySelector(`[data-key="${target.id}"]`);
    stick.current = false;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const same = confirmed.filter((u) => Math.floor(u.startSec) === Math.floor(target.startSec)).map((u) => u.id);
    setFocused(new Set(same.length ? same : [target.id]));
    const timer = setTimeout(() => setFocused(new Set()), 2000);
    return () => clearTimeout(timer);
  }, [focus]);

  // Chat behaviour: keep following new lines only while the reader is at the bottom.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { stick.current = entry.isIntersecting; }, {
      root: scroller.current,
      rootMargin: "0px 0px 80px",
    });
    observer.observe(bottom.current!);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [m.utterances.length, live]);

  const busy = m.status === "recording" || m.status === "processing";
  return (
    <div className="transcript selectable" ref={scroller}>
      {groups.map((group) => (
        <MessageGroup key={lineKey(group[0])} group={group} player={player} focused={focused} onStamp={onStamp} />
      ))}
      {!groups.length && !busy && (
        // While a file is being prepared the session is still "new", but it is no longer waiting for one.
        !importing && <p className="empty">{t(m.status === "new" ? "detail.notRecorded" : "detail.emptyTranscript")}</p>
      )}
      {m.status === "recording" && (
        <p className="typing" role="status">
          <span className="spinner" aria-hidden />
          {t("detail.listening")}
        </p>
      )}
      <div ref={bottom} aria-hidden />
    </div>
  );
}

const MessageGroup = memo(function MessageGroup({ group, player, focused, onStamp }: {
  group: Line[];
  player: Player;
  focused: ReadonlySet<number>;
  onStamp: (u: Utterance) => void;
}) {
  return (
    <ol className="msg-group">
      {group.map((u, i) => (
        <Message key={lineKey(u)} u={u} head={i === 0} player={player} focused={focused.has(u.id)} onStamp={onStamp} />
      ))}
    </ol>
  );
});

const Message = memo(function Message({
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
  const [hovered, setHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const playing = player.playingId === u.id;
  return (
    <li
      className={`msg${head ? " msg--head" : ""}${u.draft ? " msg--draft" : ""}`}
      data-key={lineKey(u)}
      data-playing={playing || undefined}
      data-focused={focused || undefined}
      tabIndex={u.draft ? undefined : 0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHasFocus(false); }}
    >
      <div className="msg__gutter">
        {head ? (
          <span className="avatar" data-speaker={speakerKey(u)} aria-hidden>
            {u.speaker ?? speakerName(u, t).slice(0, 1)}
          </span>
        ) : (
          <span className="msg__gutter-time tnum">{clock(u.startSec)}</span>
        )}
      </div>
      <div>
        {head && (
          <div className="msg__head">
            <span className="msg__name" data-speaker={speakerKey(u)}>
              {speakerName(u, t)}
            </span>
            <span className="msg__time tnum">{clock(u.startSec)}</span>
          </div>
        )}
        <p className="msg__text">{u.text}</p>
      </div>
      {!u.draft && (hovered || hasFocus) && <div className="msg__actions">
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
});

type Player = ReturnType<typeof usePlayer>;

/** Follow a selected utterance into subsequent chunks until paused or the meeting changes. */
function usePlayer(meetingId: number) {
  const [selection, setSelection] = useState<{ meetingId: number; u: Utterance } | null>(null);
  const toggle = useCallback((u: Utterance) => {
    setSelection((s) => s?.meetingId === meetingId && s.u.id === u.id ? null : { meetingId, u });
  }, [meetingId]);

  useLayoutEffect(() => {
    if (!selection) return;
    if (selection.meetingId !== meetingId) {
      setSelection(null);
      return;
    }
    const { u } = selection;
    let active = true;
    let audio: HTMLAudioElement | null = null;
    function release() {
      if (!audio) return;
      audio.onloadedmetadata = audio.onerror = audio.onended = audio.onpause = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio = null;
    }
    function finish() {
      if (active) setSelection((s) => s === selection ? null : s);
    }
    async function play(at: number, previousUrl?: string) {
      try {
        const ref = await window.api.audioFor(meetingId, u.track, at);
        if (!active) return;
        if (!ref || ref.url === previousUrl) return finish();
        release();
        const a = new Audio();
        audio = a;
        a.onloadedmetadata = () => {
          a.onloadedmetadata = null;
          const offset = previousUrl ? 0 : ref.offsetSec;
          a.currentTime = offset < a.duration ? offset : Math.max(0, a.duration - 2);
          void a.play().catch(() => { if (audio === a) finish(); });
        };
        a.onended = () => { void play(ref.chunkStartSec + a.duration + 0.05, ref.url); };
        a.onpause = () => { if (!a.ended) finish(); };
        a.onerror = finish;
        a.src = ref.url;
      } catch {
        finish();
      }
    }
    void play(u.startSec);
    return () => {
      active = false;
      release();
    };
  }, [meetingId, selection]);

  const playingId = selection?.meetingId === meetingId ? selection.u.id : null;
  return useMemo(() => ({ playingId, toggle }), [playingId, toggle]);
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
          disabled={!recorded}
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
      {editing ? (
        // Also with no summary yet: write one by hand, or keep typing after clearing it.
        <SummaryEditor key={m.id} meetingId={m.id} value={m.summary ?? ""} onSave={pane.onSave} />
      ) : m.summary !== null ? (
        <div className="summary-read" onDoubleClick={() => setEditing(true)}>
          <SummaryDoc markdown={m.summary} onTime={onTime} />
        </div>
      ) : (
        <p className="panel__pending">
          {m.status === "recording" || m.status === "new" || m.status === "processing"
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
function SummaryEditor({ meetingId, value, onSave }: { meetingId: number; value: string; onSave: SummaryPane["onSave"] }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const pending = useRef<string | null>(null);
  const save = () => {
    if (pending.current === null) return;
    onSave(meetingId, pending.current);
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
