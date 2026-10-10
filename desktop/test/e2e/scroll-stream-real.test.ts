/**
 * 真实流式收尾取证 v2（mock SSE，多轮 + 工具调用 + 中部起步探针）
 *
 * v1 结论：短会话（1 user + 1 assistant）真实流式收尾后滚动完全正常
 * （range=708、上滚 -300 生效、无 preventDefault）。用户实测仍卡死且 S4=长会话
 * 更易复现 → 差异在"多轮收尾 / 长会话 DOM 累积"这一维。
 *
 * v2 变化：
 *   - 同一会话连发 3 轮提问，每轮都带工具调用 → 走多次 finishAssistantMessage
 *   - 每轮结束后立刻探针（定位"第几轮开始坏"）
 *   - 探针一律先把 scrollTop 设到 range 中部再滚（v1 贴底测下滚 = 无意义）
 *   - 在滚轮坐标处 dump elementsFromPoint，直接看光标下是什么
 *   - 滚后 0/150/550ms 三次采样，检测"被拽回底部"的 drift
 */
import { test, expect, _electron as electron } from "@playwright/test";
import http from "node:http";

const testEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  NODE_ENV: "test",
  AIDEAGENT_TEST_MODE: "1",
};

const MARKER = "scroll-stream-real2";

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
        app.process()?.stderr?.on("data", (d: Buffer) => console.log("[main-err]", String(d).replace(/\s+$/, "").slice(0, 300)));
      } catch { /* stdio 不可用 */ }
      const window = await app.firstWindow({ timeout: 15_000 });
      window.on("pageerror", (e: any) => console.log("[pageerror]", String(e).slice(0, 400)));
      window.on("console", (m: any) => {
        if (m.type() === "error") console.log("[page-console-error]", m.text().slice(0, 300));
      });
      await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      const ready = await window.evaluate(() => document.readyState).catch((e: any) => `eval-fail: ${e}`);
      if (ready !== "complete" && ready !== "interactive") throw new Error(`bad readyState: ${ready}`);
      await window.waitForTimeout(1000);
      return { app, window };
    } catch (e) {
      lastErr = e;
      console.log(`[launch] attempt ${attempt} failed: ${e}`);
      if (app) { try { await closeApp(app); } catch { /* ignore */ } }
    }
  }
  throw lastErr;
};

/* ── mock OpenAI 兼容 SSE ─────────────────────────────────── */

const startMockApi = (): Promise<{ url: string; close: () => Promise<void>; calls: () => number }> => {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      // 协议正确性：上一轮若是工具结果 → 本轮给最终文本；否则本轮先推理 + 发起工具调用
      let isToolResult = false;
      try {
        const parsed = JSON.parse(body);
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        isToolResult = msgs.length > 0 && msgs[msgs.length - 1].role === "tool";
      } catch { /* 解析失败按文本轮处理 */ }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const reasoning = `第 ${n} 次调用：先分析用户意图再决定动作，这段推理会撑满 thinking-body 的 200px 上限。`.repeat(30);
      const answer = `第 ${n} 次调用回答正文，包含中文与 English 以及 \`code\`，用来撑高对话列表。`.repeat(12);
      const chunks: any[] = [];
      for (const p of reasoning.match(/.{1,40}/g)!) chunks.push({ delta: { reasoning_content: p } });
      if (!isToolResult) {
        // 每轮一个工具调用（file_read 读 package.json，失败也没关系——工具条目照样生成）
        chunks.push({
          delta: {
            tool_calls: [
              { index: 0, id: `call_${n}`, type: "function", function: { name: "file_read", arguments: '{"path":"package.json"}' } },
            ],
          },
          finish_reason: "tool_calls",
        });
      } else {
        for (const p of answer.match(/.{1,40}/g)!) chunks.push({ delta: { content: p } });
        chunks.push({ delta: {}, finish_reason: "stop" });
      }
      chunks.push({ usage: { prompt_tokens: 4000, completion_tokens: 900, total_tokens: 4900, prompt_tokens_details: { cached_tokens: 0 } } });

      let i = 0;
      const tick = () => {
        if (i >= chunks.length) { res.write("data: [DONE]\n\n"); res.end(); return; }
        const c = chunks[i++];
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: c.delta ?? {}, finish_reason: c.finish_reason ?? null }], ...(c.usage ? { usage: c.usage } : {}) })}\n\n`);
        setTimeout(tick, 8);
      };
      tick();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        calls: () => n,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
};

/* ── 取证 ─────────────────────────────────────────────────── */

const FORENSIC = () => {
  const ml = document.getElementById("message-list") as HTMLElement;
  const cs = getComputedStyle(ml);
  const open = [...document.querySelectorAll("details[open]")].map((d) => d.className);
  const innerScrollers = [...document.querySelectorAll(".thinking-body, .tool-entry-body, pre")]
    .map((e) => {
      const h = e as HTMLElement, c = getComputedStyle(h);
      return { cls: h.className, sh: h.scrollHeight, ch: h.clientHeight, oy: c.overflowY, ox: c.overflowX, ob: c.overscrollBehaviorY };
    })
    .slice(0, 12);
  return {
    ml: { sh: ml.scrollHeight, ch: ml.clientHeight, st: Math.round(ml.scrollTop), range: ml.scrollHeight - ml.clientHeight, oy: cs.overflowY, flex: cs.flex, minH: cs.minHeight, maxH: cs.maxHeight, inline: ml.getAttribute("style") || "" },
    chatArea: document.getElementById("chat-area")?.className || "",
    open,
    innerScrollers,
    streaming: document.querySelectorAll(".message.assistant.streaming").length,
    msgs: document.querySelectorAll(".message").length,
    toolEntries: document.querySelectorAll(".tool-entry").length,
    thinking: document.querySelectorAll(".thinking-details").length,
    holderChildren: (() => {
      const hs = [...document.body.children].filter((e) => !e.id && !e.className && e.tagName === "DIV");
      return hs.map((e) => ({ kids: e.children.length, disp: getComputedStyle(e).display, cls: e.className }));
    })(),
  };
};

test("scroll-stream-real v2: multi-turn real stream end forensics", async () => {
  test.setTimeout(420_000);
  const api = await startMockApi();
  console.log(`[srr2] mock api ${api.url}`);
  const { app, window } = await launchApp();

  await window.evaluate(() => document.getElementById("boot-screen")?.remove());
  const pre: any[] = await window.evaluate(() => (window as any).aideagent.listSessions()).catch(() => []);
  for (const s of pre.filter((x: any) => String(x.title || "").includes(MARKER))) {
    await window.evaluate((id: any) => (window as any).aideagent.deleteSession(id), s.id);
  }

  await window
    .evaluate((url: any) => {
      localStorage.setItem("AideAgent_provider", "");
      localStorage.setItem("AideAgent_api_url", url);
      localStorage.setItem("AideAgent_model", "mock-model");
      localStorage.setItem("AideAgent_api_format", "openai");
      location.reload();
    }, api.url)
    .catch(() => {});
  await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
  await window.waitForTimeout(1500);
  await window.evaluate(() => document.getElementById("boot-screen")?.remove());

  await window.evaluate(() => {
    (window as any).__wheelLog = [];
    window.addEventListener("wheel", (e: WheelEvent) => {
      const t = e.target as HTMLElement;
      (window as any).__wheelLog.push({
        dy: e.deltaY,
        dp: e.defaultPrevented,
        target: t.tagName + (t.id ? "#" + t.id : "") + (typeof t.className === "string" ? "." + String(t.className).split(" ").join(".") : ""),
        mlTop: Math.round((document.getElementById("message-list") as any)?.scrollTop ?? -1),
      });
    }, true);
  });

  await window.locator(".session-item").first().waitFor({ timeout: 15_000 });
  await window.locator("#new-chat").click();
  await window.waitForTimeout(600);

  const getScroll = () => window.evaluate(() => (document.getElementById("message-list") as any).scrollTop);
  const setScrollFrac = (f: number) =>
    window.evaluate((fr: any) => {
      const ml: any = document.getElementById("message-list");
      ml.scrollTop = (ml.scrollHeight - ml.clientHeight) * fr;
    }, f);

  const probe = async (label: string, dy: number, notches = 1, frac = 0.5) => {
    await setScrollFrac(frac);
    await window.waitForTimeout(200);
    await window.evaluate(() => { (window as any).__wheelLog = []; });
    const mlBox = await window.locator("#message-list").boundingBox();
    const x = mlBox!.x + mlBox!.width * 0.45;
    const y = mlBox!.y + mlBox!.height * 0.55;
    const hit: string[] = await window.evaluate(([px, py]: any) =>
      document.elementsFromPoint(px, py).slice(0, 4).map((e: any) =>
        e.tagName + (e.id ? "#" + e.id : "") + "." + (typeof e.className === "string" ? String(e.className).split(" ").join(".") : "")),
      [x, y]);
    const before = await getScroll();
    await window.mouse.move(x, y);
    for (let i = 0; i < notches; i++) { await window.mouse.wheel(0, dy); await window.waitForTimeout(120); }
    await window.waitForTimeout(150);
    const t150 = await getScroll();
    await window.waitForTimeout(400);
    const t550 = await getScroll();
    const log: any[] = await window.evaluate(() => (window as any).__wheelLog);
    console.log(
      `[srr2] ${label}: before=${Math.round(before)} after=${Math.round(t150)} delta=${Math.round(t150 - before)} drift=${Math.round(t550 - t150)} wheels=${log.length} prevented=${log.filter((l) => l.dp).length} hit=${JSON.stringify(hit.slice(0, 2))}`,
    );
    return { delta: t150 - before, drift: t550 - t150, log, hit };
  };

  // ── 3 轮提问，每轮结束后探针 ──
  const perTurn: any[] = [];
  for (let turn = 1; turn <= 3; turn++) {
    await window.locator("#prompt-input").fill(`【${MARKER}】第 ${turn} 轮：读一下 package.json 然后详细回答。`);
    await window.waitForFunction(() => { const b: any = document.getElementById("send-btn"); return b && !b.disabled; }, undefined, { timeout: 8_000 }).catch(() => {});
    await window.locator("#send-btn").click();
    const started = await window.waitForSelector(".message.assistant.streaming", { timeout: 30_000 }).then(() => true).catch(() => false);
    if (!started) { console.log(`[srr2] turn ${turn}: stream never started`); break; }

    // 流式中途：等内容足够高后上滚（真实用户行为），观察是否被拽回
    if (turn === 3) {
      for (let t = 0; t < 40; t++) {
        const r = await window.evaluate(() => { const ml: any = document.getElementById("message-list"); return ml.scrollHeight - ml.clientHeight; });
        if (r > 400) break;
        await window.waitForTimeout(300);
      }
      await setScrollFrac(0.2);
      const midBefore = await getScroll();
      await window.mouse.move(0, 0);
      const mlBox = await window.locator("#message-list").boundingBox();
      await window.mouse.move(mlBox!.x + mlBox!.width * 0.45, mlBox!.y + mlBox!.height * 0.55);
      await window.mouse.wheel(0, -200);
      await window.waitForTimeout(600);
      const midAfter = await getScroll();
      console.log(`[srr2] turn 3 MID-STREAM up: before=${Math.round(midBefore)} after=${Math.round(midAfter)} delta=${Math.round(midAfter - midBefore)}`);
    }

    await window.waitForFunction(() => !document.querySelector(".message.assistant.streaming"), undefined, { timeout: 120_000 }).catch(() => console.log(`[srr2] turn ${turn} never finished`));
    await window.waitForTimeout(1200);

    const f: any = await window.evaluate(FORENSIC);
    console.log(`[srr2] ── turn ${turn} end ── ml=${JSON.stringify(f.ml)}`);
    console.log(`[srr2]    msgs=${f.msgs} toolEntries=${f.toolEntries} thinking=${f.thinking} open=${JSON.stringify(f.open)} streaming=${f.streaming} chatArea="${f.chatArea}" holder=${JSON.stringify(f.holderChildren)}`);
    console.log(`[srr2]    innerScrollers=${JSON.stringify(f.innerScrollers)}`);

    const down = await probe(`turn ${turn} DOWN dy=300`, 300);
    const up = await probe(`turn ${turn} UP dy=-300`, -300);
    const small = await probe(`turn ${turn} DOWN dy=24 x10`, 24, 10);
    perTurn.push({ turn, ml: f.ml, down: down.delta, up: up.delta, small: small.delta, downHit: down.hit, upHit: up.hit });
  }

  console.log(`[srr2] api calls = ${api.calls()}`);
  console.log("[srr2] SUMMARY:", JSON.stringify(perTurn.map((p) => ({ t: p.turn, range: p.ml.range, st: p.ml.st, down: Math.round(p.down), up: Math.round(p.up), small: Math.round(p.small) }))), false);

  await window
    .evaluate((m: any) => (window as any).aideagent.listSessions().then((ss: any) => Promise.all(ss.filter((x: any) => String(x.title || "").includes(m)).map((x: any) => (window as any).aideagent.deleteSession(x.id)))), MARKER)
    .catch(() => {});
  await api.close();
  await closeApp(app);

  // 只有"确实可滚"(range>200) 时滚轮不动才算失效；range=0 是内容不足一屏，正常
  const broken = perTurn.filter((p) => p.ml.range > 200 && (Math.abs(p.down) < 20 || Math.abs(p.up) < 20 || Math.abs(p.small) < 20));
  console.log(`[srr2] VERDICT broken-turns=${JSON.stringify(broken.map((b) => b.turn))}`);
  expect(broken.length, "存在滚轮失效的轮次").toBe(0);
});
