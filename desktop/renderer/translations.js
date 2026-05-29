/**
 * GoodAgent i18n — Lightweight translation system
 * Supports: zh (简体中文), en (English)
 */

const LANG_KEY = "goodagent_lang";

const translations = {
  zh: {
    // ── Settings Tabs ──
    "settings.title": "设置",
    "settings.api": "API 配置",
    "settings.avatar": "头像",
    "settings.skills": "技能",
    "settings.prompt": "系统提示词",
    "settings.mcp": "MCP",
    "settings.social": "社交",
    "settings.memory": "记忆",
    "settings.kb": "知识库",
    "settings.agent_skills": "Agent 技能",
    "settings.font": "字体",
    "settings.language": "语言",
    "settings.close": "关闭",

    // ── Config Banner ──
    "banner.api_required": "请先在设置中配置 API",
    "banner.open_settings": "打开设置",

    // ── Permission Modal ──
    "perm.title": "⚠️ 需要授权",
    "perm.hint": "以下命令需要您的批准：",
    "perm.deny": "拒绝",
    "perm.allow": "允许",

    // ── Ask Question Modal ──
    "ask.title": "🤔 需要确认",
    "ask.confirm": "确认",

    // ── API Config Panel ──
    "api.provider": "供应商",
    "api.custom": "— 自定义 —",
    "api.url": "API URL",
    "api.model": "Model",
    "api.model_placeholder": "输入模型名称，如 gpt-4o",
    "api.fetch_models": "从 API 获取可用模型列表",
    "api.fetch_btn": "获取模型",
    "api.key": "API Key",
    "api.save": "保存",
    "api.fill_url": "请填写 API URL",
    "api.saved": "✅ 已保存 — {name} API",
    "api.fetching": "获取中...",
    "api.fetch_success": "✅ 获取到 {count} 个模型",
    "api.fetch_empty": "未获取到模型，请检查 API URL 是否正确",
    "api.config_first": "请先在设置中配置 API URL",

    // ── Provider Names ──
    "provider.custom": "自定义",
    "provider.deepseek": "DeepSeek",
    "provider.glm": "GLM (智谱)",
    "provider.qwen": "Qwen (通义千问)",
    "provider.mimo": "MiMo (小米)",
    "provider.claude": "Claude (Anthropic)",
    "provider.lmstudio": "LM Studio（本地）",
    "provider.ollama": "Ollama（本地）",

    // ── Avatar Panel ──
    "avatar.select_hint": "选择一个图片文件作为头像",
    "avatar.select": "选择图片",
    "avatar.reset": "恢复默认",
    "avatar.agent_name": "Agent 名称",
    "avatar.save": "保存",
    "avatar.name_hint": "修改后在侧边栏、对话标签、页面标题等所有位置生效",
    "avatar.user_section": "我的头像和名称",
    "avatar.user_hint": "选择一个图片文件作为你的头像",
    "avatar.user_name": "你的名称",
    "avatar.user_name_hint": "修改后在对话中你的消息标签上显示",
    "avatar.user_default": "你",
    "avatar.save_fail": "头像保存失败：图片过大，请选择较小的图片",
    "avatar.select_file": "请选择图片文件",
    "avatar.decode_fail": "图片解码失败，请换一张图",
    "avatar.name_changed": "名称已改为 \"{name}\"",

    // ── Skills Panel (L3) ──
    "skills.local_hint": "本地安装的技能（.agents/ / .claude/skills/），Agent 可自动识别并使用。此面板为只读浏览。",
    "skills.refresh": "刷新",
    "skills.count": "{count} 个技能",
    "skills.scanning": "正在扫描 L3 本地技能...",
    "skills.empty": "未找到本地技能。技能存放在 .agents/ 或 .claude/skills/ 目录下。",
    "skills.load_error": "加载本地技能失败",
    "skills.triggers": "触发:",
    "skills.tools_count": "个工具",

    // ── System Prompt Panel ──
    "prompt.new": "新建",
    "prompt.default": "默认",
    "prompt.name": "配置名称",
    "prompt.placeholder": "在此输入系统提示词...",
    "prompt.saved": "已保存",
    "prompt.enabled": "已启用",
    "prompt.enable": "启用",
    "prompt.empty_hint": "点击上方「新建」创建系统提示词配置",
    "prompt.created": "系统提示词{num}",
    "prompt.delete_confirm": "确定要删除配置「{name}」吗？",
    "prompt.deleted": "配置「{name}」已删除",
    "prompt.enabled_now": "已启用当前配置",

    // ── MCP Panel ──
    "mcp.hint": "配置 MCP（Model Context Protocol）服务器，让 AI 可以访问更多工具（数据库、文件系统、浏览器等）。格式与 Claude Code 的 .mcp.json 兼容。",
    "mcp.searxng_title": "🔍 快速添加 SearXNG 搜索",
    "mcp.searxng_add": "添加",
    "mcp.searxng_hint": "输入你的 SearXNG 实例地址，自动配置 npx mcp-searxng@latest",
    "mcp.detect_title": "📡 检测本地 MCP 配置",
    "mcp.scan": "扫描",
    "mcp.detect_hint": "扫描 Claude Code CLI、OpenCode 等本机已配置的 MCP 服务器，一键导入。",
    "mcp.add_server": "手动添加服务器",
    "mcp.save_config": "保存配置",
    "mcp.name": "名称",
    "mcp.name_placeholder": "例如: filesystem",
    "mcp.command": "命令 (command)",
    "mcp.command_placeholder": "例如: npx",
    "mcp.args": "参数 (args)",
    "mcp.args_placeholder": "例如: -y @modelcontextprotocol/server-filesystem C:/Users/7",
    "mcp.env": "环境变量 (可选, JSON)",
    "mcp.env_placeholder": "{\"API_KEY\":\"xxx\"}",
    "mcp.save_start": "保存并启动",
    "mcp.cancel": "取消",
    "mcp.empty": "没有配置 MCP 服务器。点击\"添加服务器\"开始。",
    "mcp.no_tools": "(无工具)",
    "mcp.running": "运行中",
    "mcp.error": "错误",
    "mcp.starting": "启动中...",
    "mcp.restart": "重启",
    "mcp.retry": "重试",
    "mcp.remove": "移除",
    "mcp.tools_label": "工具:",
    "mcp.restarting": "重启中...",
    "mcp.restart_fail": "重启 \"{name}\" 失败: {error}",
    "mcp.remove_confirm": "确定移除 MCP 服务器 \"{name}\"？",
    "mcp.remove_fail": "移除 \"{name}\" 失败: {error}",
    "mcp.load_error": "加载 MCP 服务器失败",
    "mcp.saving": "保存中...",
    "mcp.config_saved": "✅ MCP 配置已保存",
    "mcp.save_fail": "保存失败: {error}",
    "mcp.name_required": "名称和命令不能为空",
    "mcp.env_invalid": "环境变量格式错误，请输入有效 JSON",
    "mcp.starting_server": "启动中...",
    "mcp.start_fail": "启动失败: {error}",
    "mcp.searxng_url_required": "请填写 SearXNG URL",
    "mcp.searxng_adding": "添加中...",
    "mcp.searxng_added": "✅ SearXNG 已添加并启动",
    "mcp.searxng_fail": "添加失败: {error}",
    "mcp.detect_empty": "未找到本地 MCP 配置。已扫描 Claude Code CLI (~/.claude/)、OpenCode 等位置。",
    "mcp.disabled": "(已禁用)",
    "mcp.import_btn": "导入",
    "mcp.importing": "导入中...",
    "mcp.imported": "✅ \"{name}\" 已导入",
    "mcp.import_done": "✅ 已导入",
    "mcp.import_fail": "导入 \"{name}\" 失败: {error}",
    "mcp.connecting": "连接中...",
    "mcp.connected": "✅ \"{name}\" 已连接",
    "mcp.connect_done": "✅ 已连接",
    "mcp.connect_fail": "连接 \"{name}\" 失败: {error}",
    "mcp.connect": "连接",
    "mcp.detect_fail": "检测失败: {error}",
    "mcp.scanning": "扫描中...",

    // ── Social Panel ──
    "social.hint": "连接社交平台，AI 自动回复消息。",
    "social.wechat": "微信",
    "social.connected": "已连接",
    "social.disconnected": "未连接",
    "social.qr_login": "扫码登录",
    "social.logout": "退出登录",
    "social.qr_title": "微信扫码登录",
    "social.qr_loading": "加载中...",
    "social.qr_scan": "请使用微信扫描二维码",
    "social.qr_scanned": "已扫码，请在手机上确认...",
    "social.qr_success": "登录成功！",
    "social.qr_expired": "二维码已过期，请重新打开",
    "social.qr_error": "获取失败: {error}",
    "social.qr_network": "网络错误",
    "social.getting_qr": "获取二维码...",
    "social.logged_out": "已退出登录",
    "social.incoming": "收到消息: {text}",

    // ── Memory Panel ──
    "memory.title": "记忆管理",
    "memory.hint": "Agent 会在对话中自动创建和更新记忆",
    "memory.search": "搜索记忆...",
    "memory.new": "＋ 新建",
    "memory.empty_hint": "选择一个记忆查看或编辑\n或点击「＋ 新建」创建新的记忆",
    "memory.name_placeholder": "名称，如 user_role",
    "memory.type_user": "用户信息",
    "memory.type_feedback": "用户反馈",
    "memory.type_project": "项目上下文",
    "memory.type_reference": "外部参考",
    "memory.desc_placeholder": "简短描述，用于搜索匹配",
    "memory.body_placeholder": "记忆内容（支持 Markdown）...",
    "memory.save": "保存",
    "memory.delete": "删除",
    "memory.label_user": "👤 用户",
    "memory.label_feedback": "💬 反馈",
    "memory.label_project": "📋 项目",
    "memory.label_reference": "🔗 参考",
    "memory.empty": "暂无记忆",
    "memory.auto_hint": "Agent 会在对话中自动创建",
    "memory.no_desc": "(无描述)",
    "memory.name_required": "❌ 名称不能为空",
    "memory.saving": "保存中...",
    "memory.saved": "✅ 已保存",
    "memory.save_fail": "❌ 保存失败: {error}",
    "memory.delete_confirm": "删除记忆 \"{name}\"？此操作不可撤销。",
    "memory.deleted": "✅ 已删除",
    "memory.delete_fail": "❌ 删除失败: {error}",

    // ── Knowledge Base Panel ──
    "kb.title": "知识库 (Obsidian)",
    "kb.hint": "混合 RAG 检索：FTS5 关键词 + 向量语义搜索",
    "kb.vault_path": "Vault 路径",
    "kb.vault_placeholder": "选择 Obsidian Vault 文件夹",
    "kb.select": "选择",
    "kb.clear": "清除",
    "kb.embedding": "Embedding 模型",
    "kb.local_model": "本地 MiniLM-L6（离线，推荐）",
    "kb.ollama_model": "Ollama（需本地运行）",
    "kb.deepseek_model": "DeepSeek API",
    "kb.unconfigured": "未配置",
    "kb.indexed": "已索引 {count} 篇笔记，{embedded} 篇已向量化",
    "kb.not_indexed": "未索引",
    "kb.days_range": "请输入 1-365 之间的天数",
    "kb.scan_btn": "扫描并索引",
    "kb.test_btn": "测试搜索",
    "kb.test_placeholder": "输入关键词测试搜索...",
    "kb.max_notes": "最大注入笔记数",
    "kb.max_chars": "单篇最大字数",
    "kb.error": "错误: {error}",
    "kb.pick_fail": "选择文件夹失败: {error}",
    "kb.select_vault": "请先选择 Vault 路径",
    "kb.indexing": "索引中...",
    "kb.scanning": "正在扫描和索引...",
    "kb.index_success": "已索引 {count} 篇笔记，{embedded} 篇已向量化",
    "kb.searching": "搜索中...",
    "kb.no_results": "无结果",

    // ── Agent Skills Panel (L2) ──
    "agent_skills.title": "Agent 技能",
    "agent_skills.hint": "Agent 生成或手动创建的可复用操作流程",
    "agent_skills.import": "导入",
    "agent_skills.new": "＋ 新建技能",
    "agent_skills.create_title": "创建新技能",
    "agent_skills.name_placeholder": "技能名称（英文小写 + 连字符）",
    "agent_skills.desc_placeholder": "简短描述",
    "agent_skills.steps_placeholder": "1. 步骤一\n2. 步骤二",
    "agent_skills.save": "保存",
    "agent_skills.cancel": "取消",
    "agent_skills.auto_archive": "自动归档超过",
    "agent_skills.archive_days": "天未使用的技能",
    "agent_skills.loading": "加载中...",
    "agent_skills.manual": "手动创建",
    "agent_skills.never_run": "未运行",
    "agent_skills.active": "活跃",
    "agent_skills.archived": "归档",
    "agent_skills.last_run": "上次:",
    "agent_skills.mergeable": "对可合并",
    "agent_skills.run_curator": "立即整理",
    "agent_skills.patterns_title": "🔍 检测到重复操作模式",
    "agent_skills.occurred": "出现",
    "agent_skills.times": "次",
    "agent_skills.generate": "生成技能",
    "agent_skills.empty": "暂无技能。Agent 会在发现重复操作模式时自动生成，或在对话中说「创建技能」。",
    "agent_skills.status_active": "已激活",
    "agent_skills.status_archived": "已归档",
    "agent_skills.edit": "编辑",
    "agent_skills.export": "导出",
    "agent_skills.deactivate": "停用",
    "agent_skills.activate": "启用",
    "agent_skills.delete": "删除",
    "agent_skills.usage": "使用",
    "agent_skills.times_suffix": "次",
    "agent_skills.success_rate": "成功率",
    "agent_skills.trigger_prefix": "触发:",
    "agent_skills.curator_running": "运行中...",
    "agent_skills.curator_done": "Curator 完成: 归档 {archived} 个，发现 {dupes} 对可合并技能",
    "agent_skills.curator_fail": "Curator 失败: {error}",
    "agent_skills.generating": "生成中...",
    "agent_skills.generate_fail": "生成失败: {error}",
    "agent_skills.delete_confirm": "删除技能 {name}？",

    // ── Font Panel ──
    "font.label": "聊天字体",
    "font.yahei": "微软雅黑（默认）",
    "font.serif": "思源宋体",
    "font.hint": "修改后立即生效，影响所有对话消息和思考过程的显示字体",

    // ── Language Panel ──
    "lang.interface": "界面语言",
    "lang.hint": "切换语言后立即生效",
    "lang.zh": "简体中文",
    "lang.en": "English",

    // ── Sidebar ──
    "sidebar.new_chat": "新对话",
    "sidebar.search": "搜索历史对话...",
    "sidebar.clear_all": "清空所有会话",
    "sidebar.settings": "设置",
    "sidebar.workspace_hint": "点击切换工作区间",
    "sidebar.empty": "暂无历史会话",
    "sidebar.no_match": "未找到匹配",
    "sidebar.no_title": "(无标题)",
    "sidebar.export": "导出为 Markdown",
    "sidebar.delete": "删除此会话",
    "sidebar.delete_confirm": "确定删除此会话？",
    "sidebar.clear_confirm": "确定要清空所有会话记录吗？此操作不可撤销。",
    "sidebar.clear_done": "已清空所有会话 ({count}条)",
    "sidebar.delete_fail": "删除失败: {error}",

    // ── Chat Area ──
    "chat.welcome_desc": "任何事都可以找 {name}",
    "chat.upload": "上传文件",
    "chat.input_placeholder": "向 {name} 提问...",
    "chat.send": "发送",
    "chat.stop": "停止",
    "chat.plan": "计划",
    "chat.plan_hint": "计划模式：只读分析，不修改文件",
    "chat.kb_toggle": "知识库",
    "chat.kb_hint": "知识库 RAG 检索",
    "chat.reasoning": "深度推理",
    "chat.reasoning_hint": "深度推理",

    // ── Status ──
    "status.thinking": "思考中...",
    "status.ready": "就绪",
    "status.tasks": "{count} 个任务",
    "status.todos": "{count} 个 todo",

    // ── Thinking Section ──
    "thinking.title": "🧠 推理过程",
    "thinking.running": "运行中...",
    "thinking.done": "完成",

    // ── File Upload ──
    "file.remove": "移除",
    "file.too_large": "文件 \"{name}\" 超过 20MB 限制，已跳过",

    // ── Misc ──
    "misc.copied": "已复制",
    "misc.saving": "保存中...",
    "misc.saved": "已保存",
    "misc.failed": "失败",
    "misc.custom_suffix": "（自定义）",
    "misc.error": "错误",
    "misc.copy_content": "复制内容",
    "misc.download_markdown": "下载为 Markdown",
    "misc.unknown_error": "发生了未知错误",
    "misc.unconfigured": "未配置",
    "misc.not_set": "未设置",
    "misc.tasks": "{count} 个任务",

    // ── Model Labels ──
    "model.deepseek_v4_flash": "DeepSeek-V4-Flash（快速，默认）",
    "model.deepseek_v4_pro": "DeepSeek-V4-Pro（旗舰，强大）",
    "model.glm_4_7_flash": "GLM-4.7-Flash（免费，推荐）",
    "model.glm_4_plus": "GLM-4-Plus（旗舰）",
    "model.glm_4_air": "GLM-4-Air（轻量经济）",
    "model.qwen3_7_max": "Qwen3.7-Max（最新旗舰）",
    "model.qwen_plus": "Qwen-Plus（均衡，默认）",
    "model.qwen_turbo": "Qwen-Turbo（快速经济）",
    "model.mimo_7b_rl": "MiMo-7B-RL（推理，默认）",
    "model.mimo_7b_sft": "MiMo-7B-SFT（通用）",
    "model.claude_sonnet_4": "Claude Sonnet 4.6（均衡，推荐）",
    "model.claude_opus_4": "Claude Opus 4.6（旗舰）",
    "model.claude_haiku_4_5": "Claude Haiku 4.5（快速）",

    // ── Token Budget ──
    "budget.over_hard": "超过硬限制 {limit}，将被截断",
    "budget.near_limit": "接近限制 {limit}",
    "budget.tooltip": "系统提示词的估算 token 数（含记忆/任务/技能等上下文）",

    // ── Skill Editor ──
    "skill_editor.title": "编辑技能",
    "skill_editor.name": "技能名称",
    "skill_editor.desc": "简短描述",
    "skill_editor.triggers": "触发词（逗号分隔）",
    "skill_editor.body": "SKILL.md 正文...",
    "skill_editor.cancel": "取消",
    "skill_editor.save": "保存",
    "skill_editor.not_found": "技能不存在",
    "skill_editor.load_fail": "加载失败: {error}",
    "skill_editor.name_required": "名称不能为空",
    "skill_editor.save_fail": "保存失败: {error}",
    "skill_editor.export_fail": "导出失败: {error}",
    "skill_editor.invalid_file": "无效的技能文件: 缺少 body 或 steps",
    "skill_editor.import_fail": "导入失败: {error}",

    // ── Context Usage ──
    "context.label": "上下文 {pct}%",

    // ── Common Actions ──
    "common.save": "保存",
    "common.delete": "删除",
    "common.cancel": "取消",

    // ── Additional API Keys ──
    "api.system_prompt_title": "System Prompt",
    "api.system_prompt_placeholder": "可选：设置系统级提示词，会影响所有 Agent 的对话行为",
    "api.fetch_models_btn": "获取模型",

    // ── Additional Chat Keys ──
    "chat.welcome_title": "GoodAgent",
    "chat.task_progress": "当前任务进度",
    "chat.context_usage": "上下文使用量",

    // ── Additional Sidebar Keys ──
    "sidebar.switch_workspace": "点击切换工作区间",

    // ── WeChat Overlay ──
    "wechat.qr_title": "微信扫码登录",
    "wechat.loading": "加载中...",
    "wechat.scan_hint": "请使用微信扫描二维码",

    // ── Additional Skills Panel Keys ──
    "skills.desc": "本地安装的技能（.agents/ / .claude/skills/），Agent 可自动识别并使用。此面板为只读浏览。",

    // ── Additional Prompt Keys ──
    "prompt.new_profile": "新建",

    // ── Additional MCP Keys ──
    "mcp.desc": "配置 MCP（Model Context Protocol）服务器，让 AI 可以访问更多工具（数据库、文件系统、浏览器等）。格式与 Claude Code 的 .mcp.json 兼容。",
    "mcp.quick_searxng": "🔍 快速添加 SearXNG 搜索",
    "mcp.searxng_placeholder": "http://localhost:4000",
    "mcp.add": "添加",
    "mcp.detect_local": "📡 检测本地 MCP 配置",
    "mcp.empty_hint": "没有配置 MCP 服务器。点击\"添加服务器\"开始。",
    "mcp.refresh": "刷新",

    // ── Additional Agent Skills Keys ──
    "agent_skills.refresh": "刷新",
    "agent_skills.new_skill": "＋ 新建技能",
    "agent_skills.archive_before": "自动归档超过",
    "agent_skills.archive_after": "天未使用的技能",
    "agent_skills.count": "0 个技能",

    // ── Error Messages ──
    "error.query": "Query error:",
  },

  en: {
    // ── Settings Tabs ──
    "settings.title": "Settings",
    "settings.api": "API Config",
    "settings.avatar": "Avatar",
    "settings.skills": "Skills",
    "settings.prompt": "System Prompt",
    "settings.mcp": "MCP",
    "settings.social": "Social",
    "settings.memory": "Memory",
    "settings.kb": "Knowledge Base",
    "settings.agent_skills": "Agent Skills",
    "settings.font": "Font",
    "settings.language": "Language",
    "settings.close": "Close",

    // ── Config Banner ──
    "banner.api_required": "Please configure your API in Settings first",
    "banner.open_settings": "Open Settings",

    // ── Permission Modal ──
    "perm.title": "⚠️ Authorization Required",
    "perm.hint": "The following command needs your approval:",
    "perm.deny": "Deny",
    "perm.allow": "Allow",

    // ── Ask Question Modal ──
    "ask.title": "🤔 Confirmation Needed",
    "ask.confirm": "Confirm",

    // ── API Config Panel ──
    "api.provider": "Provider",
    "api.custom": "— Custom —",
    "api.url": "API URL",
    "api.model": "Model",
    "api.model_placeholder": "Enter model name, e.g. gpt-4o",
    "api.fetch_models": "Fetch available models from API",
    "api.fetch_btn": "Fetch Models",
    "api.key": "API Key",
    "api.save": "Save",
    "api.fill_url": "Please fill in the API URL",
    "api.saved": "✅ Saved — {name} API",
    "api.fetching": "Fetching...",
    "api.fetch_success": "✅ Fetched {count} models",
    "api.fetch_empty": "No models found. Please check the API URL.",
    "api.config_first": "Please configure the API URL in Settings first",

    // ── Provider Names ──
    "provider.custom": "Custom",
    "provider.deepseek": "DeepSeek",
    "provider.glm": "GLM (Zhipu)",
    "provider.qwen": "Qwen (Tongyi Qianwen)",
    "provider.mimo": "MiMo (Xiaomi)",
    "provider.claude": "Claude (Anthropic)",
    "provider.lmstudio": "LM Studio (Local)",
    "provider.ollama": "Ollama (Local)",

    // ── Avatar Panel ──
    "avatar.select_hint": "Choose an image file as avatar",
    "avatar.select": "Choose Image",
    "avatar.reset": "Reset to Default",
    "avatar.agent_name": "Agent Name",
    "avatar.save": "Save",
    "avatar.name_hint": "Takes effect in sidebar, chat labels, and page title",
    "avatar.user_section": "My Avatar & Name",
    "avatar.user_hint": "Choose an image file as your avatar",
    "avatar.user_name": "Your Name",
    "avatar.user_name_hint": "Displayed on your message labels in chat",
    "avatar.user_default": "You",
    "avatar.save_fail": "Avatar save failed: image too large, please choose a smaller one",
    "avatar.select_file": "Please select an image file",
    "avatar.decode_fail": "Image decode failed, please try another image",
    "avatar.name_changed": "Name changed to \"{name}\"",

    // ── Skills Panel (L3) ──
    "skills.local_hint": "Locally installed skills (.agents/ / .claude/skills/), auto-detected by Agent. This panel is read-only.",
    "skills.refresh": "Refresh",
    "skills.count": "{count} skills",
    "skills.scanning": "Scanning L3 local skills...",
    "skills.empty": "No local skills found. Skills are stored in .agents/ or .claude/skills/ directories.",
    "skills.load_error": "Failed to load local skills",
    "skills.triggers": "Triggers:",
    "skills.tools_count": "tools",

    // ── System Prompt Panel ──
    "prompt.new": "New",
    "prompt.default": "Default",
    "prompt.name": "Profile Name",
    "prompt.placeholder": "Enter system prompt here...",
    "prompt.saved": "Saved",
    "prompt.enabled": "Enabled",
    "prompt.enable": "Enable",
    "prompt.empty_hint": "Click \"New\" above to create a system prompt profile",
    "prompt.created": "System Prompt {num}",
    "prompt.delete_confirm": "Delete profile \"{name}\"?",
    "prompt.deleted": "Profile \"{name}\" deleted",
    "prompt.enabled_now": "Current profile enabled",

    // ── MCP Panel ──
    "mcp.hint": "Configure MCP (Model Context Protocol) servers to give AI access to more tools (databases, filesystem, browser, etc). Compatible with Claude Code's .mcp.json format.",
    "mcp.searxng_title": "🔍 Quick Add SearXNG Search",
    "mcp.searxng_add": "Add",
    "mcp.searxng_hint": "Enter your SearXNG instance URL to auto-configure npx mcp-searxng@latest",
    "mcp.detect_title": "📡 Detect Local MCP Configs",
    "mcp.scan": "Scan",
    "mcp.detect_hint": "Scan Claude Code CLI, OpenCode and other locally configured MCP servers for one-click import.",
    "mcp.add_server": "Add Server Manually",
    "mcp.save_config": "Save Config",
    "mcp.name": "Name",
    "mcp.name_placeholder": "e.g. filesystem",
    "mcp.command": "Command",
    "mcp.command_placeholder": "e.g. npx",
    "mcp.args": "Arguments",
    "mcp.args_placeholder": "e.g. -y @modelcontextprotocol/server-filesystem C:/Users/7",
    "mcp.env": "Environment Variables (optional, JSON)",
    "mcp.env_placeholder": "{\"API_KEY\":\"xxx\"}",
    "mcp.save_start": "Save & Start",
    "mcp.cancel": "Cancel",
    "mcp.empty": "No MCP servers configured. Click \"Add Server\" to get started.",
    "mcp.no_tools": "(no tools)",
    "mcp.running": "Running",
    "mcp.error": "Error",
    "mcp.starting": "Starting...",
    "mcp.restart": "Restart",
    "mcp.retry": "Retry",
    "mcp.remove": "Remove",
    "mcp.tools_label": "Tools:",
    "mcp.restarting": "Restarting...",
    "mcp.restart_fail": "Restart \"{name}\" failed: {error}",
    "mcp.remove_confirm": "Remove MCP server \"{name}\"?",
    "mcp.remove_fail": "Remove \"{name}\" failed: {error}",
    "mcp.load_error": "Failed to load MCP servers",
    "mcp.saving": "Saving...",
    "mcp.config_saved": "✅ MCP config saved",
    "mcp.save_fail": "Save failed: {error}",
    "mcp.name_required": "Name and command cannot be empty",
    "mcp.env_invalid": "Invalid environment variables format, please enter valid JSON",
    "mcp.starting_server": "Starting...",
    "mcp.start_fail": "Start failed: {error}",
    "mcp.searxng_url_required": "Please fill in the SearXNG URL",
    "mcp.searxng_adding": "Adding...",
    "mcp.searxng_added": "✅ SearXNG added and started",
    "mcp.searxng_fail": "Add failed: {error}",
    "mcp.detect_empty": "No local MCP configs found. Scanned Claude Code CLI (~/.claude/), OpenCode, etc.",
    "mcp.disabled": "(disabled)",
    "mcp.import_btn": "Import",
    "mcp.importing": "Importing...",
    "mcp.imported": "✅ \"{name}\" imported",
    "mcp.import_done": "✅ Imported",
    "mcp.import_fail": "Import \"{name}\" failed: {error}",
    "mcp.connecting": "Connecting...",
    "mcp.connected": "✅ \"{name}\" connected",
    "mcp.connect_done": "✅ Connected",
    "mcp.connect_fail": "Connect \"{name}\" failed: {error}",
    "mcp.connect": "Connect",
    "mcp.detect_fail": "Detection failed: {error}",
    "mcp.scanning": "Scanning...",

    // ── Social Panel ──
    "social.hint": "Connect social platforms for AI auto-reply.",
    "social.wechat": "WeChat",
    "social.connected": "Connected",
    "social.disconnected": "Disconnected",
    "social.qr_login": "Scan QR Login",
    "social.logout": "Logout",
    "social.qr_title": "WeChat QR Login",
    "social.qr_loading": "Loading...",
    "social.qr_scan": "Please scan the QR code with WeChat",
    "social.qr_scanned": "Scanned, please confirm on your phone...",
    "social.qr_success": "Login successful!",
    "social.qr_expired": "QR code expired, please reopen",
    "social.qr_error": "Failed: {error}",
    "social.qr_network": "Network error",
    "social.getting_qr": "Getting QR code...",
    "social.logged_out": "Logged out",
    "social.incoming": "Received: {text}",

    // ── Memory Panel ──
    "memory.title": "Memory Management",
    "memory.hint": "Agent automatically creates and updates memories during conversations",
    "memory.search": "Search memories...",
    "memory.new": "＋ New",
    "memory.empty_hint": "Select a memory to view or edit\nor click \"+ New\" to create one",
    "memory.name_placeholder": "Name, e.g. user_role",
    "memory.type_user": "User Info",
    "memory.type_feedback": "User Feedback",
    "memory.type_project": "Project Context",
    "memory.type_reference": "External Reference",
    "memory.desc_placeholder": "Short description for search matching",
    "memory.body_placeholder": "Memory content (Markdown supported)...",
    "memory.save": "Save",
    "memory.delete": "Delete",
    "memory.label_user": "👤 User",
    "memory.label_feedback": "💬 Feedback",
    "memory.label_project": "📋 Project",
    "memory.label_reference": "🔗 Reference",
    "memory.empty": "No memories yet",
    "memory.auto_hint": "Agent creates them automatically during conversations",
    "memory.no_desc": "(no description)",
    "memory.name_required": "❌ Name cannot be empty",
    "memory.saving": "Saving...",
    "memory.saved": "✅ Saved",
    "memory.save_fail": "❌ Save failed: {error}",
    "memory.delete_confirm": "Delete memory \"{name}\"? This cannot be undone.",
    "memory.deleted": "✅ Deleted",
    "memory.delete_fail": "❌ Delete failed: {error}",

    // ── Knowledge Base Panel ──
    "kb.title": "Knowledge Base (Obsidian)",
    "kb.hint": "Hybrid RAG: FTS5 keyword + vector semantic search",
    "kb.vault_path": "Vault Path",
    "kb.vault_placeholder": "Select Obsidian Vault folder",
    "kb.select": "Select",
    "kb.clear": "Clear",
    "kb.embedding": "Embedding Model",
    "kb.local_model": "Local MiniLM-L6 (Offline, Recommended)",
    "kb.ollama_model": "Ollama (Requires local server)",
    "kb.deepseek_model": "DeepSeek API",
    "kb.unconfigured": "Not configured",
    "kb.indexed": "Indexed {count} notes, {embedded} vectorized",
    "kb.not_indexed": "Not indexed",
    "kb.days_range": "Please enter a number between 1 and 365",
    "kb.scan_btn": "Scan & Index",
    "kb.test_btn": "Test Search",
    "kb.test_placeholder": "Enter keywords to test search...",
    "kb.max_notes": "Max injected notes",
    "kb.max_chars": "Max chars per note",
    "kb.error": "Error: {error}",
    "kb.pick_fail": "Failed to select folder: {error}",
    "kb.select_vault": "Please select a Vault path first",
    "kb.indexing": "Indexing...",
    "kb.scanning": "Scanning and indexing...",
    "kb.index_success": "Indexed {count} notes, {embedded} vectorized",
    "kb.searching": "Searching...",
    "kb.no_results": "No results",

    // ── Agent Skills Panel (L2) ──
    "agent_skills.title": "Agent Skills",
    "agent_skills.hint": "Reusable workflows generated by Agent or created manually",
    "agent_skills.import": "Import",
    "agent_skills.new": "＋ New Skill",
    "agent_skills.create_title": "Create New Skill",
    "agent_skills.name_placeholder": "Skill name (lowercase + hyphens)",
    "agent_skills.desc_placeholder": "Short description",
    "agent_skills.steps_placeholder": "1. Step one\n2. Step two",
    "agent_skills.save": "Save",
    "agent_skills.cancel": "Cancel",
    "agent_skills.auto_archive": "Auto-archive skills unused for",
    "agent_skills.archive_days": "days",
    "agent_skills.loading": "Loading...",
    "agent_skills.manual": "Manual",
    "agent_skills.never_run": "Never",
    "agent_skills.active": "active",
    "agent_skills.archived": "archived",
    "agent_skills.last_run": "Last:",
    "agent_skills.mergeable": "mergeable pairs",
    "agent_skills.run_curator": "Run Curator",
    "agent_skills.patterns_title": "🔍 Repeated patterns detected",
    "agent_skills.occurred": "occurred",
    "agent_skills.times": "times",
    "agent_skills.generate": "Generate Skill",
    "agent_skills.empty": "No skills yet. Agent auto-generates when it detects repeated patterns, or say \"create skill\" in chat.",
    "agent_skills.status_active": "Active",
    "agent_skills.status_archived": "Archived",
    "agent_skills.edit": "Edit",
    "agent_skills.export": "Export",
    "agent_skills.deactivate": "Deactivate",
    "agent_skills.activate": "Activate",
    "agent_skills.delete": "Delete",
    "agent_skills.usage": "Used",
    "agent_skills.times_suffix": "times",
    "agent_skills.success_rate": "Success",
    "agent_skills.trigger_prefix": "Triggers:",
    "agent_skills.curator_running": "Running...",
    "agent_skills.curator_done": "Curator done: archived {archived}, found {dupes} mergeable pairs",
    "agent_skills.curator_fail": "Curator failed: {error}",
    "agent_skills.generating": "Generating...",
    "agent_skills.generate_fail": "Generation failed: {error}",
    "agent_skills.delete_confirm": "Delete skill {name}?",

    // ── Font Panel ──
    "font.label": "Chat Font",
    "font.yahei": "Microsoft YaHei (Default)",
    "font.serif": "Source Han Serif",
    "font.hint": "Takes effect immediately, affects all chat messages and reasoning display",

    // ── Language Panel ──
    "lang.interface": "Interface Language",
    "lang.hint": "Takes effect immediately after switching",
    "lang.zh": "简体中文",
    "lang.en": "English",

    // ── Sidebar ──
    "sidebar.new_chat": "New Chat",
    "sidebar.search": "Search history...",
    "sidebar.clear_all": "Clear All Sessions",
    "sidebar.settings": "Settings",
    "sidebar.workspace_hint": "Click to switch workspace",
    "sidebar.empty": "No chat history",
    "sidebar.no_match": "No matches found",
    "sidebar.no_title": "(untitled)",
    "sidebar.export": "Export as Markdown",
    "sidebar.delete": "Delete this session",
    "sidebar.delete_confirm": "Delete this session?",
    "sidebar.clear_confirm": "Clear all session records? This cannot be undone.",
    "sidebar.clear_done": "Cleared all sessions ({count})",
    "sidebar.delete_fail": "Delete failed: {error}",

    // ── Chat Area ──
    "chat.welcome_desc": "Ask {name} anything",
    "chat.upload": "Upload File",
    "chat.input_placeholder": "Ask {name}...",
    "chat.send": "Send",
    "chat.stop": "Stop",
    "chat.plan": "Plan",
    "chat.plan_hint": "Plan mode: read-only analysis, no file modifications",
    "chat.kb_toggle": "KB",
    "chat.kb_hint": "Knowledge Base RAG Search",
    "chat.reasoning": "Reasoning",
    "chat.reasoning_hint": "Deep Reasoning",

    // ── Status ──
    "status.thinking": "Thinking...",
    "status.ready": "Ready",
    "status.tasks": "{count} tasks",
    "status.todos": "{count} todos",

    // ── Thinking Section ──
    "thinking.title": "🧠 Reasoning",
    "thinking.running": "Running...",
    "thinking.done": "Done",

    // ── File Upload ──
    "file.remove": "Remove",
    "file.too_large": "File \"{name}\" exceeds 20MB limit, skipped",

    // ── Misc ──
    "misc.copied": "Copied",
    "misc.saving": "Saving...",
    "misc.saved": "Saved",
    "misc.failed": "Failed",
    "misc.custom_suffix": " (Custom)",
    "misc.error": "Error",
    "misc.copy_content": "Copy Content",
    "misc.download_markdown": "Download as Markdown",
    "misc.unknown_error": "An unknown error occurred",
    "misc.unconfigured": "Not configured",
    "misc.not_set": "Not set",
    "misc.tasks": "{count} tasks",

    // ── Model Labels ──
    "model.deepseek_v4_flash": "DeepSeek-V4-Flash (Fast, Default)",
    "model.deepseek_v4_pro": "DeepSeek-V4-Pro (Flagship, Powerful)",
    "model.glm_4_7_flash": "GLM-4.7-Flash (Free, Recommended)",
    "model.glm_4_plus": "GLM-4-Plus (Flagship)",
    "model.glm_4_air": "GLM-4-Air (Lightweight, Economical)",
    "model.qwen3_7_max": "Qwen3.7-Max (Latest Flagship)",
    "model.qwen_plus": "Qwen-Plus (Balanced, Default)",
    "model.qwen_turbo": "Qwen-Turbo (Fast, Economical)",
    "model.mimo_7b_rl": "MiMo-7B-RL (Reasoning, Default)",
    "model.mimo_7b_sft": "MiMo-7B-SFT (General)",
    "model.claude_sonnet_4": "Claude Sonnet 4.6 (Balanced, Recommended)",
    "model.claude_opus_4": "Claude Opus 4.6 (Flagship)",
    "model.claude_haiku_4_5": "Claude Haiku 4.5 (Fast)",

    // ── Token Budget ──
    "budget.over_hard": "Exceeds hard limit {limit}, will be truncated",
    "budget.near_limit": "Approaching limit {limit}",
    "budget.tooltip": "Estimated token count for system prompt (including memory/tasks/skills context)",

    // ── Skill Editor ──
    "skill_editor.title": "Edit Skill",
    "skill_editor.name": "Skill Name",
    "skill_editor.desc": "Short description",
    "skill_editor.triggers": "Triggers (comma separated)",
    "skill_editor.body": "SKILL.md content...",
    "skill_editor.cancel": "Cancel",
    "skill_editor.save": "Save",
    "skill_editor.not_found": "Skill not found",
    "skill_editor.load_fail": "Load failed: {error}",
    "skill_editor.name_required": "Name cannot be empty",
    "skill_editor.save_fail": "Save failed: {error}",
    "skill_editor.export_fail": "Export failed: {error}",
    "skill_editor.invalid_file": "Invalid skill file: missing body or steps",
    "skill_editor.import_fail": "Import failed: {error}",

    // ── Context Usage ──
    "context.label": "Context {pct}%",

    // ── Common Actions ──
    "common.save": "Save",
    "common.delete": "Delete",
    "common.cancel": "Cancel",

    // ── Additional API Keys ──
    "api.system_prompt_title": "System Prompt",
    "api.system_prompt_placeholder": "Optional: set a system-level prompt affecting all Agent conversations",
    "api.fetch_models_btn": "Fetch Models",

    // ── Additional Chat Keys ──
    "chat.welcome_title": "GoodAgent",
    "chat.task_progress": "Task Progress",
    "chat.context_usage": "Context Usage",

    // ── Additional Sidebar Keys ──
    "sidebar.switch_workspace": "Click to switch workspace",

    // ── WeChat Overlay ──
    "wechat.qr_title": "WeChat QR Login",
    "wechat.loading": "Loading...",
    "wechat.scan_hint": "Please scan the QR code with WeChat",

    // ── Additional Skills Panel Keys ──
    "skills.desc": "Locally installed skills (.agents/ / .claude/skills/) auto-detected by Agent. This panel is read-only.",

    // ── Additional Prompt Keys ──
    "prompt.new_profile": "New",

    // ── Additional MCP Keys ──
    "mcp.desc": "Configure MCP (Model Context Protocol) servers to give AI access to more tools (databases, filesystem, browser, etc). Compatible with Claude Code's .mcp.json format.",
    "mcp.quick_searxng": "🔍 Quick Add SearXNG Search",
    "mcp.searxng_placeholder": "http://localhost:4000",
    "mcp.add": "Add",
    "mcp.detect_local": "📡 Detect Local MCP Configs",
    "mcp.empty_hint": "No MCP servers configured. Click \"Add Server\" to get started.",
    "mcp.import_btn": "Import",
    "mcp.refresh": "Refresh",

    // ── Additional Agent Skills Keys ──
    "agent_skills.refresh": "Refresh",
    "agent_skills.new_skill": "＋ New Skill",
    "agent_skills.archive_before": "Auto-archive skills unused for",
    "agent_skills.archive_after": "days",
    "agent_skills.count": "0 skills",

    // ── Error Messages ──
    "error.query": "Query error:",
  },
};

// ── Public API ──

function getLang() {
  return localStorage.getItem(LANG_KEY) || "zh";
}

function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang);
}

function t(key, vars = {}) {
  const lang = getLang();
  let str = translations[lang]?.[key] || translations.zh[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

function applyLang() {
  // Static text elements
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (el.hasAttribute("data-i18n-placeholder")) {
      el.placeholder = t(key);
    } else {
      el.textContent = t(key);
    }
  });
  // Title attributes
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
}
