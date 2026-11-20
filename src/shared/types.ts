import type { Locale } from "./i18n";

export type Track = "mic" | "system";

/** `new`: a session that has not been recorded yet. */
export type MeetingStatus = "new" | "recording" | "processing" | "done" | "error";

export type Summary = {
  title: string;
  overview: string;
  decisions: string[];
  actionItems: { owner: string; task: string; due: string }[];
  topics: { title: string; points: string[] }[];
};

export type MeetingRow = {
  id: number;
  title: string;
  startedAt: string;
  status: MeetingStatus;
  unread: boolean;
  folderId: number | null;
  starred: boolean;
  /** Recording length; for meetings before it was stored, the last utterance's start. */
  durationSec: number;
  /** At least one line was transcribed: something to summarize or export. */
  hasTranscript: boolean;
  /** The summary overview, for the list's second line. */
  preview: string | null;
};

/** What the meeting list shows: a smart collection or a folder id. */
export type LibraryView = "all" | "starred" | number;
export type LibraryCounts = { all: number; starred: number; recording: boolean };
export type Folder = { id: number; name: string; count: number };
export type Library = { counts: LibraryCounts; folders: Folder[] };

/** Undoable library changes (⌘Z). */
export type LibraryOp =
  | { type: "rename"; id: number; title: string }
  | { type: "move"; ids: number[]; folderId: number | null }
  | { type: "star"; ids: number[]; starred: boolean }
  | { type: "delete"; ids: number[] }
  | { type: "createFolder"; name: string }
  | { type: "renameFolder"; id: number; name: string }
  | { type: "deleteFolder"; id: number };
export type LibraryResult = { ok: true; id?: number } | { ok: false; error: string };

/** Commands shared by the menu bar, toolbar, context menus and ⌘K. */
export type ActionId =
  | "record"
  | "newSession"
  | "newFolder"
  | "undo"
  | "redo"
  | "palette"
  | "rename"
  | "star"
  | "summarize"
  | "exportMarkdown"
  | "exportText"
  | "delete"
  | "toggleSidebar"
  | "toggleSummary"
  | "settings"
  | "styleGuide";

/** A native context menu item; `id` comes back when it is chosen. */
export type MenuSpec =
  | { id: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string }
  | { label: string; submenu: MenuSpec[] }
  | { type: "separator" };

/** Where an utterance's audio lives: a chunk file URL and the offset into it. */
/** `chunkStartSec`: where that file starts in the meeting, so playback can carry on into the next one. */
export type AudioRef = { url: string; offsetSec: number; chunkStartSec: number };

/** `speaker`: 1, 2, … when diarization told the voices in a track apart (imported files). */
export type SpeakerNames = Record<string, string>;

export type Utterance = {
  id: number; track: Track; startSec: number; text: string; speaker: number | null;
  /** Shown as one line (joinSplitSentences): the pieces after this one, which an edit replaces. */
  joined?: number[];
};

export type MeetingDetail = MeetingRow & {
  /** Markdown, written by Summarize and edited by the user. */
  summary: string | null;
  error: string | null;
  /** This session's live model; null uses the one in Settings. */
  liveModel: string | null;
  /** This session's glossary; empty uses the shared one in Settings. */
  glossary: string;
  /** Names given to this meeting's voices, by speakerKey ("mic", "system", "1", …). */
  speakerNames: SpeakerNames;
  utterances: Utterance[];
};

/** Live caption text still being spoken; it becomes an utterance when its segment finishes. */
export type LiveLine = { key: string; track: Track; startSec: number; text: string };
/** A live caption event from any provider: text still being spoken, or a finished segment. */
export type LiveEvent =
  /** Text appended to segment `id`; `endSec`, when known, is where this piece of audio ends. */
  | { type: "delta"; id: string; text: string; atSec: number; endSec?: number }
  | { type: "segment"; id: string; text: string; startSec: number; endSec: number }
  /** The stream lost its connection and is opening a new one; speech in between has no captions. */
  | { type: "reconnect" }
  | { type: "error"; message: string };

/**
 * GPT-Live, the conversational model Codex's /voice runs on, used here only for its transcript of
 * what people say; its spoken replies are discarded. Runs over WebRTC in the renderer (qgrid only).
 */
export const GPT_LIVE_MODEL = "openai/gpt-live-1";
/** How long a stopped GPT-Live session keeps listening for the transcript of the last words. */
export const GPT_LIVE_TAIL_MS = 2000;

/** Live caption traffic for the settings test uses this id; meetings start at 1. */
export const LIVE_TEST_ID = 0;
export type LiveView = { lines: LiveLine[]; error: string | null };

export type Chunk = { meetingId: number; track: Track; startSec: number } & ({ ogg: Uint8Array } | { pcm: Int16Array });
export const IMPORT_CHUNK_SEC = 30;

export type LiveProvider = "qgrid" | "openai";
export type SummaryProvider = "qgrid" | "openai" | "anthropic";

export const DEFAULT_MODELS = {
  live: { openai: "gpt-live-transcribe", qgrid: "openai/gpt-live-transcribe" },
  summary: { openai: "gpt-6-luna", anthropic: "claude-sonnet-5-5", qgrid: "openai/gpt-6-luna" },
} as const;

export type ThemeMode = "system" | "light" | "dark";
export type KeyName = "openai" | "anthropic";
export type ConnectionRole = "summary";
export type ModelRole = "live" | "summary";

/** One choice in a model picker; `detail` is a short price and capability line. */
export type ModelOption = { id: string; available: boolean; detail?: string; efforts?: string[] };
export type ModelList = { ok: true; models: ModelOption[] } | { ok: false; error: string };

export type Settings = {
  /** Language of the app's menus and screens. */
  locale: Locale;
  theme: ThemeMode;
  qgridUrl: string;
  /** Live captions: what the meeting record is written from. */
  live: { provider: LiveProvider; model: string };
  /** `effort` is a reasoning level the model lists (qgrid only); unset uses the model default. */
  summary: { provider: SummaryProvider; model: string; effort?: string };
  language: string;
  /** Names and terms, comma-separated; steers spelling in transcription and summary. */
  glossary: string;
  recording: {
    /** "" follows the macOS default input. */
    micDeviceId: string;
    /** Off for in-person meetings: record the microphone only. */
    systemAudio: boolean;
  };
  /** Whether a key is stored; key values never leave the main process. */
  hasKey: { openai: boolean; anthropic: boolean };
};

export type StoredSettings = Omit<Settings, "hasKey">;

/** Where an import is: fetching the speaker models once, finding speakers, then transcribing turns. */
export type ImportProgress = { phase: "audio" | "recording" | "models" | "speakers" } | { phase: "transcribe"; done: number; total: number };

export type ConnectionResult = { ok: true; ms: number } | { ok: false; error: string };

export type StorageInfo = { path: string; bytes: number; audio: number; database: number; models: number; meetings: number };

export type AppInfo = { version: string; electron: string; platform: string };

export type Api = {
  /** A query (even empty) searches for up to 50 palette results. Omit it to list the whole view. */
  listMeetings(view: LibraryView, query?: string): Promise<MeetingRow[]>;
  library(): Promise<Library>;
  perform(op: LibraryOp): Promise<LibraryResult>;
  /** App-level undo; resolves to the label of what changed, or null. */
  undo(): Promise<string | null>;
  redo(): Promise<string | null>;
  /** Pops a native context menu at the pointer; resolves to the chosen item id. */
  showMenu(items: MenuSpec[]): Promise<string | null>;
  /** The commands disabled on screen right now, so the menu bar greys out the same ones. */
  setMenuState(disabled: ActionId[], labels: Partial<Record<ActionId, string>>): void;
  /** Commands from the app menu bar, by action id. */
  onMenuAction(listener: (id: ActionId) => void): () => void;
  openSettings(): void;
  /** macOS accent colour as #rrggbb, and its changes. */
  accentColor(): Promise<string>;
  onAccentColor(listener: (hex: string) => void): () => void;
  getMeeting(id: number): Promise<MeetingDetail | null>;
  /** Starts a meeting in `folderId` (the folder on screen), or unfiled. */
  /** A new, unrecorded session; resolves to its id. */
  createMeeting(folderId?: number | null): Promise<number>;
  /** Starts recording a `new` session; false when it is not one. */
  startMeeting(id: number): Promise<boolean>;
  /** Capture never started: the session goes back to `new`, ready for another try. */
  abortMeeting(id: number): Promise<void>;
  /**
   * Imports an audio file (16 kHz mono) into a `new` session: speakers are told apart, then each
   * speaker turn is transcribed. Resolves once it has started; progress comes via onImportProgress.
   */
  /** `language`: the file's spoken language, or "auto" to let the transcriber detect it. */
  /** Transcribes a track's opening audio (16 kHz mono from 0 s) that reached no live session. */
  transcribeOpening(id: number, track: Track, pcm: Int16Array, token?: number): Promise<void>;
  importFile(id: number, pcm: Int16Array, language: string, ogg: (Uint8Array | null)[]): Promise<boolean>;
  /** null: the import of `id` ended. */
  onImportProgress(listener: (id: number, progress: ImportProgress | null) => void): () => void;
  /** The glossary of a meeting being recorded with GPT-Live changed. */
  onLiveGlossary(listener: (id: number, glossary: string) => void): () => void;
  /** A session's own live model (null: Settings) or glossary (empty: the shared one). */
  setSessionOptions(id: number, options: { liveModel?: string | null; glossary?: string }): Promise<void>;
  /**
   * Names the voice of a line. While the meeting records, an other-side line is that voice alone
   * and later lines that sound like it take the name; otherwise the whole voice is renamed ("" goes
   * back to the default name).
   */
  nameVoice(meetingId: number, utteranceId: number, name: string): Promise<void>;
  /** Holds a line still being spoken while the user corrects it, so it does not move on. */
  holdDraft(meetingId: number, key: string): void;
  releaseDraft(meetingId: number, key: string): void;
  /** Corrects word `index` of a line still being spoken. */
  fixDraft(meetingId: number, key: string, index: number, from: string, to: string): Promise<void>;
  /** The other side's audio while GPT-Live captions it, so its voices can be named live. */
  sendVoiceAudio(meetingId: number, pcm: Int16Array): void;
  /** A transcript line as corrected by hand; `joined` pieces shown with it are removed. */
  editUtterance(meetingId: number, id: number, text: string, joined?: number[]): Promise<void>;
  sendChunk(chunk: Chunk): void;
  /** About 100 ms of 16 kHz PCM16 for the live captions, every frame from the track's start. */
  sendLiveAudio(meetingId: number, track: Track, pcm: Int16Array, token?: number): void;
  /** Caption events the renderer produced itself (GPT-Live over WebRTC). */
  sendLiveEvent(meetingId: number, track: Track, event: LiveEvent, token?: number): void;
  /** Exchanges a WebRTC offer for a GPT-Live session through qgrid; resolves to the answer. */
  /** Session options for `meetingId` (glossary) shape the GPT-Live instructions. */
  liveCall(sdp: string, meetingId: number, token?: number): Promise<{ ok: true; sdp: string } | { ok: false; error: string }>;
  /** `recordedSec`: the audio length, given when the meeting was paused along the way. */
  stopMeeting(id: number, recordedSec?: number): Promise<void>;
  /** Ends the capture's caption session; the meeting stays recording. */
  pauseMeeting(id: number): Promise<void>;
  /** Records on into a finished meeting; resolves to where its audio continues, or null. */
  continueMeeting(id: number): Promise<number | null>;
  /** A new caption session (the session's model now) whose times start at `offsetSec`. */
  resumeMeeting(id: number, offsetSec: number): Promise<boolean>;
  /** Live captions for the settings test under LIVE_TEST_ID; nothing is saved. */
  /** `model` overrides the saved live model. */
  startLiveTest(model?: Settings["live"]): Promise<number>;
  stopLiveTest(token: number): Promise<void>;
  liveView(id: number): Promise<LiveView | null>;
  /** Writes the summary with `model` (of the summary provider) or the one in Settings. */
  summarize(id: number, model?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  setSummaryText(id: number, markdown: string): Promise<void>;
  /** Save dialog, then the meeting as Markdown or plain text; false when cancelled. */
  exportMeeting(id: number, format: "md" | "txt"): Promise<boolean>;
  markOpened(id: number): Promise<void>;
  audioFor(meetingId: number, track: Track, startSec: number): Promise<AudioRef | null>;
  /** A track's saved chunks (Ogg Opus or WAV bytes) in time order. */
  audioChunks(meetingId: number, track: Track): Promise<{ bytes: Uint8Array; startSec: number }[]>;
  /** Tells the recorded other side's voices apart (16 kHz mono from 0 s) and numbers its lines. */
  separateSpeakers(meetingId: number, samples: Float32Array): Promise<void>;
  getSettings(): Promise<Settings>;
  /** Applies immediately; nested groups (live, summary, recording) are replaced whole. */
  patchSettings(patch: Partial<StoredSettings>): Promise<Settings>;
  /** "" deletes the key. */
  setKey(name: KeyName, value: string): Promise<Settings>;
  testConnection(role: ConnectionRole): Promise<ConnectionResult>;
  /** The models `provider` offers for `role`, from qgrid's catalog or the provider's model list. */
  listModels(role: ModelRole, provider: string): Promise<ModelList>;
  storageInfo(): Promise<StorageInfo>;
  openDataFolder(): Promise<void>;
  appInfo(): Promise<AppInfo>;
  onMeetingChanged(listener: (id: number) => void): () => void;
  onUtterancesAdded(listener: (meetingId: number, rows: Utterance[]) => void): () => void;
  /** The UI language changed in settings. */
  onLocale(listener: (locale: Locale) => void): () => void;
  onLive(listener: (meetingId: number, view: LiveView, token?: number) => void): () => void;
};
