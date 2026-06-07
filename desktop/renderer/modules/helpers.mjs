// @ts-check — JSDoc-typed helper utilities (sanitize, renderMarkdown, etc.).
// @ts-check — 带 JSDoc 类型注解的辅助函数（sanitize、renderMarkdown 等）。

/**
 * Sanitize an HTML string with DOMPurify using the allowed tags for chat messages.
 * @param {string} html - raw HTML to sanitize
 * @returns {string} sanitized HTML
 */
export function sanitize(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "b", "i", "em", "strong", "a", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "code", "pre", "blockquote", "hr", "table", "thead", "tbody",
      "tr", "th", "td", "span", "div", "img", "hr", "del", "input",
    ],
    ALLOWED_ATTR: ["href", "target", "class", "id", "src", "alt", "type", "checked", "disabled", "data-m"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-]|$))/i,
  });
}

/**
 * Render markdown to sanitized HTML, with $$...$$ and \[...\] converted to
 * KaTeX placeholders for later rendering in renderLatexInElement.
 * @param {string} text - raw markdown
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(text) {
  // 1. $$...$$ → display math
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, '<span class="kp" data-m="d">$1</span>');
  // 2. \[...\] → display math (greedy to capture multiline)
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, '<span class="kp" data-m="d">$1</span>');
  // 3. \(...\) → inline math
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, '<span class="kp" data-m="i">$1</span>');
  // 4. \begin{env}...\end{env} → display math (cases, aligned, gather, etc.)
  text = text.replace(/\\begin\{([^}]+)\}([\s\S]+?)\\end\{\1\}/g, (m, env, body) => {
    return `<span class="kp" data-m="d">\\begin{${env}}${body}\\end{${env}}</span>`;
  });
  // 5. Dangling \[ without \] (streaming edge case) — wrap rest of line
  text = text.replace(/\\\[(?![\s\S]*\\\])([^\n]*)/g, '<span class="kp" data-m="d">$1</span>');
  // 6. Dangling \( without \) (streaming edge case) — wrap rest of line
  text = text.replace(/\\\((?![\s\S]*\\\))([^\n]*)/g, '<span class="kp" data-m="i">$1</span>');
  // 7. $...$ → inline math (with content detection)
  text = text.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (m, inner) => {
    const t = inner.trim();
    if (/^\d+[.,]?\d*%?$/.test(t)) return m;
    if (/[\\{}_^]/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    if (/[a-zA-Z]/.test(t) && /[=+\-*/^()\[\]<>]/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    return m;
  });
  let html = marked.parse(text);
  html = sanitize(html);
  return html;
}

/**
 * Walk the given container and render any `.kp` (KaTeX placeholder) spans.
 * @param {HTMLElement} el - container element to scan
 */
export function renderLatexInElement(el) {
  if (typeof katex !== "undefined" && typeof katex.render === "function") {
    el.querySelectorAll("span.kp").forEach((node) => {
      const span = /** @type {HTMLElement} */ (node);
      const tex = span.textContent || "";
      const displayMode = span.dataset.m === "d";
      try {
        katex.render(tex, span, { displayMode, throwOnError: true });
      } catch (_e) {
        span.outerHTML = displayMode
          ? `<div class="katex-raw">\\[${tex.replace(/</g, "&lt;")}\\]</div>`
          : `<span class="katex-raw">\\(${tex.replace(/</g, "&lt;")}\\)</span>`;
      }
    });
  }
}

/**
 * Auto-resize a textarea to fit its content (capped at 200px).
 * @param {HTMLTextAreaElement} textarea
 */
export function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

/**
 * Format a byte count as a short human-readable size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Scroll the message list to the bottom.
 */
export function scrollToBottom() {
  const el = document.getElementById("message-list");
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * Set the status bar text.
 * @param {string} text
 */
export function setStatus(text) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = text;
}

/**
 * @returns {boolean} whether the reasoning/thinking section is enabled (default true)
 */
export function loadReasoningEnabled() {
  return localStorage.getItem("AideAgent_reasoning_enabled") !== "false";
}

/**
 * @param {boolean} enabled
 */
export function saveReasoningEnabled(enabled) {
  localStorage.setItem("AideAgent_reasoning_enabled", String(enabled));
}
