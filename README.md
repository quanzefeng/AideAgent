# AideAgent

> 一个把 AI 装进你电脑里的桌面助手。不只是聊天，能直接动手帮你干活。

---

## 这是什么

AideAgent 是一个跑在你电脑本地（也支持云端模型）的 AI 桌面应用。它不只是一个聊天窗口——它能调用工具、能读你的笔记、能操控浏览器、能连你的微信。

如果你是那种"让 AI 替我干点活"的人，而不是"和 AI 聊聊天"的人——这个项目就是给你写的。

![AideAgent 主对话界面](docs/screenshots/01-主对话界面.png)

---

## 它解决的痛点

现成的 AI 工具有点别扭：

- **网页版对话**——聊完就没了，不能动手干别的。
- **其他桌面 AI**——要么只能聊天，要么扩展性差，要么数据全在云上。
- **Claude Code 类 CLI**——没图形界面，配置门槛高，小白劝退。

AideAgent 想把这几件事都做了：

- **能聊**（左下角输入框就是对话框）
- **能干**（能调工具、能跑命令、能搜网页、能翻笔记）
- **能连你**（能挂微信、能在本地跑模型、不上传你的数据）
- **能扩展**（有 MCP 协议、有 Skills 系统，想加什么加什么）

---

## 它能干什么（一图一文，对应主界面那些开关）

主界面输入框下面的四个开关分别对应四种能力：

### 1. 📋 Plan — 任务拆解与执行

勾上之后，AI 不会直接动手，会先把你的需求拆成步骤、走规划流程，然后再执行。适合"我要做个东西但不告诉你细节"的场景。

### 2. 📚 KB — 知识库检索

挂载你的 Obsidian 笔记（或者其他 Markdown 文件夹），AI 回答时会先去翻你的笔记，找到相关的内容再回。相当于给你的 AI 装了个本地 RAG。

![知识库配置面板](docs/screenshots/04-知识库配置.png)

### 3. 🌐 Web Search — 联网搜索

需要查实时信息的时候勾上。内置了一个不依赖任何 API Key 的元搜索引擎（Bing + GitHub），也支持付费的 Tavily。

### 4. 💡 Reasoning — 深度思考

让模型多花点时间思考，回答更深入（前提是你用的模型支持）。

输入框上面那四个按钮——**消息**、**工具**、**Skill**、**MCP**——是它的能力扩展层：

- **工具**——内置工具（读文件、写文件、跑命令、抓网页等）
- **Skill**——从 `.agents/skills/` 或 `.claude/skills/` 目录自动扫描到的技能（一次扫到 200+ 个）
- **MCP**——通过 Model Context Protocol 接入的外部服务（Edge 浏览器、本地搜索、远程 API……）

---

## 六大能力（按"能动手的程度"从轻到重）

### 一、多模型——想用谁就用谁

界面里点 **API Config** 可以切换模型，支持：

- **DeepSeek**（国产，便宜好用）
- **GLM-4**（智谱）
- **Qwen / 通义千问**（阿里）
- **Claude**（Anthropic 的官方和第三方中转）
- **本地模型**——Ollama、LM Studio、llama.cpp server 都行

API Key 通过操作系统的密钥库（Windows DPAPI / macOS Keychain / Linux libsecret）加密存储，不会明文落盘。

---

### 二、知识库——AI 能读你的笔记

把你的 Obsidian vault 路径告诉它，AI 回答时会先检索你的笔记。

底层是 SQLite + FTS5 全文检索 + ONNX 跑的本地向量模型（`all-MiniLM-L6-v2`，384 维），两种结果用 RRF 融合。不需要联网，搜索全部本地完成。

首次启动会自动下载模型文件（`postinstall` 钩子会跑，从 `hf-mirror.com` 或 `huggingface.co` 拉）。

---

### 三、Skills 体系——让 AI 学会干特定的事

Skills 是放在 `.agents/skills/` 或 `.claude/skills/` 目录下的文件夹，每个里面有一个 SKILL.md 描述"我能干什么"。AI 在合适的时候会自动调用它们。

![Skills 面板](docs/screenshots/03-技能总开关.png)

- **本地 Skills**——自动扫描，每个独立开关（截图里看到 209 个 skills 都开着）
- **Agent Skills**——自己创建的智能体技能
- 编写一个 Skill 就是写个 Markdown 文件，门槛很低

---

### 四、MCP 生态——接入任何外部服务

MCP（Model Context Protocol）是 Anthropic 推的协议，相当于 AI 应用的"USB 接口"。AideAgent 内置了几个一键启用的服务：

![MCP 面板](docs/screenshots/02-MCP工具生态.png)

- **Edge Browser**——通过 Playwright 操控 Edge，能截图、能填表单、能抓数据
- **Computer Use**——通过系统可访问性 API 模拟鼠标键盘（默认关闭，慎开）
- **Web Search**（内置）——免 Key 的元搜索
- **filesystem**——受控的文件读写（限定在用户目录下）
- **远程 MCP**——支持 HTTP 接入，可加自定义请求头

也可以手动加任何 npx 能跑的 MCP server。

---

### 五、微信机器人——把 AI 接到你微信里

应用启动后会尝试拉起微信 iLink Bot 桥接。扫码登录后：

- 你在桌面端和 AI 聊的内容，可以自动同步到微信
- 微信里发消息，AI 也回你

API 配置会同步到微信端（同一个对话上下文）。这个功能在大陆地区尤其方便，不用开 VPN。

> 实现细节在 `desktop/core/wechat-bridge.mjs`，扫码登录 → 轮询 → Bearer Token → 双向消息推送，整套流程都在里面。

---

### 六、扩展性与自动化——开发者向

如果你是开发者，这几样东西够你玩很久：

- **IPC 接口齐全**——所有功能都暴露成 IPC handler，可以自己写脚本调
- **state 安全**——所有可调用的子命令都在 `GH_SAFE` 白名单里，不会乱跑 `rm -rf`
- **测试覆盖**——Vitest 单测 + Playwright E2E（Electron 模式）
- **类型检查**——`tsc --noEmit` 跑过整个项目（虽然代码是 JS，但有 JSDoc 类型注解）
- **跨平台打包**——`electron-builder` 一键出 Windows NSIS / macOS DMG / Linux deb+AppImage
- **自动更新**——`electron-updater` 从 GitHub Releases 拉新版本

---

## 项目骨架

```
AideAgent/
├── desktop/                 # Electron 桌面应用
│   ├── main.mjs             # 主进程入口
│   ├── preload.cjs          # 预加载桥接（CJS）
│   ├── core/                # 核心模块（IPC、工具执行、状态管理……）
│   ├── renderer/            # 渲染层（vanilla JS，无框架）
│   ├── mcp-manager.mjs      # MCP 协议管理
│   ├── lsp-manager.mjs      # LSP 客户端（TS/JS）
│   ├── session-db.mjs       # 会话存储（SQLite + FTS5）
│   ├── knowledge-store.mjs  # 知识库（FTS5 + 向量检索）
│   ├── memory-store.mjs     # 记忆存储
│   ├── skills-store.mjs     # 技能目录
│   ├── wechat-bridge.mjs    # 微信机器人桥接
│   └── scripts/
│       └── download-model.mjs  # 首次启动下载 ONNX 模型
├── kb/                      # 默认知识库目录
├── models/                  # 本地模型文件（运行期生成）
└── docs/                    # 文档
```

技术栈一句话总结：**Electron 40 + 原生 JS（无前端框架）+ node:sqlite + ONNX Runtime + MCP**。

---

## 快速开始

### 环境要求

- Node.js 22.5+（因为用到了 `node:sqlite` 这个内置模块）
- npm（项目带 lockfile）

### 跑起来

```bash
cd desktop
npm install         # 会自动下载 embedding 模型（约 25MB）
npm start
```

如果模型下载失败（网络问题），可以手动设环境变量重试：

```bash
# 国内镜像优先（在 download-model.mjs 里默认就是这个顺序）
HF_ENDPOINT=https://hf-mirror.com npm install
```

### 打安装包

```bash
npm run dist:win     # Windows NSIS
npm run dist:mac     # macOS DMG
npm run dist:linux   # Linux deb + AppImage
npm run dist:all     # 三平台一把梭
```

打好的包在 `desktop/release/` 下面。

### 开发模式

```bash
npm run dev          # Electron + DevTools
npm run test         # Vitest 单测
npm run test:e2e     # Playwright E2E（Electron 模式）
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

---

## 几个贴心细节

- **数据本地化**——会话、笔记索引、技能、记忆全在 `~/.aideagent/`，不上云
- **API Key 加密**——用操作系统的 Keychain，不写明文
- **首次启动会自动迁移**——如果是从旧版本（`~/.goodagent/`）升上来的，配置会自动迁移
- **CSP 严格**——渲染层有完整的 Content Security Policy
- **MCP 配置兼容 Claude Code 格式**——可以直接复制 `.mcp.json` 过来用

---

## 联系方式 & 致谢

仓库在 [github.com/quanzefeng/AideAgent](https://github.com/quanzefeng/AideAgent)。

如果你觉得这个项目有用，**点个 ⭐ Star** 是对作者最大的鼓励。

提 Issue、提 PR 都欢迎。功能建议、bug 反馈、使用疑问——任何一种都好。

---

## 写在最后

这个项目没有花哨的 roadmap，也没有"我们要做 AGI"的口号。它就是一群人觉得"AI 应该能帮我做点事"之后，写出来的一个小工具。

如果你也是这么想的，欢迎来用，欢迎来改。

如果这个 README 你看完了还不知道它能干什么——**装上玩两分钟就知道了**，别看文档了。