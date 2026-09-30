// ── Agent Loop — Main conversation loop + session compression ──

import sessionDb from "../session-db.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { openaiCall, anthropicCall } from "./format-adapters.ts";
import { selectRelevantMemories } from "./memory-selection.ts";
import { runTool } from "./tool-executor.ts";
import { compressContext, sendContextUsage, estimateTokens, estimateMessageTokens, trimToBudget, TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD, summarizeForContinuation } from "./token-budget.ts";
import * as hookManager from "./hook-manager.ts";
import * as memory from "../memory-store.ts";
import * as skills from "../skills-store.ts";
import { writeFileSync, mkdtempSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { getExtractor } from "../kb/extractors/index.ts";
import {
  getSessionId, setSessionId, getHistory, setHistory,
  getAbortCtrl, setAbortCtrl,
  getWorkspace,
  taskStore, getTodoList,
  sendToRenderer, genId, MAX_OUTPUT, MAX_TURNS, MAX_CONTINUATIONS,
  CONTEXT_WINDOW, CONTEXT_COMPRESS_PCT, LLM_CALL_TIMEOUT,
  resetSurfacedMemories, bumpTurnCounter,
  getOpencodeAcpClient, setOpencodeAcpClient, isOpencodeAcpClientAlive,
  detectModelContextWindow, setContextWindow,
} from "./state.ts";

// ── Prompt caching: freeze system prompt & contextBlock base after first turn ──
let _sysPromptCache: string | null = null;
let _contextBlockBaseCache: string | null = null;

interface LoopMessage {
  role: string;
  content: any;
  reasoning_content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  system?: string;
}

function getHistoryTitle(history: LoopMessage[]): string {
  const firstUser = history.find(m => m.role === "user");
  if (!firstUser) return "新对话";
  const text = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content || "");
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
}

/**
 * Build the full on-disk history for one user turn: all prior turns +
 * this user message + this turn's tool results + final/partial assistant text.
 *
 * `sessionDb.saveSession` does DELETE-all + re-insert, so saving only the
 * current turn would wipe every previous message. Callers must pass
 * `priorTurns` taken from the DB at the start of the turn (getHistory()
 * only holds user+assistant text and would drop prior turns' tool rows).
 */
export function buildTurnHistory(opts: {
  priorTurns: LoopMessage[];
  prompt: string;
  files?: any[];
  tools?: Array<{ id: string; name: string; args?: any; result?: any }>;
  assistantContent: string;
  assistantReasoning?: string;
}): LoopMessage[] {
  const userContent = opts.prompt
    || (opts.files && opts.files.length > 0
      ? `[${opts.files.map(f => f.name).join(", ")}]`
      : "");
  const out: LoopMessage[] = [...opts.priorTurns];
  out.push({ role: "user", content: userContent });
  for (const tc of opts.tools || []) {
    const argsStr = tc.args ? JSON.stringify(tc.args).slice(0, 500) : "";
    const resultStr = tc.result != null
      ? (typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result)).slice(0, 2000)
      : "";
    out.push({
      role: "tool",
      tool_call_id: tc.id,
      content: resultStr,
      tool_calls: [{
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: argsStr },
      }],
    });
  }
  const asst: LoopMessage = { role: "assistant", content: opts.assistantContent || "" };
  if (opts.assistantReasoning) asst.reasoning_content = opts.assistantReasoning;
  out.push(asst);
  return out;
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
export function extractThinkBlocks(text: string): { cleanText: string, thinkText: string } {
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
 * Split a streamed assistant turn at `toolBoundary` (index right after the
 * last turn that produced tool_calls) so display/save only keep the FINAL
 * answer in `content` and move process narration into `reasoning_content`.
 *
 * The renderer mirrors this live: everything streamed before `tool:start`
 * gets flushed into the thinking block, only the tail stays as body text.
 * If there is no final-answer segment at all (aborted / interrupted mid-tool
 * run) we fall back to the old behaviour — whole text as content — so a Stop
 * never loses the partial answer.
 *
 * @param {string} allText   raw concatenation of all turn contents
 * @param {string} allReasoning raw concatenation of all reasoning_content
 * @param {number} toolBoundary index into allText after the last tool-call turn
 * @returns {{ bodyText: string, reasoningText: string }}
 */
export function splitStreamText(allText: string, allReasoning: string, toolBoundary: number): { bodyText: string, reasoningText: string } {
  const boundary = Math.max(0, Math.min(toolBoundary || 0, allText.length));
  const answer = allText.slice(boundary);

  if (!answer.trim()) {
    // No final segment (Stop / error before the model produced an
    // answer-after-tools turn) — persist everything as content, as before.
    const { cleanText, thinkText } = extractThinkBlocks(allText);
    const reasoningText = [allReasoning, thinkText].filter(s => s && s.trim()).join("\n\n");
    return { bodyText: cleanText || allText || "", reasoningText };
  }

  const narr = allText.slice(0, boundary);
  const { cleanText: answerClean, thinkText: answerThink } = extractThinkBlocks(answer);
  const { cleanText: narrClean, thinkText: narrThink } = extractThinkBlocks(narr);
  // Process narration joins reasoning (mirrors the renderer's flush-to-
  // thinking on tool:start); </think> tags in the answer tail also move up.
  const reasoningText = [allReasoning, narrThink, narrClean, answerThink]
    .filter(s => s && s.trim()).join("\n\n");
  return { bodyText: answerClean || answer.trim(), reasoningText };
}

// ── Vision capability: does this model understand image_url blocks? ──
// Pure-text models (DeepSeek chat, most local GGUF, MiniMax text-only) reject
// or silently ignore image_url parts. Known-multimodal models are matched by
// ID patterns; anything unknown defaults to NON-vision (safe): we save the
// image to disk and hand the model a text directive pointing at the
// vision-bridge skill instead of sending a block it can't use.
const VISION_MODEL_PATTERNS = [
  /^claude/i,              // Anthropic Claude (all multimodal)
  /glm-4\S*v\S*/i,         // GLM-4V / GLM-4.1V / GLM-4.6V (Zhipu vision)
  /qwen[23]?.*-?vl/i,      // Qwen-VL / Qwen2-VL / Qwen3-VL
  /gpt-4o/i, /gpt-4\.1/i, /gpt-4-vision/i, /gpt-5/i, /o[0-9]+/i,
  /gemini/i, /gemma-3/i,
  /llava/i, /internvl/i, /minicpm-v/i, /phi-3-vision/i, /qwen-vl/i,
];

/**
 * @param {string|null|undefined} model
 * @returns {boolean} true when the model ID matches a known-multimodal pattern.
 */
export function supportsVision(model?: string | null): boolean {
  if (!model) return false;
  return VISION_MODEL_PATTERNS.some(rx => rx.test(model));
}

/**
 * Save an image attachment (base64 dataUrl) to a temp file so a non-vision
 * model can still access it via the vision-bridge skill. Returns the path,
 * or null when the write fails (caller falls back to image_url).
 *
 * @param {{name?: string, dataUrl?: string}} f
 * @returns {{path: string} | null}
 */
function saveImageAttachment(f: { name?: string, dataUrl?: string }): { path: string } | null {
  try {
    const base64Data = (f.dataUrl || "").includes("base64,") ? (f.dataUrl as string).split("base64,")[1] : f.dataUrl || "";
    if (!base64Data) return null;
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length === 0) return null;
    const ext = (f.name || "image").split(".").pop()?.toLowerCase() || "png";
    const dir = join(tmpdir(), "aideagent-image-attach");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    writeFileSync(path, buffer);
    return { path };
  } catch (e: any) {
    console.error("[agent-loop] saveImageAttachment failed:", e.message);
    return null;
  }
}

// ── Vision-bridge skill discovery ──────────────────────────────────────
// The vision-bridge invoker script lives alongside the user's installed skills
// (the same directories skill-scanner.mjs scans). Resolve it at runtime — the
// previous literal `C:\Users\7\...` path only existed on the author's machine
// and broke image description everywhere else. When no script is found,
// VISION_BRIDGE_SCRIPT is null and the call sites below degrade gracefully
// instead of handing the model a python command that cannot run.
const VISION_BRIDGE_CANDIDATES = [
  join(homedir(), ".agents", "skills", "vision-bridge", "vision_bridge.py"),
  join(homedir(), ".claude", "skills", "vision-bridge", "vision_bridge.py"),
  join(homedir(), ".agents", "vision-bridge", "vision_bridge.py"),
];
const VISION_BRIDGE_SCRIPT = VISION_BRIDGE_CANDIDATES.find(p => existsSync(p)) ?? null;

// Runtime of the active agentLoop call is captured as a closure-local variable
// inside agentLoop so concurrent calls (or a runtime switch mid-flight) can't
// race against each other on a module-level holder. Previous design used
// `let _currentRuntime = "aide"` at module scope, which caused concurrent
// queries to overwrite each other's persisted session runtime metadata.

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
async function autoReview(msgs: LoopMessage[], apiKey: string, apiUrl: string, model: string, apiFormat: string, signal?: AbortSignal): Promise<void> {
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

    const body: any = {
      model: model || "deepseek-chat",
      messages: [{ role: "user", content: reviewPrompt }],
      max_tokens: 1024,
      temperature: 0.3,
      stream: false,
    };
    const endpoint = apiFormat === "anthropic"
      ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
      : apiUrl;
    const headers: Record<string, string> = apiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    if (apiFormat === "anthropic") {
      body.system = "你是一个对话分析助手。从对话中提取值得长期记忆的信息。";
      body.model = model || "claude-sonnet-4-20250514";
      delete body.temperature;
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
  } catch (e: any) {
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
 * @param {string} [opencodeModelId] - when runtime === "opencode", the
 *   model id the user picked from the picker (e.g. "anthropic/claude-sonnet-4").
 *   Forwarded to ACP `session/new` so opencode spawns with that model.
 */
export async function agentLoop(
  prompt: string,
  apiKey: string,
  apiUrl: string,
  model: string,
  apiFormat = "openai",
  files: any[] = [],
  enabledSkills?: string[],
  reasoning = true,
  agentName?: string,
  kbEnabled = false,
  isPlanMode = false,
  webSearchEnabled = true,
  silent = false,
  runtime = "aide",
  opencodeModelId?: string,
): Promise<{ text: string, aborted?: boolean }> {
  // Captured as closure-local: every saveSession call inside this agentLoop
  // invocation writes the SAME runtime value, regardless of what a concurrent
  // or later agentLoop call does to its own local copy.
  const sessionRuntime = runtime === "opencode" ? "opencode" : "aide";
  /**
   * @param {string} id
   * @param {Array<{role:string,content:any}>} history
   * @param {string} title
   */
  const saveSession = async (id: string, history: LoopMessage[], title: string): Promise<void> => {
    try { await sessionDb.saveSession(id, history, title, sessionRuntime); } catch { /* ignored */ }
  };
  // Full prior-turn rows (incl. tool entries) as they existed in the DB
  // BEFORE this agentLoop call. getHistory() is only user+assistant text —
  // using it as priorTurns would DELETE-all every previous tool row on save.
  let priorTurnsSnapshot: LoopMessage[] = [];
  let partialTurnPersisted = false;
  /**
   * Best-effort persist of the current (possibly partial) turn:
   * prior DB history + this user prompt + tools so far + partial assistant text.
   * Also appends the user/assistant pair to in-memory history so the next turn
   * (and the final save) still sees this exchange. Runs at most once per turn.
   *
   * Layered like the final save: narration before `toolBoundary` goes to
   * reasoning_content, text after it (the in-flight final answer) to content.
   */
  const persistPartialTurn = async (allText: string, allReasoning: string, toolBoundary: number, mainToolCalls: Array<{ id: string, name: string, args?: any, result?: any }>): Promise<void> => {
    if (partialTurnPersisted) return;
    try {
      const sid = getSessionId();
      if (!sid) return;
      const { bodyText: partialBody, reasoningText: partialReasoning } = splitStreamText(allText, allReasoning, toolBoundary);
      const saveHistory = buildTurnHistory({
        priorTurns: priorTurnsSnapshot,
        prompt,
        files,
        tools: mainToolCalls,
        assistantContent: partialBody,
        assistantReasoning: partialReasoning || undefined,
      });
      await saveSession(sid, saveHistory, getHistoryTitle(saveHistory));
      partialTurnPersisted = true;
      const histNow = getHistory();
      histNow.push(
        { role: "user", content: prompt || (files && files.length > 0 ? `[${files.map(f => f.name).join(", ")}]` : "") },
        {
          role: "assistant",
          content: partialBody,
          ...(partialReasoning ? { reasoning_content: partialReasoning } : {}),
        },
      );
    } catch { /* best-effort */ }
  };
  let abortCtrl = getAbortCtrl() as AbortController | null;
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  setAbortCtrl(abortCtrl);
  const { signal } = abortCtrl;
  const sdr = (channel: string, data: any): void => { if (!silent) sendToRenderer(channel, data); };

  let sessionId = getSessionId() as string | null;
  if (!sessionId) { sessionId = genId(); setSessionId(sessionId); }

  hookManager.initHookManager(getWorkspace());

  // Ensure the session row exists so it appears in the sidebar — but NEVER
  // wipe existing messages. sessionDb.saveSession does DELETE-all + re-insert;
  // writing a one-message placeholder here used to destroy prior turns, and
  // an interrupt before the final save left only the current user prompt
  // (refresh → previous answers gone / blank).
  const placeholderTitle = (prompt || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "新对话";
  try {
    const existing = sessionDb.loadSession(sessionId);
    priorTurnsSnapshot = (existing && Array.isArray(existing.history) ? existing.history : []) as LoopMessage[];
    if (priorTurnsSnapshot.length === 0) {
      await sessionDb.saveSession(
        /** @type {string} */ (sessionId),
        [{ role: "user", content: prompt || "" }],
        placeholderTitle,
        sessionRuntime,
      );
    } else {
      sessionDb.updateTitle(sessionId, placeholderTitle);
    }
  } catch { /* sidebar presence is best-effort */ }
  sdr("session:update", { sessionId });

  // ── OpenCode runtime: delegate entirely to the local ACP client ──
  // When runtime === "opencode", the user has chosen to drive a local
  // `opencode acp` subprocess via the Agent Client Protocol. opencode handles
  // its own model config, KB, skills, tools, and MCP — we just translate its
  // session/update notifications into the renderer's stream:* channels and
  // skip the cloud-API loop entirely. If the binary is missing or fails to
  // start, surface that as a stream error and fall back gracefully.
  if (sessionRuntime === "opencode") {
    return await runOpencodeAcp({
      prompt,
      files,
      silent,
      sessionId,
      sessionRuntime,
      saveSession,
      sdr,
      isPlanMode,
      signal,
      opencodeModelId,
      priorTurnsSnapshot,
    });
  }

  // ── Detect model context window for local models ──
  // For local models (llama.cpp, Ollama), detect the actual context window
  // to prevent exceed_context_size_error during long conversations.
  if (sessionRuntime === "aide" && apiUrl) {
    try {
      const detectedCtx = await detectModelContextWindow(apiUrl, model);
      if (detectedCtx) {
        setContextWindow(detectedCtx);
        console.log(`[agent-loop] Set context window to ${detectedCtx} for model: ${model}`);
      }
    } catch (e: any) {
      console.warn('[agent-loop] Failed to detect context window:', e.message);
    }
  }

  // ── Build user message with optional file attachments ──
  let userMessage: LoopMessage;
  if (files && files.length > 0) {
    const contentParts: any[] = [];
    if (prompt) contentParts.push({ type: "text", text: prompt });

    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) {
        if (supportsVision(model)) {
          contentParts.push({ type: "image_url", image_url: { url: f.dataUrl } });
        } else {
          // Model can't consume image_url blocks (DeepSeek chat, most local
          // GGUF, MiniMax text-only, ...). Save the image to disk and inject a
          // text directive so the model knows the vision-bridge skill can
          // describe it — sending a raw image_url would be rejected/ignored
          // by the API. If the write fails, fall back to image_url anyway.
          const saved = saveImageAttachment(f);
          if (saved) {
            const visionCmd = VISION_BRIDGE_SCRIPT
              ? `如需查看图片内容，请使用 vision-bridge 技能，运行：\n` +
                `python "${VISION_BRIDGE_SCRIPT}" --image "${saved.path}" --prompt "请详细描述这张图片的内容"\n` +
                `（若图片在剪贴板中，可改为 --clipboard）\n`
              : `（本机未检测到 vision-bridge 技能脚本，无法自动描述图片内容——如需此功能，请安装该技能）\n`;
            contentParts.push({
              type: "text",
              text: `\n\n[图片附件: ${f.name}] 当前模型不支持直接读取图片。图片已保存到本地文件：\n${saved.path}\n\n${visionCmd}`,
            });
          } else {
            contentParts.push({ type: "image_url", image_url: { url: f.dataUrl } });
          }
        }
      } else {
        // Non-image attachments: try to extract readable text via KB
        // extractors. Previously this used `atob()` to decode the base64
        // as a Latin-1 string — which silently corrupts binary files
        // (PDF/DOCX/XLSX/PPTX) into FlateDecode/ASCII85 byte noise that
        // models can't parse. Now we route .pdf/.docx/.pptx/.xlsx through
        // the proper extractors; pure-text files (.md/.txt/.json/.csv...)
        // fall back to utf-8 decoding.
        const base64Data = (f.dataUrl || "").includes("base64,") ? f.dataUrl.split("base64,")[1] : (f.dataUrl || "");
        if (!base64Data) {
          // Attachment without a readable dataUrl (e.g. aborted read) — skip
          // extraction instead of crashing the whole turn.
          contentParts.push({ type: "text", text: `[附件 ${f.name || "file"} 无法读取，已跳过]` });
          continue;
        }
        const buffer = Buffer.from(base64Data, "base64");
        let fileText = "";
        let extractionNote = "";
        try {
          const ext = (f.name.split(".").pop() ?? "").toLowerCase();
          // Use a synthetic filename so the extractor can dispatch by extension.
          const tempName = `attach-${Date.now()}.${ext}`;
          const tempPath = join(tmpdir(), tempName);
          writeFileSync(tempPath, buffer);
          try {
            const extractor = await getExtractor(tempPath);
            if (extractor) {
              const ext2 = extractor as any;
              const result = await ext2.extract(tempPath);
              fileText = result.body || "";
              extractionNote = `[Extracted via ${ext2.id} extractor from ${f.name}]`;
            } else {
              // No extractor — fall back to utf-8 (works for .md/.txt/.json/.csv).
              fileText = buffer.toString("utf-8");
              extractionNote = `[Decoded as utf-8 — no extractor for .${ext}]`;
            }
          } finally {
            try { unlinkSync(tempPath); } catch { /* tmp cleanup best-effort */ }
          }
        } catch (e: any) {
          fileText = `[Failed to read attachment: ${e.message}]`;
          extractionNote = `[Extraction error for ${f.name}]`;
        }
        const fileDesc = `\n\n--- File: ${f.name} ---\n${extractionNote}\n${fileText}\n--- End of ${f.name} ---\n`;
        contentParts.push({ type: "text", text: fileDesc });
      }
    }
    userMessage = { role: "user", content: contentParts };
  } else {
    userMessage = { role: "user", content: prompt };
  }

  // First turn OR process restarted (caches are null) — rebuild everything
  const isFirstTurn = getHistory().length === 0 || !_sysPromptCache;

  let sysContent: string, contextBlockBase: string;

  if (isFirstTurn) {
    // ── First turn: build full system prompt, cache everything ──
    const sysPrompt = await buildSystemPrompt(enabledSkills, agentName, prompt, kbEnabled, isPlanMode, webSearchEnabled, true, model);
    sysContent = sysPrompt.content;
    contextBlockBase = sysPrompt.contextBlock || "";

    // ── Stable system content (no dynamic injections — cacheable) ──
    // ── Inject Agent & AskUserQuestion tool awareness (stable per session) ──
    if (!sysContent.includes("AskUserQuestion")) {
      sysContent += `\n\n**AskUserQuestion:** You can ask the user up to 4 multiple-choice questions when you need clarification. Use this instead of guessing. The user will see a dialog and respond.`;
    }
    if (!sysContent.includes("`Agent`")) {
      sysContent += `\n\n**Agent (Sub-Agent):** You can launch sub-agents (\`Agent\` tool) for parallel independent work. Sub-agents have access to file_read, file_write, file_edit, grep, glob, bash, web_search, web_fetch, git tools, skills and memory/KB tools — they CAN modify files, so delegate only genuinely independent tasks. Use them to search for information in parallel while you continue other work. A sub-agent returns a single text result. Example: \`Agent(description="search AI news", prompt="Search the web for the latest AI news this week and summarize the top 3 stories.")\``;
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

    _sysPromptCache = sysContent;
    _contextBlockBaseCache = contextBlockBase;
  } else {
    // ── Turn 2+: use cached system prompt (already has KB/AGENTS.md from turn 1) ──
    sysContent = _sysPromptCache!;
    contextBlockBase = _contextBlockBaseCache ?? "";
  }

  // ── Build dynamic context block on top of cached base ──
  const contextExtraMsgs: LoopMessage[] = [];
  // `contextBlock` keeps the combined string for continuation snapshot
  let contextBlock = contextBlockBase;

  const activeTasks: any[] = Array.from(taskStore.values()).filter((t: any) => t.status !== "completed" && t.status !== "deleted");
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
  } catch (e: any) {
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
  let msgs: LoopMessage[] = [{ role: "system", content: sysContent }];
  if (contextBlockBase && contextBlockBase.trim()) {
    msgs.push({ role: "user", content: contextBlockBase.trim() });
  }
  msgs.push(...history.map(m => ({ ...m })));
  msgs.push(...contextExtraMsgs);
  msgs.push(userMessage);
  // Index of this turn's user message — the mid-turn checkpoint below must
  // only snapshot from here onward (msgs[0..history] is prior/context, and
  // contextExtraMsgs are injected user-role blocks that must not be saved
  // as real conversation history).
  const currentTurnMsgStart = msgs.length - 1;
  let allText = "", allReasoning = "";
  // ── Output layering ──
  // allText is the raw concatenation of every turn's content (kept for the
  // API-context history). For DISPLAY/SAVE we split it at the last tool call:
  //   toolBoundary   = index in allText right after the last turn that had
  //                    tool_calls (the renderer flushes its narration into the
  //                    thinking block at that same tool:start event)
  //   text before it = process narration (goes to reasoning_content)
  //   text after it  = the final answer (goes to `content`)
  let toolBoundary = 0;
  let continuation = 0;
  let agentFinished = false;
  const mainToolCalls: Array<{ id: string, name: string, args?: any, result?: any }> = [];
  // ── P0 fix: rebuild context block from LIVE state on every continuation. ──
  // Previously this was a single-shot snapshot, so any task/todo changes that
  // happened mid-conversation were lost when the context was rebuilt.
  const buildContextMsg = (): LoopMessage | null => {
    const liveActive: any[] = Array.from(taskStore.values()).filter((t: any) => t.status !== "completed" && t.status !== "deleted");
    const liveTodos = getTodoList();
    const liveUnverified: any[] = Array.from(taskStore.values()).filter((t: any) => t.unverified === true);
    const parts: string[] = [];
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
    let webSearchCalls = 0;       // time-sensitive guard: force ≥5 searches before final answer
    let recencyNudges = 0;

    if (continuation > 1) {
      const banner = `\n\n--- 第 ${continuation} 次自动继续 ---\n`;
      allText += banner;
      sdr("stream:chunk", { text: banner });
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
      // Hoist callSignal so the CONTEXT_SIZE_EXCEEDED retry path in the
      // catch block can reuse the same composed abort signal.
      const callSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(LLM_CALL_TIMEOUT)])
        : AbortSignal.timeout(LLM_CALL_TIMEOUT);
      try {
        const callFn = apiFormat === "anthropic" ? anthropicCall : openaiCall;
        const result = await callFn(msgs, apiUrl, apiKey, model, callSignal, reasoning, kbEnabled, webSearchEnabled, silent);
        content = result.content;
        reasoningContent = /** @type {any} */ (result).reasoningContent || "";
        allText += result.content;
        if (reasoningContent) allReasoning += reasoningContent;
        tcs = result.tcs;
        // A turn with tool calls ends a "process narration" segment: the
        // renderer flushes everything streamed so far into the thinking block
        // when tool:start fires, so mirror that boundary here for save/reload.
        if (tcs.length > 0) toolBoundary = allText.length;
        // B1: capture finishReason so we can detect length-truncated responses
        // and recover by asking the model to continue instead of accepting
        // the truncated tail as a final answer.
        finishReason = /** @type {any} */ (result).finishReason || null;
        if (finishReason === "length") {
          console.warn(`[agent-loop] response truncated by finish_reason=length (content=${content.length} chars, tcs=${tcs.length}). Will request continuation.`);
        }
        // ── Log cache metrics & forward to UI ──
        if (result.usage) {
          const u: any = result.usage;
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
      } catch (err: any) {
        if (err.name === "AbortError") {
          hookManager.fire("SessionEnd", { sessionId: getSessionId(), aborted: true }).catch(() => {});
          // Persist prior turns + this user message + whatever partial text
          // streamed before Stop — otherwise reload shows only the placeholder
          // (or an older snapshot) and the interrupted answer vanishes.
          await persistPartialTurn(allText, allReasoning, toolBoundary, mainToolCalls);
          return { text: splitStreamText(allText, allReasoning, toolBoundary).bodyText, aborted: true };
        }
        // Handle context size exceeded - compress and retry
        if (err.type === 'CONTEXT_SIZE_EXCEEDED' && err.detectedContextWindow) {
          console.log(`[agent-loop] Context size exceeded. Detected window: ${err.detectedContextWindow}. Compressing and retrying...`);
          
          // Force compress context to 50% of detected window. Use 50% (not 60%)
          // because our token estimation doesn't count tool_defs or the prompt
          // template overhead — the API-side real token count is always higher.
          const targetTokens = Math.floor(err.detectedContextWindow * 0.5);
          let compressAttempt = 0;
          const MAX_COMPRESS_ATTEMPTS = 3;
          
          // Send warning to user
          sdr("stream:chunk", { text: `⚠️ 上下文超出限制，正在自动压缩后重试...\n`, done: false });
          
          // Compress hard + verify the estimate dropped below target before retrying.
          while (compressAttempt < MAX_COMPRESS_ATTEMPTS) {
            compressAttempt++;
            compressContext(msgs, targetTokens);
            const afterCompress = estimateMessageTokens(msgs);
            console.log(`[agent-loop] Compress attempt ${compressAttempt}: ${afterCompress.totalTokens} tokens (target ${targetTokens})`);
            if (afterCompress.totalTokens <= targetTokens) break;
            // Still over target — cut deeper: drop tool results entirely then retry.
            for (const m of msgs) {
              if (m.role === "tool" && typeof m.content === "string" && estimateTokens(m.content) > 1000) {
                m.content = m.content.slice(0, 500) + "\n...(工具输出已截断)...";
              }
            }
          }
          
          // Retry the call — use a FRESH timeout signal. The original
          // `callSignal`'s 5-minute AbortSignal.timeout may be nearly spent
          // after the first (failed) call, so reusing it could abort the
          // retry almost immediately.
          try {
            const retrySignal = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(LLM_CALL_TIMEOUT)])
              : AbortSignal.timeout(LLM_CALL_TIMEOUT);
            const retryCallFn = apiFormat === "anthropic" ? anthropicCall : openaiCall;
            const retryResult = await retryCallFn(msgs, apiUrl, apiKey, model, retrySignal, reasoning, kbEnabled, webSearchEnabled, silent);
            content = retryResult.content;
            reasoningContent = retryResult.reasoningContent || "";
            tcs = retryResult.tcs;
            finishReason = retryResult.finishReason || null;
            allText += retryResult.content;
            if (reasoningContent) allReasoning += reasoningContent;
            if (tcs.length > 0) toolBoundary = allText.length;
          } catch (retryErr: any) {
            // If retry also fails, throw original error
            console.error(`[agent-loop] Retry also failed:`, retryErr.message);
            await persistPartialTurn(allText, allReasoning, toolBoundary, mainToolCalls);
            throw err;
          }
        } else {
          await persistPartialTurn(allText, allReasoning, toolBoundary, mainToolCalls);
          throw err;
        }
      }

      const asst: LoopMessage = { role: "assistant", content: content || null };
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
        const unverified: any[] = Array.from(taskStore.values()).filter((t: any) => t.unverified === true);
        const activeTasks: any[] = Array.from(taskStore.values()).filter((t: any) => t.status === "in_progress" || t.status === "pending");
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
          msgs.push({ role: "user", content: "⚠️ 你还没调用任何工具就准备结束。用户的要求是操作性任务（不是纯聊天），请先用 file_read / bash / grep / web_search 等工具获取信息或执行操作，再回答。如果你不确定要做什么，请用 AskUserQuestion 向用户确认。" });
          turns++;
          continue;
        }
        // Recency guard: 昨天/最近/news-style prompts must not finish after
        // 2-3 shallow searches — that is how stale/fake answers slip through.
        const wantsRecency = webSearchEnabled && /(昨天|今日|今天|昨日|最近|最新|近期|刚刚|新闻|快讯|时事|yesterday|today|latest|recent|breaking|this\s+(week|month)|news)/i.test(prompt || "");
        const RECENCY_MIN_SEARCHES = 5;
        if (wantsRecency && webSearchCalls < RECENCY_MIN_SEARCHES && recencyNudges < 3 && turns < MAX_TURNS - 2) {
          recencyNudges++;
          msgs.push({
            role: "user",
            content: `⚠️ 时效性/新闻类问题证据不足：目前 ${webSearchCalls}/次 web_search（要求 ≥${RECENCY_MIN_SEARCHES}），且核心断言须有 ≥2 个不同 hostname 独立源一致（重大结论 ≥3 源 + 1 个一手/权威源）。请继续：① 换角度再搜（query 带当前日期，可传 days）；② 核对 published_date 与 hostname 多样性（同站多篇/转载只算 1 源）；③ 源冲突则再搜或并列标注"未证实"；④ 不足 2 独立源时用"仅见 X 报道"降级表述，禁止把单源当已证实事实。核够再给最终答案。`,
          });
          turns++;
          continue;
        }
        agentFinished = true;
        break;
      }
      toolsCalledThisTurn += tcs.length;
      webSearchCalls += tcs.filter((tc) => tc.function?.name === "web_search").length;

      // ── Execute tools (Agent calls in parallel, others sequential) ──
      const agentCalls = tcs.filter(tc => tc.function?.name === "Agent");
      const otherCalls = tcs.filter(tc => tc.function?.name !== "Agent");

      if (agentCalls.length > 0) {
        for (const tc of agentCalls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
          sdr("tool:start", { name: "Agent", args, toolCallId: tc.id });
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
          let aArgs;
          try { aArgs = JSON.parse(tc.function.arguments); } catch { aArgs = { raw: tc.function.arguments }; }
          let rStr = JSON.stringify(result);
          if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
          sdr("tool:result", { name: "Agent", result, toolCallId: tc.id });
          mainToolCalls.push({ id: tc.id, name: "Agent", args: aArgs, result });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
          hookManager.fire("PostToolUse", { tool: "Agent", result }).catch(() => {});
        }
      }

      for (const tc of otherCalls) {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = { raw: tc.function.arguments }; }
        sdr("tool:start", { name: tc.function.name, args, toolCallId: tc.id });

        let result: any;
        try { result = await runTool(tc); } catch (e: any) { result = { error: e.message }; }

        let rStr = JSON.stringify(result);
        if (rStr.length > MAX_OUTPUT) rStr = rStr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
        sdr("tool:result", { name: tc.function.name, result, toolCallId: tc.id });
        mainToolCalls.push({ id: tc.id, name: tc.function.name, args, result });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: rStr });
        hookManager.fire("PostToolUse", { tool: tc.function.name, result }).catch(() => {});

        // P3方案A: if view_image returned image data, inject it as a separate
        // user message with an image_url content block so the LLM can SEE it
        // on the next call. The tool message above just carries the metadata
        // (path/size), the actual base64 image is injected here. Anthropic
        // adapter (format-adapters.mjs:76-78) converts image_url → image block.
        // OpenAI-compatible APIs (incl. MiniMax /anthropic) accept this natively.
        if (result?.type === "image" && result?.data && result?.media_type) {
          if (supportsVision(model)) {
            msgs.push({
              role: "user",
              content: [{
                type: "image_url",
                image_url: { url: `data:${result.media_type};base64,${result.data}` },
              }],
            });
          } else {
            // Non-vision model can't consume the image block — persist the
            // image to a temp file and point the model at vision-bridge so it
            // can still "see" what view_image found.
            const saved = saveImageAttachment({
              name: `view-${Date.now()}.${result.media_type.split("/")[1] || "png"}`,
              dataUrl: `data:${result.media_type};base64,${result.data}`,
            });
            if (saved) {
              const visionCmd = VISION_BRIDGE_SCRIPT
                ? `如需查看内容，请使用 vision-bridge 技能：python "${VISION_BRIDGE_SCRIPT}" --image "${saved.path}" --prompt "请描述这张图片的内容"\n`
                : `（本机未检测到 vision-bridge 技能脚本，无法自动描述图片内容）\n`;
              msgs.push({
                role: "user",
                content: `[view_image 结果] 图片已保存到：${saved.path}\n${visionCmd}`,
              });
            } else {
              msgs.push({
                role: "user",
                content: `[view_image 结果] 图片数据已返回（${result.media_type}，${((result.data.length * 3) / 4 / 1024).toFixed(0)}KB base64），但当前模型不支持直接读取图片。图片路径：${result.description || "(unknown)"}\n`,
              });
            }
          }
        }

        // P3: turn-level checkpoint — every 5 turns persist the current
        // history snapshot so a crash mid-task can be resumed. Cap the
        // snapshot at 200 messages to keep the DB write fast.
        //
        // Base = priorTurnsSnapshot (full DB history at agentLoop start,
        // INCLUDING prior turns' tool rows). The old code saved only
        // user/assistant rows sliced from `msgs`, and saveSession DELETEs
        // then re-inserts — so a mid-task checkpoint used to wipe every
        // prior tool entry (and injected context-block user messages).
        if (turns % 5 === 0 && sessionId) {
          try {
            const currentTurnMsgs = msgs
              .slice(currentTurnMsgStart)
              .filter(m => m.role === "user" || m.role === "assistant")
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
            const histSnapshot = [...priorTurnsSnapshot, ...currentTurnMsgs].slice(-200);
            await sessionDb.saveSession(sessionId, histSnapshot, getHistoryTitle(histSnapshot), sessionRuntime);
            sessionDb.saveTurnProgress(sessionId, {
              currentTurn: turns,
              maxTurns: MAX_TURNS,
              currentContinuation: continuation,
              maxContinuations: MAX_CONTINUATIONS,
              lastSummary: "",
            });
          } catch (e: any) {
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
      // Don't cut mid-tool-pair: if the window starts on a tool row, extend
      // back to the assistant that declared it (bounded by the system msg).
      // A start index of 0 would duplicate sysMsg — min bound is 1.
      let recentStart = Math.max(1, msgs.length - 6);
      while (recentStart > 1 && msgs[recentStart]?.role === "tool") recentStart--;
      const recentMsgs = msgs.slice(recentStart);
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
        } catch (e: any) {
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
  //   1. pull <think>…</think> blocks out of each segment and merge them into
  //      `allReasoning` (preferring the API field if both are present)
  //   2. write the cleaned `content` so reload and live chat render identically
  //   3. split at `toolBoundary`: narration before the last tool call is
  //      PROCESS text → reasoning_content; only the answer tail → content
  //      (mirrors the renderer flushing narration into thinking on tool:start)
  const { bodyText, reasoningText: combinedReasoning } = splitStreamText(allText, allReasoning, toolBoundary);
  const historyAsst: LoopMessage = { role: "assistant", content: bodyText };
  if (combinedReasoning) historyAsst.reasoning_content = combinedReasoning;
  if (process.env.DEBUG_REASONING === "1") {
    console.log(`[reasoning-debug] agent-loop end: allReasoning.length=${allReasoning.length}, allText.length=${allText.length}, toolBoundary=${toolBoundary}, bodyText.length=${bodyText.length}, combinedReasoning.length=${combinedReasoning.length}`);
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

      const body: any = {
        model: model || "deepseek-chat",
        messages: [{ role: "user", content: compactPrompt }],
        max_tokens: 2048,
        stream: false,
      };
      const endpoint = apiFormat === "anthropic"
        ? apiUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "") + "/v1/messages"
        : apiUrl;
      const headers: Record<string, string> = apiFormat === "anthropic"
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
      } as RequestInit);
      if (res.ok) {
        const data = await res.json();
        summary = apiFormat === "anthropic"
          ? (data.content?.[0]?.text || "")
          : (data.choices?.[0]?.message?.content || "");
      }
    } catch (e: any) {
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
          getHistoryTitle(recent),
          sessionRuntime
        );
        sessionDb.updateTitle(parentId, getHistoryTitle(recent));
        recent.unshift({ role: "user", content: `## 📋 对话摘要\n\n${summary}` });
      } catch (e: any) { console.error("[compress]", e.message); }
    }

    setHistory(recent);
  }

  // Auto-save after each turn. priorTurnsSnapshot is the DB history from
  // before this turn (incl. tool rows) — saveSession DELETEs then re-inserts,
  // so omitting those tools would wipe them every turn.
  const finalSessionId = getSessionId();
  if (finalSessionId && !partialTurnPersisted) {
    const saveHistory = buildTurnHistory({
      priorTurns: priorTurnsSnapshot,
      prompt,
      files,
      tools: mainToolCalls,
      assistantContent: bodyText,
      assistantReasoning: combinedReasoning || undefined,
    });
    const title = getHistoryTitle(saveHistory);
    saveSession(finalSessionId, saveHistory, title).catch(() => {});
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
        const suggestions = await skills.detectPatterns(sessionDb as any);
        if (Array.isArray(suggestions) && suggestions.length > 0) {
          sdr("agent-skill:patterns-detected", { suggestions });
        }
      } catch (e: any) {
        console.error("[agent-loop] detectPatterns failed:", e?.message);
      }
    })();
  }
  return { text: bodyText || "(no text response)" };
}

export function resetPromptCache() {
  _sysPromptCache = null;
  _contextBlockBaseCache = null;
}

/**
 * Drive a single prompt turn through the local OpenCode ACP subprocess.
 * Skips the cloud-API loop entirely; opencode handles model, KB, skills, tools,
 * MCP on its side. We translate `session/update` notifications into the same
 * `stream:*` channels the renderer already knows.
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array<any>} [args.files]
 * @param {boolean} args.silent
 * @param {string} args.sessionId
 * @param {"aide"|"opencode"} args.sessionRuntime
 * @param {(id: string, history: Array<any>, title: string) => Promise<void>} args.saveSession
 * @param {(channel: string, data: any) => void} args.sdr
 * @param {boolean} [args.isPlanMode]
 * @param {AbortSignal} [args.signal]
 * @param {string|null} [args.opencodeModelId]
 * @returns {Promise<{ text: string }>}
 */
async function runOpencodeAcp({ prompt, files = [] as any[], silent, sessionId, sessionRuntime, saveSession, sdr, signal, isPlanMode = false, opencodeModelId, priorTurnsSnapshot = [] as LoopMessage[] }: {
  prompt: string;
  files?: any[];
  silent?: boolean;
  sessionId: string | null;
  sessionRuntime: string;
  saveSession: (id: string, history: LoopMessage[], title: string) => Promise<void>;
  sdr: (channel: string, data: any) => void;
  signal?: AbortSignal;
  isPlanMode?: boolean;
  opencodeModelId?: string | null;
  priorTurnsSnapshot?: LoopMessage[];
}): Promise<{ text: string, aborted?: boolean }> {
  const { OpencodeAcpClient } = await import("./opencode-acp-client.ts");
  const { detectOpencode } = await import("./opencode-detector.ts");

  // 1. Locate the opencode binary. If it's not installed, surface as a stream
  // error so the renderer's onStreamError handler can show a friendly message
  // and the user can install via the existing install-guide modal.
  const detection = await detectOpencode();
  if (!detection.installed || !detection.path) {
    sdr("stream:error", { message: "opencode 未检测到，请先安装 OpenCode CLI（参考上方安装提示）" });
    return { text: "" };
  }
  if (!detection.available) {
    sdr("stream:error", { message: `opencode 二进制无法执行 (version=${detection.version}, reason=${detection.reason})` });
    return { text: "" };
  }

  // 2. Build the ACP prompt. We send a content-block array (per ACP v1 spec):
  //    - text block for the user's prompt text (optionally with file contents
  //      inlined as `--- File: name ---\n...\n--- End ---` so opencode doesn't
  //      need to call file_read to access the data)
  //    - image blocks for images (if agent advertises `image` capability)
  //
  // Why inline text instead of using `resource` or `resource_link`?
  // Empirical testing with opencode v1.17.9 + Ollama shows:
  //   - `{type:"resource", text:...}` (embedded text) works syntactically but
  //     the model often only emits `agent_thought_chunk` and no visible text.
  //   - `{type:"resource_link", uri:"file://..."}` causes opencode to short-
  //     circuit the turn with `end_turn` and zero chunks (likely because
  //     reading an outside-cwd temp file requires a `permission:request` that
  //     we don't surface to the user).
  //   - Inlining text into the prompt works reliably with both cloud and local
  //     models — matches what the AideAgent runtime does (see core/agent-
  //     loop.mjs lines 240-262 in the cloud code path).
  const promptBlocks = [];
  let inlineText = String(prompt || "");
  // Plan mode: prepend a directive telling opencode to only plan, not execute.
  // We append the directive LAST so the user's actual question stays first;
  // this matches how Claude Code's own plan mode injects instructions.
  if (isPlanMode) {
    inlineText +=
      "\n\n[系统提示：当前处于计划模式。请仅输出可执行的实施计划，"
      + "不要调用任何会修改文件或执行命令的工具。"
      + "等待用户确认后再开始动手。]";
  }
  // File handling strategy:
  //   - Text files (.md/.txt/.js/.json/...) → inline into the prompt text.
  //     Reliable across cloud + local models; matches the AideAgent runtime.
  //   - Binary files (PDF/ZIP/.exe/UTF-8-invalid) + images → defer to
  //     `client.buildFileBlocks()` after `start()`, which uses {type:"image"}
  //     blocks for images (when agent supports it) or writes a temp file and
  //     emits a resource_link (when it doesn't). The temp dir is cleaned up
  //     in the finally block below via `client.cleanupFileBlocks()`.
  //   - Anything `buildFileBlocks` drops (e.g. empty payload, temp write
  //     failure) is surfaced to the user via `stream:error` so silent drops
  //     can't happen.
  const binaryFiles: Array<{ name: string, type: string, dataUrl: string, size?: number }> = [];
  if (Array.isArray(files) && files.length > 0) {
    for (const file of files) {
      const mime = file.type || "application/octet-stream";
      const dataUrl = file.dataUrl || "";
      const commaIdx = dataUrl.indexOf(",");
      const base64Payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : "";
      if (!base64Payload) continue;
      // Images and anything that fails UTF-8 decoding go through
      // buildFileBlocks (image blocks + resource_link fallback). Text
      // files stay inline.
      if (mime.startsWith("image/")) {
        binaryFiles.push({ name: file.name, type: mime, dataUrl, size: file.size });
        continue;
      }
      let text;
      try {
        text = Buffer.from(base64Payload, "base64").toString("utf-8");
        // Detect replacement chars from invalid UTF-8 — treat as binary.
        // toString("utf-8") doesn't throw on bad bytes; it emits U+FFFD.
        // A file with >1% replacement chars is almost certainly binary.
        if (text.length > 0) {
          const fffd = (text.match(/\uFFFD/g) || []).length;
          if (fffd / text.length > 0.01) {
            binaryFiles.push({ name: file.name, type: mime, dataUrl, size: file.size });
            continue;
          }
        }
      } catch {
        binaryFiles.push({ name: file.name, type: mime, dataUrl, size: file.size });
        continue;
      }
      const MAX_INLINE = 50 * 1024;
      if (text.length > MAX_INLINE) {
        text = text.slice(0, MAX_INLINE) + `\n\n…(truncated, ${text.length - MAX_INLINE} more bytes)`;
      }
      inlineText += `\n\n--- File: ${file.name} ---\n${text}\n--- End of ${file.name} ---`;
    }
  }
  if (inlineText) promptBlocks.push({ type: "text", text: inlineText });

  // 3. Spawn + initialize the ACP client.
  //
  // REUSE POLICY: a cached `OpencodeAcpClient` (kept in module state by
  // state.mjs) survives across consecutive prompts in the same session.
  // Without this, every user message spawns a fresh subprocess + session,
  // losing all prior conversation context — this was the bug fixed in v1.29.
  //
  // We reuse when the cached client is alive AND nothing about the
  // environment changed that requires a fresh process:
  //   - cached._sessionId must exist (start() completed)
  //   - opencode binary path must still match the detected one (rare —
  //     covers reinstalls / multi-version PATH)
  //   - cwd must still match (user switched workspace mid-session)
  //   - if modelId changed, we apply it via session/set_config_option on
  //     the existing session instead of spawning a new one.
  //
  // When reusing, we skip start() and the modelId is applied via
  // `applyModelIfNeeded` below. When the cache is stale/missing, we spawn
  // a fresh client and run the full handshake.
  const cached = getOpencodeAcpClient();
  const targetCwd = getWorkspace() || process.cwd();
  // isOpencodeAcpClientAlive() returns false when `cached` is null, but TS
  // can't see through the optional default → narrow explicitly.
  const cachedAlive = cached !== null && isOpencodeAcpClientAlive(cached);
  const canReuse = cachedAlive
    && cached.binPath === detection.path
    && cached.cwd === targetCwd
    && cached._sessionId;

  /** @type {import("./opencode-acp-client.ts").OpencodeAcpClient} */
  let client;
  let clientOwnedByCache = false;  // true if we created a new client this turn

  if (canReuse && cached) {
    // Reuse path: keep the subprocess + ACP session alive across prompts so
    // the agent sees the full conversation context.
    client = cached;
    console.log(`[runOpencodeAcp] reusing cached ACP client (sessionId=${cached._sessionId}, modelId=${cached.modelId})`);
    // Push the prompt blocks via the existing session. The model's existing
    // context (prior turns) is preserved server-side because the ACP session
    // is the same.
  } else {
    // Cold path: spawn a fresh subprocess + initialize + session/new.
    // If a stale cached client exists (dead OR alive-but-not-reusable, e.g.
    // different binPath/cwd or no session), tear it down before replacing so
    // we don't leak the old subprocess.
    if (cached && !canReuse) {
      try { await cached.stop(); } catch { /* ignore */ }
      setOpencodeAcpClient(null);
    }
    client = new OpencodeAcpClient({
      binPath: detection.path,
      cwd: targetCwd,
      clientInfo: { name: "AideAgent", version: "1.0.0" },
      modelId: opencodeModelId || null,
    });
    setOpencodeAcpClient(client);
    clientOwnedByCache = true;

    // Surface ACP results to the renderer as soon as start() resolves so the
    // model picker can populate even before the first prompt completes.
    client.on("ready", (info) => {
      sdr("opencode:ready", {
        models: info.models || [],
        modes: info.modes || [],
        configOptions: info.configOptions || [],
        sessionId: info.sessionId,
        // Echo the user-selected modelId back so the renderer can mark it
        // active even if opencode's "currentModelId" field is absent.
        currentModelId: opencodeModelId || (info.currentModelId ?? null),
      });
    });
  }

  // 4. Wire event translators. We accumulate text + reasoning so we can
  //    persist them into the session DB the same way the cloud path does.
  //    `allHistory` captures the full conversation including tool calls so
  //    session reload shows the complete chain — not just first+last message.
  //
  //    CRITICAL — LISTENER LEAK FIX (added with ACP session reuse):
  //    When the client is reused across turns, every previously-registered
  //    listener is still attached. EventEmitter.on() appends, not replaces,
  //    so each turn's registration would stack on top of the previous one.
  //    Symptom: turn 1 normal, turn 2 each chunk fires 2x, turn 3 each
  //    chunk fires 3x — text appears duplicated/tripled/etc. in the
  //    renderer. Remove existing listeners for these events before
  //    re-registering so each turn has exactly one set.
  client.removeAllListeners("text-chunk");
  client.removeAllListeners("reasoning-chunk");
  client.removeAllListeners("tool-start");
  client.removeAllListeners("tool-result");
  client.removeAllListeners("auth-required");
  client.removeAllListeners("permission-request");

  let allText = "";
  let allReasoning = "";
  const allHistory: Array<{ role: string, content: string, tool_name?: string, tool_args?: string, tool_result?: string }> = [];
  const toolCalls: Array<{ id: string, name: string, args?: any, result?: any }> = [];
  let aborted = false;
  let authFailed = false;

  client.on("text-chunk", (chunk) => {
    if (aborted) return;
    allText += chunk;
    sdr("stream:chunk", { text: chunk });
  });
  client.on("reasoning-chunk", (chunk) => {
    if (aborted) return;
    allReasoning += chunk;
    sdr("stream:reasoning", { text: chunk });
  });
  client.on("tool-start", (e) => {
    if (aborted) return;
    const id = e.toolCallId || String(toolCalls.length);
    toolCalls.push({ id, name: e.name, args: e.args });
    sdr("tool:start", { name: e.name, args: e.args || {}, toolCallId: id });
  });
  client.on("tool-result", (e) => {
    if (aborted) return;
    // Prefer toolCallId so parallel/out-of-order results mark the right entry.
    let matched = e.toolCallId
      ? toolCalls.find((t) => t.id === e.toolCallId && !t.result)
      : undefined;
    if (!matched) {
      matched = [...toolCalls].reverse().find((t) => t.name === e.name && !t.result);
    }
    if (matched) matched.result = e.result;
    else toolCalls.push({ id: e.toolCallId || String(toolCalls.length), name: e.name, result: e.result });
    sdr("tool:result", { name: e.name, result: e.result, toolCallId: e.toolCallId || matched?.id });
  });
  client.on("auth-required", (e) => {
    // opencode needs `opencode auth login` run in a terminal. Surface a
    // clear, actionable error instead of letting the session fail with a
    // cryptic "opencode exited" a few seconds later.
    authFailed = true;
    sdr("stream:error", {
      message: `OpenCode 需要登录后才能使用。请在终端运行：opencode auth login（认证方式：${(e.authMethods || []).map((m: any) => m.id).join(", ")}）`,
    });
  });
  client.on("permission-request", (e) => {
    // Auto-approved by the ACP client (see _onMessage in
    // opencode-acp-client.mjs). Forward to the UI for visibility only —
    // the response has already been sent back to the agent so the turn
    // keeps moving. A future iteration can surface an interactive approve/
    // deny dialog instead of auto-approving.
    if (aborted) return;
    sdr("permission:request", {
      id: e.id,
      toolCallId: e.toolCallId,
      kind: e.kind || "",
      title: e.title || "",
      options: e.options || [],
      approved: e.approved || "",
    });
  });

  // 5. Hook abort signal → cancel the ACP turn.
  const onAbort = () => {
    aborted = true;
    try { client.cancel(); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // 6. Drive the prompt turn.
  // `persistSession` gates the finally-block save: we want to save on the
  // success path AND on the error path (so partial responses survive a
  // subprocess crash), but NOT on user-initiated abort (the user chose to
  // discard). Default true; abort paths flip it to false before returning.
  // `fileTempDir` tracks any temp directory created by buildFileBlocks so
  // the finally block can clean it up on every exit path.
  let persistSession = true;
  let fileTempDir = null;
  try {
    await client.start();
    sdr("session:update", { sessionId });

// After start() the agent has advertised its prompt capabilities via
    // `initialize`. Now we can route binaryFiles (images + non-text
    // attachments) through buildFileBlocks, which uses {type:"image"} when
    // the agent supports it or writes a temp file + resource_link otherwise.
    // Any file buildFileBlocks drops (e.g. empty payload) is surfaced to the
    // user — no silent drops.
    if (binaryFiles.length > 0) {
      const { blocks, tempDir, dropped } = client.buildFileBlocks(binaryFiles);
      fileTempDir = tempDir;
      for (const b of blocks) promptBlocks.push(b);
      for (const d of dropped) {
        sdr("stream:error", {
          message: `附件 "${d.name}" 未发送：${d.reason}`,
          nonFatal: true,
        });
      }
    }

    // Mid-conversation model switch: if the user picked a different model
    // between turns (or this is the very first prompt but a modelId was
    // supplied), apply it via session/set_config_option before sending.
    // Required because session/new silently ignores modelId in opencode
    // v1.17.x — set_config_option is the only reliable path. See
    // opencode-acp-client.mjs _start() for the same pattern on cold start.
    if (opencodeModelId && client.modelId !== opencodeModelId) {
      try {
        await client._request?.("session/set_config_option", {
          sessionId: client._sessionId,
          configId: "model",
          value: opencodeModelId,
        });
        client.modelId = opencodeModelId;
        console.log(`[runOpencodeAcp] switched model mid-session to ${opencodeModelId}`);
      } catch (e: any) {
        console.warn(`[runOpencodeAcp] model switch to ${opencodeModelId} failed: ${e.message}`);
        sdr("stream:error", {
          message: `切换模型到 ${opencodeModelId} 失败：${e.message}（继续使用当前模型）`,
          nonFatal: true,
        });
      }
    }

    const { stopReason } = await client.sendPrompt(promptBlocks);
    if (stopReason === "cancelled" || aborted) {
      hookManager.fire("SessionEnd", { sessionId, aborted: true }).catch(() => {});
      // Still persist prior turns + partial text so Stop doesn't wipe history.
      persistSession = true;
      return { text: allText, aborted: true };
    }
    hookManager.fire("SessionEnd", { sessionId, aborted: false }).catch(() => {});
  } catch (err: any) {
    if (err.name === "AbortError" || aborted) {
      hookManager.fire("SessionEnd", { sessionId, aborted: true }).catch(() => {});
      persistSession = true;  // keep prior turns + partial answer on disk
      return { text: allText, aborted: true };
    }
    sdr("stream:error", { message: err.message || String(err) });
    // Keep persistSession = true — partial text from a crashed session is
    // still worth saving so the user doesn't lose everything on reload.
    return { text: allText };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    // CRITICAL: only stop the client if it's no longer alive OR we just
    // created it on the cold path and the subprocess crashed mid-turn.
    // On the reuse path we deliberately keep the subprocess alive so the
    // next user message in the same session sees the full conversation.
    if (clientOwnedByCache) {
      // Cold path this turn: client is "ours" for now. Keep it cached for
      // the next prompt UNLESS it died during the turn. On the next call,
      // canReuse will be false (because isOpencodeAcpClientAlive() returns
      // false) and we'll spawn fresh — but at least the user gets one good
      // turn on the cold path. If the client died, evict it so we don't
      // hand a dead instance to the next caller.
      if (!isOpencodeAcpClientAlive(client)) {
        try { await client.stop(); } catch { /* ignore */ }
        setOpencodeAcpClient(null);
        console.log("[runOpencodeAcp] cold-path client died during turn, evicted from cache");
      }
      // else: alive → keep in cache for the next prompt
    } else {
      // Reuse path: explicitly do NOT stop. The client is shared with future
      // prompts; tearing it down would defeat the whole point of caching.
      // If it's somehow dead, evict the cache so the next turn spawns fresh.
      if (!isOpencodeAcpClientAlive(client)) {
        setOpencodeAcpClient(null);
        console.log("[runOpencodeAcp] reused client died mid-turn, evicted from cache");
      }
    }
    // Clean up any temp dir created by buildFileBlocks (resource_link
    // fallback for binary files). Safe to call with null.
    try { client.cleanupFileBlocks(fileTempDir); } catch { /* ignore */ }
    // Persist to session DB so reload shows the same conversation. This runs
    // on every exit path where persistSession is true (success + error +
    // user abort — Stop must not wipe prior turns or the partial answer).
    if (persistSession) {
      try {
        // priorTurnsSnapshot = DB history before this turn (incl. tool rows).
        // saveSession DELETEs then re-inserts — getHistory() alone would wipe
        // prior turns' tool entries every opencode save.
        const saveHistory = buildTurnHistory({
          priorTurns: priorTurnsSnapshot,
          prompt,
          files,
          tools: toolCalls,
          assistantContent: allText || "",
          assistantReasoning: allReasoning || undefined,
        });
        const finalTitle = getHistoryTitle(saveHistory);
        if (sessionId) await saveSession(sessionId, saveHistory, finalTitle);
        // Keep in-memory history aligned with what we just wrote so the next
        // turn's context includes this exchange (tool rows stay DB-only,
        // matching aide's user+assistant getHistory() shape).
        const histNow = getHistory();
        histNow.push(
          { role: "user", content: prompt || (files && files.length > 0 ? `[${files.map(f => f.name).join(", ")}]` : "") },
          { role: "assistant", content: allText || "" },
        );
      } catch { /* don't let a save failure mask the real return */ }
    }
  }

  return { text: allText || "(no text response)" };
}
