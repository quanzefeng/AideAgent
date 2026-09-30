// ── Sub-Agent Launcher ──────────────────────────────────────

interface ApiConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  apiFormat?: string;
}

import { SUB_AGENT_TOOL_NAMES, SUB_AGENT_MAX_TURNS, _subAgentCtrls, getLastApiConfig, sendToRenderer } from "./state.ts";
import { getAllToolDefs } from "./format-adapters.ts";
import { runTool } from "./tool-executor.ts";

// Hard cap on a single sub-agent LLM request so a hung API never blocks the
// parent agent loop indefinitely (parent uses Promise.allSettled on sub-agents).
const SUB_AGENT_LLM_TIMEOUT_MS = 5 * 60 * 1000;

interface SubAgentMessage {
  role: string;
  content: any;
  reasoning_content?: any;
  tool_calls?: Array<{ id: string, type?: string, index?: number, function?: { name: string, arguments: string } }>;
  tool_call_id?: string;
}

export async function runSubAgent(description: string, prompt: string, subAgentId: string | null = null): Promise<{ text: string, aborted?: boolean }> {
  const cfg: ApiConfig = getLastApiConfig() as any;
  if (!cfg.apiKey || !cfg.apiUrl) return { text: "(子代理不可用：请先在主对话中发送一条消息激活 API)" };

  const id = subAgentId || `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
  const ctrl = new AbortController();
  _subAgentCtrls.set(id, ctrl);
  const { signal } = ctrl;

  const allToolDefs = getAllToolDefs();
  const subTools = allToolDefs.filter(t => SUB_AGENT_TOOL_NAMES.has(t.function?.name));

  const sysContent = `你是 AideAgent 的子代理，拥有完整工具集。
可用工具: bash（执行命令）, file_read, file_write, file_edit, grep, glob, web_search, web_fetch, lsp（代码跳转/引用/hover）, git_diff, git_commit, git_branch, gh_pr, gh_issue, gh_repo, skill, invoke_skill, create_skill, write_memory, kb_write, kb_search, kb_get_note, TaskCreate, TaskUpdate, TaskList, TodoWrite, AskUserQuestion。
你的任务是: ${prompt}
完成后直接返回文本结果。注意：bash 命令需要用户确认才能执行。`;
  const msgs: SubAgentMessage[] = [
    { role: "system", content: sysContent },
    { role: "user", content: prompt },
  ];

  console.error("[sub-agent] starting:", id, description);
  let allText = "";

  try {
    for (let turns = 0; turns < SUB_AGENT_MAX_TURNS; turns++) {
      const { apiKey, apiUrl, model, apiFormat } = cfg;
      const isAnthropic = apiFormat === "anthropic";

      const subModel = model || "deepseek-chat";

      const cleanMsgs = isAnthropic ? msgs : msgs.map(m => {
        if (m.role === "assistant" && m.reasoning_content !== undefined) {
          // Drop reasoning_content (DeepSeek-specific, not in Anthropic schema)
        const rest = { ...m };
        delete (rest as any).reasoning_content;
        return rest;
        }
        return m;
      });

      const body: Record<string, any> = {
        model: subModel,
        messages: cleanMsgs,
        tools: isAnthropic
          ? subTools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
          : subTools,
        max_tokens: 65536,
        stream: true,
      };
      const endpoint = isAnthropic
        ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
        : apiUrl;
      const headers: Record<string, string> = isAnthropic
        ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      if (isAnthropic) {
        const sys = cleanMsgs.find(m => m.role === "system");
        body.system = sys?.content || "";
        // BUGFIX: Anthropic API 不识别 role="tool"（tool result）和内联 tool_calls 数组。
        // 必须转换为 content blocks 格式（toAnthropicMessages 的惯例）。
        body.messages = cleanMsgs.filter(m => m.role !== "system").map(m => {
          if (m.role === "tool") {
            // tool result → { role: "user", content: [{type: "tool_result", tool_use_id, content}] }
            return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] };
          }
          if (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0) {
            // assistant 的 tool_calls 数组 → content blocks 中的 tool_use
            const blocks: any[] = [];
            if (m.content) blocks.push({ type: "text", text: m.content });
            for (const tc of m.tool_calls ?? []) {
              let input = {};
              try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
              blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
            }
            return { role: "assistant", content: blocks };
          }
          return m;
        });
      }

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify(body),
        // Combine user abort with a hard LLM timeout so a hung API never
        // blocks the parent agent loop indefinitely.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SUB_AGENT_LLM_TIMEOUT_MS)]) : AbortSignal.timeout(SUB_AGENT_LLM_TIMEOUT_MS),
      });

      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`API ${res.status}: ${errText}`);
      }

      if (!res.body) throw new Error("No response body (sub-agent)");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      const tcAccum: Record<number, { id: string, name: string, args: string }> = {};

      const processLine = (line: string): void => {
        if (!line.startsWith("data: ")) return;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const data = JSON.parse(payload);
          if (isAnthropic) {
            if (data.type === "content_block_delta") {
              if (data.delta?.type === "text_delta") {
                content += data.delta.text;
                sendToRenderer("subagent:chunk", { id, text: data.delta.text });
              } else if (data.delta?.type === "input_json_delta") {
                const idx = data.index ?? 0;
                if (!tcAccum[idx]) tcAccum[idx] = { id: "", name: "", args: "" };
                tcAccum[idx].args += data.delta.partial_json;
              }
            } else if (data.type === "content_block_start") {
              if (data.content_block?.type === "tool_use") {
                const idx = data.index ?? 0;
                tcAccum[idx] = { id: data.content_block.id, name: data.content_block.name, args: "" };
              }
            }
          } else {
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              sendToRenderer("subagent:chunk", { id, text: delta.content });
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!tcAccum[idx]) tcAccum[idx] = { id: tc.id || "", name: "", args: "" };
                if (tc.id) tcAccum[idx].id = tc.id;
                if (tc.function?.name) tcAccum[idx].name = tc.function.name;
                if (tc.function?.arguments) tcAccum[idx].args += tc.function.arguments;
              }
            }
          }
        } catch { /* ignored */ }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      // SSE flush: a final line without a trailing "\n" would otherwise stay
      // in `buf` and never be processed (lost last delta / tool_call).
      buf += dec.decode();
      if (buf.trim()) processLine(buf);

      // BUGFIX: 某些 API（Ollama/proxy/开源模型）在流式 tool_calls 中不发送 id 字段，
      // 导致 tc.id 为空字符串 → API 400 "tool id() not found"。兜底生成 fallback ID。
      const _genToolId = () => `sub_tc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const tcs = Object.values(tcAccum).filter(tc => tc.name).map(tc => ({
        id: tc.id || _genToolId(), type: "function",
        function: { name: tc.name, arguments: tc.args || "{}" },
      }));

      sendToRenderer("subagent:progress", { id, description, turn: turns, content: content.slice(-200), tcsCount: tcs.length, done: false });

      allText += content || "";
      const asst: SubAgentMessage = { role: "assistant", content: content || null };
      if (tcs.length > 0) asst.tool_calls = tcs;
      msgs.push(asst);

      if (tcs.length === 0) break;

      for (const tc of tcs) {
        const toolName = tc.function?.name;
        if (!SUB_AGENT_TOOL_NAMES.has(toolName)) {
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `Tool "${toolName}" not available to sub-agent` }) });
          continue;
        }
        let result: any;
        try { result = await runTool(tc as any); } catch (e) { result = { error: (e as any).message }; }
        const resultStr = JSON.stringify(result).slice(0, 16000);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    }
  } catch (err) {
    const e = err as any;
    if (e.name === "AbortError") return { text: allText || "(aborted)", aborted: true };
    return { text: allText || `(子代理错误: ${e.message})` };
  } finally {
    _subAgentCtrls.delete(id);
  }

  sendToRenderer("subagent:progress", { id, description, turn: -1, content: "", tcsCount: 0, done: true });
  return { text: allText || "(no result)" };
}
