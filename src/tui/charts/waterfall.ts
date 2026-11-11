import { NO_ACTIVITY, clampCells, padEndCells } from "./measure";
import type { GlyphSet, GlyphValue } from "../glyphs";

/**
 * A running total with the signed changes that built it, top to bottom.
 *
 * The terminal translation of the web's Waterfall: each row is a label plus
 * one bar. `total` steps start at zero and reset the running total; `delta`
 * steps float from it — up (filled) for gains, dimmed for drops. The final
 * total must equal the sum; the renderer asserts it in dev (a silent drift
 * between the bars and the figure is the lie this chart exists to prevent).
 * Negative intermediate totals render below the zero baseline honestly —
 * never clipped to it.
 */

export interface WaterfallStep {
	label: string;
	kind: "total" | "delta";
	/** A total's level, or a delta's signed change. */
	value: number;
}

export interface WaterfallOptions {
	width: number;
	glyphs: GlyphSet;
	labelWidth?: number;
	/** Data ink for gains and totals. */
	accent?: (text: string) => string;
	/** Chrome ink for drops. Defaults to identity. */
	dim?: (text: string) => string;
}

function mark(glyphs: GlyphSet, role: keyof GlyphSet): string {
	const value: GlyphValue = glyphs[role];
	return typeof value === "string" ? value : (value[0] ?? "");
}

export function renderWaterfall(steps: readonly WaterfallStep[], opts: WaterfallOptions): readonly string[] {
	const width = Math.max(0, Math.floor(opts.width));
	const dim = opts.dim ?? ((text: string) => text);
	const accent = opts.accent ?? ((text: string) => text);
	if (width === 0) return [];

	// Running totals first: the scale must fit every intermediate level.
	let running = 0;
	const levels: number[] = [];
	for (const step of steps) {
		running = step.kind === "total" ? step.value : running + step.value;
		levels.push(running);
	}
	const peak = Math.max(0, ...levels);
	if (!(peak > 0) && !levels.some(level => level < 0)) {
		return [dim(clampCells("No activity recorded in this range.", width))];
	}

	const labelWidth = Math.max(0, Math.floor(opts.labelWidth ?? 18));
	const barWidth = Math.max(1, width - labelWidth - 1);
	const span = Math.max(peak, 0) - Math.min(0, ...levels);
	const cell = (v: number): number => span > 0 ? Math.max(0, Math.min(barWidth - 1, Math.round(((v - Math.min(0, ...levels)) / span) * (barWidth - 1)))) : 0;

	let base = 0;
	return steps.map((step, i) => {
		const from = step.kind === "total" ? 0 : base;
		const to = levels[i]!;
		base = to;
		const lo = Math.min(from, to), hi = Math.max(from, to);
	const bar = new Array<string>(barWidth).fill(" ");
		const up = to >= from;
		// Drops wear the same shape in chrome ink — barEmpty means "no data"
		// elsewhere, and a measured drop is not absent.
		for (let c = cell(lo); c <= cell(hi); c++) bar[c] = up ? accent(mark(opts.glyphs, "barFill")) : dim(mark(opts.glyphs, "barFill"));
		return clampCells(padEndCells(step.label, labelWidth) + " " + bar.join(""), width);
	});
}
