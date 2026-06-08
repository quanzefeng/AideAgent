// ── IPC Handlers — All ipcMain.handle registrations ──────────

import { ipcMain, BrowserWindow, dialog, safeStorage } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import sessionDb from "../session-db.mjs";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";
import * as kb from "../knowledge-store.mjs";
import mcpManager from "../mcp-manager.mjs";
import { agentLoop } from "./agent-loop.mjs";
import { scanSkills } from "./skill-scanner.mjs";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  taskStore, setTodoList,
  setEpisodicSearched,
  _subAgentCtrls as _subAgentCtrlsRaw, _surfacedMemories,
  getWorkspace, setWorkspace,
  getPlanMode, setPlanMode,
  pendingPerms, _askResolvers,
  setLastApiConfig,
  sendToRenderer,
} from "./state.mjs";
import { loadPromptProfiles, savePromptProfiles, DEFAULT_PROMPT } from "./system-prompt.mjs";
import { hasPersistedWorkspace } from "./workspace-config.mjs";

/** @type {Map<string, AbortController>} */
const _subAgentCtrls = _subAgentCtrlsRaw;

/** @param {Array<{role: string, content: string}>} history */
function getHistoryTitle(history) {
  const firstUser = history.find(m => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

/** @param {string} id @param {Array<{role: string, content: string}>} history @param {string} title */
async function saveSession(id, history, title) {
  try { await sessionDb.saveSession(id, history, title); } catch { /* ignored */ }
}

export function registerIpcHandlers() {
  ipcMain.handle("query:submit", async (event, { prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, planMode: pm, webSearchEnabled = true }) => {
    setPlanMode(!!pm);
    console.log("[plan-mode] query:submit planMode =", getPlanMode(), "pm =", pm);
    if (apiKey && apiUrl) setLastApiConfig({ apiKey, apiUrl, model, apiFormat, agentName });
    sendToRenderer("stream:start", {});
    try { await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName, kbEnabled, getPlanMode(), webSearchEnabled); }
    catch (/** @type {any} */ err) { sendToRenderer("stream:error", { message: err.message }); }
    sendToRenderer("stream:done", {});
  });

  ipcMain.handle("query:abort", () => {
    const abortCtrl = getAbortCtrl();
    if (abortCtrl) { abortCtrl.abort(); setAbortCtrl(null); }
    for (const ctrl of _subAgentCtrls.values()) { ctrl.abort(); }
    _subAgentCtrls.clear();
  });

  ipcMain.handle("session:reset", async () => {
    const sessionId = getSessionId();
    const history = getHistory();
    if (sessionId && history.length > 0) {
      const title = getHistoryTitle(history);
      await saveSession(sessionId, history, title);
    }
    setSessionId(null); setHistory([]);
    setEpisodicSearched(false);
    taskStore.clear();
    setTodoList([]);
    _surfacedMemories.clear();
    for (const ctrl of _subAgentCtrls.values()) { ctrl.abort(); }
    _subAgentCtrls.clear();
    sendToRenderer("task:clear", {});
  });

  ipcMain.handle("session:list", async () => {
    return await sessionDb.listSessions();
  });

  ipcMain.handle("session:load", async (_event, id, opts) => {
    const data = await sessionDb.loadSession(id);
    if (data) {
      if (!opts?.readOnly) {
        setSessionId(/** @type {string} */ (data.id));
        setHistory(/** @type {Array<{role: string, content: string}>} */ (data.history || []));
        sendToRenderer("session:update", { sessionId: data.id });
      }
      return { sessionId: data.id, title: data.title, history: /** @type {Array<{role: string, content: string}>} */ (data.history || []) };
    }
    return null;
  });

  ipcMain.handle("session:delete", async (_event, id) => {
    await sessionDb.deleteSession(id);
  });

  ipcMain.handle("session:delete-all", async () => {
    try {
      console.log("[session:delete-all] starting...");
      const result = sessionDb.deleteAllSessions();
      sessionDb.forceCheckpoint();
      console.log("[session:delete-all] result:", result, "checkpoint done");
      setSessionId(null); setHistory([]);
      return result;
    } catch (/** @type {any} */ e) {
      console.error("[session:delete-all] error:", e);
      return { error: e.message };
    }
  });

  ipcMain.handle("session:delete-message", async (_event, messageId) => {
    try { return sessionDb.deleteMessage(messageId); } catch (/** @type {any} */ e) { return { error: e.message }; }
  });

  ipcMain.handle("session:edit-message", async (_event, messageId, newContent) => {
    try { return sessionDb.editMessage(messageId, newContent); } catch (/** @type {any} */ e) { return { error: e.message }; }
  });

  ipcMain.handle("session:export-markdown", async (_event, id) => {
    try { return sessionDb.exportSession(id); } catch (/** @type {any} */ e) { return { error: e.message }; }
  });

  ipcMain.handle("session:search", async (_event, query, limit) => {
    try { return sessionDb.searchMessages(query, limit); } catch { return []; }
  });

  ipcMain.handle("session:last", async (_event, limit) => {
    try { return sessionDb.getLastSession(limit); } catch { return null; }
  });

  ipcMain.handle("session:status", async () => {
    try { return sessionDb.getStatus(); } catch { return { error: "unavailable" }; }
  });

  // ── Memory Store IPC ──────────────────────────────────────
  ipcMain.handle("memory:read-user", async () => memory.readUserMemory());
  ipcMain.handle("memory:write-user", async (_e, content) => {
    memory.writeUserMemory(content);
    memory.rebuildIndex();
    return { ok: true };
  });
  ipcMain.handle("memory:append-user", async (_e, content) => {
    memory.appendUserMemory(content);
    memory.rebuildIndex();
    return { ok: true };
  });
  ipcMain.handle("memory:read-project", async () => memory.readProjectMemory());
  ipcMain.handle("memory:write-project", async (_e, content) => {
    memory.writeProjectMemory(content);
    memory.rebuildIndex();
    return { ok: true };
  });
  ipcMain.handle("memory:append-project", async (_e, content) => {
    memory.appendProjectMemory(content);
    memory.rebuildIndex();
    return { ok: true };
  });
  ipcMain.handle("memory:search", async (_e, query) => memory.searchMemory(query || "", 10));
  ipcMain.handle("memory:check-dup", async (_e, type, text) => memory.checkDuplicate(type, text));
  ipcMain.handle("memory:index", async () => { memory.rebuildIndex(); return { ok: true }; });

  // ── Workspace IPC ────────────────────────────────────────
  ipcMain.handle("workspace:get", async () => getWorkspace());
  ipcMain.handle("workspace:needs-first-pick", async () => {
    // True when no workspace has been persisted yet (first launch,
    // or persisted path was deleted/moved). Renderer uses this to
    // decide whether to show the first-pick modal on startup.
    return { needs: !hasPersistedWorkspace() };
  });
  ipcMain.handle("workspace:set", async (_e, newPath) => {
    if (!newPath || typeof newPath !== "string") return { error: "invalid path" };
    try {
      const { statSync } = await import("node:fs");
      const st = statSync(newPath);
      if (!st.isDirectory()) return { error: "not a directory" };
    } catch { return { error: "path does not exist" }; }
    setWorkspace(newPath);
    return { ok: true, workspace: getWorkspace() };
  });
  ipcMain.handle("workspace:pick", async () => {
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择工作区间",
      defaultPath: getWorkspace(),
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    setWorkspace(result.filePaths[0]);
    return { ok: true, workspace: getWorkspace() };
  });

  // ── Multi-file memory API ────────────────────────────────
  ipcMain.handle("memory:list-all", async () => {
    try { return memory.listMemories(); } catch { return []; }
  });
  ipcMain.handle("memory:read-one", async (_e, filename) => {
    return memory.readMemory(filename);
  });
  ipcMain.handle("memory:create", async (_e, { name, description, type, content }) => {
    return memory.createMemory(name, description, type, content);
  });
  ipcMain.handle("memory:update", async (_e, { filename, content, name, description, type }) => {
    return memory.updateMemory(filename, content, name, description, type);
  });
  ipcMain.handle("memory:delete", async (_e, filename) => {
    return memory.deleteMemory(filename);
  });

  // ── Skills IPC ──────────────────────────────────────────
  ipcMain.handle("skills:list-all", async () => skills.listSkills());
  ipcMain.handle("skills:load-one", async (_e, name) => skills.loadSkill(name));
  ipcMain.handle("skills:set-status", async (_e, name, status) => skills.setSkillStatus(name, status));
  ipcMain.handle("skills:delete", async (_e, name) => skills.deleteSkill(name));
  ipcMain.handle("skills:detect-patterns", async () => skills.detectPatterns(/** @type {any} */ (sessionDb)));
  ipcMain.handle("skills:curator-run", async () => skills.runCurator());
  ipcMain.handle("skills:curator-status", async () => skills.getCuratorStatus());
  ipcMain.handle("skills:curator-config", async (_e, config) => skills.setCuratorConfig(config || {}));
  ipcMain.handle("skills:health", async (_e, name) => skills.getSkillHealth(name));
  ipcMain.handle("skills:save", async (_e, name, meta, body) => skills.saveSkill(name, meta, body));
  ipcMain.handle("skills:search", async (_e, query, limit) => skills.searchSkills(query, limit));
  ipcMain.handle("skills:reindex", async () => { skills.reindexSkills(); return { ok: true }; });

  ipcMain.handle("permission:respond", (event, { id, allow }) => {
    const resolve = pendingPerms.get(id);
    if (resolve) { resolve(allow); pendingPerms.delete(id); }
  });

  ipcMain.handle("ask:respond", (_event, { id, answers }) => {
    const resolve = _askResolvers.get(id);
    if (resolve) { resolve({ answers: answers || {} }); _askResolvers.delete(id); }
  });

  // ── Plan Mode IPC ───────────────────────────────────────
  ipcMain.handle("plan-mode:set", (_event, enabled) => { setPlanMode(!!enabled); console.log("[plan-mode] setPlanMode:", enabled, "-> planMode =", getPlanMode()); return { planMode: getPlanMode() }; });
  ipcMain.handle("plan-mode:get", () => ({ planMode: getPlanMode() }));

  ipcMain.handle("skills:list", async () => {
    return scanSkills();
  });

  // ── Knowledge Base IPC ──────────────────────────────────
  ipcMain.handle("kb:get-vault", async () => kb.getVault());
  ipcMain.handle("kb:set-vault", async (_e, path) => kb.setVault(path));
  ipcMain.handle("kb:pick-vault", async () => {
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择 Obsidian Vault 文件夹",
      defaultPath: kb.getVault() || homedir(),
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const setResult = kb.setVault(result.filePaths[0]);
    return { ...result, ...setResult };
  });
  ipcMain.handle("kb:config", async () => kb.getConfig());
  ipcMain.handle("kb:set-config", async (_e, cfg) => kb.setConfig(cfg));
  ipcMain.handle("kb:scan", async () => kb.rebuildIndex());
  ipcMain.handle("kb:status", async () => kb.getStatus());
  ipcMain.handle("kb:search", async (_e, query, limit) => kb.search(query, limit));
  ipcMain.handle("kb:list", async (_e, offset, limit) => kb.listNotes(offset, limit));
  ipcMain.handle("kb:ollama-models", async () => kb.listOllamaModels());
  ipcMain.handle("kb:get-note", async (_e, path) => kb.getNote(path));
  ipcMain.handle("kb:create-note", async (_e, { path: notePath, content, tags }) => kb.createNote(notePath, content, tags));
  ipcMain.handle("kb:update-note", async (_e, { path: notePath, content }) => kb.updateNote(notePath, content));
  ipcMain.handle("kb:delete-note", async (_e, path) => kb.deleteNote(path));

  // ── System Prompt Profile Store IPC ─────────────────────
  ipcMain.handle("prompt:list", async () => {
    return loadPromptProfiles();
  });

  ipcMain.handle("prompt:default", async () => {
    return DEFAULT_PROMPT;
  });

  ipcMain.handle("prompt:save", async (_event, profile) => {
    const store = loadPromptProfiles();
    store.profiles[profile.id] = profile;
    savePromptProfiles(store);
    return { success: true };
  });

  ipcMain.handle("prompt:delete", async (_event, profileId) => {
    const store = loadPromptProfiles();
    if (profileId === "default") return { success: false, error: "Cannot delete default profile" };
    if (store.activeProfile === profileId) {
      store.activeProfile = "default";
    }
    delete store.profiles[profileId];
    savePromptProfiles(store);
    return { success: true };
  });

  ipcMain.handle("prompt:activate", async (_event, profileId) => {
    const store = loadPromptProfiles();
    if (!store.profiles[profileId]) return { success: false, error: "Profile not found" };
    store.activeProfile = profileId;
    savePromptProfiles(store);
    return { success: true };
  });

  ipcMain.handle("skills:load", async (_event, name) => {
    const skillsList = scanSkills();
    const skill = skillsList.find(s => s.name === name);
    if (!skill) return null;
    try {
      const content = readFileSync(skill.path, "utf-8");
      const body = content.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim();
      return { ...skill, body, content };
    } catch { return null; }
  });

  // ── MCP IPC Handlers ────────────────────────────────────
  ipcMain.handle("mcp:list", async () => {
    return mcpManager.listServers();
  });

  ipcMain.handle("mcp:config", async () => {
    return mcpManager.loadConfig();
  });

  ipcMain.handle("mcp:add", async (_event, { name, config }) => {
    try {
      await mcpManager.addServer(name, config);
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:add-remote", async (_event, { name, url, headers }) => {
    try {
      const config = {
        type: "streamableHttp",
        url,
        headers: headers || {},
      };
      await mcpManager.addServer(name, config);
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:save-all", async () => {
    try {
      mcpManager.saveAllServers();
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:remove", async (_event, name) => {
    try {
      await mcpManager.removeServer(name);
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:restart", async (_event, name) => {
    try {
      const tools = await mcpManager.restartServer(name);
      return { success: true, tools };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:builtins", async () => {
    return mcpManager.getBuiltins();
  });

  ipcMain.handle("mcp:toggle-builtin", async (_event, { name, enabled }) => {
    try {
      await mcpManager.toggleBuiltin(name, enabled);
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:detect-local", async () => {
    const HOME = homedir();
    const PLATFORM = process.platform;
    const found = [];

    /**
     * @param {string} filePath
     * @param {string} source
     * @param {{keys?: string[]}} [opts]
     */
    function readMcpServers(filePath, source, opts = {}) {
      if (!existsSync(filePath)) return [];
      try {
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        const keys = opts.keys || ["mcpServers"];
        let servers = {};
        for (const k of keys) {
          if (data[k] && typeof data[k] === "object") {
            servers = data[k];
            break;
          }
        }
        const entries = [];
        for (const [name, cfg] of Object.entries(servers)) {
          if (!cfg || typeof cfg !== "object") continue;
          /** @type {{ source: string, serverName: string, kind: string, command: string, args: string[], env: Record<string, string>, url: string, headers: Record<string, string>, description: string, disabled?: boolean }} */
          const normalized = {
            source,
            serverName: name,
            kind: cfg.command ? "stdio" : "remote",
            command: cfg.command || "",
            args: cfg.args || [],
            env: cfg.env || {},
            url: cfg.baseUrl || cfg.url || "",
            headers: cfg.headers || {},
            description: cfg.description || "",
          };
          if (cfg.isActive === false || cfg.enabled === false) {
            normalized.disabled = true;
          }
          entries.push(normalized);
        }
        return entries;
      } catch (/** @type {any} */ e) {
        console.error(`[mcp] Failed to read ${filePath}:`, e.message);
        return [];
      }
    }

    for (const p of [join(HOME, ".claude", ".mcp.json"), join(HOME, ".claude", "settings.json")]) {
      found.push(...readMcpServers(p, "Claude Code"));
    }
    found.push(...readMcpServers(join(HOME, ".config", "opencode", "mcp.json"), "OpenCode"));
    found.push(...readMcpServers(join(HOME, ".config", "opencode", "opencode.json"), "OpenCode", { keys: ["m"] }));

    // Claude Desktop config paths (cross-platform)
    const claudeConfigDir = PLATFORM === "darwin"
      ? join(HOME, "Library", "Application Support", "Claude")
      : PLATFORM === "win32"
        ? join(process.env.APPDATA || join(HOME, "AppData", "Roaming"), "Claude")
        : join(HOME, ".config", "Claude");
    for (const p of [join(claudeConfigDir, "claude_dotfiles", "mcp.json"), join(claudeConfigDir, "mcp.json")]) {
      found.push(...readMcpServers(p, "Claude Desktop"));
    }

    const seen = new Set();
    const deduped = [];
    for (const entry of found) {
      const key = `${entry.source}||${entry.serverName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }

    return deduped;
  });

  ipcMain.handle("mcp:quick-add-searxng", async (_event, searxngUrl) => {
    try {
      if (!searxngUrl || typeof searxngUrl !== "string") {
        return { success: false, error: "请提供 SearXNG URL" };
      }
      const u = new URL(searxngUrl);
      if (!u.protocol.startsWith("http")) {
        return { success: false, error: "URL 必须以 http:// 或 https:// 开头" };
      }

      const config = {
        command: "npx",
        args: ["-y", "mcp-searxng@latest"],
        env: {
          SEARXNG_URL: searxngUrl.replace(/\/+$/, ""),
          SEARXNG_TIMEOUT: "15000",
          SEARXNG_SAFE_SEARCH: "1",
        },
      };
      await mcpManager.addServer("searxng", config);
      return { success: true };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("dialog:download-markdown", async (_event, content) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { success: false, error: "No focused window" };

    const result = await dialog.showSaveDialog(win, {
      title: "下载为 Markdown",
      defaultPath: `agent-response-${Date.now()}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    try {
      writeFileSync(result.filePath, content, "utf-8");
      return { success: true, filePath: result.filePath };
    } catch (/** @type {any} */ e) {
      return { success: false, error: e.message };
    }
  });

  // ── Encrypted API Key Storage ──────────────────────────────
  const KEY_STORE_PATH = join(homedir(), ".aideagent", "api-keys.enc");

  function loadKeyStore() {
    try {
      if (existsSync(KEY_STORE_PATH)) {
        const data = readFileSync(KEY_STORE_PATH);
        if (safeStorage.isEncryptionAvailable()) {
          return JSON.parse(safeStorage.decryptString(data));
        }
        // Fallback: try reading as plaintext (migration)
        return JSON.parse(data.toString("utf8"));
      }
    } catch { /* ignored */ }
    return {};
  }

  /** @param {Record<string, string>} store */
  function saveKeyStore(store) {
    const json = JSON.stringify(store);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      writeFileSync(KEY_STORE_PATH, encrypted);
    } else {
      // Fallback: plaintext (no encryption available)
      writeFileSync(KEY_STORE_PATH, json, "utf8");
    }
  }

  ipcMain.handle("api-key:save", (_event, { provider, key }) => {
    if (!provider || !key) return { error: "provider and key required" };
    const store = loadKeyStore();
    store[provider] = key;
    saveKeyStore(store);
    return { ok: true };
  });

  ipcMain.handle("api-key:load", (_event, { provider }) => {
    if (!provider) return null;
    const store = loadKeyStore();
    return store[provider] || null;
  });

  ipcMain.handle("env:get", (_event, name) => {
    return process.env[name] || null;
  });

  ipcMain.handle("api-key:delete", (_event, { provider }) => {
    if (!provider) return { error: "provider required" };
    const store = loadKeyStore();
    delete store[provider];
    saveKeyStore(store);
    return { ok: true };
  });
}
