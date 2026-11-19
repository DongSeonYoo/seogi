import { DatabaseSync } from "node:sqlite";
import type {
  Folder,
  LibraryCounts,
  LibraryView,
  MeetingRow,
  MeetingStatus,
  Summary,
  Track,
  Utterance,
} from "../shared/types";

export type Db = ReturnType<typeof openDb>;

/** `appQuitMessage` marks meetings a crash or quit left unfinished. */
export function openDb(file: string, appQuitMessage = "Processing stopped because the app quit") {
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
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  const columns = db.prepare("PRAGMA table_info(meetings)").all().map((c) => c.name);
  const addColumn = (name: string, ddl: string) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE meetings ADD COLUMN ${ddl}`);
  };
  // Unread until the user opens it after the summary lands.
  addColumn("opened", "opened INTEGER NOT NULL DEFAULT 1");
  addColumn("folder_id", "folder_id INTEGER");
  addColumn("starred", "starred INTEGER NOT NULL DEFAULT 0");
  // Set by delete; purged for real at quit and launch. Until then ⌘Z restores the meeting.
  addColumn("deleted_at", "deleted_at TEXT");
  // A title the user typed; a later summary keeps it instead of writing its own.
  addColumn("title_edited", "title_edited INTEGER NOT NULL DEFAULT 0");
  addColumn("ended_at", "ended_at TEXT");
  // A crash mid-recording leaves rows that no session will ever finish.
  db.prepare("UPDATE meetings SET status = 'error', error = ? WHERE status IN ('recording', 'processing')").run(
    appQuitMessage,
  );

  const live = "m.deleted_at IS NULL";
  const select = `SELECT m.*, f.id AS live_folder_id,
      COALESCE((julianday(m.ended_at) - julianday(m.started_at)) * 86400,
               (SELECT MAX(start_sec) FROM utterances u WHERE u.meeting_id = m.id), 0) AS duration_sec,
      json_extract(m.summary, '$.overview') AS preview
    FROM meetings m LEFT JOIN folders f ON f.id = m.folder_id AND f.deleted_at IS NULL`;

  const toRow = (r: Record<string, unknown>): MeetingRow => ({
    id: Number(r.id),
    title: String(r.title),
    startedAt: String(r.started_at),
    status: r.status as MeetingStatus,
    unread: r.status === "done" && !r.opened,
    // A meeting in a deleted folder shows as unfiled until the folder comes back.
    folderId: r.live_folder_id === null ? null : Number(r.live_folder_id),
    starred: !!r.starred,
    durationSec: Number(r.duration_sec ?? 0),
    preview: r.preview ? String(r.preview) : null,
  });

  const viewWhere: Record<Exclude<LibraryView, number>, string> = {
    all: "1",
    unread: "m.status = 'done' AND m.opened = 0",
    starred: "m.starred = 1",
    error: "m.status = 'error'",
  };

  return {
    raw: db,

    createMeeting(title: string, folderId: number | null = null): number {
      const r = db
        .prepare("INSERT INTO meetings (title, started_at, status, folder_id) VALUES (?, ?, 'recording', ?)")
        .run(title, new Date().toISOString(), folderId);
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

    /** The first stop fixes the length; a resummary keeps it. */
    setEnded(id: number) {
      db.prepare("UPDATE meetings SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
    },

    setSummary(id: number, summary: Summary) {
      db.prepare(
        "UPDATE meetings SET title = CASE WHEN title_edited THEN title ELSE ? END, summary = ? WHERE id = ?",
      ).run(summary.title, JSON.stringify(summary), id);
    },

    addUtterances(meetingId: number, track: Track, rows: { startSec: number; text: string }[]) {
      const insert = db.prepare(
        "INSERT INTO utterances (meeting_id, track, start_sec, text) VALUES (?, ?, ?, ?)",
      );
      for (const u of rows) insert.run(meetingId, track, u.startSec, u.text);
    },

    // ponytail: LIKE scan over all text; add an FTS5 trigram table if search gets slow.
    listMeetings(view: LibraryView = "all", query = ""): MeetingRow[] {
      const folder = typeof view === "number";
      // Both parameters are always bound, so the clauses that do not apply test them as no-ops.
      return db
        .prepare(
          `${select} WHERE ${live} AND ${folder ? "1" : viewWhere[view as Exclude<LibraryView, number>]}
           AND (?2 IS NULL OR f.id = ?2)
           AND (?1 = '%%' OR m.title LIKE ?1 OR m.summary LIKE ?1
             OR EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id AND u.text LIKE ?1))
           ORDER BY m.started_at DESC`,
        )
        .all(`%${query.trim()}%`, folder ? view : null)
        .map(toRow);
    },

    counts(): LibraryCounts {
      const one = (where: string) =>
        Number(db.prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE ${live} AND ${where}`).get()?.n ?? 0);
      return {
        all: one(viewWhere.all),
        unread: one(viewWhere.unread),
        starred: one(viewWhere.starred),
        error: one(viewWhere.error),
        recording: one("m.status = 'recording'") > 0,
      };
    },

    listFolders(): Folder[] {
      return db
        .prepare(
          `SELECT f.id, f.name, (SELECT COUNT(*) FROM meetings m WHERE m.folder_id = f.id AND ${live}) AS count
           FROM folders f WHERE f.deleted_at IS NULL ORDER BY f.name COLLATE NOCASE`,
        )
        .all()
        .map((r) => ({ id: Number(r.id), name: String(r.name), count: Number(r.count) }));
    },

    getMeeting(id: number) {
      const r = db.prepare(`${select} WHERE m.id = ? AND ${live}`).get(id);
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

    /** Values an undo needs to put back; read before a change. */
    meetingFields(id: number) {
      const r = db.prepare("SELECT title, title_edited, folder_id, starred, status FROM meetings WHERE id = ?").get(id);
      return r
        ? {
            title: String(r.title),
            titleEdited: !!r.title_edited,
            folderId: r.folder_id === null ? null : Number(r.folder_id),
            starred: !!r.starred,
            status: r.status as MeetingStatus,
          }
        : null;
    },

    setTitle(id: number, title: string, edited: boolean) {
      db.prepare("UPDATE meetings SET title = ?, title_edited = ? WHERE id = ?").run(title, edited ? 1 : 0, id);
    },

    setFolder(id: number, folderId: number | null) {
      db.prepare("UPDATE meetings SET folder_id = ? WHERE id = ?").run(folderId, id);
    },

    setStarred(id: number, starred: boolean) {
      db.prepare("UPDATE meetings SET starred = ? WHERE id = ?").run(starred ? 1 : 0, id);
    },

    setMeetingDeleted(id: number, deleted: boolean) {
      db.prepare("UPDATE meetings SET deleted_at = ? WHERE id = ?").run(deleted ? new Date().toISOString() : null, id);
    },

    createFolder(name: string): number {
      return Number(db.prepare("INSERT INTO folders (name) VALUES (?)").run(name).lastInsertRowid);
    },

    folderName(id: number): string | null {
      const r = db.prepare("SELECT name FROM folders WHERE id = ?").get(id);
      return r ? String(r.name) : null;
    },

    renameFolder(id: number, name: string) {
      db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
    },

    setFolderDeleted(id: number, deleted: boolean) {
      db.prepare("UPDATE folders SET deleted_at = ? WHERE id = ?").run(deleted ? new Date().toISOString() : null, id);
    },

    /** Removes deleted meetings and folders for good; returns the meeting ids so audio can go too. */
    purgeDeleted(): number[] {
      const ids = db
        .prepare("SELECT id FROM meetings WHERE deleted_at IS NOT NULL")
        .all()
        .map((r) => Number(r.id));
      db.exec(`
        DELETE FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE deleted_at IS NOT NULL);
        DELETE FROM meetings WHERE deleted_at IS NOT NULL;
        UPDATE meetings SET folder_id = NULL
          WHERE folder_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL);
        DELETE FROM folders WHERE deleted_at IS NOT NULL;
      `);
      return ids;
    },
  };
}
