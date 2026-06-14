/**
 * AideAgent Knowledge Store — Hybrid RAG (FTS5 + Vector Embeddings)
 *
 * Provides Obsidian vault indexing, full-text search, vector embeddings,
 * and hybrid search via Reciprocal Rank Fusion (RRF).
 *
 * DB: ~/.aideagent/knowledge.db
 * Config: ~/.aideagent/kb-config.json
 */

import { join, relative, extname, basename, dirname } from "path";
import { fileURLToPath } from "node:url";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, watch, realpathSync } from "fs";
import { DatabaseSync } from "node:sqlite";

// ── Pure-function modules (Wave 1 split) ──────────────────
import { spaceCJK, sanitizeFtsTerm } from "./kb/text-utils.mjs";
import { stripMarkdown, stripNoteBody, splitIntoChunks, parseFrontMatter, extractTitle, extractTags } from "./kb/markdown.mjs";
import { vectorToBuffer, bufferToVector, cosineSimilarity } from "./kb/vector-math.mjs";
import { reciprocalRankFusion } from "./kb/rank-fusion.mjs";

// ── Infrastructure modules (Wave 2 split) ─────────────────
import { getVault, getConfig, setVault, setConfig, getEffectiveMaxBodyChars, getAutoDetectedMaxBodyChars, _setAutoDetectedMaxBodyChars as _markAutoDetectedMaxBodyChars } from "./kb/config.mjs";
import { getDb, hasFts5 } from "./kb/db.mjs";
import { isSafeVaultPath, setVaultExcludes, scanVault } from "./kb/vault-scanner.mjs";
import { _logError, getErrorCounts } from "./kb/log.mjs";
import { embedText } from "./kb/embedder.mjs";
import { listNotes, getNote, createNote, updateNote, deleteNote } from "./kb/notes.mjs";
import { search, ftsDeleteByRelPath, ftsDeleteChunk, ftsInsertChunk, ftsSearch } from "./kb/search.mjs";
import { reindexSingleFile, rebuildIndex } from "./kb/indexer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// HOME / DATA_DIR / DB_PATH / CONFIG_PATH → moved to kb/config.mjs
// _embeddingDim → moved to kb/embedder.mjs

// ── File Watcher ─────────────────────────────────────────────
/** @type {import("fs").FSWatcher | null} */
let _watcher = null;
let _watcherTimer = null;
const WATCHER_DEBOUNCE_MS = 500;

/**
 * Debounce helper — coalesces rapid fs.watch events into a single call.
 * @param {() => void} fn
 * @returns {() => void}
 */
function debounced(fn) {
  return () => {
    if (_watcherTimer) clearTimeout(_watcherTimer);
    _watcherTimer = setTimeout(() => { _watcherTimer = null; fn(); }, WATCHER_DEBOUNCE_MS);
  };
}

export function startWatcher() {
  const _vaultPath = getVault();
  if (!_vaultPath || !existsSync(_vaultPath)) return { ok: false, error: "vault not set" };
  if (_watcher) return { ok: true, error: "already watching" };

  const processChange = debounced(async () => {
    // Full sync: scan vault and diff against DB, re-index changed/new files
    // Since fs.watch doesn't give us reliable "which file changed" on all platforms,
    // we do a lightweight scan — compare mtime_ms against DB records.
    try {
      const db = getDb();
      const vault = getVault();
      const files = scanVault(vault, vault);
      let updated = 0;
      for (const file of files) {
        const row = db.prepare("SELECT mtime_ms FROM kb_notes WHERE rel_path = ?").get(file.relPath);
        if (!row || Number(row.mtime_ms) !== file.mtimeMs) {
          await reindexSingleFile(file.relPath);
          updated++;
        }
      }

      // Remove notes whose files no longer exist
      const indexed = db.prepare("SELECT rel_path FROM kb_notes").all();
      const existingPaths = new Set(files.map(/** @param {any} f */ f => f.relPath));
      for (const row of indexed) {
        if (!existingPaths.has(String(row.rel_path))) {
          const nr = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(String(row.rel_path));
          if (nr) {
            db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(Number(nr.id));
            db.prepare("DELETE FROM kb_notes WHERE rel_path = ?").run(String(row.rel_path));
            updated++;
          }
        }
      }
      if (updated > 0) console.log(`[kb-watcher] sync: ${updated} file(s) updated`);
    } catch (/** @type {any} */ e) {
      console.error("[kb-watcher] sync error:", e.message);
    }
  });

  try {
    _watcher = watch(_vaultPath, { recursive: true }, processChange);
    console.log(`[kb-watcher] started on: ${_vaultPath}`);
    return { ok: true };
  } catch (/** @type {any} */ e) {
    console.error("[kb-watcher] failed to start:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Check whether the vault watcher is currently active.
 * @returns {boolean}
 */
export function isWatcherActive() {
  return !!_watcher;
}

/**
 * Stop the vault watcher.
 */
export function stopWatcher() {
  if (_watcher) {
    try { _watcher.close(); } catch (/** @type {any} */ e) { _logError("fs", e); }
    _watcher = null;
    console.log("[kb-watcher] stopped");
  }
  if (_watcherTimer) {
    clearTimeout(_watcherTimer);
    _watcherTimer = null;
  }
}

// isSafeVaultPath → moved to kb/vault-scanner.mjs (re-exported at bottom)

// ── Configuration ─────────────────────────────────────────
// _vaultPath, _config, _autoDetectedMaxBodyChars, loadConfig, saveConfig,
// getVault, getConfig, setVault, setConfig, getEffectiveMaxBodyChars
// → moved to kb/config.mjs (re-exported at bottom)

// ── Query Rewriting, LLM Reranking, FTS, Hybrid Search ────
// rewriteQuery, rerankResults, search, ftsDeleteByRelPath, ftsDeleteChunk,
// ftsInsertChunk, ftsSearch, VECTOR_*_SIM, MIN_TOP_RRF_SCORE, REWRITE_*,
// RERANK_*, rewriteCache, rerankCache, _rewriteInFlight, _rerankInFlight
// → moved to kb/search.mjs (re-exported at bottom)

// ── Error counter (exposed via getStatus) ────────────────────
// _errCounts, _logError → moved to kb/log.mjs
// ── CRUD Operations ───────────────────────────────────────
// listNotes, getNote, createNote, updateNote, deleteNote
// → moved to kb/notes.mjs (re-exported at bottom)

// ── Ollama Model Discovery ────────────────────────────────

/** @returns {Promise<string[]>} */
export async function listOllamaModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(/** @param {{name:string}} m */ m => m.name);
  } catch (/** @type {any} */ e) {
    // Ollama may be down; return empty list (UI shows "no models").
    _logError("embed", e);
    return [];
  }
}

// ── Status ────────────────────────────────────────────────

export function getStatus() {
  const db = getDb();
  try {
    const noteCount = Number(db.prepare("SELECT COUNT(*) as count FROM kb_notes").get()?.count ?? 0);
    const chunkCount = Number(db.prepare("SELECT COUNT(*) as count FROM kb_chunks").get()?.count ?? 0);
    const embeddedCount = Number(db.prepare("SELECT COUNT(*) as count FROM kb_embeddings").get()?.count ?? 0);
    const watcherActive = !!_watcher;
    const cfg = getConfig();
    return {
      vault: getVault(),
      noteCount,
      chunkCount,
      embeddedCount,
      watcherActive,
      embeddingProvider: cfg.embeddingProvider,
      maxBodyChars: cfg.maxBodyChars,
      autoDetectedMaxBodyChars: getAutoDetectedMaxBodyChars(),
      effectiveMaxBodyChars: getEffectiveMaxBodyChars(),
      // Expose error counters so operators can detect degraded operation
      // (silent FTS drift, embed failures, etc.) without grepping logs.
      errorCounts: getErrorCounts(),
    };
  } catch (/** @type {any} */ e) {
    _logError("db", e);
    return { vault: getVault(), noteCount: 0, chunkCount: 0, embeddedCount: 0, errorCounts: getErrorCounts() };
  }
}

// ── Re-exports for backward compatibility (Wave 1 + Wave 2 + Wave 3) ─
// These functions live in dedicated modules under kb/ for testability and
// separation of concerns, but the public API of knowledge-store.mjs is
// unchanged — external imports keep working.

// Wave 1 — pure functions
export { spaceCJK, sanitizeFtsTerm } from "./kb/text-utils.mjs";
export { stripMarkdown, stripNoteBody, splitIntoChunks, parseFrontMatter, extractTitle, extractTags } from "./kb/markdown.mjs";
export { vectorToBuffer, bufferToVector, cosineSimilarity } from "./kb/vector-math.mjs";
export { reciprocalRankFusion } from "./kb/rank-fusion.mjs";

// Wave 2 — infrastructure
export { getVault, getConfig, setVault, setConfig, getEffectiveMaxBodyChars, DATA_DIR, DB_PATH, CONFIG_PATH } from "./kb/config.mjs";
export { getDb, hasFts5 } from "./kb/db.mjs";
export { isSafeVaultPath, setVaultExcludes, scanVault } from "./kb/vault-scanner.mjs";
export { _logError, getErrorCounts } from "./kb/log.mjs";
export { embedText, getEmbeddingDim, isEmbedderReady } from "./kb/embedder.mjs";

// Wave 3 — core search / indexer / notes
export { listNotes, getNote, createNote, updateNote, deleteNote } from "./kb/notes.mjs";
export { search, ftsDeleteByRelPath, ftsDeleteChunk, ftsInsertChunk, ftsSearch } from "./kb/search.mjs";
export { reindexSingleFile, rebuildIndex } from "./kb/indexer.mjs";
