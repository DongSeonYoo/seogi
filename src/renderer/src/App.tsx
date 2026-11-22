import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionId,
  Library,
  LibraryOp,
  LibraryView,
  LiveView,
  MeetingDetail,
  MeetingRow,
  MenuSpec,
  Settings,
  Utterance,
} from "../../shared/types";
import { mergeUtterances } from "../../shared/transcript";
import { showStored } from "../../shared/i18n";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { summaryPreview } from "../../shared/summary";
import { MeetingList } from "./MeetingList";
import { MeetingView } from "./MeetingView";
import { useT } from "./i18n";
import { preparingAudio } from "./importAudio";
import { encodeOpus } from "./opus";
import { liveCaptionHooks } from "./gptLive";
import { NO_SYSTEM_AUDIO, startRecording } from "./recorder";
import { Sidebar } from "./Sidebar";
import { LIST_W, SIDEBAR_W, Splitter, useLayout } from "./Splitter";
import { Toolbar, type Recording } from "./Toolbar";
import { useAppStyle } from "./ui";
import { onAccent } from "./format";

const api = window.api;
const StyleGuide = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import("./StyleGuide")).StyleGuide }))
  : null;
const EMPTY_LIBRARY: Library = {
  counts: { all: 0, starred: 0, recording: false },
  folders: [],
};

/** A text field has focus, so ⌘Z and friends belong to it. */
const typing = () => document.activeElement?.matches("input, textarea, [contenteditable]") ?? false;

function addToDetail(detail: MeetingDetail, rows: Utterance[]): MeetingDetail {
  const utterances = mergeUtterances(detail.utterances, rows);
  if (utterances === detail.utterances) return detail;
  return { ...detail, utterances, durationSec: Math.max(detail.durationSec, utterances.at(-1)!.startSec) };
}

export function App() {
  const t = useT();
  const [view, setView] = useState<LibraryView>("all");
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [library, setLibrary] = useState<Library>(EMPTY_LIBRARY);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [live, setLive] = useState<{ id: number; view: LiveView } | null>(null);
  const [systemSilent, setSystemSilent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const panes = useLayout();
  const { sidebar } = panes.layout;
  const [palette, setPalette] = useState(false);
  /** ⌘F presses: each opens (or refocuses) the open meeting's find bar. */
  const [findN, setFindN] = useState(0);
  /** A line picked in ⌘K: its meeting opens there. */
  const [reveal, setReveal] = useState<{ id: number; sec: number; n: number } | null>(null);
  const [guide, setGuide] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<number | null>(null);
  /** Ends the running capture; resolves to the seconds it recorded. */
  const stopRef = useRef<(() => Promise<number>) | null>(null);
  /** The live recording and a start in progress, read by handlers that may run before a re-render. */
  const recordingRef = useRef<Recording | null>(null);
  /** A pause whose capture is still ending; resume and stop wait for it. */
  const pausingRef = useRef<Promise<void> | null>(null);
  const startingRef = useRef<Promise<void> | null>(null);
  /** The meeting whose summary is being written, and the last summarize failure. */
  const [summarizing, setSummarizing] = useState<number | null>(null);
  const [summaryError, setSummaryError] = useState<{ id: number; error: string } | null>(null);
  /** The summary model picked in the pane; null uses the one in Settings. */
  const [summaryModel, setSummaryModel] = useState<string | null>(null);
  /** Set when Stop is pressed before the start has a meeting to stop. */
  const cancelRef = useRef(false);

  // A list or detail read already in flight must keep edits made after its snapshot.
  type ListEdit = Partial<Pick<MeetingRow, "preview" | "durationSec">>;
  const listEdits = useRef<Map<number, ListEdit> | null>(null);
  type DetailRead = { id: number; rows: Utterance[]; edit?: Pick<MeetingDetail, "summary" | "preview"> };
  const detailRead = useRef<DetailRead | null>(null);
  const saveSummary = useCallback((id: number, markdown: string) => {
    void api.setSummaryText(id, markdown);
    const edit = { summary: markdown.trim() ? markdown : null, preview: summaryPreview(markdown) };
    listEdits.current?.set(id, { ...listEdits.current.get(id), preview: edit.preview });
    if (detailRead.current?.id === id) detailRead.current.edit = edit;
    setMeetings((rows) => {
      const index = rows.findIndex((m) => m.id === id);
      if (index < 0 || rows[index].preview === edit.preview) return rows;
      return rows.with(index, { ...rows[index], preview: edit.preview });
    });
    setDetail((m) => m?.id === id ? { ...m, ...edit } : m);
  }, []);

  const refreshList = useCallback(async () => {
    const edits = new Map<number, ListEdit>();
    listEdits.current = edits;
    const [rows, lib] = await Promise.all([api.listMeetings(view), api.library()]);
    if (listEdits.current !== edits) return;
    listEdits.current = null;
    setMeetings(edits.size ? rows.map((m) => {
      const edit = edits.get(m.id);
      return edit ? { ...m, ...edit, durationSec: Math.max(m.durationSec, edit.durationSec ?? 0) } : m;
    }) : rows);
    setLibrary(lib);
  }, [view]);
  useEffect(() => void refreshList(), [refreshList]);
  useEffect(() => api.onMeetingChanged(() => void refreshList()), [refreshList]);
  useEffect(() => {
    async function reload() {
      if (selected === null) return setDetail(null);
      const request: DetailRead = { id: selected, rows: [] };
      detailRead.current = request;
      const d = await api.getMeeting(selected);
      if (detailRead.current !== request) return;
      detailRead.current = null;
      setDetail(d && addToDetail(request.edit ? { ...d, ...request.edit } : d, request.rows));
      if (!d) setSelected((id) => id === selected ? null : id);
    }
    const offRows = api.onUtterancesAdded((id, rows) => {
      const lastSec = rows.reduce((last, u) => Math.max(last, u.startSec), 0);
      const edit = listEdits.current?.get(id);
      listEdits.current?.set(id, { ...edit, durationSec: Math.max(edit?.durationSec ?? 0, lastSec) });
      setMeetings((list) => list.map((m) => m.id === id && m.durationSec < lastSec ? { ...m, durationSec: lastSec } : m));
      if (id !== selected) return;
      detailRead.current?.rows.push(...rows);
      setDetail((d) => d?.id === id ? addToDetail(d, rows) : d);
    });
    const offChange = api.onMeetingChanged((id) => {
      if (id === selected || id === -1) void reload();
    });
    void reload();
    return () => {
      detailRead.current = null;
      offRows();
      offChange();
    };
  }, [selected]);
  useEffect(() => {
    setLive(null);
    if (selected === null) return;
    let acceptSnapshot = true;
    const off = api.onLive((id, view) => {
      if (id !== selected) return;
      acceptSnapshot = false;
      setLive({ id, view });
    });
    void api.liveView(selected).then((view) => {
      if (acceptSnapshot && view) setLive({ id: selected, view });
    });
    return () => { acceptSnapshot = false; off(); };
  }, [selected]);

  // The selection follows the macOS accent colour.
  useEffect(() => {
    const apply = (hex: string) => {
      document.documentElement.style.setProperty("--system-accent", hex);
      document.documentElement.style.setProperty("--system-on-accent", onAccent(hex));
    };
    void api.accentColor().then(apply);
    return api.onAccentColor(apply);
  }, []);
  useAppStyle();
  // A selection the list on screen no longer shows (another folder, an unstarred meeting) goes, so
  // the toolbar never acts on a meeting out of sight. The recording session stays open regardless.
  useEffect(() => {
    if (selected !== null && selected !== recordingRef.current?.id && !meetings.some((m) => m.id === selected)) setSelected(null);
  }, [meetings]);

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
  }

  async function run(op: LibraryOp) {
    const r = await api.perform(op);
    if (!r.ok) setNotice(r.error);
    return r;
  }

  /** Starts a meeting; a second press stops it, even while capture is still being set up. */
  function start() {
    if (startingRef.current || recordingRef.current) return;
    cancelRef.current = false;
    startingRef.current = begin().finally(() => (startingRef.current = null));
  }

  async function begin() {
    setNotice(null);
    const { recording: options, live: liveModel } = await api.getSettings();
    // Records into the open session if it has not been recorded yet, else into a new one.
    const session = current?.status === "new" && !preparingAudio(current.id) ? current : null;
    const id = session?.id ?? (await api.createMeeting(typeof view === "number" ? view : null));
    if (!(await api.startMeeting(id))) return;
    // Recording from the press on: the toolbar flips to Stop while capture (and its permission
    // prompts) is still being set up.
    const rec: Recording = { id, startedAt: Date.now(), offsetSec: 0 };
    recordingRef.current = rec;
    setRecording(rec);
    void refreshList();
    setSelected(id);
    setGuide(false);
    if (cancelRef.current) return endRecording(rec);
    if (await capture(rec, options, { provider: liveModel.provider, model: session?.liveModel ?? liveModel.model }))
      if (cancelRef.current) await endRecording(rec);
  }

  /** Starts capture and captions for `rec`; false (with a notice) when they could not start. */
  async function capture(rec: Recording, options: Settings["recording"], live: Settings["live"]) {
    const { id, offsetSec } = rec;
    const captions = liveCaptionHooks(id, live);
    try {
      let writes = Promise.resolve();
      const stopRecording = await startRecording(
        (track, startSec, pcm) => {
          writes = writes.then(async () => {
            const ogg = await encodeOpus(pcm);
            api.sendChunk({ meetingId: id, track, startSec: offsetSec + startSec, ...(ogg ? { ogg } : { pcm }) });
          });
        },
        { ...options, onSystemSilence: setSystemSilent, ...captions.options },
      );
      stopRef.current = async () => {
        try {
          return await stopRecording();
        } finally {
          captions.stop();
          await writes;
        }
      };
      return true;
    } catch (e) {
      captions.stop();
      if (recordingRef.current !== rec) return false; // already stopped; nothing to report
      const message = e instanceof Error ? e.message : String(e);
      setNotice(t("notice.startFailed", { error: message === NO_SYSTEM_AUDIO ? t("error.noSystemAudio") : message }));
      if (offsetSec) {
        // A resume that failed leaves the meeting paused, with what was recorded before.
        await api.pauseMeeting(id);
        const paused = { ...rec, startedAt: null };
        recordingRef.current = paused;
        setRecording(paused);
      } else {
        recordingRef.current = null;
        setRecording(null);
        await api.abortMeeting(id);
      }
      return false;
    }
  }

  /** Ends the capture but not the meeting: the session's model and glossary can change meanwhile. */
  function pause() {
    const rec = recordingRef.current;
    const stopCapture = stopRef.current;
    if (!rec || rec.startedAt === null || !stopCapture || pausingRef.current) return;
    stopRef.current = null;
    // Shown paused at once; the exact audio length replaces the estimate when capture has ended.
    const paused: Recording = { ...rec, startedAt: null, offsetSec: rec.offsetSec + (Date.now() - rec.startedAt) / 1000 };
    recordingRef.current = paused;
    setRecording(paused);
    setSystemSilent(false);
    pausingRef.current = (async () => {
      try {
        const sec = await stopCapture();
        if (recordingRef.current === paused) {
          const exact = { ...paused, offsetSec: rec.offsetSec + sec };
          recordingRef.current = exact;
          setRecording(exact);
        }
      } catch (e) {
        setNotice(showStored(e instanceof Error ? e.message : String(e), t));
      } finally {
        await api.pauseMeeting(rec.id);
      }
    })().finally(() => (pausingRef.current = null));
  }

  /** Records on into the finished meeting on screen, after the audio it already has. */
  function continueMeeting() {
    const m = current;
    if (!m || (m.status !== "done" && m.status !== "error") || recordingRef.current || startingRef.current) return;
    cancelRef.current = false;
    startingRef.current = (async () => {
      setNotice(null);
      const [{ recording: options, live }, offsetSec] = await Promise.all([api.getSettings(), api.continueMeeting(m.id)]);
      if (offsetSec === null) return;
      const rec: Recording = { id: m.id, startedAt: Date.now(), offsetSec };
      recordingRef.current = rec;
      setRecording(rec);
      if (cancelRef.current) return endRecording(rec);
      const started = await capture(rec, options, { provider: live.provider, model: m.liveModel ?? live.model });
      // Capture failed (left paused) or was stopped while starting: the meeting ends as it was.
      if (!started && recordingRef.current?.id === m.id) await endRecording(recordingRef.current);
      else if (started && cancelRef.current) await endRecording(rec);
    })().finally(() => (startingRef.current = null));
  }

  /** Records on into the paused meeting with the session's model as it is now. */
  function resume() {
    if (recordingRef.current?.startedAt !== null || startingRef.current) return;
    cancelRef.current = false;
    startingRef.current = (async () => {
      await pausingRef.current;
      const paused = recordingRef.current;
      if (!paused || paused.startedAt !== null) return;
      const [{ recording: options, live }, m] = await Promise.all([api.getSettings(), api.getMeeting(paused.id)]);
      // Stopped while this was getting ready: nothing to resume.
      if (recordingRef.current !== paused || !(await api.resumeMeeting(paused.id, paused.offsetSec))) return;
      if (recordingRef.current !== paused) return; // stopped meanwhile; the stop ended that session
      const rec: Recording = { ...paused, startedAt: Date.now() };
      recordingRef.current = rec;
      setRecording(rec);
      if (await capture(rec, options, { provider: live.provider, model: m?.liveModel ?? live.model }))
        if (cancelRef.current) await endRecording(rec);
    })().finally(() => (startingRef.current = null));
  }

  /** Writes the summary on request; an existing (possibly edited) one is replaced only if confirmed. */
  async function summarizeMeeting(m: { id: number; summary?: string | null }) {
    if (summarizing !== null) return;
    if (m.summary?.trim() && !window.confirm(t("summary.replaceConfirm"))) return;
    if (!panes.layout.summary) panes.toggleSummary();
    setSummarizing(m.id);
    setSummaryError(null);
    const r = await api.summarize(m.id, summaryModel ?? undefined);
    setSummarizing(null);
    if (!r.ok) setSummaryError({ id: m.id, error: r.error });
  }

  /** A new, empty session in the folder on view, opened and ready to record. */
  async function newSession() {
    // A new session is not starred, so Starred could not show it.
    if (view === "starred") setView("all");
    const id = await api.createMeeting(typeof view === "number" ? view : null);
    await refreshList();
    setSelected(id);
    setRenaming(false);
    setGuide(false);
  }

  /** Ends the recording at once; a capture still starting is ended when it comes up (see begin). */
  async function stop() {
    if (pausingRef.current) await pausingRef.current;
    const rec = recordingRef.current;
    if (!rec || (!stopRef.current && rec.startedAt !== null)) {
      if (startingRef.current) cancelRef.current = true;
      return;
    }
    await endRecording(rec);
  }

  async function endRecording(rec: Recording) {
    recordingRef.current = null;
    setRecording(null);
    setSystemSilent(false);
    const stopCapture = stopRef.current;
    stopRef.current = null;
    let sec = 0;
    try {
      sec = (await stopCapture?.()) ?? 0;
    } catch (e) {
      setNotice(showStored(e instanceof Error ? e.message : String(e), t));
    } finally {
      // A meeting paused along the way is as long as its audio, not its wall-clock span.
      await api.stopMeeting(rec.id, rec.offsetSec ? rec.offsetSec + sec : undefined);
    }
  }

  const current = detail && detail.id === selected ? detail : null;
  const busy = (m: MeetingRow | null) => !!m && (m.status === "recording" || m.status === "processing" || preparingAudio(m.id));

  /** Every command, once: the menu bar, toolbar, context menus and ⌘K all run these. */
  const actions: Record<ActionId, PaletteAction> = {
    record: {
      label: recording ? t("action.stop") : t("action.record"),
      shortcut: "⇧⌘R",
      run: () => void (recordingRef.current || startingRef.current ? stop() : start()),
    },
    newSession: { label: t("action.newSession"), shortcut: "⌘N", run: newSession },
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
    find: {
      label: t("action.find"),
      shortcut: "⌘F",
      enabled: !!current,
      run: () => setFindN((n) => n + 1),
    },
    summarize: {
      label: t("action.summarize"),
      shortcut: "⇧⌘S",
      enabled: !!current && !busy(current) && current.utterances.length > 0 && summarizing === null,
      run: () => void (current && summarizeMeeting(current)),
    },
    exportMarkdown: {
      label: t("action.exportMarkdown"),
      shortcut: "⇧⌘E",
      enabled: !!current && !busy(current) && current.utterances.length > 0,
      run: () => void (current && api.exportMeeting(current.id, "md")),
    },
    exportText: {
      label: t("action.exportText"),
      enabled: !!current && !busy(current) && current.utterances.length > 0,
      run: () => void (current && api.exportMeeting(current.id, "txt")),
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
    toggleSummary: { label: t("action.toggleSummary"), shortcut: "⌥⌘S", run: panes.toggleSummary },
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
  const disabledActions = (Object.keys(actions) as ActionId[]).filter((id) => actions[id].enabled === false).join(",");
  // The menu bar mirrors what the screen offers: the same disabled commands, the Star/Unstar label.
  const starLabel = actions.star.label;
  useEffect(
    () => api.setMenuState(disabledActions ? (disabledActions.split(",") as ActionId[]) : [], { star: starLabel }),
    [disabledActions, starLabel],
  );

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
      // Only a finished meeting has a transcript to summarize or export.
      { id: "summarize", label: t("action.summarize"), enabled: m.status === "done" && m.hasTranscript && summarizing === null },
      {
        label: t("action.export"),
        submenu: [
          { id: "export:md", label: t("action.exportMarkdown"), enabled: m.status === "done" && m.hasTranscript },
          { id: "export:txt", label: t("action.exportText"), enabled: m.status === "done" && m.hasTranscript },
        ],
      },
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
    if (chosen === "summarize") return void summarizeMeeting(await api.getMeeting(m.id) ?? m);
    if (chosen === "export:md" || chosen === "export:txt") return void api.exportMeeting(m.id, chosen === "export:md" ? "md" : "txt");
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
          range={SIDEBAR_W}
          label={t("sidebar.resize")}
          onResize={panes.resizeSidebar}
          onReset={panes.resetSidebar}
        />
      )}
      <Splitter
        at={(sidebar ? panes.layout.sidebarW : 0) + panes.layout.listW}
        value={panes.layout.listW}
        range={LIST_W}
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
        renaming={renaming}
        sidebar={sidebar}
        summary={panes.layout.summary}
        onToggleSidebar={() => perform("toggleSidebar")}
        onToggleSummary={() => perform("toggleSummary")}
        onRename={(title) => {
          setRenaming(false);
          if (current && title !== null && title !== current.title) void run({ type: "rename", id: current.id, title });
        }}
        onStartRename={() => perform("rename")}
        onNewSession={() => perform("newSession")}
        onStar={() => perform("star")}
        onSummarize={() => perform("summarize")}
        onPalette={() => perform("palette")}
        canSummarize={actions.summarize.enabled !== false}
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
        {guide && StyleGuide ? (
          <Suspense fallback={null}><StyleGuide /></Suspense>
        ) : current ? (
          <MeetingView
            meeting={current}
            reveal={reveal?.id === current.id ? reveal : null}
            findN={findN}
            live={live?.id === current.id ? live.view : null}
            recording={recording?.id === current.id ? recording : null}
            systemSilent={systemSilent}
            summary={{
              onSave: saveSummary,
              open: panes.layout.summary,
              width: panes.layout.summaryW,
              onResize: panes.resizeSummary,
              onReset: panes.resetSummary,
              model: summaryModel,
              onModel: setSummaryModel,
              busy: summarizing === current.id,
              elsewhere: summarizing !== null && summarizing !== current.id,
              error: summaryError?.id === current.id ? summaryError.error : null,
              onSummarize: () => void summarizeMeeting(current),
              onExport: (format) => void api.exportMeeting(current.id, format),
            }}
            onRecord={() => perform("record")}
            onPause={() => (recording?.startedAt === null ? resume() : pause())}
            onContinue={continueMeeting}
            recordingElsewhere={!!recording && recording.id !== current.id}
          />
        ) : (
          <div className="placeholder">
            {/* An empty Starred or folder says how to fill it; recording does not put anything there. */}
            <strong>
              {meetings.length ? t("placeholder.pick")
                : view === "starred" ? t("placeholder.emptyStarred")
                : typeof view === "number" ? t("placeholder.emptyFolder")
                : t("placeholder.empty")}
            </strong>
            <span>
              {!meetings.length && view === "starred" ? t("placeholder.emptyStarredHint")
                : !meetings.length && typeof view === "number" ? t("placeholder.emptyFolderHint")
                : t("placeholder.hint")}
            </span>
          </div>
        )}
      </main>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        actions={(Object.keys(actions) as ActionId[])
          .filter((id) => !["palette", "undo", "redo", "styleGuide"].includes(id))
          .map((id) => ({ ...actions[id], id }))}
        onPick={(id, sec) => {
          setView("all");
          select(id);
          setReveal(sec === undefined ? null : { id, sec, n: Date.now() });
        }}
      />
    </div>
  );
}
