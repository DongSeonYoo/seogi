import { contextBridge, ipcRenderer } from "electron";
import type { Api, LiveView } from "../shared/types";

const api: Api = {
  listMeetings: (q) => ipcRenderer.invoke("listMeetings", q),
  getMeeting: (id) => ipcRenderer.invoke("getMeeting", id),
  startMeeting: () => ipcRenderer.invoke("startMeeting"),
  sendChunk: (chunk) => ipcRenderer.send("sendChunk", chunk),
  sendLiveAudio: (meetingId, track, pcm) => ipcRenderer.send("liveAudio", meetingId, track, pcm),
  stopMeeting: (id) => ipcRenderer.invoke("stopMeeting", id),
  resummarize: (id) => ipcRenderer.invoke("resummarize", id),
  markOpened: (id) => ipcRenderer.invoke("markOpened", id),
  audioFor: (meetingId, track, startSec) => ipcRenderer.invoke("audioFor", meetingId, track, startSec),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  patchSettings: (patch) => ipcRenderer.invoke("patchSettings", patch),
  setKey: (name, value) => ipcRenderer.invoke("setKey", name, value),
  testConnection: (role) => ipcRenderer.invoke("testConnection", role),
  storageInfo: () => ipcRenderer.invoke("storageInfo"),
  openDataFolder: () => ipcRenderer.invoke("openDataFolder"),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  onMeetingChanged(listener) {
    const handler = (_e: unknown, id: number) => listener(id);
    ipcRenderer.on("meeting-changed", handler);
    return () => ipcRenderer.off("meeting-changed", handler);
  },
  onLive(listener) {
    const handler = (_e: unknown, id: number, view: LiveView) => listener(id, view);
    ipcRenderer.on("live", handler);
    return () => ipcRenderer.off("live", handler);
  },
};

contextBridge.exposeInMainWorld("api", api);
