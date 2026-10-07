/**
 * `src/tui/charts/host-adapter.ts` — plan and render host charts with our glyphs.
 *
 * The host pipeline decides what a table becomes and what it plots:
 * `analyzeTable` reads the cells, `planChart` picks the chart kind and the
 * columns to draw, `buildChart` turns that into a `ChartSpec`, and
 * `worthCharting` decides whether the picture says more than the table. This
 * module only maps our `TimelineRow[]` and bar-series shapes onto the host's
 * table input, then redraws the resulting `ChartSpec` with the project's own
 * primitives — `renderSeriesChart`, `resolveSeries`, our glyphs.
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
import type { PaletteTheme } from "../palette";
import type { SymbolPreset } from "../glyphs";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

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

  const lines = renderSeriesChart(series, {
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
