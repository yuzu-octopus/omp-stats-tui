/**
 * `src/tui/charts/host-adapter.ts` — plan and render host charts with our glyphs.
 *
 * The host pipeline decides what a table becomes and what it plots:
 * `analyzeTable` reads the cells, `planChart` picks the chart kind and the
 * columns to draw, `buildChart` turns that into a `ChartSpec`, and
 * `worthCharting` decides whether the picture says more than the table. This
 * module only maps our `TimelineRow[]` and bar-series shapes onto the host's
 * table input, then redraws the resulting `ChartSpec` with the project's own
 * primitives. THE KIND DRIVES THE GEOMETRY: a temporal axis comes back `line`
 * and a multi-series line draws a shared-axis plot; every categorical kind
 * (bar/paired/grouped/heatmap) draws as bands through `renderSeriesChart`.
 * Series hues come from `resolveSeries`, marks from our glyphs.
 *
 * Money honesty: the host's `formatValue` compacts (`$1235` for 1234.56) and
 * prints `$0` for unpriced. It is NEVER called here. A currency series' labels
 * go through `costWithUnpriced`, so unpriced requests read `N/A`, not `$0`.
 */

import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import { buildChart, planChart, worthCharting } from "@oh-my-pi/pi-tui/charts/chart-plan";
import type { ChartSpec } from "@oh-my-pi/pi-tui/charts/chart-plan";
import type { TimelineRow, TimeSeriesOptions } from "./time-series";
import type { SeriesChartSeries, SeriesChartOptions } from "./compose";
import { renderSeriesChart } from "./compose";
import { costWithUnpriced } from "../format";
import { resolveSeries, type PaletteTheme } from "../palette";
import { glyph, SPARK_LEVELS, type SymbolPreset } from "../glyphs";
import { truncateToWidth, type ThemeColor } from "@oh-my-pi/pi-tui";

// ─── Spec ────────────────────────────────────────────────────────────────────

/**
 * A host `ChartSpec` from a timeline, plus the two modes the host does not model.
 *
 * `stacked`/`cumulative` are RECORDED, not applied. `renderSeriesChart` has no
 * stacking geometry — a terminal cell cannot carry two stacked values legibly
 * (that is exactly the `░█░█░█` noise `compose.ts` exists to prevent). So a
 * `stacked` spec is drawn as its component bands, which is honest — it shows the
 * parts — and a caller that needs the stack total sums the series before
 * plotting.
 */
export type TimelineChartSpec = ChartSpec & {
  readonly stacked?: boolean;
  readonly cumulative?: boolean;
};

// ─── Table cells ─────────────────────────────────────────────────────────────

/**
 * A cell the host reads as its number.
 *
 * Cost cells carry a currency mark so the host types the column `currency`; the
 * RENDERED money label is still `costWithUnpriced`, never this text.
 */
function cell(value: number | null | undefined, currency: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (!currency) return String(value);
  return value < 0 ? `-$${-value}` : `$${value}`;
}

// ─── Timeline planning ───────────────────────────────────────────────────────

/**
 * Full pipeline: timeline data → host `ChartSpec`.
 *
 * Table construction follows the pre-flight ruling: header = [labelCol, ...measureNames],
 * rows = categories × measures (column 0 = categories).
 *
 * Gap policy: `undefined` whenever the host's `planChart` finds no chart or
 * `worthCharting` rejects the spec (too few categories, no spread).
 */
export function planTimeline(
  axis: readonly number[],
  rows: readonly TimelineRow[],
  options: TimeSeriesOptions,
): TimelineChartSpec | undefined {
  if (!axis.length || !rows.length) return undefined;

  const currency = rows.map((row) => row.key === "cost");
  const table = analyzeTable(
    ["Bucket", ...rows.map((row) => row.label)],
    axis.map((timestamp, index) => [
      // An ISO timestamp, so the host reads the column as temporal.
      new Date(timestamp).toISOString(),
      ...rows.map((row, column) => cell(row.values[index], currency[column]!)),
    ]),
  );

  const plan = planChart(table);
  if (!plan) return undefined;
  const spec = buildChart(table, plan);
  if (!spec || !worthCharting(spec)) return undefined;

  return { ...spec, stacked: options.stacked, cumulative: options.cumulative };
}

// ─── Series planning ─────────────────────────────────────────────────────────

/**
 * Full pipeline: series data → host `ChartSpec`.
 *
 * Same table construction as {@link planTimeline}: header = [labelCol, ...measureNames],
 * rows = categories × measures (column 0 = categories).
 */
export function planSeries(
  series: readonly SeriesChartSeries[],
  _options: SeriesChartOptions,
): ChartSpec | undefined {
  if (!series.length) return undefined;

  const table = analyzeTable(
    ["Series", ...series.map((entry) => entry.label)],
    series[0]!.values.map((_, index) => [
      `Bucket ${index + 1}`,
      ...series.map((entry) => cell(entry.values[index], false)),
    ]),
  );

  const plan = planChart(table);
  if (!plan) return undefined;
  const spec = buildChart(table, plan);
  if (!spec || !worthCharting(spec)) return undefined;
  return spec;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export interface HostChartOptions {
  width: number;
  height?: number;
  preset: SymbolPreset;
  theme: PaletteTheme;
  paint: (color: ThemeColor, text: string) => string;
  dim?: (text: string) => string;
  labels?: boolean;
  currency?: boolean;
  unpriced?: number;
}

/**
 * What a temporal spec says when every reading is zero. The band compositor's
 * own sentence, retyped here so the two renderings of one state agree — the
 * plot only reaches this on the defensive path, since `worthCharting` already
 * rejects an all-zero table before a spec exists.
 */
const NO_ACTIVITY = "No activity recorded in this range.";

/**
 * A multi-series temporal plot on ONE shared scale — the geometry the old
 * `renderTimeSeries` drew, restored for the host's `line` kind.
 *
 * WHY THIS IS NOT THE BAND COMPOSITOR. `renderSeriesChart` gives every series
 * its own band of rows. That is right for a categorical chart, and it is wrong
 * for a time series whose height is no greater than its series count: with six
 * series in five rows `bandHeights` hands every band its one-row floor, and
 * `renderDailyBars` at height 1 has no magnitude row above the floor
 * (`plotRows(1) === 0`), so the chart is a wall of `_` with no ink at all. The
 * analytics screens pass exactly those shapes. A shared-axis plot has no such
 * cliff: every series is drawn INTO one grid, so the marks survive any height.
 *
 * The scale is the maximum over every series (and, when stacked, over each
 * bucket's total) — one axis for all of them, which is the property the web's
 * stacking communicates (`Chart.tsx:83-98`, `leftMax` over every stackable
 * series). A stacked cell carries the series that DOMINATES its slice, since a
 * terminal cell has one hue; partial coverage keeps magnitude on the eighth-
 * block ramp. An unstacked series drops one point per bucket.
 *
 * NO AXIS LABELS AND NO CURSOR: those stay the caller's (the legend carries
 * each series' value and visibility, and money labels never leave
 * `costWithUnpriced`). The marks are the whole of what this draws.
 */
function renderSharedAxisPlot(
  series: readonly SeriesChartSeries[],
  opts: HostChartOptions,
  stacked: boolean,
  cumulative: boolean,
): readonly string[] {
  const width = Math.max(1, Math.floor(opts.width));
  const height = Math.max(1, Math.floor(opts.height ?? 6));
  const dim = opts.dim ?? ((text: string) => text);
  const count = series[0]!.values.length;
  if (count === 0) return [dim(truncateToWidth(NO_ACTIVITY, width))];

  // ONE scale for every series. Stacked charts measure the bucket TOTAL against
  // it, so a column's full stack reaches the top rather than the loudest single
  // component.
  let max = 0;
  for (let i = 0; i < count; i++) {
    let total = 0;
    for (const entry of series) {
      const value = entry.values[i] ?? 0;
      if (value > max) max = value;
      total += value;
    }
    if (stacked && total > max) max = total;
  }
  if (!(max > 0)) return [dim(truncateToWidth(NO_ACTIVITY, width))];

  const colors = resolveSeries(series.length, opts.theme);
  // The left column is the spine, so it is spent only when there are two
  // columns to spend — otherwise `spine + plot` would be one cell wider than the
  // panel, and one over-wide line corrupts the whole overlay. One column per
  // bucket where they fit; the newest buckets otherwise.
  const spineWidth = width >= 2 ? 1 : 0;
  const available = Math.max(1, width - spineWidth);
  const slots = Math.min(count, available);
  const cellWidth = Math.max(1, Math.floor(available / slots));
  const plotWidth = slots * cellWidth;
  const start = count - slots;

  const grid: string[][] = Array.from({ length: height }, () => Array<string>(plotWidth).fill(" "));
  for (let slot = 0; slot < slots; slot++) {
    const i = start + slot;
    if (stacked) {
      for (let y = 0; y < height; y++) {
        const low = ((height - 1 - y) / height) * max;
        const high = ((height - y) / height) * max;
        let base = 0;
        let coverage = 0;
        let dominant = 0;
        let color = colors[0]!;
        for (let r = 0; r < series.length; r++) {
          const value = series[r]!.values[i] ?? 0;
          const overlap = Math.max(0, Math.min(base + value, high) - Math.max(base, low));
          coverage += overlap;
          if (overlap > dominant) {
            dominant = overlap;
            color = colors[r] ?? colors[0]!;
          }
          base += value;
        }
        if (coverage <= 0) continue;
        const level = Math.max(0, Math.min(SPARK_LEVELS - 1, Math.ceil((coverage / (high - low)) * SPARK_LEVELS) - 1));
        const mark = opts.paint(color, glyph(opts.preset, "sparkRamp", level));
        for (let x = slot * cellWidth; x < (slot + 1) * cellWidth; x++) grid[y]![x] = mark;
      }
    } else {
      for (let r = 0; r < series.length; r++) {
        const value = series[r]!.values[i] ?? 0;
        const y = height - 1 - Math.max(0, Math.min(height - 1, Math.round((value / max) * (height - 1))));
        const mark = opts.paint(colors[r] ?? colors[0]!, glyph(opts.preset, cumulative ? "pointFilled" : "pointHollow"));
        if (cumulative) for (let x = slot * cellWidth; x < (slot + 1) * cellWidth; x++) grid[y]![x] = mark;
        else grid[y]![slot * cellWidth + Math.floor((cellWidth - 1) / 2)] = mark;
      }
    }
  }
  const spine = spineWidth > 0 ? dim(glyph(opts.preset, "plotSpine")) : "";
  return grid.map((row) => spine + row.join(""));
}

/**
 * Render a host `ChartSpec` to terminal lines using the project's own primitives.
 *
 * Currency labels go through `costWithUnpriced` — never the host's `formatValue`.
 */
export function renderHostChart(spec: ChartSpec, opts: HostChartOptions): readonly string[] {
  const { width, preset, theme, paint, dim, labels } = opts;
  if (!spec.series.length) return [];

  const series: SeriesChartSeries[] = spec.series.map((entry) => ({
    label: entry.name,
    values: entry.points.map((point) => point?.value ?? 0),
  }));

  // THE HOST OWNS THE KIND, SO THE RENDERER MUST READ IT. A temporal axis comes
  // back `line`; everything else (bar/paired/grouped/heatmap) is categorical and
  // stays on the band compositor. A multi-series `line` draws the shared-axis
  // plot — see {@link renderSharedAxisPlot} for why the compositor cannot draw
  // those shapes. A SINGLE series keeps the compositor: its column chart is the
  // same rendering it had before the swap, and this must not change it.
  const temporal = spec.kind === "line";
  const lines = temporal && series.length > 1
    ? renderSharedAxisPlot(series, opts, (spec as TimelineChartSpec).stacked === true, (spec as TimelineChartSpec).cumulative === true)
    : renderSeriesChart(series, {
      width,
      height: opts.height ?? 6,
      preset,
      theme,
      paint,
      dim: dim ?? ((text: string) => text),
      labels,
    });

  if (!opts.currency || opts.unpriced === undefined) return lines;

  const money: string[] = [];
  for (const entry of spec.series) {
    if (entry.dim !== "currency") continue;
    const figures = entry.points.map((point) =>
      point ? costWithUnpriced(point.value, opts.unpriced!) : "—",
    );
    money.push(`${entry.name}: ${figures.join(", ")}`);
  }

  return [...lines, ...money];
}
