import type { Translate } from "../shared/i18n";
import type { LibraryOp, LibraryResult } from "../shared/types";
import type { Db } from "./db";

/** One undoable change: `redo` repeats it after an undo. The label is worded when shown, in the UI language of that moment. */
type Step = { label: (t: Translate) => string; undo(): void; redo(): void };

/** The app-level undo stack behind ⌘Z / ⇧⌘Z (text fields keep their own). */
export class History {
  private done: Step[] = [];
  private undone: Step[] = [];

  push(step: Step) {
    this.done.push(step);
    if (this.done.length > 100) this.done.shift();
    this.undone = [];
  }

  /** Returns the label of what was undone, or null when there is nothing to undo. */
  undo(t: Translate): string | null {
    const step = this.done.pop();
    if (!step) return null;
    step.undo();
    this.undone.push(step);
    return step.label(t);
  }

  redo(t: Translate): string | null {
    const step = this.undone.pop();
    if (!step) return null;
    step.redo();
    this.done.push(step);
    return step.label(t);
  }

  undoLabel(t: Translate) {
    return this.done.at(-1)?.label(t) ?? null;
  }

  redoLabel(t: Translate) {
    return this.undone.at(-1)?.label(t) ?? null;
  }
}

/**
 * Applies a library change and records how to reverse it. Recording and summarizing are not
 * library changes and are not undoable.
 */
export function perform(db: Db, history: History, op: LibraryOp, t: Translate): LibraryResult {
  const fields = (id: number) => {
    const f = db.meetingFields(id);
    if (!f) throw new Error(t("error.meetingNotFound"));
    return f;
  };

  switch (op.type) {
    case "rename": {
      const title = op.title.trim();
      if (!title) return { ok: false, error: t("error.emptyTitle") };
      const before = fields(op.id);
      const redo = () => db.setTitle(op.id, title, true);
      redo();
      history.push({ label: (t) => t("undo.rename"), redo, undo: () => db.setTitle(op.id, before.title, before.titleEdited) });
      return { ok: true };
    }
    case "move": {
      const before = op.ids.map((id) => [id, fields(id).folderId] as const);
      const redo = () => op.ids.forEach((id) => db.setFolder(id, op.folderId));
      redo();
      history.push({
        label: (t) => t("undo.move"),
        redo,
        undo: () => before.forEach(([id, folderId]) => db.setFolder(id, folderId)),
      });
      return { ok: true };
    }
    case "star": {
      const before = op.ids.map((id) => [id, fields(id).starred] as const);
      const redo = () => op.ids.forEach((id) => db.setStarred(id, op.starred));
      redo();
      history.push({
        label: (t) => op.starred ? t("undo.star") : t("undo.unstar"),
        redo,
        undo: () => before.forEach(([id, starred]) => db.setStarred(id, starred)),
      });
      return { ok: true };
    }
    case "delete": {
      if (op.ids.some((id) => ["recording", "processing"].includes(fields(id).status)))
        return { ok: false, error: t("error.deleteBusy") };
      const redo = () => op.ids.forEach((id) => db.setMeetingDeleted(id, true));
      redo();
      history.push({
        label: (t) => op.ids.length > 1 ? t("undo.deleteMany", { n: op.ids.length }) : t("undo.delete"),
        redo,
        undo: () => op.ids.forEach((id) => db.setMeetingDeleted(id, false)),
      });
      return { ok: true };
    }
    case "createFolder": {
      const id = db.createFolder(op.name.trim() || t("folder.new"));
      history.push({
        label: (t) => t("undo.newFolder"),
        redo: () => db.setFolderDeleted(id, false),
        undo: () => db.setFolderDeleted(id, true),
      });
      return { ok: true, id };
    }
    case "renameFolder": {
      const name = op.name.trim();
      const before = db.folderName(op.id);
      if (!name || before === null) return { ok: false, error: t("error.emptyFolderName") };
      const redo = () => db.renameFolder(op.id, name);
      redo();
      history.push({ label: (t) => t("undo.renameFolder"), redo, undo: () => db.renameFolder(op.id, before) });
      return { ok: true };
    }
    case "deleteFolder": {
      // Its meetings stay; they show as unfiled until the folder is restored or purged.
      const redo = () => db.setFolderDeleted(op.id, true);
      redo();
      history.push({ label: (t) => t("undo.deleteFolder"), redo, undo: () => db.setFolderDeleted(op.id, false) });
      return { ok: true };
    }
  }
}
