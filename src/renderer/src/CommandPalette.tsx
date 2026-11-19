import { ChevronRight, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import type { ActionId, MeetingRow } from "../../shared/types";
import { fullDate } from "./format";
import { useI18n, useT } from "./i18n";
import { Dialog, Kbd } from "./ui";

export type PaletteAction = {
  label: string;
  shortcut?: string;
  /** false greys the command out everywhere it appears. */
  enabled?: boolean;
  run: () => void | Promise<void>;
};

type Item = { kind: "action"; id: ActionId; action: PaletteAction } | { kind: "meeting"; meeting: MeetingRow };

/** ⌘K: one field for commands and for every meeting's title, summary and transcript. */
export function CommandPalette({
  open,
  onClose,
  actions,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  actions: (PaletteAction & { id: ActionId })[];
  onPick: (meetingId: number) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} className="palette" label={t("action.palette")}>
      <PaletteBody onClose={onClose} actions={actions} onPick={onPick} />
    </Dialog>
  );
}

function PaletteBody({
  onClose,
  actions,
  onPick,
}: {
  onClose: () => void;
  actions: (PaletteAction & { id: ActionId })[];
  onPick: (id: number) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stale = false;
    window.api.listMeetings("all", query).then((r) => {
      if (stale) return;
      setMeetings(r.slice(0, 50));
      setActive(0);
    });
    return () => {
      stale = true;
    };
  }, [query]);

  const q = query.trim().toLowerCase();
  const items: Item[] = [
    ...actions
      .filter((a) => a.enabled !== false && (!q || a.label.toLowerCase().includes(q)))
      .map((a) => ({ kind: "action" as const, id: a.id, action: a })),
    ...meetings.map((m) => ({ kind: "meeting" as const, meeting: m })),
  ];

  function pick(item: Item | undefined) {
    if (!item) return;
    onClose();
    if (item.kind === "action") void item.action.run();
    else onPick(item.meeting.id);
  }

  return (
    <>
      <input
        className="palette__input"
        autoFocus
        placeholder={t("palette.placeholder")}
        value={query}
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={items[active] ? `palette-${active}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, items.length - 1));
          else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter") pick(items[active]);
          else return;
          e.preventDefault();
        }}
      />
      <ul className="palette__list" id="palette-list" role="listbox">
        {items.map((item, i) => (
          <li key={item.kind === "action" ? item.id : item.meeting.id}>
            {(i === 0 || items[i - 1].kind !== item.kind) && (
              <div className="palette__group">{item.kind === "action" ? t("palette.commands") : t("palette.meetings")}</div>
            )}
            <button
              type="button"
              id={`palette-${i}`}
              role="option"
              className="palette__item"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(item)}
            >
              {item.kind === "action" ? <ChevronRight aria-hidden /> : <FileText aria-hidden />}
              <span className="palette__item-title">{item.kind === "action" ? item.action.label : item.meeting.title}</span>
              {item.kind === "action" ? (
                item.action.shortcut && <Kbd>{item.action.shortcut}</Kbd>
              ) : (
                <span className="palette__item-meta tnum">{fullDate(item.meeting.startedAt, i18n)}</span>
              )}
            </button>
          </li>
        ))}
        {!items.length && <li className="empty">{t("palette.noMatch", { query })}</li>}
      </ul>
      <div className="palette__foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> {t("palette.move")}
        </span>
        <span>
          <Kbd>↵</Kbd> {t("palette.run")}
        </span>
        <span>
          <Kbd>esc</Kbd> {t("palette.close")}
        </span>
      </div>
    </>
  );
}
