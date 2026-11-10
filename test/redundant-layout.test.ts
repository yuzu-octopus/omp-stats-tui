/**
 * `test/redundant-layout.test.ts` — three redundancies a rendered screen shows.
 *
 * Every test here was written by LOOKING at `bun scripts/probe-render.ts costs
 * --width 150` and finding something repeated rather than by reading a spec and
 * imagining a defect. Each rule is stated once, asserted through the REAL
 * renderer over a synthetic `ScreenSpec`, and — where the shipped specs are the
 * case that produced the screenshot — over the shipped spec as well.
 *
 *   A  A `legend` band whose every item the chart above already PUBLISHED on its
 *      own rows is a second rendering of that chart, and is dropped.
 *   B  A table column that resolves to zero in EVERY row carries no variation and
 *      is dropped — except the money-caveat column, which AGENTS.md:228 requires
 *      beside cost always.
 *   C  A stat tile's HINT that resolves to zero, and restates a figure a sibling
 *      tile in the same statRow already states, is dropped.
 *
 * None of the three is "delete the feature". A legend stays for a chart that
 * cannot name its own series; the caveat column stays; a non-zero hint stays, and
 * so does a zero hint that is the only place its figure appears. Each of those
 * has its own test below, because a rule stated only by its exception is a rule
 * nobody can check.
 */
import type { Band } from "../src/tui/band";
import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";
import type { CostTimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";

import { SCREEN_SPECS, type Band as IRBand, type Column as IRColumn, type MetricRef, type ScreenSpec } from "../src/layout/spec";
import { screenBands, type ScreenRenderOptions } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { AGGREGATE, COST_SERIES, FIXTURE_NOW, liveData } from "./fixtures/panel";

ensureThemeSync();

const PRESET: SymbolPreset = "unicode";

function opts(spec: ScreenSpec, data: PanelData, width = 150): ScreenRenderOptions {
	return {
		spec,
		data,
		plan: planLayout(width, 40, PRESET),
		preset: PRESET,
		range: DEFAULT_RANGE,
		now: FIXTURE_NOW,
		fg: (color: ThemeColor, value: string) => theme.fg(color, value),
		bold: value => theme.bold(value),
		palette: theme,
		seriesColorFor: index => SERIES_COLORS[index % SERIES_COLORS.length],
		glyphs: glyphsFor(PRESET),
	};
}

const specOf = (id: string): ScreenSpec => {
	const spec = SCREEN_SPECS.find(candidate => candidate.id === id);
	if (spec === undefined) throw new Error(`no screen spec ${id}`);
	return spec;
};

/**
 * A spec with no web route behind it. The rules below are about COMPOSITION —
 * which bands and columns survive — and a rule proved only against the shipped
 * specs would be a rule proved against one payload's accidents.
 */
function probeSpec(bands: readonly IRBand[], id = "probe"): ScreenSpec {
	return {
		id,
		label: "Probe",
		short: "P",
		needs: ["overview", "costs"],
		bands,
		source: { file: "test/redundant-layout.test.ts", lines: "1" },
	};
}

const overall = (field: string): MetricRef => ({ kind: "aggregate", source: "overall", field });
const costField = (field: string): MetricRef => ({ kind: "series", source: "costSeries", field, groupBy: "model" });
const summedCost = (field: string): MetricRef => ({
	kind: "derived",
	name: field === "cost" ? "totalCost" : "unpricedRequests",
	op: "sum",
	of: costField(field),
});

/** One `(day, model)` cost row, shaped like `CostTimeSeriesPoint`. */
function costRow(model: string, cost: number, over: Partial<CostTimeSeriesPoint> = {}): CostTimeSeriesPoint {
	return {
		timestamp: FIXTURE_NOW,
		model,
		provider: "openrouter",
		cost,
		unpricedRequests: 0,
		costInput: cost * 0.1,
		costOutput: cost * 0.05,
		costCacheRead: cost * 0.8,
		costCacheWrite: cost * 0.05,
		requests: 100,
		...over,
	};
}

const costData = (rows: readonly CostTimeSeriesPoint[]): PanelData => liveData({ costs: { costSeries: [...rows] } });

// ─── A: a legend that only repeats the chart above it ─────────────────────────

test("A: a legend whose EVERY item the shareBar above already published does not render", () => {
	// The rule, in one band pair. A `shareBar` row is `label bar… pct figure` —
	// it names its own series and states that series' share. A legend beneath it
	// printing the same labels and the same percentages says nothing the row
	// above did not.
	const tokens = [
		{ key: "input", label: "Uncached input", metric: overall("totalInputTokens") },
		{ key: "cacheRead", label: "Cache read", metric: overall("totalCacheReadTokens") },
	];
	const spec = probeSpec([
		{ kind: "chart", title: "Token mix", chart: { type: "shareBar", axis: "share", series: tokens } },
		{ kind: "legend", items: tokens },
	]);
	expect(screenBands(opts(spec, liveData())).some(band => band.kind === "legend")).toBe(false);
});

test("A: the costs screen publishes no legend — the shareBar names all four components", () => {
	// The screenshot: `Where it went` draws Input/Output/Cache read/Cache write
	// with a bar, a percentage and a figure on each of its four rows, and the
	// four legend rows under it said the same four names at the same four
	// percentages. Four rows of nothing.
	const bands = screenBands(opts(specOf("costs"), liveData()));
	expect(bands.some(band => band.kind === "legend")).toBe(false);
});

test("A: a legend item the chart above did NOT publish keeps the whole legend", () => {
	// The exemption, and the case that must never be "fixed". Overview's legend
	// names three agent rows the `Token mix` shareBar has no series for — no
	// label, no bar, no share anywhere else on the screen. Suppressing a legend
	// because SOME of it is repeated would delete those three rows' only
	// rendering.
	//
	// Suppression is therefore all-or-nothing per legend band, not per item:
	// `renderLegend` wears each swatch in its ITEM index's hue, so removing the
	// first four items would slide the agent keys onto the hues the shareBar
	// already spent on the token kinds — a key that names the wrong series. One
	// legend, all or none.
	const bands = screenBands(opts(specOf("overview"), liveData()));
	const legend = bands.find(band => band.kind === "legend");
	expect(legend, "the agent-type legend must survive").toBeTruthy();
	if (legend === undefined || legend.kind !== "legend") throw new Error("not a legend band");
	const labels = legend.items.map(item => item.label);
	for (const label of ["Uncached input", "Cache read", "Main agent", "Subagents", "Advisor"]) {
		expect(labels, label).toContain(label);
	}
});

test("A: a chart kind that cannot name its own series KEEPS its legend", () => {
	// `bars` labels each series UNDER its marks, in the series' own hue, and
	// publishes no share for anything — there is nothing for a legend to adopt.
	// This is the band kind the legend exists for, so a rule that suppressed it
	// would delete the only place the shares are stated.
	const series = [
		{ key: "ok", label: "Succeeded", metric: { kind: "series", source: "timeSeries", field: "requests" } as MetricRef },
		{ key: "err", label: "Failed", metric: { kind: "series", source: "timeSeries", field: "errors" } as MetricRef },
	];
	const spec = probeSpec([
		{ kind: "chart", title: "Activity", chart: { type: "bars", axis: "requests", series } },
		{ kind: "legend", items: series },
	]);
	const legend = screenBands(opts(spec, liveData())).find(band => band.kind === "legend");
	expect(legend, "a chart that publishes nothing must keep its legend").toBeTruthy();
	if (legend === undefined || legend.kind !== "legend") throw new Error("not a legend band");
	expect(legend.items.map(item => item.label)).toEqual(["Succeeded", "Failed"]);
});

// ─── B: a column that is zero in every row says nothing ──────────────────────

/** A one-table spec over `costSeries`, so a test varies the DATA, not the spec. */
function costTableSpec(columns: readonly IRColumn[]): ScreenSpec {
	return probeSpec([{ kind: "table", title: "By model", rows: { source: "costSeries" }, columns }]);
}

const modelColumn: IRColumn = {
	header: "Model",
	align: "left",
	source: { kind: "label", source: "costSeries", field: "model" },
};

const headersOf = (spec: ScreenSpec, data: PanelData): readonly string[] => {
	const table = screenBands(opts(spec, data)).find(band => band.kind === "table");
	if (table === undefined || table.kind !== "table") throw new Error("no table band");
	return table.columns.map(column => column.header);
};

test("B: a column that is zero in SOME rows is kept — it carries a variation", () => {
	const spec = costTableSpec([modelColumn, { header: "Cache write", align: "right", source: costField("costCacheWrite") }]);
	const data = costData([costRow("priced", 10), costRow("free", 4, { costCacheWrite: 0 })]);
	expect(headersOf(spec, data)).toContain("Cache write");
});

test("B: a column that resolves to zero in EVERY row is dropped", () => {
	// The screenshot: `By model` printed Cache read and Cache write as `$0` down
	// every row. Neither varies, so each was a header, a gutter and a digit
	// saying "nothing happened here" — which is not a figure.
	const spec = costTableSpec([
		modelColumn,
		{ header: "Estimate", align: "right", source: costField("cost") },
		{ header: "Cache write", align: "right", source: costField("costCacheWrite") },
	]);
	const data = costData([costRow("a", 10, { costCacheWrite: 0 }), costRow("b", 20, { costCacheWrite: 0 })]);
	const headers = headersOf(spec, data);
	expect(headers, "an all-zero column carries no information").not.toContain("Cache write");
	expect(headers, "a column that varies must survive").toContain("Estimate");
	expect(headers[0], "the identity column is never dropped").toBe("Model");
});

test("B: the unpriced column is KEPT even when every row is zero — it is the money caveat", () => {
	// AGENTS.md:228, and CONTEXT.md's `Cost`: "a cost figure shown without its
	// unpriced count beside it is a wrong number, not a rounded one". `0` HERE
	// means nothing went unmeasured, and it says so beside the Estimate that
	// would otherwise read as a floor with no stated cause. That is the one
	// column an all-zero rule must not take, and it is why Cache write is the
	// column that goes instead: an all-zero caveat REMOVES a claim, while an
	// all-zero component only repeats a figure the cost bars already draw.
	const spec = costTableSpec([
		modelColumn,
		{ header: "Estimate", align: "right", source: costField("cost") },
		{ header: "Cache write", align: "right", source: costField("costCacheWrite") },
		{ header: "Unpriced", align: "right", source: costField("unpricedRequests") },
	]);
	const data = costData([
		costRow("a", 10, { costCacheWrite: 0, unpricedRequests: 0 }),
		costRow("b", 20, { costCacheWrite: 0, unpricedRequests: 0 }),
	]);
	const headers = headersOf(spec, data);
	expect(headers, "the caveat column must render beside cost").toContain("Unpriced");
	expect(headers, "the other all-zero column is the one that goes").not.toContain("Cache write");
	expect(headers, "and the money column it caveats is still there").toContain("Estimate");
});

// ─── C: a hint that says zero and repeats its own row ─────────────────────────

const tileOf = (bands: readonly Band[], label: string) => {
	const row = bands.find(band => band.kind === "statRow");
	if (row === undefined || row.kind !== "statRow") throw new Error("no statRow band");
	const tile = row.stats.find(stat => stat.label === label);
	if (tile === undefined) throw new Error(`no tile ${label}`);
	return tile;
};

test("C: a zero hint that a sibling tile states is dropped", () => {
	// The screenshot: `API-equivalent estimate` printed the hint `0` while the
	// `Unpriced requests` tile in the same statRow printed the same `0` — the
	// same figure twice, and the extra row pushed the next tile row down.
	// The shipped fixture carries 4,197 unpriced, which is the NON-zero case
	// the sibling test below covers. This test is about the ZERO case, so the
	// cost series' unpriced population is zeroed for this one render.
	const zeroUnpriced = liveData({ costs: { costSeries: COST_SERIES.map(point => ({ ...point, unpricedRequests: 0 })) } });
	const bands = screenBands(opts(specOf("costs"), zeroUnpriced));
	expect(tileOf(bands, "API-equivalent estimate").hint, "the restated zero must go").toBeUndefined();
	expect(tileOf(bands, "Unpriced requests").value, "while the figure itself stays stated").toBe("0");
});

test("C: a NON-ZERO hint always renders, even beside the sibling that states it", () => {
	// The money caveat at work: `7 unpriced` under the estimate is the number
	// that says how much of the total above is a floor, and a sibling tile
	// stating it does not make this one redundant — it makes it confirmed.
	// Narrowly scoped: ONLY a hint that resolves to numeric zero is eligible.
	const spec = probeSpec([{ kind: "statRow", stats: [
		{ label: "API-equivalent estimate", metric: summedCost("cost"), hint: summedCost("unpricedRequests") },
		{ label: "Unpriced requests", metric: summedCost("unpricedRequests") },
	]}]);
	const data = costData([costRow("a", 10, { unpricedRequests: 7 })]);
	expect(tileOf(screenBands(opts(spec, data)), "API-equivalent estimate").hint).toBeDefined();
});

test("C: a zero hint that is the ONLY place its figure appears is kept", () => {
	// Dropping this one would delete information: nothing else on the row
	// states the count, and `0` here still says something — nothing went
	// unmeasured, stated where the caveat belongs.
	const spec = probeSpec([{ kind: "statRow", stats: [
		{ label: "API-equivalent estimate", metric: summedCost("cost"), hint: summedCost("unpricedRequests") },
	]}]);
	const data = costData([costRow("a", 10, { unpricedRequests: 0 })]);
	expect(tileOf(screenBands(opts(spec, data)), "API-equivalent estimate").hint).toBe("0");
});
