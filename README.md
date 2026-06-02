# GoodAgent

> 一个功能强大的桌面 AI 助手，拥有 28 个内置工具、知识库 RAG、多模型支持、Hook 扩展、自动压缩继续、自进化记忆等能力。  
> A powerful desktop AI assistant with 28 built-in tools, RAG knowledge base, multi-model support, Hook extensions, automatic context continuation, and self-evolving memory.

---

## 项目简介 / Introduction

**中文**：GoodAgent 是一款桌面 AI 助手，支持多种大语言模型（DeepSeek、Claude、GLM、Qwen、MiniMax 等），内置丰富的工具集，可以帮你编程、搜索、管理文件、操作 Git、查阅知识库，让 AI 真正成为一个能干的助手。

**English**: GoodAgent is a desktop AI assistant supporting multiple LLMs (DeepSeek, Claude, GLM, Qwen, MiniMax, etc.) with a rich built-in toolset. It helps you code, search, manage files, operate Git, and query knowledge bases — making AI a truly capable assistant.

---

## 功能特性 / Features

### 多模型支持 / Multi-Model Support

内置 8 个模型供应商预设，一键切换。支持 OpenAI 兼容和 Anthropic 两种 API 格式，也可以自定义任何兼容的 API 地址。  
Built-in 8 provider presets with one-click switching. Supports both OpenAI-compatible and Anthropic API formats. Custom API endpoints are also supported.

| 供应商 / Provider | 说明 / Description |
|--------|------|
| DeepSeek | V4-Flash / V4-Pro |
| GLM（智谱） | GLM-4.7-Flash / GLM-4-Plus |
| Qwen（通义千问） | Qwen3.7-Max / Qwen-Plus |
| Claude（Anthropic） | Sonnet 4.6 / Opus 4.7 / Haiku 4.5 |
| MiniMax | M2.7 / M2.7-Highspeed |
| llama.cpp | 本地部署 / Local |
| LM Studio | 本地部署 / Local |
| Ollama | 本地部署 / Local |

---

### 28 个内置工具 / 28 Built-in Tools

#### 文件与代码 / Files & Code
| 工具 / Tool | 说明 / Description |
|------|------|
| `file_read` | 读取文件内容 / Read file content |
| `file_write` | 创建或覆盖文件 / Create or overwrite files |
| `file_edit` | 精确替换文本（支持多行匹配）/ Surgical text replacement |
| `grep` | 正则搜索代码内容 / Regex search in code |
| `glob` | 按文件名模式查找文件 / Find files by glob pattern |
| `lsp` | 代码智能：跳转定义、查找引用、悬停信息 / Language server: go-to-def, references, hover |

#### 命令执行 / Shell
| 工具 / Tool | 说明 / Description |
|------|------|
| `bash` | 跨平台命令执行（Windows=pwsh, Linux/macOS=bash），含危险操作检测与 Hook 拦截 / Cross-platform shell with dangerous command detection and Hook interception |

#### 网络搜索 / Web
| 工具 / Tool | 说明 / Description |
|------|------|
| `web_search` | 搜索互联网（Tavily API）/ Search the internet |
| `web_fetch` | 抓取并提取网页内容（含 SSRF 防护）/ Fetch and extract web content (with SSRF protection) |

#### 版本控制 / Version Control
| 工具 / Tool | 说明 / Description |
|------|------|
| `git_diff` | 查看 Git 差异 / View git diff |
| `git_commit` | 创建 Git 提交（使用安全 spawn，防命令注入）/ Create commit (safe spawn, injection-proof) |
| `git_branch` | 管理 Git 分支 / Manage git branches |
| `gh_pr` | 管理 GitHub Pull Request / GitHub PR management |
| `gh_issue` | 管理 GitHub Issue / GitHub Issue management |
| `gh_repo` | 查看 GitHub 仓库信息 / View GitHub repo info |

#### 知识管理 / Knowledge Management
| 工具 / Tool | 说明 / Description |
|------|------|
| `kb_search` | 搜索知识库（FTS5 全文 + 向量语义 + RRF 融合）/ Hybrid RAG search |
| `kb_write` | 写入笔记到知识库 / Write notes to knowledge base |
| `kb_get_note` | 读取知识库单条笔记 / Read a single knowledge base note |
| `write_memory` | 保存跨会话的永久记忆 / Save persistent cross-session memories |

#### 任务与协作 / Tasks & Collaboration
| 工具 / Tool | 说明 / Description |
|------|------|
| `TaskCreate` | 创建任务追踪复杂工作 / Create tasks for tracking complex work |
| `TaskUpdate` | 更新任务状态 / Update task status |
| `TaskList` | 查看所有任务进度 / View all tasks |
| `TodoWrite` | 写临时待办清单 / Write session todo checklist |
| `AskUserQuestion` | 多选问题询问用户 / Ask user multiple-choice questions |

#### 技能系统 / Skill System
| 工具 / Tool | 说明 / Description |
|------|------|
| `skill` | 加载 L3 安装技能 / Load installed skills |
| `invoke_skill` | 调用 Agent 自创技能（L2），自动回退到 L3 / Invoke agent-created skills with L3 fallback |
| `create_skill` | 创建或更新技能工作流（LLM 自动生成内容）/ Create or update skills (LLM auto-generates) |

#### 子代理 / Sub-Agent
| 工具 / Tool | 说明 / Description |
|------|------|
| `Agent` | 启动只读子代理，并行执行研究任务 / Launch read-only sub-agents for parallel research |

---

### MCP 扩展 / MCP Extensions

**中文**：支持 Model Context Protocol，可接入外部工具服务器。支持本地进程（stdio）和远程服务（HTTP）两种方式，自动检测 Claude Code、Claude Desktop、OpenCode 的本地 MCP 配置。接入后，MCP 工具与内置工具统一调用。

**English**: Supports Model Context Protocol for external tool servers via stdio and HTTP. Auto-detects local MCP configurations from Claude Code, Claude Desktop, and OpenCode. MCP tools are seamlessly integrated alongside built-in tools.

---

### 知识库 / Knowledge Base (RAG)

**中文**：对接 Obsidian vault，实现本地知识检索。

- **混合搜索**：FTS5 关键词全文搜索 + 向量语义搜索
- **RRF 融合**：自动合并两种搜索结果，取最相关的内容
- **向量模型**：内置 MiniLM-L6（离线可用，打包进应用），也支持 Ollama 自定义模型
- **智能截断**：自动检测 Ollama 模型上下文长度，按模型能力截断嵌入文本
- **即时注入**：相关笔记自动注入到对话 system prompt 中

**English**: Connects to Obsidian vault for local knowledge retrieval.

- **Hybrid Search**: FTS5 keyword search + vector semantic search
- **RRF Fusion**: Automatically merges both search results for optimal relevance
- **Vector Models**: Bundled MiniLM-L6 (offline-ready, shipped with the app), Ollama with model selection
- **Smart Truncation**: Auto-detects Ollama model context length for optimal embedding
- **Context Injection**: Relevant notes are automatically injected into the system prompt

---

### 持久记忆 / Persistent Memory

**中文**：跨会话的记忆系统，让 Agent 越用越了解你。

- 多文件 Markdown 存储，支持类型标签（用户偏好、项目背景、反馈纠错、参考资源）
- **语义选择**：每次对话自动挑选最相关的记忆注入上下文
- **去重检测**：防止重复保存相似内容

**English**: Cross-session memory system that helps the agent learn about you over time.

- Multi-file Markdown storage with type tags (user, project, feedback, reference)
- **Semantic Selection**: Auto-selects the most relevant memories for each conversation
- **Deduplication**: Prevents saving duplicate content

---

### 自进化 / Self-Evolution

**中文**：对话结束后自动反思，提取长期记忆。

- **自动审查**：每次对话结束后，Agent 在后台分析最近的交流
- **提取三类记忆**：用户偏好（PREFERENCE）、技术决策（DECISION）、新知识（KNOWLEDGE）
- **自动写入**：提取到的信息自动保存到 USER.md / MEMORY.md
- **零感知**：后台静默完成，不影响对话体验

**English**: Automatic post-session reflection and memory extraction.

- **Auto-Review**: After each session, the agent analyzes recent exchanges in the background
- **Three Memory Types**: User preferences, technical decisions, and new knowledge
- **Auto-Save**: Extracted insights are automatically saved to USER.md / MEMORY.md
- **Zero Friction**: Runs silently in the background without affecting the conversation

---

### 自动压缩继续 / Auto-Compress & Continue

**中文**：处理超长复杂任务时，Agent 不会中断。

- **上下文感知**：当 token 使用量达到 90%（256K 窗口）时自动触发
- **摘要压缩**：调用 LLM 对历史对话做智能摘要，保留关键决策和文件信息
- **无缝继续**：重建上下文后自动继续工作，对话中显示"第 N 次自动继续"
- **最多 5 次**：每轮 50 个工具调用 × 5 次继续 = 最多 250 轮有效工作

**English**: Handles ultra-long complex tasks without interruption.

- **Context-Aware**: Automatically triggers at 90% token usage (256K window)
- **AI Summarization**: Uses LLM to intelligently summarize conversation history, preserving key decisions
- **Seamless Continuation**: Automatically resumes work after rebuilding context
- **Up to 5x**: 50 tool calls per turn × 5 continuations = up to 250 effective rounds

---

### Project Context 自动加载 / AGENTS.md Auto-Loading

**中文**：Agent 启动时自动读取项目规范文件。

- **多标准兼容**：优先读 `AGENTS.md`，兼容 `CLAUDE.md`
- **两级加载**：项目级（workspace 根目录）+ 全局级（`~/.goodagent/CLAUDE.md`）
- **零配置**：文件存在就自动加载，不存在就静默跳过

**English**: Automatically loads project context files at session start.

- **Multi-Standard**: Reads `AGENTS.md` first, `CLAUDE.md` as fallback
- **Two Levels**: Project-level (workspace root) + global-level (`~/.goodagent/CLAUDE.md`)
- **Zero Config**: Files are loaded automatically if they exist, silently skipped otherwise

---

### Hook 系统 / Hook System

**中文**：Agent 行为可编程——在关键动作前后自动执行你的脚本。

- **3 个核心事件**：PreToolUse（工具执行前拦截）、PostToolUse（工具执行后处理）、SessionEnd（对话结束时通知）
- **JSON 协议**：stdin/stdout JSON 通信，Node.js 脚本，跨平台统一
- **安全护栏**：enabled 开关、tools 过滤、路径穿越防护、超时兜底
- **示例脚本**：项目内置危险命令拦截、自动格式化、对话通知等示例

**English**: Programmable agent behavior — run your scripts before and after key actions.

- **3 Core Events**: PreToolUse (intercept before tool), PostToolUse (process after tool), SessionEnd (on session end)
- **JSON Protocol**: stdin/stdout JSON communication, Node.js scripts, cross-platform
- **Safety Guards**: enabled toggle, tools filter, path traversal protection, timeout fallback
- **Example Scripts**: Built-in examples for dangerous command interception, auto-formatting, and notifications

---

### 会话管理 / Session Management

**中文**：
- 对话自动保存到 SQLite 数据库（含 FTS5 全文搜索）
- **多开对话**：Agent 在后台继续运行时，可以查看其他对话或开启新对话
- 全文搜索历史对话
- 导出为 Markdown 文件
- 支持编辑和删除单条消息

**English**:
- Auto-save to SQLite database with FTS5 full-text search
- **Multi-Session**: Browse other conversations or start new ones while agent runs in background
- Full-text search across conversation history
- Export to Markdown
- Edit and delete individual messages

---

### 安全特性 / Security

**中文**：
- **计划模式**：只读模式，Agent 只能读取和规划，不能执行写操作
- **API 密钥加密**：使用操作系统级加密存储（Electron safeStorage），非明文
- **路径防护**：知识库写入时验证路径，防止越权；Hook 脚本路径穿越防护
- **命令注入防护**：git/gh 命令使用数组参数 spawn，不经 shell 拼接
- **SSRF 防护**：web_fetch 拦截内网地址（localhost/192.168/169.254）
- **XSS 防护**：知识库面板全部使用 textContent，无 innerHTML
- **危险命令检测**：执行前检测 rm -rf / format 等并请求确认

**English**:
- **Plan Mode**: Read-only mode — agent can only read and plan, no write operations
- **Encrypted API Keys**: OS-level encryption via Electron safeStorage
- **Path Protection**: Knowledge base path validation; Hook script path traversal prevention
- **Command Injection Prevention**: git/gh commands use array-based spawn, never shell string interpolation
- **SSRF Protection**: web_fetch blocks internal network addresses
- **XSS Prevention**: Knowledge base panel uses textContent, zero innerHTML
- **Dangerous Command Detection**: Detects rm -rf, format, etc. and requests user confirmation

---

### 界面特性 / UI Features

**中文**：
- 暗色主题，长时间使用不伤眼
- 流式渲染，推理过程可展开查看
- LaTeX 数学公式渲染
- 代码块语法高亮（highlight.js）
- 中英文界面一键切换
- 12 个设置面板（API/头像/技能/提示词/MCP/社交/记忆/知识库/Agent 技能/字体/语言/关于）
- 工作区间路径在侧边栏持续可见，点击可快捷切换目录
- 自定义头像和名称

**English**:
- Dark theme with streaming response rendering
- Expandable reasoning/thinking section
- LaTeX math formula rendering
- Code syntax highlighting (highlight.js)
- One-click Chinese/English UI switch
- 12 settings panels (API/Avatar/Skills/Prompt/MCP/Social/Memory/Knowledge Base/Agent Skills/Font/Language/About)
- Workspace path persistent in sidebar with quick-switch on click
- Custom avatar and agent name

---

### 微信机器人 / WeChat Bot

**中文**：扫码登录微信，通过微信给 Agent 发消息，Agent 自动回复（使用完整对话能力）。

**English**: QR code login to WeChat. Send messages to the agent via WeChat, and the agent auto-replies using its full conversational capabilities.

---

### 自动更新 / Auto-Update

**中文**：支持版本检测和一键更新，可开启启动时自动检查，显示更新日志和下载进度。

**English**: Version detection and one-click update via electron-updater. Optional auto-check on startup with changelog and progress display.

---

### Agent 技能系统 / Agent Skill System

**中文**：
- **自主提炼**：Agent 检测到重复任务模式后，可自动创建技能
- **模式检测**：分析最近 30 个对话，发现高频话题，提示提炼为技能
- **Curator 自动管理**：30 天未使用的技能自动归档，检测重复技能建议合并
- **L2/L3 双系统**：Agent 自创技能（L2）+ 社区安装技能（L3），双通道调用，自动回退

**English**:
- **Autonomous Creation**: Agent detects repeated task patterns and auto-creates skills
- **Pattern Detection**: Analyzes last 30 sessions, surfaces high-frequency topics for skill creation
- **Curator Auto-Management**: Auto-archives skills unused for 30 days, detects duplicates
- **L2/L3 Dual System**: Agent-created skills (L2) + community-installed skills (L3), dual-channel with automatic fallback

---

## 快速开始 / Quick Start

### 安装运行 / Install & Run

```bash
git clone https://github.com/quanzefeng/GoodAgent.git
cd GoodAgent/desktop
npm install
npm start
```

首次运行会自动下载内嵌模型 MiniLM-L6（~23MB），之后完全离线可用。  
On first run, the bundled MiniLM-L6 model (~23MB) is downloaded automatically. Fully offline thereafter.

### 配置 API / Configure API

**中文**：打开 **设置 → API 配置**，选择模型供应商，填入 API 密钥和地址，选择模型后保存即可。

**English**: Open **Settings → API Config**, select a provider, enter your API key and URL, choose a model, and save.

---

## 快捷键 / Keyboard Shortcuts

| 快捷键 / Shortcut | 功能 / Function |
|--------|------|
| Enter | 发送消息 / Send |
| Ctrl+I | 打开设置 / Settings |

---

## 开发者 / Development

```bash
npm run dev          # 开发模式 / Dev mode
npm run download-model  # 下载嵌入模型 / Download embedding model
npm test             # 运行测试 / Run tests
npm run lint         # 代码检查 / Lint
npm run typecheck    # 类型检查 / Type check
npm run dist:win     # 打包 Windows / Build Windows
npm run dist:mac     # 打包 macOS / Build macOS
npm run dist:linux   # 打包 Linux / Build Linux
```

### 项目结构 / Project Structure

```
desktop/
  main.mjs                 # 应用入口 / App entry
  preload.cjs              # IPC 通道桥接 / IPC bridge (~60 channels)
  core/                    # 主进程核心模块 / Main process core
    agent-loop.mjs         # 对话主线 + 自动压缩继续 + 自进化 / Conversation loop + auto-continue + auto-review
    tool-executor.mjs      # 28 工具调度 + 跨平台 Shell / Tool dispatch + cross-platform shell
    tool-definitions.mjs   # 工具定义 / Tool definitions
    system-prompt.mjs      # 系统提示词构建 + AGENTS.md 加载 / Prompt builder + AGENTS.md loading
    format-adapters.mjs    # OpenAI / Anthropic API 适配器 / API format adapters
    token-budget.mjs       # Token 估算 + 上下文压缩 + 摘要继续 / Token estimation + context compression
    hook-manager.mjs       # Hook 系统 / Hook system
    sub-agent.mjs          # 子代理 / Sub-agent
    state.mjs              # 共享状态 + 平台检测 / Shared state + platform detection
    ipc-handlers.mjs       # IPC 处理器（~80 handlers）/ IPC handlers
    memory-selection.mjs   # 记忆语义选择 / Semantic memory selection
    skill-scanner.mjs      # L3 技能扫描 / L3 skill scanner
    workspace-config.mjs   # 工作区间持久化 / Workspace persistence
  session-db.mjs           # 会话数据库 / Session database (SQLite+FTS5)
  memory-store.mjs         # 记忆存储 / Memory store
  skills-store.mjs         # L2 技能存储 / L2 skill store
  knowledge-store.mjs      # 知识库 RAG / Knowledge base RAG (SQLite+FTS5+vectors)
  mcp-manager.mjs          # MCP 协议管理 / MCP manager (JSON-RPC 2.0)
  lsp-manager.mjs          # LSP 客户端 / LSP client
  update-manager.mjs       # 自动更新 / Auto-updater
  renderer/                # 渲染进程 / Renderer
    index.html             # 主界面 / Main UI
    app.js                 # 主逻辑 / Main logic
    style.css              # 样式 / Styles
    translations.js        # 中/英文翻译 / i18n (zh-CN + en)
    modules/               # UI 模块 / UI modules
  test/                    # Vitest 测试 / Tests
  models/                  # 内嵌模型 / Bundled models (MiniLM-L6)
  scripts/                 # 构建脚本 / Build scripts
```

---

## 联系方式 / Contact

- 微信 / WeChat: q2993919594
- 谷歌邮箱 / Email: zefengquan5@gmail.com
- GitHub: https://github.com/quanzefeng/GoodAgent
