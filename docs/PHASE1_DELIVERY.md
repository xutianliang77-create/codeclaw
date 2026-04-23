# CodeClaw Phase 1 Delivery

## Scope

Phase 1 delivers a CLI-first agent loop with:

1. provider selection and fallback
2. interactive setup/config flows
3. QueryEngine-based REPL
4. file, glob, and shell tools
5. permission gating and approval queue recovery
6. manual, proactive, and reactive compact
7. unified ingress routing for CLI

## Delivered Components

### Runtime

1. `src/cli.tsx`
2. `src/app/App.tsx`
3. `src/agent/queryEngine.ts`
4. `src/ingress/gateway.ts`
5. `src/ingress/sessionManager.ts`

### Providers

1. `src/provider/registry.ts`
2. `src/provider/client.ts`
3. `src/provider/builtins.ts`

### Tools and Permissions

1. `src/tools/local.ts`
2. `src/tools/types.ts`
3. `src/permissions/manager.ts`
4. `src/approvals/store.ts`

### Commands

Delivered Phase 1 commands:

1. `/help`
2. `/status`
3. `/resume`
4. `/session`
5. `/providers`
6. `/context`
7. `/memory`
8. `/compact`
9. `/approvals`
10. `/diff`
11. `/skills`
12. `/hooks`
13. `/init`
14. `/model <name>`
15. `/mode <permission-mode>`
16. `/approve [id]`
17. `/deny [id]`
18. `/read <path>`
19. `/glob <pattern>`
20. `/bash <command>`
21. `/write <path> :: <content>`
22. `/append <path> :: <content>`
23. `/replace <path> :: <find> :: <replace>`

CLI lifecycle commands:

1. `codeclaw setup`
2. `codeclaw config`
3. `codeclaw doctor`
4. `codeclaw gateway`

## Known Phase 1 Boundaries

1. `/diff` currently reports session-tracked edited files instead of a git patch
2. `skills` and `hooks` report scaffold status only; full integrations are deferred
3. session persistence is still approval-focused rather than full transcript recovery
4. real remote-provider smoke tests still depend on user-supplied API keys

## Verification

Current baseline:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run test`
4. `bun run build`

Regression areas covered:

1. transcript and command flows
2. permission decisions and approval queue recovery
3. setup/config/doctor loading paths
4. ingress gateway and HTTP API handler behavior

## Real LSP Runtime

Phase 1.5 adds a real `multilspy` runtime for:

1. `/symbol`
2. `/definition`
3. `/references`

Standard setup:

```bash
npm run setup:lsp
```

See [LSP_SETUP.md](./LSP_SETUP.md) for the full install flow.
