# Atomic rebuildIndex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kb/indexer.mjs::rebuildIndex` interruption-safe by writing into shadow tables and atomic-swapping, with auto-cleanup on startup.

**Architecture:** Two-phase rebuild — Phase A fills 4 shadow tables (`kb_*_new`) inside per-batch transactions while the originals stay live; Phase B does a single BEGIN/COMMIT that DROPs the originals and RENAMEs the shadows. A `kb_meta` table holds the `rebuild_lock` row for concurrency control and startup recovery.

**Tech Stack:** Node.js `node:sqlite`, Vitest, existing `kb/*` modules. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-15-rebuild-atomic-design.md`

---

## File Map

| File | Role | Action |
|---|---|---|
| `kb/db.mjs` | DB singleton, schema, startup recovery | Modify: extract `SCHEMA_DDL`, add `_meta` table, add startup cleanup, add `_setDbPath` test hook |
| `kb/search.mjs` | FTS5 search + insert helpers | Modify: export `ftsInsertChunkNew` |
| `kb/indexer.mjs` | `rebuildIndex` + `reindexSingleFile` | Modify: rewrite `rebuildIndex` for two-phase swap |
| `test/rebuild-atomic.test.mjs` | Atomic-rebuild regression tests | Create |
| `test/helpers/iso-kb.mjs` | Test helper to isolate DB per test | Create |

No new runtime dependencies. Test helper is pure JS.

---

## Task 1: Extract schema DDL and add `_meta` table to `kb/db.mjs`

**Files:**
- Modify: `kb/db.mjs:42-132` (the inline `CREATE TABLE` statements)
- Modify: `kb/db.mjs:135` (return `_db`)

- [ ] **Step 1: Add the `SCHEMA_DDL` constant + `_meta` table**

In `kb/db.mjs`, replace the inline CREATE TABLE block (lines 42-132) with a constant + helper. Specifically:

After the existing `CREATE TABLE IF NOT EXISTS kb_notes (...)` block (ends at line 54), insert a new constant `SCHEMA_DDL` that holds the SQL for all four user tables (notes, chunks, fts, embeddings), then use it both for the main tables and for the shadow tables later. Concretely:

Add this near the top of the file (just before `getDb`):

```js
/**
 * Schema DDL for the four user tables. Exported so indexer.mjs can build
 * shadow tables (kb_*_new) with the exact same shape.
 *
 * Note: kb_fts uses FTS5 when available; the LIKE fallback is handled
 * separately in getDb().
 */
export const SCHEMA_DDL = {
  notes: `
    CREATE TABLE IF NOT EXISTS kb_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      title TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      word_count INTEGER DEFAULT 0,
      mtime_ms INTEGER,
      created_at TEXT,
      updated_at TEXT
    )`,
  chunks: `
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      heading TEXT DEFAULT '',
      content TEXT NOT NULL,
      FOREIGN KEY(note_id) REFERENCES kb_notes(id) ON DELETE CASCADE
    )`,
  embeddings: `
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
    )`,
  fts5: `
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      chunk_id UNINDEXED,
      heading,
      content,
      tokenize='unicode61'
    )`,
  ftsFallback: `
    CREATE TABLE IF NOT EXISTS kb_fts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER,
      heading TEXT,
      content TEXT
    )`,
};

/**
 * Internal-state lookup table. Currently used for rebuild_lock; designed
 * to be extensible (last_rebuild_at, embedding_model_version, etc.).
 */
export const META_DDL = `
  CREATE TABLE IF NOT EXISTS kb_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;
```

Then in `getDb()`, **replace** the inline CREATE TABLE statements (lines 42-132) with calls to `SCHEMA_DDL` and `META_DDL`:

```js
// ── User tables (notes, chunks, embeddings) ─────────────
_db.exec(SCHEMA_DDL.notes);
_db.exec(SCHEMA_DDL.chunks);
_db.exec(META_DDL);

// ── FTS5 with LIKE fallback ─────────────────────────────
try {
  _db.exec(SCHEMA_DDL.fts5);
  // Verify the table actually has chunk_id column (schema migration check)
  const cols = _db.prepare("PRAGMA table_info(kb_fts)").all();
  const hasChunkId = cols.some(c => String(c.name) === "chunk_id");
  if (!hasChunkId) {
    _db.exec("DROP TABLE IF EXISTS kb_fts");
    _db.exec(SCHEMA_DDL.fts5);
  }
  _hasFts5 = true;
  console.log("[kb] FTS5 available (chunk-level)");
} catch (e) {
  console.log("[kb] FTS5 not available, using LIKE search:", e.message);
  _hasFts5 = false;
  try {
    _db.exec(SCHEMA_DDL.ftsFallback);
  } catch (e2) {
    _logError("db", e2);
  }
}

_db.exec(SCHEMA_DDL.embeddings);
```

Note: the `_db.exec(SCHEMA_DDL.notes)` already has `IF NOT EXISTS` baked into the constant — that's fine, it's idempotent.

- [ ] **Step 2: Verify file still parses**

Run: `cd D:/AideAgent/desktop && node --check kb/db.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add kb/db.mjs
git commit -m "refactor(kb): extract SCHEMA_DDL constant, add kb_meta table"
```

---

## Task 2: Add startup recovery (Phase 5) to `kb/db.mjs`

**Files:**
- Modify: `kb/db.mjs` (in `getDb()`, right after PRAGMAs)

- [ ] **Step 1: Add startup cleanup block**

In `getDb()`, **after** the three PRAGMA lines (lines 36-40) and **before** any user table DDL, insert the recovery block:

```js
// ── Startup recovery: drop stale shadow tables if a previous
//    rebuild was interrupted. Safe to run on every getDb() call:
db.exec(META_DDL); // ensure kb_meta exists before we query it
try {
  const lock = db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
  if (lock) {
    db.exec("DROP TABLE IF EXISTS kb_fts_new");
    db.exec("DROP TABLE IF EXISTS kb_embeddings_new");
    db.exec("DROP TABLE IF EXISTS kb_chunks_new");
    db.exec("DROP TABLE IF EXISTS kb_notes_new");
    db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
    console.warn("[kb] cleaned up stale shadow tables from interrupted rebuild");
  }
} catch (e) {
  // kb_meta might not exist on first run; CREATE TABLE IF NOT EXISTS
  // above guarantees it does by the time we reach here, but be defensive.
  console.warn("[kb] startup recovery check skipped:", e.message);
}
```

Wait — `META_DDL` is a constant string. We're calling `db.exec(META_DDL)` inside `getDb()` which is fine because `META_DDL` has `IF NOT EXISTS`. The order should be: PRAGMAs → create `kb_meta` first → check lock → then create the user tables. **But the shadow tables are named `kb_fts_new` etc., which would not collide with `kb_fts` even if the shadow table from a previous run somehow survived — DROP IF EXISTS handles that.**

Actually, re-think: the spec says recovery drops shadow tables BEFORE any user table DDL, because we want recovery to happen before the schema migration check (`PRAGMA table_info(kb_fts)` etc.). Otherwise a half-rebuilt `kb_fts_new` could trip up the schema check (it wouldn't — it's a different table — but cleaner to recover first).

So the final order in `getDb()` is:
1. PRAGMAs
2. `META_DDL` (create `kb_meta`)
3. Recovery block (drop stale `_new` tables + clear lock)
4. User table DDLs (notes, chunks, fts, embeddings)

- [ ] **Step 2: Verify file still parses**

Run: `cd D:/AideAgent/desktop && node --check kb/db.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add kb/db.mjs
git commit -m "feat(kb): add startup recovery for interrupted rebuilds"
```

---

## Task 3: Add `_setDbPath` test hook to `kb/db.mjs`

**Files:**
- Modify: `kb/db.mjs:21-35` (singleton state + getDb)

- [ ] **Step 1: Make `DB_PATH` overridable for tests**

Replace the `_db`/`_hasFts5` block at the top of `kb/db.mjs` (lines 24-26) with:

```js
/** @type {DatabaseSync | null} */
let _db = null;
let _hasFts5 = false;
/** @type {string | null} Override DB path for tests. Null = use default. */
let _dbPathOverride = null;
```

Then replace the `_db = new DatabaseSync(DB_PATH);` line at line 35 with:

```js
_db = new DatabaseSync(_dbPathOverride || DB_PATH);
```

Then add at the bottom of the file (after `_registerLogger`):

```js
/**
 * Test-only: override the DB path. Pass null to reset to default.
 * Resets the singleton so the next getDb() call uses the new path.
 */
export function _setDbPath(path) {
  _dbPathOverride = path;
  if (_db) {
    try { _db.close(); } catch (e) { /* ignore */ }
    _db = null;
  }
  _hasFts5 = false;
}
```

- [ ] **Step 2: Verify file still parses**

Run: `cd D:/AideAgent/desktop && node --check kb/db.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add kb/db.mjs
git commit -m "test(kb): add _setDbPath hook for isolated DB testing"
```

---

## Task 4: Add `ftsInsertChunkNew` to `kb/search.mjs`

**Files:**
- Modify: `kb/search.mjs:53-62` (after the existing `ftsInsertChunk`)

- [ ] **Step 1: Add the shadow-table insert helper**

After the `ftsInsertChunk` function (ends at line 62), add:

```js
/**
 * Insert a chunk into the shadow FTS table (kb_fts_new).
 * Used exclusively by rebuildIndex's Phase 1 (shadow table writes).
 * The shadow table has the same schema as kb_fts but is renamed during
 * the atomic swap; until then it coexists with kb_fts.
 */
export function ftsInsertChunkNew(chunkId, heading, content) {
  try {
    const spacedHeading = spaceCJK(heading || "");
    getDb().prepare("INSERT INTO kb_fts_new(chunk_id, heading, content) VALUES (?,?,?)")
      .run(chunkId, spacedHeading, spaceCJK(content || ""));
  } catch (/** @type {any} */ e) {
    console.error("[kb] ftsInsertChunkNew error:", e.message);
  }
}
```

- [ ] **Step 2: Verify file still parses**

Run: `cd D:/AideAgent/desktop && node --check kb/search.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add kb/search.mjs
git commit -m "feat(kb): add ftsInsertChunkNew for shadow table writes"
```

---

## Task 5: Create the test helper for isolated KB

**Files:**
- Create: `test/helpers/iso-kb.mjs`

- [ ] **Step 1: Write the helper**

```js
/**
 * Test helper: create an isolated knowledge base backed by a temp DB.
 * Usage:
 *   const iso = await makeIsoKb({ noteFiles: { "a.md": "# a\nbody" } });
 *   // ... do work ...
 *   iso.cleanup();
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.noteFiles] - map of relative path → file content
 * @param {string} [opts.vaultDir] - override vault path (default: temp dir)
 * @returns {Promise<{vaultDir: string, dbPath: string, cleanup: () => void}>}
 */
export function makeIsoKb(opts = {}) {
  const base = opts.vaultDir || mkdtempSync(join(tmpdir(), "kb-iso-"));
  const vaultDir = join(base, "vault");
  const dbDir = join(base, "db");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });

  if (opts.noteFiles) {
    for (const [rel, content] of Object.entries(opts.noteFiles)) {
      const full = join(vaultDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
  }

  const dbPath = join(dbDir, "test.db");

  return {
    vaultDir,
    dbPath,
    cleanup() {
      try { rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
  };
}
```

- [ ] **Step 2: Verify file parses**

Run: `cd D:/AideAgent/desktop && node --check test/helpers/iso-kb.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add test/helpers/iso-kb.mjs
git commit -m "test(kb): add isolated KB helper for temp DB tests"
```

---

## Task 6: Write failing test — happy path

**Files:**
- Create: `test/rebuild-atomic.test.mjs`

- [ ] **Step 1: Write the test file with the happy-path test**

```js
/**
 * Atomic rebuildIndex regression tests.
 *
 * Covers the four scenarios from spec §10:
 *   1. Happy path — full rebuild, lock cleared, _new tables dropped
 *   2. Interrupted rebuild — startup recovery restores old state
 *   3. Concurrent rebuild — second call returns error, no corruption
 *   4. FTS swap verification — search works after rebuild
 *   5. Embedding dim tracking — dim column preserved through RENAME
 *
 * Each test uses an isolated DB (via _setDbPath) and a temp vault dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setVault } from "../knowledge-store.mjs";
import { rebuildIndex } from "../kb/indexer.mjs";
import { _setDbPath, getDb } from "../kb/db.mjs";
import { makeIsoKb } from "./helpers/iso-kb.mjs";

describe("Atomic rebuildIndex", () => {
  /** @type {ReturnType<typeof makeIsoKb>} */
  let iso;

  beforeEach(() => {
    iso = makeIsoKb({
      noteFiles: {
        "alpha.md": "# Alpha\n\nThis is the alpha note about cats and dogs.\n",
        "beta.md":  "# Beta\n\nThis is the beta note about cats specifically.\n",
        "gamma.md": "# Gamma\n\nA note about dogs running in the park.\n",
      },
    });
    _setDbPath(iso.dbPath);
    setVault(iso.vaultDir);
  });

  afterEach(() => {
    _setDbPath(null);
    iso.cleanup();
  });

  it("happy path: rebuild completes, lock cleared, _new tables dropped, FTS works", async () => {
    // ── Act ──
    /** @type {Array<{indexed:number, embedded:number, chunked:number, failed:number, total:number}>} */
    const progressEvents = [];
    const result = await rebuildIndex((p) => progressEvents.push(p));

    // ── Assert: result ──
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.indexed).toBe(3);
    expect(result.chunked).toBeGreaterThanOrEqual(3);
    expect(result.failed).toBe(0);

    // ── Assert: shadow tables dropped ──
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE '%_new'"
    ).all().map(r => r.name);
    expect(tables).toEqual([]);

    // ── Assert: lock cleared ──
    const lock = db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
    expect(lock).toBeUndefined();

    // ── Assert: progress events were emitted ──
    expect(progressEvents.length).toBeGreaterThan(0);
    const last = progressEvents[progressEvents.length - 1];
    expect(last.indexed).toBe(3);

    // ── Assert: FTS finds content that was in the new notes ──
    const { ftsSearch } = await import("../kb/search.mjs");
    const hits = ftsSearch("cats", 10);
    const hitPaths = hits.map(h => {
      const r = db.prepare("SELECT n.rel_path FROM kb_chunks c JOIN kb_notes n ON c.note_id = n.id WHERE c.id = ?").get(h.chunk_id);
      return r?.rel_path;
    });
    expect(hitPaths.filter(Boolean).sort()).toEqual(["alpha.md", "beta.md"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it FAILS**

Run: `cd D:/AideAgent/desktop && npx vitest run test/rebuild-atomic.test.mjs 2>&1 | tail -30`
Expected: FAIL with `rebuildIndex` either crashing (current impl deletes tables but doesn't recreate _new) or returning wrong shape (current impl doesn't return lock-related state).

Specifically, the test will fail because:
- Current `rebuildIndex` deletes all data upfront and writes to live tables, not `_new` tables. After the rebuild, the live `kb_notes` is empty (deleted first), then refilled. The `_new` tables were never created, so `tables` array will be `[]` for the wrong reason. But `lock` row was never inserted, so `lock === undefined` accidentally passes. The real failure will be that **the test's `beforeEach` setup needs `_setDbPath` to actually work**, and the current `db.mjs` doesn't have it (Task 3).

So the test will fail with `_setDbPath is not a function`.

- [ ] **Step 3: Confirm failure mode**

The output should reference `_setDbPath` being missing. If not, the current `rebuildIndex` may already return some unexpected shape — read the failure carefully and adjust.

- [ ] **Step 4: Do NOT commit yet**

We commit only after the test passes (Task 7).

---

## Task 7: Implement `rebuildIndex` two-phase rebuild

**Files:**
- Modify: `kb/indexer.mjs:144-262` (rewrite the entire `rebuildIndex` function body)

- [ ] **Step 1: Add imports**

At the top of `kb/indexer.mjs`, replace the `ftsInsertChunk` import (line 30) with:

```js
import { ftsInsertChunk, ftsInsertChunkNew } from "./search.mjs";
```

- [ ] **Step 2: Rewrite `rebuildIndex`**

Replace the function body (lines 144-262) with the four-phase implementation:

```js
/** @param {Function} [progressCb] @returns {Promise<{ok:boolean, indexed:number, embedded:number, chunked:number, failed:number, total:number}|{error:string}>} */
export async function rebuildIndex(progressCb) {
  const _vaultPath = getVault();
  if (!_vaultPath || !existsSync(_vaultPath)) return { error: "vault not set or not found" };

  const db = getDb();

  // ── Phase 0+1: Acquire lock + create shadow tables (single transaction) ──
  // If the INSERT raises SQLITE_CONSTRAINT_PRIMARYKEY, a rebuild is already
  // in progress — ROLLBACK the entire transaction and return.
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO kb_meta(key, value) VALUES ('rebuild_lock', ?)")
      .run(new Date().toISOString());

    // Create shadow tables with same schema as the originals.
    // Use SCHEMA_DDL.notes without IF NOT EXISTS (we want a fresh empty table).
    db.exec(`
      CREATE TABLE kb_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        title TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        word_count INTEGER DEFAULT 0,
        mtime_ms INTEGER,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE kb_chunks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        chunk_index INTEGER DEFAULT 0,
        heading TEXT DEFAULT '',
        content TEXT NOT NULL,
        FOREIGN KEY(note_id) REFERENCES kb_notes_new(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE kb_embeddings_new (
        chunk_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        dim INTEGER NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES kb_chunks_new(id) ON DELETE CASCADE
      )
    `);
    // FTS5 virtual table (or LIKE fallback if FTS5 unavailable)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE kb_fts_new USING fts5(
          chunk_id UNINDEXED,
          heading,
          content,
          tokenize='unicode61'
        )
      `);
    } catch (e) {
      // FTS5 unavailable — use LIKE fallback schema
      db.exec(`
        CREATE TABLE kb_fts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chunk_id INTEGER,
          heading TEXT,
          content TEXT
        )
      `);
    }
    db.exec("COMMIT");
  } catch (/** @type {any} */ e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (String(e.code || "").includes("CONSTRAINT") || String(e.message).includes("PRIMARY KEY")) {
      return { error: "rebuild already in progress" };
    }
    throw e;
  }

  // From here on, we MUST release the lock. try/finally ensures it.
  try {
    const notes = scanVaultInline(_vaultPath, _vaultPath);

    // ── Phase 2: Pass 1 — fill shadow tables ──────────────────────────
    /**
     * @type {Array<{noteId:number, noteTitle:string, relPath:string, chunkIndex:number, heading:string, content:string}>}
     */
    const allChunks = [];
    for (const note of notes) {
      try {
        const result = db.prepare(
          "INSERT INTO kb_notes_new(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
        ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
        const noteId = Number(result.lastInsertRowid);

        const chunks = splitIntoChunks(note.body, note.title);
        if (chunks.length === 0) {
          chunks.push({ heading: note.title, content: stripMarkdown(note.body) || "" });
        }

        for (let ci = 0; ci < chunks.length; ci++) {
          allChunks.push({
            noteId,
            noteTitle: note.title,
            relPath: note.relPath,
            chunkIndex: ci,
            heading: chunks[ci].heading,
            content: chunks[ci].content,
          });
        }
      } catch (/** @type {any} */ e) {
        console.error(`[kb] Failed to insert note ${note.relPath}:`, e.message);
      }
    }

    const max = getEffectiveMaxBodyChars();
    const insertChunk = db.prepare(
      "INSERT INTO kb_chunks_new(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
    );
    const insertEmbedding = db.prepare(
      "INSERT INTO kb_embeddings_new(chunk_id, embedding, dim) VALUES (?,?,?)"
    );

    let indexed = 0;
    let embedded = 0;
    let chunked = 0;
    let failed = 0;
    const noteIndexedSet = new Set();
    const total = notes.length;

    const t0 = Date.now();

    for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);

      const embedInputs = batch.map((c) =>
        (c.noteTitle + "\n" + c.heading + "\n" + c.content).slice(0, max)
      );

      let vectors;
      try {
        vectors = await embedBatch(embedInputs);
      } catch (/** @type {any} */ e) {
        _logError("embed", e);
        failed += batch.length;
        continue;
      }

      try {
        db.exec("BEGIN IMMEDIATE");
        for (let j = 0; j < batch.length; j++) {
          const c = batch[j];
          const vec = vectors[j];
          const chunkResult = insertChunk.run(c.noteId, c.chunkIndex, c.heading, c.content);
          const chunkId = Number(chunkResult.lastInsertRowid);
          ftsInsertChunkNew(chunkId, c.heading, c.content);
          if (vec) {
            insertEmbedding.run(chunkId, vectorToBuffer(vec), getEmbeddingDim());
            embedded++;
          } else {
            failed++;
          }
          chunked++;
          noteIndexedSet.add(c.noteId);
        }
        db.exec("COMMIT");
      } catch (/** @type {any} */ e) {
        try { db.exec("ROLLBACK"); } catch { /* ignored */ }
        _logError("db", e);
        failed += batch.length;
      }

      indexed = noteIndexedSet.size;
      if (progressCb) progressCb({ indexed, embedded, chunked, failed, total });
    }

    // ── Phase 3: atomic swap (single transaction) ─────────────────────
    // Drop originals, RENAME shadows into place. If any step fails,
    // ROLLBACK restores the originals intact.
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("DROP TABLE kb_fts");
      db.exec("ALTER TABLE kb_fts_new RENAME TO kb_fts");
      db.exec("DROP TABLE kb_embeddings");
      db.exec("ALTER TABLE kb_embeddings_new RENAME TO kb_embeddings");
      db.exec("DROP TABLE kb_chunks");
      db.exec("ALTER TABLE kb_chunks_new RENAME TO kb_chunks");
      db.exec("DROP TABLE kb_notes");
      db.exec("ALTER TABLE kb_notes_new RENAME TO kb_notes");
      db.exec("COMMIT");
    } catch (/** @type {any} */ e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      _logError("db", e);
      throw e; // re-raise so caller knows; lock will still be cleared by finally
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[kb] rebuild done: ${chunked} chunks, ${embedded} embedded, ${failed} failed in ${elapsed}s`);
    return { ok: true, indexed, embedded, chunked, failed, total };
  } finally {
    // ── Phase 4: always release the lock ──────────────────────────────
    try {
      db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
    } catch (/** @type {any} */ e) {
      console.warn("[kb] failed to release rebuild_lock:", e.message);
    }
  }
}
```

- [ ] **Step 3: Verify file parses**

Run: `cd D:/AideAgent/desktop && node --check kb/indexer.mjs && echo OK`
Expected: `OK`

- [ ] **Step 4: Run the happy-path test**

Run: `cd D:/AideAgent/desktop && npx vitest run test/rebuild-atomic.test.mjs 2>&1 | tail -25`
Expected: PASS (1 test passing)

If FAIL:
- `result.error` from rebuild → check that lock acquisition worked
- `_new tables exist` failure → check that swap ran
- `ftsSearch returns wrong rows` → check that ftsInsertChunkNew wrote to `kb_fts_new` before swap
- `embedder error` → check that `getEmbeddingDim()` returns a number (could be 0 if embedder never initialized; in that case the test should still pass because empty embeddings are skipped via `if (vec)`)

- [ ] **Step 5: Commit**

```bash
git add kb/indexer.mjs test/rebuild-atomic.test.mjs
git commit -m "feat(kb): atomic rebuildIndex via shadow tables + two-phase swap"
```

---

## Task 8: Add interruption recovery test

**Files:**
- Modify: `test/rebuild-atomic.test.mjs` (append new test inside `describe`)

- [ ] **Step 1: Append the test**

Add this inside the `describe("Atomic rebuildIndex", ...)` block, after the existing `it("happy path:...")`:

```js
  it("interrupted rebuild: startup recovery restores old state", async () => {
    // ── Setup: pre-populate the index with a known note ──
    const r1 = await rebuildIndex();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const db = getDb();
    const notesBefore = db.prepare("SELECT COUNT(*) AS c FROM kb_notes").get();
    expect(notesBefore.c).toBe(3);

    // ── Simulate interruption: manually write a stale lock + a partial
    //    kb_notes_new shadow table + a non-empty kb_chunks_new ──
    db.prepare("INSERT INTO kb_meta(key, value) VALUES ('rebuild_lock', ?)").run("stale");
    db.exec(`
      CREATE TABLE kb_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        title TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        word_count INTEGER DEFAULT 0,
        mtime_ms INTEGER,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    db.prepare(
      "INSERT INTO kb_notes_new(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run("stale.md", "stale.md", "Stale", "[]", 0, Date.now(), new Date().toISOString(), new Date().toISOString());

    // ── Act: close & reopen the DB to trigger startup recovery ──
    _setDbPath(null);  // closes the singleton
    _setDbPath(iso.dbPath); // reopens; recovery should run on next getDb()

    // ── Assert: shadow tables dropped, lock cleared ──
    const db2 = getDb();
    const staleShadow = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kb_notes_new'"
    ).get();
    expect(staleShadow).toBeUndefined();
    const lockAfter = db2.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
    expect(lockAfter).toBeUndefined();

    // ── Assert: original kb_notes is intact ──
    const notesAfter = db2.prepare("SELECT COUNT(*) AS c FROM kb_notes").get();
    expect(notesAfter.c).toBe(3);
  });
```

- [ ] **Step 2: Run and confirm PASS**

Run: `cd D:/AideAgent/desktop && npx vitest run test/rebuild-atomic.test.mjs 2>&1 | tail -15`
Expected: 2 tests passing.

- [ ] **Step 3: Commit**

```bash
git add test/rebuild-atomic.test.mjs
git commit -m "test(kb): verify startup recovery drops stale shadow tables"
```

---

## Task 9: Add concurrent rebuild test

**Files:**
- Modify: `test/rebuild-atomic.test.mjs`

- [ ] **Step 1: Append the test**

```js
  it("concurrent rebuild: second call returns error, no corruption", async () => {
    // ── Setup: pre-populate so we have something to swap ──
    const r0 = await rebuildIndex();
    expect(r0.ok).toBe(true);

    // ── Manually set the lock to simulate an in-progress rebuild ──
    const db = getDb();
    db.prepare("INSERT INTO kb_meta(key, value) VALUES ('rebuild_lock', ?)").run("fake-lock");

    // ── Act: attempt a rebuild while lock is held ──
    const result = await rebuildIndex();

    // ── Assert: returned error, didn't write anything new ──
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/in progress/i);
    }

    // Lock row is still present (the second call did NOT clear it,
    // because it bailed before the finally block ran — verify that
    // by checking: the lock that the first rebuild set should still
    // exist, untouched).
    const lock = db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
    expect(lock?.value).toBe("fake-lock");
  });
```

Note: we set the lock manually (not by starting a real concurrent rebuild) because the real-world concurrency case is impossible to test reliably without async racing. The behavior under test is: "if the lock is held, `rebuildIndex` returns an error and does nothing else."

- [ ] **Step 2: Run and confirm PASS**

Run: `cd D:/AideAgent/desktop && npx vitest run test/rebuild-atomic.test.mjs 2>&1 | tail -15`
Expected: 3 tests passing.

- [ ] **Step 3: Commit**

```bash
git add test/rebuild-atomic.test.mjs
git commit -m "test(kb): verify concurrent rebuild is rejected"
```

---

## Task 10: Add FTS-after-swap and embedding-dim tests

**Files:**
- Modify: `test/rebuild-atomic.test.mjs`

- [ ] **Step 1: Append FTS test**

```js
  it("FTS swap verification: search hits match new notes", async () => {
    // Use a vault with content that exercises CJK + multi-word FTS
    _setDbPath(null);
    iso.cleanup();
    iso = makeIsoKb({
      noteFiles: {
        "x.md": "# X\n\nThe quick brown fox jumps over the lazy dog.\n",
        "y.md": "# Y\n\nA lazy fox naps in the afternoon sun.\n",
        "z.md": "# Z\n\nTotally unrelated content here.\n",
      },
    });
    _setDbPath(iso.dbPath);
    setVault(iso.vaultDir);

    const result = await rebuildIndex();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // After atomic swap, the renamed kb_fts should contain entries
    // for all chunks of x/y/z.
    const { ftsSearch, hasFts5 } = await import("../kb/search.mjs");
    const hits = ftsSearch("fox", 10);
    const hitPaths = new Set();
    const db = getDb();
    for (const h of hits) {
      const row = db.prepare(
        "SELECT n.rel_path FROM kb_chunks c JOIN kb_notes n ON c.note_id = n.id WHERE c.id = ?"
      ).get(h.chunk_id);
      if (row) hitPaths.add(row.rel_path);
    }
    // Both x.md and y.md mention "fox"
    expect([...hitPaths].sort()).toEqual(["x.md", "y.md"]);
  });
```

- [ ] **Step 2: Append dim-tracking test**

```js
  it("embedding dim tracking: dim column preserved through RENAME", async () => {
    const { getEmbeddingDim } = await import("../kb/embedder.mjs");
    const expectedDim = getEmbeddingDim();

    const result = await rebuildIndex();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All kb_embeddings rows (post-swap) should have the current dim.
    // Note: it's normal for some chunks to have no embedding (embedder
    // returned null); the rows that DO exist must have the correct dim.
    const db = getDb();
    const sample = db.prepare("SELECT dim, COUNT(*) AS c FROM kb_embeddings GROUP BY dim").all();
    // Either: 0 embeddings (embedder offline) OR every dim equals expectedDim
    if (sample.length > 0) {
      for (const row of sample) {
        expect(row.dim).toBe(expectedDim);
      }
    }
  });
```

- [ ] **Step 3: Run all 5 tests**

Run: `cd D:/AideAgent/desktop && npx vitest run test/rebuild-atomic.test.mjs 2>&1 | tail -15`
Expected: 5 tests passing.

If the FTS test fails with "0 hits":
- Check that `ftsSearch` is looking at `kb_fts` (which after swap is the renamed `kb_fts_new`)
- Check that `ftsInsertChunkNew` was called for every chunk
- Check that `PRAGMA table_info(kb_fts)` post-rebuild shows the chunk_id column

If dim test fails:
- Likely the test ran before `getEmbeddingDim()` was initialized. Check that the embedder module is imported once and the dim is set. If dim returns 0 or undefined, the rebuild will succeed but skip embeddings; the test's `sample.length > 0` check handles that.

- [ ] **Step 4: Commit**

```bash
git add test/rebuild-atomic.test.mjs
git commit -m "test(kb): verify FTS swap and embedding dim after rebuild"
```

---

## Task 11: Full regression — run all unit tests

**Files:** none (verification step)

- [ ] **Step 1: Run the unit test suite**

Run: `cd D:/AideAgent/desktop && npx vitest run --exclude 'test/e2e/**' --exclude 'test/kb-quality.test.mjs' 2>&1 | tail -15`
Expected: All tests pass (12 + 1 new = 13 files, ~175+ tests).

The exclusions are because:
- `test/e2e/**` requires Electron
- `test/kb-quality.test.mjs` requires a live Ollama server (was flaky before our changes — see task summary)

- [ ] **Step 2: Confirm no regressions**

If any pre-existing test fails, the diff is the culprit. Read the failure carefully:
- `token-budget.test.mjs` failures → check if Phase 3 swap touches `token-budget.mjs` (it shouldn't)
- `knowledge-store-pure.test.mjs` failures → check if `SCHEMA_DDL` extraction changed the schema string (it shouldn't — DDL strings copied verbatim)
- `session-db.test.mjs` failures → unrelated; this is a different DB

- [ ] **Step 3: Final summary commit (if needed)**

If you made any fix-up commits in Steps 1-2, no further commit is needed. Otherwise, you're done.

```bash
git log --oneline -10
```

Should show: 8 new commits + the spec commit from brainstorming phase.

---

## Self-Review Notes

**Spec coverage:**
- §4.1 two-phase shape → Task 7
- §4.2 Phase 0 lock → Task 7
- §4.3 Phase 1 shadow tables → Task 7
- §4.4 Phase 2 fill shadows → Task 7
- §4.5 Phase 3 atomic swap → Task 7
- §4.6 Phase 4 lock release → Task 7
- §4.7 Phase 5 startup recovery → Task 2
- §5 kb_meta → Task 1
- §6 error matrix → covered by happy-path + concurrent test
- §7 performance → implicit (single transaction wraps 8 schema ops, well under 50ms)
- §8 files changed → matches Task 1-5 + 7-10
- §9 migration → kb_meta uses IF NOT EXISTS, no migration needed
- §10 tests → Tasks 6, 8, 9, 10 cover all 5 spec cases

**Placeholder scan:** No "TBD", "TODO", "implement later" in steps. All code blocks contain real content.

**Type consistency:**
- `_setDbPath(path)` defined Task 3, used in Task 5's helper and Task 6's test → consistent
- `ftsInsertChunkNew(chunkId, heading, content)` defined Task 4, used in Task 7 → consistent
- `kb_meta` table name used in Task 1 (DDL), Task 2 (recovery), Task 7 (lock), Task 8 (test) → consistent
- `_new` table names used uniformly across Tasks 1, 2, 7, 8 → consistent
- Error return shape `{ error: string }` for failure, `{ ok: true, ... }` for success — used in Task 7 implementation, asserted in Tasks 6, 9 → consistent
