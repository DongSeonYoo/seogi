import { AlertCircle, Mic, Search, Settings, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { MeetingRow } from "../../shared/types";
import { clock, groupByDay, timeOfDay } from "./format";
import { Button, IconButton, Kbd } from "./ui";

export type Recording = { id: number; startedAt: number };

export function Sidebar({
  meetings,
  selected,
  recording,
  pendingChunks,
  error,
  onSelect,
  onSearch,
  onStart,
  onStop,
  onSettings,
}: {
  meetings: MeetingRow[];
  selected: number | null;
  recording: Recording | null;
  pendingChunks: number;
  error: string | null;
  onSelect: (id: number) => void;
  onSearch: () => void;
  onStart: () => void;
  onStop: () => void;
  onSettings: () => void;
}) {
  const [starting, setStarting] = useState(false);

  return (
    <aside className="sidebar" aria-label="회의 목록">
      <div className="sidebar__chrome drag" />
      <div className="sidebar__top">
        <button type="button" className="search-trigger" onClick={onSearch}>
          <Search aria-hidden />
          <span>회의 검색</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <nav className="channel-list">
        {groupByDay(meetings).map((g) => (
          <section key={g.label} className="channel-group">
            <h2 className="channel-group__label">{g.label}</h2>
            <ul>
              {g.items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="channel"
                    aria-current={m.id === selected || undefined}
                    data-unread={m.unread || undefined}
                    onClick={() => onSelect(m.id)}
                  >
                    <span className="channel__title">{m.title}</span>
                    <ChannelStatus meeting={m} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!meetings.length && <p className="empty">아직 녹음한 회의가 없습니다.</p>}
      </nav>

      <div className="dock">
        {error && (
          <p className="notice" role="alert">
            <AlertCircle aria-hidden />
            {error}
          </p>
        )}
        {recording ? (
          <>
            <div className="dock__live" role="status">
              <span className="live-dot" aria-hidden />
              <div className="dock__live-text">
                <div className="dock__live-title">녹음 중</div>
                <div className="dock__live-meta tnum">
                  <Elapsed since={recording.startedAt} />
                  {pendingChunks > 0 && ` · 전사 대기 ${pendingChunks}`}
                </div>
              </div>
            </div>
            <div className="dock__row">
              <Button variant="danger" icon={<Square aria-hidden />} onClick={onStop}>
                녹음 종료
              </Button>
            </div>
          </>
        ) : (
          <div className="dock__row">
            <Button
              variant="primary"
              icon={<Mic aria-hidden />}
              state={starting ? "loading" : undefined}
              onClick={async () => {
                setStarting(true);
                try {
                  await onStart();
                } finally {
                  setStarting(false);
                }
              }}
            >
              새 회의 녹음
            </Button>
            <IconButton label="설정 (⌘,)" onClick={onSettings}>
              <Settings aria-hidden />
            </IconButton>
          </div>
        )}
      </div>
    </aside>
  );
}

function ChannelStatus({ meeting: m }: { meeting: MeetingRow }) {
  if (m.status === "recording")
    return (
      <span className="channel__status" data-status="recording">
        <span className="live-dot" aria-hidden />
        녹음 중
      </span>
    );
  if (m.status === "processing")
    return (
      <span className="channel__status">
        <span className="spinner" aria-hidden />
        <span className="visually-hidden">정리 중</span>
      </span>
    );
  if (m.status === "error")
    return (
      <span className="channel__status" data-status="error" title="처리 중 오류">
        <AlertCircle size={14} aria-hidden />
        <span className="visually-hidden">오류</span>
      </span>
    );
  return <span className="channel__meta tnum">{timeOfDay(m.startedAt)}</span>;
}

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{clock((now - since) / 1000)}</>;
}
