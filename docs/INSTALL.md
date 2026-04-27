# CodeClaw 安装与配置

本文覆盖：系统要求、安装、首次配置、各通道启动、配置文件参考、常见排错。

> 命令清单看 [SLASH_COMMANDS.md](./SLASH_COMMANDS.md)；日常使用工作流看 [USAGE.md](./USAGE.md)。

---

## 1. 系统要求

| 必需 | 版本 |
|---|---|
| Node.js | `22+` |
| npm | `10+` |
| Bun | `1.x`（仅 build 时需要；运行只需 Node） |
| OS | Linux / macOS / Windows（WSL2 推荐） |

| 可选 | 用途 |
|---|---|
| Python `3.x` + `venv` | 真实 LSP 后端（multilspy）；不装走 regex fallback |
| Ollama | 本地跑 bge-m3 embedding（`/rag embed`） |
| LM Studio | 本地 OpenAI 兼容服务（含 embedding） |

## 2. 安装

```bash
git clone <repo-url> CodeClaw
cd CodeClaw
npm install
bun run build       # 产出 dist/cli.js
```

### 全局软链（可选，让 `codeclaw` 命令全局可用）

```bash
npm link
codeclaw --version  # 确认软链生效
```

不软链直接用：`node dist/cli.js [args]`。

## 3. 首次配置：providers

CodeClaw 不内置 API key，必须先配。两条路径：

### 3.1 交互式（推荐首次用）

```bash
codeclaw setup
```

跟提示选 provider（OpenAI / Anthropic / Ollama / LM Studio / 自定义 OpenAI 兼容），填 baseUrl + apiKey + model，会生成：

- `~/.codeclaw/providers.json` — provider chain 配置
- 选定 provider 的 fallback chain（fallback 用 `codeclaw config` 后调）

### 3.2 直接编辑 `~/.codeclaw/providers.json`

```json
{
  "openai": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "timeoutMs": 30000,
    "apiKeyEnvVar": "CODECLAW_OPENAI_API_KEY"
  },
  "anthropic": {
    "enabled": true,
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-sonnet-4-6",
    "timeoutMs": 30000,
    "apiKeyEnvVar": "CODECLAW_ANTHROPIC_API_KEY"
  },
  "lmstudio": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "qwen/qwen3-32b",
    "timeoutMs": 240000,
    "maxTokens": 32768
  },
  "ollama": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:11434",
    "model": "llama3.1",
    "timeoutMs": 60000
  }
}
```

`apiKeyEnvVar` 字段告诉 CodeClaw 从哪个环境变量读 key（推荐做法，不存 key 到磁盘）：

```bash
export CODECLAW_OPENAI_API_KEY=sk-...
export CODECLAW_ANTHROPIC_API_KEY=sk-ant-...
```

### 3.3 选当前 provider + fallback chain

```bash
codeclaw config       # 交互式选
```

或直接编辑 `~/.codeclaw/selection.json`：

```json
{ "current": "lmstudio", "fallback": "openai" }
```

## 4. 验证

```bash
codeclaw doctor
```

绿色检查清单：
- ✅ Node 版本 ≥ 22
- ✅ ~/.codeclaw 目录存在
- ✅ providers.json 至少 1 个 enabled provider
- ✅ data.db 可读写
- ✅ audit.db 可读写

## 5. 启动

### 5.1 CLI（默认 ink TUI）

```bash
codeclaw
```

输入 `/help` 看所有命令；`/exit` 或 Ctrl-C 退出。

### 5.2 纯文本 REPL（IME 友好）

```bash
codeclaw --plain
```

中文输入法支持比 ink 强；功能等价。

### 5.3 HTTP gateway

```bash
codeclaw gateway --port 3000
# 可选 bearer 鉴权
CODECLAW_GATEWAY_TOKEN=your-secret-token codeclaw gateway --port 3000
```

API 文档见 [HTTP_API.md](./HTTP_API.md)。

### 5.4 Web SPA

```bash
export CODECLAW_WEB_TOKEN=your-strong-token   # 必需，否则拒启
codeclaw web --port=7180 --host=127.0.0.1
```

浏览器打开 `http://127.0.0.1:7180`，token 输入同 env 值。

#114 阶段 A 改进：`codeclaw web` 现在与 CLI 共享 mcpManager + settings + provider 链，
因此 web 端的 LLM 也能用 MCP 工具，hooks（PreToolUse / PostToolUse / 等）也会触发。
SIGHUP 信号会同步到所有 active web session，等价于 ink CLI 的热重载行为。

阶段 A 暴露的 panel：Chat / RAG / Graph / MCP / Hooks 共 5 个；多会话侧栏；状态栏 5s 轮询。
完整使用见 [USAGE.md §10 Web 段](./USAGE.md)。

#115 阶段 B 起 `codeclaw web` 同时提供两条 URL：

| URL | 实现 |
|---|---|
| `http://127.0.0.1:7180/` 或 `/legacy` | vanilla JS SPA（阶段 A · 上线已稳定） |
| `http://127.0.0.1:7180/next` | React + Vite 重写版（阶段 B · 开发中） |

`/next` 需要先在仓库根 `cd web-react && npm install && npm run build`（一次性），后续 `bun run build`
会自动把 `web-react/dist` 拷到 `dist/public-react/`；未构建时 `/next` 返 404，不影响 `/legacy`。

### 5.5 WeChat（iLink）

需要先获取 iLink token 文件：

```bash
codeclaw wechat                         # webhook 模式
codeclaw wechat --worker                # iLink 长轮询模式
```

详细见 [WECHAT_BOT.md](./WECHAT_BOT.md)。

### 5.6 SDK 子命令（管理 skill）

```bash
codeclaw skill list
codeclaw skill install <path-or-url>
codeclaw skill remove <name>
```

## 6. 进阶配置

### 6.1 用户偏好 `~/.codeclaw/CODECLAW.md`

启动时自动注入 system prompt 当 "User Preferences"。例：

```markdown
# CodeClaw Preferences

- 回答用中文
- 代码注释中英混排
- 优先用 pnpm 而非 npm
```

也可用命令操作：`/preferences user-add 回答用中文`。

### 6.2 项目偏好 `<workspace>/CODECLAW.md`

同上，但仅当前项目；覆盖用户级。例：

```markdown
- 这个项目用 vitest 不用 jest
- import 路径用相对而非 alias
```

命令：`/preferences add 用 vitest 不用 jest`。

### 6.3 MCP server 配置

`~/.codeclaw/mcp.json` 或 `<workspace>/.mcp.json`（项目级覆盖用户级）：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

启动后 MCP 工具自动以 `mcp__<server>__<tool>` 形式注入 LLM tool registry。失败 server 不阻塞主进程，崩溃后指数退避重启（1/2/4/8/16s，最多 5 次）。

### 6.4 Hooks 与 Status line

`~/.codeclaw/settings.json` 或 `<workspace>/.codeclaw/settings.json`（也兼容 `~/.claude/settings.json`）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          { "type": "command", "command": "scripts/precheck.sh", "timeout": 5000 }
        ]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "notify-send 'CodeClaw done'" }] }
    ]
  },
  "statusLine": {
    "command": "echo \"$(git branch --show-current) · $(date +%H:%M)\"",
    "intervalMs": 2000
  }
}
```

5 个 hook 时点：`PreToolUse` `PostToolUse` `UserPromptSubmit` `Stop` `SessionStart`。详细语义见 [SLASH_COMMANDS.md `/hooks` 章节](./SLASH_COMMANDS.md)。

**热重载**：`kill -HUP <pid>` 可在不重启 codeclaw 的情况下重新加载 settings.json。

## 7. 环境变量速查

| 变量 | 用途 |
|---|---|
| `CODECLAW_OPENAI_API_KEY` 等 | provider apiKeyEnvVar 引用值 |
| `CODECLAW_NATIVE_TOOLS=false` | 关闭 native tool_use（v0.7.0 起默认开启；设 false 走纯文本回复路径）|
| `CODECLAW_PROJECT_MEMORY=false` | 关闭跨会话项目级 memory |
| `CODECLAW_PLAN_MODE_STRICT=false` | 关闭 ExitPlanMode tool 注册 |
| `CODECLAW_SUBAGENT=false` | 关闭 Task subagent tool |
| `CODECLAW_RAG=false` | 关闭 rag_search native tool |
| `CODECLAW_GRAPH=false` | 关闭 graph_query native tool |
| `CODECLAW_CRON=false` | 关闭主 cli engine 内置 cron 调度器（仅影响内置 cron，不影响 OS cron）|
| `CODECLAW_TOKEN_WARN_THRESHOLD=0.7` | token 用量 70% 时 warn（默认）|
| `CODECLAW_AUTO_COMPACT_THRESHOLD=0.95` | token 用量 95% 触发 autoCompact（默认）|
| `CODECLAW_RAG_EMBED_MODEL=bge-m3` | RAG 用的 embedding 模型 |
| `CODECLAW_RAG_EMBED_BASE_URL` | embedding endpoint（不传走 currentProvider.baseUrl）|
| `CODECLAW_AGENT_GRADE=false` | 紧急回退 M1 之前的旧 system prompt 路径 |
| `CODECLAW_GATEWAY_TOKEN` | gateway 子命令 bearer 鉴权 |
| `CODECLAW_WECHAT_TOKEN` | wechat webhook 子命令 bearer 鉴权 |
| `CODECLAW_WEB_TOKEN` | web 子命令必需 bearer token（无则拒启）|
| `CODECLAW_ILINK_WECHAT_TOKEN_FILE` | iLink token 文件路径 |
| `CODECLAW_ILINK_WECHAT_BASE_URL` | iLink 服务端 baseUrl（默认 ilinkai.weixin.qq.com）|
| `CODECLAW_NO_PROMPT_REDACT=1` | 关掉发送给 LLM 前的 secret redact |
| `CODECLAW_ENABLE_REAL_LSP=1` | 强制走真 multilspy LSP 而非 regex fallback |

## 8. 文件存储位置

```
~/.codeclaw/
├── providers.json            # provider chain
├── selection.json            # 当前 + fallback
├── CODECLAW.md               # 用户级偏好
├── mcp.json                  # MCP server 配置
├── settings.json             # hooks + statusLine
├── cron.json                 # 内置 cron 任务定义（#116）
├── cron-runs/<task-id>/      # 任务运行历史 jsonl，按日切
├── data.db                   # 全局：sessions / tasks / memory_digest / approvals / cost
├── audit.db                  # 审计链
├── sessions/                 # transcript JSONL
├── approvals/                # pending approval JSON
├── logs/                     # crash log
└── projects/<sha256(workspace):16>/
    ├── memory/               # 项目级 memory（M2-02）
    │   ├── MEMORY.md         # 索引
    │   └── *.md              # user_note / fact / observation
    └── rag.db                # RAG chunks + 倒排 + embedding + CodebaseGraph
```

## 9. 常见排错

| 症状 | 原因 / 修法 |
|---|---|
| `codeclaw: command not found` | 没 `npm link`；用 `node dist/cli.js` 或 `npx codeclaw` |
| `No usable provider configured` | `codeclaw setup` 后没设 selection.json，跑 `codeclaw config` |
| LLM 调用超时 | 增 provider `timeoutMs`（云模型默认 30s，本地模型建议 ≥ 240s）|
| `/rag search` 返 "index is empty" | 先跑 `/rag index` 全量构建 |
| `/rag search` 想用 hybrid 但仍是 BM25 | 跑 `/rag embed` 补缺向量；确认 `CODECLAW_RAG_EMBED_MODEL` 模型在 provider 可用 |
| `/graph query` 返 "graph is empty" | 先跑 `/graph build`（仅 TS/JS 文件被索引）|
| 中文输入法字符撕裂 | 用 `codeclaw --plain`，ink TUI 对 IME 支持弱 |
| MCP server 反复重启 | `/mcp` 看 `restarts=` 与 `lastError`；超过 5 次后 status=failed 不再重启；改 mcp.json 后重启 codeclaw |
| Hook 不执行 | `/hooks` 看是否被识别；`SIGHUP` 触发热重载；matcher regex 是否匹配 tool name |
| LM Studio 模型 reasoning 干扰答案 | 见 docs/LSP_SETUP.md（已修复，但确认 `CODECLAW_AGENT_GRADE=true` 默认）|

如仍有问题，先 `codeclaw doctor` 全面检查，再贴 `~/.codeclaw/logs/crash.log` 复盘。
