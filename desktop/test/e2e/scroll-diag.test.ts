/**
 * 滚动卡死诊断：对话收尾后主列表滚不动
 *
 * 场景拆成可独立测量的两段：
 *  1) 收尾后的设计态 —— 所有 details 折叠，纯正文 → 主列表应该能正常滚
 *  2) 用户展开 💭思考 / 工具结果后 —— 嵌套滚动条 + overscroll-behavior:contain
 *     是否吞掉滚轮（光标悬停其上时主列表纹丝不动）
 * 若 1 正常 + 2 被吞 → 根因 = 嵌套滚动冲突（与用户猜测一致）。
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
  const app = await electron.launch({ args: ["."], env: testEnv, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  await window.waitForTimeout(1000);
  return { app, window };
};

test("scroll diag: finished-state range + wheel over nested scrollers", async () => {
  const { app, window } = await launchApp();

  // ── 1) 搭一段"对话刚结束"的真实 DOM（details 全部折叠） ──
  const setup: any = await window.evaluate(() => {
    // 测试环境里开机动画可能还没结束（全屏 z-index:2000 盖层会吞掉所有
    // 指针事件）——真实用户在启动结束后不会遇到，这里直接移除以测量真实布局。
    document.getElementById("boot-screen")?.remove();
    const ml: any = document.getElementById("message-list");
    const area = document.getElementById("chat-area");
    if (area) area.classList.remove("is-blank");
    ml.innerHTML = "";
    const para = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        `<p>第 ${i + 1} 段：这是用于撑开消息高度的正文内容，包含中文与 English words，模拟真实回答的排版高度。</p>`
      ).join("");
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
          <details class="tool-entry"><summary class="tool-entry-head">🔧 tool</summary><div class="tool-entry-body"><div class="tool-entry-result">${"工具运行结果片段。".repeat(30)}</div></div></details>
          <div class="message-text">${para(16)}</div>
          <div class="message-actions"><button class="msg-action-btn">复制</button></div>
        </div>`;
      ml.appendChild(a);
    }
    ml.scrollTop = 0;
    const cs = getComputedStyle(ml);
    return {
      range: ml.scrollHeight - ml.clientHeight,
      sh: ml.scrollHeight,
      ch: ml.clientHeight,
      overflowY: cs.overflowY,
      flex: cs.flex,
      minH: cs.minHeight,
      scrollTop: ml.scrollTop,
    };
  });
  console.log("[diag] finished-state layout:", JSON.stringify(setup));
  expect(setup.overflowY).toBe("auto");
  // 收尾设计态必须有真实滚动量（否则就是老 bug：scrollHeight===clientHeight）
  expect(setup.range).toBeGreaterThan(500);

  const getScroll = () =>
    window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);

  const wheelAt = async (x: number, y: number, dy = 600) => {
    await window.mouse.move(x, y);
    await window.mouse.wheel(0, dy);
    await window.waitForTimeout(250);
    return getScroll();
  };

  // ── 0) 对照组：页面里塞一个独立滚动 div，验证 mouse.wheel 本身可用 ──
  const control: any = await window.evaluate(() => {
    const d = document.createElement("div");
    d.id = "tst-scroller";
    d.style.cssText = "position:fixed;right:20px;top:20px;width:80px;height:80px;overflow:auto;z-index:9999;background:#ffe;";
    d.innerHTML = '<div style="height:2000px"></div>';
    document.body.appendChild(d);
    return { focused: document.hasFocus() };
  });
  const ctrlBox = await window.locator("#tst-scroller").boundingBox();
  if (ctrlBox) {
    await window.mouse.move(ctrlBox.x + 40, ctrlBox.y + 40);
    await window.mouse.wheel(0, 300);
    await window.waitForTimeout(250);
  }
  const ctrlScroll = await window.evaluate(
    () => (document.getElementById("tst-scroller") as any).scrollTop
  );
  console.log(`[diag] CONTROL wheel over fixed scroller: scrollTop=${ctrlScroll} focused=${control.focused}`);
  // 记录光标下到底是什么元素
  const hit: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    ml.scrollTop = 0;
    const tb = document.querySelector(".message.assistant .message-text") as any;
    const r = tb.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + Math.min(60, r.height / 2);
    const el = document.elementFromPoint(x, y);
    const chain: string[] = [];
    let n: any = el;
    while (n && n !== document.body) {
      chain.push(`${n.tagName}.${n.className || ""}#id=${n.id || ""}`);
      n = n.parentElement;
    }
    return { x, y, chain, hasFocus: document.hasFocus() };
  });
  console.log("[diag] elementFromPoint chain:", JSON.stringify(hit, null, 1));

  // ── 2) 光标悬在"纯正文"上滚轮 → 主列表应该动 ──
  const textBox = await window.locator(".message.assistant .message-text").first().boundingBox();
  if (!textBox) throw new Error("message-text not found");
  const plain0 = await getScroll();
  const plain1 = await wheelAt(textBox.x + textBox.width / 2, textBox.y + Math.min(60, textBox.height / 2));
  console.log(`[diag] wheel over PLAIN text: ${plain0} → ${plain1}`);
  if (ctrlScroll > 0) {
    // 滚轮机制可用 → 主列表不动就是应用内的滚动链问题
    expect(plain1 - plain0).toBeGreaterThan(100);
  }

  // ── 3) 展开思考块 → 把内部滚动推到边界 → 再滚轮 ──
  // 边界态判定：overscroll-behavior:contain 会阻断向主列表的链路（delta=0），
  // 去掉 contain 后余量应链到主列表（delta>0）。这就是"展开思考后滑不动"的根因。
  await window.evaluate(() => {
    (document.getElementById("message-list") as any).scrollTop = 0;
  });
  await window.locator(".message.assistant .thinking-details summary").first().click();
  await window.waitForTimeout(200);
  const thinkBox = await window.locator(".thinking-body").first().boundingBox();
  if (!thinkBox) throw new Error("thinking-body not found (details not open?)");
  const innerAtEdge = await window.evaluate(() => {
    const tb: any = document.querySelector(".thinking-body");
    tb.scrollTop = tb.scrollHeight;
    return { scrollTop: tb.scrollTop, scrollHeight: tb.scrollHeight, clientHeight: tb.clientHeight };
  });
  const think0 = await getScroll();
  const think1 = await wheelAt(thinkBox.x + thinkBox.width / 2, thinkBox.y + Math.min(100, thinkBox.height / 2));
  console.log(`[diag] wheel at INNER EDGE of thinking-body ${JSON.stringify(innerAtEdge)}: main ${think0} → ${think1} (delta=${think1 - think0})`);

  // ── 4) 收起思考 → 同一位置滚轮恢复 → 证明卡死由展开态引起 ──
  await window.locator(".message.assistant .thinking-details summary").first().click();
  await window.waitForTimeout(200);
  const textBox2 = await window.locator(".message.assistant .message-text").first().boundingBox();
  if (!textBox2) throw new Error("message-text not found after close");
  const rec0 = await getScroll();
  const rec1 = await wheelAt(textBox2.x + textBox2.width / 2, textBox2.y + Math.min(60, textBox2.height / 2));
  console.log(`[diag] wheel after COLLAPSE: ${rec0} → ${rec1} (delta=${rec1 - rec0})`);
  expect(rec1 - rec0).toBeGreaterThan(100);

  // ── 5) 展开工具结果 → 内部滚到底 → 再滚轮 → 是否被吞 ──
  await window.evaluate(() => {
    (document.getElementById("message-list") as any).scrollTop = 0;
  });
  await window.locator(".message.assistant .tool-entry summary").first().click();
  await window.waitForTimeout(200);
  const toolBox = await window.locator(".tool-entry-body").first().boundingBox();
  if (!toolBox) throw new Error("tool-entry-body not found (details not open?)");
  const toolInner = await window.evaluate(() => {
    const tb: any = document.querySelector(".tool-entry-body");
    tb.scrollTop = tb.scrollHeight;
    return { scrollTop: tb.scrollTop, scrollHeight: tb.scrollHeight, clientHeight: tb.clientHeight };
  });
  const tool0 = await getScroll();
  const tool1 = await wheelAt(toolBox.x + toolBox.width / 2, toolBox.y + Math.min(80, toolBox.height / 2));
  console.log(`[diag] wheel at INNER EDGE of tool-entry-body ${JSON.stringify(toolInner)}: main ${tool0} → ${tool1} (delta=${tool1 - tool0})`);

  // ── 判定：修复（去掉 overscroll-behavior:contain）后 ──
  // 内部处于边界时，滚轮必须链到主列表；否则用户"展开思考后滑不下来"。
  expect(think1 - think0).toBeGreaterThan(100);
  expect(tool1 - tool0).toBeGreaterThan(100);

  await closeApp(app);
});
