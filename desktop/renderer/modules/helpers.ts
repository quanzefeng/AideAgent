// @ts-check — JSDoc-typed helper utilities (sanitize, renderMarkdown, etc.).
// @ts-check — 带 JSDoc 类型注解的辅助函数（sanitize、renderMarkdown 等）。

/**
 * Sanitize an HTML string with DOMPurify using the allowed tags for chat messages.
 * @param {string} html - raw HTML to sanitize
 * @returns {string} sanitized HTML
 */
export function sanitize(html: any) {
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
 * Escape a string for safe insertion into HTML text content or quoted
 * attribute values. Unlike DOMPurify (which sanitizes HTML fragments),
 * this is for plain-text values that must NOT be interpreted as HTML.
 * Use this for: element text, title="", alt="", data-*="", etc.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str: any) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Repair common model LaTeX mistakes that make KaTeX throw.
 * Pure string→string so it can be unit-tested without a DOM.
 * @param {string} tex
 * @returns {string}
 */
export function repairTex(tex: any): string {
  if (!tex) return "";
  let s = String(tex);
  // Model replacement chars / tofu (■) break KaTeX tokens like \tag*{■}
  s = s.replace(/[\uFFFD\u25A0\u25A1]/g, "");
  // aligned row break written as `\4pt]` (missing `[` and one `\`) → `\\[4pt]`
  s = s.replace(/(?<!\\)\\(\d+(?:\.\d+)?pt)\]/g, "\\\\[$1]");
  // Model often writes `\&=` inside aligned; KaTeX wants `&=`
  s = s.replace(/\\&/g, "&");
  // Drop broken \tag*{...} (keep only simple alphanumeric tags)
  s = s.replace(/\\tag\*?\{([^}]*)\}/g, (_m, content) =>
    /^[A-Za-z0-9.\-()]+$/.test(String(content)) ? `\\tag{${content}}` : "",
  );
  // Mixed plain + env: keep only the complete env block when one exists
  const envMatch = s.match(/\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/);
  if (envMatch && envMatch[0].length >= 8 && s.trim() !== envMatch[0]) {
    const before = s.slice(0, envMatch.index || 0).trim();
    const after = s.slice((envMatch.index || 0) + envMatch[0].length).trim();
    // Only peel off if the leftovers are clearly non-TeX noise / short repeats
    if (before.length + after.length < 80 || /[=\s]{3,}/.test(before + after)) {
      s = envMatch[0];
    }
  }
  // Unbalanced closing braces — strip extras from the right so KaTeX can parse
  const count = (ch: string) => s.split(ch).length - 1;
  let open = count("{");
  let close = count("}");
  while (close > open && s.includes("}")) {
    const idx = s.lastIndexOf("}");
    s = s.slice(0, idx) + s.slice(idx + 1);
    close--;
  }
  return s.trim();
}

/**
 * True when a text run looks like bare LaTeX never wrapped in
 * $...$ / \(...\) / \[...\]. Conservative: known commands or sub/superscripts.
 * Long multi-formula blobs return false — split first via splitBareLatexSegments.
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeBareLatex(s: any): boolean {
  if (!s || s.length < 2 || s.length > 300) return false;
  if (/\$\$|\\\(|\\\[|class="kp"/.test(s)) return false;
  if (/^[A-Za-z]:\\/.test(s.trim())) return false;
  // Markdown table rows (| c1 | c2 | ...) are never LaTeX. Cells like
  // `IQ2_XS(2.50bpw)` match hasSub+hasOps, which used to swallow the whole
  // row into a .kp span → marked lost the pipes, closed the table early,
  // and the remaining rows rendered as raw math crammed to one side.
  const trow = s.trim();
  if (trow.startsWith("|") && (trow.match(/\|/g) || []).length >= 3) return false;
  // Block markers at fragment start (`- `, `* `, `> `, `# ` …) must never
  // be swallowed into math either — eating the marker silently destroys
  // the list/quote/heading (same bug class as the table-pipe case: fuzzy
  // math detection ran before markdown structure was parsed).
  if (/^\s*(?:[-*+]\s|>\s|#{1,6}\s)/.test(s)) return false;
  // Multiple "f(x) =" starts glued together = model repetition, not one formula
  const starts = s.match(/[A-Za-z]\([A-Za-z0-9]\)\s*=/g);
  if (starts && starts.length >= 2) return false;
  const hasCmd = /\\(?:frac|dfrac|tfrac|cfrac|sqrt|begin|end|left|right|Longrightarrow|Longleftarrow|Rightarrow|Leftarrow|rightarrow|leftarrow|mapsto|blacksquare|square|triangle|angle|Delta|Gamma|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|omega|infty|partial|nabla|int|iint|sum|prod|lim|log|ln|exp|min|max|binom|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|subset|subseteq|forall|exists|neg|wedge|vee|ldots|cdots|vdots|ddots|quad|qquad|mathrm|mathbb|mathbf|mathit|hat|bar|vec|overline|underline|prime|because|therefore|deg|circ|degree|text|operatorname|limits|displaystyle|tilde|check|breve|acute|grave|dot|ddot|imath|jmath|ell|emptyset|mathcal|mathfrak|mathsf|mathtt|boxed|overset|underset|stackrel|dbinom|tbinom|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan)\b/.test(s);
  const hasSub = /[A-Za-z0-9)]_[A-Za-z0-9{]/.test(s) || /[A-Za-z0-9)]\^\{?[A-Za-z0-9]/.test(s);
  const hasOps = /[=+\-*/^()[\]<>|&]/.test(s) && /[A-Za-z0-9\\]/.test(s);
  const hasGeoSym = /[∠△⊥∥≈≡∼∪∩∈∀∃∅∫∑∏√∞≤≥≠±×÷⋅]/.test(s) && /[A-Za-z0-9]/.test(s);
  if (hasCmd) return true;
  if (hasSub && hasOps) return true;
  if (/[A-Za-z]_[A-Za-z0-9]/.test(s) && hasOps) return true;
  if (hasGeoSym) return true;
  return false;
}

const CJK_SPLIT = /([㐀-䶿一-鿿豈-﫿　-〿＀-￯]+)/;
const COMPLETE_ENV_RE = /\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/;

/** Strip latex markers / unicode exponents so repeated model copies compare equal. */
export function normFormula(s: any): string {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/[²³⁴⁵⁶⁷⁸⁹]/g, (m) => String("²³⁴⁵⁶⁷⁸⁹".indexOf(m) + 2))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (m) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(m)))
    .replace(/[−–—]/g, "-")
    .replace(/[·⋅]/g, "")
    .replace(/[_^{}\\]/g, "")
    .toLowerCase();
}

function latexScore(s: string): number {
  let n = 0;
  n += (s.match(/\\/g) || []).length * 3;
  n += (s.match(/[_^]/g) || []).length * 2;
  n += (s.match(/[{}]/g) || []).length;
  n -= (s.match(/[\uFFFD■□]/g) || []).length * 10;
  return n;
}

function areSimilarFormulas(a: string, b: string): boolean {
  const na = normFormula(a);
  const nb = normFormula(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Same call prefix (P(x)= / f(y)= …) — model often reprints the same formula
  // in plain / unicode / latex forms back-to-back.
  const prefix = (s: string) => {
    const m = s.match(/^([a-z]\([a-z0-9]\)=)/);
    return m ? m[1] : "";
  };
  const pa = prefix(na);
  const pb = prefix(nb);
  if (pa && pa === pb) return true;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) {
    return true;
  }
  return false;
}

function isMathishChunk(c: string): boolean {
  if (!c || !c.trim()) return false;
  if (/^@@AIDE/.test(c)) return false;
  if (COMPLETE_ENV_RE.test(c) && c.trim().startsWith("\\begin")) return true;
  if (looksLikeBareLatex(c)) return true;
  if (c.length <= 300 && /=/.test(c) && /[A-Za-z\\∠△⊥]/.test(c)) return true;
  if (c.length <= 80 && /[∠△⊥∥≈≡∈∫∑∏]/.test(c) && /[A-Za-z0-9]/.test(c)) return true;
  return false;
}

/** Keep only the richest copy of consecutive near-duplicate model formulas. */
function dedupeSimilarMath(chunks: string[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  const flush = () => {
    if (group.length === 0) return;
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      let best = group[0];
      for (const g of group) {
        if (latexScore(g) > latexScore(best)) best = g;
      }
      out.push(best);
    }
    group = [];
  };
  for (const c of chunks) {
    if (isMathishChunk(c)) {
      if (group.length > 0 && areSimilarFormulas(group[group.length - 1], c)) {
        group.push(c);
      } else {
        flush();
        group = [c];
      }
    } else {
      flush();
      out.push(c);
    }
  }
  flush();
  return out;
}

/**
 * Split a non-CJK run into formula-sized chunks so glued model output
 * (`P(x)=...P(x)=...` or triple-copied `A=(b,0)...`) never becomes one giant KaTeX expression.
 * Complete `\begin...\end` env blocks stay atomic; immediate duplicate runs collapse.
 * @param {string} seg
 * @returns {string[]}
 */
export function splitBareLatexSegments(seg: any): string[] {
  const s = String(seg ?? "");
  if (!s) return [];
  // Mask complete envs so line/formula splits cannot tear aligned blocks apart.
  // Use a private sentinel distinct from wrapBareOutsideKp's outer mask so
  // restore only rewrites envs this function actually captured.
  const envs: string[] = [];
  const masked = s.replace(COMPLETE_ENV_RE, (m) => {
    envs.push(m);
    return `\uE002E${envs.length - 1}\uE003`;
  });
  const restore = (chunk: string) =>
    chunk.replace(/\uE002E(\d+)\uE003/g, (full, i) => envs[+i] ?? full);
  const lines = masked.split(/\r?\n/);
  const out: string[] = [];
  // Positive-width starts: f(x)= , Letter=( , or complete env placeholder
  const startRe = /[A-Za-z]\([A-Za-z0-9]\)\s*=|[A-Za-z]\s*=\s*\(|\uE002E\d+\uE003/g;
  for (const rawLine of lines) {
    // Preserve blank lines so markdown structure (headings/tables/lists) survives
    if (!rawLine.trim()) {
      out.push("");
      continue;
    }
    // Markdown table rows are structural — never split or collapse them.
    // `f(1)=` style cells would otherwise tear the row into multiple lines
    // and break the table in marked.
    const tr = rawLine.trim();
    if (tr.startsWith("|") && (tr.match(/\|/g) || []).length >= 3) {
      out.push(restore(rawLine));
      continue;
    }
    // Collapse model triple-quads: ABCABCABC → ABC, ∠C∠C∠C → ∠C.
    // Tempered so the repeated unit cannot contain `|` (markdown tables
    // like |---|---| must survive untouched).
    const line = rawLine.replace(/((?:(?!\|).){2,}?)\1{1,}/g, "$1");
    const matches: number[] = [];
    let m: RegExpExecArray | null;
    startRe.lastIndex = 0;
    while ((m = startRe.exec(line))) {
      matches.push(m.index);
      if (m[0].length === 0) startRe.lastIndex++;
    }
    if (matches.length <= 1) {
      out.push(restore(line));
      continue;
    }
    // Keep leading text + first formula; cut before each later formula start
    let prev = 0;
    for (let i = 1; i < matches.length; i++) {
      const piece = restore(line.slice(prev, matches[i]));
      if (piece.trim()) out.push(piece);
      prev = matches[i];
    }
    const tail = restore(line.slice(prev));
    if (tail.trim()) out.push(tail);
  }
  return out;
}

function wrapBareOutsideKp(text: string): string {
  if (!text) return text;
  // Mask complete envs first — they may span lines; line-split must not tear them.
  // Outer sentinel (\uE000/\uE001) is distinct from splitBareLatexSegments's
  // inner mask (\uE002/\uE003) so neither restore clobbers the other's envs.
  const envs: string[] = [];
  const masked = text.replace(COMPLETE_ENV_RE, (m) => {
    envs.push(m);
    return `\uE000E${envs.length - 1}\uE001`;
  });
  const restoreEnvs = (s: string) =>
    s.replace(/\uE000E(\d+)\uE001/g, (_m, i) => {
      const tex = envs[+i] ?? "";
      return `<span class="kp" data-m="d">${tex}</span>`;
    });
  // Line-by-line so markdown structure survives. Table rows (≥3 pipes,
  // leading `|`) stay ATOMIC: the CJK split below would tear a row like
  // `| 64 GB …追求最高质量 | **IQ3_S（…）** |` into fragments, and a
  // fragment such as ` | **IQ3_S` passes looksLikeBareLatex (subscript +
  // pipe ops), wraps the cell delimiter into a .kp span — marked then
  // loses the pipe, drops the column, and the text crams into column 1.
  const lines = masked.split("\n");
  const outLines: string[] = [];
  for (const line of lines) {
    const trow = line.trim();
    if (trow.startsWith("|") && (trow.match(/\|/g) || []).length >= 3) {
      outLines.push(line);
      continue;
    }
    let lineOut = "";
    for (const part of line.split(CJK_SPLIT)) {
      if (!part) continue;
      if (/[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/.test(part)) {
        lineOut += part;
        continue;
      }
      const chunks = dedupeSimilarMath(splitBareLatexSegments(part));
      let acc = "";
      for (const chunk of chunks) {
        if (!chunk) continue;
        const t = chunk.trim();
        if (!t) {
          acc += chunk;
          continue;
        }
        if (/\uE000E\d+\uE001/.test(t)) {
          acc += restoreEnvs(t);
          continue;
        }
        if (t.startsWith("\\begin") && COMPLETE_ENV_RE.test(t)) {
          acc += `<span class="kp" data-m="d">${t}</span>`;
          continue;
        }
        if (looksLikeBareLatex(t)) {
          acc += `<span class="kp" data-m="i">${t}</span>`;
        } else {
          acc += chunk;
        }
      }
      lineOut += acc;
    }
    outLines.push(lineOut);
  }
  return restoreEnvs(outLines.join("\n"));
}

/**
 * Wrap bare (delimiter-less) LaTeX runs in `.kp` placeholders.
 * Skips existing `.kp` spans (display math already extracted). Dedupes
 * consecutive near-duplicate model formula copies before wrapping.
 * @param {string} text
 * @returns {string}
 */
export function wrapBareLatexRuns(text: any): string {
  if (!text) return text;
  const src = String(text);
  const kpRe = /<span class="kp"[^>]*>[\s\S]*?<\/span>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = kpRe.exec(src))) {
    out += wrapBareOutsideKp(src.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += wrapBareOutsideKp(src.slice(last));
  return out;
}

/**
 * Render markdown to sanitized HTML, with $$...$$ and \[...\] converted to
 * KaTeX placeholders for later rendering in renderLatexInElement.
 * @param {string} text - raw markdown
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(text: any) {
  // Protect fenced/inline code from math rules only; restore before marked
  // so marked still turns fences into <pre><code>.
  const codeFences: string[] = [];
  let src = String(text ?? "");
  src = src.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (_m: any) => {
    codeFences.push(_m);
    return `@@AIDECODE${codeFences.length - 1}@@`;
  });
  const inlineCodes: string[] = [];
  src = src.replace(/(`[^`\n]+`)/g, (_m: any) => {
    inlineCodes.push(_m);
    return `@@AIDEICODE${inlineCodes.length - 1}@@`;
  });

  // 1. $$...$$ → display math
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, '<span class="kp" data-m="d">$1</span>');
  // 2. \[...\] → display math (lookbehind skips LaTeX row breaks `\\[4pt]`)
  src = src.replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, '<span class="kp" data-m="d">$1</span>');
  // 3. \(...\) → inline math
  src = src.replace(/(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g, '<span class="kp" data-m="i">$1</span>');
  // 4. \begin{env}...\end{env} → display math (atomic; must run before bare wrap)
  src = src.replace(COMPLETE_ENV_RE, (_m: any, env: any, body: any) => {
    return `<span class="kp" data-m="d">\\begin{${env}}${body}\\end{${env}}</span>`;
  });
  // 5. Dangling \[ (streaming)
  src = src.replace(/(?<!\\)\\\[([^\n]*)/g, '<span class="kp" data-m="d">$1</span>');
  // 6. Dangling \( (streaming)
  src = src.replace(/(?<!\\)\\\(([^\n]*)/g, '<span class="kp" data-m="i">$1</span>');
  // 7. $...$ → inline math. Single-letter / short ids ($C$, $BC$, $x$) count as math.
  src = src.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (m: any, inner: any) => {
    const t = inner.trim();
    if (/^\d+[.,]?\d*%?$/.test(t)) return m; // currency / plain number
    if (/[\\{}_^]/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    if (/^[A-Za-z]{1,8}$/.test(t)) return `<span class="kp" data-m="i">${t}</span>`;
    if (/^[A-Za-z]{1,6}(?:\s*,\s*[A-Za-z]{1,6}){1,8}$/.test(t)) {
      return `<span class="kp" data-m="i">${t}</span>`;
    }
    if (/[a-zA-Z]/.test(t) && /[=+\-*/^()\[\]<>]/.test(t)) {
      return `<span class="kp" data-m="i">${t}</span>`;
    }
    return m;
  });
  // 8. Bare LaTeX with no delimiters (models often skip $...$)
  src = wrapBareLatexRuns(src);

  // Extract .kp spans to plain tokens before marked. Raw HTML spans in the
  // source trigger CommonMark HTML-block rules and swallow subsequent
  // headings/tables/lists until a blank line — that was the "everything is
  // one giant bold paragraph" bug. Tokens are inert text; we re-inject spans
  // into the HTML after marked + before sanitize. Do this while code is still
  // protected so literal HTML inside fences is never treated as math.
  const mathStore: Array<{ mode: string; tex: string }> = [];
  src = src.replace(
    /<span class="kp" data-m="([di])">([\s\S]*?)<\/span>/g,
    (_m: any, mode: any, tex: any) => {
      mathStore.push({ mode: String(mode), tex: String(tex) });
      return `@@AIDEMATH${mathStore.length - 1}@@`;
    },
  );

  // Restore code samples so marked/sanitize see the real content
  src = src.replace(/@@AIDEICODE(\d+)@@/g, (_m: any, i: any) => inlineCodes[+i] ?? "");
  src = src.replace(/@@AIDECODE(\d+)@@/g, (_m: any, i: any) => codeFences[+i] ?? "");

  let html = marked.parse(src);
  html = html.replace(/@@AIDEMATH(\d+)@@/g, (_m: any, i: any) => {
    const item = mathStore[+i];
    if (!item) return "";
    return `<span class="kp" data-m="${item.mode}">${escapeHtml(item.tex)}</span>`;
  });
  html = sanitize(html);
  return html;
}

/**
 * Find text nodes containing bare LaTeX and wrap them as `.kp` spans.
 * Skips code / pre / already-rendered KaTeX.
 * @param {HTMLElement} root
 */
function wrapBareLatexTextNodes(root: any) {
  if (typeof document === "undefined") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: any) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "PRE" || tag === "CODE" || tag === "SCRIPT" || tag === "STYLE") {
        return NodeFilter.FILTER_REJECT;
      }
      if (p.closest?.(".kp, .katex, .katex-error, .katex-raw, .katex-host")) {
        return NodeFilter.FILTER_REJECT;
      }
      const s = node.nodeValue || "";
      if (!s || s.length > 2000) return NodeFilter.FILTER_REJECT;
      if (!looksLikeBareLatex(s) && !splitBareLatexSegments(s).some(looksLikeBareLatex)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: any[] = [];
  let n: any;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const s = node.nodeValue || "";
    const frag = document.createDocumentFragment();
    let changed = false;
    const segs = dedupeSimilarMath(splitBareLatexSegments(s));
    for (const seg of segs) {
      for (const part of seg.split(CJK_SPLIT)) {
        if (!part) continue;
        if (/[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const t = part.trim();
        if (t.startsWith("\\begin") && COMPLETE_ENV_RE.test(t)) {
          const span = document.createElement("span");
          span.className = "kp";
          span.dataset.m = "d";
          span.textContent = t;
          frag.appendChild(span);
          changed = true;
          continue;
        }
        if (looksLikeBareLatex(t)) {
          const span = document.createElement("span");
          span.className = "kp";
          span.dataset.m = "i";
          span.textContent = t;
          frag.appendChild(span);
          changed = true;
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      }
    }
    if (changed) node.replaceWith(frag);
  }
}

/**
 * Walk the given container and render any `.kp` (KaTeX placeholder) spans.
 * Also picks up bare LaTeX left in text nodes (no `.kp` yet).
 * @param {HTMLElement} el - container element to scan
 */
export function renderLatexInElement(el: any) {
  if (!el) return;
  try {
    wrapBareLatexTextNodes(el);
  } catch { /* non-fatal */ }
  if (typeof katex === "undefined" || typeof katex.render !== "function") {
    return; // local vendor/katex.min.js should prevent this
  }
  el.querySelectorAll("span.kp").forEach((node: any) => {
    const span = /** @type {HTMLElement} */ (node);
    if (span.classList.contains("katex-host")) return; // already rendered
    const raw = span.textContent || "";
    let displayMode = span.dataset.m === "d";
    // Complete env always display; plain+env mix → display for the env body
    if (!displayMode && COMPLETE_ENV_RE.test(raw) && raw.trim().startsWith("\\begin")) {
      displayMode = true;
    }
    const tex = repairTex(raw);
    try {
      // throwOnError:false — render as much as possible; bad tokens get
      // .katex-error styling instead of dumping the whole formula raw.
      katex.render(tex, span, {
        displayMode,
        throwOnError: false,
        strict: false,
        errorColor: "#b91c1c",
      });
      span.classList.add("katex-host");
    } catch (_e) {
      const esc = escapeHtml(tex);
      span.outerHTML = displayMode
        ? `<div class="katex-raw katex-raw-block">\\[${esc}\\]</div>`
        : `<span class="katex-raw">\\(${esc}\\)</span>`;
    }
  });
}

/**
 * Auto-resize a textarea to fit its content. Always honors the CSS
 * min-height (set on #prompt-input, currently 30px) so an empty input
 * never collapses below the comfortable single-line height, then grows
 * up to the CSS max-height (200px) as content expands.
 * @param {HTMLTextAreaElement} textarea
 */
export function autoResize(textarea: any) {
  textarea.style.height = "auto";
  const minH = parseFloat(getComputedStyle(textarea).minHeight) || 0;
  const maxH = parseFloat(getComputedStyle(textarea).maxHeight) || Infinity;
  textarea.style.height = Math.max(minH, Math.min(maxH, textarea.scrollHeight)) + "px";
}

/**
 * Format a byte count as a short human-readable size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes: any) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Scroll the message list to the bottom.
 * Reads scrollHeight immediately before writing scrollTop so a forced
 * layout flush picks up the latest DOM (details collapse, actions, etc.).
 */
export function scrollToBottom() {
  const el = document.getElementById("message-list");
  if (!el) return;
  // Repair: conversation must stay a real scroll container. A residual
  // #chat-area.is-blank used to set overflow:visible + flex:none, which makes
  // scrollHeight===clientHeight and clips later content under #chat-area.
  if (el.querySelector(".message")) {
    document.getElementById("chat-area")?.classList.remove("is-blank");
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") {
      el.style.setProperty("overflow-y", "auto", "important");
      el.style.setProperty("flex", "1 1 0", "important");
      el.style.setProperty("min-height", "0", "important");
      // 兜底同样要覆盖 max-height：#chat-area.is-blank 态把 #message-list 设成
      // flex:0 1 auto + max-height:100%，若 is-blank 残留或 :has() 规则失效瞬间，
      // 列表会退化回内容撑高被 #chat-area 裁切（scrollHeight===clientHeight）。
      el.style.setProperty("max-height", "none", "important");
    }
  }
  const top = el.scrollHeight;
  if (el.scrollTop !== top) el.scrollTop = top;
}

/**
 * Stream auto-follow: snap to bottom ONLY when the user is already near it.
 * The streaming handlers used to call scrollToBottom() unconditionally on
 * every ~50ms render / reasoning chunk, which yanked the list back to the
 * bottom the instant the user tried to scroll up mid-stream.
 */
export function autoFollowScroll() {
  const el = document.getElementById("message-list");
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120) scrollToBottom();
}

/**
 * Re-assert bottom scroll across a short window so late layout (image
 * load, KaTeX fonts, details collapse) cannot leave scrollTop pinned to
 * a stale max while content still overflows.
 * @param {number} [durationMs]
 */
export function pinScrollBottom(durationMs = 400) {
  scrollToBottom();
  const start = performance.now();
  let raf = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  function onUserScroll() { stop(); }
  function stop() {
    cancelAnimationFrame(raf);
    if (timeout) clearTimeout(timeout);
    window.removeEventListener("wheel", onUserScroll);
  }
  const tick = () => {
    scrollToBottom();
    if (performance.now() - start < durationMs) {
      raf = requestAnimationFrame(tick);
    }
  };
  raf = requestAnimationFrame(tick);
  timeout = setTimeout(() => {
    scrollToBottom();
    stop();
  }, durationMs);
  // 用户一动滚轮就立刻让路：收尾 pin 不该和用户上下滚动搏斗几百 ms
  // （表现为"回答刚结束滚轮就滚不动"的起始卡顿）。
  window.addEventListener("wheel", onUserScroll, { passive: true });
  return () => {
    stop();
  };
}

/**
 * Set the status bar text.
 * @param {string} text
 */
export function setStatus(text: any) {
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
export function saveReasoningEnabled(enabled: any) {
  localStorage.setItem("AideAgent_reasoning_enabled", String(enabled));
}
