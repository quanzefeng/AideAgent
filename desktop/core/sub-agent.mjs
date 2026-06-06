// ── Sub-Agent Launcher ──────────────────────────────────────

import { SUB_AGENT_TOOL_NAMES, SUB_AGENT_MAX_TURNS, _subAgentCtrls, getLastApiConfig, sendToRenderer } from "./state.mjs";
import { getAllToolDefs } from "./format-adapters.mjs";
import { runTool } from "./tool-executor.mjs";

export async function runSubAgent(description, prompt, subAgentId = null) {
  const cfg = getLastApiConfig();
  if (!cfg.apiKey || !cfg.apiUrl) return { text: "(子代理不可用：请先在主对话中发送一条消息激活 API)" };

  const id = subAgentId || `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
  const ctrl = new AbortController();
  _subAgentCtrls.set(id, ctrl);
  const { signal } = ctrl;

  const subTools = getAllToolDefs().filter(t => SUB_AGENT_TOOL_NAMES.has(t.function?.name));

  const sysContent = `你是 AideAgent 的子代理，拥有完整工具集。
可用工具: bash（执行命令）, file_read, file_write, file_edit, grep, glob, web_search, web_fetch, lsp（代码跳转/引用/hover）, git_diff, git_commit, git_branch, gh_pr, gh_issue, gh_repo, skill, invoke_skill, create_skill, write_memory, kb_write, kb_search, kb_get_note, memory_search, TaskCreate, TaskUpdate, TaskList, TodoWrite, AskUserQuestion。
你的任务是: ${prompt}
完成后直接返回文本结果。注意：bash 命令需要用户确认才能执行。`;
  const msgs = [
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
          const rest = { ...m };
          delete rest.reasoning_content;
          return rest;
        }
        return m;
      });

      const body = {
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
      const headers = isAnthropic
        ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      if (isAnthropic) {
        const sys = cleanMsgs.find(m => m.role === "system");
        body.system = sys?.content || "";
        body.messages = cleanMsgs.filter(m => m.role !== "system");
      }

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`API ${res.status}: ${errText}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      const tcAccum = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
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
        }
      }

      const tcs = Object.values(tcAccum).filter(tc => tc.name).map(tc => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.args || "{}" },
      }));

      sendToRenderer("subagent:progress", { id, description, turn: turns, content: content.slice(-200), tcsCount: tcs.length, done: false });

      allText += content || "";
      const asst = { role: "assistant", content: content || null };
      if (tcs.length > 0) asst.tool_calls = tcs;
      msgs.push(asst);

      if (tcs.length === 0) break;

      for (const tc of tcs) {
        const toolName = tc.function?.name;
        if (!SUB_AGENT_TOOL_NAMES.has(toolName)) {
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `Tool "${toolName}" not available to sub-agent` }) });
          continue;
        }
        let result;
        try { result = await runTool(tc); } catch (e) { result = { error: e.message }; }
        const resultStr = JSON.stringify(result).slice(0, 16000);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return { text: allText || "(aborted)", aborted: true };
    return { text: allText || `(子代理错误: ${err.message})` };
  } finally {
    _subAgentCtrls.delete(id);
  }

  sendToRenderer("subagent:progress", { id, description, turn: -1, content: "", tcsCount: 0, done: true });
  return { text: allText || "(no result)" };
}
