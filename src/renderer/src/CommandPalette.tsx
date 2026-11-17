import { useEffect, useState } from "react";
import type { MeetingRow } from "../../shared/types";
import { fullDate } from "./format";
import { Dialog, Kbd } from "./ui";

/** Discord's quick switcher: type to search every meeting, arrows to move, Enter to open. */
export function CommandPalette({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: number) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} className="palette" label="회의 검색">
      <PaletteBody onClose={onClose} onPick={onPick} />
    </Dialog>
  );
}

function PaletteBody({ onClose, onPick }: { onClose: () => void; onPick: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MeetingRow[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stale = false;
    window.api.listMeetings(query).then((r) => {
      if (stale) return;
      setResults(r.slice(0, 50));
      setActive(0);
    });
    return () => {
      stale = true;
    };
  }, [query]);

  function pick(m: MeetingRow | undefined) {
    if (!m) return;
    onPick(m.id);
    onClose();
  }

  return (
    <>
      <input
        className="palette__input"
        autoFocus
        placeholder="제목, 요약, 대화 내용으로 찾기"
        value={query}
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter") pick(results[active]);
          else return;
          e.preventDefault();
        }}
      />
      <ul className="palette__list" id="palette-list" role="listbox">
        {results.map((m, i) => (
          <li key={m.id}>
            <button
              type="button"
              id={`palette-${m.id}`}
              role="option"
              className="palette__item"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(m)}
            >
              <span className="palette__item-title">{m.title}</span>
              <span className="palette__item-meta tnum">{fullDate(m.startedAt)}</span>
            </button>
          </li>
        ))}
        {!results.length && <li className="empty">{query ? `'${query}'와 일치하는 회의가 없습니다.` : "회의가 없습니다."}</li>}
      </ul>
      <div className="palette__foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 이동
        </span>
        <span>
          <Kbd>↵</Kbd> 열기
        </span>
        <span>
          <Kbd>esc</Kbd> 닫기
        </span>
      </div>
    </>
  );
}
