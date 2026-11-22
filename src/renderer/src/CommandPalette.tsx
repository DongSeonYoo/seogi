import { ChevronRight, FileText, Quote } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { snippet } from "../../shared/search";
import { clock } from "../../shared/summary";
import type { ActionId, MeetingRow, SearchLine, SearchResult } from "../../shared/types";
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

type Item =
  | { kind: "action"; id: ActionId; action: PaletteAction }
  | { kind: "meeting"; meeting: MeetingRow }
  | { kind: "line"; line: SearchLine };

/** `text` with its found ranges marked. */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out.push(text.slice(at, a), <mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * ⌘K: one field for commands, meetings (title and summary) and the lines that say it; a line
 * opens its meeting at that moment.
 */
export function CommandPalette({
  open,
  onClose,
  actions,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  actions: (PaletteAction & { id: ActionId })[];
  onPick: (meetingId: number, sec?: number) => void;
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
  onPick: (id: number, sec?: number) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; found: SearchResult } | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      // An empty field lists recent meetings; a query searches them and their lines.
      void (query.trim() ? window.api.search(query) : window.api.listMeetings("all").then((meetings) => ({ meetings: meetings.slice(0, 20), lines: [] }))).then((found) => {
        if (!stale) setResults({ query, found });
      });
    }, query ? 150 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim().toLowerCase();
  const found = results?.query === query ? results.found : { meetings: [], lines: [] };
  const items: Item[] = [
    ...actions
      .filter((a) => a.enabled !== false && (!q || a.label.toLowerCase().includes(q)))
      .map((a) => ({ kind: "action" as const, id: a.id, action: a })),
    ...found.meetings.map((m) => ({ kind: "meeting" as const, meeting: m })),
    ...found.lines.map((l) => ({ kind: "line" as const, line: l })),
  ];

  function pick(item: Item | undefined) {
    if (!item) return;
    onClose();
    // After the dialog closes, so focus is off its search field: commands like Delete refuse to
    // act while the user is typing.
    if (item.kind === "action") setTimeout(() => void item.action.run());
    else if (item.kind === "meeting") onPick(item.meeting.id);
    else onPick(item.line.meetingId, item.line.startSec);
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
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return; // an Enter that ends a Korean syllable
          let next = active;
          if (e.key === "ArrowDown") next = Math.max(0, Math.min(active + 1, items.length - 1));
          else if (e.key === "ArrowUp") next = Math.max(active - 1, 0);
          else if (e.key === "Enter") return void (e.preventDefault(), pick(items[active]));
          else return;
          e.preventDefault();
          setActive(next);
          document.getElementById(`palette-${next}`)?.scrollIntoView({ block: "nearest" });
        }}
      />
      <ul className="palette__list" id="palette-list" role="listbox" aria-label={t("palette.results")}>
        {(["action", "meeting", "line"] as const).map((kind) => {
          const group = items.flatMap((item, i) => (item.kind === kind ? [{ item, i }] : []));
          if (!group.length) return null;
          return (
            <li key={kind} role="group" aria-labelledby={`palette-group-${kind}`}>
              <div className="palette__group" id={`palette-group-${kind}`}>
                {t(kind === "action" ? "palette.commands" : kind === "meeting" ? "palette.meetings" : "palette.lines")}
              </div>
              <ul role="presentation">
                {group.map(({ item, i }) => (
                  // Options are the items themselves; focus stays in the search field (aria-activedescendant).
                  <li
                    key={item.kind === "action" ? item.id : item.kind === "meeting" ? item.meeting.id : `l${item.line.id}`}
                    id={`palette-${i}`}
                    role="option"
                    className="palette__item"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => pick(item)}
                  >
                    {item.kind === "action" ? (
                      <>
                        <ChevronRight aria-hidden />
                        <span className="palette__item-title">{item.action.label}</span>
                        {item.action.shortcut && <Kbd>{item.action.shortcut}</Kbd>}
                      </>
                    ) : item.kind === "meeting" ? (
                      <>
                        <FileText aria-hidden />
                        <span className="palette__item-title">{item.meeting.title}</span>
                        <span className="palette__item-meta tnum">{fullDate(item.meeting.startedAt, i18n)}</span>
                      </>
                    ) : (
                      <>
                        <Quote aria-hidden />
                        <span className="palette__item-title palette__line">
                          <Marked text={snippet(item.line.text, item.line.ranges)[0]} ranges={snippet(item.line.text, item.line.ranges)[1]} />
                        </span>
                        <span className="palette__item-meta tnum">
                          {item.line.meetingTitle} · {clock(item.line.startSec)}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
        {/* No verdict while this query's meetings are still on their way. */}
        {!items.length && results?.query === query && <li className="empty">{t("palette.noMatch", { query })}</li>}
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
