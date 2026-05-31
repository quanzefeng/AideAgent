# GoodAgent

> 一个功能强大的桌面 AI 助手，拥有 27 个内置工具、知识库 RAG、多模型支持、MCP 扩展等能力。

## 项目简介

GoodAgent 是一款桌面 AI 助手，支持多种大语言模型（DeepSeek、Claude、GLM、Qwen、MiniMax 等），内置丰富的工具集，可以帮你编程、搜索、管理文件、操作 Git、查阅知识库，让 AI 真正成为一个能干的助手。

---

## 功能特性

### 多模型支持

内置 8 个模型供应商预设，一键切换：

| 供应商 | 说明 |
|--------|------|
| DeepSeek | V4-Flash / V4-Pro |
| GLM（智谱） | GLM-4.7-Flash / GLM-4-Plus |
| Qwen（通义千问） | Qwen3.7-Max / Qwen-Plus |
| Claude（Anthropic） | Sonnet 4.6 / Opus 4.7 / Haiku 4.5 |
| MiniMax | M2.7 / M2.7-Highspeed |
| llama.cpp | 本地部署 |
| LM Studio | 本地部署 |
| Ollama | 本地部署 |

支持 OpenAI 兼容和 Anthropic 两种 API 格式，也可以自定义任何兼容的 API 地址。

---

### 27 个内置工具

#### 文件与代码
| 工具 | 说明 |
|------|------|
| `file_read` | 读取文件内容 |
| `file_write` | 创建或覆盖文件 |
| `file_edit` | 精确替换文本（支持多行匹配） |
| `grep` | 正则搜索代码内容 |
| `glob` | 按文件名模式查找文件 |
| `lsp` | 代码智能：跳转定义、查找引用、悬停信息 |

#### 命令执行
| 工具 | 说明 |
|------|------|
| `bash` | 执行命令（含危险操作检测与确认） |

#### 网络搜索
| 工具 | 说明 |
|------|------|
| `web_search` | 搜索互联网 |
| `web_fetch` | 抓取并提取网页内容 |

#### 版本控制
| 工具 | 说明 |
|------|------|
| `git_diff` | 查看 Git 差异 |
| `git_commit` | 创建 Git 提交 |
| `git_branch` | 管理 Git 分支 |
| `gh_pr` | 管理 GitHub Pull Request |
| `gh_issue` | 管理 GitHub Issue |
| `gh_repo` | 查看 GitHub 仓库信息 |

#### 知识管理
| 工具 | 说明 |
|------|------|
| `kb_search` | 搜索知识库（Obsidian vault） |
| `kb_write` | 写入笔记到知识库 |
| `write_memory` | 保存跨会话的永久记忆 |

#### 任务与协作
| 工具 | 说明 |
|------|------|
| `TaskCreate` | 创建任务追踪复杂工作 |
| `TaskUpdate` | 更新任务状态 |
| `TaskList` | 查看所有任务进度 |
| `TodoWrite` | 写临时待办清单 |
| `AskUserQuestion` | 多选问题询问用户 |

#### 技能系统
| 工具 | 说明 |
|------|------|
| `skill` | 加载技能文件 |
| `invoke_skill` | 调用已加载的技能 |
| `create_skill` | 创建或更新技能工作流 |

#### 子代理
| 工具 | 说明 |
|------|------|
| `Agent` | 启动只读子代理，并行执行研究任务 |

---

### MCP 扩展

支持 Model Context Protocol，可接入外部工具服务器：

- 支持本地进程（stdio）和远程服务（HTTP）两种方式
- 自动检测 Claude Code、Claude Desktop、OpenCode 的本地 MCP 配置
- 接入后，MCP 工具与内置工具统一调用

---

### 知识库（RAG）

对接 Obsidian vault，实现本地知识检索：

- **混合搜索**：关键词全文搜索 + 向量语义搜索
- **RRF 融合**：自动合并两种搜索结果，取最相关的内容
- **向量模型**：支持本地 MiniLM-L6、Ollama、DeepSeek 三种嵌入方式
- **即时注入**：相关笔记自动注入到对话上下文中

---

### 持久记忆

跨会话的记忆系统，让 Agent 越用越了解你：

- 多文件 Markdown 存储，支持类型标签（用户偏好、项目背景、反馈纠错等）
- **AI 语义选择**：每次对话自动挑选最相关的记忆注入上下文
- **过期追踪**：标注记忆新旧程度，避免过期信息误导
- **去重检测**：防止重复保存相似内容

---

### 会话管理

- 对话自动保存，随时切换回历史对话
- **多开对话**：Agent 在后台继续运行时，你可以查看其他对话或开启新对话
- **消息队列**：在 Agent 运行时输入的消息自动排队，完成后依次执行
- 全文搜索历史对话
- 导出为 Markdown 文件
- 支持编辑和删除单条消息

---

### 安全特性

- **Plan 模式**：只读模式，Agent 只能读取和规划，不能执行写操作
- **加密密钥**：API 密钥使用操作系统级加密存储，非明文
- **路径防护**：知识库写入时验证路径，防止越权访问
- **危险命令检测**：执行命令前检测 `rm -rf` 等危险操作并请求确认

---

### 界面特性

- **暗色主题**：深色界面，长时间使用不伤眼
- **流式渲染**：回答实时呈现，推理过程可展开查看
- **LaTeX 渲染**：数学公式完美显示
- **代码高亮**：代码块语法高亮
- **中英文切换**：界面语言一键切换
- **自定义头像和名称**：个性化 Agent 和你自己的显示名称

---

### 系统提示词

- 支持多个提示词配置文件
- 可创建、编辑、启用/禁用、切换
- 支持 `{{WORKSPACE}}` 变量
- 可针对不同场景准备不同的提示词

---

### 微信机器人

- 扫码登录微信
- 通过微信给 Agent 发消息
- Agent 自动回复（使用完整对话能力）

---

### 自动更新

- 支持版本检测和一键更新
- 可开启启动时自动检查
- 显示更新日志和下载进度

---

## 快速开始

### 安装运行

```bash
git clone https://github.com/quanzefeng/GoodAgent.git
cd GoodAgent/desktop
npm install
npm start
```

### 配置 API

打开 **设置 → API 配置**，选择模型供应商，填入 API 密钥和地址，选择模型后保存即可开始使用。

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Enter | 发送消息 |
| Ctrl+I | 打开设置 |

---

## 开发者

```bash
npm run dev          # 开发模式
npm test             # 运行测试
npm run lint         # 代码检查
npm run typecheck    # 类型检查
npm run dist:win     # 打包 Windows
npm run dist:mac     # 打包 macOS
npm run dist:linux   # 打包 Linux
```

---

## 联系方式

- 微信: q2993919594
- 谷歌邮箱: zefengquan5@gmail.com
- GitHub: https://github.com/quanzefeng/GoodAgent
