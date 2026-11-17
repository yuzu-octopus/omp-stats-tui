# Plan 018: Feature payload guards and bounded work per render

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P1 · Effort M · Risk LOW · Depends on none · Category bug/perf
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

Requests/Overview commit unvalidated API arrays and can throw inside `render` if upstream shape drifts, while every sibling controller rejects malformed payloads into a defined error state. Frustration re-arms its 1 s poll forever when a mid-run payload is malformed because the stale `job` still reads `"running"`. The Errors screen recomputes signature grouping and model aggregation two or three times per frame over up to 1000 rows.

## Current state

- `src/tui/features/core/requests.ts:151-164` — `groups()`/`modelRows()`/`visible()` derive from `rows`; `:168` assigns `rows = result` with no `Array.isArray` guard.
- `src/tui/features/core/summary.ts:94` — `recent.value` spread into `data` unchecked; `:164` filters it.
- `src/tui/features/frustration.ts:69-72` — invalid payload sets `error` but leaves `job`; `:84-89` `finally` always calls `schedulePoll()`, which re-arms while `job.state === "running"` (`:54-58`).
- `src/tui/features/core/requests.ts:180,189-190` — `render()` calls `visible()`, `groups()` and `modelRows()` again; `handleInput()` repeats them at `:241,258,266`.
- Validation pattern to copy: `src/tui/features/providers.ts:164-167`, `frustration.ts:69-72`, `traces.ts:141,160`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/request-workflows.test.ts test/core-summary-workflows.test.ts test/frustration-feature.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/features/core/requests.ts`, `src/tui/features/core/summary.ts`, `src/tui/features/frustration.ts`, `test/request-workflows.test.ts`, `test/core-summary-workflows.test.ts`, `test/frustration-feature.test.ts`.
Out of scope: `src/tui/features/core/shared.ts`, `src/tui/panel.ts`, `src/data/*`, other charts/tests.

## Steps

1. Add failing tests:
   - `test/request-workflows.test.ts`: a 200 response with a non-array payload produces the defined error state (no throw from `render`).
   - `test/core-summary-workflows.test.ts`: a malformed `recent` payload leaves Overview in its error/no-data state rather than crashing the body.
   - `test/frustration-feature.test.ts`: a malformed poll response while a run is running clears or stops the running job so no further poll is scheduled; assert the timer does not re-arm.
2. Run target tests → all three fail.
3. Add `Array.isArray(result)` guards before committing rows in `requests.ts` and before spreading `recent.value` in `summary.ts`; put the failure into the existing error field with wording matching sibling controllers. Do not change success-path formatting.
4. In `frustration.ts`, make `schedulePoll()` require `error === undefined` as well as a running job, or clear `job` on invalid payload; pick the smallest change that stops the busy loop without cancelling a legitimate running job on a transient network error (network errors already set `error`; document the choice in one comment).
5. In `requests.ts`, compute `groups()` and `modelRows()` once per `render()`/`handleInput()` flow and pass the results to `visible()` and the panes. Preserve all sort/filter/search semantics; no output change expected.
6. Run target tests, full suite and typecheck → all pass.

## Test plan

Three new tests above; existing request/error/frustration workflows are the regression net. No white-box counters; assert rendered states and observable timer scheduling.

## Done criteria

- [ ] Malformed arrays become defined error states on Requests and Overview.
- [ ] Invalid frustration poll no longer re-arms forever.
- [ ] `render()`/`handleInput()` each derive error groups and model rows once.
- [ ] Full suite and typecheck pass; only in-scope files changed.

## STOP conditions

If a guard changes an existing success-path string asserted by a test, stop and report rather than editing the assertion casually. If timer behaviour needs a fake-clock rewrite, stop.

## Maintenance notes

Any new `reader.api` consumer should validate its payload before commit; this plan closes the remaining two gaps.
