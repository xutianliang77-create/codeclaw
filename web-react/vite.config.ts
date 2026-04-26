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
    // 161KB gzip 的 vendor 在生产可接受；调高阈值避免误报
    chunkSizeWarningLimit: 700,
    // 手动拆分体积大头：vendor 包含 react/markdown/highlight（避免循环），d3 / virtual 单拆
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("d3-")) return "d3";
            if (id.includes("@tanstack")) return "virtual";
            // react / react-dom / react-markdown / remark / rehype / highlight.js 都进 vendor
            return "vendor";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
