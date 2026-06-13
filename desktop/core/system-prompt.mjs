// ── System Prompt Builder + Prompt Profile Store ────────────

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { app } from "electron";
import os from "node:os";
import sessionDb from "../session-db.mjs";
import * as skills from "../skills-store.mjs";
import * as kb from "../knowledge-store.mjs";
import mcpManager from "../mcp-manager.mjs";
import { scanSkills } from "./skill-scanner.mjs";
import { getWorkspace, getSessionId, getPromptStorePath, setPromptStorePath, _episodicSearched } from "./state.mjs";
import { estimateTokens, trimToBudget, TOKEN_BUDGET_WARN } from "./token-budget.mjs";

/**
 * @param {string} ver
 * @returns {string}
 */
export function bumpVersion(ver) {
  const parts = ver.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

const DEFAULT_PROMPT = `You are AideAgent, an expert coding assistant running on Windows with direct access to the user's computer. Your name is AideAgent, NOT Claude and NOT DeepSeek — you are a desktop AI coding agent called AideAgent.

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
8. When asked about your own configuration (search engine, API provider, model, etc.), **do NOT guess**. Use \`file_read\` or \`bash\` to check the relevant config files before answering.

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
function readFileSyncSafe(p) {
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
    setPromptStorePath(join(app.getPath("userData"), "system-prompt-profiles.json"));
  }
}

export function loadPromptProfiles() {
  _initPromptStorePath();
  try {
    const storePath = /** @type {string} */ (getPromptStorePath());
    if (existsSync(storePath)) {
      const raw = readFileSync(storePath, "utf-8");
      const store = JSON.parse(raw);
      let migrated = false;
      if (store.profiles) {
        for (const prof of Object.values(store.profiles)) {
          if (prof && prof.sections && !prof.content) {
            prof.content = Object.entries(prof.sections)
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
  } catch (/** @type {any} */ e) {
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

/**
 * @param {Object} data
 */
export function savePromptProfiles(data) {
  _initPromptStorePath();
  try {
    const storePath = /** @type {string} */ (getPromptStorePath());
    const dir = dirname(storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (/** @type {any} */ e) {
    console.error("[main] Failed to save prompt profiles:", e.message);
  }
}

/**
 * @param {string[]} [enabledSkills]
 * @param {string} [agentName]
 * @param {string} [userPrompt]
 * @param {boolean} [kbEnabled]
 * @param {boolean} [isPlanMode]
 * @param {boolean} [webSearchEnabled]
 * @param {boolean} [kbInject]
 * @returns {Promise<{role: string, content: string, contextBlock: string | null}>}
 */
export async function buildSystemPrompt(enabledSkills, agentName, userPrompt = "", kbEnabled = false, isPlanMode = false, webSearchEnabled = true, kbInject = true) {
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
      const { embedText } = await import("../knowledge-store.mjs");
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
        const { sendToRenderer } = await import("./state.mjs");
        sendToRenderer("skill:match-result", {
          userPrompt: userPrompt.slice(0, 200),
          totalSkills: filterSkills.length,
          matchedCount: matches.length,
          matchedNames: matches.map(m => m.skill.name),
        });
      } catch { /* renderer may not be ready */ }
    } catch (/** @type {any} */ e) {
      // Fall back to no matching; the LLM still sees the full list and can self-select.
      // P1: surface the failure so the user knows why skills weren't auto-matched
      const msg = `[system-prompt] skill match failed: ${e.message}`;
      console.error(msg);
      skillMatchWarning = `⚠️ 技能自动匹配失败 (${e.message})。LLM 将仅从全列表自选——可能错过相关技能。如持续失败请检查 embedding 服务（Ollama / 本地 MiniLM）。`;
      try {
        const { sendToRenderer } = await import("./state.mjs");
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
          content = profileContent.replace(/\{\{INHERIT_DEFAULT\}\}/g, DEFAULT_PROMPT);
        } else {
          content = profileContent;
        }
        content = content.replace(/\{\{WORKSPACE\}\}/g, WORKSPACE);
      }
    }
  } catch (/** @type {any} */ e) {
    console.error("[main] Failed to load prompt profiles:", e.message);
  }

  if (!content) {
    content = DEFAULT_PROMPT;
  }

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
    const { getAllToolDefs } = await import("./format-adapters.mjs");
    const allDefs = getAllToolDefs(true, true) || [];
    const BUILTIN_NAMES = new Set(["bash","file_read","file_write","file_edit","grep","glob","lsp","web_search","web_fetch","write_memory","skill","invoke_skill","create_skill","TaskCreate","TaskUpdate","TaskList","TodoWrite","AskUserQuestion","Agent","kb_search","kb_write","kb_get_note","git_diff","git_commit","git_branch","gh_pr","gh_issue","gh_repo","list_skills","list_memories","list_kb","list_mcp","list_tools"]);
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
  let contextBlock = "";

  let memorySections = [];
  try {
    const episodicSearched = _episodicSearched;
    if (userPrompt && !episodicSearched) {
      import("./state.mjs").then(m => m.setEpisodicSearched(true));
      const results = sessionDb.searchMessages(userPrompt, 8);
      if (results.length > 0) {
        const lines = results.map(r =>
          `- [${r.sessionTitle}] ${(r.snippet || "").replace(/<\/?mark>/g, "")}`
        ).join("\n");
        memorySections.push(`\n\n**对话记忆：**\n${lines}`);
      }
    }
    const recentSessions = sessionDb.getRecentSessions(10, 4, sessionId ?? undefined);
    if (recentSessions?.length) {
      const sessionContexts = recentSessions.map(s => {
        if (!s.messages?.length) return null;
        const lines = s.messages.map(m => `- ${m.role}: ${String(m.content || "").slice(0, 200)}`).join("\n");
        return `**[${s.title}]**\n${lines}`;
      }).filter(Boolean).join("\n\n");
      if (sessionContexts) {
        memorySections.push(`\n\n**最近对话：**\n${sessionContexts}`);
      }
    }
    try {
      const HOME = os.homedir();
      for (const [label, path] of [["USER.md", join(HOME, ".aideagent", "memories", "USER.md")], ["MEMORY.md", join(HOME, ".aideagent", "memories", "MEMORY.md")]]) {
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
        contextBlock += sec;
      } else {
        const trimmed = sec.text.length > 2000 ? sec.text.slice(0, 2000) : sec.text;
        contextBlock += `\n\n**${sec.label} — 永久记忆：**\n${trimmed}`;
      }
    }
  } else {
    for (const sec of memorySections) {
      if (typeof sec === 'string') {
        contextBlock += trimToBudget(sec, Math.max(200, memBudget));
      } else {
        const trimmed = sec.text.length > 800 ? sec.text.slice(0, 800) : sec.text;
        contextBlock += `\n\n**${sec.label} (摘要):**\n${trimmed}`;
      }
    }
  }

  if (kbEnabled && kb.getVault() && kbInject) {
    try {
      const kbCfg = kb.getConfig();
      const maxNotes = kbCfg.maxNotes ?? 20;
      const maxChars = kbCfg.maxChars ?? 20000;
      const kbResults = await kb.search(userPrompt, maxNotes);
      if (kbResults.length > 0) {
        const kbContext = kbResults.map(r => {
          let snippet = r.snippet || "";
          if (snippet.length > maxChars) snippet = snippet.slice(0, maxChars) + "...";
          return `**[${r.title}]** (${r.rel_path})\n${snippet}`;
        }).join("\n\n");
        contextBlock += `\n\n<knowledge-base>\n**知识库相关内容：**\n${kbContext}\n</knowledge-base>`;
      }
    } catch { /* ignored */ }
  }

  // ── Skill list (reference data — moved from system prompt to contextBlock) ──
  contextBlock += `\n\n**Available Skills (${filterSkills.length} total):**\n${skillList}`;
  if (matchedSection) contextBlock += `\n\n${matchedSection}`;

  const skillsCtx = skills.buildSkillsContext();
  if (skillsCtx) contextBlock += skillsCtx;

  if (skillMatchWarning) contextBlock += `\n\n${skillMatchWarning}`;

  try {
    const patterns = skills.detectPatterns(/** @type {any} */ (sessionDb));
    if (patterns.length > 0) {
      const hints = patterns.slice(0, 3).map(p =>
        `- "${p.phrase}" (${p.count} 次). 示例: "${p.examples[0]}"`
      ).join("\n");
      contextBlock += `\n\n**Repeated patterns detected in your conversation history:** These topics appear multiple times across sessions. If a pattern represents a reusable workflow, use \`create_skill\` to save it:\n${hints}`;
    }
  } catch { /* ignored */ }

  return { role: "system", content, contextBlock: contextBlock.trim() || null };
}
