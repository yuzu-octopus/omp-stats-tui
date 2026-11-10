/**
 * `src/tui/showcase/spec.ts` — the showcase's SECTIONS, declared as `ScreenSpec`s.
 *
 * The showcase does not hand-build a body. It declares sections in the same IR
 * the real screens use (`Band[]` on a `ScreenSpec`) and renders them through the
 * same `renderScreen` → `screenBands` → `renderBands` path, so what the playground
 * demonstrates is the GRAMMAR rather than a parallel renderer beside it. A
 * playground with its own string builder would prove nothing about the panel: it
 * would be a second implementation whose bugs are its own.
 *
 * Six sections, each answering one design question, and together covering every
 * grammar surface (`test/showcase-grammar.test.ts` holds that coverage):
 *
 *   - `tiles`   — stat tiles: emphasis, hints, sparklines, long and short labels.
 *   - `charts`  — every chart primitive, single- AND multi-series, every axis.
 *   - `tables`  — every cell kind, the column drop order, aligned figures.
 *   - `awkward` — a one-record table, a hundred-record one, a null latency, a
 *                 forty-cell label beside a twenty-character figure.
 *   - `states`  — measured zero against unmeasured, and a genuinely flat series.
 *   - `empty`   — the empty RANGE, as a whole-screen state.
 *
 * THE EMPTY RANGE IS WHOLE-SCREEN, and that is chart-redraw's ruling rather than a
 * shortcut: `chartBand` DROPS a band over a source that was never fetched, because
 * "nothing happened in this window" and "nobody asked" are different claims. So the
 * empty range gets its own section, and the "present but flat" case — a payload
 * that WAS fetched and returned all zeroes — is a genuinely third state shown
 * separately in `states`.
 *
 * WHAT THE SHOWCASE DELIBERATELY DOES NOT DECLARE, per the owners of the modules
 * involved, so these are stated here rather than rediscovered as bugs:
 *
 *   - No `custom` band. `renderScreen`'s `toBand` turns every custom band into a
 *     NOTE, so it is the grammar's bypass rather than part of it, and it is being
 *     retired. A showcase that used it would demonstrate the bypass.
 *   - No `StatTile.size`. Dead by design: the panel picks tile columns from
 *     width, and a second size axis with no terminal effect would be a lie in the
 *     IR. `emphasis` is the only size lever that reaches the grammar.
 *   - No wrapped cell. Wrapping is out of the grammar by design — it breaks
 *     one-row-per-record, which every row-count invariant downstream depends on.
 *     The showcase shows TRUNCATION, and its note says so.
 *
 * WHY `needs` IS STILL DECLARED, on a showcase that fetches nothing. Because
 * `NEED_BY_SOURCE` is what makes a spec's declared needs and its refs agree, and
 * `test/showcase-needs.test.ts` asserts the two are consistent — a spec reading a
 * payload it never declared would render an empty band, and the showcase would be
 * exhibiting the panel's silent-empty trap as if it were design.
 */

import type { MetricRef, ScreenSpec } from "../../layout/spec";
import type { PanelData } from "../../data/api";
import {
	AWKWARD_COST,
	AWKWARD_LABEL,
	SHOWCASE_AWKWARD,
	SHOWCASE_EMPTY,
	SHOWCASE_FLAT,
	SHOWCASE_NOW,
	SHOWCASE_RECORD,
} from "./fixtures";

export { AWKWARD_COST, AWKWARD_LABEL, SHOWCASE_NOW };

/**
 * Every need the showcase's sections can read, and every fixture supplies.
 *
 * `rollupStatus` is deliberately absent: the showcase's freshness chrome is
 * fabricated (`SYNC` in `panel.ts`), so no band reads it and the needs↔refs guard
 * would flag it as a declared need with no reader.
 */
const NEEDS: ScreenSpec["needs"] = [
	"overview",
	"modelDashboard",
	"costs",
	"folders",
	"recent",
	"errors",
	"tools",
	"dailyActivity",
	"gain",
];

// ─── Metric shorthands, mirroring spec.ts's own vocabulary ───────────────────

const overall = (field: string) => ({ kind: "aggregate", source: "overall", field }) as const;
const byModel = (field: string) => ({ kind: "aggregate", source: "byModel", field }) as const;
const modelSeries = (field: string) => ({ kind: "series", source: "modelSeries", field }) as const;
const costSeries = (field: string) => ({ kind: "series", source: "costSeries", field }) as const;
const timeSeries = (field: string) => ({ kind: "series", source: "timeSeries", field }) as const;
const dailyActivity = (field: string) => ({ kind: "series", source: "dailyActivity", field }) as const;
const byAgentType = (field: string) => ({ kind: "series", source: "byAgentType", field }) as const;
const recent = (field: string) => ({ kind: "aggregate", source: "recentMessages", field }) as const;
const errors = (field: string) => ({ kind: "aggregate", source: "errorMessages", field }) as const;
const folder = (field: string) => ({ kind: "aggregate", source: "folders", field }) as const;
const tool = (field: string) => ({ kind: "aggregate", source: "toolsByTool", field }) as const;
const toolSeries = (field: string) => ({ kind: "series", source: "toolsSeries", field }) as const;
const gainOverall = (field: string) => ({ kind: "aggregate", source: "gainOverall", field }) as const;

/** A sum over any series source — `dailyActivity` as readily as `timeSeries`. */
const sumOf = (name: string, of: MetricRef) => ({ kind: "derived", name, op: "sum", of }) as const;

const CITATION = {
	file: "src/tui/showcase/spec.ts",
	lines: "this file",
	note: "A SHOWCASE section: declared to exercise the grammar on fixtures, not ported from a web route.",
} as const;

// ─── tiles ───────────────────────────────────────────────────────────────────

/**
 * Stat tiles. The question this section answers is what the tile grid looks like
 * when a tile is asked to carry a long label, a hint that does not fit, and a
 * sparkline at once — three rules the grammar applies independently (`band.ts`:
 * a hint is dropped rather than truncated, the value truncates rather than the
 * label, and a sparkline is drawn only where it will not smear).
 */
const tiles: ScreenSpec = {
	id: "tiles",
	label: "Stat tiles",
	short: "▦",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "API-equivalent cost",
					metric: overall("totalCost"),
					emphasis: "primary",
					hint: overall("unpricedRequests"),
					spark: timeSeries("cost"),
				},
				{
					label: "Requests",
					metric: overall("totalRequests"),
					hint: overall("failedRequests"),
					spark: timeSeries("requests"),
				},
				{ label: "Cache rate", metric: overall("cacheRate"), hint: overall("cacheSavings") },
				{
					label: "Error rate",
					metric: overall("errorRate"),
					hint: overall("successfulRequests"),
					spark: timeSeries("errors"),
				},
			],
		},
		{
			// A wide row at 100 columns and a one-across column at 40: the grid
			// MEASURES its tiles and picks columns, so this row is where a too-wide
			// label stops being able to set the geometry for its neighbours.
			kind: "statRow",
			stats: [
				{ label: "Uncached input", metric: overall("totalInputTokens") },
				{ label: "Cache read", metric: overall("totalCacheReadTokens") },
				{ label: "Cache write", metric: overall("totalCacheWriteTokens") },
				{ label: "Output", metric: overall("totalOutputTokens") },
				{ label: "Premium requests", metric: overall("totalPremiumRequests") },
				{ label: "Tokens/s", metric: overall("avgTokensPerSecond") },
				{ label: "Avg latency", metric: overall("avgDuration") },
				{ label: "Avg TTFT", metric: overall("avgTtft") },
			],
		},
		{
			// THE AWKWARD ROW. A 40-cell label beside a 20-character figure, and a
			// hint longer than its tile — three independent clamps on one row.
			kind: "statRow",
			stats: [
				{
					label: AWKWARD_LABEL,
					metric: byModel("totalCost"),
					emphasis: "primary",
					hint: { text: "forty cells of label beside a twenty-character figure" },
				},
				{
					label: "Total requests",
					metric: overall("totalRequests"),
					hint: { text: "a hint far wider than the tile it sits in" },
				},
				{ label: "x", metric: overall("cacheRate") },
			],
		},
		{
			// One tile: the grid's single-column case, where a sparkline is still drawn
			// (`sparkVisible` is `columns <= 2`).
			kind: "statRow",
			stats: [{ label: "Trend", metric: overall("totalCost"), spark: timeSeries("cost") }],
		},
		{
			// Zero, unmeasured, negative and absent, each on its own tile. The first
			// two are the pair the `unpricedRequests` seam exists for, and the last is
			// the field that is ALWAYS null and must read the web's dash.
			kind: "statRow",
			stats: [
				{ label: "Measured zero", metric: byModel("totalCost"), hint: { text: "a price of zero, which is a real price" } },
				{ label: "Unmeasured", metric: byModel("unpricedRequests"), hint: { text: "spend that could not be measured" } },
				{ label: "Negative", metric: byModel("cacheSavings"), hint: { text: "cache savings can be negative" } },
				{ label: "Absent", metric: gainOverall("reductionPercent"), hint: { text: "never recorded, so never 0.0%" } },
			],
		},
	],
};

// ─── charts ──────────────────────────────────────────────────────────────────

/**
 * Every chart primitive the codebase has, on every axis, single- and multi-series.
 * The question is what the five kinds LOOK like side by side, and whether their ink
 * ladders are actually distinguishable at each width.
 */
const charts: ScreenSpec = {
	id: "charts",
	label: "Charts",
	short: "▤",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			kind: "chart",
			title: "Cost per day",
			chart: { type: "bars", axis: "cost", series: [{ key: "cost", label: "Cost", metric: costSeries("cost") }] },
		},
		{
			// MULTI-SERIES: one band of rows per series, band heights sized by each
			// series' peak RELATIVE to the shared maximum, so magnitude reads ACROSS
			// series the way column height reads within one (`compose.ts`). Four here,
			// and six is the ceiling — the web folds past it.
			kind: "chart",
			title: "Cost by billing component",
			chart: {
				type: "bars",
				axis: "cost",
				series: [
					{ key: "input", label: "Input", metric: costSeries("costInput") },
					{ key: "output", label: "Output", metric: costSeries("costOutput") },
					{ key: "cacheRead", label: "Cache read", metric: costSeries("costCacheRead") },
					{ key: "cacheWrite", label: "Cache write", metric: costSeries("costCacheWrite") },
				],
			},
		},
		{
			kind: "chart",
			title: "Requests per bucket",
			chart: {
				type: "bars",
				axis: "requests",
				series: [
					{ key: "ok", label: "Succeeded", metric: timeSeries("succeededRequests") },
					{ key: "err", label: "Failed", metric: timeSeries("errors") },
				],
			},
		},
		{
			kind: "chart",
			title: "Tokens per bucket",
			chart: {
				type: "sparkline",
				axis: "tokens",
				series: [{ key: "tokens", label: "Tokens", metric: timeSeries("tokens") }],
			},
		},
		{
			kind: "chart",
			title: "Spend over time",
			chart: { type: "sparkline", axis: "time", series: [{ key: "cost", label: "Cost", metric: timeSeries("cost") }] },
		},
		{
			kind: "chart",
			title: "Tool calls per bucket",
			chart: { type: "sparkline", axis: "count", series: [{ key: "calls", label: "Calls", metric: toolSeries("calls") }] },
		},
		{
			kind: "chart",
			title: "Activity",
			chart: {
				type: "heatmap",
				axis: "cost",
				calendar: { orientation: "weeks-as-columns", dayLabels: ["M", "T", "W", "T", "F", "S", "S"] },
				series: [{ key: "cost", label: "Cost per day", metric: dailyActivity("cost") }],
			},
		},
		{
			kind: "chart",
			title: "Cost by model",
			chart: {
				type: "rankedBars",
				axis: "cost",
				foldTo: { limit: 3, label: "Other models" },
				series: [{ key: "cost", label: "Cost", metric: byModel("totalCost") }],
			},
		},
		{
			kind: "chart",
			title: "Requests by model",
			chart: {
				type: "rankedBars",
				axis: "requests",
				foldTo: { limit: 3, label: "Other models" },
				series: [{ key: "requests", label: "Requests", metric: byModel("totalRequests") }],
			},
		},
		{
			kind: "chart",
			title: "Token mix",
			chart: {
				type: "shareBar",
				axis: "share",
				series: [
					{ key: "input", label: "Uncached input", metric: overall("totalInputTokens") },
					{ key: "cacheRead", label: "Cache read", metric: overall("totalCacheReadTokens") },
					{ key: "cacheWrite", label: "Cache write", metric: overall("totalCacheWriteTokens") },
					{ key: "output", label: "Output", metric: overall("totalOutputTokens") },
				],
			},
		},
		{
			// A legend is a CONTINUATION of the chart above it: no heading, no blank
			// line before, exactly one after (G4's deliberate exception). It adopts the
			// shares that chart published, so the two cannot disagree.
			kind: "legend",
			items: [
				{ key: "input", label: "Uncached input", metric: overall("totalInputTokens") },
				{ key: "cacheRead", label: "Cache read", metric: overall("totalCacheReadTokens") },
				{ key: "cacheWrite", label: "Cache write", metric: overall("totalCacheWriteTokens") },
				{ key: "output", label: "Output", metric: overall("totalOutputTokens") },
			],
		},
		{
			// A SECOND legend over a different composition. Two legends on one screen
			// is the case where a reader has to tell them apart, which is a design
			// question rather than a rendering one.
			kind: "legend",
			items: [
				{ key: "main", label: "Main agent", metric: byAgentType("totalRequests") },
				{ key: "subagent", label: "Subagents", metric: byAgentType("totalRequests") },
				{ key: "advisor", label: "Advisor", metric: byAgentType("totalRequests") },
			],
		},
		{
			kind: "note",
			text: "Scaled by COST, never by tokens: this project's own price spread is 41x at comparable token volume, so a token-scaled chart would confidently rank the cheapest model as the smallest.",
		},
	],
};

// ─── tables ──────────────────────────────────────────────────────────────────

/**
 * Every cell kind and every column-drop decision. `Column.priority` is the whole
 * of the truncation policy's second step, so this section declares three tiers: a
 * narrow terminal drops the highest number first and keeps the identity column
 * until nothing else is left.
 */
const tables: ScreenSpec = {
	id: "tables",
	label: "Tables",
	short: "▥",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			kind: "table",
			title: "Latest requests",
			rows: { source: "recentMessages", initialSort: { by: recent("timestamp"), direction: "desc" } },
			columns: [
				{ header: "Model", align: "left", source: recent("model"), cell: "text" },
				{ header: "Provider", align: "left", source: recent("provider"), cell: "text", priority: 3 },
				{ header: "When", align: "left", source: recent("timestamp"), cell: "text", priority: 2 },
				{ header: "Tokens", align: "right", source: recent("usage.totalTokens"), cell: "text", priority: 1 },
				{ header: "Cost", align: "right", source: recent("usage.cost.total"), cell: "text" },
				{ header: "Duration", align: "right", source: recent("duration"), cell: "text", priority: 4 },
				{ header: "Status", align: "right", source: recent("stopReason"), cell: "badge" },
			],
		},
		{
			// A METER cell: the FIGURE first, then a short bar beside it, tinted by
			// status against the column's own maximum. The figure never drops — a
			// magnitude column showing only a bar has told the reader nothing.
			kind: "table",
			title: "Cost by model",
			rows: { source: "byModel" },
			columns: [
				{ header: "Model", align: "left", source: byModel("model"), cell: "text" },
				{ header: "Cost", align: "right", source: byModel("totalCost"), cell: "meter" },
				{ header: "Requests", align: "right", source: byModel("totalRequests"), cell: "meter", priority: 2 },
				{ header: "Cache rate", align: "right", source: byModel("cacheRate"), cell: "text", priority: 1 },
				{ header: "Unpriced", align: "right", source: byModel("unpricedRequests"), cell: "text", priority: 3 },
			],
		},
		{
			// A SPARKLINE cell, composed in `renderCell` rather than in the grammar:
			// it needs a per-row series, which the grammar cannot know.
			kind: "table",
			title: "Model trend",
			rows: { source: "byModel" },
			columns: [
				{ header: "Model", align: "left", source: byModel("model"), cell: "text" },
				{ header: "Trend", align: "left", source: modelSeries("requests"), cell: "sparkline" },
				{ header: "Total", align: "right", source: byModel("totalRequests"), cell: "text", priority: 1 },
			],
		},
		{
			// Long paths and a short one: the identity column measures itself, and past
			// the panel's width it truncates on its OWN value rather than overflowing
			// into the border.
			kind: "table",
			title: "By folder",
			rows: { source: "folders" },
			columns: [
				{ header: "Folder", align: "left", source: folder("folder"), cell: "text" },
				{ header: "Requests", align: "right", source: folder("totalRequests"), cell: "meter" },
				{ header: "Cost", align: "right", source: folder("totalCost"), cell: "text", priority: 1 },
				{ header: "Last used", align: "left", source: folder("lastTimestamp"), cell: "text", priority: 2 },
			],
		},
		{
			kind: "table",
			title: "By tool",
			rows: { source: "toolsByTool" },
			columns: [
				{ header: "Tool", align: "left", source: tool("tool"), cell: "text" },
				{ header: "Calls", align: "right", source: tool("calls"), cell: "meter" },
				{ header: "Errors", align: "right", source: tool("errors"), cell: "badge" },
				{ header: "Result chars", align: "right", source: tool("resultChars"), cell: "text", priority: 3 },
				{ header: "Last used", align: "left", source: tool("lastUsed"), cell: "text", priority: 1 },
			],
		},
		{
			// Every row is a FAILURE here, so the badge column wears the error ink
			// throughout — the case where a uniform column says nothing and the reader
			// has to read the row.
			kind: "table",
			title: "Errors",
			rows: { source: "errorMessages" },
			columns: [
				{ header: "Model", align: "left", source: errors("model"), cell: "text" },
				{ header: "Message", align: "left", source: errors("errorMessage"), cell: "text", priority: 2 },
				{ header: "When", align: "left", source: errors("timestamp"), cell: "text", priority: 1 },
				{ header: "Status", align: "right", source: errors("stopReason"), cell: "badge" },
			],
		},
		{
			kind: "note",
			text: "Narrow columns are DROPPED by declared priority, never squeezed, and the identity column is never dropped: a row whose subject the reader cannot see is a row that cannot be read.",
		},
	],
};

// ─── awkward ─────────────────────────────────────────────────────────────────

/**
 * The deliberately difficult shapes. Every case here is a place the grammar has a
 * decision to make, and the fixture supplying them is `fixtures.ts`: a
 * one-record table, a hundred-record one that must drop and say so, a NULL latency
 * that must render as the host's hyphen rather than a blank, and a forty-cell
 * label beside a twenty-character figure.
 */
const awkward: ScreenSpec = {
	id: "awkward",
	label: "Awkward",
	short: "⚠",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			// Exactly one record. A table with a single row must still draw its header
			// and its one row rather than collapsing to nothing.
			kind: "table",
			title: "A single request",
			rows: { source: "recentMessages" },
			columns: [
				{ header: "Model", align: "left", source: recent("model"), cell: "text" },
				{ header: "Provider", align: "left", source: recent("provider"), cell: "text", priority: 3 },
				{ header: "Tokens", align: "right", source: recent("usage.totalTokens"), cell: "text", priority: 2 },
				{ header: "Duration", align: "right", source: recent("duration"), cell: "text", priority: 1 },
				{ header: "Status", align: "right", source: recent("stopReason"), cell: "badge" },
			],
		},
		{
			// Every fetched failure remains reachable through scrolling.
			kind: "table",
			title: "Every failure",
			rows: { source: "errorMessages" },
			columns: [
				{ header: "Message", align: "left", source: errors("errorMessage"), cell: "text" },
				{ header: "Model", align: "left", source: errors("model"), cell: "text", priority: 3 },
				{ header: "When", align: "left", source: errors("timestamp"), cell: "text", priority: 1 },
				{ header: "Duration", align: "right", source: errors("duration"), cell: "text", priority: 4 },
			],
		},
		{
			kind: "statRow",
			stats: [
				{
					label: AWKWARD_LABEL,
					metric: byModel("totalCost"),
					emphasis: "primary",
					hint: { text: "forty cells of label beside a twenty-character figure" },
				},
				{ label: "Requests", metric: byModel("totalRequests") },
				{ label: "Cache rate", metric: byModel("cacheRate"), hint: byModel("cacheSavings") },
			],
		},
		{
			// Long labels on a share bar, where the label column is capped at half the
			// width: the case where a 40-cell label cannot have the room it wants.
			kind: "chart",
			title: "Share of spend",
			chart: {
				type: "shareBar",
				axis: "share",
				foldTo: { limit: 2, label: "Everything else" },
				series: [{ key: "cost", label: "Cost", metric: byModel("totalCost") }],
			},
		},
		{
			kind: "chart",
			title: "Cost by model",
			chart: { type: "rankedBars", axis: "cost", series: [{ key: "cost", label: "Cost", metric: byModel("totalCost") }] },
		},
		{
			kind: "note",
			text: "A long figure is TRUNCATED on its own digits, never wrapped: wrapping breaks one row per record, which every row-count invariant downstream depends on.",
		},
	],
};

// ─── states ──────────────────────────────────────────────────────────────────

/**
 * Measured zero against unmeasured, and a genuinely FLAT series. The question is
 * whether a reader can tell these apart at a glance, because they are three
 * different claims and only two of them are numbers.
 */
const states: ScreenSpec = {
	id: "states",
	label: "States",
	short: "◇",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			kind: "statRow",
			stats: [
				{ label: "Flat cost", metric: sumOf("flatCost", timeSeries("cost")), hint: { text: "fetched, and every bucket is zero" } },
				{ label: "Activity cost", metric: sumOf("activityCost", dailyActivity("cost")) },
				{ label: "Activity requests", metric: sumOf("activityRequests", dailyActivity("requests")) },
				{ label: "Measured zero", metric: byModel("totalCost"), hint: { text: "a price of zero is a real price" } },
			],
		},
		{
			// Over the FLAT record, so the bars are genuinely all empty rather than
			// merely small: a real chart with nothing in it.
			kind: "chart",
			title: "Cost per day (flat)",
			chart: { type: "bars", axis: "cost", series: [{ key: "cost", label: "Cost", metric: costSeries("cost") }] },
		},
		{
			kind: "chart",
			title: "Requests per bucket (flat)",
			chart: {
				type: "bars",
				axis: "requests",
				series: [
					{ key: "ok", label: "Succeeded", metric: timeSeries("succeededRequests") },
					{ key: "err", label: "Failed", metric: timeSeries("errors") },
				],
			},
		},
		{
			// Measured zero beside unmeasured, on one row. `$0` for the first, `N/A`
			// beside an unpriced count for the second — never `$0.00` for both.
			kind: "table",
			title: "Zero is not unknown",
			rows: { source: "byModel" },
			columns: [
				{ header: "Model", align: "left", source: byModel("model"), cell: "text" },
				{ header: "Cost", align: "right", source: byModel("totalCost"), cell: "meter" },
				{ header: "Unpriced", align: "right", source: byModel("unpricedRequests"), cell: "text" },
			],
		},
		{
			kind: "chart",
			title: "Cost by model",
			chart: { type: "rankedBars", axis: "cost", series: [{ key: "cost", label: "Cost", metric: byModel("totalCost") }] },
		},
		{
			kind: "note",
			text: "An all-zero series is a measured zero and draws a real chart. A source that was never FETCHED is dropped instead, because nothing happened and nobody asked are different claims.",
		},
	],
};

// ─── empty ───────────────────────────────────────────────────────────────────

/**
 * The empty RANGE, as a whole-screen state.
 *
 * Every payload is fetched and every array is empty. `renderScreen` answers that
 * in one dim line of words, because a field of zero-day cells is a claim about
 * someone's usage that happens to be wrong (CONTEXT.md, the loading state) — and
 * `/usage` renders exactly that field, which is the deviation this panel keeps.
 *
 * The two tiles are declared rather than removed, because a section with no bands
 * would not demonstrate anything: they show what the resolver still answers when
 * the rows are gone, and the two notes say which state this is.
 */
const empty: ScreenSpec = {
	id: "empty",
	label: "Empty range",
	short: "○",
	needs: NEEDS,
	source: CITATION,
	bands: [
		{
			kind: "note",
			text: "Every payload below was FETCHED and came back empty — so this is nothing recorded, not nobody asked. A screen whose only surviving bands are notes gets the panel s own one-line answer instead, and that is what is on screen.",
		},
		{
			kind: "note",
			text: "A range with no data is stated in words, never drawn as a field of zero-day cells: a grid of empty days is a claim about someone s usage that happens to be wrong.",
		},
	],
};

// ─── The registry ────────────────────────────────────────────────────────────

/** One showcase section: its identity, its nav metadata, and its declared spec. */
export interface ShowcaseSection {
	readonly id: string;
	readonly label: string;
	/** One cell per preset — the `TAB_SHORT` rule. */
	readonly short: Readonly<Record<"unicode" | "nerd" | "ascii", string>>;
	/** Second key of the `g <key>` jump, as the real nav has. */
	readonly hotkey: string;
	readonly spec: ScreenSpec;
}

/**
 * One section per showcase screen, in tab order. Frozen for the same reason
 * `SCREEN_SPECS` is: a spec mutated at runtime is a spec that will be.
 *
 * The `short` labels are ONE CELL on every preset — the rule `TAB_SHORT` obeys,
 * because a strip that wraps costs the body a row — and they are asserted to be by
 * measurement in `test/showcase-panel.test.ts`.
 */
export const SHOWCASE_SECTIONS: readonly ShowcaseSection[] = Object.freeze([
	{ id: tiles.id, label: tiles.label, short: { unicode: "▦", nerd: "▦", ascii: "#" }, hotkey: "t", spec: tiles },
	{ id: charts.id, label: charts.label, short: { unicode: "▤", nerd: "▤", ascii: "^" }, hotkey: "c", spec: charts },
	{ id: tables.id, label: tables.label, short: { unicode: "▥", nerd: "▥", ascii: "=" }, hotkey: "b", spec: tables },
	{ id: awkward.id, label: awkward.label, short: { unicode: "⚠", nerd: "⚠", ascii: "!" }, hotkey: "a", spec: awkward },
	{
		id: states.id,
		label: states.label,
		short: { unicode: "◇", nerd: "◇", ascii: "o" },
		hotkey: "s",
		spec: states,
	},
	{ id: empty.id, label: empty.label, short: { unicode: "○", nerd: "○", ascii: "-" }, hotkey: "e", spec: empty },
]);

/**
 * The fixture for one section, as the shape `renderScreen` consumes.
 *
 * Four records, not one: the ordinary one, the empty one, the all-zero-flat one
 * and the awkward one. The mapping is a chain of conditionals rather than a spread
 * of `??` fallbacks because a section asking for a record that does not exist is a
 * bug worth naming, not one to paper over with the ordinary fixture.
 */
export function showcaseData(sectionId: string): PanelData {
	const record =
		sectionId === empty.id
			? SHOWCASE_EMPTY
			: sectionId === states.id
				? SHOWCASE_FLAT
				: sectionId === awkward.id
					? SHOWCASE_AWKWARD
					: SHOWCASE_RECORD;
	// `PanelData` widens the request rows upstream declares as a shape the route
	// does not actually return; the cast is at the SEAM and nowhere else, exactly
	// as in `test/fixtures/panel.ts`. Inside `fixtures.ts` the rows are the shape
	// `rowToMessageStats` builds, and every reader goes through the resolver's
	// string-keyed path.
	return record as unknown as PanelData;
}