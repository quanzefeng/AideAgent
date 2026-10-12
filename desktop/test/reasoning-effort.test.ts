/**
 * Tests for the reasoning-effort picker (低/中/高/Max) feature.
 *
 * Covers the three layers that replaced the old boolean 深度推理 toggle:
 *   1. helpers: loadReasoningEffort/saveReasoningEffort incl. legacy
 *      AideAgent_reasoning_enabled boolean migration and the removed
 *      "none" tier → "low" migration.
 *   2. system-prompt: the 🔒 强制推理规则 mandate is injected for every
 *      tier with tier-specific depth guidance ("none" — internal-only —
 *      is the only value that omits it).
 *   3. format-adapters: effort → request-body mapping for OpenAI format
 *      (reasoning_effort passthrough / omitted on none) and Anthropic
 *      format (thinking.budget_tokens per tier / omitted on none; max
 *      uses a 75%-of-max_tokens budget).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── localStorage stub (Node has no DOM) ──
const lsStore: Record<string, string> = {};
const lsStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k]; },
};
(globalThis.localStorage = lsStub as any);

const { loadReasoningEffort, saveReasoningEffort, REASONING_EFFORTS } =
  await import("../renderer/modules/helpers.ts");

describe("loadReasoningEffort / saveReasoningEffort", () => {
  beforeEach(() => lsStub.clear());

  it("defaults to medium when nothing is stored", () => {
    expect(loadReasoningEffort()).toBe("medium");
  });

  it("round-trips all four levels", () => {
    for (const lvl of REASONING_EFFORTS) {
      saveReasoningEffort(lvl);
      expect(loadReasoningEffort()).toBe(lvl);
    }
  });

  it("migrates legacy boolean true → high and removes the old key", () => {
    lsStore["AideAgent_reasoning_enabled"] = "true";
    expect(loadReasoningEffort()).toBe("high");
    expect(lsStore["AideAgent_reasoning_enabled"]).toBeUndefined();
    expect(lsStore["AideAgent_reasoning_effort"]).toBe("high");
  });

  it("migrates legacy boolean false → low", () => {
    lsStore["AideAgent_reasoning_enabled"] = "false";
    expect(loadReasoningEffort()).toBe("low");
    expect(lsStore["AideAgent_reasoning_enabled"]).toBeUndefined();
  });

  it("migrates the removed 'none' tier → low", () => {
    lsStore["AideAgent_reasoning_effort"] = "none";
    expect(loadReasoningEffort()).toBe("low");
    expect(lsStore["AideAgent_reasoning_effort"]).toBe("low");
  });

  it("stored valid value wins over legacy key", () => {
    lsStore["AideAgent_reasoning_effort"] = "low";
    lsStore["AideAgent_reasoning_enabled"] = "true";
    expect(loadReasoningEffort()).toBe("low");
  });

  it("corrupt stored value falls back to medium", () => {
    lsStore["AideAgent_reasoning_effort"] = "ultra";
    expect(loadReasoningEffort()).toBe("medium");
  });

  it("save rejects invalid levels and stores medium instead", () => {
    saveReasoningEffort("bogus");
    expect(lsStore["AideAgent_reasoning_effort"]).toBe("medium");
  });
});

// ── system-prompt gating ──
describe("buildSystemPrompt forced-reasoning gate", () => {
  it("injects the mandate at medium (default)", async () => {
    const { buildSystemPrompt } = await import("../core/system-prompt.ts");
    const r = await buildSystemPrompt([], "TestAgent", "hi", false, false, true, false, "deepseek-v4-flash");
    expect(r.content).toContain("强制推理规则");
  }, 30000);

  it("omits the mandate when effort is none (internal-only tier)", async () => {
    const { buildSystemPrompt } = await import("../core/system-prompt.ts");
    const r = await buildSystemPrompt([], "TestAgent", "hi", false, false, true, false, "deepseek-v4-flash", "none");
    expect(r.content).not.toContain("强制推理规则");
    // the output-layering rules must stay — they are orthogonal to reasoning
    expect(r.content).toContain("输出分层规则");
  }, 30000);

  it("tier-specific depth guidance is injected per level", async () => {
    const { buildSystemPrompt } = await import("../core/system-prompt.ts");
    const cases: Array<[string, string]> = [
      ["low", "低思考档"],
      ["medium", "中思考档"],
      ["high", "高思考档"],
      ["max", "Max 思考档"],
    ];
    for (const [lvl, marker] of cases) {
      const r = await buildSystemPrompt([], "TestAgent", "hi", false, false, true, false, "deepseek-v4-flash", lvl);
      expect(r.content).toContain("强制推理规则");
      expect(r.content).toContain(marker);
    }
  }, 60000);
});

// ── adapter body mapping (fetch stub captures the request) ──
describe("reasoning effort → request body", () => {
  const openaiSSE =
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const anthropicSSE =
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';

  let capturedBody: any;
  let fetchMock: any;

  beforeEach(() => {
    capturedBody = null;
    fetchMock = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      const sse = String(init.body).includes('"anthropic"') || capturedBody.system !== undefined ? anthropicSSE : openaiSSE;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("openaiCall: medium → reasoning_effort='medium'", async () => {
    const { openaiCall } = await import("../core/format-adapters.ts");
    const r = await openaiCall(
      [{ role: "user", content: "hi" }],
      "https://example.test/v1/chat/completions", "sk-test", "test-model",
      new AbortController().signal, "medium", false, false, true,
    );
    expect(capturedBody.reasoning_effort).toBe("medium");
    expect(r.content).toBe("ok");
  });

  it("openaiCall: low/high/max pass through verbatim", async () => {
    const { openaiCall } = await import("../core/format-adapters.ts");
    for (const lvl of ["low", "high", "max"]) {
      capturedBody = null;
      await openaiCall(
        [{ role: "user", content: "hi" }],
        "https://example.test/v1/chat/completions", "sk-test", "test-model",
        new AbortController().signal, lvl, false, false, true,
      );
      expect(capturedBody.reasoning_effort).toBe(lvl);
    }
  });

  it("openaiCall: none omits the key entirely", async () => {
    const { openaiCall } = await import("../core/format-adapters.ts");
    await openaiCall(
      [{ role: "user", content: "hi" }],
      "https://example.test/v1/chat/completions", "sk-test", "test-model",
      new AbortController().signal, "none", false, false, true,
    );
    expect(capturedBody).not.toHaveProperty("reasoning_effort");
  });

  it("anthropicCall: levels map to thinking budgets 4096/8192/16384", async () => {
    const { anthropicCall } = await import("../core/format-adapters.ts");
    const expected: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };
    for (const [lvl, budget] of Object.entries(expected)) {
      capturedBody = null;
      await anthropicCall(
        [{ role: "user", content: "hi" }],
        "https://example.test/v1/messages", "sk-test", "test-model",
        new AbortController().signal, lvl, false, false, true,
      );
      expect(capturedBody.thinking).toEqual({ type: "enabled", budget_tokens: budget });
    }
  });

  it("anthropicCall: none omits thinking", async () => {
    const { anthropicCall } = await import("../core/format-adapters.ts");
    await anthropicCall(
      [{ role: "user", content: "hi" }],
      "https://example.test/v1/messages", "sk-test", "test-model",
      new AbortController().signal, "none", false, false, true,
    );
    expect(capturedBody).not.toHaveProperty("thinking");
  });

  it("anthropicCall: max uses a 75%-of-max_tokens budget", async () => {
    const { anthropicCall } = await import("../core/format-adapters.ts");
    await anthropicCall(
      [{ role: "user", content: "hi" }],
      "https://example.test/v1/messages", "sk-test", "test-model",
      new AbortController().signal, "max", false, false, true,
    );
    expect(capturedBody.thinking.budget_tokens).toBe(Math.floor(capturedBody.max_tokens * 0.75));
    expect(capturedBody.thinking.budget_tokens).toBeLessThan(capturedBody.max_tokens);
  });

  it("anthropicCall: budget never exceeds half of max_tokens", async () => {
    const { anthropicCall } = await import("../core/format-adapters.ts");
    await anthropicCall(
      [{ role: "user", content: "hi" }],
      "https://example.test/v1/messages", "sk-test", "test-model",
      new AbortController().signal, "high", false, false, true,
    );
    expect(capturedBody.thinking.budget_tokens).toBeLessThanOrEqual(Math.floor(capturedBody.max_tokens / 2));
  });
});

// ── gateway reasoning_effort whitelist fallback ──
describe("gateway effort alias fallback", () => {
  it("resolveEffortAlias: sensenova whitelist remaps max → xhigh", async () => {
    const { resolveEffortAlias } = await import("../core/format-adapters.ts");
    const err = 'API 400 (Bad Request)\\nResponse: {"error":{"message":"field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none","type":"invalid_request_error","param":"reasoning_effort","code":"3"}}';
    expect(resolveEffortAlias(err, "max", "https://alias-unit.test/v1")).toBe("xhigh");
  });

  it("resolveEffortAlias: falls back to strongest allowed tier at or below ours", async () => {
    const { resolveEffortAlias } = await import("../core/format-adapters.ts");
    const err = "should be one of: low, medium, none";
    expect(resolveEffortAlias(err, "high", "https://alias-unit2.test/v1")).toBe("medium");
    expect(resolveEffortAlias(err, "max", "https://alias-unit3.test/v1")).toBe("medium");
  });

  it("resolveEffortAlias: returns null when the error carries no whitelist", async () => {
    const { resolveEffortAlias } = await import("../core/format-adapters.ts");
    expect(resolveEffortAlias("API 500 Internal Server Error", "max", "https://alias-unit4.test/v1")).toBeNull();
  });

  it("openaiCall: 400 on max → retries with xhigh, then caches the alias", async () => {
    const url = "https://alias-remap.test/v1/chat/completions";
    const openaiSSE =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const reject400 = () => new Response(
      JSON.stringify({
        error: {
          message: "field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none",
          type: "invalid_request_error",
          param: "reasoning_effort",
          code: "3",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      // 400 only when the gateway-unfriendly value "max" is actually sent;
      // the remapped "xhigh" (and everything else) succeeds.
      if (b.reasoning_effort === "max") return reject400();
      return new Response(openaiSSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { openaiCall } = await import("../core/format-adapters.ts");
    const r = await openaiCall(
      [{ role: "user", content: "hi" }],
      url, "sk-test", "test-model",
      new AbortController().signal, "max", false, false, true,
    );
    // first attempt sent max → 400; retry sent xhigh → 200
    expect(bodies.length).toBe(2);
    expect(bodies[0].reasoning_effort).toBe("max");
    expect(bodies[1].reasoning_effort).toBe("xhigh");
    expect(r.content).toBe("ok");

    // second call on the same gateway: alias is cached → straight to xhigh, no 400
    bodies.length = 0;
    await openaiCall(
      [{ role: "user", content: "hi again" }],
      url, "sk-test", "test-model",
      new AbortController().signal, "max", false, false, true,
    );
    expect(bodies.length).toBe(1);
    expect(bodies[0].reasoning_effort).toBe("xhigh");
  });
});
