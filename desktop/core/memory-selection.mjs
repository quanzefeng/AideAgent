// ── AI Semantic Memory Selection ────────────────────────────

import * as memory from "../memory-store.mjs";
import { markSurfaced, isSurfaced, pruneSurfacedMemories, getCurrentTurn } from "./state.mjs";

// P3方案3(b): hard limits on user / feedback inclusion in each selection.
// Without this, the LLM-side picker sometimes skips user preferences entirely
// in favor of project context, leading to the Agent "forgetting" user
// corrections and re-doing the same mistake (e.g. re-checking imaginary web
// results the user already complained about).
const HARD_USER_LIMIT = 1;
const HARD_FEEDBACK_LIMIT = 2;
const HARD_PROJECT_LIMIT = 8 - HARD_USER_LIMIT - HARD_FEEDBACK_LIMIT; // 5

/**
 * @param {string} query
 * @param {string} apiKey
 * @param {string} apiUrl
 * @param {string} model
 * @param {string} apiFormat
 */
export async function selectRelevantMemories(query, apiKey, apiUrl, model, apiFormat) {
  const memories = memory.listMemories();
  if (memories.length === 0) return "";

  // P3方案3(c): prune TTL-expired entries from the surfaced-set so the
  // "fresh" pool below can grow back as the conversation moves on.
  const now = getCurrentTurn();
  pruneSurfacedMemories(now);

  // "Fresh" = not surfaced in the last _SURFACED_TTL_TURNS conversation turns.
  // Fall back to ALL memories when too few fresh ones remain, so the
  // agent never has zero context (better to re-show stale than show nothing).
  const freshMemories = memories.filter(m => !isSurfaced(m.filename, now));
  const candidates = freshMemories.length >= 3 ? freshMemories : memories;
  if (candidates.length === 0) return "";

  // ── Fast path: ≤ 8 candidates → no LLM call, just return all ──
  // (Same behavior as before, but with type-balanced ordering: put
  // user + feedback first so they're always surfaced.)
  if (candidates.length <= 8) {
    const balanced = balanceByType(candidates, 8);
    for (const m of balanced) markSurfaced(m.filename);
    return renderMemories(balanced);
  }

  // ── Slow path: > 8 candidates → ask the LLM to pick top 8 ──
  const manifest = candidates.map(m => {
    const ageDays = memory.memoryAgeDays(m.mtimeMs);
    const ageStr = ageDays > 30 ? ` [${ageDays}d old]` : ageDays > 7 ? ` [${ageDays}d]` : "";
    return `- ${m.filename} [${m.type}] ${m.name}: ${m.description}${ageStr}`;
  }).join("\n");

  const selectPrompt = `You are selecting memory files relevant to a user's query. Pick up to 8 files.

PRIORITY ORDER (load in this order, skip types that don't apply):
1. USER memories (preferences, identity, interests) — try to include at least 1
2. FEEDBACK memories (corrections, behavior rules, "don't do X") — try to include at least 1
3. PROJECT memories (project context, technical decisions)
4. REFERENCE memories (docs, tool references) — only if directly needed

Hard rules:
- If a user/feedback memory exists and is at all relevant, prefer it over a project memory
- Do NOT select reference docs for tools already being used (unless they contain warnings/gotchas)
- Skip memories that describe the SAME task being worked on (interference, not help)

Return ONLY a JSON array of filenames.

User query: ${query.slice(0, 500)}

Available memories:
${manifest}

Return: {"selected_memories": ["file1.md", "file2.md", "file3.md"]}`;

  try {
    /** @type {{ model: string, messages: { role: string, content: string }[], max_tokens: number, stream: boolean, system?: string }} */
    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: selectPrompt }],
      max_tokens: 256,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
    /** @type {Record<string, string>} */
    const headers = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "You select relevant memory files. Return ONLY valid JSON.";
      body.model = model || "claude-haiku-4.5-20250514";
    }

    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      /** @type {string} */
      const selectedText = apiFormat === "anthropic"
        ? (data.content?.[0]?.text || "")
        : (data.choices?.[0]?.message?.content || "");

      let selectedNames = [];
      try {
        const parsed = JSON.parse(selectedText);
        selectedNames = (/** @type {string[]} */ (parsed.selected_memories || parsed || [])).map(s => String(s).trim().replace(/\.md$/, ""));
      } catch {
        selectedNames = selectedText.split(/[,，\n]/).map(s => s.trim().replace(/\.md$/, "")).filter(Boolean);
      }

      const validFilenames = new Set(candidates.map(m => m.filename));
      const validNames = selectedNames.filter(sn => {
        if (validFilenames.has(sn)) return true;
        if (validFilenames.has(sn + ".md")) return true;
        return candidates.some(m => m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")));
      });

      const llmPicked = candidates.filter(m =>
        validNames.some(sn => m.filename === sn || m.filename === sn + ".md" || m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")))
      );

      // P3方案3(b): post-process to enforce type caps. If the LLM skipped
      // user/feedback entirely, swap in the highest-priority fresh ones.
      const final = enforceTypeCaps(llmPicked, candidates, 8);
      if (final.length > 0) {
        for (const m of final) markSurfaced(m.filename);
        return renderMemories(final);
      }
    }
  } catch (/** @type {any} */ e) {
    console.error("[memory] semantic selection failed:", e.message);
  }

  // Fallback: balanced slice from candidates (no LLM involved)
  const fallback = balanceByType(candidates, 5);
  for (const m of fallback) markSurfaced(m.filename);
  return renderMemories(fallback);
}

/**
 * Order memories so user > feedback > project > reference, then
 * keep the first `limit`. Preserves mtime-desc order within each bucket.
 */
function balanceByType(candidates, limit) {
  const byType = { user: [], feedback: [], project: [], reference: [] };
  for (const m of candidates) {
    if (byType[m.type]) byType[m.type].push(m);
    else byType.project.push(m); // unknown types count as project
  }
  const ordered = [...byType.user, ...byType.feedback, ...byType.project, ...byType.reference];
  return ordered.slice(0, limit);
}

/**
 * P3方案3(b): enforce hard caps on user/feedback/project types in the
 * final selection. LLM often skips user/feedback when there are many
 * project memories to choose from — this guarantees at least the cap
 * is met (when available) by swapping out lowest-priority project entries.
 */
function enforceTypeCaps(llmPicked, allCandidates, totalLimit) {
  const picked = [...llmPicked];
  const pickedSet = new Set(picked.map(m => m.filename));

  // Ensure user memories are included
  const userCount = picked.filter(m => m.type === "user").length;
  if (userCount < HARD_USER_LIMIT) {
    const needed = HARD_USER_LIMIT - userCount;
    const userPool = allCandidates
      .filter(m => m.type === "user" && !pickedSet.has(m.filename))
      .slice(0, needed);
    for (const m of userPool) {
      picked.push(m);
      pickedSet.add(m.filename);
    }
  }

  // Ensure feedback memories are included
  const feedbackCount = picked.filter(m => m.type === "feedback").length;
  if (feedbackCount < HARD_FEEDBACK_LIMIT) {
    const needed = HARD_FEEDBACK_LIMIT - feedbackCount;
    const fbPool = allCandidates
      .filter(m => m.type === "feedback" && !pickedSet.has(m.filename))
      .slice(0, needed);
    for (const m of fbPool) {
      picked.push(m);
      pickedSet.add(m.filename);
    }
  }

  // Enforce project cap — if too many projects leaked in, drop the
  // ones the LLM added last (heuristic: lowest mtime in the picked set).
  if (picked.length > totalLimit) {
    const projects = picked
      .map((m, i) => ({ m, i }))
      .filter(x => x.m.type === "project")
      .sort((a, b) => a.m.mtimeMs - b.m.mtimeMs); // oldest first → drop first
    let overflow = picked.length - totalLimit;
    const dropIdx = new Set();
    for (const x of projects) {
      if (overflow <= 0) break;
      dropIdx.add(x.i);
      overflow--;
    }
    return picked.filter((_, i) => !dropIdx.has(i)).slice(0, totalLimit);
  }
  return picked.slice(0, totalLimit);
}

function renderMemories(memories) {
  return memories.map(m => {
    const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
    return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
  }).join("\n");
}
