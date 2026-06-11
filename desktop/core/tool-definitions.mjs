// ── Tool Definitions (OpenAI function calling) ─────────────
//
// Each description follows a Claude Code-style structure:
//   1) WHAT it does (1 line)
//   2) WHEN to use it (1-3 examples)
//   3) WHEN NOT to use it (redirect to the right tool)
//
// LLM tool-choice quality is dominated by these descriptions. Vague or
// overlap-y descriptions cause the model to pick wrong tools or skip them
// entirely. Keep them sharp and mutually exclusive.

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a PowerShell command on Windows. Returns stdout/stderr/exit code.\n\nUSE for: running builds, tests, git/npm/Node commands, exploring project structure (`Get-ChildItem`, `Select-String`), one-off shell operations.\n\nDO NOT use for: reading a file you already know the path to (use `file_read`); searching code (use `grep`); finding files by name (use `glob`). The shell is your fallback — prefer the dedicated tools above whenever possible.\n\n**Output handling (P2):** If output exceeds 60,000 chars or the response indicates truncation, re-run with `head=N` (first N lines), `tail=N` (last N lines), or `offset=N` (start at line N) to page through large outputs. Combining `offset=100` and `head=50` shows lines 100-149.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The PowerShell command to execute" },
          description: { type: "string", description: "Brief description shown to user" },
          head: { type: "integer", description: "If set, return only the first N lines (useful for paginating large output)." },
          tail: { type: "integer", description: "If set, return only the last N lines (useful for seeing the end of build/test output)." },
          offset: { type: "integer", description: "If set with `head`, start at line N instead of line 0." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read the full text content of a single file. Use when you know the path.\n\nUSE for: reading source code, config files, SKILL.md, CLAUDE.md, package.json.\n\nDO NOT use for: searching content across files (use `grep`); listing files in a directory (use `glob` or `bash Get-ChildItem`); reading knowledge-base notes (use `kb_get_note`); binary or huge files (>2000 lines — read in slices via grep first).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file (absolute or relative to workspace)" },
        }, required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Create or fully overwrite a file. Auto-creates parent directories.\n\nUSE for: new files; complete rewrites; small config files.\n\nDO NOT use for: surgical changes to existing files (use `file_edit` — it preserves surrounding code and is safer); writing markdown notes to the knowledge base (use `kb_write`); writing session memories (use `write_memory`).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "The full file content" },
        }, required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_edit",
      description: "Replace exact text in a file (surgical edit). Safer than `file_write` because it cannot accidentally delete unrelated code.\n\nUSE for: any modification to an existing file where you know the surrounding text.\n\nDO NOT use for: creating a new file (use `file_write`); replacing an entire file (use `file_write` if rewriting from scratch). The `old_string` must match EXACTLY (whitespace, punctuation, capitalization included).\n\n**Matching rules:**\n- If `old_string` matches 0 locations: returns an error. Use file_read to inspect.\n- If `old_string` matches 2+ locations: returns an error listing the line numbers. Add more surrounding context to make it unique, or set `replaceAll=true` to replace all.\n- If `old_string` matches exactly 1 location: replaces it.\n- `replaceAll=true` is required for batch replacement (use with care).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
          old_string: { type: "string", description: "Exact text to find (must match exactly, including whitespace and line endings)" },
          new_string: { type: "string", description: "Replacement text" },
          replaceAll: { type: "boolean", description: "Set to true to replace all occurrences. Default is false (must be unique).", default: false },
        }, required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex. Returns file:line matches.\n\nUSE for: finding where a function/symbol/string is defined or used; searching multiple files; code archaeology.\n\nDO NOT use for: finding files by name (use `glob`); reading a known file (use `file_read`); searching the knowledge base (use `kb_search`). Prefer `include` filter to limit scope.",
      parameters: {
        type: "object", properties: {
          pattern: { type: "string", description: "Regex to search" },
          include: { type: "string", description: "File filter (e.g. *.ts)" },
          path: { type: "string", description: "Directory to search (default: workspace)" },
        }, required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by name pattern (glob). Returns file paths.\n\nUSE for: finding files by name (`**/*.ts`, `src/**/*.css`); listing directory contents by extension; locating config files.\n\nDO NOT use for: searching file contents (use `grep`); reading a known file (use `file_read`); recursive directory trees (use `bash Get-ChildItem -Recurse`).",
      parameters: {
        type: "object", properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/**/*.css)" },
          path: { type: "string", description: "Directory (default: workspace)" },
        }, required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and extract readable text content.\n\nUSE for: reading documentation pages, articles, GitHub READMEs, API references, single-page fetches where you know the URL.\n\nDO NOT use for: searching across multiple sources (use `web_search`); reading local files (use `file_read`); bulk operations (do multiple `web_fetch` in parallel via sub-agents).",
      parameters: {
        type: "object", properties: {
          url: { type: "string", description: "The URL to fetch (must start with http:// or https://)" },
          max_length: { type: "number", description: "Maximum characters to return (default: 8000, max: 50000)" },
        }, required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the internet for current information.\n\nUSE for: up-to-date news, recent documentation, current API changes, current best practices, anything post-training-cutoff.\n\nDO NOT use for: searching the user's local files (use `grep` / `glob`); searching their knowledge base (use `kb_search`); questions about the current project (read the files instead — they are authoritative).",
      parameters: {
        type: "object", properties: {
          query: { type: "string", description: "The search query" },
          max_results: { type: "number", description: "Number of results to return (1-10, default: 5)" },
        }, required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tools",
      description: "List all tools currently available in this session with structured metadata: total count, by-category breakdown, name shadowing detection (built-in vs MCP), and per-tool description.\n\nUSE for: questions about 'what tools do you have', 'is there a tool for X', 'is web_search built-in or MCP'. This is the AUTHORITATIVE source of truth — never guess whether a tool exists; it is the runtime-filtered list (KB on/off, web search on/off, plan mode all affect visibility).\n\nDO NOT use for: invoking a tool (just call it by name); getting full parameter schema (use this tool to see names, then call the tool).",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional. Filter by category: 'file', 'shell', 'web', 'git', 'github', 'knowledge', 'task', 'skill', 'memory', 'kb', 'meta', 'all'." },
          includeShadowing: { type: "boolean", description: "Optional. Default true — include the `shadowing` array (tools that exist in both built-in and MCP forms)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mcp",
      description: "List all MCP (Model Context Protocol) servers and their tools. Returns each server's name, status (running/stopped/error), and the tools it exposes.\n\nUSE for: questions about 'which MCP servers are connected', 'what tools does the WebSearch MCP expose', 'is X MCP running'. This is the AUTHORITATIVE source of truth — never bash/grep to discover MCP servers; mcp-manager maintains its own runtime registry.\n\nDO NOT use for: invoking an MCP tool (just call the tool directly by its name, e.g. `web_search`, `browser_navigate`); configuring MCP (user does this in Settings → MCP).",
      parameters: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Optional. Filter to a single server name. Returns its full tool list." },
          statusFilter: { type: "string", enum: ["running", "stopped", "error", "all"], description: "Optional. Default 'all'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_kb",
      description: "List knowledge-base notes with structured metadata: total count, indexed paths, per-note size and modification time.\n\nUSE for: questions about 'what's in the knowledge base', 'how many notes', 'is there a note about X'. This is the AUTHORITATIVE source of truth — never bash/grep the user's vault directory to discover KB content; the canonical path is whatever `getVault()` returns (configured in Settings → 知识库).\n\nDO NOT use for: semantic search (use `kb_search`); reading a specific note (use `kb_get_note`); writing notes (use `kb_write`).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Optional. Max notes to return. Default 50." },
          offset: { type: "integer", description: "Optional. Pagination offset. Default 0." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description: "List all persistent memories (user/feedback/project/reference) with structured metadata: total count, by-type breakdown, names, descriptions, and per-memory file path.\n\nUSE for: any question about 'how many memories do you have', 'what do you remember about me', 'is there a memory about X'. This is the AUTHORITATIVE source of truth — never bash/grep `~/.aideagent/memories/` to discover memory files; that directory may contain unrelated markdown. The canonical path is `~/.aideagent/memory/`.\n\nDO NOT use for: reading a specific memory's full content (use `read_memory` or `write_memory` to search); saving new memory (use `write_memory`).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["user", "feedback", "project", "reference", "all"], description: "Optional. Filter to one memory type. Default: 'all'." },
          search: { type: "string", description: "Optional. If provided, returns only memories whose name or description contains this substring (case-insensitive)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description: "List all loaded skills with structured metadata: total count, by-source breakdown (canonical paths only), cross-source duplicates, and per-skill sourcePath/description/version.\n\nUSE for: any question about 'how many skills do you have', 'any duplicates', 'where do skills come from', 'is skill X installed'. This is the AUTHORITATIVE source of truth — never bash/grep the filesystem to answer such questions. The 3rd-party GitHub clone at `D:\\claude_skills\\skills-main\\skills` is NOT a loaded source; the only canonical paths are `~/.agents/skills/` and `~/.claude/skills/`.\n\nDO NOT use for: loading a specific skill's instructions (use `skill`); creating a skill (use `create_skill`).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional. If provided, returns detailed metadata for that skill only (path, description, triggers, version, source, allowedTools)." },
          source: { type: "string", enum: ["agents", "claude", "all"], description: "Optional. Filter to one source. Default: 'all'." },
          includeDuplicates: { type: "boolean", description: "Optional. Default true — include the `duplicates` array (names appearing in multiple sources)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description: "Load a skill (agent-created L2 or user-installed L3) by name and return its full instructions.\n\n**Unified tool (P2):** searches agent-created skills (L2) first, then installed skills (L3) as fallback. You do NOT need to choose between `skill` and `invoke_skill` — they are the same tool now; `invoke_skill` is kept as a deprecated alias.\n\nUSE for: when the system prompt's <skills> section lists a skill whose name or description matches the task — call this FIRST before improvising. The skill's SKILL.md contains step-by-step instructions the user has already curated.\n\nDO NOT use for: when no skill clearly matches the task; when you have already loaded the skill in this session (it will be re-loaded, which is fine but wasteful).",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "The skill name to load (e.g. 'review', 'qa', 'investigate')" },
        }, required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description: "Save an important fact to permanent cross-session memory.\n\nFour types: 'user' (about the user), 'feedback' (guidance/corrections from user), 'project' (ongoing work context), 'reference' (external system pointers).\n\nUSE for: user preferences, project deadlines/stand, stakeholder decisions, external API keys/URLs, recurring corrections.\n\nDO NOT save: code patterns/architecture (read the files); git history (git log is authoritative); debug solutions (the fix is in code); info already in CLAUDE.md/AGENTS.md; ephemeral task state; anything derivable from the current project. Only save non-obvious, non-derivable context that would be lost across sessions. Use 'name' and 'description' fields for future search. If updating, provide 'filename'.",
      parameters: {
        type: "object", properties: {
          type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type" },
          name: { type: "string", description: "Short descriptive name (e.g. 'user_role', 'feedback_tests_must_hit_db')" },
          description: { type: "string", description: "One-line summary used for relevance search" },
          content: { type: "string", description: "Markdown content. For 'feedback' type: start with the rule, then **Why:** and **How to apply:**." },
          filename: { type: "string", description: "If updating existing memory, provide the filename" },
        }, required: ["type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_skill",
      description: "**DEPRECATED — use `skill` instead.** This is an alias for the `skill` tool with identical behavior. Kept only for backward compatibility; new tool calls should use `skill`.",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "The skill name to invoke" },
        }, required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_skill",
      description: "Create a new reusable skill OR update an existing one (merge by name).\n\nUSE for: when you notice the user repeatedly asking for the same kind of task; when you discover a better way to do something already covered by a skill; when the user explicitly says 'remember how to do X'.\n\nDO NOT use for: one-off tasks (use `write_memory` instead to record a fact).",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "Skill name (lowercase-hyphenated, e.g. 'deploy-frontend')" },
          description: { type: "string", description: "Short description of what this skill does (updated if skill exists)" },
          prompt: { type: "string", description: "Description of the task pattern to encode as a skill, or improvements to add" },
        }, required: ["name", "description", "prompt"],
      },
    },
  },
  // ── Task Management ──
  {
    type: "function",
    function: {
      name: "TaskCreate",
      description: "Create a new task to track progress during complex multi-step work.\n\nUSE for: 3+ distinct steps; multi-file work; anything you would otherwise write a numbered todo list for. Use TaskCreate, then mark `in_progress` when starting each task and `completed` immediately when done.\n\nDO NOT use for: 1-2 simple steps; ephemeral session checkboxes (use `TodoWrite` instead, which is lighter-weight and lives only in this session).",
      parameters: {
        type: "object", properties: {
          subject: { type: "string", description: "A brief title for the task" },
          description: { type: "string", description: "What needs to be done" },
          activeForm: { type: "string", description: "Present continuous form shown during execution (e.g. 'Running tests')" },
        }, required: ["subject", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskUpdate",
      description: "Update a task's status or details. Mark in_progress when starting, completed when done.\n\n**IMPORTANT (anti-hallucination):** When setting status='completed', you MUST provide a non-empty `evidence` string that proves the task was actually done — e.g. a relevant command output line ('$ npm test → 12 passed'), a created/modified file path, a git commit hash, or a 1-line diff summary. If you cannot provide evidence, omit `status='completed'` and explain in your reply what went wrong instead. Tasks marked completed without evidence are recorded as 'unverified' in the UI so the user can double-check.",
      parameters: {
        type: "object", properties: {
          taskId: { type: "string", description: "The ID of the task to update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status" },
          subject: { type: "string", description: "New subject" },
          description: { type: "string", description: "New description" },
          evidence: { type: "string", description: "REQUIRED when status='completed': one-line proof the task was actually done (command output, file path, commit hash, or diff summary). Leave empty only if the task genuinely could not be completed." },
        }, required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskList",
      description: "List all tasks to see current progress.\n\nUSE for: mid-task orientation when you've been working on many tasks and lost track.\n\nDO NOT call repeatedly — only when you actually need a snapshot.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Todo Management ──
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the lightweight session todo checklist (NOT persistent across sessions).\n\nUSE for: 1-5 step tasks within a single turn where the user benefits from seeing live progress (rendered in the UI). Exactly one task `in_progress` at a time. Mark complete immediately after finishing.\n\nDO NOT use for: persistent tracking (use `TaskCreate`); >5 steps (use `TaskCreate` instead).",
      parameters: {
        type: "object", properties: {
          todos: {
            type: "array",
            description: "The full todo list (replaces previous list)",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "What to do (imperative, e.g. 'Fix auth bug')" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status" },
                activeForm: { type: "string", description: "Present continuous (e.g. 'Fixing auth bug')" },
              },
              required: ["content", "status", "activeForm"],
            },
          },
        }, required: ["todos"],
      },
    },
  },
  // ── User Interaction ──
  {
    type: "function",
    function: {
      name: "AskUserQuestion",
      description: "Ask the user multiple-choice questions to clarify ambiguity before acting.\n\nUSE for: when the request has 2-4 reasonable interpretations and guessing wrong would waste significant work; when choosing between 2+ valid approaches with different trade-offs; when confirming destructive/irreversible actions.\n\nDO NOT use for: simple yes/no confirmation; asking the same question you could answer yourself with file_read/grep; piling up trivial questions; more than 4 questions. Prefer to keep going if the cost of being wrong is low.",
      parameters: {
        type: "object", properties: {
          questions: {
            type: "array", minItems: 1, maxItems: 4,
            description: "Questions to ask (1-4)",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The complete question, ending with ?" },
                header: { type: "string", description: "Short label (max 12 chars)" },
                options: {
                  type: "array", minItems: 2, maxItems: 4,
                  description: "Available choices (2-4)",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Display text (1-5 words)" },
                      description: { type: "string", description: "What this option means" },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: { type: "boolean", description: "Allow multiple selections (default false)" },
              },
              required: ["question", "header", "options"],
            },
          },
        }, required: ["questions"],
      },
    },
  },
  // ── Sub-agent ──
  {
    type: "function",
    function: {
      name: "Agent",
      description: "Launch a read-only sub-agent for INDEPENDENT research tasks in parallel.\n\nUSE for: gathering information from 2+ independent sources simultaneously (e.g. read 3 different files for context, or search web + grep code in parallel). Sub-agents have access to web_search, web_fetch, file_read, grep, glob. They return a single text summary — they CANNOT modify files.\n\nDO NOT use for: sequential tasks (one task depends on another's result); single quick lookups; anything that needs file modification. Don't use Agent when the same job can be done with one direct tool call.",
      parameters: {
        type: "object", properties: {
          description: { type: "string", description: "Short name for this sub-task (e.g. 'search AI news', 'find TODO files')" },
          prompt: { type: "string", description: "The complete task for the sub-agent. Be specific about what to find and what format to return." },
        }, required: ["description", "prompt"],
      },
    },
  },
  // ── Knowledge Base ──
  {
    type: "function",
    function: {
      name: "kb_search",
      description: "Search the user's knowledge base (Obsidian vault) for notes matching a query. Returns relevant snippets.\n\nUSE for: when the system prompt's <knowledge-base> section doesn't have enough detail; when you need to find specific information from the user's personal notes; questions about the user's projects/notes/research.\n\nDO NOT use for: searching the current project (use `grep` / `glob`); reading a known note (use `kb_get_note`); general web search (use `web_search`).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (keywords or question)" },
          limit: { type: "number", description: "Max notes to return (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_write",
      description: "Create or update a note in the user's knowledge base (Obsidian vault).\n\nUSE for: saving research findings, organized knowledge, long-form notes the user may want to re-read later. Auto-injected into future prompts as <knowledge-base>.\n\nDO NOT use for: cross-session user facts (use `write_memory`); session scratchpads.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path for the note (e.g. 'folder/note.md')" },
          content: { type: "string", description: "Markdown content of the note" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for the note" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_get_note",
      description: "Read the full content of a specific note from the knowledge base.\n\nUSE for: after `kb_search` returns a result and you need the full text of a specific note; or when you know the exact path.\n\nDO NOT use for: searching (use `kb_search`); reading current project files (use `file_read`).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Relative path of the note (e.g. 'folder/note.md')" },
        },
        required: ["path"],
      },
    },
  },
  // ── LSP Tool ──
  {
    type: "function",
    function: {
      name: "lsp",
      description: "Language Server Protocol: go to definition, find references, hover info, document symbols. Requires a language server installed for the file's language.\n\nUSE for: navigating code (jump to where a symbol is defined); finding all callers of a function; reading type signatures on hover; listing symbols in a file.\n\nDO NOT use for: code search by content (use `grep`); finding files (use `glob`); when no language server is configured for the file type — fall back to grep + file_read.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["goToDefinition", "findReferences", "hover", "documentSymbol"], description: "The LSP operation" },
          filePath: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (1-based)" },
          character: { type: "number", description: "Character offset (1-based)" },
        },
        required: ["operation", "filePath"],
      },
    },
  },
  // ── Git Tools ──
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show uncommitted git changes (`git diff`). Optionally filter to a specific file or show staged changes.\n\nUSE for: reviewing what you've changed before committing; showing the user the diff; confirming the working state.\n\nDO NOT use for: viewing file contents (use `file_read`); viewing history (use `bash git log`).",
      parameters: {
        type: "object", properties: {
          file: { type: "string", description: "Specific file path to diff" },
          staged: { type: "boolean", description: "If true, show staged changes (`git diff --cached`)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage changes and create a git commit. If `message` is omitted, returns the diff for the AI to generate a commit message.\n\nUSE for: committing work after the user approves.\n\nDO NOT use for: pushing (push is separate); committing without user consent on shared branches.",
      parameters: {
        type: "object", properties: {
          message: { type: "string", description: "Commit message. If omitted, AI will generate one from the diff." },
          files: { type: "array", items: { type: "string" }, description: "Specific files to stage. If omitted, stages all changed files." },
          amend: { type: "boolean", description: "If true, amend the last commit" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "Create, switch, list, or query git branches.\n\nUSE for: starting a new feature branch; switching contexts; listing local branches.\n\nDO NOT use for: committing changes (use `git_commit`); viewing history (use `bash git log`).",
      parameters: {
        type: "object", properties: {
          action: { type: "string", enum: ["create", "switch", "list", "current"], description: "Branch action" },
          name: { type: "string", description: "Branch name (required for create/switch)" },
        },
        required: ["action"],
      },
    },
  },
  // ── GitHub (gh cli) ──
  {
    type: "function",
    function: {
      name: "gh_pr",
      description: "GitHub Pull Request operations via `gh` CLI. Create, view, list, diff, merge, checkout, or close PRs.\n\nUSE for: any GitHub PR workflow.\n\nDO NOT use for: pushing branches (use `bash git push`); non-GitHub git operations.",
      parameters: {
        type: "object", properties: {
          action: {
            type: "string",
            enum: ["create", "view", "list", "diff", "merge", "checkout", "close"],
            description: "PR action",
          },
          title: { type: "string", description: "PR title (required for create)" },
          body: { type: "string", description: "PR description/body (for create)" },
          base: { type: "string", description: "Base branch (for create, default: main)" },
          head: { type: "string", description: "Head branch (for create, default: current branch)" },
          pr: { type: "string", description: "PR number or URL (for view/diff/merge/checkout/close)" },
          state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Filter PRs by state (for list)" },
          limit: { type: "number", description: "Max PRs to list (default 20)" },
          reviewer: { type: "string", description: "Filter by reviewer (for list)" },
          json: { type: "boolean", description: "If true, return raw JSON output" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gh_issue",
      description: "GitHub Issue operations via `gh` CLI. Create, view, list, close, reopen, or comment on issues.\n\nUSE for: any GitHub issue workflow.\n\nDO NOT use for: PRs (use `gh_pr`); local TODO tracking (use `TaskCreate` / `TodoWrite`).",
      parameters: {
        type: "object", properties: {
          action: {
            type: "string",
            enum: ["create", "view", "list", "close", "reopen", "comment"],
            description: "Issue action",
          },
          title: { type: "string", description: "Issue title (required for create)" },
          body: { type: "string", description: "Issue description (for create/comment)" },
          issue: { type: "string", description: "Issue number or URL (for view/close/reopen/comment)" },
          state: { type: "string", enum: ["open", "closed", "all"], description: "Filter issues by state (for list)" },
          label: { type: "string", description: "Filter by label (comma-separated)" },
          assignee: { type: "string", description: "Filter by assignee" },
          limit: { type: "number", description: "Max issues to list (default 20)" },
          json: { type: "boolean", description: "If true, return raw JSON output" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gh_repo",
      description: "GitHub repository info via `gh` CLI. View repo details, list user repos, view README, clone, or create new repo.\n\nUSE for: GitHub repo lookup, listing the user's repos, or creating a new GitHub repo.\n\nDO NOT use for: cloning via local protocol (use `bash git clone`); non-GitHub operations.",
      parameters: {
        type: "object", properties: {
          action: {
            type: "string",
            enum: ["view", "list", "readme", "clone", "create"],
            description: "Repo action",
          },
          repo: { type: "string", description: "Repository (owner/repo format, for view/clone)" },
          url: { type: "string", description: "URL to clone (for clone)" },
          name: { type: "string", description: "Repo name (for create)" },
          description: { type: "string", description: "Repo description (for create)" },
          private: { type: "boolean", description: "Make repo private (for create, default false)" },
          visibility: { type: "string", enum: ["public", "private"], description: "Visibility (for list)" },
          limit: { type: "number", description: "Max repos to list (default 20)" },
        },
        required: ["action"],
      },
    },
  },
];
