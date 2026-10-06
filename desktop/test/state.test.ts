import { describe, it, expect } from "vitest";
import { genId, DANGEROUS, GIT_SAFE, GH_SAFE, PLAN_MODE_READONLY, SUB_AGENT_TOOL_NAMES, MAX_TURNS, CONTEXT_WINDOW, IS_WINDOWS, parseContextWindowFromError, setContextWindow, DEFAULT_CONTEXT_WINDOW } from "../core/state.ts";

describe("State", () => {
  describe("genId", () => {
    it("generates a string starting with ses_", () => {
      const id = genId();
      expect(id).toMatch(/^ses_/);
    });

    it("generates unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(genId());
      expect(ids.size).toBe(100);
    });
  });

  describe("DANGEROUS patterns", () => {
    it("matches dangerous commands", () => {
      if (IS_WINDOWS) {
        expect(DANGEROUS.some(r => r.test("rm -rf C:\\temp"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("Remove-Item -Recurse C:\\temp"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("del /f file.txt"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("format c:"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("diskpart"))).toBe(true);
      } else {
        // POSIX
        expect(DANGEROUS.some(r => r.test("rm -rf /"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("rm -rf /etc"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("sudo rm -rf /home"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("dd if=/dev/zero of=/dev/sda"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("mkfs.ext4 /dev/sda1"))).toBe(true);
        expect(DANGEROUS.some(r => r.test("chmod -R 777 /"))).toBe(true);
      }
    });

    it("does not match safe commands", () => {
      expect(DANGEROUS.some(r => r.test("ls -la"))).toBe(false);
      expect(DANGEROUS.some(r => r.test("cat file.txt"))).toBe(false);
      if (!IS_WINDOWS) {
        // POSIX-specific safe cases
        expect(DANGEROUS.some(r => r.test("rm -rf /tmp/build"))).toBe(false);
        expect(DANGEROUS.some(r => r.test("rm -rf /var/tmp/cache"))).toBe(false);
        expect(DANGEROUS.some(r => r.test("chown -R me:me /home/me/proj"))).toBe(false);
      }
    });
  });

  describe("GIT_SAFE pattern", () => {
    it("matches safe git commands", () => {
      expect(GIT_SAFE.test("git status")).toBe(true);
      expect(GIT_SAFE.test("git add .")).toBe(true);
      expect(GIT_SAFE.test("git commit -m msg")).toBe(true);
      expect(GIT_SAFE.test("git push origin main")).toBe(true);
      expect(GIT_SAFE.test("git log --oneline")).toBe(true);
    });

    it("does not match unknown git commands", () => {
      expect(GIT_SAFE.test("git rm -rf /")).toBe(false);
      expect(GIT_SAFE.test("git clean -fd")).toBe(false);
    });
  });

  describe("GH_SAFE pattern", () => {
    it("matches safe gh commands", () => {
      expect(GH_SAFE.test("gh pr list")).toBe(true);
      expect(GH_SAFE.test("gh issue create")).toBe(true);
      expect(GH_SAFE.test("gh repo clone x")).toBe(true);
    });

    it("does not match unknown gh commands", () => {
      expect(GH_SAFE.test("gh unknown")).toBe(false);
    });
  });

  describe("Constants", () => {
    it("MAX_TURNS is a positive number", () => {
      expect(MAX_TURNS).toBeGreaterThan(0);
    });

    it("CONTEXT_WINDOW is a positive number", () => {
      expect(CONTEXT_WINDOW).toBeGreaterThan(0);
    });

    it("PLAN_MODE_READONLY is a Set", () => {
      expect(PLAN_MODE_READONLY).toBeInstanceOf(Set);
      expect(PLAN_MODE_READONLY.has("file_read")).toBe(true);
      expect(PLAN_MODE_READONLY.has("grep")).toBe(true);
    });

    it("SUB_AGENT_TOOL_NAMES is a Set", () => {
      expect(SUB_AGENT_TOOL_NAMES).toBeInstanceOf(Set);
      expect(SUB_AGENT_TOOL_NAMES.has("bash")).toBe(true);
      expect(SUB_AGENT_TOOL_NAMES.has("file_read")).toBe(true);
    });
  });

  describe("parseContextWindowFromError", () => {
    it("parses llama.cpp n_ctx JSON", () => {
      const raw = JSON.stringify({ error: { code: 400, message: "exceed_context_size_error", type: "exceed_context_size_error", n_prompt_tokens: 70372, n_ctx: 65536 } });
      expect(parseContextWindowFromError(raw)).toBe(65536);
      expect(parseContextWindowFromError(`API 400\nResponse: ${raw}`)).toBe(65536);
    });

    it("parses n_ctx from bare text", () => {
      expect(parseContextWindowFromError('{"error":{"message":"too big","n_ctx":32768}}')).toBe(32768);
    });

    it("parses strata/gateway 'exceeds the context (N)' message", () => {
      const msg = 'API 400 (Bad Request)\nURL: http://100.101.153.58:8080/v1/chat/completions\nModel: qwen3.8-flash-next-iq3_s\nResponse: {"error": {"type": "invalid_request_error", "message": "prompt (65816 tokens) + max tokens (65536) exceeds the context (131072); requests are never truncated. Send a smaller max_tokens (at most 65248 here), or add \\"fit_max_tokens\\": true to the model\'s strata-<model>.json to shorten it to the room left (#545)"}}';
      expect(parseContextWindowFromError(msg)).toBe(131072);
    });

    it("parses 'exceeds the available context size (N)'", () => {
      expect(parseContextWindowFromError("requests are too large and exceeds the available context size (65536); simplify")).toBe(65536);
    });

    it("derives the window from prompt + allowed max_tokens when no total is given", () => {
      const msg = "prompt (60000 tokens) + max tokens (65536) is too big. Send a smaller max_tokens (at most 40000 here)";
      expect(parseContextWindowFromError(msg)).toBe(100000);
    });

    it("returns null for unrelated errors", () => {
      expect(parseContextWindowFromError("model not found")).toBeNull();
      expect(parseContextWindowFromError("")).toBeNull();
      expect(parseContextWindowFromError('{"error":{"message":"rate limited"}}')).toBeNull();
    });
  });

  describe("setContextWindow", () => {
    it("clamps junk and keeps the previous value", () => {
      const before = CONTEXT_WINDOW;
      setContextWindow(NaN);
      setContextWindow(1);
      expect(CONTEXT_WINDOW).toBe(before);
      setContextWindow(DEFAULT_CONTEXT_WINDOW);
      expect(CONTEXT_WINDOW).toBe(DEFAULT_CONTEXT_WINDOW);
    });
  });
});
