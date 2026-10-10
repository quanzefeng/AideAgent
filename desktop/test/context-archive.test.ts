import { describe, it, expect, afterEach } from "vitest";
import {
  archiveDropped, readArchived, searchArchived, listArchived,
  pointerSuffix, setContextArchiveEnabled, ARCHIVE_MIN_CHARS,
} from "../core/context-archive.ts";
import sessionDb from "../session-db.ts";

const created: string[] = [];
function track(id: string | null): string | null { if (id) created.push(id); return id; }

afterEach(() => {
  setContextArchiveEnabled(true);
  for (const id of created.splice(0)) sessionDb.deleteContext(id);
});

describe("context archive (reversible compression)", () => {
  describe("pointerSuffix", () => {
    it("advertises ids and how to fetch them", () => {
      const s = pointerSuffix(["ca_0123456789", null]);
      expect(s).toContain("#ca_0123456789");
      expect(s).toContain("context_recall");
    });

    it("says irrecoverable when nothing was archived", () => {
      const s = pointerSuffix([null, null]);
      expect(s).toContain("不可恢复");
      expect(s).not.toContain("ca_");
    });

    it("caps advertised ids and reports the overflow", () => {
      const ids = Array.from({ length: 12 }, (_, i) => `ca_${String(i).padStart(10, "0")}`);
      const s = pointerSuffix(ids);
      expect(s).toContain("#ca_0000000000");
      expect(s).toContain("等 12 条");
      // 8 shown × ("#ca_" + 10 chars) — the 9th id must not appear
      expect(s).not.toContain("#ca_0000000008");
    });
  });

  describe("archiveDropped", () => {
    it("skips fragments below ARCHIVE_MIN_CHARS without touching storage", () => {
      setContextArchiveEnabled(true);
      expect(archiveDropped({ content: "x".repeat(ARCHIVE_MIN_CHARS - 1) })).toBe(null);
    });

    it("returns nothing when disabled", () => {
      setContextArchiveEnabled(false);
      expect(archiveDropped({ content: "y".repeat(2000) })).toBe(null);
      setContextArchiveEnabled(true);
    });

    it("roundtrips a real drop: archive → read → search → list → delete", () => {
      const body = "DROP_MARKER_9f3a 原始工具输出 " + "z".repeat(1000);
      const id = track(archiveDropped({
        content: body, kind: "tool_result", source: "compressContext", role: "tool", sessionId: null,
      }));
      expect(id).toMatch(/^ca_[0-9a-f]{10}$/);

      const row = readArchived(id!);
      expect(row).toBeTruthy();
      expect(row.content).toBe(body);
      expect(row.kind).toBe("tool_result");
      expect(row.orig_chars).toBe(body.length);

      const hits = searchArchived("DROP_MARKER_9f3a", 5);
      expect(hits.some((h: any) => h.id === id)).toBe(true);

      const listed = listArchived(50, null);
      expect(listed.some((l: any) => l.id === id)).toBe(true);
      expect(listed.find((l: any) => l.id === id)?.preview).toContain("DROP_MARKER_9f3a");
    });

    it("returns null for an unknown id", () => {
      expect(readArchived("ca_doesnotexist")).toBe(null);
    });
  });
});
