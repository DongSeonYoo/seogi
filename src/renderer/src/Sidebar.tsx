import { Folder, FolderPlus, Inbox, Settings, Star, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Library, LibraryView } from "../../shared/types";
import { TitleInput } from "./Toolbar";
import { useT } from "./i18n";
import { IconButton } from "./ui";

/** Drag payload for a meeting row; folders and All Meetings accept it. */
export const MEETING_DRAG = "application/x-seogi-meeting";

/** Tower's sidebar: smart collections, then folders. Dropping a meeting files it. */
export function Sidebar({
  view,
  library,
  renamingFolder,
  onView,
  onDropMeeting,
  onFolderMenu,
  onRenameFolder,
  onNewFolder,
  onSettings,
}: {
  view: LibraryView;
  library: Library;
  renamingFolder: number | null;
  onView: (v: LibraryView) => void;
  onDropMeeting: (meetingId: number, folderId: number | null) => void;
  onFolderMenu: (folderId: number) => void;
  /** null: renaming was cancelled. */
  onRenameFolder: (id: number, name: string | null) => void;
  onNewFolder: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  const { counts, folders } = library;
  return (
    <aside className="sidebar" aria-label={t("sidebar.library")}>
      <div className="sidebar__lights drag" />
      <nav className="sidebar__scroll">
        <Section title={t("sidebar.library")}>
          <Item icon={Inbox} label={t("view.all")} count={counts.all} active={view === "all"} onClick={() => onView("all")} onDrop={(id) => onDropMeeting(id, null)} />
          <Item icon={Star} label={t("view.starred")} count={counts.starred} active={view === "starred"} onClick={() => onView("starred")} />
        </Section>
        <Section
          title={t("sidebar.folders")}
          action={
            <IconButton label={`${t("action.newFolder")} (⇧⌘N)`} onClick={onNewFolder}>
              <FolderPlus aria-hidden />
            </IconButton>
          }
        >
          {folders.map((f) =>
            renamingFolder === f.id ? (
              <li key={f.id} className="side-item" data-editing>
                <Folder aria-hidden />
                <TitleInput className="side-item__input" value={f.name} onDone={(name) => onRenameFolder(f.id, name)} />
              </li>
            ) : (
              <Item
                key={f.id}
                icon={Folder}
                label={f.name}
                count={f.count}
                active={view === f.id}
                onClick={() => onView(f.id)}
                onDrop={(id) => onDropMeeting(id, f.id)}
                onMenu={() => onFolderMenu(f.id)}
              />
            ),
          )}
          {!folders.length && <li className="side-empty">{t("sidebar.foldersEmpty")}</li>}
        </Section>
      </nav>
      <div className="sidebar__foot">
        <IconButton label={`${t("action.newFolder")} (⇧⌘N)`} onClick={onNewFolder}>
          <FolderPlus aria-hidden />
        </IconButton>
        <IconButton label={`${t("action.settings")} (⌘,)`} onClick={onSettings}>
          <Settings aria-hidden />
        </IconButton>
      </div>
    </aside>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="side-section">
      <h2 className="side-section__title">
        {title}
        {action}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

function Item({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  onDrop,
  onMenu,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onDrop?: (meetingId: number) => void;
  onMenu?: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="side-item"
        aria-current={active || undefined}
        data-drop={over || undefined}
        onClick={onClick}
        onContextMenu={
          onMenu &&
          ((e) => {
            e.preventDefault();
            onMenu();
          })
        }
        onDragOver={
          onDrop &&
          ((e) => {
            if (!e.dataTransfer.types.includes(MEETING_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(true);
          })
        }
        onDragLeave={() => setOver(false)}
        onDrop={
          onDrop &&
          ((e) => {
            setOver(false);
            const id = Number(e.dataTransfer.getData(MEETING_DRAG));
            if (id) onDrop(id);
          })
        }
      >
        <Icon aria-hidden />
        <span className="side-item__label">{label}</span>
        {count > 0 && <span className="side-item__count tnum">{count}</span>}
      </button>
    </li>
  );
}
