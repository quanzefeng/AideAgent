/**
 * 展开态滚轮验证（修复 1-3 的效果验证）
 *
 * 用户报告：agent 回答结束后滚轮滑不动，切走再切回才恢复。根因之一是
 * 展开的 .thinking-body / .tool-entry-body 作为嵌套滚动容器吞掉滚轮。
 *
 * 本用例测三种内部容器形态，并给出"原生链路 vs 手动转发"的对照，
 * 用来判定 capture 兜底转发是否会造成双倍滚动：
 *   A) 对照组：不匹配兜底选择器的假滚动容器（纯浏览器原生行为）
 *   B) 目标组：匹配兜底选择器的假滚动容器（内容 ≤ max-height，无滚动余量）
 *   C) 真滚动容器：有滚动余量 → 内部先滚，到边链回主列表
 *   D) 真实小 delta：触控板式连续 20 次 dy=24，主列表必须在有限次数内动起来
 */
import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const killApp = (app: any) => {
  try {
    const proc = app?.process?.();
    if (proc && !proc.killed) proc.kill("SIGKILL");
  } catch { /* 已退出 */ }
};

const closeApp = async (app: any) => {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close-timeout")), 5000)),
    ]);
  } catch {
    killApp(app);
  }
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

test("scroll-expand: expanded nested scrollers must not freeze the main list", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp();

  // ── 1) 搭"对话刚结束"的真实形态 DOM：thinking 长文本(真滚动容器) + 工具块短结果(假滚动容器) ──
  const setup: any = await window.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    const ml: any = document.getElementById("message-list");
    const area = document.getElementById("chat-area");
    if (area) area.classList.remove("is-blank");
    ml.innerHTML = "";
    const para = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        `<p>第 ${i + 1} 段：用于撑开消息高度的正文内容，包含中文与 English words，模拟真实回答排版。</p>`).join("");
    for (let i = 0; i < 4; i++) {
      const u = document.createElement("div");
      u.className = "message user";
      u.innerHTML = `<div class="message-label">USER</div><div class="message-bubble"><p>问题 ${i + 1}</p></div>`;
      ml.appendChild(u);
      const a = document.createElement("div");
      a.className = "message assistant";
      a.innerHTML = `
        <div class="message-label">AIDEAGENT</div>
        <div class="message-content">
          <details class="thinking-details"><summary class="thinking-summary">💭 思考过程</summary><div class="thinking-body"><div class="thinking-text">${"思考内容：分析用户意图并决定下一步。\n".repeat(40)}</div></div></details>
          <details class="tool-entry"><summary class="tool-entry-head">🔧 tool</summary><div class="tool-entry-body"><div class="tool-entry-args"><span class="tool-arg"><span class="tool-arg-key">path</span><span class="tool-arg-val">a.txt</span></span></div><div class="tool-entry-result"><span class="tool-result-ok">短结果</span></div></div></details>
          <div class="message-text">${para(16)}</div>
          <div class="message-actions"><button class="msg-action-btn">复制</button></div>
        </div>`;
      ml.appendChild(a);
    }
    // 对照组：同样是无滚动余量的 overflow-y:auto 容器，但类名不匹配兜底选择器
    // → 只走浏览器原生链路，用来标定"原生到底滚多少"
    const ctl = document.createElement("div");
    ctl.className = "probe-ctl-body";
    ctl.style.cssText = "max-height:160px;overflow-y:auto;padding:4px 0;";
    ctl.innerHTML = `<div class="message-text" style="font-size:11px">对照容器：内容很短，无滚动余量。</div>`;
    (ml.querySelector(".message.assistant .message-content") as any).prepend(ctl);

    ml.scrollTop = 0;
    const cs = getComputedStyle(ml);
    return {
      range: ml.scrollHeight - ml.clientHeight,
      overflowY: cs.overflowY,
      minH: cs.minHeight,
      maxHeight: cs.maxHeight,
    };
  });
  console.log("[expand] setup:", JSON.stringify(setup));
  expect(setup.overflowY).toBe("auto");
  expect(setup.range).toBeGreaterThan(500);

  const getScroll = () => window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);
  const reset = () => window.evaluate(() => { (document.getElementById("message-list") as any).scrollTop = 0; });

  const wheelOver = async (sel: string, dy: number, notches = 1) => {
    await reset();
    await window.waitForTimeout(120);
    const box = await window.locator(sel).first().boundingBox();
    if (!box) throw new Error(`no box for ${sel}`);
    const mlBox = await window.locator("#message-list").boundingBox();
    const x = box.x + Math.min(box.width / 2, 200);
    const y = Math.min(Math.max(box.y + 20, mlBox!.y + 30), mlBox!.y + mlBox!.height - 50);
    const hit: string[] = await window.evaluate(([px, py]: any) =>
      document.elementsFromPoint(px, py).slice(0, 3).map((e: any) =>
        e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : "")),
      [x, y]);
    const before = await getScroll();
    await window.mouse.move(x, y);
    for (let i = 0; i < notches; i++) {
      await window.mouse.wheel(0, dy);
      await window.waitForTimeout(120);
    }
    await window.waitForTimeout(200);
    const after = await getScroll();
    return { delta: after - before, hit };
  };

  // ── A) 对照组：无余量容器（纯原生链路）──
  const ctlRes = await wheelOver(".probe-ctl-body", 500);
  console.log(`[expand] A control (no-range, native only): delta=${ctlRes.delta} hit=${JSON.stringify(ctlRes.hit)}`);

  // ── B) 目标组：展开工具块（短结果 → 假滚动容器，匹配兜底选择器）──
  await window.locator(".message.assistant .tool-entry summary").first().click();
  await window.waitForTimeout(200);
  const toolShape: any = await window.evaluate(() => {
    const tb: any = document.querySelector(".tool-entry-body");
    return { sh: tb.scrollHeight, ch: tb.clientHeight, fake: tb.scrollHeight <= tb.clientHeight + 1 };
  });
  const toolRes = await wheelOver(".tool-entry-body", 500);
  console.log(`[expand] B fake-scroller (.tool-entry-body) ${JSON.stringify(toolShape)}: delta=${toolRes.delta} hit=${JSON.stringify(toolRes.hit)}`);

  // ── C) 展开 thinking（长文本）：修复后它不再是纵向 scroller，
  //        第一格滚轮就必须直接移动主列表（旧断言"内部先滚"已作废）──
  await window.locator(".message.assistant .thinking-details summary").first().click();
  await window.waitForTimeout(200);
  const thinkShape: any = await window.evaluate(() => {
    const tb: any = document.querySelector(".thinking-body");
    return { sh: tb.scrollHeight, ch: tb.clientHeight, real: tb.scrollHeight > tb.clientHeight + 1 };
  });
  expect(thinkShape.real, ".thinking-body 不应再有纵向滚动余量").toBe(false);
  const thinkFirst = await wheelOver(".thinking-body", 500, 1);
  console.log(`[expand] C expanded thinking (no inner scroller): delta=${thinkFirst.delta} hit=${JSON.stringify(thinkFirst.hit)}`);

  // ── D) 真实小 delta：连续 20 次 dy=24 悬停在真滚动容器上，主列表必须动起来 ──
  const smallRes = await wheelOver(".thinking-body", 24, 20);
  console.log(`[expand] D small-delta x20 over real scroller: delta=${smallRes.delta}`);

  // ── E) 折叠态回归：收起所有 details 后滚轮必须正常 ──
  await window.evaluate(() => {
    document.querySelectorAll(".thinking-details[open], .tool-entry[open]").forEach(d => d.removeAttribute("open"));
  });
  const collapsedRes = await wheelOver(".message.assistant .message-text", 500);
  console.log(`[expand] E collapsed plain text: delta=${collapsedRes.delta}`);

  console.log(`[expand] VERDICT ctl=${ctlRes.delta} fake=${toolRes.delta} ratio=${(toolRes.delta / (ctlRes.delta || 1)).toFixed(2)}`);

  // ── 断言 ──
  expect(ctlRes.delta, "对照组：原生链路应可滚").toBeGreaterThan(100);
  expect(toolRes.delta, "B 假滚动容器上滚轮必须让主列表动").toBeGreaterThan(100);
  expect(thinkFirst.delta, "C 展开思考块后第一格滚轮必须直接移动主列表").toBeGreaterThan(100);
  expect(smallRes.delta, "D 真实小 delta 连续滚动必须让主列表动").toBeGreaterThan(100);
  expect(collapsedRes.delta, "E 折叠态滚轮必须正常").toBeGreaterThan(100);

  await closeApp(app);
});
