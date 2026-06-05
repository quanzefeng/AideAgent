// ── AI Semantic Memory Selection ────────────────────────────

import * as memory from "../memory-store.mjs";
import { _surfacedMemories } from "./state.mjs";

export async function selectRelevantMemories(query, apiKey, apiUrl, model, apiFormat) {
  const memories = memory.listMemories();
  if (memories.length === 0) return "";

  const freshMemories = memories.filter(m => !_surfacedMemories.has(m.filename));
  const candidates = freshMemories.length >= 3 ? freshMemories : memories;
  if (candidates.length === 0) return "";

  if (candidates.length <= 5) {
    for (const m of candidates) _surfacedMemories.add(m.filename);
    return candidates.map(m => {
      const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
      return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
    }).join("\n");
  }

  const manifest = candidates.map(m => {
    const ageDays = memory.memoryAgeDays(m.mtimeMs);
    const ageStr = ageDays > 30 ? ` [${ageDays}d old]` : ageDays > 7 ? ` [${ageDays}d]` : "";
    return `- ${m.filename} [${m.type}] ${m.name}: ${m.description}${ageStr}`;
  }).join("\n");

  const selectPrompt = `You are selecting memory files relevant to a user's query. From the list below, pick up to 5 files that are clearly useful. Be selective — if unsure, skip it. Do NOT select reference docs for tools already being used (unless they contain warnings/gotchas).

CRITICAL: If the query starts with "当前任务上下文:", the user is ALREADY working on a specific task (described after that prefix). Skip memories that describe the SAME task — the agent doesn't need to be reminded of what it's currently doing. Only select memories that provide genuinely NEW background knowledge or related-but-different context. Memories that describe tasks already being worked on are interference, not help.

Return ONLY a JSON array of filenames.

User query: ${query.slice(0, 500)}

Available memories:
${manifest}

Return: {"selected_memories": ["file1.md", "file2.md"]}`;

  try {
    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: selectPrompt }],
      max_tokens: 256,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
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
      const selectedText = apiFormat === "anthropic"
        ? (data.content?.[0]?.text || "")
        : (data.choices?.[0]?.message?.content || "");

      let selectedNames = [];
      try {
        const parsed = JSON.parse(selectedText);
        selectedNames = (parsed.selected_memories || parsed || []).map(s => String(s).trim().replace(/\.md$/, ""));
      } catch {
        selectedNames = selectedText.split(/[,，\n]/).map(s => s.trim().replace(/\.md$/, "")).filter(Boolean);
      }

      const validFilenames = new Set(candidates.map(m => m.filename));
      const validNames = selectedNames.filter(sn => {
        if (validFilenames.has(sn)) return true;
        if (validFilenames.has(sn + ".md")) return true;
        return candidates.some(m => m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")));
      });

      const selected = candidates.filter(m =>
        validNames.some(sn => m.filename === sn || m.filename === sn + ".md" || m.filename.includes(sn) || sn.includes(m.filename.replace(/\.md$/, "")))
      ).slice(0, 5);

      if (selected.length > 0) {
        for (const m of selected) _surfacedMemories.add(m.filename);
        return selected.map(m => {
          const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
          return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
        }).join("\n");
      }
    }
  } catch (e) {
    console.error("[memory] semantic selection failed:", e.message);
  }

  const fallback = candidates.slice(0, 5);
  for (const m of fallback) _surfacedMemories.add(m.filename);
  return fallback.map(m => {
    const ageNote = memory.memoryFreshnessNote(m.mtimeMs);
    return `\n### [${m.type}] ${m.name}${ageNote}\n${m.body}`;
  }).join("\n");
}
