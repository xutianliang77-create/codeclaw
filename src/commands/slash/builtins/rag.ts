/**
 * `/rag` · 操作 workspace RAG 索引（M4-#75 step e）
 *
 * 用法：
 *   /rag                  显示 status（chunk 数 / 最后索引时间 / workspace）
 *   /rag index            全量 / 增量索引整个 workspace
 *   /rag search <q>       关键字 BM25 召回（top-K）
 *   /rag status           同 /rag 无参
 *   /rag clear            清空索引（不重建，需要再跑 /rag index）
 */

import { defineCommand, reply } from "../registry";

interface RagHolder {
  runRagCommand(argsRaw: string): Promise<string>;
}

function isHolder(x: unknown): x is RagHolder {
  return !!x && typeof (x as RagHolder).runRagCommand === "function";
}

export default defineCommand({
  name: "/rag",
  category: "memory",
  risk: "low",
  summary: "Index / search the workspace RAG store (BM25 keyword retrieval).",
  helpDetail:
    "Usage:\n" +
    "  /rag                  show index status\n" +
    "  /rag index            build / incrementally update workspace index\n" +
    "  /rag search <query>   BM25 keyword search top-K\n" +
    "  /rag status           same as /rag (status snapshot)\n" +
    "  /rag clear            wipe the index (re-run /rag index to rebuild)\n" +
    "Notes:\n" +
    "  - Index is per-workspace at ~/.codeclaw/projects/<hash>/rag.db\n" +
    "  - Hybrid (BM25 + bge-m3 embeddings) coming next; current is keyword only",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("rag command unavailable: runtime missing runRagCommand");
    }
    return reply(await ctx.queryEngine.runRagCommand(ctx.argsRaw));
  },
});
