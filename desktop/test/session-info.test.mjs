// @ts-check
// Tests for core/session-info.mjs.
//
// Strategy: inject a temp `homedir` + `userData` via _setTestPaths so we
// can synthesize fake config files in a sandboxed temp dir. Verifies
// the file-reading helpers, the keys filter, and the snapshot
// integration (renderer snapshot wins over defaults).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpHome;
let tmpUserData;
let mod;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "session-info-test-home-"));
  tmpUserData = mkdtempSync(join(tmpdir(), "session-info-test-ud-"));
  // Synthesize a fake ~/.aideagent/ with kb + memory + skills.
  const aideagentDir = join(tmpHome, ".aideagent");
  mkdirSync(join(aideagentDir, "memory"), { recursive: true });
  mkdirSync(join(aideagentDir, "skills", "_archive", "old-skill"), { recursive: true });
  mkdirSync(join(aideagentDir, "skills", "test-skill"), { recursive: true });

  writeFileSync(join(aideagentDir, "kb-config.json"), JSON.stringify({
    provider: "local",
    vaultPath: "/tmp/fake-vault",
    maxNotes: 100,
  }));
  writeFileSync(join(aideagentDir, "memory", "user_profile.md"), "name: tester\n");
  writeFileSync(join(aideagentDir, "memory", "preferences.md"), "likes: tea\n");
  writeFileSync(join(aideagentDir, "skills", "test-skill", "SKILL.md"),
    "---\nname: test-skill\ndescription: A test skill for unit tests\n---\nbody\n");
  writeFileSync(join(aideagentDir, "skills", "_archive", "old-skill", "SKILL.md"),
    "---\nname: old-skill\n---\n");

  // Synthesize a fake userData with workspace + mcp + profile.
  writeFileSync(join(tmpUserData, "workspace-config.json"), JSON.stringify({ current: "/tmp/fake-ws" }));
  writeFileSync(join(tmpUserData, "mcp-servers.json"), JSON.stringify({
    servers: { "fake-srv": { command: "echo" }, "another": { command: "cat" } },
    builtins: { "edge-browser": true },
  }));
  writeFileSync(join(tmpUserData, "system-prompt-profiles.json"), JSON.stringify({
    activeProfile: "default",
    profiles: { default: {}, strict: {} },
  }));

  mod = await import("../core/session-info.mjs");
  mod._setTestPaths({ homedir: tmpHome, userData: tmpUserData });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  mod.setRendererSnapshot(null);
});

describe("getSessionInfo — file-based sections", () => {
  it("reads workspace from userData/workspace-config.json", () => {
    const r = mod.getSessionInfo({ keys: ["workspace"] });
    expect(r.data.workspace).toEqual({ current: "/tmp/fake-ws" });
  });

  it("reads KB config from ~/.aideagent/kb-config.json", () => {
    const r = mod.getSessionInfo({ keys: ["kb"] });
    expect(r.data.kb).toMatchObject({
      provider: "local",
      vaultPath: "/tmp/fake-vault",
      maxNotes: 100,
    });
  });

  it("summarizes MCP config — server count + names, no env dump", () => {
    const r = mod.getSessionInfo({ keys: ["mcp"] });
    expect(r.data.mcp.serverCount).toBe(2);
    expect(r.data.mcp.serverNames.sort()).toEqual(["another", "fake-srv"]);
    expect(r.data.mcp.builtins).toEqual({ "edge-browser": true });
    // Must NOT include env values or command args (privacy)
    expect(JSON.stringify(r.data.mcp)).not.toContain("echo");
    expect(JSON.stringify(r.data.mcp)).not.toContain("cat");
  });

  it("reads system-prompt-profiles.json — active + count, no content dump", () => {
    const r = mod.getSessionInfo({ keys: ["system_prompt"] });
    expect(r.data.system_prompt.activeProfile).toBe("default");
    expect(r.data.system_prompt.profileCount).toBe(2);
    expect(r.data.system_prompt.profileNames.sort()).toEqual(["default", "strict"]);
  });

  it("summarizes memory directory — file count + total bytes + file list", () => {
    const r = mod.getSessionInfo({ keys: ["memory"] });
    expect(r.data.memory.fileCount).toBe(2);
    expect(r.data.memory.totalBytes).toBeGreaterThan(0);
    const names = r.data.memory.files.map((f) => f.name).sort();
    expect(names).toEqual(["preferences.md", "user_profile.md"]);
  });

  it("summarizes skills directory — agentManaged count + name/description from SKILL.md", () => {
    const r = mod.getSessionInfo({ keys: ["skills"] });
    expect(r.data.skills.agentManaged).toBe(1); // test-skill
    expect(r.data.skills.archived).toBe(1);    // old-skill
    expect(r.data.skills.list).toHaveLength(1);
    expect(r.data.skills.list[0]).toMatchObject({
      dir: "test-skill",
      name: "test-skill",
      description: "A test skill for unit tests",
    });
  });

  it("exposes data paths", () => {
    const r = mod.getSessionInfo({ keys: ["paths"] });
    expect(r.data.paths.aideagent_dir).toBe(join(tmpHome, ".aideagent"));
    expect(r.data.paths.user_data_dir).toBe(tmpUserData);
  });

  it("exposes app info", () => {
    const r = mod.getSessionInfo({ keys: ["app"] });
    expect(r.data.app.platform).toBe(process.platform);
    expect(r.data.app.node).toBe(process.version);
    expect(r.data.app.version).toBeTruthy();
  });
});

describe("getSessionInfo — renderer snapshot", () => {
  it("uses 'aide' as default runtime when no snapshot pushed", () => {
    const r = mod.getSessionInfo({ keys: ["runtime"] });
    expect(r.data.runtime).toBe("aide");
  });

  it("reflects the latest pushed snapshot", () => {
    mod.setRendererSnapshot({
      runtime: "opencode",
      api: { provider: "deepseek", model: "deepseek-chat", apiUrl: "https://api.deepseek.com/v1", apiFormat: "openai" },
      appearance: { lang: "en", theme_preset: "midnight", theme_accent: "#ff0000", font: "Inter", font_weights: null },
      identity: { agent_name: "MyAgent", user_name: "alice", has_user_avatar: true },
      toggles: { reasoning_enabled: true, search_provider: "tavily" },
    });
    const r = mod.getSessionInfo();
    expect(r.runtime).toBe("opencode");
    expect(r.api.model).toBe("deepseek-chat");
    expect(r.appearance.lang).toBe("en");
    expect(r.identity.agent_name).toBe("MyAgent");
    expect(r.toggles.reasoning_enabled).toBe(true);
  });

  it("returns null for renderer fields when no snapshot pushed", () => {
    const r = mod.getSessionInfo({ keys: ["api", "appearance", "identity", "toggles"] });
    expect(r.data.api).toBeNull();
    expect(r.data.appearance).toBeNull();
    expect(r.data.identity).toBeNull();
    expect(r.data.toggles).toBeNull();
  });
});

describe("getSessionInfo — keys filter", () => {
  it("returns all sections by default", () => {
    const r = mod.getSessionInfo();
    expect(r).toHaveProperty("runtime");
    expect(r).toHaveProperty("api");
    expect(r).toHaveProperty("workspace");
    expect(r).toHaveProperty("kb");
    expect(r).toHaveProperty("mcp");
    expect(r).toHaveProperty("memory");
    expect(r).toHaveProperty("skills");
    expect(r).toHaveProperty("paths");
    expect(r).toHaveProperty("app");
  });

  it("returns only requested sections when keys is provided", () => {
    const r = mod.getSessionInfo({ keys: ["api", "workspace"] });
    expect(r.requested).toEqual(["api", "workspace"]);
    expect(r.found.sort()).toEqual(["api", "workspace"]);
    expect(r.missing).toEqual([]);
    expect(r.data).toHaveProperty("api");
    expect(r.data).toHaveProperty("workspace");
    expect(r.data).not.toHaveProperty("kb");
    expect(r.data).not.toHaveProperty("mcp");
  });

  it("reports missing keys separately", () => {
    const r = mod.getSessionInfo({ keys: ["api", "nonexistent_section", "kb"] });
    expect(r.found.sort()).toEqual(["api", "kb"]);
    expect(r.missing).toEqual(["nonexistent_section"]);
  });

  it("treats empty keys array as 'all'", () => {
    const r = mod.getSessionInfo({ keys: [] });
    expect(r).toHaveProperty("kb");
    expect(r).toHaveProperty("mcp");
  });
});

describe("getSessionInfo — security", () => {
  it("never returns API key values, only config", () => {
    // Synthesize a fake api-keys.enc — even if read, it must NOT be in output.
    writeFileSync(join(tmpHome, ".aideagent", "api-keys.enc"), "ENCRYPTED_BLOB");
    const r = mod.getSessionInfo();
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("ENCRYPTED_BLOB");
    expect(blob).not.toContain("api-keys.enc");
  });

  it("does not dump MCP server env/args (could contain secrets)", () => {
    writeFileSync(join(tmpUserData, "mcp-servers.json"), JSON.stringify({
      servers: {
        "secret-srv": {
          command: "node",
          args: ["--api-key", "sk-12345"],
          env: { API_KEY: "sk-secret" },
        },
      },
    }));
    const r = mod.getSessionInfo({ keys: ["mcp"] });
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("sk-12345");
    expect(blob).not.toContain("sk-secret");
    // Names are fine — just server NAMES, not config
    expect(blob).toContain("secret-srv");
  });
});

describe("getSessionInfo — resilience", () => {
  it("returns null/empty for missing files instead of throwing", () => {
    // Wipe everything
    rmSync(join(tmpHome, ".aideagent", "kb-config.json"), { force: true });
    rmSync(join(tmpHome, ".aideagent", "memory"), { recursive: true, force: true });
    rmSync(join(tmpHome, ".aideagent", "skills"), { recursive: true, force: true });
    rmSync(join(tmpUserData, "workspace-config.json"), { force: true });
    rmSync(join(tmpUserData, "mcp-servers.json"), { force: true });
    rmSync(join(tmpUserData, "system-prompt-profiles.json"), { force: true });

    const r = mod.getSessionInfo();
    expect(r.kb).toBeNull();
    expect(r.workspace).toBeNull();
    expect(r.mcp).toBeNull();
    expect(r.system_prompt).toBeNull();
    expect(r.memory.fileCount).toBe(0);
    expect(r.skills.agentManaged).toBe(0);
  });

  it("returns null for corrupted JSON without crashing", () => {
    writeFileSync(join(tmpHome, ".aideagent", "kb-config.json"), "{not valid json");
    const r = mod.getSessionInfo({ keys: ["kb"] });
    expect(r.data.kb).toBeNull();
  });
});