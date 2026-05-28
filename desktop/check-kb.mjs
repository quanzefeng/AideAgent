import { join } from "path";
import { homedir } from "os";
import { readFileSync, existsSync } from "fs";

const HOME = homedir();
const DB_PATH = join(HOME, ".goodagent", "knowledge.db");
const CONFIG_PATH = join(HOME, ".goodagent", "kb-config.json");

// Print config
try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  console.log("=== kb-config.json ===");
  console.log(JSON.stringify(cfg, null, 2));
} catch (e) {
  console.log("Config not found:", e.message);
}

// Query DB
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  const notes = db.prepare("SELECT id, rel_path, title, word_count FROM kb_notes").all();
  console.log("\n=== kb_notes ===");
  console.table(notes);

  const embCount = db.prepare("SELECT COUNT(*) as cnt FROM kb_embeddings").get();
  console.log("\nEmbeddings count:", embCount.cnt);
} catch (e) {
  console.log("DB query error:", e.message);
}
