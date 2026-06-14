/**
 * SQLite database initialization for the knowledge base.
 *
 * Owns the singleton DB connection and the schema/migrations:
 *   - kb_notes     (note-level metadata)
 *   - kb_chunks    (chunk-level content, joined to notes)
 *   - kb_fts       (FTS5 virtual table over chunk_id, heading, content)
 *   - kb_embeddings (BLOB embedding per chunk, with dim tracking)
 *
 * Schema migration safety:
 *   - On startup, PRAGMA table_info() checks each table's columns. If an
 *     old note-level schema is detected (e.g. kb_fts without chunk_id), the
 *     table is dropped and recreated with the current schema.
 *   - The dim column on kb_embeddings records the embedding dimensionality
 *     at write time, so a future dim change (model switch) doesn't silently
 *     mix incompatible vectors.
 *
 * Pure schema + connection management. No scanning, no embedding, no search.
 */

import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.mjs";

/** @type {DatabaseSync | null} */
let _db = null;
let _hasFts5 = false;

/**
 * Get (or create) the singleton DB connection.
 * Lazy-initialized so first-time users don't pay the cost until they
 * actually need the DB.
 */
export function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  // Wait up to 5s for write locks held by other processes (e.g. second
  // AideAgent instance) instead of failing immediately with SQLITE_BUSY.
  _db.exec("PRAGMA busy_timeout=5000");

  _db.exec(`
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
    )
  `);

  // ── Chunk-level tables ─────────────────────────────────
  // kb_chunks: stores individual chunks per note
  _db.exec(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      heading TEXT DEFAULT '',
      content TEXT NOT NULL,
      FOREIGN KEY(note_id) REFERENCES kb_notes(id) ON DELETE CASCADE
    )
  `);

  // Chunk-level FTS
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        chunk_id UNINDEXED,
        heading,
        content,
        tokenize='unicode61'
      )
    `);
    // Verify the table actually has chunk_id column (schema migration check)
    const cols = _db.prepare("PRAGMA table_info(kb_fts)").all();
    const hasChunkId = cols.some(/** @param {any} c */ c => String(c.name) === "chunk_id");
    if (!hasChunkId) {
      // Old note-level schema — drop and recreate
      _db.exec("DROP TABLE IF EXISTS kb_fts");
      _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
          chunk_id UNINDEXED,
          heading,
          content,
          tokenize='unicode61'
        )
      `);
    }
    _hasFts5 = true;
    console.log("[kb] FTS5 available (chunk-level)");
  } catch (/** @type {any} */ e) {
    console.log("[kb] FTS5 not available, using LIKE search:", e.message);
    _hasFts5 = false;
    try {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS kb_fts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chunk_id INTEGER,
          heading TEXT,
          content TEXT
        )
      `);
    } catch (/** @type {any} */ e2) {
      // Fallback table creation is best-effort; if it already exists
      // (or the DB is read-only), we proceed with whatever worked.
      _logError("db", e2);
    }
  }

  // Chunk-level embeddings
  // Check column structure first to avoid dropping data on each startup
  {
    const embCols = _db.prepare("PRAGMA table_info(kb_embeddings)").all();
    const hasChunkId = embCols.some(/** @param {any} c */ c => String(c.name) === "chunk_id");
    if (!hasChunkId) {
      // Old note-level schema — drop and recreate
      _db.exec("DROP TABLE IF EXISTS kb_embeddings");
    }
  }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
    )
  `);

  return _db;
}

/** Whether the current DB has FTS5 (vs the LIKE fallback). */
export function hasFts5() {
  return _hasFts5;
}

// ── Error reporting (registered by main module) ───────────

let _logError = (bucket, err) => {
  const msg = err?.message || String(err);
  console.warn(`[kb] ${bucket} error: ${msg.slice(0, 200)}`);
};

export function _registerLogger(fn) {
  _logError = fn;
}
