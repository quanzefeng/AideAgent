# Coding Conventions

**Analysis Date:** 2026-06-08

## Language & Module System

- **Primary language:** JavaScript (`.mjs` for ESM, `.cjs` for CJS).
- **TypeScript config exists** (`desktop/tsconfig.json`) but is used purely for JSDoc type-checking (`"checkJs": true`-style), not source files. Almost all code is plain JS.
- **Module system:** ESM throughout. `desktop/package.json` declares `"type": "module"`.
- **CJS exception:** `desktop/preload.cjs` is the only CJS file — required because Electron's preload runs in a Node CJS context and must use `require()`.
- **Renderer modules:** `desktop/renderer/modules/*.mjs` are loaded in the browser context; `desktop/renderer/translations.js` is plain JS and uses `import` (ESM-compatible `.js`).

## Import Style

**ESM (`.mjs`):**
```javascript
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import mcpManager from "../mcp-manager.mjs";
import * as memory from "../memory-store.mjs";
import { buildSystemPrompt } from "./system-prompt.mjs";
```

**Conventions observed:**
- Node built-ins: prefer `node:fs`, `node:path`, `node:url`, `node:sqlite` (`node:` prefix), but some files use the bare names (`"fs"`, `"path"`, `"os"`) — both styles coexist, the `node:` prefix is preferred in `core/` modules.
- Local imports: always include `.mjs` extension (required for native ESM).
- Namespace imports (`import * as foo`) used for stores and shared state modules: `import * as memory from "../memory-store.mjs"`, `import * as hookManager from "./hook-manager.mjs"`.
- Circular-dependency avoidance: lazy `await import(...)` inside a getter — see `desktop/core/tool-executor.mjs` lines 142–170 (e.g. `getRunSubAgent`, `getLoadWxConfig`).

**CJS (`preload.cjs`):**
```javascript
const { contextBridge, ipcRenderer } = require("electron");
```

## Naming

**Files:**
- `kebab-case.mjs` (e.g. `agent-loop.mjs`, `tool-executor.mjs`, `memory-store.mjs`, `format-adapters.mjs`).
- One exception: `main.mjs` (root entry) is single-word.
- `desktop/tsconfig.json` exists for type-checking; no `.ts` source files.

**Functions:**
- `camelCase`: `runTool`, `listMemories`, `selectRelevantMemories`, `parseFrontMatter`, `appendUserMemory`.
- Exported helpers in stores: short verb-form — `listSkills`, `readMemory`, `createMemory`, `updateMemory`, `deleteMemory`, `searchMemory`.

**Variables:**
- `camelCase` for locals, parameters, and module-level mutable state.
- Module-level constants: `UPPER_SNAKE_CASE` — `MAX_OUTPUT`, `CONTEXT_WINDOW`, `PLAN_MODE_READONLY`, `SUB_AGENT_TOOL_NAMES`, `IS_WINDOWS`, `PS_EXE`, `DANGEROUS`, `GIT_SAFE`, `GH_SAFE`, `MAX_TURNS`, `MAX_CONTINUATIONS`.
- Private module-level state: leading underscore (`_sysPromptCache`, `_ftsDb`, `_vaultPath`, `_runSubAgent`, `_cachedToolDefs`).

**Types / TypeScript-only:**
- Type casts use JSDoc `/** @type {T} */` syntax: `/** @type {AbortController | null} */ (getAbortCtrl())`.
- Inline callback types: `/** @param {{role:string,content:any}} m */`.

**Classes:** No classes used in main process. Everything is functional / module-level. No `class` keyword observed in the explored files.

## Async Patterns

**Dominant style:** `async`/`await` for top-level functions, `new Promise((resolve) => ...)` for low-level callbacks (spawn, IPC).

```javascript
export async function agentLoop(prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], ...) {
  // ...
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
  // ...
}

function runShell(command, opts = {}) {
  return new Promise(resolve => {
    try {
      const child = spawn(SHELL.exe, args, { cwd: getWorkspace(), shell: false, timeout: opts.timeout || 60000 });
      // ...
      child.on("close", code => resolve({ out, err, code }));
      child.on("error", e => resolve({ error: e.message }));
    } catch (e) { resolve({ error: e.message }); }
  });
}
```

**`.then()` is rare.** Almost all observed code uses `await`. Promise constructor is only used for event-style APIs (spawn events, IPC).

**Abort signal pattern:** `AbortController` is shared via `core/state.mjs` (`getAbortCtrl` / `setAbortCtrl`) and passed to `fetch` via `signal`. Hard timeouts also use `AbortSignal.timeout(20000)` and `AbortSignal.timeout(15000)` directly.

## Error Handling

**Strategy:** Catch-and-log at boundaries, do not throw across module boundaries. Tool handlers return `{ error: "..." }` shapes; main flow treats errors as data.

**Patterns observed:**

1. **Top-level fire-and-forget with `try { ... } catch { /* ignored */ }`** — used liberally for non-critical writes (FTS sync, index updates, config writes). See `memory-store.mjs` `ftsInsert`, `writeIndex`, `addToIndex`.

2. **`try { ... } catch (e) { console.error(...) }` for important background tasks** — see `agent-loop.mjs` `autoReview`, `memory-selection.mjs` semantic selection:
   ```javascript
   } catch (/** @type {any} */ e) {
     console.error("[memory] semantic selection failed:", e.message);
   }
   ```
   Errors are logged with a `[module-name]` tag prefix and `e.message` (never the full stack).

3. **Returned result objects with `ok` flag for IPC-shaped operations**:
   ```javascript
   /** @returns {{ ok: boolean, filename?: string, name?: string, error?: string }} */
   export function createMemory(name, description, type, body) { ... }
   export function deleteMemory(filename) { ... return { ok: true }; }
   ```

4. **Error objects embedded in tool results**:
   ```javascript
   return { error: `🚫 计划模式下禁止执行 "${name}" 操作。...` };
   ```

5. **Silent fallbacks for FTS/DB unavailable**: `try { db.prepare(...).all(...) } catch { return db.prepare("SELECT ... LIKE ?")...all(...); }` — `searchMemory` in `memory-store.mjs`.

**Note:** Almost no use of custom Error subclasses or `throw new Error(...)` in main process; the codebase prefers error-as-data.

## Logging

**Framework:** Plain `console.log` / `console.error` — no structured logger.

**Style:**
- Bracketed module tag prefix: `[main]`, `[auto-review]`, `[memory]`, `[plan-mode]`, `[skills-store]`, `[memory-store]`.
- Log lines are short and human-readable, often including count or state:
  ```javascript
  console.log("[auto-review] Saved learnings:", lines.length, "items");
  console.log("[main] window.aideagent available in renderer:", hasAPI);
  console.log("[plan-mode] getAllToolDefs planMode =", planMode, "builtins =", builtins.length, "mcp =", mcpDefs.length);
  ```
- Errors include `e.message` only (no stack):
  ```javascript
  console.error("[main] PRELOAD ERROR:", preloadPath, error.message);
  ```

**No log levels** (no warn/info/debug distinction) — code uses `console.log` for "things happened" and `console.error` for failures.

## Code Style

**Formatting:** No Prettier config detected. Inferred from code: 2-space indent, single quotes, no semicolons in statements that begin with `(`, `return`, etc. — but mostly standard semicolons. `desktop/eslint.config.js` uses `@eslint/js` recommended rules only, no stylistic rules.

**Linting:** ESLint 10 with `@eslint/js` recommended preset (`desktop/eslint.config.js`):
- Ignored dirs: `node_modules`, `release`, `dist`, `renderer/**`, `test/**`, plus `check-*.mjs` and `test-*.mjs` patterns.
- Strict rules: `no-undef: error`, `no-unused-vars: warn`, `no-constant-condition: warn`, `no-empty: warn`, `no-useless-escape: warn`, `no-useless-assignment: warn`.
- Globals whitelisted explicitly: `console`, `process`, `fetch`, `AbortController`, `Buffer`, `URL`, etc.
- `ecmaVersion: 2022`, `sourceType: "module"`.

## Comments & Documentation

**JSDoc usage:** High. Every public exported function has a JSDoc block with `@param` and `@returns`. Internal helpers often have at least a one-line JSDoc.

```javascript
/**
 * @param {string} filename
 * @returns {{ filename: string, name: string; description: string; type: string; body: string } | null}
 */
export function readMemory(filename) { ... }
```

**Type annotations on locals:** Common — JSDoc cast on next line:
```javascript
/** @type {string | null} */
let _sysPromptCache = null;
/** @type {Record<string,string>} */
const headers = apiFormat === "anthropic" ? { ... } : { ... };
```

**Section banners:** `// ── Section Name ────────────────────────────────` divider comments are used heavily to split files into logical sections (e.g. `// ── FTS5 ──`, `// ── Frontmatter ──`, `// ── Migration from old format ──`).

**Inline comments:** Medium density. Used to explain "why" not "what":
```javascript
// Take last 8 exchanges (16 messages) for review
// Cached auto-detected limit (computed in getEmbedder when provider is ollama)
```

**Language:** Bilingual (Chinese + English) is the norm in comments, prompts, and JSDoc descriptions. User-facing strings (prompts, error messages) are mostly Chinese.

## Module Design

**Exports:**
- Named exports dominate (`export function listMemories()`, `export async function runTool()`).
- Re-export pattern: `desktop/core/tool-executor.mjs` does `export { runShell, isDangerous, requestPermission };` to expose helpers beyond the main `runTool`.
- Default export for singleton stores: `export default mcpManager` in `desktop/mcp-manager.mjs`, `export default sessionDb` in `desktop/session-db.mjs`.

**No barrel files** (`index.mjs` is used as a real module, not a re-export shim — see `desktop/search-engine/index.mjs`).

**Module-private state:** Stored in module-level `let` declarations (e.g. `let _ftsDb = null;`). Exported via accessor functions when needed: `getWorkspace`, `getPlanMode`, `getAbortCtrl`. This pattern is concentrated in `desktop/core/state.mjs`.

## Function Design

**Parameter style:** Long positional parameter lists are common for orchestration functions:
```javascript
export async function agentLoop(
  prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [],
  enabledSkills, reasoning = true, agentName, kbEnabled = false,
  isPlanMode = false, webSearchEnabled = true, silent = false
)
```
This is a known anti-pattern but is consistent across the codebase. Refactors should use a single options-object parameter.

**Returns:**
- Pure functions: primitives, arrays, or simple objects.
- Mutating operations: `{ ok: boolean, error?: string, ... }` shape.
- Tool results: `{ content: string }`, `{ error: string }`, or structured data — `runTool` callers must handle both shapes.

**Default values:** Function-signature defaults, e.g. `apiFormat = "openai"`, `reasoning = true`, `kbEnabled = false`, `webSearchEnabled = true`. No destructured defaults.

## Path Aliases

**No path aliases.** All imports use relative paths (`./`, `../`) with explicit `.mjs` extensions. Path resolution from `desktop/core/agent-loop.mjs` to `desktop/session-db.mjs` is `../session-db.mjs`.

## Constants Reference

| Location | Constant | Purpose |
|---|---|---|
| `core/state.mjs` | `MAX_OUTPUT`, `MAX_TURNS`, `MAX_CONTINUATIONS` | Loop/output caps |
| `core/state.mjs` | `CONTEXT_WINDOW`, `CONTEXT_COMPRESS_PCT` | Token management |
| `core/state.mjs` | `DANGEROUS`, `GIT_SAFE`, `GH_SAFE` | Command-allow/deny regex |
| `core/state.mjs` | `PLAN_MODE_READONLY`, `SUB_AGENT_TOOL_NAMES` | Tool gating |
| `core/state.mjs` | `SHELL`, `IS_WINDOWS`, `PS_EXE` | Cross-platform shell |
| `core/state.mjs` | `TOKEN_BUDGET_WARN`, `TOKEN_BUDGET_HARD` | Token thresholds |

## Summary of Prescriptive Guidelines

When writing new code in this repo:

1. **Use `.mjs` for any new file.** Reserve `.cjs` for files that must run in Electron's preload CJS context.
2. **Use `import` with explicit `.mjs` extension.** Namespace imports (`import * as x`) for store-style modules.
3. **Functions: `camelCase`.** Files: `kebab-case.mjs`. Module-level constants: `UPPER_SNAKE_CASE`. Private state: `_camelCase`.
4. **JSDoc every exported function** with `@param`/`@returns`. Add `/** @type {T} */` annotations on `let` declarations holding typed values.
5. **Async: `async/await`.** Use `new Promise` only for event-style APIs. Always handle errors — either via `try/catch` + `console.error("[module] …")` or by returning `{ ok, error }`.
6. **Errors are data, not exceptions.** Tool handlers return `{ error: "..." }`. Mutating operations return `{ ok, error? }`. Do not throw across module boundaries.
7. **Log with bracketed prefix:** `console.log("[module] event:", payload)`. Use `console.error` for failures and include `e.message`.
8. **Default values in function signature**, not destructured `opts`.
9. **No classes** — prefer module-level functions with shared state stored in `let` declarations.
10. **No barrel files, no path aliases.** Use relative paths.

---

*Convention analysis: 2026-06-08*
