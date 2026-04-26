/**
 * Slash 命令清单（B.9 ⌘K palette 数据源）
 *
 * 与 docs/SLASH_COMMANDS.md 同步（构建期可改为静态导入解析；当前手抄，36 条）。
 */

export type SlashCategory =
  | "session"
  | "permission"
  | "observability"
  | "memory"
  | "provider"
  | "plugin"
  | "integration"
  | "workflow"
  | "help";

export interface SlashEntry {
  name: string;
  category: SlashCategory;
  summary: string;
  /** 选中后插入到 composer 的样板（光标停在此处） */
  template?: string;
}

export const SLASH_COMMANDS: SlashEntry[] = [
  // help
  { name: "/help", category: "help", summary: "命令列表" },
  // session
  { name: "/ask", category: "session", summary: "一次性只读问答（自动恢复 mode）", template: "/ask " },
  { name: "/end", category: "session", summary: "总结当前 session 并存 L2 digest" },
  { name: "/export", category: "session", summary: "导出 transcript 到 markdown", template: "/export " },
  { name: "/forget", category: "session", summary: "清掉跨会话 digest", template: "/forget --all" },
  { name: "/init", category: "session", summary: "首次启动 bootstrap 检查清单" },
  { name: "/resume", category: "session", summary: "恢复上次中断的会话" },
  { name: "/session", category: "session", summary: "当前 session 元信息" },
  { name: "/status", category: "session", summary: "provider / mode / cwd 一行总览" },
  // workflow
  { name: "/commit", category: "workflow", summary: "只读预览 git 改动（status + diff stat）" },
  { name: "/cron", category: "workflow", summary: "定时任务（slash / prompt / shell）", template: "/cron list" },
  { name: "/fix", category: "workflow", summary: "fix orchestration（plan + execute）", template: "/fix " },
  { name: "/orchestrate", category: "workflow", summary: "完整 Planner→Executor→Reflector", template: "/orchestrate " },
  { name: "/plan", category: "workflow", summary: "仅 plan 不执行", template: "/plan " },
  { name: "/review", category: "workflow", summary: "review skill plan + execute", template: "/review " },
  // memory
  { name: "/compact", category: "memory", summary: "压早期消息成 summary", template: "/compact" },
  { name: "/graph", category: "memory", summary: "CodebaseGraph 操作", template: "/graph " },
  { name: "/memory", category: "memory", summary: "压缩 summary 状态" },
  { name: "/preferences", category: "memory", summary: "用户 / 项目偏好（CODECLAW.md）", template: "/preferences add " },
  { name: "/rag", category: "memory", summary: "RAG 索引 / 搜索", template: "/rag " },
  { name: "/remember", category: "memory", summary: "记一条事实到项目 memory", template: "/remember " },
  { name: "/summary", category: "memory", summary: "看最近一次压缩 summary" },
  // observability
  { name: "/context", category: "observability", summary: "token 用量 / context 状态" },
  { name: "/cost", category: "observability", summary: "session 成本 + 今日跨会话" },
  { name: "/debug-tool-call", category: "observability", summary: "调试某条 tool call" },
  { name: "/diff", category: "observability", summary: "git diff stat" },
  { name: "/doctor", category: "observability", summary: "环境健康检查" },
  // permission
  { name: "/approvals", category: "permission", summary: "看 / 处理 pending approvals" },
  { name: "/mode", category: "permission", summary: "切 permission mode", template: "/mode plan" },
  // provider
  { name: "/model", category: "provider", summary: "切 model", template: "/model " },
  { name: "/providers", category: "provider", summary: "列 provider chain" },
  // plugin
  { name: "/hooks", category: "plugin", summary: "lifecycle hooks 配置 + 状态" },
  { name: "/reload-plugins", category: "plugin", summary: "重新扫描 skill / plugins" },
  { name: "/skills", category: "plugin", summary: "列 / 用 skill", template: "/skills " },
  // integration
  { name: "/mcp", category: "integration", summary: "MCP server / tool 操作", template: "/mcp " },
  { name: "/wechat", category: "integration", summary: "WeChat 二维码登录 + worker" },
];

/** 简单 fuzzy match：所有 query 字符按序出现在 candidate 中即命中 */
export function fuzzyMatch(query: string, candidate: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** 给候选项打分用于排序：name 命中权重 > summary > category */
export function scoreEntry(query: string, entry: SlashEntry): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  let score = 0;
  if (entry.name.toLowerCase().startsWith("/" + q.replace(/^\//, ""))) score += 100;
  if (entry.name.toLowerCase().includes(q)) score += 50;
  if (entry.summary.toLowerCase().includes(q)) score += 20;
  if (entry.category.toLowerCase().includes(q)) score += 5;
  return score;
}
