import { AlertCircle, Check, Copy, PanelRight, Pause, Play, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MeetingDetail, Utterance } from "../../shared/types";
import { joinSplitSentences } from "../../shared/transcript";
import { clock, fullDate, groupUtterances, SPEAKER } from "./format";
import { Button, IconButton } from "./ui";

const STATUS = { recording: "녹음 중", processing: "정리 중", done: "완료", error: "오류" } as const;

export function MeetingView({
  meeting: m,
  panelOpen,
  onTogglePanel,
  onResummarize,
}: {
  meeting: MeetingDetail;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onResummarize: () => void;
}) {
  return (
    <>
      <header className="main__header drag">
        <h1 className="main__title">{m.title}</h1>
        <span className="main__meta">
          {fullDate(m.startedAt)} · {STATUS[m.status]}
        </span>
        <IconButton label={panelOpen ? "요약 패널 닫기" : "요약 패널 열기"} aria-pressed={panelOpen} onClick={onTogglePanel}>
          <PanelRight aria-hidden />
        </IconButton>
      </header>
      <Transcript meeting={m} />
      {panelOpen && <SummaryPanel meeting={m} onResummarize={onResummarize} />}
    </>
  );
}

function Transcript({ meeting: m }: { meeting: MeetingDetail }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const player = usePlayer(m.id);

  // Chat behaviour: keep following new lines only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [m.utterances.length]);

  const live = m.status === "recording" || m.status === "processing";
  return (
    <div
      className="transcript selectable"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {m.error && (
        <p className="notice" role="alert">
          <AlertCircle aria-hidden />
          {m.error}
        </p>
      )}
      {groupUtterances(joinSplitSentences(m.utterances)).map((group) => (
        <ol key={group[0].id} className="msg-group">
          {group.map((u, i) => (
            <Message key={u.id} u={u} head={i === 0} player={player} />
          ))}
        </ol>
      ))}
      {!m.utterances.length && !live && !m.error && <p className="empty">전사된 내용이 없습니다.</p>}
      {live && (
        <p className="typing" role="status">
          <span className="spinner" aria-hidden />
          {m.status === "recording"
            ? m.pendingChunks > 0
              ? "받아 적는 중…"
              : "듣는 중… 말이 끊기는 지점마다 30초 안팎으로 받아 적습니다."
            : "남은 구간을 받아 적고 요약을 만드는 중…"}
        </p>
      )}
    </div>
  );
}

function Message({ u, head, player }: { u: Utterance; head: boolean; player: Player }) {
  const [copied, setCopied] = useState(false);
  const playing = player.playingId === u.id;
  return (
    <li className={head ? "msg msg--head" : "msg"} data-playing={playing || undefined}>
      <div className="msg__gutter">
        {head ? (
          <span className="avatar" data-speaker={u.track} aria-hidden>
            {SPEAKER[u.track]}
          </span>
        ) : (
          <span className="msg__gutter-time tnum">{clock(u.startSec)}</span>
        )}
      </div>
      <div>
        {head && (
          <div className="msg__head">
            <span className="msg__name" data-speaker={u.track}>
              {SPEAKER[u.track]}
            </span>
            <span className="msg__time tnum">{clock(u.startSec)}</span>
          </div>
        )}
        <p className="msg__text">{u.text}</p>
      </div>
      <div className="msg__actions">
        <IconButton label={playing ? "재생 멈춤" : "이 지점부터 듣기"} onClick={() => player.toggle(u)}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </IconButton>
        <IconButton
          label={copied ? "복사됨" : "복사"}
          onClick={async () => {
            await navigator.clipboard.writeText(u.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
      </div>
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

function SummaryPanel({ meeting: m, onResummarize }: { meeting: MeetingDetail; onResummarize: () => void }) {
  const s = m.summary;
  return (
    <aside className="panel selectable" aria-label="요약">
      {!s && (
        <div className="panel__pending">
          {m.status === "processing" && <span className="spinner" aria-hidden />}
          {m.status === "recording"
            ? "녹음을 마치면 요약이 만들어집니다."
            : m.status === "processing"
              ? "요약을 만드는 중…"
              : "요약이 없습니다."}
        </div>
      )}
      {s && (
        <>
          <section className="panel__section">
            <h2 className="panel__label">개요</h2>
            <p className="panel__overview">{s.overview}</p>
          </section>
          {s.decisions.length > 0 && (
            <section className="panel__section">
              <h2 className="panel__label">결정사항</h2>
              <ul className="panel__list">
                {s.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          )}
          {s.actionItems.length > 0 && (
            <section className="panel__section">
              <h2 className="panel__label">액션아이템</h2>
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
              <h2 className="panel__label">주제별 정리</h2>
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
      {(m.status === "done" || m.status === "error") && m.utterances.length > 0 && (
        <div className="panel__foot">
          <Button variant="ghost" icon={<RefreshCw aria-hidden />} onClick={onResummarize}>
            요약 다시 만들기
          </Button>
        </div>
      )}
    </aside>
  );
}
