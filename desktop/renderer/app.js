// @ts-nocheck — this 2872-line monolith will be split into focused modules
// in the refactor step. Adding JSDoc here would be wasted effort.
// @ts-nocheck — 这个 2872 行的单片文件会在重构步骤拆分为聚焦模块。
//              在这里加 JSDoc 是浪费工作。
/* ── Import modules ───────────────────────────────────── */
import './modules/font-settings.mjs';
import './modules/bg-settings.mjs';
import './modules/workspace.mjs';
import { initKnowledgeBase } from './modules/knowledge-base.mjs';
import { initMemoryPanel } from './modules/memory-panel.mjs';
import { loadAgentName, loadUserName, applyAgentName, applyUserName, initAgentNameUI, initUserAvatarUI, loadUserAvatarSrc } from './modules/agent-name.mjs';
import { sanitize, renderMarkdown, renderLatexInElement, autoResize, formatFileSize, scrollToBottom, setStatus, loadReasoningEnabled, saveReasoningEnabled } from './modules/helpers.mjs';
import { loadEnabledSkills } from './modules/skills-panel.mjs';
import { switchSettingsTab, initSettingsTabs } from './modules/settings-tabs.mjs';
import { createFilePreviews } from './modules/file-previews.mjs';
import { createPromptStore } from './modules/prompt-store.mjs';
import { createMcpPanel } from './modules/mcp.mjs';
import { createWechatPanel } from './modules/wechat.mjs';

/* ── Configure marked.js ──────────────────────────────── */
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {}
    }
    return hljs.highlightAuto(code).value;
  },
});

/* ── Constants ────────────────────────────────────────── */
const STORAGE_KEYS = {
  PROVIDER: "AideAgent_provider",
  API_URL: "AideAgent_api_url",
  MODEL: "AideAgent_model",
  API_KEY: "AideAgent_api_key",
  API_FORMAT: "AideAgent_api_format",
  REASONING_ENABLED: "AideAgent_reasoning_enabled",
};

const PROVIDER_PRESETS = {
  "":        { name: t("provider.custom"),     url: "",                              model: "",                                   models: [], format: "openai" },
  deepseek:  { name: t("provider.deepseek"),   url: "https://api.deepseek.com",      model: "deepseek-v4-flash",                  models: [{id:"deepseek-v4-flash",label:t("model.deepseek_v4_flash")},{id:"deepseek-v4-pro",label:t("model.deepseek_v4_pro")}], format: "openai" },
  glm:       { name: t("provider.glm"),        url: "https://open.bigmodel.cn/api/paas/v4", model: "GLM-4.7-Flash",                  models: [{id:"GLM-4.7-Flash",label:t("model.glm_4_7_flash")},{id:"GLM-4-Plus",label:t("model.glm_4_plus")},{id:"GLM-4-Air",label:t("model.glm_4_air")}], format: "openai" },
  qwen:      { name: t("provider.qwen"),       url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",          models: [{id:"qwen3.7-max",label:t("model.qwen3_7_max")},{id:"qwen-plus",label:t("model.qwen_plus")},{id:"qwen-turbo",label:t("model.qwen_turbo")}], format: "openai" },
  llamacpp:  { name: t("provider.llamacpp"),   url: "http://127.0.0.1:8080/v1",       model: "",                                   models: [], format: "openai" },
  minimax:   { name: t("provider.minimax"),    url: "https://api.minimaxi.com/anthropic",  model: "MiniMax-M2.7",                       models: [{id:"MiniMax-M2.7",label:t("model.minimax_m2_7")},{id:"MiniMax-M2.7-highspeed",label:t("model.minimax_m2_7_highspeed")}], format: "anthropic" },
  claude:    { name: t("provider.claude"),      url: "https://api.anthropic.com",     model: "claude-sonnet-4-20250514",            models: [{id:"claude-sonnet-4-20250514",label:t("model.claude_sonnet_4")},{id:"claude-opus-4-20250514",label:t("model.claude_opus_4")},{id:"claude-haiku-4.5-20250514",label:t("model.claude_haiku_4_5")}], format: "anthropic" },
  lmstudio:  { name: t("provider.lmstudio"),   url: "http://localhost:1234/v1",      model: "",                                   models: [], format: "openai" },
  ollama:    { name: t("provider.ollama"),      url: "http://localhost:11434/v1",     model: "",                                   models: [], format: "openai" },
};

/* ── State ────────────────────────────────────────────── */
const state = {
  sessionId: null,
  isStreaming: false,
  currentAssistantMsg: null,
  currentText: "",
  currentReasoning: "",
  _thinkBuffer: "",       // buffered partial think tag across chunks
  _permResolve: null,
  _toolCallCount: 0,
  _afterToolCall: false,  // true after a tool call completes, triggers new reasoning block
  _reasoningBlockText: "", // text of the current reasoning block
  attachedFiles: [],       // {name, size, type, dataUrl}
  _streamStartTime: 0,
  _streamCharCount: 0,
  _cacheMetrics: null,     // { hit, miss, total, rate } from latest API call
};

/* ── DOM refs ─────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const configBanner = $("#config-banner");
const bannerSettingsBtn = $("#banner-settings-btn");
const app = $("#app");
const messageList = $("#message-list");
const promptInput = $("#prompt-input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const statusText = $("#status-text");
const infoModelName = $("#info-model-name");
const taskIndicator = $("#task-indicator");
const reasoningCheckbox = $("#reasoning-checkbox");
const planModeCheckbox = $("#plan-mode-checkbox");
const sessionDisplay = $("#session-display");
const cwdDisplay = $("#cwd-display");
const newChatBtn = $("#new-chat");
const permModal = $("#perm-modal");
const permCommand = $("#perm-command");
const permAllow = $("#perm-allow");
const permDeny = $("#perm-deny");
const settingsModal = $("#settings-modal");
const settingsBtn = $("#settings-btn");
const settingsCloseBtn = $("#settings-close-btn");
const settingsTabs = $("#settings-tabs");
const settingsProvider = $("#settings-provider");
const settingsUrl = $("#settings-url");
const settingsModel = $("#settings-model");
const settingsModelInput = $("#settings-model-input");
const settingsKey = $("#settings-key");
const settingsSearchProvider = $("#settings-search-provider");
const settingsTavilyKey = $("#settings-tavily-key");
const tavilyKeyRow = $("#tavily-key-row");
const settingsSaveBtn = $("#settings-save-btn");
const settingsStatus = $("#settings-status");
const avatarFileInput = $("#avatar-file-input");
const changeAvatarBtn = $("#change-avatar-btn");
const resetAvatarBtn = $("#reset-avatar-btn");
const settingsPreview = $("#settings-preview");
const sidebarAvatar = $("#sidebar-avatar");
const welcomeAvatar = $("#welcome-avatar");
const uploadBtn = $("#upload-btn");
const fileInput = $("#file-input");
const filePreviewArea = $("#file-preview-area");
const AVATAR_KEY = "AideAgent_avatar";
const USER_AVATAR_KEY = "AideAgent_user_avatar";
const FONT_KEY = "AideAgent_font";
const USER_NAME_KEY = "AideAgent_user_name";

/* ── Helpers (imported from modules/helpers.mjs) ── */

/* ── File upload ──────────────────────────────── */
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

// File previews extracted to modules/file-previews.mjs (Step 3c).
// The state, DOM refs, and callbacks are passed via createFilePreviews({...}).
// 已提取到 modules/file-previews.mjs（Step 3c）。state、DOM 引用和回调通过
// createFilePreviews({...}) 注入。
const filePreviews = createFilePreviews({
  state,
  filePreviewArea,
  fileInput,
  uploadBtn,
  sendBtn,
  promptInput,
  MAX_FILE_SIZE,
  onError: (msg) => addErrorMessage(t(msg)),
  formatFileSize,
});
const renderFilePreviews = filePreviews.renderFilePreviews;
const updateSendButton = filePreviews.updateSendButton;
const handleFileUpload = filePreviews.handleFileUpload;


/* ── Update info bar (model name + reasoning state) ── */
function updateInfoBar() {
  if (!infoModelName) return;
  const cfg = loadApiConfig();
  // Show model name (or provider label if no model)
  const preset = cfg.provider ? PROVIDER_PRESETS[cfg.provider] : null;
  const label = preset?.name || cfg.apiUrl?.replace(/https?:\/\//, "").split("/")[0] || "";
  const model = cfg.model || "";
  infoModelName.textContent = model ? `${label} · ${model}` : label;
}

/* ── Reasoning toggle event ──────────────────────── */
if (reasoningCheckbox) {
  reasoningCheckbox.checked = loadReasoningEnabled();
  reasoningCheckbox.addEventListener("change", () => {
    saveReasoningEnabled(reasoningCheckbox.checked);
  });
  // Plan mode toggle
  planModeCheckbox.addEventListener("change", () => {
    window.aideagent.setPlanMode(planModeCheckbox.checked);
  });
  // Load initial plan mode state
  window.aideagent.getPlanMode().then(r => { planModeCheckbox.checked = r.planMode; }).catch(() => {});
}

/* ── Message DOM ──────────────────────────────────────── */
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "message user";
  const userName = loadUserName();
  const userAvatarSrc = loadUserAvatarSrc();
  // Build DOM safely — avatar before name to match original layout
  const label = document.createElement("div");
  label.className = "message-label";
  if (userAvatarSrc) {
    const img = document.createElement("img");
    img.className = "avatar user-msg-avatar";
    img.src = userAvatarSrc;
    img.alt = "";
    label.appendChild(img);
  }
  label.appendChild(document.createTextNode(userName));
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.innerHTML = `<p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p>`;
  div.appendChild(label);
  div.appendChild(bubble);
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

function addAssistantMessage() {
  const div = document.createElement("div");
  div.className = "message assistant streaming";
  const agentName = loadAgentName();
  const saved = localStorage.getItem(AVATAR_KEY);
  const avatarSrc = saved || DEFAULT_AVATAR;
  // Build DOM safely to prevent XSS from localStorage-tainted values
  const label = document.createElement("div");
  label.className = "message-label";
  const img = document.createElement("img");
  img.className = "avatar msg-avatar";
  img.src = avatarSrc;
  img.alt = "";
  label.appendChild(img);
  label.appendChild(document.createTextNode(agentName));
  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = '<div class="message-text"></div>';
  div.appendChild(label);
  div.appendChild(content);
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

function addErrorMessage(text) {
  const div = document.createElement("div");
  div.className = "message error";
  div.innerHTML = `
    <div class="message-label">${t("misc.error")}</div>
    <div class="message-bubble"><p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p></div>
  `;
  messageList.appendChild(div);
  scrollToBottom();
  return div;
}

/* ── Extract thinking / reasoning from content ──────── */
function extractThinkingBlocks(text) {
  const blocks = [];
  // Reattach buffered partial from previous chunk
  if (state._thinkBuffer) {
    text = state._thinkBuffer + text;
    state._thinkBuffer = "";
  }

  // ... — DeepSeek R1 / Qwen style
  // Split into tag vs non-tag segments (case-insensitive)
  const parts = [];
  let lastIdx = 0;
  const re = /<\/?think>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push({ text: text.slice(lastIdx, match.index), tag: null });
    parts.push({ text: "", tag: match[0].toLowerCase() });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), tag: null });

  let clean = "", inside = false, pending = "";
  for (const p of parts) {
    if (p.tag === "<think>") {
      inside = true; pending = "";
    } else if (p.tag === "</think>") {
      inside = false;
      if (pending) blocks.push(pending);
      pending = "";
    } else if (inside) {
      pending += p.text;
    } else {
      clean += p.text;
    }
  }

  // Unclosed → buffer for next chunk
  if (inside) state._thinkBuffer = "<think>" + pending;

  return { cleanText: clean.trim(), thinkingText: blocks.join("\n\n").trim() };
}

function updateThinkingSection(msgEl, text) {
  if (!text) return;
  const section = getOrCreateThinkingSection(msgEl);
  if (!section) return;
  if (!section.hasAttribute("open")) section.setAttribute("open", "");
  const tc = section.querySelector(".thinking-content");

  // After a tool call, start a new reasoning block
  if (state._afterToolCall) {
    state._afterToolCall = false;
    state._reasoningBlockText = "";
  }

  state._reasoningBlockText = text;

  // Find or create the last reasoning div
  let el = null;
  const children = tc.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].classList.contains("thinking-reasoning")) {
      el = children[i];
      break;
    }
  }
  // If no reasoning div, or last child is a tool-entry, create new
  if (!el || (tc.lastElementChild && tc.lastElementChild.classList.contains("tool-entry"))) {
    el = document.createElement("div");
    el.className = "thinking-reasoning";
    tc.appendChild(el);
  }
  el.textContent = text;
}

function updateAssistantContent(msgEl, text) {
  const textEl = msgEl.querySelector(".message-text");
  if (!textEl) return;

  if (!text.trim()) {
    textEl.innerHTML = '<span class="thinking-indicator">' + t("status.thinking") + '</span>';
    return;
  }

  // Extract ... thinking blocks into the collapsible section
  const { cleanText, thinkingText } = extractThinkingBlocks(text);
  if (thinkingText) {
    // Merge with any reasoning_content already shown
    const fullThinking = state.currentReasoning
      ? state.currentReasoning + "\n\n" + thinkingText
      : thinkingText;
    updateThinkingSection(msgEl, fullThinking);
  }

  textEl.innerHTML = renderMarkdown(cleanText || text);

  // Re-highlight code blocks
  textEl.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });

  // Render LaTeX via KaTeX (finds <span class="kp"> markers)
  renderLatexInElement(textEl);
}

function finishAssistantMessage(msgEl) {
  msgEl.classList.remove("streaming");
  // 思考过程折叠起来（移除 open 属性）
  const thinking = msgEl.querySelector(".thinking-collapsible");
  if (thinking) thinking.removeAttribute("open");

  // If message only has thinking indicator (no content), replace it
  const textEl = msgEl.querySelector(".message-text");
  if (textEl && textEl.querySelector(".thinking-indicator")) {
    if (state.currentText) {
      textEl.innerHTML = renderMarkdown(state.currentText);
    } else {
      textEl.innerHTML = `<span style="color:var(--text-muted);font-size:13px;">${t("status.stopped")}</span>`;
    }
  }

  // 添加复制/下载操作栏（避免重复添加）
  if (!msgEl.querySelector(".message-actions")) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.innerHTML = `
      <button class="msg-action-btn" data-i18n-title="misc.copy_content" title="复制内容" data-action="copy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="msg-action-btn" data-i18n-title="misc.download_markdown" title="下载为 Markdown" data-action="download">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    `;
    msgEl.querySelector(".message-content").after(actions);

    const textGetter = () => {
      const textEl = msgEl.querySelector(".message-text");
      return textEl ? textEl.textContent || "" : "";
    };

    actions.addEventListener("click", async (e) => {
      const btn = e.target.closest(".msg-action-btn");
      if (!btn) return;
      const text = textGetter();
      if (!text) return;

      if (btn.dataset.action === "copy") {
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.innerHTML;
          btn.innerHTML = `<span style="color:#22c55e">${t("misc.copied")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } catch { /* ignore */ }
      } else if (btn.dataset.action === "download") {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = t("misc.saving");
        const result = await window.aideagent.downloadMarkdown(text);
        if (result.success) {
          btn.innerHTML = `<span style="color:#22c55e">${t("misc.saved")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } else if (!result.canceled) {
          btn.innerHTML = `<span style="color:#ef4444">${t("misc.failed")}</span>`;
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        } else {
          btn.innerHTML = orig;
        }
        btn.disabled = false;
      }
    });
  }

  // Show token speed indicator
  if (!msgEl.querySelector(".token-speed") && state._streamStartTime > 0) {
    const elapsed = (Date.now() - state._streamStartTime) / 1000;
    const chars = state._streamCharCount;
    if (elapsed > 0.5 && chars > 0) {
      const cps = (chars / elapsed).toFixed(0);
      // Estimate tokens: ~4 chars per token for English, ~1.5 for CJK
      const cjkCount = (state.currentText.match(/[一-鿿]/g) || []).length;
      const asciiCount = chars - cjkCount;
      const tokens = Math.ceil(cjkCount * 0.7 + asciiCount * 0.25);
      const tps = (tokens / elapsed).toFixed(1);
      const speedEl = document.createElement("div");
      speedEl.className = "token-speed";
      speedEl.style.cssText = "font-size:11px;color:var(--text-muted);margin-top:4px;text-align:right;";
      let speedText = `⚡ ${tps} tok/s · ${elapsed.toFixed(1)}s`;
      let speedTitle = `${chars} 字符 · ${tokens} tokens · ${elapsed.toFixed(1)}s`;
      if (state._cacheMetrics && state._cacheMetrics.rate > 0) {
        const { hit, miss, total, rate } = state._cacheMetrics;
        const color = rate >= 80 ? "#22c55e" : rate >= 50 ? "#eab308" : "#ef4444";
        speedText += ` · <span style="color:${color}">💾 ${rate}%</span> 命中缓存`;
        speedTitle += `\nCache hit: ${hit.toLocaleString()} · Miss: ${miss.toLocaleString()} · Total: ${total.toLocaleString()}`;
      }
      speedEl.innerHTML = speedText;
      speedEl.title = speedTitle;
      const actions = msgEl.querySelector(".message-actions");
      if (actions) actions.before(speedEl);
      else msgEl.querySelector(".message-content")?.after(speedEl);
    }
  }

  scrollToBottom();
}

/* ── Show welcome ─────────────────────────────────────── */
function showWelcome() {
  const agentName = loadAgentName();
  messageList.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">
        <img id="welcome-avatar" class="avatar avatar-welcome" src="avatar.jpg" alt="${agentName}" />
      </div>
      <h1>${agentName}</h1>
      <p class="description">${t("chat.welcome_desc", { name: agentName })}</p>
    </div>
  `;
  // Re-apply avatar after DOM replacement (DEFAULT_AVATAR fallback if none saved)
  const saved = localStorage.getItem(AVATAR_KEY);
  const src = saved || DEFAULT_AVATAR;
  const wa = document.getElementById("welcome-avatar");
  if (wa) wa.src = src;
  const sp = document.getElementById("settings-preview");
  if (sp) sp.src = src;
}

/* ── Settings Persistence ─────────────────────────────── */
// Encrypted API key cache (loaded async from main process)
const _apiKeyCache = {}; // { provider: key }

async function initApiKeys() {
  const provider = localStorage.getItem(STORAGE_KEYS.PROVIDER) || "";
  if (provider) {
    try {
      const key = await window.aideagent.loadApiKey(provider);
      if (key) {
        _apiKeyCache[provider] = key;
      } else {
        // Migrate old plaintext key from localStorage
        const legacyKey = localStorage.getItem(provider ? `AideAgent_api_key_${provider}` : "AideAgent_api_key") || "";
        if (legacyKey) {
          _apiKeyCache[provider] = legacyKey;
          await window.aideagent.saveApiKey(provider, legacyKey);
          localStorage.removeItem(provider ? `AideAgent_api_key_${provider}` : "AideAgent_api_key");
        }
      }
    } catch { /* ignored */ }
  }
}

function loadApiConfig() {
  const provider = localStorage.getItem(STORAGE_KEYS.PROVIDER) || "";
  const prefix = provider ? `AideAgent_${provider}_` : "AideAgent_";
  const apiKey = _apiKeyCache[provider] || "";
  return {
    provider,
    apiUrl: localStorage.getItem(`${prefix}api_url`) || "",
    model: localStorage.getItem(`${prefix}model`) || "",
    apiKey,
    apiFormat: localStorage.getItem(STORAGE_KEYS.API_FORMAT) || "openai",
  };
}

async function saveApiConfig(provider, apiUrl, model, apiKey, apiFormat) {
  const prefix = provider ? `AideAgent_${provider}_` : "AideAgent_";
  if (apiUrl) localStorage.setItem(`${prefix}api_url`, apiUrl);
  localStorage.setItem(STORAGE_KEYS.PROVIDER, provider);
  if (model) localStorage.setItem(`${prefix}model`, model);
  if (apiFormat) localStorage.setItem(STORAGE_KEYS.API_FORMAT, apiFormat);
  if (apiKey) {
    _apiKeyCache[provider] = apiKey;
    await window.aideagent.saveApiKey(provider, apiKey);
    // Remove legacy plaintext key
    localStorage.removeItem(provider ? `AideAgent_api_key_${provider}` : "AideAgent_api_key");
  }
}

function clearApiConfig() {
  Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
}

function hasApiConfig() {
  const cfg = loadApiConfig();
  return !!cfg.apiUrl;
}

function updateConfigBanner() {
  if (hasApiConfig()) {
    configBanner.classList.add("hidden");
  } else {
    configBanner.classList.remove("hidden");
  }
}

function getCurrentModelValue() {
  if (settingsModelInput && settingsModelInput.style.display !== "none") {
    return settingsModelInput.value;
  }
  return settingsModel?.value || "";
}

function populateModelDropdown(preset, selectedModel) {
  if (!settingsModel) return;
  settingsModel.innerHTML = "";
  if (preset && preset.models && preset.models.length > 0) {
    preset.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === selectedModel) opt.selected = true;
      settingsModel.appendChild(opt);
    });
    if (selectedModel && !preset.models.some(m => m.id === selectedModel)) {
      const customOpt = document.createElement("option");
      customOpt.value = selectedModel;
      customOpt.textContent = selectedModel + " (自定义)";
      customOpt.selected = true;
      settingsModel.insertBefore(customOpt, settingsModel.firstChild);
    }
    // Add "自定义" option at the bottom
    const customEntry = document.createElement("option");
    customEntry.value = "__custom__";
    customEntry.textContent = "✏️ 手动输入模型名称...";
    settingsModel.appendChild(customEntry);
    // Toggle to input when "自定义" is selected
    settingsModel.addEventListener("change", () => {
      if (settingsModel.value === "__custom__") {
        settingsModel.style.display = "none";
        settingsModelInput.style.display = "";
        settingsModelInput.value = "";
        settingsModelInput.focus();
      }
    });
    settingsModel.style.display = "";
    if (settingsModelInput) settingsModelInput.style.display = "none";
  } else {
    settingsModel.style.display = "none";
    if (settingsModelInput) {
      settingsModelInput.style.display = "";
      settingsModelInput.value = selectedModel || "";
    }
  }
}

function fillSettingsForm() {
  _fillingForm = true;
  try {
    const cfg = loadApiConfig();
    if (settingsProvider) settingsProvider.value = cfg.provider;
    const preset = PROVIDER_PRESETS[cfg.provider];
    if (settingsUrl) settingsUrl.value = cfg.apiUrl || (preset?.url ?? "");
    if (settingsModel || settingsModelInput) {
      const selectedModel = cfg.model || preset?.model || "";
      populateModelDropdown(preset, selectedModel);
    }
    if (settingsKey) settingsKey.value = cfg.apiKey;
    // Load search provider + Tavily key
    if (settingsSearchProvider) {
      const saved = localStorage.getItem("AideAgent_search_provider") || "tavily";
      settingsSearchProvider.value = saved;
      if (tavilyKeyRow) tavilyKeyRow.style.display = saved === "tavily" ? "block" : "none";
    }
    if (settingsTavilyKey) {
      // Try encrypted store first, then env var
      window.aideagent.loadApiKey("tavily").then(k => {
        if (k) { settingsTavilyKey.value = k; return; }
        // Auto-detect from environment
        window.aideagent.getEnvVar("TAVILY_API_KEY").then(envKey => {
          if (envKey) settingsTavilyKey.value = envKey;
        }).catch(() => {});
      }).catch(() => {});
    }
  } finally {
    _fillingForm = false;
  }
}

function onProviderChange() {
  const key = settingsProvider?.value || "";
  const preset = PROVIDER_PRESETS[key];
  const prefix = key ? `AideAgent_${key}_` : "AideAgent_";
  const savedUrl = localStorage.getItem(`${prefix}api_url`) || "";
  const savedModel = localStorage.getItem(`${prefix}model`) || "";
  if (preset && key) {
    settingsUrl.value = savedUrl || preset.url;
    populateModelDropdown(preset, savedModel || preset.model);
    if (preset.models.length === 0 && preset.url) {
      setTimeout(fetchModels, 300);
    }
  } else {
    settingsUrl.value = savedUrl;
    populateModelDropdown(null, savedModel);
  }
  // Load from encrypted key store (not localStorage — keys were migrated)
  if (settingsKey) {
    settingsKey.value = _apiKeyCache[key] || "";
    if (!_apiKeyCache[key] && key) {
      window.aideagent.loadApiKey(key).then(k => {
        if (k) { _apiKeyCache[key] = k; settingsKey.value = k; }
      }).catch(() => {});
    }
  }
}

function normalizeApiUrl(url) {
  url = url.trim();
  if (!url) return "";
  // Strip trailing slash
  url = url.replace(/\/+$/, "");
  // Already has chat completions path
  if (/\/chat\/completions$/.test(url)) return url;
  // If it ends with /v1 or similar version prefix, append chat/completions
  if (/\/v\d+$/.test(url)) return url + "/chat/completions";
  // If it looks like a base URL (just scheme + host), append /chat/completions
  try {
    const u = new URL(url);
    if (u.pathname === "/" || u.pathname === "") return url + "/chat/completions";
  } catch {}
  // Default: append /chat/completions
  return url + "/chat/completions";
}

async function saveSettingsForm() {
  const provider = settingsProvider?.value || "";
  const rawUrl = (settingsUrl?.value || "").trim();
  const model = getCurrentModelValue().trim();
  const apiKey = (settingsKey?.value || "").trim();
  const preset = PROVIDER_PRESETS[provider];
  const apiFormat = preset?.format || "openai";

  if (!rawUrl) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fill_url");
      settingsStatus.className = "settings-status error";
    }
    return;
  }

  const apiUrl = apiFormat === "anthropic" ? rawUrl.replace(/\/+$/, "") : normalizeApiUrl(rawUrl);

  // Show the normalized URL to user
  if (apiUrl !== rawUrl) {
    settingsUrl.value = apiUrl;
  }

  await saveApiConfig(provider, apiUrl, model, apiKey, apiFormat);
  // Save search provider preference (localStorage for UI + config file for main process)
  if (settingsSearchProvider) {
    localStorage.setItem("AideAgent_search_provider", settingsSearchProvider.value);
    window.aideagent.saveApiKey("_search_provider", settingsSearchProvider.value).catch(() => {});
  }
  // Save Tavily key if provided
  const tavilyKey = (settingsTavilyKey?.value || "").trim();
  if (tavilyKey) {
    await window.aideagent.saveApiKey("tavily", tavilyKey);
  }
  // Sync to WeChat bot config so WeChat uses updated API
  window.aideagent.syncApiToWechat?.({ apiUrl, apiKey, model, apiFormat }).catch(() => {});
  updateConfigBanner();
  updateInfoBar();
  if (settingsStatus) {
    settingsStatus.textContent = t("api.saved", { name: preset?.name || provider || t("provider.custom") });
    settingsStatus.className = "settings-status success";
  }
  // Show connection status in sidebar
  const providerLabel = preset?.name || provider || apiUrl.replace(/https?:\/\//, "").split("/")[0];
  if (cwdDisplay) cwdDisplay.textContent = providerLabel;
  setTimeout(() => settingsStatus.className = "settings-status hidden", 3000);
}

/* ── Fetch Models ─────────────────────────────────────── */
async function fetchModels() {
  const btn = document.getElementById("settings-fetch-models-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add("fetching");
  btn.textContent = t("api.fetching");

  const settingsStatus = document.getElementById("settings-status");
  const rawUrl = (document.getElementById("settings-url")?.value || "").trim();
  const apiKey = (document.getElementById("settings-key")?.value || "").trim();

  // Derive base URL for models endpoint
  let baseUrl = rawUrl
    .replace(/\/chat\/completions$/, "")
    .replace(/\/v1\/chat\/completions$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "");

  if (!baseUrl) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fill_url");
      settingsStatus.className = "settings-status error";
    }
    btn.disabled = false;
    btn.classList.remove("fetching");
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> ' + t("api.fetch_models_btn");
    return;
  }

  // Try multiple endpoints, starting with /v1/models then /api/tags (Ollama)
  const endpoints = [
    baseUrl + "/v1/models",
    baseUrl + "/models",
    baseUrl + "/api/tags",
  ];

  let models = [];
  for (const url of endpoints) {
    try {
      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      // Try different response formats
      const list = data.data || data.models || [];
      if (Array.isArray(list) && list.length > 0) {
        models = list.map(m => ({
          id: m.id || m.name || "",
          label: m.id || m.name || "(unnamed)",
        })).filter(m => m.id);
        break;
      }
    } catch {}
  }

  if (models.length > 0) {
    // Populate the select with fetched models
    if (settingsModel) {
      settingsModel.style.display = "";
      settingsModel.innerHTML = "";
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.id;
        settingsModel.appendChild(opt);
      });
      // Add custom entry at bottom
      const customEntry = document.createElement("option");
      customEntry.value = "__custom__";
      customEntry.textContent = "✏️ 手动输入模型名称...";
      settingsModel.appendChild(customEntry);
      if (models.length > 0) settingsModel.value = models[0].id;
    }
    if (settingsModelInput) settingsModelInput.style.display = "none";
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fetch_success", { count: models.length });
      settingsStatus.className = "settings-status success";
    }
  } else {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fetch_empty");
      settingsStatus.className = "settings-status error";
    }
  }

  btn.disabled = false;
  btn.classList.remove("fetching");
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M21 3v5h-5"/></svg> ' + t("api.fetch_models_btn");
}

/* ── Query ────────────────────────────────────────────── */
// ── Message queue for multi-conversation ──────────────────
const _queryQueue = [];

async function submitQuery() {
  const text = promptInput.value.trim();
  const files = state.attachedFiles;
  if ((!text && files.length === 0)) return;
  if (state.isStreaming) {
    // Queue the message for later
    _queryQueue.push({ text, files: [...files] });
    promptInput.value = "";
    autoResize(promptInput);
    state.attachedFiles = [];
    renderFilePreviews();
    updateSendButton();
    setStatus(t("status.queued") || "已排队，等待当前对话完成...");
    return;
  }

  const cfg = loadApiConfig();
  if (!cfg.apiUrl) {
    addErrorMessage(t("api.config_first"));
    return;
  }

  // Fallback: use currently selected model in settings dropdown if not yet persisted
  if (!cfg.model) {
    const fallbackModel = getCurrentModelValue();
    if (fallbackModel) cfg.model = fallbackModel.trim();
  }

  // Clear input and files
  promptInput.value = "";
  autoResize(promptInput);
  state.attachedFiles = [];
  renderFilePreviews();
  updateSendButton();

  state.isStreaming = true;
  state.currentText = "";
  state._toolCallCount = 0;
  state._afterToolCall = false;
  state._reasoningBlockText = "";

  // Hide welcome, show messages
  const welcome = messageList.querySelector(".welcome");
  if (welcome) welcome.style.display = "none";

  // Add user message (show text + file attachments)
  let userHtml = text ? `<p>${sanitize(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p>` : "";
  if (files.length > 0) {
    const fileList = files.map(f => {
      const safeName = sanitize(f.name.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      if (f.type.startsWith("image/")) {
        // Build img via DOM API so data: URLs aren't stripped by DOMPurify
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin:4px 0";
        const img = document.createElement("img");
        img.src = f.dataUrl; // safe — from local FileReader
        img.alt = f.name;
        img.style.cssText = "max-width:200px;max-height:150px;border-radius:6px;object-fit:cover;border:1px solid var(--border)";
        wrap.appendChild(img);
        return wrap.outerHTML;
      }
      return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:var(--text-light);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${safeName}</div>`;
    }).join("");
    userHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:${text ? 4 : 0}px">${fileList}</div>`;
  }
  const userDiv = addUserMessage("");
  const bubble = userDiv.querySelector(".message-bubble") || userDiv;
  bubble.innerHTML = userHtml;

  // Create assistant message
  state.currentAssistantMsg = addAssistantMessage();
  updateAssistantContent(state.currentAssistantMsg, "");

  // Toggle buttons
  sendBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  setStatus(t("status.thinking"));

  // Build file attachments for the API
  const apiFiles = files.map(f => ({
    name: f.name,
    type: f.type,
    dataUrl: f.dataUrl,
  }));

  // Submit
  try {
    const enabledSkills = loadEnabledSkills();
    const reasoning = loadReasoningEnabled();
    const agentName = loadAgentName();
    const kbEnabled = document.getElementById("kb-toggle")?.checked || false;
    const webSearchEnabled = document.getElementById("web-search-toggle")?.checked ?? true;
    await window.aideagent.submitQuery(text, cfg.apiKey, cfg.apiUrl, cfg.model, cfg.apiFormat, apiFiles, enabledSkills, reasoning, agentName, kbEnabled, planModeCheckbox.checked, webSearchEnabled);
  } catch (err) {
    console.error("Query error:", err);
  }
}

function abortQuery() {
  window.aideagent.abortQuery();
  if (state.currentAssistantMsg) {
    finishAssistantMessage(state.currentAssistantMsg);
  }
  stopQuery();
}

function stopQuery() {
  state.isStreaming = false;
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  sendBtn.disabled = false;
  setStatus(t("status.ready"));
}

function processQueryQueue() {
  if (_queryQueue.length === 0) return;
  const next = _queryQueue.shift();
  // Restore queued files to state
  state.attachedFiles = next.files || [];
  // Set prompt and submit
  promptInput.value = next.text;
  submitQuery();
}

function resetChat() {
  if (state.isStreaming) {
    // Don't abort — hold streaming DOM, show welcome
    holdStreamingDom();
    state.isStreaming = false;
    // Reset backend session so next query starts fresh
    window.aideagent.resetSession();
    _loadedSessionId = null;
    state.currentAssistantMsg = null;
    _queryQueue.length = 0;
    showWelcome();
    state.attachedFiles = [];
    _taskCache.clear();
    _todoCache.length = 0;
    updateTaskIndicator(null, null, null, []);
    if (sessionDisplay) sessionDisplay.textContent = "—";
    renderFilePreviews();
    updateSendButton();
    promptInput.value = "";
    setStatus(t("status.ready"));
    refreshSessionList();
    requestAnimationFrame(() => promptInput.focus());
    return;
  }
  window.aideagent.resetSession();
  _queryQueue.length = 0;
  state.sessionId = null;
  state.isStreaming = false;
  state.currentText = "";
  state.currentReasoning = "";
  state._thinkBuffer = "";
  state.currentAssistantMsg = null;
  state._toolCallCount = 0;
  state._afterToolCall = false;
  state._reasoningBlockText = "";
  state.attachedFiles = [];
  _loadedSessionId = null;
  _taskCache.clear();
  _todoCache.length = 0;
  updateTaskIndicator(null, null, null, []);
  if (sessionDisplay) sessionDisplay.textContent = "—";
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  renderFilePreviews();
  updateSendButton();
  showWelcome();
  promptInput.value = "";
  setStatus(t("status.ready"));
  refreshSessionList();
  requestAnimationFrame(() => promptInput.focus());
}

/* ── Session List ──────────────────────────────────────────── */
let _loadedSessionId = null;

// ── Holding container for streaming DOM when switching sessions ────
let _streamingHolder = document.createElement("div");
_streamingHolder.style.display = "none";
document.body.appendChild(_streamingHolder);

function holdStreamingDom() {
  if (!state.currentAssistantMsg) return;
  while (messageList.firstChild) {
    _streamingHolder.appendChild(messageList.firstChild);
  }
}

function restoreHeldDom() {
  if (!_streamingHolder.firstChild) return false;
  messageList.innerHTML = "";
  while (_streamingHolder.firstChild) {
    messageList.appendChild(_streamingHolder.firstChild);
  }
  // Rebind state to restored DOM
  const msgs = messageList.querySelectorAll(".message");
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].classList.contains("assistant")) {
      state.currentAssistantMsg = msgs[i];
      break;
    }
  }
  state._toolCallCount = messageList.querySelectorAll(".tool-entry").length;
  return true;
}

function refreshSessionList() {
  window.aideagent.listSessions().then(sessions => {
    const container = document.getElementById("session-list");
    if (!container) return;
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="session-list-empty">' + t("sidebar.empty") + '</div>';
      return;
    }
    container.innerHTML = sessions.map(s => {
      const isStreaming = state.isStreaming && state.sessionId === s.id;
      const isActive = _loadedSessionId === s.id || isStreaming;
      const streamDot = isStreaming ? '<span class="streaming-dot"></span>' : '';
      return `
      <div class="session-item ${isActive ? "active" : ""}" data-session-id="${s.id}">
        <div class="session-item-title" title="${sanitize(s.title || t("sidebar.no_title"))}">${streamDot}${sanitize((s.title || t("sidebar.no_title")).slice(0, 28))}</div>
        <div class="session-item-actions">
          <button class="session-export" data-session-id="${s.id}" title="${t("sidebar.export")}">↓</button>
          <button class="session-delete" data-session-id="${s.id}" title="${t("sidebar.delete")}">×</button>
        </div>
      </div>
      `;
    }).join("");
  }).catch(() => {});
}

// Session search
document.getElementById("session-search-input")?.addEventListener("input", function () {
  const query = this.value.trim();
  if (!query) { refreshSessionList(); return; }
  window.aideagent.searchSessions(query, 30).then(results => {
    const container = document.getElementById("session-list");
    if (!container) return;
    if (!results?.length) {
      container.innerHTML = '<div class="session-list-empty">' + t("sidebar.no_match") + '</div>';
      return;
    }
    container.innerHTML = results.map(r => `
      <div class="session-item" data-session-id="${r.sessionId}">
        <div class="session-item-title">${sanitize(r.snippet || r.sessionTitle)}</div>
        <span style="font-size:10px;color:var(--text-muted)">${sanitize(r.sessionTitle || "")}</span>
      </div>
    `).join("");
  }).catch(() => {});
});

function loadChat(sessionId) {
  // If clicking on the same streaming session, just restore held DOM
  if (state.isStreaming && sessionId === state.sessionId) {
    restoreHeldDom();
    _loadedSessionId = sessionId;
    if (sessionDisplay) sessionDisplay.textContent = sessionId || "—";
    refreshSessionList();
    scrollToBottom();
    return;
  }

  // If streaming, hold current DOM before loading a different session
  if (state.isStreaming) {
    holdStreamingDom();
    // Load with readOnly to avoid overwriting backend state
    window.aideagent.loadSession(sessionId, { readOnly: true }).then(data => {
      if (!data) return;
      _loadedSessionId = data.sessionId;
      if (sessionDisplay) sessionDisplay.textContent = data.title || data.sessionId || "—";
      rebuildMessages(data);
      refreshSessionList();
      scrollToBottom();
    }).catch(e => console.error("[loadChat] loadSession error:", e));
    return;
  }

  window.aideagent.loadSession(sessionId).then(data => {
    if (!data) return;
    _loadedSessionId = data.sessionId;
    state.sessionId = data.sessionId;
    state.isStreaming = false;
    state.currentText = "";
    state.currentReasoning = "";
    state.currentAssistantMsg = null;
    state._toolCallCount = 0;
    state._afterToolCall = false;
    state._reasoningBlockText = "";
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    sendBtn.disabled = false;
    promptInput.value = "";
    setStatus(t("status.ready"));

    rebuildMessages(data);
    if (sessionDisplay) sessionDisplay.textContent = data.sessionId || "—";
    refreshSessionList();
  }).catch(() => {});
}

function rebuildMessages(data) {
  messageList.innerHTML = "";
  const hist = data.history || [];
  for (const m of hist) {
    if (m.role === "user") {
      const el = addUserMessage(m.content);
      if (m.id) el.dataset.msgId = m.id;
    } else if (m.role === "assistant") {
      const el = addAssistantMessage();
      if (m.id) el.dataset.msgId = m.id;
      state.currentAssistantMsg = el;
      requestAnimationFrame(() => {
        if (m.reasoning_content) {
          state.currentReasoning = m.reasoning_content;
          updateThinkingSection(el, m.reasoning_content);
        }
        updateAssistantContent(el, m.content || "");
        finishAssistantMessage(el);
      });
    }
  }
  state.currentAssistantMsg = null;
}

// Delegate click events on session-list (handles load, delete, export)
document.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest(".session-delete");
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.sessionId;
    if (id && await showConfirmDialog(t("sidebar.delete_confirm"))) {
      window.aideagent.deleteSession(id).then(() => {
        if (_loadedSessionId === id) _loadedSessionId = null;
        refreshSessionList();
      });
    }
    return;
  }

  const exportBtn = e.target.closest(".session-export");
  if (exportBtn) {
    e.stopPropagation();
    const id = exportBtn.dataset.sessionId;
    if (id) {
      window.aideagent.exportSessionMarkdown(id).then(data => {
        if (data?.markdown) {
          const blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `${data.title || "session"}.md`;
          a.click();
          URL.revokeObjectURL(url);
        }
      });
    }
    return;
  }

  const editBtn = e.target.closest(".msg-edit-btn");
  if (editBtn) {
    e.stopPropagation();
    const msgEl = editBtn.closest(".message");
    const textEl = editBtn.closest(".message-bubble")?.querySelector("p");
    if (!msgEl || !textEl) return;
    const oldText = textEl.textContent || "";
    const input = document.createElement("textarea");
    input.value = oldText;
    input.className = "msg-edit-input";
    input.style.width = "100%"; input.style.minHeight = "60px";
    textEl.replaceWith(input);
    editBtn.textContent = "✓";
    editBtn.classList.add("saving");
    editBtn.onclick = async () => {
      const newText = input.value.trim();
      if (!newText || newText === oldText) { undoEdit(); return; }
      const msgId = msgEl.dataset.msgId;
      if (msgId) {
        await window.aideagent.editMessage(parseInt(msgId), newText);
      }
      const p = document.createElement("p");
      p.textContent = newText;
      input.replaceWith(p);
      editBtn.textContent = "✎";
      editBtn.classList.remove("saving");
      editBtn.onclick = null;
    };
    function undoEdit() {
      const p = document.createElement("p");
      p.textContent = oldText;
      input.replaceWith(p);
      editBtn.textContent = "✎";
      editBtn.classList.remove("saving");
      editBtn.onclick = null;
    }
    return;
  }

  const item = e.target.closest(".session-item");
  if (item) {
    const id = item.dataset.sessionId;
    if (id) loadChat(id);
  }
});

/* ── Tool call display (collapsible inside assistant message) ─ */
function getOrCreateThinkingSection(msgEl) {
  const el = msgEl || state.currentAssistantMsg;
  if (!el) return null;
  let section = el.querySelector(".thinking-collapsible");
  if (!section) {
    const content = el.querySelector(".message-content");
    if (!content) return null;
    section = document.createElement("details");
    section.className = "thinking-collapsible";
    section.innerHTML = `<summary>${t("thinking.title")}</summary><div class="thinking-content"></div>`;
    content.insertBefore(section, content.firstChild);
  }
  return section;
}

function addToolCall(name, args) {
  state._toolCallCount++;
  state._afterToolCall = true;
  const section = getOrCreateThinkingSection();
  if (!section) return;

  const tc = section.querySelector(".thinking-content");
  const entry = document.createElement("div");
  entry.className = "tool-entry";
  entry.id = `tool-${state._toolCallCount}`;
  const argsStr = Object.entries(args || {})
    .map(([k, v]) => `<span class="tool-arg"><span class="tool-arg-key">${k}</span><span class="tool-arg-val">${sanitize(String(v).slice(0, 120))}</span></span>`)
    .join("");
  entry.innerHTML = `
    <div class="tool-entry-head">
      <span class="tool-entry-icon spinning"></span>
      <span class="tool-entry-name">${sanitize(name.toLowerCase())}</span>
      <span class="tool-entry-status">${t("mcp.running")}</span>
    </div>
    <div class="tool-entry-args">${argsStr || ""}</div>
    <div class="tool-entry-result"></div>
  `;
  tc.appendChild(entry);
  scrollToBottom();
  return entry;
}

function completeToolCall(name, result) {
  const el = document.getElementById(`tool-${state._toolCallCount}`);
  if (!el) return;
  const icon = el.querySelector(".tool-entry-icon");
  if (icon) {
    icon.classList.remove("spinning");
    icon.classList.add(result?.error ? "error" : "done");
  }
  const statusIcon = result?.error ? "❌" : "";
  el.querySelector(".tool-entry-status").textContent = `${statusIcon} ${t("thinking.done")}`;
  if (result?.error) {
    el.querySelector(".tool-entry-result").innerHTML = `<span style="color:var(--danger);">${sanitize(String(result.error).slice(0, 200))}</span>`;
  }
  el.classList.add("tool-done");
  scrollToBottom();
}

/* ── Task indicator ──────────────────────────────────── */
const _taskCache = new Map(); // taskId -> { subject, status }
const _todoCache = [];        // current todo list

function updateTaskIndicator(subject, taskId, newStatus, todos) {
  if (taskId && subject) _taskCache.set(taskId, { subject, status: "pending" });
  if (taskId && newStatus) {
    const cached = _taskCache.get(taskId);
    if (cached) cached.status = newStatus;
  }
  if (todos) { _todoCache.length = 0; _todoCache.push(...todos); }

  const active = Array.from(_taskCache.values()).filter(t => t.status !== "completed" && t.status !== "deleted");
  const todoActive = _todoCache.filter(t => t.status !== "completed");
  const total = active.length + todoActive.length;

  if (total === 0) {
    taskIndicator.classList.add("hidden");
    taskIndicator.classList.remove("has-active");
    taskIndicator.textContent = "";
  } else {
    taskIndicator.classList.remove("hidden");
    taskIndicator.classList.add("has-active");
    const parts = [];
    if (active.length > 0) parts.push(t("status.tasks", {count: active.length}));
    if (todoActive.length > 0) parts.push(t("status.todos", {count: todoActive.length}));
    taskIndicator.textContent = "📋 " + parts.join(" · ");
    taskIndicator.title = active.map(t => `${t.status === "in_progress" ? "🔄" : "⬜"} ${t.subject}`).join("\n");
  }
}

/* ── Ask Question dialog ────────────────────────────── */
let _askResolve = null;
const askModal = $("#ask-modal");
const askModalBody = $("#ask-modal-body");
const askSubmit = $("#ask-submit");

function showAskQuestion(data) {
  return new Promise(resolve => {
    _askResolve = resolve;
    const { questions } = data;
    askModalBody.innerHTML = questions.map((q, qi) => {
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const name = `ask_q_${qi}`;
      return `<div style="margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:6px;font-size:14px;">${q.header ? `<span style="background:var(--bg-tertiary);padding:1px 6px;border-radius:3px;font-size:12px;margin-right:6px;">${q.header.replace(/</g,'&lt;')}</span>` : ""}${q.question.replace(/</g,'&lt;')}</div>
        ${q.options.map((o, oi) => `<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;margin:4px 0;border-radius:6px;cursor:pointer;background:var(--bg-secondary);">
          <input type="${inputType}" name="${name}" value="${oi}" style="margin-top:2px;flex-shrink:0;" />
          <div><div style="font-size:13px;font-weight:500;">${o.label.replace(/</g,'&lt;')}</div><div style="font-size:12px;color:var(--text-muted);">${o.description.replace(/</g,'&lt;')}</div></div>
        </label>`).join("")}
      </div>`;
    }).join("");
    askSubmit.onclick = () => {
      const answers = {};
      questions.forEach((q, qi) => {
        const checked = askModalBody.querySelectorAll(`input[name="ask_q_${qi}"]:checked`);
        if (checked.length > 0) {
          answers[q.question] = Array.from(checked).map(c => q.options[parseInt(c.value)].label).join(",");
        }
      });
      askModal.classList.remove("active");
      _askResolve = null;
      resolve(answers);
    };
    askModal.classList.add("active");
  });
}

/* ── Permission dialog ───────────────────────────────── */
function showPermission(evt) {
  return new Promise((resolve) => {
    state._permResolve = resolve;
    permCommand.textContent = evt.command;
    permModal.classList.add("active");

    const cleanup = () => { permModal.classList.remove("active"); };
    permAllow.onclick = () => { cleanup(); resolve(true); };
    permDeny.onclick = () => { cleanup(); resolve(false); };
  });
}

// Render permission request from main process
window.aideagent.onPermissionRequest((data) => {
  if (state._permResolve) {
    // Already showing a permission dialog - auto-deny new one
    window.aideagent.respondPermission(data.id, false);
    return;
  }
  showPermission(data).then((allow) => {
    window.aideagent.respondPermission(data.id, allow);
    state._permResolve = null;
  });
});

// Render question from AskUserQuestion tool
window.aideagent.onAskQuestion((data) => {
  if (_askResolve) {
    // Already showing a question dialog — auto-close old one
    _askResolve({});
    _askResolve = null;
    askModal.classList.remove("active");
  }
  showAskQuestion(data).then((answers) => {
    window.aideagent.respondQuestion(data.id, answers);
  });
});

/* ── Safe event listener registration ──────────────── */
function onIpc(name, handler) {
  const fn = window.aideagent[name];
  if (typeof fn === "function") fn(handler);
  else console.warn("[app] AideAgent." + name + " not available");
}

/* ── IPC event handlers ──────────────────────────────── */
function setupIPC() {
  onIpc("onStreamStart", () => {
    state.currentText = "";
    state.currentReasoning = "";
    state._thinkBuffer = "";
    state._streamStartTime = Date.now();
    state._streamCharCount = 0;
    state._cacheMetrics = null;
  });

  onIpc("onStreamMetrics", (data) => {
    state._cacheMetrics = data;
  });

  onIpc("onStreamChunk", (data) => {
    if (!state.currentAssistantMsg) return;

    if (!state.isStreaming) {
      state.isStreaming = true;
    }

    if (data.text) {
      state.currentText += data.text;
      state._streamCharCount += data.text.length;

      // Batch render: update at most every ~50ms
      if (!state._renderTimer) {
        state._renderTimer = setTimeout(() => {
          updateAssistantContent(state.currentAssistantMsg, state.currentText);
          state._renderTimer = null;
          scrollToBottom();
        }, 50);
      }
    }

    if (data.done) {
      if (state._renderTimer) {
        clearTimeout(state._renderTimer);
        state._renderTimer = null;
      }
      if (data.is_result && data.text) {
        state.currentText = data.text;
      }
      updateAssistantContent(state.currentAssistantMsg, state.currentText);
      finishAssistantMessage(state.currentAssistantMsg);
      stopQuery();
    }
  });

  onIpc("onStreamReasoning", (data) => {
    if (!state.currentAssistantMsg) return;
    state.currentReasoning += data.text;
    const section = getOrCreateThinkingSection();
    if (!section) return;
    if (!section.hasAttribute("open")) section.setAttribute("open", "");
    const tc = section.querySelector(".thinking-content");

    // After a tool call, start a new reasoning block
    if (state._afterToolCall) {
      state._afterToolCall = false;
      state._reasoningBlockText = "";
    }

    state._reasoningBlockText += data.text;

    // Find or create the last reasoning div in thinking-content
    let reasoningEl = null;
    const children = tc.children;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].classList.contains("thinking-reasoning")) {
        reasoningEl = children[i];
        break;
      }
    }
    // If no reasoning div exists, or the last child is a tool-entry, create new
    if (!reasoningEl || (tc.lastElementChild && tc.lastElementChild.classList.contains("tool-entry"))) {
      reasoningEl = document.createElement("div");
      reasoningEl.className = "thinking-reasoning";
      tc.appendChild(reasoningEl);
    }
    reasoningEl.textContent = state._reasoningBlockText;
    scrollToBottom();
  });

  onIpc("onStreamDone", () => {
    if (state.currentAssistantMsg) {
      if (state.currentText) {
        updateAssistantContent(state.currentAssistantMsg, state.currentText);
      }
      finishAssistantMessage(state.currentAssistantMsg);
    }
    stopQuery();
    refreshSessionList();
    // Process queued queries
    processQueryQueue();
  });

  onIpc("onStreamError", (data) => {
    if (state.currentAssistantMsg) {
      finishAssistantMessage(state.currentAssistantMsg);
    }
    stopQuery();
    refreshSessionList();
    addErrorMessage(data.message || t("misc.unknown_error"));
  });

  window.aideagent.onToolStart((data) => {
    addToolCall(data.name, data.args);
  });

  window.aideagent.onToolResult((data) => {
    completeToolCall(data.name, data.result);
    // Update task indicator for task management tools
    if (data.name === "TaskCreate" && data.result?.task) {
      updateTaskIndicator(data.result.task.subject, data.result.task.id, "pending");
    } else if (data.name === "TaskUpdate" && data.result?.success) {
      updateTaskIndicator(null, data.result.taskId, data.result.updatedFields?.includes("status") ? data.result.statusChange?.to : null);
    } else if (data.name === "TodoWrite" && data.result?.newTodos) {
      updateTaskIndicator(null, null, null, data.result.newTodos);
    }
  });

  // Sub-agent progress: show turn status in thinking section
  try {
    window.aideagent.onSubagentProgress?.((data) => {
      if (data.done) return;
      // Find the running Agent tool entry and update its status
      const thinkingContent = state.currentAssistantMsg?.querySelector?.(".thinking-content");
      if (!thinkingContent) return;
      const entries = thinkingContent.querySelectorAll(".tool-entry");
      for (const entry of entries) {
        const nameEl = entry.querySelector(".tool-entry-name");
        if (nameEl && nameEl.textContent.includes("agent") && entry.querySelector(".tool-entry-status")?.textContent?.includes("running")) {
          const statusEl = entry.querySelector(".tool-entry-status");
          if (statusEl && data.description) {
            statusEl.textContent = `${data.description} (turn ${data.turn + 1})`;
          }
          break;
        }
      }
    });
  } catch (e) { /* preload may not be updated yet */ }

  try {
    window.aideagent.onTaskClear?.(() => {
      _taskCache.clear();
      _todoCache.length = 0;
      updateTaskIndicator(null, null, null, []);
    });
  } catch (e) { /* preload may not be updated yet */ }

  window.aideagent.onSessionUpdate((data) => {
    state.sessionId = data.sessionId;
    if (sessionDisplay) {
  if (sessionDisplay) sessionDisplay.textContent = data.sessionId || "—";
    }
    // If this is a new session (not from loadChat), reset loaded flag
    if (data.sessionId && _loadedSessionId && _loadedSessionId !== data.sessionId) {
      _loadedSessionId = data.sessionId;
    }
    // Refresh session list when a new session is created
    refreshSessionList();
  });

  window.aideagent.onL0Budget((data) => {
    const el = document.getElementById("token-budget");
    if (!el) return;
    el.classList.remove("hidden");
    if (data.overHard) {
      el.textContent = `⚠️ ${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget danger";
      el.title = t("budget.over_hard", {limit: data.hardThreshold.toLocaleString()});
    } else if (data.overWarn) {
      el.textContent = `⚡ ${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget warn";
      el.title = t("budget.near_limit", {limit: data.hardThreshold.toLocaleString()});
    } else {
      // Only show when above 4000, otherwise hide
      if (data.estimatedTokens < 4000) {
        el.classList.add("hidden");
        el.textContent = "";
        return;
      }
      el.textContent = `${data.estimatedTokens.toLocaleString()} tokens`;
      el.className = "token-budget ok";
      el.title = t("budget.tooltip");
    }
  });

  // Context usage indicator
  try {
    window.aideagent.onContextUsage?.((data) => {
      const el = document.getElementById("context-usage");
      if (!el) return;
      el.classList.remove("hidden", "ok", "warn", "danger");
      if (data.usagePct >= 90) {
        el.textContent = '⚠️ ' + t("context.label", {pct: data.usagePct});
        el.classList.add("danger");
      } else if (data.usagePct >= 80) {
        el.textContent = '⚡ ' + t("context.label", {pct: data.usagePct});
        el.classList.add("warn");
      } else if (data.totalTokens > 5000) {
        el.textContent = t("context.label", {pct: data.usagePct});
        el.classList.add("ok");
      } else {
        el.classList.add("hidden");
      }
      el.title = `${data.totalTokens.toLocaleString()} / ${data.windowSize.toLocaleString()} tokens`;
    });
  } catch (e) { /* preload may not be updated yet */ }
}

/* ── Avatar ──────────────────────────────────────────── */

// Default avatar data URL (embedded, handles WebP-as-JPG files safely)
const DEFAULT_AVATAR = "avatar.jpg";

// Load saved avatar from localStorage, or use default.
// Re-query welcomeAvatar each time since showWelcome() destroys the old element.
function loadAvatar() {
  const saved = localStorage.getItem(AVATAR_KEY);
  const src = saved || DEFAULT_AVATAR;
  const imgs = [sidebarAvatar, settingsPreview, document.getElementById("welcome-avatar")].filter(Boolean);
  imgs.forEach((img) => { img.src = src; });
  // Update avatars in existing assistant messages too
  document.querySelectorAll(".msg-avatar").forEach((img) => { img.src = src; });
}

function saveAvatar(src) {
  try {
    localStorage.setItem(AVATAR_KEY, src);
    loadAvatar();
  } catch (e) {
    console.error("[avatar] save failed:", e.message);
    showToast(t("avatar.save_fail"), "error");
  }
}

function showToast(msg, type) {
  const existing = document.querySelector(".avatar-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `avatar-toast ${type || "info"}`;
  toast.textContent = msg;
  toast.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;animation:fadeIn 0.3s;transition:opacity 0.3s";
  if (type === "error") toast.style.background = "rgba(208,49,45,0.9)";
  else toast.style.background = "rgba(46,160,67,0.9)";
  toast.style.color = "#fff";
  toast.style.backdropFilter = "blur(8px)";
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 3000);
}

function resetAvatar() {
  localStorage.removeItem(AVATAR_KEY);
  loadAvatar();
}

/* ── Custom Confirm Dialog (avoid native confirm() focus bug in Electron) ── */
function showConfirmDialog(msg) {
  return new Promise(resolve => {
    const modal = document.getElementById("confirm-modal");
    const message = document.getElementById("confirm-modal-message");
    const okBtn = document.getElementById("confirm-modal-ok");
    const cancelBtn = document.getElementById("confirm-modal-cancel");
    if (!modal || !message || !okBtn || !cancelBtn) { resolve(true); return; }
    message.textContent = msg;
    modal.classList.add("active");
    const cleanup = () => {
      modal.classList.remove("active");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    // Click outside to cancel
    modal.addEventListener("click", function onClickOut(e) {
      if (e.target === modal) { cleanup(); modal.removeEventListener("click", onClickOut); resolve(false); }
    });
  });
}

// Detect image format from magic bytes (not file extension)
function detectMimeFromHeader(header) {
  const bytes = new Uint8Array(header);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
  // WebP: RIFF + 4 bytes + WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

// File input → detect real format → compress → save
avatarFileInput.addEventListener("change", async () => {
  const file = avatarFileInput.files?.[0];
  if (!file) return;

  // Reject non-images at the MIME level
  if (!file.type.startsWith("image/")) {
    showToast(t("avatar.select_file"), "error");
    avatarFileInput.value = "";
    return;
  }

  // Detect real format from magic bytes (handles .jpg-is-actually-WebP files)
  let realType;
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    realType = detectMimeFromHeader(header);
  } catch (e) {
    realType = file.type; // fallback to browser-reported type
  }
  // If we can't determine the format, use the browser-reported type
  const mimeType = realType || file.type;

  const MAX_PX = 200;
  const correctedBlob = new Blob([file], { type: mimeType });
  const blobUrl = URL.createObjectURL(correctedBlob);
  const img = new Image();

  img.onload = () => {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_PX || h > MAX_PX) {
      const scale = MAX_PX / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL("image/jpeg", 0.85);
    URL.revokeObjectURL(blobUrl);
    saveAvatar(compressed);
  };

  img.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    console.error("[avatar] failed to decode:", file.name, "detected:", mimeType, "browser said:", file.type);
    showToast(t("avatar.decode_fail"), "error");
  };

  img.src = blobUrl;
  avatarFileInput.value = "";
});

changeAvatarBtn.addEventListener("click", () => {
  avatarFileInput.click();
});

resetAvatarBtn.addEventListener("click", resetAvatar);

/* ── Agent Name + User Name + User Avatar (imported from modules/agent-name.mjs) ── */

/* ── Font Settings (imported from modules/font-settings.mjs) ── */

/* ── Skills (imported from modules/skills-panel.mjs) ── */

/* ── MCP Servers (extracted to modules/mcp.mjs, Step 6) ── */

// MCP panel initialized by modules/mcp.mjs (Step 6). All event
// listeners, loadMcpServers, loadMcpBuiltins, showMcpStatus, and
// detectLocalMcp live in that module. The factory closure reads t,
// getLang, sanitize, and showConfirmDialog from app.js globals.
const mcpPanel = createMcpPanel({
  t,
  getLang,
  sanitize,
  onConfirm: showConfirmDialog,
});
mcpPanel.init();

/* ── WeChat iLink QR Login + Bot ──────────────────────────── */
// Extracted to modules/wechat.mjs (Step 8). Factory wires t and
// loadApiConfig from app.js globals; everything else (login, logout,
// QR overlay, polling, event listeners, self-init) lives in the module.
const wechatPanel = createWechatPanel({
  t,
  loadApiConfig,
});
/* ── System Prompt Profile Management ─────────────────── */
// Extracted to modules/prompt-store.mjs (Step 3d).
// All prompt profile state (promptStore, currentProfileId, _promptDirty) is
// encapsulated in the module's closure. Exposes 4 functions: loadPromptStore,
// renderProfileSelector, renderPromptEditor, addNewProfile.
// 已提取到 modules/prompt-store.mjs（Step 3d）。所有 prompt 状态封装在闭包内。
const promptStoreCtl = createPromptStore({
  t,
  onConfirm: showConfirmDialog,
});
const loadPromptStore = promptStoreCtl.loadPromptStore;
const renderProfileSelector = promptStoreCtl.renderProfileSelector;
const renderPromptEditor = promptStoreCtl.renderPromptEditor;
const addNewProfile = promptStoreCtl.addNewProfile;

// ── Prompt event bindings ──

document.getElementById("prompt-add-profile-btn")?.addEventListener("click", addNewProfile);

// Load prompt profiles when the prompt tab is opened
document.querySelector('.settings-tab[data-tab="prompt"]')?.addEventListener("click", async () => {
  const container = document.getElementById("prompt-sections");
  if (!container || container.children.length === 0) {
    await loadPromptStore();
    renderProfileSelector();
    renderPromptEditor();
  }
});

/* ── Settings tab switching ──────────────────────────── */
// Extracted to modules/settings-tabs.mjs. Click listeners are now bound by
// initSettingsTabs() during init (see bottom of file).
// 已提取到 modules/settings-tabs.mjs。点击监听器由 initSettingsTabs() 初始化。

/* ── Settings modal ─────────────────────────────────── */
settingsCloseBtn.addEventListener("click", () => {
  settingsModal.classList.remove("active");
});

// Close on overlay click
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove("active");
});

/* ── Event Listeners ──────────────────────────────────── */

// Provider dropdown change — auto-fill URL + model (skip during programmatic fill)
let _fillingForm = false;
settingsProvider?.addEventListener("change", () => { if (!_fillingForm) onProviderChange(); });

// Fetch models button
document.getElementById("settings-fetch-models-btn")?.addEventListener("click", fetchModels);

// Settings save
settingsSaveBtn?.addEventListener("click", saveSettingsForm);
settingsSearchProvider?.addEventListener("change", () => {
  if (tavilyKeyRow) tavilyKeyRow.style.display = settingsSearchProvider.value === "tavily" ? "block" : "none";
});

// Delete all sessions
const deleteAllBtn = $("#delete-all-sessions-btn");
deleteAllBtn?.addEventListener("click", async () => {
  if (!await showConfirmDialog(t("sidebar.clear_confirm"))) return;
  try {
    const result = await window.aideagent.deleteAllSessions();
    if (result && result.error) {
      showToast(t("sidebar.delete_fail", {error: result.error}));
      return;
    }
    state.sessionId = null;
    _loadedSessionId = null;
    messageList.innerHTML = "";
    showWelcome();
    refreshSessionList();
    showToast(t("sidebar.clear_done", { count: result?.deleted || 0 }));
  } catch (e) {
    console.error("deleteAllSessions error:", e);
    showToast(t("sidebar.delete_fail", {error: e.message}));
  }
});

// Settings modal: fill form when opened
settingsBtn?.addEventListener("click", () => {
  fillSettingsForm();
  settingsPreview.src = sidebarAvatar.src;
  settingsStatus.className = "settings-status hidden";
  switchSettingsTab("api"); // Always open to API config first
  settingsModal.classList.add("active");
});

// Banner settings button
bannerSettingsBtn?.addEventListener("click", () => {
  settingsBtn.click();
});

// Prompt input
promptInput.addEventListener("input", () => {
  autoResize(promptInput);
  updateSendButton();
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) submitQuery();
  }
});

sendBtn.addEventListener("click", submitQuery);
stopBtn.addEventListener("click", abortQuery);
newChatBtn.addEventListener("click", resetChat);

// Auto-focus input when window regains focus (fixes Electron focus loss after confirm() / alt-tab)
window.addEventListener("focus", () => {
  if (!state.isStreaming && !settingsModal.classList.contains("active")) {
    requestAnimationFrame(() => promptInput.focus());
  }
});

/* ── Init ──────────────────────────────────────────────── */
initSettingsTabs();
filePreviews.init();
setupIPC();
loadAvatar();
initAgentNameUI();
applyAgentName(loadAgentName());
initUserAvatarUI();
applyUserName(loadUserName());
updateConfigBanner();

// Load encrypted API keys then apply config
initApiKeys().then(() => {
  const cfg = loadApiConfig();
// Auto-sync to WeChat bot on startup
if (cfg.apiUrl && cfg.apiKey) {
  window.aideagent.syncApiToWechat?.({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, model: cfg.model, apiFormat: cfg.apiFormat || "openai" }).catch(() => {});
}
if (cfg.provider) {
  if (cwdDisplay) cwdDisplay.textContent = cfg.provider;
} else if (cfg.apiUrl) {
  if (cwdDisplay) cwdDisplay.textContent = cfg.apiUrl.replace(/https?:\/\//, "").split("/")[0];
} else {
  if (cwdDisplay) cwdDisplay.textContent = t("misc.unconfigured");
}
updateInfoBar();
if (hasApiConfig()) {
  promptInput.focus();
}

// Load saved session list
refreshSessionList();
}); // end initApiKeys().then()

/* ── Memory Panel (imported from modules/memory-panel.mjs) ── */

/* ── Skills Panel (imported from modules/skills-panel.mjs) ── */

/* ── Workspace (imported from modules/workspace.mjs) ── */

/* ── Knowledge Base (imported from modules/knowledge-base.mjs) ── */
initKnowledgeBase();
initMemoryPanel();

/* ── About / Update Panel ─────────────────────────── */
(function initAboutPanel() {
  const AUTO_UPDATE_KEY = "AideAgent_auto_update";

  const checkBtn = document.getElementById("update-check-btn");
  const autoCheckbox = document.getElementById("auto-update-checkbox");
  const statusEl = document.getElementById("update-status");
  const progressContainer = document.getElementById("update-progress-container");
  const progressBar = document.getElementById("update-progress-bar");
  const progressText = document.getElementById("update-progress-text");
  const progressPercent = document.getElementById("update-progress-percent");
  const installBtn = document.getElementById("update-install-btn");
  const changelogEl = document.getElementById("changelog-content");
  const versionEl = document.getElementById("about-version");

  // Load current version + changelog from GitHub
  window.aideagent.updateCheckVersion().then(v => {
    const ver = v || "1.0.1";
    if (versionEl) versionEl.textContent = t("about.version", { version: ver });
    // Fetch current version's release notes from GitHub
    fetch("https://api.github.com/repos/quanzefeng/AideAgent/releases/latest")
      .then(r => r.ok ? r.json() : null)
      .then(release => {
        if (release && release.body && changelogEl) {
          changelogEl.innerHTML = marked.parse(release.body);
        }
      })
      .catch(() => { /* silent fallback — keep default HTML */ });
  }).catch(() => {});

  // Load auto-check preference
  const autoEnabled = localStorage.getItem(AUTO_UPDATE_KEY) === "true";
  if (autoCheckbox) autoCheckbox.checked = autoEnabled;

  autoCheckbox?.addEventListener("change", () => {
    localStorage.setItem(AUTO_UPDATE_KEY, autoCheckbox.checked);
  });

  // Manual check button
  checkBtn?.addEventListener("click", async () => {
    checkBtn.disabled = true;
    statusEl.textContent = t("about.checking");
    statusEl.style.color = "var(--text-light)";
    try {
      await window.aideagent.updateCheckForUpdates();
    } catch (e) {
      statusEl.textContent = t("about.check_failed", { error: e.message });
      statusEl.style.color = "var(--danger)";
    }
    checkBtn.disabled = false;
  });

  // Install button
  installBtn?.addEventListener("click", () => {
    window.aideagent.updateInstall();
  });

  // Listen for status updates from main process
  window.aideagent.onUpdateStatus?.((data) => {
    switch (data.status) {
      case "checking":
        statusEl.textContent = t("about.checking");
        statusEl.style.color = "var(--text-light)";
        progressContainer?.classList.add("hidden");
        installBtn?.classList.add("hidden");
        break;
      case "available":
        statusEl.textContent = t("about.new_version", { version: data.version });
        statusEl.style.color = "var(--primary)";
        progressContainer?.classList.remove("hidden");
        installBtn?.classList.add("hidden");
        if (data.releaseNotes && changelogEl) {
          changelogEl.innerHTML = marked.parse(data.releaseNotes);
        }
        break;
      case "not-available":
        statusEl.textContent = t("about.status_idle");
        statusEl.style.color = "var(--text-light)";
        progressContainer?.classList.add("hidden");
        installBtn?.classList.add("hidden");
        break;
      case "downloaded":
        statusEl.textContent = t("about.downloaded", { version: data.version });
        statusEl.style.color = "#22c55e";
        // Show 100% on progress bar, keep it visible, and show install button
        if (progressBar) progressBar.style.width = "100%";
        if (progressPercent) progressPercent.textContent = "100%";
        installBtn?.classList.remove("hidden");
        break;
      case "error":
        statusEl.textContent = t("about.check_failed", { error: data.message });
        statusEl.style.color = "var(--danger)";
        progressContainer?.classList.add("hidden");
        installBtn?.classList.add("hidden");
        break;
    }
  });

  // Listen for download progress
  window.aideagent.onUpdateProgress?.((data) => {
    if (progressBar) progressBar.style.width = Math.round(data.percent) + "%";
    if (progressPercent) progressPercent.textContent = Math.round(data.percent) + "%";
  });

  // Auto-check on startup if enabled
  if (autoEnabled) {
    setTimeout(() => {
      window.aideagent.updateCheckForUpdates().catch(() => {});
    }, 3000);
  }
})();

/* ── Language Switching ─────────────────────────────── */
(function initLanguage() {
  const langSelect = document.getElementById("lang-select");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", () => {
      setLang(langSelect.value);
      applyLang();
      // Re-render dynamic elements
      applyAgentName(loadAgentName());
      applyUserName(loadUserName());
      refreshSessionList();
      // Update welcome description
      const welcomeDesc = document.querySelector(".welcome .description");
      if (welcomeDesc) welcomeDesc.textContent = t("chat.welcome_desc", { name: loadAgentName() });
      // Update input placeholder
      const input = document.getElementById("prompt-input");
      if (input) input.placeholder = t("chat.input_placeholder", { name: loadAgentName() });
      // Re-render prompt profiles & editor (dynamically generated, not covered by applyLang)
      renderProfileSelector();
      renderPromptEditor();
      // Update KB clear status if visible
      const kbSt = document.getElementById("kb-status");
      if (kbSt && kbSt.textContent.match(/^(未配置|Not configured)$/)) kbSt.textContent = t("kb.unconfigured");
      // Update workspace
      updateWorkspaceDisplay();
    });
  }
  // Apply saved language on load
  if (typeof applyLang === "function") applyLang();
})();
