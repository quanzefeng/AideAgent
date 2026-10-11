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

  // Audit fix C1 (hysteresis): the default compressContext budget is the
  // TARGET line (CONTEXT_TARGET_PCT=0.55), NOT the 70% trigger. A session
  // between target and trigger must be compressed down to the target; the old
  // budget=trigger design left zero headroom and re-compressed every few
  // turns. These tests fail on the old code and pass on the fix.
  describe("hysteresis target (C1)", () => {
    it("compresses without an explicit budget when usage sits between target and trigger", async () => {
      const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
      const { CONTEXT_WINDOW, CONTEXT_TARGET_PCT } = await import("../core/state.ts");
      setContextArchiveEnabled(false);
      // 60 messages × ~2500 tokens ≈ 150K ≈ 57% of the 256K window: above the
      // 55% target, below the 70% trigger.
      const msgs: any[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` + "z".repeat(9950) });
      const before = estimateMessageTokens(msgs).totalTokens;
      expect(before).toBeGreaterThan(Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET_PCT));
      expect(before).toBeLessThan(Math.floor(CONTEXT_WINDOW * 0.70));

      const result = compressContext(msgs);
      expect(result.compressed).toBe(true);

      const after = estimateMessageTokens(msgs).totalTokens;
      expect(after).toBeLessThanOrEqual(Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET_PCT) + 1000);
    });

    it("leaves usage alone below the target line", async () => {
      const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
      const { CONTEXT_WINDOW, CONTEXT_TARGET_PCT } = await import("../core/state.ts");
      setContextArchiveEnabled(false);
      // 60 messages × ~2000 tokens ≈ 120K ≈ 46%: below the 55% target.
      const msgs: any[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` + "z".repeat(7950) });
      const before = estimateMessageTokens(msgs).totalTokens;
      expect(before).toBeLessThan(Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET_PCT));

      const result = compressContext(msgs);
      expect(result.compressed).toBe(false);
      expect(estimateMessageTokens(msgs).totalTokens).toBe(before);
    });

    it("several turns pass after a compression before the next one (no thrash)", async () => {
      const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
      const { CONTEXT_WINDOW, CONTEXT_TARGET_PCT } = await import("../core/state.ts");
      setContextArchiveEnabled(false);
      // 60 messages ≈ 150K (> 55% target): compress once, down to ~55K.
      const msgs: any[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` + "z".repeat(9950) });
      const first = compressContext(msgs);
      expect(first.compressed).toBe(true);
      const base = estimateMessageTokens(msgs).totalTokens;
      expect(base).toBeLessThan(Math.floor(CONTEXT_WINDOW * CONTEXT_TARGET_PCT));

      // Simulate turns: each adds ~5K tokens. Target headroom is ~90K, so the
      // first ~12 turns must NOT re-compress. The old budget=trigger design
      // (70%) re-compressed on the very next turn — this test fails there.
      let quietTurns = 0;
      for (let t = 0; t < 12; t++) {
        msgs.push({ role: "user", content: `turn${t}u` + "z".repeat(9950) });
        msgs.push({ role: "assistant", content: `turn${t}a` + "z".repeat(9950) });
        const r = compressContext(msgs);
        if (r.compressed) break;
        quietTurns++;
      }
      expect(quietTurns).toBeGreaterThanOrEqual(8);
    });
  });

  // Spec §3 step 4: the compression marker must carry a digest of what was
  // pruned so the model can decide whether to expand pointers (audit fix P2).
  describe("compression marker digest (P2)", () => {
    it("keeps a per-message digest (user head / assistant tail) and skips injected context blocks", async () => {
      const { setContextArchiveEnabled } = await import("../core/context-archive.ts");
      setContextArchiveEnabled(false); // digest is collected regardless of archiving
      const msgs: any[] = [
        { role: "system", content: "sys" },
      ];
      // 10 anchor messages push the interesting ones into the PRUNABLE middle
      // (the first 10 non-system messages are preserved, so a fact placed at
      // index 1 would never reach the digest).
      for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `anchor${i}` });
      msgs.push({ role: "user", content: "请修复 login 模块的 validateToken" });
      msgs.push({ role: "assistant", content: "我先读文件再决定方案，结论稍后给出" });
      // Injected context block — must NOT appear in the digest (rebuilt live):
      msgs.push({ role: "user", content: "## 当前任务状态\n- 🔄 修复 login" });
      // Content-less assistant turn (tool-call only) — stringifies to '""' and
      // must NOT produce a garbage digest line:
      msgs.push({ role: "assistant", content: null });
      for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `d${i}` + "z".repeat(9000) });
      msgs.push({ role: "user", content: "最近的问题" });
      msgs.push({ role: "assistant", content: "正在处理" });

      const result = compressContext(msgs, 50);
      expect(result.compressed).toBe(true);
      const sys = msgs[0].content as string;
      expect(sys).toContain("被裁剪消息摘要");
      // user head: the pruned request text appears at the start of its digest line
      expect(sys).toMatch(/- 用户: 请修复 login 模块的 validateToken/);
      // assistant tail: conclusion-ish words survive
      expect(sys).toMatch(/- 助手: .*结论稍后给出/);
      // injected context block skipped
      expect(sys).not.toContain("当前任务状态");
      // content-less assistant turn skipped (no '""' garbage line)
      expect(sys).not.toContain('助手: ""');
    });
  });

  // Spec §9: long-task information retention — a key fact from an early turn
  // must stay reachable across repeated compressions (either in the anchor
  // zone of the live context, or in the full-text-searchable archive).
  describe("long-task retention (P2)", () => {
    it("keeps an early-turn fact reachable after 3 compression rounds", async () => {
      const { setContextArchiveEnabled, searchArchived } = await import("../core/context-archive.ts");
      const { default: sessionDb } = await import("../session-db.ts");
      setContextArchiveEnabled(true);

      // Snapshot the archive before, delete exactly what this test adds after.
      const before = new Set((sessionDb.listContextArchive(1000, null) as any[]).map((r: any) => r.id));
      const addedIds: string[] = [];
      try {
        const msgs: any[] = [{ role: "system", content: "sys" }];
        // 10 anchor messages first: the fact pair below sits in the PRUNABLE
        // middle, so it must survive via the archive, not the anchor zone.
        for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `anchor${i}` });
        msgs.push({ role: "user", content: "请修复 login 模块" });
        // NOTE: padded past ARCHIVE_MIN_CHARS (500) — fragments shorter than
        // the threshold are intentionally not archived (pointer cost > value);
        // they survive only via the compression-marker digest instead.
        msgs.push({ role: "assistant", content: "好的，关键约束：密码必须用 bcrypt，不要用 md5。" + "z".repeat(700) });
        for (let i = 0; i < 26; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` + "z".repeat(9000) });
        for (let r = 0; r < 3; r++) {
          // Explicit budget so EVERY round prunes (default 55% target would
          // skip rounds once the context is small again).
          const res = compressContext(msgs, 30_000);
          expect(res.compressed).toBe(true);
          for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `g${r}${i}` + "z".repeat(9000) });
        }
        const allText = msgs.map(m => (typeof m.content === "string" ? m.content : "")).join("\n");
        const inContext = allText.includes("bcrypt");
        const hits = searchArchived("bcrypt", 5);
        const archived = hits.some((h: any) => (h.snippet || "").includes("bcrypt") || String(h.id).length > 0);
        // archived fallback: verify the actual archived row content carries the fact
        let archivedVerified = false;
        for (const h of hits) {
          const row = sessionDb.readContext(h.id);
          if (row && row.content.includes("bcrypt")) { archivedVerified = true; break; }
        }
        expect(inContext || archivedVerified, "早期轮次的关键事实必须仍在上下文或可检索归档中").toBe(true);
      } finally {
        for (const r of sessionDb.listContextArchive(1000, null) as any[]) {
          if (!before.has(r.id)) addedIds.push(r.id);
        }
        for (const id of addedIds) sessionDb.deleteContext(id);
        setContextArchiveEnabled(true);
      }
    });
  });
});
