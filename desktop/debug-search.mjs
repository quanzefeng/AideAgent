import { DatabaseSync } from "node:sqlite";
import { homedir } from "os";
import { join } from "path";

const db = new DatabaseSync(join(homedir(), ".goodagent", "sessions.db"));

// Show all FTS5 rows
const all = db.prepare("SELECT rowid, session_id, substr(content,1,60) as c FROM messages_fts").all();
console.log("FTS5 rows:", all.length);
all.forEach(r => console.log(" row", r.rowid, r.session_id, r.c));

// Direct MATCH
const r = db.prepare("SELECT session_id, snippet(messages_fts,1,'<m>','</m>','...',30) as s, rank FROM messages_fts WHERE messages_fts MATCH '微分' ORDER BY rank").all();
console.log("\nMATCH 微分:", r.length, "hits");
r.forEach(x => console.log(" sid:", x.session_id, "rank:", x.rank, "snippet:", x.s));

// Try LIKE fallback (which should NOT trigger since FTS5 found results)
const like = db.prepare("SELECT m.session_id, s.title, m.content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.content LIKE '%微分%'").all();
console.log("\nLIKE 微分:", like.length, "matches");
like.forEach(x => console.log(" sid:", x.session_id, x.title, x.content?.substring(0, 40)));

db.close();
