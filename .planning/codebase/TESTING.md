# Testing Patterns

**Analysis Date:** 2026-06-08

## Overview

The project uses a **two-tier testing strategy**:

1. **Vitest** for fast unit / integration tests (Node environment, no Electron).
2. **Playwright** for E2E tests that boot a real Electron app and drive the renderer.

Both run via `npm test` and `npm run test:e2e` respectively. The two suites are independent and can be run in any order.

## Unit / Integration Tests (Vitest)

### Configuration

- **Config file:** `desktop/vitest.config.mjs`
- **Framework:** Vitest 4.x (`vitest@^4.1.7` in devDependencies).
- **Environment:** `node` (no JSDOM — the tests target main-process modules only).
- **Test timeout:** 30 s.
- **File parallelism:** Disabled (`fileParallelism: false`) — tests share the user's real `~/.aideagent/` data directory and must run serially to avoid races.
- **Include pattern:** `test/**/*.test.mjs`.

```javascript
// desktop/vitest.config.mjs
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
  },
});
```

### Run Commands

```bash
npm test              # vitest run (single-shot)
npm run test:watch    # vitest (watch mode)
```

### File Location & Naming

- **Location:** `desktop/test/` (no `unit/` subdirectory — the unit tests sit directly in `test/`).
- **Naming:** `<module>.test.mjs` — same name as the module under test.
  - `desktop/test/state.test.mjs` → `desktop/core/state.mjs`
  - `desktop/test/memory-store.test.mjs` → `desktop/memory-store.mjs`
  - `desktop/test/skills-store.test.mjs` → `desktop/skills-store.mjs`
- **E2E full suites:** `desktop/test/e2e-full.test.mjs`, `desktop/test/features.test.mjs` (cross-module integration).

### File List

```
desktop/test/
├── e2e/                         # Playwright tests
│   ├── agent-name.test.mjs
│   ├── font-lang.test.mjs
│   ├── kb.test.mjs
│   ├── memory.test.mjs
│   ├── prompt.test.mjs
│   ├── skills.test.mjs
│   └── smoke.test.mjs
├── e2e-full.test.mjs            # Vitest E2E (multi-module, no Electron)
├── features.test.mjs            # Pure-function behavior tests
├── format-adapters.test.mjs
├── knowledge-store.test.mjs
├── memory-store.test.mjs
├── patterns.test.mjs
├── session-db.test.mjs
├── shell-cross-platform.test.mjs
├── skill-scanner.test.mjs
├── skills-store.test.mjs
├── state.test.mjs
└── token-budget.test.mjs
```

### Suite Organization

Standard Vitest `describe` / `it` pattern. Nested `describe` blocks group related cases (e.g. `Pure functions`, `CRUD operations`):

```javascript
// desktop/test/memory-store.test.mjs
import { describe, it, expect, afterAll } from "vitest";
import { memoryAgeDays, memoryAge, memoryFreshnessNote, listMemories, ... } from "../memory-store.mjs";

describe("Memory Store", () => {
  describe("Pure functions", () => {
    it("memoryAgeDays returns 0 for null/0", () => { ... });
    it("memoryAgeDays returns 1 for yesterday", () => { ... });
    // ...
  });

  describe("CRUD operations", () => {
    it("createMemory", () => {
      const result = createMemory("test_memory", "A test memory", "project", "Test body content");
      expect(result.ok).toBe(true);
      createdFilename = result.filename;
    });
    it("readMemory", () => { ... });
    // ...
  });
});
```

### Patterns

**Imports:** Direct ESM imports from `../<module>.mjs`. No `vi.mock()` mocking at the module boundary in the explored tests — most tests exercise real functions with real `~/.aideagent/` data.

**Setup / Teardown:** `afterAll` used to clean up resources and restore mutated state:
```javascript
afterAll(() => {
  sessionDb.close();
  if (origUser !== undefined) memory.writeUserMemory(origUser);
});
```

**Assertion style:** Verbose `expect()` chains; explicit `.toBe()`, `.toEqual()`, `.toHaveProperty()`, `.toContain()`. No fluent matchers like `toMatchObject` are used in the sampled files. Boolean flags checked with `.toBe(true)` / `.toBe(false)`.

**Multi-line expectations:** Each assertion is on its own line — no consolidated `expect` calls.

### Mocking

- **Framework:** Vitest's `vi` is imported in some tests (e.g. `shell-cross-platform.test.mjs`) but most tests in the sample **do not mock** — they exercise real modules against the real filesystem under `~/.aideagent/`.
- **When mocking occurs:** External processes (e.g. `vi.mock("node:child_process")` in `shell-cross-platform.test.mjs`).
- **What to mock:** External system calls, child processes, network, and anything that would be slow or unreliable in CI.
- **What NOT to mock:** Stores (`memory-store`, `skills-store`, `session-db`), formatters, and pure logic. Tests rely on `~/.aideagent/` being writable and clean up after themselves.

### Coverage

- **No coverage tool configured.** `vitest.config.mjs` has no `coverage` block.
- No CI-enforced coverage target.
- To view coverage, add `@vitest/coverage-v8` and run `vitest run --coverage`.

### Test Types

| Type | Location | Approach |
|---|---|---|
| **Unit (pure functions)** | `state.test.mjs`, `token-budget.test.mjs`, `format-adapters.test.mjs`, `skill-scanner.test.mjs`, `features.test.mjs` | Import, call, assert. No I/O. |
| **Integration (real stores)** | `memory-store.test.mjs`, `skills-store.test.mjs`, `knowledge-store.test.mjs`, `session-db.test.mjs`, `patterns.test.mjs`, `shell-cross-platform.test.mjs` | Real `~/.aideagent/` data; CRUD + FTS5 + SQLite. |
| **E2E (multi-module, no Electron)** | `e2e-full.test.mjs` | Combines session-db + memory + skills in one flow. |

## E2E Tests (Playwright)

### Configuration

- **Config file:** `desktop/playwright.config.mjs`
- **Framework:** `@playwright/test@^1.60.0`.
- **Test directory:** `./test/e2e`.
- **Mode:** Electron — `_electron` from Playwright is used to launch the actual `desktop/main.mjs` app.
- **Worker count:** 1 (`workers: 1`, `fullyParallel: false`) — multiple Electron instances collide on sandbox.
- **Retries:** 0.
- **Timeout:** 120 s per test (Electron cold-start + model download can take ~60 s).
- **Expect timeout:** 10 s.

```javascript
// desktop/playwright.config.mjs
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
```

### Run Commands

```bash
npm run test:e2e                 # Run all e2e (headless)
npm run test:e2e:headed          # See the Electron window
npm run test:e2e:ui              # Playwright UI mode
npm run test:e2e -- smoke        # Run tests with "smoke" in the name
```

### File List

```
desktop/test/e2e/
├── agent-name.test.mjs   # Agent / user name editor
├── font-lang.test.mjs    # Font & language settings
├── kb.test.mjs           # Knowledge base (vault) tab
├── memory.test.mjs       # Memory panel
├── prompt.test.mjs       # System prompt profiles
├── skills.test.mjs       # Skills panel
└── smoke.test.mjs        # App-launch sanity + settings/appearance flow
```

### Test Structure

Each file imports `test`, `expect`, and `_electron as electron` from `@playwright/test`. Tests use a shared launch helper defined at the top of the file:

```javascript
// desktop/test/e2e/smoke.test.mjs
import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const killApp = (app) => {
  try {
    const proc = app?.process?.();
    if (proc && !proc.killed) proc.kill("SIGKILL");
  } catch (e) { /* already exited */ }
};

const closeApp = async (app) => {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close-timeout")), 5000)
      ),
    ]);
  } catch (e) { killApp(app); }
};

const launchApp = async () => {
  const app = await electron.launch({
    args: ["."],
    env: testEnv,
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(1000);
  // Clean state — clear localStorage so persisted prefs don't leak between tests
  await window.evaluate(() => localStorage.clear());
  await window.reload();
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(500);
  return { app, window };
};
```

### Per-Test Pattern

Most tests follow this shape:

```javascript
test("memory: IPC memoryCreate and memoryListAll work", async () => {
  let app, window;
  try {
    ({ app, window } = await launchApp());
    await openMemoryTab(window);

    const testName = "test_memory_" + Date.now();
    const createResult = await window.evaluate(async ({name, body}) => {
      return await window.aideagent.memoryCreate(name, "test desc", "project", body);
    }, {name: testName, body: testBody});
    expect(createResult).toHaveProperty("filename");

    const listResult = await window.evaluate(async () => {
      return await window.aideagent.memoryListAll();
    });
    expect(Array.isArray(listResult)).toBe(true);
  } finally {
    await closeApp(app);
  }
});
```

### Patterns

**App lifecycle:** `try { ... } finally { closeApp(app); }` to guarantee the Electron process is killed even on failure. `closeApp` races a 5-second graceful close against a hard `SIGKILL`.

**Renderer IPC:** Tests call exposed `window.aideagent.*` methods directly via `window.evaluate(...)`. The `preload.cjs` bridge exposes a flat namespace — see `desktop/preload.cjs` for the full list (e.g. `memoryCreate`, `memoryListAll`, `memoryDelete`, `skillsListAll`, `kbSetVault`).

**Tab navigation helper:** Each panel test defines an `open<Panel>Tab` helper that:
1. Clicks `#settings-btn`.
2. Waits for `#settings-modal.active` to confirm the modal opened.
3. Clicks the tab: `await window.locator('#settings-modal [data-tab="<name>"]').click();`
4. Waits a fixed 400–500 ms for the tab to render.

**Localstorage cleanup:** `launchApp` calls `localStorage.clear()` then `window.reload()` so each test starts from defaults. This avoids the well-known leak where `bg-settings` reads the previous test's preset.

**Selectors:** Use stable `#id` and `[data-tab="..."]` attributes rather than CSS classes. Wait patterns use `waitForLoadState("domcontentloaded")` and `waitForTimeout(...)` (no `expect(...).toBeVisible()` polling inside `launchApp`).

**Cross-platform:** `ELECTRON_DISABLE_SANDBOX=1` is set in `testEnv` to match `npm start`. `AIDEAGENT_TEST_MODE=1` is a flag the app reads to skip slow startup paths (MCP, WeChat) so `app.close()` finishes in <5 s.

**Mocking:** No mocking in E2E. Tests use the real app, real filesystem, real IPC. The renderer's `window.aideagent` is the production bridge — tests rely on the underlying stores being functional.

### Failure Artifacts

- **Trace, screenshot, video:** Retained on failure (`retain-on-failure`) and written to `desktop/playwright-report/`.
- **HTML report:** `desktop/playwright-report/index.html` (already present in the working tree).

## Common Patterns Summary

| Concern | Unit (Vitest) | E2E (Playwright) |
|---|---|---|
| Setup | `beforeAll` / `afterAll` hooks | `launchApp()` per test |
| Cleanup | `afterAll(() => sessionDb.close())` | `try/finally closeApp(app)` |
| Async | `async/await` on async functions | `async/await` on `window.evaluate` |
| Assert | `expect(x).toBe(y)`, `.toEqual`, `.toHaveProperty` | `expect(locator).toBeVisible()`, `expect(value).toMatch()` |
| Mocking | `vi.mock(...)` for child processes | None — real app + real IPC |
| Isolation | Run serially (`fileParallelism: false`) | Run serially (`workers: 1`) |
| Data | Real `~/.aideagent/` directory | Real `~/.aideagent/` directory |
| Timeouts | 30 s test, no expect timeout | 120 s test, 10 s expect |

## How to Add New Tests

**Pure-function test (Vitest):**
1. Create `desktop/test/<module>.test.mjs`.
2. Import named functions from `../<module>.mjs`.
3. Use `describe` → nested `describe` → `it` hierarchy.
4. Keep tests deterministic — feed in fixed inputs (use `Date.now() - 86_400_000` for "yesterday" rather than computing relative dates).
5. Run `npm test` to verify.

**E2E panel test (Playwright):**
1. Create `desktop/test/e2e/<panel>.test.mjs`.
2. Copy the `testEnv` / `killApp` / `closeApp` / `launchApp` / `open<Panel>Tab` block from an existing file (e.g. `memory.test.mjs`).
3. Wrap each test body in `try { ... } finally { await closeApp(app); }`.
4. Drive the UI via `window.locator(...)` and assertions via `expect(locator).toBeVisible()`, `.toHaveCount()`, `.inputValue()`.
5. To test IPC methods, call them via `await window.evaluate(async () => await window.aideagent.<method>(...))`.
6. Run `npm run test:e2e` to verify.

---

*Testing analysis: 2026-06-08*
