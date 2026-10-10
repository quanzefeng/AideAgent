import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/e2e/*.test.ts 是 Playwright 用例（npm run test:e2e）。被 vitest 收集时
    // 必然报 "Playwright Test did not expect test() to be called here"，
    // 表现为十几个假失败文件，掩盖真实回归。
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
  },
});
