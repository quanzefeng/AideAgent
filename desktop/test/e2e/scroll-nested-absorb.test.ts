/**
 * 回归：消息列表内不得存在纵向嵌套滚动容器（滚轮必须直接滚主列表）
 *
 * 用户症状：agent 回答结束后滚轮滑不动、看不到下面内容；切到别的会话再切回来
 * 就恢复。根因（实测）：.thinking-body(max-height:200px;overflow-y:auto) 装的是
 * 完整未截断的 reasoning，.tool-entry-body(160px) 是工具结果 —— 展开后它们是
 * 数百到数千 px 余量的纵向 scroller，滚轮先被它们吃掉，主列表要等它滚到边才动。
 * 实测数据（修复前）：
 *   .tool-entry-body  range=1845 → 连滚 6 格(720px) 主列表 delta=0，内部吸收 720
 *   .thinking-body    range=494  → 连滚 6 格 主列表 delta=120（5/6 格被吞）
 * 切会话走 rebuildMessages → details 全折叠 → 嵌套容器消失 → 恢复（症状 S3）。
 *
 * 修复：style.css 里 .thinking-body / .tool-entry-body / .resume-banner pre 不再
 * 限高滚动（与既有的 .message-text pre { overflow-y:hidden } 同一约定）。
 * 本用例把四种光标位置都测一遍，并要求消息列表内没有任何纵向 scroller。
 */
import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = { ...process.env, ELECTRON_DISABLE_SANDBOX: "1", NODE_ENV: "test", AIDEAGENT_TEST_MODE: "1" };

const killApp = (app: any) => {
  try { const p = app?.process?.(); if (p && !p.killed) p.kill("SIGKILL"); } catch { /* 已退出 */ }
};
const closeApp = async (app: any) => {
  if (!app) return;
  try {
    await Promise.race([app.close(), new Promise((_, r) => setTimeout(() => r(new Error("close-timeout")), 5000))]);
  } catch { killApp(app); }
};
const launchApp = async () => {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let app: any = null;
    try {
      app = await electron.launch({ args: ["."], env: testEnv, timeout: 30_000 });
      const window = await app.firstWindow({ timeout: 15_000 });
      await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      const ready = await window.evaluate(() => document.readyState).catch(() => "fail");
      if (ready !== "complete" && ready !== "interactive") throw new Error(`bad readyState: ${ready}`);
      await window.waitForTimeout(1000);
      return { app, window };
    } catch (e) {
      lastErr = e;
      if (app) { try { await closeApp(app); } catch { /* ignore */ } }
    }
  }
  throw lastErr;
};

test("no vertical nested scroller inside #message-list", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp();

  const setup: any = await window.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    const ml: any = document.getElementById("message-list");
    document.getElementById("chat-area")?.classList.remove("is-blank");
    ml.innerHTML = "";
    const para = (n: number) =>
      Array.from({ length: n }, (_, i) => `<p>第 ${i + 1} 段正文，用于撑开对话列表高度，含中文与 English words。</p>`).join("");
    // 真实 reasoning 体量：完整未截断（reasoning_effort:high 下数千字很常见）
    const longReasoning = "推理：先确认用户意图，再决定要读哪些文件、调用哪些工具，然后组织答案。".repeat(160);
    // 工具结果按 200 字截断、参数按 120 字截断（app.ts 的 slice），展开后只有几行
    const toolResult = "package.json 前 200 字：{ \"name\": \"aideagent-desktop\", \"version\": \"1.0.36\", \"type\": \"module\", \"main\": \"main.ts\", \"scripts\": { \"start\": \"electron .\" } }";
    const code = Array.from({ length: 40 }, (_, i) => `const line${i} = computeSomething(${i}) + anotherVeryLongExpressionToForceHorizontalOverflow(${i * 97});`).join("\n");
    for (let i = 0; i < 5; i++) {
      const a = document.createElement("div");
      a.className = "message assistant";
      a.innerHTML = `
        <div class="message-label">AIDEAGENT</div>
        <div class="message-content">
          <details class="thinking-details"><summary class="thinking-summary">💭 思考过程</summary><div class="thinking-body"><div class="thinking-text">${longReasoning}</div></div></details>
          <details class="tool-entry"><summary class="tool-entry-head">🔧 file_read</summary><div class="tool-entry-body"><div class="tool-entry-args"><span class="tool-arg"><span class="tool-arg-key">path</span><span class="tool-arg-val">renderer/app.ts</span></span></div><div class="tool-entry-result"><span class="tool-result-ok">${toolResult}</span></div></div></details>
          <div class="message-text">${para(4)}<pre><code class="language-javascript">${code}</code></pre>${para(4)}<div class="katex-display">E=mc^2 ${"\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}".repeat(6)}</div><table><thead><tr><th>列A</th><th>列B</th><th>列C</th></tr></thead><tbody>${Array.from({ length: 6 }, (_, r) => `<tr><td>行${r + 1}甲</td><td>行${r + 1}乙</td><td>行${r + 1}丙</td></tr>`).join("")}</tbody></table><p>超长单行内联代码：<code>${"someVeryLongIdentifier.chainCall().anotherSegment().more().end();".repeat(4)}</code></p></div>
        </div>`;
      ml.appendChild(a);
    }
    // resume-banner 也在 #message-list 内（app.ts getTurnProgress 分支）
    const banner = document.createElement("div");
    banner.className = "resume-banner";
    banner.innerHTML = `<details><summary>查看上次摘要</summary><pre>${"上次中断时的摘要文本。".repeat(60)}</pre></details>`;
    ml.insertBefore(banner, ml.firstChild);

    ml.querySelectorAll("details").forEach((d: any) => d.setAttribute("open", ""));
    ml.scrollTop = 0;
    return { mlRange: ml.scrollHeight - ml.clientHeight };
  });
  console.log("[nest] setup mlRange=", setup.mlRange);
  expect(setup.mlRange).toBeGreaterThan(1000);

  // ── 1) 消息列表内不允许存在纵向可滚动容器（含 pre / banner pre / 任意后代）──
  const scrollers: any[] = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    const out: any[] = [];
    for (const node of ml.querySelectorAll("*")) {
      const el = node as HTMLElement;
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "hidden") && el.scrollHeight > el.clientHeight + 1) {
        out.push({ cls: el.className || el.tagName, sh: el.scrollHeight, ch: el.clientHeight, oy, range: el.scrollHeight - el.clientHeight });
      }
    }
    return out.slice(0, 10);
  });
  console.log("[nest] vertical scrollable descendants:", JSON.stringify(scrollers));

  // ── 2) 四种光标位置，各连滚 6 格 dy=120，主列表必须立刻移动 ──
  const mlScroll = () => window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);
  const probe = async (label: string, sel: string) => {
    await window.evaluate(() => { (document.getElementById("message-list") as any).scrollTop = 0; });
    await window.waitForTimeout(200);
    // 先把目标滚进视口，再取它自身可见范围内的一点 —— 否则展开的 thinking-body
    // 比视口还高，clamp 后所有探针都会落在它上面（v1 的探针缺陷）。
    await window.locator(sel).first().scrollIntoViewIfNeeded();
    await window.waitForTimeout(150);
    const box = await window.locator(sel).first().boundingBox();
    const mlBox = await window.locator("#message-list").boundingBox();
    if (!box || !mlBox) { console.log(`[nest] ${label}: no box`); return { label, delta: 0, hit: [] as string[], sel }; }
    const x = box.x + Math.min(box.width / 2, 200);
    const y = Math.min(Math.max(box.y + Math.min(box.height / 2, 60), mlBox.y + 20), mlBox.y + mlBox.height - 30);
    const hit: string[] = await window.evaluate(([px, py]: any) =>
      document.elementsFromPoint(px, py).slice(0, 4).map((e: any) => e.tagName + "." + (typeof e.className === "string" ? String(e.className).split(" ").join(".") : "")), [x, y]);
    const before = await mlScroll();
    await window.mouse.move(x, y);
    for (let i = 0; i < 6; i++) { await window.mouse.wheel(0, 120); await window.waitForTimeout(150); }
    const after = await mlScroll();
    console.log(`[nest] ${label}: delta=${Math.round(after - before)} hit=${JSON.stringify(hit.slice(0, 2))}`);
    return { label, delta: after - before, hit, sel };
  };

  const thinking = await probe("over .thinking-body", ".thinking-body");
  const tool = await probe("over .tool-entry-body", ".tool-entry-body");
  const code = await probe("over pre code", ".message-text pre code");
  const banner = await probe("over .resume-banner pre", ".resume-banner pre");
  const plain = await probe("over .message-text", ".message-text p");
  const katex = await probe("over .katex-display", ".katex-display");

  await closeApp(app);

  // 探针必须真的命中目标（否则测的不是这个位置）
  const hitExpect: Record<string, string> = {
    ".thinking-body": "thinking-body",
    ".tool-entry-body": "tool-entry",
    ".message-text pre code": "PRE",
    ".resume-banner pre": "PRE",
    ".message-text p": "message-text",
    ".katex-display": "katex-display",
  };
  for (const p of [thinking, tool, code, banner, plain, katex]) {
    const want = hitExpect[p.sel];
    expect(p.hit.join(" "), `${p.label} 光标应命中 ${want}（实际 ${JSON.stringify(p.hit)}）`).toContain(want);
  }

  expect(scrollers, `消息列表内存在纵向可滚动容器（会吞滚轮）: ${JSON.stringify(scrollers)}`).toEqual([]);
  for (const p of [thinking, tool, code, banner, plain, katex]) {
    expect(p.delta, `${p.label} 上连滚 6 格(720px) 主列表必须已移动`).toBeGreaterThan(500);
  }
});
