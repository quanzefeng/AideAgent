// ── WeChat iLink Bridge — QR Login + Bot ────────────────────

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import os from "node:os";
import { app, ipcMain } from "electron";
import {
  WX_BASE, WX_BOT_TYPE, WX_POLL_TIMEOUT, WX_MSG_CHUNK,
  MSG_ITEM_TEXT, MSG_TYPE_BOT, MSG_STATE_FINISH,
  getWxBotToken, setWxBotToken, getWxBotId, setWxBotId,
  getWxUserId, setWxUserId, getWxPollAbort, setWxPollAbort,
  getLastApiConfig, sendToRenderer,
} from "./state.mjs";

function randomWxUin() {
  return Buffer.from(String(Math.floor(Math.random() * 4294967296)), "utf-8").toString("base64");
}

function wxHeaders(token) {
  const h = {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomWxUin(),
    "iLink-App-ClientVersion": "1",
  };
  if (token) {
    h["AuthorizationType"] = "ilink_bot_token";
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

async function getWechatQrcode() {
  try {
    const res = await fetch(`${WX_BASE}/ilink/bot/get_bot_qrcode?bot_type=${WX_BOT_TYPE}`, { headers: wxHeaders() });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data.qrcode) return { ok: false, error: "no qrcode" };
    const qrText = data.qrcode_img_content || data.qrcode;
    const qrDataUrl = await QRCode.toDataURL(qrText, { width: 280, margin: 2 });
    return { ok: true, qrcodeUrl: qrDataUrl, qrcodeId: data.qrcode };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function pollQrcodeStatus(qrcodeId) {
  if (!qrcodeId) return { status: "error", error: "missing qrcodeId" };
  try {
    const url = `${WX_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    let res;
    try { res = await fetch(url, { headers: wxHeaders(), signal: ctrl.signal }); } finally { clearTimeout(t); }
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
    const data = await res.json();
    switch (data.status) {
      case "wait": return { status: "waiting" };
      case "scaned": return { status: "scanned" };
      case "confirmed":
        if (!data.bot_token) return { status: "error", error: "no token" };
        return { status: "confirmed", botToken: data.bot_token, botId: data.ilink_bot_id, userId: data.ilink_user_id };
      case "expired": return { status: "expired" };
      default: return { status: data.status || "waiting" };
    }
  } catch (err) { return { status: "error", error: err.message }; }
}

async function wxApi(endpoint, body, timeoutMs = WX_POLL_TIMEOUT) {
  if (!getWxBotToken()) throw new Error("not logged in");
  const url = new URL(endpoint, WX_BASE.endsWith("/") ? WX_BASE : WX_BASE + "/");
  const ctrl = new AbortController();
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs + 5000) : null;
  try {
    const res = await fetch(url.toString(), {
      method: "POST", headers: wxHeaders(getWxBotToken()),
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(`HTTP ${res.status}: ${txt.slice(0,100)}`); }
    return await res.json();
  } finally { if (t) clearTimeout(t); }
}

async function wxSendMessage(chatId, text, contextToken) {
  if (!contextToken) throw new Error("需要对方先发消息才能回复");
  for (let i = 0; i < text.length; i += WX_MSG_CHUNK) {
    await wxApi("ilink/bot/sendmessage", {
      msg: { from_user_id: "", to_user_id: chatId,         client_id: randomUUID(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: text.slice(i, i + WX_MSG_CHUNK) } }],
        context_token: contextToken },
      base_info: { channel_version: "1.0.0" },
    }, 30000);
  }
}

function extractText(itemList) {
  let t = "";
  for (const it of itemList || []) { if (it.type === 1 && it.text_item?.text) t += it.text_item.text; }
  return t;
}

async function wxPollLoop() {
  setWxPollAbort(new AbortController());
  let buf = "", fails = 0;
  console.log("[wechat] poll loop started");
  while (!getWxPollAbort().signal.aborted) {
    try {
      const resp = await wxApi("ilink/bot/getupdates", { get_updates_buf: buf, base_info: { channel_version: "1.0.0" } });
      fails = 0; if (resp.get_updates_buf) buf = resp.get_updates_buf;
      const msgCount = (resp.msgs || []).length;
      if (msgCount > 0) console.log(`[wechat] received ${msgCount} messages`);
      sendToRenderer("wechat:bot-status", { status: "connected" });
      for (const msg of resp.msgs || []) {
        const uid = msg.from_user_id || "";
        if (!uid || uid.endsWith("@im.bot")) continue;
        const text = extractText(msg.item_list);
        if (!text) continue;
        console.log(`[wechat] incoming from ${uid}: "${text.substring(0, 50)}"`);
        sendToRenderer("wechat:incoming", { userId: uid, text: text.substring(0, 200) });
        try {
          const reply = await generateWxReply(text);
          console.log(`[wechat] replying: "${reply.substring(0, 50)}..."`);
          await wxSendMessage(uid, reply, msg.context_token);
        } catch (err) {
          console.error("[wechat] reply:", err.message);
          try { await wxSendMessage(uid, `[${err.message}]`, msg.context_token); } catch { /* ignored */ }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") continue;
      console.error(`[wechat] poll error (fail ${++fails}/3):`, err.message);
      if (fails >= 3) sendToRenderer("wechat:bot-status", { status: "error", error: err.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log("[wechat] poll loop ended");
}

export function loadWxConfig() {
  const p = join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config", "wechat.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

function saveWxConfig(cfg) {
  const d = join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config");
  try { mkdirSync(d, { recursive: true }); } catch { /* ignored */ }
  writeFileSync(join(d, "wechat.json"), JSON.stringify(cfg, null, 2));
}

async function generateWxReply(prompt) {
  const cfg = loadWxConfig();
  const lastApi = getLastApiConfig();
  const apiKey = cfg.apiKey || lastApi.apiKey;
  const apiUrl = cfg.apiUrl || lastApi.apiUrl;
  const model = cfg.model || lastApi.model || "deepseek-chat";
  const apiFormat = cfg.apiFormat || lastApi.apiFormat || "openai";

  if (!apiKey || !apiUrl) return "请先在桌面端发送一条消息激活 API，或重新扫码登录";

  // Lazy import to avoid circular dependency
  const { agentLoop } = await import("./agent-loop.mjs");
  try {
    const result = await agentLoop(prompt, apiKey, apiUrl, model, apiFormat, [], [], false, "");
    return result.text || "";
  } catch (err) {
    console.error("[wechat] agentLoop error:", err.message);
    return `[出错: ${err.message}]`;
  }
}

export function registerWechatIpc() {
  ipcMain.handle("wechat:get-qrcode", async () => await getWechatQrcode());
  ipcMain.handle("wechat:poll-status", async (_e, qrcodeId) => await pollQrcodeStatus(qrcodeId));

  ipcMain.handle("wechat:login", async (_e, creds) => {
    console.log("[wechat] login with creds:", { hasToken: !!creds.botToken, hasApiKey: !!creds.apiKey, apiUrl: creds.apiUrl });
    setWxBotToken(creds.botToken); setWxBotId(creds.botId); setWxUserId(creds.userId);
    saveWxConfig({ botToken: creds.botToken, botId: creds.botId, userId: creds.userId, apiKey: creds.apiKey, apiUrl: creds.apiUrl, model: creds.model, apiFormat: creds.apiFormat });
    wxPollLoop().catch(e => console.error("[wechat] poll:", e.message));
    return { ok: true };
  });

  ipcMain.handle("wechat:logout", async () => {
    const pollAbort = getWxPollAbort();
    if (pollAbort) { pollAbort.abort("logout"); setWxPollAbort(null); }
    setWxBotToken(null); setWxBotId(null); setWxUserId(null);
    try { unlinkSync(join(process.env.USERPROFILE || os.homedir(), ".goodagent", "config", "wechat.json")); } catch { /* ignored */ }
    sendToRenderer("wechat:bot-status", { status: "disconnected" });
    return { ok: true };
  });

  ipcMain.handle("wechat:get-status", async () => {
    const cfg = loadWxConfig();
    return {
      loggedIn: !!getWxBotToken(),
      botId: getWxBotId() || cfg.botId,
      userId: getWxUserId() || cfg.userId,
      status: getWxBotToken() ? "running" : "disconnected",
    };
  });

  ipcMain.handle("api:sync-to-wechat", async (_e, { apiUrl, apiKey, model, apiFormat }) => {
    const cfg = loadWxConfig();
    cfg.apiUrl = apiUrl; cfg.apiKey = apiKey; cfg.model = model; cfg.apiFormat = apiFormat;
    saveWxConfig(cfg);
    return { ok: true };
  });
}

export function autoStartWechat() {
  app.whenReady().then(async () => {
    try {
      const cfg = loadWxConfig();
      if (cfg.botToken) {
        setWxBotToken(cfg.botToken); setWxBotId(cfg.botId); setWxUserId(cfg.userId);
        console.log("[wechat] auto-starting bot from saved config");
        wxPollLoop().catch(e => console.error("[wechat] auto-start:", e.message));
      }
    } catch { /* ignored */ }
  });
}
