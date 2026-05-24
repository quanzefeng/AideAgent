import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("goodAgent", {
  test: "hello",
  version: process.versions.electron,
  respondPermission: (id, allow) => ipcRenderer.invoke("permission:respond", { id, allow }),
  onPermissionRequest: (cb) => ipcRenderer.on("permission:request", (_event, d) => cb(d)),
  submitQuery: (prompt, apiKey, apiUrl, model, apiFormat, files) => ipcRenderer.invoke("query:submit", { prompt, apiKey, apiUrl, model, apiFormat, files }),
  abortQuery: () => ipcRenderer.invoke("query:abort"),
  resetSession: () => ipcRenderer.invoke("session:reset"),
  onStreamStart: (cb) => ipcRenderer.on("stream:start", () => cb()),
  onStreamChunk: (cb) => ipcRenderer.on("stream:chunk", (_event, d) => cb(d)),
  onStreamReasoning: (cb) => ipcRenderer.on("stream:reasoning", (_event, d) => cb(d)),
  onStreamDone: (cb) => ipcRenderer.on("stream:done", () => cb()),
  onStreamError: (cb) => ipcRenderer.on("stream:error", (_event, d) => cb(d)),
  onToolStart: (cb) => ipcRenderer.on("tool:start", (_event, d) => cb(d)),
  onToolResult: (cb) => ipcRenderer.on("tool:result", (_event, d) => cb(d)),
  onSessionUpdate: (cb) => ipcRenderer.on("session:update", (_event, d) => cb(d)),
});