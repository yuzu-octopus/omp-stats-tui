# Plan 019: Trace timeline and transcript rows are built once per frame

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P2 · Effort M · Risk LOW · Depends on none · Category perf
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

`ancestors()` constructs a full id→track Map on every call and `visibleTracks()` calls it once per track, so one timeline render is O(T²). `renderTimeline()` also filters the full lane array per track. `transcriptRows()` builds and sorts all spans/markers two or three times per frame. Traces with nested agents grow T; the 5 s refresh and every frame-cache miss pay this repeatedly.

## Current state

- `src/tui/features/traces/model.ts:26-41` — `ancestors()` builds `new Map(tracks.map(t => [t.id, t]))` per call; `visibleTracks()` calls `ancestors` per track. `:12-19` `transcriptRows()` allocates rows and sorts per call.
- `src/tui/features/traces/render.ts:74-85` — `buildLanes`, `visibleTracks`, `lanes.filter(...)` per track, and `ancestors`/`tracks.filter` per rendered row.
- `src/tui/features/traces.ts:40-49,329,331,348` — `rows()` and `selectedRow()` each call `transcriptRows()`; one render calls both repeatedly.
- Invariants: track ordering, lane ordinals, selection identity, collapse marking and transcript search must not change.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/traces-feature.test.ts test/trace-model.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/features/traces/model.ts`, `src/tui/features/traces/render.ts`, `src/tui/features/traces.ts`, `test/traces-feature.test.ts`, and a new `test/trace-model.test.ts` only if needed.
Out of scope: `src/tui/panel.ts`, other features, `src/tui/charts/*`, `test/panel.test.ts`.

## Steps

1. Add a regression test in `test/traces-feature.test.ts` (or new `test/trace-model.test.ts`) using a fixture with at least 6 nested tracks: assert that one `renderTimeline()` call produces the same lane order, selected row and transcript order as a hand-checked baseline before the refactor. Capture the baseline by running the existing code first; the assertion must be on rendered output, not call counts.
2. Build the id→track Map once per `renderTimeline()`/`visibleTracks()` invocation and pass it to `ancestors()`; add an internal overload or helper so direct callers still work. Group lanes into `Map<trackId, Lane[]>` once and index by track id inside the row loop.
3. Compute `transcriptRows(trace.tracks)` once per trace snapshot in `traces.ts` (cache keyed by the `tracks` array identity, invalidated when a new trace loads) and derive `rows()`, `selectedRow()` and match counts from that array. No ordering/filter change.
4. Run target tests, full suite and typecheck → all pass; output must be byte-identical to the captured baseline.

## Test plan

One characterization test on rendered output with nested tracks; existing trace suite is the regression net. No call-count assertions.

## Done criteria

- [ ] One Map construction and one lane index per render; one transcript sort per trace snapshot.
- [ ] Captured baseline output unchanged; full suite and typecheck pass.
- [ ] Only in-scope files changed.

## STOP conditions

If any rendered line changes after the refactor, stop and report instead of updating the baseline. If the cache cannot be keyed safely on `tracks` identity, stop.

## Maintenance notes

A new trace must replace the cached `tracks` reference; do not add a deep equality cache.
