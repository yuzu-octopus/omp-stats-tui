/**
 * `src/tui/charts/host-adapter.ts` — plan and render host charts with our glyphs.
 *
 * Bridges raw timeline/series data to a concrete chart spec, then renders
 * using the project's own primitives. Currency labels go through
 * `costWithUnpriced` — never the host's `formatValue` — so unpriced requests
 * show N/A rather than a misleading $0.
 */

import type { TimelineRow, TimeSeriesOptions } from "./time-series";
import type { SeriesChartSeries, SeriesChartOptions } from "./compose";
import { renderSeriesChart } from "./compose";
import { costWithUnpriced } from "../format";
import type { PaletteTheme } from "../palette";
import type { SymbolPreset } from "../glyphs";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

// ─── Chart spec ──────────────────────────────────────────────────────────────

export interface HostChartSeries {
  label: string;
  values: readonly (number | null)[];
  dim?: "currency" | "number" | "percent";
}

/**
 * A concrete, renderable chart. Deliberately plain (`number[]`, not the IR's
 * `MetricRef`): the adapter has already resolved the data.
 *
 * STACKED/CUMULATIVE ARE RECORDED, NOT RENDERED. `renderSeriesChart` composes
 * one BAND per series against a shared scale — it has no stacking geometry, and
 * a terminal cell cannot carry two stacked values legibly (that is exactly the
 * `░█░█░█` noise `compose.ts` exists to prevent). So `stacked`/`cumulative`
 * survive here as metadata for a caller that wants to sum before plotting; the
 * renderer treats every spec as banded. A `stacked` spec is therefore rendered
 * as its component bands, which is honest — it shows the parts — and the
 * caller that needs a total sums the series first.
 */
export interface HostChartSpec {
  kind: "line" | "bars";
  categories: readonly string[];
  series: readonly HostChartSeries[];
  /** Recorded from {@link TimeSeriesOptions}; see the note above. */
  stacked?: boolean;
  /** Recorded from {@link TimeSeriesOptions}; see the note above. */
  cumulative?: boolean;
}

// ─── Table analysis ──────────────────────────────────────────────────────────

export interface TableAnalysis {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  roles: readonly ("label" | "measure")[];
}

export function analyzeTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): TableAnalysis {
  return {
    header,
    rows,
    roles: header.map((_, i) => (i === 0 ? "label" : "measure")),
  };
}

// ─── Chart planning ──────────────────────────────────────────────────────────

export function planChart(
  table: TableAnalysis,
  dims?: readonly ("currency" | "number" | "percent")[],
): HostChartSpec | undefined {
  if (!table.header.length || !table.rows.length) return undefined;

  const measures = table.header.slice(1);
  if (!measures.length) return undefined;

  return {
    kind: "bars",
    categories: table.rows.map((row) => row[0]!),
    series: measures.map((label, i) => ({
      label,
      values: table.rows.map((row) => {
        const v = row[i + 1];
        if (v === undefined || v === "—") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }),
      dim: dims?.[i] ?? "number",
    })),
  };
}

export function buildChart(_table: TableAnalysis, plan: HostChartSpec): HostChartSpec | undefined {
  return plan;
}

export function worthCharting(spec: HostChartSpec): boolean {
  return spec.series.length > 0;
}

// ─── Timeline planning ───────────────────────────────────────────────────────

/**
 * Full pipeline: timeline data → HostChartSpec.
 *
 * Table construction follows the pre-flight ruling: header = [labelCol, ...measureNames],
 * rows = categories × measures (column 0 = categories).
 *
 * Gap policy: returns undefined when there are fewer than 3 buckets (sub-threshold).
 */
export function planTimeline(
  axis: readonly number[],
  rows: readonly TimelineRow[],
  options: TimeSeriesOptions,
): HostChartSpec | undefined {
  if (!axis.length || !rows.length) return undefined;
  if (axis.length < 3) return undefined;

  const header = ["Bucket", ...rows.map((r) => r.label)];
  const tableRows = axis.map((ts, i) => {
    const bucketLabel = new Date(ts).toISOString().slice(5, 16).replace("T", " ");
    return [bucketLabel, ...rows.map((r) => String(r.values[i] ?? "—"))];
  });

  const table = analyzeTable(header, tableRows);
  const dims = rows.map((r) => (r.key === "cost" ? ("currency" as const) : ("number" as const)));
  const plan = planChart(table, dims);
  if (!plan) return undefined;
  const spec = buildChart(table, plan);
  if (!spec || !worthCharting(spec)) return undefined;

  // `stacked`/`cumulative` are RECORDED, not applied — see HostChartSpec. The
  // banded renderer shows the parts; a caller wanting the stack total sums the
  // series before plotting.
  return { ...spec, kind: "line", stacked: options.stacked, cumulative: options.cumulative };
}

// ─── Series planning ─────────────────────────────────────────────────────────

/**
 * Full pipeline: series data → HostChartSpec.
 *
 * Table construction follows the pre-flight ruling: header = [labelCol, ...measureNames],
 * rows = categories × measures (column 0 = categories).
 */
export function planSeries(
  series: readonly SeriesChartSeries[],
  _options: SeriesChartOptions,
): HostChartSpec | undefined {
  if (!series.length) return undefined;

  const header = ["Series", ...series.map((s) => s.label)];
  const tableRows = series[0]!.values.map((_, i) => {
    const bucketLabel = `Bucket ${i + 1}`;
    return [bucketLabel, ...series.map((s) => String(s.values[i] ?? "—"))];
  });

  const table = analyzeTable(header, tableRows);
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
 * Render a HostChartSpec to terminal lines using the project's own primitives.
 *
 * Currency labels go through `costWithUnpriced` — never the host's `formatValue`.
 */
export function renderHostChart(spec: HostChartSpec, opts: HostChartOptions): readonly string[] {
  const { width, preset, theme, paint, dim, labels } = opts;
  const dimFn = dim ?? ((text: string) => text);

  if (!spec.series.length) return [];

  const series: SeriesChartSeries[] = spec.series.map((s) => ({
    label: s.label,
    values: s.values.map((v) => v ?? 0),
  }));

  const lines = renderSeriesChart(series, {
    width,
    height: opts.height ?? 6,
    preset,
    theme,
    paint,
    dim: dimFn,
    labels,
  });

  if (!opts.currency || opts.unpriced === undefined) return lines;

  const valueLines: string[] = [];
  for (const s of spec.series) {
    if (s.dim !== "currency") continue;
    const formatted = s.values.map((v) => (v === null ? "—" : costWithUnpriced(v, opts.unpriced!)));
    valueLines.push(`${s.label}: ${formatted.join(", ")}`);
  }

  return [...lines, ...valueLines];
}
