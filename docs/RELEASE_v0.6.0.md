# CodeClaw v0.6.0

Channels & Scheduling release — 把 cron / Web 通道做完整，前端 React 重写到 IDE 级体验。

## Highlights

### Cron · 内置定时任务（#116）

- `/cron list | add | remove | enable | disable | run-now | logs`
- 3 类 task：`slash` / `prompt` / `shell`
- Schedule：标准 5 字段 + `@hourly` `@daily` `@weekly` `@monthly` + `@every 30s|5m|1h`
- 持久化：`~/.codeclaw/cron.json` + jsonl 运行历史 + sqlite `cron_runs` 表（双写）
- 通知：`--notify=cli` 注入 chat / `--notify=web` SSE 广播 / `--notify=wechat` worker 外发队列
- 5 个 builtin 模板：`/cron template add daily-rag` 一句话加任务
- env `CODECLAW_CRON=false` 紧急回退

### Web 通道 · 阶段 A（vanilla SPA · `/legacy`）（#114）

- 13 个新 endpoint：MCP 3 / Hooks 2 / RAG 4 / Graph 3 + status-line + subagents
- 5 个 panel：Chat / RAG / Graph / MCP / Hooks
- 多会话侧栏（list + 新建）
- 状态栏 5s 轮询
- `codeclaw web` 子命令：mcpManager + settings + provider chain 全部注入
- SIGHUP 热重载：广播给所有 active session engine

### Web 通道 · 阶段 B（React + Vite · `/next`）（#115）

- 子包 `web-react/` 独立 npm package（不污染主仓）
- Vite 5 + React 19 + TypeScript + Tailwind 3 + zustand
- ChatPane：`@tanstack/react-virtual` 虚拟滚动（≥10K message）+ 流式 markdown + tool 折叠卡 + 自动贴底
- Graph：d3-force 自实现（节点拖动 / 缩放 / 平移 / hover / 双击切查询）
- ⌘K Command Palette：模糊搜 36 slash 命令 → Enter 注入 chat composer
- Monaco viewer：lazy-load + self-host（离线可用）；RAG hit 大块走行号 + 折叠
- ApprovalCard：SSE `approval-request` → 卡片 → Approve/Deny 一键
- Subagent Tree：SSE `subagent-start/end` 实时推送 + polling 兜底
- 主题切换：auto / light / dark；CSS variables + `[data-theme]`
- bundle 拆分：vendor / d3 / virtual / Monaco lazy

### 后端 SSE 流增强

- 新事件类型：`subagent-start` / `subagent-end` / `cron-result`
- `?token=` query 鉴权 fallback（EventSource 不能设 header）
- `SubagentRegistry` 跟踪每会话子 agent 调用历史

### Wechat 外发通道（#116 阶段 🅑）

- `WechatBotAdapter.outboundQueue` + `enqueueOutboundText` / `drainOutboundQueue`
- `WechatBotService.sendToActive(text)` API
- worker 每轮 poll 三路合并发送：response cards + sync cards + outbound cards
- cli.tsx 把 sendToActive 注入 cron `--notify=wechat` 适配器

## Numbers

| 项 | v0.5.0 | v0.6.0 |
|---|---|---|
| Slash 命令 | 33 | 36（+`/cron`，加 template 子命令）|
| 主仓单测 | ~754 | 1272 |
| Web 通道端点 | 8 | 22 |
| 子包 | 0 | 1（web-react）|
| 文件总数（src） | ~150 | ~180 |

## Validation Snapshot

通过：

- `npm run lint`（核心 src 0 error；测试侧 88 个 pre-existing 测试基础设施债另起 sweep）
- `npm run typecheck`（main + web-react 双仓 clean）
- `npm run test`（1272 题主仓 + 23 题 web-react，total 1295 全过）
- `bun run build`（dist + web-react/dist）

## Known Boundaries

- subagent 父子嵌套递归（runner unregister Task tool 防递归）— 单层 OK，深嵌套未深测
- cron DAG / 失败重试 / 跨机调度 / 任务依赖 → 阶段 🅒 路线图（未列入 v0.7 必做）
- B.12 Playwright e2e 推迟（100MB 浏览器 binary，CI 成本高）
- LSP node-native client（去 Python multilspy）→ P1+ 路线
- WeChat 富媒体（图片 / 文件 / 语音 outbound）

## Migration Notes (v0.5.0 → v0.6.0)

无需手工迁移。

- `~/.codeclaw/data.db` 自动跑 migration `003_cron_runs.sql`
- 旧 cron.json 兼容（schema 不变）
- 旧 vanilla web SPA 仍在 `/` 与 `/legacy`（无变化）
- 新 React UI 在 `/next`（首次需 `cd web-react && npm install && npm run build`）
- env `CODECLAW_CRON=false` 不变；`CODECLAW_WEB_TOKEN` 不变

## Recommended Next Steps

- v0.7：Cron 阶段 🅒（DAG / retry / 跨机）评估或推迟到 v0.8
- v0.7：MCP 远程托管 / 跨进程
- v0.7：WeChat 富媒体 outbound
- 工程：Playwright e2e + bundle 进一步 lazy split

## Acknowledgements

本 release 期间 deep-reviewer 审出 7 件完整性问题（A2 / B2 / C2 / D1 / E1 / F1 / P0）已全部修复。
