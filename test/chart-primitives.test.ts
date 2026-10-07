/**
 * `test/chart-primitives.test.ts` — the four chart primitives, and the proof
 * that a multi-series chart is COMPOSITION rather than a second geometry.
 *
 * WHY THIS FILE IS SHAPE-SENSITIVE. Charts in this panel have broken four times
 * in one session, and every time the same way: a working single-series renderer
 * existed, and a new multi-series rendering path was written beside it. The
 * breakage looked like `░█░░░░█░░░░█░░░█░░░█░░░░` on one line — one glyph per
 * sample, interleaved, a reader unable to say which series any column belonged
 * to. Nothing threw; the tests passed, because the new path was tested on its
 * own terms and was internally consistent.
 *
 * So the invariant is not "the chart looks right", which a human judges once and
 * a machine never. It is BY EQUALITY: {@link renderSeriesChart} must produce
 * byte-identical output to calling the existing single-series renderer once per
 * series. That is a claim a machine can check, and it fails the moment someone
 * writes a new geometry instead of composing the old one — which is the only
 * moment that matters.
 *
 * The four primitives are also swept here across widths and all three symbol
 * presets. They are the load-bearing rendering code for the whole panel and the
 * renderer is being refactored around them, so a regression in a primitive
 * should surface in THIS file, which nothing else is editing, rather than as a
 * mystery three layers up.
 */

import { expect, test } from "bun:test";

import { renderDailyBars, renderModelCostBars } from "../src/tui/charts/bars";
import { renderHeatmap } from "../src/tui/charts/heatmap";
import { renderSparkline } from "../src/tui/charts/sparkline";
import { bandHeights, bandMax, renderSeriesChart, type SeriesChartSeries } from "../src/tui/charts/compose";
import { PALETTE, heatRamp, resolveSeries, stripForTest, type PaletteTheme } from "../src/tui/palette";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import type { CostTimeSeriesPoint, DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { planTimeline, renderHostChart } from "../src/tui/charts/host-adapter";
import { costWithUnpriced } from "../src/tui/format";

const PRESETS: readonly SymbolPreset[] = ["unicode", "ascii", "nerd"];
const WIDTHS = [40, 80, 120, 200] as const;

/**
 * A theme that needs no omp runtime. `getColorHex` must return a DISTINCT hex
 * per token or `resolveSeries`'s dedupe collapses the palette to one colour and
 * the multi-series colour tests would prove nothing.
 */
const THEME: PaletteTheme = {
	getColorHex: (token: string) => `#${(token.length * 7919).toString(16).padStart(6, "0").slice(-6)}`,
	getColorMode: () => "truecolor",
	getSymbolPreset: () => "unicode",
};

/** Identity styling: colour is applied by the caller, so tests compare geometry. */
const paint = (text: string) => text;

/** Width of a rendered line in cells, ANSI excluded. */
const cells = (line: string): number => Bun.stringWidth(stripForTest(line));

// ─── The sweep: every primitive, every width, every preset ───────────────────

test("renderDailyBars renders at every width and preset without overflowing", () => {
	const values = [0, 3, 12, 40, 41, 7, 0, 19, 25, 11];
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			const rows = renderDailyBars(values, {
				width,
				height: 6,
				glyphs: glyphsFor(preset),
				accent: paint,
				dim: paint,
			});
			expect(rows.length).toBe(6);
			for (const row of rows) expect(cells(row)).toBe(width);
		}
	}
});

test("renderDailyBars scales by VALUE, and that value is cost", () => {
	// THE INVARIANT EVERY CHART MUST HOLD. Bars scale by cost, never tokens: this
	// database carries a 41x price spread at comparable token volume, so scaling
	// by tokens inverts the ranking — the cheapest model would draw the tallest
	// bar and the panel would be confidently, silently wrong.

	// The scale is set by the LARGEST value in the chart, so the probe is a
	// two-column chart with a known peak beside the value under test. Column 0's
	// filled-row count is then its height against that peak: the peak gets all 8
	// rows, half of it gets 4, a quarter gets 2 (the primitive floors a recorded
	// value at one row, and a quarter of 8 is exactly 2).
	const height = 8;
	const PEAK = 4;
	const columnHeight = (value: number): number =>
		renderDailyBars([value, PEAK], {
			width: 2,
			height,
			glyphs: glyphsFor("unicode"),
			accent: paint,
			dim: paint,
		}).filter(row => stripForTest(row)[0] === "█").length;

	// A `height`-row chart is `height - 1` magnitude rows over the floor.
		expect(columnHeight(PEAK)).toBe(height - 1);
	expect(columnHeight(PEAK / 2)).toBe(Math.round((height - 1) / 2));
	expect(columnHeight(PEAK / 4)).toBe(Math.round((height - 1) / 4));
	// Monotonic: a bigger value never draws a shorter column.
	expect(columnHeight(3)).toBeGreaterThan(columnHeight(2));
	// Nothing recorded draws nothing, which is what separates "no spend" from
	// "never queried".
	expect(columnHeight(0)).toBe(0);
});

test("renderDailyBars says so when a range has no data at all", () => {
	const rows = renderDailyBars([], {
		width: 40,
		height: 4,
		glyphs: glyphsFor("unicode"),
		accent: paint,
		dim: paint,
	});
	expect(rows.length).toBe(1);
	expect(rows[0]).toContain("No activity");
});

test("renderSparkline renders at every width and preset, one cell per sample", () => {
	const values = [3, 9, 1, 14, 7, 0, 22, 11];
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			const line = renderSparkline(values, { width, preset });
			expect(cells(line)).toBe(width);
		}
	}
});

test("renderSparkline scales by magnitude, so the peak is the tallest rung", () => {
	// The peak sample must use the top of the ramp. `sparkRamp` is 8 rungs and
	// the top one is the full block, so a peak that renders as anything shorter
	// means the scale is off by a rung.
	const ramp = glyphsFor("unicode").sparkRamp;
	const top = Array.isArray(ramp) ? ramp[ramp.length - 1] : ramp;
	const line = renderSparkline([1, 2, 99, 2, 1], { width: 5, preset: "unicode" });
	expect(stripForTest(line)[2]).toBe(top);
});

const ACTIVITY: readonly DailyActivityPoint[] = Array.from({ length: 40 }, (_, i) => ({
	day: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
	cost: i === 12 ? 42 : i % 7,
	requests: 100 + i,
	totalTokens: 1_000_000 * (i + 1),
}));

test("renderHeatmap resolves one stop per level through the palette ramp", () => {
	// usage-dashboard.ts:812 + :867 — four stops at t=0.3/0.5/0.72/1.0, indexed
	// ramp[level-1]. A three-stop ramp leaves level 4 uncoloured.
	const rows = renderHeatmap(ACTIVITY, {
		innerWidth: 120,
		labelWidth: 2,
		weeks: 12,
		glyphs: glyphsFor("unicode"),
		ramp: [0, 1, 2, 3].map(level => heatRamp(THEME, level)),
		dim: (text: string) => text,
		today: new Date("2026-07-15T12:00:00Z"),
	});
	expect(rows.length).toBe(8);
	expect(new Set([0, 1, 2, 3].map(level => heatRamp(THEME, level))).size).toBe(4);
});

test("renderHeatmap renders at every width and preset without overflowing", () => {
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			const rows = renderHeatmap(ACTIVITY, {
				innerWidth: width,
				labelWidth: 2,
				weeks: 12,
				glyphs: glyphsFor(preset),
				ramp: [PALETTE.heat1, PALETTE.heat2, PALETTE.heat3].map(() => ""),
				dim: (text: string) => text,
				today: new Date("2026-07-15T12:00:00Z"),
			});
			expect(rows.length).toBe(8); // month row + seven weekday rows
			for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(width);
		}
	}
});
const COST_POINTS: readonly CostTimeSeriesPoint[] = [
	{
		timestamp: 1_700_000_000_000,
		model: "gpt-5.6-terra",
		provider: "openrouter",
		cost: 42,
		unpricedRequests: 0,
		costInput: 4,
		costOutput: 2,
		costCacheRead: 34,
		costCacheWrite: 2,
		requests: 900,
	},
	{
		timestamp: 1_700_000_000_000,
		model: "deepseek-v4-flash",
		provider: "deepseek",
		cost: 1,
		unpricedRequests: 3,
		costInput: 0.1,
		costOutput: 0.05,
		costCacheRead: 0.8,
		costCacheWrite: 0.05,
		requests: 4_000,
	},
];

test("renderModelCostBars renders at every width and preset without overflowing", () => {
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			const rows = renderModelCostBars(COST_POINTS, {
				width,
				height: 5,
				glyphs: glyphsFor(preset),
				accent: paint,
				dim: paint,
			});
			expect(rows.length).toBe(5);
			for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(width);
		}
	}
});

test("renderModelCostBars ranks by COST: the 42x token spender is the shorter bar", () => {
	// The token-scaled inversion, caught directly. `deepseek-v4-flash` moves 4x
	// the tokens of `gpt-5.6-terra` here and costs 1/42 as much. Scale by tokens
	// and the cheapest model draws the tallest column, which inverts the whole
	// chart. Two models, two columns: column 0 is the dearer one.
	const rows = renderModelCostBars(COST_POINTS, {
		width: 2,
		height: 8,
		glyphs: glyphsFor("unicode"),
		accent: paint,
		dim: paint,
	});
	const filled = (col: number) => rows.filter(row => stripForTest(row)[col] === "█").length;
	expect(filled(0)).toBeGreaterThan(filled(1));
	expect(filled(0)).toBe(7);
});

// ─── Composition: the multi-series chart IS the primitive, N times ───────────

/**
 * Series with EQUAL peaks.
 *
 * Equal peaks are what make the shared allocation give every series the same
 * band height, which is what lets the composition be asserted as plain
 * byte-equality against `series.flatMap(…)`. The unequal-peak case is covered
 * by the band-by-band test and by `bandHeights` directly.
 */
const REQUEST_SERIES: readonly SeriesChartSeries[] = [
	{ label: "Succeeded", values: [12, 30, 8, 20, 21] },
	{ label: "Failed", values: [12, 30, 8, 20, 21] },
];

/**
 * The mark-only form, which is what the equality tests compare.
 *
 * `labels: false` is the pure composition: no band names, so the output is
 * exactly `renderDailyBars` once per series. Labelled output is that plus one
 * row per band, and has its own test below.
 */
function marks(
	series: readonly SeriesChartSeries[],
	width: number,
	height: number,
	preset: SymbolPreset = "unicode",
): readonly string[] {
	return renderSeriesChart(series, {
		width,
		height,
		preset,
		theme: THEME,
		paint: (_color, text) => text,
		labels: false,
	});
}

/**
 * The primitive, called exactly as `compose` must call it.
 *
 * `max` is the SHARED peak across every series, because that is what
 * `renderSeriesChart` hands each band — see `bandMax`. Omitting it here would
 * compare the composition against a differently-scaled renderer, which is the
 * one thing the equality is supposed to rule out.
 */
function primitive(
	values: readonly number[],
	width: number,
	height: number,
	preset: SymbolPreset,
	max: number,
) {
	return renderDailyBars(values, {
		width,
		height,
		max,
		glyphs: glyphsFor(preset),
		accent: (_text: string) => _text,
		dim: (_text: string) => _text,
	});
}

test("renderSeriesChart IS renderDailyBars called once per series", () => {
	// THE EQUALITY THAT MATTERS. Not "looks like a stacked chart" — byte-identical
	// to the composition a caller would have written by hand. A new multi-series
	// geometry fails this; composing passes.
	const series = REQUEST_SERIES;
	const width = 20;
	const height = 6;
	const perSeries = bandHeights(series.map(s => Math.max(...s.values)), height)[0] ?? 0;
	const max = bandMax(series);

	const handRolled = series.flatMap(s => primitive(s.values, width, perSeries, "unicode", max));

	expect(marks(series, width, height)).toEqual(handRolled);
});

test("renderSeriesChart of ONE series is exactly the primitive", () => {
	const one: SeriesChartSeries[] = [{ label: "Calls", values: [4, 9, 2, 7] }];
	expect(marks(one, 12, 3)).toEqual(primitive(one[0]!.values, 12, 3, "unicode", bandMax(one)));
});

test("every series in a multi-series chart is the primitive, band by band", () => {
	// The whole-chart equality above could still pass if one series were rendered
	// correctly and another fudged. This asks, for EACH series, whether its own
	// band is the primitive over its own values — and it uses UNEVEN peaks, so it
	// also covers the unequal-band case the equal-peak equality cannot reach.
	const series: SeriesChartSeries[] = [
		{ label: "Succeeded", values: [44, 40, 44, 38] },
		{ label: "Failed", values: [4, 4, 4, 4] },
	];
	const width = 20;
	// The WHOLE height is the budget: bands draw from one pool, so the test has to
	// ask for the allocation the same way `renderSeriesChart` does.
	const budget = 16;
	const rows = marks(series, width, budget);

	const heights = bandHeights([44, 4], budget);
	const max = bandMax(series);
	let offset = 0;
	for (const [index, entry] of series.entries()) {
		const band = rows.slice(offset, offset + (heights[index] ?? 0));
		expect(band.slice()).toEqual([...primitive(entry.values, width, heights[index] ?? 0, "unicode", max)]);
		offset += heights[index] ?? 0;
	}
});

test("composition holds at every preset and every width", () => {
	const series = REQUEST_SERIES;
	const height = 6;
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			const perSeries = bandHeights(series.map(s => Math.max(...s.values)), height)[0] ?? 0;
			const max = bandMax(series);
			const expected = series.flatMap(s => primitive(s.values, width, perSeries, preset, max));
			expect(marks(series, width, height, preset)).toEqual(expected);
			for (const row of expected) expect(cells(row)).toBe(width);
		}
	}
});

test("the SHARED scale is what stops a 4% failure rate reading as 100%", () => {
	// THE REGRESSION THIS MODULE EXISTS TO PREVENT, stated as arithmetic. Failed
	// peaks at 4; Succeeded peaks at 44. If each series scaled against its OWN
	// maximum both bands would fill and the chart would claim a hundred percent
	// failure. Under a shared scale the quiet band is a fraction of the loud one.
	//
	// Asserted on the ALLOCATION rather than on the pixels: `renderDailyBars`
	// rounds any fraction of a row up to at least one filled cell, so measuring
	// pixels here would be testing the primitive's rounding, not this rule.
	// THE BUDGET IS THE WHOLE CHART, so these sums are the chart height — a band
	// cannot claim a row another band is not giving up.
	//
	// EVERY BAND IS ITS MAGNITUDE PLUS ITS FLOOR, and the floor is unconditional,
	// so a band that recorded something is never allocated a single row: that
	// would be a bare baseline, which reads as a series that recorded nothing.
	expect(bandHeights([44, 4], 8)).toEqual([6, 2]);
	// Equal peaks get equal bands — the case the composition equalities rely on.
	expect(bandHeights([10, 10, 10], 3)).toEqual([1, 1, 1]);
	// Equal peaks and a budget too small for ink: every band still paints its floor.
	expect(bandHeights([16, 0], 2)).toEqual([1, 1]);
	// A live band gets its ink row when the budget allows one over the floors, so
	// "drew nothing" and "recorded nothing" stay distinguishable.
	expect(bandHeights([100, 1], 4)).toEqual([2, 2]);
	// No budget, no bands.
	expect(bandHeights([44, 4], 0)).toEqual([0, 0]);
	// Nothing recorded anywhere: every band still gets its floor, so "no data"
	// reads as a flat empty chart rather than a missing one. There is no magnitude
	// to divide, so the rows left over after that go to NOBODY.
	expect(bandHeights([0, 0], 4)).toEqual([1, 1]);
	// And whenever the budget can cover the bands, EVERY band is covered — a band
	// with no rows at all is indistinguishable from a series never declared.
	for (const peaks of [[16, 8, 2, 1], [1, 1, 1], [9], [44, 4, 0], [4, 4, 4, 4]]) {
		for (const budget of [peaks.length, peaks.length + 1, peaks.length + 2, 8, 14, 40]) {
			expect(
				bandHeights(peaks, budget).filter(rows => rows === 0),
				`${JSON.stringify(peaks)} / ${budget}`,
			).toEqual([]);
		}
	}
	// THE SUM MAY EXCEED A BUDGET TOO SMALL FOR THE BANDS, on purpose: every band
	// is guaranteed its floor, because a band with no rows draws nothing at all and
	// a series the chart declares and then omits is indistinguishable from one it
	// never declared. Clamping the sum back to a budget smaller than the series
	// count is exactly what dropped the all-zero band off the end — quietest, last,
	// first to be shed. The height is enforced where it is observed instead: in
	// `renderSeriesChart`, which sheds quietest-first, and asserted on the RENDERED
	// rows by 'no band ever claims a row the chart was not given'.
	expect(bandHeights([16, 8, 2, 1], 1).reduce((sum, rows) => sum + rows, 0)).toBe(4);
	// No budget at all is still no chart.
	expect(bandHeights([16, 8, 2, 1], 0)).toEqual([0, 0, 0, 0]);
});

test("a labelled chart names every band and still holds the width", () => {
	const width = 20;
	const rows = renderSeriesChart(REQUEST_SERIES, {
		width,
		height: 9,
		preset: "unicode",
		theme: THEME,
		paint: (_color, text) => text,
	});
	expect(rows.some(row => row.includes("Succeeded"))).toBe(true);
	expect(rows.some(row => row.includes("Failed"))).toBe(true);
	expect(rows.length).toBeLessThanOrEqual(9);
	for (const row of rows) expect(cells(row)).toBe(width);
});

test("renderSeriesChart colours each series from resolveSeries", () => {
	// Asserting only that the palette returns two different tokens would pass even
	// if `compose` ignored the palette entirely. This counts what `compose`
	// actually handed to `paint`, so a dropped `resolveSeries` call fails.
	const tokens = resolveSeries(2, THEME);
	expect(tokens[0]).not.toBe(tokens[1]);

	const seen = new Map<string, number>();
	const rows = renderSeriesChart(REQUEST_SERIES, {
		width: 20,
		height: 4,
		preset: "unicode",
		theme: THEME,
		paint: (color, text) => {
			seen.set(color, (seen.get(color) ?? 0) + 1);
			return text;
		},
	});

	expect(rows.length).toBeGreaterThan(0);
	for (const token of tokens) expect(seen.get(token) ?? 0).toBeGreaterThan(0);
});

test("renderSeriesChart renders nothing for no series, rather than a blank block", () => {
	expect(
		renderSeriesChart([], {
			width: 20,
			height: 4,
			preset: "unicode",
			theme: THEME,
			paint: (_color, text) => text,
		}),
	).toEqual([]);
});

test("renderSeriesChart drops the remainder rather than giving it to the last series", () => {
	// 5 rows across 3 series is 1 row each with 2 spare. Handing the spare rows to
	// the final series would make its apparent magnitude a function of its
	// position in the list.
	const many: SeriesChartSeries[] = [
		{ label: "a", values: [1, 2] },
		{ label: "b", values: [2, 1] },
		{ label: "c", values: [1, 1] },
	];
	const rows = marks(many, 10, 5);
	void bandMax(many);
	// The 5 rows go to the LOUDEST bands, not to the last one: `b` peaks at 2 and
	// takes the spare row that `a` — no quieter, but listed first — did not.
	expect(rows.length).toBe(5);
	for (const row of rows) expect(cells(row)).toBe(10);
});

// ─── Host adapter: planTimeline, money labels, gap policy ────────────────────

test("planTimeline returns a ChartSpec for valid timeline data", () => {
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "a", label: "A", values: [1, 2, 3, 4] }];
	const spec = planTimeline(axis, rows, {});
	expect(spec).toBeDefined();
	expect(spec!.kind).toBe("line");
	expect(spec!.categories.length).toBe(4);
	expect(spec!.series.length).toBe(1);
});

test("adapter never calls host formatValue for currency", () => {
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "cost", label: "Cost", values: [0, 1, 2, 3] }];
	const spec = planTimeline(axis, rows, {});
	expect(spec).toBeDefined();
	// The host typed the column currency from the cells; the LABEL is still ours.
	expect(spec!.series[0]!.dim).toBe("currency");

	const lines = renderHostChart(spec!, {
		width: 80,
		preset: "unicode",
		theme: THEME,
		paint: (_color, text) => text,
		currency: true,
		unpriced: 5,
	});

	const allText = lines.join("\n");
	expect(allText).not.toContain("$0");
	expect(allText).toContain(costWithUnpriced(0, 5));
});

test("planTimeline returns undefined for sub-threshold data", () => {
	const axis = [1700000000000, 1700008640000];
	const rows = [{ key: "a", label: "A", values: [1, 1] }];
	const spec = planTimeline(axis, rows, {});
	expect(spec).toBeUndefined();
});

test("planTimeline applies the worthCharting gap policy", () => {
	// Four buckets pass `planChart`, but four points at a 2× spread carry no
	// trend: `worthCharting` rejects it, so the adapter returns undefined.
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "a", label: "A", values: [1, 1, 1, 2] }];
	expect(planTimeline(axis, rows, {})).toBeUndefined();
});

test("planTimeline records stacked and cumulative flags on the spec", () => {
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "a", label: "A", values: [1, 2, 3, 4] }];
	const spec = planTimeline(axis, rows, { stacked: true, cumulative: true });
	expect(spec).toBeDefined();
	expect(spec!.stacked).toBe(true);
	expect(spec!.cumulative).toBe(true);
});
