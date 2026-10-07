/**
 * `test/chart-ink.test.ts` — what EVERY chart in this panel owes its reader,
 * asserted on rendered output rather than on any one primitive's internals.
 *
 * WHY THIS FILE EXISTS. The complaint that produced it was "charts are badly
 * drawn, colouring is bad", and the captures underneath that complaint all had
 * the same cause: `░` was being emitted as the FILL of the unplotted part of
 * every bar, share bar and ranked row. At `innerWidth` 96 and `barHeight` 14
 * that is a 96 × 14 wall of U+2591 — fourteen hundred glyphs of texture that
 * encodes nothing, drawn in the SERIES colour so it read as data. The web draws
 * nothing there at all: `Chart.tsx:229` is `{!v ? return null : …}`, and the
 * plot's background is the card's own colour.
 *
 * So the rule this file pins is the negative one first — no chart may emit a
 * shade glyph as track or background — and then the four things that must be
 * true once the noise is gone, each of which was previously unfalsifiable
 * because the noise covered everything:
 *
 *   1. **ZERO-BASELINED.** Every filled cell in a column chart is CONTIGUOUS
 *      down to the row above the floor. A chart with a floating block implies a
 *      non-zero baseline, which is a lie about magnitude.
 *   2. **A FLOOR.** Every column chart ends on a row of `axisLine`, so zero has
 *      a place. The web strokes `.chart-baseline` at `y(0)` (`Chart.tsx:304`);
 *      we MARK it instead of drawing it (see the divergence note in bars.ts).
 *   3. **THREE STATES, NOT TWO.** Measured zero, an all-zero series and absent
 *      data are three different claims and must render three different ways.
 *      The web collapses two of them (`Chart.tsx:108`: `empty` is every value
 *      falsy) and so did we; a terminal can do better, because a zero bucket
 *      inside a live series is a visible gap in an otherwise-drawn column.
 *   4. **WIDTH-1 INK.** Every glyph a chart can emit measures exactly one cell
 *      under all three presets, so no chart row can ever be one column wider
 *      than the panel it sits in.
 *
 * Every assertion here is deliberately about OUTPUT — the marks, the colours
 * that reached them, the widths they measure — because "the chart looks right"
 * is a thing a human judges once and a machine never.
 */

import { expect, test } from "bun:test";

import { renderDailyBars, renderModelCostBars } from "../src/tui/charts/bars";
import { bandHeights, renderSeriesChart, type SeriesChartSeries } from "../src/tui/charts/compose";
import { renderRankedBars, renderShareBar, renderSparkline } from "../src/tui/charts/sparkline";
import { renderTimeSeries } from "../src/tui/charts/time-series";
import { glyph, glyphsFor, type GlyphSet, type SymbolPreset } from "../src/tui/glyphs";
import { stripForTest, type PaletteTheme } from "../src/tui/palette";
import type { FeatureContext } from "../src/tui/features/types";
import type { ThemeColor } from "@oh-my-pi/pi-tui";
import type { CostTimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";

const PRESETS: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];
/** The widths the brief requires every screen captured at, plus the plan's floor. */
const WIDTHS = [20, 40, 60, 100, 150] as const;

/**
 * A theme that needs no omp runtime. `getColorHex` must return a DISTINCT hex
 * per token or `resolveSeries`'s dedupe collapses the palette to one colour and
 * every "these two series differ" assertion below would pass vacuously.
 */
const THEME: PaletteTheme = {
	getColorHex: (token: string) => `#${(token.length * 7919).toString(16).padStart(6, "0").slice(-6)}`,
	getColorMode: () => "truecolor",
	getSymbolPreset: () => "unicode",
};

const identity = (text: string) => text;

/** Visible cells, ANSI excluded. */
const cells = (line: string): number => Bun.stringWidth(stripForTest(line));

/**
 * Options for a column chart, at one width and height. Four primitives are
 * swept against it, so the callbacks stay in lockstep by construction.
 */
const barOpts = (width: number, height: number, glyphs: GlyphSet) => ({
	width,
	height,
	glyphs,
	accent: identity,
	dim: identity,
});

/**
 * Split a rendered column chart into its floor row and the marks above it.
 *
 * Throws rather than returning `undefined`: this is read at six call sites, and
 * a nullable return would mean an unchecked cast at each one to reach `.marks`.
 * A helper that cannot answer its own question should fail the test loudly.
 */
function splitChart(rows: readonly string[], axis: string): { marks: string[]; floor: string } {
	const floor = stripForTest(rows[rows.length - 1] ?? "");
	if (![...floor].every(ch => ch === axis)) {
		throw new Error(`not a column chart (axis ${JSON.stringify(axis)}): ${JSON.stringify(rows)}`);
	}
	return { marks: rows.slice(0, -1), floor };
}

/** Filled cells per column of one column chart's marks. */
function filledPerColumn(chart: { marks: readonly string[] }, fill: string, width: number): number[] {
	const counts = new Array<number>(width).fill(0);
	for (const row of chart.marks) {
		[...stripForTest(row)].forEach((ch, col) => {
			if (ch === fill && col < width) counts[col] = (counts[col] ?? 0) + 1;
		});
	}
	return counts;
}

// ─── 1. No shade glyph is ever chart ink ─────────────────────────────────────

test("no chart primitive emits a shade glyph as track or background", () => {
	// THE defect, stated as an invariant so it cannot come back quietly. The web
	// draws NOTHING in the unplotted part of a plot (`Chart.tsx:229`), and a
	// 6%-white meter track (`styles.css:1380`) is not a glyph. A shade block is
	// neither: it is a cell of texture encoding nothing, and at panel width
	// there are hundreds of them per chart.
	const shade = glyphsFor("unicode").barEmpty;
	if (typeof shade !== "string") throw new Error("barEmpty must be a single glyph to be a shade");
	for (const preset of PRESETS) {
		for (const width of WIDTHS) {
			for (const height of [1, 2, 6, 14]) {
				const bars = renderDailyBars([0, 1, 4, 9, 0, 2], barOpts(width, height, glyphsFor(preset)));
				expect(stripForTest(bars.join("\n")).includes(shade), `${preset}/${width}/${height} bars`).toBe(false);

				const composed = renderSeriesChart(
					[
						{ label: "Succeeded", values: [1, 5, 9, 0] },
						{ label: "Failed", values: [0, 1, 0, 2] },
					],
					{ width, height: height * 2, preset, theme: THEME, paint: (_c, text) => text, labels: false },
				);
				expect(stripForTest(composed.join("\n")).includes(shade), `${preset} compose`).toBe(false);

				const ranked = renderRankedBars(
					[
						{ label: "alpha", value: 9 },
						{ label: "beta", value: 0 },
					],
					{ width, preset, accent: identity },
				);
				expect(stripForTest(ranked.join("\n")).includes(shade), `${preset} ranked`).toBe(false);

				const share = renderShareBar(0.42, { width, preset, accent: identity }, "42.0%");
				expect(share.includes(shade), `${preset} share`).toBe(false);
			}
		}
	}
});

test("a bar chart at panel width is mostly whitespace, not mostly texture", () => {
	// The shape of the complaint, asserted as a ratio so it cannot regress by
	// degrees. A quiet chart is overwhelmingly blank; only the columns that
	// recorded something carry ink, plus one floor row.
	const glyphs = glyphsFor("unicode");
	const values = Array.from({ length: 40 }, (_, i) => (i % 20 === 0 ? 10 : 0));
	const axis = glyph("unicode", "axisLine");
	const chart = splitChart(renderDailyBars(values, barOpts(96, 10, glyphs)), axis);
	const ink = [...stripForTest(chart.marks.join(""))].filter(ch => ch !== " " && ch !== axis).length;
	// Two busy buckets out of forty. Even counting their full columns, ink is a
	// small fraction of the plot; before the fix it was ~99% `░`.
	expect(ink / (chart.marks.length * 96)).toBeLessThan(0.1);
});

// ─── 2. Zero-baselined, with a floor ─────────────────────────────────────────

test("every filled cell in a column chart reaches the floor — nothing floats", () => {
	// A bar with a gap under it claims a non-zero baseline, which silently
	// inflates every magnitude on the chart. Rows come top to bottom, so in each
	// column the filled run must be a SUFFIX of the rows above the floor.
	for (const preset of PRESETS) {
		const glyphs = glyphsFor(preset);
		const fill = glyph(preset, "barFill");
		const axis = glyph(preset, "axisLine");
		const values = [0, 3, 12, 40, 41, 7, 0, 19, 25, 11, 4, 0, 30];
		for (const width of [8, 13, 40]) {
			const chart = splitChart(renderDailyBars(values, barOpts(width, 9, glyphs)), axis);
			for (const [col, filled] of filledPerColumn(chart, fill, width).entries()) {
				if (filled === 0) continue;
				// Rows run top to bottom and a bar rises off the floor, so the
				// filled run must be a SUFFIX: from the top of the bar downward,
				// there is never a blank.
				const column = chart.marks.map(row => [...stripForTest(row)][col] === fill);
				const top = column.findIndex(Boolean);
				expect(
					column.slice(top).every(Boolean),
					`${preset}/${width} col ${col} (${filled} filled): ${column.map(d => (d ? "█" : " ")).join("")}`,
				).toBe(true);
			}
		}
	}
});

test("a column chart's last row is the floor, so zero has a place to be", () => {
	// `Chart.tsx:304` strokes `.chart-baseline` at `y(0)` on every chart. G5 and
	// /usage's zero-rules body forbid us a rule, so we mark the floor with a
	// width-1 glyph instead — see the divergence note in `bars.ts`.
	for (const preset of PRESETS) {
		const glyphs = glyphsFor(preset);
		const axis = glyph(preset, "axisLine");
		for (const height of [2, 4, 9, 14]) {
			const rows = renderDailyBars([0, 3, 9], barOpts(20, height, glyphs));
			expect(rows.length, `${preset}/${height}`).toBe(height);
			expect(stripForTest(rows[rows.length - 1] ?? ""), `${preset}/${height}`).toBe(axis.repeat(20));
		}
	}
});

test("the floor never wears a series colour, and never a data colour either", () => {
	// The web's baseline is `--line-3` and its gridlines are 5.5% white: the
	// floor is chrome. `compose` used to pass the SERIES paint as `dim`, which
	// is how a wall of `░` ended up wearing a data colour.
	const painted = new Set<string>();
	const rows = renderSeriesChart(
		[
			{ label: "Succeeded", values: [1, 5, 9, 0] },
			{ label: "Failed", values: [0, 1, 0, 2] },
		],
		{
			width: 12,
			height: 8,
			preset: "unicode",
			theme: THEME,
			paint: color => {
				painted.add(color);
				return "";
			},
			dim: text => text,
		},
	);
	// Two hues reach `paint`, one per series; the floor went through `dim`. A
	// band only has room for a floor when it has more than one row, so this
	// counts the rows that carry one rather than assuming a row per series.
	expect(painted.size).toBe(2);
	const axis = glyph("unicode", "axisLine");
	const floor = rows.filter(row => stripForTest(row).includes(axis));
	expect(floor.length).toBeGreaterThan(0);
	for (const row of floor) expect(stripForTest(row)).toBe(axis.repeat(12));
});

test("a quiet series draws a SHORTER band than a loud one, not an identical one", () => {
	// THE REGRESSION `compose.ts`'s own header says it exists to prevent, caught
	// by LOOKING at the render rather than by reading the arithmetic. Overview's
	// Succeeded and Failed bands came out pixel-identical: bands were sized by
	// peak share (1 row against 6) and the primitive inside each band then
	// re-scaled against that band's OWN peak, so one row of "Failed" filled one
	// row completely. The allocation said the quiet series was quiet; the
	// geometry said it was not; and the geometry is what a reader sees.
	//
	// One divisor across the bands is the fix — the web's single `leftMax`
	// (`Chart.tsx:83-98`) — and this asserts its observable consequence.
	const rows = renderSeriesChart(
		[
			{ label: "Succeeded", values: [44, 40, 44, 38] },
			{ label: "Failed", values: [4, 4, 4, 4] },
		],
		{ width: 20, height: 14, preset: "unicode", theme: THEME, paint: (_c, text) => text },
	);
	const fill = glyph("unicode", "barFill");
	const succeeded = rows.findIndex(row => stripForTest(row).includes("Succeeded"));
	const failed = rows.findIndex(row => stripForTest(row).includes("Failed"));
	// `renderSeriesChart` labels a band AFTER its marks, so a band's rows are the
	// ones between the previous label and its own.
	const markedRows = (from: number, to: number): number =>
		rows.slice(from, to).filter(row => [...stripForTest(row)].includes(fill)).length;
	const loud = markedRows(0, succeeded);
	const quiet = markedRows(succeeded + 1, failed);
	expect(quiet).toBeGreaterThan(0);
	expect(loud).toBeGreaterThan(quiet);
	// And not by a hair: a 4% band against a 100% one must be visibly shorter, or
	// the reader is being told the failure rate is high.
	expect(quiet * 3).toBeLessThan(loud);
});

/**
 * Rows of INK in each labelled band, in the order the labels were given.
 *
 * `renderSeriesChart` labels a band AFTER its marks, so a band's rows are those
 * between the previous label and its own — the same split the test above walks
 * by hand, done once for three chart shapes instead of three times.
 *
 * Throws rather than returning a short array: a band that cannot be found means
 * the chart is not shaped the way the caller believes, and a silently shorter
 * result would let `Math.max` over an empty set pass.
 */
function bandInk(rows: readonly string[], labels: readonly string[], fill: string): number[] {
	const ink: number[] = [];
	let start = 0;
	for (const label of labels) {
		const at = rows.findIndex((row, index) => index >= start && stripForTest(row).includes(label));
		if (at < 0) throw new Error(`no band labelled ${JSON.stringify(label)}: ${JSON.stringify(rows)}`);
		ink.push(rows.slice(start, at).filter(row => [...stripForTest(row)].includes(fill)).length);
		start = at + 1;
	}
	return ink;
}

test("an all-zero series inside a multi-series chart draws its floor, never a blank band", () => {
	// DEFECT 1, and it is in the COMPOSITION rather than the primitive: the
	// primitive already drew a floor for an all-zero series, at every height. The
	// composed chart lost it, because the floor was charged to the magnitude side
	// — `plotRows` gives a one-row band over to the data, and a series that
	// recorded nothing has no data to put in that row, so the row came out blank
	// with nothing under it. A blank band and a band that was never there are then
	// the same claim, which is the whole reason the three states are three.
	const axis = glyph("unicode", "axisLine");
	const width = 20;
	const rows = renderSeriesChart(
		[
			{ label: "Succeeded", values: [12, 30, 8, 20, 21] },
			{ label: "Failed", values: [0, 0, 0, 0, 0] },
		],
		{ width, height: 12, preset: "unicode", theme: THEME, paint: (_color, text) => text },
	);
	const failed = rows.findIndex(row => stripForTest(row).includes("Failed"));
	expect(failed, "the all-zero band must still be present").toBeGreaterThan(0);
	const band = rows.slice(0, failed).map(row => stripForTest(row));
	// PRESENT, ACCOUNTED FOR, NOTHING RECORDED: its floor is the only ink it has.
	expect(band).toContain(axis.repeat(width));
	// And it is never a block of nothing, which is what an absent band looks like.
	expect(band.some(row => row.trim() === "")).toBe(false);
});

test("band height carries magnitude across two, three and four series", () => {
	// DEFECT 2. Band height was allocated in a space where the FLOOR counted as
	// magnitude, so the loudest band spent the very row that said it was loud on
	// its floor: bands allocated 1 and 2 rows drew the SAME single row of ink. A
	// 16x peak spread came out of a four-series chart as 1 of 4 distinct band
	// shapes, which is the shared-max claim failing silently — the maximum was
	// passed to every band, and the row budget cancelled it out again.
	//
	// Two series is included because it is the case that already worked: if the
	// fix regressed THAT, it would have stopped discriminating everywhere.
	const fill = glyph("unicode", "barFill");
	const shapes: readonly (readonly [string, readonly number[]])[][] = [
		[
			["Succeeded", [44, 40, 44, 38]],
			["Failed", [4, 4, 4, 4]],
		],
		[
			["a", [60, 50, 60, 55]],
			["b", [10, 10, 10, 10]],
			["c", [1, 1, 1, 1]],
		],
		[
			["Input", [2, 1, 4, 2]],
			["Output", [1, 2, 1, 1]],
			["Cache read", [16, 8, 20, 12]],
			["Cache write", [1, 2, 1, 1]],
		],
	];

	for (const shape of shapes) {
		const labels = shape.map(([label]) => label);
		const rows = renderSeriesChart(
			shape.map(([label, values]) => ({ label, values })),
			{ width: 20, height: 14, preset: "unicode", theme: THEME, paint: (_color, text) => text },
		);
		const ink = bandInk(rows, labels, fill);
		expect(ink.length, labels.join("/")).toBe(labels.length);
		// Every series that recorded something draws something.
		for (const [index, count] of ink.entries()) {
			expect(count, `${labels[index]} drew nothing`).toBeGreaterThan(0);
		}
		// And the loudest band is VISIBLY taller than the quietest — three times
		// over, or the reader is being told a quiet series is a loud one. Equal
		// bands are the failure this test exists for.
		const loud = Math.max(...ink);
		const quiet = Math.min(...ink);
		expect(quiet * 3, `${labels.join("/")} drew ${ink.join(", ")} rows of ink`).toBeLessThanOrEqual(loud);
	}
});

test("a chart too short for BOTH names and discrimination drops the names, not the rows", () => {
	// Found while sweeping the band allocation: names cost one row each, and at
	// four series in eight rows they cost half the chart — leaving every band
	// exactly one row. That is a chart which names four series and then shows
	// them as four identical bars, so the naming was buying nothing a reader can
	// use while destroying the one thing they can.
	//
	// A label is CHROME and band height is DATA, so when the rows cannot pay for
	// both, the marks win and the caller names them.
	const fill = glyph("unicode", "barFill");
	const shape: readonly SeriesChartSeries[] = [
		{ label: "Input", values: [16, 8, 12] },
		{ label: "Output", values: [8, 4, 6] },
		{ label: "Cache read", values: [4, 2, 3] },
		{ label: "Cache write", values: [2, 1, 1] },
	];
	// Eight rows for four bands. With the floor now mandatory, two rows per band is
	// the most a live band can have — one row of ink and its baseline — so this is
	// the shape that chart must reach: every band drawn, none named.
	const rows = renderSeriesChart(shape, { width: 20, height: 8, preset: "unicode", theme: THEME, paint: (_c, t) => t });
	expect(rows.some(row => shape.some(s => stripForTest(row).includes(s.label)))).toBe(false);
	expect(rows.length).toBe(8);
	// Every band is a chart: ink standing on a floor, never a bare baseline.
	const axis = glyph("unicode", "axisLine");
	const ink = rows.filter(row => [...stripForTest(row)].includes(fill)).length;
	const floors = rows.filter(row => stripForTest(row).trim() === axis.repeat(20)).length;
	expect(ink, "one row of ink per band").toBe(shape.length);
	expect(floors, "one floor per band").toBe(shape.length);
	// One row taller, and there IS room for both — so the names come back.
	const roomy = renderSeriesChart(shape, { width: 20, height: 14, preset: "unicode", theme: THEME, paint: (_c, t) => t });
	for (const series of shape) {
		expect(roomy.some(row => stripForTest(row).includes(series.label)), `${series.label} must be named`).toBe(true);
	}
});

test("no band ever claims a row the chart was not given", () => {
	// The budget is the WHOLE chart height, so the floor a band reserves its own
	// row for comes out of the same pool. This is the invariant that lets a
	// four-series chart keep the rows its bands actually drew instead of
	// overflowing the panel it sits in.
	for (const count of [1, 2, 3, 4, 5, 6]) {
		for (const height of [1, 2, 3, 4, 8, 14, 20]) {
			const series: SeriesChartSeries[] = Array.from({ length: count }, (_, i) => ({
				label: `s${i}`,
				values: [16 / (i + 1), 8 / (i + 1), 4 / (i + 1)],
			}));
			for (const labels of [false, true]) {
				const rows = renderSeriesChart(series, { width: 20, height, preset: "unicode", theme: THEME, paint: (_c, t) => t, labels });
				expect(rows.length, `${count}/${height}/${labels}`).toBeLessThanOrEqual(height);
				for (const row of rows) expect(cells(row), `${count}/${height}/${labels}`).toBe(20);
			}
		}
	}
});

test("EVERY band ends on a row that CARRIES INK, not merely on a row", () => {
	// The defect this pins is one a row-COUNT check cannot see. The floor was
	// emitted only when `rows < height`, so a band allocated exactly one row drew
	// either a bare line of ink with no baseline under it, or — for an all-zero
	// series — a row containing no glyph at all, which rendered as the blank
	// padding between two cards. Both cases had the right NUMBER of rows and the
	// wrong CONTENT, which is why an earlier sweep that only counted rows per band
	// reported the chart as clean.
	//
	// So this asserts the INK on each band's last row, at every arity and height.
	for (const preset of PRESETS) {
		const mark = glyph(preset, "axisLine");
		for (const count of [1, 2, 3, 4, 5, 6]) {
			for (const height of [1, 2, 3, 4, 8, 14, 20]) {
				// EQUAL PEAKS, every series live. Equal peaks are what collapsed the
				// old allocation to one row per band (`[1,1,1,1]`), and one row per
				// band is the shape that drew no floor. A DECAYING profile cannot
				// reproduce it: its loudest band soaks up the spare rows and lands on
				// two, so a sweep built from one quietly misses the defect — which is
				// what the first version of this test did.
				const series: SeriesChartSeries[] = Array.from({ length: count }, (_, i) => ({
					label: `s${i}`,
					values: [4, 2, 4],
				}));
				for (const labels of [false, true]) {
					const rows = renderSeriesChart(series, { width: 20, height, preset, theme: THEME, paint: (_c, t) => t, labels });
					// Split into bands: `renderSeriesChart` labels a band AFTER its
					// marks, and a floor row closes one whether or not it is labelled.
					const bands: string[][] = [];
					let open: string[] = [];
					for (const row of rows) {
						const plain = stripForTest(row);
						if (labels && series.some(s => plain.trim() === s.label)) { bands.push(open); open = []; continue; }
						open.push(row);
						if (plain.includes(mark)) { bands.push(open); open = []; }
					}
					if (open.length > 0) bands.push(open);
					for (const [index, band] of bands.entries()) {
						if (band.length === 0) continue;
						// Every band must OWN a floor row, and that floor must carry the
						// axis glyph. Counting rows per band cannot see this — the defective
						// bands had the right row COUNT and no baseline under it — and
						// checking only that a band ends on *some* ink cannot see it
						// either, because a one-row band of data is itself ink. So this asks
						// the question directly: a floor, carrying a glyph, under every band.
						const floors = band.filter(row => stripForTest(row).includes(mark));
						expect(
							floors.length,
							`${preset} ${count}/${height}/${labels} band ${index} has a floor, got ${JSON.stringify(band.map(r => stripForTest(r).slice(0, 12)))}`,
						).toBeGreaterThan(0);
						expect(
							stripForTest(band[band.length - 1] ?? "").includes(mark),
							`${preset} ${count}/${height}/${labels} band ${index} ENDS on its floor`,
						).toBe(true);
					}
				}
			}
		}
	}
});

test("an ALL-ZERO series is never shed to nothing — it always paints a floor", () => {
	// THE DEFECT THIS PINS, found by scanning rendered frames rather than by
	// running the code under test: `bandHeights` handed its floor out loudest
	// first, so whenever the budget was smaller than the series count the tail
	// bands were left with ZERO rows. A band with no rows draws nothing at all —
	// no floor, no ink — and being quietest and last, the all-zero series was
	// always among the shed. Its row read as the blank padding between two cards,
	// which is the one thing an all-zero series must not look like: it is present,
	// accounted for, and recorded nothing.
	//
	// So this asserts the FLOOR GLYPH, not a row count: a band that is drawn at
	// all must paint its floor, and the all-zero series must be drawn whenever the
	// chart has a row for it.
	const axis = glyph("unicode", "axisLine");
	for (const count of [2, 3, 4, 5, 6]) {
		for (const height of [1, 2, 3, 4, 6, 8, 14, 20]) {
			// The all-zero series LAST: that is the position the old allocator shed
			// from, so a leading one would not reproduce the defect.
			const series: SeriesChartSeries[] = [
				...Array.from({ length: count - 1 }, (_, i) => ({ label: `live${i}`, values: [16, 8, 12] })),
				{ label: "zero", values: [0, 0, 0] },
			];
			for (const labels of [false, true]) {
				const where = `${count}/${height}/${labels}`;
				const rows = renderSeriesChart(series, { width: 20, height, preset: "unicode", theme: THEME, paint: (_c, t) => t, labels });
				// Every drawn row that is a band floor carries the glyph. Count the
				// floors and require one per band that got any rows at all.
				// One floor per band that was drawn. When a chart is too short, the
				// shed takes whole bands quietest-first, so the all-zero series may
				// legitimately not be drawn — but every band that IS drawn paints a
				// floor, and the all-zero one paints its floor whenever there is a
				// row for it at all.
				// The band count is the number of rows the chart actually spent on
				// bands — and a chart too short for its own series list sheds whole
				// bands quietest-first, so that is fewer than `count`.
				const floors = rows.filter(row => stripForTest(row).includes(axis)).length;
				const inkRows = rows.filter(row => stripForTest(row).includes("\u2588")).length;
				expect(floors, `${where}: every drawn band paints a floor`).toBeGreaterThan(0);
				// Each floor sits UNDER the band it closes, so a floor is never the
				// only row of a band that also drew ink, and every band's last row is
				// either its floor or a floor row follows the ink it belongs to.
				expect(floors + inkRows, `${where}: rows are accounted for`).toBeLessThanOrEqual(rows.length);
				// THE SHAPE THAT LOST THE BAND: budget smaller than the series count.
				// `renderSeriesChart` sheds whole bands quietest-first, so the drawn
				// count is min(count, height) — and the all-zero band is the first
				// shed, so it must still be present whenever a band is drawn at all.
				expect(floors, `${where}: a floor for every drawn band`).toBe(Math.min(count, height));
				// And the bands that SURVIVE are the loud ones. The all-zero series is
				// the quietest, so it is the first to be shed — but only once every
				// live band has kept its floor, never before, and never silently
				// dropped from under a label that still names it.
				const liveFloors = Math.min(count - 1, height);
				expect(floors, `${where}: the loud bands keep their floors`).toBeGreaterThanOrEqual(Math.min(liveFloors, height));
				// THE GUARANTEE ITSELF, at the level it is made. `bandHeights` used
				// to hand its floor out loudest-first and STOP, so a budget smaller
				// than the series count left the tail bands with zero rows — and the
				// all-zero band, being quietest and last, was always among them. A
				// band with no rows paints no floor at all, which is the blank row
				// the defect report pointed at.
				// THE GUARANTEE ITSELF, at the level it is made: whenever the budget
				// has a row for it, EVERY band is allocated at least that one row.
				// This is what was missing — the allocation handed its floor out
				// loudest-first and STOPPED, so a budget smaller than the series
				// count left the tail bands with zero rows. A band with zero rows
				// paints no floor, and that is the blank row the defect pointed at.
				const peaks = series.map(s => Math.max(...s.values));
				const markable = Math.min(height, labels && height >= count * 2 + 1 ? height - count : height);
				expect(
					bandHeights(peaks, markable).filter(rows => rows < 1),
					`${where}: no band is allocated zero rows`,
				).toEqual([]);
				// And no band may ever END on a row with no glyph in it.
				for (const row of rows) {
					const plain = stripForTest(row);
					if (plain.trim() === "" && labels === false) continue; // a spacer between cards
					if (labels && series.some(s => plain.trim() === s.label)) continue;
					expect(plain.trim(), `${where}: no drawn row is glyphless`).not.toBe("");
				}
			}
		}
	}
});

test("a one-row chart is its FLOOR, and the allocator is what stops a live band being only that", () => {
	// This test used to pin the opposite rule: at height 1 the single row was the
	// DATA, on the reasoning that a bare baseline would render a quiet series as
	// having recorded nothing. That reasoning was right about the intent and wrong
	// about the mechanism, and it cost a defect — a band of ink with no baseline
	// under it is not a column chart either, and the series that suffered most was
	// the ALL-ZERO one, whose single row then held no glyph at all and was
	// indistinguishable from the padding between two cards.
	//
	// So the floor is unconditional, and `bandHeights` gives a band that recorded
	// something TWO rows so it has ink over a baseline. A band of one row is
	// therefore a claim that nothing was recorded — which is exactly what it says.
	const axis = glyph("unicode", "axisLine");
	const rows = renderDailyBars([0, 4, 0], barOpts(3, 1, glyphsFor("unicode")));
	expect(rows.length).toBe(1);
	expect(rows[0]).toBe(axis.repeat(3));

	// And the allocation is what makes a quiet series readable rather than a bare
	// baseline: it never gets a single row while it still has ink to show.
	for (const budget of [4, 8, 14]) {
		expect(bandHeights([44, 4], budget).every(rows => rows >= 2), `[44,4]/${budget}`).toBe(true);
		expect(bandHeights([1], budget)[0]).toBeGreaterThanOrEqual(2);
	}
});

// ─── 3. Measured zero, an empty series and absent data are three things ──────

test("measured zero, an all-zero series and absent data render three different ways", () => {
	const glyphs = glyphsFor("unicode");
	const axis = glyph("unicode", "axisLine");
	const opts = barOpts(40, 4, glyphs);

	// ABSENT: no buckets at all. One dim sentence, no plot, no floor.
	const absent = renderDailyBars([], opts);
	expect(absent.length).toBe(1);
	expect(absent[0]).toContain("No activity");
	expect(stripForTest(absent[0] ?? "")).not.toContain(axis);

	// EMPTY: buckets exist and every one measured zero. A real chart whose floor
	// is the only ink — present, accounted for, and nothing recorded.
	const empty = splitChart(renderDailyBars([0, 0, 0, 0, 0, 0], opts), axis);
	expect(renderDailyBars([0, 0, 0, 0, 0, 0], opts).length).toBe(4);
	expect(stripForTest(empty.marks.join("")).trim()).toBe("");

	// MEASURED ZERO: one bucket inside a live series. A gap in an otherwise
	// drawn column, with the floor still under it.
	const sparse = renderDailyBars([0, 7, 0, 0], barOpts(4, 4, glyphs));
	// Three magnitude rows, so the one busy bucket fills the top of the chart
	// and the other three are gaps.
	expect([...stripForTest(sparse[0] ?? "")]).toEqual([" ", glyph("unicode", "barFill"), " ", " "]);

	// And the three are pairwise distinguishable as whole renderings.
	const shapes = [absent.join("\n"), empty.marks.join("\n"), sparse.join("\n")];
	expect(new Set(shapes).size).toBe(3);
});

test("the empty state obeys the width rule like every other line", () => {
	// A 35-character message in a 20-column panel is an overflow, and an
	// overflowing line corrupts the panel exactly as an over-wide bar row does.
	for (const width of [1, 8, 20]) {
		for (const row of renderDailyBars([], barOpts(width, 4, glyphsFor("unicode")))) {
			expect(cells(row), `width ${width}`).toBeLessThanOrEqual(width);
		}
	}
});

// ─── 4. Width-1 ink under every preset, at every width ──────────────────────

test("every chart glyph measures exactly one cell under all three presets", () => {
	// One over-wide cell corrupts the whole overlay, because a terminal wraps
	// rather than clips. The glyph module owns the guarantee for the glyphs; this
	// asserts it for the charts that EMIT them, which is where a stray
	// multi-cell character would actually enter a row.
	let distinct = 0;
	const seen = new Set<string>();
	for (const preset of PRESETS) {
		for (const value of Object.values(glyphsFor(preset))) {
			for (const glyph of typeof value === "string" ? [value] : value) {
				if (glyph === " ") continue; // ascii `heatEmpty`, blank by design
				seen.add(glyph);
				expect(Bun.stringWidth(glyph), `${preset} ${JSON.stringify(glyph)}`).toBe(1);
			}
		}
	}
	distinct = seen.size;
	expect(distinct).toBeGreaterThan(10);
});

test("no rendered chart row exceeds the width it was given, swept hard", () => {
	// Swept 20..200 rather than a handful of widths, because an overflow usually
	// appears only at some widths. Every primitive, every preset.
	const values = Array.from({ length: 64 }, (_, i) => (i * 37) % 91);
	for (const preset of PRESETS) {
		const glyphs = glyphsFor(preset);
		for (let width = 20; width <= 200; width++) {
			for (const height of [1, 2, 7, 14]) {
				for (const row of renderDailyBars(values, barOpts(width, height, glyphs))) {
					expect(cells(row), `${preset}/${width}/${height}: ${JSON.stringify(row)}`).toBe(width);
				}
			}
			const composed = renderSeriesChart(
				[
					{ label: "Succeeded", values },
					{ label: "Failed", values: values.map(v => v % 3) },
				],
				{ width, height: 10, preset, theme: THEME, paint: (_c, text) => text },
			);
			for (const row of composed) {
				expect(cells(row), `${preset}/compose/${width}: ${JSON.stringify(row)}`).toBe(width);
			}
			const ranked = renderRankedBars(
				[
					{ label: "a-very-long-model-name-that-needs-truncation", value: 900 },
					{ label: "b", value: 0, unpriced: 4 },
				],
				{ width, preset, accent: identity },
			);
			for (const row of ranked) {
				expect(cells(row), `${preset}/ranked/${width}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(width);
			}
			expect(
				cells(renderShareBar(0.37, { width, preset, accent: identity }, "37.0% 854M")),
				`${preset}/share/${width}`,
			).toBe(width);
			expect(cells(renderSparkline(values, { width, preset })), `${preset}/spark/${width}`).toBe(width);
		}
	}
});

test("no chart body emits a rule — G5 holds for the floor too", () => {
	// `test/band.test.ts` asserts this at the band level; this asserts it for
	// the primitives directly, so a new primitive cannot slip a rule past it.
	const RULE_RUN = /[─━═]{3,}/;
	for (const preset of PRESETS) {
		const glyphs = glyphsFor(preset);
		const width = 60;
		const rendered = [
			...renderDailyBars([0, 3, 9, 1], barOpts(width, 8, glyphs)),
			...renderSeriesChart(
				[
					{ label: "a", values: [1, 2, 3] },
					{ label: "b", values: [3, 2, 1] },
				],
				{ width, height: 8, preset, theme: THEME, paint: (_c, text) => text },
			),
			...renderRankedBars([{ label: "a", value: 3 }], { width, preset, accent: identity }),
			renderShareBar(0.5, { width, preset, accent: identity }, "50%"),
		];
		for (const row of rendered) expect(stripForTest(row), `${preset}: ${row}`).not.toMatch(RULE_RUN);
	}
});

// ─── 5. A cost chart still scales by cost, and still has a floor ─────────────

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

test("renderModelCostBars loses the track without losing the cost invariant", () => {
	const glyphs = glyphsFor("unicode");
	const axis = glyph("unicode", "axisLine");
	const chart = splitChart(renderModelCostBars(COST_POINTS, barOpts(2, 6, glyphs)), axis);
	const filled = filledPerColumn(chart, glyph("unicode", "barFill"), 2);
	// The 42x token spender is still the shorter bar: scaling by cost, not tokens.
	expect(filled[0]).toBeGreaterThan(filled[1] ?? 0);
});

// ─── 6. renderTimeSeries is a delegation, not a second geometry ───────────────

/**
 * A context for the swapped renderer. Real theme methods off {@link THEME} so
 * `resolveSeries` resolves distinct hues, with `fg` as identity so assertions
 * read glyphs rather than escapes. Only `fg` and `getSymbolPreset` are reached.
 */
const seriesCtx = { theme: { ...THEME, fg: (_color: ThemeColor, text: string) => text } } as unknown as FeatureContext;

test("renderTimeSeries delegates to host pipeline", () => {
	// Four buckets, not the plan's three: `worthCharting` needs at least four
	// categories, so three would take the empty-state branch and prove nothing
	// about the delegation.
	const axis = [1700000000000, 1700008640000, 1700095040000, 1700181440000];
	const rows = [{ key: "a", label: "A", values: [1, 2, 3, 4] }];
	const lines = renderTimeSeries(seriesCtx, axis, rows, 80, 1, {});
	const text = stripForTest(lines.join("\n"));
	expect(lines.length).toBeGreaterThan(0);
	// The host planned a chart, so a plot is drawn and the legend names the series.
	expect(text).toContain(glyph("unicode", "barFill"));
	expect(text).toContain("A");
});

test("renderTimeSeries says so when the host will not chart the range", () => {
	// Two buckets fail `worthCharting`, so `planTimeline` returns undefined and
	// the renderer must supply its OWN sentence rather than a blank body.
	const axis = [1700000000000, 1700008640000];
	const lines = renderTimeSeries(seriesCtx, axis, [{ key: "a", label: "A", values: [1, 2] }], 80, 0, {});
	const text = stripForTest(lines.join("\n"));
	expect(text).toContain("No chart-worthy data in this range.");
	expect(text).not.toContain(glyph("unicode", "barFill"));
});
