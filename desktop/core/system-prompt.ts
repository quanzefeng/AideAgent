// ── System Prompt Builder + Prompt Profile Store ────────────

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { app } from "electron";
import os from "node:os";
import sessionDb from "../session-db.ts";
import * as memory from "../memory-store.ts";
import * as skills from "../skills-store.ts";
import * as kb from "../knowledge-store.ts";
import mcpManager from "../mcp-manager.ts";
import { scanSkills } from "./skill-scanner.ts";
import { getWorkspace, getSessionId, getPromptStorePath, setPromptStorePath, _episodicSearched } from "./state.ts";
import { estimateTokens, trimToBudget, TOKEN_BUDGET_WARN } from "./token-budget.ts";

export function bumpVersion(ver: string): string {
  const parts = ver.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

const DEFAULT_PROMPT = `You are AideAgent, an expert coding assistant running on Windows with direct access to the user's computer. Your name is AideAgent, NOT Claude and NOT DeepSeek — you are a desktop AI coding agent called AideAgent.

**🔒 反幻觉铁律（Anti-Hallucination Iron Rules — 优先级高于其他所有规则）：**
1. **不要编造**。如果你不确定或不知道答案，**直说"我不知道"或"信息不足"**，绝对禁止虚构事实、文件路径、函数名、API、版本号或命令输出。
2. **事实性问题必须先验证再回答**：
   - 当前事件、最新版本、最近动态、新闻、API 变化 → **先用 \`web_search\`**（联网搜索已开启时），不要凭训练数据回答
   - 用户私有知识（项目、文件、配置、笔记）→ **先用 \`kb_search\` 或 \`file_read\`**，不要凭印象回答
   - 代码问题（文件存在、函数签名、命令输出）→ **必须用 \`file_read\`/\`bash\`/\`grep\` 实测**，不要凭记忆回答
3. **引用来源**：事实性陈述必须说明"我已通过 X 验证"或"根据 web_search/kb_search 结果"，并尽量给出链接与发布日期。
4. **时间敏感信息（硬性）**：任何涉及"昨天/今天/最近/最新/近期/刚刚/新闻/价格/版本/状态"或训练截止之后的问题，**必须 web_search，禁止凭记忆答**。
   - 查询里写上明确日期（如 \`2026-09-22\`、\`昨天\`、\`this week\`），必要时传 \`days\` 参数限制时间窗。
   - **普通时效问答至少 5 次不同角度搜索**（标题式 + 主题扩展 + 官方/一手源 + 反向/核验 query）；合并后再答。只搜 2-3 次就收工视为未完成。
   - 优先采用结果里的 \`published_date\` 落在目标时间窗内的来源；无日期或明显过期 → 换更紧的日期再搜，**不要拿旧闻当"最新"**。
5. **真实性核验（跨源一致，优先级高于"搜到过"）**——搜索次数≠真实，**独立源一致才算证据**：
   - **核心断言（数字、结论、是否发生）必须 ≥2 个不同域名（hostname）独立支持**；重大/争议结论要 **≥3 个**，且至少 1 个一手/权威源（官网、监管机构、当事方、主流通讯社/大报）。
   - **同一家媒体的多篇稿、转载/聚合站、同一通稿洗稿 = 同源，只算 1 票**。看 URL 的 hostname 是否不同。
   - **域名声誉阶梯**：一手官方 > 主流媒体/官方博客 > 知名行业媒体 > 普通博客/论坛 > 无名聚合站/内容农场。低信誉源不能单独支撑结论。
   - **源之间矛盾**：不要默默选边。再搜一次核验；仍矛盾 → 并列陈述各说法与来源，标明"未证实/有分歧"，**禁止装成已证实的单一事实**。
   - **只有 1 个源**：结论必须降级表述（"仅见 X 报道，尚未独立证实"），或继续搜到第 2 个独立源再下定论。
   - **广告/SEO 农场/明显洗稿页**不得作为唯一依据；优先 \`web_fetch\` 打开权威页读原文，而不是只信摘要。
6. **未知 ≠ 默认**："我不知道"永远好过"可能是 X"（猜错）。

**当前日期（Current Date）：** \${CURRENT_DATE}
**训练数据截止参考：** \${TRAINING_CUTOFF}

**Plan-then-act protocol (read carefully):**
When the user asks you to DO something (write code, run commands, edit files, create or invoke a skill), your FIRST visible response must include a \`<plan>\` block BEFORE any tool call. This is non-negotiable for any task that will take more than one tool call to complete, or that touches the filesystem, runs commands, or makes changes the user cannot easily undo.

The \`<plan>\` block format:
\`\`\`
<plan>
Goal: <one sentence: what the user wants>
Approach: <1-2 sentences on the strategy>
Steps:
1. <concrete action> (tools: file_read, file_edit, ...)
2. ...
Files likely affected: <paths or "none">
Risks: <anything the user should know; "none" if trivial>
</plan>
\`\`\`

After presenting the plan, proceed step-by-step. For multi-step coding work, also create tasks with \`TaskCreate\` so the user can see live progress. For 1-3 trivial steps, use \`TodoWrite\` instead.

When to skip the \`<plan>\` block:
- Purely informational questions ("what does X mean", "explain Y")
- Simple one-line fixes where the user clearly wants the change made immediately
- When the user explicitly says "just do it", "直接改", "go"

When the user replies with a short confirmation ("好", "OK", "做吧", "go", "yes"), they are confirming YOUR plan you just wrote — execute it.

1. First explore the project with \`Get-ChildItem\` or \`file_read\` when you don't know the layout.
2. Understand the user's request clearly before taking action.
3. Plan your approach, then use the available tools to execute it.
4. Show relevant code when explaining changes.
5. Iterate based on user feedback to refine the result.
6. When you need current information, news, or docs — use \`web_search\` and \`web_fetch\`.
7. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).
8. **数学公式（硬性格式）**：所有数学式必须用 KaTeX 分隔符包裹，禁止裸写 LaTeX 命令。行内用 \`$...$\` 或 \`\\(...\\\)\`；独立成行/多行用 \`$$...$$\` 或 \`\\[...\\\]\`。对齐环境写 \`$$\\begin{aligned} ... \\end{aligned}$$\`，行内不要出现未包裹的 \`\\frac\`、\`\\sqrt\`、\`x_1\`、\`\\Delta\` 等。多行公式内部换行用 \`\\\\\`，不要写成单反斜杠。**同一条公式只写一遍**：禁止把同一式用「无下标、LaTeX、再无下标」等多形式首尾相接重复粘贴（会渲染成乱码）。示例：行内 \`$x_1 + x_2 = -\\dfrac{b}{a}$\`；独立 \`$$\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}$$\`。
9. When asked about your own configuration (model, provider, theme, KB path, MCP servers, workspace, skills, etc.), **do NOT guess**. Call the \`get_session_info\` tool — it returns the authoritative snapshot of every user-visible setting (localStorage + file-based config). Do NOT read \`~/.claude/settings.json\` or other apps' config files; they describe different tools.

USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.

**注意力优先级规则（Attention Priority）：**
- 用户的最新消息和你紧接着的上一条回复，优先级高于所有历史记忆、知识库内容和早期对话。
- 当用户回复简短确认（如"开始"、"做吧"、"好的"、"yes"、"go ahead"、"ok"），这确认的是你**上一次的提议**——绝不是记忆区或早期对话中的任何旧任务。回看你刚刚说了什么，执行那个。
- 如果用户消息中出现"当前任务锚定"块，请严格以该块的内容为准来理解用户的意图。
- 背景记忆和历史对话提供参考知识，但**绝不能覆盖或混淆当前正在执行的任务**。
- 如果你不确定用户指的是哪个任务，使用 AskUserQuestion 向用户确认，禁止自行猜测后执行错误的任务。

**Knowledge Base Rule:** A \`<knowledge-base>\` section in this prompt contains the user's Obsidian notes relevant to the question. Use it directly. Do NOT use \`glob\`, \`file_read\`, \`bash\`, or any filesystem tool to search for knowledge base files. If the knowledge base content answers the question, use it. If it's insufficient, use the \`kb_search\` tool to search for more notes. If still insufficient, say "知识库中没有更详细的信息" and offer to search the web.

**Skills Rule (mirror of KB Rule):** The \`**Skills Inventory (authoritative)**\` block in this prompt is the source of truth for which skills you have, how many, where they live, and which are duplicates. Do NOT use \`glob\`, \`file_read\`, \`bash\`, \`grep\`, or any filesystem tool to discover skills in other directories — especially NOT \`D:\\claude_skills\\skills-main\` or similar cloned paths; those are third-party GitHub repos, NOT installed skill sources. If you need a structured breakdown (per-source counts, duplicate names, version info), call the \`list_skills\` tool. If you need to load a specific skill's instructions, use the \`skill\` tool with the skill's name.

If the user's request matches a skill's purpose, load it via the \`skill\` tool and follow its instructions.

You are running on Windows as a desktop AI coding agent.`;

export { DEFAULT_PROMPT };

// ── AGENTS.md / CLAUDE.md auto-loading ────────────────────
/** Safe file read returning string or null */
function readFileSyncSafe(p: string): string | null {
  try { return readFileSync(p, "utf-8"); } catch { return null; }
}

function loadContextMd() {
  const WORKSPACE = getWorkspace();
  const files = [
    { path: join(WORKSPACE, "AGENTS.md"), label: "项目" },
    { path: join(WORKSPACE, "CLAUDE.md"), label: "项目" },
    { path: join(os.homedir(), ".aideagent", "CLAUDE.md"), label: "全局" },
  ];
  const parts = [];
  for (const { path, label } of files) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8").replace(/\r\n/g, "\n").trim();
        if (raw) parts.push(`<context-md source="${path}" type="${label}">\n${raw}\n</context-md>`);
      }
    } catch { /* skip unreadable files */ }
  }
  return parts.length > 0
    ? "\n\n## 项目上下文（自动加载自 AGENTS.md / CLAUDE.md）\n" + parts.join("\n\n")
    : "";
}

function _initPromptStorePath() {
  if (!getPromptStorePath()) {
    // `app` is undefined outside the Electron main process (vitest); never
    // let profile loading crash on a non-Electron context.
    try {
      const base = typeof app?.getPath === "function" ? app.getPath("userData") : null;
      if (base) setPromptStorePath(join(base, "system-prompt-profiles.json"));
    } catch { /* ignored */ }
  }
}

export function loadPromptProfiles() {
  _initPromptStorePath();
  try {
    const storePath = getPromptStorePath() as string;
    if (storePath && existsSync(storePath)) {
      const raw = readFileSync(storePath, "utf-8");
      const store: any = JSON.parse(raw);
      let migrated = false;
      if (store.profiles) {
        for (const prof of Object.values(store.profiles) as any[]) {
          if (prof && prof.sections && !prof.content) {
            prof.content = Object.entries(prof.sections as Record<string, any>)
              .filter(([, sec]) => sec.enabled && sec.content && sec.content.trim())
              .map(([, sec]) => sec.content.trim())
              .join("\n\n");
            delete prof.sections;
            migrated = true;
          }
        }
      }
      if (migrated) {
        savePromptProfiles(store);
        console.log("[main] Migrated profiles from sections to single content");
      }
      return store;
    }
  } catch (e: any) {
    console.error("[main] Failed to load prompt profiles:", e.message);
  }
  return {
    activeProfile: "default",
    profiles: {
      default: {
        id: "default",
        name: "默认",
        enabled: true,
        content: DEFAULT_PROMPT,
      },
    },
  };
}

export function savePromptProfiles(data: any): void {
  _initPromptStorePath();
  try {
    const storePath = getPromptStorePath() as string;
    if (!storePath) return;
    const dir = dirname(storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e: any) {
    console.error("[main] Failed to save prompt profiles:", e.message);
  }
}

/**
 * Training-cutoff reference: injected at build time from the ACTIVE model.
 * A hardcoded per-vendor date list goes stale the moment the user switches
 * models — the exact stale-fact failure the anti-hallucination rules forbid.
 */
function trainingCutoffNote(model: string): string {
  const m = (model || "").toLowerCase();
  const known = m.includes("claude") ? "Claude ≈ 2025-03"
    : m.includes("deepseek") ? "DeepSeek ≈ 2025-05"
    : m.includes("minimax") ? "MiniMax M3 ≈ 2025-04"
    : null;
  const ref = known ? `模型训练数据截止 ${known}` : "训练数据截止日期未知（见所用模型的官方文档）";
  return `${ref}。此日期之后的事件必须用 web_search 验证，不要凭训练数据答。当前日期之前的"昨天" = Current Date 减 1 天，算完再搜。`;
}

/** Top-N sessions surfaced in the "最近对话" context section (Phase 3a). */
const RECENT_SESSIONS_TOP = 3;
/** Whole-section cap for "最近对话" — was ~5.1k chars unbounded. */
const RECENT_SESSIONS_MAX_CHARS = 1200;
/** Whole-section cap for injected knowledge-base notes (Phase 3b). */
const KB_CONTEXT_MAX_CHARS = 6000;
/** Per-note snippet cap inside the KB section. */
const KB_SNIPPET_MAX_CHARS = 2000;

/**
 * Phase 3a relevance terms for ranking past sessions against the live prompt.
 * ASCII words ≥2 chars plus CJK bigrams (Chinese prompts have no spaces, so
 * whole-run matching would almost never hit). Capped at 40 terms to keep the
 * ranking O(40) per candidate session.
 */
export function promptRelevanceTerms(prompt: string): string[] {
  if (!prompt) return [];
  const p = prompt.toLowerCase();
  const terms = new Set<string>();
  for (const w of p.split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length >= 2) terms.add(w);
  }
  const runs = p.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of runs) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms].slice(0, 40);
}

export async function buildSystemPrompt(
  enabledSkills?: string[],
  agentName?: string,
  userPrompt = "",
  kbEnabled = false,
  isPlanMode = false,
  webSearchEnabled = true,
  kbInject = true,
  model = "",
): Promise<{ role: string, content: string, contextBlock: string | null, dynamicContextBlock: string | null, staticContextBlock: string | null }> {
  const WORKSPACE = getWorkspace();
  const sessionId = getSessionId();
  const allSkills = scanSkills();
  const filterSkills = enabledSkills && enabledSkills.length > 0
    ? allSkills.filter(s => enabledSkills.includes(s.name))
    : allSkills;

  // Phase 2: match user prompt against skills using [A] trigger keywords + [B] embedding similarity.
  // Matched skills are pinned to the top of the list with a ⚡ marker so the LLM sees them first.
  // `kb` is imported as `* as kb` above — embedText is the only embedding entry point we need.
  let matchedNames = new Set();
  let matchedDetails = new Map();
  let skillMatchWarning = null;
  if (userPrompt && userPrompt.trim() && filterSkills.length > 0) {
    try {
      const { embedText } = await import("../knowledge-store.ts");
      const matches = await skills.matchSkills(userPrompt, filterSkills, {
        embedFn: embedText,
        semanticThreshold: 0.5,
        semanticTopK: 3,
      });
      for (const m of matches) {
        matchedNames.add(m.skill.name);
        matchedDetails.set(m.skill.name, m);
      }
      // P1: surface match outcomes to the renderer so silent zero-match is visible
      try {
        const { sendToRenderer } = await import("./state.ts");
        sendToRenderer("skill:match-result", {
          userPrompt: userPrompt.slice(0, 200),
          totalSkills: filterSkills.length,
          matchedCount: matches.length,
          matchedNames: matches.map(m => m.skill.name),
        });
      } catch { /* renderer may not be ready */ }
    } catch (e: any) {
      // Fall back to no matching; the LLM still sees the full list and can self-select.
      // P1: surface the failure so the user knows why skills weren't auto-matched
      const msg = `[system-prompt] skill match failed: ${e.message}`;
      console.error(msg);
      skillMatchWarning = `⚠️ 技能自动匹配失败 (${e.message})。LLM 将仅从全列表自选——可能错过相关技能。如持续失败请检查 embedding 服务（Ollama / 本地 MiniLM）。`;
      try {
        const { sendToRenderer } = await import("./state.ts");
        sendToRenderer("skill:match-error", { error: e.message, userPrompt: userPrompt.slice(0, 200) });
      } catch { /* renderer may not be ready */ }
    }
  }

  // Build a top section listing matched skills, then a full list (matched ones repeated with a tag)
  const matchedSkills = filterSkills.filter(s => matchedNames.has(s.name));
  const matchedSection = matchedSkills.length > 0
    ? "**Auto-matched (from your prompt — please use these if relevant):**\n" +
      matchedSkills.map(s => {
        const m = matchedDetails.get(s.name);
        const tag = m?.via?.startsWith("trigger:") ? `trigger \`${m.via.slice(8)}\`` : "semantic match";
        return `  - ⚡ \`${s.name}\`: ${s.description || "(no description)"} _(${tag})_`;
      }).join("\n")
    : "";

  const skillList = filterSkills.length > 0
    ? filterSkills.map(s => {
        const tag = matchedNames.has(s.name) ? " ⚡" : "";
        return `  - \`${s.name}\`${tag}: ${s.description || "(no description)"}`;
      }).join("\n")
    : "  (no skills enabled)";

  // FIX: inject current date into DEFAULT_PROMPT so the LLM has temporal
  // awareness (was missing entirely — see hallucination investigation).
  // Computed once per session, not per token, so caching stays safe.
  const CURRENT_DATE = new Date().toISOString().split("T")[0];
  const PROMPT_WITH_DATE = DEFAULT_PROMPT
    .replace(/\$\{CURRENT_DATE\}/g, CURRENT_DATE)
    .replace(/\$\{TRAINING_CUTOFF\}/g, trainingCutoffNote(model));

  let content = "";
  try {
    const store = loadPromptProfiles();
    const profileId = store.activeProfile || "default";
    const profile = store.profiles[profileId];
    if (profile && profile.enabled) {
      if (profile.content && profile.content.trim()) {
        // P1: profile inherit — {{INHERIT_DEFAULT}} token in profile content
        // is replaced with the built-in DEFAULT_PROMPT (post-template-var
        // substitution). This lets users create a custom persona on top of
        // the default rules, rather than completely replacing them. Existing
        // profiles that don't include the token keep current behavior
        // (full replacement), preserving backward compatibility.
        const profileContent = profile.content.trim();
        if (profileContent.includes("{{INHERIT_DEFAULT}}")) {
          content = profileContent.replace(/\{\{INHERIT_DEFAULT\}\}/g, PROMPT_WITH_DATE);
        } else {
          content = profileContent;
        }
        // Substitute CURRENT_DATE in user custom prompts too (they may reference it).
        content = content.replace(/\$\{CURRENT_DATE\}/g, CURRENT_DATE);
        content = content.replace(/\$\{TRAINING_CUTOFF\}/g, trainingCutoffNote(model));
        content = content.replace(/\{\{WORKSPACE\}\}/g, WORKSPACE);
      }
    }
  } catch (e: any) {
    console.error("[main] Failed to load prompt profiles:", e.message);
  }

  if (!content) {
    content = PROMPT_WITH_DATE;
  }

  // B7: system-level reasoning enforcement. Appended AFTER user profile so
  // even a custom profile that fully replaces DEFAULT_PROMPT can't bypass it.
  // Without this, custom prompts were free to drop the "must reason first"
  // rule, which made the in-UI "Reasoning" toggle a no-op. LLMs treat late
  // system instructions as strong constraints, so appending at the end works
  // reliably across Claude / DeepSeek / MiniMax M3 / V4 flash.
  content += `\n\n---

🔒 **强制推理规则（系统级硬性要求）**：
每轮回复前**必须**先在 reasoning / thinking 字段输出思考过程（用户要解决什么、需要查什么、可能的方案），再输出最终答案；即使是简单问候也要在 reasoning 里简短说明你的判断。
**绝不可跳过推理直接回答**——这是 agent 稳定性的硬性要求，无法被任何自定义提示词关闭或覆盖。`;

  // Output layering: with tool-calling the model tends to narrate its plan
  // ("我先读取文件…") in `content` of intermediate turns. That narration is
  // rendered as body text, so it must be at most one short progress line —
  // plans / analysis belong in reasoning, the final answer must START with
  // its conclusion instead of a recap of what was just done.
  content += `\n\n---

🔒 **输出分层规则（系统级硬性要求）**：
- **思考、计划、分析一律写在 reasoning / thinking 字段**，不要写进 content。
- 调用工具之前的中间轮 content **只准写一句 ≤30 字的进度说明**（如"正在读取配置文件…"），禁止整段方案、禁止复述工具结果。
- **最终回答（不再调用工具的那一轮）直接以标题或结论开头**，不要用"我刚才已经…"、"经过分析…"之类的回顾开场。
- 正文 content 只保留给用户最终需要的答案；过程叙述属于思考区。`;

  // B8: anti-laziness enforcement. Without this, LLMs (especially MiniMax
  // M3 / DeepSeek V4 flash) would respond to operational requests like
  // "fix the bug in A" with "done!" after zero tool calls. The follow-up
  // guard in agent-loop.mjs (the "0 tools + action verb" check) is the hard
  // backstop, but pairing it with a system-prompt directive gives the LLM
  // a chance to self-correct before we burn a turn on a reminder message.
  content += `\n\n---

🔒 **防偷懒规则（系统级硬性要求）**：
- **操作性请求必须用工具**：用户请求包含操作动词（改/修/查/找/跑/执行/删除/创建/读取/搜索/运行/分析 等）时，必须先调用 file_read / bash / grep / web_search 等工具获取信息或执行操作。
- **时效性问题必须多搜 + 跨源核验**：问昨天/今天/最近/最新/新闻/版本/价格 → **至少 5 次**不同 query 的 web_search（带日期）；核心断言须 **≥2 个不同 hostname** 独立支持（重大结论 ≥3 源 + 1 一手源）；同站多篇/转载只算 1 源；单源必须降级为"仅见 X 报道"或再搜证实。少于 5 次、无日期、或把单源当实锤 = 未完成。
- **3+ 步的复杂任务必须用 TaskCreate 建清单**，每步完成时用 TaskUpdate(status="completed", evidence=<实际证据>) 标记——evidence 必须是命令输出、文件路径、diff 摘要等真实证据，**禁止用"完成"等占位符**。
- **1-2 步的简单任务用 TodoWrite**（更轻量、不持久）。
- **完成判定基于真实结果，不是猜测**。如果你没调任何工具就说"已完成"，视为回复未完成。`;

  const mcpServers = mcpManager.listServers().filter(s => s.status === "running");
  let mcpSection = "";
  if (mcpServers.length > 0) {
    const lines = [];
    for (const server of mcpServers) {
      const toolNames = server.tools.map(/** @param {{name: string}} t */ t => `\`${t.name}\``).join(", ");
      lines.push(`  - **${server.name}**: ${toolNames}`);
    }
    mcpSection = `\n\n**MCP servers:**
${lines.join("\n")}\n
You can use the MCP tools listed above just like any other tool.`;
  }

  // ── Compact Authoritative Sources (use tools, NOT filesystem) ──
  const sourceParts = [];
  let dupLine = "";

  // Skills
  if (filterSkills.length > 0) {
    const nameCount = new Map();
    for (const s of filterSkills) nameCount.set(s.name, (nameCount.get(s.name) || 0) + 1);
    const dupNames = [...nameCount.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (dupNames.length > 0) {
      dupLine = `\n- **Duplicates:** ${dupNames.slice(0, 8).map(n => `\`${n}\``).join(", ")}${dupNames.length > 8 ? ", ..." : ""}`;
    }
    sourceParts.push(`Skills: \`list_skills\` (${filterSkills.length} loaded${(enabledSkills?.length && enabledSkills.length !== filterSkills.length) ? `, ${enabledSkills.length} enabled` : ""})`);
  }
  // Memory
  try { const allMems = memory.listMemories() || []; if (allMems.length > 0) sourceParts.push(`Memory: \`list_memories\` (${allMems.length} entries)`); } catch { /* ignored */ }
  // KB
  try { const vault = kb.getVault(); if (vault) { const r = kb.listNotes(0, 1); sourceParts.push(`KB: \`kb_search\` (${r.total || 0} notes)`); } } catch { /* ignored */ }
  // MCP
  try { const allSrv = mcpManager.listServers() || []; const runSrv = allSrv.filter(s => s.status === "running"); sourceParts.push(`MCP: \`list_mcp\` (${allSrv.length} servers, ${runSrv.length} running)`); } catch { /* ignored */ }
  // Tools
  let toolShadowLine = "";
  try {
    const { getAllToolDefs } = await import("./format-adapters.ts");
    const { TOOL_DEFS } = await import("./tool-definitions.ts");
    const allDefs = getAllToolDefs(true, true) || [];
    // Derive builtin names from the source of truth instead of a hardcoded
    // list — the old copy was already stale (missing view_image,
    // get_session_info) and miscounted them as MCP tools.
    const BUILTIN_NAMES = new Set(TOOL_DEFS.map(t => t.function.name));
    const builtin = allDefs.filter(d => BUILTIN_NAMES.has(d.function.name)).length;
    sourceParts.push(`Tools: \`list_tools\` (${allDefs.length}: ${builtin} built-in + ${allDefs.length - builtin} MCP)`);
    // Shadow detection
    const names = allDefs.map(d => d.function.name);
    const shadowing = [...new Set(names.filter((n, i) => names.indexOf(n) !== names.lastIndexOf(n)))];
    if (shadowing.length > 0) toolShadowLine = `\n- ⚠️ Name shadowing: \`${shadowing.join("`, `")}\` (built-in + MCP both provide these — runtime dispatches MCP first)`;
  } catch { /* ignored */ }

  content += `\n\n**Authoritative Sources (use each source's tool — do NOT glob/bash/grep to discover these):**\n- ${sourceParts.join("\n- ")}${dupLine}${toolShadowLine}
${mcpSection}

Working directory: ${WORKSPACE}`;

  if (agentName && agentName !== "AideAgent") {
    content = content.replace(/AideAgent/g, agentName);
  }

  content += `\n\n**Memory:** You have persistent memory via \`write_memory\`. Save facts that are NOT derivable from code or git history.\n\n**Do NOT save:** code patterns/architecture (read the files), git history (git log is authoritative), debug solutions (fix is in code), CLAUDE.md content, or temporary task state. **DO save:** user preferences, project context (deadlines, stakeholder decisions), feedback/corrections, external system pointers.\n\nWhen a memory names a specific file or function, verify it exists before acting — memories can be stale.\n\nYou also have \`create_skill\` — use it when you notice repeated task patterns.`;

  content += `\n\n**IMPORTANT: Before answering any user request, check the "Enabled skills" and skill list in the context block below. If a skill matches, call \`skill\` / \`invoke_skill\` to load and follow its instructions.**`;

  if (isPlanMode) {
    content += "\n\n## ⚠️ 计划模式\n当前处于计划模式。你只能读取和分析代码，绝对不能使用 file_write、file_edit、bash 等写操作工具。\n请先制定详细的实现计划（包括文件变更清单、步骤、依赖关系），等用户确认后再执行。";
  }

  // ── Inject AGENTS.md / CLAUDE.md ──
  content += loadContextMd();

  if (!webSearchEnabled) {
    content += "\n\n## 🚫 联网搜索已关闭\n用户关闭了联网搜索功能。你不能使用 web_search、web_fetch 工具，也不能通过 bash 执行 curl、Invoke-WebRequest、wget 等命令进行联网。请仅基于本地文件、知识库和已有信息回答。如果信息不足，请告知用户需要联网搜索才能获取更多信息。";
  }

  // ── Build dynamic context block (NOT in system prompt — preserved for caching) ──
  // Phase 3c split: dynamicCtx changes turn-to-turn (episodic/recent-session
  // hits, KB notes) while staticCtx (skill inventory, matched skill, repeated
  // patterns) is stable for the whole session. contextBlock is both joined so
  // existing callers keep working; the split lets callers re-append the stable
  // part after a continuation rebuild without paying for the stale dynamic part.
  let dynamicCtx = "";

  let memorySections = [];
  try {
    const episodicSearched = _episodicSearched;
    if (userPrompt && !episodicSearched) {
      import("./state.ts").then(m => m.setEpisodicSearched(true));
      const results = sessionDb.searchMessages(userPrompt, 8);
      if (results.length > 0) {
        const lines = results.map(r =>
          `- [${r.sessionTitle}] ${(r.snippet || "").replace(/<\/?mark>/g, "")}`
        ).join("\n");
        memorySections.push(`\n\n**对话记忆：**\n${lines}`);
      }
    }
    // Phase 3a: was getRecentSessions(10, 4) with 200-char message slices —
    // up to 10 sessions × 4 messages ≈ 5.1k chars (measured), nearly half the
    // whole context block and mostly irrelevant to the current question.
    // Now: rank candidate sessions by relevance to the live prompt, keep at
    // most 3, and hard-cap the section at 1,200 chars (drop whole sessions
    // that don't fit rather than emitting a useless fragment).
    const recentSessions = sessionDb.getRecentSessions(10, 4, sessionId ?? undefined);
    if (recentSessions?.length) {
      const terms = promptRelevanceTerms(userPrompt);
      const ranked = recentSessions
        .map((s: any, idx: number) => {
          const hay = `${s.title}\n${(s.messages || []).map((m: any) => m.content || "").join("\n")}`.toLowerCase();
          const score = terms.reduce((acc: number, t: string) => acc + (hay.includes(t) ? 1 : 0), 0);
          return { s, idx, score };
        })
        // Most relevant first; ties keep original recency order (idx asc).
        .sort((a: any, b: any) => (b.score - a.score) || (a.idx - b.idx));
      let usedChars = 0;
      const parts: string[] = [];
      for (const { s } of ranked.slice(0, RECENT_SESSIONS_TOP)) {
        if (!s.messages?.length) continue;
        const lines = s.messages
          .map((m: any) => `- ${m.role}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 150)}`)
          .join("\n");
        const entry = `**[${s.title}]**\n${lines}`;
        if (usedChars + entry.length > RECENT_SESSIONS_MAX_CHARS) continue;
        usedChars += entry.length;
        parts.push(entry);
      }
      if (parts.length) {
        memorySections.push(`\n\n**最近对话：**\n${parts.join("\n\n")}`);
      }
    }
    try {
      const HOME = os.homedir();
      // Fix: was reading from `memories/` (legacy single-file path) but
      // memory-store.mjs writes to `memory/` (new multi-file path). The
      // legacy path never exists on fresh installs, so the sections were
      // silently dropped. Read from the new location to actually surface
      // the index file. The `readFileSync` is wrapped in try/catch so a
      // missing file is still a no-op for users with no MEMORY.md.
      for (const [label, path] of [["USER.md", join(HOME, ".aideagent", "memory", "USER.md")], ["MEMORY.md", join(HOME, ".aideagent", "memory", "MEMORY.md")]]) {
        try {
          const text = readFileSync(path, "utf8").trim();
          if (text) memorySections.push({ label, text });
        } catch { /* ignored */ }
      }
    } catch { /* ignored */ }
  } catch { /* ignored */ }

  const memBudget = TOKEN_BUDGET_WARN - estimateTokens(content);
  if (memBudget > 500) {
    for (const sec of memorySections) {
      if (typeof sec === 'string') {
        dynamicCtx += sec;
      } else {
        const trimmed = sec.text.length > 2000 ? sec.text.slice(0, 2000) : sec.text;
        dynamicCtx += `\n\n**${sec.label} — 永久记忆：**\n${trimmed}`;
      }
    }
  } else {
    for (const sec of memorySections) {
      if (typeof sec === 'string') {
        dynamicCtx += trimToBudget(sec, Math.max(200, memBudget));
      } else {
        const trimmed = sec.text.length > 800 ? sec.text.slice(0, 800) : sec.text;
        dynamicCtx += `\n\n**${sec.label} (摘要):**\n${trimmed}`;
      }
    }
  }

  if (kbEnabled && kb.getVault() && kbInject) {
    try {
      const kbCfg = kb.getConfig();
      const maxNotes = kbCfg.maxNotes ?? 20;
      const kbResults = await kb.search(userPrompt, maxNotes);
      if (kbResults.length > 0) {
        // Phase 3b: global cap. kb-config `maxChars` (default 20k) was applied
        // PER NOTE and there was no aggregate limit — 20 notes × 20k could
        // quadruple the context block on its own. Now each snippet is bounded
        // AND the whole section stops at KB_CONTEXT_MAX_CHARS.
        const perNote = Math.min(kbCfg.maxChars ?? KB_SNIPPET_MAX_CHARS, KB_SNIPPET_MAX_CHARS);
        let usedChars = 0;
        const parts: string[] = [];
        for (const r of kbResults) {
          if (usedChars >= KB_CONTEXT_MAX_CHARS) break;
          let snippet = r.snippet || "";
          if (snippet.length > perNote) snippet = snippet.slice(0, perNote) + "...";
          const entry = `**[${r.title}]** (${r.rel_path})\n${snippet}`;
          if (usedChars + entry.length > KB_CONTEXT_MAX_CHARS) {
            const room = KB_CONTEXT_MAX_CHARS - usedChars;
            if (room < 200) break;
            parts.push(entry.slice(0, room) + "…");
            break;
          }
          usedChars += entry.length;
          parts.push(entry);
        }
        if (parts.length) {
          dynamicCtx += `\n\n<knowledge-base>\n**知识库相关内容：**\n${parts.join("\n\n")}\n</knowledge-base>`;
        }
      }
    } catch { /* ignored */ }
  }

  // ── Static context: stable for the session (skill inventory etc.) ──
  let staticCtx = "";
  // ── Skill list (reference data — moved from system prompt to contextBlock) ──
  staticCtx += `\n\n**Available Skills (${filterSkills.length} total):**\n${skillList}`;
  if (matchedSection) staticCtx += `\n\n${matchedSection}`;

  const skillsCtx = skills.buildSkillsContext();
  if (skillsCtx) staticCtx += skillsCtx;

  if (skillMatchWarning) staticCtx += `\n\n${skillMatchWarning}`;

  try {
    const patterns = skills.detectPatterns(sessionDb as any);
    if (patterns.length > 0) {
      const hints = patterns.slice(0, 3).map(p =>
        `- "${p.phrase}" (${p.count} 次). 示例: "${p.examples[0]}"`
      ).join("\n");
      staticCtx += `\n\n**Repeated patterns detected in your conversation history:** These topics appear multiple times across sessions. If a pattern represents a reusable workflow, use \`create_skill\` to save it:\n${hints}`;
    }
  } catch { /* ignored */ }

  const dyn = dynamicCtx.trim();
  const stat = staticCtx.trim();
  // Contract: contextBlock === [dynamic, static].filter(Boolean).join("\n\n")
  // (tests assert this). Empty halves collapse to the other one.
  const contextBlock = [dyn, stat].filter(Boolean).join("\n\n") || null;
  return {
    role: "system",
    content,
    contextBlock,
    dynamicContextBlock: dyn || null,
    staticContextBlock: stat || null,
  };
}
