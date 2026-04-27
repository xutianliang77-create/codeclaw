#!/usr/bin/env node
/**
 * Post-install 钩子（v0.7.0 P1.2/P1.4）
 *
 * 目标：让 `npm install` 自动装好 web-react/ 子工程 deps，避免用户漏跑 `cd web-react && npm install`
 * 后访问 /next/ 看到旧 bundle / 缺 tab。
 *
 * 守卫：
 *   - CI=true 时跳过（避免双重 install 拖慢流水线；CI 自行决定）
 *   - 已被 web-react 内部 install 触发时跳过（INIT_CWD 检测，防递归）
 *   - web-react/node_modules 已存在时跳过（用户手动装过）
 *   - 失败仅 console.warn，不让 root install 整个失败
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webReactDir = path.join(repoRoot, "web-react");
const webReactNodeModules = path.join(webReactDir, "node_modules");

if (process.env.CI === "true") {
  console.log("[post-install] CI detected, skip web-react install");
  process.exit(0);
}

// 防递归：当 npm install 是在 web-react/ 目录内被触发的，INIT_CWD 会指向 web-react
const initCwd = process.env.INIT_CWD ?? "";
if (path.resolve(initCwd) === webReactDir) {
  process.exit(0);
}

if (!existsSync(webReactDir)) {
  // 没有 web-react/ 目录（可能是精简发行版）；静默跳过
  process.exit(0);
}

if (existsSync(webReactNodeModules)) {
  console.log("[post-install] web-react/node_modules already present, skip");
  process.exit(0);
}

console.log("[post-install] installing web-react deps ...");
try {
  execSync("npm install --no-audit --no-fund", {
    cwd: webReactDir,
    stdio: "inherit",
  });
  console.log("[post-install] ✓ web-react deps installed");
} catch (err) {
  console.warn(
    `[post-install] web-react install failed (continuing without web UI): ${
      err instanceof Error ? err.message : String(err)
    }`
  );
  // 不 process.exit(1)；root install 视为成功，仅警告
  process.exit(0);
}

// P1.4：装完前端 deps 后，如果 dist/public-react 缺失也顺便 build 一次
// （首次 clone 流程：npm install 一步拿到可用产物；再次 install 不会重复 build）
const distPublicReact = path.join(repoRoot, "dist", "public-react", "index.html");
if (existsSync(distPublicReact)) {
  console.log("[post-install] dist/public-react already built, skip build");
  process.exit(0);
}

if (process.env.CODECLAW_SKIP_WEB_BUILD === "true") {
  console.log("[post-install] CODECLAW_SKIP_WEB_BUILD=true, skip build");
  console.log(
    "[post-install] 提示：稍后跑 `npm run build:web && npm run build` 才能让 /next/ 可用"
  );
  process.exit(0);
}

console.log("[post-install] building web-react and dist (one-time, ~30-60s) ...");
try {
  execSync("npm run build:web", { cwd: repoRoot, stdio: "inherit" });
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
  console.log("[post-install] ✓ build complete; dist/public-react ready");
} catch (err) {
  console.warn(
    `[post-install] build failed (CLI 仍可用；/next/ 暂时不可访问): ${
      err instanceof Error ? err.message : String(err)
    }`
  );
  console.warn(
    "[post-install] 修复后跑：`npm run build:web && npm run build`"
  );
}
