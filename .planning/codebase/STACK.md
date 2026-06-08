# Stack

**Analysis Date:** 2026-06-08

## Languages

**Primary:**
- JavaScript (ESM modules, `.mjs`) — main process, core modules, renderer
- TypeScript (type-checked via `tsc --noEmit` only, not compiled) — `tsconfig.json` allows `checkJs` over JS files; JSDoc provides types
- HTML — `desktop/renderer/index.html`
- CSS — `desktop/renderer/style.css`

**Secondary:**
- CommonJS (`.cjs`) — only `desktop/preload.cjs` (Electron preload contract requires CJS in some builds)
- SQL (FTS5) — used in `node:sqlite` queries across `session-db.mjs`, `memory-store.mjs`, `knowledge-store.mjs`, `skills-store.mjs`

**Type System:** JSDoc-driven. `tsconfig.json` runs `checkJs: true` against `.mjs`/`.cjs`/`.html` files. `desktop/renderer/global.d.ts` declares ambient types for CDN libraries (`marked`, `hljs`, `katex`, `DOMPurify`).

## Runtime

**Node Version:**
- Required: `node:sqlite` (built-in module) is used throughout — requires **Node.js 22.5+** (or Electron's bundled Node 22+)
- No `engines` field in `package.json`; no `.nvmrc` or `.node-version` present — pin via Electron version (40.x) which ships Node 22

**Electron Version:**
- `electron@^40.8.0` (devDependency)
- Sandbox disabled via `ELECTRON_DISABLE_SANDBOX=1` in `start` script and `app.commandLine.appendSwitch("no-sandbox")` in `main.mjs`
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (in `webPreferences`)

**Package Manager:**
- npm (lockfile: `desktop/package-lock.json` present)
- No `pnpm-lock.yaml` or `yarn.lock`

**Module System:**
- `"type": "module"` in `desktop/package.json` — all `.mjs` files are ESM
- Preload is intentionally CJS (`preload.cjs`) for Electron compatibility
- TypeScript config: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`

## Frameworks

**Core:**
- **Electron 40.8.0** — Desktop app shell, IPC, BrowserWindow, app lifecycle, auto-updater
- **electron-builder 26.0.0** — Packaging for Windows (NSIS), macOS (DMG), Linux (deb + AppImage)
- **electron-updater 6.8.3** — Auto-update from GitHub releases (see `desktop/update-manager.mjs`)

**Renderer (No UI framework):**
- **Vanilla JavaScript** — `desktop/renderer/app.js` is a single ~2000+ line file orchestrating modules
- **ES modules** for renderer modules under `desktop/renderer/modules/`
- **CDN-loaded libraries** in `desktop/renderer/index.html`:
  - `marked` — Markdown parsing
  - `highlight.js` — Syntax highlighting
  - `KaTeX` — Math rendering
  - `DOMPurify` — HTML sanitization
- **No React / Vue / Svelte / Tailwind** — custom CSS in `style.css`

**AI / Embedding (On-device):**
- **@huggingface/transformers 4.2.0** — Local ONNX model runner for embeddings (Xenova/all-MiniLM-L6-v2, 384-dim)
- **onnxruntime-node** (transitive, unpacked from asar in `package.json` build config) — Native runtime for ONNX models
- **sharp** (transitive, unpacked from asar) — Image processing for screenshots / thumbnails

**Local LLM Servers (via OpenAI-compatible endpoint):**
- Ollama (`http://localhost:11434`) — `desktop/knowledge-store.mjs`, `desktop/renderer/app.js:53`
- LM Studio (`http://localhost:1234`) — `desktop/renderer/app.js:52`
- llama.cpp server (`http://127.0.0.1:8080`) — `desktop/renderer/app.js:49`

## Build Tools

**Compilation:** None — pure JavaScript shipped as-is (`"*.mjs"`, `"preload.cjs"`, `"renderer/**"`, `"core/**"`, `"search-engine/**"` in `package.json` build files). TypeScript is type-check-only via `tsc --noEmit`.

**Bundler:** None — no webpack/vite/esbuild/rollup. Modules loaded directly by Node and the browser.

**Packager:**
- `electron-builder@^26.0.0` — produces:
  - Windows: NSIS installer (`dist:win`)
  - macOS: DMG (`dist:mac`)
  - Linux: `.deb` + `AppImage` (`dist:linux`)
- `appId: com.aideagent.desktop`
- Publish target: GitHub releases (`"owner": "quanzefeng", "repo": "AideAgent"`)

**Native Modules (asar-unpacked):**
- `node_modules/onnxruntime-node/**`
- `node_modules/sharp/**`

**Extra Resources:**
- `../dist` → packaged as `cli-dist/` (sibling build artifact, not in this repo's `desktop/`)
- `models/` → packaged as `models/` (local ONNX model files)

**Cross-platform env vars:**
- `cross-env@^10.1.0` (devDependency) — used in `start` script for `ELECTRON_DISABLE_SANDBOX=1`

## Testing

**Unit / Integration Tests:**
- **Vitest 4.1.7** (devDependency) — `desktop/vitest.config.mjs`
  - `include: ["test/**/*.test.mjs"]`
  - `environment: "node"`
  - `testTimeout: 30000`
  - `fileParallelism: false`
  - Test files: `desktop/test/*.test.mjs` (state, format-adapters, knowledge-store, memory-store, patterns, session-db, shell-cross-platform, skill-scanner, skills-store, token-budget, features)
- Run: `npm run test` | watch: `npm run test:watch`

**E2E Tests:**
- **Playwright 1.60.0** (devDependency) — `desktop/playwright.config.mjs`
  - `testDir: "./test/e2e"`
  - Electron mode (uses bundled Chromium — no `playwright install`)
  - `fullyParallel: false`, `workers: 1` (Electron sandboxing issues)
  - `timeout: 120_000`
  - `retries: 0`
  - Reporters: `list` + `html` (output to `desktop/playwright-report/`)
  - Test files: `desktop/test/e2e/*.test.mjs` (smoke, agent-name, font-lang, kb, memory, prompt, skills)
- Run: `npm run test:e2e` | `npm run test:e2e:headed` | `npm run test:e2e -- smoke` (filter by name)

**Type Checking:**
- `npm run typecheck` → `tsc --noEmit`
- `tsconfig.json` is `strict: true`, `checkJs: true`, includes `core/**/*`, `*.mjs`, `preload.cjs`, `renderer/**/*`

**Linting:**
- **ESLint 10.4.0** (devDependency) — `desktop/eslint.config.js` (flat config)
- `@eslint/js@^10.0.1` — `js.configs.recommended`
- `ecmaVersion: 2022`, `sourceType: "module"`
- Custom rules: `no-unused-vars: warn`, `no-undef: error`, `no-constant-condition: warn`, `no-empty: warn`, `no-useless-escape: warn`, `no-useless-assignment: warn`
- Lint scope: `*.mjs core/*.mjs` (excludes `renderer/**`, `test/**`)
- Run: `npm run lint` | `npm run lint:fix`

## Key Dependencies

| Package | Version | Purpose |
|---|---|---|
| `electron` | ^40.8.0 | Desktop app runtime |
| `electron-builder` | ^26.0.0 | Multi-platform packager (win/mac/linux) |
| `electron-updater` | ^6.8.3 | Auto-update from GitHub releases |
| `@huggingface/transformers` | ^4.2.0 | Local ONNX model inference (Xenova/all-MiniLM-L6-v2 embeddings) |
| `qrcode` | ^1.5.4 | WeChat QR code generation (`desktop/core/wechat-bridge.mjs`) |
| `vitest` | ^4.1.7 | Unit/integration test runner |
| `@playwright/test` | ^1.60.0 | E2E test runner (Electron mode) |
| `typescript` | ^6.0.3 | Type checker (`tsc --noEmit`) |
| `eslint` | ^10.4.0 | Linter (flat config) |
| `@eslint/js` | ^10.0.1 | ESLint recommended ruleset |
| `cross-env` | ^10.1.0 | Cross-platform env vars in npm scripts |

**Transitive (from `package.json` build config — asar-unpacked):**
- `onnxruntime-node` — Native ONNX runtime for `@huggingface/transformers`
- `sharp` — Native image processing (likely for screenshot/image preview features)

**Built-in Node modules used heavily:**
- `node:sqlite` (`DatabaseSync`) — All persistent storage: sessions, memory, knowledge base, skills (FTS5)
- `node:child_process` (`spawn`) — MCP servers, LSP servers
- `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:url` — Filesystem and path operations
- `node:worker_threads` — Not directly used; isolation via Electron's renderer process instead

## Configuration

**Environment Variables (consumed):**
- `AIDEAGENT_TEST_MODE=1` — Skips MCP/WeChat init in `main.mjs` for fast E2E startup
- `ELECTRON_DISABLE_SANDBOX=1` — Required for Linux/macOS dev (set in `start` script)
- `TAVILY_API_KEY` — Tavily web search provider (`desktop/core/tool-executor.mjs:312`)
- Standard `GITHUB_TOKEN` / `GH_TOKEN` — For `gh` CLI subcommand execution in `core/state.mjs` (line 101: `GH_SAFE` regex whitelists safe `gh` subcommands)

**Env Var Exposure:**
- `ipcMain.handle("env:get", ...)` in `desktop/core/ipc-handlers.mjs:558` — controlled renderer access to env vars

**User Data Location:**
- `app.getPath("userData")` — Per-platform Electron user data dir
- `~/.aideagent/` — Primary config/data directory (created by all stores):
  - `knowledge.db` — Knowledge base (FTS5 + vector embeddings)
  - `sessions.db` — Session history (FTS5)
  - `memory.db` — Memory store (FTS5)
  - `skills.db` — Skills catalog (FTS5)
  - `mcp-servers.json` — MCP server config
  - `kb-config.json` — KB configuration (vault path, embedder, model)

**Migration:**
- `main.mjs:84-96` — Auto-renames legacy `~/.goodagent` → `~/.aideagent` on first launch

**Encrypted Storage:**
- `electron.safeStorage` used in `desktop/core/ipc-handlers.mjs:522-541` and `desktop/core/tool-executor.mjs:116-119` for API key persistence
- Falls back to plaintext JSON file if OS keychain unavailable

## Platform Requirements

**Development:**
- Node.js 22.5+ (for `node:sqlite` built-in)
- npm (uses `package-lock.json`)
- Windows / macOS / Linux
- Internet access for `postinstall` hook → `node scripts/download-model.mjs` (downloads ONNX embedding model from `hf-mirror.com` or `huggingface.co`)

**Production:**
- Packaged via `electron-builder`:
  - Windows: NSIS installer (icon: `icon.ico`)
  - macOS: DMG (icon: `icon.png`, category: Developer Tools)
  - Linux: `.deb` + `AppImage` (icon: `icon.png`, category: Development)
- Auto-update via GitHub releases (`https://github.com/quanzefeng/AideAgent`)

**Architecture:**
- Cross-platform (no arch-specific code in `main.mjs`)
- LSP server `cwd` set to user's workspace via `getWorkspace()` from `core/state.mjs`
- `windowsHide: true` for child processes on Windows (`lsp-manager.mjs:85`)

**Browser Compatibility (Renderer):**
- CSP set in `renderer/index.html`:
  - `default-src 'self'`
  - `script-src 'self' https://cdnjs.cloudflare.com`
  - `style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com`
  - `img-src 'self' data: blob:`
  - `connect-src https: http: ws: wss:`
- CORS headers injected for all main-session requests in `main.mjs:105-111`:
  - `access-control-allow-origin: *`
  - Allows `GET, POST, PUT, DELETE, OPTIONS`

---

*Stack analysis: 2026-06-08*
