# Phase 2 Delivery

This document summarizes the current delivery status for Phase 2
(`Planner / Executor / Reflector + SDK/HTTP + MCP + Skills + remaining commands`).

## Status

Phase 2 can now be considered **formally closed for the current MVP scope**.

That conclusion is based on:

1. `Planner / Executor / Reflector` are implemented and exercised by
   executable playback suites.
2. `SDK/HTTP API` shares the same session and permission semantics as the CLI.
3. `MCP` has a minimal working local server loop with permission enforcement.
4. `Skill System` is no longer placeholder-only; it affects prompt injection
   and execution boundaries.
5. Remaining Phase 2 commands are available and covered by tests.

## Delivered Areas

### 1. Planning / Execution / Reflection

- `/plan <goal>`
- `/orchestrate <goal>`
- explicit `GoalDefinition`
- explicit `completionChecks`
- execution observations and action logs
- approval-required / replan / escalated paths
- repeated-gap escalation

Primary files:

- `src/orchestration/goalPlanner.ts`
- `src/orchestration/executor.ts`
- `src/orchestration/reflector.ts`
- `src/orchestration/approvalExecution.ts`

### 2. External Entry Points

- CLI
- HTTP / SDK
- Ingress gateway shared session semantics
- minimal MCP command loop

Primary files:

- `src/sdk/httpServer.ts`
- `src/sdk/client.ts`
- `src/ingress/gateway.ts`
- `src/mcp/service.ts`

### 3. Skill and Productivity Layer

- built-in skill registry
- skill discovery / activation / clearing
- skill prompt injection
- skill `allowedTools` enforcement
- `/review`
- `/summary`
- `/export`
- `/reload-plugins`
- `/debug-tool-call`
- `/doctor`

Primary files:

- `src/skills/registry.ts`
- `src/agent/queryEngine.ts`

## Evidence

### Playback Suites

- `test/orchestration-playback.test.ts`
  - 10 real task samples
  - covers `complete / approval-required / replan / escalated`
- `docs/PHASE2_PLAYBACKS.md`
  - sample matrix and expected outcomes

### QueryEngine End-to-End Examples

- `test/query-engine-e2e.test.ts`
  - ingress + review + MCP
  - ingress + orchestration approval + export
  - provider lane + skill prompt injection + command lane coexistence

### Full Validation Snapshot

Current full validation:

- `npm run lint`
- `npm run test`
- `bun run build`

## Known Deferred Items

Phase 2 is closed for MVP scope, but these are intentionally deferred:

1. MCP is still minimal and in-process; real stdio/SSE transports are not done.
2. MCP calls are permission-gated, but not yet integrated into the full approval queue.
3. Skills are built-in only; no repo-driven `SKILL.md` discovery yet.
4. Approved edits are structured and deterministic, but not AST-level edits.
5. Natural-language file read auto-routing to `/read` is still TODO.
6. TUI Chinese IME compatibility is still weaker than `--plain`.

## Recommendation

Recommended next move: begin Phase 3 cautiously, while keeping the remaining
deferred items tracked as targeted follow-up work rather than re-opening
Phase 2 wholesale.
