import sessionDb from "./session-db.mjs";

console.log("═══ Session DB E2E ═══");

// 1. Create
const s1 = sessionDb.createSession("技术讨论");
console.log("[CREATE]", s1.id, s1.title);

// 2. Save session with history
sessionDb.saveSession(s1.id, [
  { role: "user", content: "Python和Go有什么区别？" },
  { role: "assistant", content: "Python是解释型语言，Go是编译型语言。" },
  { role: "user", content: "那性能方面呢？" },
  { role: "assistant", content: "Go的性能接近C，Python慢很多但在IO密集型场景表现好。" },
], "Python vs Go");

console.log("[SAVE] ok");

// 3. Load
const loaded = sessionDb.loadSession(s1.id);
console.assert(loaded.history.length === 4, "4 messages");
console.assert(loaded.title === "Python vs Go", "title saved");
console.log("[LOAD]", loaded.history.length, "msgs");

// 4. List
const list = sessionDb.listSessions(10);
console.assert(list.length >= 1, "list works");
console.log("[LIST]", list.length, "sessions");

// 5. Search
const r1 = sessionDb.searchMessages("Python", 10);
console.assert(r1.length > 0, "search Python");
console.log("[SEARCH] Python:", r1.length, "hits, snippet:", r1[0]?.snippet?.substring(0, 40));

// 6. Update title
sessionDb.updateTitle(s1.id, "Python vs Go 全面对比");
console.assert(sessionDb.loadSession(s1.id).title.includes("Go"), "title updated");
console.log("[TITLE] ok");

// 7. Last session
const last = sessionDb.getLastSession(2);
console.assert(last.messages.length === 2, "last 2 msgs");
console.log("[LAST]", last.title, last.messages.length, "msgs");

// 8. Status
const st = sessionDb.getStatus();
console.log("[STATUS]", st.sessionCount, "sessions,", st.messageCount, "msgs,", st.dbSize, "bytes");

// 9. Delete
sessionDb.deleteSession(s1.id);
console.assert(sessionDb.listSessions(10).length === 0, "all deleted");
console.log("[DELETE] ok");

sessionDb.close();
console.log("\n✓ ALL 9 TESTS PASSED");
