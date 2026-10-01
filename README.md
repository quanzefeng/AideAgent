# AideAgent

[![License](https://img.shields.io/github/license/quanzefeng/AideAgent)](LICENSE)
[![Release](https://img.shields.io/github/v/release/quanzefeng/AideAgent)](https://github.com/quanzefeng/AideAgent/releases)
[![Stars](https://img.shields.io/github/stars/quanzefeng/AideAgent)](https://github.com/quanzefeng/AideAgent/stargazers)

> A desktop assistant that puts AI on your machine. Not just chat — it actually does the work.

![AideAgent home screen — sidebar with new chat and settings, centered welcome avatar, prompt box with model picker and capability toggles](docs/screenshots/00-首页.png)

## Contents

- [What this is](#what-this-is)
- [The problem it solves](#the-problem-it-solves)
- [Two runtimes](#two-runtimes--pick-on-the-welcome-screen)
- [What it can do](#what-it-can-do-matching-the-four-toggles-in-the-ui)
- [Six capabilities](#six-capabilities-ordered-from-lightest-touch-to-deepest-reach)
- [Project layout](#project-layout)
- [Quick start](#quick-start)
- [Nice details](#nice-details)
- [Contact & thanks](#contact--thanks)
- [A final word](#a-final-word)

---

## What this is

AideAgent is an AI desktop app that runs on your computer (cloud models are supported too). It's not a chat window — it can call tools, read your notes, drive a browser, connect to your WeChat, and even hand the wheel to a local OpenCode CLI as the agent engine.

If you're the kind of person who wants AI to *do things for you*, not just *talk to you* — this project is for you.

---

## The problem it solves

Off-the-shelf AI tools are awkward in their own ways:

- **Web-based chat** — the conversation ends, and the AI can't do anything else.
- **Other desktop AI** — either chat-only, hard to extend, or your data lives in the cloud.
- **CLI agents** — no GUI, high setup bar, brutal for non-developers.

AideAgent tries to cover all three:

- **Chat** (the input box in the lower-left is the conversation)
- **Act** (tools, commands, web search, notes search, file edits)
- **Reach you** (WeChat bridge, local model support, your data stays on disk)
- **Extend** (MCP protocol, Skills system, add whatever you want)
- **Two runtimes, one app** — flip a card on the welcome screen between the built-in AideAgent loop and a local OpenCode CLI

---

## Two runtimes — pick on the welcome screen

The very first thing you see is a card chooser with two engines:

- **AideAgent** — the built-in agent loop. Custom tool executor, in-process reasoning, fast iteration. This is the default.
- **OpenCode** — if you have the `opencode` CLI installed locally, AideAgent can hand the entire session over to it via the [Agent Client Protocol](https://agentclientprotocol.com/). You get the full OpenCode experience without leaving the GUI.

When you pick OpenCode but the CLI isn't on `PATH`, an install guide pops up with one-click links to `npm i -g opencode-ai`, `scoop install opencode`, or `brew install opencode`, plus a "Re-detect" button to pick it up after you install.

The choice is persisted per-user (`localStorage["AideAgent_runtime"]`) and re-applied on session restore — but if you restore an OpenCode session and the CLI is no longer installed, we quietly fall back to AideAgent and surface a toast so you're not confused about why the input box swapped.

### OpenCode mode selector

When runtime = OpenCode, the bottom-left of the input box has a 3-mode dropdown (instead of the single Plan toggle AideAgent uses):

| Mode | What it does |
|------|--------------|
| **Build** (default) | Normal execution. Reads, edits, and runs commands. |
| **Plan** | Read-only. Outputs a plan, asks before touching files. |
| **Authorize** | Auto-approves every operation. For "I trust you, just go" sessions. |

Your mode choice is persisted (`AideAgent_oc_mode`) and re-applied on the next launch.

### OpenCode file upload

OpenCode supports file attachments via the `+` button on its input box — images go inline (`{type:"image"}`) so the model can see them directly; everything else (PDF, Markdown, source, etc.) is written to a temp file and attached as a `resource_link` with a `file://` URI. The model can then call `file_read` on the URI. This is the most reliable path we found against opencode v1.18.x — the inline-text `{type:"resource"}` route silently stalled the response in our testing, so `resource_link` is the only fallback we ship.

### OpenCode model picker

OpenCode's `initialize` handshake returns the models the server supports; AideAgent mirrors that list into its own dropdown so you can pick a model without leaving the GUI. The same dropdown lives in both runtimes' info bars.

---

## What it can do (matching the four toggles in the UI)

The four toggles under the input box correspond to four capabilities:

### 1. 📋 Plan — break down and execute tasks

When toggled, the AI won't just dive in. It plans first, then executes. For "I want to build something but I haven't thought through the details" situations.

> AideAgent runtime only — OpenCode uses the 3-mode dropdown above.

### 2. 📚 KB — knowledge base search

Local RAG over your notes and documents — formats, internals, and setup are covered in [§2 Knowledge base](#2-knowledge-base--ai-reads-your-notes-and-documents) below.

### 3. 🌐 Web Search — live web search

Toggle it on when you need real-time info. A built-in meta-search engine (Bing + GitHub, no API key required).

### 4. 💡 Reasoning — think deeper

Lets the model spend more time thinking, for more thorough answers (only works if your model supports it).

The `+` button beside the input box opens a popover — file upload, prompt library, and skills. Built-in tools (read/write files, run commands, fetch web pages, …) are always available to the agent, and the extension layers — knowledge base, skills, MCP servers, memory — are all configured in **Settings**.

---

## Six capabilities (ordered from "lightest touch" to "deepest reach")

### 1. Multiple models — pick whoever you want

Click **API Config** and you'll see 10 presets, ready to go:

- **DeepSeek** — flagship and flash tiers
- **GLM (Zhipu)** — flash / plus / air tiers
- **Qwen (Tongyi Qianwen, Alibaba)** — max / plus / turbo tiers
- **Claude (Anthropic)** — Sonnet / Opus / Haiku lines
- **MiniMax** — standard / high-speed variants
- **Ollama** — local, drop in any model you've pulled
- **LM Studio** — local, with the GUI
- **llama.cpp** — local, the server mode
- **OpenCode Go (OpenAI-compatible)** — `opencode.ai/zen/go` (GLM, Kimi, DeepSeek, Mimo, …)
- **OpenCode Go (Anthropic-compatible)** — `opencode.ai/zen/go` (MiniMax, Qwen, …)

Preset model lists track vendor releases — the in-app picker is always the source of truth.

Both **OpenAI-compatible** and **Anthropic** API formats are supported, so you can swap in any third-party proxy or self-hosted endpoint that speaks the same language. Custom base URLs are also fine — just paste your own.

API keys are encrypted by the operating system keychain (Windows DPAPI / macOS Keychain / Linux libsecret), never stored in plaintext.

---

### 2. Knowledge base — AI reads your notes and documents

Point it at your Obsidian vault (or any folder), and the AI will search your notes before answering.

Supported file formats (toggleable in Settings → Knowledge Base):
- **Markdown** — `.md` / `.mdown` / `.mkd` / `.mkdn` / `.markdown` (always on)
- **Word** — `.docx` (default on, parsed via `mammoth`)
- **PowerPoint** — `.pptx` (default on, parsed via direct OOXML XML extraction)
- **CSV / TSV** — `.csv` / `.tsv` (default off, each row → "column: value" sentence)
- **Excel** — `.xlsx` (default off, parsed via SheetJS, multi-sheet support)
- **PDF** — `.pdf` (shipped in v1.0.29, parsed via `pdf-parse`)

Under the hood: SQLite + FTS5 full-text search + ONNX running a local embedding model (`all-MiniLM-L6-v2`, 384 dimensions), fused with RRF. Fully offline. Nothing leaves your machine.

On first launch, model files download automatically (via a `postinstall` hook, pulling from `hf-mirror.com` or `huggingface.co`).

The extractor architecture is pluggable — each format lives in `desktop/kb/extractors/` and implements a standard `{ extract, chunkText }` interface. Adding a new format is one file + one registry entry.

---

### 3. Skills system — teach AI to do specific things

A Skill is a folder under `.agents/skills/` or `.claude/skills/` containing a SKILL.md that says "I can do X". The AI invokes the right one when it fits.

- **Local Skills** — auto-scanned, individually toggleable (200+ found on a typical scan)
- **Agent Skills** — skills you create yourself
- Writing a Skill is just writing a Markdown file — low barrier

---

### 4. MCP ecosystem — plug in any external service

MCP (Model Context Protocol) is Anthropic's protocol — think of it as a "USB port" for AI apps. AideAgent ships with several one-click services:

- **Edge Browser** — Playwright-driven Edge, can screenshot, fill forms, scrape data
- **Computer Use** — simulates mouse and keyboard through system accessibility APIs (off by default, turn on with care)
- **Web Search** (built-in) — keyless meta-search
- **filesystem** — controlled file read/write, scoped to your user directory
- **Remote MCP** — HTTP with custom headers, plug in whatever you want

You can also add any MCP server that `npx` can run.

---

### 5. WeChat bot — bring AI into your WeChat

On startup the app tries to launch the WeChat iLink Bot bridge. Scan to log in and you get:

- Desktop chats with the AI auto-mirrored to WeChat
- Messages you send in WeChat get replied to by the AI

API config syncs to the WeChat side too (same conversation context).

> Implementation lives in `desktop/core/wechat-bridge.ts` — QR scan → polling → bearer token → bidirectional message push, all wired up.

---

### 6. Extensibility and automation — for developers

If you're a developer, these will keep you busy for a while:

- **Full IPC interface** — every feature exposed as an IPC handler, script it however you like
- **Two agent runtimes** — built-in AideAgent loop + OpenCode via ACP. Same UI, different engines
- **Tests** — Vitest unit suites (renderer, stores, agent loop, kb quality — 450+ assertions) plus Playwright e2e suites (smoke, scroll, kb, skills, memory, agent flows) via `npm run test` / `npm run test:e2e`
- **Type checking** — `tsc --noEmit` passes across the whole TypeScript project
- **Cross-platform packaging** — `electron-builder` produces Windows NSIS, macOS DMG, and Linux deb+AppImage in one shot
- **Auto-update** — `electron-updater` pulls new versions from GitHub Releases
- **i18n** — Chinese and English UI, switchable in Settings → Language

---

## Project layout

```
AideAgent/
├── desktop/                          # Electron desktop app
│   ├── main.ts                       # main process entry
│   ├── preload.ts                    # preload bridge
│   ├── core/                         # core modules (IPC, tool execution, state, ...)
│   │   ├── agent-loop.ts             # built-in agent loop (tool calls + reasoning)
│   │   ├── opencode-acp-client.ts    # OpenCode ACP client (spawns `opencode acp`, JSON-RPC over stdio)
│   │   ├── opencode-detector.ts      # detects local `opencode` binary (PATH + common install locations)
│   │   ├── ipc-handlers.ts
│   │   ├── state.ts
│   │   ├── tool-executor.ts
│   │   ├── tool-definitions.ts
│   │   ├── wechat-bridge.ts
│   │   └── ...
│   ├── kb/                           # knowledge base (FTS5 + vector + format extractors)
│   │   ├── vault-scanner.ts          # recursive vault scan (format-aware)
│   │   ├── indexer.ts                # full rebuild + single-file reindex
│   │   ├── search.ts                 # hybrid RAG: FTS5 + vector + RRF + LLM rerank
│   │   ├── markdown.ts               # Markdown parsing + heading-based chunking
│   │   ├── formats.ts                # extension → extractor registry + enable/disable
│   │   ├── extractors/               # per-format text extractors (pluggable)
│   │   │   ├── index.ts              # extractor dispatch
│   │   │   ├── markdown.ts           # .md adapter (wraps kb/markdown.ts)
│   │   │   ├── docx.ts               # .docx via mammoth
│   │   │   ├── pptx.ts               # .pptx via OOXML ZIP parsing
│   │   │   ├── csv.ts                # .csv/.tsv → "col: val" sentences
│   │   │   ├── xlsx.ts               # .xlsx via SheetJS (multi-sheet)
│   │   │   ├── pdf.ts                # .pdf via pdf-parse
│   │   │   └── chunk-utils.ts        # paragraph-based chunking for non-Markdown
│   │   └── ...
│   ├── renderer/                     # renderer (vanilla TypeScript, no framework)
│   │   ├── app.ts                    # main entry (orchestrates modules)
│   │   ├── translations.ts           # i18n (zh + en)
│   │   ├── index.html                # UI shell
│   │   ├── style.css
│   │   └── modules/                  # feature modules
│   │       ├── runtime-selector.ts   # AideAgent vs OpenCode chooser + 3-mode dropdown
│   │       ├── file-previews.ts      # shared file-chip renderer for both runtimes
│   │       ├── knowledge-base.ts
│   │       ├── skills-panel.ts
│   │       ├── mcp.ts
│   │       ├── wechat.ts
│   │       ├── memory-panel.ts
│   │       ├── prompt-store.ts
│   │       └── ...
│   ├── mcp-manager.ts                # MCP protocol manager
│   ├── lsp-manager.ts                # LSP client (TS/JS)
│   ├── session-db.ts                 # session storage (SQLite + FTS5)
│   ├── knowledge-store.ts            # knowledge base (FTS5 + vector)
│   ├── memory-store.ts               # memory storage
│   ├── skills-store.ts               # skills catalog
│   ├── prompts-store.ts              # prompts storage
│   ├── update-manager.ts             # auto-update manager
│   ├── search-engine/                # meta-search engine (Bing + GitHub)
│   └── scripts/
│       └── download-model.ts         # downloads ONNX model on first run
├── kb/                               # default knowledge base directory
├── models/                           # local model files (generated at runtime)
└── docs/                             # documentation + screenshots
```

Tech stack, one line: **Electron 40 + vanilla TypeScript (no frontend framework) + node:sqlite + ONNX Runtime + MCP + Agent Client Protocol**.

---

## Quick start

### Requirements

- Node.js 22.5+ (because we use the built-in `node:sqlite` module)
- npm (the project ships a lockfile)
- (Optional) the `opencode` CLI on your `PATH` — only needed if you want the OpenCode runtime. Install with `npm i -g opencode-ai@latest`, `scoop install opencode`, or `brew install opencode`

### Run it

```bash
cd desktop
npm install         # automatically downloads the embedding model (~25MB)
npm start
```

If the model download fails (network issues), set an env var and retry:

```bash
# China mirror takes priority (default order in download-model.ts)
HF_ENDPOINT=https://hf-mirror.com npm install
```

To debug the OpenCode ACP protocol (verbose stdio logging):

```bash
DEBUG_OPENCODE_ACP=1 npm start
```

### Build installers

```bash
npm run dist:win     # Windows NSIS
npm run dist:mac     # macOS DMG
npm run dist:linux   # Linux deb + AppImage
npm run dist:all     # all three platforms
```

Built installers land in `desktop/release/`.

### Development mode

```bash
npm run dev          # Electron + DevTools
npm run test         # Vitest unit suites (renderer/stores/agent loop/kb)
npm run test:e2e     # Playwright E2E (smoke/scroll/kb/skills/memory/agent)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

---

## Nice details

- **Local-first data** — sessions, note indexes, skills, and memory all live in `~/.aideagent/`, never uploaded
- **Encrypted API keys** — OS Keychain, never plaintext
- **Auto-migration on first launch** — first-time setup is fully automatic; no manual steps required
- **Strict CSP** — the renderer ships with a complete Content Security Policy
- **MCP config compatible with Claude Code format** — copy your existing `.mcp.json` over and it just works
- **Per-runtime persistence** — your runtime pick (AideAgent / OpenCode), OpenCode mode (Build / Plan / Authorize), and OpenCode model are all stored in `localStorage` and re-applied on every launch
- **i18n** — Chinese and English UI, switchable in Settings → Language. Every label, button, modal, and toast has a translation entry
- **Cyberpunk HUD theme** — optional neon chrome (corner brackets, scanlines) with a customizable accent color; automatically quiets down when the system asks for reduced motion
- **OpenCode resilience** — per-request 120s timeout on the ACP channel, so a dead subprocess surfaces "opencode 无响应" instead of hanging the UI

---

## Contact & thanks

The repo lives at [github.com/quanzefeng/AideAgent](https://github.com/quanzefeng/AideAgent).

If you find this useful, **a ⭐ Star** is the biggest encouragement for the author.

Issues, PRs — all welcome. Feature ideas, bug reports, usage questions — any of those.

---

## A final word

This project doesn't have a fancy roadmap, and it doesn't claim to be "building AGI". It's just a small tool written by people who thought "AI should be able to actually help me do things".

If you feel the same way, feel free to use it, and feel free to change it.

If you've read this whole README and still don't know what it does — **install it and play with it for two minutes**. Skip the docs.
