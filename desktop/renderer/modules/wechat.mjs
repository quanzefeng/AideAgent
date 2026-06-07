// @ts-check — JSDoc-typed WeChat iLink QR login + bot panel.
// @ts-check — 带 JSDoc 类型注解的微信 iLink 扫码登录 + 机器人面板。
/**
 * WeChat iLink QR Login + Bot
 * --------------------------------------------------------------------------
 * 负责 settings → 社交 tab 的微信机器人管理：
 *   - 显示当前登录状态徽章 (connected / disconnected)
 *   - 打开 QR 浮层：拉取二维码 + 轮询扫码状态
 *   - 扫码成功后用拉取的凭证调用 wechatLogin 启动机器人
 *   - 监听主进程的 bot 状态 / 收到消息事件
 *
 * 状态全部封装在闭包内。
 *
 * 元素约定（与 index.html 保持一致）：
 *   - #wechat-status-badge — 状态徽章
 *   - #wechat-login-btn, #wechat-logout-btn — 登录 / 登出按钮
 *   - #wechat-login-status — 状态条（incoming 提示用）
 *   - #wechat-qr-overlay, #wechat-qr-img, #wechat-qr-loading,
 *     #wechat-qr-status, #wechat-qr-close — QR 浮层
 *   - .settings-tab[data-tab="social"] — 社交 tab 切换
 */

/**
 * @param {{
 *   t: (key: string, vars?: Record<string, string | number>) => string,
 *   loadApiConfig: () => { apiUrl: string; apiKey: string; model: string; apiFormat: string },
 * }} deps
 */
export function createWechatPanel({ t, loadApiConfig }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let _wxPollTimer = null;

  /** Fetch the current WeChat login status and update the badge. */
  async function initWechatStatus() {
    try {
      const status = await window.aideagent.wechatGetStatus();
      updateWechatUI(status);
    } catch (e) {
      console.warn("[wechat] status:", /** @type {Error} */ (e).message);
    }
  }

  /**
   * @param {{ loggedIn: boolean, status?: string }} status
   */
  function updateWechatUI(status) {
    const badge = document.getElementById("wechat-status-badge");
    const loginBtn = document.getElementById("wechat-login-btn");
    const logoutBtn = document.getElementById("wechat-logout-btn");

    if (badge) {
      if (status.loggedIn) {
        badge.textContent = t("social.connected");
        badge.className = "wechat-badge connected";
      } else {
        badge.textContent = t("social.disconnected");
        badge.className = "wechat-badge disconnected";
      }
    }
    if (loginBtn) loginBtn.classList.toggle("hidden", status.loggedIn);
    if (logoutBtn) logoutBtn.classList.toggle("hidden", !status.loggedIn);
  }

  /**
   * @param {string} msg
   * @param {string} [type]
   */
  function showWxStatus(msg, type) {
    const el = document.getElementById("wechat-login-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "wechat-login-status " + (type || "info");
    el.classList.remove("hidden");
  }

  function hideWxStatus() {
    const el = document.getElementById("wechat-login-status");
    if (el) el.classList.add("hidden");
  }

  // ── QR Overlay ───────────────────────────────────────────

  document.getElementById("wechat-login-btn")?.addEventListener("click", async () => {
    const overlay = document.getElementById("wechat-qr-overlay");
    const qrImg = /** @type {HTMLImageElement | null} */ (document.getElementById("wechat-qr-img"));
    const loading = document.getElementById("wechat-qr-loading");
    const statusEl = document.getElementById("wechat-qr-status");
    if (overlay) overlay.classList.remove("hidden");
    if (loading) loading.style.display = "block";
    if (qrImg) qrImg.style.display = "none";
    if (statusEl) {
      statusEl.textContent = t("social.getting_qr");
      statusEl.className = "wechat-qr-status";
    }

    /** @type {string | null} */
    let qrcodeId = null;
    const MAX_REFRESH = 3;
    let refreshCount = 0;
    let stopped = false;

    // Close button
    const closeBtn = /** @type {HTMLElement | null} */ (document.getElementById("wechat-qr-close"));
    closeBtn?.addEventListener("click", () => {
      stopped = true;
      if (overlay) overlay.classList.add("hidden");
    });

    async function fetchQr() {
      try {
        if (loading) loading.style.display = "block";
        if (qrImg) qrImg.style.display = "none";
        if (statusEl) {
          statusEl.textContent = t("social.getting_qr");
          statusEl.className = "wechat-qr-status";
        }

        const result = await window.aideagent.wechatGetQrcode();
        if (result.ok) {
          if (qrImg && result.qrcodeUrl) qrImg.src = result.qrcodeUrl;
          if (qrImg) qrImg.style.display = "block";
          if (loading) loading.style.display = "none";
          qrcodeId = result.qrcodeId || null;
          if (statusEl) {
            statusEl.textContent = t("social.qr_scan");
            statusEl.className = "wechat-qr-status";
          }
          if (qrcodeId) startPoll(qrcodeId);
        } else {
          if (statusEl) {
            statusEl.textContent = t("social.qr_error", { error: result.error || "" });
            statusEl.className = "wechat-qr-status error";
          }
        }
      } catch {
        if (statusEl) {
          statusEl.textContent = t("social.qr_network");
          statusEl.className = "wechat-qr-status error";
        }
      }
    }

    /**
     * @param {string} id
     */
    async function startPoll(id) {
      while (!stopped) {
        try {
          const r = await window.aideagent.wechatPollStatus(id);
          if (stopped) return;
          if (r.status === "scanned") {
            if (statusEl) {
              statusEl.textContent = t("social.qr_scanned");
              statusEl.className = "wechat-qr-status";
            }
          } else if (r.status === "confirmed") {
            if (statusEl) {
              statusEl.textContent = t("social.qr_success");
              statusEl.className = "wechat-qr-status success";
            }
            // Save credentials + start bot
            const cfg = loadApiConfig();
            await window.aideagent.wechatLogin({
              botToken: r.botToken || "",
              botId: r.botId || "",
              userId: r.userId || "",
              apiKey: cfg.apiKey,
              apiUrl: cfg.apiUrl,
              model: cfg.model,
              apiFormat: cfg.apiFormat,
            });
            await initWechatStatus();
            setTimeout(() => { if (overlay) overlay.classList.add("hidden"); }, 1500);
            return;
          } else if (r.status === "expired") {
            refreshCount++;
            if (refreshCount >= MAX_REFRESH) {
              if (statusEl) {
                statusEl.textContent = t("social.qr_expired");
                statusEl.className = "wechat-qr-status error";
              }
              return;
            }
            await fetchQr();
            return;
          }
          if (r.error && statusEl) { statusEl.textContent = r.error; }
        } catch {}
        await new Promise((resolve) => { _wxPollTimer = setTimeout(resolve, 1000); });
      }
    }

    await fetchQr();
  });

  // ── Logout ───────────────────────────────────────────

  document.getElementById("wechat-logout-btn")?.addEventListener("click", async () => {
    await window.aideagent.wechatLogout();
    await initWechatStatus();
    showWxStatus(t("social.logged_out"), "info");
  });

  // ── Main-process event listeners ───────────────────────────

  // Bot status updates from main process
  if (typeof window.aideagent.onWechatBotStatus === "function") {
    window.aideagent.onWechatBotStatus((data) => {
      if (data.status === "connected") updateWechatUI({ loggedIn: true, status: "running" });
      else if (data.status === "disconnected") updateWechatUI({ loggedIn: false });
    });
  }

  // Incoming message notifications
  if (typeof window.aideagent.onWechatIncoming === "function") {
    window.aideagent.onWechatIncoming((data) => {
      showWxStatus(t("social.incoming", { text: data.text }), "info");
      setTimeout(hideWxStatus, 5000);
    });
  }

  // ── Social tab click ──────────────────────────────────────

  document.querySelector('.settings-tab[data-tab="social"]')?.addEventListener("click", () => {
    initWechatStatus();
  });

  // Self-init on module load (matches old app.js behavior)
  initWechatStatus();

  return { init: initWechatStatus };
}
