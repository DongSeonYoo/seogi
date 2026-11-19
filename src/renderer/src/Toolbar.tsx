import { Mic, PanelLeft, RefreshCw, Search, Square, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MeetingDetail } from "../../shared/types";
import { clock, duration, fullDate } from "./format";
import { useI18n } from "./i18n";
import { IconButton } from "./ui";

export type Recording = { id: number; startedAt: number };


/** The unified toolbar over the list and detail: title on the left, capsules of actions on the right. */
export function Toolbar({
  meeting: m,
  recording,
  renaming,
  sidebar,
  canResummarize,
  onToggleSidebar,
  onRename,
  onStartRename,
  onRecord,
  onStar,
  onResummarize,
  onPalette,
}: {
  meeting: MeetingDetail | null;
  recording: Recording | null;
  renaming: boolean;
  sidebar: boolean;
  canResummarize: boolean;
  onToggleSidebar: () => void;
  /** null: the edit was cancelled. */
  onRename: (title: string | null) => void;
  onStartRename: () => void;
  onRecord: () => void;
  onStar: () => void;
  onResummarize: () => void;
  onPalette: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = { recording: t("status.recording"), processing: t("status.processing"), done: "", error: t("status.error") };
  const subtitle = m
    ? [fullDate(m.startedAt, i18n), m.durationSec > 0 && duration(m.durationSec, i18n), status[m.status]]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <header className="toolbar drag">
      {!sidebar && <div className="toolbar__lights" />}
      <IconButton label={`${t("action.toggleSidebar")} (⌃⌘S)`} onClick={onToggleSidebar}>
        <PanelLeft aria-hidden />
      </IconButton>
      <div className="toolbar__title">
        {m && renaming ? (
          <TitleInput value={m.title} onDone={onRename} />
        ) : (
          <h1 className="toolbar__name" onDoubleClick={m ? onStartRename : undefined} title={m ? t("toolbar.renameHint") : undefined}>
            {m?.title ?? t("app.name")}
          </h1>
        )}
        {subtitle && <p className="toolbar__sub tnum">{subtitle}</p>}
      </div>
      <div className="toolbar__actions">
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
        <div className="capsule">
          <IconButton label={`${m?.starred ? t("action.unstar") : t("action.star")} (⌘D)`} aria-pressed={!!m?.starred} disabled={!m} onClick={onStar}>
            <Star aria-hidden fill={m?.starred ? "currentColor" : "none"} />
          </IconButton>
          <IconButton label={`${t("action.resummarize")} (⇧⌘S)`} disabled={!canResummarize} onClick={onResummarize}>
            <RefreshCw aria-hidden />
          </IconButton>
        </div>
        <div className="capsule">
          <IconButton label={`${t("action.palette")} (⌘K)`} onClick={onPalette}>
            <Search aria-hidden />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

/** Inline title editing: Enter or blur saves, Esc cancels. */
export function TitleInput({
  value,
  onDone,
  className = "toolbar__input",
}: {
  value: string;
  onDone: (next: string | null) => void;
  className?: string;
}) {
  const t = useI18n().t;
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      ref={ref}
      className={className}
      value={draft}
      aria-label={t("toolbar.name")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft.trim() ? draft.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(draft.trim() ? draft.trim() : null);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tnum">{clock((now - since) / 1000)}</span>;
}
