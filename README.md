<div align="center">

# 🤖 AideAgent

### The open-source Claude Desktop alternative — 28 tools, local RAG, Prompt Caching, in 50MB.

[![GitHub stars](https://img.shields.io/github/stars/quanzefeng/AideAgent?style=flat-square)](https://github.com/quanzefeng/AideAgent/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/quanzefeng/AideAgent?style=flat-square)](https://github.com/quanzefeng/AideAgent/network)
[![GitHub release](https://img.shields.io/github/v/release/quanzefeng/AideAgent?style=flat-square)](https://github.com/quanzefeng/AideAgent/releases)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![Electron](https://img.shields.io/badge/Electron-40-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](#-download)

</div>

---

## 👀 What is AideAgent?

AideAgent is a **local-first desktop AI assistant** that does everything Claude Desktop does — and more — but **free, open-source, and 5× smaller**.

- 🛡️ **Your data never leaves your machine** — offline MiniLM-L6 embedding, OS-encrypted API keys, SSRF protection
- ⚡ **Save 90% on API bills** — explicit Prompt Caching (Anthropic + DeepSeek) with live hit-rate display
- 🧰 **28 built-in tools** — file/shell/git/GitHub/MCP/LSP/skill/kb, all in one binary
- 🔌 **Plays nice with the ecosystem** — auto-detects Claude Code/Desktop MCP configs, one-click install of 200+ skills
- 💬 **WeChat bot** — talk to your agent from your phone

> Built by one developer in 24 days. **17 releases. 180 commits. 25 test files. 50MB install.**

---

## 📸 Preview

<table>
<tr>
<td width="50%">

**Main Chat Interface**  
左侧会话列表 + 工作目录，中间流式对话区，底部 4 个智能开关（计划模式 / 知识库 / 联网搜索 / 深度推理）

![Main Chat](docs/screenshots/01-main-chat.png)

</td>
<td width="50%">

**Knowledge Base Search (Hybrid RAG)**  
FTS5 关键词 + 向量语义 + RRF 融合，3 亿字 Obsidian vault 也能秒级定位

![KB Search](docs/screenshots/02-knowledge-base-search.png)

</td>
</tr>
<tr>
<td width="50%">

**28 Tools Overview**  
Agent 自主介绍能力：编程、搜索、管理文件、操作 Git、查阅知识库，一应俱全

![Features](docs/screenshots/03-features-overview.png)

</td>
<td width="50%">

**Local-First Tech Stack**  
内嵌 MiniLM-L6 离线嵌入 / 198 篇已索引笔记 / 4 类持久记忆 / 0 远程依赖

![Tech Stack](docs/screenshots/04-tech-stack.png)

</td>
</tr>
</table>

---

## ⚖️ AideAgent vs The Alternatives

> Tired of paying $20/mo for tools that don't have RAG, hooks, or WeChat integration?

| Feature | **AideAgent** | Claude Desktop | Cursor | Cline | Continue |
|---|:---:|:---:|:---:|:---:|:---:|
| **Price** | Free + OSS | $20/mo | $20/mo | Free + OSS | Free + OSS |
| **Open Source** | ✅ Apache-2.0 | ❌ | ❌ | ✅ Apache-2.0 | ✅ Apache-2.0 |
| **Local RAG / Knowledge Base** | ✅ Built-in hybrid | ❌ | ⚠️ Paid add-on | ❌ | ⚠️ Basic |
| **Prompt Caching** | ✅ Explicit + visible | ✅ Built-in (hidden) | ⚠️ Black box | ❌ | ❌ |
| **Hook System** | ✅ 3 events | ❌ | ❌ | ❌ | ❌ |
| **MCP Support** | ✅ Auto-detect | ✅ | ⚠️ Limited | ✅ | ⚠️ Limited |
| **LSP Integration** | ✅ Built-in | ❌ | ✅ | ❌ | ⚠️ Basic |
| **WeChat Bot** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Self-Evolving Memory** | ✅ Auto | ❌ | ❌ | ❌ | ❌ |
| **Auto-Compress & Continue** | ✅ Up to 5× | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited | ❌ |
| **Skill Ecosystem** | ✅ 200+ | ⚠️ Limited | ⚠️ Limited | ❌ | ⚠️ Limited |
| **Offline Embedding Model** | ✅ Bundled | ❌ | ❌ | ❌ | ❌ |
| **API Key Encryption** | ✅ OS-level | ✅ | ✅ | ✅ | ⚠️ Local file |
| **Install Size** | **~50MB** | ~200MB | ~400MB | ~80MB | ~60MB |
| **Platforms** | Win/Mac/Linux | Win/Mac | Win/Mac | VSCode | VSCode/JetBrains |

**Verdict:** If you want Claude Desktop's polish **plus** RAG **plus** Hooks **plus** WeChat — without the $20/mo tax — AideAgent is for you.

---

## 🚀 Quick Start (30 seconds)

### Option 1: Download Pre-built Binary (Recommended)

👉 **[Download for Windows / macOS / Linux →](https://github.com/quanzefeng/AideAgent/releases)**

No Node.js required. Double-click and go.

### Option 2: Run from Source

```bash
git clone https://github.com/quanzefeng/AideAgent.git
cd AideAgent/desktop
npm install        # postinstall auto-downloads MiniLM-L6 (~23MB)
npm start
```

### 3-Step Setup

1. **Open Settings → API Config** → choose a provider (DeepSeek / Claude / GLM / Qwen / Ollama / ...)
2. **Paste your API key** → saved with OS-level encryption (Windows DPAPI / macOS Keychain / Linux libsecret)
3. **Start chatting** → Agent has 28 tools ready to go

> 💡 **No API key?** Use Ollama / LM Studio / llama.cpp for fully local inference. Zero data leaves your machine.

---

## 🌟 Core Features

### 🛡️ Local-First Privacy
- **Offline MiniLM-L6** embedding model bundled (384-dim, ~23MB)
- **OS-level encryption** for all API keys (Electron `safeStorage`)
- **SSRF protection** — `web_fetch` blocks 127.0.0.1 / 192.168.* / 169.254.*
- **Path traversal prevention** in KB writes and Hook scripts
- **Command injection proof** — git/gh use array-based `spawn`, never shell strings
- **XSS proof** — KB panel uses `textContent`, zero `innerHTML`
- **Dangerous command detection** — `rm -rf /`, `format`, etc. require explicit confirmation

### ⚡ Prompt Caching (Save 90% on API bills)
- **Stable system prompt** — dynamic content (memory, KB, tasks) moved to user messages, system prompt never changes → always cacheable
- **Lazy KB loading** — KB results injected only on first turn
- **Anthropic explicit cache** — `cache_control` markers on system + tools + history, 1-hour TTL
- **DeepSeek auto-cache** — message ordering optimized for maximum prefix match
- **Live hit-rate display** — `💾 90% cached` shown after each reply with color coding (🟢≥80% / 🟡≥50% / 🔴<50%)

### 🧰 28 Built-in Tools

| Category | Tools |
|---|---|
| **Files & Code** | `file_read`, `file_write`, `file_edit`, `grep`, `glob`, `lsp` (go-to-def, references, hover) |
| **Shell** | `bash` (cross-platform pwsh/bash, dangerous command detection, Hook interception) |
| **Web** | `web_search` (Tavily + meta-search fallback), `web_fetch` (SSRF-protected) |
| **Version Control** | `git_diff`, `git_commit`, `git_branch`, `gh_pr`, `gh_issue`, `gh_repo` |
| **Knowledge** | `kb_search` (FTS5 + vector + RRF), `kb_write`, `kb_get_note`, `write_memory` |
| **Tasks** | `TaskCreate`, `TaskUpdate`, `TaskList`, `TodoWrite`, `AskUserQuestion` |
| **Skills** | `skill`, `invoke_skill`, `create_skill` (L2/L3 dual system) |
| **Sub-Agent** | `Agent` (read-only parallel research) |

### 🔌 MCP + Skill Ecosystem
- **MCP** — stdio + HTTP transports, **auto-detects** Claude Code/Desktop/OpenCode configs
- **200+ skills** installable via `npx skills add` (L3 system)
- **L2 agent-created skills** — agent learns your workflow and creates reusable skills automatically
- **Curator** auto-archives skills unused for 30+ days, detects duplicates

### 🧠 Hybrid RAG (Obsidian-Native)
- **FTS5** keyword search + **vector semantic** search (MiniLM-L6 or Ollama)
- **RRF fusion** — merges both result sets for optimal relevance
- **MRL compression** — auto-detects Matryoshka-capable models (e.g. qwen3-embedding), compresses 1024→384 dim losslessly
- **Smart truncation** — auto-detects Ollama model context length
- **Instant injection** — relevant notes auto-injected into system prompt

### 🪝 Hook System (Programmable Agent Behavior)
- **3 events** — `PreToolUse` / `PostToolUse` / `SessionEnd`
- **JSON protocol** over stdin/stdout, cross-platform
- **Safety guards** — `enabled` toggle, `tools` filter, path traversal protection, timeout fallback
- **Built-in examples** — dangerous command interception, auto-formatting, session notifications

### 💾 Self-Evolving Memory
- **Post-session reflection** — agent analyzes recent exchanges, extracts PREFERENCE / DECISION / KNOWLEDGE
- **Auto-save** to `USER.md` / `MEMORY.md` — zero user friction
- **Semantic selection** — auto-picks most relevant memories per conversation
- **Deduplication** — prevents saving redundant content

### 🔄 Auto-Compress & Continue
- **Context-aware trigger** at 90% token usage (256K window)
- **LLM summarization** — preserves key decisions and file references
- **Seamless resume** — "Auto-continued (N/5)" shown inline
- **Up to 5× continuations** = 50 tool calls × 5 = 250 effective rounds

### 📁 Project Context (AGENTS.md)
- **Multi-standard** — reads `AGENTS.md` first, `CLAUDE.md` as fallback
- **Two-level loading** — project root + `~/.aideagent/CLAUDE.md`
- **Zero config** — auto-loaded if present

### 💬 WeChat Bot
- QR-code login to WeChat
- Send messages to your agent from your phone
- Full conversational capabilities, end-to-end

### 🎨 UI / UX
- Dark theme, streaming responses, expandable reasoning
- LaTeX math + code syntax highlighting (highlight.js)
- One-click Chinese/English UI switch
- 12 settings panels (API / Avatar / Skills / Prompt / MCP / Social / Memory / KB / Skills / Font / Language / About)
- Custom avatar and agent name

---

## 🏗️ Architecture

```
desktop/
├── main.mjs                 # App entry
├── preload.cjs              # IPC bridge (~60 channels)
├── core/
│   ├── agent-loop.mjs       # Conversation loop + auto-continue + auto-review
│   ├── tool-executor.mjs    # 28 tools + cross-platform shell
│   ├── tool-definitions.mjs # Tool schemas
│   ├── system-prompt.mjs    # Prompt builder + AGENTS.md loading
│   ├── format-adapters.mjs  # OpenAI/Anthropic adapters + Prompt Caching
│   ├── token-budget.mjs     # Token estimation + context compression
│   ├── hook-manager.mjs     # Hook system
│   ├── sub-agent.mjs        # Read-only sub-agents
│   ├── state.mjs            # Shared state + platform detection
│   ├── ipc-handlers.mjs     # IPC handlers (~80)
│   ├── memory-selection.mjs # Semantic memory selection
│   ├── skill-scanner.mjs    # L3 skill scanner
│   └── workspace-config.mjs # Workspace persistence
├── session-db.mjs           # Session DB (SQLite + FTS5)
├── memory-store.mjs         # Memory store
├── skills-store.mjs         # L2 skill store
├── knowledge-store.mjs      # KB RAG (SQLite + FTS5 + vectors)
├── mcp-manager.mjs          # MCP protocol (JSON-RPC 2.0)
├── lsp-manager.mjs          # LSP client
├── update-manager.mjs       # Auto-updater
├── renderer/                # UI (vanilla JS, no framework bloat)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── translations.js      # i18n (zh-CN + en)
│   └── modules/
├── test/                    # 25 Vitest test files
├── models/                  # Bundled MiniLM-L6
└── scripts/                 # Build scripts
```

**Stack:** Electron 40 · Node.js 22 · SQLite (FTS5 + vectors) · Vitest · Playwright · electron-builder

**No TypeScript build step** — vanilla JS keeps startup fast and bundle small.

---

## 🔬 Who's Using AideAgent?

> _Be the first! Star ⭐ the repo and open an issue to get featured here._

---

## 📚 Documentation

- 📖 **[User Guide](docs/user-guide.md)** — Detailed walkthrough of every feature
- 🛠️ **[Developer Guide](docs/developer-guide.md)** — Architecture deep-dive, contributing
- 🔌 **[MCP Setup](docs/mcp-setup.md)** — Connect external tool servers
- 🪝 **[Hook Examples](docs/hook-examples.md)** — Pre/Post/SessionEnd recipes
- 🎯 **[Prompt Caching](docs/prompt-caching.md)** — How the cache works + cost benchmarks
- 🤖 **[Multi-Model Setup](docs/multi-model.md)** — DeepSeek, Claude, GLM, Qwen, Ollama, ...

---

## 🗺️ Roadmap

- [ ] **Agent Marketplace** — share and install community-created skills
- [ ] **VSCode Extension** — same agent, in your editor
- [ ] **Multi-Agent Collaboration** — orchestrate multiple agents on one task
- [ ] **Voice Mode** — push-to-talk with Whisper integration
- [ ] **Cloud Sync (optional, E2E-encrypted)** — for users who want it

See [open issues](https://github.com/quanzefeng/AideAgent/issues) for the full list.

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

**Quick start:**
```bash
git clone https://github.com/quanzefeng/AideAgent.git
cd AideAgent/desktop
npm install
npm run dev      # development mode with hot reload
npm test         # run Vitest suite
npm run lint
```

**Good first issues:** [good-first-issue label](https://github.com/quanzefeng/AideAgent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

---

## 📜 License

[Apache License 2.0](LICENSE) — free for commercial and personal use.

---

## ⭐ Star History

<a href="https://star-history.com/#quanzefeng/AideAgent&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=quanzefeng/AideAgent&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=quanzefeng/AideAgent&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=quanzefeng/AideAgent&type=Date" />
  </picture>
</a>

---

## 💖 Sponsorship

If AideAgent saved you time or money, consider buying the author a coffee ☕

<div align="center">
  <img src="assets/alipay-qr.jpg" width="200" alt="Alipay" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/wechat-qr.jpg" width="200" alt="WeChat" />
</div>

---

## 📬 Contact

- 💬 WeChat: `q2993919594`
- 📧 Email: `zefengquan5@gmail.com`
- 🐙 GitHub: [@quanzefeng](https://github.com/quanzefeng)

---

<div align="center">

**If this project helps you, please ⭐ star it — it helps more developers find it.**

Made with ❤️ by one developer in 24 days.

</div>
