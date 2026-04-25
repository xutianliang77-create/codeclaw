import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "cli.tsx")],
  outfile: path.join(outDir, "cli.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  jsx: "automatic",
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node"
  },
  define: {
    "process.env.NODE_ENV": "\"production\""
  }
});

// migrate.ts 用 path.join(__dirname, "migrations", kind) 解析 sql 文件位置；
// 打包后 __dirname = dist/，所以 sql 必须随之拷贝到 dist/migrations/{data,audit}/。
// esbuild bundle 不会处理 fs.readdirSync 引用的非 import 资源。
await cp(
  path.join(rootDir, "src", "storage", "migrations"),
  path.join(outDir, "migrations"),
  { recursive: true }
);

console.log("Built dist/cli.js + copied migrations/");
