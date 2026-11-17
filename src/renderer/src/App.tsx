import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingDetail, MeetingRow } from "../../shared/types";
import { CommandPalette } from "./CommandPalette";
import { MeetingView } from "./MeetingView";
import { startRecording } from "./recorder";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar, type Recording } from "./Sidebar";
import { StyleGuide } from "./StyleGuide";
import { Kbd } from "./ui";

const api = window.api;

export function App() {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [guide, setGuide] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);

  const refreshList = useCallback(() => api.listMeetings("").then(setMeetings), []);
  const refreshDetail = useCallback(
    () => (selected === null ? setDetail(null) : api.getMeeting(selected).then(setDetail)),
    [selected],
  );

  useEffect(() => void refreshList(), [refreshList]);
  useEffect(() => void refreshDetail(), [refreshDetail]);
  useEffect(
    () =>
      api.onMeetingChanged((id) => {
        void refreshList();
        if (id === selected) void refreshDetail();
      }),
    [refreshList, refreshDetail, selected],
  );

  // Opening a finished meeting clears its unread pill.
  useEffect(() => {
    if (detail?.status === "done" && meetings.find((m) => m.id === detail.id)?.unread)
      void api.markOpened(detail.id).then(refreshList);
  }, [detail, meetings, refreshList]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === "k") setPalette((v) => !v);
      else if (e.key === ",") setSettings(true);
      else if (e.key === "d" && e.shiftKey && import.meta.env.DEV) setGuide((v) => !v);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function start() {
    setError(null);
    const id = await api.startMeeting();
    try {
      stopRef.current = await startRecording((track, startSec, pcm) =>
        api.sendChunk({ meetingId: id, track, startSec, pcm }),
      );
    } catch (e) {
      await api.stopMeeting(id);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setRecording({ id, startedAt: Date.now() });
    setSelected(id);
    setGuide(false);
    setPanelOpen(false); // the transcript gets the width while recording
    void refreshList();
  }

  async function stop() {
    if (!recording) return;
    const { id } = recording;
    setRecording(null);
    setPanelOpen(true);
    await stopRef.current?.();
    stopRef.current = null;
    await api.stopMeeting(id);
  }

  return (
    <div className="app">
      <Sidebar
        meetings={meetings}
        selected={guide ? null : selected}
        recording={recording}
        pendingChunks={recording && detail?.id === recording.id ? detail.pendingChunks : 0}
        error={error}
        onSelect={(id) => {
          setSelected(id);
          setGuide(false);
        }}
        onSearch={() => setPalette(true)}
        onStart={start}
        onStop={stop}
        onSettings={() => setSettings(true)}
      />
      <main className="main">
        {guide ? (
          <StyleGuide />
        ) : detail ? (
          <MeetingView
            meeting={detail}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((v) => !v)}
            onResummarize={() => api.resummarize(detail.id)}
          />
        ) : (
          <>
            <header className="main__header drag" />
            <div className="placeholder">
              <strong>회의를 고르거나 새로 녹음하세요.</strong>
              <span>
                <Kbd>⌘K</Kbd> 로 지난 회의를 찾을 수 있습니다.
              </span>
            </div>
          </>
        )}
      </main>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onPick={(id) => {
          setSelected(id);
          setGuide(false);
        }}
      />
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
