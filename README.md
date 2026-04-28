# CodeClaw

CodeClaw is a CLI-first autonomous agent scaffold for coding workflows.

It currently includes:

- provider selection and fallback
- a local REPL with approvals and compacting
- file / shell / edit tools
- LSP-backed symbol / definition / references queries (defaults to a zero-dependency regex index; the real `multilspy` backend is opt-in — see **LSP Setup** below)
- HTTP SDK / gateway entrypoints
- a minimal planner / executor / reflector lane
- WeChat bot integration with iLink login and worker polling

## Status

This repository is currently at `v0.6.0`.

What is already delivered:

- Phase 1: CLI agent loop, tools, approvals, compact, ingress, HTTP gateway
- Phase 1.5: real LSP bridge with fallback index
- Phase 2: planner / executor / reflector, MCP, skills, remaining commands
- Phase 3.5: WeChat bot login, webhook mode, worker mode, approval / resume flow
- **v0.6.0** (this release):
  - Cron 阶段 🅑：内置定时任务 (slash / prompt / shell)，3 通道 notify (cli / web / wechat)，sqlite 历史，5 任务模板
  - Web Stage A：13 后端 endpoint + 5 vanilla SPA panel + 多会话侧栏 + 状态栏
  - Web Stage B：`/next` URL 上的 React + Vite 重写（虚拟滚动 / 流式 markdown / d3-force / ⌘K palette / Monaco viewer / 主题切换）
  - Subagent SSE 真实推送（替代 polling）

What is still intentionally limited:

- edits are deterministic and structured, but not AST-level
- MCP is still minimal and in-process
- TUI Chinese IME support is weaker than `--plain`
- WeChat rich media support is not done yet
- Cron DAG / 失败重试 / 跨机调度 (阶段 🅒) 未做

## Requirements

- Node.js `22+`
- npm `10+`
- Bun `1.x` for builds
- **optional**: Python `3.x` + `venv` **only if** you want the real `multilspy`-backed LSP lane. Without it, CodeClaw silently falls back to a regex-based index for `/symbol`, `/definition`, `/references` — all commands still work, cross-file semantic precision is reduced.

### Recommended terminal · 推荐终端

CodeClaw 的 ink TUI 在高频按键时事件量大。在 **macOS 26 beta** 上，Apple 自带的 **Terminal.app** 存在 `NSEventThread` libmalloc 内存破坏 bug（与 codeclaw 无关，会随机崩窗）——强烈建议换一个 GPU 加速的现代终端：

```bash
# Ghostty（极快，Apple GPU 加速，Mihail Konev 出品）
brew install --cask ghostty

# 或 iTerm2 / Warp / Alacritty 任选其一
brew install --cask iterm2
```

如果只能用 Terminal.app，跑 `node dist/cli.js --plain` 走纯文本 REPL 也能规避大部分崩溃。

## Quick Start

Install dependencies:

```bash
npm install
```

Build:

```bash
bun run build
```

Run the plain REPL:

```bash
node dist/cli.js --plain
```

Recommended validation:

```bash
npm run lint
npm run typecheck
npm run test
bun run build
```

## Common Commands

Lifecycle commands:

- `codeclaw setup`
- `codeclaw config`
- `codeclaw doctor`
- `codeclaw gateway`
- `codeclaw wechat`

Core REPL commands:

- `/help`
- `/status`
- `/session`
- `/providers`
- `/context`
- `/memory`
- `/compact`
- `/approvals`
- `/read <path>`
- `/glob <pattern>`
- `/symbol <name>`
- `/definition <name>`
- `/references <name>`
- `/bash <command>`
- `/write <path> :: <content>`
- `/append <path> :: <content>`
- `/replace <path> :: <find> :: <replace>`
- `/plan <goal>`
- `/orchestrate <goal>`
- `/wechat`

## LSP Setup

CodeClaw ships with **two LSP backends**:

| Backend | Requires | When used |
|---------|----------|-----------|
| `fallback-regex-index` | nothing | **Default** if you skip LSP setup; regex-based `/symbol /definition /references` |
| `multilspy` | Python `3.x` + venv + `npm run setup:lsp` | Real cross-file semantic LSP via Python bridge |

**Out of the box (no setup)** — `/symbol`, `/definition`, `/references` work via the regex index. Good enough for most single-file navigation.

**Opt-in real LSP** (needed for cross-file references, type-aware queries):

```bash
npm run setup:lsp   # creates .venv-lsp, installs multilspy + typescript-language-server
```

Once `.venv-lsp` exists, CodeClaw auto-detects and prefers the real backend. You can force either lane:

```bash
CODECLAW_ENABLE_REAL_LSP=1 codeclaw   # force real LSP (errors out if venv missing)
CODECLAW_ENABLE_REAL_LSP=0 codeclaw   # force regex fallback, ignore venv
# unset = auto (default): prefer real LSP if available, else silent fallback
```

See [docs/LSP_SETUP.md](./docs/LSP_SETUP.md) for full install flow and troubleshooting.

> **Why Python for LSP?** The real lane currently uses `multilspy` (Python) to manage LSP servers across multiple languages. A Node-native LSP client is on the roadmap (P1+) and will remove the Python dependency; until then, `multilspy` stays opt-in and the regex lane is the zero-dependency default.

## WeChat Bot

CodeClaw supports two WeChat access paths:

1. webhook mode
2. iLink worker mode

Inside the CLI, run:

```text
/wechat
```

That starts QR login, binds WeChat to the current session, and auto-starts the worker after confirmation.

See [docs/WECHAT_BOT.md](./docs/WECHAT_BOT.md).

## HTTP API

Start the local gateway:

```bash
node dist/cli.js gateway --port 3000
```

See [docs/HTTP_API.md](./docs/HTTP_API.md).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](./docs/INSTALL.md) | 安装、首次配置、各通道启动、环境变量速查、常见排错 |
| [docs/USAGE.md](./docs/USAGE.md) | 用户视角 12 个工作流（陌生代码库 / 写代码 / 调 bug / refactor / MCP / Hooks / Status line 等） |
| [docs/SLASH_COMMANDS.md](./docs/SLASH_COMMANDS.md) | 35 个 builtin slash 命令字典 + native tool 总览 + 存储位置 |
| [docs/HTTP_API.md](./docs/HTTP_API.md) | gateway 子命令 HTTP API |
| [docs/WECHAT_BOT.md](./docs/WECHAT_BOT.md) | WeChat iLink 集成（webhook + worker 双模式） |
| [docs/LSP_SETUP.md](./docs/LSP_SETUP.md) | 真 multilspy LSP 后端可选安装 |

## Release Notes

The first public release notes are in:

- [docs/RELEASE_v0.6.0.md](./docs/RELEASE_v0.6.0.md) — current
- [docs/RELEASE_v0.5.0.md](./docs/RELEASE_v0.5.0.md) — first public release

## License

[MIT](./LICENSE)
