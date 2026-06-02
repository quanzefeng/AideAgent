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
  if (systemEnd === -1) return { estimatedTokens: afterTruncation.totalTokens, compressed: true, removedMessages };
  // Keep prefix (cache anchor) + suffix (current context), trim middle messages
  const ANCHOR = 6;  // first 6 non-system messages preserved as cache prefix
  const RECENT = 8;  // last 8 messages preserved as current context (includes user question)
  if (msgs.length > systemEnd + ANCHOR + RECENT) {
    const prefix = msgs.slice(0, systemEnd + ANCHOR);
    const suffix = msgs.slice(-RECENT);
    removedMessages = msgs.length - prefix.length - suffix.length;
    msgs.splice(0, msgs.length, ...prefix, ...suffix);
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

export async function summarizeForContinuation(msgs, apiKey, apiUrl, model, apiFormat) {
  const convText = msgs.slice(1).map(m => {
    const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role === "tool" ? "工具返回" : m.role;
    const text = (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""))
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 600);
    return `[${role}]: ${text}`;
  }).join("\n");

  const compactPrompt = `你是一个对话摘要助手。请总结以下对话，保留关键信息：

**必须保留：** 具体文件名、函数名、错误信息、用户需求和偏好、已做出的决策、代码改动
**必须丢弃：** 问候语、重复内容、工具调用原始输出细节

对话：
${convText}

用一段中文简要总结（包括：已完成什么、正在做什么、还需要做什么）：`;

  try {
    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: compactPrompt }],
      max_tokens: 2048,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
    const headers = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "你是一个专业的对话摘要助手。";
      body.model = model || "claude-sonnet-4-20250514";
    }

    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Summarize failed: ${res.status}`);
    const data = await res.json();
    const summary = apiFormat === "anthropic"
      ? (data.content?.[0]?.text || "")
      : (data.choices?.[0]?.message?.content || "");

    if (summary && summary.trim().length > 20) return summary.trim();
  } catch (e) {
    console.error("[token-budget] summarizeForContinuation failed:", e.message);
  }

  // Fallback: simple truncation-based summary
  const lines = ["## 对话摘要\n"];
  for (const m of msgs.slice(1, -6)) {
    const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "";
    if (!role) continue;
    const text = (typeof m.content === "string" ? m.content : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 250);
    if (text) lines.push(`- **${role}：** ${text}`);
  }
  return lines.join("\n");
}

export { TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD };
