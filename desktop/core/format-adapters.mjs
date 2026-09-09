// ── Format Adapters — OpenAI/Anthropic API calls ────────────

import mcpManager from "../mcp-manager.mjs";
import { TOOL_DEFS } from "./tool-definitions.mjs";
import { getPlanMode, PLAN_MODE_READONLY, sendToRenderer, parseContextWindowFromError, setContextWindow, MAX_API_RETRIES, RETRY_BACKOFF_MS, RETRY_MAX_SINGLE_WAIT } from "./state.mjs";

// ── API retry helpers (rate limit / transient 5xx) ────────────

/**
 * Special error carrying the context-window overflow info. Thrown by the
 * adapters when the API reports the request exceeded the model's context
 * window; `agent-loop.mjs` catches it (via `err.type ===
 * 'CONTEXT_SIZE_EXCEEDED'`), compresses, and retries once.
 * @extends {Error}
 */
export class ContextSizeError extends Error {
  /** @type {string} */
  type = 'CONTEXT_SIZE_EXCEEDED';
  /** @type {number} */
  detectedContextWindow = 0;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HTTP statuses that are worth retrying. 429 = rate limit; 500/502/503/529
 * = provider transient failures. 4xx (400/401/403/404...) are permanent
 * request errors and must NOT be retried.
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

/**
 * Pick the wait time before the next retry.
 * - 429 with a `Retry-After` header → honor it, capped at RETRY_MAX_SINGLE_WAIT.
 * - Otherwise → exponential-ish schedule; the final (5th) retry reserves 30s.
 * @param {Response | null} res
 * @param {number} attempt 0-based retry index (0 = 1st retry, MAX_API_RETRIES-1 = final)
 * @returns {number} delay in ms
 */
export function getRetryDelay(res, attempt) {
  const retryAfter = res?.headers?.get?.("retry-after");
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, RETRY_MAX_SINGLE_WAIT);
  }
  return RETRY_BACKOFF_MS[Math.min(attempt, MAX_API_RETRIES - 1)];
}

/**
 * Notify the renderer that we're about to retry a failed API call.
 * @param {string} source
 * @param {{attempt: number, maxAttempts: number, delayMs: number, status: number, statusText: string}} info
 */
function notifyRetry(source, info) {
  console.warn(`[${source}] API ${info.status} (${info.statusText}) — retry ${info.attempt}/${info.maxAttempts} in ${Math.round(info.delayMs / 1000)}s`);
  sendToRenderer("stream:retrying", info);
}

/**
 * Run a fetch + non-ok handling loop with backoff retries. Used by both
 * adapters. Returns the successful Response, or throws:
 *  - a plain Error for permanent (non-retryable) failures,
 *  - an Error with type=CONTEXT_SIZE_EXCEEDED for context overflow
 *    (caller compresses and retries once),
 *  - an Error whose message records the retry count once retries are
 *    exhausted. AbortError propagates untouched (user cancel / timeout).
 *
 * @param {() => Promise<Response>} doFetch
 * @param {(res: Response, errText: string) => string} buildErrorMsg
 * @param {(errText: string, errorMsg: string) => Error | null} [classify] optional classifier — return a special Error to throw immediately
 * @param {string} [source] log prefix, e.g. "openaiCall"
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(doFetch, buildErrorMsg, classify, source = "api") {
  for (let attempt = 0; ; attempt++) {
    /** @type {Response} */
    let res;
    try {
      res = await doFetch();
    } catch (err) {
      // AbortError (user cancel) and TimeoutError (LLM_CALL_TIMEOUT) must
      // never be retried — the caller handles cancel, and a hung upstream is
      // not a transient blip worth 5 more attempts.
      const errName = /** @type {any} */ (err).name;
      if (errName === "AbortError" || errName === "TimeoutError") throw err;
      // Network-level failure (fetch TypeError: DNS, refused, reset) — retryable.
      if (attempt >= MAX_API_RETRIES) {
        const msg = `已自动重试 ${MAX_API_RETRIES} 次仍失败\n\n${/** @type {any} */ (err).message}`;
        const finalErr = new Error(msg);
        finalErr.cause = err;
        throw finalErr;
      }
      const delayMs = RETRY_BACKOFF_MS[Math.min(attempt, MAX_API_RETRIES - 1)];
      notifyRetry(source, { attempt: attempt + 1, maxAttempts: MAX_API_RETRIES, delayMs, status: 0, statusText: "network error" });
      await sleep(delayMs);
      continue;
    }

    if (res.ok) return res;

    const errText = (await res.text().catch(() => "")).slice(0, 500);
    const errorMsg = buildErrorMsg(res, errText);

    // Classifier may produce a special error (e.g. CONTEXT_SIZE_EXCEEDED).
    if (classify) {
      const special = classify(errText, errorMsg);
      if (special) throw special;
    }

    if (!isRetryableStatus(res.status) || attempt >= MAX_API_RETRIES) {
      if (attempt >= MAX_API_RETRIES) {
        const finalErr = new Error(`已自动重试 ${MAX_API_RETRIES} 次仍失败\n\n${errorMsg}`);
        finalErr.cause = res.status;
        throw finalErr;
      }
      throw new Error(errorMsg);
    }

    const delayMs = getRetryDelay(res, attempt);
    notifyRetry(source, { attempt: attempt + 1, maxAttempts: MAX_API_RETRIES, delayMs, status: res.status, statusText: res.statusText });
    await sleep(delayMs);
  }
}

// ── Tool definition cache (stable per session — MCP config doesn't change mid-conversation) ──
/** @type {null | Array<{type: string, function: {name: string, description: string, parameters: object}}>} */
let _cachedToolDefs = null;
/** @type {null | string} */
let _cachedToolKey = null;

/**
 * @param {boolean} [kbEnabled]
 * @param {boolean} [webSearchEnabled]
 * @returns {Array<{type: string, function: {name: string, description: string, parameters: object}}>}
 */
export function getAllToolDefs(kbEnabled = true, webSearchEnabled = true) {
  const planMode = getPlanMode();
  const key = `${kbEnabled}|${webSearchEnabled}|${planMode}`;
  if (_cachedToolKey === key && _cachedToolDefs) {
    return _cachedToolDefs;
  }
  let builtins = kbEnabled ? TOOL_DEFS : TOOL_DEFS.filter(t => t.function.name !== "kb_write" && t.function.name !== "kb_search");
  if (!webSearchEnabled) builtins = builtins.filter(t => t.function.name !== "web_search" && t.function.name !== "web_fetch");
  if (planMode) builtins = builtins.filter(t => PLAN_MODE_READONLY.has(t.function.name));
  const mcpFilter = webSearchEnabled ? {} : { excludeCategories: ["web-search"] };
  const mcpDefs = mcpManager.listAllToolDefs(mcpFilter);
  console.log("[plan-mode] getAllToolDefs planMode =", planMode, "builtins =", builtins.length, "mcp =", planMode ? 0 : mcpDefs.length);
  // Deduplicate by tool name — duplicate MCP servers (builtin + imported) can collide
  const merged = planMode ? builtins : [...builtins, ...mcpDefs];
  const seen = new Set();
  const result = [];
  for (const def of merged) {
    const name = def.function.name;
    if (!seen.has(name)) { seen.add(name); result.push(def); }
  }
  _cachedToolDefs = result;
  _cachedToolKey = key;
  return result;
}

/**
 * @returns {void}
 */
export function invalidateToolDefsCache() {
  _cachedToolDefs = null;
  _cachedToolKey = null;
}

/**
 * @param {boolean} [kbEnabled]
 * @param {boolean} [webSearchEnabled]
 * @returns {Array<{name: string, description: string, input_schema: object}>}
 */
export function toAnthropicTools(kbEnabled = true, webSearchEnabled = true) {
  return getAllToolDefs(kbEnabled, webSearchEnabled).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * @param {{role: string, content?: any, tool_calls?: Array<{id: string, function: {name: string, arguments: string}}>, tool_call_id?: string}[]} msgs
 * @returns {{messages: Array<{role: string, content: any}>, system: string | null}}
 */
export function toAnthropicMessages(msgs) {
  const messages = [];
  let system = null;
  for (const m of msgs) {
    if (m.role === "system") { system = system ? system + "\n\n" + m.content : m.content; continue; }
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map(c => {
            if (c.type === "image_url") {
              return { type: "image", source: { type: "base64", media_type: c.image_url.url.split(";")[0].replace("data:", ""), data: c.image_url.url.split("base64,")[1] } };
            }
            return c;
          })
        : m.content;
      messages.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* ignored */ }
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
      }
      messages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
    }
  }
  return { messages, system };
}

/**
 * @param {any[]} msgs
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {AbortSignal} signal
 * @param {boolean} [reasoning]
 * @param {boolean} [kbEnabled]
 * @param {boolean} [webSearchEnabled]
 * @returns {Promise<{content: string, reasoningContent: string, finishReason: string | null, tcs: Array<{id: string, type: string, function: {name: string, arguments: string}}>, usage: object | null}>}
 */
export async function openaiCall(msgs, apiUrl, apiKey, model, signal, reasoning = true, kbEnabled = true, webSearchEnabled = true) {
  const toolDefs = getAllToolDefs(kbEnabled, webSearchEnabled);
  console.log("[openaiCall] tools sent to LLM:", toolDefs.map(t => t.function.name).join(", "));
  /** @type {{ model: string, messages: any[], tools: any[], stream: boolean, max_tokens: number, reasoning_effort?: string }} */
  const body = { model: model || "deepseek-chat", messages: msgs, tools: toolDefs, stream: true, max_tokens: 65536 };
  if (reasoning) body.reasoning_effort = "high";
  const res = await fetchWithRetry(
    () => fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    }),
    (res, errText) => `API ${res.status} (${res.statusText})\nURL: ${apiUrl}\nModel: ${model || "deepseek-chat"}\n${errText ? "Response: " + errText : ""}`,
    (errText, errorMsg) => {
      // Context size error — throw a special error for the agent loop to
      // compress-and-retry.
      if (errText.includes('exceed_context_size_error') || errText.includes('exceeds the available context size')) {
        const detectedCtx = parseContextWindowFromError(errText);
        if (detectedCtx) {
          setContextWindow(detectedCtx);
          const retryError = new ContextSizeError(errorMsg);
          retryError.detectedContextWindow = detectedCtx;
          return retryError;
        }
      }
      return null;
    },
    "openaiCall",
  );
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningContent = "";
  /** @type {Record<number, {id: string, type: string, function: {name: string, arguments: string}}>} */
  const tcAccum = {};
  let finishReason = null;
  let usage = null;
  // DEBUG_REASONING=1 dumps the first non-empty delta keys so we can see
  // what fields the API actually returns (e.g. for MiniMax M3, which uses
  // a different field name than DeepSeek's `delta.reasoning_content`).
  // Set the env var, restart the app, run a conversation, then check the
  // Electron main-process console for the [reasoning-debug] lines.
  const debugReasoning = process.env.DEBUG_REASONING === "1";
  if (debugReasoning) console.log(`[reasoning-debug] openaiCall model=${model} url=${apiUrl}`);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n").slice(0, -1)) {
      const t = line.trim();
      if (!t || !t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        const delta = j.choices?.[0]?.delta || {};
        finishReason = j.choices?.[0]?.finish_reason;
        if (j.usage) usage = j.usage; // last chunk carries cache metrics
        if (delta.content) { content += delta.content; sendToRenderer("stream:chunk", { text: delta.content, done: false }); }
        if (delta.reasoning_content) { reasoningContent += delta.reasoning_content; sendToRenderer("stream:reasoning", { text: delta.reasoning_content }); }
        if (debugReasoning) {
          // Log every field the delta exposes (once per unique shape) so we
          // can spot the field name MiniMax M3 / similar providers actually
          // use for chain-of-thought.
          const k = Object.keys(delta).sort().join(",");
          if (!(/** @type {any} */ (globalThis.__reasoningDebugSeen || (globalThis.__reasoningDebugSeen = new Set()))).has(k)) {
            globalThis.__reasoningDebugSeen.add(k);
            console.log(`[reasoning-debug] delta keys: ${k}`);
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) tcAccum[tc.index].id = tc.id;
            // BUGFIX: was `+=` which concatenated repeated name deltas into
            // "bashbash" / "file_readfile_read". OpenAI-compatible providers
            // (DeepSeek V4 flash, MiniMax M3, etc.) sometimes re-emit the
            // tool name in a later delta after a tool_call_id, which then
            // broke tool-executor's switch dispatch and silently dropped the
            // call — manifesting as "no tool call" or "tool output garbled".
            // The name is set once at the first emission; `arguments` is
            // legitimately a streaming append.
            if (tc.function?.name) tcAccum[tc.index].function.name = tc.function.name;
            if (tc.function?.arguments) tcAccum[tc.index].function.arguments += tc.function.arguments;
          }
        }
      } catch { /* ignored */ }
    }
    buf = buf.split("\n").pop() || "";
  }
  if (debugReasoning) {
    console.log(`[reasoning-debug] final reasoningContent.length=${reasoningContent.length} content.length=${content.length}`);
    if (!reasoningContent && content.length > 0) {
      console.log(`[reasoning-debug] ⚠️ reasoningContent is empty but content has ${content.length} chars.`);
      console.log(`[reasoning-debug] content first 500: ${content.slice(0, 500).replace(/\n/g, "\\n")}`);
    }
  }
  return { content, reasoningContent, finishReason, tcs: Object.values(tcAccum), usage };
}

/**
 * @param {any[]} msgs
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {AbortSignal} signal
 * @param {boolean} [reasoning]
 * @param {boolean} [kbEnabled]
 * @param {boolean} [webSearchEnabled]
 * @returns {Promise<{content: string, reasoningContent: string, finishReason: string | null, tcs: Array<{id: string, type: string, function: {name: string, arguments: string}}>, usage: object | null}>}
 */
export async function anthropicCall(msgs, apiUrl, apiKey, model, signal, reasoning = true, kbEnabled = true, webSearchEnabled = true) {
  const { messages, system } = toAnthropicMessages(msgs);
  // ── Cache the first message (first history entry) → caches system + entire history prefix ──
  // After reordering, messages[0] is the first history item — stable across turns.
  if (messages.length > 0) {
    const first = messages[0];
    if (typeof first.content === "string") {
      first.content = [{ type: "text", text: first.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(first.content) && first.content.length > 0) {
      first.content[0].cache_control = { type: "ephemeral" };
    }
  }
  const toolDefs = toAnthropicTools(kbEnabled, webSearchEnabled);
  console.log("[anthropicCall] tools sent to LLM:", toolDefs.map(t => t.name).join(", "));
  const base = apiUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/messages") ? base
    : base.endsWith("/v1") ? base + "/messages"
    : base + "/v1/messages";
  // ── Prompt caching: mark system prompt + last tool as cache breakpoints ──
  const systemBlock = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: 3600 } }]
    : "";
  const cachedTools = toolDefs.length > 0
    ? [...toolDefs.slice(0, -1), { ...toolDefs[toolDefs.length - 1], cache_control: { type: "ephemeral", ttl: 3600 } }]
    : toolDefs;

  /** @type {{ model: string, max_tokens: number, system: any, messages: any[], tools: any[], stream: boolean, thinking?: { type: string, budget_tokens: number } }} */
  const body = {
    model: model || "claude-sonnet-4-20250514",
    max_tokens: 65536,
    system: systemBlock,
    messages,
    tools: cachedTools,
    stream: true,
  };
  if (reasoning) {
    body.thinking = { type: "enabled", budget_tokens: 4096 };
  }
  const res = await fetchWithRetry(
    () => fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2025-03-01",
      },
      body: JSON.stringify(body),
      signal,
    }),
    (res, errText) => `API ${res.status} (${res.statusText})\nURL: ${endpoint}\nModel: ${model || "claude-sonnet-4-20250514"}\n${errText ? "Response: " + errText : ""}`,
    (errText, errorMsg) => {
      // Context size error — throw a special error for the agent loop to
      // compress-and-retry.
      if (errText.includes('exceed_context_size_error') || errText.includes('exceeds the available context size')) {
        const detectedCtx = parseContextWindowFromError(errText);
        if (detectedCtx) {
          setContextWindow(detectedCtx);
          const retryError = new ContextSizeError(errorMsg);
          retryError.detectedContextWindow = detectedCtx;
          return retryError;
        }
      }
      return null;
    },
    "anthropicCall",
  );
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningContent = "";
  /** @type {Record<number, {id: string, name: string, input: string}>} */
  const tcAccum = {};
  let finishReason = null;
  let usage = null;
  // DEBUG_REASONING=1 dumps the first event type so we can see what the
  // API actually streams (e.g. does it emit `thinking_delta` or a custom
  // event for chain-of-thought?).
  const debugReasoning = process.env.DEBUG_REASONING === "1";
  if (debugReasoning) console.log(`[reasoning-debug] anthropicCall model=${model} endpoint=${apiUrl}`);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("event: ")) { /* event type not used */ }
      else if (t.startsWith("data: ")) {
        const d = t.slice(6).trim();
        if (!d) continue;
        try {
          const j = JSON.parse(d);
          if (j.type === "content_block_start" && j.content_block?.type === "text") {
            // text block started
          } else if (j.type === "content_block_start" && j.content_block?.type === "thinking") {
            // thinking block started
          } else if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
            content += j.delta.text;
            sendToRenderer("stream:chunk", { text: j.delta.text, done: false });
          } else if (j.type === "content_block_delta" && j.delta?.type === "thinking_delta") {
            // BUGFIX: anthropicCall used to only forward `stream:reasoning` to
            // the renderer (so live chat could show thinking) but never
            // accumulated it locally. That meant `result.reasoningContent`
            // was always `undefined` for Anthropic-format APIs → the DB
            // `reasoning_content` column stayed NULL → reasoning vanished
            // when reloading historical conversations. Now we accumulate
            // alongside the live event so save path can persist it.
            reasoningContent += j.delta.thinking;
            sendToRenderer("stream:reasoning", { text: j.delta.thinking });
          } else if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
            tcAccum[j.index] = { id: j.content_block.id, name: j.content_block.name, input: "" };
          } else if (j.type === "content_block_delta" && j.delta?.type === "input_json_delta") {
            if (tcAccum[j.index]) tcAccum[j.index].input += j.delta.partial_json;
          } else if (j.type === "message_start") {
            if (j.message?.usage) usage = j.message.usage;
          } else if (j.type === "message_delta") {
            finishReason = j.delta?.stop_reason;
          }
        } catch { /* ignored */ }
      }
    }
  }
  const tcs = Object.values(tcAccum).map(tc => ({
    id: tc.id, type: "function",
    function: { name: tc.name, arguments: tc.input },
  }));
  if (debugReasoning) {
    console.log(`[reasoning-debug] anthropicCall end: reasoningContent.length=${reasoningContent.length} content.length=${content.length}`);
    if (!reasoningContent && content.length > 0) {
      console.log(`[reasoning-debug] anthropicCall ⚠️ reasoningContent empty but content has ${content.length} chars.`);
    }
  }
  return { content, reasoningContent, finishReason, tcs, usage };
}
