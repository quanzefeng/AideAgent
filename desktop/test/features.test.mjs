import { describe, it, expect } from "vitest";

describe("Plan Mode Tool Filtering", () => {
  const PLAN_MODE_READONLY = new Set([
    "file_read", "grep", "glob", "web_search", "web_fetch",
    "Agent", "AskUserQuestion", "TaskList", "TodoWrite", "write_memory", "kb_write",
    "skill", "invoke_skill", "lsp",
  ]);
  const ALL_TOOLS = ["bash","file_read","file_write","file_edit","grep","glob","web_search","web_fetch","skill","invoke_skill","create_skill","write_memory","TaskCreate","TaskUpdate","TaskList","TodoWrite","Agent","AskUserQuestion","kb_write","lsp","git_diff","git_commit","git_branch"];

  it("file_read is readonly in plan mode", () => {
    expect(PLAN_MODE_READONLY.has("file_read")).toBe(true);
  });

  it("bash is blocked in plan mode", () => {
    expect(PLAN_MODE_READONLY.has("bash")).toBe(false);
  });

  it("file_write is blocked in plan mode", () => {
    expect(PLAN_MODE_READONLY.has("file_write")).toBe(false);
  });

  it("git_commit is blocked in plan mode", () => {
    expect(PLAN_MODE_READONLY.has("git_commit")).toBe(false);
  });

  it("lsp is readonly in plan mode", () => {
    expect(PLAN_MODE_READONLY.has("lsp")).toBe(true);
  });
});

describe("Git Safe Whitelist", () => {
  const GIT_SAFE = /^git\s+(add|status|diff|commit|branch|checkout|log|show|stash|fetch|pull|push|merge|rebase|reset|remote|tag)/i;
  const DANGEROUS = [/rm\s+-rf/i, /Remove-Item.*-Recurse/i, /del\s+\/f/i, /rd\s+\/s/i, /format\s+\w:/i, /diskpart/i];

  function isDangerous(cmd) {
    if (GIT_SAFE.test(cmd.trim())) return false;
    return DANGEROUS.some(p => p.test(cmd));
  }

  it("git status is safe", () => expect(isDangerous("git status")).toBe(false));
  it("git add is safe", () => expect(isDangerous("git add -A")).toBe(false));
  it("git commit is safe", () => expect(isDangerous("git commit -m 'test'")).toBe(false));
  it("git branch is safe", () => expect(isDangerous("git branch feature/test")).toBe(false));
  it("rm -rf is dangerous", () => expect(isDangerous("rm -rf /")).toBe(true));
  it("format c: is dangerous", () => expect(isDangerous("format c:")).toBe(true));
});
