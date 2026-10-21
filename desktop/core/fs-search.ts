// ── Filesystem search — native grep with ripgrep acceleration ──
//
// The old grep implementation shelled out to PowerShell:
//
//   Get-ChildItem -Path ... -Recurse | Select-String ...
//
// which (a) walked node_modules/.git, (b) broke on quotes in the pattern,
// (c) started a whole PowerShell process per call, and (d) returned only the
// basename, so `index.ts:42` was ambiguous across the repo.
//
// This module prefers `rg` (fast, respects .gitignore, smart-case) and falls
// back to a bounded in-process walker when ripgrep is not installed. Both
// paths return the same shape and honor the same exclusions and caps.

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components",
  "dist", "build", "out", "release", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".cache", ".parcel-cache", ".turbo", ".venv", "venv", "__pycache__",
  "target", "models", ".idea", ".vscode-test", "test-results", "playwright-report",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_WALKED = 40_000;

export interface GrepOptions {
  pattern: string;
  path?: string;
  include?: string;
  context?: number;
  maxResults?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export interface GrepResult {
  matches: string[];
  count: number;
  engine: "ripgrep" | "native";
  truncated?: boolean;
  hint?: string;
}

function clampInt(v: any, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function hasUppercase(pattern: string): boolean {
  // ripgrep's smart-case ignores uppercase inside escapes/classes badly; a
  // simple scan is good enough and matches user expectation for code search.
  return /[A-Z]/.test(pattern);
}

function matchesInclude(relPath: string, include?: string): boolean {
  if (!include) return true;
  const clean = include.trim().replace(/\\/g, "/");
  if (!clean) return true;
  const candidates = clean.includes("/") ? [relPath] : [relPath.split("/").pop() || relPath];
  const re = new RegExp(`^${globToRegexSource(clean)}$`, "i");
  return candidates.some(c => re.test(c));
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const parts = glob.slice(i + 1, end).split(",").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${parts.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else if ("\\.+^$()|[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

async function walkFiles(root: string, include: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES_WALKED) {
    if (signal?.aborted) break;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (signal?.aborted) break;
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (matchesInclude(rel, include)) files.push(abs);
        if (files.length >= MAX_FILES_WALKED) break;
      }
    }
  }
  return files;
}

function runRipgrep(opts: GrepOptions, cwd: string): Promise<GrepResult | null> {
  const timeout = clampInt(opts.timeout, 15000, 1000, 120000);
  const maxResults = clampInt(opts.maxResults, 100, 1, 500);
  const context = clampInt(opts.context, 2, 0, 20);
  const target = opts.path ? resolve(cwd, opts.path) : cwd;
  const args = ["--json", "--line-number", "--no-heading", "--color", "never", "--smart-case"];
  if (context > 0) args.push("-C", String(context));
  if (opts.include) args.push("-g", opts.include);
  for (const d of SKIP_DIRS) args.push("-g", `!${d}/**`);
  args.push("--", opts.pattern, target);

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("rg", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolvePromise(null);
      return;
    }
    let buf = "";
    let stderr = "";
    let matches: string[] = [];
    let matchCount = 0;
    let sawNonEmptyOutput = false;
    let settled = false;
    let spawnFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GrepResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolvePromise(result);
      };
      // Resolve only after rg actually releases its file handles. Returning on
      // kill() left a short window where Windows could still hold the search
      // root (rmdir → EBUSY) and where the next tool call could race the old
      // process. If rg already exited, resolve immediately.
      if (spawnFailed || !child || child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      child.once("close", done);
      try { child.kill(); } catch { done(); }
    };
    // Stop must cancel a running rg too, not only the JS fallback.
    const onAbort = () => finish({
      matches, count: matches.length, engine: "ripgrep", hint: "Search aborted.",
    });
    if (opts.signal?.aborted) {
      finish({ matches: [], count: 0, engine: "ripgrep", hint: "Search aborted." });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      finish({
        matches, count: matches.length, engine: "ripgrep",
        truncated: true,
        hint: `Search timed out after ${timeout}ms. Narrow the path/pattern.`,
      });
    }, timeout);

    child.on("error", (err: any) => {
      if (err?.code === "ENOENT") { spawnFailed = true; finish(null); }
      else finish(null);
    });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        sawNonEmptyOutput = true;
        let evt: any;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt?.type === "match") {
          const p = evt.data?.path?.text ?? "";
          const ln = evt.data?.line_number ?? 0;
          const text = String(evt.data?.lines?.text ?? "").replace(/\r?\n$/, "");
          matches.push(`${relative(cwd, p).split(sep).join("/")}:${ln}: ${text}`);
          matchCount++;
          if (matchCount >= maxResults) {
            finish({
              matches, count: matches.length, engine: "ripgrep",
              truncated: true,
              hint: `Result cap reached (${maxResults}). Refine the pattern or raise max_results (max 500).`,
            });
            return;
          }
        } else if (evt?.type === "context" && matches.length > 0) {
          const text = String(evt.data?.lines?.text ?? "").replace(/\r?\n$/, "");
          matches.push(`  | ${text}`);
        }
      }
    });
    child.on("close", (code) => {
      if (spawnFailed) return; // finish(null) already ran
      if (code === 2) { finish(null); return; } // rg usage/IO error → fallback
      if (!sawNonEmptyOutput && stderr && /unrecognized|invalid/i.test(stderr) && code !== 1) {
        finish(null);
        return;
      }
      finish({ matches, count: matches.length, engine: "ripgrep" });
    });
  });
}

async function runNative(opts: GrepOptions, cwd: string): Promise<GrepResult> {
  const maxResults = clampInt(opts.maxResults, 100, 1, 500);
  const context = clampInt(opts.context, 2, 0, 20);
  const target = opts.path ? resolve(cwd, opts.path) : cwd;
  const flags = hasUppercase(opts.pattern) ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, flags);
  } catch (e: any) {
    throw new Error(`Invalid regex: ${e?.message || e}`);
  }

  let files: string[];
  try {
    const st = await stat(target);
    files = st.isFile() ? [target] : await walkFiles(target, opts.include, opts.signal);
  } catch {
    return { matches: [], count: 0, engine: "native", hint: `Path not found: ${target}` };
  }

  const matches: string[] = [];
  let matchCount = 0;
  let idx = 0;
  let aborted = false;

  const scan = async (abs: string) => {
    if (matchCount >= maxResults || opts.signal?.aborted) return;
    let st;
    try { st = await stat(abs); } catch { return; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
    let content: string;
    try {
      const buf = await readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) return; // binary
      content = buf.toString("utf-8");
    } catch { return; }
    const lines = content.split(/\r?\n/);
    const rel = relative(cwd, abs).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (matchCount >= maxResults || opts.signal?.aborted) return;
      if (!re.test(lines[i])) continue;
      matchCount++;
      matches.push(`${rel}:${i + 1}: ${lines[i]}`);
      for (let c = 1; c <= context && i + c < lines.length; c++) {
        matches.push(`  | ${lines[i + c]}`);
      }
    }
  };

  const workers = Array.from({ length: 12 }, async () => {
    while (true) {
      if (matchCount >= maxResults || opts.signal?.aborted) return;
      const i = idx++;
      if (i >= files.length) return;
      await scan(files[i]);
    }
  });
  await Promise.all(workers);
  if (opts.signal?.aborted) aborted = true;

  return {
    matches,
    count: matches.length,
    engine: "native",
    ...(matchCount >= maxResults ? {
      truncated: true,
      hint: `Result cap reached (${maxResults}). Refine the pattern or raise max_results (max 500).`,
    } : {}),
    ...(aborted ? { hint: "Search aborted." } : {}),
  };
}

/**
 * Search file contents. Throws only for invalid regex when the native engine
 * runs; a missing ripgrep transparently falls back.
 */
export async function grepFiles(opts: GrepOptions, cwd: string, signal?: AbortSignal): Promise<GrepResult> {
  if (!opts.pattern) throw new Error("pattern is required");
  const merged = { ...opts, signal: opts.signal ?? signal };
  const rg = await runRipgrep(merged, cwd);
  if (rg) return rg;
  return runNative(merged, cwd);
}
