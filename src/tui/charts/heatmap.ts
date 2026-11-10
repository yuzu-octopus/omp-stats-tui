import { calendarLayout } from "./calendar";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { GlyphSet } from "../glyphs";

/**
 * The calendar heatmap. Monday-first, one cell per day, exactly like `/usage`'s
 * own ANSI grid (usage-dashboard.ts:824-872 — not the native chart/table, which
 * are fallback surfaces for other terminals).
 *
 * A pure render function: data in, lines out. No theme singleton, no database,
 * no I/O. Styling arrives injected (`dim`, `ramp`), because the theme
 * singleton throws when an extension reads it at module scope.
 *
 * The terminal-owned calendar layout ports `/usage`'s local-date algorithm:
 * zero-fill for quiet days, sqrt-compressed max-anchored levels, request
 * fallback for unpriced activity, and `null` for future dates. The colour
 * ramp arrives from `palette.heatRamp`, which ports `/usage`'s arithmetic.
 *
 * `calendarLayout` memoises on the `points` array reference, so hand it the
 * payload array itself: a `filter`/`map` copy gets no hit, and mutating one
 * in place would serve a stale grid.
 */

/** Raw foreground reset. Deliberately not `theme.fg(...)` per cell: that would
 *  be a theme lookup for every one of ~371 cells on every frame. `/usage` does
 *  the same thing for the same reason. */
const FG_RESET = "\x1b[39m";

/** All seven Monday-first day labels, exactly as /usage's HEATMAP_DAY_LABELS. */
const ROW_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export interface HeatmapOptions {
	/** Content width. No rendered row may exceed it. */
	innerWidth: number;
	/** Width of the weekday-label gutter. */
	labelWidth: number;
	/** Week columns to draw. Reduced by `weeksForWidth` on a narrow terminal. */
	weeks: number;
	glyphs: GlyphSet;
	/**
	 * Four colour stops for levels 1..4. Level 0 deliberately uses none: a day
	 * with no activity must read as empty, not as the faintest colour.
	 */
	ramp: readonly string[];
	/** Dim styling, injected so this module never reads the theme singleton. */
	dim: (text: string) => string;
	/** Injectable so tests are independent of the wall clock. */
	today?: Date;
	/** Local calendar day selected by keyboard; future cells remain absent. */
	selectedDay?: string;
	/** Selected-cell styling is injected from the active theme. */
	selected?: (text: string) => string;
}

/**
 * How many week columns fit the width: the host's own continuous clamp
 * (usage-dashboard.ts:834). Narrow terminals lose WINDOW, never cell size —
 * a cell stays exactly one column wide.
 */
export function weeksForWidth(labelWidth: number, innerWidth: number): number {
	return Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));
}

/**
 * Render the grid: one dimmed month-label row plus seven day rows
 * (usage-dashboard.ts:824-872, rendered byte for byte: dimmed gutters, dimmed
 * empty cells, the single ■ at four ramp colours, raw ESC[39m resets,
 * trimEnd'ed day rows).
 *
 * Cell states:
 *
 *   null  → a future date. Two spaces. ABSENT, not zero.
 *   0     → no activity. Dimmed `heatEmpty` plus a space. Present and
 *           accounted for.
 *   1..4  → `ramp[cell - 1]` + ■ + FG_RESET + space. The glyph is identical
 *           at every level; the colour alone carries the intensity.
 */
export function renderHeatmap(
	points: readonly DailyActivityPoint[],
	opts: HeatmapOptions,
): readonly string[] {
	const weeks = Math.max(1, opts.weeks);
	const layout = calendarLayout(points, weeks, opts.today);
	const selectedDate = opts.selectedDay ? new Date(`${opts.selectedDay}T12:00:00`) : undefined;
	const selectedOffset = selectedDate
		? Math.round((Date.UTC(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()) -
			Date.UTC(layout.start.getFullYear(), layout.start.getMonth(), layout.start.getDate())) / 86_400_000)
		: -1;
	const selectedWeek = Math.floor(selectedOffset / 7);
	const selectedRow = selectedOffset % 7;

	// Fixed at 2: the host's own gutter (usage-dashboard.ts:833), one label
	// cell plus one space. Callers pass it through; anything else is clamped.
	const labelWidth = 2;
	// One glyph plus one space per column.
	const columnWidth = 2;

	// The host's own assembly (usage-dashboard.ts:851-859): start from the
	// gutter and APPEND each label only when its column starts at or past the
	// end of the text so far. Overwriting a character buffer instead would
	// fuse two month names where a short month meets the next label.
	let monthLine = " ".repeat(labelWidth);
	for (let week = 0; week < weeks; week++) {
		const label = layout.monthLabels[week];
		const targetCol = labelWidth + week * columnWidth;
		if (label && targetCol >= visibleWidth(monthLine)) {
			monthLine = monthLine.padEnd(targetCol) + label;
		}
	}
	const monthRow = opts.dim(truncateToWidth(monthLine, opts.innerWidth));

	const body = layout.cells.map((weekRow, dayIndex) => {
		let line = opts.dim(ROW_LABELS[dayIndex] ?? "") + " ";
		for (let week = 0; week < weeks; week++) {
			const cell = weekRow[week];
			// ABSENT (a future date) — blank, and deliberately NOT the empty glyph.
			// Colouring a day that has not happened as "zero activity" would be a
			// lie about spend.
			if (cell === null) line += "  ";
			// Present but no activity — drawn, so a quiet day still occupies its
			// slot in the calendar rather than vanishing from the axis.
			else if (week === selectedWeek && dayIndex === selectedRow && opts.selected) {
				line += `${opts.selected(cell === 0 ? emptyCell(opts.glyphs) : heatCell(opts.glyphs, cell))} `;
			} else if (cell === 0) line += `${opts.dim(emptyCell(opts.glyphs))} `;
			else line += `${opts.ramp[cell - 1] ?? ""}${heatCell(opts.glyphs, cell)}${FG_RESET} `;
		}
		return line.trimEnd();
	});

	// Clamp to the requested width. Truncating is correct here and wrapping is
	// not: a wrapped row silently doubles the row count and shifts the whole grid.
	const width = Math.max(0, opts.innerWidth);
	return [monthRow, ...body].map(row => (Bun.stringWidth(row) > width ? clip(row, width) : row));
}

/** Clip to `width` visible cells without splitting an ANSI escape sequence. */
function clip(row: string, width: number): string {
	if (width <= 0) return "";
	let visible = 0;
	let out = "";
	for (let i = 0; i < row.length; ) {
		if (row[i] === "\x1b") {
			const end = row.indexOf("m", i);
			const stop = end === -1 ? row.length : end + 1;
			out += row.slice(i, stop);
			i = stop;
			continue;
		}
		if (visible >= width) break;
		out += row[i];
		visible++;
		i++;
	}
	return out;
}

/**
 * Read one rung of a role's ladder out of the `GlyphSet` the caller already
 * resolved. `glyph(preset, role, level)` would need a preset string, but the
 * caller hands us the set instead so that no render function has to re-read the
 * theme singleton. Going through the set keeps one source of truth: the ladder in
 * `src/tui/glyphs.ts` is the only place a heatmap character is written down.
 */
function ladderRung(set: GlyphSet, role: "heatCell" | "heatEmpty", level: number): string {
	const value = set[role];
	if (typeof value === "string") return value;
	return value[Math.max(0, Math.min(value.length - 1, level))] ?? value[0];
}

/** Level 1..4 cell glyph. */
function heatCell(set: GlyphSet, level: number): string {
	return ladderRung(set, "heatCell", level - 1);
}

/** A day that is present but had no activity. */
function emptyCell(set: GlyphSet): string {
	return ladderRung(set, "heatEmpty", 0);
}
