// ── IPC Handlers — All ipcMain.handle registrations ──────────

import { ipcMain, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import sessionDb from "../session-db.ts";
import * as memory from "../memory-store.ts";
import * as skills from "../skills-store.ts";
import * as kb from "../knowledge-store.ts";
import * as prompts from "../prompts-store.ts";
import mcpManager from "../mcp-manager.ts";
import { agentLoop, resetPromptCache } from "./agent-loop.ts";
import { scanSkills } from "./skill-scanner.ts";
import { detectOpencode, listOpencodeModels } from "./opencode-detector.ts";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  taskStore, setTodoList, getTodoList,
  setEpisodicSearched,
  _subAgentCtrls as _subAgentCtrlsRaw, resetSurfacedMemories,
  getWorkspace, setWorkspace,
  getPlanMode, setPlanMode,
  getCurrentRuntime, setCurrentRuntime,
  pendingPerms, _askResolvers,
  setLastApiConfig, getLastApiConfig,
  sendToRenderer, getRendererBuffer, clearRendererBuffer,
  getOpencodeAcpClient, setOpencodeAcpClient,
} from "./state.ts";
import { loadPromptProfiles, savePromptProfiles, DEFAULT_PROMPT } from "./system-prompt.ts";
import { hasPersistedWorkspace } from "./workspace-config.ts";
import { setRendererSnapshot } from "./session-info.ts";
import { updateContextWindowForModel } from "./context-window.ts";

const _subAgentCtrls: Map<string, AbortController> = _subAgentCtrlsRaw as any;

function getHistoryTitle(history: Array<{ role: string, content: string }>): string {
  const firstUser = history.find(m => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

async function saveSession(id: string, history: Array<{ role: string, content: string }>, title: string): Promise<void> {
  // Helper invoked outside agentLoop's closure (e.g. by `session:reset`).
  // Read the runtime from module state so OpenCode sessions get tagged
  // correctly instead of being hardcoded to "aide".
  try { await sessionDb.saveSession(id, history, title, getCurrentRuntime() as any); } catch { /* ignored */ }
}

export function registerIpcHandlers() {
  // Detect locally-installed opencode CLI for the runtime selector.
  ipcMain.handle("agent:detect-opencode", async () => {
    try { return await detectOpencode(); }
    catch (e: any) { return { installed: false, path: null, version: null, available: false, reason: "error", error: e.message }; }
  });
  // List available OpenCode models without spawning a full ACP session.
  // Populates the renderer's model picker BEFORE the first prompt.
  ipcMain.handle("opencode:list-models", async () => {
    try { return await listOpencodeModels(); }
    catch (e: any) { console.warn("[ipc] opencode:list-models failed:", e.message); return []; }
  });

  // Fetch remote model list from the provider's /models endpoint.
  // Runs in MAIN process: renderer fetch is subject to CORS preflight, and
  // many providers (e.g. sensenova) answer OPTIONS with 404, so the browser
  // blocks the request as "Failed to fetch". Node fetch ignores CORS.
  ipcMain.handle("api:fetch-models", async (_event, args: { baseUrl?: string; apiKey?: string }) => {
    const rawBase = String(args?.baseUrl || "").trim();
    const apiKey = String(args?.apiKey || "").trim();
    let baseUrl: string;
    try {
      const u = new URL(rawBase);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      baseUrl = u.href.replace(/\/+$/, "").replace(/\/v1$/, "");
    } catch {
      return { models: [], errors: ["invalid_url"] };
    }

    const endpoints = [baseUrl + "/v1/models", baseUrl + "/models", baseUrl + "/api/tags"];
    const models: Array<{ id: string; label: string }> = [];
    const errors: string[] = [];
    for (const url of endpoints) {
      const shortUrl = url.replace(baseUrl, "") || url;
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          let detail = [res.status, res.statusText].filter(Boolean).join(" ");
          try {
            const body: any = await res.json();
            const msg = body?.error?.message || body?.message ||
              (typeof body?.error === "string" ? body.error : null);
            if (msg) detail += ` — ${msg}`;
          } catch { /* no body */ }
          errors.push(`${shortUrl}: ${detail}`);
          continue;
        }
        const data: any = await res.json();
        const list = data?.data || data?.models || [];
        if (Array.isArray(list) && list.length > 0) {
          for (const m of list) {
            const id = m?.id || m?.name || "";
            if (id) models.push({ id: String(id), label: String(id) });
          }
          break;
        }
      } catch (e: any) {
        errors.push(`${shortUrl}: ${e?.message || String(e)}`);
      }
    }
    return { models, errors };
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
    } catch (e: any) { return { ok: false, error: e.message }; }
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

  ipcMain.handle("query:submit", async (event, { prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, planMode: pm, webSearchEnabled = true, runtime = "aide", opencodeModelId = null, contextWindowOverride }) => {
    setPlanMode(!!pm);
    setCurrentRuntime(runtime);  // so saveSession helper in session:reset tags correctly
    console.log("[query:submit] runtime =", runtime, "opencodeModelId =", opencodeModelId, "planMode =", getPlanMode(), "pm =", pm);
    if (apiKey && apiUrl) setLastApiConfig({ apiKey, apiUrl, model, apiFormat, agentName });
    // Re-resolve the context window for the active model (local servers need
    // no apiKey, so this runs outside the guard above). Fire-and-forget: the
    // sync path sets an immediate best guess; the server probe refines async.
    updateContextWindowForModel({ model, apiUrl, apiKey, apiFormat, contextWindowOverride });
    sendToRenderer("stream:start", {});
    try { await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName, kbEnabled, getPlanMode(), webSearchEnabled, false, runtime, opencodeModelId); }
    catch (err: any) {
      const raw = String(err?.message || err || "");
      // Surface connection drops as an actionable message instead of the
      // raw undici text ("terminated").
      const dropped = raw.includes("terminated")
        || /ECONNRESET|other side closed|socket hang up|UND_ERR_SOCKET/i.test(raw);
      sendToRenderer("stream:error", {
        message: dropped ? `连接被服务端中断，请重试（网络或 API 网关断流）。原文: ${raw}` : raw,
      });
    }
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
      // agent-loop's persistSession already saved the FULL history (incl.
      // tool calls) when the run completed. getHistory() only holds
      // user+assistant text — overwriting would strip the tool calls from
      // the saved session. Only fall back to getHistory() when the DB has
      // no messages for this session yet (e.g. persistSession was skipped).
      let hasSaved = false;
      try {
        const existing = sessionDb.loadSession(sessionId);
        hasSaved = !!(existing && existing.history && existing.history.length > 0);
      } catch { /* ignore */ }
      if (!hasSaved) {
        const title = getHistoryTitle(history);
        await saveSession(sessionId, history, title);
      }
      // P2: persist the current task/todo state before clearing in-memory
      try {
        sessionDb.saveSessionTasks(sessionId, Array.from(taskStore.values()).filter((t: any) => t.status !== "deleted") as any);
        sessionDb.saveSessionTodos(sessionId, getTodoList());
      } catch (e: any) { console.error("[session:reset] task persist failed:", e?.message); }
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
    // Tear down any cached OpenCode ACP subprocess so the next "new chat"
    // starts a fresh ACP session. Without this, a reset → first-prompt
    // path would reuse the prior session's context (a worse leak than
    // the original bug). Best-effort: stop() can throw if the process
    // already exited, and that's fine.
    const cachedOpencode = getOpencodeAcpClient();
    if (cachedOpencode) {
      try { await cachedOpencode.stop(); } catch { /* ignore */ }
      setOpencodeAcpClient(null);
    }
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
        setSessionId(data.id as string);
        setHistory((data.history || []) as Array<{ role: string, content: string }>);
        // P2: restore task/todo state from DB
        try {
          const tasks: any[] = sessionDb.loadSessionTasks(id) || [];
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
        } catch (e: any) { console.error("[session:load] task restore failed:", e?.message); }
        sendToRenderer("session:update", { sessionId: data.id });
      }
      return { sessionId: data.id, title: data.title, runtime: data.runtime || "aide", history: (data.history || []) as Array<{ role: string, content: string }> };
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
    } catch (e: any) {
      console.error("[session:delete-all] error:", e);
      return { error: e.message };
    }
  });

  ipcMain.handle("session:delete-message", async (_event, messageId) => {
    try { return sessionDb.deleteMessage(messageId); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("session:edit-message", async (_event, messageId, newContent) => {
    try { return sessionDb.editMessage(messageId, newContent); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("session:export-markdown", async (_event, id) => {
    try { return sessionDb.exportSession(id); } catch (e: any) { return { error: e.message }; }
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
  ipcMain.handle("skills:detect-patterns", async () => skills.detectPatterns(sessionDb as any));
  ipcMain.handle("skills:curator-run", async () => skills.runCurator());
  ipcMain.handle("skills:curator-status", async () => skills.getCuratorStatus());
  ipcMain.handle("skills:curator-config", async (_e, config) => skills.setCuratorConfig(config || {}));
  ipcMain.handle("skills:health", async (_e, name) => skills.getSkillHealth(name));
  ipcMain.handle("skills:save", async (_e, name, meta, body) => skills.saveSkill(name, meta, body));
  ipcMain.handle("skills:search", async (_e, query, limit) => skills.searchSkills(query, limit));
  ipcMain.handle("skills:reindex", async () => { skills.reindexSkills(); return { ok: true }; });

  // ── Auto-generate skills from conversation (Phase 2 completion) ──
  // Renderer-driven flow: user picks a candidate from the pattern card in
  // the L2 skills panel and clicks "生成技能" → the main process pulls the
  // matching sessions, calls the LLM, parses, and saves a SKILL.md.
  //
  // Returns a structured result so the renderer can surface failures.
  ipcMain.handle("skills:auto-generate", async (_e, { phrase, apiConfig }) => {
    try {
      if (!phrase || typeof phrase !== "string") return { saved: false, error: "missing phrase" };
      /** @type {{apiKey:string, apiUrl:string, model:string, apiFormat:string}} */
      const cfg = apiConfig && typeof apiConfig === "object"
        ? apiConfig
        : { apiKey: "", apiUrl: "", model: "", apiFormat: "openai" };
      if (!cfg.apiKey || !cfg.apiUrl) return { saved: false, error: "api config missing" };

      const suggestions = skills.detectPatterns(sessionDb as any);
      const match = suggestions.find(s => s.phrase === phrase);
      if (!match) return { saved: false, error: "phrase not in detected patterns" };

      // Pull recent sessions whose first user message contains the phrase,
      // and ship their transcripts to the LLM as raw material for the distill.
      const recentSessions = sessionDb.listSessions(30);
      const matchingMsgs: Array<{ role: string, content: string }> = [];
      for (const s of recentSessions.slice(0, 10)) {
        try {
          const data = sessionDb.loadSession((s as any).id as string);
          if (!data?.history) continue;
          /** @type {any[]} */
          const hist = data.history;
          const userMsgs = hist.filter(m => m.role === "user");
          if (!userMsgs.length) continue;
          const firstQuery = String(userMsgs[0].content || "").trim();
          if (!firstQuery.includes(phrase)) continue;
          // Take up to 16 messages (8 exchanges) from this matching session.
          matchingMsgs.push(...hist.slice(0, 16).filter(m => m.role === "user" || m.role === "assistant"));
        } catch { /* ignored */ }
      }
      if (matchingMsgs.length < 4) return { saved: false, error: "no matching session content" };

      const result = await skills.autoGenerateSkillFromConversation({
        msgs: matchingMsgs,
        candidate: { phrase, count: match.count, examples: match.examples || [] },
        apiKey: cfg.apiKey,
        apiUrl: cfg.apiUrl,
        model: cfg.model,
        apiFormat: cfg.apiFormat || "openai",
      });
      // Tell the L2 panel to refresh so the new skill shows up immediately.
      try { sendToRenderer("skills:translations-updated", { count: 1, generated: result.name }); } catch { /* renderer may be gone */ }
      return result;
    } catch (e: any) {
      return { saved: false, error: e?.message || String(e) };
    }
  });

  // Sweep all detected candidates in one shot — used by the session-end
  // auto-trigger in agent-loop.mjs. Resilient: one failure never aborts
  // the others. Returns an array of results so the UI can show per-skill
  // status.
  ipcMain.handle("skills:auto-generate-all", async (_e, { apiConfig, signal } = {}) => {
/** @type {Array<{phrase:string, saved:boolean, name?:string, error?:string, alreadyExisted?:boolean}>} */
      const results = [];
    try {
      /** @type {{apiKey:string, apiUrl:string, model:string, apiFormat:string}} */
      const cfg = apiConfig && typeof apiConfig === "object"
        ? apiConfig
        : { apiKey: "", apiUrl: "", model: "", apiFormat: "openai" };
      if (!cfg.apiKey || !cfg.apiUrl) return [];

      const suggestions = skills.detectPatterns(sessionDb as any);
      if (!suggestions.length) return [];

      const recentSessions = sessionDb.listSessions(30);
      for (const cand of suggestions.slice(0, 5)) {
        try {
          const matchingMsgs: Array<{ role: string, content: string }> = [];
          for (const s of recentSessions.slice(0, 10)) {
            try {
              const data = sessionDb.loadSession((s as any).id as string);
              if (!data?.history) continue;
              /** @type {any[]} */
              const hist = data.history;
              const userMsgs = hist.filter(m => m.role === "user");
              if (!userMsgs.length) continue;
              if (!String(userMsgs[0].content || "").includes(cand.phrase)) continue;
              matchingMsgs.push(...hist.slice(0, 16).filter(m => m.role === "user" || m.role === "assistant"));
            } catch { /* ignore */ }
          }
          if (matchingMsgs.length < 4) { results.push({ phrase: cand.phrase, saved: false, error: "no matching content" }); continue; }
          const r = await skills.autoGenerateSkillFromConversation({
            msgs: matchingMsgs, candidate: cand,
            apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, model: cfg.model, apiFormat: cfg.apiFormat || "openai",
            signal,
          });
          results.push({ phrase: cand.phrase, saved: r.saved === true, name: r.name, error: r.error, alreadyExisted: r.alreadyExisted });
        } catch (e: any) {
          results.push({ phrase: cand.phrase, saved: false, error: e?.message || String(e) });
        }
      }
      try { sendToRenderer("skills:translations-updated", { count: results.filter(r => r.saved).length, generatedBatch: true }); } catch { /* renderer may be gone */ }
    } catch (e: any) {
      console.error("[skills:auto-generate-all] error:", e?.message);
    }
    return results;
  });

  // Per-user skill name translations (display-only, in ~/.aideagent/skill-translations.json)
  // Use the same union (L3 scanSkills + L2 listSkills) the renderer shows, so cache
  // keys line up with what the user actually sees in the skills panel.
  ipcMain.handle("skills:translations-get", async () => {
    try { return { ok: true, translations: skills.loadTranslations() }; }
    catch (e: any) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("skills:translations-missing", async () => {
    try {
      /** @type {any} */
      const l3 = scanSkills() || [];
      /** @type {any} */
      const l2 = skills.listSkills() || [];
      const seen = new Set(l3.map((/** @type {any} */ s) => s.name));
      const all = /** @type {any} */ ([...l3, ...l2.filter((/** @type {any} */ s) => !seen.has(s.name))]);
      return { ok: true, missing: skills.getMissingTranslations(all as any) };
    } catch (e: any) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("skills:translations-ensure", async (_e, apiConfig) => {
    try {
      /** @type {any} */
      const l3 = scanSkills() || [];
      /** @type {any} */
      const l2 = skills.listSkills() || [];
      const seen = new Set(l3.map((/** @type {any} */ s) => s.name));
      const all = /** @type {any} */ ([...l3, ...l2.filter((/** @type {any} */ s) => !seen.has(s.name))]);
      const missing = skills.getMissingTranslations(all as any);
      if (missing.length === 0) return { ok: true, translated: 0, totalMissing: 0, errors: 0 };
      /** @type {any} */
      const cfg = apiConfig && apiConfig.apiKey ? apiConfig : (getLastApiConfig() || {});
      const result = await skills.ensureTranslations(missing, cfg);
      if (result.translated > 0) {
        sendToRenderer("skills:translations-updated", { count: result.translated });
      }
      return { ok: true, ...result, skipped: result.skipped || (!cfg.apiKey ? "no api key in main process" : undefined) };
    } catch (e: any) { return { ok: false, error: e.message }; }
  });
  // Manual override for a single skill's display name (renderer "✎ edit" button).
  // Pass "" to remove the override and fall back to heuristic. Broadcasts the
  // same "translations-updated" event so the panel re-renders.
  ipcMain.handle("skills:translation-set", async (_e, name, zh) => {
    try {
      const result = skills.setTranslation(name, zh);
      if (result.ok) sendToRenderer("skills:translations-updated", { count: 1 });
      return result;
    } catch (e: any) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("permission:respond", (event, { id, allow }) => {
    const resolve = pendingPerms.get(id) as ((allow: boolean) => void) | undefined;
    if (resolve) { resolve(allow); pendingPerms.delete(id); }
  });

  ipcMain.handle("ask:respond", (_event, { id, answers }) => {
    const resolve = _askResolvers.get(id) as ((v: any) => void) | undefined;
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
    } catch (e: any) {
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
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:save-all", async () => {
    try {
      mcpManager.saveAllServers();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:remove", async (_event, name) => {
    try {
      await mcpManager.removeServer(name);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:restart", async (_event, name) => {
    try {
      const tools = await mcpManager.restartServer(name);
      return { success: true, tools };
    } catch (e: any) {
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
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("mcp:detect-local", async () => {
    const HOME = homedir();
    const PLATFORM = process.platform;
    const found = [];

    function readMcpServers(filePath: string, source: string, opts: { keys?: string[] } = {}): any[] {
      if (!existsSync(filePath)) return [];
      try {
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        const keys = opts.keys || ["mcpServers"];
        let servers: Record<string, any> = {};
        for (const k of keys) {
          if (data[k] && typeof data[k] === "object") {
            servers = data[k];
            break;
          }
        }
        const entries: any[] = [];
        for (const [name, cfg] of Object.entries(servers)) {
          if (!cfg || typeof cfg !== "object") continue;
          const normalized: any = {
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
      } catch (e: any) {
        console.error(`[mcp] Failed to read ${filePath}:`, e.message);
        return [];
      }
    }

    for (const p of [join(HOME, ".claude", ".mcp.json"), join(HOME, ".claude", "settings.json")]) {
      found.push(...readMcpServers(p, "Claude Code"));
    }
    // OpenCode stores config at ~/.config/opencode/opencode.json (and
    // optional mcp.json) on ALL platforms, including Windows — the docs
    // use the XDG-style path regardless of OS. Older Windows builds also
    // wrote to %APPDATA%/opencode, so probe both so the "import from
    // OpenCode" button works everywhere.
    const opencodeConfigDirs = [
      join(HOME, ".config", "opencode"),
      ...(PLATFORM === "win32"
        ? [join(process.env.APPDATA || join(HOME, "AppData", "Roaming"), "opencode")]
        : []),
    ];
    for (const dir of opencodeConfigDirs) {
      found.push(...readMcpServers(join(dir, "mcp.json"), "OpenCode"));
      // opencode.json uses the "mcp" top-level key; tolerate "mcpServers" too.
      found.push(...readMcpServers(join(dir, "opencode.json"), "OpenCode", { keys: ["mcp", "mcpServers"] }));
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
    } catch (e: any) {
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
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Encrypted API Key Storage ──────────────────────────────
  const KEY_STORE_PATH = join(homedir(), ".aideagent", "api-keys.enc");

  // The "custom" provider is represented by an empty string "" throughout the
  // renderer (settings-provider <option value="">). An empty string is falsy,
  // so the old `if (!provider)` guards below silently REJECTED custom-provider
  // keys — they were never persisted, and vanished on restart / provider
  // switch. Normalize "" to a stable sentinel key (matching the existing
  // `_search_provider` naming style) so custom keys are stored like any other.
  const CUSTOM_KEYSTORE_ID = "_custom";
  const keyStoreId = (provider: string): string => provider || CUSTOM_KEYSTORE_ID;

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

  function saveKeyStore(store: Record<string, string>): void {
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
    // `provider == null` (not `!provider`) so the custom provider's empty
    // string is accepted and normalized to CUSTOM_KEYSTORE_ID.
    if (provider == null || !key) return { error: "provider and key required" };
    const store = loadKeyStore();
    store[keyStoreId(provider)] = key;
    saveKeyStore(store);
    return { ok: true };
  });

  ipcMain.handle("api-key:load", (_event, { provider }) => {
    if (provider == null) return null;
    const store = loadKeyStore();
    return store[keyStoreId(provider)] || null;
  });

  // Read-only env access for renderer-side features that need to know things
  // like the user's PATH, HOME, or locale. SECURITY: We do NOT expose the
  // full environment to the renderer — a Skill's rendered output could read
  // AWS keys, GitHub tokens, or any other secret in process.env via a
  // crafted <script> tag. Allow-list only the harmless env vars a UI feature
  // might legitimately need; everything else is rejected with null.
  ipcMain.handle("env:get", (_event, name) => {
    if (typeof name !== "string") return null;
    const ALLOWED = new Set([
      "PATH", "Path",                       // locate binaries
      "HOME", "USERPROFILE",                // user home
      "USER", "USERNAME",                   // username
      "LANG", "LC_ALL", "LANGUAGE",         // locale
      "TZ",                                  // timezone
      "SHELL", "ComSpec",                    // default shell (Windows)
      "TMP", "TEMP", "TMPDIR",               // temp dirs
      "XDG_CONFIG_HOME", "XDG_DATA_HOME",   // Linux XDG paths
    ]);
    if (!ALLOWED.has(name)) return null;
    return process.env[name] || null;
  });

  ipcMain.handle("api-key:delete", (_event, { provider }) => {
    if (provider == null) return { error: "provider required" };
    const store = loadKeyStore();
    delete store[keyStoreId(provider)];
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
