import { AlertCircle, Check, Copy, Info, Pause, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveView, MeetingDetail, Utterance } from "../../shared/types";
import { joinSplitSentences } from "../../shared/transcript";
import { clock, duration, fullDate, groupUtterances } from "./format";
import { useI18n, useT } from "./i18n";
import { Elapsed, type Recording } from "./Toolbar";
import { IconButton, Segmented } from "./ui";

export type DetailTab = "summary" | "transcript";

/** The detail pane: summary or transcript (⌘1 / ⌘2) over a status bar. */
export function MeetingView({
  meeting: m,
  tab,
  onTab,
  live,
  recording,
  systemSilent,
}: {
  meeting: MeetingDetail;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  live: LiveView | null;
  recording: Recording | null;
  systemSilent: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const speakers = new Set(m.utterances.map((u) => u.track)).size;
  return (
    <>
      <div className="detail__head">
        <Segmented<DetailTab>
          label={t("detail.view")}
          value={tab}
          onChange={onTab}
          options={[
            { value: "summary", label: t("detail.summary") },
            { value: "transcript", label: t("detail.transcript") },
          ]}
        />
      </div>
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
      {tab === "summary" ? <SummaryView meeting={m} /> : <Transcript meeting={m} live={live} />}
      <footer className="statusbar tnum" role="status">
        <span className="statusbar__left">
          {recording ? (
            <>
              <span className="live-dot" aria-hidden />
              {t("detail.recordingFor")} <Elapsed since={recording.startedAt} />
              {m.pendingChunks > 0 && ` · ${t("detail.pending", { n: m.pendingChunks })}`}
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
    </>
  );
}

/** A transcript line; drafts are live captions not yet replaced by a chunk transcript. */
type Line = Utterance & { key: string; draft?: boolean };

function Transcript({ meeting: m, live }: { meeting: MeetingDetail; live: LiveView | null }) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const player = usePlayer(m.id);

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
            <Message key={u.key} u={u} head={i === 0} player={player} />
          ))}
        </ol>
      ))}
      {!lines.length && !busy && <p className="empty">{t("detail.emptyTranscript")}</p>}
      {m.status === "recording" && (
        <p className="typing" role="status">
          <span className="spinner" aria-hidden />
          {t("detail.listening")}
        </p>
      )}
    </div>
  );
}

function Message({ u, head, player }: { u: Line; head: boolean; player: Player }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const playing = player.playingId === u.id;
  return (
    <li
      className={`msg${head ? " msg--head" : ""}${u.draft ? " msg--draft" : ""}`}
      data-playing={playing || undefined}
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

function SummaryView({ meeting: m }: { meeting: MeetingDetail }) {
  const t = useT();
  const s = m.summary;
  return (
    <article className="summary selectable" aria-label={t("detail.summary")}>
      {!s && (
        <div className="panel__pending">
          {m.status === "processing" && <span className="spinner" aria-hidden />}
          {m.status === "recording"
            ? t("summary.whenStopped")
            : m.status === "processing"
              ? t("summary.writing")
              : t("summary.none")}
        </div>
      )}
      {s && (
        <>
          <section className="panel__section">
            <h2 className="panel__label">{t("summary.overview")}</h2>
            <p className="panel__overview">{s.overview}</p>
          </section>
          {s.decisions.length > 0 && (
            <section className="panel__section">
              <h2 className="panel__label">{t("summary.decisions")}</h2>
              <ul className="panel__list">
                {s.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          )}
          {s.actionItems.length > 0 && (
            <section className="panel__section">
              <h2 className="panel__label">{t("summary.actionItems")}</h2>
              {s.actionItems.map((a, i) => (
                <div key={i} className="action">
                  <span>{a.task}</span>
                  <span className="action__meta">
                    <span className="action__owner">{a.owner}</span>
                    <span>{a.due}</span>
                  </span>
                </div>
              ))}
            </section>
          )}
          {s.topics.length > 0 && (
            <section className="panel__section">
              <h2 className="panel__label">{t("summary.topics")}</h2>
              {s.topics.map((t, i) => (
                <div key={i} className="topic">
                  <h3 className="topic__title">{t.title}</h3>
                  <ul className="panel__list">
                    {t.points.map((p, j) => (
                      <li key={j}>{p}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </article>
  );
}
