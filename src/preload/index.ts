import { contextBridge, ipcRenderer } from "electron"

import { CHANNELS, type AiDelta, type IpcApi } from "../shared/ipc"

const api: IpcApi = {
  repoLoad: () => ipcRenderer.invoke(CHANNELS.repoLoad),
  diffRead: (path: string) => ipcRenderer.invoke(CHANNELS.diffRead, path),
  aiGenerate: (paths: string[]) => ipcRenderer.invoke(CHANNELS.aiGenerate, paths),
  onAiDelta: (cb) => {
    ipcRenderer.on(CHANNELS.aiDelta, (_event, delta) => cb(delta as AiDelta))
  },
  aiCancel: () => ipcRenderer.invoke(CHANNELS.aiCancel),
  commit: (input) => ipcRenderer.invoke(CHANNELS.commit, input),
  configGet: () => ipcRenderer.invoke(CHANNELS.configGet),
  configSave: (partial) => ipcRenderer.invoke(CHANNELS.configSave, partial),
  themesList: () => ipcRenderer.invoke(CHANNELS.themesList),
  winmergeOpen: (path: string) => ipcRenderer.invoke(CHANNELS.winmergeOpen, path),
}

contextBridge.exposeInMainWorld("api", api)
