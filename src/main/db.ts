import { DatabaseSync } from "node:sqlite";
import type {
  Folder,
  LibraryCounts,
  LibraryView,
  MeetingRow,
  MeetingStatus,
  SpeakerNames,
  Summary,
  Track,
  Utterance,
} from "../shared/types";
import { summaryMarkdown, summaryPreview } from "../shared/summary.ts";
import type { Translate } from "../shared/i18n";

export type Db = ReturnType<typeof openDb>;

function legacySummary(json: string): Summary | null {
  let s: Summary;
  try {
    s = JSON.parse(json);
  } catch {
    return null;
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!s || typeof s.title !== "string" || typeof s.overview !== "string" || !strings(s.decisions)) return null;
  if (!Array.isArray(s.actionItems) || !s.actionItems.every((a) =>
    a && typeof a.task === "string" && typeof a.owner === "string" && typeof a.due === "string")) return null;
  if (!Array.isArray(s.topics) || !s.topics.every((x) => x && typeof x.title === "string" && strings(x.points))) return null;
  return s;
}

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
    CREATE TABLE IF NOT EXISTS pending_audio_deletes (
      meeting_id INTEGER PRIMARY KEY AUTOINCREMENT
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
  db.exec("CREATE INDEX IF NOT EXISTS meetings_live_folder ON meetings(folder_id) WHERE deleted_at IS NULL");
  // A title the user typed; a later summary keeps it instead of writing its own.
  addColumn("title_edited", "title_edited INTEGER NOT NULL DEFAULT 0");
  addColumn("ended_at", "ended_at TEXT");
  // Per-session choices; null falls back to the settings (glossary: an override, not an addition).
  addColumn("live_model", "live_model TEXT");
  addColumn("glossary", "glossary TEXT");
  addColumn("speaker_names", "speaker_names TEXT");
  // Speaker 1, 2, … within a track, when diarization told voices apart; null otherwise.
  const utteranceColumns = db.prepare("PRAGMA table_info(utterances)").all().map((c) => c.name);
  if (!utteranceColumns.includes("speaker")) db.exec("ALTER TABLE utterances ADD COLUMN speaker INTEGER");
  // A crash mid-recording leaves rows that no session will ever finish.
  db.prepare("UPDATE meetings SET status = 'error', error = ? WHERE status IN ('recording', 'processing')").run(
    appQuitMessage,
  );

  const live = "m.deleted_at IS NULL";
  const select = `SELECT m.*, f.id AS live_folder_id,
      COALESCE((julianday(m.ended_at) - julianday(m.started_at)) * 86400,
               (SELECT MAX(start_sec) FROM utterances u WHERE u.meeting_id = m.id), 0) AS duration_sec,
      EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id) AS has_transcript
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
    hasTranscript: Boolean(r.has_transcript),
    preview: r.summary ? summaryPreview(String(r.summary)) : null,
  });

  const viewWhere: Record<Exclude<LibraryView, number>, string> = {
    all: "1",
    starred: "m.starred = 1",
  };

  return {
    raw: db,

    createMeeting(title: string, folderId: number | null = null): number {
      // sqlite_sequence remembers even acknowledged deletions. A slow retry must never
      // see a new meeting at a retired folder path.
      const r = db
        .prepare(`INSERT INTO meetings (id, title, started_at, status, folder_id)
          VALUES (1 + MAX(COALESCE((SELECT MAX(id) FROM meetings), 0),
                          COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'pending_audio_deletes'), 0)),
                  ?, ?, 'new', ?)`)
        .run(title, new Date().toISOString(), folderId);
      return Number(r.lastInsertRowid);
    },

    /** The session's own live model and glossary; null where it uses the settings. */
    sessionOptions(id: number): { liveModel: string | null; glossary: string | null } {
      const r = db.prepare("SELECT live_model, glossary FROM meetings WHERE id = ?").get(id);
      return {
        liveModel: r?.live_model ? String(r.live_model) : null,
        glossary: r?.glossary ? String(r.glossary) : null,
      };
    },

    setSessionOptions(id: number, o: { liveModel?: string | null; glossary?: string }) {
      if (o.liveModel !== undefined) db.prepare("UPDATE meetings SET live_model = ? WHERE id = ?").run(o.liveModel, id);
      if (o.glossary !== undefined)
        db.prepare("UPDATE meetings SET glossary = ? WHERE id = ?").run(o.glossary.trim() || null, id);
    },

    /** An imported file is being transcribed; only an unrecorded session takes one. */
    startImport(id: number): boolean {
      return db.prepare("UPDATE meetings SET status = 'processing' WHERE id = ? AND status = 'new' AND deleted_at IS NULL").run(id).changes > 0;
    },

    /** The import is done: its length is the file's, counted from when the session was made. */
    finishImport(id: number, durationSec: number, error: string | null) {
      const r = db.prepare("SELECT started_at FROM meetings WHERE id = ?").get(id);
      const ended = new Date(Date.parse(String(r?.started_at)) + durationSec * 1000).toISOString();
      db.prepare("UPDATE meetings SET status = ?, error = ?, ended_at = ? WHERE id = ?").run(error && !this.hasUtterances(id) ? "error" : "done", error, ended, id);
    },

    hasUtterances(id: number): boolean {
      return !!db.prepare("SELECT 1 FROM utterances WHERE meeting_id = ? LIMIT 1").get(id);
    },

    /** Recording starts the clock, so the length leaves out the time before it. */
    startRecording(id: number): boolean {
      const r = db
        .prepare("UPDATE meetings SET status = 'recording', started_at = ? WHERE id = ? AND status = 'new'")
        .run(new Date().toISOString(), id);
      return r.changes > 0;
    },

    /** A finished meeting records on: its end is unset until the next stop fixes it again. */
    continueRecording(id: number): boolean {
      return db.prepare("UPDATE meetings SET status = 'recording', ended_at = NULL, error = NULL WHERE id = ? AND status IN ('done', 'error') AND deleted_at IS NULL").run(id).changes > 0;
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
    /** Live caption times can run a little past the recording's end (a reconnect's late turn). */
    clampUtterances(id: number) {
      db.prepare(
        `UPDATE utterances SET start_sec = (
           SELECT MAX(0, (julianday(ended_at) - julianday(started_at)) * 86400 - 0.5) FROM meetings WHERE id = ?1)
         WHERE meeting_id = ?1 AND start_sec > (
           SELECT (julianday(ended_at) - julianday(started_at)) * 86400 FROM meetings WHERE id = ?1 AND ended_at IS NOT NULL)`,
      ).run(id);
    },

    /** `recordedSec`: the audio length, for a paused meeting whose wall-clock span includes the pauses. */
    setEnded(id: number, recordedSec?: number) {
      if (recordedSec === undefined)
        db.prepare("UPDATE meetings SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
      else
        db.prepare(
          "UPDATE meetings SET ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+' || ? || ' seconds')) WHERE id = ?",
        ).run(recordedSec, id);
    },

    /** A new summary (Markdown) and its title; a title the user typed stays. */
    setSummary(id: number, title: string, markdown: string) {
      db.prepare(
        "UPDATE meetings SET title = CASE WHEN title_edited THEN title ELSE ? END, summary = ? WHERE id = ?",
      ).run(title, markdown, id);
    },

    /** The user's edit of the summary text. */
    setSummaryText(id: number, markdown: string) {
      db.prepare("UPDATE meetings SET summary = ? WHERE id = ?").run(markdown.trim() ? markdown : null, id);
    },

    /** Later edits are free-form Markdown, even if the user pastes valid JSON. */
    migrateSummaries(t: Translate) {
      if (Number(db.prepare("PRAGMA user_version").get()?.user_version) >= 1) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare("UPDATE meetings SET summary = ? WHERE id = ?");
        const rows = db.prepare("SELECT id, summary FROM meetings WHERE ltrim(summary, char(9,10,13,32)) LIKE '{%'").all();
        for (const row of rows) {
          const s = legacySummary(String(row.summary));
          if (s) update.run(summaryMarkdown(s, t), row.id);
        }
        db.exec("PRAGMA user_version = 1; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    addUtterances(meetingId: number, track: Track, rows: { startSec: number; text: string; speaker?: number }[]) {
      const insert = db.prepare(
        "INSERT INTO utterances (meeting_id, track, start_sec, text, speaker) VALUES (?, ?, ?, ?, ?)",
      );
      db.exec("BEGIN");
      try {
        const stored = rows.map(({ startSec, text, speaker }): Utterance => {
          const { lastInsertRowid } = insert.run(meetingId, track, startSec, text, speaker ?? null);
          return { id: Number(lastInsertRowid), track, startSec, text, speaker: speaker ?? null };
        });
        db.exec("COMMIT");
        return stored;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    // ponytail: LIKE scan over all text; add an FTS5 trigram table if search gets slow.
    listMeetings(view: LibraryView = "all", query?: string): MeetingRow[] {
      const folder = typeof view === "number";
      // Both parameters are always bound, so the clauses that do not apply test them as no-ops.
      return db
        .prepare(
          `${select} WHERE ${live} AND ${folder ? "1" : viewWhere[view as Exclude<LibraryView, number>]}
           AND (?2 IS NULL OR f.id = ?2)
           AND (?1 = '%%' OR m.title LIKE ?1 OR m.summary LIKE ?1
             OR EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id AND u.text LIKE ?1))
           ORDER BY m.started_at DESC ${query === undefined ? "" : "LIMIT 50"}`,
        )
        .all(`%${query?.trim() ?? ""}%`, folder ? view : null)
        .map(toRow);
    },

    counts(): LibraryCounts {
      const one = (where: string) =>
        Number(db.prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE ${live} AND ${where}`).get()?.n ?? 0);
      return {
        all: one(viewWhere.all),
        starred: one(viewWhere.starred),
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

    setSpeakerName(id: number, key: string, name: string) {
      const r = db.prepare("SELECT speaker_names FROM meetings WHERE id = ?").get(id);
      const names: SpeakerNames = r?.speaker_names ? JSON.parse(String(r.speaker_names)) : {};
      if (name.trim()) names[key] = name.trim();
      else delete names[key];
      db.prepare("UPDATE meetings SET speaker_names = ? WHERE id = ?").run(Object.keys(names).length ? JSON.stringify(names) : null, id);
    },
    /** Lines as stored, for putting them back after an edit is undone. */
    linesById(meetingId: number, ids: number[]): Utterance[] {
      const get = db.prepare("SELECT id, track, start_sec, text, speaker FROM utterances WHERE id = ? AND meeting_id = ?");
      return ids.flatMap((id) => {
        const r = get.get(id, meetingId);
        return r ? [{ id: Number(r.id), track: r.track as Track, startSec: Number(r.start_sec), text: String(r.text), speaker: r.speaker === null ? null : Number(r.speaker) }] : [];
      });
    },
    /** Puts lines back exactly as they were, ids included. */
    restoreLines(meetingId: number, lines: Utterance[]) {
      const put = db.prepare("INSERT OR REPLACE INTO utterances (id, meeting_id, track, start_sec, text, speaker) VALUES (?, ?, ?, ?, ?, ?)");
      db.exec("BEGIN");
      try {
        for (const u of lines) put.run(u.id, meetingId, u.track, u.startSec, u.text, u.speaker);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** A line corrected by hand, with the pieces that were shown joined to it removed. */
    editUtterance(meetingId: number, id: number, text: string, joined: number[] = []) {
      const remove = db.prepare("DELETE FROM utterances WHERE id = ? AND meeting_id = ?");
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE utterances SET text = ? WHERE id = ? AND meeting_id = ?").run(text, id, meetingId);
        for (const piece of joined) remove.run(piece, meetingId);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** Speaker numbers for a meeting's lines, written together. */
    setSpeakers(meetingId: number, speakers: Map<number, number>) {
      const update = db.prepare("UPDATE utterances SET speaker = ? WHERE id = ? AND meeting_id = ?");
      db.exec("BEGIN");
      try {
        for (const [id, speaker] of speakers) update.run(speaker, id, meetingId);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getMeeting(id: number) {
      const r = db.prepare(`${select} WHERE m.id = ? AND ${live}`).get(id);
      if (!r) return null;
      const utterances = db
        .prepare(
          "SELECT id, track, start_sec, text, speaker FROM utterances WHERE meeting_id = ? ORDER BY start_sec, id",
        )
        .all(id)
        .map(
          (u): Utterance => ({
            id: Number(u.id),
            track: u.track as Track,
            startSec: Number(u.start_sec),
            text: String(u.text),
            speaker: u.speaker === null ? null : Number(u.speaker),
          }),
        );
      return {
        ...toRow(r),
        summary: r.summary ? String(r.summary) : null,
        error: r.error ? String(r.error) : null,
        liveModel: r.live_model ? String(r.live_model) : null,
        glossary: r.glossary ? String(r.glossary) : "",
        speakerNames: r.speaker_names ? (JSON.parse(String(r.speaker_names)) as SpeakerNames) : {},
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

    /** Permanently deletes the rows and records the remaining filesystem work together. */
    purgeDeleted(): number[] {
      const deleted = "deleted_at IS NOT NULL AND status NOT IN ('recording', 'processing')";
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          INSERT INTO pending_audio_deletes SELECT id FROM meetings WHERE ${deleted};
          DELETE FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE ${deleted});
          DELETE FROM meetings WHERE ${deleted};
          UPDATE meetings SET folder_id = NULL
            WHERE folder_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL);
          DELETE FROM folders WHERE deleted_at IS NOT NULL;
          COMMIT;
        `);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return db.prepare("SELECT meeting_id FROM pending_audio_deletes").all().map((r) => Number(r.meeting_id));
    },

    audioRemoved(id: number) {
      db.prepare("DELETE FROM pending_audio_deletes WHERE meeting_id = ?").run(id);
    },
  };
}
