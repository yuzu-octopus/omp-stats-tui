# Plan 014: Chart honesty and dead work cleanup

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P1 · Effort M · Risk LOW/MED · Depends on none · Category bug/perf
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

Sparklines currently draw a missing sample with the same glyph as a measured zero; legend swatches disagree with plotted hues once a non-middle series is hidden; a full cost summary is computed and discarded on every bar render; waterfall spreads its whole level array twice per row; heatmap declares a `labelWidth` option its renderer ignores. All five are directly observable or provable dead work in the shared chart layer used by production screens.

## Current state

- `src/tui/charts/sparkline.ts:90-127` — non-finite values fall to `level = 0` and emit `sparkRamp[0]`; padding is blank. `src/tui/features/core/analytics.ts:428-430` maps `null` to `NaN` before calling it.
- `src/tui/charts/time-series.ts:86-116` — `active` filters `hidden`, `colors = resolveSeries(...full rows...)`, legend swatches use full-row index. `src/tui/charts/host-adapter.ts:424,477` re-resolves colours over filtered `series` and paints by active index.
- `src/tui/charts/bars.ts:311,330` — `const summary = buildCostSummary(points); … void summary;`; ranking already comes from `pivotSeries` at `:317-322`.
- `src/tui/charts/waterfall.ts:58-59` — `Math.min(0, ...levels)` recomputed inside `cell()` for every row.
- `src/tui/charts/heatmap.ts:34-40,94-96` — `HeatmapOptions.labelWidth` declared but renderer hardcodes `const labelWidth = 2`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/sparkline.test.ts test/chart-ink.test.ts test/chart-primitives.test.ts test/bars.test.ts test/heatmap.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/charts/sparkline.ts`, `time-series.ts`, `host-adapter.ts`, `bars.ts`, `waterfall.ts`, `heatmap.ts`, `src/tui/features/core/analytics.ts` (only the `sparkCell` call), and tests `test/sparkline.test.ts`, `test/chart-ink.test.ts`, `test/chart-primitives.test.ts`, `test/bars.test.ts`, `test/heatmap.test.ts`.
Out of scope: `src/tui/palette.ts` colour tables, `src/tui/glyphs.ts`, other features, `src/tui/panel.ts`, package files.

## Steps

1. Add failing tests first:
   - `test/sparkline.test.ts`: a null/non-finite sample renders a blank cell while a measured zero renders `ramp[0]`, at identical width and max.
   - `test/chart-ink.test.ts`: render `renderTimeSeries` with 3 rows, hide the middle row, assert the painted mark colour for each remaining series equals its legend swatch colour (compare the actual `fg` escape, not a hardcoded hue).
   - `test/bars.test.ts`: render cost bars and assert no behavioural dependency on `buildCostSummary` (existing ranking assertions suffice; no new assertion about the deleted call).
   - `test/heatmap.test.ts`: assert the rendered gutter is 2 cells and that `weeksForWidth` uses the same 2-cell gutter.
2. Run target tests → the sparkline and legend tests fail.
3. Change `renderSparkline` to accept `readonly (number | null)[]`; emit `" "` for null/non-finite samples without altering scale computation. Change `sparkCell` to pass values through unchanged and update its comment (null is a gap, not a baseline mark).
4. Thread a stable colour list from `renderTimeSeries` into `renderHostChart`: add optional `seriesColors?: readonly ThemeColor[]` to `HostChartOptions` (and `SeriesRenderOptions` where needed), build it from the full-row `colors` array for the `active` rows only, and use `opts.seriesColors?.[index] ?? resolved[index]` before painting in both the shared-axis and categorical paths. Keep `resolveSeries` as fallback for other callers; do not add a second colour table.
5. Delete the dead `buildCostSummary` call, its `void`, and the now-unused import from `bars.ts`. Hoist the waterfall floor into one `const` beside `span`. Either honour `opts.labelWidth` with a real clamp in `renderHeatmap` or delete the option and update its only caller in `src/tui/features/core/summary.ts:263,279` to use a named constant; choose the smallest option that keeps all tests green.
6. Run target tests, then full suite and typecheck → all pass.

## Test plan

Existing suites listed in Commands; add the two new assertions in step 1. Preserve all existing glyph-width and byte-equality invariants.

## Done criteria

- [ ] Missing sparkline samples render blank; zero still renders `ramp[0]`.
- [ ] Legend swatch and painted mark share a colour with a middle series hidden.
- [ ] No `buildCostSummary` call remains in `bars.ts`; no repeated `Math.min(0, ...levels)` in `waterfall.ts`; heatmap gutter contract matches its option set.
- [ ] Full suite and typecheck pass; only in-scope files changed.

## STOP conditions

If threading `seriesColors` requires changing a host chart class or the palette table, stop and report. If a hidden-series colour assertion cannot observe painted output without white-box access, stop and report.

## Maintenance notes

Future series additions must supply stable `colorIndex` values; the legend and plot now share one colour source. Re-check the sparkline gap rule if another caller passes `NaN` as a sentinel.
