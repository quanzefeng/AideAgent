import { describe, it, expect, beforeEach } from "vitest";
import { summarizeSubAgentResult } from "../core/agent-loop.ts";
import { setContextArchiveEnabled, readArchived } from "../core/context-archive.ts";
import sessionDb from "../session-db.ts";

// Audit fix C4 (P1): large structured sub-agent replies must NOT be dumped
// into the main context — the summary replaces them and the raw text goes to
// the archive with a pointer. Small/plain replies pass through verbatim.
beforeEach(() => setContextArchiveEnabled(false));

describe("summarizeSubAgentResult (audit fix C4)", () => {
  it("replaces a large structured reply with a short summary + archive pointer", () => {
    setContextArchiveEnabled(true);
    let cleanupId: string | null = null;
    try {
      const raw = "调研细节 ".repeat(1000); // ≈ 5000 chars ≫ STRUCTURED_RAW_KEEP_CHARS
      const rStr = summarizeSubAgentResult({
        text: "## 结论\n用 pnpm 安装\n## 关键证据\n- 证据一\n## 未解决问题\n无\n## 建议的下一步\n跑 install\n\n" + raw,
        structured: { conclusion: "用 pnpm 安装", evidence: "- 证据一", openIssues: "无", nextStep: "跑 install" },
      });
      expect(rStr).toContain("## 子代理结论");
      expect(rStr).toContain("用 pnpm 安装");
      expect(rStr).not.toContain("调研细节"); // raw dump stays OUT of the main context
      const m = rStr.match(/ca_[0-9a-f]{10}/);
      expect(m, "large structured result must carry an archive pointer").toBeTruthy();
      cleanupId = m![0];
      const row = readArchived(cleanupId);
      expect(row?.content).toContain("调研细节");
    } finally {
      // Hygiene: even on assertion failure, never leak a NULL-session row.
      if (cleanupId) sessionDb.deleteContext(cleanupId);
      setContextArchiveEnabled(false);
    }
  });

  it("passes small structured replies through verbatim (detail is cheap)", () => {
    const result = {
      text: "## 结论\n小发现",
      structured: { conclusion: "小发现", evidence: "", openIssues: "无", nextStep: "无" },
    };
    expect(summarizeSubAgentResult(result)).toBe(JSON.stringify(result));
  });

  it("passes unstructured replies through verbatim", () => {
    const result = { text: "普通文本结果" };
    expect(summarizeSubAgentResult(result)).toBe(JSON.stringify(result));
    expect(summarizeSubAgentResult({ error: "sub-agent failed" })).toBe('{"error":"sub-agent failed"}');
  });

  it("passes aborted replies through verbatim (no structured block)", () => {
    const result = { text: "半截文本", aborted: true };
    expect(summarizeSubAgentResult(result)).toBe(JSON.stringify(result));
  });
});
