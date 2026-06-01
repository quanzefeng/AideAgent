// ── Token Budget & Context Compression ──────────────────────

import { CONTEXT_WINDOW, CONTEXT_COMPRESS_PCT, TOOL_RESULT_KEEP_CHARS, sendToRenderer } from "./state.mjs";

const TOKEN_BUDGET_WARN = 50000;
const TOKEN_BUDGET_HARD = 80000;

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (ch > 'ÿ') cjk++;
    else ascii++;
  }
  return Math.ceil(cjk * 1.5 + ascii * 0.25);
}

export function trimToBudget(text, budget) {
  if (!text || estimateTokens(text) <= budget) return text;
  const maxChars = budget * 3.5;
  const half = Math.floor(maxChars * 0.6);
  return text.slice(0, half) + `\n\n...(truncated ${Math.ceil(estimateTokens(text) - budget)} tokens)...\n\n` + text.slice(-Math.floor(maxChars * 0.3));
}

export function estimateMessageTokens(msgs) {
  let systemTokens = 0, historyTokens = 0, toolResultTokens = 0;
  for (const m of msgs) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    if (m.role === "system") systemTokens += estimateTokens(c);
    else if (m.role === "tool") toolResultTokens += estimateTokens(c);
    else {
      historyTokens += estimateTokens(c);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) historyTokens += estimateTokens(tc.function?.arguments || "");
      }
    }
  }
  return { totalTokens: systemTokens + historyTokens + toolResultTokens, systemTokens, historyTokens, toolResultTokens };
}

export function compressContext(msgs, budget) {
  if (!budget) budget = Math.floor(CONTEXT_WINDOW * CONTEXT_COMPRESS_PCT);
  const before = estimateMessageTokens(msgs);
  if (before.totalTokens <= budget) return { estimatedTokens: before.totalTokens, compressed: false, removedMessages: 0 };

  let removedMessages = 0;

  for (let i = 1; i < msgs.length - 6; i++) {
    const m = msgs[i];
    if (m.role === "tool" && m.content && m.content.length > TOOL_RESULT_KEEP_CHARS + 100) {
      const origLen = m.content.length;
      m.content = m.content.slice(0, TOOL_RESULT_KEEP_CHARS) + `\n...[truncated ${origLen - TOOL_RESULT_KEEP_CHARS} chars]`;
    }
  }

  const afterTruncation = estimateMessageTokens(msgs);
  if (afterTruncation.totalTokens <= budget) return { estimatedTokens: afterTruncation.totalTokens, compressed: true, removedMessages: 0 };

  const systemEnd = msgs.findIndex(m => m.role !== "system");
  if (systemEnd === -1) return { estimatedTokens: afterPruning.totalTokens, compressed: true, removedMessages };
  while (msgs.length > systemEnd + 10) {
    msgs.splice(systemEnd, 1);
    removedMessages++;
  }

  const afterPruning = estimateMessageTokens(msgs);
  return { estimatedTokens: afterPruning.totalTokens, compressed: true, removedMessages };
}

export function sendContextUsage(msgs) {
  const usage = estimateMessageTokens(msgs);
  sendToRenderer("context:usage", {
    totalTokens: usage.totalTokens,
    systemTokens: usage.systemTokens,
    historyTokens: usage.historyTokens,
    toolResultTokens: usage.toolResultTokens,
    windowSize: CONTEXT_WINDOW,
    usagePct: Math.round((usage.totalTokens / CONTEXT_WINDOW) * 100),
  });
}

export { TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD };
