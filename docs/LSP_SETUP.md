# Real LSP Setup

CodeClaw now supports a real `multilspy` backend for:

1. `/symbol`
2. `/definition`
3. `/references`

The real backend is a Python + Node mixed runtime:

1. Python dependency: `multilspy`
2. Node runtime dependency: `typescript-language-server`
3. Node runtime dependency: `typescript`

## Standard Setup

Run:

```bash
npm run setup:lsp
```

This will:

1. create `.venv-lsp`
2. install `multilspy`
3. install `typescript-language-server`
4. install `typescript`

## Runtime Behavior

By default, CodeClaw now auto-prefers the real LSP backend when the local LSP runtime is available.

You can still override behavior:

```bash
CODECLAW_ENABLE_REAL_LSP=1 node dist/cli.js --plain
CODECLAW_ENABLE_REAL_LSP=0 node dist/cli.js --plain
```

Meaning:

1. unset: auto-detect and prefer real LSP
2. `1`: force-attempt real LSP
3. `0`: force fallback regex index

## Current Notes

1. `.venv-lsp` is intentionally local to the repository
2. if real LSP fails, CodeClaw still falls back to `fallback-regex-index`
3. current real backend is strongest on TypeScript-centric workspaces
