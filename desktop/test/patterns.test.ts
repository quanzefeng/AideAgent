import { describe, it, expect, afterAll } from "vitest";
import { detectPatterns } from "../skills-store.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { homedir } from "os";

const db = new DatabaseSync(join(homedir(), ".aideagent", "sessions.db"));
const mockDb = {
  listSessions: (n: any) => db.prepare("SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT ?").all(n),
  loadSession: (id: any) => {
    const msgs = db.prepare("SELECT role, content FROM messages WHERE session_id=? ORDER BY id").all(id);
    return { id, history: msgs };
  }
};

describe("Pattern Detection", () => {
  it("detects patterns from session history", () => {
    const patterns = detectPatterns((mockDb as any)!);
    expect(Array.isArray(patterns)).toBe(true);
    // Patterns should have phrase and count
    for (const p of patterns) {
      expect(p).toHaveProperty("phrase");
      expect(p).toHaveProperty("count");
      expect(p.count).toBeGreaterThan(0);
    }
  });

  afterAll(() => {
    db.close();
  });
});
