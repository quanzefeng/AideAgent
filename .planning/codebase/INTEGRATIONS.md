# Integrations

**Analysis Date:** 2026-06-08

## LLM Providers

AideAgent is **provider-agnostic** — the user configures any OpenAI-compatible or Anthropic-compatible endpoint. Provider presets are defined in `desktop/renderer/app.js:44-54`.

**OpenAI-compatible format (default):**
- **DeepSeek** — `https://api.deepseek.com` — Default model: `deepseek-v4-flash`
  - File: `desktop/renderer/app.js:46`
- **GLM (Zhipu BigModel)** — `https://open.bigmodel.cn/api/paas/v4` — Default: `GLM-4.7-Flash`
  - File: `desktop/renderer/app.js:47`
- **Qwen (Aliyun DashScope)** — `https://dashscope.aliyuncs.com/compatible-mode/v1` — Default: `qwen-plus`
  - File: `desktop/renderer/app.js:48`
- **Custom** — User-provided URL + model — `desktop/renderer/app.js:45`

**Anthropic format:**
- **Anthropic Claude** — `https://api.anthropic.com` — Default: `claude-sonnet-4-20250514`
  - Models: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`, `claude-haiku-4.5-20250514`
  - File: `desktop/renderer/app.js:51`
- **MiniMax (third-party Anthropic-compatible)** — `https://api.minimaxi.com/anthropic` — Default: `MiniMax-M2.7`
  - File: `desktop/renderer/app.js:50`

**Local model servers (OpenAI-compatible):**
- **llama.cpp server** — `http://127.0.0.1:8080/v1` — `desktop/renderer/app.js:49`
- **LM Studio** — `http://localhost:1234/v1` — `desktop/renderer/app.js:52`
- **Ollama** — `http://localhost:11434/v1` — `desktop/renderer/app.js:53`

**API Call Adapters:**
- `desktop/core/format-adapters.mjs:112` — `openaiCall(msgs, apiUrl, apiKey, model, signal, reasoning, kbEnabled, webSearchEnabled)` — Streams OpenAI-format chat completions
- `desktop/core/format-adapters.mjs:177` — `anthropicCall(msgs, apiUrl, apiKey, model, signal, reasoning, kbEnabled, webSearchEnabled)` — Streams Anthropic `/v1/messages`
- Both support tool definitions (`tools` parameter), streaming (`stream: true`), and `max_tokens: 65536`

**Auth:**
- All API keys persisted via `electron.safeStorage` encrypted storage at `KEY_STORE_PATH` (managed in `desktop/core/ipc-handlers.mjs:522-541`)
- IPC handlers: `api-key:save`, `api-key:load`, `api-key:delete` (`desktop/preload.cjs:127-129`)

## External Services

### WeChat iLink Bot Bridge
- **Base URL:** `https://ilinkai.weixin.qq.com` — `desktop/core/state.mjs:188`
- **Bot Type:** `"3"` (iLink bot) — `desktop/core/state.mjs:189`
- **Auth Flow:** QR-code login + polling for scan/confirm
  - `get_bot_qrcode?bot_type=3` → returns `qrcode_img_content` (rendered as data URL via `qrcode` package)
  - `get_qrcode_status?qrcode=<id>` — Polled until `scanned` → `confirmed` (returns `bot_token`, `ilink_bot_id`, `ilink_user_id`)
  - Bearer token: `Authorization: Bearer <bot_token>` (header `AuthorizationType: ilink_bot_token`)
- **Custom Header:** `iLink-App-ClientVersion: 1`
- **X-WECHAT-UIN:** Random base64-encoded 32-bit number per request (anti-tracking)
- **Polling:** 45s timeout, `AbortController`-based cancellation
- **Implementation:** `desktop/core/wechat-bridge.mjs` (entire file)
- **Auto-start:** Called from `main.mjs:144` unless `AIDEAGENT_TEST_MODE=1`
- **Message Chunking:** `WX_MSG_CHUNK` constant (for splitting long responses)
- **Uses:** Forwards LLM replies to WeChat contacts as bot messages, syncs user API config to WeChat bot

### Web Search Providers

**Built-in search (no API key required):**
- `desktop/search-engine/index.mjs` — Zero-dependency meta-search engine
- **Bing** — HTML scraping (no API key)
- **GitHub API** — `https://api.github.com/search/repositories?q=<query>&per_page=<n>&sort=stars` — `desktop/search-engine/index.mjs:227`
- **Health tracking:** Source-failure backoff (`MAX_FAILURES: 3`, `BACKOFF_MS: 120_000`)
- **Cache:** 60s TTL in-memory
- **Result merging:** URL + title dedup, score normalization

**Tavily (paid, optional):**
- `https://api.tavily.com/search` — `desktop/core/tool-executor.mjs:326`
- Auth: `Bearer ${TAVILY_API_KEY}` (from `process.env.TAVILY_API_KEY` or encrypted store)
- Provider preference saved in user prefs; falls back to built-in
- Implementation: `desktop/core/tool-executor.mjs:308-337`

### GitHub API
- **Releases check:** `https://api.github.com/repos/quanzefeng/AideAgent/releases/latest` — `desktop/renderer/app.js:1956`
- **Repo search:** `https://api.github.com/search/repositories` — `desktop/search-engine/index.mjs:227`
- **Token auth:** Optional `GITHUB_TOKEN` / `GH_TOKEN` env var for `gh` CLI subcommands (whitelisted via `GH_SAFE` regex in `core/state.mjs:101`)

### HuggingFace / Model Downloads
- **Model:** `Xenova/all-MiniLM-L6-v2` (ONNX, 384-dim embeddings)
- **Download script:** `desktop/scripts/download-model.mjs` (runs as `postinstall`)
- **Mirrors (in order):**
  1. `https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main` (China)
  2. `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main` (official)
- **Files:** `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx`
- **Local path:** `desktop/models/all-MiniLM-L6-v2/`
- **Runtime loader:** `desktop/knowledge-store.mjs:329` — `await importWithTimeout("@huggingface/transformers", 15000)`

## Protocols

### MCP (Model Context Protocol)

**Manager:** `desktop/mcp-manager.mjs` (21KB, full lifecycle management)
- **Transport:** JSON-RPC 2.0 over stdio
- **Config location:** `app.getPath("userData")/mcp-servers.json` (matches Claude Code's `.mcp.json` format for migration)
- **Lifecycle:** initialize → notifications/initialized → tools/list (cache) → tools/call
- **Library:** None — raw `node:child_process.spawn` + line-buffered JSON-RPC reader

**Built-in MCP Servers (toggleable in code, `desktop/mcp-manager.mjs:22-54`):**

| Name | Command | Purpose |
|---|---|---|
| `edge-browser` | `npx -y @playwright/mcp@latest --browser msedge` | Edge browser automation via Playwright |
| `filesystem` | `npx -y @modelcontextprotocol/server-filesystem C:\ D:\` | Secure file read/write within user dirs |
| `computer-use` | `npx -y open-computer-use@0.1.52 mcp` | Desktop control (screenshots, clicks, keyboard) via accessibility APIs — **disabled by default** (`defaultEnabled: false`) |

**Quick-add helper:** `mcp:quick-add-searxng` IPC handler (`desktop/core/ipc-handlers.mjs:467-487`) — adds `mcp-searxng@latest` with `SEARXNG_URL` env var

**Remote MCP:** `mcp:add-remote` IPC handler supports adding MCP servers reachable over HTTP (URL + custom headers)

**IPC surface:** `desktop/preload.cjs:68-79` — `mcpList`, `mcpConfig`, `mcpAdd`, `mcpRemove`, `mcpRestart`, `mcpDetectLocal`, `mcpAddRemote`, `mcpSaveAll`, `mcpQuickAddSearxng`, `mcpBuiltins`, `mcpToggleBuiltin`

### LSP (Language Server Protocol)

**Manager:** `desktop/lsp-manager.mjs` (10KB, lightweight client)
- **Transport:** JSON-RPC over stdio (Content-Length framed)
- **Library:** None — custom spawn + `Content-Length:` header parser

**Supported Languages (hardcoded in `desktop/lsp-manager.mjs:38-43`):**
- `.ts` / `.tsx` / `.js` / `.jsx` → `typescript-language-server --stdio`

**Capabilities advertised:** `goToDefinition`, `findReferences`, `hover`, `documentSymbol`

**Process model:**
- One language server process per language (cached in `Map<lang, LspServer>`)
- `cwd` set to user's workspace via `getWorkspace()` from `core/state.mjs:84`
- `shell: true` for Windows command resolution
- `windowsHide: true`

**Note:** Only TypeScript/JavaScript supported. No Python/Go/Rust servers configured despite the module's comment claiming "auto-detected by file extension" — the detection table only contains TS/JS entries.

## Databases (Local — All SQLite via `node:sqlite`)

All databases use Node's built-in `node:sqlite` module (`DatabaseSync`) with **FTS5** full-text search extension.

| Database | File | Location | Tables/Schema | File |
|---|---|---|---|---|
| Sessions | `sessions.db` | `~/.aideagent/sessions.db` | `sessions`, `messages` (FTS5) | `desktop/session-db.mjs` |
| Memory | `memory.db` | `~/.aideagent/memory.db` | `user_memory`, `project_memory` (FTS5) | `desktop/memory-store.mjs` |
| Knowledge Base | `knowledge.db` | `~/.aideagent/knowledge.db` | Notes (FTS5 + vector embeddings, RRF hybrid) | `desktop/knowledge-store.mjs` |
| Skills | `skills.db` | `~/.aideagent/skills.db` | Skills catalog (FTS5) | `desktop/skills-store.mjs` |

**FTS5 Tokenization:** `fts5Normalize()` helper in `session-db.mjs:22-27` adds spaces between CJK and ASCII characters to improve Chinese/English mixed search.

**Migration:** `main.mjs:124` calls `sessionDb.migrateFromJson()` on startup to convert legacy JSON session files.

## Authentication & Identity

**No centralized auth** — the desktop app is a local-first single-user tool.

**API Key Storage:**
- `electron.safeStorage` (OS keychain — DPAPI on Windows, Keychain on macOS, libsecret on Linux)
- Encrypted blob written to `KEY_STORE_PATH`
- Plaintext JSON fallback when `safeStorage.isEncryptionAvailable()` returns false
- Implementation: `desktop/core/ipc-handlers.mjs:515-541`

**WeChat Auth:**
- QR-code based bot authentication (see WeChat section above)
- Bearer token stored in module-level state (`getWxBotToken`/`setWxBotToken` in `core/state.mjs`)

**MCP Server Auth:**
- Per-server `env` and `headers` fields in config (`mcp-servers.json`)
- Remote MCP servers can include custom HTTP headers for auth

## Monitoring & Observability

**Error Tracking:** None — no Sentry/GlitchTip/Bugsnag integration.

**Logs:** `console.log` / `console.error` to stdout (Electron main process console). Renderer logs flow through Chromium DevTools (`mainWindow.webContents.openDevTools()` in dev mode).

**Update Manager:** `desktop/update-manager.mjs` — Streams status events to renderer via IPC:
- `update:status` — checking / available / not-available / downloaded / error
- `update:progress` — `percent`, `bytesPerSecond`, `transferred`, `total`

## CI/CD & Deployment

**Hosting:** GitHub
- Repo: `https://github.com/quanzefeng/AideAgent`
- Releases: `https://github.com/quanzefeng/AideAgent/releases/latest`
- Publish target configured in `package.json:29-33`:
  ```json
  "publish": { "provider": "github", "owner": "quanzefeng", "repo": "AideAgent" }
  ```

**CI Pipeline:** None detected — no `.github/workflows/`, no `.gitlab-ci.yml`, no Jenkins config in the visible repo.

**Distribution:**
- `npm run dist:win` → Windows NSIS
- `npm run dist:mac` → macOS DMG
- `npm run dist:linux` → Linux `.deb` + AppImage
- `npm run dist:all` → all three platforms
- Auto-update via `electron-updater` reading from GitHub releases API

## Environment Configuration

**Required env vars:** None strictly required — all are user-configured via the settings UI and persisted to `~/.aideagent/`.

**Optional env vars (consumed):**
- `AIDEAGENT_TEST_MODE=1` — Skip MCP/WeChat init (E2E tests only)
- `ELECTRON_DISABLE_SANDBOX=1` — Required for Linux/macOS dev
- `TAVILY_API_KEY` — Tavily web search
- `GITHUB_TOKEN` / `GH_TOKEN` — `gh` CLI authentication
- `SEARXNG_URL` — Passed to `mcp-searxng` server (via MCP config, not main process)

**Secrets location:**
- API keys: `~/.aideagent/<provider>.key.enc` (encrypted via `safeStorage`)
- WeChat token: in-memory only (`core/state.mjs` module state)
- MCP server config: `app.getPath("userData")/mcp-servers.json` (plain JSON)
- KB config: `~/.aideagent/kb-config.json` (plain JSON, no secrets)

**`.env` files:** None present in `desktop/`. All configuration is user-driven through the renderer UI.

## Webhooks & Callbacks

**Incoming:** None — the app does not expose any HTTP server.

**Outgoing:**
- WeChat iLink API callbacks (QR login, message send) — see WeChat section
- LLM provider API calls (OpenAI / Anthropic format) — see LLM Providers section
- GitHub releases check — see GitHub API section
- HuggingFace model download — see HuggingFace section

---

*Integration audit: 2026-06-08*
