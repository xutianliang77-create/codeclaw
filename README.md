# CodeClaw

CodeClaw is a CLI-first autonomous agent scaffold for coding workflows.

It currently includes:

- provider selection and fallback
- a local REPL with approvals and compacting
- file / shell / edit tools
- LSP-backed symbol / definition / references queries
- HTTP SDK / gateway entrypoints
- a minimal planner / executor / reflector lane
- WeChat bot integration with iLink login and worker polling

## Status

This repository is currently at `v0.5.0`.

What is already delivered:

- Phase 1: CLI agent loop, tools, approvals, compact, ingress, HTTP gateway
- Phase 1.5: real LSP bridge with fallback index
- Phase 2: planner / executor / reflector, MCP, skills, remaining commands
- Phase 3.5: WeChat bot login, webhook mode, worker mode, approval / resume flow

What is still intentionally limited:

- edits are deterministic and structured, but not AST-level
- MCP is still minimal and in-process
- TUI Chinese IME support is weaker than `--plain`
- WeChat rich media support is not done yet

## Requirements

- Node.js `22+`
- npm `10+`
- Bun `1.x` for builds
- optional: Python `3.x` for real LSP (`multilspy`)

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

To enable the real multilspy-backed lane:

```bash
npm run setup:lsp
```

Then use:

- `/symbol <name>`
- `/definition <name>`
- `/references <name>`

See [docs/LSP_SETUP.md](./docs/LSP_SETUP.md).

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

## Release Notes

The first public release notes are in:

- [docs/RELEASE_v0.5.0.md](./docs/RELEASE_v0.5.0.md)

## License

[MIT](./LICENSE)
