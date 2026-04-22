import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
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

console.log("Built dist/cli.js");
