/**
 * GoodAgent Knowledge Store — Hybrid RAG (FTS5 + Vector Embeddings)
 *
 * Provides Obsidian vault indexing, full-text search, vector embeddings,
 * and hybrid search via Reciprocal Rank Fusion (RRF).
 *
 * DB: ~/.goodagent/knowledge.db
 * Config: ~/.goodagent/kb-config.json
 */

import { join, relative, extname, basename, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const DATA_DIR = join(HOME, ".goodagent");
const DB_PATH = join(DATA_DIR, "knowledge.db");
const CONFIG_PATH = join(DATA_DIR, "kb-config.json");
const EMBEDDING_DIM = 384; // Unified dimension for all providers

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function isSafeVaultPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  const resolved = join(_vaultPath, relPath);
  return resolved.startsWith(_vaultPath);
}

// ── Configuration ─────────────────────────────────────────

let _vaultPath = "";
let _config = { embeddingProvider: "local", maxNotes: 20, maxChars: 20000 };

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    _vaultPath = cfg.vaultPath || "";
    _config = { ..._config, ...cfg };
  } catch { /* ignored */ }
}

function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ..._config, vaultPath: _vaultPath }, null, 2), "utf-8");
  } catch { /* ignored */ }
}

loadConfig();

export function getVault() { return _vaultPath; }
export function getConfig() { return { ..._config, vaultPath: _vaultPath }; }

export function setVault(path) {
  if (path !== "" && (typeof path !== "string" || !existsSync(path))) return { error: "path does not exist" };
  _vaultPath = path || "";
  saveConfig();
  return { ok: true, vault: _vaultPath };
}

export function setConfig(cfg) {
  if (cfg.embeddingProvider) _config.embeddingProvider = cfg.embeddingProvider;
  if (cfg.maxNotes) _config.maxNotes = Math.max(1, Math.min(100, cfg.maxNotes));
  if (cfg.maxChars) _config.maxChars = Math.max(100, Math.min(50000, cfg.maxChars));
  saveConfig();
  return { ok: true, config: _config };
}

// Space out CJK characters individually so FTS5 unicode61 tokenizes them as separate tokens.
// "故宫博物院" → "故 宫 博 物 院"
function spaceCJK(text) {
  if (!text) return text;
  return text.replace(/([一-鿿㐀-䶿⺀-⻿])/g, "$1 ").trim();
}

// ── Frontmatter Parser ────────────────────────────────────

function parseFrontMatter(text) {
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

function extractTags(text) {
  const fm = parseFrontMatter(text);
  const tags = new Set(fm.tags);
  // Also extract inline #tags
  const inlineTags = text.matchAll(/(?<=^|\s)#([a-zA-Z一-鿿][\w一-鿿-]*)/gm);
  for (const m of inlineTags) tags.add(m[1]);
  return [...tags];
}

// ── Database ──────────────────────────────────────────────

let _db = null;
let _hasFts5 = false;

function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");

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

  // Try FTS5 first, fallback to regular table
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        rel_path UNINDEXED,
        title,
        tags,
        body,
        tokenize='unicode61'
      )
    `);
    _hasFts5 = true;
    console.log("[kb] FTS5 available");
  } catch (e) {
    console.log("[kb] FTS5 not available, using LIKE search:", e.message);
    _hasFts5 = false;
    try {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS kb_fts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rel_path TEXT,
          title TEXT,
          tags TEXT,
          body TEXT
        )
      `);
    } catch { /* ignored */ }
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      note_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      FOREIGN KEY(note_id) REFERENCES kb_notes(id) ON DELETE CASCADE
    )
  `);

  return _db;
}

// ── FTS Operations ────────────────────────────────────────

function ftsDelete(relPath) {
  try { getDb().prepare("DELETE FROM kb_fts WHERE rel_path = ?").run(relPath); } catch { /* ignored */ }
}

function ftsInsert(relPath, title, tags, body) {
  try {
    ftsDelete(relPath);
    // Space CJK characters so unicode61 tokenizes them individually
    getDb().prepare("INSERT INTO kb_fts(rel_path, title, tags, body) VALUES (?,?,?,?)")
      .run(relPath, spaceCJK(title || ""), spaceCJK((tags || []).join(" ")), spaceCJK(body || ""));
  } catch (e) {
    console.error("[kb] ftsInsert error:", e.message);
  }
}

function ftsSearch(query, limit) {
  const db = getDb();
  if (_hasFts5) {
    try {
      // Split query into terms, space CJK chars in each, wrap each as phrase, join with AND
      const terms = query.split(/\s+/).filter(Boolean);
      const spacedTerms = terms.map(t => '"' + spaceCJK(t) + '"');
      const matchExpr = spacedTerms.join(" ");
      return db.prepare(
        'SELECT rowid, rel_path, title, tags, snippet(kb_fts, 3, \'<mark>\', \'</mark>\', \'…\', 64) as snippet FROM kb_fts WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(matchExpr, limit);
    } catch { /* ignored */ }
  }
  // LIKE fallback
  try {
    return db.prepare(
      "SELECT id as rowid, rel_path, title, tags, body as snippet FROM kb_fts WHERE title LIKE ? OR tags LIKE ? OR body LIKE ? LIMIT ?"
    ).all("%" + query + "%", "%" + query + "%", "%" + query + "%", limit);
  } catch { return []; }
}

// ── Embedding Provider ────────────────────────────────────

let _embedder = null;
let _embedderReady = false;

async function getEmbedder() {
  if (_embedderReady) return _embedder;

  const provider = _config.embeddingProvider || "local";

  // Try configured provider first, then auto-detect fallbacks
  const providers = [provider, "ollama", "local"].filter((v, i, a) => a.indexOf(v) === i);

  for (const p of providers) {
    if (p === "local") {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        _embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        _embedderReady = true;
        console.log("[kb] Using local MiniLM-L6 embedder");
        return _embedder;
      } catch (e) {
        console.log("[kb] Local embedder unavailable:", e.message);
      }
    }

    if (p === "ollama") {
      try {
        const res = await fetch("http://localhost:11434/api/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "nomic-embed-text", input: "test" }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          _embedder = { type: "ollama", model: "nomic-embed-text" };
          _embedderReady = true;
          console.log("[kb] Using Ollama embedder");
          return _embedder;
        }
      } catch { /* ignored */ }
    }

    if (p === "deepseek") {
      _embedder = { type: "deepseek" };
      _embedderReady = true;
      console.log("[kb] Using DeepSeek embedder");
      return _embedder;
    }
  }

  console.log("[kb] No embedder available, vector search disabled");
  return null;
}

async function embedText(text) {
  const embedder = await getEmbedder();
  if (!embedder) return null;

  try {
    if (embedder.type === "ollama") {
      const res = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data.embeddings?.[0];
      if (!vec) return null;
      // Truncate/pad to EMBEDDING_DIM
      const result = new Float32Array(EMBEDDING_DIM);
      for (let i = 0; i < Math.min(vec.length, EMBEDDING_DIM); i++) result[i] = vec[i];
      return result;
    }

    if (embedder.type === "deepseek") {
      // Will be handled by main process passing API key
      return null;
    }

    // Local HuggingFace transformer
    const output = await embedder(text, { pooling: "mean", normalize: true });
    const vec = output.data;
    const result = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < Math.min(vec.length, EMBEDDING_DIM); i++) result[i] = vec[i];
    return result;
  } catch (e) {
    console.error("[kb] Embed failed:", e.message);
    return null;
  }
}

// ── Vector Operations ─────────────────────────────────────

function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function bufferToVector(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a, b) {
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

function scanVault(dir, baseDir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip .obsidian directory
      if (entry.name === ".obsidian") continue;
      results.push(...scanVault(fullPath, baseDir));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      try {
        const stat = statSync(fullPath);
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        const title = extractTitle(content, entry.name);
        const tags = extractTags(content);
        // Strip frontmatter and markdown for body
        const body = content
          .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
          .replace(/#{1,6}\s+/g, "")
          .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
          .replace(/[*_`~]/g, "")
          .replace(/\n{2,}/g, "\n")
          .trim();
        results.push({
          relPath,
          filename: entry.name,
          title,
          tags,
          body,
          wordCount: body.length,
          mtimeMs: stat.mtimeMs,
        });
      } catch { /* ignored */ }
    }
  }
  return results;
}

// ── Rebuild Index ─────────────────────────────────────────

export async function rebuildIndex(progressCb) {
  if (!_vaultPath || !existsSync(_vaultPath)) return { error: "vault not set or not found" };

  const db = getDb();
  const notes = scanVault(_vaultPath, _vaultPath);

  // Clear existing data
  try { db.exec("DELETE FROM kb_fts"); } catch { /* ignored */ }
  try { db.exec("DELETE FROM kb_embeddings"); } catch { /* ignored */ }
  db.exec("DELETE FROM kb_notes");

  let indexed = 0;
  let embedded = 0;

  for (const note of notes) {
    try {
      // Insert note metadata
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const noteId = result.lastInsertRowid;

      // Insert into FTS
      ftsInsert(note.relPath, note.title, note.tags, note.body);

      // Generate embedding
      try {
        const embedding = await embedText(note.title + "\n" + note.body.slice(0, 1000));
        if (embedding) {
          db.prepare("INSERT INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
            .run(noteId, vectorToBuffer(embedding), EMBEDDING_DIM);
          embedded++;
        }
      } catch { /* ignored */ }

      indexed++;
      if (progressCb) progressCb({ indexed, embedded, total: notes.length });
    } catch (e) {
      console.error(`[kb] Failed to index ${note.relPath}:`, e.message);
    }
  }

  return { ok: true, indexed, embedded, total: notes.length };
}

// ── Hybrid Search ─────────────────────────────────────────

export async function search(query, limit = 5) {
  if (!_vaultPath) return [];
  if (!query || !query.trim()) return [];

  const db = getDb();
  const searchLimit = limit * 3; // Over-fetch for RRF

  // 1. Text keyword search (FTS5 or LIKE fallback)
  let ftsResults = ftsSearch(query, searchLimit);

  // 2. Vector similarity search
  let vectorResults = [];
  try {
    const queryEmbedding = await embedText(query);
    if (queryEmbedding) {
      const allEmbeddings = db.prepare("SELECT note_id, embedding FROM kb_embeddings").all();
      vectorResults = allEmbeddings
        .map(row => ({
          id: row.note_id,
          similarity: cosineSimilarity(queryEmbedding, bufferToVector(row.embedding)),
        }))
        .filter(r => r.similarity > 0.1)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, searchLimit);
    }
  } catch { /* ignored */ }

  // 3. Fuse with RRF — use rel_path as the join key (FTS rowid != kb_notes.id)
  const ftsIds = ftsResults.map((r, i) => {
    const note = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(r.rel_path);
    return note ? { id: note.id, rank: i } : null;
  }).filter(Boolean);
  const vecIds = vectorResults.map((r, i) => ({ id: r.id, rank: i }));

  let fused;
  if (ftsIds.length > 0 && vecIds.length > 0) {
    fused = reciprocalRankFusion([ftsIds, vecIds]);
  } else if (ftsIds.length > 0) {
    fused = ftsIds.map((r, i) => ({ id: r.id, score: 1 / (60 + i + 1) }));
  } else if (vecIds.length > 0) {
    fused = vecIds.map((r, i) => ({ id: r.id, score: 1 / (60 + i + 1) }));
  } else {
    return [];
  }

  // 4. Return top-K with content
  const topIds = fused.slice(0, limit);
  const results = [];

  for (const { id, score } of topIds) {
    try {
      const note = db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(id);
      if (!note) continue;
      // Read full note content from file, fallback to FTS snippet
      let snippet = note.title;
      try {
        const fullPath = join(_vaultPath, note.rel_path);
        snippet = readFileSync(fullPath, "utf-8");
      } catch {
        const ftsMatch = ftsResults.find(r => r.rel_path === note.rel_path);
        snippet = ftsMatch?.snippet || note.title;
      }
      results.push({
        id: note.id,
        rel_path: note.rel_path,
        title: note.title,
        tags: JSON.parse(note.tags || "[]"),
        snippet,
        rrfScore: score,
      });
    } catch { /* ignored */ }
  }

  return results;
}

// ── CRUD Operations ───────────────────────────────────────

export function listNotes(offset = 0, limit = 50) {
  const db = getDb();
  try {
    const total = db.prepare("SELECT COUNT(*) as count FROM kb_notes").get().count;
    const notes = db.prepare("SELECT * FROM kb_notes ORDER BY mtime_ms DESC LIMIT ? OFFSET ?").all(limit, offset);
    return {
      total,
      notes: notes.map(n => ({
        id: n.id,
        rel_path: n.rel_path,
        filename: n.filename,
        title: n.title,
        tags: JSON.parse(n.tags || "[]"),
        word_count: n.word_count,
        mtime_ms: n.mtime_ms,
      })),
    };
  } catch { return { total: 0, notes: [] }; }
}

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
      tags: JSON.parse(note.tags || "[]"),
      content,
    };
  } catch { return null; }
}

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
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").replace(/#{1,6}\s+/g, "").trim();

    const db = getDb();
    const result = db.prepare(
      "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(relPath, basename(relPath), title, JSON.stringify(noteTags), body.length, stat.mtimeMs, new Date().toISOString(), new Date().toISOString());

    ftsInsert(relPath, title, noteTags, body);

    // Generate embedding (block until done so search is consistent)
    try {
      const embedding = await embedText(title + "\n" + body.slice(0, 1000));
      if (embedding) {
        getDb().prepare("INSERT INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
          .run(result.lastInsertRowid, vectorToBuffer(embedding), EMBEDDING_DIM);
      }
    } catch { /* ignored */ }

    return { ok: true, relPath, title };
  } catch (e) { return { error: e.message }; }
}

export async function updateNote(relPath, content) {
  if (!_vaultPath) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(_vaultPath, relPath);

  try {
    writeFileSync(fullPath, content, "utf-8");

    const stat = statSync(fullPath);
    const title = extractTitle(content, basename(relPath));
    const tags = extractTags(content);
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").replace(/#{1,6}\s+/g, "").trim();

    const db = getDb();
    db.prepare(
      "UPDATE kb_notes SET title=?, tags=?, word_count=?, mtime_ms=?, updated_at=? WHERE rel_path=?"
    ).run(title, JSON.stringify(tags), body.length, stat.mtimeMs, new Date().toISOString(), relPath);

    ftsInsert(relPath, title, tags, body);

    // Update embedding (block until done so search is consistent)
    try {
      const embedding = await embedText(title + "\n" + body.slice(0, 1000));
      if (embedding) {
        const note = getDb().prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
        if (note) {
          getDb().prepare("REPLACE INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
            .run(note.id, vectorToBuffer(embedding), EMBEDDING_DIM);
        }
      }
    } catch { /* ignored */ }

    return { ok: true, relPath, title };
  } catch (e) { return { error: e.message }; }
}

export function deleteNote(relPath) {
  if (!_vaultPath) return { error: "vault not set" };
  if (!isSafeVaultPath(relPath)) return { error: "invalid path" };
  const fullPath = join(_vaultPath, relPath);

  try {
    // Delete file
    if (existsSync(fullPath)) unlinkSync(fullPath);

    // Delete from DB
    const db = getDb();
    const note = db.prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
    if (note) {
      db.prepare("DELETE FROM kb_embeddings WHERE note_id = ?").run(note.id);
    }
    db.prepare("DELETE FROM kb_notes WHERE rel_path = ?").run(relPath);
    ftsDelete(relPath);

    return { ok: true, relPath };
  } catch (e) { return { error: e.message }; }
}

// ── Status ────────────────────────────────────────────────

export function getStatus() {
  const db = getDb();
  try {
    const noteCount = db.prepare("SELECT COUNT(*) as count FROM kb_notes").get().count;
    const embeddedCount = db.prepare("SELECT COUNT(*) as count FROM kb_embeddings").get().count;
    return {
      vault: _vaultPath,
      noteCount,
      embeddedCount,
      embeddingProvider: _config.embeddingProvider,
    };
  } catch { return { vault: _vaultPath, noteCount: 0, embeddedCount: 0 }; }
}
