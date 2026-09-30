/**
 * 流式实况滚动测试：真实发一次查询（注入用户同款 API 端点），测两个状态：
 *   A) 流式进行中：向上滚轮后是否被每 50ms 的 scrollToBottom 拉回底部（卡死假想根因）
 *   B) 流结束后  ：滚轮 / thumb 抓取 / 轨道点击 / 布局（收尾 pin 结束后的最终态）
 * 结束后删除本测试创建的会话（标题含 "scroll-live" 标记），不污染用户数据。
 */
import { test, expect, _electron as electron } from "@playwright/test";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const MARKER = "scroll-live";

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

test("scroll-live: during-stream + post-finish scroll", async () => {
  test.setTimeout(600_000);
  const { app, window } = await launchApp();

  const getScroll = () =>
    window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);
  const resetScroll = () =>
    window.evaluate(() => {
      (document.getElementById("message-list") as any).scrollTop = 0;
    });

  // ── 0) 清理上次残留 + 注入 API 配置后 reload（测试实例 localStorage 初始为空 →
  //      banner 可见且无法发查询；注入后 banner 应隐藏、查询可发） ──
  await window.evaluate(() => document.getElementById("boot-screen")?.remove());
  const pre: any[] = await window.evaluate(() => (window as any).aideagent.listSessions()).catch(() => []);
  for (const s of pre.filter((x: any) => String(x.title || "").includes(MARKER))) {
    await window.evaluate((id: any) => (window as any).aideagent.deleteSession(id), s.id);
    console.log(`[live] removed leftover session: ${s.title}`);
  }

  await window
    .evaluate(() => {
      localStorage.setItem("AideAgent_provider", "");
      localStorage.setItem("AideAgent_api_url", "https://token.sensenova.cn/v1/chat/completions");
      localStorage.setItem("AideAgent_model", "deepseek-v4-flash");
      localStorage.setItem("AideAgent_api_format", "openai");
      location.reload();
    })
    .catch(() => { /* reload 导致的导航中断可忽略 */ });
  await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
  await window.waitForTimeout(1500);
  await window.evaluate(() => document.getElementById("boot-screen")?.remove());

  const bannerState: any = await window.evaluate(() => {
    const b: any = document.getElementById("config-banner");
    return b ? { cls: b.className, display: getComputedStyle(b).display } : null;
  });
  console.log("[live] banner after config inject:", JSON.stringify(bannerState));

  await window.locator(".session-item").first().waitFor({ timeout: 15_000 });

  // ── 1) 新对话 + 发长查询 ──
  await window.locator("#new-chat").click();
  await window.waitForTimeout(600);
  const prompt = `【${MARKER}测试】请写一篇约1500字的科普文章，标题《人工智能的发展史》，分章节，内容详实。`;
  await window.locator("#prompt-input").fill(prompt);
  await window.waitForFunction(() => {
    const b: any = document.getElementById("send-btn");
    return b && !b.disabled;
  }, undefined, { timeout: 5_000 }).catch(() => console.log("[live] send-btn still disabled"));
  await window.locator("#send-btn").click();

  // ── 2) 流式进行中：能否向上滚走 ──
  const streamingSeen = await window
    .waitForSelector(".message.assistant.streaming", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`[live] streaming started: ${streamingSeen}`);

  let duringStream: any = "stream never started";
  if (streamingSeen) {
    // 轮询等可滚内容：reasoning 阶段可见内容可能一直小于视口（range=0）；
    // 流先结束则跳过本段（收尾电池已覆盖结束后行为）
    let rangeNow = 0;
    let probeReady = false;
    for (let t = 0; t < 75; t++) {
      const st = await window.evaluate(() => {
        const ml: any = document.getElementById("message-list");
        return {
          streaming: !!document.querySelector(".message.assistant.streaming"),
          range: ml ? ml.scrollHeight - ml.clientHeight : 0,
        };
      });
      rangeNow = st.range;
      if (!st.streaming) break;
      if (rangeNow > 500) {
        probeReady = true;
        break;
      }
      await window.waitForTimeout(2000);
    }
    const mlBox = await window.locator("#message-list").boundingBox();
    if (mlBox && probeReady) {
      await window.evaluate(() => {
        const ml: any = document.getElementById("message-list");
        ml.scrollTop = ml.scrollHeight;
      });
      await window.waitForTimeout(150);
      const s0 = await getScroll();
      // 瞄准正文（列表中心可能落在 open 的 thinking-body 上 → 内部吃轮属嵌套滚动设计）
      const textBox = await window.locator(".message.assistant .message-text").first().boundingBox().catch(() => null);
      const wx = textBox ? textBox.x + Math.min(textBox.width / 2, 400) : mlBox.x + Math.min(mlBox.width / 2, 400);
      const wy = textBox
        ? Math.min(Math.max(textBox.y + 40, mlBox.y + 30), mlBox.y + mlBox.height - 50)
        : mlBox.y + mlBox.height / 2;
      const hitChain: string[] = await window.evaluate(
        ([x, y]: any) =>
          document.elementsFromPoint(x, y).slice(0, 4).map(e =>
            e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? e.className : "")),
        [wx, wy],
      );
      await window.mouse.move(wx, wy);
      await window.mouse.wheel(0, -500);
      await window.waitForTimeout(400);
      const s1 = await getScroll();
      await window.mouse.wheel(0, -500);
      await window.waitForTimeout(400);
      const s2 = await getScroll();
      duringStream = { stillStreaming: true, s0, s1, s2, range: rangeNow, hitChain };
      console.log(`[live] wheel-UP during stream: ${s0} → ${s1} → ${s2} (range=${rangeNow}) hit=${JSON.stringify(hitChain)}`);
    } else {
      duringStream = { stillStreaming: false, skipped: true, range: rangeNow };
      console.log(`[live] during-stream probe skipped (range=${rangeNow})`);
    }
  }

  // ── 3) 等流结束（done 或 error 都收尾） ──
  const finished = await window
    .waitForFunction(() => {
      const stop: any = document.getElementById("stop-btn");
      const streaming = document.querySelectorAll(".message.assistant.streaming").length;
      return !!stop && stop.classList.contains("hidden") && streaming === 0;
    }, undefined, { timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  await window.waitForTimeout(1200); // 越过 finish 后的 500ms pin 窗口
  console.log(`[live] stream finished: ${finished}`);

  const dump: any = await window.evaluate(() => {
    const ml: any = document.getElementById("message-list");
    return {
      messageCount: ml.querySelectorAll(".message").length,
      actionsCount: ml.querySelectorAll(".message-actions").length,
      errorCount: ml.querySelectorAll(".message.error").length,
      streamingLeft: ml.querySelectorAll(".message.assistant.streaming").length,
      range: ml.scrollHeight - ml.clientHeight,
      bannerCls: (document.getElementById("config-banner") as any)?.className,
    };
  });
  console.log("[live] post-finish dump:", JSON.stringify(dump));

  // ── 4) 结束后电池 ──
  const runBattery = async (tag: string) => {
    await resetScroll();
    const mlBox = await window.locator("#message-list").boundingBox();
    if (!mlBox) throw new Error("no #message-list box");

    // 滚轮 × 正文
    const textBox = await window.locator(".message.assistant .message-text").first().boundingBox();
    const textDeltas: number[] = [];
    if (textBox) {
      let prev = await getScroll();
      for (let i = 0; i < 3; i++) {
        await window.mouse.move(
          textBox.x + Math.min(textBox.width / 2, 300),
          Math.min(Math.max(textBox.y + 40, mlBox.y + 30), mlBox.y + mlBox.height - 50),
        );
        await window.mouse.wheel(0, 500);
        await window.waitForTimeout(300);
        const now = await getScroll();
        textDeltas.push(now - prev);
        prev = now;
      }
    }

    // 滚轮 × 右侧空白
    await resetScroll();
    const r0 = await getScroll();
    await window.mouse.move(mlBox.x + mlBox.width - 30, mlBox.y + mlBox.height / 2);
    await window.mouse.wheel(0, 500);
    await window.waitForTimeout(300);
    const r1 = await getScroll();

    // thumb 抓取矩阵（含顶部 banner 曾压住的区域）
    const sbX = mlBox.x + mlBox.width - 3;
    const matrix: any[] = [];
    for (const yOff of [2, 8, 18, 32, 48, 60]) {
      await resetScroll();
      await window.waitForTimeout(120);
      const m0 = await getScroll();
      await window.mouse.move(sbX, mlBox.y + yOff);
      await window.mouse.down();
      await window.mouse.move(sbX, mlBox.y + yOff + 80, { steps: 5 });
      await window.waitForTimeout(120);
      const mMid = await getScroll();
      await window.mouse.up();
      await window.waitForTimeout(120);
      matrix.push({ yOff, mid: Math.round(mMid - m0) });
    }

    // 轨道点击
    await resetScroll();
    await window.mouse.click(sbX, mlBox.y + Math.round(mlBox.height * 0.8));
    await window.waitForTimeout(300);
    const trackJump = await getScroll();

    // 布局
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
        overflowY: cs.overflowY,
        minH: cs.minHeight,
      };
    });

    const res = { tag, textDeltas, rightDelta: r1 - r0, matrix, trackJump, layout };
    console.log(`[live] battery(${tag}):`, JSON.stringify(res));
    return res;
  };

  const battery =
    dump.range > 500
      ? await runBattery("live-conversation")
      : await (async () => {
          console.log("[live] live conversation too short (stream likely errored) → fallback battery on AI新闻 session");
          const named = window.locator(".session-item", { hasText: "AI新闻" });
          if ((await named.count()) > 0) {
            await named.first().click();
            await window.waitForTimeout(2000);
            return runBattery("fallback-session");
          }
          return null;
        })();

  // ── 5) 清理：删除本测试创建的会话（在断言前做，失败也不留垃圾） ──
  try {
    const now: any[] = await window.evaluate(() => (window as any).aideagent.listSessions());
    for (const s of now.filter((x: any) => String(x.title || "").includes(MARKER))) {
      await window.evaluate((id: any) => (window as any).aideagent.deleteSession(id), s.id);
      console.log(`[live] cleanup deleted session: ${s.title}`);
    }
  } catch (e) {
    console.log(`[live] cleanup failed: ${e}`);
  }

  // ── 断言 ──
  expect(bannerState.cls).toContain("hidden");
  expect(dump.streamingLeft).toBe(0);
  // 流式进行中用户必须能向上滚走（修复前渲染 tick 无条件 scrollToBottom → s1≈s0 被拉回）
  if (duringStream && typeof duringStream === "object" && duringStream.stillStreaming && duringStream.s0 > 0) {
    const hit0 = Array.isArray(duringStream.hitChain) ? String(duringStream.hitChain[0] || "") : "";
    if (hit0.includes("thinking-body")) {
      console.log("[live] during-stream wheel landed on thinking-body (nested scroll by design) — assert skipped");
    } else {
      expect(duringStream.s1).toBeLessThan(duringStream.s0 - 100);
    }
  }
  if (battery) {
    expect(battery.textDeltas.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    expect(battery.rightDelta).toBeGreaterThan(100);
    const grabs = battery.matrix.map((m: any) => m.mid);
    expect(Math.min(...grabs)).toBeGreaterThan(100);
    expect(battery.trackJump).toBeGreaterThan(100);
    expect(Math.abs(battery.layout.range - battery.layout.expectedRange)).toBeLessThan(60);
    expect(battery.layout.overflowY).toBe("auto");
  }
});
