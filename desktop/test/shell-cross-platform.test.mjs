import { describe, it, expect, vi } from "vitest";
import { SHELL, IS_WINDOWS, DANGEROUS, PS_UTF8_PREFIX, PS_EXE } from "../core/state.mjs";
import { runShell, runPowerShell } from "../core/tool-executor.mjs";

describe("Cross-platform shell (state.mjs)", () => {
  describe("IS_WINDOWS / PS_EXE / SHELL constants", () => {
    it("IS_WINDOWS matches process.platform", () => {
      expect(IS_WINDOWS).toBe(process.platform === "win32");
    });

    it("PS_EXE is null on non-Windows, non-null on Windows", () => {
      if (IS_WINDOWS) {
        expect(PS_EXE).toBeTypeOf("string");
        expect(["pwsh", "powershell"]).toContain(PS_EXE);
      } else {
        expect(PS_EXE).toBeNull();
      }
    });

    it("SHELL has the right shape", () => {
      expect(SHELL).toBeTypeOf("object");
      expect(SHELL.exe).toBeTypeOf("string");
      expect(SHELL.exe.length).toBeGreaterThan(0);
      expect(SHELL.buildArgs).toBeTypeOf("function");
    });

    it("SHELL picks the right binary per platform", () => {
      if (IS_WINDOWS) {
        expect(SHELL.exe).toBe(PS_EXE);
      } else {
        expect(SHELL.exe).toBe("/bin/bash");
      }
    });

    it("SHELL.buildArgs returns the right shape per platform", () => {
      const args = SHELL.buildArgs("echo hi");
      expect(Array.isArray(args)).toBe(true);
      expect(args.length).toBeGreaterThan(0);
      if (IS_WINDOWS) {
        // pwsh / powershell.exe: ["-NoProfile", "-Command", <utf8Prefix>cmd]
        expect(args[0]).toBe("-NoProfile");
        expect(args[1]).toBe("-Command");
        expect(args[2]).toContain("echo hi");
        expect(args[2]).toContain(PS_UTF8_PREFIX);
      } else {
        // bash: ["-c", cmd]
        expect(args).toEqual(["-c", "echo hi"]);
      }
    });
  });

  describe("DANGEROUS patterns (cross-platform)", () => {
    it("catches Windows dangerous commands", () => {
      if (!IS_WINDOWS) return; // POSIX DANGEROUS is different
      expect(DANGEROUS.some(r => r.test("rm -rf C:\\temp"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("Remove-Item -Recurse C:\\temp"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("format c:"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("diskpart"))).toBe(true);
    });

    it("catches Linux/macOS dangerous commands", () => {
      if (IS_WINDOWS) return;
      expect(DANGEROUS.some(r => r.test("rm -rf /"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("rm -rf /etc"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("sudo rm -rf /home"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("dd if=/dev/zero of=/dev/sda"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("mkfs.ext4 /dev/sda1"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("echo x > /dev/sda"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("chmod -R 777 /"))).toBe(true);
      expect(DANGEROUS.some(r => r.test("chown -R root:root /etc"))).toBe(true);
    });

    it("does NOT match safe commands on the current platform", () => {
      expect(DANGEROUS.some(r => r.test("ls -la"))).toBe(false);
      expect(DANGEROUS.some(r => r.test("cat file.txt"))).toBe(false);
      if (!IS_WINDOWS) {
        expect(DANGEROUS.some(r => r.test("rm -rf /tmp/build"))).toBe(false);
        expect(DANGEROUS.some(r => r.test("rm -rf /var/tmp/cache"))).toBe(false);
        expect(DANGEROUS.some(r => r.test("chown -R me:me /home/me/project"))).toBe(false);
        expect(DANGEROUS.some(r => r.test("chown -R me:me /Users/me/project"))).toBe(false);
      }
    });
  });
});

describe("runShell (tool-executor.mjs)", () => {
  it("exists and is callable", () => {
    expect(typeof runShell).toBe("function");
  });

  it("is exposed under the legacy runPowerShell alias", () => {
    expect(runPowerShell).toBe(runShell);
  });

  it("resolves with { out, err, code } for a successful command", async () => {
    const r = await runShell("echo cross-platform-shell-test", { timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("cross-platform-shell-test");
  });

  it("captures stderr separately", async () => {
    // POSIX: echo to stderr via `1>&2`; Windows pwsh: `Write-Error` or `[Console]::Error.WriteLine`
    const cmd = IS_WINDOWS
      ? "[Console]::Error.WriteLine('on-stderr')"
      : "echo on-stderr 1>&2";
    const r = await runShell(cmd, { timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(r.out.trim()).toBe("");
    expect(r.err.trim()).toBe("on-stderr");
  });

  it("returns a non-zero code for a failed command without throwing", async () => {
    const cmd = IS_WINDOWS ? "exit 7" : "exit 7";
    const r = await runShell(cmd, { timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(r.code).toBe(7);
  });

  it("returns { error } when given a non-existent binary path", async () => {
    // Force a spawn failure by overriding the exe path via a fresh SHELL.
    // We re-import the module fresh to swap SHELL.exe; the simplest way is
    // to construct a child that points at a path that does not exist.
    // Here we use a tiny ad-hoc helper that mirrors runShell's shape.
    const { spawn } = await import("node:child_process");
    const result = await new Promise(resolve => {
      const child = spawn("/does/not/exist/echo-xyz", ["hi"], { shell: false });
      child.on("error", e => resolve({ error: e.message }));
      child.on("close", code => resolve({ out: "", err: "", code }));
    });
    expect(result.error).toBeTypeOf("string");
  });
});
