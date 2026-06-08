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
import { estimateTokens, trimToBudget, TOKEN_BUDGET_WARN, TOKEN_BUDGET_HARD } from "./token-budget.mjs";

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

1. First explore the project with \`dir\` or \`Get-ChildItem\`.
2. Understand the user's request clearly before taking action.
3. Plan your approach, then use the available tools to execute it.
4. Show relevant code when explaining changes.
5. Iterate based on user feedback to refine the result.
6. When you need current information, news, or docs — use \`web_search\` and \`web_fetch\`.
7. Always respond in the same language the user uses (if they write in Chinese, answer in Chinese; if English, answer in English).
8. When asked about your own configuration (search engine, API provider, model, etc.), **do NOT guess**. Use \`file_read\` or \`bash\` to check the relevant config files before answering.

**Available tools:**
- \`bash\` — Run PowerShell commands (dir, git, npm, etc.)
- \`file_read\` — Read file contents
- \`file_write\` — Create or overwrite files
- \`file_edit\` — Replace exact text in files
- \`grep\` — Regex search in files
- \`glob\` — Find files by name pattern
- \`web_fetch\` — Fetch and extract content from any URL
- \`web_search\` — Search the internet for current information
- \`skill\` — Load a user-installed skill (SKILL.md workflow)
- \`invoke_skill\` — Invoke a loaded skill
- \`create_skill\` — Create or update reusable skill workflows
- \`write_memory\` — Save important facts to permanent memory
- \`TaskCreate\` — Create tasks to track complex multi-step work
- \`TaskUpdate\` — Update task status (pending/in_progress/completed/deleted)
- \`TaskList\` — List all tasks to see progress
- \`TodoWrite\` — Update a lightweight session todo checklist
- \`AskUserQuestion\` — Ask the user clarifying multiple-choice questions
- \`Agent\` — Launch a read-only sub-agent for parallel research, code exploration, or web searches
- \`kb_search\` — Search the user's knowledge base (Obsidian vault)
- \`kb_write\` — Create or update notes in the knowledge base
- \`lsp\` — Language Server Protocol: go to definition, find references, hover info
- \`git_diff\` — Show git working tree changes
- \`git_commit\` — Create a git commit
- \`git_branch\` — Manage git branches
- \`gh_pr\` — Manage GitHub pull requests
- \`gh_issue\` — Manage GitHub issues
- \`gh_repo\` — View GitHub repository info

USE THE TOOLS. Don't just suggest — actually run commands, read files, make changes.

**注意力优先级规则（Attention Priority）：**
- 用户的最新消息和你紧接着的上一条回复，优先级高于所有历史记忆、知识库内容和早期对话。
- 当用户回复简短确认（如"开始"、"做吧"、"好的"、"yes"、"go ahead"、"ok"），这确认的是你**上一次的提议**——绝不是记忆区或早期对话中的任何旧任务。回看你刚刚说了什么，执行那个。
- 如果用户消息中出现"当前任务锚定"块，请严格以该块的内容为准来理解用户的意图。
- 背景记忆和历史对话提供参考知识，但**绝不能覆盖或混淆当前正在执行的任务**。
- 如果你不确定用户指的是哪个任务，使用 AskUserQuestion 向用户确认，禁止自行猜测后执行错误的任务。

**Knowledge Base Rule:** A \`<knowledge-base>\` section in this prompt contains the user's Obsidian notes relevant to the question. Use it directly. Do NOT use \`glob\`, \`file_read\`, \`bash\`, or any filesystem tool to search for knowledge base files. If the knowledge base content answers the question, use it. If it's insufficient, use the \`kb_search\` tool to search for more notes. If still insufficient, say "知识库中没有更详细的信息" and offer to search the web.

If the user's request matches a skill's purpose, load it via the \`skill\` tool and follow its instructions.

You are running on Windows as a desktop AI coding agent.`;

export { DEFAULT_PROMPT };

// ── AGENTS.md / CLAUDE.md auto-loading ────────────────────
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
  const skillList = filterSkills.length > 0
    ? filterSkills.map(s => `  - \`${s.name}\`: ${s.description || "(no description)"}`).join("\n")
    : "  (no skills enabled)";

  let content = "";
  try {
    const store = loadPromptProfiles();
    const profileId = store.activeProfile || "default";
    const profile = store.profiles[profileId];
    if (profile && profile.enabled) {
      if (profile.content && profile.content.trim()) {
        content = profile.content.trim();
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

  content += `\n\n**Enabled skills (user-selected):**
${skillList}
${mcpSection}

Working directory: ${WORKSPACE}`;

  if (agentName && agentName !== "AideAgent") {
    content = content.replace(/AideAgent/g, agentName);
  }

  content += `\n\n**Memory:** You have persistent memory via \`write_memory\`. Save facts that are NOT derivable from code or git history.\n\n**Do NOT save:** code patterns/architecture (read the files), git history (git log is authoritative), debug solutions (fix is in code), CLAUDE.md content, or temporary task state. **DO save:** user preferences, project context (deadlines, stakeholder decisions), feedback/corrections, external system pointers.\n\nWhen a memory names a specific file or function, verify it exists before acting — memories can be stale.\n\nYou also have \`create_skill\` — use it when you notice repeated task patterns.`;

  const skillsCtx = skills.buildSkillsContext();
  if (skillsCtx) content += skillsCtx;

  content += `\n\n**IMPORTANT: Before answering any user request, check both "Enabled skills" and "Available Skills" sections above. If a skill matches the user's request, you MUST call \`skill\` (for installed skills) or \`invoke_skill\` (for agent skills) with that skill name to load its full instructions, then follow them. Do not ignore matching skills.**`;

  try {
    const patterns = skills.detectPatterns(/** @type {any} */ (sessionDb));
    if (patterns.length > 0) {
      const hints = patterns.slice(0, 3).map(p =>
        `- "${p.phrase}" (${p.count} 次). 示例: "${p.examples[0]}"`
      ).join("\n");
      content += `\n\n**Repeated patterns detected in your conversation history:** These topics appear multiple times across sessions. If a pattern represents a reusable workflow, use \`create_skill\` to save it:\n${hints}`;
    }
  } catch { /* ignored */ }

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

  return { role: "system", content, contextBlock: contextBlock.trim() || null };
}
