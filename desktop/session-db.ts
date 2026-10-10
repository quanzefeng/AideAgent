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
function fts5Normalize(text: string): string {
  if (!text) return text;
  return text
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])([a-zA-Z0-9])/g, "$1 $2")
    .replace(/([a-zA-Z0-9])([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g, "$1 $2");
}

interface SessionMessage {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string, type: string, function: { name: string, arguments: string } }>;
  timestamp?: string;
}

class SessionDB {
  #db: import("node:sqlite").DatabaseSync | null = null;
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
        message_count INTEGER DEFAULT 0,
        runtime TEXT DEFAULT 'aide'
      )
    `);

    // Migration: add runtime column if missing (existing DBs predate it)
    try {
      this.#ensureOpen().exec("ALTER TABLE sessions ADD COLUMN runtime TEXT DEFAULT 'aide'");
    } catch { /* ignored */ } // column already exists

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
        message_id UNINDEXED,
        content,
        tokenize='unicode61'
      )
    `);

    // Migration: older DBs created messages_fts without message_id, which
    // forced FTS deletes to match on content (a duplicate content string
    // would delete the wrong/extra rows). Rebuild the index from messages.
    let ftsHasMessageId = true;
    try { this.#ensureOpen().prepare("SELECT message_id FROM messages_fts LIMIT 0").run(); }
    catch { ftsHasMessageId = false; }
    if (!ftsHasMessageId) {
      this.#ensureOpen().exec("DROP TABLE messages_fts");
      this.#ensureOpen().exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          session_id UNINDEXED,
          message_id UNINDEXED,
          content,
          tokenize='unicode61'
        )
      `);
      const rebuildRows = this.#ensureOpen().prepare(
        "SELECT id, session_id, content FROM messages WHERE content IS NOT NULL AND content != ''"
      ).all() as Array<{ id: number, session_id: string, content: string }>;
      const rebuildIns = this.#ensureOpen().prepare(
        "INSERT INTO messages_fts(session_id, message_id, content) VALUES (?, ?, ?)"
      );
      for (const r of rebuildRows) rebuildIns.run(r.session_id, String(r.id), fts5Normalize(String(r.content)));
    }

    // P2: task persistence — restore TaskCreate/TaskUpdate state across restarts
    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS session_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        active_form TEXT,
        evidence TEXT,
        unverified INTEGER DEFAULT 0,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS session_todos (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        active_form TEXT,
        position INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // P2/P3: long-task resume — survive process restarts mid-conversation.
    // A long agent loop can be killed by the OS, by the user, or by a crash
    // in the middle of turn 40. We persist the current turn/continuation
    // counter and the latest summary so a future session can pick up where
    // it left off instead of restarting the task from scratch.
    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS session_turn_progress (
        session_id TEXT PRIMARY KEY,
        current_turn INTEGER NOT NULL DEFAULT 0,
        max_turns INTEGER NOT NULL DEFAULT 0,
        current_continuation INTEGER NOT NULL DEFAULT 0,
        max_continuations INTEGER NOT NULL DEFAULT 0,
        last_summary TEXT,
        last_checkpoint_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // ── Context archive (reversible compression) ──────────────────────
    // When compressContext / continuation / MAX_OUTPUT drop or truncate
    // content from the LIVE context, the full original text is stored here
    // and a short `ca_*` pointer is left in its place. The LLM reads those
    // pointers back with the `context_recall` tool, which is what makes
    // compression reversible instead of lossy (previously the text was
    // destroyed in place and only a 2000-char copy survived in `messages`).
    this.#ensureOpen().exec(`
      CREATE TABLE IF NOT EXISTS context_archive (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        kind TEXT NOT NULL,
        source TEXT,
        role TEXT,
        content TEXT NOT NULL,
        orig_chars INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.#ensureOpen().exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS context_archive_fts USING fts5(
        archive_id UNINDEXED,
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

  #ensureOpen(): import("node:sqlite").DatabaseSync { if (!this.#db) this.open(); return this.#db!; }

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

  saveSession(id: string, history: SessionMessage[], title?: string, runtime?: "aide" | "opencode") {
    this.#ensureOpen();
    const now = new Date().toISOString();
    const rt = runtime === "opencode" ? "opencode" : "aide";

    // Upsert session
    const existing = this.#ensureOpen().prepare("SELECT id FROM sessions WHERE id = ?").get(id);
    if (existing) {
      this.#ensureOpen().prepare(
        "UPDATE sessions SET title = ?, updated_at = ?, runtime = ? WHERE id = ?"
      ).run(title || existing.title || "会话", now, rt, id);
    } else {
      this.#ensureOpen().prepare(
        "INSERT INTO sessions(id, title, created_at, updated_at, runtime) VALUES (?, ?, ?, ?, ?)"
      ).run(id, title || "会话", now, now, rt);
    }

    // Clear old messages + FTS, re-insert all history, update count — all
    // in one transaction so a crash mid-save can't leave the session with
    // deleted-but-not-reinserted history.
    try {
      this.#ensureOpen().exec("BEGIN");
      this.#ensureOpen().prepare("DELETE FROM messages_fts WHERE session_id = ?").run(id);
      this.#ensureOpen().prepare("DELETE FROM messages WHERE session_id = ?").run(id);

      // Re-insert all history messages
      const insertMsg = this.#ensureOpen().prepare(
        "INSERT INTO messages(session_id, role, content, reasoning_content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertFts = this.#ensureOpen().prepare(
        "INSERT INTO messages_fts(session_id, message_id, content) VALUES (?, ?, ?)"
      );
      for (const m of history) {
        const ts = m.timestamp || now;
        const toolCallsJson = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
          ? JSON.stringify(m.tool_calls)
          : null;
        const info = insertMsg.run(id, m.role, m.content || "", m.reasoning_content || null, toolCallsJson, ts);
        // message_id is stored as TEXT (FTS5 columns have no type affinity —
        // an integer stored here would never compare equal to a text param)
        if (m.content) insertFts.run(id, String(info.lastInsertRowid), fts5Normalize(m.content));
      }

      // Update count
      this.#ensureOpen().prepare(
        "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?"
      ).run(id, id);
      this.#ensureOpen().exec("COMMIT");
    } catch (e) {
      try { this.#ensureOpen().exec("ROLLBACK"); } catch { /* ignored */ }
      throw e;
    }

    return { id, title, updatedAt: now };
  }

  loadSession(id: string) {
    this.#ensureOpen();
    const s = this.#ensureOpen().prepare(
      "SELECT id, title, created_at, updated_at, runtime FROM sessions WHERE id = ?"
    ).get(id);
    if (!s) return null;

    const msgs = this.#ensureOpen().prepare(
      "SELECT id, role, content, reasoning_content, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC"
    ).all(id);

    return {
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      runtime: s.runtime || "aide",
      history: msgs.map((m: any) => {
        const toolCalls = m.tool_calls ? JSON.parse(String(m.tool_calls)) : undefined;
        // API providers require role:"tool" messages to carry tool_call_id,
        // but the DB has no such column — derive it from the persisted
        // tool_calls entry (old rows were saved without tool_call_id too).
        const toolCallId = m.role === "tool"
          ? (toolCalls && toolCalls[0]?.id ? String(toolCalls[0].id) : undefined)
          : undefined;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          reasoning_content: m.reasoning_content || undefined,
          tool_calls: toolCalls,
          tool_call_id: toolCallId,
          timestamp: m.timestamp,
        };
      }),
    };
  }

  // ── Task persistence (P2) ─────────────────────────────────────
  saveSessionTasks(sessionId: string, tasks: Array<{ id: string, subject: string, description?: string, status: string, activeForm?: string, evidence?: string | null, unverified?: boolean, completedAt?: string, createdAt?: string, updatedAt?: string }>) {
    this.#ensureOpen();
    if (!sessionId || !Array.isArray(tasks)) return { saved: 0 };
    const now = new Date().toISOString();
    // Upsert each task; tasks not in the array for this session are NOT auto-deleted
    // (allows partial persistence when caller only wants to save active ones)
    const upsert = this.#ensureOpen().prepare(`
      INSERT INTO session_tasks(id, session_id, subject, description, status, active_form, evidence, unverified, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        subject=excluded.subject, description=excluded.description, status=excluded.status,
        active_form=excluded.active_form, evidence=excluded.evidence, unverified=excluded.unverified,
        completed_at=excluded.completed_at, updated_at=excluded.updated_at
    `);
    let saved = 0;
    this.#ensureOpen().exec("BEGIN");
    try {
      for (const t of tasks) {
        if (!t?.id || !t?.subject) continue;
        upsert.run(
          t.id, sessionId, t.subject, t.description || "", t.status || "pending",
          t.activeForm || t.subject, t.evidence || null, t.unverified ? 1 : 0,
          t.completedAt || null, t.createdAt || now, now
        );
        saved++;
      }
      this.#ensureOpen().exec("COMMIT");
    } catch (e: any) {
      this.#ensureOpen().exec("ROLLBACK");
      return { error: e.message, saved: 0 };
    }
    return { saved };
  }

  saveSessionTodos(sessionId: string, todos: Array<{ id: string, content: string, status: string, activeForm?: string }>) {
    this.#ensureOpen();
    if (!sessionId || !Array.isArray(todos)) return { saved: 0 };
    const deleteOld = this.#ensureOpen().prepare("DELETE FROM session_todos WHERE session_id = ?");
    const insert = this.#ensureOpen().prepare(`
      INSERT INTO session_todos(id, session_id, content, status, active_form, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.#ensureOpen().exec("BEGIN");
    try {
      deleteOld.run(sessionId);
      todos.forEach((t, i) => {
        if (!t?.id || !t?.content) return;
        insert.run(t.id, sessionId, t.content, t.status || "pending", t.activeForm || t.content, i);
      });
      this.#ensureOpen().exec("COMMIT");
    } catch (e: any) {
      this.#ensureOpen().exec("ROLLBACK");
      return { error: e.message, saved: 0 };
    }
    return { saved: todos.length };
  }

  loadSessionTasks(sessionId: string) {
    this.#ensureOpen();
    if (!sessionId) return [];
    const rows = this.#ensureOpen().prepare(
      "SELECT id, subject, description, status, active_form, evidence, unverified, completed_at, created_at, updated_at FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId);
    return rows.map(r => ({
      id: r.id,
      subject: r.subject,
      description: r.description || undefined,
      status: r.status,
      activeForm: r.active_form,
      evidence: r.evidence,
      unverified: r.unverified === 1,
      completedAt: r.completed_at || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  loadSessionTodos(sessionId: string) {
    this.#ensureOpen();
    if (!sessionId) return [];
    const rows = this.#ensureOpen().prepare(
      "SELECT id, content, status, active_form FROM session_todos WHERE session_id = ? ORDER BY position ASC"
    ).all(sessionId);
    return rows.map(r => ({
      id: r.id,
      content: r.content,
      status: r.status,
      activeForm: r.active_form,
    }));
  }

  clearSessionTasks(sessionId: string) {
    this.#ensureOpen();
    if (!sessionId) return;
    this.#ensureOpen().prepare("DELETE FROM session_tasks WHERE session_id = ?").run(sessionId);
    this.#ensureOpen().prepare("DELETE FROM session_todos WHERE session_id = ?").run(sessionId);
  }

  // ── Turn progress (long-task resume) ────────────────────────
  saveTurnProgress(sessionId: string, progress: { currentTurn: number, maxTurns: number, currentContinuation: number, maxContinuations: number, lastSummary?: string }) {
    if (!sessionId) return;
    this.#ensureOpen();
    const now = new Date().toISOString();
    const existing = this.#ensureOpen().prepare("SELECT session_id FROM session_turn_progress WHERE session_id = ?").get(sessionId);
    if (existing) {
      this.#ensureOpen().prepare(
        "UPDATE session_turn_progress SET current_turn = ?, max_turns = ?, current_continuation = ?, max_continuations = ?, last_summary = ?, last_checkpoint_at = ?, updated_at = ? WHERE session_id = ?"
      ).run(
        progress.currentTurn | 0,
        progress.maxTurns | 0,
        progress.currentContinuation | 0,
        progress.maxContinuations | 0,
        progress.lastSummary || null,
        now,
        now,
        sessionId,
      );
    } else {
      this.#ensureOpen().prepare(
        "INSERT INTO session_turn_progress(session_id, current_turn, max_turns, current_continuation, max_continuations, last_summary, last_checkpoint_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        sessionId,
        progress.currentTurn | 0,
        progress.maxTurns | 0,
        progress.currentContinuation | 0,
        progress.maxContinuations | 0,
        progress.lastSummary || null,
        now,
        now,
      );
    }
  }

  loadTurnProgress(sessionId: string): any {
    if (!sessionId) return null;
    this.#ensureOpen();
    const row = this.#ensureOpen().prepare(
      "SELECT current_turn, max_turns, current_continuation, max_continuations, last_summary, last_checkpoint_at, updated_at FROM session_turn_progress WHERE session_id = ?"
    ).get(sessionId);
    if (!row) return null;
    return {
      currentTurn: row.current_turn,
      maxTurns: row.max_turns,
      currentContinuation: row.current_continuation,
      maxContinuations: row.max_continuations,
      lastSummary: row.last_summary || "",
      lastCheckpointAt: row.last_checkpoint_at,
      updatedAt: row.updated_at,
    };
  }

  clearTurnProgress(sessionId: string) {
    if (!sessionId) return;
    this.#ensureOpen();
    this.#ensureOpen().prepare("DELETE FROM session_turn_progress WHERE session_id = ?").run(sessionId);
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

  deleteSession(id: string) {
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

  deleteMessage(messageId: string) {
    this.#ensureOpen();
    const msg = this.#ensureOpen().prepare(
      "SELECT session_id, content FROM messages WHERE id = ?"
    ).get(messageId);
    if (!msg) return { error: "not found" };

    // Remove from FTS — by message_id (content-based delete would remove
    // every row sharing the same text, not just this message)
    this.#ensureOpen().prepare("DELETE FROM messages_fts WHERE message_id = ?").run(String(messageId));
    // Remove from messages
    this.#ensureOpen().prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    // Update count
    this.#ensureOpen().prepare(
      "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?"
    ).run(msg.session_id, msg.session_id);
    return { deleted: true, sessionId: msg.session_id };
  }

updateTitle(id: string, title: string) {
    this.#ensureOpen();
    const now = new Date().toISOString();
    this.#ensureOpen().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
    return { id, title, updatedAt: now };
  }

editMessage(messageId: string, newContent: string) {
    this.#ensureOpen();
    const msg = this.#ensureOpen().prepare("SELECT session_id, content FROM messages WHERE id = ?").get(messageId);
    if (!msg) return { error: "not found" };

    // Update messages table
    this.#ensureOpen().prepare("UPDATE messages SET content = ? WHERE id = ?").run(newContent, messageId);

    // Update FTS: delete old, insert new
    this.#ensureOpen().prepare("DELETE FROM messages_fts WHERE message_id = ?").run(String(messageId));
    if (newContent) {
      this.#ensureOpen().prepare(
        "INSERT INTO messages_fts(session_id, message_id, content) VALUES (?, ?, ?)"
      ).run(msg.session_id, String(messageId), fts5Normalize(newContent));
    }

    return { updated: true, sessionId: msg.session_id, messageId };
  }

  exportSession(id: string) {
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

  searchMessages(query: string, limit = 30): Array<{ sessionId: string, sessionTitle: string, snippet: string, rank: number }> {
    this.#ensureOpen();
    if (!query?.trim()) return [];

    const sql = `
      SELECT
        session_id,
        snippet(messages_fts, 2, '<mark>', '</mark>', '…', 40) AS snippet,
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
    } catch (err: any) {
      if (err.message?.includes("syntax error")) {
        const safe = query.replace(/[^\w\u4e00-\u9fff\s\-"]+/g, " ").trim();
        if (safe && safe !== query) return this.searchMessages(safe, limit);
      }
      throw err;
    }
  }

  // ── Context archive (reversible compression) ────────────────────────

  /**
   * Persist content that is about to be dropped/truncated from the live
   * context, returning a short `ca_*` pointer the model can hand back to
   * `context_recall`. This is the difference between lossy truncation and
   * reversible compression: the original text always survives in storage.
   *
   * @param {{content: string, kind?: string, source?: string, role?: string, sessionId?: string|null, minChars?: number}} opts
   *   minChars: skip tiny fragments (noise); callers doing intentional
   *   large drops pass a threshold, default 0 = archive whatever it gets.
   * @returns {string|null} archive id, or null when nothing was stored
   */
  archiveContext(opts: { content: string, kind?: string, source?: string, role?: string, sessionId?: string | null, minChars?: number }): string | null {
    const content = opts?.content || "";
    if (!content) return null;
    const minChars = opts.minChars ?? 0;
    if (content.length < minChars) return null;
    try {
      const db = this.#ensureOpen();
      const id = "ca_" + randomUUID().replace(/-/g, "").slice(0, 10);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO context_archive (id, session_id, kind, source, role, content, orig_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id, opts.sessionId || null, opts.kind || "message", opts.source || "", opts.role || "", content, content.length, now);
      try {
        db.prepare("INSERT INTO context_archive_fts(archive_id, content) VALUES (?, ?)").run(id, fts5Normalize(content));
      } catch { /* FTS failure must not lose the archive row itself */ }
      this.#pruneContextArchive(opts.sessionId || null);
      return id;
    } catch (err: any) {
      console.error("[session-db] archiveContext failed:", err.message);
      return null;
    }
  }

  /** @param {string} id */
  readContext(id: string) {
    if (!id) return null;
    try {
      return (this.#ensureOpen().prepare(
        "SELECT id, session_id, kind, source, role, content, orig_chars, created_at FROM context_archive WHERE id = ?"
      ).get(id) || null) as any;
    } catch { return null; }
  }

  /**
   * Full-text search over archived content. Used by `context_recall(query)`.
   * @param {string} query
   * @param {number} [limit]
   */
  searchContext(query: string, limit = 5): Array<{ id: string, kind: string, source: string, orig_chars: number, created_at: string, snippet: string }> {
    if (!query?.trim()) return [];
    const out: any[] = [];
    try {
      const rows = this.#ensureOpen().prepare(
        `SELECT a.id, a.kind, a.source, a.orig_chars, a.created_at,
                snippet(context_archive_fts, 1, '<mark>', '</mark>', '…', 60) AS snippet
         FROM context_archive_fts JOIN context_archive a ON a.id = context_archive_fts.archive_id
         WHERE context_archive_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(query, limit) as any[];
      out.push(...rows);
    } catch { /* MATCH syntax errors fall through to LIKE */ }
    if (out.length === 0) {
      try {
        const rows = this.#ensureOpen().prepare(
          `SELECT id, kind, source, orig_chars, created_at, substr(content, 1, 120) AS snippet
           FROM context_archive WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`
        ).all("%" + query + "%", limit) as any[];
        out.push(...rows);
      } catch { /* ignored */ }
    }
    return out;
  }

  /**
   * Recent archive entries (metadata + preview). Used by
   * `context_recall()` with no arguments so the model can see what exists.
   * @param {number} [limit]
   * @param {string|null} [sessionId]
   */
  listContextArchive(limit = 20, sessionId: string | null = null): Array<{ id: string, kind: string, source: string, orig_chars: number, created_at: string, preview: string }> {
    try {
      const sql = sessionId
        ? "SELECT id, kind, source, orig_chars, created_at, substr(content, 1, 200) AS preview FROM context_archive WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
        : "SELECT id, kind, source, orig_chars, created_at, substr(content, 1, 200) AS preview FROM context_archive ORDER BY created_at DESC LIMIT ?";
      const args: any[] = sessionId ? [sessionId, limit] : [limit];
      return this.#ensureOpen().prepare(sql).all(...args) as any[];
    } catch { return []; }
  }

  /** Remove one archive entry (both FTS and row). Used by TTL pruning/tests. */
  deleteContext(id: string): boolean {
    if (!id) return false;
    try {
      const db = this.#ensureOpen();
      try { db.prepare("DELETE FROM context_archive_fts WHERE archive_id = ?").run(id); } catch { /* ignored */ }
      const info = db.prepare("DELETE FROM context_archive WHERE id = ?").run(id) as any;
      return Number(info.changes || 0) > 0;
    } catch { return false; }
  }

  /** Bounded growth: keep the newest 200 entries per session + 30-day TTL. */
  #pruneContextArchive(sessionId: string | null) {
    try {
      const db = this.#ensureOpen();
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const stale = db.prepare("SELECT id FROM context_archive WHERE created_at < ?").all(cutoff) as any[];
      if (sessionId) {
        const overflow = db.prepare(
          "SELECT id FROM context_archive WHERE session_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 200"
        ).all(sessionId) as any[];
        stale.push(...overflow);
      }
      if (!stale.length) return;
      const del = db.prepare("DELETE FROM context_archive WHERE id = ?");
      const delFts = db.prepare("DELETE FROM context_archive_fts WHERE archive_id = ?");
      for (const r of stale) {
        del.run(r.id);
        try { delFts.run(r.id); } catch { /* ignored */ }
      }
    } catch { /* pruning must never break archiving */ }
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

  migrateFromJson(jsonDir: string) {
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
      } catch (err: any) {
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
