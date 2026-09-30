import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E 配置（Electron 模式）
 *
 * 用法：
 *   npm run test:e2e                  # 跑全部烟雾测试
 *   npm run test:e2e -- --headed      # 看 UI
 *   npm run test:e2e -- smoke         # 跑名字含 "smoke" 的
 *
 * 注意：
 *   - 不需要 `playwright install chromium` —— Electron 自带 Chromium
 *   - 单 worker 跑（Electron 多实例容易出 sandbox 问题）
 *   - ELECTRON_DISABLE_SANDBOX=1 跟 start 脚本保持一致
 */
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
