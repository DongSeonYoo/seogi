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
  onMenuAction: (listener) => on("menu-action", listener),
  openSettings: () => ipcRenderer.send("openSettings"),
  accentColor: () => ipcRenderer.invoke("accentColor"),
  onAccentColor: (listener) => on("accent-color", listener),
  getMeeting: (id) => ipcRenderer.invoke("getMeeting", id),
  startMeeting: (folderId) => ipcRenderer.invoke("startMeeting", folderId),
  sendChunk: (chunk) => ipcRenderer.send("sendChunk", chunk),
  sendLiveAudio: (meetingId, track, pcm) => ipcRenderer.send("liveAudio", meetingId, track, pcm),
  sendLiveEvent: (meetingId, track, event) => ipcRenderer.send("liveEvent", meetingId, track, event),
  liveCall: (sdp) => ipcRenderer.invoke("liveCall", sdp),
  startLiveTest: () => ipcRenderer.invoke("startLiveTest"),
  stopLiveTest: () => ipcRenderer.invoke("stopLiveTest"),
  stopMeeting: (id) => ipcRenderer.invoke("stopMeeting", id),
  resummarize: (id) => ipcRenderer.invoke("resummarize", id),
  markOpened: (id) => ipcRenderer.invoke("markOpened", id),
  audioFor: (meetingId, track, startSec) => ipcRenderer.invoke("audioFor", meetingId, track, startSec),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  patchSettings: (patch) => ipcRenderer.invoke("patchSettings", patch),
  setKey: (name, value) => ipcRenderer.invoke("setKey", name, value),
  testConnection: (role) => ipcRenderer.invoke("testConnection", role),
  listModels: (role, provider) => ipcRenderer.invoke("listModels", role, provider),
  storageInfo: () => ipcRenderer.invoke("storageInfo"),
  openDataFolder: () => ipcRenderer.invoke("openDataFolder"),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  onMeetingChanged: (listener) => on("meeting-changed", listener),
  onLive: (listener) => on("live", listener),
  onLocale: (listener) => on("locale", listener),
};

contextBridge.exposeInMainWorld("api", api);
