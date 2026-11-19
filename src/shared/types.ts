export type Track = "mic" | "system";

export type MeetingStatus = "recording" | "processing" | "done" | "error";

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
};

/** Where an utterance's audio lives: a chunk file URL and the offset into it. */
export type AudioRef = { url: string; offsetSec: number };

export type Utterance = { id: number; track: Track; startSec: number; text: string };

export type MeetingDetail = MeetingRow & {
  summary: Summary | null;
  error: string | null;
  pendingChunks: number;
  utterances: Utterance[];
};

/** A live caption draft, shown while recording until the chunk transcript replaces it. */
export type LiveLine = { key: string; track: Track; startSec: number; text: string };
/** Live caption traffic for the settings test uses this id; meetings start at 1. */
export const LIVE_TEST_ID = 0;
export type LiveView = { lines: LiveLine[]; error: string | null };

export type Chunk = { meetingId: number; track: Track; startSec: number; pcm: Int16Array };

export type TranscriptionProvider = "qgrid" | "openai";
export type LiveProvider = "qgrid" | "openai";
export type SummaryProvider = "qgrid" | "openai" | "anthropic";

export const DEFAULT_MODELS = {
  transcription: { openai: "gpt-4o-transcribe", qgrid: "openai/gpt-transcribe" },
  live: { openai: "gpt-live-transcribe", qgrid: "openai/gpt-live-transcribe" },
  summary: { openai: "gpt-6-luna", anthropic: "claude-sonnet-5-5", qgrid: "openai/gpt-6-luna" },
} as const;

export type ThemeMode = "system" | "light" | "dark";
export type KeyName = "openai" | "anthropic";
export type ConnectionRole = "transcription" | "summary";
export type ModelRole = "transcription" | "live" | "summary";

/** One choice in a model picker; `detail` is a short price and capability line. */
export type ModelOption = { id: string; available: boolean; detail?: string; efforts?: string[] };
export type ModelList = { ok: true; models: ModelOption[] } | { ok: false; error: string };

export type Settings = {
  theme: ThemeMode;
  qgridUrl: string;
  transcription: { provider: TranscriptionProvider; model: string };
  /** Live caption drafts while recording; replaced by the transcription model's chunks. */
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

export type ConnectionResult = { ok: true; ms: number } | { ok: false; error: string };

export type StorageInfo = { path: string; bytes: number; meetings: number };

export type AppInfo = { version: string; electron: string; platform: string };

export type Api = {
  listMeetings(query: string): Promise<MeetingRow[]>;
  getMeeting(id: number): Promise<MeetingDetail | null>;
  startMeeting(): Promise<number>;
  sendChunk(chunk: Chunk): void;
  /** About 100 ms of 16 kHz PCM16 for the live captions, every frame from the track's start. */
  sendLiveAudio(meetingId: number, track: Track, pcm: Int16Array): void;
  stopMeeting(id: number): Promise<void>;
  /** Live captions for the settings test under LIVE_TEST_ID; nothing is saved. */
  startLiveTest(): Promise<void>;
  stopLiveTest(): Promise<void>;
  resummarize(id: number): Promise<void>;
  markOpened(id: number): Promise<void>;
  audioFor(meetingId: number, track: Track, startSec: number): Promise<AudioRef | null>;
  getSettings(): Promise<Settings>;
  /** Applies immediately; nested groups (transcription, summary, recording) are replaced whole. */
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
  onLive(listener: (meetingId: number, view: LiveView) => void): () => void;
};
