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
import { bandHeights, bandMax, type SeriesChartSeries } from "../src/tui/charts/compose";
import { PALETTE, heatRamp, resolveSeries, stripForTest, type PaletteTheme } from "../src/tui/palette";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import type { CostTimeSeriesPoint, DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { planSeries, planTimeline, renderHostChart, renderSeriesChart } from "../src/tui/charts/host-adapter";

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

// ─── Band allocation: one scale, heights that carry magnitude ─────────────────

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

test("a labelled band chart names every band and still holds the width", () => {
	const series: SeriesChartSeries[] = [
		{ label: "Succeeded", values: [12, 30, 8, 20] },
		{ label: "Failed", values: [12, 30, 8, 20] },
	];
	const width = 20;
	const rows = renderSeriesChart(series, {
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

test("the band renderer colours each series from resolveSeries", () => {
	// Asserting only that the palette returns two different tokens would pass even
	// if the renderer ignored the palette entirely. This counts what the renderer
	// actually handed to `paint`, so a dropped `resolveSeries` call fails.
	const series: SeriesChartSeries[] = [
		{ label: "Succeeded", values: [12, 30, 8, 20] },
		{ label: "Failed", values: [12, 30, 8, 20] },
	];
	const tokens = resolveSeries(2, THEME);
	expect(tokens[0]).not.toBe(tokens[1]);

	const seen: Record<string, number> = {};
	const rows = renderSeriesChart(series, {
		width: 20,
		height: 4,
		preset: "unicode",
		theme: THEME,
		paint: (color, text) => {
			seen[color] = (seen[color] ?? 0) + 1;
			return text;
		},
	});

	expect(rows.length).toBeGreaterThan(0);
	for (const token of tokens) expect(seen[token] ?? 0).toBeGreaterThan(0);
});

test("the band renderer draws nothing for no series, rather than a blank block", () => {
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

test("bands drop the remainder rather than giving it to the last series", () => {
	// 5 rows across 3 series is 1 row each with 2 spare. Handing the spare rows to
	// the final series would make its apparent magnitude a function of its
	// position in the list.
	const many: SeriesChartSeries[] = [
		{ label: "a", values: [1, 2] },
		{ label: "b", values: [2, 1] },
		{ label: "c", values: [1, 1] },
	];
	const rows = renderSeriesChart(many, {
		width: 10,
		height: 5,
		preset: "unicode",
		theme: THEME,
		paint: (_color, text) => text,
		labels: false,
	});
	// The 5 rows go to the LOUDEST bands, not to the last one: `b` peaks at 2 and
	// takes the spare row that `a` — no quieter, but listed first — did not.
	expect(rows.length).toBe(5);
	for (const row of rows) expect(cells(row)).toBe(10);
});

// ─── Composition byte-equality: the renderer IS the primitive ────────────────

test("renderSeriesChart of ONE series is exactly renderDailyBars", () => {
	const s: SeriesChartSeries = { label: "Succeeded", values: [12, 30, 8, 20, 0, 5] };
	const width = 20;
	const height = 6;
	const glyphs = glyphsFor("unicode");
	const max = bandMax([s]);

	const expected = renderDailyBars(s.values, {
		width,
		height,
		max,
		glyphs,
		accent: paint,
		dim: (text) => text,
	});

	const actual = renderSeriesChart([s], {
		width,
		height,
		preset: "unicode",
		theme: THEME,
		paint: (_color, text) => text,
		labels: false,
	});

	expect(actual).toEqual(expected);
});

test("renderSeriesChart is renderDailyBars called once per series, band by band", () => {
	const series: SeriesChartSeries[] = [
		{ label: "Succeeded", values: [12, 30, 8, 20, 0, 5] },
		{ label: "Failed", values: [2, 0, 1, 0, 3, 0] },
	];
	const width = 20;
	const height = 8;
	const glyphs = glyphsFor("unicode");
	const max = bandMax(series);
	const perBand = series.map((entry) =>
		entry.values.reduce((peak, value) => (value > peak ? value : peak), 0),
	);
	const rowsEach = bandHeights(perBand, height);

	const expected = series.flatMap((entry, index) =>
		renderDailyBars(entry.values, {
			width,
			height: rowsEach[index]!,
			max,
			glyphs,
			accent: paint,
			dim: (text) => text,
		}),
	);

	const actual = renderSeriesChart(series, {
		width,
		height,
		preset: "unicode",
		theme: THEME,
		paint: (_color, text) => text,
		labels: false,
	});

	expect(actual).toEqual(expected);
});

test("composition holds at every preset and every width", () => {
	const series: SeriesChartSeries[] = [
		{ label: "A", values: [5, 0, 15, 3] },
		{ label: "B", values: [0, 8, 2, 0] },
		{ label: "C", values: [1, 1, 1, 1] },
	];
	const max = bandMax(series);
	const perBand = series.map((entry) =>
		entry.values.reduce((peak, value) => (value > peak ? value : peak), 0),
	);

	for (const preset of PRESETS) {
		const glyphs = glyphsFor(preset);
		for (const width of WIDTHS) {
			for (const height of [4, 6, 8, 10]) {
				const rowsEach = bandHeights(perBand, height);
				const expected = series.flatMap((entry, index) =>
					renderDailyBars(entry.values, {
						width,
						height: rowsEach[index]!,
						max,
						glyphs,
						accent: paint,
						dim: (text) => text,
					}),
				);
				const actual = renderSeriesChart(series, {
					width,
					height,
					preset,
					theme: THEME,
					paint: (_color, text) => text,
					labels: false,
				});
				expect(actual).toEqual(expected);
			}
		}
	}
});

// ─── Host adapter: planTimeline, planSeries, money labels, gap policy ─────────

test("planTimeline returns a ChartSpec for valid timeline data", () => {
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "a", label: "A", values: [1, 2, 3, 4] }];
	const spec = planTimeline(axis, rows, {});
	expect(spec).toBeDefined();
	expect(spec!.kind).toBe("line");
	expect(spec!.categories.length).toBe(4);
	expect(spec!.series.length).toBe(1);
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

test("planSeries returns a non-line ChartSpec for a categorical multi-series table", () => {
	// The `barRows` path: bucketed series become rows of "Bucket N × measures",
	// so the host must NOT type the axis temporal — only `line` takes the
	// shared-axis plot, and a bar spec that came back `line` would draw points
	// instead of bands. Four buckets clear `worthCharting`'s floor.
	const spec = planSeries(
		[
			{ label: "Succeeded", values: [12, 30, 8, 20] },
			{ label: "Failed", values: [1, 3, 0, 2] },
		],
		{},
	);
	expect(spec).toBeDefined();
	expect(spec!.kind).not.toBe("line");
	expect(spec!.categories.length).toBe(4);
	expect(spec!.series.length).toBe(2);
});

test("planSeries returns undefined for no series", () => {
	expect(planSeries([], {})).toBeUndefined();
});

test("planSeries returns undefined for sub-threshold data", () => {
	// Two buckets fail `worthCharting`, so the adapter returns undefined and
	// `barRows` must supply its own honest sentence rather than a blank body.
	const spec = planSeries(
		[
			{ label: "Succeeded", values: [1, 1] },
			{ label: "Failed", values: [1, 1] },
		],
		{},
	);
	expect(spec).toBeUndefined();
});
