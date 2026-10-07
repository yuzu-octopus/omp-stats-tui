/**
 * The vertical daily bar chart.
 *
 * A pure render function: data in, lines out. No theme singleton, no database,
 * no I/O. Colours arrive as two callbacks, which is what makes every rule in
 * here testable without a terminal.
 *
 * ── Where the logic comes from ───────────────────────────────────────────────
 * This is a PORT of the stats dashboard's chart layer, not a new design. The
 * row derivation is deliberately NOT reimplemented:
 *
 *  - `densify` (client/data/series) buckets and sums — the plan originally
 *    proposed a hand-written `bucketToWidth` here, which was a second
 *    implementation of a solved problem.
 *  - `pivotSeries` (same module) owns the top-N + "Other (n)" ranking policy.
 *  - `buildCostSummary` (client/data/view-models) owns per-model cost totals
 *    and the cost-first ranking comparator.
 *
 * ⚠ Import ONLY from `@oh-me-pi/omp-stats/client/data/*`. Two measured reasons,
 * and the second is the one that bites first:
 *
 *  1. `client/data/` is plain TypeScript with no `react` import anywhere, so
 *     nothing React-shaped enters a terminal process. (React *is* installed —
 *     it arrives transitively — so this is a discipline rule, not an accident
 *     of resolution.)
 *  2. `client/charts/*` is `.tsx` and CANNOT be imported at all: the package's
 *     exports map declares `"./client/*": "./src/client/*.ts"`, and a `.tsx`
 *     file does not resolve through it. Measured — every attempt fails with
 *     `Cannot find package '@oh-me-pi/omp-stats'`, which reads like a missing
 *     dependency and is not one.
 *
 * So if you want a chart's behaviour, port its arithmetic (as `niceScale`
 * would be) or take it from `client/data`. Reaching for the component is not
 * an option and never will be. See F15.
 *
 * The imports are STATIC because the extension loader's resolve hook only
 * rewrites static specifiers; a dynamic `import()` of any `@oh-me-pi/*` fails
 * there (F9).
 */

import { densify, pivotSeries } from "@oh-my-pi/omp-stats/client/data/series";
import { buildCostSummary } from "@oh-my-pi/omp-stats/client/data/view-models";
import type { CostTimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { GlyphSet, GlyphValue } from "../glyphs";

export interface BarsOptions {
	/** Columns available to the chart. No rendered row may exceed it. */
	width: number;
	/**
	 * Rows the WHOLE plot occupies, floor included — see {@link compose}.
	 *
	 * This is the magnitude axis: one filled row is one step of the shared
	 * scale every column in the chart is measured against.
	 */
	height: number;
	glyphs: GlyphSet;
	/**
	 * The scale maximum, when the caller has one.
	 *
	 * Omit it and the series' own peak is the maximum, which is right for a
	 * single-series chart: its tallest column fills the plot, which is what tells
	 * the reader the range.
	 *
	 * A MULTI-series chart must supply the maximum across ALL its series, and
	 * that is the whole reason this option exists. It used to be absent, so every
	 * band silently re-scaled against its own peak and a 4%-failure band drew
	 * exactly the same shape as the 100%-success band beside it — the quiet lie
	 * the web's single y-axis (`Chart.tsx:83-98`) exists to prevent, reproduced in
	 * a different shape. The band renderer in `host-adapter.ts` passes the shared
	 * maximum; see `bandMax`.
	 */
	max?: number;
	/** Data ink. Reaches the FILLED cells of a column and nothing else. */
	accent: (text: string) => string;
	/**
	 * Chrome ink. Reaches the floor mark and the empty state, and nothing else —
	 * the web draws both at ink-3 (`--chart-grid`, `.chart-empty`), never in a
	 * series colour.
	 */
	dim: (text: string) => string;
}

/**
 * Sum per-bucket cost with the host's `densify`.
 *
 * A thin wrapper on purpose: `densify` sums points into their bucket and drops
 * points that fall off the axis, which is the behaviour we want and the
 * behaviour the dashboard has already been running against real data. The test
 * `costsForBuckets is the host's densify, not a reimplementation` compares our
 * output against `densify`'s directly, so this can never quietly diverge.
 */
export function costsForBuckets(
	points: readonly { timestamp: number; cost: number }[],
	buckets: readonly number[],
): readonly number[] {
	return densify(points, buckets, (p) => p.cost);
}

/** Resolve a role that may be a single glyph or a ramp, without branching on preset. */
function mark(glyphs: GlyphSet, role: keyof GlyphSet): string {
	const value: GlyphValue = glyphs[role];
	return typeof value === "string" ? value : (value[0] ?? "");
}

/**
 * Column heights in rows, scaled from zero to `height`.
 *
 * SCALING IS BY COST, NEVER BY TOKEN COUNT — this is the chart's one
 * correctness rule. In this database `deepseek-v4-flash` reads 4.04 BILLION
 * cache tokens for $22.85 while `gpt-5.6-terra` reads 2.39B for $935.72: a 41x
 * price spread at comparable token volume. Scale those by tokens and the chart
 * is confidently, silently wrong — it would put the cheapest model at the top.
 * Cost is what the user pays, so cost is the height.
 *
 * THE 8-LEVEL RAMP IS NOT USED HERE, deliberately. `sparkRamp` encodes a value
 * within a single cell; stacking those vertically gives every bar a staircase
 * top edge and near-equal bars no shared top line. A column chart repeats ONE
 * glyph and lets ROW COUNT carry the magnitude, which is why `height` is the
 * resolution axis and why the ramp is not consulted.
 *
 * A zero value gets ZERO filled rows, which now renders as a blank column over
 * the floor rather than as a full-height block of `░`. That is what separates
 * the three states this chart can be in, which used to collapse into one:
 *
 *   - a bucket that measured zero inside a live series is a GAP — the column
 *     simply does not rise off the floor;
 *   - a series where every bucket measured zero is a real chart whose floor is
 *     the only ink — present, accounted for, nothing recorded;
 *   - a range with no buckets at all is the empty-state sentence below.
 *
 * The web collapses the first two (`Chart.tsx:108`: `empty` is every value
 * falsy). A terminal does not have to, because the floor gives zero somewhere
 * to be drawn.
 */
function heights(values: readonly number[], rows: number, supplied?: number): readonly number[] {
	if (rows <= 0) return values.map(() => 0);
	// The caller's maximum when there is one, else this series' own peak. Never
	// the series MINIMUM: min-max stretches a quiet series to fill the ramp and
	// renders a quiet week exactly like a busy one.
	const max = supplied ?? Math.max(0, ...values);
	// Nothing to scale against, so every column stays empty rather than dividing
	// by zero. (Crush's guard is `if (max === 0) max = 1`; transcribing that
	// literally into a ramp paints a non-zero value FULL.)
	if (max <= 0) return values.map(() => 0);
	// THE ONE-ROW FLOOR, unconditionally. A value that rounds to no rows is drawn
	// as one row anyway, because the alternative is a series that recorded
	// something drawing nothing — and "it drew nothing" and "it recorded nothing"
	// are then the same claim. That is rule 4, and it outranks the rounding error
	// it introduces: a value a fiftieth of the scale reads as one row instead of
	// no rows, which over-reads. An under-read is worse, because the reader
	// concludes from a blank band that nothing happened.
	//
	// So a shared scale alone is NOT enough to make two bands comparable — a
	// quiet band given one row fills that row completely. The band renderer
	// therefore sizes bands by PEAK SHARE as well as passing the shared maximum:
	// the row count carries the cross-series magnitude and the maximum keeps each
	// band from over-filling the rows it was given.
	return values.map((v) => (v <= 0 ? 0 : Math.max(1, Math.min(rows, Math.round((v / max) * rows)))));
}

/**
 * Rows of magnitude a plot of `height` rows has, once the floor is taken.
 *
 * THE FLOOR IS INSIDE THE BUDGET, deliberately. A band allocated
 * `renderDailyBars(values, {height})` must not grow by a row per call, or a
 * four-series chart would claim four rows more than the plan gave it and the
 * body would overflow — and the band renderer splits one `height` between its
 * series, so an extra row per band would silently halve the resolution.
 *
 * So the floor comes out of the height rather than being added to it, and it
 * comes out of EVERY band, `height` 1 included: one row is the floor and there
 * is no magnitude above it. It used to be given to the data at `height` 1, on
 * the reasoning that a bare baseline would render a quiet series as having
 * recorded nothing — but a band of ink with no baseline under it is not a
 * column chart either, and it is the all-zero series that pays worst, since its
 * one row then had nothing in it and read as the gap between two cards.
 */
function plotRows(height: number): number {
	return Math.max(0, height - 1);
}

/**
 * The rows a column chart is made of: magnitude rows, then the floor.
 *
 * Rows come top to bottom, so row `r` covers column heights `rows - r` and
 * below; every column therefore rises off the SAME bottom row, which is what
 * makes the chart zero-baselined. `test/chart-ink.test.ts` asserts the
 * contiguity directly, because a bar with a gap under it claims a non-zero
 * baseline and inflates every magnitude on the chart.
 *
 * ── A blank cell is a blank cell ────────────────────────────────────────────
 * The unplotted part of a column is a SPACE. It used to be `dim(barEmpty)`, a
 * wall of U+2591 that encoded nothing, and at `innerWidth` 96 × `barHeight` 14
 * that was 1,344 glyphs of texture per chart — the whole complaint. The web
 * draws nothing there either: `Chart.tsx:229` is `{!v ? return null : …}` and
 * the plot's background is the card's own colour, while the only track on the
 * page is `.meter`'s `rgba(255,255,255,0.06)` (`styles.css:1380`), which is a
 * background and not a glyph.
 *
 * DIVERGENCE (deliberate, noted): the web strokes `.chart-baseline` at `y(0)`
 * in `--line-3` (`Chart.tsx:304`). G5 and `/usage`'s zero-rules body forbid a
 * full-width rule inside a band, so we MARK the floor with a width-1 glyph
 * instead of drawing one. A mark is the better terminal translation anyway: it
 * cannot be mistaken for a section separator, and it costs one row instead of
 * one line in the middle of the plot.
 */
function compose(columnHeights: readonly number[], rows: number, opts: BarsOptions): readonly string[] {
	const fill = mark(opts.glyphs, "barFill");
	const out: string[] = [];

	for (let r = 0; r < rows; r++) {
		const threshold = rows - r;
		out.push(columnHeights.map(h => (h >= threshold ? opts.accent(fill) : " ")).join(""));
	}
	// EVERY BAND ENDS ON ITS FLOOR, always, with no exception for a one-row band.
	//
	// This used to be `if (rows < opts.height)`, which quietly dropped the floor
	// from any band whose whole allocation was one row — the loud row of ink was
	// there, so the band looked drawn, but the ink had no baseline under it and
	// the band read as a floating line rather than a column chart. Worse, at a
	// one-row allocation an all-zero band produced a row of nothing at all: the
	// row existed, it carried no glyph, and it was indistinguishable from the
	// padding between two cards.
	//
	// `plotRows` is what decides how many rows of DATA fit above the floor, so the
	// floor belongs here unconditionally: a band of `height` rows is `height - 1`
	// of magnitude and one mark of baseline, and a height-1 band is that single
	// mark with no magnitude above it — which is exactly the honest reading of a
	// series that recorded nothing.
	const width = Math.max(0, Math.floor(opts.width));
	out.push(opts.dim(mark(opts.glyphs, "axisLine").repeat(width)));
	return out;
}

/**
 * What a range with no buckets says. Named once so the two entry points below
 * cannot drift into two different sentences for the same state.
 */
const NO_ACTIVITY = "No activity recorded in this range.";

/**
 * Truncate to `width` cells, measured rather than counted.
 *
 * Data ink is guaranteed one cell wide (Task 3's invariant), but a styling
 * callback may return ANSI escape sequences, so `text.length` would be the
 * wrong measure. Every line this module returns goes through here or through
 * the same width check, because one over-wide line corrupts the whole overlay.
 */
function clamp(text: string, width: number): string {
	if (Bun.stringWidth(text) <= width) return text;
	let out = "";
	for (const ch of text) {
		if (Bun.stringWidth(out + ch) > width) break;
		out += ch;
	}
	return out;
}


/**
 * The daily bar chart over an already-bucketed series of COSTS.
 *
 * Bars are adjacent, one cell each — plotext's 0.8-of-a-slot fraction exists
 * because its plot matrix is a scatter with variable gaps; a dense calendar
 * chart wants contiguous columns, and a fractional width would need per-column
 * padding maths that `Bun.stringWidth` would then have to absorb.
 */
export function renderDailyBars(values: readonly number[], opts: BarsOptions): readonly string[] {
	// ABSENT — no buckets at all. A real state, not an error and not "zero
	// everywhere": the web draws its centred `.chart-empty` for exactly this
	// (`Chart.tsx:320`), and a chart of blank columns would read as "you did
	// nothing", when in truth the range was never populated. Clamped to the
	// width like every other line: a 35-character message in a 20-column panel
	// is an overflow, and an empty-state line that overflows corrupts the panel
	// exactly as a wide bar row would.
	if (values.length === 0) {
		return [opts.dim(clamp(NO_ACTIVITY, Math.max(0, Math.floor(opts.width))))];
	}

	const width = Math.max(0, Math.floor(opts.width));
	// Exactly `width` columns: densify pads when there is less data than width,
	// and we would rather show trailing blank columns than a row narrower than
	// the panel it sits in.
	const columns = values.length === width ? values : costsForBuckets(
		values.map((cost, i) => ({ timestamp: i, cost })),
		Array.from({ length: width }, (_, i) => i),
	);

	const rows = plotRows(opts.height);
	return compose(heights(columns, rows, opts.max), rows, { ...opts, width });
}

/**
 * Per-model cost bars over the cost series.
 *
 * Every ranking decision is the host's: `pivotSeries` ranks by total, keeps the
 * top `limit` and folds the rest into a trailing "Other (n)", and
 * `buildCostSummary` supplies the per-model totals and the cost-first
 * comparator. We add only the rendering.
 */
export function renderModelCostBars(
	points: readonly CostTimeSeriesPoint[],
	opts: BarsOptions & { limit?: number },
): readonly string[] {
	if (points.length === 0) return [opts.dim(clamp(NO_ACTIVITY, Math.max(0, Math.floor(opts.width))))];

	const width = Math.max(0, Math.floor(opts.width));
	const summary = buildCostSummary(points);
	const buckets = [...new Set(points.map((p) => p.timestamp))].sort((a, b) => a - b);

	// pivotSeries, not our own sort. It also folds everything past `limit` into
	// one "Other (n)" column, so a chart of twenty models does not become
	// twenty unreadable cells.
	const series = pivotSeries(points, {
		buckets,
		key: (p) => `${p.model}::${p.provider}`,
		value: (p) => p.cost,
		limit: opts.limit ?? Number.POSITIVE_INFINITY,
	});

	// One column per model, ranked, in the order pivotSeries returned them.
	// `ChartSeries.values` is `readonly (number | null)[]` because a series may
	// contain gaps; pivotSeries only produces them when a caller passes raw
	// points, but the type is the contract, and a null there means "no value",
	// which for a total is zero.
	const perModel = series.map((s) => s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0));
	void summary; // the totals belong to the caller's legend, not to the geometry

	const columns =
		perModel.length === width
			? perModel
			: costsForBuckets(
					perModel.map((cost, i) => ({ timestamp: i, cost })),
					Array.from({ length: width }, (_, i) => i),
				);

	const rows = plotRows(opts.height);
	return compose(heights(columns, rows, opts.max), rows, { ...opts, width });
}
