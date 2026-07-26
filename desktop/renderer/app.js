// @ts-nocheck — this 2872-line monolith will be split into focused modules
// in the refactor step. Adding JSDoc here would be wasted effort.
// @ts-nocheck — 这个 2872 行的单片文件会在重构步骤拆分为聚焦模块。
//              在这里加 JSDoc 是浪费工作。
/* ── Import modules ───────────────────────────────────── */
import './modules/font-settings.mjs';
import './modules/bg-settings.mjs';
import './modules/workspace.mjs';
import { initKnowledgeBase, loadKnowledgeBasePanel } from './modules/knowledge-base.mjs';
import { initMemoryPanel } from './modules/memory-panel.mjs';
import { initPromptsPanel } from './modules/prompts-settings.mjs';
import { openPromptsImportModal } from './modules/prompts-modal.mjs';
import { loadAgentName, loadUserName, applyAgentName, applyUserName, initAgentNameUI, initUserAvatarUI, loadUserAvatarSrc } from './modules/agent-name.mjs';
import { sanitize, renderMarkdown, renderLatexInElement, autoResize, formatFileSize, scrollToBottom, setStatus, loadReasoningEnabled, saveReasoningEnabled } from './modules/helpers.mjs';
import { loadEnabledSkills, loadAndRenderSkills } from './modules/skills-panel.mjs';
import { switchSettingsTab, initSettingsTabs } from './modules/settings-tabs.mjs';
import { createFilePreviews } from './modules/file-previews.mjs';
import { initUpdateToast, getSkippedVersion, setSkippedVersion } from './modules/update-toast.mjs';
import { createPromptStore } from './modules/prompt-store.mjs';
import { createMcpPanel } from './modules/mcp.mjs';
import { createWechatPanel } from './modules/wechat.mjs';
import { initRuntimeSelector, rebindRuntimeCards, getCurrentRuntime, setRuntime } from './modules/runtime-selector.mjs';
import { installLocalStorageHook, pushSessionInfo } from './modules/session-info.mjs';

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

// Provider presets store i18n KEYS in `name` rather than translated strings,
// so the labels can be re-translated when the user switches languages. The
// sole consumer (`updateInfoBar` / settings panel) calls `t(preset.name)` at
// read time. Model labels in `models[].label` follow the same convention.
const PROVIDER_PRESETS = {
  "":        { name: "provider.custom",     url: "",                              model: "",                                   models: [], format: "openai" },
  deepseek:  { name: "provider.deepseek",   url: "https://api.deepseek.com",      model: "deepseek-v4-flash",                  models: [{id:"deepseek-v4-flash",label:"model.deepseek_v4_flash"},{id:"deepseek-v4-pro",label:"model.deepseek_v4_pro"}], format: "openai" },
  glm:       { name: "provider.glm",        url: "https://open.bigmodel.cn/api/paas/v4", model: "GLM-4.7-Flash",                  models: [{id:"GLM-4.7-Flash",label:"model.glm_4_7_flash"},{id:"GLM-4-Plus",label:"model.glm_4_plus"},{id:"GLM-4-Air",label:"model.glm_4_air"}], format: "openai" },
  qwen:      { name: "provider.qwen",       url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",          models: [{id:"qwen3.7-max",label:"model.qwen3_7_max"},{id:"qwen-plus",label:"model.qwen_plus"},{id:"qwen-turbo",label:"model.qwen_turbo"}], format: "openai" },
  llamacpp:  { name: "provider.llamacpp",   url: "http://127.0.0.1:8080/v1",       model: "",                                   models: [], format: "openai" },
  minimax:   { name: "provider.minimax",    url: "https://api.minimaxi.com/anthropic",  model: "MiniMax-M2.7",                       models: [{id:"MiniMax-M2.7",label:"model.minimax_m2_7"},{id:"MiniMax-M2.7-highspeed",label:"model.minimax_m2_7_highspeed"}], format: "anthropic" },
  claude:    { name: "provider.claude",      url: "https://api.anthropic.com",     model: "claude-sonnet-4-20250514",            models: [{id:"claude-sonnet-4-20250514",label:"model.claude_sonnet_4"},{id:"claude-opus-4-20250514",label:"model.claude_opus_4"},{id:"claude-haiku-4.5-20250514",label:"model.claude_haiku_4_5"}], format: "anthropic" },
  "opencode-go":     { name: "provider.opencode_go",     url: "https://opencode.ai/zen/go/v1", model: "glm-5.1",       models: [{id:"glm-5.1",label:"model.glm_5_1"},{id:"glm-5.2",label:"model.glm_5_2"},{id:"kimi-k2.6",label:"model.kimi_k2_6"},{id:"kimi-k2.7",label:"model.kimi_k2_7"},{id:"deepseek-v4-pro",label:"model.deepseek_v4_pro"},{id:"deepseek-v4-flash",label:"model.deepseek_v4_flash"},{id:"mimo-v2.5",label:"model.mimo_v2_5"},{id:"mimo-v2.5-pro",label:"model.mimo_v2_5_pro"}], format: "openai" },
  "opencode-go-ant": { name: "provider.opencode_go_ant", url: "https://opencode.ai/zen/go/v1", model: "minimax-m2.7",  models: [{id:"minimax-m2.5",label:"model.minimax_m2_5"},{id:"minimax-m2.7",label:"model.minimax_m2_7"},{id:"minimax-m3",label:"model.minimax_m3"},{id:"qwen3.6-plus",label:"model.qwen3_6_plus"},{id:"qwen3.7-plus",label:"model.qwen3_7_plus"},{id:"qwen3.7-max",label:"model.qwen3_7_max"}], format: "anthropic" },
  lmstudio:  { name: "provider.lmstudio",   url: "http://localhost:1234/v1",      model: "",                                   models: [], format: "openai" },
  ollama:    { name: "provider.ollama",      url: "http://localhost:11434/v1",     model: "",                                   models: [], format: "openai" },
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
// OpenCode uses a 3-mode dropdown (default / build / plan) instead of a
// single plan-mode toggle. The active mode is stored in `ocMode`.
const opencodeModeButton = $("#opencode-mode-button");
const opencodeModeMenu = $("#opencode-mode-menu");
const opencodeModeLabel = $("#opencode-mode-label");
// Persist the OpenCode mode across sessions so the user doesn't have to
// re-pick "计划模式" every time they restart the app. localStorage key
// follows the existing `AideAgent_*` convention.
const OC_MODE_KEY = "AideAgent_oc_mode";
// OpenCode model picker — sibling of the mode selector. The DOM refs are
// queried at module init (the picker is inside #info-bar-opencode, which
// only mounts on welcome screen). State lives in `ocAvailableModels` /
// `ocModelId` and is persisted to `OC_MODEL_KEY` so the choice survives
// restart. Populated when the ACP `ready` event delivers the model list.
const opencodeModelButton = $("#opencode-model-button");
const opencodeModelMenu = $("#opencode-model-menu");
const opencodeModelName = $("#opencode-model-name");
/** @type {Array<{id:string,name:string}>} */
let ocAvailableModels = [];
const ocAvailableModelIds = new Set();
let ocModelId = (() => {
  try { return localStorage.getItem("AideAgent_opencodeModel") || null; }
  catch { return null; }
})();
const OC_MODEL_KEY = "AideAgent_opencodeModel";
let ocMode = (() => {
  const saved = (() => { try { return localStorage.getItem(OC_MODE_KEY); } catch { return null; } })();
  return saved === "default" || saved === "build" || saved === "plan" ? saved : "build";
})();
const sessionDisplay = $("#session-display");
const cwdDisplay = $("#cwd-display");

// Active input elements for the current runtime. When runtime = opencode,
// the bottom input box is #input-wrapper-opencode and its textarea/buttons
// have separate ids. These getters route submit/stop/key handling to whichever
// box is visible so the rest of submitQuery can stay runtime-agnostic.
const ocPromptInput = () => /** @type {HTMLTextAreaElement|null} */ (document.getElementById("prompt-input-opencode"));
const ocSendBtn = () => document.getElementById("send-btn-opencode");
const ocStopBtn = () => document.getElementById("stop-btn-opencode");
/** @returns {HTMLTextAreaElement} */
function activePromptInput() {
  return getCurrentRuntime() === "opencode" ? (ocPromptInput() || promptInput) : promptInput;
}
function activeSendBtn() {
  return getCurrentRuntime() === "opencode" ? (ocSendBtn() || sendBtn) : sendBtn;
}
function activeStopBtn() {
  return getCurrentRuntime() === "opencode" ? (ocStopBtn() || stopBtn) : stopBtn;
}
/**
 * Whether the currently-visible runtime is in plan mode.
 * - AideAgent: read from its dedicated #plan-mode-checkbox.
 * - OpenCode: read from `ocMode` (the dropdown selection).
 */
function activePlanModeEnabled() {
  if (getCurrentRuntime() === "opencode") return ocMode === "plan";
  return planModeCheckbox?.checked ?? false;
}
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
const settingsContextWindow = $("#settings-context-window");
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
// OpenCode-mode equivalents (mirror the aide DOM structure so the same
// file-previews UI can be reused by both runtimes). The state and
// #file-preview-area are SHARED — the user sees the same chip list
// regardless of which input box is active.
const ocUploadBtn = $("#upload-btn-opencode");
const ocFileInput = $("#file-input-opencode");
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
const aideUpdateSendButton = filePreviews.updateSendButton;
const handleFileUpload = filePreviews.handleFileUpload;
// Composite: re-evaluates BOTH the aide and OpenCode send buttons in one
// call. Kept under the legacy name `updateSendButton` so the existing
// callsites don't need to be touched, and so that mutations to
// `state.attachedFiles` always keep both runtimes' UI in sync.
const updateSendButton = () => {
  aideUpdateSendButton();
  if (typeof ocUpdateSendButton === "function") ocUpdateSendButton();
};

// OpenCode-mode file previews: second instance sharing `state` and the
// shared #file-preview-area. Renders the same chips; gates the OpenCode
// send button via its own updateSendButton closure (since the send button
// is a different DOM element). Init() below wires #file-input-opencode
// to the file picker.
const ocFilePreviews = createFilePreviews({
  state,
  filePreviewArea,
  fileInput: ocFileInput,
  uploadBtn: ocUploadBtn,
  sendBtn: ocSendBtn(),
  promptInput: ocPromptInput() || promptInput,
  MAX_FILE_SIZE,
  onError: (msg) => addErrorMessage(t(msg)),
  formatFileSize,
});
const ocUpdateSendButton = ocFilePreviews.updateSendButton;
const ocHandleFileUpload = ocFilePreviews.handleFileUpload;


/* ── Input menu popover ──────────────────────────────────
   Replaces the upload button's direct → file picker click with a 3-option
   menu: 上传文件 / 常用提示词 / 技能. Each item routes through
   handleInputMenuAction(action), which closes the popover first, then
   dispatches to the right handler:
     upload  → fileInput.click()                (file picker)
     prompts → openPromptsImportModal()          (prompt library modal)
     skills  → settings + skills tab + render    (skills catalog)

   IMPORTANT: the popover itself is absolutely positioned (CSS), so this
   code only needs to toggle a `hidden` class on #input-menu. It must NOT
   touch #input-wrapper or #prompt-input — that is what caused the
   previous prompts-feature regression. */
const inputMenu = $("#input-menu");
const inputMenuItems = inputMenu ? inputMenu.querySelectorAll(".input-menu-item") : [];

function isInputMenuOpen() {
  return inputMenu && !inputMenu.classList.contains("hidden");
}

function openInputMenu() {
  if (!inputMenu) return;
  inputMenu.classList.remove("hidden");
  uploadBtn.setAttribute("aria-expanded", "true");
}

function closeInputMenu() {
  if (!inputMenu) return;
  inputMenu.classList.add("hidden");
  uploadBtn.setAttribute("aria-expanded", "false");
}

function toggleInputMenu() {
  if (isInputMenuOpen()) closeInputMenu();
  else openInputMenu();
}

function handleInputMenuAction(action) {
  closeInputMenu();
  switch (action) {
    case "upload":
      // Preserve original behavior: trigger the hidden file input.
      fileInput.click();
      break;
    case "prompts":
      // Stage 3: open the prompts import modal (list + preview + insert).
      openPromptsImportModal();
      break;
    case "skills":
      // Stage 4: open settings and switch to the skills tab. The user picks
      // a skill from the list and clicks its "导入" button to insert it
      // into the chat input (handler lives in skills-panel.mjs).
      settingsModal.classList.add("active");
      switchSettingsTab("skills");
      // Load the skill list if it hasn't been rendered yet
      loadAndRenderSkills?.();
      break;
    default:
      console.warn("[input-menu] unknown action:", action);
  }
}

function initInputMenu() {
  if (!uploadBtn || !inputMenu) return;

  // Toggle on upload button click.
  uploadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInputMenu();
  });

  // Wire each popover item to handleInputMenuAction(...). Without this loop
  // the items render and the popover opens, but clicking them does nothing —
  // `inputMenuItems` is collected (line 243) but never iterated, and
  // `handleInputMenuAction` is defined but never called.
  inputMenuItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.getAttribute("data-action");
      handleInputMenuAction(action);
    });
  });

  // Outside-click + Escape + window resize all dismiss the popover.
  initInputMenuOutsideListeners();
}

/**
 * Wire up the OpenCode 3-mode dropdown (default / build / plan).
 * - Click the button → toggle the menu open/closed.
 * - Click an option → set ocMode, update the button label, close the menu.
 * - Click outside → close the menu.
 * - Keyboard: Escape closes the menu.
 */
function initOpencodeModeSelector() {
  const selector = $("#opencode-mode-selector");
  if (!selector || !opencodeModeButton || !opencodeModeMenu) return;

  // Apply the current ocMode to the DOM (label, aria-selected on options).
  // Labels go through the i18n layer so English-locale users see English.
  function renderMode() {
    const labels = {
      default: t("opencode.mode.default"),
      build: t("opencode.mode.build"),
      plan: t("opencode.mode.plan"),
    };
    if (opencodeModeLabel) opencodeModeLabel.textContent = labels[ocMode] || labels.build;
    opencodeModeMenu.querySelectorAll("li[data-mode]").forEach((li) => {
      li.setAttribute("aria-selected", li.getAttribute("data-mode") === ocMode ? "true" : "false");
    });
  }
  renderMode();

  function open() {
    selector.classList.add("open");
    opencodeModeMenu.classList.remove("hidden");
    opencodeModeButton.setAttribute("aria-expanded", "true");
  }
  function close() {
    selector.classList.remove("open");
    opencodeModeMenu.classList.add("hidden");
    opencodeModeButton.setAttribute("aria-expanded", "false");
  }
  function isOpen() {
    return !opencodeModeMenu.classList.contains("hidden");
  }

  opencodeModeButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  opencodeModeMenu.querySelectorAll("li[data-mode]").forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = li.getAttribute("data-mode");
      if (next === "default" || next === "build" || next === "plan") {
        ocMode = next;
        // Persist so the choice survives app restart.
        try { localStorage.setItem(OC_MODE_KEY, next); } catch { /* ignore */ }
        renderMode();
      }
      close();
    });
  });

  // Click anywhere outside closes the menu.
  document.addEventListener("click", (e) => {
    if (isOpen() && !selector.contains(e.target)) close();
  });

// Escape closes the menu.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      close();
      opencodeModeButton.focus();
    }
  });
}

/**
 * OpenCode model picker — sibling of the mode selector. Shows the
 * currently-selected model in the button label; clicking opens a list of
 * `opencode models` (provider/model pairs). Selection is persisted to
 * localStorage and forwarded to the IPC on every submit (when runtime is
 * opencode). The choice takes effect on the NEXT query because opencode
 * binds the model at spawn time via --model (ACP v1 has no setModel).
 */
function initOpencodeModelSelector() {
  const selector = $("#opencode-model-selector");
  if (!selector || !opencodeModelButton || !opencodeModelMenu) return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderButton() {
    if (!opencodeModelName) return;
    let label;
    if (!ocModelId) label = t("opencode.model.unset");
    else {
      const found = ocAvailableModels.find((m) => m.id === ocModelId);
      label = (found && found.name) || ocModelId;
    }
    opencodeModelName.textContent = label;
  }

  function renderList() {
    const li = (id, name, desc, isUnset) => {
      const checked = (id || "") === (ocModelId || "") ? "true" : "false";
      const safeId = (id || "").replace(/"/g, "&quot;");
      return `<li role="option" data-model-id="${safeId}" aria-selected="${checked}"${isUnset ? ' data-unset="true"' : ""}><span class="mode-check"></span><span class="mode-title">${escapeHtml(name)}</span><span class="mode-desc">${escapeHtml(desc || "")}</span></li>`;
    };
    const items = [];
    items.push(li("", t("opencode.model.unset"), t("opencode.model.unset_desc"), true));
    for (const m of ocAvailableModels) items.push(li(m.id, m.name || m.id, m.id));
    if (ocAvailableModels.length === 0) {
      items.length = 0;
      items.push(li("", t("opencode.model.empty"), t("opencode.model.empty_desc"), true));
    }
    opencodeModelMenu.innerHTML = items.join("");
  }

  function open() {
    selector.classList.add("open");
    opencodeModelMenu.classList.remove("hidden");
    opencodeModelButton.setAttribute("aria-expanded", "true");
  }
  function close() {
    selector.classList.remove("open");
    opencodeModelMenu.classList.add("hidden");
    opencodeModelButton.setAttribute("aria-expanded", "false");
  }
  function isOpen() {
    return !opencodeModelMenu.classList.contains("hidden");
  }

  renderButton();
  renderList();

  opencodeModelButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  // Delegate clicks on list items so re-rendering doesn't require
  // re-binding.
  opencodeModelMenu.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-model-id]");
    if (!li || li.getAttribute("aria-disabled") === "true") return;
    e.stopPropagation();
    const raw = li.getAttribute("data-model-id") || "";
    ocModelId = raw || null;
    try {
      if (ocModelId) localStorage.setItem(OC_MODEL_KEY, ocModelId);
      else localStorage.removeItem(OC_MODEL_KEY);
    } catch { /* ignore */ }
    opencodeModelMenu.querySelectorAll("li[data-model-id]").forEach((el) => {
      el.setAttribute("aria-selected", (el.getAttribute("data-model-id") || "") === (ocModelId || "") ? "true" : "false");
    });
    renderButton();
    close();
  });

  document.addEventListener("click", (e) => {
    if (isOpen() && !selector.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      close();
      opencodeModelButton.focus();
    }
  });

  // Load the list lazily so the dropdown is populated as soon as opencode
  // is detected. Safe to call repeatedly; the IPC just re-spawns the
  // one-shot CLI.
  refreshOpencodeModels();
}

/**
 * Reload `opencode models` and refresh the model picker UI. Used by
 * initOpencodeModelSelector() on init, and could be called from a "refresh"
 * button later if we add one.
 */
// Expose on window so runtime-selector.mjs (which doesn't import app.js)
// can trigger a refresh on every runtime switch. Idempotent.
if (typeof window !== "undefined") window.__refreshOpencodeModels = () => refreshOpencodeModels();

async function refreshOpencodeModels() {
  if (!window.aideagent?.listOpencodeModels) return;
  try {
    const list = await window.aideagent.listOpencodeModels();
    if (Array.isArray(list)) {
      ocAvailableModels = list;
      ocAvailableModelIds.clear();
      for (const m of list) if (m && m.id) ocAvailableModelIds.add(m.id);
      // If the persisted selection isn't in the list anymore, drop it
      // so the dropdown shows the unset entry (less surprising than a
      // ghost selection).
      if (ocModelId && !ocAvailableModelIds.has(ocModelId)) {
        ocModelId = null;
        try { localStorage.removeItem(OC_MODEL_KEY); } catch { /* ignore */ }
      }
      // Re-render the picker (the selector might not be visible yet, but
      // this updates the label + aria-selected for when it is).
      const menu = document.getElementById("opencode-model-menu");
      const name = document.getElementById("opencode-model-name");
      if (menu && name) {
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        const li = (id, n, d, isUnset) => {
          const checked = (id || "") === (ocModelId || "") ? "true" : "false";
          const safeId = (id || "").replace(/"/g, "&quot;");
          return `<li role="option" data-model-id="${safeId}" aria-selected="${checked}"${isUnset ? ' data-unset="true"' : ""}><span class="mode-check"></span><span class="mode-title">${esc(n)}</span><span class="mode-desc">${esc(d || "")}</span></li>`;
        };
        const items = [li("", t("opencode.model.unset"), t("opencode.model.unset_desc"), true)];
        for (const m of ocAvailableModels) items.push(li(m.id, m.name || m.id, m.id));
        if (ocAvailableModels.length === 0) items.length = 0, items.push(li("", t("opencode.model.empty"), t("opencode.model.empty_desc"), true));
        menu.innerHTML = items.join("");
        const found = ocAvailableModels.find((m) => m.id === ocModelId);
        name.textContent = (found && found.name) || ocModelId || t("opencode.model.unset");
      }
    }
  } catch (err) {
    console.error("[opencode] listOpencodeModels failed:", err.message);
  }
}

// Expose for the runtime selector (which lives in a separate module and
// calls back into here when the user switches to OpenCode).
window.refreshOpencodeModels = refreshOpencodeModels;

/**
 * Listen for the per-query model announcement so the button label
 * reflects what opencode actually accepted. Called from setupIPC() after
 * the renderer IPC bridge is wired.
 */
function wireOpencodeModelsStreamListener() {
  if (!window.aideagent?.onOpencodeModels) return;
  window.aideagent.onOpencodeModels((data) => {
    if (!data || !Array.isArray(data.models)) return;
    ocAvailableModels = data.models;
    ocAvailableModelIds.clear();
    for (const m of data.models) if (m && m.id) ocAvailableModelIds.add(m.id);
    if (data.currentModelId && typeof data.currentModelId === "string") {
      ocModelId = data.currentModelId;
      try { localStorage.setItem(OC_MODEL_KEY, ocModelId); } catch { /* ignore */ }
    }
  });
}

// Outside-click and Escape both dismiss the popover.
function initInputMenuOutsideListeners() {
  document.addEventListener("click", (e) => {
    if (!isInputMenuOpen()) return;
    if (inputMenu.contains(e.target) || uploadBtn.contains(e.target)) return;
    closeInputMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isInputMenuOpen()) {
      closeInputMenu();
    }
  });

  // Close when window resizes (popover anchored to a button that moved).
  window.addEventListener("resize", () => {
    if (isInputMenuOpen()) closeInputMenu();
  });
}


/* ── Update info bar (model name + reasoning state) ── */
function updateInfoBar() {
  if (!infoModelName) return;
  const cfg = loadApiConfig();
  // Show model name (or provider label if no model). preset.name is an i18n
  // KEY — translate it here so language switches are reflected immediately.
  const preset = cfg.provider ? PROVIDER_PRESETS[cfg.provider] : null;
  const label = preset ? t(preset.name) : (cfg.apiUrl?.replace(/https?:\/\//, "").split("/")[0] || "");
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
      <div class="runtime-choices" id="runtime-choices" role="tablist" aria-label="Runtime selector">
        <button class="runtime-choice active" data-runtime="aide" role="tab" aria-selected="true" type="button">
          <span class="runtime-choice-icon runtime-choice-icon-aide">Ⓐ</span>
          <span class="runtime-choice-body">
            <span class="runtime-choice-name">${t("runtime.aide")}</span>
            <span class="runtime-choice-desc">${t("runtime.aide.desc")}</span>
          </span>
          <span class="runtime-badge runtime-badge-aide">${t("runtime.detected")}</span>
        </button>
        <button class="runtime-choice" data-runtime="opencode" role="tab" aria-selected="false" type="button">
          <span class="runtime-choice-icon runtime-choice-icon-opencode">⬡</span>
          <span class="runtime-choice-body">
            <span class="runtime-choice-name">${t("runtime.opencode")}</span>
            <span class="runtime-choice-desc">${t("runtime.opencode.desc")}</span>
          </span>
          <span class="runtime-badge" id="opencode-status-badge">${t("runtime.detecting")}</span>
        </button>
      </div>
    </div>
  `;
  // Re-apply avatar after DOM replacement (DEFAULT_AVATAR fallback if none saved)
  const saved = localStorage.getItem(AVATAR_KEY);
  const src = saved || DEFAULT_AVATAR;
  const wa = document.getElementById("welcome-avatar");
  if (wa) wa.src = src;
  const sp = document.getElementById("settings-preview");
  if (sp) sp.src = src;
  // Re-bind the runtime cards' click events and re-apply visual state.
  // showWelcome destroys the old DOM, so the listeners that initRuntimeSelector
  // attached on first paint are gone. rebindRuntimeCards is the cheap
  // (no re-detection) refresh path — see runtime-selector.mjs.
  rebindRuntimeCards();
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
    contextWindow: localStorage.getItem(`${prefix}context_window`) || "",
  };
}

async function saveApiConfig(provider, apiUrl, model, apiKey, apiFormat, contextWindow) {
  const prefix = provider ? `AideAgent_${provider}_` : "AideAgent_";
  if (apiUrl) localStorage.setItem(`${prefix}api_url`, apiUrl);
  localStorage.setItem(STORAGE_KEYS.PROVIDER, provider);
  if (model) localStorage.setItem(`${prefix}model`, model);
  if (apiFormat) localStorage.setItem(STORAGE_KEYS.API_FORMAT, apiFormat);
  // Empty string = clear the manual override (auto-detection takes over).
  if (contextWindow) localStorage.setItem(`${prefix}context_window`, contextWindow);
  else localStorage.removeItem(`${prefix}context_window`);
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
      // m.label is an i18n KEY — translate at render time.
      opt.textContent = t(m.label);
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
    if (settingsContextWindow) settingsContextWindow.value = cfg.contextWindow || "";
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
  // Context-window override is stored per-provider, same prefix scheme.
  if (settingsContextWindow) settingsContextWindow.value = localStorage.getItem(`${prefix}context_window`) || "";
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
  const contextWindow = (settingsContextWindow?.value || "").trim();
  const preset = PROVIDER_PRESETS[provider];
  const apiFormat = preset?.format || "openai";

  if (!rawUrl) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.fill_url");
      settingsStatus.className = "settings-status error";
    }
    return;
  }

  // Manual context-window override: empty (auto) or a sane integer.
  if (contextWindow && (!/^\d+$/.test(contextWindow) || Number(contextWindow) < 4096)) {
    if (settingsStatus) {
      settingsStatus.textContent = t("api.context_window_invalid");
      settingsStatus.className = "settings-status error";
    }
    return;
  }

  const apiUrl = apiFormat === "anthropic" ? rawUrl.replace(/\/+$/, "") : normalizeApiUrl(rawUrl);

  // Show the normalized URL to user
  if (apiUrl !== rawUrl) {
    settingsUrl.value = apiUrl;
  }

  await saveApiConfig(provider, apiUrl, model, apiKey, apiFormat, contextWindow);
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
  const input = activePromptInput();
  const text = input.value.trim();
  const files = state.attachedFiles;
  if ((!text && files.length === 0)) return;
  if (state.isStreaming) {
    // Queue the message for later
    _queryQueue.push({ text, files: [...files] });
    input.value = "";
    autoResize(input);
    state.attachedFiles = [];
    renderFilePreviews();
    updateSendButton();
    setStatus(t("status.queued") || "已排队，等待当前对话完成...");
    return;
  }

  const runtime = getCurrentRuntime();
  const cfg = loadApiConfig();
  // opencode uses the local CLI's own model config — it doesn't need an API URL.
  if (runtime !== "opencode" && !cfg.apiUrl) {
    addErrorMessage(t("api.config_first"));
    return;
  }

  // Fallback: use currently selected model in settings dropdown if not yet persisted
  if (!cfg.model) {
    const fallbackModel = getCurrentModelValue();
    if (fallbackModel) cfg.model = fallbackModel.trim();
  }

  // Clear input and files
  input.value = "";
  autoResize(input);
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
  activeSendBtn().classList.add("hidden");
  activeStopBtn().classList.remove("hidden");
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
    // When runtime=opencode, the AideAgent API config (`cfg.model`) is
    // ignored — opencode uses its own model selection. Forward the user's
    // picker choice (or null = opencode default) so the main process can
    // pass it to ACP `session/new`.
    const opencodeModelId = getCurrentRuntime() === "opencode" ? ocModelId : null;
    await window.aideagent.submitQuery(text, cfg.apiKey, cfg.apiUrl, cfg.model, cfg.apiFormat, apiFiles, enabledSkills, reasoning, agentName, kbEnabled, activePlanModeEnabled(), webSearchEnabled, getCurrentRuntime(), opencodeModelId, cfg.contextWindow || "");
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
  // Restore both runtime's send/stop buttons — stopQuery can fire after a
  // runtime switch, so be defensive and reset whichever pair exists.
  for (const sb of [sendBtn, ocSendBtn()]) {
    if (!sb) continue;
    sb.classList.remove("hidden");
    if (sb !== ocSendBtn()) sb.disabled = false;
  }
  for (const sb of [stopBtn, ocStopBtn()]) {
    if (sb) sb.classList.add("hidden");
  }
  setStatus(t("status.ready"));
}

function processQueryQueue() {
  if (_queryQueue.length === 0) return;
  const next = _queryQueue.shift();
  // Restore queued files to state
  state.attachedFiles = next.files || [];
  // Set prompt and submit. Use activePromptInput() so the queued text lands
  // in the currently-visible input (OpenCode's textarea when runtime is
  // opencode, AideAgent's otherwise). Writing to the hidden one would make
  // the queued query invisible to the user.
  activePromptInput().value = next.text;
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
    // Clear BOTH input boxes — switching runtimes after reset shouldn't
    // show leftover text in the now-visible one. Focus the active one so
    // the user can start typing immediately in the runtime they're on.
    promptInput.value = "";
    const ocIn = ocPromptInput();
    if (ocIn) ocIn.value = "";
    setStatus(t("status.ready"));
    refreshSessionList();
    requestAnimationFrame(() => activePromptInput().focus());
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
  // Same dual-clear + active-focus as the streaming branch above.
  promptInput.value = "";
  const ocIn2 = ocPromptInput();
  if (ocIn2) ocIn2.value = "";
  setStatus(t("status.ready"));
  refreshSessionList();
  requestAnimationFrame(() => activePromptInput().focus());
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

    // Restore the runtime this session was started with (session-level binding).
    if (data.runtime) setRuntime(data.runtime, false, true);

    rebuildMessages(data);
    if (sessionDisplay) sessionDisplay.textContent = data.sessionId || "—";
    refreshSessionList();

    // P1: check if this session has a turn_progress marker (was interrupted mid-task).
    window.aideagent.getTurnProgress(sessionId).then(tp => {
      if (tp && (tp.currentContinuation > 0 || tp.currentTurn > 0)) {
        const banner = document.createElement("div");
        banner.className = "resume-banner";
        banner.textContent = `⚠ 此对话在第 ${tp.currentTurn} 轮（第 ${tp.currentContinuation + 1} 次续写）中断。可发消息让 agent 继续。`;
        if (tp.lastSummary) {
          const detail = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = "查看上次摘要";
          detail.appendChild(summary);
          const pre = document.createElement("pre");
          pre.textContent = tp.lastSummary;
          detail.appendChild(pre);
          banner.appendChild(detail);
        }
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        closeBtn.className = "resume-banner-close";
        closeBtn.onclick = () => { try { window.aideagent.clearTurnProgress(sessionId); } catch {} banner.remove(); };
        banner.appendChild(closeBtn);
        messageList.insertBefore(banner, messageList.firstChild);
      }
    }).catch(() => {});
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

  // OpenCode model picker — main process forwards ACP `session/new`
  // results via the `opencode:ready` event channel. Wire it now so the
  // picker is populated as soon as opencode spawns.
  wireOpencodeModelsStreamListener();

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
    // P3: a chunk may carry `done: true` in older code paths, but the
    // canonical stream-end signal is the separate `stream:done` IPC
    // (sent by ipc-handlers.mjs after agentLoop returns). The old
    // dual-trigger path called stopQuery() here AND in onStreamDone,
    // which could race with the queued-query processor and lose the
    // final text. Treat chunk.done as a no-op and let stream:done
    // own the close.
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
        el.classList.add("danger");
      } else if (data.usagePct >= 80) {
        el.classList.add("warn");
      } else if (data.totalTokens > 5000) {
        el.classList.add("ok");
      } else {
        el.classList.add("hidden");
        return;
      }
      el.querySelector(".context-usage-bar").style.setProperty("--fill", data.usagePct + "%");
      el.querySelector(".context-usage-text").textContent = data.usagePct + "%";
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

// OpenCode input box — mirrors the bindings above for its own textarea/buttons.
// File uploads are now enabled for OpenCode too: the ocUploadBtn directly
// triggers the hidden ocFileInput (no popover — OpenCode doesn't use the
// prompts/skills popover). The ocFilePreviews instance shares state and
// #file-preview-area with the aide instance, so chips render in the same
// location. Send button is enabled when there is text OR attached files.
const ocInput = ocPromptInput();
if (ocInput) {
  const ocSend = ocSendBtn();
  const ocStop = ocStopBtn();
  const syncOcSend = () => {
    if (ocSend) {
      ocSend.disabled = !ocInput.value.trim() && state.attachedFiles.length === 0;
    }
  };
  ocInput.addEventListener("input", () => { autoResize(ocInput); syncOcSend(); });
  ocInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ocSend && !ocSend.disabled) submitQuery();
    }
  });
  if (ocSend) ocSend.addEventListener("click", submitQuery);
  if (ocStop) ocStop.addEventListener("click", abortQuery);
  // Upload button directly opens the file picker (no popover for OpenCode).
  if (ocUploadBtn && ocFileInput) {
    ocUploadBtn.addEventListener("click", () => ocFileInput.click());
  }
  syncOcSend();
}
newChatBtn.addEventListener("click", resetChat);

// Auto-focus input when window regains focus (fixes Electron focus loss after confirm() / alt-tab)
window.addEventListener("focus", () => {
  if (!state.isStreaming && !settingsModal.classList.contains("active")) {
    requestAnimationFrame(() => promptInput.focus());
  }
});

/* ── Init ──────────────────────────────────────────────── */
initSettingsTabs();
initInputMenu();
filePreviews.init();
if (ocFileInput) ocFilePreviews.init();
initOpencodeModeSelector();
initOpencodeModelSelector();
setupIPC();
loadAvatar();
initAgentNameUI();
applyAgentName(loadAgentName());
initUserAvatarUI();
applyUserName(loadUserName());
initRuntimeSelector();
// Kick off the OpenCode model fetch so the picker is populated even
// before the user clicks the runtime card. The fetch is cheap (single
// `opencode models` CLI call, ~200ms) and idempotent.
if (typeof window.__refreshOpencodeModels === "function") {
  window.__refreshOpencodeModels();
}
updateConfigBanner();
// Session info: wrap localStorage.setItem so any write to an
// `AideAgent_*` key auto-pushes the snapshot to main. After install,
// do an initial push so the main process has the current state before
// the AI makes its first `get_session_info` call.
installLocalStorageHook();
pushSessionInfo();

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
initPromptsPanel();

/* ── Update Toast (top-right slide-in notifications) ── */
initUpdateToast();

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
  const downloadBtn = document.getElementById("update-download-btn");
  const installBtn = document.getElementById("update-install-btn");
  const skipBtn = document.getElementById("update-skip-btn");
  const changelogEl = document.getElementById("changelog-content");
  const versionEl = document.getElementById("about-version");

  // ── Helpers ──────────────────────────────────────────
  // Reset the panel to its "no update" baseline before re-rendering.
  // Called whenever a new status arrives so stale buttons / progress
  // from a previous update flow don't linger.
  const resetPanelButtons = () => {
    progressContainer?.classList.add("hidden");
    downloadBtn?.classList.add("hidden");
    installBtn?.classList.add("hidden");
    skipBtn?.classList.add("hidden");
    if (progressBar) progressBar.style.width = "0%";
    if (progressPercent) progressPercent.textContent = "0%";
  };

  // Read the renderer-side skip preference. Returns the version string
  // or null. This is the cross-session source of truth (main process
  // mirrors it in memory for in-session checks only).
  const isVersionSkipped = (version) => {
    if (!version) return false;
    const stored = getSkippedVersion();
    return !!stored && stored === version;
  };

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

  // Load auto-check preference. Three-state semantics:
  //   - key never set      → first install, default to ON (99% of users
  //                          never find this checkbox in Settings otherwise)
  //   - key === "true"     → user explicitly opted in
  //   - key === "false"    → user explicitly opted out — respect it
  // This avoids silently re-enabling auto-check for users who previously
  // turned it off during the previous build's default-off period.
  const storedAuto = localStorage.getItem(AUTO_UPDATE_KEY);
  const autoEnabled = storedAuto === null ? true : storedAuto === "true";
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

  // Download button (visible in "available" state) — triggers the actual
  // download. With autoDownload=false the main process only downloads
  // when the user explicitly asks for it.
  downloadBtn?.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    progressContainer?.classList.remove("hidden");
    progressContainer && (progressText.textContent = t("about.downloading"));
    try {
      await window.aideagent.updateDownload?.();
    } catch (e) {
      statusEl.textContent = t("about.check_failed", { error: e.message });
      statusEl.style.color = "var(--danger)";
    }
    downloadBtn.disabled = false;
  });

  // Install button (visible in "downloaded" state) — quit-and-install.
  installBtn?.addEventListener("click", () => {
    window.aideagent.updateInstall();
  });

  // Skip button (visible in "available" state) — remembers the version
  // in localStorage so future auto-checks don't pester the user about it.
  // Also informs the main process for in-session consistency.
  skipBtn?.addEventListener("click", () => {
    if (!currentVersion) return;
    setSkippedVersion(currentVersion);
    window.aideagent.updateSkip?.(currentVersion).catch(() => {});
    statusEl.textContent = t("about.skipped", { version: currentVersion });
    statusEl.style.color = "var(--text-light)";
    resetPanelButtons();
  });

  // Tracks the currently-displayed version so skipBtn knows what to skip.
  let currentVersion = null;

  // Listen for status updates from main process
  window.aideagent.onUpdateStatus?.((data) => {
    switch (data.status) {
      case "checking":
        statusEl.textContent = t("about.checking");
        statusEl.style.color = "var(--text-light)";
        resetPanelButtons();
        break;
      case "available": {
        currentVersion = data.version;
        statusEl.textContent = t("about.new_version_ready", { version: data.version });
        // Use --accent instead of --primary (--primary was never defined in any :root block;
        // the bar CSS uses --accent correctly. Fall back to a hardcoded indigo for safety).
        statusEl.style.color = "var(--accent, #6366f1)";
        resetPanelButtons();
        if (data.releaseNotes && changelogEl) {
          changelogEl.innerHTML = marked.parse(data.releaseNotes);
        }
        // Honor cross-session skip: if the user previously skipped this
        // exact version, show a static "skipped" message and hide all
        // action buttons. (data.skipped is the in-session fast path set
        // by update:skip IPC; getSkippedVersion() is the persistent one.)
        const skipped = data.skipped || isVersionSkipped(data.version);
        if (skipped) {
          statusEl.textContent = t("about.skipped", { version: data.version });
          statusEl.style.color = "var(--text-light)";
          // Hide all action buttons — version is silently skipped.
        } else {
          downloadBtn?.classList.remove("hidden");
          skipBtn?.classList.remove("hidden");
        }
        break;
      }
      case "not-available":
        statusEl.textContent = t("about.status_idle");
        statusEl.style.color = "var(--text-light)";
        resetPanelButtons();
        currentVersion = null;
        break;
      case "downloaded":
        statusEl.textContent = t("about.downloaded", { version: data.version });
        statusEl.style.color = "#22c55e";
        // Show 100% on progress bar, keep it visible, and show install button
        progressContainer?.classList.remove("hidden");
        if (progressBar) progressBar.style.width = "100%";
        if (progressPercent) progressPercent.textContent = "100%";
        downloadBtn?.classList.add("hidden");
        skipBtn?.classList.add("hidden");
        installBtn?.classList.remove("hidden");
        break;
      case "error":
        statusEl.textContent = t("about.check_failed", { error: data.message });
        statusEl.style.color = "var(--danger)";
        resetPanelButtons();
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
      // Re-render KB panel status ("Indexed X notes" doesn't auto-refresh on lang switch)
      const kbTab = document.querySelector('.settings-tab[data-tab="knowledge-base"]');
      const kbPanel = document.getElementById("tab-knowledge-base");
      if (kbTab?.classList.contains("active") && kbPanel && !kbPanel.classList.contains("hidden")) {
        loadKnowledgeBasePanel().catch(() => {});
      }
      // Update workspace
      updateWorkspaceDisplay();
      // Re-render dynamic elements created after page load so they pick
      // up the new locale (otherwise they keep showing the language that
      // was active when they were first created).
      if (typeof renderMode === "function") renderMode();  // OpenCode mode selector label
      if (typeof applyOpencodeStatus === "function") applyOpencodeStatus(_opencodeStatus);  // Runtime badge
      if (typeof switchInputBox === "function") switchInputBox(getCurrentRuntime());  // Runtime choice cards
      if (typeof refreshSessionList === "function") refreshSessionList();  // Session list
    });
  }
  // Apply saved language on load
  if (typeof applyLang === "function") applyLang();
})();
