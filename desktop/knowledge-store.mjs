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

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = homedir();
const DATA_DIR = join(HOME, ".aideagent");
const DB_PATH = join(DATA_DIR, "knowledge.db");
const CONFIG_PATH = join(DATA_DIR, "kb-config.json");
let _embeddingDim = 384; // Auto-detected at runtime from the actual embedding model

// ── Chunking configuration ──────────────────────────────
const CHUNK_SIZE = 500;   // chars per chunk (fixed-size fallback)
const CHUNK_OVERLAP = 100; // overlap between consecutive fixed-size chunks

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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

/**
 * Re-index a single file from the vault (called by watcher on change).
 * Scans the file, splits into chunks, replaces old chunks/FTS/embedding.
 * Silently ignores non-markdown files and files outside vault.
 * @param {string} relPath - relative path within the vault
 */
async function reindexSingleFile(relPath) {
  if (!_vaultPath) return;
  if (!relPath.endsWith(".md")) return;
  const fullPath = join(_vaultPath, relPath);
  if (!existsSync(fullPath)) return;

  try {
    const content = readFileSync(fullPath, "utf-8");
    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    const tags = extractTags(content);
    const body = stripNoteBody(content);

    const db = getDb();
    const existing = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    const noteId = existing ? Number(existing.id) : null;

    if (noteId) {
      // Update existing note
      db.prepare("UPDATE kb_notes SET title=?, tags=?, word_count=?, mtime_ms=?, updated_at=? WHERE id=?")
        .run(title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), noteId);

      // Remove old chunks (cascade deletes FTS + embeddings)
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(noteId);
    } else {
      // New note
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(relPath, basename(relPath), title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const newNoteId = Number(result.lastInsertRowid);
      // Re-chunk the new note
      const chunks = splitIntoChunks(body, title);
      if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });
      const max = getEffectiveMaxBodyChars();
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkResult = db.prepare(
          "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
        ).run(newNoteId, ci, chunk.heading, chunk.content);
        const chunkId = Number(chunkResult.lastInsertRowid);
        ftsInsertChunk(chunkId, chunk.heading, chunk.content);
        try {
          const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max));
          if (embedding) {
            db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
              .run(chunkId, vectorToBuffer(embedding), _embeddingDim);
          } else {
            console.warn(`[kb] embedText returned null for chunk ${ci} of ${relPath}`);
          }
        } catch (/** @type {any} */ e) {
          console.error(`[kb] embedText failed for chunk ${ci} of ${relPath}: ${e.message}`);
        }
      }
      return;
    }

    // For existing note, re-chunk and re-embed
    const chunks = splitIntoChunks(body, title);
    if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });
    const max = getEffectiveMaxBodyChars();
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkResult = db.prepare(
        "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
      ).run(noteId, ci, chunk.heading, chunk.content);
      const chunkId = Number(chunkResult.lastInsertRowid);
      ftsInsertChunk(chunkId, chunk.heading, chunk.content);
      try {
        const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max));
        if (embedding) {
          db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
            .run(chunkId, vectorToBuffer(embedding), _embeddingDim);
        }
      } catch (/** @type {any} */ e) {
        _logError("embed", e);
        console.error(`[kb] embedText failed for chunk ${ci} of ${relPath}: ${e.message}`);
      }
    }

    console.log(`[kb-watcher] re-indexed: ${relPath} (${chunks.length} chunks)`);
  } catch (/** @type {any} */ e) {
    console.error(`[kb-watcher] failed to re-index ${relPath}:`, e.message);
  }
}

/**
 * Start watching the vault directory for changes.
 * Automatically re-indexes files on add/change via debounced fs.watch.
 * Silently no-ops if the vault is not set or already watching.
 * @returns {{ ok: boolean, error?: string }}
 */
export function startWatcher() {
  if (!_vaultPath || !existsSync(_vaultPath)) return { ok: false, error: "vault not set" };
  if (_watcher) return { ok: true, error: "already watching" };

  const processChange = debounced(async () => {
    // Full sync: scan vault and diff against DB, re-index changed/new files
    // Since fs.watch doesn't give us reliable "which file changed" on all platforms,
    // we do a lightweight scan — compare mtime_ms against DB records.
    try {
      const db = getDb();
      const files = scanVault(_vaultPath, _vaultPath);
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

/**
 * Validate that `relPath` resolves to a location inside the vault.
 *
 * Defends against:
 *   - ".." path traversal (e.g. "../../etc/passwd")
 *   - Absolute paths and UNC paths (\\server\share)
 *   - Symlinks inside the vault that point outside (e.g. a malicious
 *     Obsidian plugin or user-created symlink to C:\Windows\System32)
 *   - NTFS alternate data streams ("foo.md:hidden")
 *   - Null bytes and other control characters
 *
 * Uses realpathSync on both sides to defeat symlink-based bypasses that
 * a pure string prefix check would miss.
 * @param {string} relPath
 * @returns {boolean}
 */
function isSafeVaultPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  // Reject obviously dangerous patterns upfront
  if (relPath.includes("..")) return false;          // traversal segments
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false; // absolute / UNC
  if (/[\x00-\x1f]/.test(relPath)) return false;     // control chars incl. NUL
  if (/^[A-Za-z]:/.test(relPath)) return false;      // Windows drive-relative
  if (relPath.includes(":")) return false;           // NTFS ADS (foo.md:hidden)
  if (!_vaultPath) return false;

  const resolved = join(_vaultPath, relPath);
  // Compare real paths (resolve symlinks on both sides)
  let realVault, realTarget;
  try {
    realVault = realpathSync(_vaultPath);
  } catch {
    return false;
  }
  try {
    // If the target doesn't exist yet (e.g. createNote on a new file),
    // resolve the parent directory and re-append the basename.
    realTarget = realpathSync.native
      ? realpathSync(resolved, { throwIfNoEntry: false })
      : null;
    if (!realTarget) {
      const parent = dirname(resolved);
      const base = basename(resolved);
      const realParent = realpathSync(parent);
      realTarget = join(realParent, base);
    }
  } catch {
    return false;
  }
  // Normalize Windows path separators before comparison
  const norm = (p) => p.replace(/\\/g, "/");
  return norm(realTarget).startsWith(norm(realVault) + "/") || norm(realTarget) === norm(realVault);
}

// ── Configuration ─────────────────────────────────────────

let _vaultPath = "";
/** @type {{embeddingProvider:string, ollamaEmbedModel:string, maxNotes:number, maxChars:number, maxBodyChars:number, queryRewriteModel?:string, queryRewriteEnabled?:boolean, rerankEnabled?:boolean, rerankModel?:string, rerankTopN?:number}} */
let _config = { embeddingProvider: "local", ollamaEmbedModel: "nomic-embed-text", maxNotes: 20, maxChars: 20000, maxBodyChars: 0, queryRewriteModel: "qwen3.5:9b", queryRewriteEnabled: true, rerankEnabled: true, rerankModel: "gemma4:e4b", rerankTopN: 15 };
// maxBodyChars: 0 = auto-detect from Ollama model context, >0 = user override

// Cached auto-detected limit (computed in getEmbedder when provider is ollama)
let _autoDetectedMaxBodyChars = 0;

// ── Query Rewriting (LRU cache + Ollama chat model) ───────
// Turns "本地大模型" into ["本地大模型", "本地运行的大语言模型", "Ollama 本地模型", ...]
// Helps both FTS keyword matching AND vector similarity for short/conceptual queries.
const REWRITE_CACHE_MAX = 256;
const rewriteCache = new Map(); // query → variants[]
let _rewriteEverSucceeded = false;
/** @type {Map<string, Promise<string[]>>} */
let _rewriteInFlight = new Map(); // Map<query, Promise> for per-key concurrent-call coalescing

// ── Error counter (exposed via getStatus) ────────────────────
// Tracks silently-swallowed errors so operators can detect degraded operation
// without grepping logs. Counters are monotonically increasing since process start.
/** @type {{rewrites:number, reranks:number, fts:number, embed:number, fs:number, db:number, total:number}} */
let _errCounts = { rewrites: 0, reranks: 0, fts: 0, embed: 0, fs: 0, db: 0, total: 0 };

/**
 * Increment an error counter and log a single-line warning.
 * Centralizing this prevents the prior pattern of 33+ unlogged catches.
 * @param {"rewrites"|"reranks"|"fts"|"embed"|"fs"|"db"} bucket
 * @param {any} err
 */
function _logError(bucket, err) {
  if (!_errCounts[bucket]) _errCounts[bucket] = 0;
  _errCounts[bucket]++;
  _errCounts.total++;
  const msg = err?.message || String(err);
  // Truncate stack to keep logs readable
  console.warn(`[kb] ${bucket} error: ${msg.slice(0, 200)}`);
}

const REWRITE_PROMPT = `You are a search query rewriter for a personal Obsidian knowledge base.
Given a user's search query, output 3-5 alternative phrasings that would find the same information.
Rules:
- SHORT alternatives (3-15 words each)
- Mix synonyms, related concepts, and natural Chinese/English variations
- Output ONLY the alternatives, one per line, no numbering, no explanation

Query: {query}

Alternatives:`;

const RERANK_PROMPT = `You are a relevance judge for a personal Obsidian knowledge base search.
Given a search query and a list of candidate results, output the indices (1-based) of the most relevant results IN ORDER OF RELEVANCE, comma-separated, no spaces, no other text.
Include only results that are actually relevant to the query. If a result is not relevant, OMIT its index.

Query: {query}

Candidates:
{candidates}

Most relevant indices (comma-separated):`;

// ── Rerank LRU cache (query+chunk_ids → ordered indices) ────
const RERANK_CACHE_MAX = 128;
const rerankCache = new Map(); // "query|chunk_id1,chunk_id2,..." → indices[]
let _rerankEverSucceeded = false; // Tracks first-call cold start for adaptive timeout
/** @type {Map<string, Promise<any[]|null>>} */
let _rerankInFlight = new Map(); // Map<cacheKey, Promise> for per-key concurrent-call coalescing

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    _vaultPath = cfg.vaultPath || "";
    _config = { ..._config, ...cfg };
  } catch (/** @type {any} */ e) {
    // Missing/corrupt config file is normal on first run.
    _logError("fs", e);
  }
}

function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ..._config, vaultPath: _vaultPath }, null, 2), "utf-8");
  } catch (/** @type {any} */ e) {
    // Config write failure is non-fatal (settings won't persist this session).
    _logError("fs", e);
  }
}

loadConfig();

export function getVault() { return _vaultPath; }
export function getConfig() { return { ..._config, vaultPath: _vaultPath }; }

/** @param {string} path @returns {{ok:boolean, vault:string}|{error:string}} */
export function setVault(path) {
  if (path !== "" && (typeof path !== "string" || !existsSync(path))) return { error: "path does not exist" };
  // Stop previous watcher if any
  stopWatcher();
  _vaultPath = path || "";
  saveConfig();
  // Auto-start watcher if vault is set
  if (_vaultPath) startWatcher();
  return { ok: true, vault: _vaultPath };
}

/** @param {{embeddingProvider?:string, ollamaEmbedModel?:string, maxNotes?:number, maxChars?:number, maxBodyChars?:number, queryRewriteModel?:string, queryRewriteEnabled?:boolean, rerankEnabled?:boolean, rerankModel?:string, rerankTopN?:number}} cfg @returns {{ok:boolean, config:object}} */
export function setConfig(cfg) {
  if (cfg.embeddingProvider) _config.embeddingProvider = cfg.embeddingProvider;
  if (cfg.ollamaEmbedModel && cfg.ollamaEmbedModel !== _config.ollamaEmbedModel) {
    _config.ollamaEmbedModel = cfg.ollamaEmbedModel;
    _embedderReady = false; // re-init with new model name
  }
  if (cfg.maxNotes) _config.maxNotes = Math.max(1, Math.min(100, cfg.maxNotes));
  if (cfg.maxChars) _config.maxChars = Math.max(100, Math.min(50000, cfg.maxChars));
  if (cfg.maxBodyChars !== undefined) {
    _config.maxBodyChars = Math.max(0, Math.min(100000, parseInt(String(cfg.maxBodyChars)) || 0));
    // Setting maxBodyChars=0 means "auto-detect from Ollama model". If we
    // previously auto-detected a value, that's now stale (e.g. user switched
    // from a long-context model to a short-context one). Force re-detection.
    if (_config.maxBodyChars === 0) _autoDetectedMaxBodyChars = 0;
  }
  // Clear LLM result caches when the model changes — old outputs are invalid
  if (cfg.queryRewriteModel && cfg.queryRewriteModel !== _config.queryRewriteModel) {
    rewriteCache.clear();
    _rewriteEverSucceeded = false;
  }
  if (cfg.rerankModel && cfg.rerankModel !== _config.rerankModel) {
    rerankCache.clear();
    _rerankEverSucceeded = false;
  }
  if (cfg.queryRewriteEnabled !== undefined) _config.queryRewriteEnabled = Boolean(cfg.queryRewriteEnabled);
  if (cfg.rerankEnabled !== undefined) _config.rerankEnabled = Boolean(cfg.rerankEnabled);
  if (cfg.queryRewriteModel) _config.queryRewriteModel = String(cfg.queryRewriteModel);
  if (cfg.rerankModel) _config.rerankModel = String(cfg.rerankModel);
  if (cfg.rerankTopN !== undefined) _config.rerankTopN = Math.max(5, Math.min(50, parseInt(String(cfg.rerankTopN)) || 20));
  saveConfig();
  return { ok: true, config: _config };
}

// Effective max body chars: user override > auto-detected > 1500 fallback
export function getEffectiveMaxBodyChars() {
  if (_config.maxBodyChars > 0) return _config.maxBodyChars;
  if (_autoDetectedMaxBodyChars > 0) return _autoDetectedMaxBodyChars;
  return 1500; // safe fallback before any detection
}

// Space out CJK characters individually so FTS5 unicode61 tokenizes them as separate tokens.
// "故宫博物院" → "故 宫 博 物 院"
/** @param {string} text @returns {string} */
function spaceCJK(text) {
  if (!text) return text;
  return text.replace(/([一-鿿㐀-䶿⺀-⻿])/g, "$1 ").trim();
}

/**
 * Sanitize a single token before it goes into an FTS5 MATCH expression.
 * FTS5 has many metacharacters (" * ( ) : ^ - + . ,) that can break the
 * parser or change query semantics in surprising ways. Strip all but
 * letters/digits/CJK/underscore/dash, then re-quote with double quotes.
 * @param {string} term
 * @returns {string} sanitized term safe to wrap in "..." for FTS5
 */
function sanitizeFtsTerm(term) {
  if (!term) return "";
  // Keep letters, digits, CJK, underscore, dash. Strip everything else.
  return term.replace(/[^\w一-鿿㐀-䶿\-]/g, "");
}

/**
 * Strip Markdown formatting for clean embedding text.
 * Removes headings markers, bold/italic, wikilinks, code markers, strikethrough.
 * Collapses multiple newlines.
 * @param {string} text
 * @returns {string}
 */
function stripMarkdown(text) {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,3}_ {1,3}/g, "")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Strip a full note's raw content to its embeddable body.
 * Handles frontmatter, headings, wikilinks, formatting, and whitespace — the
 * SAME logic for ALL paths (rebuild, watcher, create, update). Previously the
 * watcher path skipped wikilinks/formatting, producing different chunk content
 * from the rebuild path. This is the single source of truth.
 * @param {string} content
 * @returns {string}
 */
function stripNoteBody(content) {
  return content
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Split note body into semantic chunks.
 *
 * Strategy (tiered):
 *   1. Heading-based — split on `##` (or higher) headings.
 *      Each section becomes a chunk tagged with its heading for context.
 *   2. Single-heading — if the note has only one `#` (title) or no headings,
 *      or all sections have very short content, fall through to fixed-size.
 *   3. Fixed-size — CHUNK_SIZE chars with CHUNK_OVERLAP.
 *
 * @param {string} rawBody - Full note body with frontmatter already stripped
 * @param {string} [fallbackTitle] - Note title used when no heading is found
 * @returns {Array<{heading:string, content:string}>}
 */
function splitIntoChunks(rawBody, fallbackTitle = "") {
  /** @type {Array<{heading:string, content:string}>} */
  const chunks = [];
  const body = (rawBody || "").trim();
  if (!body) return chunks;

  // ── Attempt 1: heading-based split ──────────────────────────
  // Match ## or higher (level 2-6). We skip # (level 1) because
  // that's usually the document title, not a section divider.
  const headingMatches = [...body.matchAll(/^(#{2,6})\s+(.+)$/gm)];

  if (headingMatches.length >= 2) {
    // Capture content BEFORE the first heading as a lead chunk. Previously
    // this was silently dropped — intro/lead content was invisible to
    // search. Now it gets indexed under the note title (≥20 chars guard
    // skips trivial frontmatter leftovers).
    const firstHeadingStart = headingMatches[0].index;
    const lead = body.slice(0, firstHeadingStart).trim();
    if (lead && lead.length >= 20) {
      chunks.push({ heading: fallbackTitle || "", content: stripMarkdown(lead) });
    }

    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].index;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : body.length;
      const rawSection = body.slice(start, end).trim();
      if (rawSection) {
        chunks.push({
          heading: headingMatches[i][2].trim(),
          content: stripMarkdown(rawSection),
        });
      }
    }
  }

  // ── Attempt 2: single # heading ────────────────────────────
  if (chunks.length === 0) {
    const h1Matches = [...body.matchAll(/^#{1}\s+(.+)$/gm)];
    if (h1Matches.length >= 2) {
      // Same lead-capture fix as Attempt 1
      const firstH1Start = h1Matches[0].index;
      const lead = body.slice(0, firstH1Start).trim();
      if (lead && lead.length >= 20) {
        chunks.push({ heading: fallbackTitle || "", content: stripMarkdown(lead) });
      }

      for (let i = 0; i < h1Matches.length; i++) {
        const start = h1Matches[i].index;
        const end = i + 1 < h1Matches.length ? h1Matches[i + 1].index : body.length;
        const rawSection = body.slice(start, end).trim();
        if (rawSection) {
          chunks.push({
            heading: h1Matches[i][2].trim(),
            content: stripMarkdown(rawSection),
          });
        }
      }
    }
  }

  // ── Fallback: fixed-size with overlap ──────────────────────
  if (chunks.length === 0) {
    const clean = stripMarkdown(body);
    let start = 0;
    while (start < clean.length) {
      const end = Math.min(start + CHUNK_SIZE, clean.length);
      const piece = clean.slice(start, end).trim();
      if (piece) {
        chunks.push({ heading: start === 0 ? fallbackTitle : "", content: piece });
      }
      if (end >= clean.length) break;
      start = end - CHUNK_OVERLAP;
    }
  }

  return chunks;
}

// ── Frontmatter Parser ────────────────────────────────────

/** @param {string} text @returns {{title:string, tags:string[], aliases:string[]}} */
function parseFrontMatter(text) {
  /** @type {{title:string, tags:string[], aliases:string[]}} */
  const meta = { title: "", tags: [], aliases: [] };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "title" || key === "name") meta.title = val;
      else if (key === "tags") {
        // Handle both [tag1, tag2] and "tag1, tag2" formats
        if (val.startsWith("[")) {
          meta.tags = val.slice(1, -1).split(",").map(t => t.trim().replace(/^["']|["']$/g, ""));
        } else {
          meta.tags = val.split(",").map(t => t.trim());
        }
      }
      else if (key === "aliases") {
        if (val.startsWith("[")) {
          meta.aliases = val.slice(1, -1).split(",").map(t => t.trim().replace(/^["']|["']$/g, ""));
        } else {
          meta.aliases = [val];
        }
      }
    }
  }
  return meta;
}

/** @param {string} text @param {string} filename @returns {string} */
function extractTitle(text, filename) {
  // Try frontmatter title first
  const fm = parseFrontMatter(text);
  if (fm.title) return fm.title;
  // Try first H1 heading
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  // Fallback to filename
  return basename(filename, ".md");
}

/** @param {string} text @returns {string[]} */
function extractTags(text) {
  const fm = parseFrontMatter(text);
  /** @type {Set<string>} */
  const tags = new Set(fm.tags);
  // Also extract inline #tags
  const inlineTags = text.matchAll(/(?<=^|\s)#([a-zA-Z一-鿿][\w一-鿿-]*)/gm);
  for (const m of inlineTags) tags.add(m[1]);
  return [...tags];
}

// ── Database ──────────────────────────────────────────────

/** @type {import("node:sqlite").DatabaseSync | null} */
let _db = null;
let _hasFts5 = false;

function getDb() {
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
    } catch (/** @type {any} */ e) {
      // Fallback table creation is best-effort; if it already exists
      // (or the DB is read-only), we proceed with whatever worked.
      _logError("db", e);
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

// ── FTS Operations ────────────────────────────────────────

/** Delete all FTS entries for chunks belonging to a specific note (by rel_path). */
function ftsDeleteByRelPath(relPath) {
  try {
    const db = getDb();
    // Get chunk IDs for this note, then delete them from FTS
    const noteRows = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").all(relPath);
    if (noteRows.length === 0) return;
    const noteId = Number(noteRows[0].id);
    const chunks = db.prepare("SELECT id FROM kb_chunks WHERE note_id = ?").all(noteId);
    const stmt = db.prepare("DELETE FROM kb_fts WHERE chunk_id = ?");
    for (const ch of chunks) {
      try { stmt.run(Number(ch.id)); }
      catch (/** @type {any} */ e) { _logError("fts", e); }
    }
  } catch (/** @type {any} */ e) {
    // FTS5 delete failures leak ghost rows; surfaced via getStatus().
    _logError("fts", e);
  }
}

/** Delete a single chunk from FTS by chunk_id. */
function ftsDeleteChunk(chunkId) {
  try { getDb().prepare("DELETE FROM kb_fts WHERE chunk_id = ?").run(chunkId); }
  catch (/** @type {any} */ e) { _logError("fts", e); }
}

/** Insert a chunk into FTS. */
function ftsInsertChunk(chunkId, heading, content) {
  try {
    const spacedHeading = spaceCJK(heading || "");
    getDb().prepare("INSERT INTO kb_fts(chunk_id, heading, content) VALUES (?,?,?)")
      .run(chunkId, spacedHeading, spaceCJK(content || ""));
  } catch (/** @type {any} */ e) {
    console.error("[kb] ftsInsertChunk error:", e.message);
  }
}

/** @param {string} query @param {number} limit @returns {any[]} */
function ftsSearch(query, limit) {
  const db = getDb();
  if (_hasFts5) {
    try {
      const terms = query.split(/\s+/).filter(Boolean);
      // Sanitize each term: strip FTS5 metacharacters that could change
      // query semantics or break the parser. Then quote + space-CJK.
      const spacedTerms = terms
        .map(t => sanitizeFtsTerm(spaceCJK(t)))
        .filter(t => t.length > 0)
        .map(t => '"' + t + '"');
      if (spacedTerms.length === 0) return [];
      const matchExpr = spacedTerms.join(" ");
      return db.prepare(
        'SELECT rowid, chunk_id, heading, snippet(kb_fts, 2, \'<mark>\', \'</mark>\', \'…\', 256) as snippet FROM kb_fts WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(matchExpr, limit);
    } catch (/** @type {any} */ e) {
      _logError("fts", e);
      return [];
    }
  }
  // LIKE fallback
  try {
    return db.prepare(
      "SELECT id as rowid, chunk_id, heading, content as snippet FROM kb_fts WHERE heading LIKE ? OR content LIKE ? LIMIT ?"
    ).all("%" + query + "%", "%" + query + "%", limit);
  } catch (/** @type {any} */ e) {
    _logError("fts", e);
    return [];
  }
}

// ── Local Model Path Resolution ──────────────────────────

function getLocalModelPath() {
  // In packaged app, extraResources land in process.resourcesPath
  const prodPath = join(process.resourcesPath || "", "models", "all-MiniLM-L6-v2");
  if (existsSync(join(prodPath, "config.json"))) return prodPath;

  // In dev, models are stored relative to this file: desktop/models/
  const devPath = join(__dirname, "..", "models", "all-MiniLM-L6-v2");
  if (existsSync(join(devPath, "config.json"))) return devPath;

  return null;
}

// ── Embedding Provider ────────────────────────────────────

/** @type {any} */
let _embedder = null;
let _embedderReady = false;

// Dynamic import with timeout — prevents hanging if native modules can't load
// (e.g. onnxruntime-node inside an Electron asar archive)
/** @param {string} moduleSpecifier @param {number} [timeoutMs] @returns {Promise<any>} */
async function importWithTimeout(moduleSpecifier, timeoutMs = 15000) {
  const result = await Promise.race([
    import(moduleSpecifier),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Import timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
  return result;
}

async function getEmbedder() {
  if (_embedderReady) return _embedder;

  const provider = _config.embeddingProvider || "local";

  // Build provider try-order: configured provider first, then fallbacks
  // IMPORTANT: If user explicitly chose "ollama", do NOT fall back to "local"
  // (local can hang in packaged asar builds due to onnxruntime-node native module loading)
  const providers = provider === "ollama"
    ? ["ollama"]
    : [provider, "ollama", "local"].filter((v, i, a) => a.indexOf(v) === i);

  for (const p of providers) {
    if (p === "local") {
      // [PACKAGING-FIX] — isElectron declared OUTSIDE try so finally can access it
      const isElectron = process.release?.name === "electron";
      if (isElectron) {
        console.log("[kb] Electron detected, release.name before patch:", process.release.name);
        try { Object.defineProperty(process.release, "name", { value: "node", configurable: true }); } catch (/** @type {any} */ e) {
          console.log("[kb] Failed to patch process.release.name:", e.message);
        }
        console.log("[kb] release.name after patch:", process.release.name);
      }
      try {

        console.log("[kb] Attempting to import @huggingface/transformers...");
        const { pipeline } = await importWithTimeout("@huggingface/transformers", 15000);
        console.log("[kb] Import succeeded");
        const localPath = getLocalModelPath();
        _embedder = localPath
          ? await pipeline("feature-extraction", localPath, { local_files_only: true })
          : await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        _embedderReady = true;
        console.log("[kb] Using local MiniLM-L6 embedder" + (localPath ? " (bundled)" : " (downloaded)"));
        return _embedder;
      } catch (/** @type {any} */ e) {
        console.log("[kb] Local embedder unavailable:", e.message);
      } finally {
        // Restore original release name to avoid side effects
        if (isElectron) {
          try { Object.defineProperty(process.release, "name", { value: "electron", configurable: true }); }
          catch (/** @type {any} */ e) { _logError("fs", e); }
        }
      }
    }

    if (p === "ollama") {
      try {
        const ollamaModel = _config.ollamaEmbedModel || "nomic-embed-text";

        // Probe 1: detect native dimension (no dimensions param)
        const probe1 = await fetch("http://localhost:11434/api/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: ollamaModel, input: "test", options: { num_gpu: 99 } }),
          signal: AbortSignal.timeout(5000),
        });
        if (!probe1.ok) throw new Error("Ollama probe1 failed");
        const p1data = await probe1.json();
        const p1vec = p1data.embeddings?.[0];
        if (!p1vec) throw new Error("Ollama returned no embedding");

        const nativeDim = p1vec.length;

        // Probe 2: if native > 384, test whether model supports MRL (dimensions param)
        if (nativeDim > 384) {
          try {
            const probe2 = await fetch("http://localhost:11434/api/embed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: ollamaModel, input: "test", dimensions: 384, options: { num_gpu: 99 } }),
              signal: AbortSignal.timeout(5000),
            });
            if (probe2.ok) {
              const p2data = await probe2.json();
              const p2vec = p2data.embeddings?.[0];
              _embeddingDim = (p2vec && p2vec.length === 384) ? 384 : nativeDim;
            } else {
              _embeddingDim = nativeDim;
            }
          } catch {
            _embeddingDim = nativeDim;
          }
        }

        console.log(`[kb] Embedding dim: ${_embeddingDim} (native: ${nativeDim})${_embeddingDim < nativeDim ? ' via MRL' : _embeddingDim === 384 ? '' : ' (native >384, full dim stored)'}`);

        _embedder = { type: "ollama", model: ollamaModel };
        _embedderReady = true;
        console.log("[kb] Using Ollama embedder:", ollamaModel);
        // Auto-detect model context length (only if user hasn't overridden)
        if (_config.maxBodyChars === 0) {
          const ctx = await detectModelContext(ollamaModel);
          // 85% of context to leave tokenization headroom; assumes ~1.2 tok/char
          _autoDetectedMaxBodyChars = Math.floor(ctx * 0.85);
          console.log(`[kb] Auto-detected max body chars: ${_autoDetectedMaxBodyChars} (model context: ${ctx})`);
        }
        return _embedder;
      } catch (/** @type {any} */ e) {
        // Probe failure is expected (Ollama may not be running) and the
        // outer loop will try the next provider. Logged at debug level.
        _logError("embed", e);
      }
    }

  }

  console.log("[kb] No embedder available, vector search disabled");
  return null;
}

// Query Ollama /api/show for the model's actual context length
// Different model architectures use different keys: bert.context_length, qwen2.context_length, llama.context_length
/** @param {string} modelName @returns {Promise<number>} */
async function detectModelContext(modelName) {
  try {
    const res = await fetch("http://localhost:11434/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 2048;
    const data = await res.json();
    return data.model_info?.["bert.context_length"]
        || data.model_info?.["nomic-bert.context_length"]
        || data.model_info?.["qwen2.context_length"]
        || data.model_info?.["qwen3.context_length"]
        || data.model_info?.["llama.context_length"]
        || 2048;
  } catch { return 2048; }
}

/** @param {string} text @returns {Promise<Float32Array|null>} */
export async function embedText(text) {
  const embedder = await getEmbedder();
  if (!embedder) return null;

  try {
    if (embedder.type === "ollama") {
      const res = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(_embeddingDim === 384
          ? { model: _embedder.model, input: text, dimensions: 384, options: { num_gpu: 99 } }
          : { model: _embedder.model, input: text, options: { num_gpu: 99 } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data.embeddings?.[0];
      if (!vec) return null;
      const result = new Float32Array(_embeddingDim);
      for (let i = 0; i < Math.min(vec.length, _embeddingDim); i++) result[i] = vec[i];
      return result;
    }

    // Local HuggingFace transformer
    const output = await embedder(text, { pooling: "mean", normalize: true });
    const vec = output.data;
    // Auto-detect dimension on first local HF call
    if (vec.length !== _embeddingDim) {
      _embeddingDim = vec.length;
      console.log(`[kb] Local embedder dim: ${_embeddingDim}`);
    }
    const result = new Float32Array(_embeddingDim);
    for (let i = 0; i < Math.min(vec.length, _embeddingDim); i++) result[i] = vec[i];
    return result;
  } catch (/** @type {any} */ e) {
    console.error("[kb] Embed failed:", e.message);
    return null;
  }
}

// ── Vector Operations ─────────────────────────────────────

/** @param {Float32Array} vec @returns {Buffer} */
function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** @param {Buffer} buf @returns {Float32Array} */
function bufferToVector(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** @param {Float32Array|number[]} a @param {Float32Array|number[]} b @returns {number} */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    console.warn(`[kb] Dimension mismatch in similarity: ${a.length} vs ${b.length}. Rebuild index.`);
    return 0;
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Reciprocal Rank Fusion ────────────────────────────────

/** @param {Array<Array<{id:number, rank?:number}>>} resultLists @param {number} [k] @returns {Array<{id:number, score:number}>} */
function reciprocalRankFusion(resultLists, k = 60) {
  const scores = new Map();
  for (const results of resultLists) {
    results.forEach((doc, index) => {
      const rank = index + 1;
      const rrfScore = 1 / (k + rank);
      const id = typeof doc === "object" ? doc.id : doc;
      scores.set(id, (scores.get(id) || 0) + rrfScore);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}

// ── File Scanning ─────────────────────────────────────────

// Directories that should NEVER be indexed. These pollute search results
// with unrelated content (e.g. .opencode/node_modules/zod/README.md
// drowning out actual user notes). Configurable via setVaultExcludes.
const DEFAULT_SKIP_DIRS = new Set([
  ".obsidian",    // Obsidian config + plugins
  "node_modules", // npm/pnpm package internals (huge, noisy)
  ".git",         // git internals (binary)
  ".trash",       // Obsidian trash
  ".vscode",      // IDE config
  ".idea",        // JetBrains config
]);
let _customSkipDirs = new Set();

/**
 * Add custom directory names to skip during scanning.
 * @param {string[]} names
 */
export function setVaultExcludes(names) {
  _customSkipDirs = new Set((names || []).map(String));
}

/** @param {string} dir @param {string} baseDir @returns {Array<{relPath:string, filename:string, title:string, tags:string[], body:string, wordCount:number, mtimeMs:number}>} */
function scanVault(dir, baseDir) {
  /** @type {Array<{relPath:string, filename:string, title:string, tags:string[], body:string, wordCount:number, mtimeMs:number}>} */
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ..._customSkipDirs]);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...scanVault(fullPath, baseDir));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      try {
        const stat = statSync(fullPath);
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        const title = extractTitle(content, entry.name);
        /** @type {string[]} */
        const tags = extractTags(content);
        // Strip frontmatter and markdown for body (single source of truth)
        const body = stripNoteBody(content);
        results.push({
          relPath,
          filename: entry.name,
          title,
          tags,
          body,
          wordCount: body.length,
          mtimeMs: stat.mtimeMs,
        });
      } catch (/** @type {any} */ e) {
        console.warn(`[kb] Skipping ${fullPath}: ${e.message}`);
      }
    }
  }
  return results;
}

// ── Rebuild Index ─────────────────────────────────────────

/** @param {Function} [progressCb] @returns {Promise<{ok:boolean, indexed:number, embedded:number, chunked:number, failed:number, total:number}|{error:string}>} */
export async function rebuildIndex(progressCb) {
  if (!_vaultPath || !existsSync(_vaultPath)) return { error: "vault not set or not found" };

  // Pause watcher during rebuild to avoid double-processing
  const wasWatching = !!_watcher;
  stopWatcher();

  const db = getDb();
  const notes = scanVault(_vaultPath, _vaultPath);

  // Clear existing data (cascade deletes chunks/embeddings/FTS)
  try { db.exec("DELETE FROM kb_fts"); } catch (/** @type {any} */ e) { _logError("fts", e); }
  try { db.exec("DELETE FROM kb_embeddings"); } catch (/** @type {any} */ e) { _logError("db", e); }
  db.exec("DELETE FROM kb_chunks");
  db.exec("DELETE FROM kb_notes");

  let indexed = 0;
  let embedded = 0;
  let chunked = 0;
  let failed = 0;

  for (const note of notes) {
    try {
      // Insert note metadata
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const noteId = Number(result.lastInsertRowid);

      // Split into chunks
      const chunks = splitIntoChunks(note.body, note.title);
      if (chunks.length === 0) {
        // If no chunks created, create one from the whole body
        chunks.push({ heading: note.title, content: stripMarkdown(note.body) || "" });
      }

      const max = getEffectiveMaxBodyChars();

      // Process each chunk
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];

        // Insert chunk metadata
        const chunkResult = db.prepare(
          "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
        ).run(noteId, ci, chunk.heading, chunk.content);
        const chunkId = Number(chunkResult.lastInsertRowid);

        // Index in FTS
        ftsInsertChunk(chunkId, chunk.heading, chunk.content);

        // Generate embedding (truncated to maxBodyChars)
        const embedTextContent = (note.title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max);
        let embedding = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          embedding = await embedText(embedTextContent);
          if (embedding) break;
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
        }
        if (embedding) {
          db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
            .run(chunkId, vectorToBuffer(embedding), _embeddingDim);
          embedded++;
        } else {
          console.error(`[kb] Embed failed for chunk ${ci} of ${note.relPath}`);
          failed++;
        }
        chunked++;
      }

      indexed++;
      if (progressCb) progressCb({ indexed, embedded, chunked, failed, total: notes.length });
    } catch (/** @type {any} */ e) {
      console.error(`[kb] Failed to index ${note.relPath}:`, e.message);
    }
  }

  // Restart watcher if it was running before rebuild
  if (wasWatching) startWatcher();

  return { ok: true, indexed, embedded, chunked, failed, total: notes.length };
}

// ── Hybrid Search ─────────────────────────────────────────

// "I don't know" thresholds — empirically derived from your vault stats.
// VECTOR_SIMILARITY_FLOOR: with N=1345 chunks of 384-dim normalized vectors,
//   E[max random similarity] ≈ √(2·ln(N)/N) ≈ 0.08. Anything below 0.25 is
//   almost certainly noise from a query that has no semantic match in the vault.
// VECTOR_CONFIDENT_SIM: when FTS has no keyword matches, the query has no
//   lexical anchor. MiniLM-L6 is overconfident on short Chinese queries
//   (e.g. "本地大模型" → 数据宝地址 0.611, a non-match), so we require
//   >0.55 to be sure the match is real. This filters pure noise like
//   "asdfghjkl" (0.504), 焦虑 (0.424), 小说 (0.498).
// MIN_TOP_RRF_SCORE: even with FTS hit, a top RRF < 0.012 means rank ≥ 84 in a
//   single list — effectively random. Return [] rather than force-answer.
const VECTOR_SIMILARITY_FLOOR = 0.25;
const VECTOR_CONFIDENT_SIM = 0.55;
const MIN_TOP_RRF_SCORE = 0.012;

/**
 * Expand a query into 3-5 semantic variants using a small local chat model.
 * Falls back to [query] if rewrite is disabled, model unavailable, or times out.
 * @param {string} query
 * @returns {Promise<string[]>}
 */
async function rewriteQuery(query) {
  if (_config.queryRewriteEnabled === false) return [query];
  const cacheKey = query.toLowerCase().trim();
  if (rewriteCache.has(cacheKey)) return rewriteCache.get(cacheKey);
  // Coalesce concurrent calls PER KEY — if a rewrite for the same query is
  // already in flight, share its promise. Previously a single shared promise
  // caused query B to silently get query A's variant set (cross-query leakage).
  const existing = _rewriteInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const model = _config.queryRewriteModel || "qwen3.5:9b";
    // First call may need to load the model into RAM (cold start). Adaptive timeout.
    const isFirstCall = rewriteCache.size === 0 && !_rewriteEverSucceeded;
    const timeoutMs = isFirstCall ? 30000 : 3000;
    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: REWRITE_PROMPT.replace("{query}", query),
          stream: false,
          options: { temperature: 0.3, num_predict: 200, num_ctx: 512 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [query];
      const data = await res.json();
      const variants = String(data.response || "")
        .split("\n")
        .map((s) => s.trim().replace(/^[\d\-\.\)\*]+\s*/, ""))
        .filter((s) => s.length >= 2 && s.length <= 100 && s.toLowerCase() !== cacheKey)
        .slice(0, 5);
      const result = variants.length > 0 ? [query, ...variants] : [query];
      // LRU cache (evict oldest when full)
      if (rewriteCache.size >= REWRITE_CACHE_MAX) {
        const firstKey = rewriteCache.keys().next().value;
        rewriteCache.delete(firstKey);
      }
      rewriteCache.set(cacheKey, result);
      _rewriteEverSucceeded = true;
      return result;
    } catch (/** @type {any} */ e) {
      _logError("rewrite", e);
      return [query]; // Quietly fall back to original query
    } finally {
      _rewriteInFlight.delete(cacheKey); // Release per-key in-flight slot
    }
  })();
  _rewriteInFlight.set(cacheKey, promise);
  return promise;
}

/** @param {string} query @param {number} [limit] @returns {Promise<Array<{id:number, rel_path:string, title:string, tags:string[], snippet:string, heading:string, rrfScore:number}>>} */
export async function search(query, limit = 5) {
  if (!_vaultPath) return [];
  if (!query || !query.trim()) return [];

  const db = getDb();
  const searchLimit = limit * 3; // Over-fetch for RRF

  // 0. Query rewriting: get semantic variants (original + expansions).
  // Falls back to [query] if rewrite disabled, model unavailable, or times out.
  const variants = await rewriteQuery(query);

  // Pre-load all chunk vectors ONCE (avoid re-scanning for each variant).
  // Guard against runaway memory: a 384-dim Float32 vector is 1.5KB raw +
  // ~100B JS overhead. At 50K chunks this is ~75MB per concurrent search call.
  const allEmbeddings = db.prepare("SELECT chunk_id, embedding FROM kb_embeddings").all();
  if (allEmbeddings.length > 50000) {
    console.warn(
      `[kb] Large vector index (${allEmbeddings.length} chunks). ` +
      `Consider sqlite-vec extension or a smaller chunk size. ` +
      `Latency and memory will degrade linearly with chunk count.`
    );
  }
  /** @type {Array<{id:number, vec:Float32Array}>} */
  const allChunkVectors = allEmbeddings.map((r) => ({
    id: r.chunk_id,
    vec: bufferToVector(r.embedding),
  }));

  // 1+2. For each variant, run FTS + vector search in parallel.
  /** @type {Array<{ftsIds:Array<{id:number, rank:number, ftsResult:any}>, vecIds:Array<{id:number, rank:number}>, ftsResults:any[], topSim:number}>} */
  const variantResults = await Promise.all(variants.map(async (variant) => {
    const fts = ftsSearch(variant, searchLimit);
    const ftsIds = fts
      .map((r, i) => ({ id: Number(r.chunk_id), rank: i, ftsResult: r }))
      .filter((x) => x.id > 0);

    /** @type {Array<{id:number, rank:number}>} */
    let vecIds = [];
    let topSim = 0;
    try {
      const qe = await embedText(variant);
      if (qe) {
        const scored = allChunkVectors
          .map((c) => ({ id: c.id, sim: cosineSimilarity(qe, c.vec) }))
          .filter((r) => r.sim > VECTOR_SIMILARITY_FLOOR)
          .sort((a, b) => b.sim - a.sim);
        topSim = scored.length > 0 ? scored[0].sim : 0;
        vecIds = scored.slice(0, searchLimit).map((r, i) => ({ id: r.id, rank: i }));
      }
    } catch (/** @type {any} */ e) {
      console.error(`[kb] embedText failed for variant "${variant.slice(0, 50)}": ${e.message}`);
    }

    return { ftsIds, vecIds, ftsResults: fts, topSim };
  }));

  // 3. Aggregate RRF scores across all variants using MAX-per-variant.
  // For each variant, compute its (FTS + vector) RRF sum. For each chunk, keep
  // the best RRF score across all variants. This way a chunk that's a perfect
  // match for ONE variant (but noise for the others) still gets a high score.
  // The previous sum/Normalize approach was silently dropping such chunks.
  /** @type {Map<number, {score:number, ftsResult:any}>} */
  const chunkScores = new Map();
  let totalFtsHits = 0;
  // Only use the ORIGINAL query's vector sim for the "I don't know" gate —
  // a garbage rewritten variant's accidental high similarity should NOT
  // bypass the gate. (Bug fix: previously used max across all variants.)
  const originalTopVectorSim = variantResults[0]?.topSim || 0;
  for (const vr of variantResults) {
    totalFtsHits += vr.ftsIds.length;
    // Per-variant RRF: sum within this variant's FTS+vector lists
    /** @type {Map<number, number>} */
    const variantScores = new Map();
    for (const { id, rank, ftsResult } of vr.ftsIds) {
      variantScores.set(id, (variantScores.get(id) || 0) + 1 / (60 + rank + 1));
      // Capture the first FTS result we see (used for snippet later)
      if (!chunkScores.has(id) || !chunkScores.get(id).ftsResult) {
        if (ftsResult) {
          const cur = chunkScores.get(id) || { score: 0, ftsResult: null };
          cur.ftsResult = ftsResult;
          chunkScores.set(id, cur);
        }
      }
    }
    for (const { id, rank } of vr.vecIds) {
      variantScores.set(id, (variantScores.get(id) || 0) + 1 / (60 + rank + 1));
    }
    // For each chunk in this variant, take max with previous best
    for (const [id, vScore] of variantScores) {
      const cur = chunkScores.get(id) || { score: 0, ftsResult: null };
      if (vScore > cur.score) cur.score = vScore;
      chunkScores.set(id, cur);
    }
  }
  // Max possible score ≈ single-list top rank (1/61 ≈ 0.0164), so MIN_TOP_RRF_SCORE (0.012) still works.
  const fusedChunks = [...chunkScores.entries()]
    .map(([id, { score, ftsResult }]) => ({ id, score, ftsResult }))
    .sort((a, b) => b.score - a.score);

  // 3.1 "I don't know" gate — early bail.
  // Uses ORIGINAL query's vector sim only (not max across variants) to avoid
  // a garbage rewritten variant's accidental high similarity from bypassing
  // the gate.
  if (totalFtsHits === 0 && originalTopVectorSim < VECTOR_CONFIDENT_SIM) {
    return [];
  }
  if (!fusedChunks.length || fusedChunks[0].score < MIN_TOP_RRF_SCORE) {
    return [];
  }

  // 4. Aggregate chunks by parent note — for each note, keep only its best chunk
  /** @type {Map<number, {noteId:number, chunkId:number, score:number, heading:string, snippet:string}>} */
  const bestPerNote = new Map();
  const chunkToNote = new Map();

  // Batched lookup: single query for all chunk IDs instead of N+1.
  // If fusedChunks is large (50-150), this is a 100x+ speedup.
  if (fusedChunks.length > 0) {
    try {
      const ids = fusedChunks.map((c) => c.id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, note_id, heading, content FROM kb_chunks WHERE id IN (${placeholders})`
      ).all(...ids);
      for (const row of rows) {
        chunkToNote.set(Number(row.id), {
          noteId: Number(row.note_id),
          heading: String(row.heading),
          content: String(row.content),
        });
      }
    } catch (/** @type {any} */ e) {
      console.error(`[kb] batched chunk lookup failed: ${e.message}`);
    }
  }

  for (const { id: chunkId, score, ftsResult } of fusedChunks) {
    const mapping = chunkToNote.get(chunkId);
    if (!mapping) continue;
    const { noteId, heading, content } = mapping;

    // Use the FTS snippet if any variant contributed an FTS hit; else fall
    // back to first 300 chars of the chunk content.
    const snippet = ftsResult?.snippet || content.slice(0, 300);

    if (!bestPerNote.has(noteId) || score > bestPerNote.get(noteId).score) {
      bestPerNote.set(noteId, { noteId, chunkId, score, heading, snippet });
    }
  }

  // 5. Sort notes by their best chunk's score, return top-K
  // 5. Aggregate chunks by parent note (best per note) — hydrate full results.
  // Take top `rerankTopN` (independent of `limit`) so LLM rerank has a buffer
  // to swap in better candidates. e.g. limit=5 + rerankTopN=30 → fetch 30, rerank, return 5.
  const rerankTopN = _config.rerankTopN || 30;
  const sortedNotes = [...bestPerNote.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, rerankTopN);

  /** @type {Array<{id:number, rel_path:string, title:string, tags:string[], snippet:string, heading:string, rrfScore:number}>} */
  const candidates = [];
  for (const [noteId, best] of sortedNotes) {
    try {
      const note = db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(noteId);
      if (!note) continue;
      candidates.push({
        id: Number(note.id),
        rel_path: String(note.rel_path),
        title: String(note.title),
        tags: JSON.parse(String(note.tags || "[]")),
        snippet: best.snippet,
        heading: best.heading,
        rrfScore: best.score,
      });
    } catch (/** @type {any} */ e) {
      // Per-candidate hydration failure: skip this candidate and continue
      // with the rest. If this fires often, the index may be corrupt.
      _logError("db", e);
    }
  }

  // 6. Optional LLM rerank — reorders candidates by semantic relevance.
  // Falls back gracefully to RRF order if model is unavailable / times out.
  if (candidates.length > limit) {
    const reranked = await rerankResults(query, candidates, limit);
    if (reranked && reranked.length > 0) return reranked;
  }
  return candidates.slice(0, limit);
}

/**
 * Use a small local chat model to rerank top-N candidates by relevance to the query.
 * Cache key: query + ordered list of candidate ids (so the same query against
 * the same index state returns the same rerank without an LLM call).
 * @param {string} query
 * @param {Array<{id:number, rel_path:string, title:string, snippet:string}>} candidates
 * @param {number} limit
 * @returns {Promise<Array<any>|null>} Reranked top-`limit`, or null on failure
 */
async function rerankResults(query, candidates, limit) {
  if (_config.rerankEnabled === false) return null;

  // Cache: identical query + identical candidate set → reuse previous order
  const cacheKey = query.toLowerCase().trim() + "|" + candidates.map((c) => c.id).join(",");
  if (rerankCache.has(cacheKey)) {
    const cachedIndices = rerankCache.get(cacheKey);
    return cachedIndices.map((i) => candidates[i]).filter(Boolean).slice(0, limit);
  }
  // Coalesce concurrent calls PER KEY — share promise for identical query+set.
  // Previously a single shared promise leaked the first in-flight's result to
  // every concurrent call (cross-query contamination).
  const existing = _rerankInFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const model = _config.rerankModel || "gemma4:e4b";
    // Build the candidates block: title + truncated snippet. Keep snippets small
    // (150 chars) so 15 candidates fit comfortably in a 4K-token context.
    const items = candidates
      .map((c, i) => `[${i + 1}] ${c.title}\n${(c.snippet || "").slice(0, 150).replace(/\s+/g, " ")}`)
      .join("\n\n");
    const prompt = RERANK_PROMPT
      .replace("{query}", query)
      .replace("{candidates}", items);

    // First call may need to load the model into RAM (10-30s on cold start).
    // Adaptive timeout: 30s for the first call, 8s for warm ones.
    const isFirstCall = rerankCache.size === 0 && !_rerankEverSucceeded;
    const timeoutMs = isFirstCall ? 30000 : 8000;

    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.0, num_predict: 200, num_ctx: 4096 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = String(data.response || "");
      // Parse "3,1,5,2" → [3, 1, 5, 2]; tolerate "3 1 5 2" or "3,1,5,2,"
      const parsed = text
        .match(/\d+/g)
        ?.map((s) => parseInt(s, 10) - 1)
        .filter((i) => i >= 0 && i < candidates.length) || [];
      // Dedup while preserving order
      const seen = new Set();
      const unique = [];
      for (const i of parsed) {
        if (!seen.has(i)) {
          seen.add(i);
          unique.push(i);
        }
      }
      if (unique.length === 0) return null;
      // LRU cache (evict oldest)
      if (rerankCache.size >= RERANK_CACHE_MAX) {
        const firstKey = rerankCache.keys().next().value;
        rerankCache.delete(firstKey);
      }
      rerankCache.set(cacheKey, unique);
      _rerankEverSucceeded = true;
      return unique.slice(0, limit).map((i) => candidates[i]);
    } catch (/** @type {any} */ e) {
      _logError("rerank", e);
      return null; // Quietly fall back to RRF order
    } finally {
      _rerankInFlight.delete(cacheKey); // Release per-key in-flight slot
    }
  })();
  _rerankInFlight.set(cacheKey, promise);
  return promise;
}

// ── CRUD Operations ───────────────────────────────────────

export function listNotes(offset = 0, limit = 50) {
  const db = getDb();
  try {
    const total = Number(db.prepare("SELECT COUNT(*) as count FROM kb_notes").get()?.count ?? 0);
    const notes = db.prepare("SELECT * FROM kb_notes ORDER BY mtime_ms DESC LIMIT ? OFFSET ?").all(limit, offset);
    return {
      total,
      notes: notes.map(/** @param {any} n */ n => ({
        id: n.id,
        rel_path: n.rel_path,
        filename: n.filename,
        title: n.title,
        tags: JSON.parse(String(n.tags || "[]")),
        word_count: Number(n.word_count),
        mtime_ms: Number(n.mtime_ms),
      })),
    };
  } catch (/** @type {any} */ e) {
    // listNotes is read-only; on DB error, return empty list and log.
    _logError("db", e);
    return { total: 0, notes: [] };
  }
}

/** @param {string} relPath @returns {object|null} */
export function getNote(relPath) {
  const db = getDb();
  try {
    const note = db.prepare("SELECT * FROM kb_notes WHERE rel_path = ?").get(relPath);
    if (!note) return null;
    // Read actual file content
    const fullPath = join(_vaultPath, relPath);
    const content = readFileSync(fullPath, "utf-8");
    return {
      ...note,
      tags: JSON.parse(String(note.tags || "[]")),
      content,
    };
  } catch (/** @type {any} */ e) {
    // getNote is read-only; on missing file or DB error, return null and log.
    _logError("db", e);
    return null;
  }
}

/** @param {string} relPath @param {string} content @param {string[]} [tags] @returns {Promise<{ok:boolean, relPath:string, title:string}|{error:string}>} */
export async function createNote(relPath, content, tags = []) {
  if (!_vaultPath) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(_vaultPath, relPath);

  try {
    // Ensure directory exists
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Write file
    writeFileSync(fullPath, content, "utf-8");

    // Index the new note
    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    const noteTags = tags.length > 0 ? tags : extractTags(content);
    const body = stripNoteBody(content);

    const db = getDb();
    const noteResult = db.prepare(
      "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(relPath, basename(relPath), title, JSON.stringify(noteTags), body.length, stat.mtimeMs, new Date().toISOString(), new Date().toISOString());
    const noteId = Number(noteResult.lastInsertRowid);

    // Split into chunks and index each
    const chunks = splitIntoChunks(body, title);
    if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });

    const max = getEffectiveMaxBodyChars();
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkResult = db.prepare(
        "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
      ).run(noteId, ci, chunk.heading, chunk.content);
      const chunkId = Number(chunkResult.lastInsertRowid);

      ftsInsertChunk(chunkId, chunk.heading, chunk.content);

      try {
        const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, max));
        if (embedding) {
          db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
            .run(chunkId, vectorToBuffer(embedding), _embeddingDim);
        }
      } catch (/** @type {any} */ e) {
        _logError("embed", e);
      }
    }

    return { ok: true, relPath, title };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}

/** @param {string} relPath @param {string} content @returns {Promise<{ok:boolean, relPath:string, title:string}|{error:string}>} */
export async function updateNote(relPath, content) {
  if (!_vaultPath) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(_vaultPath, relPath);

  try {
    writeFileSync(fullPath, content, "utf-8");

    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    /** @type {string[]} */
    const tags = extractTags(content);
    const body = stripNoteBody(content);

    const db = getDb();
    db.prepare(
      "UPDATE kb_notes SET title=?, tags=?, word_count=?, mtime_ms=?, updated_at=? WHERE rel_path=?"
    ).run(title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), relPath);

    // Remove old chunks, then re-chunk
    const noteRow = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    const noteId = noteRow ? Number(noteRow.id) : null;
    if (noteId) {
      // Delete old chunks (cascade deletes FTS + embeddings)
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(noteId);

      // Split into new chunks
      const chunks = splitIntoChunks(body, title);
      if (chunks.length === 0) chunks.push({ heading: title, content: stripMarkdown(body) || "" });

      const max = getEffectiveMaxBodyChars();
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkResult = db.prepare(
          "INSERT INTO kb_chunks(note_id, chunk_index, heading, content) VALUES (?,?,?,?)"
        ).run(noteId, ci, chunk.heading, chunk.content);
        const chunkId = Number(chunkResult.lastInsertRowid);

        ftsInsertChunk(chunkId, chunk.heading, chunk.content);

        try {
          const embedding = await embedText((title + "\n" + chunk.heading + "\n" + chunk.content).slice(0, getEffectiveMaxBodyChars()));
          if (embedding) {
            db.prepare("INSERT INTO kb_embeddings(chunk_id, embedding, dim) VALUES (?,?,?)")
              .run(chunkId, vectorToBuffer(embedding), _embeddingDim);
          }
        } catch (/** @type {any} */ e) {
          _logError("embed", e);
        }
      }
    }

    return { ok: true, relPath, title };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}

/** @param {string} relPath @returns {{ok:boolean, relPath:string}|{error:string}} */
export function deleteNote(relPath) {
  if (!_vaultPath) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(_vaultPath, relPath);

  try {
    // Delete file
    if (existsSync(fullPath)) unlinkSync(fullPath);

    // Delete from DB (cascade: CASCADE deletes chunks → embeddings → auto-handles FK)
    const db = getDb();
    // Delete chunks explicitly (cascades triggers FTS cleanup)
    const noteRow = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    if (noteRow) {
      db.prepare("DELETE FROM kb_chunks WHERE note_id = ?").run(Number(noteRow.id));
    }
    db.prepare("DELETE FROM kb_notes WHERE rel_path = ?").run(relPath);

    return { ok: true, relPath };
  } catch (/** @type {any} */ e) { return { error: e.message }; }
}

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
    return {
      vault: _vaultPath,
      noteCount,
      chunkCount,
      embeddedCount,
      watcherActive,
      embeddingProvider: _config.embeddingProvider,
      maxBodyChars: _config.maxBodyChars,
      autoDetectedMaxBodyChars: _autoDetectedMaxBodyChars,
      effectiveMaxBodyChars: getEffectiveMaxBodyChars(),
      // Expose error counters so operators can detect degraded operation
      // (silent FTS drift, embed failures, etc.) without grepping logs.
      errorCounts: { ..._errCounts },
    };
  } catch (/** @type {any} */ e) {
    _logError("db", e);
    return { vault: _vaultPath, noteCount: 0, chunkCount: 0, embeddedCount: 0, errorCounts: { ..._errCounts } };
  }
}
