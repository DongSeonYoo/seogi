import type { ReactNode } from "react";

/** `[mm:ss]` or `[h:mm:ss]`: a time in the transcript. */
const TIME = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g;

/**
 * Renders the summary's Markdown (headings, lists, checkboxes, bold, code, paragraphs: what
 * Summarize writes and people type) with every [mm:ss] as a link to that moment of the transcript.
 */
export function SummaryDoc({ markdown, onTime }: { markdown: string; onTime: (sec: number) => void }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list}</ul>);
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "), onTime)}</p>);
    list = [];
    para = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(?:\[( |x)\]\s+)?(.*)$/i.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      const H = heading[1].length <= 2 ? "h3" : "h4";
      blocks.push(<H key={blocks.length}>{inline(heading[2], onTime)}</H>);
    } else if (item) {
      if (para.length) flush();
      list.push(
        <li key={list.length} data-task={item[1] === undefined ? undefined : item[1].trim() ? "done" : "open"}>
          {inline(item[2], onTime)}
        </li>,
      );
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="summary-doc selectable">{blocks}</div>;
}

function inline(text: string, onTime: (sec: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TIME)) {
    out.push(...styled(text.slice(last, m.index), out.length));
    const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    out.push(
      <button key={out.length} type="button" className="time-link tnum" onClick={() => onTime(sec)}>
        {m[0].slice(1, -1)}
      </button>,
    );
    last = m.index + m[0].length;
  }
  out.push(...styled(text.slice(last), out.length));
  return out;
}

/** **bold** and `code`; everything else is text. */
function styled(text: string, key: number): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("**") ? (
        <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") ? (
        <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
