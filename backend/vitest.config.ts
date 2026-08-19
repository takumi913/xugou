import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只跑源码里的测试。`pnpm build` 的 tsc 产物落在 dist/，
    // 不加这条会把编译后的 *.test.js 当成第二份用例再跑一遍。
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
