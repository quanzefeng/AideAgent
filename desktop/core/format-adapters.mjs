// ── Format Adapters — OpenAI/Anthropic API calls ────────────

import mcpManager from "../mcp-manager.mjs";
import { TOOL_DEFS } from "./tool-definitions.mjs";
import { getPlanMode, PLAN_MODE_READONLY, sendToRenderer } from "./state.mjs";

export function getAllToolDefs(kbEnabled = true, webSearchEnabled = true) {
  const planMode = getPlanMode();
  let builtins = kbEnabled ? TOOL_DEFS : TOOL_DEFS.filter(t => t.function.name !== "kb_write" && t.function.name !== "kb_search");
  if (!webSearchEnabled) builtins = builtins.filter(t => t.function.name !== "web_search" && t.function.name !== "web_fetch");
  if (planMode) builtins = builtins.filter(t => PLAN_MODE_READONLY.has(t.function.name));
  const mcpFilter = webSearchEnabled ? {} : { excludeCategories: ["web-search"] };
  const mcpDefs = mcpManager.listAllToolDefs(mcpFilter);
  console.log("[plan-mode] getAllToolDefs planMode =", planMode, "builtins =", builtins.length, "mcp =", planMode ? 0 : mcpDefs.length);
  return planMode ? builtins : [...builtins, ...mcpDefs];
}

export function toAnthropicTools(kbEnabled = true, webSearchEnabled = true) {
  return getAllToolDefs(kbEnabled, webSearchEnabled).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export function toAnthropicMessages(msgs) {
  const messages = [];
  let system = null;
  for (const m of msgs) {
    if (m.role === "system") { system = m.content; continue; }
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

export async function openaiCall(msgs, apiUrl, apiKey, model, signal, reasoning = true, kbEnabled = true, webSearchEnabled = true) {
  const toolDefs = getAllToolDefs(kbEnabled, webSearchEnabled);
  console.log("[openaiCall] tools sent to LLM:", toolDefs.map(t => t.function.name).join(", "));
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
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningContent = "";
  const tcAccum = {};
  let finishReason = null;
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
  return { content, reasoningContent, finishReason, tcs: Object.values(tcAccum) };
}

export async function anthropicCall(msgs, apiUrl, apiKey, model, signal, reasoning = true, kbEnabled = true, webSearchEnabled = true) {
  const { messages, system } = toAnthropicMessages(msgs);
  const toolDefs = toAnthropicTools(kbEnabled, webSearchEnabled);
  console.log("[anthropicCall] tools sent to LLM:", toolDefs.map(t => t.name).join(", "));
  const base = apiUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/messages") ? base
    : base.endsWith("/v1") ? base + "/messages"
    : base + "/v1/messages";
  const body = {
    model: model || "claude-sonnet-4-20250514",
    max_tokens: 65536,
    system: system || "",
    messages,
    tools: toolDefs,
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
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`API ${res.status} (${res.statusText})\nURL: ${endpoint}\nModel: ${model || "claude-sonnet-4-20250514"}\n${body ? "Response: " + body : ""}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "";
  const tcAccum = {};
  let finishReason = null;
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
  return { content, finishReason, tcs };
}
