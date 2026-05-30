import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const DB_PATH = join(HOME, ".goodagent", "knowledge.db");

try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB_PATH);

  // Total notes
  const noteCount = db.prepare("SELECT COUNT(*) as cnt FROM kb_notes").get();
  console.log(`Total notes in kb_notes: ${noteCount.cnt}`);

  // Total embeddings
  try {
    const embCount = db.prepare("SELECT COUNT(*) as cnt FROM kb_embeddings").get();
    console.log(`Total embeddings (向量化笔记): ${embCount.cnt}`);
    console.log(`向量化比例: ${embCount.cnt}/${noteCount.cnt} (${(embCount.cnt / noteCount.cnt * 100).toFixed(1)}%)`);
  } catch (e) {
    console.log("kb_embeddings table error:", e.message);
  }

  // Check all tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("\nAll tables:", tables.map(t => t.name).join(", "));

  // Check schema of kb_embeddings
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='kb_embeddings'").get();
    console.log("\nkb_embeddings schema:", schema?.sql);
  } catch (e) {}

  // Check schema of kb_notes
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='kb_notes'").get();
    console.log("\nkb_notes schema:", schema?.sql);
  } catch (e) {}

  // List notes with embedding status if possible
  try {
    const embNotes = db.prepare("SELECT DISTINCT note_id FROM kb_embeddings").all();
    console.log(`\nNotes with embeddings: ${embNotes.length}`);
    const allNotes = db.prepare("SELECT id, title FROM kb_notes").all();
    const embNoteIds = new Set(embNotes.map(e => e.note_id));
    const embedded = allNotes.filter(n => embNoteIds.has(n.id));
    const notEmbedded = allNotes.filter(n => !embNoteIds.has(n.id));
    
    console.log(`\n已向量化 (${embedded.length}):`);
    for (const n of embedded) {
      console.log(`  [${n.id}] ${n.title}`);
    }
    
    console.log(`\n未向量化 (${notEmbedded.length}):`);
    for (const n of notEmbedded.slice(0, 20)) {
      console.log(`  [${n.id}] ${n.title}`);
    }
    if (notEmbedded.length > 20) {
      console.log(`  ... and ${notEmbedded.length - 20} more`);
    }
  } catch (e) {
    console.log("Error listing embedding status:", e.message);
  }

} catch (e) {
  console.error("Error:", e.message);
}
