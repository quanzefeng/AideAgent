// ── Automatic Memory Extraction (pure parser) ─────────────────
//
// autoReview asks the model for structured JSON. Keeping the parser in its own
// module makes it unit-testable without Electron / IPC, and lets us accept the
// older line-based format so an older prompt profile cannot silently stop
// saving memories.

export type ExtractedMemoryType = "user" | "feedback" | "project" | "reference";

export interface ExtractedMemory {
  type: ExtractedMemoryType;
  title: string;
  summary: string;
  content: string;
}

const TYPE_ALIASES: Record<string, ExtractedMemoryType> = {
  user: "user",
  preference: "user",
  preferences: "user",
  user_preference: "user",
  user_preferences: "user",
  feedback: "feedback",
  correction: "feedback",
  corrections: "feedback",
  rule: "feedback",
  project: "project",
  decision: "project",
  decisions: "project",
  knowledge: "project",
  context: "project",
  reference: "reference",
  references: "reference",
  docs: "reference",
  pointer: "reference",
};

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const GENERIC_SECRET_PATTERN =
  /\b(?:api[_-]?key|password|passwd|secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-]{12,})/i;

/** Never let auto-extraction persist an obvious credential. */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_PATTERNS.some(re => re.test(text))) return true;
  const match = text.match(GENERIC_SECRET_PATTERN);
  if (!match) return false;
  // "api_key: OPENAI_API_KEY" is a safe pointer to an env var, not a value.
  if (/^[A-Z][A-Z0-9_]*$/.test(match[1])) return false;
  return true;
}

function oneLine(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function normalizeType(value: unknown): ExtractedMemoryType {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TYPE_ALIASES[key] || "project";
}

function normalizeItem(raw: any): ExtractedMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const content = String(raw.content ?? raw.text ?? raw.value ?? raw.memory ?? "").trim();
  if (!content) return null;
  if (looksLikeSecret(content)) return null;

  const type = normalizeType(raw.type ?? raw.kind ?? raw.category);
  const fallbackTitle = oneLine(content, 60);
  const title = oneLine(raw.title ?? raw.name, 80) || fallbackTitle;
  const summary = oneLine(raw.summary ?? raw.description, 160) || oneLine(content, 160);
  return {
    type,
    title,
    summary,
    content: content.length > 2000 ? content.slice(0, 2000) + "\n…(truncated)" : content,
  };
}

function tryParseJson(text: string): ExtractedMemory[] | null {
  const candidates = [text];
  // Models often wrap JSON in a sentence or a markdown fence. Try the first
  // balanced-looking object/array before giving up.
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.memories)
          ? parsed.memories
          : Array.isArray(parsed?.items)
            ? parsed.items
            : null;
      if (!arr) continue;
      const normalized = arr.map(normalizeItem).filter((x: unknown): x is ExtractedMemory => !!x);
      if (normalized.length > 0) return normalized.slice(0, 8);
    } catch { /* try next shape */ }
  }
  return null;
}

/**
 * Parse a model response from autoReview.
 *
 * Accepted:
 * - {"memories":[{type,title,summary,content}, ...]}
 * - [{...}, ...]
 * - legacy PREFERENCE:/DECISION:/KNOWLEDGE:/FEEDBACK:/REFERENCE: lines
 * - "NONE" / empty -> []
 */
export function parseMemoryExtraction(raw: string): ExtractedMemory[] {
  const text = String(raw ?? "").trim();
  if (!text || /^none\b/i.test(text)) return [];

  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const json = tryParseJson(withoutFence) || tryParseJson(text);
  if (json && json.length > 0) return json;

  // Legacy line format. Keep this so users who customized the prompt profile
  // don't lose auto-extraction after upgrading.
  const out: ExtractedMemory[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(PREFERENCE|FEEDBACK|DECISION|KNOWLEDGE|REFERENCE)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const content = m[2].trim();
    if (!content || /^none$/i.test(content) || looksLikeSecret(content)) continue;
    const kind = m[1].toUpperCase();
    const type: ExtractedMemoryType =
      kind === "PREFERENCE" ? "user" :
      kind === "FEEDBACK" ? "feedback" :
      kind === "REFERENCE" ? "reference" : "project";
    out.push({
      type,
      title: oneLine(content, 60),
      summary: oneLine(content, 160),
      content: content.length > 2000 ? content.slice(0, 2000) + "\n…(truncated)" : content,
    });
  }
  return out.slice(0, 8);
}
