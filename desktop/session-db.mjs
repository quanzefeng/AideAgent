/**
 * AideAgent Session Database — SQLite + FTS5
 * 
 * Replaces the old JSON-file session store with a persistent,
 * searchable SQLite database. Auto-migrates existing JSON files.
 * 
 * DB: ~/.aideagent/sessions.db
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { randomUUID } from "node:crypto";

const HOME = homedir();
const DATA_DIR = join(HOME, ".aideagent");
const DB_PATH = join(DATA_DIR, "sessions.db");

/** Insert spaces between CJK and ASCII for FTS5 tokenization */
/** @param {string} text @returns {string} */
function fts5Normalize(text) {
  if (!text) return text;
  return text
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])([a-zA-Z0-9])/g, "$1 $2")
    .replace(/([a-zA-Z0-9])([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g, "$1 $2");
}

class SessionDB {
  /** @type {import("node:sqlite").DatabaseSync | null} */
  #db = null;
  #ready = false;

  // ── Lifecycle ──────────────────────────────────────────────

  open() {
    if (this.#db) return this;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    this.#db = new DatabaseSync(DB_PATH);
    this.#ensureOpen().exec("PRAGMA foreign_keys = ON");
    this.#ensureOpen().exec("PRAGMA journal_mode = WAL");

    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0
      )
    `);

    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        reasoning_content TEXT,
        tool_calls TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Migration: add reasoning_content column if missing
    try {
      this.#ensureOpen().exec("ALTER TABLE messages ADD COLUMN reasoning_content TEXT");
    } catch { /* ignored */ } // column already exists

    this.#ensureOpen().exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        content,
        tokenize='unicode61'
      )
    `);

    this.#ready = true;
    return this;
  }

  close() {
    if (this.#db) {
      try { this.#ensureOpen().exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignored */ }
      this.#ensureOpen().close(); this.#db = null; this.#ready = false;
    }
  }

  forceCheckpoint() {
    if (this.#db) {
      try { this.#ensureOpen().exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignored */ }
    }
  }

  /** @returns {import("node:sqlite").DatabaseSync} */
  #ensureOpen() { if (!this.#db) this.open(); return /** @type {import("node:sqlite").DatabaseSync} */ (this.#db); }

  // ── Session CRUD ───────────────────────────────────────────

  createSession(title = "") {
    this.#ensureOpen();
    const id = "ses_" + randomUUID().replace(/-/g, "").slice(0, 13);
    const now = new Date().toISOString();
    this.#ensureOpen().prepare(
      "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(id, title || `会话 (${now.slice(0, 10)})`, now, now);
    return { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  /** @param {string} id @param {Array<{role:string,content:string,reasoning_content?:string,timestamp?:string}>} history @param {string} [title] */
  saveSession(id, history, title) {
    this.#ensureOpen();
    const now = new Date().toISOString();

    // Upsert session
    const existing = this.#ensureOpen().prepare("SELECT id FROM sessions WHERE id = ?").get(id);
    if (existing) {
      this.#ensureOpen().prepare(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?"
      ).run(title || existing.title || "会话", now, id);
    } else {
      this.#ensureOpen().prepare(
        "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
      ).run(id, title || "会话", now, now);
    }

    // Clear old messages + FTS
    this.#ensureOpen().prepare("DELETE FROM messages_fts WHERE session_id = ?").run(id);
    this.#ensureOpen().prepare("DELETE FROM messages WHERE session_id = ?").run(id);

    // Re-insert all history messages
    const insertMsg = this.#ensureOpen().prepare(
      "INSERT INTO messages(session_id, role, content, reasoning_content, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    const insertFts = this.#ensureOpen().prepare(
      "INSERT INTO messages_fts(session_id, content) VALUES (?, ?)"
    );
    for (const m of history) {
      const ts = m.timestamp || now;
      insertMsg.run(id, m.role, m.content || "", m.reasoning_content || null, ts);
      if (m.content) insertFts.run(id, fts5Normalize(m.content));
    }

    // Update count
    this.#ensureOpen().prepare(
      "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?"
    ).run(id, id);

    return { id, title, updatedAt: now };
  }

  /** @param {string} id */
  loadSession(id) {
    this.#ensureOpen();
    const s = this.#ensureOpen().prepare(
      "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?"
    ).get(id);
    if (!s) return null;

    const msgs = this.#ensureOpen().prepare(
      "SELECT id, role, content, reasoning_content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC"
    ).all(id);

    return {
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      history: msgs.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning_content: m.reasoning_content || undefined,
        timestamp: m.timestamp,
      })),
    };
  }

  /** @param {number} [limit] */
  listSessions(limit = 50) {
    this.#ensureOpen();
    return this.#ensureOpen().prepare(
      "SELECT id, title, created_at, updated_at, message_count FROM sessions ORDER BY updated_at DESC LIMIT ?"
    ).all(limit).map(s => ({
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      messageCount: s.message_count,
    }));
  }

  /** @param {string} id */
  deleteSession(id) {
    this.#ensureOpen();
    this.#ensureOpen().prepare("DELETE FROM messages_fts WHERE session_id = ?").run(id);
    this.#ensureOpen().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    this.#ensureOpen().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return { deleted: true };
  }

  deleteAllSessions() {
    this.#ensureOpen();
    const count = this.#ensureOpen().prepare("SELECT COUNT(*) as c FROM sessions").get()?.c ?? 0;
    this.#ensureOpen().exec("BEGIN");
    try {
      this.#ensureOpen().prepare("DELETE FROM messages_fts").run();
      this.#ensureOpen().prepare("DELETE FROM messages").run();
      this.#ensureOpen().prepare("DELETE FROM sessions").run();
      this.#ensureOpen().exec("COMMIT");
      // Force WAL checkpoint to persist changes to main DB file
      try { this.#ensureOpen().exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignored */ }
    } catch (e) {
      this.#ensureOpen().exec("ROLLBACK");
      throw e;
    }
    return { deleted: count };
  }

  /** @param {string} messageId */
  deleteMessage(messageId) {
    this.#ensureOpen();
    const msg = this.#ensureOpen().prepare(
      "SELECT session_id, content FROM messages WHERE id = ?"
    ).get(messageId);
    if (!msg) return { error: "not found" };

    // Remove from FTS
    if (msg.content) {
      this.#ensureOpen().prepare(
        "DELETE FROM messages_fts WHERE session_id = ? AND content = ?"
      ).run(msg.session_id, fts5Normalize(String(msg.content)));
    }
    // Remove from messages
    this.#ensureOpen().prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    // Update count
    this.#ensureOpen().prepare(
      "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?"
    ).run(msg.session_id, msg.session_id);
    return { deleted: true, sessionId: msg.session_id };
  }

  /** @param {string} id @param {string} title */
  updateTitle(id, title) {
    this.#ensureOpen();
    const now = new Date().toISOString();
    this.#ensureOpen().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
    return { id, title, updatedAt: now };
  }

  /** @param {string} messageId @param {string} newContent */
  editMessage(messageId, newContent) {
    this.#ensureOpen();
    const msg = this.#ensureOpen().prepare("SELECT session_id, content FROM messages WHERE id = ?").get(messageId);
    if (!msg) return { error: "not found" };

    // Update messages table
    this.#ensureOpen().prepare("UPDATE messages SET content = ? WHERE id = ?").run(newContent, messageId);

    // Update FTS: delete old, insert new
    if (msg.content) {
      this.#ensureOpen().prepare(
        "DELETE FROM messages_fts WHERE session_id = ? AND content = ?"
      ).run(msg.session_id, fts5Normalize(String(msg.content)));
    }
    if (newContent) {
      this.#ensureOpen().prepare(
        "INSERT INTO messages_fts(session_id, content) VALUES (?, ?)"
      ).run(msg.session_id, fts5Normalize(newContent));
    }

    return { updated: true, sessionId: msg.session_id, messageId };
  }

  /** @param {string} id */
  exportSession(id) {
    this.#ensureOpen();
    const s = this.#ensureOpen().prepare(
      "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?"
    ).get(id);
    if (!s) return null;

    const msgs = this.#ensureOpen().prepare(
      "SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC"
    ).all(id);

    const lines = [`# ${s.title}`, ``, `**创建时间:** ${s.created_at}`, `**更新时间:** ${s.updated_at}`, ``];
    for (const m of msgs) {
      lines.push(`### ${m.role === "user" ? "用户" : "助手"}`);
      lines.push(`${m.content || "(空)"}`);
      lines.push(``);
    }
    return { id: s.id, title: s.title, markdown: lines.join("\n") };
  }

  // ── FTS5 Search ──────────────────────────────────────────

  /** @param {string} query @param {number} [limit] @returns {Array<{sessionId:string,sessionTitle:string,snippet:string,rank:number}>} */
  searchMessages(query, limit = 30) {
    this.#ensureOpen();
    if (!query?.trim()) return [];

    const sql = `
      SELECT
        session_id,
        snippet(messages_fts, 1, '<mark>', '</mark>', '…', 40) AS snippet,
        rank
      FROM messages_fts
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;

    try {
      const rows = this.#ensureOpen().prepare(sql).all(query, limit);
      // Deduplicate by session_id, keep lowest rank (best match) per session
      const seen = new Map();
      for (const r of rows) {
        if (!seen.has(r.session_id) || (r.rank ?? 0) < (seen.get(r.session_id).rank ?? 0)) {
          seen.set(r.session_id, r);
        }
      }
      const results = Array.from(seen.values()).sort((a, b) => a.rank - b.rank).map(r => {
        let sessionTitle = "";
        try {
          const s = this.#ensureOpen().prepare("SELECT title FROM sessions WHERE id = ?").get(r.session_id);
          sessionTitle = String(s?.title || "");
        } catch { /* ignored */ }
        return { sessionId: r.session_id, sessionTitle, snippet: r.snippet, rank: r.rank };
      });

      // CJK LIKE fallback
      if (results.length === 0 && /[\u4e00-\u9fff]/.test(query)) {
        const likeRows = this.#ensureOpen().prepare(
          "SELECT m.session_id, m.content, s.title AS st FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.content LIKE ? ORDER BY m.timestamp DESC LIMIT ?"
        ).all("%" + query + "%", limit);
        const seen = new Map();
        for (const r of likeRows) {
          if (!seen.has(r.session_id)) {
            seen.set(r.session_id, r);
          }
        }
        return Array.from(seen.values()).map(r => ({
          sessionId: r.session_id,
          sessionTitle: r.st || "",
          snippet: (r.content || "").substring(0, 200),
          rank: 0,
        }));
      }

      return results;
    } catch (/** @type {any} */ err) {
      if (err.message?.includes("syntax error")) {
        const safe = query.replace(/[^\w\u4e00-\u9fff\s\-"]+/g, " ").trim();
        if (safe && safe !== query) return this.searchMessages(safe, limit);
      }
      throw err;
    }
  }

  /** @param {number} [limit] @param {string} [excludeId] */
  getLastSession(limit = 6, excludeId = "") {
    this.#ensureOpen();
    let last;
    if (excludeId) {
      last = this.#ensureOpen().prepare(
        "SELECT id, title FROM sessions WHERE id != ? ORDER BY updated_at DESC LIMIT 1"
      ).get(excludeId);
    } else {
      last = this.#ensureOpen().prepare(
        "SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT 1"
      ).get();
    }
    if (!last) return null;

    const msgs = this.#ensureOpen().prepare(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?"
    ).all(last.id, limit);

    return {
      id: last.id,
      title: last.title,
      messages: msgs.map(m => ({ role: m.role, content: m.content })),
    };
  }

  /** @param {number} [count] @param {number} [msgsPerSession] @param {string} [excludeId] */
  getRecentSessions(count = 10, msgsPerSession = 4, excludeId = "") {
    this.#ensureOpen();
    const sql = excludeId
      ? "SELECT id, title FROM sessions WHERE id != ? ORDER BY updated_at DESC LIMIT ?"
      : "SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT ?";
    const params = excludeId ? [excludeId, count] : [count];
    const sessions = this.#ensureOpen().prepare(sql).all(...params);
    return sessions.map(s => {
      const msgs = this.#ensureOpen().prepare(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?"
      ).all(s.id, msgsPerSession);
      return {
        id: s.id,
        title: s.title,
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
      };
    });
  }

  getStatus() {
    this.#ensureOpen();
    return {
      ready: this.#ready,
      dbPath: DB_PATH,
      dbSize: existsSync(DB_PATH) ? statSync(DB_PATH).size : 0,
      sessionCount: this.#ensureOpen().prepare("SELECT COUNT(*) AS c FROM sessions").get()?.c || 0,
      messageCount: this.#ensureOpen().prepare("SELECT COUNT(*) AS c FROM messages").get()?.c || 0,
      ftsDocCount: this.#ensureOpen().prepare("SELECT COUNT(*) AS c FROM messages_fts").get()?.c || 0,
    };
  }

  // ── Migration from old JSON files ─────────────────────────

  /** @param {string} jsonDir */
  migrateFromJson(jsonDir) {
    this.#ensureOpen();
    if (!existsSync(jsonDir)) return 0;

    const files = readdirSync(jsonDir).filter(f => f.endsWith(".json"));
    if (files.length === 0) return 0;

    console.log(`[session-db] migrating ${files.length} JSON sessions...`);
    let count = 0;

    for (const f of files) {
      try {
        const raw = readFileSync(join(jsonDir, f), "utf8");
        const data = JSON.parse(raw);
        if (!data.id || !data.history?.length) continue;

        // Don't overwrite if already migrated
        const exists = this.#ensureOpen().prepare("SELECT id FROM sessions WHERE id = ?").get(data.id);
        if (exists) { try { unlinkSync(join(jsonDir, f)); } catch { /* ignored */ } continue; }

        this.saveSession(data.id, data.history, data.title);
        count++;
        // Delete old JSON file after successful migration
        try { unlinkSync(join(jsonDir, f)); } catch { /* ignored */ }
      } catch (/** @type {any} */ err) {
        console.error(`[session-db] migration error ${f}:`, err.message);
      }
    }

    console.log(`[session-db] migrated ${count} sessions`);
    return count;
  }
}

const sessionDb = new SessionDB();
sessionDb.open();

export default sessionDb;
export { SessionDB };
