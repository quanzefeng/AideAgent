// ── OpenCode CLI detector ───────────────────────────────────
// Locates a locally-installed opencode CLI on the user's machine and reports
// whether it can be driven via ACP (`opencode acp`).
//
// Search strategy:
//   1. System PATH via `where` (Windows) / `which` (unix) — try EVERY line,
//      not just the first (PowerShell `where.exe` may list a stale/extension-
//      less shim first that Node's `execFile` can't run directly on Windows)
//   2. Well-known install locations (npm, brew, scoop, yarn, pnpm, cargo,
//      nix, winget, choco, official curl installer, custom npm prefix, …)
//
// Validation: an "exists" check is NOT sufficient on Windows — `existsSync`
// can return true for a shim file that Node's `execFile` refuses to run
// because the OS shell extension lookup happens differently. We instead
// run `opencode --version` as the source of truth and treat "ran successfully
// and printed a version" as "available".
//
// We do NOT bundle opencode — the user installs it themselves; we only detect.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileP = promisify(execFile);
const IS_WIN = process.platform === "win32";
const DETECT_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 3000;

/**
 * Determine the user's home directory using every available source, in order
 * of reliability. Electron's main process sometimes inherits a stripped PATH
 * from a shortcut launch, but USERPROFILE (Windows) / HOME (Unix) are usually
 * preserved even when other env vars aren't. We try all candidates and pick
 * the first non-empty one.
 */
function resolveHome() {
  if (IS_WIN) {
    return process.env.USERPROFILE
      || process.env.HOME
      || process.env.HOMEDRIVE + process.env.HOMEPATH
      || "";
  }
  return process.env.HOME
    || process.env.USERPROFILE  // rare on unix but harmless to try
    || "";
}

/**
 * Build the platform-specific candidate list. Each entry can include shell
 * variants (.cmd / .exe / no extension on Windows) so we don't have to think
 * about PATHEXT for each path individually.
 */
function candidatePaths() {
  const HOME = resolveHome();
  if (!HOME) return [];
  if (IS_WIN) {
    const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
    const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
    const PROGRAMDATA = process.env.ProgramData || "C:\\ProgramData";
    const base = [
      // Default npm-global install prefix (Windows: %APPDATA%\npm).
      APPDATA + "\\npm",
      // Scoop (persistent + shimmed).
      HOME + "\\scoop\\apps\\opencode\\current",
      HOME + "\\scoop\\shims",
      // Yarn / pnpm global bins — %LOCALAPPDATA% on Windows.
      LOCALAPPDATA + "\\yarn\\bin",
      LOCALAPPDATA + "\\pnpm",
      // WinGet (`winget install opencode`) — Microsoft\WinGet\Links.
      LOCALAPPDATA + "\\Microsoft\\WinGet\\Links",
      // Chocolatey — puts shims under %ProgramData%\chocolatey\bin.
      PROGRAMDATA + "\\chocolatey\\bin",
      // Official curl installer (https://opencode.ai/install).
      HOME + "\\.opencode\\bin",
      // Manual install — keep an eye on common Program Files locations.
      "C:\\Program Files\\opencode",
      "C:\\Program Files (x86)\\opencode",
    ];
    // Flatten: for each base dir, try common binary names including Windows-
    // specific shim extensions (.cmd, .exe, .bat, .ps1) and the extensionless
    // name some npm installs create. Order: prefer .cmd/.exe that Node can
    // exec directly on Windows.
    const names = ["opencode.cmd", "opencode.exe", "opencode.bat", "opencode", "opencode.ps1"];
    const out = [];
    for (const dir of base) {
      for (const name of names) out.push(join(dir, name));
    }
    return out;
  }
  // unix
  const base = [
    join(HOME, ".local", "bin"),
    join(HOME, ".bun", "bin"),
    join(HOME, ".opencode", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(HOME, ".cargo", "bin"),
    join(HOME, ".nix-profile", "bin"),
    "/usr/local/Homebrew/bin",
    "/opt/npm/bin",
  ];
  return base.map((dir) => join(dir, "opencode"));
}

/**
 * Run a command and capture stdout. Returns null on any failure (timeout,
 * ENOENT, non-zero exit, …).
 *
 * IMPORTANT (Windows): on Windows, Node's `execFile` cannot directly run
 * `.cmd` / `.bat` files because CreateProcessW requires the file extension to
 * be recognized without the shell. With `shell: true`, Node invokes cmd.exe
 * which handles shim extensions natively. This is the difference between
 * "the binary exists" and "the binary can actually run" — for opencode shims
 * (`opencode.cmd`) we need shell:true to succeed.
 *
 * Args we pass (`["--version"]`) are static and never contain user input, so
 * the shell-injection risk of `shell: true` is zero in practice.
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {number} [timeoutMs]
 */
async function runCmd(cmd, args = [], timeoutMs = DETECT_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: IS_WIN,  // required for `.cmd` shims on Windows
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Try to actually run `<path> --version`. Returns the version string on
 * success, null on any failure (ENOENT, exec format error, timeout, …).
 * This is the source of truth for "available" — `existsSync` is unreliable
 * on Windows because of PATHEXT / extensionless shims.
 * @param {string} binPath
 */
async function tryRun(binPath) {
  const out = await runCmd(binPath, ["--version"], VERSION_TIMEOUT_MS);
  if (!out) return null;
  const m = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
  return m ? m[1] : out.slice(0, 40);
}

/**
 * Reorder PATH candidates to prefer executable extensions (`.cmd`, `.exe`,
 * `.bat`, `.ps1`) over extensionless entries. On Windows, `where.exe` may
 * list the extensionless shim before the real `.cmd` — but Node's
 * `child_process.spawn` cannot directly execute an extensionless file via
 * CreateProcessW. We need to return a path that spawn() can launch WITHOUT
 * requiring `shell: true` everywhere downstream.
 *
 * This is a string-level reorder, no I/O — `tryRun` still validates each one.
 */
function prioritizeExecutableExtensions(lines) {
  if (!IS_WIN) return lines;
  const extRank = (p) => {
    const lower = p.toLowerCase();
    if (lower.endsWith(".cmd")) return 0;   // npm/pnpm/yarn shims
    if (lower.endsWith(".exe")) return 1;   // scoop / installer / custom
    if (lower.endsWith(".bat")) return 2;   // legacy
    if (lower.endsWith(".ps1")) return 3;   // powershell shim
    return 4;                                // extensionless / unknown
  };
  return [...lines].sort((a, b) => extRank(a) - extRank(b));
}

/**
 * Resolve a PATH-located binary by trying EVERY line (not just the first).
 * On Windows, `where.exe` may return a stale extensionless shim before the
 * real `.cmd` — we don't know which one will actually run, so we try each
 * with `tryRun`.
 *
 * PATH candidates are reordered to prefer executable extensions (`.cmd` /
 * `.exe` / `.bat` / `.ps1`) over extensionless entries, so the path we
 * return can be launched by Node's `spawn()` without `shell: true`.
 * @returns {Promise<{ path: string|null, triedPaths: string[], whichOutput: string|null }>}
 */
async function resolveBinaryPath() {
  const tried = [];

  // 1. PATH lookup — try each line via tryRun.
  const cmd = IS_WIN ? "where" : "which";
  const out = await runCmd(cmd, ["opencode"]);
  if (out) {
    const rawLines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const lines = prioritizeExecutableExtensions(rawLines);
    tried.push(`<${cmd} opencode> → ${rawLines.length} candidate(s) (priority-ordered):`);
    for (const p of lines) tried.push(`  ${p}`);
    for (const p of lines) {
      const v = await tryRun(p);
      if (v !== null) {
        tried.push(`✓ executable: ${p}`);
        return { path: p, version: v, triedPaths: tried, whichOutput: out };
      } else {
        tried.push(`✗ not executable (skipping): ${p}`);
      }
    }
  } else {
    tried.push(`<${cmd} opencode> → (no result)`);
  }

  // 2. Candidate paths — same tryRun validation. Note: candidatePaths() already
  //    emits `.cmd` first via the names array, so these are already prioritized.
  for (const c of candidatePaths()) {
    tried.push(c);
    const v = await tryRun(c);
    if (v !== null) {
      tried.push(`✓ executable: ${c}`);
      return { path: c, version: v, triedPaths: tried, whichOutput: out };
    }
  }

  return { path: null, version: null, triedPaths: tried, whichOutput: out };
}

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   path: string|null,
 *   version: string|null,
 *   available: boolean,
 *   reason?: string,
 *   triedPaths?: string[],
 *   whichOutput?: string|null,
 *   homeUsed?: string
 * }>}
 *   `available` = installed AND a version was readable (i.e. the binary runs).
 */
export async function detectOpencode() {
  const HOME = resolveHome();
  console.log("[opencode-detector] HOME=", HOME, "USERPROFILE=", process.env.USERPROFILE);
  const { path: binPath, version, triedPaths, whichOutput } = await resolveBinaryPath();
  if (!binPath) {
    console.log("[opencode-detector] not found. searched:");
    for (const p of triedPaths) console.log("  -", p);
    return {
      installed: false,
      path: null,
      version: null,
      available: false,
      reason: "not_found",
      triedPaths,
      whichOutput,
      homeUsed: HOME,
    };
  }
  // tryRun already proved --version works, so available is true whenever we
  // got a path with a non-null version.
  return {
    installed: true,
    path: binPath,
    version,
    available: version !== null,
    reason: version === null ? "version_unreadable" : undefined,
    triedPaths,
    whichOutput,
    homeUsed: HOME,
  };
}