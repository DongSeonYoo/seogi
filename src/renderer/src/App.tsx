import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionId,
  Library,
  LibraryOp,
  LibraryView,
  LiveView,
  MeetingDetail,
  MeetingRow,
  MenuSpec,
} from "../../shared/types";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { MeetingList } from "./MeetingList";
import { MeetingView, type DetailTab } from "./MeetingView";
import { useT } from "./i18n";
import { liveCaptionHooks } from "./gptLive";
import { NO_SYSTEM_AUDIO, startRecording } from "./recorder";
import { Sidebar } from "./Sidebar";
import { Splitter, useLayout } from "./Splitter";
import { StyleGuide } from "./StyleGuide";
import { Toolbar, type Recording } from "./Toolbar";

const api = window.api;
const EMPTY_LIBRARY: Library = {
  counts: { all: 0, starred: 0, recording: false },
  folders: [],
};

/** A text field has focus, so ⌘Z and friends belong to it. */
const typing = () => document.activeElement?.matches("input, textarea, [contenteditable]") ?? false;

export function App() {
  const t = useT();
  const [view, setView] = useState<LibraryView>("all");
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [library, setLibrary] = useState<Library>(EMPTY_LIBRARY);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>("summary");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [live, setLive] = useState<{ id: number; view: LiveView } | null>(null);
  const [systemSilent, setSystemSilent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const panes = useLayout();
  const { sidebar } = panes.layout;
  const [palette, setPalette] = useState(false);
  const [guide, setGuide] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<number | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);

  const refreshList = useCallback(async () => {
    const [rows, lib] = await Promise.all([api.listMeetings(view), api.library()]);
    setMeetings(rows);
    setLibrary(lib);
  }, [view]);
  const refreshDetail = useCallback(async () => {
    if (selected === null) return setDetail(null);
    const d = await api.getMeeting(selected);
    setDetail(d);
    // A deleted meeting leaves the detail pane.
    if (!d) setSelected(null);
  }, [selected]);

  useEffect(() => void refreshList(), [refreshList]);
  useEffect(() => void refreshDetail(), [refreshDetail]);
  useEffect(
    () =>
      api.onMeetingChanged((id) => {
        void refreshList();
        if (id === selected || id === -1) void refreshDetail();
      }),
    [refreshList, refreshDetail, selected],
  );
  useEffect(() => api.onLive((id, v) => setLive({ id, view: v })), []);

  // The selection follows the macOS accent colour.
  useEffect(() => {
    const apply = (hex: string) => document.documentElement.style.setProperty("--system-accent", hex);
    void api.accentColor().then(apply);
    return api.onAccentColor(apply);
  }, []);
  // Lists grey out their selection while the window is in the background, like AppKit.
  useEffect(() => {
    const set = () => document.documentElement.toggleAttribute("data-inactive", !document.hasFocus());
    window.addEventListener("focus", set);
    window.addEventListener("blur", set);
    return () => {
      window.removeEventListener("focus", set);
      window.removeEventListener("blur", set);
    };
  }, []);

  // A folder whose creation was undone (or that was deleted elsewhere) can no longer be shown.
  useEffect(() => {
    if (typeof view === "number" && library !== EMPTY_LIBRARY && !library.folders.some((f) => f.id === view)) setView("all");
  }, [library, view]);

  // Opening a finished meeting clears its unread mark.
  useEffect(() => {
    if (detail?.status === "done" && detail.unread) void api.markOpened(detail.id).then(refreshList);
  }, [detail, refreshList]);

  function select(id: number | null) {
    setSelected(id);
    setRenaming(false);
    setGuide(false);
    const m = meetings.find((x) => x.id === id);
    setTab(m && (m.status === "recording" || m.status === "processing") ? "transcript" : "summary");
  }

  async function run(op: LibraryOp) {
    const r = await api.perform(op);
    if (!r.ok) setNotice(r.error);
    return r;
  }

  async function start() {
    setNotice(null);
    const { recording: options, live: liveModel } = await api.getSettings();
    const id = await api.startMeeting(typeof view === "number" ? view : null);
    const captions = liveCaptionHooks(id, liveModel);
    try {
      const stopRecording = await startRecording(
        (track, startSec, pcm) => api.sendChunk({ meetingId: id, track, startSec, pcm }),
        { ...options, onSystemSilence: setSystemSilent, ...captions.options },
      );
      stopRef.current = async () => {
        captions.stop();
        await stopRecording();
      };
    } catch (e) {
      captions.stop();
      await api.stopMeeting(id);
      const message = e instanceof Error ? e.message : String(e);
      setNotice(t("notice.startFailed", { error: message === NO_SYSTEM_AUDIO ? t("error.noSystemAudio") : message }));
      return;
    }
    setRecording({ id, startedAt: Date.now() });
    void refreshList();
    setSelected(id);
    setTab("transcript");
    setGuide(false);
  }

  async function stop() {
    if (!recording) return;
    const { id } = recording;
    setRecording(null);
    setSystemSilent(false);
    await stopRef.current?.();
    stopRef.current = null;
    await api.stopMeeting(id);
  }

  const current = detail && detail.id === selected ? detail : null;
  const busy = (m: { status: string } | null) => m?.status === "recording" || m?.status === "processing";

  /** Every command, once: the menu bar, toolbar, context menus and ⌘K all run these. */
  const actions: Record<ActionId, PaletteAction> = {
    record: {
      label: recording ? t("action.stop") : t("action.record"),
      shortcut: "⇧⌘R",
      run: () => void (recording ? stop() : start()),
    },
    newFolder: {
      label: t("action.newFolder"),
      shortcut: "⇧⌘N",
      run: async () => {
        const r = await run({ type: "createFolder", name: t("folder.new") });
        if (r.ok && r.id) {
          // Load the folder before showing it, or the missing-folder check sends the view back to All Meetings.
          setLibrary(await api.library());
          setView(r.id);
          setRenamingFolder(r.id);
        }
      },
    },
    undo: {
      label: t("action.undo"),
      shortcut: "⌘Z",
      run: () => (typing() ? void document.execCommand("undo") : void api.undo()),
    },
    redo: {
      label: t("action.redo"),
      shortcut: "⇧⌘Z",
      run: () => (typing() ? void document.execCommand("redo") : void api.redo()),
    },
    palette: { label: t("action.palette"), shortcut: "⌘K", run: () => setPalette(true) },
    rename: { label: t("action.rename"), enabled: !!current, run: () => setRenaming(true) },
    star: {
      label: current?.starred ? t("action.unstar") : t("action.star"),
      shortcut: "⌘D",
      enabled: !!current,
      run: () => void (current && run({ type: "star", ids: [current.id], starred: !current.starred })),
    },
    resummarize: {
      label: t("action.resummarize"),
      shortcut: "⇧⌘S",
      enabled: !!current && !busy(current) && current.utterances.length > 0,
      run: () => void (current && api.resummarize(current.id)),
    },
    delete: {
      label: t("action.delete"),
      shortcut: "⌘⌫",
      enabled: !!current && !busy(current),
      run: async () => {
        if (!current || typing()) return;
        const i = meetings.findIndex((m) => m.id === current.id);
        const r = await run({ type: "delete", ids: [current.id] });
        if (r.ok) select((meetings[i + 1] ?? meetings[i - 1])?.id ?? null);
      },
    },
    "tab:summary": { label: t("action.showSummary"), shortcut: "⌘1", enabled: !!current, run: () => setTab("summary") },
    "tab:transcript": { label: t("action.showTranscript"), shortcut: "⌘2", enabled: !!current, run: () => setTab("transcript") },
    toggleSidebar: { label: t("action.toggleSidebar"), shortcut: "⌘B", run: panes.toggleSidebar },
    settings: { label: t("action.settings"), shortcut: "⌘,", run: () => api.openSettings() },
    styleGuide: { label: t("action.styleGuide"), run: () => void (import.meta.env.DEV && setGuide((v) => !v)) },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const perform = (id: ActionId) => {
    const a = actionsRef.current[id];
    if (a.enabled !== false) void a.run();
  };
  useEffect(() => api.onMenuAction(perform), []);

  /** The right-click menu for a meeting: the same actions plus "move to folder". */
  async function meetingMenu(m: MeetingRow) {
    select(m.id);
    const folders: MenuSpec[] = [
      { id: "folder:none", label: t("folder.none"), checked: m.folderId === null },
      ...library.folders.map((f) => ({ id: `folder:${f.id}`, label: f.name, checked: m.folderId === f.id })),
    ];
    const locked = busy(m);
    const chosen = await api.showMenu([
      { id: "rename", label: t("action.rename") },
      { id: "star", label: m.starred ? t("action.unstar") : t("action.star") },
      { label: t("action.moveTo"), submenu: folders },
      { id: "resummarize", label: t("action.resummarize"), enabled: !locked },
      { type: "separator" },
      { id: "delete", label: t("action.delete"), enabled: !locked },
    ]);
    if (!chosen) return;
    if (chosen.startsWith("folder:")) {
      const folderId = chosen === "folder:none" ? null : Number(chosen.slice(7));
      return void run({ type: "move", ids: [m.id], folderId });
    }
    if (chosen === "rename") return setRenaming(true);
    if (chosen === "star") return void run({ type: "star", ids: [m.id], starred: !m.starred });
    if (chosen === "resummarize") return void api.resummarize(m.id);
    if (chosen === "delete") {
      const i = meetings.findIndex((x) => x.id === m.id);
      const r = await run({ type: "delete", ids: [m.id] });
      if (r.ok) select((meetings[i + 1] ?? meetings[i - 1])?.id ?? null);
    }
  }

  async function folderMenu(id: number) {
    const chosen = await api.showMenu([
      { id: "rename", label: t("action.rename") },
      { type: "separator" },
      { id: "delete", label: t("action.deleteFolder") },
    ]);
    if (chosen === "rename") setRenamingFolder(id);
    if (chosen === "delete") {
      await run({ type: "deleteFolder", id });
      if (view === id) setView("all");
    }
  }

  const viewTitle =
    typeof view === "number"
      ? (library.folders.find((f) => f.id === view)?.name ?? t("view.folder"))
      : t(`view.${view}`);

  return (
    <div className="app" data-sidebar={sidebar || undefined} style={panes.style}>
      {sidebar && (
        <Splitter
          at={panes.layout.sidebarW}
          label={t("sidebar.resize")}
          onResize={panes.resizeSidebar}
          onReset={panes.resetSidebar}
        />
      )}
      <Splitter
        at={(sidebar ? panes.layout.sidebarW : 0) + panes.layout.listW}
        label={t("sidebar.resizeList")}
        className="splitter--list"
        onResize={(w) => panes.resizeList(w - (sidebar ? panes.layout.sidebarW : 0))}
        onReset={panes.resetList}
      />
      {sidebar && (
        <Sidebar
          view={view}
          library={library}
          renamingFolder={renamingFolder}
          onView={(v) => {
            setView(v);
            setGuide(false);
          }}
          onDropMeeting={(id, folderId) => void run({ type: "move", ids: [id], folderId })}
          onFolderMenu={folderMenu}
          onRenameFolder={(id, name) => {
            setRenamingFolder(null);
            if (name !== null) void run({ type: "renameFolder", id, name });
          }}
          onNewFolder={() => perform("newFolder")}
          onSettings={() => perform("settings")}
        />
      )}
      <Toolbar
        meeting={current}
        recording={recording}
        renaming={renaming}
        sidebar={sidebar}
        onToggleSidebar={() => perform("toggleSidebar")}
        onRename={(title) => {
          setRenaming(false);
          if (current && title !== null && title !== current.title) void run({ type: "rename", id: current.id, title });
        }}
        onStartRename={() => perform("rename")}
        onRecord={() => perform("record")}
        onStar={() => perform("star")}
        onResummarize={() => perform("resummarize")}
        onPalette={() => perform("palette")}
        canResummarize={actions.resummarize.enabled !== false}
      />
      <MeetingList
        title={viewTitle}
        meetings={meetings}
        selected={selected}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        onSelect={select}
        onMenu={meetingMenu}
      />
      <main className="detail">
        {guide ? (
          <StyleGuide />
        ) : current ? (
          <MeetingView
            meeting={current}
            tab={tab}
            onTab={setTab}
            live={live?.id === current.id ? live.view : null}
            recording={recording?.id === current.id ? recording : null}
            systemSilent={systemSilent}
          />
        ) : (
          <div className="placeholder">
            <strong>{meetings.length ? t("placeholder.pick") : t("placeholder.empty")}</strong>
            <span>{t("placeholder.hint")}</span>
          </div>
        )}
      </main>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        actions={(Object.keys(actions) as ActionId[])
          .filter((id) => !["palette", "undo", "redo", "styleGuide"].includes(id))
          .map((id) => ({ ...actions[id], id }))}
        onPick={(id) => {
          setView("all");
          select(id);
        }}
      />
    </div>
  );
}
