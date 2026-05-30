// ── Skill Scanner — scan SKILL.md files from installed dirs ──

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const HOME = homedir();
const SKILL_DIRS = [
  join(HOME, ".agents", "skills"),
  join(HOME, ".agents"),
  join(HOME, ".claude", "skills"),
];

export function parseFrontMatter(text) {
  const meta = { name: "", description: "", triggers: [], allowed_tools: [] };
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  const yaml = match[1];
  const arrayKeys = new Set(["triggers", "allowed_tools", "allowed-tools"]);
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val.startsWith("[")) {
        try { meta[key] = JSON.parse(val); } catch {
          meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        }
      } else if (val.startsWith("|") || val.startsWith(">")) {
        // multi-line scalar — skip
      } else if (arrayKeys.has(key)) {
        const clean = val.replace(/^["']|["']$/g, "");
        meta[key] = clean.includes(",") ? clean.split(",").map(s => s.trim()).filter(Boolean) : [clean];
      } else {
        meta[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  return meta;
}

export function scanSkills() {
  const skills = [];
  const seen = new Set();
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      try {
        const content = readFileSync(skillPath, "utf-8");
        const meta = parseFrontMatter(content);
        skills.push({
          name: meta.name || entry.name,
          description: meta.description || "",
          version: meta.version || "",
          triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
          allowedTools: Array.isArray(meta["allowed-tools"]) ? meta["allowed-tools"] : [],
          path: skillPath,
          source: dir.includes(".agents") ? "agents" : "claude",
        });
      } catch { /* ignored */ }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
