const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("goodAgent", {
  test: "hello",
  version: process.versions.electron,
  respondPermission: (id, allow) => ipcRenderer.invoke("permission:respond", { id, allow }),
  onPermissionRequest: (cb) => ipcRenderer.on("permission:request", (_event, d) => cb(d)),
  submitQuery: (prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning) => ipcRenderer.invoke("query:submit", { prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning }),
  abortQuery: () => ipcRenderer.invoke("query:abort"),
  resetSession: () => ipcRenderer.invoke("session:reset"),
  listSessions: () => ipcRenderer.invoke("session:list"),
  loadSession: (id) => ipcRenderer.invoke("session:load", id),
  deleteSession: (id) => ipcRenderer.invoke("session:delete", id),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  loadSkill: (name) => ipcRenderer.invoke("skills:load", name),
  onStreamStart: (cb) => ipcRenderer.on("stream:start", () => cb()),
  onStreamChunk: (cb) => ipcRenderer.on("stream:chunk", (_event, d) => cb(d)),
  onStreamReasoning: (cb) => ipcRenderer.on("stream:reasoning", (_event, d) => cb(d)),
  onStreamDone: (cb) => ipcRenderer.on("stream:done", () => cb()),
  onStreamError: (cb) => ipcRenderer.on("stream:error", (_event, d) => cb(d)),
  onToolStart: (cb) => ipcRenderer.on("tool:start", (_event, d) => cb(d)),
  onToolResult: (cb) => ipcRenderer.on("tool:result", (_event, d) => cb(d)),
  onSessionUpdate: (cb) => ipcRenderer.on("session:update", (_event, d) => cb(d)),
});
