// ── Format Adapters — OpenAI/Anthropic API calls ────────────

import mcpManager from "../mcp-manager.mjs";
import { TOOL_DEFS } from "./tool-definitions.mjs";
import { getPlanMode, PLAN_MODE_READONLY, sendToRenderer } from "./state.mjs";

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
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`API ${res.status} (${res.statusText})\nURL: ${apiUrl}\nModel: ${model || "deepseek-chat"}\n${body ? "Response: " + body : ""}`);
  }
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningContent = "";
  /** @type {Record<number, {id: string, type: string, function: {name: string, arguments: string}}>} */
  const tcAccum = {};
  let finishReason = null;
  let usage = null;
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
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) tcAccum[tc.index].id = tc.id;
            if (tc.function?.name) tcAccum[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) tcAccum[tc.index].function.arguments += tc.function.arguments;
          }
        }
      } catch { /* ignored */ }
    }
    buf = buf.split("\n").pop() || "";
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
 * @returns {Promise<{content: string, finishReason: string | null, tcs: Array<{id: string, type: string, function: {name: string, arguments: string}}>, usage: object | null}>}
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
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2025-03-01",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`API ${res.status} (${res.statusText})\nURL: ${endpoint}\nModel: ${model || "claude-sonnet-4-20250514"}\n${body ? "Response: " + body : ""}`);
  }
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const dec = new TextDecoder();
  let buf = "", content = "";
  /** @type {Record<number, {id: string, name: string, input: string}>} */
  const tcAccum = {};
  let finishReason = null;
  let usage = null;
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
  return { content, finishReason, tcs, usage };
}
