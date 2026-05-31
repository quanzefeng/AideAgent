// ── Agent Loop — Main conversation loop + session compression ──

import sessionDb from "../session-db.mjs";
import { buildSystemPrompt } from "./system-prompt.mjs";
import { openaiCall, anthropicCall } from "./format-adapters.mjs";
import { selectRelevantMemories } from "./memory-selection.mjs";
import { runTool } from "./tool-executor.mjs";
import { compressContext, sendContextUsage, estimateTokens, trimToBudget, TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD } from "./token-budget.mjs";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  taskStore, getTodoList,
  sendToRenderer, genId, MAX_OUTPUT, MAX_TURNS,
} from "./state.mjs";

function getHistoryTitle(history) {
  const firstUser = history.find(m => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

async function saveSession(id, history, title) {
  try { await sessionDb.saveSession(id, history, title); } catch { /* ignored */ }
}

export async function agentLoop(prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, isPlanMode = false, webSearchEnabled = true) {
  let abortCtrl = getAbortCtrl();
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  setAbortCtrl(abortCtrl);
  const { signal } = abortCtrl;

  let sessionId = getSessionId();
  if (!sessionId) { sessionId = genId(); setSessionId(sessionId); }
  // Save placeholder session to DB immediately so it appears in sidebar
  const placeholderTitle = (prompt || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
  const placeholderHistory = [{ role: "user", content: prompt || "" }];
  await sessionDb.saveSession(sessionId, placeholderHistory, placeholderTitle);
  sendToRenderer("session:update", { sessionId });

  // ── Build user message with optional file attachments ──
  let userMessage;
  if (files && files.length > 0) {
    const contentParts = [];
    if (prompt) contentParts.push({ type: "text", text: prompt });

    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) {
        contentParts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      } else {
        try {
          const base64Data = f.dataUrl.includes("base64,") ? f.dataUrl.split("base64,")[1] : f.dataUrl;
          const decoded = atob(base64Data);
          const fileDesc = `\n\n--- File: ${f.name} ---\n${decoded}\n--- End of ${f.name} ---\n`;
          contentParts.push({ type: "text", text: fileDesc });
        } catch {
          contentParts.push({ type: "text", text: `\n\n[Attachment: ${f.name} — unable to decode]` });
        }
      }
    }
    userMessage = { role: "user", content: contentParts };
  } else {
    userMessage = { role: "user", content: prompt };
  }

  const sysPrompt = await buildSystemPrompt(enabledSkills, agentName, prompt, kbEnabled, isPlanMode, webSearchEnabled);

  // ── Inject task/todo status into system context ──
  let sysContent = sysPrompt.content;
  const activeTasks = Array.from(taskStore.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
  if (activeTasks.length > 0) {
    sysContent += "\n\n## 当前任务状态\n";
    for (const t of activeTasks) {
      const icon = t.status === "in_progress" ? "🔄" : "⬜";
      sysContent += `- ${icon} **${t.subject}** (${t.status}) — ${t.description}\n`;
    }
  }
  const todoList = getTodoList();
  if (todoList.length > 0) {
    sysContent += "\n## 当前 Todo 清单\n";
    for (const t of todoList) {
      const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
      sysContent += `- ${icon} ${t.content}\n`;
    }
  }

  // ── Inject Agent & AskUserQuestion tool awareness ──
  if (!sysContent.includes("AskUserQuestion")) {
    sysContent += `\n\n**AskUserQuestion:** You can ask the user up to 4 multiple-choice questions when you need clarification. Use this instead of guessing. The user will see a dialog and respond.`;
  }
  if (!sysContent.includes("`Agent`")) {
    sysContent += `\n\n**Agent (Sub-Agent):** You can launch read-only sub-agents (\`Agent\` tool) for parallel independent research. Sub-agents have access to file_read, grep, glob, web_search, web_fetch. Use them to search for information in parallel while you continue other work. A sub-agent returns a single text result. Example: \`Agent(description="search AI news", prompt="Search the web for the latest AI news this week and summarize the top 3 stories.")\``;
  }
  if (!sysContent.includes("Do NOT save")) {
    sysContent += `\n\n**Memory hygiene:** Do NOT save code patterns, architecture, or file paths as memories — those are derivable from the current project state. Only save non-obvious context: user preferences, stakeholder decisions, deadlines, corrections, external system references. If a memory claims a function or file exists, verify with grep/file_read before acting on it.`;
  }

  // ── Inject relevant memories ──
  try {
    const relevantMems = await selectRelevantMemories(prompt, apiKey, apiUrl, model, apiFormat);
    if (relevantMems) {
      sysContent += "\n\n## 相关记忆\n" + relevantMems;
    }
  } catch (e) {
    console.error("[memory] selection error:", e.message);
  }

  // ── L0 token budget check ──
  const estTokens = estimateTokens(sysContent);
  if (estTokens > TOKEN_BUDGET_WARN) {
    sendToRenderer("l0:budget", {
      estimatedTokens: estTokens,
      warnThreshold: TOKEN_BUDGET_WARN,
      hardThreshold: TOKEN_BUDGET_HARD,
      overWarn: estTokens > TOKEN_BUDGET_WARN,
      overHard: estTokens > TOKEN_BUDGET_HARD,
    });
    if (estTokens > TOKEN_BUDGET_HARD) {
      sysContent = trimToBudget(sysContent, TOKEN_BUDGET_HARD);
    }
  }

  const history = getHistory();
  const msgs = [{ role: "system", content: sysContent }, ...history.map(m => ({ ...m })), userMessage];
  let turns = 0;
  let allText = "", allReasoning = "";

  compressContext(msgs);
  sendContextUsage(msgs);

  while (turns < MAX_TURNS) {
    turns++;
    compressContext(msgs);
    sendContextUsage(msgs);

    let content, reasoningContent, tcs;
    try {
      const callFn = apiFormat === "anthropic" ? anthropicCall : openaiCall;
      const result = await callFn(msgs, apiUrl, apiKey, model, signal, reasoning, kbEnabled, webSearchEnabled);
      content = result.content;
      reasoningContent = result.reasoningContent || "";
      allText += result.content;
      if (reasoningContent) allReasoning += reasoningContent;
      tcs = result.tcs;
    } catch (err) {
      if (err.name === "AbortError") return { text: allText, aborted: true };
      throw err;
    }

    const asst = { role: "assistant", content: content || null };
    if (reasoningContent) asst.reasoning_content = reasoningContent;
    if (tcs.length > 0) asst.tool_calls = tcs;
    msgs.push(asst);

    if (tcs.length === 0) break;

    // ── Execute tools (Agent calls in parallel, others sequential) ──
    const agentCalls = tcs.filter(tc => tc.function?.name === "Agent");
    const otherCalls = tcs.filter(tc => tc.function?.name !== "Agent");

    if (agentCalls.length > 0) {
      for (const tc of agentCalls) {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
        sendToRenderer("tool:start", { name: "Agent", args });
      }

      const agentResults = await Promise.allSettled(
        agentCalls.map(tc => runTool(tc))
      );

      for (let i = 0; i < agentCalls.length; i++) {
        const tc = agentCalls[i];
        const settled = agentResults[i];
        const result = settled.status === "fulfilled"
          ? settled.value
          : { error: settled.reason?.message || "Sub-agent failed" };
        let rStr = JSON.stringify(result);
        if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
        sendToRenderer("tool:result", { name: "Agent", result });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
      }
    }

    for (const tc of otherCalls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
      sendToRenderer("tool:start", { name: tc.function.name, args });

      let result;
      try { result = await runTool(tc); } catch (e) { result = { error: e.message }; }

      let rStr = JSON.stringify(result);
      if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
      sendToRenderer("tool:result", { name: tc.function.name, result });
      msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
    }
  }

  // Save conversation
  const historyAsst = { role: "assistant", content: allText || "" };
  if (allReasoning) historyAsst.reasoning_content = allReasoning;
  const historyUser = { role: "user", content: prompt || (files && files.length > 0 ? `[${files.map(f => f.name).join(", ")}]` : "") };
  const hist = getHistory();
  hist.push(historyUser, historyAsst);

  // ── Session Compression (AI-driven) ──
  if (hist.length > 40) {
    const oldHistory = hist.slice(0, hist.length - 20);
    const recent = hist.slice(hist.length - 20);

    let summary = "";
    try {
      const convText = oldHistory.map(m => {
        const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
        const text = (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).replace(/[\r\n\t]+/g, " ").trim();
        return `[${role}]: ${text.slice(0, 500)}`;
      }).join("\n");

      const compactPrompt = `总结以下对话的关键信息。保留: 具体文件名、函数名、错误信息、用户明确提出的需求和偏好、已做出的决策。丢弃: 问候语、重复内容、工具调用的原始输出细节。

对话:
${convText}

用一段简洁的摘要总结（中文）:`;

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
        body.system = "You are a helpful assistant that summarizes conversations concisely.";
        body.model = model || "claude-sonnet-4-20250514";
      }

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        summary = apiFormat === "anthropic"
          ? (data.content?.[0]?.text || "")
          : (data.choices?.[0]?.message?.content || "");
      }
    } catch (e) {
      console.error("[compress] AI compaction failed, using fallback:", e.message);
    }

    if (!summary || summary.trim().length < 20) {
      const summaryLines = ["## 早期对话摘要\n"];
      let lastRole = "";
      for (const m of oldHistory.slice(-30)) {
        const role = m.role === "user" ? "用户" : "助手";
        const text = (typeof m.content === "string" ? m.content : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
        if (!text) continue;
        if (role === lastRole) summaryLines.push(`  ...${text}`);
        else summaryLines.push(`- **${role}：** ${text}`);
        lastRole = role;
      }
      summary = summaryLines.join("\n");
    }

    if (sessionId) {
      try {
        const parentId = sessionId;
        const compressedId = parentId + "_c" + Date.now().toString(36);
        sessionDb.saveSession(
          compressedId,
          [{ role: "system", content: summary }, ...recent],
          getHistoryTitle(recent)
        );
        sessionDb.updateTitle(parentId, getHistoryTitle(recent));
        recent.unshift({ role: "system", content: summary });
      } catch (e) { console.error("[compress]", e.message); }
    }

    setHistory(recent);
  }

  // Auto-save after each turn
  const finalSessionId = getSessionId();
  if (finalSessionId) {
    const title = getHistoryTitle(getHistory());
    saveSession(finalSessionId, getHistory(), title).catch(() => {});
  }

  return { text: allText || "(no text response)" };
}
