/**
 * Vitest 配置
 *
 * 默认发现策略 + 显式排除 Golden FIX workspace：
 *   - test/golden/fix/FIX-**：这些 workspace 是 Golden Set "故意 broken" 的素材，
 *     由 test/golden/runner/fix.ts 独立安装依赖后单独跑，不应混进主测试回归。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/golden/fix/**",
    ],
  },
});
