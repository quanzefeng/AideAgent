/**
 * GoodAgent Skills Store — L3 Skill Memory
 * 
 * Skills are markdown files in ~/.goodagent/skills/ with YAML frontmatter.
 * Format follows Hermes/agentskills.io convention.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const SKILLS_DIR = join(HOME, ".goodagent", "skills");
const ARCHIVE_DIR = join(SKILLS_DIR, "_archive");
const CURATOR_PATH = join(SKILLS_DIR, "_curator.json");
const SKILLS_DB_PATH = join(SKILLS_DIR, "skills.db");

if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

// ── SQLite skills index (sidecar, flat files are primary) ──
let skillsDb;
try {
  skillsDb = new DatabaseSync(SKILLS_DB_PATH);
  skillsDb.exec(`CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    description TEXT DEFAULT '',
    triggers TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active',
    version TEXT DEFAULT '1.0.0',
    body TEXT DEFAULT '',
    usage_count INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 1.0,
    created_at TEXT DEFAULT '',
    last_used_at INTEGER DEFAULT 0
  )`);
  skillsDb.exec(`CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)`);
  skillsDb.exec(`CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills(last_used_at)`);
  // FTS5 index for full-text search
  skillsDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, description, triggers, body,
    content='skills', content_rowid='rowid'
  )`);
  // Triggers to keep FTS in sync (on replace)
  skillsDb.exec(`
    CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(rowid, name, description, triggers, body)
      VALUES (new.rowid, new.name, new.description, new.triggers, new.body);
    END
  `);
  skillsDb.exec(`
    CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers, body)
      VALUES ('delete', old.rowid, old.name, old.description, old.triggers, old.body);
    END
  `);
  skillsDb.exec(`
    CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers, body)
      VALUES ('delete', old.rowid, old.name, old.description, old.triggers, old.body);
      INSERT INTO skills_fts(rowid, name, description, triggers, body)
      VALUES (new.rowid, new.name, new.description, new.triggers, new.body);
    END
  `);
} catch (e) {
  console.error("[skills-store] SQLite init failed:", e.message);
  skillsDb = null;
}

/** Sync a skill from flat file into the SQLite index. */
function syncSkillToDb(name, meta, body) {
  if (!skillsDb) return;
  try {
    const stmt = skillsDb.prepare(`INSERT OR REPLACE INTO skills(name, description, triggers, status, version, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(
      meta.name || name,
      meta.description || "",
      JSON.stringify(meta.triggers || []),
      meta.status || "active",
      meta.version || "1.0.0",
      body || "",
      meta.created_at || new Date().toISOString()
    );
  } catch (e) { console.error("[skills-store] DB sync error:", e.message); }
}

/** Sync curator usage stats into the SQLite index. */
function syncCuratorToDb(name) {
  if (!skillsDb) return;
  try {
    const curator = loadCurator();
    const stats = curator[name];
    if (stats) {
      skillsDb.prepare(`UPDATE skills SET usage_count=?, success_rate=?, last_used_at=? WHERE name=?`)
        .run(stats.usage_count || 0, stats.success_rate || 1, stats.last_used_at || 0, name);
    }
  } catch { /* ignored */ }
}

/** Rebuild the entire SQLite index from flat files. */
function rebuildDbIndex() {
  if (!skillsDb) return;
  try {
    skillsDb.exec("DELETE FROM skills");
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== "_archive" && d.name !== "_temp")
      .map(d => d.name);
    for (const name of dirs) {
      const skillPath = join(SKILLS_DIR, name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        syncSkillToDb(name, meta, body);
        syncCuratorToDb(name);
      } catch { /* ignored */ }
    }
  } catch (e) { console.error("[skills-store] rebuildDbIndex:", e.message); }
}

/**
 * Search skills by text query using FTS5.
 * Returns matching skills with rank. If DB is unavailable, falls back to name/description matching.
 */
export function searchSkills(query, limit = 10) {
  if (!skillsDb) {
    // Fallback: linear scan
    if (!query) return [];
    const q = query.toLowerCase();
    return listSkills().filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).slice(0, limit);
  }
  try {
    // Normalize query for FTS5: insert spaces between CJK characters
    const normalized = query.replace(/([\u4e00-\u9fff])(?=[\u4e00-\u9fff])/g, "$1 ");
    const rows = skillsDb.prepare(
      `SELECT s.name, s.description, s.status, s.version, s.usage_count, s.success_rate, s.triggers, rank
       FROM skills_fts f JOIN skills s ON f.rowid = s.rowid
       WHERE skills_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(normalized, limit);
    return rows.map(r => ({
      name: r.name,
      description: r.description,
      status: r.status,
      version: r.version,
      usage_count: r.usage_count,
      success_rate: r.success_rate,
      triggers: JSON.parse(r.triggers || "[]"),
      _rank: r.rank,
    }));
  } catch (e) {
    console.error("[skills-store] searchSkills error:", e.message);
    return [];
  }
}

/** Manually trigger a full index rebuild. */
export function reindexSkills() { rebuildDbIndex(); }

// ── YAML frontmatter parser ─────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: text };
  const yaml = match[1];
  const body = text.slice(match[0].length).trim();
  const meta = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.+)/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val === "true") val = true;
      if (val === "false") val = false;
      if (/^\d+$/.test(val)) val = parseInt(val);
      if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
      if (val.startsWith("[") && val.endsWith("]")) {
        try { val = JSON.parse(val); } catch {
          // Fallback: unquoted array-like → split by comma
          val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        }
      }
      meta[kv[1]] = val;
    }
  }
  return { meta, body };
}

function buildFrontmatter(meta) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (k.startsWith("_")) continue; // skip internal keys like _origin
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(x => JSON.stringify(x)).join(", ")}]`);
    else if (typeof v === "string" && (v.includes(" ") || v.includes(":"))) lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (typeof v === "boolean" || typeof v === "number") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ── Curator state ───────────────────────────────────────────

function loadCurator() {
  try { return JSON.parse(readFileSync(CURATOR_PATH, "utf8")); } catch { return {}; }
}
function saveCurator(data) {
  writeFileSync(CURATOR_PATH, JSON.stringify(data, null, 2));
}

// ── Skill CRUD ──────────────────────────────────────────────

export function listSkills() {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== "_archive")
    .map(d => d.name);

  const curator = loadCurator();
  return dirs.map(name => {
    const skillPath = join(SKILLS_DIR, name, "SKILL.md");
    try {
      const raw = readFileSync(skillPath, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const stats = curator[name] || {};
      return {
        name: meta.name || name,
        description: meta.description || "",
        triggers: Array.isArray(meta.triggers) ? meta.triggers : (typeof meta.triggers === "string" && meta.triggers ? meta.triggers.split(",").map(s => s.trim()).filter(Boolean) : []),
        usage_count: stats.usage_count || meta.usage_count || 0,
        success_rate: stats.success_rate || 1,
        status: stats.status || meta.status || "active",
        created_at: meta.created_at || "",
        version: meta.version || "1.0.0",
        body_preview: body.slice(0, 200),
      };
    } catch { return { name, error: "failed to read" }; }
  });
}

export function loadSkill(name) {
  const skillPath = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  // Normalize triggers to array
  if (typeof meta.triggers === "string") meta.triggers = meta.triggers.split(",").map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(meta.triggers)) meta.triggers = [];
  return { ...meta, name: meta.name || name, body };
}

export function saveSkill(name, meta, body) {
  const skillDir = join(SKILLS_DIR, name);
  mkdirSync(skillDir, { recursive: true });
  const content = buildFrontmatter(meta) + "\n\n" + (body || "");
  writeFileSync(join(skillDir, "SKILL.md"), content);
  syncSkillToDb(name, meta, body);
  return { saved: true, name };
}

export function deleteSkill(name) {
  const skillDir = join(SKILLS_DIR, name);
  if (!existsSync(skillDir)) return { error: "not found" };
  // Archive: rename to _archive/name (cross-device-safe via copy+delete)
  const archiveDest = join(ARCHIVE_DIR, name);
  try {
    if (existsSync(archiveDest)) rmSync(archiveDest, { recursive: true, force: true });
    copyRecursive(skillDir, archiveDest);
    rmSync(skillDir, { recursive: true, force: true });
  } catch {
    // Last resort: just delete
    rmSync(skillDir, { recursive: true, force: true });
  }
  // Remove from SQLite index
  if (skillsDb) {
    try { skillsDb.prepare("DELETE FROM skills WHERE name=?").run(name); } catch { /* ignored */ }
  }
  return { deleted: true };
}

function copyRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) { copyRecursive(s, d); }
    else { writeFileSync(d, readFileSync(s)); }
  }
}

export function setSkillStatus(name, status) {
  const curator = loadCurator();
  curator[name] = { ...(curator[name] || {}), status };
  saveCurator(curator);

  // Update frontmatter in the file too
  const skillPath = join(SKILLS_DIR, name, "SKILL.md");
  if (existsSync(skillPath)) {
    const raw = readFileSync(skillPath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    meta.status = status;
    writeFileSync(skillPath, buildFrontmatter(meta) + "\n\n" + body);
  }
  // Sync status to SQLite
  if (skillsDb) {
    try { skillsDb.prepare("UPDATE skills SET status=? WHERE name=?").run(status, name); } catch { /* ignored */ }
  }
  return { name, status };
}

export function recordSkillUsage(name, success = true) {
  const curator = loadCurator();
  const stats = curator[name] || {};
  stats.usage_count = (stats.usage_count || 0) + 1;
  stats.last_used_at = Date.now();
  if (!success) stats.success_rate = ((stats.success_rate || 1) * (stats.usage_count - 1) + 0) / stats.usage_count;
  else stats.success_rate = ((stats.success_rate || 1) * (stats.usage_count - 1) + 1) / stats.usage_count;
  curator[name] = stats;
  saveCurator(curator);
  syncCuratorToDb(name);
}

/**
 * Calculates a recency-weighted usage score for a skill.
 * Uses exponential decay with a 7-day half-life.
 * Score = usage_count * 0.5^(days_since_last_use / 7), minimum 0.1 weight.
 */
export function getUsageScore(name) {
  const curator = loadCurator();
  const stats = curator[name];
  if (!stats || !stats.usage_count) return 0;
  const daysSinceUse = stats.last_used_at ? (Date.now() - stats.last_used_at) / (86400000) : 365;
  const recencyFactor = Math.max(Math.pow(0.5, daysSinceUse / 7), 0.1);
  return stats.usage_count * recencyFactor;
}

// ── Skill generation (LLM-powered) ──────────────────────────

export async function generateSkill(prompt, apiKey, apiUrl, model) {
  if (!apiKey || !apiUrl) return { error: "API not configured" };

  let url = apiUrl.trim().replace(/\/+$/, "");
  if (!url.includes("/chat/completions")) {
    if (!url.endsWith("/v1")) url += "/v1";
    url += "/chat/completions";
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || "deepseek-chat",
        messages: [{
          role: "system",
          content: `You are a skill generator. Given a task description, generate a reusable skill file in YAML frontmatter + Markdown format.

Output ONLY the skill file content in this exact format:

---
name: skill-name
description: "Short description"
triggers: [keyword1, keyword2]
version: 1.0.0
status: active
---

## Steps
1. step one
2. step two

## Notes
- note one

The name should be lowercase with hyphens. Triggers are Chinese/English words that should activate this skill. Keep it concise and practical.`
        }, {
          role: "user",
          content: `Create a reusable skill for: ${prompt}`
        }],
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = await res.json();
    return { skill: data.choices?.[0]?.message?.content || "" };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Skill context injection ─────────────────────────────────

export function buildSkillsContext() {
  const skills = listSkills().filter(s => s.status === "active");
  if (skills.length === 0) return "";

  const lines = ["\n## Available Skills\n"];
  for (const s of skills) {
    lines.push(`### ${s.name}`);
    lines.push(`${s.description}`);
    if (s.triggers?.length) lines.push(`Triggers: ${s.triggers.join(", ")}`);
    lines.push(`Usage: ${s.usage_count} times | Success: ${Math.round((s.success_rate || 1) * 100)}%`);
    lines.push("");
  }
  lines.push(`To use a skill, call the \`invoke_skill\` tool with the skill name. The skill's full instructions will be loaded into context.`);
  return lines.join("\n");
}

// ── Pattern detection (Phase 2) ─────────────────────────────

export function detectPatterns(sessionDb) {
  try {
    const sessions = sessionDb.listSessions(30);
    if (sessions.length < 3) return [];

    // Extract first meaningful phrase from each session's first user message
    const patterns = new Map(); // phrase → { count, sessions: [] }
    for (const s of sessions) {
      const data = sessionDb.loadSession(s.id);
      if (!data?.history) continue;
      const userMsgs = data.history.filter(m => m.role === "user");
      if (!userMsgs.length) continue;
      const firstQuery = (userMsgs[0].content || "").trim();
      // Extract key phrase: first 8 CJK chars or first 3 words
      const phrase = extractKeyPhrase(firstQuery);
      if (!phrase || phrase.length < 3) continue;
      if (!patterns.has(phrase)) patterns.set(phrase, { count: 0, sessions: [], examples: [] });
      const p = patterns.get(phrase);
      p.count++;
      p.sessions.push(s.id);
      if (p.examples.length < 2) p.examples.push(firstQuery.slice(0, 80));
    }

    // Filter: appear in 3+ sessions, not already a skill
    const existingSkills = new Set(listSkills().map(s => s.name));
    const suggestions = [];
    for (const [phrase, data] of patterns) {
      if (data.count < 3) continue;
      // Check if already covered by a skill
      let covered = false;
      for (const sn of existingSkills) {
        if (phrase.includes(sn) || sn.includes(phrase)) { covered = true; break; }
      }
      if (covered) continue;

      suggestions.push({
        phrase,
        count: data.count,
        examples: data.examples,
      });
    }

    return suggestions.sort((a, b) => b.count - a.count).slice(0, 5);
  } catch (e) {
    console.error("[patterns]", e.message);
    return [];
  }
}

function extractKeyPhrase(text) {
  const cleaned = text
    .replace(/[。！？，、；：""''（）【】《》\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Extract first meaningful word/phrase (3-6 CJK chars or 1-2 words)
  const cjk = cleaned.match(/[\u4e00-\u9fff]{3,6}/);
  if (cjk) return cjk[0];
  return cleaned.split(" ").slice(0, 2).join(" ");
}

// helpers

// ── Curator (Phase 3) ───────────────────────────────────────

const CURATOR_DEFAULTS = { archiveAfterDays: 30, lastRun: null, totalRuns: 0 };

export function runCurator() {
  const curator = { ...CURATOR_DEFAULTS, ...loadCurator() };
  const now = Date.now();
  curator.lastRun = new Date().toISOString();
  curator.totalRuns = (curator.totalRuns || 0) + 1;
  const allSkills = listSkills();
  let archived = 0;
  for (const skill of allSkills) {
    if (skill.status !== "active") continue;
    const daysSinceCreation = skill.created_at ? Math.floor((now - new Date(skill.created_at).getTime()) / 86400000) : 0;
    if (daysSinceCreation > curator.archiveAfterDays && skill.usage_count < 2) {
      setSkillStatus(skill.name, "archived");
      archived++;
    }
  }
  const dupes = findSimilarSkills(allSkills);
  if (dupes.length > 0) curator.pendingMerges = dupes; else delete curator.pendingMerges;
  saveCurator(curator);
  return { archived, dupes: dupes.length, lastRun: curator.lastRun };
}

function findSimilarSkills(skills) {
  const dupes = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];
      const sim = textSimilarity(a.description || "", b.description || "") + textSimilarity(a.name || "", b.name || "");
      if (sim > 1.2) dupes.push({ skillA: a.name, skillB: b.name, similarity: Math.round(sim * 100) / 100 });
    }
  }
  return dupes;
}

function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/)), wordsB = new Set(b.toLowerCase().split(/\s+/));
  let common = 0;
  for (const w of wordsA) { if (wordsB.has(w) && w.length > 2) common++; }
  return common / Math.max(wordsA.size, 1);
}

export function getSkillHealth(name) {
  const skill = loadSkill(name);
  if (!skill) return null;
  const curator = loadCurator(), stats = curator[name] || {};
  const usage = stats.usage_count || skill.usage_count || 0;
  const success = stats.success_rate || 1;
  const usageScore = Math.min(usage / 5, 1) * 5, successScore = success * 5;
  return { name, usage, successRate: Math.round(success * 100), totalScore: Math.round((usageScore + successScore) * 10) / 10, maxScore: 10, status: (usageScore + successScore) >= 6 ? "healthy" : (usageScore + successScore) >= 3 ? "ok" : "weak" };
}

export function getCuratorStatus() {
  const curator = loadCurator(), skills = listSkills();
  return { totalSkills: skills.length, activeSkills: skills.filter(s => s.status === "active").length, archivedSkills: skills.filter(s => s.status === "archived").length, pendingMerges: curator.pendingMerges || [], lastRun: curator.lastRun || "never", totalRuns: curator.totalRuns || 0, archiveAfterDays: curator.archiveAfterDays ?? CURATOR_DEFAULTS.archiveAfterDays };
}

export function setCuratorConfig(config) {
  const curator = loadCurator();
  if (config.archiveAfterDays != null) curator.archiveAfterDays = Math.max(1, Math.min(365, config.archiveAfterDays));
  saveCurator(curator);
  return { archiveAfterDays: curator.archiveAfterDays };
}
