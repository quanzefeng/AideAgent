/**
 * 真实会话滚动诊断 v2：加载 sessions.db 里用户最近的会话（"最近有什么AI新闻?"），
 * 在真实 DOM 上先测【行为】（滚轮连发 / 滚动条拖拽），再测【布局】，
 * 最后 dump thinking 折叠态的真实结构（闭合 details 的子元素竟然有布局 → 需要证据）。
 *
 * 用户报告：对话收尾后只能往下拉一点点就卡住。截图显示 details 全部折叠。
 * 上一轮 scroll-diag（手工 DOM）布局健康 —— 本轮验证真实数据是否同样健康。
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
      try {
        app.process()?.stdout?.on("data", (d: Buffer) => console.log("[main]", String(d).replace(/\s+$/, "").slice(0, 400)));
        app.process()?.stderr?.on("data", (d: Buffer) => console.log("[main-err]", String(d).replace(/\s+$/, "").slice(0, 400)));
      } catch { /* stdio 不可用 */ }
      const window = await app.firstWindow({ timeout: 15_000 });
      window.on("console", (m: any) => {
        if (m.type() === "error") console.log("[page-console-error]", m.text());
      });
      window.on("pageerror", (e: any) => console.log("[pageerror]", String(e).slice(0, 300)));
      await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      const ready = await window.evaluate(() => document.readyState).catch((e: any) => `eval-fail: ${e}`);
      console.log(`[launch] attempt ${attempt} ok, document.readyState=${ready}`);
      if (ready !== "complete" && ready !== "interactive") throw new Error(`bad readyState: ${ready}`);
      await window.waitForTimeout(1000);
      return { app, window };
    } catch (e) {
      lastErr = e;
      console.log(`[launch] attempt ${attempt} failed: ${e}`);
      if (app) {
        try { await closeApp(app); } catch { /* ignore */ }
      }
    }
  }
  throw lastErr;
};

test("scroll-real: latest session behavior + layout", async () => {
  const { app, window } = await launchApp();

  // ── 0z) 调成用户实际窗口尺寸（截图 1917×1078 含任务栏 → 窗口 ≈1917×1030） ──
  await app.evaluate(({ BrowserWindow }: any) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.setSize(1917, 1030);
  });
  await window.waitForTimeout(600);

  await window.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
  });

  // ── 0a) 环境探针：localStorage / config-banner 状态 ──
  const env: any = await window.evaluate(() => {
    const banner: any = document.getElementById("config-banner");
    const br = banner ? banner.getBoundingClientRect() : null;
    return {
      origin: location.origin,
      apiUrl: localStorage.getItem("AideAgent_api_url"),
      provider: localStorage.getItem("AideAgent_provider"),
      storageKeys: Object.keys(localStorage).slice(0, 40),
      banner: banner
        ? { cls: banner.className, display: getComputedStyle(banner).display, rect: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null }
        : null,
    };
  });
  console.log("[real] env probe:", JSON.stringify(env, null, 1));

  await window.locator(".session-item").first().waitFor({ timeout: 15_000 });
  const named = window.locator(".session-item", { hasText: "AI新闻" });
  const item = (await named.count()) > 0 ? named.first() : window.locator(".session-item").first();
  await item.click();
  await window.waitForTimeout(2000);

  const getScroll = () =>
    window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);
  const resetScroll = () =>
    window.evaluate(() => {
      (document.getElementById("message-list") as any).scrollTop = 0;
    });

  // ── 0) 结构 dump（thinking 折叠态之谜 + finish 是否执行过） ──
  const dump: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    if (!ml) return { error: "no #message-list" };

    const thinkBodies = Array.from(ml.querySelectorAll(".thinking-body")).map((b: any) => {
      const p = b.parentElement;
      const cs = getComputedStyle(b);
      const pcs = getComputedStyle(p);
      return {
        parentTag: p.tagName,
        parentClass: p.className,
        parentHasOpen: p.hasAttribute("open"),
        parentDisplay: pcs.display,
        parentContentVis: pcs.contentVisibility,
        bodyDisplay: cs.display,
        bodyVis: cs.visibility,
        bodyContentVis: cs.contentVisibility,
        bodyRectH: Math.round(b.getBoundingClientRect().height),
        bodyClientH: b.clientHeight,
        bodyScrollH: b.scrollHeight,
        bodyOffsetParent: b.offsetParent ? b.offsetParent.tagName : null,
      };
    });

    // 对照实验：新建一个闭合 details（含 3000px 子元素），测子元素布局指标
    const ctrl = document.createElement("details");
    const ctrlDiv = document.createElement("div");
    ctrlDiv.textContent = "x".repeat(3000);
    ctrl.appendChild(ctrlDiv);
    document.body.appendChild(ctrl);
    const ctrlClosed = {
      hasOpen: ctrl.hasAttribute("open"),
      childClientH: ctrlDiv.clientHeight,
      childRectH: Math.round(ctrlDiv.getBoundingClientRect().height),
    };
    ctrl.open = true;
    const ctrlOpened = {
      hasOpen: ctrl.hasAttribute("open"),
      childClientH: ctrlDiv.clientHeight,
      childRectH: Math.round(ctrlDiv.getBoundingClientRect().height),
    };
    ctrl.remove();

    const msgs = Array.from(ml.querySelectorAll(".message"));
    return {
      messageCount: msgs.length,
      actionsCount: ml.querySelectorAll(".message-actions").length,
      tokenSpeedCount: ml.querySelectorAll(".token-speed").length,
      openDetailsCount: ml.querySelectorAll("details[open]").length,
      thinkingDetailsCount: ml.querySelectorAll("details.thinking-details").length,
      toolOpenCount: ml.querySelectorAll("details.tool-entry[open]").length,
      thinkBodies,
      ctrlClosed,
      ctrlOpened,
    };
  });
  console.log("[real] structure dump:", JSON.stringify(dump, null, 1));

  // ── 1) 行为：正文上滚轮 3 连发 ──
  await resetScroll();
  const mlBox = await window.locator("#message-list").boundingBox();
  const textBox = await window.locator(".message.assistant .message-text").first().boundingBox();
  if (!mlBox || !textBox) throw new Error("message-text/#message-list not found");
  const wx = textBox.x + Math.min(textBox.width / 2, 300);
  const wy = Math.min(Math.max(textBox.y + 40, mlBox.y + 30), mlBox.y + mlBox.height - 50);

  const textDeltas: number[] = [];
  let prev = await getScroll();
  for (let i = 0; i < 3; i++) {
    await window.mouse.move(wx, wy);
    await window.mouse.wheel(0, 500);
    await window.waitForTimeout(300);
    const now = await getScroll();
    textDeltas.push(now - prev);
    prev = now;
  }
  console.log(`[real] wheel TEXT x3 deltas: ${JSON.stringify(textDeltas)}`);

  // ── 2) 工具行 summary 上滚轮 ──
  await resetScroll();
  const toolDeltas: number[] = [];
  prev = await getScroll();
  const toolBox = await window.locator(".tool-entry summary").first().boundingBox();
  if (toolBox) {
    for (let i = 0; i < 2; i++) {
      await window.mouse.move(toolBox.x + Math.min(toolBox.width / 2, 300), toolBox.y + toolBox.height / 2);
      await window.mouse.wheel(0, 500);
      await window.waitForTimeout(300);
      const now = await getScroll();
      toolDeltas.push(now - prev);
      prev = now;
    }
  }
  console.log(`[real] wheel TOOL x2 deltas: ${JSON.stringify(toolDeltas)}`);

  // ── 3) 列表右侧空白区滚轮 ──
  await resetScroll();
  const r0 = await getScroll();
  await window.mouse.move(mlBox.x + mlBox.width - 30, mlBox.y + mlBox.height / 2);
  await window.mouse.wheel(0, 500);
  await window.waitForTimeout(300);
  const r1 = await getScroll();
  console.log(`[real] wheel RIGHT blank: delta=${r1 - r0}`);

  // ── 3b) 滚轮打在 config-banner（position:fixed 顶层条，测试实例里可见） ──
  const bannerBox = await window.locator("#config-banner").boundingBox().catch(() => null);
  let bannerDelta: any = "banner hidden";
  if (bannerBox) {
    await resetScroll();
    const b0 = await getScroll();
    await window.mouse.move(bannerBox.x + bannerBox.width / 2, bannerBox.y + bannerBox.height / 2);
    await window.mouse.wheel(0, 500);
    await window.waitForTimeout(300);
    bannerDelta = (await getScroll()) - b0;
  }
  console.log(`[real] wheel over BANNER: delta=${bannerDelta}`);

  // ── 3c) 底部带（#input-area，#chat-area overflow:hidden 内的兄弟块）滚轮 ──
  // 光标停在输入框/底部空白附近时，滚轮是否链到不可滚动祖先 → 死区
  const inputAreaBox = await window.locator("#input-area").boundingBox();
  let band: any = "no #input-area";
  if (inputAreaBox) {
    // (i) input-area 内、输入框外的右侧空白
    const bx = mlBox.x + mlBox.width - 80;
    const by = mlBox.y + mlBox.height + 40;
    const bandHit = await window.evaluate(([x, y]: any) => {
      return document.elementsFromPoint(x, y).slice(0, 4)
        .map(e => e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : ""));
    }, [bx, by]);
    await resetScroll();
    const b0 = await getScroll();
    await window.mouse.move(bx, by);
    await window.mouse.wheel(0, 500);
    await window.waitForTimeout(300);
    const bandDelta = (await getScroll()) - b0;

    // (ii) 光标压在输入 textarea 上
    const ta = window.locator("#prompt-input");
    const taBox = await ta.boundingBox();
    let taDelta: any = "no textarea";
    if (taBox) {
      await resetScroll();
      const t0 = await getScroll();
      await window.mouse.move(taBox.x + taBox.width / 2, taBox.y + taBox.height / 2);
      await window.mouse.wheel(0, 500);
      await window.waitForTimeout(300);
      taDelta = (await getScroll()) - t0;
    }
    band = { bx: Math.round(bx), by: Math.round(by), hit: bandHit, bandDelta, taDelta };
  }
  console.log(`[real] wheel over INPUT-AREA bottom band:`, JSON.stringify(band));

  // ── 4) 滚动条区域：命中�?+ 拖拽 thumb ──
  await resetScroll();
  const sbProbe: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    const r = ml.getBoundingClientRect();
    const stack = (x: number, y: number) =>
      document
        .elementsFromPoint(x, y)
        .slice(0, 5)
        .map(e => e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : ""));
    const cs = getComputedStyle(ml);
    let pseudoW = "n/a";
    try { pseudoW = getComputedStyle(ml, "::-webkit-scrollbar").width; } catch { /* 不支持 */ }
    const sl: any = document.getElementById("session-list") || document.querySelector(".session-list");
    return {
      atRightMinus3: stack(r.right - 3, r.y + 80),
      atRightMinus8: stack(r.right - 8, r.y + 200),
      // 滚动条占位：经典滚动条会占 offsetWidth-clientWidth；overlay = 0
      mlOffsetMinusClient: ml.offsetWidth - ml.clientWidth,
      webkitScrollbarWidth: pseudoW,
      standardScrollbarWidth: cs.scrollbarWidth,
      // 侧栏对照组（用户截图里侧栏 thumb 清晰可见）
      sidebar: sl ? { offsetMinusClient: sl.offsetWidth - sl.clientWidth, sh: sl.scrollHeight, ch: sl.clientHeight, id: sl.id, cls: sl.className } : null,
      sh: ml.scrollHeight,
      ch: ml.clientHeight,
    };
  });
  console.log("[real] scrollbar probe:", JSON.stringify(sbProbe, null, 1));

  // thumb 抓取矩阵：在 thumb 纵向跨度内取多个 y，逐个"抓-拖-读-放"，
  // 并记录抓取点的命中链（含 mouse.down 之后的命中），定位为什么抓不动
  const sbX = mlBox.x + mlBox.width - 3;
  const thumbH = Math.round((sbProbe.ch / sbProbe.sh) * sbProbe.ch); // 622²/5950 ≈ 65px
  console.log(`[real] expected thumb height ≈ ${thumbH}px at scrollTop=0`);
  const matrix: any[] = [];
  for (const yOff of [2, 8, 18, 32, 48, 60]) {
    await resetScroll();
    await window.waitForTimeout(120);
    const y = mlBox.y + yOff;
    const hitBefore = await window.evaluate(([x, yy]: any) => {
      const chain = document
        .elementsFromPoint(x, yy)
        .slice(0, 4)
        .map(e => e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : ""));
      return chain;
    }, [sbX, y]);
    const m0 = await getScroll();
    await window.mouse.move(sbX, y);
    await window.mouse.down();
    await window.mouse.move(sbX, y + 80, { steps: 5 });
    await window.waitForTimeout(120);
    const mMid = await getScroll();
    await window.mouse.up();
    await window.waitForTimeout(120);
    const mEnd = await getScroll();
    matrix.push({ yOff, hit: hitBefore[0], mid: Math.round(mMid - m0), end: Math.round(mEnd - m0) });
  }
  console.log("[real] thumb grab matrix:", JSON.stringify(matrix));

  // 轨道点击：thumb 下方 80% 处单击 → 应跳页
  await resetScroll();
  const trackY = mlBox.y + Math.round(mlBox.height * 0.8);
  await window.mouse.click(sbX, trackY);
  await window.waitForTimeout(300);
  const trackJump = await getScroll();
  console.log(`[real] track click @80%: scrollTop=${trackJump}`);

  // 侧栏 thumb 拖拽对照（截图里可见的那条）
  const sidebarBox = await window.locator(".session-list").boundingBox().catch(() => null);
  let sidebarDrag = "n/a";
  if (sidebarBox) {
    const s0 = await window.evaluate(() => {
      const sl: any = document.getElementById("session-list") || document.querySelector(".session-list");
      return sl ? sl.scrollTop : -1;
    });
    if (s0 >= 0) {
      const shv = await window.evaluate(() => {
        const sl: any = document.getElementById("session-list") || document.querySelector(".session-list");
        return sl ? sl.scrollHeight - sl.clientHeight : 0;
      });
      if (shv > 50) {
        await window.mouse.move(sidebarBox.x + sidebarBox.width - 3, sidebarBox.y + 15);
        await window.mouse.down();
        await window.mouse.move(sidebarBox.x + sidebarBox.width - 3, sidebarBox.y + 15 + 200, { steps: 8 });
        await window.mouse.up();
        await window.waitForTimeout(200);
        const s1 = await window.evaluate(() => {
          const sl: any = document.getElementById("session-list") || document.querySelector(".session-list");
          return sl ? sl.scrollTop : -1;
        });
        sidebarDrag = `${s0} → ${s1} (range=${shv})`;
      } else {
        sidebarDrag = `sidebar range too small: ${shv}`;
      }
    }
  }
  console.log(`[real] sidebar thumb drag: ${sidebarDrag}`);

  // ── 4b) 折叠 thinking 行的"隐藏滚动陷阱"验证 ──
  // 已知：闭合 details 的 .thinking-body 仍有 200px 布局盒 + 2254px 内部滚动量。
  // 关键问题：它可被命中吗？滚轮打在上面时，内部(不可见)先吃掉滚轮还是链到主列表？
  // 把内部 scrollTop 置顶（模拟用户先向上滚过）再打滚轮 —— 若主列表不动 = 复现用户卡死。
  const trap: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    ml.scrollTop = 0;
    const b: any = document.querySelector(".thinking-body");
    if (!b) return { error: "no .thinking-body" };
    const rb = b.getBoundingClientRect();
    const summary = b.parentElement.querySelector("summary");
    const rs = summary.getBoundingClientRect();
    b.scrollTop = 0; // 内部置顶
    const chain = document
      .elementsFromPoint(rb.x + rb.width / 2, rb.y + Math.min(20, rb.height / 2))
      .slice(0, 6)
      .map(e => e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : ""));
    return {
      summaryBottom: Math.round(rs.bottom),
      bodyTop: Math.round(rb.top),
      gap: Math.round(rb.top - rs.bottom), // 用户截图里思考行间距 ≈43px；若这里 ≈0 且 body 200px → 两环境矛盾
      bodyH: Math.round(rb.height),
      bodySH: b.scrollHeight,
      bodyScrollTop: b.scrollTop,
      hitChain: chain,
      hitIsBody: chain[0] && chain[0].includes("thinking-body"),
      messageListSH: ml.scrollHeight,
    };
  });
  console.log("[real] collapsed-thinking trap probe:", JSON.stringify(trap, null, 1));

  // 截图：思考行区域（与用户截图对比行间距）
  try {
    const firstSummary = await window.locator(".thinking-details summary").first().boundingBox();
    if (firstSummary) {
      await window.screenshot({
        path: "test-results/real-think-row.png",
        clip: {
          x: Math.max(0, firstSummary.x - 40),
          y: Math.max(0, firstSummary.y - 60),
          width: 900,
          height: 560,
        },
      });
    }
  } catch { /* 截图失败不阻断 */ }

  // 滚轮正中"折叠 thinking-body 区域"（内部已置顶）→ 主列表应能动，否则 = 用户卡死复现
  const trap0 = await getScroll();
  const bodyBox = await window.evaluate(() => {
    const b: any = document.querySelector(".thinking-body");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) };
  });
  if (bodyBox) {
    await window.mouse.move(bodyBox.x, bodyBox.y);
    await window.mouse.wheel(0, 500);
    await window.waitForTimeout(300);
  }
  const trap1 = await getScroll();
  console.log(`[real] wheel over COLLAPSED thinking-body (inner at top): ${trap0} → ${trap1} (delta=${trap1 - trap0})`);

  // ── 5) 布局（放最后，先拿行为数据） ──
  const layout: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    ml.scrollTop = 0;
    const cs = getComputedStyle(ml);
    const rMl = ml.getBoundingClientRect();
    const msgs: any[] = Array.from(ml.querySelectorAll(".message"));
    const last: any = msgs[msgs.length - 1];
    const padB = parseFloat(cs.paddingBottom) || 0;
    const expectedRange = last
      ? Math.max(0, Math.round(last.getBoundingClientRect().bottom - rMl.top + padB - rMl.height))
      : null;
    return {
      range: ml.scrollHeight - ml.clientHeight,
      expectedRange,
      sh: ml.scrollHeight,
      ch: ml.clientHeight,
      flex: cs.flex,
      minH: cs.minHeight,
      overflowY: cs.overflowY,
      scrollTopAfterReset: ml.scrollTop,
    };
  });
  console.log("[real] layout:", JSON.stringify(layout, null, 1));

  // ── 断言 ──
  expect(dump.messageCount).toBeGreaterThan(0);
  // finishAssistantMessage 执行过（actions 已加）
  expect(dump.actionsCount).toBeGreaterThan(0);
  // 布局健康：滚动量覆盖真实内容底边
  expect(Math.abs(layout.range - layout.expectedRange)).toBeLessThan(60);
  expect(layout.overflowY).toBe("auto");
  expect(layout.minH).toBe("0px");
  // 行为健康：每个测试位置的滚轮都要能推动主列表
  expect(textDeltas.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  if (toolDeltas.length > 0) {
    expect(toolDeltas.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  }
  expect(r1 - r0).toBeGreaterThan(100);
  // 底部带（输入区）滚轮必须转发给 #message-list（曾是死区：delta=0）
  if (inputAreaBox) {
    expect(band.bandDelta).toBeGreaterThan(100);
    expect(band.taDelta).toBeGreaterThan(100);
  }
  // config-banner（position:fixed 盖顶）不得吞掉滚轮 —— pointer-events:none 修复后应穿透
  if (bannerBox) {
    expect(typeof bannerDelta).toBe("number");
    expect(bannerDelta).toBeGreaterThan(100);
  }
  // thumb 拖拽：矩阵里【每一个】y（含 banner 曾压住的 y2-48 顶部区）都必须能抓动
  const grabs = matrix.map((m: any) => Math.max(m.mid, m.end));
  const bestGrab = Math.max(...grabs);
  const minGrab = Math.min(...grabs);
  console.log(`[real] thumb grab across matrix: best=${bestGrab} min=${minGrab}`);
  expect(minGrab).toBeGreaterThan(100);
  // 折叠 thinking 行区域的滚轮不得被"看不见的内部滚动"吃掉（用户"拉不下去"的假想根因）
  if (bodyBox) {
    expect(trap1 - trap0).toBeGreaterThan(100);
  }

  await closeApp(app);
});
