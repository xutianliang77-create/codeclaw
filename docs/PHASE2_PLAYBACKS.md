# Phase 2 Playbacks

This file documents the current Phase 2 playback set used to validate the
Planner / Executor / Reflector lane with realistic task samples.

## Coverage Summary

1. `analyze src/sample.ts greetUser` -> `complete`
2. `review src/entry.ts createQueryEngine` -> `complete`
3. `how createQueryEngine works in src/entry.ts?` -> `complete`
4. `analyze architecture` -> `complete`
5. `where greetUser is used in src/sample.ts?` -> `complete`
6. `fix src/sample.ts greetUser` -> `approval-required`
7. `create src/new-feature.ts` -> `approval-required`
8. `build docs/guide.md` -> `approval-required`
9. `prepare escalated architecture walkthrough` without provider and with repeated failure signature -> `escalated`
10. `prepare architecture walkthrough` without provider -> `replan`

## Intent / Decision Matrix

| # | Goal | Intent | Expected decision | Why it matters |
|---|------|--------|-------------------|----------------|
| 1 | analyze existing function implementation | analyze | complete | Verifies inspect-file + inspect-symbol + inspect-references lane |
| 2 | review query engine entrypoint | analyze | complete | Verifies review-style analyze path on a named symbol |
| 3 | query symbol behavior in file | query | complete | Verifies question-style query path with explicit symbol |
| 4 | analyze architecture | analyze | complete | Verifies fallback pattern inspection without explicit file target |
| 5 | query references in file | query | complete | Verifies query lane with file + symbol targeting |
| 6 | fix existing function | fix | approval-required | Verifies validation + write approval lane |
| 7 | create new feature scaffold | create | approval-required | Verifies missing path detection + create approval lane |
| 8 | build markdown guide | create | approval-required | Verifies non-code scaffold target still goes through approval |
| 9 | repeated provider-less task failure | task | escalated | Verifies loop detection / repeated gap escalation on a non-approval failure path |
|10 | provider-less task walkthrough | task | replan | Verifies provider/check failure leads to replan instead of false success |

## Test Source

The executable playback suite lives in:

- `test/orchestration-playback.test.ts`

It is intended to act as the primary Phase 2 sample playback proof until a
larger replay harness is added.
