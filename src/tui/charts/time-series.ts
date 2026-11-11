import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { FeatureContext } from "../features/types";
import { resolveSeries } from "../palette";
import { compactTokens, formatPercent } from "../format";
import { glyph } from "../glyphs";
import { clampCells, type BucketSpan } from "./measure";
export type { BucketSpan };
import { planTimeline, renderHostChart } from "./host-adapter";

export interface TimelineRow {
	key: string;
	label: string;
	values: readonly (number | null)[];
	legendValue?: string;
	colorIndex?: number;
}
export interface TimeSeriesOptions {
	percent?: boolean;
	cumulative?: boolean;
	hidden?: ReadonlySet<string>;
	stacked?: boolean;
	format?: (value: number) => string;
	unit?: string;
	/** Optional per-series readout, e.g. a priced floor with that bucket's unknown count. */
	formatValue?: (key: string, value: number | null | undefined, point: number) => string;
	height?: number;
	selectedKey?: string;
	legend?: boolean;
	/** Caller intent: mark this chart as currency. When absent, falls back to key sniffing (row.key === "cost"). */
	currency?: boolean;
	/** Called with clickable bucket spans (chart-relative rows). Null-gap and width-clamped buckets are omitted. */
	reportBuckets?: (spans: readonly BucketSpan[]) => void;
	/** Active filter context appended to the empty state ("Matching X."). No-filter calls render byte-identical strings. */
	filter?: string;
}

/**
 * The one sentence a plot-less range gets.
 *
 * `worthCharting` says "not worth a chart" for too few buckets and for flat
 * data alike, so the sentence is chosen from what the rows actually recorded:
 * no reading at all, every reading zero, or a real series the host still
 * judged too flat to draw. Those are three different claims and the reader
 * must not be handed the same one for each.
 */
function emptyState(active: readonly TimelineRow[], filter?: string): string {
	let measured = false;
	let max = 0;
	for (const row of active) for (const value of row.values) {
		if (value === null || value === undefined) continue;
		measured = true;
		if (value > max) max = value;
	}
	const base = !measured ? "No readings in the visible series; gaps are not zero."
		: max === 0 ? "No positive measured values in this range."
		: "No chart-worthy data in this range.";
	// Context is a suffix, never a fourth sentence: the taxonomy (no readings /
	// all zero / not chart-worthy) is picked first, the active filter appended.
	// No-filter calls render byte-identical strings.
	return filter ? `${base} Matching ${filter}.` : base;
}

/**
 * `MM-DD HH:mm` in UTC — the axis labels' only date shape. One helper so the
 * header, footer-start and footer-end conversions stay byte-identical.
 */
function formatBucket(dateMs: number): string {
	return new Date(dateMs).toISOString().slice(5, 16).replace("T", " ");
}

/**
 * Recorded buckets share one scale; null stays a gap and narrow views follow the selected point.
 *
 * GEOMETRY IS THE HOST'S. `planTimeline` builds the host table, `planChart`
 * picks the kind and `worthCharting` is the gate — a range the host will not
 * chart returns `undefined` and gets our own sentence instead. `renderHostChart`
 * redraws the spec with our glyphs. The header, the bucket-range footer and the
 * legend stay ours: they read the DATA, not the plot, and the legend is the one
 * surface carrying each series' value and visibility.
 */
export function renderTimeSeries(ctx: FeatureContext, axis: readonly number[], rows: readonly TimelineRow[], width: number, selected: number, options: TimeSeriesOptions = {}): string[] {
	const w = Math.max(1, Math.floor(width));
	if (!axis.length || !rows.length) return wrapTextWithAnsi(ctx.theme.fg("dim", "No recorded chart observations in this range."), w);
	const preset = ctx.theme.getSymbolPreset();
	const format = options.format ?? (options.percent ? value => formatPercent(value, 0) : compactTokens);
	const active = rows.filter(row => !options.hidden?.has(row.key));
	const colors = resolveSeries(Math.max(rows.length, ...rows.map(row => (row.colorIndex ?? 0) + 1)), ctx.theme);
	selected = Math.max(0, Math.min(axis.length - 1, selected));
	const date = formatBucket(axis[selected]!);
	const lines = wrapTextWithAnsi(ctx.theme.fg("dim", `${options.unit ? options.unit + " · " : ""}${date} UTC · ${axis.length} buckets`), w);
	if (!active.length) lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", "All series hidden; select a legend and toggle visibility to restore it."), w));
	else {
		const plotStart = lines.length;
		const spec = planTimeline(axis, active, options);
		if (!spec) lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", emptyState(active, options.filter)), w));
		else lines.push(...renderHostChart(spec, {
			width: w,
			height: options.height,
			preset,
			theme: ctx.theme,
			paint: (color, text) => ctx.theme.fg(color, text),
			// The floor is CHROME, never a series hue — the same rule the band
			// renderer keeps. Labels are off: the legend below names the series.
			dim: text => ctx.theme.fg("dim", text),
			labels: false,
			reportBuckets: options.reportBuckets ? spans => options.reportBuckets!(spans.map(span => ({ ...span, rowStart: span.rowStart + plotStart, rowEnd: span.rowEnd + plotStart }))) : undefined,
		}));
	}
	const first = formatBucket(axis[0]!);
	const last = formatBucket(axis[axis.length - 1]!);
	lines.push(...wrapTextWithAnsi(ctx.theme.fg("dim", `${first} → ${last} UTC`), w));
	if (options.legend !== false) for (let r = 0; r < rows.length; r++) {
		const row = rows[r], hidden = options.hidden?.has(row.key);
		const value = row.values[selected];
		const detail = (options.formatValue?.(row.key, value, selected) ?? (value === null || value === undefined ? "—" : format(value))) + (row.legendValue === undefined ? "" : ` · ${row.legendValue}`);
		const prefix = `${row.key === options.selectedKey ? glyph(preset, "rowCursor") : " "} ${ctx.theme.fg(hidden ? "dim" : colors[row.colorIndex ?? r], glyph(preset, "legendKey"))} `;
		const label = clampCells((hidden ? "off " : "") + row.label, Math.max(1, w - visibleWidth(prefix) - visibleWidth(detail) - 2));
		const line = prefix + label + " ".repeat(Math.max(1, w - visibleWidth(prefix + label) - visibleWidth(detail))) + detail;
		lines.push(hidden ? ctx.theme.fg("dim", line) : line);
	}
	return lines.map(line => clampCells(line, w));
}
