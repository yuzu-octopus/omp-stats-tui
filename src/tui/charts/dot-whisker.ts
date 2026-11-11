import { clampCells, padEndCells } from "./measure";
import type { GlyphSet, GlyphValue } from "../glyphs";

/**
 * Point estimates with their intervals on one shared axis, one row per group.
 *
 * The terminal translation of the web's DotWhisker: each row is a label plus
 * a track of N cells mapping the shared [min, max] domain (always spanning
 * zero, like the web). A mark is one filled cell; its interval is dimmed
 * whisker cells on either side. Several marks on one row overlay — later
 * marks win the cell, every mark is named in the legend detail the caller
 * prints. A null mark is a gap: no cell, never zero. Shapes (dot/ring/
 * diamond/square) collapse to one mark — the terminal has no hover text to
 * disambiguate them, and four glyphs for one magnitude would be decoration.
 */

export interface DotWhiskerMark {
	/** Value, or null for a gap. */
	value: number | null;
	/** Interval ends; null end means no whisker that way. */
	lo?: number | null;
	hi?: number | null;
}

export interface DotWhiskerRow {
	label: string;
	marks: readonly DotWhiskerMark[];
}

export interface DotWhiskerOptions {
	width: number;
	glyphs: GlyphSet;
	labelWidth?: number;
	/** Data ink for marks. */
	accent?: (text: string) => string;
	/** Chrome ink for whiskers. Defaults to identity. */
	dim?: (text: string) => string;
}

function mark(glyphs: GlyphSet, role: keyof GlyphSet): string {
	const value: GlyphValue = glyphs[role];
	return typeof value === "string" ? value : (value[0] ?? "");
}

export function renderDotWhisker(rows: readonly DotWhiskerRow[], opts: DotWhiskerOptions): readonly string[] {
	const width = Math.max(0, Math.floor(opts.width));
	if (width === 0 || rows.length === 0) return [];
	const dim = opts.dim ?? ((text: string) => text);
	const accent = opts.accent ?? ((text: string) => text);

	// Shared domain across every mark, always spanning zero.
	let min = 0, max = 0;
	for (const row of rows) for (const m of row.marks) {
		for (const v of [m.value, m.lo ?? null, m.hi ?? null]) {
			if (v === null || !Number.isFinite(v)) continue;
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	if (!(max > min)) return [dim(clampCells("No activity recorded in this range.", width))];

	const labelWidth = Math.max(0, Math.floor(opts.labelWidth ?? 18));
	const trackWidth = Math.max(1, width - labelWidth - 1);
	const cell = (v: number): number => Math.max(0, Math.min(trackWidth - 1, Math.round(((v - min) / (max - min)) * (trackWidth - 1))));

	return rows.map(row => {
		const track: string[] = new Array(trackWidth).fill(" ");
		for (const m of row.marks) {
			const lo = m.lo ?? null, hi = m.hi ?? null;
			if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
				for (let c = cell(Math.min(lo, hi)); c <= cell(Math.max(lo, hi)); c++) track[c] = dim(mark(opts.glyphs, "axisRule"));
			} else if (lo !== null && Number.isFinite(lo)) {
				track[cell(lo)] = dim(mark(opts.glyphs, "axisRule"));
			} else if (hi !== null && Number.isFinite(hi)) {
				track[cell(hi)] = dim(mark(opts.glyphs, "axisRule"));
			}
			if (m.value !== null && Number.isFinite(m.value)) {
				track[cell(m.value)] = accent(mark(opts.glyphs, "trackMarker"));
		}
		}
		return padEndCells(row.label, labelWidth) + " " + track.join("");
	}).map(line => clampCells(line, width));
}
