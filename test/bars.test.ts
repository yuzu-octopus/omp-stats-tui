import { expect, test } from "bun:test";
import { densify, pivotSeries } from "@oh-my-pi/omp-stats/client/data/series";
import { bucketAxis } from "@oh-my-pi/omp-stats/client/data/range";
import { buildCostSummary } from "@oh-my-pi/omp-stats/client/data/view-models";
import type { CostTimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";
import {
	costsForBuckets,
	renderDailyBars,
	renderModelCostBars,
} from "../src/tui/charts/bars";
import { glyph, glyphsFor } from "../src/tui/glyphs";

const identity = (t: string) => t;
const opts = (width: number, height = 8, preset: "unicode" | "nerd" | "ascii" = "unicode") => ({
	width,
	height,
	glyphs: glyphsFor(preset),
	accent: identity,
	dim: identity,
});

const fill = glyphsFor("unicode").barFill as string;
const axis = glyph("unicode", "axisLine");

/**
 * Column heights recovered from the rendered rows, so tests assert on output
 * rather than on an internal number.
 *
 * Rows come top to bottom, so only the TOPMOST filled cell marks the top of a
 * bar; its distance from the baseline (the last row) is the bar's height.
 */
function columnHeights(rows: readonly string[], width: number): number[] {
	// Filled CELLS per column, counted directly. The old form inferred a height
	// from a distance to the last row, which silently counted the chart floor as
	// a row of magnitude the moment the floor existed.
	const heights = new Array<number>(width).fill(0);
	for (const row of rows) {
		[...row].forEach((ch, col) => {
			if (ch === fill && col < width) heights[col] = (heights[col] ?? 0) + 1;
		});
	}
	return heights;
}

const DAY = 86_400_000;

function costPoint(day: number, model: string, cost: number, unpriced = 0): CostTimeSeriesPoint {
	return {
		timestamp: day * DAY,
		model,
		provider: "openai",
		cost,
		unpricedRequests: unpriced,
		costInput: cost,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
	} as CostTimeSeriesPoint;
}

/** Same shape, named for tests that do not care about the provider detail. */
const point = costPoint;

// ─── Host agreement: the tests that stop our wrappers drifting ───────────────

test("costsForBuckets is the host's densify, not a reimplementation", () => {
	// `densify` SUMS points into their bucket and drops points that fall off the
	// axis. We wrap it rather than writing the loop again, and this test is what
	// notices if the wrapper ever starts doing its own thing.
	const points = [
		{ timestamp: 0, cost: 1 },
		{ timestamp: 0, cost: 2 },
		{ timestamp: DAY, cost: 4 },
		{ timestamp: 999 * DAY, cost: 1000 }, // off-axis: must be dropped
	];
	const buckets = [0, DAY];

	expect(costsForBuckets(points, buckets)).toEqual([3, 4]);
	expect(costsForBuckets(points, buckets)).toEqual(densify(points, buckets, (p) => p.cost));
	expect(costsForBuckets([], buckets)).toEqual([0, 0]);
	expect(costsForBuckets(points, [])).toEqual([]);
});

test("no cost is silently dropped when the axis is the host's own", () => {
	// `densify` drops off-axis points BY DESIGN and silently: no error, no empty
	// chart, just a shorter bill. The only defence is that the axis we hand it
	// is the SAME axis the data was bucketed on, so this asserts the CONSERVATION
	// property directly — everything inside the window survives the round trip.
	//
	// The failure this catches is the plausible one: an axis built by hand (a
	// `for` loop over `columns`, an hourly `rangeMeta` bucket under day-aligned
	// rows) which still renders a chart, just an empty or partial one.
	const now = 200 * DAY;
	const points = Array.from({ length: 20 }, (_, i) => ({
		timestamp: (180 + i) * DAY, // all on exact day boundaries
		cost: i + 1,
	}));

	for (const range of ["1h", "24h", "7d", "30d", "90d", "all"] as const) {
		// `bucketAxis` is the host's, with the DAY width the costs route uses.
		const axis = bucketAxis(range, points.map(p => p.timestamp), DAY, now);
		const onAxis = new Set(axis);
		const inWindow = points.filter(p => onAxis.has(p.timestamp));

		const values = costsForBuckets(points, axis);

		// One cell per bucket, always.
		expect(values.length, range).toBe(axis.length);

		// CONSERVATION: the rendered total equals the total of everything the
		// axis covers. Nothing was dropped in silence.
		const rendered = values.reduce((sum, v) => sum + v, 0);
		const expected = inWindow.reduce((sum, p) => sum + p.cost, 0);
		expect(rendered, `${range}: densify lost cost between the payload and the chart`).toBe(expected);

		// And the window really does contain data for the ranges that should —
		// otherwise the conservation check would pass trivially on an empty set.
		if (range !== "1h") {
			expect(inWindow.length, `${range}: nothing landed on the axis at all`).toBeGreaterThan(0);
		}
	}
});

test("a HAND-ROLLED axis on the same points loses data that the host's axis keeps", () => {
	// The counterfactual, so the test above is not vacuous: this is the axis the
	// panel could plausibly build instead, and it demonstrably drops points. If
	// this ever stops dropping, the conservation test is no longer proving much.
	const now = 200 * DAY;
	const points = Array.from({ length: 20 }, (_, i) => ({ timestamp: (180 + i) * DAY, cost: i + 1 }));

	const handRolled = Array.from({ length: 7 }, (_, i) => (now / DAY - 6 + i) * DAY + 1); // +1ms off
	const hostAxis = bucketAxis("7d", points.map(p => p.timestamp), DAY, now);

	const handRolledTotal = costsForBuckets(points, handRolled).reduce((s, v) => s + v, 0);
	const hostTotal = costsForBuckets(points, hostAxis).reduce((s, v) => s + v, 0);

	expect(handRolledTotal).toBeLessThan(hostTotal);
	expect(hostTotal).toBeGreaterThan(0);
});

test("renderModelCostBars ranks with the host's pivotSeries, Other tail included", () => {
	// pivotSeries owns the ranking policy: rank by total, keep the top `limit`,
	// fold the rest into a trailing "Other (n)". Reproducing that comparator
	// ourselves is exactly the duplication F15 was written to stop.
	const series = pivotSeries(
		[
			{ timestamp: 0, model: "a", provider: "p", cost: 1 },
			{ timestamp: 0, model: "b", provider: "p", cost: 5 },
			{ timestamp: DAY, model: "c", provider: "p", cost: 3 },
		],
		{
			buckets: [0, DAY],
			key: (p) => `${p.model}::${p.provider}`,
			value: (p) => p.cost,
			limit: 1,
		},
	);
	expect(series.map((s) => s.key)).toEqual(["b::p", "__other__"]);
	expect(series.at(-1)?.label).toBe("Other (2)");

	// Our wrapper must agree with that ranking on the same input.
	const rows = renderModelCostBars(
		[point(0, "a", 1), point(0, "b", 5), point(1, "c", 3)],
		opts(2, 4),
	);
	expect(rows.length).toBeGreaterThan(0);
	// Ranked first is `b` at $5, so its column must fill every row of magnitude.
	// A four-row chart is three magnitude rows over the floor.
	expect(columnHeights(rows, 2)[0]).toBe(3);
});

test("renderModelCostBars derives its totals with the host's buildCostSummary", () => {
	const points = [costPoint(0, "gpt-5.6-terra", 935.72), costPoint(1, "deepseek-v4-flash", 22.85, 34_870)];

	const summary = buildCostSummary(points);
	expect(summary.totalCost).toBeCloseTo(958.57, 5);
	expect(summary.unpricedRequests).toBe(34_870);
	expect(summary.models[0]?.model).toBe("gpt-5.6-terra");

	const rows = renderModelCostBars(points, opts(2, 4));
	// The costlier model keeps the tall bar even though its bucket is one day.
	// The cheaper one gets the one-row floor, never an empty column.
	expect(columnHeights(rows, 2)).toEqual([3, 1]);
});

// ─── The chart itself ─────────────────────────────────────────────────────────

test("an empty series renders an honest empty state, not a wall of zero bars", () => {
	// At a width that fits the message.
	expect(renderDailyBars([], opts(40))).toEqual(["No activity recorded in this range."]);
	// And truncated, never overflowing, when the panel is narrower than the
	// message — the empty state obeys the width rule like every other line.
	// The shared clamp truncates with an ellipsis (19 cells + …), where the
	// old local clamp cut silently. Same 20 cells, one policy everywhere.
	const narrow = renderDailyBars([], opts(20))[0] ?? "";
	expect(narrow).toBe("No activity recorde…");
	expect(Bun.stringWidth(narrow)).toBe(20);
});

test("a zero-cost day and a high-cost day render visibly differently", () => {
	// Asserted on the rendered LINES, not on an internal number: a bar of the
	// wrong height is a rendering bug no value-level assertion would catch.
	const quiet = renderDailyBars([0, 0, 0], opts(3, 4));
	const busy = renderDailyBars([0, 0, 900], opts(3, 4));
	expect(quiet.join("\n")).not.toBe(busy.join("\n"));
	expect(quiet.join("")).not.toContain(fill);
	expect(busy.join("")).toContain(fill);
});

test("an all-zero series is a real chart whose floor is the only ink", () => {
	// Not an error and not a missing chart: the buckets exist and every one
	// measured zero. The floor is drawn and NOTHING rises off it, which is how
	// this state stays distinct from the empty-state sentence a range with no
	// buckets at all gets.
	const rows = renderDailyBars([0, 0, 0], opts(3, 4));
	expect(rows.length).toBe(4);
	expect(rows.join("")).not.toContain(fill);
	expect(rows[3]).toBe(axis.repeat(3));
});

test("a missing day renders as a gap, never as a short bar", () => {
	// The distinction that matters: an absent bucket is "not yet built" (ADR
	// 0003), a zero bucket is "nothing happened", and a small cost is "cheap".
	// The first two are now the same blank column — correctly, because the web
	// draws nothing for either (`Chart.tsx:229`) — and both are unmistakably not
	// a small spend, because a real cost always rises off the floor at all.
	const missing = renderDailyBars([0, 0, 0], opts(3, 4));
	const cheap = renderDailyBars([0, 0, 1], opts(3, 4));
	expect(missing.join("")).not.toContain(fill);
	expect(cheap.join("")).toContain(fill);
	expect(cheap.join("\n")).not.toBe(missing.join("\n"));

	// And within ONE chart, a cheap day and an expensive day are distinguishable.
	// Four rows is three rows of magnitude over the floor.
	expect(columnHeights(renderDailyBars([1, 500], opts(2, 4)), 2)).toEqual([1, 3]);
});

test("no rendered row ends in a newline, and no row is empty", () => {
	for (const row of renderDailyBars([1, 2, 3], opts(10, 5))) {
		expect(row.includes("\n")).toBe(false);
		expect(row.length).toBeGreaterThan(0);
	}
});

test("every rendered row is exactly the requested width, across a sweep", () => {
	// Swept 20..200 inclusive rather than a handful of widths: an overflow usually
	// appears only at some widths, and it corrupts the whole overlay.
	for (let width = 20; width <= 200; width++) {
		const values = Array.from({ length: 40 }, (_, i) => (i * 37) % 91);
		for (const row of renderDailyBars(values, opts(width))) {
			expect(Bun.stringWidth(row), `width ${width}: ${row}`).toBe(width);
		}
	}
});

test("no row ever exceeds the width, even for degenerate heights", () => {
	for (const height of [1, 2, 3, 24, 40]) {
		for (const values of [[], [0], [5], [1, 2, 3, 4, 5]]) {
			for (const row of renderDailyBars(values, opts(20, height))) {
				expect(Bun.stringWidth(row)).toBeLessThanOrEqual(20);
			}
		}
	}
});

test("the chart is height rows tall, top to bottom", () => {
	expect(renderDailyBars([1, 2, 3], opts(3, 6)).length).toBe(6);
});

test("the tallest bar reaches the top row, and the floor is a row of its own", () => {
	const rows = renderDailyBars([0, 5, 10], opts(3, 4));
	expect(columnHeights(rows, 3)).toEqual([0, 2, 3]);
	// The maximum column, and only the maximum column, touches the top row. The
	// unfilled cells are BLANK, not shade: the web draws nothing there.
	expect(rows[0]).toBe(`  ${fill}`);
	// Every column stands on the same floor, which is the web's
	// `.chart-baseline` at `y(0)` (`Chart.tsx:304`) marked rather than drawn.
	expect(rows[3]).toBe(axis.repeat(3));
});

test("equal costs get equal heights — the chart does not invent differences", () => {
	expect(columnHeights(renderDailyBars([7, 7, 7], opts(3, 4)), 3)).toEqual([3, 3, 3]);
});

test("bars scale on COST, never on token count", () => {
	// The two models from this database: the busy one reads MORE cache tokens
	// (4.04B vs 2.39B) but costs 41x less. A token-scaled chart would draw the
	// cheap one tallest — confidently, silently wrong.
	const byCost = costsForBuckets(
		[
			{ timestamp: 0, cost: 22.85 },
			{ timestamp: DAY, cost: 935.72 },
		],
		[0, DAY],
	);
	// 22.85 / 935.72 rounds to zero rows, so it gets the one-row floor — a real
	// cost must never render as an empty column, or a cheap day would be
	// indistinguishable from an hour whose rollup was never built.
	expect(columnHeights(renderDailyBars(byCost, opts(2, 4)), 2)).toEqual([1, 3]);

	// Token volume for those same two buckets runs the OPPOSITE way: the bucket
	// with FEWER tokens is the one that must be the taller bar.
	const byTokens = [4_040_000_000, 2_390_000_000];
	expect(byTokens[0]).toBeGreaterThan(byTokens[1] as number);
	expect(columnHeights(renderDailyBars(byCost, opts(2, 4)), 2)[1]).toBeGreaterThan(
		columnHeights(renderDailyBars(byCost, opts(2, 4)), 2)[0] as number,
	);
});

test("the chart never uses the 8-level ramp: magnitude lives in row count", () => {
	// If magnitude were compressed into sparkRamp levels, two bars differing by
	// one row would be indistinguishable and the height axis would be useless.
	// The only marks a column chart may emit are its fill, its blanks and one
	// floor row — nothing else, on any preset.
	for (const row of renderDailyBars([10, 5, 7, 2, 9, 3, 8, 1], opts(8, 8))) {
		for (const ch of [...row]) expect(ch === fill || ch === " " || ch === axis).toBe(true);
	}
});

test("the same data renders differently under unicode and ascii", () => {
	const values = [3, 1, 4, 1, 5];
	const u = renderDailyBars(values, opts(12, 4, "unicode")).join("");
	const a = renderDailyBars(values, opts(12, 4, "ascii")).join("");
	expect(u).not.toBe(a);
	expect(a).not.toContain(fill);
	expect(a).toContain(glyphsFor("ascii").barFill as string);
});

test("nerd is byte-identical to unicode, because block elements are not Nerd-specific", () => {
	// Verified rather than assumed: the claim is that no Nerd Font codepoint's
	// semantics is magnitude, so the two presets must agree exactly.
	const values = [3, 1, 4, 1, 5, 9, 2, 6];
	expect(renderDailyBars(values, opts(12, 4, "nerd"))).toEqual(renderDailyBars(values, opts(12, 4, "unicode")));
});

test("the ascii ladder renders the same geometry as unicode", () => {
	const values = [3, 1, 4, 1, 5];
	const u = renderDailyBars(values, opts(12, 4, "unicode"));
	const a = renderDailyBars(values, opts(12, 4, "ascii"));
	expect(u.length).toBe(a.length);
	for (let i = 0; i < u.length; i++) expect(Bun.stringWidth(a[i]!)).toBe(12);
});

test("colours arrive as callbacks, so the render is headless and style-agnostic", () => {
	const seen = { accent: 0, dim: 0 };
	renderDailyBars([0, 5], {
		...opts(2, 2),
		accent: (t) => {
			seen.accent++;
			return t;
		},
		dim: (t) => {
			seen.dim++;
			return t;
		},
	});
	expect(seen.accent).toBeGreaterThan(0);
	expect(seen.dim).toBeGreaterThan(0);
});
