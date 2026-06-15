# Atomic rebuildIndex — Design Spec

**Date:** 2026-06-15
**Status:** Draft (pending user approval)
**Author:** Claude (brainstorming session)
**Scope:** `kb/indexer.mjs::rebuildIndex` only

## 1. Problem

`rebuildIndex` (kb/indexer.mjs:144) is the user-triggered "重建索引" path. Current
implementation has two correctness gaps that surface only on interruption:

1. **Lines 153–156** delete `kb_fts`, `kb_embeddings`, `kb_chunks`, `kb_notes`
   *up front*, before any new data is written.
2. **Lines 165–257** then build the new index directly into the same live
   tables, batched in transactions of 64 chunks.

If the process is killed, the host loses power, or the user closes the app
between step 1 and step 2, the database is left in a state **worse than
empty**: `kb_notes` is empty, `kb_chunks` is empty, and any code path that
joins through them returns nothing. Re-running rebuild restores it; the user
just has to know to do that.

The header comment at line 17 already calls this out as a known TODO; this
spec resolves it.

## 2. Goal

Make `rebuildIndex` interruption-safe:

- If the rebuild completes, the database is fully replaced.
- If the rebuild is interrupted at *any* point, the database is left in a
  self-consistent state — either the pre-rebuild state or the post-rebuild
  state, never an in-between.
- A second `rebuildIndex` call while one is in progress must not corrupt
  anything; it should return an error.

## 3. Non-goals (explicit YAGNI)

- **No resumable rebuild** — a half-done shadow table is thrown away on the
  next rebuild. Resuming would require an order of magnitude more code
  (chunk-level cursors, per-chunk commit ledger) and the rebuild is
  user-triggered, so re-running is acceptable.
- **`reindexSingleFile`, `notes.mjs` create/update/delete** are untouched.
  These operate on the current activity tables and are already self-contained.
- **No changes** to `search.mjs`, `embedder.mjs`, `markdown.mjs`, RAG
  algorithm, or any of the constants (`VECTOR_SIMILARITY_FLOOR`, etc.).

## 4. Design

### 4.1 The two-phase shape

```
rebuildIndex(progressCb)
  │
  ├─ 0+1. Lock + create shadow tables  ← one BEGIN/COMMIT, ~10ms
  ├─ 2.   Pass-1: fill shadows          ← batched writes, identical to today
  ├─ 3.   Pass-2: atomic swap           ← one BEGIN/COMMIT, ~5ms
  └─ 4.   Lock release                  ← always runs (try/finally)
```

### 4.2 Phase 0 — Lock

Concurrency control via a single row in a new `kb_meta` table:

```sql
CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`rebuildIndex` does the lock acquisition and shadow-table creation in a
single `BEGIN IMMEDIATE; ... COMMIT;` transaction:

```js
try {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO kb_meta(key, value) VALUES ('rebuild_lock', ?)")
    .run(new Date().toISOString());
  db.exec("CREATE TABLE kb_notes_new ... ");
  // ... (Phase 1 shadow creates) ...
  db.exec("COMMIT");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch { /* ignore */ }
  // The INSERT raises SQLITE_CONSTRAINT_PRIMARYKEY on PK collision
  // when a rebuild is already in progress.
  if (String(e.code).includes("CONSTRAINT")) {
    return { error: "rebuild already in progress" };
  }
  throw e;
}
```

The PK collision (SQLite error code `SQLITE_CONSTRAINT_PRIMARYKEY`) is
the concurrency signal. We ROLLBACK the transaction so neither the lock
row nor the shadow tables leak, then return the error. The first
rebuild's lock row will be cleared either by its own completion (Phase 4)
or by startup recovery (Phase 5).

`kb_meta` is **not** dropped during the swap — it persists across rebuilds
to enable startup recovery.

### 4.3 Phase 1 — Create shadow tables

Shadow table creation happens in the **same transaction** as the Phase 0
lock acquisition (see §4.2). The shadow-table SQL is:

```sql
CREATE TABLE kb_notes_new     (same schema as kb_notes);
CREATE TABLE kb_chunks_new    (same schema as kb_chunks);
CREATE TABLE kb_embeddings_new(same schema as kb_embeddings);
CREATE VIRTUAL TABLE kb_fts_new USING fts5(
  chunk_id UNINDEXED, heading, content, tokenize='unicode61'
);
```

Schema definitions are sourced from the existing `CREATE TABLE IF NOT EXISTS`
strings in `db.mjs` (lines 42–132), extracted into a `SCHEMA_DDL` constant
exported from `db.mjs` so we don't duplicate the column lists.

If FTS5 is **not** available (LIKE fallback), `kb_fts_new` is created with
the LIKE schema (plain table) — same fallback path as `db.mjs:100-107`.

Failure during this phase: empty transaction, no shadows created, no lock
written, original error surfaces. The pre-existing database is untouched.

### 4.4 Phase 2 — Pass 1: fill shadows

The existing per-batch loop (lines 210–257) is moved verbatim but writes
into the `_new` tables. Adjustments:

- `insertChunk` and `insertEmbedding` prepared statements target
  `kb_chunks_new` and `kb_embeddings_new` respectively.
- A new `ftsInsertChunkNew(chunkId, heading, content)` helper writes to
  `kb_fts_new`. The existing `ftsInsertChunk` keeps writing to `kb_fts` for
  use by `reindexSingleFile` and `notes.mjs` — those paths are
  self-contained and don't need to change.
- Per-batch transactions: `BEGIN IMMEDIATE; ... ; COMMIT;` over the `_new`
  tables. ROLLBACK on any per-chunk failure.
- Progress callback fires from the same place as today.

If Pass 1 is interrupted (any batch incomplete): the `_new` tables are
partially filled, the old tables are still the live ones, the lock row
exists in `kb_meta`. Startup recovery (Phase 5) handles it.

### 4.5 Phase 3 — Pass 2: atomic swap

In one `BEGIN IMMEDIATE; ... COMMIT;`:

```sql
DROP TABLE kb_fts;
ALTER TABLE kb_fts_new RENAME TO kb_fts;

DROP TABLE kb_embeddings;
ALTER TABLE kb_embeddings_new RENAME TO kb_embeddings;

DROP TABLE kb_chunks;
ALTER TABLE kb_chunks_new RENAME TO kb_chunks;

DROP TABLE kb_notes;
ALTER TABLE kb_notes_new RENAME TO kb_notes;
```

All four are schema operations. SQLite groups them in the transaction; if
any fails, ROLLBACK restores all four originals intact.

**FTS5 caveat:** FTS5 virtual table RENAME in a mixed transaction is
documented to work in SQLite ≥ 3.26, and the project already uses WAL +
foreign_keys, so this is fine. If we discover at test time that FTS5
refuses to mix with normal RENAME, the fallback is a 2-step commit:
swap FTS first, then swap the other three. Tracked as a "design fallback"
not a "blocking unknown."

**No PRAGMA `foreign_keys=OFF` needed** for the swap. `DROP TABLE` on
parent tables with FK references is normally blocked, but the
`foreign_keys` PRAGMA at the top of `db.mjs:37` means we DO have FKs
enforced. However, the CASCADE rules in `kb_chunks → kb_notes` and
`kb_embeddings → kb_chunks` mean dropping `kb_notes` first would
cascade-delete children. We work around this by:
1. `DROP TABLE kb_fts` (no FKs)
2. `DROP TABLE kb_embeddings` (FK to kb_chunks — but we're dropping
   kb_chunks next, so the CASCADE delete from kb_chunks will clean up
   any orphan rows in the *old* kb_embeddings; in any case the order
   means we're not creating orphans)
3. `DROP TABLE kb_chunks` (FK to kb_notes — same reasoning)
4. `DROP TABLE kb_notes`
5. Then RENAME the `_new` versions in the *same* order to satisfy any
   cross-references in shadow tables.

Actually, since we DROP all originals and then RENAME all shadows, the
moment between step 4 (drop notes) and step 5 (rename notes) the FK
constraints inside the `_new` tables don't reference any real parents yet
— but they don't need to: the `_new` tables have FKs to each other, and
those references will become valid the instant we RENAME. The
foreign_keys PRAGMA checks deferred constraints at COMMIT, which is
exactly what we want.

If this turns out to bite in practice, the test will catch it and the
fallback is `PRAGMA foreign_keys=OFF` for the swap transaction, then
`PRAGMA foreign_keys=ON` after.

### 4.6 Phase 4 — Lock release

After Phase 3 commits:

```js
db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
```

Wrapped in `try/finally` so it always runs, even if the function returns an
error from Pass 1.

### 4.7 Phase 5 — Startup recovery (in `db.mjs::getDb`)

At the very top of `getDb()`, after PRAGMAs but before any user table
references:

```js
try {
  const lock = db.prepare("SELECT value FROM kb_meta WHERE key = 'rebuild_lock'").get();
  if (lock) {
    // Previous rebuild was interrupted. The shadow tables are stale.
    // Drop them, clear the lock, log.
    db.exec("DROP TABLE IF EXISTS kb_fts_new");
    db.exec("DROP TABLE IF EXISTS kb_embeddings_new");
    db.exec("DROP TABLE IF EXISTS kb_chunks_new");
    db.exec("DROP TABLE IF EXISTS kb_notes_new");
    db.prepare("DELETE FROM kb_meta WHERE key = 'rebuild_lock'").run();
    console.warn("[kb] cleaned up stale shadow tables from interrupted rebuild");
  }
} catch (e) {
  // kb_meta might not exist yet on first run. CREATE TABLE IF NOT EXISTS
  // is the next line, so we just swallow and continue.
}
```

`kb_meta` itself is created with `CREATE TABLE IF NOT EXISTS` alongside
the other tables in `getDb()`.

## 5. Data model — `kb_meta`

```sql
CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Used only for `rebuild_lock` for now. Schema is generic so we can add
other keys later (e.g. `last_rebuild_at`, `embedding_model_version`)
without a migration.

## 6. Error handling matrix

| Failure point | Visible behavior | Database state |
|---|---|---|
| Phase 0+1 lock or shadow create fails | error returned; ROLLBACK clears partial state; lock not set | unchanged |
| Pass 1, batch embed fails | `failed += batch.length`; continue | shadows partial, old tables intact |
| Pass 1, batch DB write fails | ROLLBACK that batch; `failed += batch.length`; continue | shadows partial, old tables intact |
| Pass 1, process killed | shadows partial, old tables intact | recoverable on next startup |
| Phase 3 swap fails | ROLLBACK restores all 4 originals | unchanged |
| Phase 3 swap succeeds, lock release fails | warning logged; next startup sees no lock, no shadows, clean | consistent (just stale lock row) |
| Lock release succeeds | normal | consistent |
| Concurrency: 2nd rebuild during 1st | `{error: "rebuild already in progress"}` | consistent |

## 7. Performance

Expected overhead vs. current implementation:

- **Phase 1** (shadow create): ~10ms (4 empty tables, no FTS index yet)
- **Phase 3** (swap): ~5ms (8 schema ops, no data movement)
- **Pass 1**: identical to today (same writes, same batching)
- **Storage during rebuild**: ~2× index size in shadow tables (briefly)

For a 50K-chunk vault, that's 50K rows × ~3 tables = ~150K extra rows on
disk during Pass 1. Acceptable for a user-triggered operation.

## 8. Files changed

| File | Lines added | Description |
|---|---|---|
| `kb/db.mjs` | +35 | Export `SCHEMA_DDL` constant, `kb_meta` table create, startup recovery in `getDb()` |
| `kb/indexer.mjs` | +60 | Rewrite `rebuildIndex` with 4 phases; add `ftsInsertChunkNew` helper |
| `kb/search.mjs` | +12 | Export `ftsInsertChunkNew(chunkId, heading, content)` — small wrapper over `kb_fts_new` |
| `test/rebuild-atomic.test.mjs` | +200 | 5 test cases (see §10) |
| `docs/superpowers/specs/2026-06-15-rebuild-atomic-design.md` | (this file) | spec |

## 9. Migration

There is no schema migration on the user's side:

- `kb_meta` is `CREATE TABLE IF NOT EXISTS`, so it appears on first launch
  after this change without touching existing data.
- The startup recovery code is guarded by a `try/catch` for the case where
  the user's DB predates `kb_meta`.
- All other tables are unchanged in shape.

A user upgrading from the previous version: open the app, the new
`getDb()` runs, `kb_meta` is created. Next rebuild uses the new code
path. No manual steps.

## 10. Tests

`test/rebuild-atomic.test.mjs` (new file, 5 cases):

1. **Happy path** — `rebuildIndex` on a vault with 5 notes completes;
   `_new` tables do not exist after; `kb_notes` count matches vault;
   `ftsSearch` returns the expected hits.
2. **Pass 1 interruption simulation** — manually insert a row into
   `kb_meta` + create the `_new` tables mid-shape (only `kb_notes_new`
   exists, no chunks), then call `getDb()` again and verify:
   - The stale `_new` table is dropped
   - The lock row is gone
   - The original `kb_notes` (with old data) is intact
3. **Concurrent rebuild** — call `rebuildIndex` twice in parallel; the
   second returns `{error: "rebuild already in progress"}` and the
   `kb_meta` lock row exists during, not after.
4. **FTS swap verification** — after rebuild, `kb_fts` (the renamed
   `kb_fts_new`) contains rows for new chunks, and `ftsSearch` returns
   the expected hits. This catches the FTS5 RENAME corner case.
5. **Embedding dim tracking** — after rebuild, every row in
   `kb_embeddings` has the current `getEmbeddingDim()` value, confirming
   the `dim` column made it through the RENAME correctly.

All tests use a temp dir as vault and an isolated `DB_PATH` (override
via env var or dependency-injectable helper) to avoid touching the
user's real index.

## 11. Open questions

None — both architectural decisions (full-table atomicity, auto-cleanup
on startup) were confirmed during brainstorming.
