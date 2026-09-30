/**
 * Test helper: create an isolated knowledge base backed by a temp DB.
 * Usage:
 *   const iso = makeIsoKb({ noteFiles: { "a.md": "# a\nbody" } });
 *   // ... do work ...
 *   iso.cleanup();
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.noteFiles] - map of relative path → file content
 * @param {string} [opts.vaultDir] - override vault path (default: temp dir)
 * @returns {{vaultDir: string, dbPath: string, cleanup: () => void}}
 */
export function makeIsoKb(opts = {}) {
  const base = (opts as any).vaultDir || mkdtempSync(join(tmpdir(), "kb-iso-"));
  const vaultDir = join(base, "vault");
  const dbDir = join(base, "db");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });

  if ((opts as any).noteFiles) {
    for (const [rel, content] of Object.entries((opts as any).noteFiles)) {
      const full = join(vaultDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, (content as any)!, "utf-8");
    }
  }

  const dbPath = join(dbDir, "test.db");

  return {
    vaultDir,
    dbPath,
    cleanup() {
      try { rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
  };
}
