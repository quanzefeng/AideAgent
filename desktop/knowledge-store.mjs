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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = homedir();
const DATA_DIR = join(HOME, ".aideagent");
const DB_PATH = join(DATA_DIR, "knowledge.db");
const CONFIG_PATH = join(DATA_DIR, "kb-config.json");
let _embeddingDim = 384; // Auto-detected at runtime from the actual embedding model

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function isSafeVaultPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  const resolved = join(_vaultPath, relPath);
  return resolved.startsWith(_vaultPath);
}

// ── Configuration ─────────────────────────────────────────

let _vaultPath = "";
let _config = { embeddingProvider: "local", ollamaEmbedModel: "nomic-embed-text", maxNotes: 20, maxChars: 20000, maxBodyChars: 0 };
// maxBodyChars: 0 = auto-detect from Ollama model context, >0 = user override

// Cached auto-detected limit (computed in getEmbedder when provider is ollama)
let _autoDetectedMaxBodyChars = 0;

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
  if (cfg.ollamaEmbedModel && cfg.ollamaEmbedModel !== _config.ollamaEmbedModel) {
    _config.ollamaEmbedModel = cfg.ollamaEmbedModel;
    _embedderReady = false; // re-init with new model name
  }
  if (cfg.maxNotes) _config.maxNotes = Math.max(1, Math.min(100, cfg.maxNotes));
  if (cfg.maxChars) _config.maxChars = Math.max(100, Math.min(50000, cfg.maxChars));
  if (cfg.maxBodyChars !== undefined) _config.maxBodyChars = Math.max(0, Math.min(100000, parseInt(cfg.maxBodyChars) || 0));
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
    // Prepend filename (without extension) to title so filenames are searchable
    const filenameOnly = basename(relPath, ".md");
    const spacedFilename = spaceCJK(filenameOnly);
    const spacedTitle = spaceCJK(title || "");
    const finalTitle = (spacedFilename + " " + spacedTitle).trim();
    getDb().prepare("INSERT INTO kb_fts(rel_path, title, tags, body) VALUES (?,?,?,?)")
      .run(relPath, finalTitle, spaceCJK((tags || []).join(" ")), spaceCJK(body || ""));
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
        'SELECT rowid, rel_path, title, tags, snippet(kb_fts, 3, \'<mark>\', \'</mark>\', \'…\', 256) as snippet FROM kb_fts WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(matchExpr, limit);
    } catch { /* ignored */ }
  }
  // LIKE fallback
  try {
    return db.prepare(
      "SELECT id as rowid, rel_path, title, tags, body as snippet FROM kb_fts WHERE title LIKE ? OR tags LIKE ? OR body LIKE ? OR rel_path LIKE ? LIMIT ?"
    ).all("%" + query + "%", "%" + query + "%", "%" + query + "%", "%" + query + "%", limit);
  } catch { return []; }
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

let _embedder = null;
let _embedderReady = false;

// Dynamic import with timeout — prevents hanging if native modules can't load
// (e.g. onnxruntime-node inside an Electron asar archive)
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
        try { Object.defineProperty(process.release, "name", { value: "node", configurable: true }); } catch (e) {
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
      } catch (e) {
        console.log("[kb] Local embedder unavailable:", e.message);
      } finally {
        // Restore original release name to avoid side effects
        if (isElectron) {
          try { Object.defineProperty(process.release, "name", { value: "electron", configurable: true }); } catch {}
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
      } catch { /* ignored */ }
    }

  }

  console.log("[kb] No embedder available, vector search disabled");
  return null;
}

// Query Ollama /api/show for the model's actual context length
// Different model architectures use different keys: bert.context_length, qwen2.context_length, llama.context_length
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

async function embedText(text) {
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
  let failed = 0;

  for (const note of notes) {
    try {
      // Insert note metadata
      const result = db.prepare(
        "INSERT INTO kb_notes(rel_path, filename, title, tags, word_count, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(note.relPath, note.filename, note.title, JSON.stringify(note.tags), note.wordCount, note.mtimeMs, new Date().toISOString(), new Date().toISOString());
      const noteId = result.lastInsertRowid;

      // Insert into FTS
      ftsInsert(note.relPath, note.title, note.tags, note.body);

      // Generate embedding with retry (recovers from Ollama cold-start timeouts)
      // Simple head truncation: text is capped at maxBodyChars (auto-detected from model context
      // on first Ollama call, or set manually in KB settings)
      const max = getEffectiveMaxBodyChars();
      const text = (note.title + "\n" + note.body).slice(0, max);
      let embedding = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        embedding = await embedText(text);
        if (embedding) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
      }
      if (embedding) {
        db.prepare("INSERT INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
          .run(noteId, vectorToBuffer(embedding), _embeddingDim);
        embedded++;
      } else {
        console.error(`[kb] Embed failed after 3 attempts: ${note.relPath}`);
        failed++;
      }

      indexed++;
      if (progressCb) progressCb({ indexed, embedded, failed, total: notes.length });
    } catch (e) {
      console.error(`[kb] Failed to index ${note.relPath}:`, e.message);
    }
  }

  return { ok: true, indexed, embedded, failed, total: notes.length };
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
      const max = getEffectiveMaxBodyChars();
      const embedding = await embedText(title + "\n" + body.slice(0, max));
      if (embedding) {
          getDb().prepare("INSERT INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
            .run(result.lastInsertRowid, vectorToBuffer(embedding), _embeddingDim);
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
      const max = getEffectiveMaxBodyChars();
      const embedding = await embedText(title + "\n" + body.slice(0, max));
      if (embedding) {
        const note = getDb().prepare("SELECT id FROM kb_notes WHERE rel_path = ?").get(relPath);
        if (note) {
          getDb().prepare("REPLACE INTO kb_embeddings(note_id, embedding, dim) VALUES (?,?,?)")
            .run(note.id, vectorToBuffer(embedding), _embeddingDim);
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

// ── Ollama Model Discovery ────────────────────────────────

export async function listOllamaModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch { return []; }
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
      maxBodyChars: _config.maxBodyChars,
      autoDetectedMaxBodyChars: _autoDetectedMaxBodyChars,
      effectiveMaxBodyChars: getEffectiveMaxBodyChars(),
    };
  } catch { return { vault: _vaultPath, noteCount: 0, embeddedCount: 0 }; }
}
