/**
 * `/graph` · CodebaseGraph 操作（M4-#76 step e）
 *
 * 用法：
 *   /graph                       显示 status (symbols/imports/calls 计数)
 *   /graph build                 全量构建（rebuild from scratch）
 *   /graph callers <name> [path] 哪些 caller 调用了 name（可选 path 限定 callee_path）
 *   /graph callees <path>        path 文件里调了哪些 callee
 *   /graph dependents <path>     哪些文件 import 了 path
 *   /graph dependencies <path>   path 文件 import 了哪些 module / 文件
 *   /graph symbol <name|path>    按名查找 symbol，或按 path 列出文件全部 symbol
 */

import { defineCommand, reply } from "../registry";

interface GraphHolder {
  runGraphCommand(argsRaw: string): string;
}

function isHolder(x: unknown): x is GraphHolder {
  return !!x && typeof (x as GraphHolder).runGraphCommand === "function";
}

export default defineCommand({
  name: "/graph",
  category: "memory",
  risk: "low",
  summary: "Build / query the workspace CodebaseGraph (TS/JS imports + call graph).",
  helpDetail:
    "Usage:\n" +
    "  /graph                          show status\n" +
    "  /graph build                    rebuild graph from scratch\n" +
    "  /graph callers <name> [path]    callers of a symbol name (optional callee path)\n" +
    "  /graph callees <path>           callees from a file\n" +
    "  /graph dependents <path>        files importing this path\n" +
    "  /graph dependencies <path>      modules imported by this file\n" +
    "  /graph symbol <name|path>       look up symbols (path argument lists file's symbols)\n" +
    "Notes:\n" +
    "  - Storage shares ~/.codeclaw/projects/<hash>/rag.db with the RAG index\n" +
    "  - Currently TS/JS only; Python / Go / Rust on roadmap",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("graph command unavailable: runtime missing runGraphCommand");
    }
    return reply(ctx.queryEngine.runGraphCommand(ctx.argsRaw));
  },
});
