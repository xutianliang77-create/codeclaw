# CodeClaw Slash 命令清单

> 版本：M3 + P2-M4 全套（2026-04-26）· 共 35 个 builtin 命令
> 所有命令在 CLI/Web/WeChat 入口均通过 `SlashRegistry` 同一实现派发。
> 实现位置：`src/commands/slash/builtins/*.ts`，注册入口 `src/commands/slash/loader.ts`。

## 分组速览

| 类别 | 命令 |
|---|---|
| help | `/help` |
| session | `/ask` `/end` `/export` `/forget` `/init` `/resume` `/session` `/status` |
| workflow | `/commit` `/fix` `/orchestrate` `/plan` `/review` |
| memory | `/compact` `/graph` `/memory` `/preferences` `/rag` `/remember` `/summary` |
| observability | `/context` `/cost` `/debug-tool-call` `/diff` `/doctor` |
| permission | `/approvals` `/mode` |
| provider | `/model` `/providers` |
| plugin | `/hooks` `/reload-plugins` `/skills` |
| integration | `/mcp` `/wechat` |

风险标记：
- `low` — 只读 / 本地纯展示
- `medium` — 切换会话或运行时状态，或对外部系统有受控副作用（如 `/wechat send`、`/mcp call`）
- `high` — 不可逆或不易回滚（删数据库记录、触发 LLM 多轮并可能写文件）

---

## help

### `/help`
- **risk**: low
- **summary**: 列出所有可用命令（按 category 分组）
- **用法**: `/help`

---

## session（会话生命周期）

### `/ask [<question>]`
- **risk**: low
- **summary**: 装载一次性 plan mode 做只读问答；下一轮自动恢复之前的 mode
- **用法**:
  - `/ask` — 装弹后另起一行输入问题
  - `/ask <question>` — 同一轮直接提交问题（rewrite 走主对话）
- **实现要点**: queryEngine 设 `askModePending`，下轮 `evaluate` 强制走只读分支

### `/end`
- **risk**: low
- **summary**: 当前会话总结后存入 L2 Memory（数据库 `memory_digest` 表）
- **用法**: `/end`
- **副作用**: 调 LLM 生成 digest；下次同 (channel,userId) 进来会自动召回最近 5 条

### `/export [<path>]`
- **risk**: low
- **summary**: 导出当前会话（transcript + metadata）到文件
- **用法**:
  - `/export` — 默认写入 `~/.codeclaw/sessions/`
  - `/export <path>` — 写到指定路径

### `/forget --all | --session <id> | --since <ms>`
- **risk**: high
- **summary**: 清理 `~/.codeclaw/data.db` 的 `memory_digest` 表（不动 audit log / sessions）
- **用法**:
  - `/forget --all` — 清空所有 digest
  - `/forget --session <id>` — 仅清单个 session
  - `/forget --since <ms>` — 清 `created_at < ms` 的记录

### `/init`
- **risk**: low
- **summary**: 初始化自检（依赖 / 数据目录 / provider / token 文件）
- **用法**: `/init`

### `/resume`
- **risk**: low
- **summary**: 中断后恢复 — 显示 pending approvals 或 session summary
- **用法**: `/resume`

### `/session`
- **risk**: low
- **summary**: 显示 session id、消息计数、最近一段 assistant 输出
- **用法**: `/session`

### `/status`
- **risk**: low
- **summary**: 一行总览 — session / provider / model / pending approval
- **用法**: `/status`

---

## workflow（业务流程）

### `/commit`
- **risk**: low
- **summary**: 只读预览待提交的 git 改动（status + diff stat + secret 扫描）
- **用法**: `/commit`
- **注**: 不会真的 commit；自动生成 commit message 暂未启用

### `/fix <bug> [-- verify "<test cmd>"]`
- **risk**: high
- **summary**: 走 fix 意图的 orchestration（plan + execute），可能改文件
- **用法**:
  - `/fix <bug description>`
  - `/fix <bug> -- verify "npm test"`
- **行为**:
  - v2: pre/post 用 verify 命令验证，附 `git diff --stat`
  - v3 diff_scope: diff 超 5 文件或 300 行 → 输出 `diff-scope: ABORT`（不自动回滚）
  - v3 auto-verify: 未传 `--verify` 时按 `package.json/pyproject.toml/Cargo.toml/go.mod` 自动选 `npm test / pytest / cargo test / go test ./...`

### `/orchestrate <goal>`
- **risk**: high
- **summary**: 完整 Planner→Executor→Reflector 周期
- **用法**: `/orchestrate <goal>`
- **注**: 风险步骤会进入 pending approvals（`/approvals` 处理）

### `/plan <goal>`
- **risk**: low
- **summary**: 仅生成 plan 步骤，不执行（无副作用）
- **用法**: `/plan <goal>`

### `/review <goal>`
- **risk**: medium
- **summary**: review skill 下的 plan + execute，不改文件
- **用法**: `/review <goal>`
- **注**: 提议的风险步骤会进 pending orchestration approvals

---

## memory（记忆 / 偏好 / 上下文压缩）

### `/compact [<N>]`
- **risk**: low
- **summary**: 把更早的消息压成 summary，保留近 N 条
- **用法**:
  - `/compact` — 默认保留近若干条
  - `/compact <N>` — 保留最近 N 条

### `/memory`
- **risk**: low
- **summary**: 显示压缩 summary 数量及最近一次压缩状态
- **用法**: `/memory`

### `/graph <build | callers | callees | dependents | dependencies | symbol | status>`
- **risk**: low
- **summary**: workspace CodebaseGraph（TS/JS imports + 调用链）构建 / 查询
- **用法**:
  - `/graph` — status (symbols/imports/calls 计数)
  - `/graph build` — 全量重建
  - `/graph callers <name> [callee_path]` — 谁调用 name（可选 callee_path 限定）
  - `/graph callees <file_path>` — file 调了哪些 callee
  - `/graph dependents <file_path>` — 哪些文件 import 了 file
  - `/graph dependencies <file_path>` — file 依赖了哪些 module / 文件
  - `/graph symbol <name|path>` — 按名查 symbol，或按 path 列文件全部 symbol
- **存储**: `~/.codeclaw/projects/<hash>/rag.db`（与 RAG 共用）
- **当前**: TS/JS only；Python / Go / Rust pending
- **配套 native tool**: `graph_query`（LLM 自动调）

### `/preferences <show | add <text> | user-add <text>>` (alias: `/prefs`)
- **risk**: low
- **summary**: 操作 `CODECLAW.md`（项目级 + 用户级），自动注入 system prompt
- **用法**:
  - `/preferences show` — 输出两层 CODECLAW.md 当前内容
  - `/preferences add <text>` — 追加一行到 `<cwd>/CODECLAW.md`
  - `/preferences user-add <text>` — 追加到 `~/.codeclaw/CODECLAW.md`
- **行为**:
  - 自动加 markdown bullet `- ` 前缀（用户已带 `-` 或 `*` 不重复加）
  - 文件不存在自动创建并加 `# CodeClaw Preferences\n\n` 头
  - 64KB 上限；超出抛错让用户手工瘦身
- **$EDITOR mode**: M3+

### `/rag <index | embed | search <q> | status | clear>`
- **risk**: low
- **summary**: workspace 代码 RAG 索引（BM25 关键字 + bge-m3 向量混合召回）
- **用法**:
  - `/rag` — status（chunks / embedded / last-indexed / workspace）
  - `/rag index` — 全量 / 增量索引（hash 比对 skip 未变文件）
  - `/rag embed` — 批量补缺向量（默认每次 ≤ 500 chunk；`bge-m3` 模型）
  - `/rag search <query>` — 自动选 hybrid（embedded > 0 时）否则降级 BM25
  - `/rag clear` — 清空索引（不重建，需再 `/rag index`）
- **行为**:
  - chunks 默认 30 行/chunk + 5 行 overlap；跳过 binary / > 500KB / node_modules / dist 等
  - 向量召回 + BM25 通过 RRF 融合（k=60）；返回 top 8 含 src 来源标识
  - embed 模型可通过 `CODECLAW_RAG_EMBED_MODEL` env 改；`CODECLAW_RAG_EMBED_BASE_URL` 改 endpoint
- **存储**: `~/.codeclaw/projects/<hash>/rag.db`
- **配套 native tool**: `rag_search`（LLM 自动调）

### `/remember <text>`
- **risk**: low
- **summary**: 持久化一条 user-type 项目长期记忆
- **存储**: `~/.codeclaw/projects/<hash>/memory/user_note_<ts>.md`
- **效果**: 未来同 workspace 会话的 system prompt 会列出 Project Memory 段
- **用法**: `/remember <text>`

### `/summary`
- **risk**: low
- **summary**: 显示最近一次 compaction summary（如有）
- **用法**: `/summary`

---

## observability（可观测）

### `/context`
- **risk**: low
- **summary**: 当前轮数 / 消息数 / 字符数 / 估算 token
- **用法**: `/context`

### `/cost`
- **risk**: low
- **summary**: session 活动快照（消息 / token / 文件 / approval 计数）
- **用法**: `/cost`
- **注**: provider 真实 input/output token 用量尚未接通（P0 W3 计划）；当前 token 数为本地 heuristic

### `/debug-tool-call [<toolName>]`
- **risk**: low
- **summary**: 检查最近一次 tool 调用的 input/output/error
- **用法**:
  - `/debug-tool-call`
  - `/debug-tool-call <toolName>` — 按 tool 名筛选

### `/diff`
- **risk**: low
- **summary**: 列出本次 session 修改 / 创建过的文件
- **用法**: `/diff`

### `/doctor` (alias: `/diag`)
- **risk**: low
- **summary**: 健康检查 — SQLite / Node / OS / 关键依赖 / WeChat token 文件
- **用法**: `/doctor`

---

## permission（权限）

### `/approvals`
- **risk**: low
- **summary**: 列出 pending tool / orchestration approvals
- **用法**: `/approvals`
- **配套**: `/approve <id>` / `/deny <id>`（dynamic 命令，不在本清单内）

### `/mode [<name>]`
- **risk**: medium
- **summary**: 查看 / 切换 permission mode
- **可选 mode**: `default` `plan` `auto` `acceptEdits` `bypassPermissions` `dontAsk`
- **用法**:
  - `/mode` — 查看当前
  - `/mode <name>` — 切换
- **注**: 切换走 `runModeCommand` 入口（含 audit log）

---

## provider（模型 / 提供商）

### `/model [<id>]`
- **risk**: medium
- **summary**: 查看 / 切换当前 model
- **用法**:
  - `/model` — 显示当前
  - `/model <id>` — 切到 `<id>`（必须在 provider chain 中存在）

### `/providers`
- **risk**: low
- **summary**: 显示当前 + fallback provider/model
- **用法**: `/providers`

---

## plugin（扩展）

### `/hooks`
- **risk**: low
- **summary**: 列出 5 个 lifecycle 时点配置的 hook 命令
- **5 个时点**: `PreToolUse` `PostToolUse` `UserPromptSubmit` `Stop` `SessionStart`
- **配置**: 路径优先级 `<workspace>/.codeclaw/settings.json` > `~/.codeclaw/settings.json` > `~/.claude/settings.json`
  ```json
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "^bash$",
        "hooks": [{ "type": "command", "command": "scripts/precheck.sh", "timeout": 5000 }]
      }],
      "Stop": [{ "hooks": [{ "type": "command", "command": "scripts/notify.sh" }] }]
    }
  }
  ```
- **行为**:
  - `PreToolUse` / `UserPromptSubmit` 阻塞型（exit≠0 拦截执行）；其他副作用型
  - 默认超时 5s；`UserPromptSubmit` 默认 200ms（严格阻塞 IO）
  - matcher（仅 PreToolUse / PostToolUse）regex 匹配 tool name；非法 regex 视为不匹配
  - fail-open：spawn 错 / timeout 不阻塞主流程（避免 hook 故障锁死所有 IO）
- **用法**: `/hooks`

### `/reload-plugins`
- **risk**: low
- **summary**: 从磁盘重新加载 skills / hooks registry
- **用法**: `/reload-plugins`

### `/skills [<name> | off]`
- **risk**: low
- **summary**: 列出 / 激活 / 停用 skill
- **用法**:
  - `/skills` — 列表
  - `/skills <name>` — 激活
  - `/skills off` — 停用当前 skill

---

## integration（外部集成）

### `/mcp <(无参) | resources | tools | read | call>`
- **risk**: medium
- **summary**: 真 spawn MCP server（M3-01）+ 内置 in-process workspace-mcp，混合展示
- **用法**:
  - `/mcp` — 列出所有 server（含 spawn server status / 重启次数 / 错误）
  - `/mcp resources <server>` — 资源列表
  - `/mcp tools <server>` — 工具列表（spawn server 优先，否则 fallback in-process）
  - `/mcp read <server> <resource>` — 读 resource（受 approval 控制）
  - `/mcp call <server> <tool> [json|raw input]` — 调用 tool；输入按 JSON 解析失败则 `{input: <raw>}`
- **配置**（路径优先级）: `<workspace>/.mcp.json` > `~/.codeclaw/mcp.json`
  ```json
  {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
      }
    }
  }
  ```
- **行为**:
  - 启动并发 spawn 所有 enabled server；失败 server 不阻塞主进程
  - 子进程崩溃 → 1s/2s/4s/8s/16s 指数退避，最多 5 次重启（超过 → status=failed）
  - LLM 看到的 tool 名为 `mcp__<server>__<tool>`（自动 sanitize 非法字符）
  - 命名空间：每个 server 暴露的 tool 自动桥接进 ToolRegistry，与 builtin / RAG / Graph 不冲突

### `/wechat <status | login | send <to> <text>>`
- **risk**: medium
- **summary**: WeChat iLink 控制
- **用法**:
  - `/wechat status` — 当前 token 状态
  - `/wechat login` — 启 QR 登录流程
  - `/wechat send <to> <text>` — 通过 iLink 发消息

---

## 配套（不在 builtin 列表，但用户可见）

| 命令 | 说明 |
|---|---|
| `/approve <id>` `/deny <id>` | 处理 `/approvals` 列表中的待批 |
| `/clear` | 清屏（CLI runtime） |
| `/quit` `/exit` | 退出 |
| `/<skill-command>` | skill manifest 声明的 commands 自动注册 |

---

## Native Tool 总览（`CODECLAW_NATIVE_TOOLS=true` 时 LLM 可调）

| tool | 来源 | env 关闭 |
|---|---|---|
| `read` `glob` `symbol` `definition` `references` | M1-B builtin（只读） | — |
| `bash` `write` `append` `replace` | M1-B builtin（写改） | — |
| `memory_write` `memory_remove` | M2-02 跨会话 memory | `CODECLAW_PROJECT_MEMORY=false` |
| `ExitPlanMode` | M2-03 plan 双阶段 | `CODECLAW_PLAN_MODE_STRICT=false` |
| `mcp__<server>__<tool>` | M3-01 真 spawn 的 MCP server | （删除 `~/.codeclaw/mcp.json`） |
| `Task` | M3-02 派生 8 个 builtin role 的 subagent | `CODECLAW_SUBAGENT=false` |
| `rag_search` | #75 P2-M4 BM25+bge-m3 混合召回 | `CODECLAW_RAG=false` |
| `graph_query` | #76 P2-M4 CodebaseGraph 调用链 / import | `CODECLAW_GRAPH=false` |

8 个 Subagent role: `general-purpose` / `Explore` / `Plan` / `code-reviewer` / `feature-dev` / `simple-executor` / `code-simplifier` / `deep-reviewer`，工具集与 permissionMode 各异（详见 `src/agent/subagents/roles.ts`）。

---

## 设计速记

- **dispatch**: 用户输入 `/` 开头的行 → CLI 走 `SlashRegistry.handle`，命中 builtin 则同步/异步返回 `reply`/`rewrite`/`error`；未命中走 LLM
- **`reply` vs `rewrite`**:
  - `reply` — 命令直接产出文本（不调 LLM）
  - `rewrite` — 用命令翻译出的新 prompt 走 LLM（如 `/ask <q>`）
- **risk 用途**: CLI/Web `/help` 渲染 + audit log 标记 + 个别 mode（如 `auto`）的 gate
- **跨入口一致**: CLI/Web/WeChat 共用同一个 registry；新增命令仅需 `builtins/<name>.ts` + `loader.ts` BUILTINS 数组
- **`CODECLAW_NATIVE_TOOLS=true` 模式下**: tools schema 进 system prompt，`/ask` `/plan` 等命令仍走原 slash 路径，不被 LLM 工具调用替代
- **存储位置一览**:
  - `~/.codeclaw/data.db` — 全局 audit / sessions / memory_digest（跨 workspace）
  - `~/.codeclaw/projects/<sha256(realpath(workspace)):16>/`
    - `memory/` `MEMORY.md` + user_note 列表（M2-02 跨会话项目级 memory）
    - `rag.db` — RAG 索引 + CodebaseGraph 共用（rag_chunks / rag_terms / cg_imports / cg_symbols / cg_calls）
  - `~/.codeclaw/CODECLAW.md` — 用户级 preferences
  - `<workspace>/CODECLAW.md` — 项目级 preferences（覆盖用户级）
  - `~/.codeclaw/mcp.json` 或 `<workspace>/.mcp.json` — MCP server 配置
  - `~/.codeclaw/settings.json` 或 `<workspace>/.codeclaw/settings.json` — hooks + statusLine
