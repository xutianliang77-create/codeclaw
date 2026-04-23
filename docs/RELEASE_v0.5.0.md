# CodeClaw v0.5.0

First public open-source release.

## Highlights

### CLI Agent Loop

- provider selection and fallback
- plain REPL and Ink-based UI
- compacting and approval queue recovery
- file, glob, shell, and edit tools

### Code Navigation

- `/symbol`
- `/definition`
- `/references`
- real `multilspy` bridge with regex fallback

### Orchestration

- `/plan <goal>`
- `/orchestrate <goal>`
- minimal planner / executor / reflector lane
- orchestration approval flow
- deterministic write / replace execution after approval

### External Entry Points

- HTTP gateway
- SDK wrapper
- ingress gateway
- minimal MCP loop

### WeChat Bot

- `/wechat` QR login inside CLI
- iLink worker mode
- webhook mode
- approval notify / resume support
- session binding to the active CLI conversation

## Validation Snapshot

Validated with:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `bun run build`

Current baseline:

- `20` test files
- `120` tests
- all passing

## Known Boundaries

- edit execution is structured, but not AST-level
- MCP is still in-process and minimal
- TUI Chinese IME support is weaker than `--plain`
- WeChat image / audio / video handling is not implemented yet

## Recommended Next Steps

- richer structured edit strategies
- stronger reflector failure memory and gap classification
- WeChat media support
- broader plugin / skill / RAG expansion
