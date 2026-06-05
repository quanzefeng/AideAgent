// ── Agent Loop — Main conversation loop + session compression ──

import sessionDb from "../session-db.mjs";
import { buildSystemPrompt } from "./system-prompt.mjs";
import { openaiCall, anthropicCall } from "./format-adapters.mjs";
import { selectRelevantMemories } from "./memory-selection.mjs";
import { runTool } from "./tool-executor.mjs";
import { compressContext, sendContextUsage, estimateTokens, estimateMessageTokens, trimToBudget, TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD, summarizeForContinuation } from "./token-budget.mjs";
import * as hookManager from "./hook-manager.mjs";
import * as memory from "../memory-store.mjs";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  getWorkspace,
  taskStore, getTodoList,
  sendToRenderer, genId, MAX_OUTPUT, MAX_TURNS, MAX_CONTINUATIONS,
  CONTEXT_WINDOW, CONTEXT_COMPRESS_PCT,
} from "./state.mjs";

// ── Prompt caching: freeze system prompt & contextBlock base after first turn ──
let _sysPromptCache = null;
let _contextBlockBaseCache = null;

function getHistoryTitle(history) {
  const firstUser = history.find(m => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

async function saveSession(id, history, title) {
  try { await sessionDb.saveSession(id, history, title); } catch { /* ignored */ }
}

// ── Auto-review: extract learnings after each session ──
async function autoReview(msgs, apiKey, apiUrl, model, apiFormat) {
  try {
    // Take last 8 exchanges (16 messages) for review
    const recent = msgs.slice(-16).filter(m => m.role === "user" || m.role === "assistant");
    if (recent.length < 4) return;

    const convText = recent.map(m => {
      const role = m.role === "user" ? "用户" : "助手";
      const text = (typeof m.content === "string" ? m.content : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 800);
      return `[${role}] ${text}`;
    }).join("\n");

    const reviewPrompt = `分析以下对话片段，提取值得长期记忆的信息。只提取以下三类：

1. **用户偏好**：用户明确表达的习惯、偏好、风格要求
2. **决策**：本次对话中做出的重要技术决策或业务决策
3. **新知识**：新学到的、对未来有帮助的信息

如果没有值得保存的内容，回复 "NONE"。

对话：
${convText}

输出格式（中文）：
PREFERENCE: <内容>
DECISION: <内容>
KNOWLEDGE: <内容>
如果没有，回复 NONE。`;

    const body = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: reviewPrompt }],
      max_tokens: 1024,
      temperature: 0.3,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
    const headers = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "你是一个对话分析助手。从对话中提取值得长期记忆的信息。";
      body.model = model || "claude-sonnet-4-20250514";
      delete body.temperature;
    }

    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const text = apiFormat === "anthropic"
      ? (data.content?.[0]?.text || "")
      : (data.choices?.[0]?.message?.content || "");

    if (!text || text.trim().toUpperCase().startsWith("NONE")) return;

    // Parse and save extracted items
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("PREFERENCE:")) {
        const val = trimmed.slice("PREFERENCE:".length).trim();
        if (val && !/^NONE$/i.test(val)) memory.appendUserMemory(val);
      } else if (trimmed.startsWith("DECISION:")) {
        const val = trimmed.slice("DECISION:".length).trim();
        if (val && !/^NONE$/i.test(val)) memory.appendProjectMemory(val);
      } else if (trimmed.startsWith("KNOWLEDGE:")) {
        const val = trimmed.slice("KNOWLEDGE:".length).trim();
        if (val && !/^NONE$/i.test(val)) memory.appendProjectMemory(val);
      }
    }
    console.log("[auto-review] Saved learnings:", lines.length, "items");
  } catch (e) {
    console.error("[auto-review] Failed:", e.message);
  }
}

export async function agentLoop(prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, isPlanMode = false, webSearchEnabled = true) {
  let abortCtrl = getAbortCtrl();
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  setAbortCtrl(abortCtrl);
  const { signal } = abortCtrl;

  let sessionId = getSessionId();
  if (!sessionId) { sessionId = genId(); setSessionId(sessionId); }

  hookManager.initHookManager(getWorkspace());

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

  // First turn OR process restarted (caches are null) — rebuild everything
  const isFirstTurn = getHistory().length === 0 || !_sysPromptCache;

  let sysContent, contextBlockBase;

  if (isFirstTurn) {
    // ── First turn: build full system prompt, cache everything ──
    const sysPrompt = await buildSystemPrompt(enabledSkills, agentName, prompt, kbEnabled, isPlanMode, webSearchEnabled, true);
    sysContent = sysPrompt.content;
    contextBlockBase = sysPrompt.contextBlock || "";

    // ── Stable system content (no dynamic injections — cacheable) ──
    // ── Inject Agent & AskUserQuestion tool awareness (stable per session) ──
    if (!sysContent.includes("AskUserQuestion")) {
      sysContent += `\n\n**AskUserQuestion:** You can ask the user up to 4 multiple-choice questions when you need clarification. Use this instead of guessing. The user will see a dialog and respond.`;
    }
    if (!sysContent.includes("`Agent`")) {
      sysContent += `\n\n**Agent (Sub-Agent):** You can launch read-only sub-agents (\`Agent\` tool) for parallel independent research. Sub-agents have access to file_read, grep, glob, web_search, web_fetch. Use them to search for information in parallel while you continue other work. A sub-agent returns a single text result. Example: \`Agent(description="search AI news", prompt="Search the web for the latest AI news this week and summarize the top 3 stories.")\``;
    }
    if (!sysContent.includes("Do NOT save")) {
      sysContent += `\n\n**Memory hygiene:** Do NOT save code patterns, architecture, or file paths as memories — those are derivable from the current project state. Only save non-obvious context: user preferences, stakeholder decisions, deadlines, corrections, external system references. If a memory claims a function or file exists, verify with grep/file_read before acting on it.`;
    }

    // ── L0 token budget check (system content only) ──
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

    _sysPromptCache = sysContent;
    _contextBlockBaseCache = contextBlockBase;
  } else {
    // ── Turn 2+: use cached system prompt (already has KB/AGENTS.md from turn 1) ──
    sysContent = _sysPromptCache;
    contextBlockBase = _contextBlockBaseCache;
  }

  // ── Build dynamic context block on top of cached base ──
  const contextExtraMsgs = [];
  // `contextBlock` keeps the combined string for continuation snapshot
  let contextBlock = contextBlockBase;

  const activeTasks = Array.from(taskStore.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
  if (activeTasks.length > 0) {
    let taskBlock = "\n## 当前任务状态\n";
    for (const t of activeTasks) {
      const icon = t.status === "in_progress" ? "🔄" : "⬜";
      taskBlock += `- ${icon} **${t.subject}** (${t.status}) — ${t.description}\n`;
    }
    contextBlock += taskBlock;
    contextExtraMsgs.push({ role: "user", content: taskBlock.trim() });
  }
  const todoList = getTodoList();
  if (todoList.length > 0) {
    let todoBlock = "\n## 当前 Todo 清单\n";
    for (const t of todoList) {
      const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
      todoBlock += `- ${icon} ${t.content}\n`;
    }
    contextBlock += todoBlock;
    contextExtraMsgs.push({ role: "user", content: todoBlock.trim() });
  }

  const history = getHistory();

  // ── Inject relevant memories (per turn — topic drift) ──
  // Pass last assistant reply as task context so the selector can
  // distinguish "already working on this" from "potentially relevant old task"
  try {
    const lastAsstMsg = [...history].reverse().find(m => m.role === "assistant");
    const memQuery = lastAsstMsg?.content
      ? `当前任务上下文: ${lastAsstMsg.content.slice(-500)}\n用户消息: ${prompt || ""}`
      : prompt;
    const relevantMems = await selectRelevantMemories(memQuery, apiKey, apiUrl, model, apiFormat);
    if (relevantMems) {
      const memBlock = "\n\n## 相关记忆\n" + relevantMems;
      contextBlock += memBlock;
      contextExtraMsgs.push({ role: "user", content: memBlock.trim() });
    }
  } catch (e) {
    console.error("[memory] selection error:", e.message);
  }

  // ── Current task anchor: when user sends a short reply,
  // remind the agent what it just proposed to prevent memory interference ──
  const isShortReply = typeof prompt === "string" && prompt.trim().length < 80;
  if (history.length > 0 && isShortReply) {
    const lastAsst = [...history].reverse().find(m => m.role === "assistant");
    if (lastAsst && lastAsst.content) {
      const proposalText = lastAsst.content.slice(-800);
      const anchor = `\n\n---\n⚠️ **当前任务锚定** — 用户刚才的简短回复是在回应你**上一次的以下内容**。请优先处理这个任务，不要被历史记忆或知识库中的旧任务干扰：\n\n> ${proposalText.replace(/\n/g, "\n> ")}\n\n请立即执行你刚才提议的方案。如果用户的简短回复含义不明确，回看以上内容来理解用户意图，而不是去历史记忆中寻找任务。`;
      if (typeof userMessage.content === "string") {
        userMessage.content = anchor + "\n\n---\n**用户消息：** " + userMessage.content;
      } else if (Array.isArray(userMessage.content)) {
        userMessage.content = [{ type: "text", text: anchor }, ...userMessage.content];
      }
    }
  }

  // [sys][ctx_base][history...][extra...][query]
  // → [sys][ctx_base][history] is the cacheable prefix;
  // ctxExtra (tasks/todos/memories) goes AFTER history so it doesn't break the prefix
  let msgs = [{ role: "system", content: sysContent }];
  if (contextBlockBase.trim()) {
    msgs.push({ role: "user", content: contextBlockBase.trim() });
  }
  msgs.push(...history.map(m => ({ ...m })));
  msgs.push(...contextExtraMsgs);
  msgs.push(userMessage);
  let allText = "", allReasoning = "";
  let continuation = 0;
  let agentFinished = false;
  let _contextMsg = contextBlock.trim() ? { role: "user", content: contextBlock.trim() } : null;

  compressContext(msgs);
  sendContextUsage(msgs);

  // ── Continuation loop: auto-compress and continue on context overflow ──
  while (continuation < MAX_CONTINUATIONS && !agentFinished) {
    continuation++;
    let turns = 0;

    if (continuation > 1) {
      const banner = `\n\n--- 第 ${continuation} 次自动继续 ---\n`;
      allText += banner;
      sendToRenderer("stream:chunk", { content: banner });
    }

    while (turns < MAX_TURNS) {
      turns++;
      compressContext(msgs);

      // Check context overflow — break to continuation
      const usage = estimateMessageTokens(msgs);
      const contextPct = usage.totalTokens / CONTEXT_WINDOW;
      if (contextPct > CONTEXT_COMPRESS_PCT) {
        console.log(`[agent-loop] Context at ${Math.round(contextPct * 100)}%, triggering continuation`);
        break;
      }

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
        // ── Log cache metrics & forward to UI ──
        if (result.usage) {
          const u = result.usage;
          if (u.prompt_cache_hit_tokens !== undefined) {
            const total = u.prompt_tokens || 0;
            const miss = u.prompt_cache_miss_tokens ?? 0;
            const pct = total > 0 ? Math.round(u.prompt_cache_hit_tokens / total * 100) : 0;
            console.log(`[cache] hit=${u.prompt_cache_hit_tokens} miss=${miss} total=${total} rate=${pct}%`);
            sendToRenderer("stream:metrics", {
              hit: u.prompt_cache_hit_tokens, miss, total, rate: pct,
            });
          } else if (u.cache_read_input_tokens !== undefined) {
            const read = u.cache_read_input_tokens || 0;
            const created = u.cache_creation_input_tokens || 0;
            const total = u.input_tokens || 0;
            const miss = total - read;
            const pct = total > 0 ? Math.round(read / total * 100) : 0;
            console.log(`[cache] read=${read} created=${created} total=${total} rate=${pct}%`);
            sendToRenderer("stream:metrics", {
              hit: read, miss, total, rate: pct,
            });
          }
        }
      } catch (err) {
        if (err.name === "AbortError") {
          hookManager.fire("SessionEnd", { sessionId: getSessionId(), aborted: true }).catch(() => {});
          return { text: allText, aborted: true };
        }
        throw err;
      }

      const asst = { role: "assistant", content: content || null };
      if (reasoningContent) asst.reasoning_content = reasoningContent;
      if (tcs.length > 0) asst.tool_calls = tcs;
      msgs.push(asst);

      if (tcs.length === 0) { agentFinished = true; break; }

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
          hookManager.fire("PostToolUse", { tool: "Agent", result }).catch(() => {});
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
        hookManager.fire("PostToolUse", { tool: tc.function.name, result }).catch(() => {});
      }
    }

    if (agentFinished) break;

    // ── Continuation: summarize and compress ──
    if (continuation < MAX_CONTINUATIONS) {
      sendToRenderer("context:continuation-start", { continuation, max: MAX_CONTINUATIONS });

      const summary = await summarizeForContinuation(msgs, apiKey, apiUrl, model, apiFormat);

      const sysMsg = msgs[0];
      const recentMsgs = msgs.slice(-6);
      // contextBlock at end → [sys][summary][recent...][ctx] = cacheable prefix for continuation
      const continuationMsg = { role: "user", content: `## 📋 对话摘要\n\n${summary}\n\n请继续完成未完成的工作，避免重复已完成的内容。` };
      msgs = [sysMsg, continuationMsg, ...recentMsgs];
      if (_contextMsg) msgs.push(_contextMsg);

      sendToRenderer("context:continuation-done", {
        continuation,
        max: MAX_CONTINUATIONS,
        summaryTokens: estimateTokens(summary),
        contextAfterTokens: estimateMessageTokens(msgs).totalTokens,
      });
      sendContextUsage(msgs);
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
          [{ role: "user", content: `## 📋 对话摘要\n\n${summary}` }, ...recent],
          getHistoryTitle(recent)
        );
        sessionDb.updateTitle(parentId, getHistoryTitle(recent));
        recent.unshift({ role: "user", content: `## 📋 对话摘要\n\n${summary}` });
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

  hookManager.fire("SessionEnd", { sessionId: finalSessionId, aborted: false }).catch(() => {});
  autoReview(msgs, apiKey, apiUrl, model, apiFormat).catch(() => {});
  return { text: allText || "(no text response)" };
}
