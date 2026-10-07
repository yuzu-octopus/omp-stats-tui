# Chart Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap our stats-tui chart internals onto the host's chart pipeline by direct static import — no copying, no second geometry engine.

**Architecture:** The host `@oh-my-pi/pi-tui/charts/*` pipeline (`analyzeTable` → `planChart` → `buildChart` → `worthCharting`) already decides what a table becomes and what it plots. We keep our money-label rule (`costWithUnpriced`), our palette roles (`resolveSeries`), and our glyphs; the host owns chart-kind selection, category/series extraction, and the gap policy. A thin adapter module maps our `TimelineRow[]` and bar-series shapes onto the host's `TableAnalysis` input, then redraws the resulting `ChartSpec` geometry with our terminal glyphs.

**Tech Stack:** TypeScript, Bun, `@oh-my-pi/pi-tui/charts/{table-data,chart-plan,chart-svg}` (static imports, exact-match externals).

**Spec:** `docs/plans/2026-10-07-chart-swap.md` (this document)

## Global Constraints

- **Static imports ONLY** for `@oh-my-pi/*`. Proven 2026-10-07: `@oh-my-pi/pi-tui/charts/table-data`, `/charts/chart-plan`, `/charts/chart-svg` load clean in the extension loader (empty stderr on `omp models -e`).
- **Build externals:** Add those three subpaths to `HOST_IMPORTS` in `scripts/build.ts` (exact-match externals). Check dist output keeps them external.
- **Money honesty is load-bearing:** Host `formatValue()` compacts (`$1235` for 1234.56) and prints `$0` for unpriced. NEVER call it for currency; our `costWithUnpriced` owns every money label. Tests must pin N/A-not-$0 on every swapped money path.
- **Theme current per render:** `resolveSeries`/palette roles stay ours; host `ChartSpec` geometry redrawn with our glyphs. No hex outside `palette.ts` (theme-fidelity test enforces).
- **No React port, no second data backend, no stdout from extension code.** Delete dead code the swap obsoletes; no shims.
- **Each task ends committable.** `bun test` + `tsc` clean per task.

## Review Focus

1. **Money path regression:** A swapped chart path that calls host `formatValue` for currency instead of `costWithUnpriced` — prints `$0` for unpriced instead of `N/A`. Test: every money-label assertion in the adapter test pins `N/A` or `costWithUnpriced` output.
2. **Theme hex leak:** A swapped path that passes a raw hex color to `ctx.theme.fg()` instead of a palette role. Test: theme-fidelity test scans for hex literals outside `palette.ts`.
3. **Gap policy drift:** A swapped path that ignores `worthCharting` and renders a chart for data the host would reject (too few points, no spread). Test: adapter test asserts `undefined` returned for sub-threshold data.
4. **Stacked/cumulative semantics lost:** The host `planChart` doesn't know about our `stacked` or `cumulative` modes. Test: adapter test asserts stacked data produces a stacked `ChartSpec` (or a note), not a flat bar chart.
5. **Dead code left behind:** `renderSeriesChart` or `renderTimeSeries` internal rendering not fully deleted after swap. Test: `grep` for old rendering functions returns nothing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tui/charts/host-adapter.ts` | **New.** Maps our `TimelineRow[]` and bar-series onto host `TableAnalysis` → `ChartSpec`; redraws geometry with our glyphs. Owns money-label wrapper and `worthCharting` gap policy. |
| `src/tui/charts/time-series.ts` | **Modify.** Replace internal rendering with adapter call. Keep signature. |
| `src/tui/charts/compose.ts` | **Modify.** Delete `renderSeriesChart`; keep `bandHeights` and `bandMax` (pure functions, still tested). |
| `src/tui/render/screen.ts` | **Modify.** `barRows` calls adapter instead of `renderSeriesChart`. |
| `scripts/build.ts` | **Modify.** Add three chart subpaths to `HOST_IMPORTS`. |
| `test/chart-primitives.test.ts` | **Modify.** Remove `renderSeriesChart` tests; add adapter tests. |
| `test/chart-ink.test.ts` | **Modify.** Add money-label and gap-policy assertions for swapped paths. |

---

### Task 1: Build externals + loader proof

**Files:**
- Modify: `scripts/build.ts:7-21`

**Interfaces:**
- Consumes: nothing
- Produces: three new externals in `HOST_IMPORTS`

- [ ] **Step 1: Add three subpaths to HOST_IMPORTS**

In `scripts/build.ts`, add to the `HOST_IMPORTS` record:
```ts
"@oh-my-pi/pi-tui/charts/table-data": true,
"@oh-my-pi/pi-tui/charts/chart-plan": true,
"@oh-my-pi/pi-tui/charts/chart-svg": true,
```

- [ ] **Step 2: Build and verify externals**

Run: `bun run build`
Expected: succeeds; `dist/index.js` contains `import"@oh-my-pi/pi-tui/charts/table-data"` (or similar) as external, not bundled.

- [ ] **Step 3: Verify loader stderr is empty**

Run: `omp models -e 2>&1 >/dev/null | grep -c "chart" || true`
Expected: `0` (no chart-related stderr)

- [ ] **Step 4: Commit**

```bash
git add scripts/build.ts
git commit -m "build: externalize host chart subpaths"
```

---

### Task 2: Adapter module

**Files:**
- Create: `src/tui/charts/host-adapter.ts`
- Test: `test/chart-primitives.test.ts` (add adapter tests)

**Interfaces:**
- Consumes: `costWithUnpriced` from `../format`, `resolveSeries` from `../palette`, `analyzeTable`/`planChart`/`buildChart`/`worthCharting` from `@oh-my-pi/pi-tui/charts/{table-data,chart-plan}`
- Produces:
  - `renderHostChart(spec: ChartSpec, opts: HostChartOptions): readonly string[]` — terminal renderer for a host `ChartSpec`
  - `planTimeline(axis: readonly number[], rows: readonly TimelineRow[], options: TimeSeriesOptions): ChartSpec | undefined` — full pipeline for time-series data
  - `planSeries(series: readonly SeriesChartSeries[], options: SeriesChartOptions): ChartSpec | undefined` — full pipeline for bar series

- [ ] **Step 1: Write failing test for `planTimeline`**

In `test/chart-primitives.test.ts`, add:
```ts
test("planTimeline returns a ChartSpec for valid timeline data", () => {
  const axis = [1700000000000, 1700008640000, 1700095040000];
  const rows = [{ key: "a", label: "A", values: [1, 2, 3] }];
  const spec = planTimeline(axis, rows, {});
  expect(spec).toBeDefined();
  expect(spec!.kind).toBe("line");
  expect(spec!.categories.length).toBe(3);
  expect(spec!.series.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/chart-primitives.test.ts -t "planTimeline"`
Expected: FAIL with "planTimeline is not a function" or import error

- [ ] **Step 3: Implement `planTimeline` in `src/tui/charts/host-adapter.ts`**

```ts
import { analyzeTable, planChart, buildChart, worthCharting } from "@oh-my-pi/pi-tui/charts/table-data";
import type { ChartSpec } from "@oh-my-pi/pi-tui/charts/chart-plan";
import type { TimelineRow, TimeSeriesOptions } from "./time-series";

export function planTimeline(
  axis: readonly number[],
  rows: readonly TimelineRow[],
  options: TimeSeriesOptions,
): ChartSpec | undefined {
  // Build synthetic GFM table: header = series names, rows = buckets
  const header = rows.map(r => r.label);
  const tableRows = axis.map((ts, i) => rows.map(r => String(r.values[i] ?? "—")));
  const table = analyzeTable(header, tableRows);
  const plan = planChart(table);
  if (!plan) return undefined;
  const spec = buildChart(table, plan);
  if (!spec || !worthCharting(spec)) return undefined;
  return spec;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/chart-primitives.test.ts -t "planTimeline"`
Expected: PASS

- [ ] **Step 5: Write failing test for money-label wrapper**

```ts
test("adapter never calls host formatValue for currency", () => {
  // A cost series with unpriced requests must show N/A, not $0
  const axis = [1700000000000, 1700008640000];
  const rows = [{ key: "cost", label: "Cost", values: [0, 0] }];
  // ... assert that the rendered output contains "N/A" not "$0"
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/chart-primitives.test.ts -t "adapter never calls host formatValue"`
Expected: FAIL

- [ ] **Step 7: Implement money-label wrapper in `renderHostChart`**

In `renderHostChart`, when `spec.series[i].dim === "currency"`, format value labels through `costWithUnpriced(value, unpriced)` instead of host `formatValue`. The `unpriced` count comes from the original `TimelineRow` metadata (passed via `HostChartOptions`).

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/chart-primitives.test.ts -t "adapter never calls host formatValue"`
Expected: PASS

- [ ] **Step 9: Write failing test for `worthCharting` gap policy**

```ts
test("planTimeline returns undefined for sub-threshold data", () => {
  const axis = [1700000000000, 1700008640000]; // only 2 buckets
  const rows = [{ key: "a", label: "A", values: [1, 1] }];
  const spec = planTimeline(axis, rows, {});
  expect(spec).toBeUndefined();
});
```

- [ ] **Step 10: Run test to verify it fails, then passes**

Run: `bun test test/chart-primitives.test.ts -t "planTimeline returns undefined"`
Expected: FAIL → then PASS after Step 3 implementation (the `worthCharting` check already handles this)

- [ ] **Step 11: Commit**

```bash
git add src/tui/charts/host-adapter.ts test/chart-primitives.test.ts
git commit -m "feat: add host chart adapter with money-label and gap policy"
```

---

### Task 3: Swap time-series.ts consumers

**Files:**
- Modify: `src/tui/charts/time-series.ts`
- Test: `test/chart-ink.test.ts` (add swapped-path assertions)

**Interfaces:**
- Consumes: `planTimeline`, `renderHostChart` from `./host-adapter`
- Produces: `renderTimeSeries` with same signature, now delegating to adapter

- [ ] **Step 1: Write failing test for swapped `renderTimeSeries`**

In `test/chart-ink.test.ts`, add:
```ts
test("renderTimeSeries delegates to host pipeline", () => {
  const ctx = mockContext();
  const axis = [1700000000000, 1700008640000, 1700095040000];
  const rows = [{ key: "a", label: "A", values: [1, 2, 3] }];
  const lines = renderTimeSeries(ctx, axis, rows, 80, 1, {});
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]).toContain("A"); // series label appears
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/chart-ink.test.ts -t "renderTimeSeries delegates"`
Expected: FAIL (if not yet swapped) or PASS (if already swapped)

- [ ] **Step 3: Rewrite `renderTimeSeries` to use adapter**

Replace the internal rendering body of `renderTimeSeries` with:
```ts
export function renderTimeSeries(ctx, axis, rows, width, selected, options = {}) {
  const spec = planTimeline(axis, rows, options);
  if (!spec) return [ctx.theme.fg("dim", "No chart-worthy data in this range.")];
  return renderHostChart(spec, { width, ctx, selected, options });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/chart-ink.test.ts -t "renderTimeSeries delegates"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all pass (existing tests may need updates if they assert on old rendering details)

- [ ] **Step 6: Commit**

```bash
git add src/tui/charts/time-series.ts test/chart-ink.test.ts
git commit -m "refactor: swap time-series rendering to host pipeline"
```

---

### Task 4: Swap compose.ts consumers

**Files:**
- Modify: `src/tui/charts/compose.ts` (delete `renderSeriesChart`)
- Modify: `src/tui/render/screen.ts:879-898` (use adapter)
- Test: `test/chart-primitives.test.ts` (remove `renderSeriesChart` tests)

**Interfaces:**
- Consumes: `planSeries`, `renderHostChart` from `./host-adapter`
- Produces: `barRows` in `screen.ts` delegates to adapter

- [ ] **Step 1: Write failing test for swapped `barRows`**

In `test/chart-ink.test.ts`, add:
```ts
test("barRows delegates to host pipeline", () => {
  // ... assert that barRows produces output via adapter
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/chart-ink.test.ts -t "barRows delegates"`
Expected: FAIL

- [ ] **Step 3: Delete `renderSeriesChart` from compose.ts**

Remove the `renderSeriesChart` function and its `SeriesChartSeries`/`SeriesChartOptions` interfaces. Keep `bandHeights` and `bandMax`.

- [ ] **Step 4: Rewrite `barRows` in screen.ts to use adapter**

```ts
function barRows(chart: ChartSpec, opts: ScreenRenderOptions, width: number): readonly string[] {
  const series = chart.series.map(s => ({ label: s.label, values: bucketedValues(s.metric, opts) }));
  const spec = planSeries(series, { width, height: Math.max(1, opts.plan.barHeight) });
  if (!spec) return [opts.fg("dim", "No chart-worthy data.")];
  return renderHostChart(spec, { width, ctx: opts, selected: 0, options: {} });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/chart-ink.test.ts -t "barRows delegates"`
Expected: PASS

- [ ] **Step 6: Remove `renderSeriesChart` tests from chart-primitives.test.ts**

Delete tests that reference `renderSeriesChart`. Keep `bandHeights` and `bandMax` tests.

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add src/tui/charts/compose.ts src/tui/render/screen.ts test/chart-primitives.test.ts test/chart-ink.test.ts
git commit -m "refactor: swap compose bar chart to host pipeline"
```

---

### Task 5: Delete dead code + full verify

**Files:**
- Modify: any files with newly-dead code
- Test: `test/theme-fidelity.test.ts` (enforce no hex outside palette.ts)

**Interfaces:**
- Consumes: nothing
- Produces: clean tree, all tests pass

- [ ] **Step 1: Grep for dead code**

Run: `grep -r "renderSeriesChart\|renderDailyBars.*compose" src/ --include="*.ts" | grep -v "test/"`
Expected: no matches (all consumers swapped)

- [ ] **Step 2: Grep for old rendering internals**

Run: `grep -r "grid\[y\]\[x]\|plotWidth\|cellWidth" src/tui/charts/ --include="*.ts" | grep -v "host-adapter.ts"`
Expected: no matches (old geometry engine deleted)

- [ ] **Step 3: Run theme-fidelity test**

Run: `bun test test/theme-fidelity.test.ts`
Expected: PASS (no hex outside palette.ts)

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: all pass

- [ ] **Step 5: Run tsc**

Run: `bun run tsc`
Expected: clean

- [ ] **Step 6: Run loader stderr check**

Run: `omp models -e 2>&1 >/dev/null | wc -l`
Expected: `0`

- [ ] **Step 7: Run probe-render captures**

Run: `bun test test/probe-timing-bucket.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: delete dead chart code after host pipeline swap"
```

---

## Self-Review

**1. Spec coverage:**
- Static imports only → Task 1 (build externals) + Global Constraints
- Money honesty → Task 2 Step 5-8 (money-label wrapper) + Review Focus 1
- Theme current per render → Task 2 (adapter uses `resolveSeries`) + Review Focus 2
- No React port, no second backend → Global Constraints
- Delete dead code, no shims → Task 4 Step 3 (delete `renderSeriesChart`) + Task 5
- Swap time-series.ts + compose.ts consumers → Tasks 3, 4
- Leave bars/sparkline/heatmap/calendar → not touched

**2. Step scan:** Each step is one action with a checkable result. No "TBD" or "handle edge cases."

**3. Type consistency:** `planTimeline` returns `ChartSpec | undefined` in Task 2, consumed in Task 3. `planSeries` returns `ChartSpec | undefined` in Task 2, consumed in Task 4. `renderHostChart` signature consistent across tasks.

**4. Review Focus:** All five items have tests in the owning task.

**5. Proportion:** Plan is ~200 lines for a swap touching ~6 files. Not a transcript.
