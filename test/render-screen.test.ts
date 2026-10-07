/**
 * `src/tui/render/screen.ts` — one `ScreenSpec` to rendered lines.
 *
 * THIS IS THE SEAM. Before it, three screens each invented their own visual
 * structure and consistency was something a reviewer had to notice. After it,
 * every screen is drawn by the same grammar (`band.ts`) from the same data
 * (`spec.ts`), so the only thing left to get wrong is a FIGURE.
 *
 * The tests below are therefore mostly about figures, because the grammar is
 * already pinned by `test/band.test.ts`. Three failure classes matter and none
 * of them throws:
 *
 *  1. A rendered cell containing `undefined`, `NaN` or `[object Object]`. The
 *     resolver returns `null` rather than the string "undefined" precisely so
 *     this cannot happen; the walk over every string in every row is what proves
 *     it, because a single leaked token is invisible in a screenshot.
 *  2. A row wider than the panel. One over-wide row corrupts the overlay's
 *     right border, and it is measured in CELLS, not bytes.
 *  3. A full-width rule. G5 in `band.ts` kills section rules inside a body; this
 *     asserts the whole pipeline still honours it after formatting.
 */

import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";
import { buildAgentTokenShare, buildCostSummary, groupErrorsBySignature } from "@oh-my-pi/omp-stats/client/data/view-models";
import { modelKey } from "@oh-my-pi/omp-stats/client/data/colors";
import { bucketAxis } from "@oh-my-pi/omp-stats/client/data/range";

import { SCREEN_SPECS, type ScreenSpec } from "../src/layout/spec";
import { renderScreen, screenBands, type ScreenRenderOptions } from "../src/tui/render/screen";
import { resolveNumber, resolveSeriesValues, rowsFor } from "../src/layout/resolve";
import { planSeries, renderHostChart } from "../src/tui/charts/host-adapter";
import { planLayout, type LayoutPlan } from "../src/tui/layout";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { PALETTE, SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE, type Range } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { FIXTURE_NOW, AGGREGATE, BY_MODEL, COST_SERIES, messageRow, blankData, emptyData, liveData } from "./fixtures/panel";

ensureThemeSync();

const PRESETS: SymbolPreset[] = ["unicode", "nerd", "ascii"];
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "");
const stripForText = (rows: readonly string[]): string => stripForTest(rows.join("\\n"));

/** What a test varies. Width and rows are inputs to the PLAN, not to the renderer. */
interface View {
	width?: number;
	rows?: number;
	preset?: SymbolPreset;
	range?: Range;
}

function opts(spec: ScreenSpec, data: PanelData, view: View = {}): ScreenRenderOptions {
	const preset = view.preset ?? "unicode";
	return {
		spec,
		data,
		plan: planLayout(view.width ?? 100, view.rows ?? 40, preset),
		preset,
		range: view.range ?? DEFAULT_RANGE,
		now: FIXTURE_NOW,
		fg: (color, text) => theme.fg(color, text),
		bold: text => theme.bold(text),
		palette: theme,
		seriesColorFor: index => SERIES_COLORS[index % SERIES_COLORS.length],
	};
}

const FILLABLE = SCREEN_SPECS.filter(spec => !spec.deferred);

// ─── no leaked non-values, anywhere ──────────────────────────────────────────

const LEAKS: readonly (readonly [string, RegExp])[] = [
	["undefined", /undefined/],
	["NaN", /NaN/],
	["[object Object]", /\[object Object\]/],
	["Infinity", /Infinity/],
];

test("no screen renders undefined, NaN, [object Object] or Infinity in ANY cell", () => {
	const leaks: string[] = [];
	for (const spec of FILLABLE) {
		for (const preset of PRESETS) {
			for (const width of [60, 100, 160]) {
				const rows = renderScreen(opts(spec, liveData(), { preset, width }));
				rows.forEach((row, index) => {
					const text = stripForTest(row);
					for (const [name, pattern] of LEAKS) {
						if (pattern.test(text)) leaks.push(`${spec.id}/${preset}@${width} row ${index}: ${name} in ${JSON.stringify(text)}`);
					}
				});
			}
		}
	}
	expect(leaks, leaks.join("\n")).toEqual([]);
});


// ─── width discipline, 40..200 ───────────────────────────────────────────────

test("no row of any screen exceeds the width, across widths 40..200", () => {
	const over: string[] = [];
	for (const spec of FILLABLE) {
		for (let width = 40; width <= 200; width++) {
			for (const row of renderScreen(opts(spec, liveData(), { width }))) {
				if (visibleWidth(row) > width) {
					over.push(`${spec.id}@${width}: ${visibleWidth(row)} cells — ${JSON.stringify(plain(row))}`);
				}
			}
		}
	}
	expect(over, over.slice(0, 10).join("\n")).toEqual([]);
});

test("no row exceeds the INNER width, so the panel border is never eaten", () => {
	// The panel insets two columns a side. A row at exactly `innerWidth` is
	// correct; a row at `innerWidth + 1` overwrites the border.
	const over: string[] = [];
	for (const spec of FILLABLE) {
		for (const width of [40, 72, 100, 200]) {
			const o = opts(spec, liveData(), { width });
			for (const row of renderScreen(o)) {
				if (visibleWidth(row) > o.plan.innerWidth) over.push(`${spec.id}@${width}: ${visibleWidth(row)} > ${o.plan.innerWidth}`);
			}
		}
	}
	expect(over, over.slice(0, 10).join("\n")).toEqual([]);
});

// ─── G5: the rule must not come back ────────────────────────────────────────

test("G5 survives the whole pipeline: no screen paints a full-width rule", () => {
	const RULE = /[─━═]{3,}/;
	const hits: string[] = [];
	for (const spec of FILLABLE) {
		for (const preset of PRESETS) {
			for (const width of [40, 100, 200]) {
				for (const row of renderScreen(opts(spec, liveData(), { preset, width }))) {
					if (RULE.test(stripForTest(row))) {
						hits.push(`${spec.id}/${preset}@${width}: ${JSON.stringify(plain(row))}`);
					}
				}
			}
		}
	}
	expect(hits, hits.slice(0, 5).join("\n")).toEqual([]);
});


// ─── the empty payload is a DEFINED state ───────────────────────────────────

test("a payload with nothing fetched says so, and invents no figure", () => {
	for (const spec of FILLABLE) {
		const text = stripForText(renderScreen(opts(spec, emptyData())));
		expect(text.length, `${spec.id} rendered nothing at all`).toBeGreaterThan(0);
		// Gain's Reduction tile is the exception that proves the shape: its
		// value is ALWAYS null and the web renders its dash, so the dash plus
		// the recorded-size note survive the empty state while every MEASURED
		// figure still reads as absent.
		if (spec.id === "gain") {
			expect(text, spec.id).toContain("–");
			expect(text, spec.id).not.toMatch(/\$|\d/);
			continue;
		}
		// The words matter: a screen that said nothing at all would read as a
		// broken panel rather than as an answer.
		expect(text, spec.id).toBe("No usage recorded in this range.");
		expect(text, spec.id).not.toMatch(/\$|\d/);
	}
});

test("a payload that WAS fetched and came back empty invents no spend", () => {
	for (const spec of FILLABLE) {
		const text = stripForText(renderScreen(opts(spec, blankData())));
		expect(text.length, `${spec.id} rendered nothing at all`).toBeGreaterThan(0);
		// Nothing happened in this window, which is a real answer. What it must
		// not be is a free-spend claim: "$0.00" here would be indistinguishable
		// from a model carrying an explicit zero price card.
		expect(text, spec.id).not.toContain("$0.00");
		for (const [name, pattern] of LEAKS) expect(text, `${spec.id}/${name}`).not.toMatch(pattern);
	}
});

test("a deferred screen states WHY it cannot be filled instead of rendering nothing", () => {
	const deferred = SCREEN_SPECS.filter(spec => spec.deferred);
	for (const spec of deferred) {
		const text = stripForText(renderScreen(opts(spec, liveData())));
		expect(text.length, spec.id).toBeGreaterThan(0);
		expect(text, spec.id).not.toMatch(/\$[\d,]/);
	}
});

// ─── the honesty rules, end to end ──────────────────────────────────────────

test("a model with no price card reads N/A and one with a real zero reads $0", () => {
	// The single most important rule in the panel, asserted through the whole
	// pipeline rather than at the formatter: the same zero in the payload means
	// two opposite things depending on a field the renderer has to read.
	const models = FILLABLE.find(spec => spec.id === "models")!;
	const text = stripForText(renderScreen(opts(models, liveData())));
	expect(text).toContain("N/A");
	expect(text).toContain("4,197 unpriced");
	expect(text).toMatch(/\$0\b/);
	expect(text).not.toContain("$0.00");
});

test("tokens are never collapsed into one total", () => {
	// 95.5% of this database's tokens are cache reads. One combined figure would
	// be arithmetically true and describe nothing, so the kinds stay separate.
	const overview = FILLABLE.find(spec => spec.id === "overview")!;
	const text = stripForText(renderScreen(opts(overview, liveData())));
	expect(text).toContain("Uncached input");
	expect(text).toContain("Cache read");
	expect(text).toContain("Cache write");
	expect(text).toContain("Output");
});

test("emphasis reaches the grammar as a DECISION, whatever the theme does with it", () => {
	// Not "a row contains a bold escape": that asserts the theme's business, and
	// a theme that renders no bold would fail a renderer that did everything
	// right. What is this module's to decide is that the IR's
	// `emphasis: "primary"` reaches the grammar as `emphasis: "primary"`.
	const overview = FILLABLE.find(spec => spec.id === "overview")!;
	const tiles = screenBands(opts(overview, liveData())).flatMap(band =>
		band.kind === "statRow" ? band.stats : [],
	);
	const primary = tiles.filter(tile => tile.emphasis === "primary");
	expect(primary.length).toBeGreaterThan(0);
	expect(primary.map(tile => tile.label)).toContain("API-equivalent cost");
});

// ─── charts actually plot ────────────────────────────────────────────────────

test("a chart band draws marks, so the grammar is not quietly dropping bodies", () => {
	// A chart that resolved to nothing would render a heading and no rows — a
	// screen that looks finished and shows no data.
	for (const id of ["overview", "activity", "models", "costs", "projects"]) {
		const spec = FILLABLE.find(s => s.id === id)!;
		const text = stripForText(renderScreen(opts(spec, liveData(), { width: 120 })));
		const marks = /[█▓▒░■·▁▂▃▄▅▆▇#.:+*]/g;
		expect(text.match(marks)?.length ?? 0, `${id} drew no chart marks`).toBeGreaterThan(4);
	}
});

test("activity's summary reads like the host: cost, requests, and the window", () => {
	// usage-dashboard.ts:839-848 — bold-accent "Activity" head, dim
	// "$COST · N requests · last W weeks", cost $X integer ≥1 else 2dp,
	// requests compact 1dp. The unpriced count rides on the COST TILE's hint;
	// the grid summary is the host's own totals line, not a second encoding.
	const spec = FILLABLE.find(s => s.id === "activity")!;
	const text = stripForText(renderScreen(opts(spec, liveData(), { width: 120 })));
	expect(text).toMatch(/Activity/);
	expect(text).toMatch(/last \d+ weeks/);
	expect(text).toMatch(/\$\d[\d,]* · [\d.]+[KMB]? requests/);
});

// ─── structure: one grammar for every screen ────────────────────────────────

test("no screen starts or ends on a blank row, and none doubles a blank", () => {
	// G4 restated at the screen level, because a renderer that inserted its own
	// paragraph breaks would still pass a band-level test.
	for (const spec of FILLABLE) {
		const rows = renderScreen(opts(spec, liveData(), { width: 140 }));
		let doubles = 0;
		for (let i = 1; i < rows.length; i++) {
			if (stripForTest(rows[i]) === "" && stripForTest(rows[i - 1]) === "") doubles++;
		}
		expect(doubles, `${spec.id} has consecutive blank rows`).toBe(0);
		expect(stripForText([rows[0]]).trim(), `${spec.id} starts blank`).not.toBe("");
		expect(stripForText([rows.at(-1) ?? ""]), `${spec.id} ends blank`).not.toBe("");
	}
});

test("band order is preserved: the IR's order is the screen's order", () => {
	for (const spec of FILLABLE) {
		const text = stripForText(renderScreen(opts(spec, liveData(), { width: 160 })));
		const titles = spec.bands
			.flatMap(band => (band.kind === "chart" || band.kind === "table" ? [band.title] : []))
			.filter(title => text.includes(title));
		// Search FORWARD from the previous heading. A stat tile can share a word
		// with a later band title ("Folders" is both a tile and a table), and
		// matching the tile would report an ordering failure that is not one.
		let at = 0;
		for (const title of titles) {
			const next = text.indexOf(title, at);
			expect(next, `${spec.id}: "${title}" is missing or out of order`).toBeGreaterThanOrEqual(at);
			at = next + title.length;
		}
	}
});

test("no source citation reaches the body: a citation is for reviewers, not readers", () => {
	// `band.source` records where the port came from. Printing
	// `OverviewRoute.tsx:247-273` on a terminal is developer-facing text in the
	// user's face, so the renderer substitutes a human axis label for it.
	for (const spec of FILLABLE) {
		const text = stripForText(renderScreen(opts(spec, liveData(), { width: 160 })));
		expect(text, spec.id).not.toContain("Route.tsx");
		expect(text, spec.id).not.toContain(".tsx:");
	}
});

// ─── colour discipline ───────────────────────────────────────────────────────

test("no literal colour reaches the screen: every hue comes from the theme", async () => {
	// `theme.fg` is the only source of colour. A hand-written hex would survive
	// every other test here and break the moment the user switched theme, so the
	// check is on the VISIBLE text: an escape sequence the theme itself emits is
	// fine, a `#rrggbb` a renderer typed is not.
	for (const spec of FILLABLE) {
		for (const row of renderScreen(opts(spec, liveData()))) {
			expect(stripForTest(row), spec.id).not.toMatch(/#[0-9a-f]{6}/i);
			// Every escape must be an SGR the theme produces. A private sequence
			// (a cursor move, an OSC) would corrupt the overlay.
			expect(stripForTest(row).replace(/\x1b\[[0-9;]*m/g, ""), spec.id).not.toContain("\x1b");
		}
	}
});

test("complete normalized signatures and model failure counts match upstream on repeated noisy errors", () => {
	const errors = [
		messageRow({ id: 9001, model: "shared", provider: "a", errorMessage: "429 req_abcdef123 after 3 tries", timestamp: FIXTURE_NOW - 60_000 }),
		messageRow({ id: 8002, model: "shared", provider: "b", errorMessage: "429 req_zzzzzz456 after 7 tries", timestamp: FIXTURE_NOW - 30_000 }),
		messageRow({ id: 7003, model: "shared", provider: "a", errorMessage: "429 req_xxxxxx789 after 8 tries", timestamp: FIXTURE_NOW }),
		messageRow({ id: 6004, model: "other", provider: "a", errorMessage: "503 unavailable", timestamp: FIXTURE_NOW - 90_000 }),
	];
	const data = liveData({ errors });
	const upstream = groupErrorsBySignature(errors);
	const groups = rowsFor("errorGroups", data) as typeof upstream;
	expect(groups.map(group => [group.signature, group.count, group.lastSeen])).toEqual(upstream.map(group => [group.signature, group.count, group.lastSeen]));
	expect(rowsFor("errorModels", data)).toEqual([
		{ model: "shared", provider: "a", count: 2 },
		{ model: "shared", provider: "b", count: 1 },
		{ model: "other", provider: "a", count: 1 },
	]);
	expect(resolveNumber({ kind: "derived", name: "signatureFailures", op: "count", of: { kind: "aggregate", source: "errorMessages", field: "errorMessage" } }, data, errors[0])).toBe(3);
	const bands = screenBands(opts(FILLABLE.find(spec => spec.id === "errors")!, data, { width: 200 }));
	const table = bands.find(band => band.kind === "table" && band.title === "Error signatures")!;
	if (table.kind !== "table" || table.rows.kind !== "inline") throw new Error("missing signature rows");
	expect(table.rows.rows).toHaveLength(2);
	expect(table.rows.rows[0]!.Signature).toBe(upstream[0]!.signature);
	expect(table.rows.rows[0]!.Failures).toMatch(/^3 /);
	const chart = bands.find(band => band.kind === "chart" && band.title === "Failures by model")!;
	if (chart.kind !== "chart") throw new Error("missing failure chart");
	const text = stripForTest(chart.chart.render().join("\n"));
	expect(text).toMatch(/shared::a.*2/);
	expect(text).toMatch(/shared::b.*1/);
	expect(text).not.toContain("9001");
});

test("agent token shares follow skewed token usage rather than equal request counts", () => {
	const agents = (["main", "subagent", "advisor"] as const).map((agentType, index) => ({
		agentType, totalRequests: 100, totalCost: 0,
		totalInputTokens: [80, 10, 0][index]!, totalOutputTokens: 0,
		totalCacheReadTokens: [10, 0, 0][index]!, totalCacheWriteTokens: 0,
	}));
	const data = liveData({ overview: { overall: AGGREGATE, byAgentType: agents, timeSeries: [] } });
	const legend = screenBands(opts(FILLABLE.find(spec => spec.id === "overview")!, data)).find(band => band.kind === "legend")!;
	if (legend.kind !== "legend") throw new Error("missing agent legend");
	const expected = buildAgentTokenShare(agents).segments.map(segment => segment.share);
	expect(legend.items.slice(-3).map(item => item.share)).toEqual(expected);
	expect(expected).toEqual([0.9, 0.1, 0]);
});

test("provider-qualified identities stay separate in charts, cost rows and performance trends", () => {
	const first = FIXTURE_NOW - 2 * 86_400_000;
	const axis = [first, first + 86_400_000, first + 2 * 86_400_000];
	const modelSeries = [
		{ timestamp: first, model: "shared", provider: "a", requests: 2 },
		{ timestamp: axis[2]!, model: "shared", provider: "b", requests: 7 },
		{ timestamp: axis[1]!, model: "shared", provider: "a", requests: 3 },
	];
	const performance = modelSeries.map(point => ({ ...point, avgTtft: point.requests * 1000, avgTokensPerSecond: point.requests * 10 }));
	const costSeries = modelSeries.map(point => ({ ...COST_SERIES[0]!, ...point, cost: point.requests }));
	const data = liveData({
		modelDashboard: { byModel: modelSeries.map(point => ({ ...BY_MODEL[0]!, ...point, totalRequests: point.requests })), modelSeries, modelPerformanceSeries: performance },
		costs: { costSeries },
	});
	const ref = { kind: "series", source: "modelSeries", field: "requests", groupBy: "model" } as const;
	expect(resolveSeriesValues(ref, data, modelSeries[0], { axis })).toEqual([2, 3, 0]);
	expect(resolveSeriesValues(ref, data, modelSeries[1], { axis })).toEqual([0, 0, 7]);
	expect(resolveSeriesValues({ ...ref, source: "modelPerformanceSeries", field: "avgTtft" }, data, modelSeries[0], { axis })).toEqual([2000, 3000, 0]);
	const modelChart = screenBands(opts(FILLABLE.find(spec => spec.id === "models")!, data, { width: 200 })).find(band => band.kind === "chart")!;
	if (modelChart.kind !== "chart") throw new Error("missing model chart");
	const text = stripForTest(modelChart.chart.render().join("\n"));
	for (const provider of ["a", "b"]) expect(text).toContain(modelKey("shared", provider));
	expect(text).toMatch(/shared::a.*41\.7%.*5/);
	expect(text).toMatch(/shared::b.*58\.3%.*7/);
	const costTable = screenBands(opts(FILLABLE.find(spec => spec.id === "costs")!, data)).find(band => band.kind === "table")!;
	if (costTable.kind !== "table" || costTable.rows.kind !== "inline") throw new Error("missing cost table");
	expect(costTable.rows.rows.map(row => [row.Model, row.Provider, row.Estimate])).toEqual(buildCostSummary(costSeries).models.map(row => [row.model, row.provider, `$${row.cost.toFixed(2)}`]));
});

test("all fetched table rows survive both conversion and final rendering at narrow and wide widths", () => {
	const count = 81;
	const recent = Array.from({ length: count }, (_, id) => messageRow({ id, model: `row-${id.toString().padStart(3, "0")}`, timestamp: FIXTURE_NOW - id }));
	const data = liveData({ recent, modelDashboard: {
		byModel: recent.map(row => ({ ...BY_MODEL[0]!, model: row.model })), modelSeries: [], modelPerformanceSeries: [],
	}, costs: { costSeries: recent.map(row => ({ ...COST_SERIES[0]!, model: row.model })) } });
	for (const id of ["overview", "requests", "models", "costs"]) {
		for (const width of [40, 160]) {
			const spec = FILLABLE.find(spec => spec.id === id)!;
			const table = screenBands(opts(spec, data, { width })).find(band => band.kind === "table")!;
			if (table.kind !== "table" || table.rows.kind !== "inline") throw new Error("missing full table");
			expect(table.rows.rows, `${id}@${width}`).toHaveLength(count);
			const text = stripForTest(renderScreen(opts(spec, data, { width })).join("\n"));
			for (const row of recent) expect(text, `${id}@${width}`).toContain(row.model);
		}
	}
});

test("sparse succeeded and failed charts densify on the real range, including idle trailing buckets", () => {
	const now = Math.floor(FIXTURE_NOW / 300_000) * 300_000;
	const points = [
		{ timestamp: now - 3_600_000, requests: 10, errors: 3, tokens: 0, cost: 0 },
		{ timestamp: now - 600_000, requests: 4, errors: 1, tokens: 0, cost: 0 },
	];
	const data = liveData({ overview: { overall: AGGREGATE, byAgentType: [], timeSeries: points } });
	const axis = bucketAxis("1h", points.map(point => point.timestamp), 300_000, now);
	const succeeded = axis.map(timestamp => points.filter(point => point.timestamp === timestamp).reduce((sum, point) => sum + point.requests - point.errors, 0));
	const failed = axis.map(timestamp => points.filter(point => point.timestamp === timestamp).reduce((sum, point) => sum + point.errors, 0));
	for (const width of [40, 160]) {
		const options = { ...opts(FILLABLE.find(spec => spec.id === "overview")!, data, { width, range: "1h" }), now };
		const chart = screenBands(options).find(band => band.kind === "chart" && band.title === "Activity")!;
		if (chart.kind !== "chart") throw new Error("missing activity chart");
		const spec = planSeries([{ label: "Succeeded", values: succeeded }, { label: "Failed", values: failed }], {});
		if (!spec) throw new Error("planSeries rejected the activity chart");
		expect(chart.chart.render()).toEqual(renderHostChart(spec, {
			width: options.plan.innerWidth, height: options.plan.barHeight, preset: options.preset, theme: options.palette,
			paint: (color: ThemeColor, text: string) => options.fg(color, text), dim: (text: string) => options.fg(PALETTE.dim, text),
		}));
		const tile = screenBands(options).flatMap(band => band.kind === "statRow" ? band.stats : []).find(tile => tile.label === "Requests")!;
		expect(tile.spark).toEqual(axis.map(timestamp => points.find(point => point.timestamp === timestamp)?.requests ?? 0));
	}
	expect(succeeded.reduce((sum, value) => sum + value, 0)).toBe(10);
	expect(failed.reduce((sum, value) => sum + value, 0)).toBe(4);
	expect(succeeded.at(-1)).toBe(0);
});

test("latency and request timing fields display milliseconds as seconds", () => {
	const overview = liveData({ overview: { overall: { ...AGGREGATE, avgDuration: 125_000, avgTtft: 430 }, byAgentType: [], timeSeries: [] } });
	const tiles = screenBands(opts(FILLABLE.find(spec => spec.id === "overview")!, overview)).flatMap(band => band.kind === "statRow" ? band.stats : []);
	expect(tiles.find(tile => tile.label === "Avg latency")!.value).toBe("125.0s");
	expect(tiles.find(tile => tile.label === "Avg TTFT")!.value).toBe("0.43s");
	const data = liveData({ recent: [messageRow({ duration: 125_000, ttft: 430 })] });
	const requestTiles = screenBands(opts(FILLABLE.find(spec => spec.id === "requests")!, data)).flatMap(band => band.kind === "statRow" ? band.stats : []);
	expect(requestTiles.find(tile => tile.label === "Median duration")!.value).toBe("125.0s");
	expect(requestTiles.find(tile => tile.label === "Median TTFT")!.value).toBe("0.43s");
});
