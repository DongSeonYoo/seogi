import { DatabaseSync } from "node:sqlite";
import type { MeetingRow, MeetingStatus, Summary, Track, Utterance } from "../shared/types";

export type Db = ReturnType<typeof openDb>;

export function openDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS utterances (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      track TEXT NOT NULL,
      start_sec REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS utterances_meeting ON utterances(meeting_id, start_sec);
  `);
  const columns = db.prepare("PRAGMA table_info(meetings)").all().map((c) => c.name);
  // Unread until the user opens it after the summary lands (Discord's unread pill).
  if (!columns.includes("opened")) db.exec("ALTER TABLE meetings ADD COLUMN opened INTEGER NOT NULL DEFAULT 1");
  // A crash mid-recording leaves rows that no session will ever finish.
  db.exec(
    `UPDATE meetings SET status = 'error', error = '앱이 종료되어 처리가 중단되었습니다'
     WHERE status IN ('recording', 'processing')`,
  );

  const toRow = (r: Record<string, unknown>): MeetingRow => ({
    id: Number(r.id),
    title: String(r.title),
    startedAt: String(r.started_at),
    status: r.status as MeetingStatus,
    unread: r.status === "done" && !r.opened,
  });

  return {
    createMeeting(title: string): number {
      const r = db
        .prepare("INSERT INTO meetings (title, started_at, status) VALUES (?, ?, 'recording')")
        .run(title, new Date().toISOString());
      return Number(r.lastInsertRowid);
    },

    setStatus(id: number, status: MeetingStatus, error: string | null = null) {
      db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(status, error, id);
    },

    setError(id: number, error: string) {
      db.prepare("UPDATE meetings SET error = ? WHERE id = ?").run(error, id);
    },

    setOpened(id: number, opened: boolean) {
      db.prepare("UPDATE meetings SET opened = ? WHERE id = ?").run(opened ? 1 : 0, id);
    },

    setSummary(id: number, summary: Summary) {
      db.prepare("UPDATE meetings SET title = ?, summary = ? WHERE id = ?").run(
        summary.title,
        JSON.stringify(summary),
        id,
      );
    },

    addUtterances(meetingId: number, track: Track, rows: { startSec: number; text: string }[]) {
      const insert = db.prepare(
        "INSERT INTO utterances (meeting_id, track, start_sec, text) VALUES (?, ?, ?, ?)",
      );
      for (const u of rows) insert.run(meetingId, track, u.startSec, u.text);
    },

    // ponytail: LIKE scan over all text; add an FTS5 trigram table if search gets slow.
    listMeetings(query: string): MeetingRow[] {
      const q = query.trim();
      const rows = q
        ? db
            .prepare(
              `SELECT * FROM meetings m WHERE m.title LIKE ?1 OR m.summary LIKE ?1
               OR EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id AND u.text LIKE ?1)
               ORDER BY m.started_at DESC`,
            )
            .all(`%${q}%`)
        : db.prepare("SELECT * FROM meetings ORDER BY started_at DESC").all();
      return rows.map(toRow);
    },

    getMeeting(id: number) {
      const r = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
      if (!r) return null;
      const utterances = db
        .prepare(
          "SELECT id, track, start_sec, text FROM utterances WHERE meeting_id = ? ORDER BY start_sec",
        )
        .all(id)
        .map(
          (u): Utterance => ({
            id: Number(u.id),
            track: u.track as Track,
            startSec: Number(u.start_sec),
            text: String(u.text),
          }),
        );
      return {
        ...toRow(r),
        summary: r.summary ? (JSON.parse(String(r.summary)) as Summary) : null,
        error: r.error ? String(r.error) : null,
        utterances,
      };
    },
  };
}
