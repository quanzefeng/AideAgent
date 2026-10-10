// ── Reversible compression: archive → pointer → context_recall ────────
//
// Every place that drops or truncates context (compressContext, the
// continuation rebuild, the MAX_OUTPUT / hard-cut caps) calls archiveDropped()
// FIRST, stores the full original text in session_db.context_archive, and
// then leaves a short `ca_*` pointer in the live context. The model reads the
// pointer back with the `context_recall` tool, so compression degrades
// gracefully instead of destroying information (the previous behaviour).

import sessionDb from "../session-db.ts";

// Fragments below this size are not worth an archive row — the pointer would
// cost almost as many tokens as the original.
export const ARCHIVE_MIN_CHARS = 500;
// How many ids to advertise per compression event before the marker itself
// starts eating the savings.
export const ARCHIVE_POINTER_LIMIT = 8;

let _enabled = true;
/** Tests set this false so compressContext never writes the user's real DB. */
export function setContextArchiveEnabled(v: boolean): void { _enabled = v; }
export function isContextArchiveEnabled(): boolean { return _enabled; }

export interface ArchiveOpts {
  content: string;
  kind?: string;   // tool_result | message | dropped_segment
  source?: string; // compressContext | continuation | MAX_OUTPUT | hard_cut
  role?: string;
  sessionId?: string | null;
  minChars?: number;
}

/**
 * Persist dropped context. Returns the `ca_*` pointer, or null when nothing
 * was archived (disabled, too small, or DB error) — callers must treat null
 * as "no pointer available" and keep their existing truncation text.
 */
export function archiveDropped(opts: ArchiveOpts): string | null {
  if (!_enabled) return null;
  if (!opts?.content) return null;
  try {
    return sessionDb.archiveContext({
      content: opts.content,
      kind: opts.kind || "message",
      source: opts.source || "",
      role: opts.role || "",
      sessionId: opts.sessionId ?? null,
      minChars: opts.minChars ?? ARCHIVE_MIN_CHARS,
    });
  } catch (e: any) {
    console.error("[context-archive] failed:", e.message);
    return null;
  }
}

/** Render ids into the suffix used inside truncation markers. */
export function pointerSuffix(ids: Array<string | null>): string {
  const clean = ids.filter(Boolean) as string[];
  if (clean.length === 0) return "原文已丢弃，不可恢复";
  const shown = clean.slice(0, ARCHIVE_POINTER_LIMIT);
  const more = clean.length > shown.length ? ` 等 ${clean.length} 条` : "";
  return `原文已归档 ${shown.map(i => `#${i}`).join(" ")}${more}，用 context_recall(id=...) 取回`;
}

export function readArchived(id: string) {
  try { return sessionDb.readContext(id); } catch { return null; }
}
export function searchArchived(query: string, limit = 5) {
  try { return sessionDb.searchContext(query, limit); } catch { return []; }
}
export function listArchived(limit = 20, sessionId: string | null = null) {
  try { return sessionDb.listContextArchive(limit, sessionId); } catch { return []; }
}
