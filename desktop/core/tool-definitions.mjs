// ── Tool Definitions (OpenAI function calling) ─────────────

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a PowerShell command on Windows. Use for file operations, git, npm, running scripts, exploring project structure.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The PowerShell command to execute" },
          description: { type: "string", description: "Brief description shown to user" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read the full text content of a file.",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
        }, required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Create or overwrite a file. Auto-creates parent directories.",
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
      description: "Edit a file by replacing exact matching text (surgical edit).",
      parameters: {
        type: "object", properties: {
          path: { type: "string", description: "Path to the file" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
        }, required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with regex. Returns file:line matches.",
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
      description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.css).",
      parameters: {
        type: "object", properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory (default: workspace)" },
        }, required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and extract readable text content. Use to read web pages, documentation, articles, or API responses.",
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
      description: "Search the internet for current information. Use when you need up-to-date news, facts, documentation, or data not in training. Returns AI-friendly snippets with source URLs.",
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
      name: "skill",
      description: "Load a user-installed skill (a guided workflow in SKILL.md format). Skills provide step-by-step instructions for specific tasks like code review, QA testing, debugging, deployment, etc. Call this first to see what skills are available, then load the one you need.",
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
      description: "Save an important fact to permanent memory. Four types: 'user' (about the user), 'feedback' (guidance/corrections from user), 'project' (ongoing work context), 'reference' (external system pointers). Use 'name' and 'description' fields for future search. If updating, provide 'filename'.\n\nDO NOT save: code patterns/architecture (derivable from files), git history (git log is authoritative), debug solutions (the fix is in the code), info already in CLAUDE.md, or ephemeral task state. Only save non-obvious, non-derivable context.",
      parameters: {
        type: "object", properties: {
          type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type: user (personal info/preferences), feedback (user's guidance/corrections), project (ongoing work context), reference (external system pointers)" },
          name: { type: "string", description: "Short descriptive name (e.g. 'user_role', 'feedback_tests_must_hit_db')" },
          description: { type: "string", description: "One-line summary used for relevance search" },
          content: { type: "string", description: "The information to remember, in markdown format. For feedback type: start with the rule, then **Why:** and **How to apply:**." },
          filename: { type: "string", description: "If updating existing memory, provide the filename (e.g. 'user_role.md')" },
        }, required: ["type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_skill",
      description: "Load and execute a saved skill. Skills are reusable workflows created by the user or generated by the agent. Call this tool to get the full skill instructions when you need to perform a task that has a matching skill.",
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
      description: "Create a new reusable skill OR update an existing one. If a skill with this name already exists, the new information will be merged in and the version bumped. Call this when you notice the user repeatedly asking for the same kind of task, or when you discover a better way to do something already in a skill.",
      parameters: {
        type: "object", properties: {
          name: { type: "string", description: "Skill name (lowercase-hyphenated, e.g. 'deploy-frontend')" },
          description: { type: "string", description: "Short description of what this skill does (updated if skill exists)" },
          prompt: { type: "string", description: "Description of the task pattern to encode as a skill, or improvements to add to existing skill" },
        }, required: ["name", "description", "prompt"],
      },
    },
  },
  // ── Task Management ──
  {
    type: "function",
    function: {
      name: "TaskCreate",
      description: "Create a new task to track progress during complex multi-step work. Use for organizing 3+ distinct steps.",
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
      description: "Update a task's status or details. Mark tasks in_progress when starting, completed when done. Use 'deleted' to remove irrelevant tasks.",
      parameters: {
        type: "object", properties: {
          taskId: { type: "string", description: "The ID of the task to update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status" },
          subject: { type: "string", description: "New subject for the task" },
          description: { type: "string", description: "New description for the task" },
        }, required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskList",
      description: "List all tasks in the task list to see current progress.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Todo Management ──
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the session todo checklist. Use proactively to track progress. Exactly one task in_progress at a time. Mark tasks complete immediately after finishing. Provide both 'content' (imperative) and 'activeForm' (present continuous) for each task.",
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
      description: "Ask the user multiple-choice questions to gather information, clarify ambiguity, or understand preferences. Use when you need user input before proceeding.",
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
      description: "Launch a read-only sub-agent to search the web or explore code IN PARALLEL while you continue other work. Sub-agents can use: web_search, web_fetch, file_read, grep, glob. Use this when you need to gather information from multiple sources simultaneously. The sub-agent works independently and returns a text summary. Example: to search for latest AI news while also checking code, call Agent twice with different prompts.",
      parameters: {
        type: "object", properties: {
          description: { type: "string", description: "Short name for this sub-task (e.g. 'search AI news', 'find TODO files')" },
          prompt: { type: "string", description: "The complete task for the sub-agent. Be specific about what to find and what format to return. Example: 'Search the web for the top 3 AI news stories this week and summarize each in 2-3 sentences.'" },
        }, required: ["description", "prompt"],
      },
    },
  },
  // ── Knowledge Base ──
  {
    type: "function",
    function: {
      name: "kb_write",
      description: "Create or update a note in the user's knowledge base (Obsidian vault). Use this to save important findings, research results, or organized knowledge.",
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
  // ── LSP Tool ──
  {
    type: "function",
    function: {
      name: "lsp",
      description: "Language Server Protocol: go to definition, find references, hover info, document symbols. Requires a language server installed for the file's language.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["goToDefinition", "findReferences", "hover", "documentSymbol"], description: "The LSP operation to perform" },
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
      description: "Show current uncommitted changes (git diff). Optionally show diff for a specific file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Optional: specific file path to diff" },
          staged: { type: "boolean", description: "If true, show staged changes (git diff --cached)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage changes and create a git commit. If message is omitted, returns diff for AI to generate a commit message.",
      parameters: {
        type: "object",
        properties: {
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
      description: "Create, switch, or list git branches.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "switch", "list", "current"], description: "Branch action" },
          name: { type: "string", description: "Branch name (required for create/switch)" },
        },
        required: ["action"],
      },
    },
  },
  // ── GitHub (gh CLI) ──
  {
    type: "function",
    function: {
      name: "gh_pr",
      description: "GitHub Pull Request operations via gh CLI. Create, view, list, diff, merge, or checkout PRs.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "view", "list", "diff", "merge", "checkout", "close"],
            description: "PR action: create (open new PR), view (show PR details), list (list PRs), diff (show PR diff), merge (merge PR), checkout (switch to PR branch), close (close PR without merging)",
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
      description: "GitHub Issue operations via gh CLI. Create, view, list, close, comment on issues.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "view", "list", "close", "reopen", "comment"],
            description: "Issue action: create (open new issue), view (show issue details), list (list issues), close (close issue), reopen (reopen closed issue), comment (add comment to issue)",
          },
          title: { type: "string", description: "Issue title (required for create)" },
          body: { type: "string", description: "Issue description (for create/comment)" },
          issue: { type: "string", description: "Issue number or URL (for view/close/reopen/comment)" },
          state: { type: "string", enum: ["open", "closed", "all"], description: "Filter issues by state (for list)" },
          label: { type: "string", description: "Filter by label (for list, comma-separated)" },
          assignee: { type: "string", description: "Filter by assignee (for list)" },
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
      description: "GitHub repository info via gh CLI. View repo details, list repos, view README.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["view", "list", "readme", "clone", "create"],
            description: "Repo action: view (show repo details), list (list user repos), readme (view README), clone (clone repo), create (create new repo)",
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
