// ── Agent Loop — Main conversation loop + session compression ──

import sessionDb from "../session-db.mjs";
import { buildSystemPrompt } from "./system-prompt.mjs";
import { openaiCall, anthropicCall } from "./format-adapters.mjs";
import { selectRelevantMemories } from "./memory-selection.mjs";
import { runTool } from "./tool-executor.mjs";
import { compressContext, sendContextUsage, estimateTokens, estimateMessageTokens, trimToBudget, TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD, summarizeForContinuation } from "./token-budget.mjs";
import * as hookManager from "./hook-manager.mjs";
import * as memory from "../memory-store.mjs";
import * as skills from "../skills-store.mjs";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  getWorkspace,
  taskStore, getTodoList,
  sendToRenderer, genId, MAX_OUTPUT, MAX_TURNS, MAX_CONTINUATIONS,
  CONTEXT_WINDOW, CONTEXT_COMPRESS_PCT, LLM_CALL_TIMEOUT,
  resetSurfacedMemories, bumpTurnCounter,
} from "./state.mjs";

// ── Prompt caching: freeze system prompt & contextBlock base after first turn ──
/** @type {string | null} */
let _sysPromptCache = null;
/** @type {string | null} */
let _contextBlockBaseCache = null;

/**
 * @param {Array<{role:string,content:any}>} history
 * @returns {string}
 */
function getHistoryTitle(history) {
  const firstUser = history.find(/** @param {{role:string,content:any}} m */ (/** @type {any} */ m) => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

/**
 * Extract `<think>…</think>` blocks from a content string. Mirrors the
 * renderer's `extractThinkingBlocks` (renderer/app.js) so that what we save
 * in `content` matches what the live chat renders after extraction.
 *
 * Why: models like MiniMax M3 sometimes stream their chain-of-thought
 * inside the `content` field (as `<think>…</think>` tags) rather than as a
 * separate `reasoning_content` field. The live chat shows it via the
 * renderer's regex, but on reload the DB still has the tags inside `content`
 * AND a NULL `reasoning_content` column. Stripping at save time fixes both
 * problems: the reasoning ends up in the `reasoning_content` column where it
 * belongs, and the saved `content` is clean text that renders identically
 * to the live chat.
 *
 * @param {string} text
 * @returns {{ cleanText: string, thinkText: string }}
 */
export function extractThinkBlocks(text) {
  if (!text) return { cleanText: "", thinkText: "" };
  const re = /<think>([\s\S]*?)<\/think>/gi;
  const blocks = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const t = match[1].trim();
    if (t) blocks.push(t);
  }
  const cleanText = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, thinkText: blocks.join("\n\n") };
}

/**
 * @param {string} id
 * @param {Array<{role:string,content:any}>} history
 * @param {string} [title]
 */
async function saveSession(id, history, title) {
  try { await sessionDb.saveSession(id, history, title); } catch { /* ignored */ }
}

// ── Auto-review: extract learnings after each session ──
/**
 * @param {Array<{role:string,content:any}>} msgs
 * @param {string} apiKey
 * @param {string} apiUrl
 * @param {string} model
 * @param {string} apiFormat
 * @param {AbortSignal} [signal] forwarded from the agent loop. If the
 *   user hit Stop, the parent abort fires and this fetch is cancelled
 *   instead of leaking the in-flight request and writing a memory
 *   derived from a half-finished session.
 */
async function autoReview(msgs, apiKey, apiUrl, model, apiFormat, signal) {
  try {
    // Take last 8 exchanges (16 messages) for review
    const recent = msgs.slice(-16).filter(/** @param {{role:string,content:any}} m */ m => m.role === "user" || m.role === "assistant");
    if (recent.length < 4) return;

    const convText = recent.map(/** @param {{role:string,content:any}} m */ m => {
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

    const body = /** @type {{ model: string, messages: Array<{role:string,content:string}>, max_tokens: number, temperature?: number, stream: boolean, system?: string }} */ ({
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: reviewPrompt }],
      max_tokens: 1024,
      temperature: 0.3,
      stream: false,
    });
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
    /** @type {Record<string,string>} */
    const headers = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "你是一个对话分析助手。从对话中提取值得长期记忆的信息。";
      body.model = model || "claude-sonnet-4-20250514";
      body.temperature = undefined;
    }

    const composed = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: composed,
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
  } catch (/** @type {any} */ e) {
    console.error("[auto-review] Failed:", e.message);
  }
}

/**
 * @param {string} prompt
 * @param {string} apiKey
 * @param {string} apiUrl
 * @param {string} model
 * @param {string} [apiFormat]
 * @param {Array<any>} [files]
 * @param {any} [enabledSkills]
 * @param {boolean} [reasoning]
 * @param {string} [agentName]
 * @param {boolean} [kbEnabled]
 * @param {boolean} [isPlanMode]
 * @param {boolean} [webSearchEnabled]
 * @param {boolean} [silent]
 */
export async function agentLoop(prompt, apiKey, apiUrl, model, apiFormat = "openai", files = [], enabledSkills, reasoning = true, agentName, kbEnabled = false, isPlanMode = false, webSearchEnabled = true, silent = false) {
  let abortCtrl = /** @type {AbortController | null} */ (getAbortCtrl());
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  setAbortCtrl(abortCtrl);
  const { signal } = abortCtrl;
  /** @type {(channel: string, data: any) => void} */
  const sdr = (channel, data) => { if (!silent) sendToRenderer(channel, data); };

  let sessionId = /** @type {string | null} */ (getSessionId());
  if (!sessionId) { sessionId = genId(); setSessionId(sessionId); }

  hookManager.initHookManager(getWorkspace());

  // Save placeholder session to DB immediately so it appears in sidebar
  const placeholderTitle = (prompt || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
  const placeholderHistory = [{ role: "user", content: prompt || "" }];
  await sessionDb.saveSession(/** @type {string} */ (sessionId), placeholderHistory, placeholderTitle);
  sdr("session:update", { sessionId });

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
      sdr("l0:budget", {
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

    _sysPromptCache = /** @type {string} */ (sysContent);
    _contextBlockBaseCache = /** @type {string} */ (contextBlockBase);
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
    // B4: previously used only the last assistant message's tail (500 chars)
    // as the memory retrieval query. That single message is often a side
    // branch (e.g. "let me also explain X") unrelated to the user's actual
    // current task, so we ended up injecting memories about old tasks.
    // Use the last 5 turns (mixed user+assistant) so the retrieval query
    // reflects the *current thread*, not whatever the LLM last said.
    const recentMsgs = history.slice(-5);
    const recentContext = recentMsgs
      .map(m => `[${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 200) : ""}`)
      .join("\n");
    const memQuery = `最近对话:\n${recentContext}\n\n用户最新消息: ${prompt || ""}`;
    const relevantMems = await selectRelevantMemories(memQuery, apiKey, apiUrl, model, apiFormat);
    if (relevantMems) {
      const memBlock = "\n\n## 相关记忆\n" + relevantMems;
      contextBlock += memBlock;
      contextExtraMsgs.push({ role: "user", content: memBlock.trim() });
    }
  } catch (/** @type {any} */ e) {
    console.error("[memory] selection error:", e.message);
  }

  // ── Current task anchor: always inject on non-first turn so the LLM
  // knows which "主线" to follow. Previously gated on prompt < 80 chars,
  // which meant longer real-world requests ("改一下 A 文件第 3 段") skipped
  // the anchor and the LLM fell back to scanning history — frequently
  // picking up an unrelated old task and producing off-topic replies.
  // Cost: +800 chars of cache-friendly text per turn. Worth it. ──
  if (history.length > 0) {
    const lastAsst = [...history].reverse().find(m => m.role === "assistant");
    if (lastAsst && lastAsst.content) {
      const proposalText = lastAsst.content.slice(-800);
      const anchor = `\n\n---\n⚠️ **当前任务锚定** — 用户刚才的回复是在回应你**上一次的以下内容**。请优先处理这个任务，不要被历史记忆或知识库中的旧任务干扰：\n\n> ${proposalText.replace(/\n/g, "\n> ")}\n\n请立即执行你刚才提议的方案。如果用户的回复含义不明确，回看以上内容来理解用户意图，而不是去历史记忆中寻找任务。`;
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
  /** @type {Array<{role:string,content:any,reasoning_content?:string,tool_calls?:Array<any>,tool_call_id?:string,system?:string}>} */
  let msgs = [{ role: "system", content: sysContent }];
  if (contextBlockBase && contextBlockBase.trim()) {
    msgs.push({ role: "user", content: contextBlockBase.trim() });
  }
  msgs.push(...history.map(m => ({ ...m })));
  msgs.push(...contextExtraMsgs);
  msgs.push(userMessage);
  let allText = "", allReasoning = "";
  let continuation = 0;
  let agentFinished = false;
  // ── P0 fix: rebuild context block from LIVE state on every continuation. ──
  // Previously this was a single-shot snapshot, so any task/todo changes that
  // happened mid-conversation were lost when the context was rebuilt.
  const buildContextMsg = () => {
    const liveActive = Array.from(taskStore.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
    const liveTodos = getTodoList();
    const liveUnverified = Array.from(taskStore.values()).filter(t => t.unverified === true);
    const parts = [];
    if (liveActive.length > 0) {
      let block = "## 当前任务状态\n";
      for (const t of liveActive) {
        const icon = t.status === "in_progress" ? "🔄" : "⬜";
        block += `- ${icon} **${t.subject}** (${t.status}) — ${t.description}\n`;
      }
      parts.push(block);
    }
    if (liveTodos.length > 0) {
      let block = "## 当前 Todo 清单\n";
      for (const t of liveTodos) {
        const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
        block += `- ${icon} ${t.content}\n`;
      }
      parts.push(block);
    }
    if (liveUnverified.length > 0) {
      let block = "## ⚠️ 未经验证的完成\n以下任务被标记为 completed 但未提供 evidence，用户可能需要复查：\n";
      for (const t of liveUnverified) {
        block += `- **${t.subject}** — status=completed (no evidence)\n`;
      }
      parts.push(block);
    }
    return parts.length > 0 ? { role: "user", content: parts.join("\n").trim() } : null;
  };
  let _contextMsg = buildContextMsg();

  compressContext(msgs);
  sendContextUsage(msgs);

  // ── Continuation loop: auto-compress and continue on context overflow ──
  while (continuation < MAX_CONTINUATIONS && !agentFinished) {
    continuation++;
    let turns = 0;
    let toolsCalledThisTurn = 0;  // P0: track tool calls to prevent pure-text "completion"

    if (continuation > 1) {
      const banner = `\n\n--- 第 ${continuation} 次自动继续 ---\n`;
      allText += banner;
      sdr("stream:chunk", { content: banner });
    }

    while (turns < MAX_TURNS) {
      turns++;
      // P3方案3(c): bump the global turn counter so memory-selection.mjs
      // can expire old surfaced memories. Without this, a memory surfaced
      // in turn 1 stays locked out for the entire session.
      bumpTurnCounter();
      compressContext(msgs);

      // Check context overflow — break to continuation
      const usage = estimateMessageTokens(msgs);
      const contextPct = usage.totalTokens / CONTEXT_WINDOW;
      if (contextPct > CONTEXT_COMPRESS_PCT) {
        console.log(`[agent-loop] Context at ${Math.round(contextPct * 100)}%, triggering continuation`);
        break;
      }

      sendContextUsage(msgs);

      let content, reasoningContent, tcs, finishReason;
      try {
        const callFn = apiFormat === "anthropic" ? anthropicCall : openaiCall;
        // P1: compose user abort + per-call timeout so a hung API request
        // doesn't block the agent loop indefinitely. Timeout is 5 min.
        const callSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(LLM_CALL_TIMEOUT)])
          : AbortSignal.timeout(LLM_CALL_TIMEOUT);
        const result = await callFn(msgs, apiUrl, apiKey, model, callSignal, reasoning, kbEnabled, webSearchEnabled);
        content = result.content;
        reasoningContent = /** @type {any} */ (result).reasoningContent || "";
        allText += result.content;
        if (reasoningContent) allReasoning += reasoningContent;
        tcs = result.tcs;
        // B1: capture finishReason so we can detect length-truncated responses
        // and recover by asking the model to continue instead of accepting
        // the truncated tail as a final answer.
        finishReason = /** @type {any} */ (result).finishReason || null;
        if (finishReason === "length") {
          console.warn(`[agent-loop] response truncated by finish_reason=length (content=${content.length} chars, tcs=${tcs.length}). Will request continuation.`);
        }
        // ── Log cache metrics & forward to UI ──
        if (result.usage) {
          /** @type {{ prompt_cache_hit_tokens?: number; prompt_tokens?: number; prompt_cache_miss_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; input_tokens?: number }} */
          const u = result.usage;
          if (u.prompt_cache_hit_tokens !== undefined) {
            const total = u.prompt_tokens || 0;
            const miss = u.prompt_cache_miss_tokens ?? 0;
            const pct = total > 0 ? Math.round(u.prompt_cache_hit_tokens / total * 100) : 0;
            console.log(`[cache] hit=${u.prompt_cache_hit_tokens} miss=${miss} total=${total} rate=${pct}%`);
            sdr("stream:metrics", {
              hit: u.prompt_cache_hit_tokens, miss, total, rate: pct,
            });
          } else if (u.cache_read_input_tokens !== undefined) {
            const read = u.cache_read_input_tokens || 0;
            const created = u.cache_creation_input_tokens || 0;
            const total = u.input_tokens || 0;
            const miss = total - read;
            const pct = total > 0 ? Math.round(read / total * 100) : 0;
            console.log(`[cache] read=${read} created=${created} total=${total} rate=${pct}%`);
            sdr("stream:metrics", {
              hit: read, miss, total, rate: pct,
            });
          }
        }
      } catch (/** @type {any} */ err) {
        if (err.name === "AbortError") {
          hookManager.fire("SessionEnd", { sessionId: getSessionId(), aborted: true }).catch(() => {});
          return { text: allText, aborted: true };
        }
        throw err;
      }

      const asst = /** @type {{ role: string, content: string | null, reasoning_content?: string, tool_calls?: Array<any> }} */ ({ role: "assistant", content: content || null });
      if (reasoningContent) asst.reasoning_content = reasoningContent;
      if (tcs.length > 0) asst.tool_calls = tcs;
      msgs.push(asst);

      // P0: prevent "pure-text completion". If the LLM responds with no tool
      // calls but also doesn't look like a final answer (i.e. still has unverified
      // tasks), push back a reminder instead of accepting the reply as done.
      if (tcs.length === 0) {
        // B1: finish_reason="length" means the API hit max_tokens mid-stream
        // before the model could finish (or call tools). The truncated tail
        // is NOT a final answer — push a "please continue" reminder so the
        // model resumes from where it was cut off instead of us accepting
        // a half-finished reply as the agent's final output.
        if (finishReason === "length") {
          const continueReminder = `⚠️ 你上一次的回复因输出长度限制被截断了（最后的内容是：「${content.slice(-200)}」）。请从断点处继续——不要重复已经写完的内容，不要从头开始。`;
          msgs.push({ role: "user", content: continueReminder });
          // Also keep the truncated assistant message in history so the model
          // can see what was already produced; do NOT set agentFinished.
          turns++;
          if (turns < MAX_TURNS) continue;
        }
        const unverified = Array.from(taskStore.values()).filter(t => t.unverified === true);
        const activeTasks = Array.from(taskStore.values()).filter(t => t.status === "in_progress" || t.status === "pending");
        if (unverified.length > 0 || activeTasks.length > 0) {
          // Don't finish — push a reminder and continue the loop
          const reminder = unverified.length > 0
            ? `⚠️ 你有 ${unverified.length} 个任务被标记为 completed 但没有提供 evidence。请用 TaskUpdate(evidence=...) 补充证据，或者用 TaskUpdate(status='in_progress') 重新开始并实际执行。`
            : `⚠️ 你还有 ${activeTasks.length} 个任务在 pending/in_progress 状态。请用 TaskUpdate 推进它们，或者在完成时提供 evidence。`;
          msgs.push({ role: "user", content: reminder });
          // Don't break — continue the inner turn loop so the LLM can act on the reminder
          // But cap at 2 extra nudges to avoid infinite loops
          turns++;
          if (turns < MAX_TURNS) continue;
        }
        // B8: anti-laziness guard. If the LLM has called 0 tools in the
        // entire conversation AND the user's prompt looks operational
        // (contains action verbs like 改/修/查/找/跑/执行/创建/读取),
        // the LLM is trying to "complete" without doing any work. Push a
        // reminder forcing tool use. Cap at 2 nudges to avoid loops; if the
        // LLM still won't use tools after that, accept its answer and let
        // the user see that it refused to act.
        const hasActionIntent = /(改|修|查|找|跑|执行|删除|创建|添加|读取|分析|搜索|运行|test|run|fix|search|read|write|delete|create|build|install|test|debug|find)/i.test(prompt || "");
        if (toolsCalledThisTurn === 0 && hasActionIntent && turns < MAX_TURNS - 2) {
          msgs.push({ role: "user", content: "⚠️ 你还没调用任何工具就准备结束。用户的要求是操作性任务（不是纯聊天），请先用 file_read / bash / grep / web_search 等工具获取信息或执行操作，再回答。如果你不确定要做什么，请用 AskUserQuestion 询问用户。" });
          turns++;
          continue;
        }
        agentFinished = true;
        break;
      }
      toolsCalledThisTurn += tcs.length;

      // ── Execute tools (Agent calls in parallel, others sequential) ──
      const agentCalls = tcs.filter(tc => tc.function?.name === "Agent");
      const otherCalls = tcs.filter(tc => tc.function?.name !== "Agent");

      if (agentCalls.length > 0) {
        for (const tc of agentCalls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
          sdr("tool:start", { name: "Agent", args });
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
          sdr("tool:result", { name: "Agent", result });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
          hookManager.fire("PostToolUse", { tool: "Agent", result }).catch(() => {});
        }
      }

      for (const tc of otherCalls) {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
        sdr("tool:start", { name: tc.function.name, args });

        let result;
        try { result = await runTool(tc); } catch (/** @type {any} */ e) { result = { error: e.message }; }

        let rStr = JSON.stringify(result);
        if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
        sdr("tool:result", { name: tc.function.name, result });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
        hookManager.fire("PostToolUse", { tool: tc.function.name, result }).catch(() => {});

        // P3: turn-level checkpoint — every 5 turns persist the current
        // history snapshot so a crash mid-task can be resumed. Cap the
        // snapshot at 200 messages to keep the DB write fast.
        if (turns % 5 === 0 && sessionId) {
          try {
            const histSnapshot = msgs
              .filter(m => m.role === "user" || m.role === "assistant")
              .slice(-200)
              .map(m => {
                // Strip embedded <think> blocks so the saved `content` is
                // the user-visible text only, and (re-)derive `reasoning_content`
                // from those blocks when the API didn't stream a separate
                // field. Models like MiniMax M3 rely on this fallback.
                const rawContent = typeof m.content === "string" ? m.content : "";
                const { cleanText, thinkText } = extractThinkBlocks(rawContent);
                const reasoning = m.reasoning_content
                  ? (thinkText ? `${m.reasoning_content}\n\n${thinkText}` : m.reasoning_content)
                  : thinkText;
                return {
                  role: m.role,
                  content: cleanText || rawContent,
                  reasoning_content: reasoning || undefined,
                  tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? m.tool_calls : undefined,
                };
              });
            await sessionDb.saveSession(sessionId, histSnapshot, getHistoryTitle(histSnapshot));
            sessionDb.saveTurnProgress(sessionId, {
              currentTurn: turns,
              maxTurns: MAX_TURNS,
              currentContinuation: continuation,
              maxContinuations: MAX_CONTINUATIONS,
              lastSummary: "",
            });
          } catch (/** @type {any} */ e) {
            console.error("[checkpoint] save failed:", e.message);
          }
        }
      }
    }

    if (agentFinished) break;

    // ── Continuation: summarize and compress ──
    if (continuation < MAX_CONTINUATIONS) {
      sdr("context:continuation-start", { continuation, max: MAX_CONTINUATIONS });

      const summary = await summarizeForContinuation(msgs, apiKey, apiUrl, model, apiFormat, signal);

      const sysMsg = msgs[0];
      const recentMsgs = msgs.slice(-6);
      // contextBlock at end → [sys][summary][recent...][ctx] = cacheable prefix for continuation
      const continuationMsg = { role: "user", content: `## 📋 对话摘要\n\n${summary}\n\n请继续完成未完成的工作，避免重复已完成的内容。` };
      // P0: rebuild context block from LIVE state instead of using stale snapshot
      _contextMsg = buildContextMsg();
      // B6: continuation should re-surface previously-surfaced memories —
      // otherwise after 5 turns the surfaced set contains all memories and
      // memory-selection returns nothing. The summary already references
      // the important facts, but giving the model fresh memory access lets
      // it recall file paths / decisions / preferences that may not be in
      // the summary's limited budget.
      resetSurfacedMemories();
      msgs = [sysMsg, continuationMsg, ...recentMsgs];
      if (_contextMsg) msgs.push(_contextMsg);

      sdr("context:continuation-done", {
        continuation,
        max: MAX_CONTINUATIONS,
        summaryTokens: estimateTokens(summary),
        contextAfterTokens: estimateMessageTokens(msgs).totalTokens,
      });
      sendContextUsage(msgs);

      // P1: persist turn progress + summary so a process restart can resume
      if (sessionId) {
        try {
          sessionDb.saveTurnProgress(sessionId, {
            currentTurn: turns,
            maxTurns: MAX_TURNS,
            currentContinuation: continuation,
            maxContinuations: MAX_CONTINUATIONS,
            lastSummary: summary.slice(0, 2000),
          });
        } catch (/** @type {any} */ e) {
          console.error("[turn-progress] save failed:", e.message);
        }
      }
    }
  }

  // Conversation completed — clear the long-task resume marker.
  if (sessionId) {
    try { sessionDb.clearTurnProgress(sessionId); } catch { /* ignored */ }
  }

  // Save conversation.
  //
  // Why we also strip <think> blocks: models like MiniMax M3 / DeepSeek R1
  // sometimes embed the chain-of-thought inside `content` (as `<think>…</think>`
  // tags) instead of streaming it via the separate `reasoning_content` field.
  // The renderer's `extractThinkingBlocks` handles this on display, but the
  // DB ends up with the think tags still baked into `content` and the
  // `reasoning_content` column stays NULL — so the reasoning is visible during
  // the live chat and then vanishes on reload. To make the save robust to
  // both APIs, we:
  //   1. pull <think>…</think> blocks out of `allText` and merge them into
  //      `allReasoning` (preferring the API field if both are present)
  //   2. write the cleaned `content` so reload and live chat render identically
  const { cleanText, thinkText } = extractThinkBlocks(allText);
  const combinedReasoning = allReasoning
    ? (thinkText ? `${allReasoning}\n\n${thinkText}` : allReasoning)
    : thinkText;
  const historyAsst = /** @type {{ role: string, content: string, reasoning_content?: string }} */ ({ role: "assistant", content: cleanText || allText || "" });
  if (combinedReasoning) historyAsst.reasoning_content = combinedReasoning;
  if (process.env.DEBUG_REASONING === "1") {
    console.log(`[reasoning-debug] agent-loop end: allReasoning.length=${allReasoning.length}, allText.length=${allText.length}, thinkText.length=${thinkText.length}, combinedReasoning.length=${combinedReasoning.length}`);
    if (!combinedReasoning) {
      console.log(`[reasoning-debug] ⚠️ combined reasoning is EMPTY. Provider is not returning reasoning_content AND content has no <think> tags.`);
    }
  }
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

      const body = /** @type {{ model: string, messages: Array<{role:string,content:string}>, max_tokens: number, stream: boolean, system?: string }} */ ({
        model: model || "deepseek-chat",
        messages: [{ role: "user", content: compactPrompt }],
        max_tokens: 2048,
        stream: false,
      });
      const endpoint = apiFormat === "anthropic"
        ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
        : apiUrl;
      /** @type {Record<string,string>} */
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
    } catch (/** @type {any} */ e) {
      console.error("[compress] AI compaction failed, using fallback:", e.message);
    }

    if (!summary || summary.trim().length < 20) {
      // Structured fact extraction — same logic as summarizeForContinuation's fallback.
      const FACT_PATTERNS = [
        { label: "文件", rx: /(?:\s|^|[`(\[])([A-Za-z]:[\\/][^\s`"'>|?]+|\.{0,2}\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g },
        { label: "函数", rx: /\b(?:function|class|const|let|var|export)\s+([A-Za-z_$][\w$]*)/g },
        { label: "错误", rx: /(?:Error|Exception|TypeError|ENOENT|EACCES|404|500|超时|失败)[^。\n]{0,120}/gi },
        { label: "用户", rx: /(?:记住|下次|以后|总是|永远|不要|必须|prefer|always|never)[^。\n]{0,120}/gi },
      ];
      const seen = new Set();
      const facts = [];
      for (const m of oldHistory.slice(-30)) {
        const text = (typeof m.content === "string" ? m.content : "").slice(0, 3000);
        for (const { label, rx } of FACT_PATTERNS) {
          rx.lastIndex = 0;
          let m1; let n = 0;
          while ((m1 = rx.exec(text)) !== null && n < 4) {
            const f = m1[0].replace(/\s+/g, " ").trim().slice(0, 160);
            if (f.length < 5) continue;
            const k = `${label}::${f}`;
            if (seen.has(k)) continue;
            seen.add(k);
            facts.push(`- **${label}：** ${f}`);
            n++;
            if (facts.length >= 40) break;
          }
          if (facts.length >= 40) break;
        }
        if (facts.length >= 40) break;
      }
      if (facts.length > 0) {
        summary = ["## 早期对话关键事实\n", "（LLM 摘要失败，正则提取）\n", ...facts].join("\n");
      } else {
        summary = "## 早期对话摘要\n（无可用信息）";
      }
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
      } catch (/** @type {any} */ e) { console.error("[compress]", e.message); }
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
  // P2: forward the abort signal so autoReview can be cancelled by Stop.
  autoReview(msgs, apiKey, apiUrl, model, apiFormat, signal).catch(() => {});

  // Phase 2 trigger: detect repeated-task patterns from the last 30 sessions.
  // If a phrase appears in 3+ sessions and isn't covered by an existing skill,
  // notify the renderer to suggest skill creation. Fire-and-forget; never block
  // the response.
  if (!silent) {
    (async () => {
      try {
        /** @type {any} */
        const db = sessionDb;
        const suggestions = await skills.detectPatterns(/** @type {any} */ (db));
        if (Array.isArray(suggestions) && suggestions.length > 0) {
          sdr("agent-skill:patterns-detected", { suggestions });
        }
      } catch (/** @type {any} */ e) {
        console.error("[agent-loop] detectPatterns failed:", e?.message);
      }
    })();
  }
  return { text: allText || "(no text response)" };
}

export function resetPromptCache() {
  _sysPromptCache = null;
  _contextBlockBaseCache = null;
}
