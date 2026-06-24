// @ts-check
// Unit tests for core/opencode-detector.mjs
//
// Tests the pure-logic surface (resolveHome, candidatePaths) via env-var
// stubs, plus tryRun against a fake opencode binary so we can prove the
// detector finds something on Windows-style paths without a real install.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// We can't easily unit-test the internal helpers (they aren't exported).
// Instead we test detectOpencode() with controlled env vars + a fake opencode
// binary that prints "opencode version 1.2.3".

let FAKE_HOME;
let FAKE_BIN_DIR;
let FAKE_BIN_PATH;

function writeFakeOpencode() {
  FAKE_HOME = mkdtempSync(join(tmpdir(), "oc-detector-home-"));
  FAKE_BIN_DIR = join(FAKE_HOME, "AppData", "Roaming", "npm");
  mkdirSync(FAKE_BIN_DIR, { recursive: true });
  // On Windows we test the .cmd shim; on POSIX we make an executable script.
  if (process.platform === "win32") {
    writeFileSync(join(FAKE_BIN_DIR, "opencode.cmd"), "@echo off\r\necho opencode version 1.2.3\r\n", "utf-8");
    writeFileSync(join(FAKE_BIN_DIR, "opencode"), "@echo off\r\necho opencode version 1.2.3\r\n", "utf-8");
  } else {
    writeFileSync(join(FAKE_BIN_DIR, "opencode"), "#!/bin/sh\necho opencode version 1.2.3\n");
    chmodSync(join(FAKE_BIN_DIR, "opencode"), 0o755);
  }
  FAKE_BIN_PATH = join(FAKE_BIN_DIR, process.platform === "win32" ? "opencode.cmd" : "opencode");
}

beforeEach(() => {
  writeFakeOpencode();
});

afterEach(() => {
  if (FAKE_HOME) rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("detectOpencode", () => {
  it("finds opencode via USERPROFILE + APPDATA fallback", async () => {
    // Import after env is set so the module picks up the fake home.
    vi.stubEnv("USERPROFILE", FAKE_HOME);
    vi.stubEnv("HOME", FAKE_HOME);
    vi.stubEnv("APPDATA", join(FAKE_HOME, "AppData", "Roaming"));
    vi.stubEnv("LOCALAPPDATA", join(FAKE_HOME, "AppData", "Local"));
    // Strip PATH so we don't accidentally pick up a real opencode elsewhere.
    vi.stubEnv("PATH", "");

    const { detectOpencode } = await import("../core/opencode-detector.mjs");
    const result = await detectOpencode();
    expect(result.installed).toBe(true);
    expect(result.available).toBe(true);
    expect(result.path).toBe(FAKE_BIN_PATH);
    expect(result.version).toMatch(/1\.2\.3/);
    vi.unstubAllEnvs();
  });

  it("returns not_found when neither PATH nor candidates have it", async () => {
    // Point HOME somewhere with no opencode.
    const EMPTY_HOME = mkdtempSync(join(tmpdir(), "oc-detector-empty-"));
    try {
      vi.stubEnv("USERPROFILE", EMPTY_HOME);
      vi.stubEnv("HOME", EMPTY_HOME);
      vi.stubEnv("APPDATA", join(EMPTY_HOME, "AppData", "Roaming"));
      vi.stubEnv("LOCALAPPDATA", join(EMPTY_HOME, "AppData", "Local"));
      // Also wipe PATH so the global `where`/`which` lookup misses too.
      vi.stubEnv("PATH", "");

      const { detectOpencode } = await import("../core/opencode-detector.mjs");
      const result = await detectOpencode();
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("not_found");
      expect(result.triedPaths).toBeDefined();
      expect(result.triedPaths.length).toBeGreaterThan(0);
    } finally {
      rmSync(EMPTY_HOME, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("returns triedPaths even when detection fails (for UI diagnostic)", async () => {
    const EMPTY_HOME = mkdtempSync(join(tmpdir(), "oc-detector-empty-"));
    try {
      vi.stubEnv("USERPROFILE", EMPTY_HOME);
      vi.stubEnv("HOME", EMPTY_HOME);
      vi.stubEnv("APPDATA", join(EMPTY_HOME, "AppData", "Roaming"));
      vi.stubEnv("LOCALAPPDATA", join(EMPTY_HOME, "AppData", "Local"));
      vi.stubEnv("PATH", "");

      const { detectOpencode } = await import("../core/opencode-detector.mjs");
      const result = await detectOpencode();
      // The first entry should be the PATH probe summary.
      expect(result.triedPaths?.[0]).toMatch(/where|which/);
      // And it should include our well-known candidates.
      const joined = (result.triedPaths || []).join("\n");
      expect(joined).toContain(join(EMPTY_HOME, "AppData", "Roaming", "npm"));
    } finally {
      rmSync(EMPTY_HOME, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});

// Sanity check: our fake binary actually runs and prints "opencode version 1.2.3".
// If THIS fails, the detector tests above aren't telling us anything useful.
describe("fake opencode binary", () => {
  it("prints a version on --version", () => {
    // On Windows run via cmd.exe so .cmd shims are dispatched correctly.
    let cmd, args;
    if (process.platform === "win32") {
      cmd = "cmd.exe";
      args = ["/c", FAKE_BIN_PATH, "--version"];
    } else {
      cmd = FAKE_BIN_PATH;
      args = ["--version"];
    }
    const res = spawnSync(cmd, args, { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/1\.2\.3/);
  });
});

// Regression: PATH lookup on Windows often returns BOTH `opencode` (extensionless
// shim) and `opencode.cmd` (real shim). The detector MUST prefer `.cmd` so that
// `child_process.spawn(binPath, ["acp"])` can launch it without `shell: true`.
// Without this, the ACP client fails with ENOENT on the first user prompt.
describe("Windows PATH lookup prefers .cmd / .exe over extensionless", () => {
  it("returns .cmd path even when 'where' lists extensionless first", async () => {
    if (process.platform !== "win32") return; // POSIX: no extension concept
    // Create two binaries: extensionless + .cmd, both functional.
    // Reuse writeFakeOpencode but also drop a .cmd version.
    const PATH_DIR = mkdtempSync(join(tmpdir(), "oc-detector-priority-"));
    try {
      const binDir = join(PATH_DIR, "AppData", "Roaming", "npm");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "opencode"), "@echo off\r\necho opencode version 1.2.3\r\n", "utf-8");
      writeFileSync(join(binDir, "opencode.cmd"), "@echo off\r\necho opencode version 1.2.3\r\n", "utf-8");

      // Run with this PATH so `where` finds both. Mirror real user env vars.
      const env = { ...process.env };
      env.PATH = PATH_DIR + ";" + binDir + ";" + (env.PATH || "");
      env.PATHEXT = ".CMD;.EXE;.BAT;.COM;.VBS;.JS;.WS;.MSC";
      env.USERPROFILE = PATH_DIR;
      env.HOME = PATH_DIR;
      env.APPDATA = join(PATH_DIR, "AppData", "Roaming");

      // Run a child node process with the controlled env so the detector
      // picks up our fake PATH. We pass --version probe so the detector
      // succeeds via the .cmd shim.
      const probe = spawnSync(
        process.execPath,
        ["-e", `
          const { detectOpencode } = await import(${JSON.stringify(new URL("../core/opencode-detector.mjs", import.meta.url).pathname)});
          const r = await detectOpencode();
          console.log("__RESULT__" + JSON.stringify(r));
        `],
        { env, encoding: "utf-8", cwd: process.cwd() },
      );
      // The detector writes diagnostic logs to stdout too; pick out the
      // marker line so we can JSON.parse it cleanly.
      const out = probe.stdout.trim();
      const markerIdx = out.lastIndexOf("__RESULT__");
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      const result = JSON.parse(out.slice(markerIdx + "__RESULT__".length));
      expect(result.installed).toBe(true);
      // The returned path MUST end in .cmd so child_process.spawn can
      // launch it without `shell: true`.
      expect(result.path).toMatch(/\.cmd$/i);
      expect(result.version).toMatch(/1\.2\.3/);
    } finally {
      rmSync(PATH_DIR, { recursive: true, force: true });
    }
  });
});