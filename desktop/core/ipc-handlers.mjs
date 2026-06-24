// ── IPC Handlers — All ipcMain.handle registrations ──────────

import { ipcMain, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import sessionDb from "../session-db.mjs";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";
import * as kb from "../knowledge-store.mjs";
import * as prompts from "../prompts-store.mjs";
import mcpManager from "../mcp-manager.mjs";
import { agentLoop, resetPromptCache } from "./agent-loop.mjs";
import { scanSkills } from "./skill-scanner.mjs";
import { detectOpencode } from "./opencode-detector.mjs";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  taskStore, setTodoList,
  setEpisodicSearched,
  _subAgentCtrls as _subAgentCtrlsRaw, resetSurfacedMemories,
  getWorkspace, setWorkspace,
  getPlanMode, setPlanMode,
  getCurrentRuntime, setCurrentRuntime,
  pendingPerms, _askResolvers,
  setLastApiConfig,
  sendToRenderer, getRendererBuffer, clearRendererBuffer,
} from "./state.mjs";
import { loadPromptProfiles, savePromptProfiles, DEFAULT_PROMPT } from "./system-prompt.mjs";
import { hasPersistedWorkspace } from "./workspace-config.mjs";
import { setRendererSnapshot } from "./session-info.mjs";

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
  // Helper invoked outside agentLoop's closure (e.g. by `session:reset`).
  // Read the runtime from module state so OpenCode sessions get tagged
  // correctly instead of being hardcoded to "aide".
  try { await sessionDb.saveSession(id, history, title, getCurrentRuntime()); } catch { /* ignored */ }
}

export function registerIpcHandlers() {
  // Detect locally-installed opencode CLI for the runtime selector.
  ipcMain.handle("agent:detect-opencode", async () => {
    try { return await detectOpencode(); }
    catch (/** @type {any} */ e) { return { installed: false, path: null, version: null, available: false, reason: "error", error: e.message }; }
  });

  // Open an external URL in the user's default browser (used by the opencode
  // install-guide modal). Validated to http(s) AND restricted to an allow-list
  // of trusted hosts so a compromised renderer (XSS, malicious skill output)
  // can't use this bridge to launch phishing pages.
  const OPEN_EXTERNAL_ALLOWED_HOSTS = new Set([
    "opencode.ai",
    "docs.opencode.ai",
    "github.com",
    "anthropic.com",
  ]);
  ipcMain.handle("shell:open-external", async (_event, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "protocol_not_allowed" };
      if (!OPEN_EXTERNAL_ALLOWED_HOSTS.has(u.hostname)) return { ok: false, error: "host_not_allowed" };
      await shell.openExternal(u.href);
      return { ok: true };
    } catch (/** @type {any} */ e) { return { ok: false, error: e.message }; }
  });

  // Renderer pushes its localStorage snapshot here whenever an
  // `AideAgent_*` key changes (auto-installed by `installLocalStorageHook`).
  // Stored in module state — the `get_session_info` tool merges this with
  // fresh file reads on each call. NOT an `ipcMain.handle` because the
  // renderer doesn't need a reply — fire-and-forget.
  ipcMain.on("session-info:update", (_event, snapshot) => {
    if (snapshot && typeof snapshot === "object") {
      setRendererSnapshot(snapshot);
    }
  });

  ipcMain.handle("query:submit", async (event, { prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, planMode: pm, webSearchEnabled = true, runtime = "aide" }) => {
    setPlanMode(!!pm);
    setCurrentRuntime(runtime);  // so saveSession helper in session:reset tags correctly
    console.log("[plan-mode] query:submit planMode =", getPlanMode(), "pm =", pm);
    if (apiKey && apiUrl) setLastApiConfig({ apiKey, apiUrl, model, apiFormat, agentName });
    sendToRenderer("stream:start", {});
    try { await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName, kbEnabled, getPlanMode(), webSearchEnabled, false, runtime); }
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
    // P1: abort the main agent loop before clearing state — otherwise a
    // ghost agent keeps running in the background consuming tokens.
    const mainAbortCtrl = getAbortCtrl();
    if (mainAbortCtrl) { mainAbortCtrl.abort(); setAbortCtrl(null); }

    const sessionId = getSessionId();
    const history = getHistory();
    if (sessionId && history.length > 0) {
      const title = getHistoryTitle(history);
      await saveSession(sessionId, history, title);
      // P2: persist the current task/todo state before clearing in-memory
      try {
        sessionDb.saveSessionTasks(sessionId, Array.from(taskStore.values()).filter(t => t.status !== "deleted"));
        sessionDb.saveSessionTodos(sessionId, getTodoList());
      } catch (e) { console.error("[session:reset] task persist failed:", e?.message); }
    }
    setSessionId(null); setHistory([]);
    setEpisodicSearched(false);
    taskStore.clear();
    setTodoList([]);
    resetSurfacedMemories();
    for (const ctrl of _subAgentCtrls.values()) { ctrl.abort(); }
    _subAgentCtrls.clear();
    resetPromptCache(); // P0: invalidate stale system prompt cache from previous session
    // P3: drop any pending long-task resume marker for the old session.
    if (sessionId) { try { sessionDb.clearTurnProgress(sessionId); } catch { /* ignored */ } }
    sendToRenderer("task:clear", {});
  });

  ipcMain.handle("session:list", async () => {
    return await sessionDb.listSessions();
  });

  ipcMain.handle("session:load", async (_event, id, opts) => {
    const data = await sessionDb.loadSession(id);
    if (data) {
      if (!opts?.readOnly) {
        resetPromptCache(); // P0: invalidate stale cached system prompt before loading a different session
        // P1: clear stale turn_progress marker from a previous crash — this
        // session is being actively loaded, so any old "interrupted at turn N"
        // record is no longer relevant.
        try { sessionDb.clearTurnProgress(id); } catch { /* ignored */ }
        setSessionId(/** @type {string} */ (data.id));
        setHistory(/** @type {Array<{role: string, content: string}>} */ (data.history || []));
        // P2: restore task/todo state from DB
        try {
          const tasks = sessionDb.loadSessionTasks(id) || [];
          taskStore.clear();
          for (const t of tasks) {
            taskStore.set(t.id, {
              id: t.id, subject: t.subject, description: t.description, status: t.status,
              activeForm: t.activeForm, evidence: t.evidence, unverified: t.unverified,
              completedAt: t.completedAt, createdAt: t.createdAt, updatedAt: t.updatedAt,
              owner: "", metadata: {},
            });
          }
          const todos = sessionDb.loadSessionTodos(id) || [];
          setTodoList(todos);
          sendToRenderer("task:restored", { taskCount: tasks.length, todoCount: todos.length });
        } catch (e) { console.error("[session:load] task restore failed:", e?.message); }
        sendToRenderer("session:update", { sessionId: data.id });
      }
      return { sessionId: data.id, title: data.title, runtime: data.runtime || "aide", history: /** @type {Array<{role: string, content: string}>} */ (data.history || []) };
    }
    return null;
  });

  ipcMain.handle("session:delete", async (_event, id) => {
    await sessionDb.deleteSession(id);
    // P2: cascade task/todo cleanup (FK ON DELETE CASCADE handles it, but be explicit)
    try { sessionDb.clearSessionTasks(id); } catch { /* ignored */ }
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

  // P1: surface long-task resume state so the renderer can show a banner
  // ("上一轮任务在第 23 轮中断，已自动续接") instead of starting blind.
  ipcMain.handle("session:turn-progress", async (_event, id) => {
    try { return sessionDb.loadTurnProgress(id); } catch { return null; }
  });
  ipcMain.handle("session:clear-turn-progress", async (_event, id) => {
    try { sessionDb.clearTurnProgress(id); return { ok: true }; } catch { return { error: "failed" }; }
  });

  // P1: renderer message buffer — replay stream events after reconnect
  ipcMain.handle("renderer:replay-buffer", async () => {
    try { const buf = getRendererBuffer(); clearRendererBuffer(); return buf; } catch { return []; }
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
  ipcMain.handle("memory:purge-by-type", async (_e, type) => {
    return memory.purgeByType(type);
  });

  // ── Prompts API (Stage 2 — user-defined reusable prompts) ──
  ipcMain.handle("prompts:list", async () => {
    try { return prompts.listPrompts(); } catch { return []; }
  });
  ipcMain.handle("prompts:read", async (_e, id) => {
    try { return prompts.readPrompt(id); } catch { return null; }
  });
  ipcMain.handle("prompts:create", async (_e, input) => {
    return prompts.createPrompt(input || {});
  });
  ipcMain.handle("prompts:update", async (_e, id, input) => {
    return prompts.updatePrompt(id, input || {});
  });
  ipcMain.handle("prompts:delete", async (_e, id) => {
    return prompts.deletePrompt(id);
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

  // Per-user skill name translations (display-only, in ~/.aideagent/skill-translations.json)
  // Use the same union (L3 scanSkills + L2 listSkills) the renderer shows, so cache
  // keys line up with what the user actually sees in the skills panel.
  ipcMain.handle("skills:translations-get", async () => {
    try { return { ok: true, translations: skills.loadTranslations() }; }
    catch (/** @type {any} */ e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("skills:translations-missing", async () => {
    try {
      /** @type {any} */
      const l3 = scanSkills() || [];
      /** @type {any} */
      const l2 = skills.listSkills() || [];
      const seen = new Set(l3.map((/** @type {any} */ s) => s.name));
      const all = /** @type {any} */ ([...l3, ...l2.filter((/** @type {any} */ s) => !seen.has(s.name))]);
      return { ok: true, missing: skills.getMissingTranslations(all) };
    } catch (/** @type {any} */ e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("skills:translations-ensure", async (_e, apiConfig) => {
    try {
      /** @type {any} */
      const l3 = scanSkills() || [];
      /** @type {any} */
      const l2 = skills.listSkills() || [];
      const seen = new Set(l3.map((/** @type {any} */ s) => s.name));
      const all = /** @type {any} */ ([...l3, ...l2.filter((/** @type {any} */ s) => !seen.has(s.name))]);
      const missing = skills.getMissingTranslations(all);
      if (missing.length === 0) return { ok: true, translated: 0, totalMissing: 0, errors: 0 };
      /** @type {any} */
      const cfg = apiConfig && apiConfig.apiKey ? apiConfig : (getLastApiConfig() || {});
      const result = await skills.ensureTranslations(missing, cfg);
      if (result.translated > 0) {
        sendToRenderer("skills:translations-updated", { count: result.translated });
      }
      return { ok: true, ...result, skipped: result.skipped || (!cfg.apiKey ? "no api key in main process" : undefined) };
    } catch (/** @type {any} */ e) { return { ok: false, error: e.message }; }
  });
  // Manual override for a single skill's display name (renderer "✎ edit" button).
  // Pass "" to remove the override and fall back to heuristic. Broadcasts the
  // same "translations-updated" event so the panel re-renders.
  ipcMain.handle("skills:translation-set", async (_e, name, zh) => {
    try {
      const result = skills.setTranslation(name, zh);
      if (result.ok) sendToRenderer("skills:translations-updated", { count: 1 });
      return result;
    } catch (/** @type {any} */ e) { return { ok: false, error: e.message }; }
  });

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

  // Read the full SKILL.md content by absolute path. Used by the renderer
  // "Import to input" button (Stage 4 of the prompts/skills flow) to fetch
  // the body of a skill from its on-disk location — needed because L3
  // skills live in ~/.agents/ or ~/.claude/, not ~/.aideagent/skills/.
  //
  // Path-scoped (not arbitrary fs access): the renderer only gets paths
  // from the trusted scanSkills() output, never from user input.
  ipcMain.handle("skills:read-content", async (_e, filePath) => {
    try {
      if (!filePath || typeof filePath !== "string") return null;
      if (!existsSync(filePath)) return null;
      // Refuse paths that aren't SKILL.md files — defense in depth
      if (!filePath.endsWith("SKILL.md") && !filePath.endsWith("skill.md")) return null;
      return readFileSync(filePath, "utf-8");
    } catch { return null; }
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

  // ── Knowledge Base Watcher IPC ────────────────────────────
  ipcMain.handle("kb:watcher-start", async () => kb.startWatcher());
  ipcMain.handle("kb:watcher-stop", async () => kb.stopWatcher());
  ipcMain.handle("kb:watcher-status", async () => ({ active: kb.isWatcherActive() }));

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
    // OpenCode uses ~/.config/opencode on macOS/Linux but %APPDATA%/opencode on
    // Windows. Probe both candidate directories so the "import from OpenCode"
    // button works on every platform.
    const opencodeConfigDirs = PLATFORM === "win32"
      ? [join(process.env.APPDATA || join(HOME, "AppData", "Roaming"), "opencode")]
      : [join(HOME, ".config", "opencode")];
    for (const dir of opencodeConfigDirs) {
      found.push(...readMcpServers(join(dir, "mcp.json"), "OpenCode"));
      found.push(...readMcpServers(join(dir, "opencode.json"), "OpenCode", { keys: ["m"] }));
    }

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

  // Note: the 12 skills:* IPC channels (skills:list-all, skills:load-one,
  // skills:set-status, skills:delete, skills:detect-patterns,
  // skills:curator-run, skills:curator-status, skills:curator-config,
  // skills:health, skills:save, skills:search, skills:reindex) are
  // registered earlier in this file (line 213+). Do NOT re-register them
  // here or Electron throws "Attempted to register a second handler".
}
