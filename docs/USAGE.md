# CodeClaw 使用指南

按"用户视角的工作流"组织，不重复 [SLASH_COMMANDS.md](./SLASH_COMMANDS.md) 的命令字典。

> 还没装？先看 [INSTALL.md](./INSTALL.md)。

---

## 0. 心智模型

| 概念 | 一句话 |
|---|---|
| **slash 命令** | `/<name>` 开头；本地直接处理（`/help` `/diff` 等）或改写后送 LLM（`/ask <q>`）|
| **native tool** | LLM 自己决定调用的工具（`read`/`bash`/`rag_search` 等），用户不直接打 |
| **permission mode** | `default` / `plan`（只读）/ `auto`（不询问）/ `acceptEdits`（自动批准编辑）/ `bypassPermissions` / `dontAsk`，用 `/mode` 切 |
| **CODECLAW.md** | 项目级 + 用户级偏好，自动注入 system prompt |
| **memory** | L1 当前会话 / L2 跨会话摘要 / 项目级 memory（M2-02）|

启 codeclaw 后，第一行打 `/help` 看全部命令；第二行打 `/status` 看当前 provider/mode/cwd。

---

## 1. 工作流：理解一个陌生代码库

```
/rag index                       # 一次性全量索引（增量后续自动）
> 这个项目的 auth 流程是怎么走的？
```

LLM 会自动：
1. 调 `rag_search` 找 auth 相关的代码块
2. 调 `graph_query type=callers` 看入口被谁调
3. 调 `read` 看具体实现
4. 用文字总结流程

效果对比"无 RAG/Graph"：
- 无：LLM 看不到代码全局，只能基于当前 cwd 文件名猜
- 有：高置信度引用 file:line 给出回答

辅助命令：
- `/graph dependencies <path>` — 单文件依赖谁
- `/graph dependents <path>` — 谁依赖该文件
- `/graph callers <funcName>` — 谁调用了这个 symbol

---

## 2. 工作流：写代码（plan → execute → review）

### 2.1 安全模式：先 plan 再执行

```
/mode plan                       # 切到只读模式
> 我想把 src/foo 重构成 src/lib/foo + src/api/foo 两层
```

LLM 在 plan mode 只能读不能写；它会用 read/glob/symbol 探查后给出步骤计划，最后调 `ExitPlanMode` tool 提交计划。

确认计划合理后：

```
/mode default                    # 切回常规
> 按计划执行
```

LLM 这时能写 / bash / 调任意 tool。每次写文件前会请求批准（permission gate）。

### 2.2 直接 orchestrate（适合范围明确的小任务）

```
/orchestrate 把 src/utils/foo.ts 的 toString 方法改成 toJSON
```

走 Planner → Executor → Reflector 闭环，自动跑完。风险步骤进 pending approval（`/approvals` 看 / `/approve <id>` 批）。

### 2.3 配套：commit 预览

```
/commit
```

只读输出 `git status` + `git diff --stat`，不真 commit。让你心里有数后再手 `git commit`。

---

## 3. 工作流：调试 bug

```
/fix 跑 npm test 时 user.test.ts 第 23 行抛 'Cannot read property of undefined'
```

`/fix` 加载 fix skill 后跑 plan + execute；可选附验证命令：

```
/fix <bug> -- verify "npm test"
```

未传 `--verify` 时会自动探测：`package.json scripts.test` → `npm test`，`pyproject.toml` → `pytest`，`Cargo.toml` → `cargo test`，`go.mod` → `go test ./...`。

行为亮点：
- v3 diff_scope：diff 超 5 文件或 300 行 → 输出 `diff-scope: ABORT`（不自动回滚，你判断要不要 reset）
- v2 pre/post verify：fix 前后都跑 verify 命令；前红后绿才算"修好"
- 跑完附 `git diff --stat`

---

## 4. 工作流：大型 refactor（subagent 分治）

主对话不希望被探查代码的细节淹没？让 subagent 跑：

```
> 用 Task tool 让 Explore role 找出所有引用 deprecated API `oldFoo()` 的地方，
  然后让 simple-executor role 一个个改成 `newFoo()`。
```

LLM 会调两次 Task：
1. `Task(role="Explore", prompt="...")` — 子 agent 在 plan mode 用 read/glob/grep 找位置，返回列表（不污染父 context）
2. `Task(role="simple-executor", prompt="...")` — 子 agent 用 acceptEdits mode 逐个改

8 个内置 role：

| role | 默认 mode | 工具集 | 用途 |
|---|---|---|---|
| `general-purpose` | default | 全集 | 通用兜底 |
| `Explore` | plan | read-only | 只读探查 |
| `Plan` | plan | read+ExitPlanMode | 设计方案 |
| `code-reviewer` | plan | read-only | 复核 PR |
| `feature-dev` | default | 全集 | 功能开发 |
| `simple-executor` | acceptEdits | read+write+bash | 范围明确的局部改 |
| `code-simplifier` | default | read+write | 完成功能后清理 |
| `deep-reviewer` | plan | read+bash | 高价值复杂改动审 |

子 agent 5 min wall clock 超时；不会递归（runner 内部 unregister Task tool）。

---

## 5. 工作流：让 codeclaw 记住偏好

### 5.1 一次性设定偏好

用户级（所有项目都生效）：

```
/preferences user-add 回答用中文
/preferences user-add 代码注释也用中文
```

写入 `~/.codeclaw/CODECLAW.md`。

项目级（仅本项目）：

```
/preferences add 这个项目用 vitest 不用 jest
/preferences add 测试写在 test/unit 下
```

写入 `<workspace>/CODECLAW.md`。项目级覆盖用户级。

### 5.2 即时事实记忆

发现一些重要事实想让 codeclaw 跨会话记住：

```
/remember 用户的 ASR endpoint 是 internal-asr.corp:7180，token 在 ~/.asr-token
```

写入 `~/.codeclaw/projects/<hash>/memory/user_note_<ts>.md`，下次同 workspace 启动时 system prompt 自动注入"Project Memory"段。

### 5.3 LLM 主动记忆

LLM 在调用 `memory_write` tool 时也会沉淀事实，未来同 workspace 会议可见。

`/memory` 看当前压缩 summary 数；`/forget --all` 清空所有跨会话 digest（不影响当前 transcript）。

---

## 6. 工作流：长对话不爆 context

CodeClaw 默认两道防线：
- **70% 用量** → 控制台 warn
- **95% 用量** → 自动 autoCompact（早期消息被 LLM 摘要后保留）

手动触发：

```
/compact            # 默认保留近若干条
/compact 5          # 保留最近 5 条
/summary            # 只看最近一次压缩 summary
```

或会话末尾持久化到 L2：

```
/end                # LLM 总结当前 session → 存 ~/.codeclaw/data.db memory_digest
```

下次同 (channel, userId) 启动 codeclaw，最近 5 条 digest 自动召回到 system prompt 顶部。

---

## 7. 进阶：MCP 集成

把外部 MCP server（filesystem / github / 数据库等）的工具暴露给 LLM。

`~/.codeclaw/mcp.json`:

```json
{
  "servers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/notes"]
    }
  }
}
```

启动 codeclaw 后，LLM 自动看到 `mcp__fs__read_file` / `mcp__fs__list_directory` 等工具。`/mcp` 看 status / 重启计数。

```
/mcp                                        # 列所有 server 状态
/mcp tools fs                               # fs server 的工具
/mcp call fs read_file '{"path":"/data/notes/x.md"}'   # 直接调
```

设计：失败 server 不阻塞主进程；崩溃指数退避重启 1/2/4/8/16s 上限 5 次。

---

## 8. 进阶：Hooks 拦截 / 通知

`~/.codeclaw/settings.json` 配 lifecycle hook：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$1\" | grep -qE 'rm -rf|sudo'; then exit 1; fi",
            "timeout": 5000
          }
        ]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "notify-send 'CodeClaw turn done'" }] }
    ]
  }
}
```

5 时点：
- `PreToolUse` — tool invoke 之前；exit≠0 阻塞 + stderr 当 tool result 反馈给 LLM
- `PostToolUse` — invoke 之后；副作用型（lint / 转发审计）
- `UserPromptSubmit` — 用户消息进 transcript 之前；exit≠0 拦截
- `Stop` — message-complete 之后；统计 / 通知
- `SessionStart` — createQueryEngine 完成后；初始化外部状态

热重载：`kill -HUP $(pgrep -f codeclaw)`。

---

## 9. 进阶：自定义 Status line

`~/.codeclaw/settings.json` 加：

```json
{
  "statusLine": {
    "command": "echo \"$(git branch --show-current 2>/dev/null) · $(date +%H:%M)\"",
    "intervalMs": 2000
  }
}
```

ink CLI 底部出现 cyan 状态条；命令失败降级显示 `[status line failed]`。

---

## 10. Web / WeChat 通道

### Web

```bash
export CODECLAW_WEB_TOKEN=your-strong-token
codeclaw web                                  # 默认 127.0.0.1:7180
codeclaw web --port=8080 --host=0.0.0.0       # 局域网共享（注意自负安全）
```

浏览器打开 `http://127.0.0.1:7180`，token 填同值；每个浏览器会话独立 queryEngine 实例。

**阶段 A 已上**：5 个 tab + 多会话侧栏 + 状态栏

| Tab | 功能 |
|---|---|
| Chat | 与 LLM 对话（与 CLI / Wechat 同 SSE 流）|
| RAG | `/rag index` `/rag embed` `/rag search` 的 GUI；展示 chunk / embedding 状态 |
| Graph | `/graph build` + 5 类查询（callers / callees / dependents / dependencies / symbol）|
| MCP | server 状态卡片 + tools 浏览 + test-call 调试器（mcpManager 注入后可用）|
| Hooks | settings.json hooks 树形展示 + 热重载按钮（等价 SIGHUP 信号）|

**多会话**：左侧栏可见所有 active session；阶段 A 仅展示 + 新建（切会话 SSE 重连留 阶段 B）。

**状态栏**：底部 cyan 一行；每 5s `GET /v1/web/status-line` 轮询。

**已知限制（阶段 A）**：
- subagent 工作树仅返 placeholder（`{subagents:[], note:"coming in stage B"}`）；后端尚未推流
- 索引 / 构建大型 workspace 时无进度条，同步等待 + spinner（阶段 B 加 SSE 子流）
- wechat / web 通道的 cron `--notify=` 仍为占位（阶段 🅑 cron 接通）

#### 阶段 B `/next` 通道（React + Vite，开发中）

打开 `http://127.0.0.1:7180/next`（与 `/legacy` 双 URL 共存）：

| 能力 | 说明 |
|---|---|
| Chat 虚拟滚动 | `@tanstack/react-virtual` 支持 N≥10K message；自动贴底 80px 阈值 |
| 流式 markdown | `react-markdown` + `rehype-highlight`；流式中尾巴闪烁光标 ▋ |
| Tool 折叠卡 | 点击展开 detail；按 status 着色（running/completed/blocked/failed/pending）|
| Monaco viewer | RAG hit 大块 / 已知扩展名（.ts/.py 等）走 Monaco 行号 + 折叠 + 语法高亮（lazy-load，self-host 离线可用）|
| ApprovalCard | SSE `approval-request` → 弹卡片；Approve / Deny 按钮直接发 `/approve` `/deny` |
| Graph d3-force | 节点拖动 / 缩放 / 平移 / 双击切查询；>500 节点警告 |
| ⌘K Palette | Cmd/Ctrl+K 打开；模糊搜 36 命令；Enter 注入 chat composer |
| Subagent Tab | 每 3s 拉一次 `/subagents`；当前后端是 placeholder，等 B.8 推流接通 |

构建：

```bash
cd web-react
npm install      # 一次性
npm run build    # 产出 dist/
cd .. && bun run build   # 主仓 build.mjs 把 web-react/dist 拷到 dist/public-react/
codeclaw web --port=7180   # 同时 serve /legacy 与 /next
```

未跑 `cd web-react && npm install && npm run build` 时 `/next` 返 404，不影响 `/legacy`。

### WeChat

```bash
codeclaw wechat                # webhook 模式（被动响应）
codeclaw wechat --worker       # iLink 长轮询模式
```

详见 [WECHAT_BOT.md](./WECHAT_BOT.md)。

---

## 11. 工作流：定时任务（cron）

`/cron` 在 codeclaw 进程内做定时调度，三类 task：

| kind | 含义 | 示例 |
|---|---|---|
| `slash` | 跑 builtin slash 命令 | `slash:/rag\ index` |
| `prompt` | 让 LLM 自由处理一段 prompt（无 `/` 前缀） | `prompt:"review this week's commits"` |
| `shell` | spawn shell 子进程 | `shell:"npm audit"` |

**重要约束**：cron 只在 codeclaw 在前台时跑。要 24×7 跑请走 OS-level cron（crontab）调
`scripts/nightly.mjs` 类似入口；本节内置 cron 与之互不干扰。

### 11.1 添加任务

```bash
/cron add rag-daily "0 2 * * *" slash:/rag\ index --notify=cli
/cron add weekly-review "0 9 * * 1" prompt:"review repo this week" --notify=cli
/cron add audit-hourly "@hourly" "shell:npm audit --production"
```

支持的 schedule：
- 标准 5 字段 `分 时 日 月 周`，含 `*` `1,3,5` `1-5` `*/15`
- 别名 `@hourly` / `@daily` / `@weekly` / `@monthly`
- 区间 `@every 30s` / `@every 5m` / `@every 1h`

时间使用本地时区（与 crontab(5) 一致）。DST 切换日推荐用 `@every` 表达式避开。

### 11.2 列 / 切 / 跑 / 看

```bash
/cron                      # 等价 /cron list
/cron list                 # 表格：id / name / schedule / kind / enabled / last-run
/cron disable rag-daily    # 暂停（不删除）
/cron enable rag-daily     # 重新启用
/cron run-now rag-daily    # 立刻跑一次（不影响下次定时）
/cron logs rag-daily --tail=5    # 最近 5 次运行历史
/cron remove rag-daily     # 永久删除
```

### 11.3 通知去向 (`--notify`)

任务跑完后默认仅写 jsonl 日志。加 `--notify=cli` 把摘要注入当前 chat（一条 local 消息）：

```
[Cron · rag-daily · ok · 1234ms]
files-scanned: 856
files-indexed: 0
chunks-upserted: 0
```

阶段🅐：`cli` 通道。
阶段🅑（接通）：
- `web` 通道：`codeclaw web` 子命令独建 cron host engine，cron 触发后通过 SSE `cron-result`
  事件广播到所有 active web session（chat tab 末尾出现 system 消息）。
- `wechat` 通道（仅 worker 模式生效）：cron 触发 → wechatService.sendToActive 入外发队列
  → 下次 worker poll 投递给"最后活跃"的 wechat 会话。webhook 模式无 poll，外发要等用户
  下次发消息触发；无 active 接收方时静默丢弃 + console.warn。

### 11.4 任务模板（阶段🅑）

5 个 builtin 模板免去记 cron 表达式：

```
/cron template list
# key              schedule    kind   description
# daily-rag        0 2 * * *   slash  每天凌晨 2 点跑 /rag index 增量重建索引
# weekly-review    0 9 * * 1   prompt 每周一 9 点让 LLM 审本周 commits + 写技术债报告
# hourly-audit     @hourly     shell  每小时跑 npm audit（仅 production deps）
# graph-rebuild    0 3 * * *   slash  每天凌晨 3 点重建 CodebaseGraph
# session-summary  0 */6 * * * prompt 每 6 小时让 LLM 总结当前 session

/cron template add daily-rag           # 用 default name
/cron template add weekly-review wr    # 自定义 name
```

### 11.5 sqlite 历史（阶段🅑）

除 jsonl 文件外，运行历史也写入 `~/.codeclaw/data.db` 的 `cron_runs` 表。便于 SQL 聚合：

```sql
SELECT task_name, status, COUNT(*) FROM cron_runs
WHERE ended_at > strftime('%s','now','-7 days') * 1000
GROUP BY task_name, status;
```

### 11.6 行为速记

- 调度精度：30s tick + ±60s 漂移补偿；同任务 1 分钟内最多 1 次触发
- 默认超时：slash/prompt 5 min；shell 1 min；用 `--timeout=10m` / `30s` 覆盖
- 任务异常 fail-soft：jsonl 记错 + 标 `lastRunStatus=error`，不阻塞其它任务
- 关闭：`CODECLAW_CRON=false codeclaw` 紧急回退；删 `~/.codeclaw/cron.json` 清空所有任务
- 配置文件：`~/.codeclaw/cron.json`（手动编辑请保持合法 JSON；损坏文件会自动备份成 `.bak.<ts>`）

---

## 12. 故障速查

| 现象 | 命令 |
|---|---|
| 不知道命令叫啥 | `/help` |
| LLM 答不对 | `/context` 看是不是 token 用满了 → `/compact` |
| 不知道当前哪个 provider | `/status` |
| 想换模型 | `/model <id>` 或 `/providers` 看链 |
| 失败的 tool 调用想看详情 | `/debug-tool-call` |
| 想看 session 跑了多久 | `/cost` |
| 全栈失忆要求重启 | `/end`（先存 digest）然后退出再启 |

---

## 13. 速记：常用键 + 命令

| | |
|---|---|
| Enter | 发送 |
| Ctrl-C | 中断（运行中）/ 退出（空闲时）|
| Esc | 清 banner |
| `a` / `d`（无输入时）| 同意 / 拒绝当前 pending approval |
| `/exit` 或 `/quit` | 退出 |
| `/help` | 命令列表 |
| `/status` | 一行总览 |
| `/mode plan` | 切只读 |
| `/ask <q>` | 一次性只读问答（自动恢复 mode）|

---

更深内容：

- 命令字典 → [SLASH_COMMANDS.md](./SLASH_COMMANDS.md)
- 安装 / 排错 → [INSTALL.md](./INSTALL.md)
- HTTP API → [HTTP_API.md](./HTTP_API.md)
- WeChat 集成 → [WECHAT_BOT.md](./WECHAT_BOT.md)
- 真 LSP 后端 → [LSP_SETUP.md](./LSP_SETUP.md)
