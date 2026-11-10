import { test, expect } from "bun:test";
import {
	planLayout,
	BREAKPOINTS,
	WIDTH_FIELDS,
	COLUMN_PARTITION_FIELDS,
} from "../src/tui/layout";
import { PANEL_CHROME_ROWS } from "../src/tui/panel-constants";
import type { SymbolPreset } from "../src/tui/glyphs";

const PRESETS: SymbolPreset[] = ["unicode", "nerd", "ascii"];

/** Every width a plan could plausibly be asked for, boundary-heavy. */
function sweep(from: number, to: number): number[] {
	const widths: number[] = [];
	for (let w = from; w <= to; w++) widths.push(w);
	return widths;
}

test("THE WIDTH INVARIANT: nothing is ever allocated past the terminal edge", () => {
	// The single most valuable test in the module: a chart drawing one cell past
	// the right edge wraps and corrupts the panel. Swept across every width, not
	// just the breakpoints, because a bug at 137 is invisible if you only check
	// 40/80/120/200.
	//
	// The invariant is NESTING, not a flat sum: innerWidth contains columnWidth,
	// which contains label+value+bar. Adding the containers to their own contents
	// would double-count and prove nothing.
	for (const preset of PRESETS) {
		for (const width of sweep(10, 400)) {
			const p = planLayout(width, 24, preset);
			const where = `${preset} w=${width}`;

			expect(p.innerWidth, where).toBeLessThanOrEqual(p.width);
			expect(p.columnWidth, where).toBeLessThanOrEqual(p.innerWidth);

			const partition = COLUMN_PARTITION_FIELDS.reduce((sum, k) => sum + p[k], 0);
			expect(partition, `${where} label+value+bar = ${partition} > column ${p.columnWidth}`)
				.toBeLessThanOrEqual(p.columnWidth);

			expect(p.sparkWidth, where).toBeLessThanOrEqual(p.innerWidth);
		}
	}
});

test("every returned width is a non-negative integer at every width", () => {
	for (const preset of PRESETS) {
		for (const width of sweep(10, 400)) {
			const p = planLayout(width, 24, preset);
			for (const key of WIDTH_FIELDS) {
				expect(Number.isInteger(p[key]), `${preset} w=${width} ${key}`).toBe(true);
				expect(p[key], `${preset} w=${width} ${key}`).toBeGreaterThanOrEqual(0);
			}
		}
	}
});

test("a sub-terminal width is legal: at least one column of content survives", () => {
	for (const preset of PRESETS) {
		for (const width of [1, 2, 5, 9, 10, 19]) {
			const p = planLayout(width, 24, preset);
			expect(p.tooNarrow, `${preset} w=${width}`).toBe(true);
			expect(p.columns, `${preset} w=${width}`).toBe(1);
			expect(p.innerWidth, `${preset} w=${width}`).toBeGreaterThanOrEqual(0);
			expect(p.barWidth, `${preset} w=${width}`).toBeGreaterThanOrEqual(0);
			expect(p.heatWeeks, `${preset} w=${width}`).toBeGreaterThanOrEqual(1);
			expect(p.barHeight, `${preset} w=${width}`).toBeGreaterThanOrEqual(1);
		}
	}
});

test("planLayout never throws, whatever it is handed", () => {
	// Defensive: the panel calls this once per frame on numbers that came from
	// the terminal, and a throw there takes the whole overlay down.
	for (const bad of [-100, -1, 0, Number.NaN, Number.MAX_SAFE_INTEGER]) {
		expect(() => planLayout(bad, 24, "unicode")).not.toThrow();
	}
	for (const bad of [-5, 0, 1, Number.NaN]) {
		expect(() => planLayout(80, bad, "unicode")).not.toThrow();
	}
});

test("each breakpoint row produces its documented decisions, walked from the table", () => {
	// Asserting the table by walking it is what lets a new breakpoint be a
	// one-line addition with no test edit — the alternative is one hand-written
	// case per threshold, which stops being maintained at the fifth.
	for (const row of BREAKPOINTS) {
		const width = row.minInnerWidth + 4; // +4 undoes the overlay panel's insets
		const p = planLayout(width, 40, "unicode");
		expect(p.columns, `${row.name} columns`).toBe(row.columns);
		expect(p.compact, `${row.name} compact`).toBe(row.compact);
		expect(p.showFooterHints, `${row.name} footer hints`).toBe(row.showFooterHints);
		expect(p.tableColumns, `${row.name} table columns`).toBe(row.tableColumns);
		expect(p.dropped, `${row.name} dropped`).toEqual(row.dropped);
	}
});

test("the breakpoint table is ordered so the first matching row wins, and covers all widths", () => {
	expect(BREAKPOINTS.length).toBeGreaterThan(1);
	// planLayout takes the FIRST row whose threshold is met, so the table must be
	// ordered widest-first and must bottom out at 0 to cover every width.
	expect(BREAKPOINTS[BREAKPOINTS.length - 1].minInnerWidth).toBe(0);
	for (let i = 1; i < BREAKPOINTS.length; i++) {
		expect(BREAKPOINTS[i].minInnerWidth).toBeLessThan(BREAKPOINTS[i - 1].minInnerWidth);
	}
});

test("dropped regions and the reason for them are both visible to a caller", () => {
	// "Degrade, never tear": a caller must be able to say what it lost and why,
	// not discover it by measuring a truncated string.
	const wide = planLayout(200, 40, "unicode");
	const narrow = planLayout(40, 24, "unicode");
	expect(wide.dropped).toEqual([]);
	expect(narrow.dropped.length).toBeGreaterThan(0);
	for (const drop of narrow.dropped) {
		expect(typeof drop.region).toBe("string");
		expect(drop.region.length).toBeGreaterThan(0);
		expect(drop.reason).toMatch(/narrow|column|width/i);
	}
});

test("widening the terminal only ever restores things, never takes them away", () => {
	// Monotonicity, swept upwards: as width grows, dropped regions must never
	// increase and columns must never decrease. Without this the panel could drop
	// a region at 60 columns and restore it at 61, which reads as a glitch.
	let previousDropped = Number.POSITIVE_INFINITY;
	let previousColumns = 0;
	for (const width of sweep(20, 300)) {
		const p = planLayout(width, 30, "unicode");
		expect(p.dropped.length, `w=${width}`).toBeLessThanOrEqual(previousDropped);
		previousDropped = p.dropped.length;
		expect(p.columns, `w=${width}`).toBeGreaterThanOrEqual(previousColumns);
		previousColumns = p.columns;
	}
	expect(previousDropped).toBe(0);
	expect(previousColumns).toBe(2);
});

test("a wide terminal gets two columns and a full-height bar chart", () => {
	const p = planLayout(200, 50, "unicode");
	expect(p.columns).toBe(2);
	expect(p.compact).toBe(false);
	expect(p.barHeight).toBeGreaterThanOrEqual(12);
	expect(p.heatWeeks).toBeGreaterThanOrEqual(26);
});

test("an 80-column terminal drops to one column", () => {
	expect(planLayout(80, 24, "unicode").columns).toBe(1);
});

test("a 40-column terminal is still a valid plan with every width at least one", () => {
	const p = planLayout(40, 24, "unicode");
	for (const key of ["innerWidth", "labelWidth", "valueWidth", "barWidth", "sparkWidth"] as const) {
		expect(p[key], key).toBeGreaterThanOrEqual(1);
	}
	expect(p.bodyRows).toBeGreaterThanOrEqual(5);
});

test("a 20x10 terminal degrades rather than returning negatives", () => {
	const p = planLayout(20, 10, "unicode");
	for (const key of ["innerWidth", "labelWidth", "valueWidth", "barWidth", "sparkWidth"] as const) {
		expect(p[key], key).toBeGreaterThanOrEqual(1);
	}
	expect(p.barHeight).toBeGreaterThanOrEqual(1);
	expect(p.heatWeeks).toBeGreaterThanOrEqual(1);
});

test("body rows clamp to the terminal and the overflow is reported, not hidden", () => {
	for (const rows of [10, 24, 40, 100]) {
		const p = planLayout(120, rows, "unicode");
		expect(p.bodyRows).toBeLessThanOrEqual(rows);
		expect(p.requestedRows).toBe(rows);
		// Comfortably tall: nothing is missing.
		expect(p.overflowRows, `rows=${rows}`).toBe(0);
	}
	// A terminal too short for its own chrome plus a one-row body still yields a
	// usable body, and says how much was lost rather than rendering a sliver.
	for (const rows of [1, 3, 5, 6]) {
		const p = planLayout(120, rows, "unicode");
		expect(p.bodyRows, `rows=${rows}`).toBe(1);
		expect(p.overflowRows, `rows=${rows}`).toBe(PANEL_CHROME_ROWS + 1 - rows);
	}
	// PANEL_CHROME_ROWS + 1 is exactly the shortest renderable panel.
	expect(planLayout(120, PANEL_CHROME_ROWS + 1, "unicode").overflowRows).toBe(0);
});

test("a bar chart taller than the body is clamped to the body and flagged", () => {
	const roomy = planLayout(200, 50, "unicode");
	const cramped = planLayout(200, 12, "unicode");
	expect(roomy.barHeight).toBeGreaterThan(cramped.barHeight);
	expect(cramped.barHeight).toBeLessThanOrEqual(cramped.bodyRows);
	expect(cramped.dropped.map(d => d.region)).toContain("barHeight");
});

test("the ascii preset does not change the layout's geometry, only its glyphs", () => {
	for (const width of [20, 40, 80, 120, 200]) {
		for (const rows of [10, 24, 40]) {
			const u = planLayout(width, rows, "unicode");
			const a = planLayout(width, rows, "ascii");
			const n = planLayout(width, rows, "nerd");
			expect(a).toEqual(u);
			expect(n).toEqual(u);
		}
	}
});

test("the heatmap week count is driven by inner width, clamped to 53", () => {
	expect(planLayout(200, 40, "unicode").heatWeeks).toBeLessThanOrEqual(53);
	expect(planLayout(60, 24, "unicode").heatWeeks).toBeLessThan(
		planLayout(200, 40, "unicode").heatWeeks,
	);
	expect(planLayout(10, 24, "unicode").heatWeeks).toBeGreaterThanOrEqual(4);
});

test("footer hints are suppressed when there is nothing to scroll", () => {
	expect(planLayout(200, 50, "unicode").showFooterHints).toBe(true);
	expect(planLayout(30, 24, "unicode").showFooterHints).toBe(false);
});

test("heatWeeks and sparkWidth are monotone non-decreasing in width", () => {
	let weeks = 0;
	let spark = 0;
	for (const width of sweep(20, 300)) {
		const p = planLayout(width, 30, "unicode");
		expect(p.heatWeeks, `w=${width}`).toBeGreaterThanOrEqual(weeks);
		weeks = p.heatWeeks;
		expect(p.sparkWidth, `w=${width}`).toBeLessThanOrEqual(p.innerWidth + 1);
		spark = p.sparkWidth;
	}
	expect(spark).toBeGreaterThan(0);
});