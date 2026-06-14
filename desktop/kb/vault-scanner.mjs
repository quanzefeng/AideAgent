/**
 * Vault directory scanning and path safety validation.
 *
 * Responsibilities:
 *   - Recursively scan the Obsidian vault for .md files
 *   - Validate that user-supplied relative paths stay inside the vault
 *     (defends against `..` traversal, absolute paths, symlinks pointing
 *     outside, NTFS alternate data streams, and null bytes)
 *   - Configurable skip-list for directories that should never be indexed
 *     (node_modules, .git, etc.)
 *
 * Path safety uses realpathSync() to defeat symlink-based bypasses that
 * a pure string prefix check would miss.
 */

import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "fs";
import { join, relative, extname, basename, dirname } from "path";
import { getVault } from "./config.mjs";
import { extractTitle, extractTags, stripNoteBody } from "./markdown.mjs";

// Directories that should NEVER be indexed. These pollute search results
// with unrelated content (e.g. .opencode/node_modules/zod/README.md
// drowning out actual user notes). Configurable via setVaultExcludes.
const DEFAULT_SKIP_DIRS = new Set([
  ".obsidian",    // Obsidian config + plugins
  "node_modules", // npm/pnpm package internals (huge, noisy)
  ".git",         // git internals (binary)
  ".trash",       // Obsidian trash
  ".vscode",      // IDE config
  ".idea",        // JetBrains config
]);

let _customSkipDirs = new Set();

/**
 * Add custom directory names to skip during scanning.
 * @param {string[]} names
 */
export function setVaultExcludes(names) {
  _customSkipDirs = new Set((names || []).map(String));
}

/**
 * Validate that `relPath` resolves to a location inside the vault.
 *
 * Defends against:
 *   - ".." path traversal (e.g. "../../etc/passwd")
 *   - Absolute paths and UNC paths (\\server\share)
 *   - Symlinks inside the vault that point outside (e.g. a malicious
 *     Obsidian plugin or user-created symlink to C:\Windows\System32)
 *   - NTFS alternate data streams ("foo.md:hidden")
 *   - Null bytes and other control characters
 *
 * Uses realpathSync on both sides to defeat symlink-based bypasses that
 * a pure string prefix check would miss.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isSafeVaultPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  // Reject obviously dangerous patterns upfront
  if (relPath.includes("..")) return false;          // traversal segments
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false; // absolute / UNC
  if (/[\x00-\x1f]/.test(relPath)) return false;     // control chars incl. NUL
  if (/^[A-Za-z]:/.test(relPath)) return false;      // Windows drive-relative
  if (relPath.includes(":")) return false;           // NTFS ADS (foo.md:hidden)
  const _vaultPath = getVault();
  if (!_vaultPath) return false;

  const resolved = join(_vaultPath, relPath);
  // Compare real paths (resolve symlinks on both sides)
  let realVault, realTarget;
  try {
    realVault = realpathSync(_vaultPath);
  } catch {
    return false;
  }
  try {
    if (existsSync(resolved)) {
      // Existing file/dir — resolve any symlinks
      realTarget = realpathSync(resolved);
    } else {
      // New file (e.g. createNote): resolve the closest EXISTING ancestor
      // and re-append. This catches symlinks in intermediate directories
      // while gracefully handling "file doesn't exist yet" + "parent
      // directory doesn't exist yet" (the latter is allowed for new files).
      let cursor = resolved;
      let realCursor = null;
      while (cursor && cursor !== dirname(cursor)) {
        if (existsSync(cursor)) {
          realCursor = realpathSync(cursor);
          break;
        }
        cursor = dirname(cursor);
      }
      // If no ancestor exists, the resolved path is new within the vault
      // root — append basename to the vault's real path. This still rejects
      // relPath values that escaped the vault, because join() is bounded.
      const base = basename(resolved);
      realTarget = join(realCursor || realVault, base);
    }
  } catch {
    return false;
  }
  // Normalize Windows path separators before comparison
  const norm = (p) => p.replace(/\\/g, "/");
  return norm(realTarget).startsWith(norm(realVault) + "/") || norm(realTarget) === norm(realVault);
}

/** @param {string} dir @param {string} baseDir @returns {Array<{relPath:string, filename:string, title:string, tags:string[], body:string, wordCount:number, mtimeMs:number}>} */
export function scanVault(dir, baseDir) {
  /** @type {Array<{relPath:string, filename:string, title:string, tags:string[], body:string, wordCount:number, mtimeMs:number}>} */
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ..._customSkipDirs]);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...scanVault(fullPath, baseDir));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      try {
        const stat = statSync(fullPath);
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        const title = extractTitle(content, entry.name);
        /** @type {string[]} */
        const tags = extractTags(content);
        // Strip frontmatter and markdown for body (single source of truth)
        const body = stripNoteBody(content);
        results.push({
          relPath,
          filename: entry.name,
          title,
          tags,
          body,
          wordCount: body.length,
          mtimeMs: stat.mtimeMs,
        });
      } catch (/** @type {any} */ e) {
        console.warn(`[kb] Skipping ${fullPath}: ${e.message}`);
      }
    }
  }
  return results;
}
