# Architecture

**Analysis Date:** 2026-06-08

## Pattern

**Overall:** Electron multi-process application with an event-driven, agent-loop core.

AideAgent follows the standard Electron split-process model (main / preload / renderer), with a single embedded "agent runtime" in the main process. The agent runtime is **turn-based and stream-oriented**: each user turn is a coroutine (`agentLoop`) that loops over LLM calls and tool dispatches until the model emits no more `tool_calls`.

**Key Characteristics:**
- **Main process owns truth.** All mutable state — session history, AbortControllers, task/todo stores, plan-mode flag, WeChat bot credentials, last-used API config — lives in `desktop/core/state.mjs` and is mutated through getter/setter pairs. The renderer receives a read/stream-only view of that state via `webContents.send`.
- **Preload is the only bridge.** `desktop/preload.cjs` exposes `window.aideagent` via `contextBridge`. All renderer → main traffic goes through `ipcRenderer.invoke` (request/response) or `ipcRenderer.on` (push events). No direct Node access in the renderer (`contextIsolation: true`, `nodeIntegration: false`).
- **IPC handlers are a flat routing layer.** `desktop/core/ipc-handlers.mjs` defines ~70 `ipcMain.handle` channels; handlers are thin wrappers that call into stores (`sessionDb`, `memory`, `skills`, `kb`, `mcpManager`) or into the agent runtime (`agentLoop`).
- **Agent loop is the heart of the app.** `desktop/core/agent-loop.mjs:153` is `agentLoop(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName, kbEnabled, isPlanMode, webSearchEnabled, silent)`. It builds the message array, calls `openaiCall`/`anthropicCall`, dispatches tools via `runTool`, and loops on `tool_calls` until exhausted.
- **Tools are an in-process dispatcher.** `desktop/core/tool-executor.mjs:181` `runTool(tc)` is a 750-line switch over ~30 builtin tools. Unknown tools fall through to the MCP manager. Sub-agents (`Agent` tool) recursively call `runSubAgent` in `desktop/core/sub-agent.mjs`.
- **Streaming via push events.** The agent loop emits `stream:start`, `stream:chunk`, `stream:reasoning`, `stream:metrics`, `tool:start`, `tool:result`, `subagent:start/chunk/progress/done`, `context:usage`, `l0:budget`, `session:update`, `task:clear`, `permission:request`, `ask:question`, `wechat:bot-status`, `wechat:incoming`, `update:status`, `update:progress`.
- **Two API adapters behind one interface.** `desktop/core/format-adapters.mjs` provides `openaiCall` and `anthropicCall` (plus `toAnthropicMessages`/`toAnthropicTools`). Tool definitions in `desktop/core/tool-definitions.mjs` are filtered by plan-mode, KB-enabled, web-search-enabled flags in `getAllToolDefs` (cached).
- **Prompt caching is a first-class concern.** The agent loop caches `_sysPromptCache` and `_contextBlockBaseCache` between turns of the same session so the static prefix hits the LLM provider's prompt cache. Anthropic adapter adds `cache_control: { type: "ephemeral" }` blocks; OpenAI adapter forwards `prompt_cache_hit_tokens`/`cache_read_input_tokens`.
- **Plan mode is enforced at three layers.** Tool registry filters write tools out (`PLAN_MODE_READONLY` set in `state.mjs`), `getAllToolDefs` re-filters, and `runTool` re-checks before dispatch.
- **Hook manager is pluggable.** `desktop/core/hook-manager.mjs` loads `hooks.json` from `<workspace>/hooks` and `~/.aideagent/hooks`, runs `PreToolUse` scripts with `{ tool, args }` JSON, accepts `{ decision: "block" | "modify" }` returns.

## Layers

### Main Process
- Purpose: Owns app lifecycle, windows, stores, IPC, agent runtime, and the LLM/tool call loop.
- Entry: `desktop/main.mjs`
- Preload registration: `desktop/main.mjs:22` `createWindow()`
- IPC registration: `desktop/main.mjs:141` `registerIpcHandlers()` / `registerWechatIpc()`
- Background jobs: `desktop/main.mjs:134` periodic skills curator (every 6 hours), `desktop/main.mjs:121` MCP init, `desktop/main.mjs:124` session DB migration
- Migration on startup: `desktop/main.mjs:86` renames `~/.goodagent` → `~/.aideagent`
- Shutdown: `desktop/main.mjs:150` closes sessionDb, shuts down LSP manager

**Core submodules (in `desktop/core/`):**
- `agent-loop.mjs:153` — main agent coroutine (turn + continuation loop)
- `state.mjs` — shared mutable state and constants (single source of truth)
- `system-prompt.mjs:177` — `buildSystemPrompt(enabledSkills, agentName, userPrompt, kbEnabled, isPlanMode, webSearchEnabled, kbInject)` produces `{ role, content, contextBlock }`
- `tool-executor.mjs:181` — `runTool(tc)` dispatches by tool name
- `tool-definitions.mjs` — `TOOL_DEFS` array (OpenAI function-calling schema for ~30 tools)
- `format-adapters.mjs:112` / `:177` — `openaiCall` / `anthropicCall` (streaming SSE → parsed chunks + tool-call accumulator)
- `sub-agent.mjs:17` — `runSubAgent(description, prompt, subAgentId)` recursive child agent
- `memory-selection.mjs:13` — `selectRelevantMemories(query, ...)` AI-ranked memory surfacing
- `token-budget.mjs` — `compressContext`, `summarizeForContinuation`, `estimateTokens`, `trimToBudget`
- `hook-manager.mjs` — `initHookManager(workspace)`, `fire(event, data)`
- `skill-scanner.mjs:44` — `scanSkills()` discovers `SKILL.md` files in `~/.agents/skills`, `~/.agents`, `~/.claude/skills`
- `workspace-config.mjs` — `loadWorkspaceConfig` / `saveWorkspaceConfig` / `hasPersistedWorkspace`
- `wechat-bridge.mjs` — WeChat iLink QR login + bot polling

**Root-level main-process modules:**
- `session-db.mjs` — SQLite-backed session persistence (`saveSession`, `loadSession`, `searchMessages`, `getRecentSessions`, `deleteSession`, `exportSession`, `forceCheckpoint`)
- `memory-store.mjs` — multi-file memory (`listMemories`, `readUserMemory`, `writeUserMemory`, `readMemory`, `createMemory`, `updateMemory`, `checkDuplicate`, `memoryFreshnessNote`, `memoryAgeDays`)
- `skills-store.mjs` — L2 skill store (`listSkills`, `loadSkill`, `saveSkill`, `recordSkillUsage`, `detectPatterns`, `runCurator`, `generateSkill`, `buildSkillsContext`)
- `knowledge-store.mjs` — Obsidian vault index (`getVault`, `search`, `getNote`, `createNote`, `updateNote`, `rebuildIndex`, `listOllamaModels`)
- `mcp-manager.mjs` — Model Context Protocol servers (`init`, `listServers`, `addServer`, `removeServer`, `restartServer`, `callTool`, `listAllToolDefs`, `toggleBuiltin`, `getBuiltins`)
- `lsp-manager.mjs` — Language Server Protocol (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `shutdown`)
- `update-manager.mjs` — auto-update (`initUpdateManager(window)`, `getVersion`, `checkForUpdates`, `install`)
- `search-engine/index.mjs` — `searchMeta(query, maxResults)` Bing + DDG + GitHub meta-search

### Preload
- Bridge: `desktop/preload.cjs`
- Purpose: Exposes `window.aideagent` via `contextBridge.exposeInMainWorld`. Every renderer → main call is either `ipcRenderer.invoke(<channel>, ...args)` (request/response) or `ipcRenderer.on(<channel>, cb)` (push).
- Notable exposed surface: `submitQuery`, `abortQuery`, `resetSession`, `loadSession`, `searchSessions`, memory CRUD, skills CRUD, KB CRUD, MCP CRUD, WeChat login, encrypted API key store, update manager, environment variable accessor.
- Push events surfaced to renderer: `stream:start/chunk/reasoning/metrics/done/error`, `tool:start/result`, `subagent:start/chunk/progress/done`, `session:update`, `l0:budget`, `context:usage`, `task:clear`, `permission:request`, `ask:question`, `wechat:bot-status/incoming`, `update:status/progress`.

### Renderer
- Purpose: Renders the chat UI, settings panels, and reacts to push events. The renderer is a **thin client** — it holds DOM state and rendering helpers but no business logic.
- Entry: `desktop/renderer/app.js` (single 2078-line monolith, explicitly marked `@ts-nocheck` and slated for refactor)
- HTML: `desktop/renderer/index.html`
- Styles: `desktop/renderer/style.css`
- i18n: `desktop/renderer/translations.js` (`t(...)` global)
- Type surface: `desktop/renderer/global.d.ts`

**Renderer modules (in `desktop/renderer/modules/`):**
- `app.js` (load-bearing root) — orchestrates DOM, providers, send/stop, sessions list, reasoning panels, permission modal
- `agent-name.mjs` — agent + user name + avatar UI
- `bg-settings.mjs` — background image settings
- `file-previews.mjs` — attachment thumbnails
- `font-settings.mjs` — font controls
- `helpers.mjs` — `sanitize`, `renderMarkdown`, `renderLatexInElement`, `autoResize`, `formatFileSize`, `scrollToBottom`, `setStatus`
- `knowledge-base.mjs` — KB vault picker, scan, search
- `mcp.mjs` — MCP servers panel
- `memory-panel.mjs` — memory CRUD UI
- `prompt-store.mjs` — prompt profile editor
- `settings-tabs.mjs` — settings tab router
- `skills-panel.mjs` — L3 + L2 skill toggles and editor
- `wechat.mjs` — WeChat panel UI
- `workspace.mjs` — workspace path picker

### Cross-cutting layers (`desktop/test/` + `desktop/scripts/`)
- `desktop/test/` — Vitest unit specs (`state.test.mjs`, `token-budget.test.mjs`, `session-db.test.mjs`, `memory-store.test.mjs`, `skills-store.test.mjs`, `knowledge-store.test.mjs`, `format-adapters.test.mjs`, `skill-scanner.test.mjs`, `shell-cross-platform.test.mjs`, `patterns.test.mjs`, `features.test.mjs`, `e2e-full.test.mjs`)
- `desktop/test/e2e/` — Playwright e2e (`smoke.test.mjs`, `agent-name.test.mjs`, `kb.test.mjs`, `memory.test.mjs`, `skills.test.mjs`, `font-lang.test.mjs`, `prompt.test.mjs`)
- `desktop/scripts/download-model.mjs` — postinstall ONNX embedding model fetch (`all-MiniLM-L6-v2`)

## Data Flow

### 1. Cold start
1. `desktop/main.mjs:84` `app.whenReady()` → migrate `~/.goodagent` → `~/.aideagent` if needed (`desktop/main.mjs:88`).
2. `desktop/main.mjs:100` `initWorkspaceFromConfig()` reads `<userData>/workspace-config.json` and overrides `WORKSPACE` in `state.mjs`.
3. `desktop/main.mjs:102` `createWindow()` builds a `BrowserWindow` with `preload.cjs`, `contextIsolation: true`, `nodeIntegration: false`.
4. `desktop/main.mjs:120` MCP init (skipped if `AIDEAGENT_TEST_MODE=1`).
5. `desktop/main.mjs:124` `sessionDb.migrateFromJson(...)`.
6. `desktop/main.mjs:131` Skills curator + initial reindex.
7. `desktop/main.mjs:141` `registerIpcHandlers()` + `registerWechatIpc()`.
8. `desktop/main.mjs:144` `autoStartWechat()` (skipped in test mode).
9. `desktop/main.mjs:135` periodic curator interval (every 6 hours).

### 2. User sends a message (request/response + streaming)
1. Renderer `app.js` invokes `window.aideagent.submitQuery(prompt, apiKey, apiUrl, model, apiFormat, files, enabledSkills, reasoning, agentName, kbEnabled, planMode, webSearchEnabled)`.
2. Preload forwards via `ipcRenderer.invoke("query:submit", {...})`.
3. `desktop/core/ipc-handlers.mjs:46` `ipcMain.handle("query:submit", ...)`:
   - calls `setPlanMode(pm)`, `setLastApiConfig(...)`.
   - sends `stream:start` to renderer.
   - awaits `agentLoop(...)`.
   - sends `stream:done`.
4. `desktop/core/agent-loop.mjs:153` `agentLoop`:
   - **a.** `getAbortCtrl()` → cancel any prior run, install fresh `AbortController`.
   - **b.** `genId()` → mint session id, `sessionDb.saveSession(...)` placeholder.
   - **c.** `hookManager.initHookManager(getWorkspace())` reload hooks config.
   - **d.** Build user message (text + inline file parts for images, base64-decoded text for files).
   - **e.** First turn only: `buildSystemPrompt(...)` produces `sysContent` + `contextBlock`; checks `TOKEN_BUDGET_WARN`/`TOKEN_BUDGET_HARD`; caches both.
   - **f.** Build dynamic context block on top of cached base: active tasks, todos, AI-selected memories via `selectRelevantMemories(prompt, apiKey, apiUrl, model, apiFormat)`.
   - **g.** Short-reply anchor: if prompt < 80 chars and history exists, prepend the last assistant turn to user message (prevents memory interference).
   - **h.** Assemble message array: `[system, ctx_base, ...history, ...contextExtras, userMessage]`.
   - **i.** `compressContext(msgs)` then `sendContextUsage(msgs)`.
5. Continuation loop (`while (continuation < MAX_CONTINUATIONS && !agentFinished)`):
   1. Inner turn loop (`while (turns < MAX_TURNS)`):
      - `compressContext(msgs)`; if `contextPct > CONTEXT_COMPRESS_PCT` (90%), break to continuation.
      - `sendContextUsage(msgs)`.
      - Call `openaiCall` / `anthropicCall` (stream SSE; parse tool-call accumulator; emit `stream:chunk`/`stream:reasoning`/`stream:metrics`).
      - If `err.name === "AbortError"`, fire `SessionEnd{aborted:true}` hook and return.
      - Push assistant message to `msgs`.
      - If no tool calls → `agentFinished = true`; break.
      - Separate `Agent` (sub-agent) calls from other tool calls.
      - `Agent` calls run in **parallel via `Promise.allSettled`** (`agent-loop.mjs:409`).
      - Other tools run **sequentially**.
      - Each result is wrapped in `{ role: "tool", tool_call_id, content }` and appended to `msgs`.
      - `PreToolUse` hook fires before each tool; `PostToolUse` hook fires after.
   2. If not finished, `summarizeForContinuation(msgs, ...)` → re-anchor as `[sys, summary, recent6, ctx]`, continue.
6. After loop: `hist.push(userMsg, assistantMsg)`.
7. If `hist.length > 40` → AI-driven session compression (split old/recent, save as `parentId_c<ts>`, keep recent only).
8. `saveSession(...)` (fire-and-forget).
9. `hookManager.fire("SessionEnd", { sessionId, aborted:false })`.
10. `autoReview(msgs, ...)` (fire-and-forget) — extracts PREFERENCE/DECISION/KNOWLEDGE and appends to memory.

### 3. Tool dispatch (in-process)
1. `runTool(tc)` at `desktop/core/tool-executor.mjs:181`.
2. Plan-mode block check (`tool-executor.mjs:187`).
3. `hookManager.fire("PreToolUse", { tool: name, args })` — returns `{ blocked, modified, args }` or `null`.
4. Switch over `name`:
   - `bash` → `isDangerous` check (`tool-executor.mjs:32`) → `requestPermission` for dangerous commands → `runShell(args.command)` (PowerShell on Windows / `bash -c` on POSIX).
   - `file_read` / `file_write` / `file_edit` → direct `node:fs/promises`.
   - `grep` / `glob` → cross-platform shell pipeline (PowerShell `Get-ChildItem | Select-String` / `find … -name`).
   - `web_fetch` → `isSafeUrl` URL allowlist (no localhost/private IPs) → `fetch` + HTML strip.
   - `web_search` → Tavily (paid) or `searchMeta(query, max)` (free meta-search).
   - `skill` / `invoke_skill` / `create_skill` → skills store.
   - `write_memory` / `memory_search` → memory store.
   - `TaskCreate` / `TaskUpdate` / `TaskList` / `TodoWrite` → mutate `taskStore` / `_todoList` in `state.mjs`.
   - `Agent` → `sub-agent.mjs:17` `runSubAgent` (recursive child loop with its own LLM call, separate AbortController, up to `SUB_AGENT_MAX_TURNS=12`).
   - `AskUserQuestion` → returns a Promise that resolves when the renderer posts via `ask:respond` (or 120 s timeout).
   - `kb_search` / `kb_write` / `kb_get_note` → knowledge-store.
   - `lsp` → lsp-manager (lazy `import("../lsp-manager.mjs")`).
   - `git_diff` / `git_commit` / `git_branch` → shell out to `git`.
   - `gh_pr` / `gh_issue` / `gh_repo` → shell out to `gh`.
   - default → `mcpManager.callTool(name, args)`.

### 4. Sub-agent flow
1. Parent calls `Agent` tool → `runSubAgent(description, prompt, subAgentId)` (`sub-agent.mjs:17`).
2. Registers AbortController in `_subAgentCtrls` (so `query:abort` can stop all children).
3. Filters `getAllToolDefs()` to `SUB_AGENT_TOOL_NAMES` (read-only-leaning subset).
4. Streams LLM response (OpenAI or Anthropic) up to `SUB_AGENT_MAX_TURNS=12` iterations.
5. For each turn, dispatches tools via `runTool` (same dispatch as parent).
6. Returns final text. Parent pushes result as `{ role: "tool", tool_call_id, content }`.

### 5. Session persistence
- `sessionDb.saveSession` writes to SQLite (`session-db.mjs`).
- `sessionDb.searchMessages(query, limit)` — used by `buildSystemPrompt` to surface past conversations matching the current prompt (episodic memory).
- `sessionDb.getRecentSessions(n, max_per, excludeId)` — used to inject recent sessions into context block.
- `sessionDb.exportSession(id)` — Markdown export.

### 6. Memory persistence
- `memory.readUserMemory` / `writeUserMemory` / `appendUserMemory` — markdown file at `~/.aideagent/memories/USER.md`.
- `memory.readProjectMemory` / `appendProjectMemory` — at workspace root.
- `memory.listMemories` / `readMemory(filename)` / `createMemory` / `updateMemory` / `deleteMemory` — multi-file memory per workspace.
- `memory.rebuildIndex()` — keyword index for `memory.search(query)`.
- `memory.checkDuplicate(type, content)` — prevents near-duplicate memory writes.

### 7. Knowledge-base (Obsidian vault) flow
- `kb.setVault(path)` records vault path; `kb.rebuildIndex()` walks vault and indexes notes.
- `kb.search(query, limit)` — embed-and-search using `all-MiNI` from `desktop/models/all-MiniLM-L6-v2/`.
- `buildSystemPrompt` injects `<knowledge-base>` block when `kbEnabled && kb.getVault()`.
- `kb_search` / `kb_write` / `kb_get_note` tools give the agent runtime access.

### 8. Permission flow (dangerous shell commands)
1. `runTool("bash")` checks `isDangerous(cmd)` (`tool-executor.mjs:32`).
2. `requestPermission(cmd)` → `nextPermId()` → push to `pendingPerms` map → send `permission:request` to renderer.
3. Renderer shows modal, user clicks Allow/Deny.
4. Renderer calls `window.aideagent.respondPermission(id, allow)` → preload `permission:respond` → `ipcMain.handle("permission:respond", ...)` resolves the pending Promise.
5. If denied, returns `{ error: "User denied this command" }`.

### 9. State management
- All mutable cross-module state lives in `desktop/core/state.mjs` and is exported as `let`s with paired `getX`/`setX` functions (`getSessionId`/`setSessionId`, `getHistory`/`setHistory`, `getAbortCtrl`/`setAbortCtrl`, `getWorkspace`/`setWorkspace`, `getPlanMode`/`setPlanMode`, `getWxBotToken`/`setWxBotToken`, etc.).
- Maps for resolver/permit tracking: `pendingPerms`, `_askResolvers`, `_subAgentCtrls`, `_surfacedMemories`.
- `taskStore: Map<id, task>` for Claude-style task tracking.
- `_sysPromptCache` / `_contextBlockBaseCache` (private to `agent-loop.mjs`) cached between turns for prompt-cache hits.
- `_cachedToolDefs` / `_cachedToolKey` (private to `format-adapters.mjs`) cached by `${kbEnabled}|${webSearchEnabled}|${planMode}`.

## Key Abstractions

**AgentLoop (`desktop/core/agent-loop.mjs:153` `agentLoop`)**
- Purpose: The single coroutine that runs one user turn from prompt to final assistant message, including multiple LLM calls and recursive tool dispatches.
- Examples: `desktop/core/agent-loop.mjs:153`
- Pattern: Turn-loop coroutine. Outer loop is `continuation` (max `MAX_CONTINUATIONS=5`); inner loop is `turns` (max `MAX_TURNS=50`); each iteration runs one LLM call and dispatches any returned tools.

**ToolExecutor (`desktop/core/tool-executor.mjs:181` `runTool`)**
- Purpose: Single switch over all builtin tool names, plus MCP fallback for unknown tools.
- Examples: `desktop/core/tool-executor.mjs:181`
- Pattern: Dispatch table + plugin (MCP). Plan-mode enforcement at `tool-executor.mjs:187`, PreToolUse hook at `:200`, returns `Promise<any>` with shape `{ error }` or tool-specific result.

**SubAgent (`desktop/core/sub-agent.mjs:17` `runSubAgent`)**
- Purpose: Recursive child agent with its own LLM loop and a filtered toolset (`SUB_AGENT_TOOL_NAMES`).
- Examples: `desktop/core/sub-agent.mjs:17`
- Pattern: Recursive agent; bounded by `SUB_AGENT_MAX_TURNS=12`; tracked by `_subAgentCtrls` so abort propagates.

**BuildSystemPrompt (`desktop/core/system-prompt.mjs:177`)**
- Purpose: Compose the static system prompt and a dynamic context block (KB hits, episodic memories, recent sessions).
- Examples: `desktop/core/system-prompt.mjs:177`
- Pattern: Pure function over current workspace/skills/KB state; cacheable result (held in `_sysPromptCache` / `_contextBlockBaseCache` for prompt-cache reuse).

**MemoryStore (`desktop/memory-store.mjs`)**
- Purpose: Multi-file markdown memory + keyword index.
- Examples: `readUserMemory` / `writeUserMemory` / `appendUserMemory` / `listMemories` / `createMemory` / `updateMemory` / `deleteMemory` / `searchMemory` / `checkDuplicate` / `memoryFreshnessNote` / `memoryAgeDays` / `rebuildIndex`.
- Pattern: File-backed document store with duplicate detection.

**KnowledgeStore (`desktop/knowledge-store.mjs`)**
- Purpose: Obsidian-vault indexer and embed-based search using the bundled ONNX `all-MiniLM-L6-v2` model.
- Examples: `getVault` / `setVault` / `rebuildIndex` / `search` / `getNote` / `createNote` / `updateNote` / `listOllamaModels`.
- Pattern: Vector index over user-chosen vault directory.

**SkillsStore (`desktop/skills-store.mjs`)**
- Purpose: L2 skills registry (curated, versioned, with curator that archives stale skills).
- Examples: `listSkills` / `loadSkill` / `saveSkill` / `recordSkillUsage` / `detectPatterns` / `runCurator` / `generateSkill` / `buildSkillsContext`.
- Pattern: Single-source JSON store + curator background job.

**SkillScanner (`desktop/core/skill-scanner.mjs:44` `scanSkills`)**
- Purpose: Discover L3 skills on disk by walking `~/.agents/skills`, `~/.agents`, `~/.claude/skills` and parsing each `SKILL.md` front-matter.
- Examples: `desktop/core/skill-scanner.mjs:44`
- Pattern: Filesystem scanner with YAML front-matter parser.

**FormatAdapters (`desktop/core/format-adapters.mjs`)**
- Purpose: Stream-parsing LLM API clients for OpenAI and Anthropic wire formats.
- Examples: `openaiCall` / `anthropicCall` / `toAnthropicTools` / `toAnthropicMessages` / `getAllToolDefs` / `invalidateToolDefsCache`.
- Pattern: Streaming SSE reader + tool-call accumulator.

**HookManager (`desktop/core/hook-manager.mjs`)**
- Purpose: User-defined external scripts that run before/after tool calls and at session end.
- Examples: `initHookManager` / `fire("PreToolUse", ...)` / `fire("PostToolUse", ...)` / `fire("SessionEnd", ...)`.
- Pattern: JSON-config + child-process runner with safe-path validation.

**SessionDB (`desktop/session-db.mjs`)**
- Purpose: SQLite-backed session history with full-text search and Markdown export.
- Examples: `saveSession` / `loadSession` / `listSessions` / `searchMessages` / `getRecentSessions` / `exportSession` / `deleteSession` / `forceCheckpoint` / `migrateFromJson`.
- Pattern: Embedded database with periodic checkpointing.

**MCPManager (`desktop/mcp-manager.mjs`)**
- Purpose: Model Context Protocol server lifecycle and tool dispatch.
- Examples: `init` / `listServers` / `addServer` / `removeServer` / `restartServer` / `callTool` / `listAllToolDefs` / `toggleBuiltin` / `getBuiltins`.
- Pattern: Subprocess supervisor + JSON-RPC bridge.

**LSPManager (`desktop/lsp-manager.mjs`)**
- Purpose: Language Server Protocol for code intelligence (go-to-def, references, hover, document symbols).
- Examples: `goToDefinition` / `findReferences` / `hover` / `documentSymbol` / `shutdown`.
- Pattern: Per-language server lifecycle manager.

**IPC Handlers (`desktop/core/ipc-handlers.mjs`)**
- Purpose: Single file that registers all ~70 `ipcMain.handle` channels.
- Examples: `desktop/core/ipc-handlers.mjs`
- Pattern: Thin routing layer; delegates to stores and runtime modules.

**Preload Bridge (`desktop/preload.cjs`)**
- Purpose: Only legal renderer → main surface; exposes `window.aideagent`.
- Examples: `desktop/preload.cjs`
- Pattern: `contextBridge.exposeInMainWorld("aideagent", {...})` with paired `invoke`/`on` wrappers.

**Renderer's `app.js`**
- Purpose: 2078-line UI monolith; explicitly self-documented as pending refactor.
- Examples: `desktop/renderer/app.js`
- Pattern: Imperative DOM + delegated module init; sub-modules are imported as side effects (`import './modules/font-settings.mjs'`) and as factories (`initKnowledgeBase`, `initMemoryPanel`, etc.).

## Entry Points

**Main process entry: `desktop/main.mjs:1`**
- Electron app entry. Defines `createWindow()`, runs migration, inits MCP/sessions/skills, registers IPC + WeChat, schedules curator.

**Preload entry: `desktop/preload.cjs:1`**
- Preload script for the renderer; `contextBridge.exposeInMainWorld("aideagent", {...})`. All renderer → main IPC routed here.

**Renderer entry: `desktop/renderer/index.html`**
- Loaded by `main.mjs:72` `mainWindow.loadFile(join(PROJECT_ROOT, "renderer", "index.html"))`. Loads `app.js` which wires DOM modules.

**Agent runtime entry: `desktop/core/agent-loop.mjs:153` `agentLoop(...)`**
- Called by `desktop/core/ipc-handlers.mjs:51` `agentLoop(...)` inside the `query:submit` handler. This is the request/response entry; all push events during the run are emitted by the loop itself.

**IPC registration entry: `desktop/core/ipc-handlers.mjs:45` `registerIpcHandlers()`**
- Single registration call from `main.mjs:141`.

**Update entry: `desktop/update-manager.mjs:initUpdateManager(window)`**
- Called from `main.mjs:79` after window creation.

## Error Handling

**Strategy:** Each tool returns `{ error: string }` on failure; the agent loop surfaces these to the LLM so it can adapt. Network failures propagate as thrown errors caught at the IPC boundary.

**Patterns:**
- **Tools return error objects, not throws.** `runTool` returns `{ error: e.message }`; agent loop pushes these as `{ role: "tool", tool_call_id, content: JSON.stringify({error:...}) }` so the LLM sees the failure and can retry.
- **AbortError is the universal cancel signal.** `agent-loop.mjs:384` translates `AbortError` into `{ text: allText, aborted: true }` and fires `SessionEnd{aborted:true}`. `query:abort` IPC handler at `ipc-handlers.mjs:56` aborts the main `AbortController` and every sub-agent controller in `_subAgentCtrls`.
- **Cross-platform shell errors caught.** `runShell` resolves with `{ out, err, code }` or `{ error }`; never rejects. `runPowerShell` is a backward-compat alias.
- **Permission flow uses Promise resolvers.** `requestPermission` returns a Promise that the renderer resolves by clicking the modal; the map `pendingPerms` is the registry.
- **`AskUserQuestion` is a Promise + 120 s timeout.** `tool-executor.mjs:487` returns a Promise that resolves when the renderer posts `ask:respond` or after 120 s with `{ answers: {}, timed_out: true }`.
- **Hook errors default to "allow".** `tool-executor.mjs:200` runs PreToolUse; null/missing decision means allow. Only `{ decision: "block" }` blocks. `onError: "block"` opts in to blocking on hook failure.
- **Plan-mode is enforced at three layers:** tool registry (`PLAN_MODE_READONLY`), `getAllToolDefs` cache key, and `runTool` early return. Even an MCP tool that returns the same name will be checked.
- **Test-mode short-circuits heavy subsystems.** `AIDEAGENT_TEST_MODE=1` skips MCP init and WeChat autostart (`main.mjs:117`).
- **API key encryption via `safeStorage`.** `ipc-handlers.mjs:515-568` uses Electron `safeStorage.encryptString` to store API keys at `~/.aideagent/api-keys.enc`; falls back to plaintext if encryption is unavailable.

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` / `console.error` with bracketed prefixes (`[main]`, `[agent-loop]`, `[memory]`, `[curator]`, `[mcp]`, `[plan-mode]`, `[sub-agent]`, `[auto-review]`, `[compression]`, etc.). No structured logger.

**Validation:** `isDangerous(cmd)` regex allowlist for shell; `isSafeUrl(url)` URL allowlist for `web_fetch`; `checkDuplicate` for memory writes; path-traversal guard in `hook-manager.mjs:safeScriptPath`.

**Authentication:** API key storage via Electron `safeStorage` (`ipc-handlers.mjs:515`); keys never written in plaintext. WeChat bot uses iLink token + per-request `X-WECHAT-UIN` random ID. No app-level login.

**Permissions:** `pendingPerms` map + `permId` counter; `permission:request` event → renderer modal → `permission:respond`.

**CORS:** `main.mjs:105` adds permissive CORS headers to all responses (custom API endpoints).

**Sandbox:** `no-sandbox` command-line flag in `main.mjs:18`; `sandbox: false` in BrowserWindow webPreferences (renderer runs with full Node via preload). Justified for local-only desktop app.

**Workspace model:** Single workspace at a time, persisted in `<userData>/workspace-config.json`, overridden by `setWorkspace` whenever user picks via `workspace:pick` modal or `workspace:set` IPC. All tools default `cwd` to `getWorkspace()`.

---

*Architecture analysis: 2026-06-08*