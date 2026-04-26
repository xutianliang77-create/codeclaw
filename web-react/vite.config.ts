/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * codeclaw-web-react · Vite 配置
 *
 * 行为：
 *   - 开发：vite dev server 5173 端口；/v1/web/* 与 /static/* proxy 到 codeclaw web 7180
 *   - 构建：dist/ 输出；codeclaw build 后由 codeclaw 主仓库的 build.mjs 拷到 dist/public-react/
 *   - 路由：codeclaw web server 在 阶段 B 启用 /next 双 URL 共存（/legacy 走旧 vanilla SPA）
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: "/next/",
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:7180",
      "/static": "http://127.0.0.1:7180",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
