import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { FeatureContext } from "../features/types";
import { PALETTE, resolveSeries } from "../palette";
import { compactTokens, formatPercent } from "../format";
import { glyph, SPARK_LEVELS } from "../glyphs";

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
}

/** Recorded buckets share one scale; null stays a gap and narrow views follow the selected point. */
export function renderTimeSeries(ctx: FeatureContext, axis: readonly number[], rows: readonly TimelineRow[], width: number, selected: number, options: TimeSeriesOptions = {}): string[] {
	const w = Math.max(1, Math.floor(width));
	if (!axis.length || !rows.length) return wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, "No recorded chart observations in this range."), w);
	const preset = ctx.theme.getSymbolPreset();
	const format = options.format ?? (options.percent ? value => formatPercent(value, 0) : compactTokens);
	const active = rows.filter(row => !options.hidden?.has(row.key));
	const colors = resolveSeries(Math.max(rows.length, ...rows.map(row => (row.colorIndex ?? 0) + 1)), ctx.theme);
	let max = options.percent ? 1 : 0;
	let measured = false;
	for (let i = 0; i < axis.length; i++) {
		let total = 0;
		for (const row of active) {
			const value = row.values[i];
			if (value === null || value === undefined) continue;
			measured = true;
			total += value;
			max = Math.max(max, value);
		}
		if (options.stacked) max = Math.max(max, total);
	}
	selected = Math.max(0, Math.min(axis.length - 1, selected));
	const yWidth = Math.min(9, Math.max(3, visibleWidth(format(max))));
	const available = Math.max(1, w - yWidth - 2);
	const slots = Math.min(axis.length, available);
	const start = Math.max(0, Math.min(axis.length - slots, selected - Math.floor(slots / 2)));
	const cellWidth = Math.max(1, Math.floor(available / slots));
	const plotWidth = slots * cellWidth;
	const markWidth = Math.min(3, Math.max(1, cellWidth - 1));
	const inset = Math.floor((cellWidth - markWidth) / 2);
	const height = Math.max(3, Math.min(10, Math.floor(options.height ?? 6)));
	const date = new Date(axis[selected]).toISOString().slice(5, 16).replace("T", " ");
	const lines = wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, `${options.unit ? options.unit + " · " : ""}${date} UTC · ${start + 1}–${start + slots}/${axis.length} buckets`), w);
	if (!active.length) lines.push(...wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, "All series hidden; select a legend and toggle visibility to restore it."), w));
	else if (!measured || max === 0) lines.push(...wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, measured ? "No positive measured values in this range." : "No readings in the visible series; gaps are not zero."), w));
	else {
		const grid = Array.from({ length: height }, () => Array<string>(plotWidth).fill(" "));
		for (let slot = 0; slot < slots; slot++) {
			const i = start + slot;
			if (options.stacked) {
				// One terminal character has one hue: choose its dominant measured segment,
				// not a whole fake row for a sub-cell series. Partial fill keeps magnitude.
				for (let y = 0; y < height; y++) {
					const low = (height - 1 - y) / height * max;
					const high = (height - y) / height * max;
					let base = 0, coverage = 0, dominant = 0, color = colors[0];
					for (let r = 0; r < rows.length; r++) {
						const row = rows[r];
						if (options.hidden?.has(row.key)) continue;
						const value = row.values[i] ?? 0;
						const overlap = Math.max(0, Math.min(base + value, high) - Math.max(base, low));
						coverage += overlap;
						if (overlap > dominant) { dominant = overlap; color = colors[row.colorIndex ?? r]; }
						base += value;
					}
					if (coverage <= 0) continue;
					const level = Math.max(0, Math.min(SPARK_LEVELS - 1, Math.ceil(coverage / (high - low) * SPARK_LEVELS) - 1));
					const mark = ctx.theme.fg(color, glyph(preset, "sparkRamp", level));
					for (let x = slot * cellWidth + inset; x < slot * cellWidth + inset + markWidth; x++) grid[y][x] = mark;
				}
			} else {
				for (let r = 0; r < rows.length; r++) {
					const row = rows[r];
					if (options.hidden?.has(row.key)) continue;
					const value = row.values[i];
					if (value === null || value === undefined) continue;
					const y = height - 1 - Math.max(0, Math.min(height - 1, Math.round(value / max * (height - 1))));
					const mark = ctx.theme.fg(colors[row.colorIndex ?? r], glyph(preset, options.cumulative ? "pointFilled" : "pointHollow"));
					const x = slot * cellWidth + Math.floor((cellWidth - 1) / 2);
					grid[y][x] = mark;
				}
			}
		}
		for (let y = 0; y < height; y++) {
			const label = y === 0 ? format(max) : y === height - 1 ? format(0) : y === Math.floor((height - 1) / 2) ? format(max * (height - 1 - y) / (height - 1)) : "";
			lines.push(ctx.theme.fg(PALETTE.muted, truncateToWidth(label, yWidth).padStart(yWidth) + " " + glyph(preset, "plotSpine")) + grid[y].join(""));
		}
		lines.push(" ".repeat(yWidth + 2 + (selected - start) * cellWidth + Math.floor((cellWidth - 1) / 2)) + ctx.theme.fg("accent", glyph(preset, "plotCursor")));
	}
	const first = new Date(axis[start]).toISOString().slice(5, 16).replace("T", " ");
	const last = new Date(axis[start + slots - 1]).toISOString().slice(5, 16).replace("T", " ");
	lines.push(...wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, `${first} → ${last} UTC`), w));
	if (options.legend !== false) for (let r = 0; r < rows.length; r++) {
		const row = rows[r], hidden = options.hidden?.has(row.key);
		const value = row.values[selected];
		const detail = hidden ? "hidden" : (options.formatValue?.(row.key, value, selected) ?? (value === null || value === undefined ? "—" : format(value))) + (row.legendValue === undefined ? "" : ` · ${row.legendValue}`);
		const prefix = `${row.key === options.selectedKey ? glyph(preset, "rowCursor") : " "} ${ctx.theme.fg(hidden ? PALETTE.muted : colors[row.colorIndex ?? r], glyph(preset, "legendKey"))} `;
		const labelWidth = Math.max(1, Math.min(36, w - visibleWidth(prefix) - visibleWidth(detail) - 2));
		const label = truncateToWidth(row.label, labelWidth);
		const line = prefix + label + " ".repeat(Math.max(2, labelWidth - visibleWidth(label) + 2)) + ctx.theme.bold(detail);
		lines.push(hidden ? ctx.theme.fg(PALETTE.muted, line) : line);
	}
	return lines.map(line => truncateToWidth(line, w));
}
