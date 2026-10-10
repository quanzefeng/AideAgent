import { describe, it, expect } from "vitest";
import { estimateTokens, trimToBudget, estimateMessageTokens, compressContext, summarizeForContinuation, setToolSchemaTokens, getToolSchemaTokens, estimateToolDefsTokens } from "../core/token-budget.ts";

describe("Token Budget", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty/null input", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens(null as any)).toBe(0);
      expect(estimateTokens(undefined as any)).toBe(0);
    });

    it("estimates ASCII text", () => {
      // 4 ASCII chars → ceil(4 * 0.25) = 1 token
      expect(estimateTokens("abcd")).toBe(1);
      // 8 ASCII chars → ceil(8 * 0.25) = 2 tokens
      expect(estimateTokens("abcdefgh")).toBe(2);
    });

    it("estimates CJK text", () => {
      // 1 CJK char → ceil(1 * 1.5) = 2 tokens (rounded up)
      expect(estimateTokens("你")).toBe(2);
      // 2 CJK chars → ceil(2 * 1.5) = 3 tokens
      expect(estimateTokens("你好")).toBe(3);
    });

    it("estimates mixed ASCII and CJK", () => {
      // "你好ab" → 2 CJK (3 tokens) + 2 ASCII (1 token) = 4
      const result = estimateTokens("你好ab");
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe("number");
    });
  });

  describe("trimToBudget", () => {
    it("returns original text if within budget", () => {
      const text = "short text";
      expect(trimToBudget(text, 1000)).toBe(text);
    });

    it("truncates text when over budget", () => {
      const longText = "a".repeat(10000);
      const result = trimToBudget(longText, 100);
      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain("truncated");
    });

    it("returns original if null/empty", () => {
      expect(trimToBudget("", 100)).toBe("");
      expect(trimToBudget(null as any, 100)).toBe(null);
    });
  });

  describe("estimateMessageTokens", () => {
    it("estimates simple message array", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.systemTokens).toBe(0);
      expect(result.historyTokens).toBeGreaterThan(0);
      expect(result.toolResultTokens).toBe(0);
    });

    it("handles system messages separately", () => {
      const msgs = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "hello" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.systemTokens).toBeGreaterThan(0);
      expect(result.historyTokens).toBeGreaterThan(0);
    });

    it("handles tool messages", () => {
      const msgs = [
        { role: "tool", content: "file contents here" },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.toolResultTokens).toBeGreaterThan(0);
    });

    it("handles messages with tool_calls", () => {
      const msgs = [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [{ function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.historyTokens).toBeGreaterThan(0);
    });

    it("handles non-string content", () => {
      const msgs = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ];
      const result = estimateMessageTokens(msgs);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it("returns zero for empty array", () => {
      const result = estimateMessageTokens([]);
      expect(result.totalTokens).toBe(0);
      expect(result.systemTokens).toBe(0);
      expect(result.historyTokens).toBe(0);
      expect(result.toolResultTokens).toBe(0);
    });
  });

  // Regression for P0 BUG #1: long tasks that hit MAX_TURNS or context
  // overflow used to get their tool_call ↔ tool_result pairs sliced in
  // half by compressContext. The next LLM call would 400 with
  // "tool_use_ids were not found" and the whole agent loop would crash.
  // After the fix, paired tool exchanges in the prunable middle zone
  // must be rescued into the suffix.
  describe("compressContext tool_call pair protection", () => {
    it("preserves assistant(tool_calls) and its paired tool result across pruning", () => {
      // Build a long enough history that the ANCHOR (6) + middle + RECENT (8)
      // window forces middle pruning. Each call id is unique so the regex
      // grouping cannot accidentally re-pair the wrong tool result.
      const msgs: any[] = [
        { role: "system", content: "sys" },
        // prefix (first 6 non-system)
        { role: "user", content: "u0" },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ];
      // Middle: 8 paired tool exchanges — total 16 messages.
      for (let i = 0; i < 8; i++) {
        msgs.push({ role: "assistant", content: null as any, tool_calls: [{ id: `call_${i}_abc`, type: "function", function: { name: "bash", arguments: "{\"command\":\"echo " + i + "\"}" } }] });
        msgs.push({ role: "tool", tool_call_id: `call_${i}_abc`, content: "result-" + i });
      }
      // Suffix (last 8): must be preserved verbatim.
      for (let i = 0; i < 8; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `tail-${i}` });
      }

      const result = compressContext(msgs, 50); // tiny budget forces pruning
      expect(result.compressed).toBe(true);

      // For every assistant(tool_calls) that survived, its paired tool
      // result must be adjacent (no orphan tool_use_id, no orphan result).
      const survivingCallIds = new Set();
      for (const m of msgs) {
        if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
          for (const tc of (m as any).tool_calls) survivingCallIds.add(tc.id);
        }
      }
      expect(survivingCallIds.size).toBeGreaterThan(0); // some pair was rescued
      for (const m of msgs) {
        if (m.role === "tool" && (m as any).tool_call_id) {
          expect(survivingCallIds.has((m as any).tool_call_id)).toBe(true);
        }
      }
    });
  });

  // Regression for P1 BUG #2: when the LLM summarization call fails or
  // the model doesn't recognize the prompt, the fallback must still
  // surface the file paths, function names, and error messages that
  // future turns need — not just a 250-char slice of the last message.
  describe("summarizeForContinuation fallback fact extraction", () => {
    it("extracts file paths, function names, and error messages from msgs", async () => {
      const msgs = [
        { role: "system", content: "sys" },
        { role: "user", content: "请把 src/auth/login.ts 里的 validateToken 函数修一下" },
        { role: "assistant", content: "好，我先读一下文件" },
        { role: "tool", tool_call_id: "x1", content: "function validateToken(token: string) { ... }" },
        { role: "assistant", content: "看到 bug 了，是 TypeError: Cannot read property 'exp' of undefined" },
        { role: "user", content: "改完之后跑测试" },
        { role: "tool", tool_call_id: "x2", content: "PASS" },
        { role: "assistant", content: "完成" },
      ];
      // Pass empty api key so the LLM call fails immediately and we
      // exercise the fallback path.
      const summary = await summarizeForContinuation(
        msgs, "", "http://127.0.0.1:1", "deepseek-chat", "openai",
        AbortSignal.timeout(1000),
      );
      expect(summary).toMatch(/src\/auth\/login\.ts|login\.ts/);
      expect(summary).toMatch(/validateToken/);
      expect(summary).toMatch(/TypeError|exp|Cannot read/);
    });
  });

  // P0: tool schemas ride in the request's `tools` field, so they were
  // invisible to every budget check despite being ~65% of a bare request.
  describe("tool schema token accounting", () => {
    it("folds the cached schema bucket into estimateMessageTokens", () => {
      const msgs = [{ role: "user", content: "hi" }];
      setToolSchemaTokens(12345);
      try {
        const withSchema = estimateMessageTokens(msgs);
        expect(withSchema.toolSchemaTokens).toBe(12345);
        expect(withSchema.totalTokens).toBe(
          withSchema.systemTokens + withSchema.historyTokens + withSchema.toolResultTokens + 12345
        );
        // Opt-out path used by computeMaxTokens (it adds tools separately).
        const without = estimateMessageTokens(msgs, false);
        expect(without.toolSchemaTokens).toBe(0);
        expect(without.totalTokens).toBeLessThan(withSchema.totalTokens);
        expect(getToolSchemaTokens()).toBe(12345);
      } finally {
        setToolSchemaTokens(0);
      }
    });

    it("accepts invalid input as 0 and estimates a tool-def array", () => {
      setToolSchemaTokens(Number.NaN);
      expect(getToolSchemaTokens()).toBe(0);
      setToolSchemaTokens(-5);
      expect(getToolSchemaTokens()).toBe(0);
      const defs = [{ type: "function", function: { name: "x", description: "abcdefgh", parameters: {} } }];
      expect(estimateToolDefsTokens(defs)).toBeGreaterThan(0);
      expect(estimateToolDefsTokens(null)).toBe(0);
    });
  });

  // Phase 2: compression must be reversible — the dropped text is archived and
  // a `ca_*` pointer is left behind instead of a silent deletion.
  describe("reversible compression", () => {
    it("archives the truncated middle of a long tool result and leaves a pointer", async () => {
      const { setContextArchiveEnabled, readArchived } = await import("../core/context-archive.ts");
      const { default: sessionDb } = await import("../session-db.ts");
      setContextArchiveEnabled(true);
      const big = "L" + "o".repeat(9000); // 9001 chars ≫ TOOL_RESULT_KEEP_CHARS
      const msgs: any[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u0" },
        { role: "tool", tool_call_id: "t_long", content: big },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "recent question" },
        { role: "assistant", content: "tail" },
      ];
      try {
        const result = compressContext(msgs, 50);
        expect(result.compressed).toBe(true);

        const tool = msgs.find(m => m.role === "tool" && m.tool_call_id === "t_long");
        expect(tool.content.length).toBeLessThan(big.length);
        const match = tool.content.match(/ca_[0-9a-f]{10}/);
        expect(match).toBeTruthy();

        // The archived copy is byte-identical to the original text.
        const row = readArchived(match![0]);
        expect(row?.content).toBe(big);
        sessionDb.deleteContext(match![0]);
      } finally {
        setContextArchiveEnabled(true);
      }
    });

    it("says the text is unrecoverable when archiving is disabled", async () => {
      const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
      setContextArchiveEnabled(false);
      const msgs: any[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u0" },
        { role: "tool", tool_call_id: "t_short", content: "Q".repeat(9000) },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "recent" },
        { role: "assistant", content: "tail" },
      ];
      try {
        compressContext(msgs, 50);
        const tool = msgs.find(m => m.role === "tool" && m.tool_call_id === "t_short");
        expect(tool.content).toContain("不可恢复");
        expect(tool.content).not.toContain("ca_");
      } finally {
        setContextArchiveEnabled(true);
      }
    });
  });
});
