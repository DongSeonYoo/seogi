import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/types";

/** Subscribes to a main-process event; returns the unsubscribe function. */
function on<A extends unknown[]>(channel: string, listener: (...args: A) => void) {
  const handler = (_e: unknown, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
}

const api: Api = {
  listMeetings: (view, query) => ipcRenderer.invoke("listMeetings", view, query),
  library: () => ipcRenderer.invoke("library"),
  perform: (op) => ipcRenderer.invoke("perform", op),
  undo: () => ipcRenderer.invoke("undo"),
  redo: () => ipcRenderer.invoke("redo"),
  showMenu: (items) => ipcRenderer.invoke("showMenu", items),
  setMenuState: (disabled, labels) => ipcRenderer.send("menuState", disabled, labels),
  onMenuAction: (listener) => on("menu-action", listener),
  openSettings: () => ipcRenderer.send("openSettings"),
  accentColor: () => ipcRenderer.invoke("accentColor"),
  onAccentColor: (listener) => on("accent-color", listener),
  getMeeting: (id) => ipcRenderer.invoke("getMeeting", id),
  createMeeting: (folderId) => ipcRenderer.invoke("createMeeting", folderId),
  startMeeting: (id) => ipcRenderer.invoke("startMeeting", id),
  abortMeeting: (id) => ipcRenderer.invoke("abortMeeting", id),
  transcribeOpening: (id, track, pcm, token) => ipcRenderer.invoke("transcribeOpening", id, track, pcm, token),
  importFile: (id, pcm, language, ogg) => ipcRenderer.invoke("importFile", id, pcm, language, ogg),
  onImportProgress: (listener) => on("import-progress", listener),
  onLiveGlossary: (listener) => on("live-glossary", listener),
  setSessionOptions: (id, options) => ipcRenderer.invoke("setSessionOptions", id, options),
  sendChunk: (chunk) => ipcRenderer.send("sendChunk", chunk),
  sendLiveAudio: (meetingId, track, pcm, token) => ipcRenderer.send("liveAudio", meetingId, track, pcm, token),
  sendLiveEvent: (meetingId, track, event, token) => ipcRenderer.send("liveEvent", meetingId, track, event, token),
  liveCall: (sdp, meetingId, token) => ipcRenderer.invoke("liveCall", sdp, meetingId, token),
  startLiveTest: (model) => ipcRenderer.invoke("startLiveTest", model),
  stopLiveTest: (token) => ipcRenderer.invoke("stopLiveTest", token),
  liveView: (id) => ipcRenderer.invoke("liveView", id),
  stopMeeting: (id, recordedSec) => ipcRenderer.invoke("stopMeeting", id, recordedSec),
  pauseMeeting: (id) => ipcRenderer.invoke("pauseMeeting", id),
  resumeMeeting: (id, offsetSec) => ipcRenderer.invoke("resumeMeeting", id, offsetSec),
  summarize: (id, model) => ipcRenderer.invoke("summarize", id, model),
  setSummaryText: (id, markdown) => ipcRenderer.invoke("setSummaryText", id, markdown),
  exportMeeting: (id, format) => ipcRenderer.invoke("exportMeeting", id, format),
  markOpened: (id) => ipcRenderer.invoke("markOpened", id),
  audioFor: (meetingId, track, startSec) => ipcRenderer.invoke("audioFor", meetingId, track, startSec),
  setSpeakerName: (meetingId, key, name) => ipcRenderer.invoke("setSpeakerName", meetingId, key, name),
  editUtterance: (meetingId, id, text, joined) => ipcRenderer.invoke("editUtterance", meetingId, id, text, joined),
  audioChunks: (meetingId, track) => ipcRenderer.invoke("audioChunks", meetingId, track),
  separateSpeakers: (meetingId, samples) => ipcRenderer.invoke("separateSpeakers", meetingId, samples),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  patchSettings: (patch) => ipcRenderer.invoke("patchSettings", patch),
  setKey: (name, value) => ipcRenderer.invoke("setKey", name, value),
  testConnection: (role) => ipcRenderer.invoke("testConnection", role),
  listModels: (role, provider) => ipcRenderer.invoke("listModels", role, provider),
  storageInfo: () => ipcRenderer.invoke("storageInfo"),
  openDataFolder: () => ipcRenderer.invoke("openDataFolder"),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  onMeetingChanged: (listener) => on("meeting-changed", listener),
  onUtterancesAdded: (listener) => on("utterances-added", listener),
  onLive: (listener) => on("live", listener),
  onLocale: (listener) => on("locale", listener),
};

contextBridge.exposeInMainWorld("api", api);
