// ── Format Adapters — OpenAI/Anthropic API calls ────────────

import mcpManager from "../mcp-manager.ts";
import { TOOL_DEFS } from "./tool-definitions.ts";
import { getPlanMode, PLAN_MODE_READONLY, sendToRenderer, parseContextWindowFromError, setContextWindow, CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, MAX_API_RETRIES, RETRY_BACKOFF_MS, RETRY_MAX_SINGLE_WAIT } from "./state.ts";
import { estimateMessageTokens } from "./token-budget.ts";
import { trimToolDefs, defsChars, MCP_TRIM_OPTIONS } from "./tool-schema-trim.ts";

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
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

export function getRetryDelay(res: Response | null, attempt: number): number {
  const retryAfter = res?.headers?.get?.("retry-after");
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, RETRY_MAX_SINGLE_WAIT);
  }
  return RETRY_BACKOFF_MS[Math.min(attempt, MAX_API_RETRIES - 1)];
}

function notifyRetry(source: string, info: { attempt: number, maxAttempts: number, delayMs: number, status: number, statusText: string }) {
  console.warn(`[${source}] API ${info.status} (${info.statusText}) — retry ${info.attempt}/${info.maxAttempts} in ${Math.round(info.delayMs / 1000)}s`);
  sendToRenderer("stream:retrying", info);
}

// ── Context-overflow detection ─────────────────────────────
// Every gateway words this differently; all of them mean "prompt + max_tokens
// no longer fits the window", so all must route to the compress-and-retry path
// instead of surfacing a raw 400 to the user.
export function isContextOverflowText(errText: string): boolean {
  return errText.includes("exceed_context_size_error")
    || errText.includes("exceeds the available context size")
    || errText.includes("exceeds the context")
    || /prompt .*exceeds.*context/i.test(errText);
}

// ── Dynamic max_tokens ─────────────────────────────────────
// A fixed 65536 collides with the window as soon as the prompt grows past
// (window - 65536): 65816 + 65536 > 131072 → 400. Size the reply allowance
// from what is actually left in the window instead.
const MAX_TOKENS_CAP = 65536;
const MAX_TOKENS_FLOOR = 4096;
// estimateMessageTokens(msgs, false) omits request-template overhead; tool
// schemas are added explicitly below from `toolDefs` (the global schema
// cache is intentionally excluded here to avoid double counting).
// so scale the prompt estimate up and add a fixed allowance for the request
// template before taking the window remainder.
const PROMPT_SAFETY_FACTOR = 1.25;
const PROMPT_OVERHEAD_TOKENS = 1024;

/**
 * Compute a max_tokens that fits prompt + reply inside the model's context.
 * @param {any[]} msgs - the messages about to be sent
 * @param {unknown} [toolDefs] - tool schemas (also consume prompt tokens)
 * @returns {number} clamped to [MAX_TOKENS_FLOOR, MAX_TOKENS_CAP]
 */
export function computeMaxTokens(msgs: any[], toolDefs?: unknown): number {
  const window = CONTEXT_WINDOW || DEFAULT_CONTEXT_WINDOW;
  // includeToolSchema=false: we add toolsTokens ourselves below, and the
  // global schema cache may already be populated for this same request.
  const promptTokens = estimateMessageTokens(msgs, false).totalTokens;
  const toolsTokens = toolDefs ? Math.ceil(JSON.stringify(toolDefs).length / 4) : 0;
  const promptCost = Math.ceil(promptTokens * PROMPT_SAFETY_FACTOR) + toolsTokens + PROMPT_OVERHEAD_TOKENS;
  const available = window - promptCost;
  return Math.max(MAX_TOKENS_FLOOR, Math.min(MAX_TOKENS_CAP, available));
}

export async function fetchWithRetry(doFetch: () => Promise<Response>, buildErrorMsg: (res: Response, errText: string) => string, classify?: (errText: string, errorMsg: string) => Error | null, source = "api"): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch();
    } catch (err: any) {
      // AbortError (user cancel) and TimeoutError (LLM_CALL_TIMEOUT) must
      // never be retried — the caller handles cancel, and a hung upstream is
      // not a transient blip worth 5 more attempts.
      const errName = err.name;
      if (errName === "AbortError" || errName === "TimeoutError") throw err;
      // Network-level failure (fetch TypeError: DNS, refused, reset) — retryable.
      if (attempt >= MAX_API_RETRIES) {
        const msg = `已自动重试 ${MAX_API_RETRIES} 次仍失败\n\n${err.message}`;
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

    const errText = (await res.text().catch(() => "")).slice(0, 1000);
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

/**
 * Mid-body-read connection drops. undici surfaces a server/gateway closing
 * the socket during an SSE stream as `TypeError: terminated`; ECONNRESET /
 * socket hang up are the raw-socket variants. Deliberately distinct from
 * client-side timeout (TimeoutError) and user Stop (AbortError), which must
 * NOT be retried here.
 */
export function isStreamDropError(e: any): boolean {
  const msg = String(e?.message || "");
  const code = String(e?.cause?.code || e?.code || "");
  return msg.includes("terminated")
    || code === "ECONNRESET"
    || code === "UND_ERR_SOCKET"
    || msg.includes("other side closed")
    || msg.includes("socket hang up");
}

// ── Tool definition cache (stable per session — MCP config doesn't change mid-conversation) ──
let _cachedToolDefs: Array<{ type: string, function: { name: string, description: string, parameters: object } }> | null = null;
let _cachedToolKey: string | null = null;

export function getAllToolDefs(kbEnabled = true, webSearchEnabled = true): Array<{ type: string, function: { name: string, description: string, parameters: object } }> {
  const planMode = getPlanMode();
  // Include the MCP server signature so adding/removing/restarting/toggling
  // a server busts the cache even when kb/web/plan flags are unchanged.
  const key = `${kbEnabled}|${webSearchEnabled}|${planMode}|${mcpManager.serverSignature()}`;
  if (_cachedToolKey === key && _cachedToolDefs) {
    return _cachedToolDefs;
  }
  let builtins = kbEnabled ? TOOL_DEFS : TOOL_DEFS.filter(t => t.function.name !== "kb_write" && t.function.name !== "kb_search");
  if (!webSearchEnabled) builtins = builtins.filter(t => t.function.name !== "web_search" && t.function.name !== "web_fetch");
  if (planMode) builtins = builtins.filter(t => PLAN_MODE_READONLY.has(t.function.name));
  const mcpFilter = webSearchEnabled ? {} : { excludeCategories: ["web-search"] };
  const mcpDefs = mcpManager.listAllToolDefs(mcpFilter);
  console.log("[plan-mode] getAllToolDefs planMode =", planMode, "builtins =", builtins.length, "mcp =", planMode ? 0 : mcpDefs.length);
  // Phase 4: MCP defs arrive raw from the servers (annotation keys, verbose
  // property prose) — strip/cap them. Built-ins pass through byte-identical
  // (their descriptions are hand-tuned for tool choice; see tool-definitions.ts).
  const mcpRawChars = mcpDefs.length ? defsChars(mcpDefs) : 0;
  const mcpTrimmed = mcpDefs.length ? trimToolDefs(mcpDefs, MCP_TRIM_OPTIONS) : mcpDefs;
  if (mcpRawChars) {
    const saved = mcpRawChars - defsChars(mcpTrimmed);
    if (saved > 0) console.log(`[mcp-schema] trimmed ${mcpTrimmed.length} defs: ${mcpRawChars} → ${defsChars(mcpTrimmed)} chars (-${saved} ≈ -${Math.round(saved * 0.25)} tok)`);
  }
  // Deduplicate by tool name — duplicate MCP servers (builtin + imported) can collide
  const merged = planMode ? builtins : [...builtins, ...mcpTrimmed];
  const seen = new Set<string>();
  const result: Array<{ type: string, function: { name: string, description: string, parameters: object } }> = [];
  for (const def of merged) {
    const name = def.function.name;
    if (!seen.has(name)) { seen.add(name); result.push(def); }
  }
  _cachedToolDefs = result;
  _cachedToolKey = key;
  return result;
}

export function invalidateToolDefsCache(): void {
  _cachedToolDefs = null;
  _cachedToolKey = null;
}

export function toAnthropicTools(kbEnabled = true, webSearchEnabled = true): Array<{ name: string, description: string, input_schema: object }> {
  return getAllToolDefs(kbEnabled, webSearchEnabled).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

interface ToolDef {
  type: string;
  function: { name: string, description: string, parameters: object };
}

interface ApiMessage {
  role: string;
  content?: any;
  tool_calls?: Array<{ id: string, function: { name: string, arguments: string } }>;
  tool_call_id?: string;
}

/**
 * Make a message list valid for tool-calling APIs.
 *
 * Saved history uses a flat Format A: `[user, tool, tool, assistant]` where
 * the tool rows carry their metadata in `tool_calls` (that's what the DB
 * column stores) but no `tool_call_id`, and no assistant message precedes
 * them declaring the calls. Both OpenAI-compatible and Anthropic APIs reject
 * that ("tool message must follow assistant tool_calls" / missing
 * tool_use_id). The live in-memory loop already pairs correctly, so this
 * only repairs broken sequences:
 *
 * - every `role:"tool"` row gets a `tool_call_id` (derived from
 *   `tool_calls[0].id` for rows loaded from the DB),
 * - a contiguous run of tool rows not covered by the preceding assistant's
 *   `tool_calls` gets a synthesized `{role:"assistant", tool_calls}` in front,
 * - assistant `tool_calls` left unanswered (interrupted turn) get empty
 *   tool responses before any non-tool message follows,
 * - `tool_calls` metadata is stripped from the tool rows themselves (it
 *   belongs on the assistant; renderer reads it separately from history).
 */
export function normalizeToolPairing(msgs: any[]): any[] {
  if (!Array.isArray(msgs) || msgs.length === 0) return msgs;
  const out: any[] = [];
  // ids declared by the last assistant that have not yet been answered
  let pending = new Set<string>();
  let synthCounter = 0;
  let i = 0;

  const flushPending = (): void => {
    for (const id of pending) out.push({ role: "tool", tool_call_id: id, content: "" });
    pending = new Set();
  };

  while (i < msgs.length) {
    const m = msgs[i];
    if (!m) { i++; continue; }

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      flushPending(); // previous assistant's unanswered calls (defensive)
      out.push(m);
      pending = new Set(m.tool_calls.map((tc: any) => String(tc?.id ?? "")).filter(Boolean));
      i++;
      continue;
    }

    if (m.role === "tool") {
      const run: any[] = [];
      while (i < msgs.length && msgs[i]?.role === "tool") run.push(msgs[i++]);
      const ids = run.map(t => String(t.tool_call_id ?? t.tool_calls?.[0]?.id ?? `call_hist_${++synthCounter}`));

      const orphans = run.filter((_, k) => !pending.has(ids[k]));
      const orphanIds = ids.filter(id => !pending.has(id));

      // Rows answering the preceding assistant — emit as-is.
      for (const t of run) {
        const id = String(t.tool_call_id ?? t.tool_calls?.[0]?.id ?? "");
        if (pending.has(id)) {
          pending.delete(id);
          out.push({ role: "tool", tool_call_id: id, content: t.content ?? "" });
        }
      }
      // Rows with no declaring assistant — synthesize one for the whole group.
      if (orphans.length > 0) {
        flushPending(); // keep pairing strict before introducing a new assistant
        out.push({
          role: "assistant",
          content: "",
          tool_calls: orphans.map((t, k) => {
            const src = Array.isArray(t.tool_calls) && t.tool_calls[0] ? t.tool_calls[0] : null;
            return {
              id: orphanIds[k],
              type: "function",
              function: {
                name: src?.function?.name || src?.name || "unknown",
                arguments: src?.function?.arguments || src?.arguments || "{}",
              },
            };
          }),
        });
        orphans.forEach((t, k) => out.push({ role: "tool", tool_call_id: orphanIds[k], content: t.content ?? "" }));
      }
      continue;
    }

    // Any other message (user/system) requires all declared calls answered.
    if (pending.size > 0) flushPending();
    out.push(m);
    i++;
  }
  flushPending();
  return out;
}

export function toAnthropicMessages(msgs: ApiMessage[]): { messages: Array<{ role: string, content: any }>, system: string | null } {
  const messages: Array<{ role: string, content: any }> = [];
  let system: string | null = null;
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
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input: any = {};
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
export async function openaiCall(msgs: any[], apiUrl: string, apiKey: string, model: string, signal: AbortSignal, reasoning = true, kbEnabled = true, webSearchEnabled = true, silent = false): Promise<{ content: string, reasoningContent: string, finishReason: string | null, tcs: Array<{ id: string, type: string, function: { name: string, arguments: string } }>, usage: object | null }> {
  msgs = normalizeToolPairing(msgs);
  const toolDefs = getAllToolDefs(kbEnabled, webSearchEnabled);
  console.log("[openaiCall] tools sent to LLM:", toolDefs.map(t => t.function.name).join(", "));
  const body: Record<string, any> = { model: model || "deepseek-chat", messages: msgs, tools: toolDefs, stream: true, max_tokens: computeMaxTokens(msgs, toolDefs) };
  if (reasoning) body.reasoning_effort = "high";
  const buildRes = () => fetchWithRetry(
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
      if (isContextOverflowText(errText)) {
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
  let buf = "", content = "", reasoningContent = "";
  const tcAccum: Record<number, { id: string, type: string, function: { name: string, arguments: string } }> = {};
  let finishReason = null;
  let usage = null;
  // DEBUG_REASONING=1 dumps the first non-empty delta keys so we can see
  // what fields the API actually returns (e.g. for MiniMax M3, which uses
  // a different field name than DeepSeek's `delta.reasoning_content`).
  // Set the env var, restart the app, run a conversation, then check the
  // Electron main-process console for the [reasoning-debug] lines.
  const debugReasoning = process.env.DEBUG_REASONING === "1";
  if (debugReasoning) console.log(`[reasoning-debug] openaiCall model=${model} url=${apiUrl}`);
  const processLine = (line: string): void => {
    const t = line.trim();
    if (!t || !t.startsWith("data:")) return;
    const d = t.slice(5).trim();
    if (d === "[DONE]") return;
    try {
      const j = JSON.parse(d);
      const delta = j.choices?.[0]?.delta || {};
      finishReason = j.choices?.[0]?.finish_reason;
      if (j.usage) usage = j.usage; // last chunk carries cache metrics
      if (delta.content) { content += delta.content; if (!silent) sendToRenderer("stream:chunk", { text: delta.content, done: false }); }
      if (delta.reasoning_content) { reasoningContent += delta.reasoning_content; if (!silent) sendToRenderer("stream:reasoning", { text: delta.reasoning_content }); }
      if (debugReasoning) {
        // Log every field the delta exposes (once per unique shape) so we
        // can spot the field name MiniMax M3 / similar providers actually
        // use for chain-of-thought.
        const k = Object.keys(delta).sort().join(",");
        const g = globalThis as any;
        const seenSet = g.__reasoningDebugSeen || (g.__reasoningDebugSeen = new Set<string>());
        if (!seenSet.has(k)) {
          seenSet.add(k);
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
  };
  const readBody = async (res: Response): Promise<void> => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n").slice(0, -1)) processLine(line);
      buf = buf.split("\n").pop() || "";
    }
    // SSE flush: a final line without a trailing "\n" would otherwise stay in
    // `buf` and never be processed — losing the last content delta / the
    // finish_reason / tool_calls of providers that don't terminate the stream.
    buf += dec.decode();
    if (buf.trim()) processLine(buf);
  };
  let res = await buildRes();
  for (let attempt = 0; ; attempt++) {
    try {
      buf = "";
      await readBody(res);
      break;
    } catch (e: any) {
      // finish_reason already received — everything that matters arrived.
      if (finishReason) break;
      if (attempt >= 1 || !isStreamDropError(e)) throw e;
      // SSE has no resume: regenerate the whole response. Tell the renderer
      // exactly how many chars of this attempt's content/reasoning already
      // streamed so it can drop them before the retry replays (no duplicates).
      console.warn(`[openaiCall] stream dropped mid-read (${e.message}); retrying once (attempt ${attempt + 1}/1)`);
      if (!silent) sendToRenderer("stream:reset", { contentChars: content.length, reasoningChars: reasoningContent.length });
      content = ""; reasoningContent = ""; finishReason = null; usage = null;
      for (const k of Object.keys(tcAccum)) delete tcAccum[Number(k)];
      res = await buildRes();
    }
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
export async function anthropicCall(msgs: any[], apiUrl: string, apiKey: string, model: string, signal: AbortSignal, reasoning = true, kbEnabled = true, webSearchEnabled = true, silent = false): Promise<{ content: string, reasoningContent: string, finishReason: string | null, tcs: Array<{ id: string, type: string, function: { name: string, arguments: string } }>, usage: object | null }> {
  const { messages, system } = toAnthropicMessages(normalizeToolPairing(msgs));
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

  const body: Record<string, any> = {
    model: model || "claude-sonnet-4-20250514",
    max_tokens: computeMaxTokens(msgs, cachedTools),
    system: systemBlock,
    messages,
    tools: cachedTools,
    stream: true,
  };
  if (reasoning) {
    body.thinking = { type: "enabled", budget_tokens: 4096 };
  }
  const buildRes = () => fetchWithRetry(
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
      if (isContextOverflowText(errText)) {
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
  let buf = "", content = "", reasoningContent = "";
  const tcAccum: Record<number, { id: string, name: string, input: string }> = {};
  let finishReason = null;
  let usage = null;
  // DEBUG_REASONING=1 dumps the first event type so we can see what the
  // API actually streams (e.g. does it emit `thinking_delta` or a custom
  // event for chain-of-thought?).
  const debugReasoning = process.env.DEBUG_REASONING === "1";
  if (debugReasoning) console.log(`[reasoning-debug] anthropicCall model=${model} endpoint=${apiUrl}`);
  const processLine = (line: string): void => {
    const t = line.trim();
    if (t.startsWith("event: ")) { /* event type not used */ }
    else if (t.startsWith("data: ")) {
      const d = t.slice(6).trim();
      if (!d) return;
      try {
        const j = JSON.parse(d);
        if (j.type === "content_block_start" && j.content_block?.type === "text") {
          // text block started
        } else if (j.type === "content_block_start" && j.content_block?.type === "thinking") {
          // thinking block started
        } else if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
          content += j.delta.text;
          if (!silent) sendToRenderer("stream:chunk", { text: j.delta.text, done: false });
        } else if (j.type === "content_block_delta" && j.delta?.type === "thinking_delta") {
          // BUGFIX: anthropicCall used to only forward `stream:reasoning` to
          // the renderer (so live chat could show thinking) but never
          // accumulated it locally. That meant `result.reasoningContent`
          // was always `undefined` for Anthropic-format APIs → the DB
          // `reasoning_content` column stayed NULL → reasoning vanished
          // when reloading historical conversations. Now we accumulate
          // alongside the live event so save path can persist it.
          reasoningContent += j.delta.thinking;
          if (!silent) sendToRenderer("stream:reasoning", { text: j.delta.thinking });
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
  };
  const readBody = async (res: Response): Promise<void> => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    // SSE flush: a final line without a trailing "\n" would otherwise stay in
    // `buf` and never be processed — losing the last delta / stop_reason.
    buf += dec.decode();
    if (buf.trim()) processLine(buf);
  };
  let res = await buildRes();
  for (let attempt = 0; ; attempt++) {
    try {
      buf = "";
      await readBody(res);
      break;
    } catch (e: any) {
      // stop_reason already received — everything that matters arrived.
      if (finishReason) break;
      if (attempt >= 1 || !isStreamDropError(e)) throw e;
      console.warn(`[anthropicCall] stream dropped mid-read (${e.message}); retrying once (attempt ${attempt + 1}/1)`);
      if (!silent) sendToRenderer("stream:reset", { contentChars: content.length, reasoningChars: reasoningContent.length });
      content = ""; reasoningContent = ""; finishReason = null; usage = null;
      for (const k of Object.keys(tcAccum)) delete tcAccum[Number(k)];
      res = await buildRes();
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
