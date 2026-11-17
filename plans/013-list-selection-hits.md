# Plan 013: List selection and click hits stay correct after filtering

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P1 · Effort S · Risk LOW · Depends on none · Category bug
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

`ListState.current()` falls back to `rows[0]` when the selected key disappears (search, filter, sort, range load) but does not write that key back. The painted cursor is row 1 while `move()` still starts from "not found" and lands on row 2, so one row is unreachable by keyboard. `render()` also computes click-hit rows from `search.length` while emitting `wrap(search, width)`, so a query that wraps at a narrow width reports hits one or more rows above the painted rows. Both are consumer-visible list interactions shared by all core screens.

## Current state

- `src/tui/features/core/shared.ts:47-57` — `current()` assigns `this.selected` only when it is `null`; `move()` starts from index 0 when the key is absent.
- `src/tui/features/core/shared.ts:79-105` — `const search = …` is a one-element array; `...wrap(search, width)` may emit several lines; `lastHits` uses `2 + search.length + line` and count math uses `search.length`.
- Pattern to copy: `test/core-summary-workflows.test.ts:110-118` constructs `new ListState(...)`, calls `render(..., ctx, "Records")` and strips ANSI before assertions.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/list-state.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/features/core/shared.ts`, new `test/list-state.test.ts`.
Out of scope: every feature controller, `src/tui/panel.ts`, `src/tui/features/presentation.ts`, other test files. Do not change public `ListState` constructor or field names.

## Steps

1. Write `test/list-state.test.ts` with two failing tests using the pattern above:
   - "a vanished selection becomes the painted row and the next arrow moves to the second row": select a key not in the next rows, render, assert the rendered text contains the first row as selected, call `list.input("j", rows)`, assert `list.selected` is the second row key.
   - "wrapped search lines shift click hits by the emitted line count": set a long `search`, render at width 20, compare `list.lastHits[0].rowStart` with the index of the first record line in the rendered output; assert equality.
2. Run `bun test test/list-state.test.ts` → both fail (first on `selected`, second on `rowStart`).
3. In `current()`, when the selected key is absent from `rows`, assign `this.selected = this.key(chosen)` before returning, for both `null` and stale keys. Keep the returned row unchanged.
4. In `render()`, compute `const searchLines = wrap(search, width)` once. Use `searchLines.length` in the empty-state output, `count`, `start`, `lastHits` offsets, and return `...searchLines` instead of `...wrap(search, width)`. The first record remains immediately after heading + search lines + header.
5. Run target tests, then `bun test` and `bun run check` → all pass.

## Test plan

New file `test/list-state.test.ts`, two tests above. Existing suite is the regression net for every screen using `ListState`.

## Done criteria

- [ ] Both new tests pass; full suite and typecheck pass.
- [ ] No `search.length` use remains in `ListState.render` geometry.
- [ ] Only the two in-scope files changed.

## STOP conditions

If a test needs a feature controller or theme singleton not available from the copied fixture pattern, stop and report. If changing `current()` breaks a retained-selection contract in the existing suite, stop and report rather than weakening the new assertions.

## Maintenance notes

Any future list that wraps its search line benefits automatically. Reviewers should check the hit offsets against wrapped search output at width 20.
