// ── Token Budget & Context Compression ──────────────────────

import { CONTEXT_WINDOW, CONTEXT_COMPRESS_PCT, TOOL_RESULT_KEEP_CHARS, sendToRenderer } from "./state.mjs";

const TOKEN_BUDGET_WARN = 50000;
const TOKEN_BUDGET_HARD = 80000;

/**
 * @typedef {{ role: string, content?: string|object|null, tool_calls?: Array<{function: {arguments?: string}}> }} Message
 */

/**
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (ch > 'ÿ') cjk++;
    else ascii++;
  }
  return Math.ceil(cjk * 1.5 + ascii * 0.25);
}

/**
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function trimToBudget(text, budget) {
  if (!text || estimateTokens(text) <= budget) return text;
  const maxChars = budget * 3.5;
  const half = Math.floor(maxChars * 0.6);
  return text.slice(0, half) + `\n\n...(truncated ${Math.ceil(estimateTokens(text) - budget)} tokens)...\n\n` + text.slice(-Math.floor(maxChars * 0.3));
}

/**
 * @param {Message[]} msgs
 * @returns {{ totalTokens: number, systemTokens: number, historyTokens: number, toolResultTokens: number }}
 */
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

/**
 * Find protected index ranges in msgs. A "protected" range is either:
 *  - an assistant message that has tool_calls (its paired tool results
 *    would otherwise be orphaned, which Anthropic/OpenAI reject with 400)
 *  - a tool message that has a tool_call_id
 *  - the most recent user message (LLM needs the current ask in context)
 *  - the last 2 messages (preserves the most recent exchange)
 * Returned array is sorted, non-overlapping [start, end) ranges.
 *
 * @param {Message[]} msgs
 * @returns {Array<[number, number]>}
 */
function findProtectedRanges(msgs) {
  const protectedSet = new Set();
  // First user message is the session anchor — keep it.
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "user" && (typeof m.content === "string" ? m.content : "").includes("当前任务锚定")) {
      protectedSet.add(i); break;
    }
  }
  // Any assistant with tool_calls AND the tool results they reference.
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      protectedSet.add(i);
      const ids = new Set(m.tool_calls.map(tc => tc.id).filter(Boolean));
      // Look forward for matching tool messages.
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j].role === "tool" && msgs[j].tool_call_id && ids.has(msgs[j].tool_call_id)) {
          protectedSet.add(j);
        } else if (msgs[j].role === "assistant") {
          break; // stop at next assistant
        }
      }
    } else if (m.role === "tool" && m.tool_call_id) {
      // Standalone tool message — its calling assistant might be gone.
      // Mark as protected so we never orphan a tool result.
      protectedSet.add(i);
    }
  }
  // Convert set to sorted ranges.
  const sorted = [...protectedSet].sort((a, b) => a - b);
  const ranges = [];
  for (const i of sorted) {
    if (ranges.length && i <= ranges[ranges.length - 1][1]) {
      ranges[ranges.length - 1][1] = i;
    } else {
      ranges.push([i, i]);
    }
  }
  return ranges;
}

/**
 * @param {Message[]} msgs
 * @param {number} [budget]
 * @returns {{ estimatedTokens: number, compressed: boolean, removedMessages: number }}
 */
export function compressContext(msgs, budget) {
  if (!budget) budget = Math.floor(CONTEXT_WINDOW * CONTEXT_COMPRESS_PCT);
  const before = estimateMessageTokens(msgs);
  if (before.totalTokens <= budget) return { estimatedTokens: before.totalTokens, compressed: false, removedMessages: 0 };

  let removedMessages = 0;

  // Step 1: truncate long tool results (cheapest reduction).
  for (let i = 1; i < msgs.length - 6; i++) {
    const m = msgs[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_RESULT_KEEP_CHARS + 100) {
      const origLen = m.content.length;
      m.content = m.content.slice(0, TOOL_RESULT_KEEP_CHARS) + `\n...[truncated ${origLen - TOOL_RESULT_KEEP_CHARS} chars]`;
    }
  }

  const afterTruncation = estimateMessageTokens(msgs);
  if (afterTruncation.totalTokens <= budget) return { estimatedTokens: afterTruncation.totalTokens, compressed: true, removedMessages: 0 };

  // Step 2: prune middle messages while preserving tool_call/result pairs.
  const systemEnd = msgs.findIndex(m => m.role !== "system");
  if (systemEnd === -1) return { estimatedTokens: afterTruncation.totalTokens, compressed: true, removedMessages };
  const ANCHOR = 6;  // first 6 non-system messages preserved as cache prefix
  const RECENT = 8;  // last 8 messages preserved as current context (includes user question)
  if (msgs.length <= systemEnd + ANCHOR + RECENT) {
    return { estimatedTokens: afterTruncation.totalTokens, compressed: true, removedMessages: 0 };
  }

  // Mark protected indices (anchors + tool_call pairs) that fall in the
  // prunable middle zone. These are moved into the suffix to survive.
  const middleStart = systemEnd + ANCHOR;
  const middleEnd = msgs.length - RECENT;
  const protectedInMiddle = new Set();
  for (const [a, b] of findProtectedRanges(msgs)) {
    for (let i = Math.max(a, middleStart); i <= Math.min(b, middleEnd - 1); i++) {
      protectedInMiddle.add(i);
    }
  }

  const prefix = msgs.slice(0, middleStart);
  const suffixStart = Math.max(middleEnd, middleStart); // safe even if no protected items
  const suffix = msgs.slice(suffixStart);
  const rescued = [];
  for (const idx of [...protectedInMiddle].sort((a, b) => a - b)) {
    rescued.push(msgs[idx]);
  }
  removedMessages = msgs.length - prefix.length - suffix.length - rescued.length;
  msgs.splice(0, msgs.length, ...prefix, ...rescued, ...suffix);

  const afterPruning = estimateMessageTokens(msgs);
  return { estimatedTokens: afterPruning.totalTokens, compressed: true, removedMessages };
}

/**
 * @param {Message[]} msgs
 */
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

/**
 * @param {Message[]} msgs
 * @param {string} apiKey
 * @param {string} apiUrl
 * @param {string} [model]
 * @param {string} [apiFormat]
 * @param {AbortSignal} [signal] forwarded from the agent loop. When the
 *   user clicks Stop, the parent AbortController fires and cancels this
 *   in-flight summary request — otherwise it completes in the background
 *   and writes a stale summary to the user.
 * @returns {Promise<string>}
 */
export async function summarizeForContinuation(msgs, apiKey, apiUrl, model, apiFormat, signal) {
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
    /** @type {Record<string, any>} */
    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: compactPrompt }],
      max_tokens: 2048,
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
      body.system = "你是一个专业的对话摘要助手。";
      body.model = model || "claude-sonnet-4-20250514";
    }

    // Forward the parent's abort signal. When the user hits Stop, both
    // the main LLM call and this summarization request cancel together.
    // AbortSignal.any() is the standard way to compose a 30s timeout with
    // a user-driven abort; on older Node, fall back to whichever fires first.
    const timeoutSignal = AbortSignal.timeout(30000);
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: composed,
    });
    if (!res.ok) throw new Error(`Summarize failed: ${res.status}`);
    const data = await res.json();
    const summary = apiFormat === "anthropic"
      ? (data.content?.[0]?.text || "")
      : (data.choices?.[0]?.message?.content || "");

    if (summary && summary.trim().length > 20) return summary.trim();
  } catch (e) {
    /** @type {any} */
    const err = e;
    console.error("[token-budget] summarizeForContinuation failed:", err.message);
  }

  // Fallback: structured fact extraction when LLM summarization fails.
  // This must preserve the things future turns need to stay coherent:
  //  - file paths the agent touched
  //  - function/class names
  //  - error messages
  //  - explicit user preferences or decisions
  // Without these, a 30+ turn task loses its coherence on the next continuation.
  const FACT_PATTERNS = [
    { label: "文件", rx: /(?:^|[\s`'"'(\[,>])([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5})(?=[\s`'"')\],;.]|$)/g },
    { label: "函数/类", rx: /\b(?:function|class|const|let|var|export\s+(?:default\s+)?(?:async\s+)?(?:function\s+)?)(\s*)([A-Za-z_$][\w$]*)/g },
    { label: "错误", rx: /(?:Error|Exception|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|404|500|超时|timeout|失败|错误)[^。\n]{0,160}/gi },
    { label: "用户偏好", rx: /(?:记住|下次|以后|总是|永远|不要|必须|请务必|prefer|preference|always|never)[^。\n]{0,160}/gi },
    { label: "决策", rx: /(?:决定|改用|采用|放弃|换成|switch\s+to|chose|picked|use\s+instead)[^。\n]{0,160}/gi },
  ];
  const seen = new Set();
  const facts = [];
  // Guard against short msgs: if we have <14 entries, scan the whole thing;
  // otherwise the original `slice(1, -6)` heuristic (skip system + final
  // 6 to avoid summarizing the very latest user request).
  const scanRange = msgs.length > 14 ? msgs.slice(1, -6) : msgs;
  for (const m of scanRange) {
    if (!m) continue;
    const text = (typeof m.content === "string" ? m.content : "").slice(0, 4000);
    for (const { label, rx } of FACT_PATTERNS) {
      rx.lastIndex = 0;
      let m1;
      let count = 0;
      while ((m1 = rx.exec(text)) !== null && count < 5) {
        const fact = m1[0].replace(/\s+/g, " ").trim().slice(0, 200);
        if (fact.length < 6) continue;
        const key = `${label}::${fact}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push(`- **${label}：** ${fact}`);
        count++;
        if (facts.length >= 60) break;
      }
      if (facts.length >= 60) break;
    }
    if (facts.length >= 60) break;
  }
  if (facts.length === 0) {
    // Last-ditch: at least keep the user messages verbatim (they carry the task statement).
    for (const m of msgs.slice(1, -6)) {
      if (m.role !== "user") continue;
      const text = (typeof m.content === "string" ? m.content : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 250);
      if (text) facts.push(`- **用户消息：** ${text}`);
      if (facts.length >= 20) break;
    }
  }
  return ["## 早期对话关键事实\n", "（LLM 摘要失败，以下为正则提取的事实清单）\n", ...facts].join("\n");
}

export { TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD };
