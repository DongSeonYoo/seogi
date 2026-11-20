import { AlertCircle, Star, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MeetingRow } from "../../shared/types";
import { duration, listDate } from "./format";
import { MEETING_DRAG } from "./Sidebar";
import { useI18n } from "./i18n";
import type { Translate } from "../../shared/i18n";
import { IconButton } from "./ui";

/** The middle pane: Mail-style rows for the current collection; arrows move, ⌘⌫ deletes. */
export function MeetingList({
  title,
  meetings,
  selected,
  notice,
  onDismissNotice,
  onSelect,
  onMenu,
}: {
  title: string;
  meetings: MeetingRow[];
  selected: number | null;
  notice: string | null;
  onDismissNotice: () => void;
  onSelect: (id: number) => void;
  onMenu: (m: MeetingRow) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <section className="list" aria-label={title}>
      <header className="list__head">
        <h2 className="list__title">{title}</h2>
        <span className="list__count tnum">{t("list.count", { n: meetings.length })}</span>
      </header>
      {notice && (
        <p className="notice" role="alert">
          <AlertCircle aria-hidden />
          <span>{notice}</span>
          <IconButton label={t("notice.close")} onClick={onDismissNotice}>
            <X aria-hidden />
          </IconButton>
        </p>
      )}
      <ul
        ref={list}
        className="list__rows"
        role="listbox"
        tabIndex={0}
        aria-label={title}
        aria-activedescendant={selected !== null ? `meeting-${selected}` : undefined}
        onKeyDown={(e) => {
          // The selected meeting's menu (rename, star, move to folder, delete) from the keyboard.
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            const m = meetings.find((x) => x.id === selected);
            if (!m) return;
            e.preventDefault();
            return void Promise.resolve(onMenu(m)).finally(() => list.current?.focus());
          }
          // ⌘⌫ is the menu's Delete accelerator; handling it here too would delete twice.
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          if (!step || !meetings.length) return;
          e.preventDefault();
          const i = meetings.findIndex((m) => m.id === selected);
          onSelect(meetings[Math.min(Math.max(i + step, 0), meetings.length - 1)].id);
        }}
      >
        {meetings.map((m) => (
          <li
            key={m.id}
            id={`meeting-${m.id}`}
            role="option"
            aria-selected={m.id === selected}
            className="row"
            data-unread={m.unread || undefined}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MEETING_DRAG, String(m.id));
              e.dataTransfer.effectAllowed = "move";
            }}
            onMouseDown={() => onSelect(m.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(m);
            }}
          >
            <div className="row__line">
              {m.unread && <span className="row__dot" aria-label={t("list.unread")} />}
              <span className="row__title">{m.title}</span>
              <span className="row__date tnum">{listDate(m.startedAt, i18n)}</span>
            </div>
            <p className="row__preview">{preview(m, t)}</p>
            <div className="row__meta">
              <RowStatus m={m} t={t} />
              {m.status !== "recording" && m.durationSec > 0 && <span className="tnum">{duration(m.durationSec, i18n)}</span>}
              {m.starred && <Star className="row__star" aria-label={t("list.starred")} fill="currentColor" />}
            </div>
          </li>
        ))}
        {!meetings.length && <li className="list__empty">{t("list.empty")}</li>}
      </ul>
    </section>
  );
}

function preview(m: MeetingRow, t: Translate) {
  if (m.preview) return m.preview;
  if (m.status === "recording") return t("preview.recording");
  if (m.status === "processing") return t("preview.processing");
  if (m.status === "error") return t("preview.error");
  if (m.status === "new") return t("preview.new");
  return t("preview.none");
}

function RowStatus({ m, t }: { m: MeetingRow; t: Translate }) {
  if (m.status === "recording")
    return (
      <span className="row__status" data-status="recording">
        <span className="live-dot" aria-hidden />
        {t("status.recording")}
      </span>
    );
  if (m.status === "processing")
    return (
      <span className="row__status">
        <span className="spinner" aria-hidden />
        {t("status.processing")}
      </span>
    );
  if (m.status === "error")
    return (
      <span className="row__status" data-status="error">
        <AlertCircle aria-hidden />
        {t("status.error")}
      </span>
    );
  return null;
}
