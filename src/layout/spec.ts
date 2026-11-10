/**
 * THE LAYOUT IR — an intermediate representation of the web dashboard.
 *
 * PROBE/TEST FIXTURE, NOT A PRODUCTION RENDER PATH. The ScreenSpec → renderScreen →
 * renderBands stack is live ONLY for /stats-test (its own showcase specs),
 * scripts/probe-render.ts, the panel's fixture branch, and tests — never a
 * production /stats-tui body.
 *
 * WHY THIS FILE EXISTS
 *
 * The three hand-written screens each invented their own visual structure.
 * Overview opens with a stat strip, a token list, a bar chart and a model
 * ranking; Activity opens with a calendar; Models opens with a model ranking
 * and then per-model blocks. Nothing connects them. The panel reads as three
 * unrelated text blocks rather than as one ported dashboard, and every new
 * screen has to invent a fourth grammar. That is not a styling bug — it is a
 * missing level of abstraction.
 *
 * So the visual structure moves down into DATA. A screen is a `ScreenSpec`: a
 * stack of bands, each naming the metrics it needs and how it is composed. A
 * renderer (a later task) turns bands into `pi-tui` components. Three things
 * follow, and they are the whole argument:
 *
 *   1. THE VISUAL GRAMMAR BECOMES A DATA DECISION. Adding a stat tile to a
 *      screen is adding an object to an array, not editing a `render`.
 *   2. THE THREE SCREENS ARE PROVABLY CONSISTENT, because there is one grammar
 *      and all three draw from it. Consistency stops being something a reviewer
 *      has to notice.
 *   3. A NEW SCREEN IS A DATA CHANGE, NOT A REWRITE.
 *
 * WHAT THE IR DELIBERATELY DOES NOT KNOW
 *
 * No glyphs, no colours, no widths, no presets. Those are renderer concerns, and
 * encoding them here would make the grammar a rendering policy a second screen
 * could quietly violate. A band that needs to say "this matters" says
 * `emphasis: "primary"`; how emphasis LOOKS is the renderer's problem, and
 * changing it must not mean editing ten screens. For the same reason there is no
 * `if (ascii)` here — and no width, because how a band behaves at 40 columns is
 * not a fact about the dashboard's structure. `test/layout-ir.test.ts` asserts
 * all of that against the serialised data rather than trusting this comment.
 *
 * METRIC REFERENCES
 *
 * A `MetricRef` names a VALUE and never says how that value reads:
 * `"$1,039.27 · 34,870 unpriced"` and `"112.36"` come from the same field.
 * Separating what is shown from how it is formatted is what lets one screen show
 * a cost as a headline and another show the same cost as a table cell without
 * either hard-coding the other's choice.
 *
 * Every import below is `import type`, which the test asserts. This module's
 * only runtime content is its own data, because an IR that can compute is an
 * IR that will eventually contain the rendering it was meant to describe.
 *
 * SOURCES
 *
 * Every spec cites the route file and line range it was ported from, so a later
 * agent can diff the port against the original instead of trusting it.
 */

import type { DataNeed } from "../data/api";

// ─── Metrics ─────────────────────────────────────────────────────────────────

/**
 * Which payload a metric is read from. Each source maps to at most one
 * `DataNeed`, and `NEED_BY_SOURCE` is that map — it is the whole reason the IR
 * can be checked against the data seam instead of against opinion.
 *
 * The network-only windows payload has NO source: the panel never fetches
 * `/api/stats/provider-windows`, so the IR cannot name it either.
 */
export type MetricSource =
	| "overall"
	| "byAgentType"
	| "timeSeries"
	| "byModel"
	| "modelSeries"
	| "modelPerformanceSeries"
	| "costSeries"
	| "folders"
	| "recentMessages"
	| "errorMessages"
	| "errorGroups"
	| "errorModels"
	| "toolsByTool"
	| "toolsByToolModel"
	| "toolsSeries"
	| "dailyActivity"
	| "rollupStatus"
	| "providerStats"
	| "gainOverall"
	| "gainBySource"
	| "gainSeries";

/** A field read off one aggregated row — `overall`, or the first row of a grouped array. */
export interface AggregateRef {
	kind: "aggregate";
	source: MetricSource;
	/** Dotted path into the payload row. `"usage.totalTokens"` is legal. */
	field: string;
}

/**
 * A row's TEXT rather than a number — the "Most used" stat shows which model won,
 * not how much of it there was. Same resolution rules as a number; a different
 * kind of value, and the IR is the place that distinction belongs.
 */
export interface LabelRef {
	kind: "label";
	source: MetricSource;
	field: string;
}

/** A field read per row of a grouped series. */
export interface SeriesRef {
	kind: "series";
	source: MetricSource;
	field: string;
	/** What the rows are grouped by, when the grouping is itself part of the fact shown. */
	groupBy?: "model" | "provider" | "tool" | "folder";
}

/**
 * A value the host computes rather than stores: a sum across token kinds, a
 * share of a total, a distinct count. Named, not implemented — the IR says the
 * tile shows "models used", and the renderer resolves it against the payload.
 */
export interface DerivedRef {
	kind: "derived";
	name: string;
	of: MetricRef;
	op: "sum" | "share" | "count" | "max";
	/** For `share`: what this is a share OF. For `max`: the rows to take the max over. */
	against?: MetricRef;
	/**
	 * For `share`: `"total"` divides by the GRAND total (a table Share column
	 * divides the row by the screen total). Absent means the row's own scope,
	 * which is what per-row rates divide by.
	 */
	againstScope?: "total";
}

export type MetricRef = AggregateRef | SeriesRef | DerivedRef | LabelRef;

/**
 * "Which fetch fills this source." Exported because the test that checks every
 * band is fillable reads it, and a table nobody can check is a comment.
 */
export const NEED_BY_SOURCE: Readonly<Record<MetricSource, DataNeed | null>> = {
	overall: "overview",
	byAgentType: "overview",
	timeSeries: "overview",
	byModel: "modelDashboard",
	modelSeries: "modelDashboard",
	modelPerformanceSeries: "modelDashboard",
	costSeries: "costs",
	folders: "folders",
	recentMessages: "recent",
	errorMessages: "errors",
	errorGroups: "errors",
	errorModels: "errors",
	toolsByTool: "tools",
	toolsByToolModel: "tools",
	toolsSeries: "tools",
	dailyActivity: "dailyActivity",
	rollupStatus: "rollupStatus",
	// `providerStats` reads the DB-backed `/api/stats/providers` aggregates —
	// per-provider totals, hourly burn, per-provider series. The NETWORK route
	// (`provider-windows`) stays out of the load path; the providers spec's note
	// names that boundary.
	providerStats: "providers",
	gainOverall: "gain",
	gainBySource: "gain",
	gainSeries: "gain",
};

/** Every metric reachable from a reference, itself first. */
export function metricRefsOf(ref: MetricRef): readonly MetricRef[] {
	if (ref.kind !== "derived") return [ref];
	return [ref, ...metricRefsOf(ref.of), ...(ref.against ? metricRefsOf(ref.against) : [])];
}

/** The payload a reference ultimately reads, following `derived` to its base. */
export function sourceOf(ref: MetricRef): MetricSource {
	return ref.kind === "derived" ? sourceOf(ref.of) : ref.source;
}

// ─── Bands ───────────────────────────────────────────────────────────────────

/** One figure with a label. The IR says what it measures; a formatter says how it reads. */
export interface StatTile {
	label: string;
	metric: MetricRef;
	/**
	 * A secondary figure under the primary, where the web route shows a hint. THREE
	 * shapes, because a hint is three different things and the IR has to say which:
	 *
	 *   - `MetricRef` — a SECOND FIGURE, read against the payload and formatted by
	 *     its own field's formatter. `hint: overall("unpricedRequests")` is the whole
	 *     reason a cost tile can print `$0` and still not lie.
	 *   - `string` — PROSE, printed verbatim. A caveat in words ("original size not
	 *     recorded") is not a number and must never be run through a formatter.
	 *   - `{ text: string }` — the same prose, spelled as an object.
	 *
	 * WHY BOTH PROSE FORMS. The object wrapper was the original and it is what every
	 * spec in this file uses, but it is a shape that exists only to be mis-guessed: a
	 * reader writing `hint: "a caveat in prose"` — the obvious reading — was not
	 * wrong, and the IR had no way to say so. It failed at RENDER time, in a session,
	 * as a crash in the middle of one tile, because the consumer's `"text" in hint`
	 * guard threw on a primitive.
	 *
	 * The bare string is therefore legal and MEANS SOMETHING DIFFERENT from the
	 * object. It is not an alias kept for symmetry: `{ text }` stays because it
	 * disambiguates at a glance when a value is spread across lines. Consumers MUST
	 * handle all three — use {@link isProseHint} rather than an `in` check, which is
	 * what threw in the first place.
	 */
	hint?: MetricRef | string | { text: string };
	/** Marks the tile a reader should land on. The renderer decides what that looks like. */
	emphasis?: "normal" | "primary";
	/** A trend line drawn inside the tile, as `Stat spark={…}` does in the web app. */
	spark?: MetricRef;
	/** The tile's size in the web grid, carried so a narrow renderer can drop the smalls first. */
	size?: "sm" | "md";
}

/**
 * Is this hint PROSE rather than a figure?
 *
 * A type guard, not a convenience, and it exists because the obvious test for it
 * was wrong. `"text" in hint` throws a `TypeError` on a bare `string` — the `in`
 * operator requires an object on its right — so the check that was supposed to
 * distinguish prose from a figure instead CRASHED on one of the three legal hint
 * shapes, at render time, in someone's session.
 *
 * It is exported so every consumer narrows through the same rule. A hint can now
 * be a `MetricRef`, a `string` or `{ text: string }`, and each of those has to be
 * told apart from the other two — a `typeof` check for the primitive, an `in`
 * check for the object, and what is left is the ref.
 */
export function isProseHint(hint: StatTile["hint"]): hint is string | { text: string } {
	return typeof hint === "string" || (typeof hint === "object" && hint !== null && "text" in hint);
}

/**
 * The prose a prose hint carries, or `null` when the hint is a figure.
 *
 * Both prose forms normalise to one string, so a consumer that only wants to
 * PRINT a hint never has to branch on which form the spec author chose — and
 * cannot get it wrong by assuming the object form.
 */
export function proseHintText(hint: StatTile["hint"]): string | null {
	if (typeof hint === "string") return hint;
	if (typeof hint === "object" && hint !== null && "text" in hint) return hint.text;
	return null;
}

/** One named series inside a chart band. */
export interface ChartSeries {
	key: string;
	label: string;
	metric: MetricRef;
}

/** How a chart is composed. Named, never drawn. */
export interface ChartSpec {
	type: "bars" | "sparkline" | "heatmap" | "rankedBars" | "shareBar";
	series: readonly ChartSeries[];
	/** The axis the chart measures. Stated so a renderer cannot quietly pick a friendlier one. */
	axis: "cost" | "requests" | "tokens" | "count" | "share" | "time";
	/** Groups folded into one trailing row, as `pivotSeries`'s `Other (n)` does. */
	foldTo?: { limit: number; label: string };
	/** The grid a calendar heatmap lays out into. */
	calendar?: { orientation: "weeks-as-columns"; dayLabels: readonly string[] };
	/** Rows a table-like chart shows before folding. */
	limit?: number;
}

/** Where a table's rows come from, and the order it lands in. */
export interface RowSource {
	source: MetricSource;
	initialSort?: { by: MetricRef; direction: "asc" | "desc" };
}

export interface Column {
	header: string;
	align: "left" | "right";
	source: MetricRef;
	/** What sits inside the cell, where the web table is not plain text. */
	cell?: "text" | "meter" | "sparkline" | "badge";
	/** The row carries a detail block, as the web models table expands. */
	expandable?: boolean;
	/**
 * How readily a narrow terminal may DROP this column. Higher goes first; 0
	 * survives until only the identity column is left.
	 *
	 * The web declares no priority — a CSS table scrolls horizontally rather
	 * than losing a column — so this is the terminal's own decision, and it is
	 * declared HERE rather than inferred in the renderer so that the order a
	 * screen drops its columns in is reviewable next to the columns themselves.
	 * The IR's column ORDER is the web's order, and that order is the default
	 * priority: the route lists what matters first, so a narrow terminal keeps
	 * what it listed first.
	 */
	priority?: number;
}

export interface LegendItem {
	key: string;
	label: string;
	metric: MetricRef;
}

export type Band =
	| { kind: "statRow"; stats: readonly StatTile[] }
	| { kind: "chart"; title: string; chart: ChartSpec; source?: string }
	| { kind: "table"; title: string; columns: readonly Column[]; rows: RowSource; source?: string }
	| { kind: "legend"; items: readonly LegendItem[]; source?: string }
	| { kind: "note"; text: string }

/** Metrics reachable from a band. `note` carries none, which is why it has no fields. */
function refsInBand(band: Band): readonly MetricRef[] {
	switch (band.kind) {
		case "statRow":
			return band.stats.flatMap(t => metricRefsOf(t.metric));
		case "chart":
			return band.chart.series.flatMap(s => metricRefsOf(s.metric));
		case "legend":
			return band.items.flatMap(i => metricRefsOf(i.metric));
		case "table":
			return band.columns.flatMap(c => metricRefsOf(c.source));
		case "note":
			return [];
	}
}

// ─── Screen ──────────────────────────────────────────────────────────────────

/** Where a spec was ported from, so the port is auditable rather than trusted. */
export interface SourceCitation {
	/** Route or overlay file in the host package. */
	file: string;
	/** Line range of the region ported. */
	lines: string;
	/** Anything a reader would need in order to check the port. */
	note?: string;
}

export interface ScreenSpec {
	id: string;
	label: string;
	short: string;
	/** Exactly the data this screen draws, in the data seam's vocabulary. */
	needs: readonly DataNeed[];
	bands: readonly Band[];
	source: SourceCitation;
}

// ─── Shared metric shorthands ────────────────────────────────────────────────
//
// Named once, reused across specs. Not a registry and not a branch: these are
// the payload fields the dashboard actually reads, spelled out so a typo is a
// compile error rather than a blank cell.

const overall = (field: string): AggregateRef => ({ kind: "aggregate", source: "overall", field });
const byModel = (field: string): AggregateRef => ({ kind: "aggregate", source: "byModel", field });
const modelSeries = (field: string, groupBy?: SeriesRef["groupBy"]): SeriesRef => ({
	kind: "series",
	source: "modelSeries",
	field,
	groupBy,
});
const costSeries = (field: string, groupBy?: SeriesRef["groupBy"]): SeriesRef => ({
	kind: "series",
	source: "costSeries",
	field,
	groupBy,
});
const timeSeries = (field: string): SeriesRef => ({ kind: "series", source: "timeSeries", field });
const gainOverall = (field: string): AggregateRef => ({ kind: "aggregate", source: "gainOverall", field });

/**
 * `sumConversationTokens` in the web app: uncached input + cache reads + cache
 * writes + output. The token kinds are deliberately NOT collapsed into one field
 * anywhere, because a single total on ~95% cache-read data describes nothing.
 */
const conversationTokens = (source: "overall" | "byModel" | "folders"): DerivedRef => ({
	kind: "derived",
	name: "conversationTokens",
	op: "sum",
	of: { kind: "aggregate", source, field: "totalInputTokens" },
	against: { kind: "aggregate", source, field: "totalCacheReadTokens" },
});

// ─── Specs ───────────────────────────────────────────────────────────────────

const overview: ScreenSpec = {
	id: "overview",
	label: "Overview",
	short: "Overview",
	needs: ["overview", "recent", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/OverviewRoute.tsx",
		lines: "63-276",
		note:
			"Two StatGrids (102-155), then a two-up grid of the Activity chart and the Token mix card (160-245), then the Latest requests table (247-273). The route's requests/tokens/cost Segmented control is NOT ported: a panel has no place to put a mode switch, so the default metric is declared and the alternatives are recorded in a note band.",
	},
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
				{
					label: "Conversation tokens",
					metric: conversationTokens("overall"),
					hint: overall("totalOutputTokens"),
					spark: timeSeries("tokens"),
				},
				{
					label: "Cache rate",
					metric: overall("cacheRate"),
					hint: overall("cacheSavings"),
				},
				{
					label: "Error rate",
					metric: overall("errorRate"),
					hint: overall("successfulRequests"),
					spark: timeSeries("errors"),
				},
			],
		},
		{
			kind: "statRow",
			stats: [
				{ label: "Uncached input", metric: overall("totalInputTokens"), size: "sm" },
				{ label: "Cache read", metric: overall("totalCacheReadTokens"), size: "sm" },
				{ label: "Cache write", metric: overall("totalCacheWriteTokens"), size: "sm" },
				{ label: "Output", metric: overall("totalOutputTokens"), size: "sm" },
				{ label: "Premium requests", metric: overall("totalPremiumRequests"), size: "sm" },
				{ label: "Tokens/s", metric: overall("avgTokensPerSecond"), size: "sm" },
				{ label: "Avg latency", metric: overall("avgDuration"), size: "sm" },
				{ label: "Avg TTFT", metric: overall("avgTtft"), size: "sm" },
			],
		},
		{
			kind: "chart",
			title: "Activity",
			source: "OverviewRoute.tsx:161-179",
			chart: {
				type: "bars",
				axis: "requests",
				series: [
					{ key: "ok", label: "Succeeded", metric: { kind: "series", source: "timeSeries", field: "succeededRequests" } },
					{ key: "err", label: "Failed", metric: timeSeries("errors") },
				],
			},
		},
		{
			kind: "chart",
			title: "Token mix",
			source: "OverviewRoute.tsx:181-244",
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
			kind: "legend",
			source: "OverviewRoute.tsx:203-210, 224-238",
			items: [
				{ key: "input", label: "Uncached input", metric: overall("totalInputTokens") },
				{ key: "cacheRead", label: "Cache read", metric: overall("totalCacheReadTokens") },
				{ key: "cacheWrite", label: "Cache write", metric: overall("totalCacheWriteTokens") },
				{ key: "output", label: "Output", metric: overall("totalOutputTokens") },
				{ key: "main", label: "Main agent", metric: { kind: "derived", name: "agentTokens:main", op: "sum", of: { kind: "aggregate", source: "byAgentType", field: "totalInputTokens" } } },
				{ key: "subagent", label: "Subagents", metric: { kind: "derived", name: "agentTokens:subagent", op: "sum", of: { kind: "aggregate", source: "byAgentType", field: "totalInputTokens" } } },
				{ key: "advisor", label: "Advisor", metric: { kind: "derived", name: "agentTokens:advisor", op: "sum", of: { kind: "aggregate", source: "byAgentType", field: "totalInputTokens" } } },
			],
		},
		{
			kind: "table",
			title: "Latest requests",
			source: "OverviewRoute.tsx:247-273, columns 278-314",
			rows: { source: "recentMessages", initialSort: { by: { kind: "aggregate", source: "recentMessages", field: "timestamp" }, direction: "desc" } },
			columns: [
				{ header: "Model", align: "left", source: { kind: "aggregate", source: "recentMessages", field: "model" } },
				{ header: "Provider", align: "left", source: { kind: "aggregate", source: "recentMessages", field: "provider" } },
				{ header: "When", align: "left", source: { kind: "aggregate", source: "recentMessages", field: "timestamp" } },
				{ header: "Tokens", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.totalTokens" } },
				{ header: "Cost", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.cost.total" } },
				{ header: "Duration", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "duration" } },
				{
					// The web's Status column is `REQUEST_STATUS[requestStatus(row)]`
					// (RequestsRoute.tsx:298-303), and `requestStatus` reads
					// `stopReason` FIRST — `aborted` is its own outcome, not a failure
					// (view-models.ts:325-328). Keying this on `errorMessage` alone
					// therefore lost the abort outcome entirely, and a successful
					// request resolved to `null` and rendered as a BLANK cell under a
					// header every row is meant to fill.
					header: "Status",
					align: "right",
					cell: "badge",
					source: { kind: "aggregate", source: "recentMessages", field: "stopReason" },
				},
			],
		},
		{
			kind: "note",
			text: "The web Activity card offers requests, tokens or cost; a panel has no mode switch, so this screen draws requests and the series are named so a renderer can swap them.",
		},
	],
};

const activity: ScreenSpec = {
	id: "activity",
	label: "Activity",
	short: "Activity",
	needs: ["dailyActivity", "costs", "rollupStatus"],
	source: {
		file: "@oh-my-pi/pi-tui/src/overlays/usage-dashboard.ts",
		lines: "305-345 (buildHeatmapLayout), 467-476 (totals), 824-875 (#renderHeatmap)",
		note:
			"THE WEB DASHBOARD HAS NO ACTIVITY ROUTE. The calendar lives in omp's own /usage overlay, fed by the same local calendar-day points, so this spec is ported from there and not from routes/. Totals come from formatActivityTotals; the day labels are HEATMAP_DAY_LABELS (M T W T F S S, Monday first).",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Activity cost",
					metric: { kind: "derived", name: "totalCost", op: "sum", of: { kind: "series", source: "dailyActivity", field: "cost" } },
					emphasis: "primary",
				},
				{
					label: "Activity requests",
					metric: { kind: "derived", name: "totalRequests", op: "sum", of: { kind: "series", source: "dailyActivity", field: "requests" } },
				},
			],
		},
		{
			kind: "chart",
			title: "Activity",
			source: "usage-dashboard.ts:313-345",
			chart: {
				type: "heatmap",
				axis: "cost",
				calendar: { orientation: "weeks-as-columns", dayLabels: ["M", "T", "W", "T", "F", "S", "S"] },
				series: [
					{
						key: "cost",
						label: "Cost per day",
						metric: { kind: "series", source: "dailyActivity", field: "cost" },
					},
				],
			},
		},
		{
			kind: "note",
			text: "Levels are square-root compressed against the busiest day, over per-day cost, falling back to request counts when nothing in range has priced usage — never rank quartiles, because intensity tracks how much work a day carried.",
		},
	],
};

const models: ScreenSpec = {
	id: "models",
	label: "Models",
	short: "Models",
	needs: ["modelDashboard", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/ModelsRoute.tsx",
		lines: "61-214 (page), 88-118 (StatGrid), 124-172 (Request share card), 174-211 (All models card), 311-433 (buildModelColumns)",
		note:
			"Column set and order are buildModelColumns verbatim, including the per-row Trend sparkline. The route's share/requests Segmented control is recorded as a fold, not ported as a switch.",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Models used",
					metric: { kind: "derived", name: "modelCount", op: "count", of: byModel("totalRequests") },
				},
				{
					label: "Most used",
					metric: { kind: "derived", name: "mostUsedModel", op: "sum", of: byModel("totalRequests") },
				},
				{
					label: "Requests",
					metric: { kind: "derived", name: "totalRequests", op: "sum", of: byModel("totalRequests") },
					hint: { kind: "derived", name: "failedRequests", op: "sum", of: byModel("failedRequests") },
					spark: modelSeries("requests", "model"),
				},
				{
					label: "API-equivalent cost",
					metric: { kind: "derived", name: "totalCost", op: "sum", of: byModel("totalCost") },
					hint: { kind: "derived", name: "unpricedRequests", op: "sum", of: byModel("unpricedRequests") },
					emphasis: "primary",
				},
			],
		},
		{
			kind: "chart",
			title: "Request share",
			source: "ModelsRoute.tsx:124-172",
			chart: {
				type: "shareBar",
				axis: "share",
				foldTo: { limit: 6, label: "Other" },
				series: [
					{
						key: "requests",
						label: "Requests per bucket",
						metric: modelSeries("requests", "model"),
					},
				],
			},
		},
		{
			kind: "table",
			title: "All models",
			source: "ModelsRoute.tsx:174-211, 311-433",
			rows: {
				source: "byModel",
				initialSort: { by: byModel("totalRequests"), direction: "desc" },
			},
			columns: [
				{
					header: "Model",
					align: "left",
					source: { kind: "label", source: "byModel", field: "model" },
					expandable: true,
				},
				{ header: "Provider", align: "left", source: { kind: "label", source: "byModel", field: "provider" } },
				{ header: "Requests", align: "right", cell: "meter", source: byModel("totalRequests") },
				{ header: "Cost", align: "right", source: byModel("totalCost") },
				{ header: "Tokens", align: "right", source: conversationTokens("byModel") },
				{ header: "Cache rate", align: "right", source: byModel("cacheRate") },
				{ header: "Errors", align: "right", cell: "badge", source: byModel("errorRate") },
				{ header: "Tokens/s", align: "right", source: byModel("avgTokensPerSecond") },
				{ header: "TTFT", align: "right", source: byModel("avgTtft") },
				{
					header: "Trend",
					align: "right",
					cell: "sparkline",
					source: modelSeries("requests", "model"),
				},
			],
		},
		{
			kind: "note",
			text: "Per-model token and cost figures are shares of the assistant turn that asked for them, not measurements of each call; a table row must not present them as per-call cost.",
		},
	],
};

const costs: ScreenSpec = {
	id: "costs",
	label: "Costs",
	short: "Costs",
	needs: ["costs", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/CostsRoute.tsx",
		lines: "90-149 (Daily estimate card), 150-156 (Where it went card), 157-171 (By model card), 246-280 (StatGrid), 323-405 (columns)",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "API-equivalent estimate",
					metric: { kind: "derived", name: "totalCost", op: "sum", of: costSeries("cost", "model") },
					emphasis: "primary",
					hint: { kind: "derived", name: "unpricedRequests", op: "sum", of: costSeries("unpricedRequests", "model") },
				},
			{
				label: "Average per day",
				// `avgDailyCost`, NOT `max`: the dashboard divides the total by the
				// days that carried usage. `max` over the same series is the busiest
				// day, which is a real number and a different one.
				metric: { kind: "derived", name: "avgDailyCost", op: "sum", of: costSeries("cost", "model") },
				hint: { kind: "derived", name: "unpricedRequests", op: "sum", of: costSeries("unpricedRequests", "model") },
			},
			{
				label: "Top model",
				// `topModel`, NOT the first row: the cost payload is in bucket order,
				// so row 0 is whatever model was cheapest on the earliest day.
				metric: { kind: "derived", name: "topModel", op: "sum", of: costSeries("cost", "model") },
			},
			{
				label: "Per priced request",
				metric: { kind: "derived", name: "perPricedRequest", op: "sum", of: costSeries("cost", "model") },
			},
			{
				label: "Unpriced requests",
				metric: { kind: "derived", name: "unpricedRequests", op: "sum", of: costSeries("unpricedRequests", "model") },
			},
			],
		},
		{
			kind: "chart",
			title: "Daily estimate",
			source: "CostsRoute.tsx:90-149",
			chart: {
				type: "bars",
				axis: "cost",
				series: [
					{ key: "costInput", label: "Input", metric: costSeries("costInput", "model") },
					{ key: "costOutput", label: "Output", metric: costSeries("costOutput", "model") },
					{ key: "costCacheRead", label: "Cache read", metric: costSeries("costCacheRead", "model") },
					{ key: "costCacheWrite", label: "Cache write", metric: costSeries("costCacheWrite", "model") },
				],
			},
		},
		{
			kind: "chart",
			title: "Where it went",
			source: "CostsRoute.tsx:150-156, 284-318 (ComponentBreakdown)",
			chart: {
				type: "shareBar",
				axis: "share",
				series: [
					{ key: "costInput", label: "Input", metric: costSeries("costInput", "model") },
					{ key: "costOutput", label: "Output", metric: costSeries("costOutput", "model") },
					{ key: "costCacheRead", label: "Cache read", metric: costSeries("costCacheRead", "model") },
					{ key: "costCacheWrite", label: "Cache write", metric: costSeries("costCacheWrite", "model") },
				],
			},
		},
		{
			kind: "legend",
			source: "CostsRoute.tsx:134-149",
			items: [
				{ key: "costInput", label: "Input", metric: costSeries("costInput", "model") },
				{ key: "costOutput", label: "Output", metric: costSeries("costOutput", "model") },
				{ key: "costCacheRead", label: "Cache read", metric: costSeries("costCacheRead", "model") },
				{ key: "costCacheWrite", label: "Cache write", metric: costSeries("costCacheWrite", "model") },
			],
		},
		{
			kind: "table",
			title: "By model",
			source: "CostsRoute.tsx:157-171, 320-413 (buildCostColumns)",
			rows: {
				source: "costSeries",
				initialSort: { by: costSeries("cost", "model"), direction: "desc" },
			},
			columns: [
				{ header: "Model", align: "left", source: { kind: "label", source: "costSeries", field: "model" } },
				{ header: "Provider", align: "left", source: { kind: "label", source: "costSeries", field: "provider" } },
				{ header: "Requests", align: "right", source: costSeries("requests", "model") },
				{ header: "Estimate", align: "right", source: costSeries("cost", "model") },
				{ header: "Share", align: "right", source: { kind: "derived", name: "modelCostShare", op: "share", of: costSeries("cost", "model"), againstScope: "total", against: { kind: "derived", name: "totalCost", op: "sum", of: costSeries("cost", "model") } } },
				{ header: "Input", align: "right", source: costSeries("costInput", "model") },
				{ header: "Output", align: "right", source: costSeries("costOutput", "model") },
				{ header: "Cache read", align: "right", source: costSeries("costCacheRead", "model") },
				{ header: "Cache write", align: "right", source: costSeries("costCacheWrite", "model") },
				{ header: "Per request", align: "right", source: { kind: "derived", name: "modelUnitCost", op: "share", of: costSeries("cost", "model"), against: costSeries("requests", "model") } },
				{ header: "Unpriced", align: "right", source: costSeries("unpricedRequests", "model") },
			],
		},
		{
			kind: "note",
			text: "Bars scale by cost, never by tokens: this data carries a 41x price spread at comparable token volume, and a token-scaled chart inverts the ranking.",
		},
	],
};

const projects: ScreenSpec = {
	id: "projects",
	label: "Projects",
	short: "Projects",
	needs: ["folders", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/ProjectsRoute.tsx",
		lines: "78-117 (StatGrid), 118-138 (Top by cost), 139-160 (Top by requests), 161-219 (Folders card), 221-320 (columns)",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Folders",
					metric: { kind: "derived", name: "folderCount", op: "count", of: { kind: "aggregate", source: "folders", field: "totalRequests" } },
				},
				{
					label: "Requests",
					metric: { kind: "derived", name: "totalRequests", op: "sum", of: { kind: "aggregate", source: "folders", field: "totalRequests" } },
					hint: { kind: "derived", name: "failedRequests", op: "sum", of: { kind: "aggregate", source: "folders", field: "failedRequests" } },
				},
				{
					label: "API-equivalent cost",
					metric: { kind: "derived", name: "totalCost", op: "sum", of: { kind: "aggregate", source: "folders", field: "totalCost" } },
					emphasis: "primary",
					hint: { kind: "derived", name: "unpricedRequests", op: "sum", of: { kind: "aggregate", source: "folders", field: "unpricedRequests" } },
				},
				{
					label: "Conversation tokens",
					metric: conversationTokens("folders"),
				},
				{
					// `rangeCacheRate`, NOT `folders.cacheRate`: every folder row carries
					// its OWN rate, so the aggregate reads folders[0] — one folder's answer
					// to a question about the whole range. `buildFolderRows` sums input and
					// cache reads across every folder and divides once.
					label: "Cache rate",
					metric: { kind: "derived", name: "rangeCacheRate", op: "sum", of: { kind: "aggregate", source: "folders", field: "totalCacheReadTokens" } },
				},
			],
		},
		{
			kind: "chart",
			title: "Top by cost",
			source: "ProjectsRoute.tsx:118-138",
			chart: {
				type: "shareBar",
				axis: "share",
				series: [
					{
						key: "cost",
						label: "Share of API-equivalent cost",
						metric: { kind: "aggregate", source: "folders", field: "totalCost" },
					},
				],
			},
		},
		{
			kind: "chart",
			title: "Top by requests",
			source: "ProjectsRoute.tsx:139-160",
			chart: {
				type: "shareBar",
				axis: "share",
				series: [
					{
						key: "requests",
						label: "Share of all requests",
						metric: { kind: "aggregate", source: "folders", field: "totalRequests" },
					},
				],
			},
		},
		{
			kind: "table",
			title: "Folders",
			source: "ProjectsRoute.tsx:161-219, 221-320",
			rows: {
				source: "folders",
				initialSort: {
					by: { kind: "aggregate", source: "folders", field: "totalCost" },
					direction: "desc",
				},
			},
			columns: [
				{ header: "Folder", align: "left", source: { kind: "label", source: "folders", field: "folder" } },
				{ header: "Requests", align: "right", source: { kind: "aggregate", source: "folders", field: "totalRequests" } },
				{ header: "Cost", align: "right", source: { kind: "aggregate", source: "folders", field: "totalCost" } },
				{ header: "Tokens", align: "right", source: conversationTokens("folders") },
				{ header: "Cache rate", align: "right", source: { kind: "aggregate", source: "folders", field: "cacheRate" } },
				{ header: "Cache savings", align: "right", source: { kind: "aggregate", source: "folders", field: "cacheSavings" } },
				{ header: "Errors", align: "right", cell: "badge", source: { kind: "aggregate", source: "folders", field: "errorRate" } },
				{ header: "Avg duration", align: "right", source: { kind: "aggregate", source: "folders", field: "avgDuration" } },
				{ header: "Last active", align: "right", source: { kind: "aggregate", source: "folders", field: "lastTimestamp" } },
			],
		},
		{
			kind: "note",
			text: "The web's hide-temporary checkbox, folder search, and click-to-filter have no terminal equivalent; the lists above rank the full folder set.",
		},
	],
};

const requests: ScreenSpec = {
	id: "requests",
	label: "Requests",
	short: "Requests",
	needs: ["recent", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/RequestsRoute.tsx",
		lines: "107-114 (header), 115-154 (StatGrid), 156-205 (Request log card), 219-299 (columns)",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Requests",
					metric: { kind: "derived", name: "loaded", op: "count", of: { kind: "aggregate", source: "recentMessages", field: "id" } },
					emphasis: "primary",
				},
				{
					label: "Failed",
					metric: { kind: "derived", name: "requestFailed", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "id" } },
					hint: { kind: "derived", name: "requestAborted", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "id" } },
				},
				{
					label: "Tokens",
					metric: { kind: "derived", name: "tokens", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "usage.totalTokens" } },
				},
				{
					label: "API-equivalent cost",
					metric: { kind: "derived", name: "cost", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "usage.cost.total" } },
				},
				{
					label: "Median duration",
					metric: { kind: "derived", name: "medianDuration", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "duration" } },
					hint: { kind: "derived", name: "p95Duration", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "duration" } },
				},
				{
					label: "Median TTFT",
					metric: { kind: "derived", name: "medianTtft", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "ttft" } },
				},
			],
		},
		{
			kind: "table",
			title: "Request log",
			source: "RequestsRoute.tsx:156-205, 219-299",
			rows: {
				source: "recentMessages",
				initialSort: {
					by: { kind: "aggregate", source: "recentMessages", field: "timestamp" },
					direction: "desc",
				},
			},
			columns: [
				{ header: "Model", align: "left", source: { kind: "label", source: "recentMessages", field: "model" } },
				{ header: "Provider", align: "left", source: { kind: "label", source: "recentMessages", field: "provider" } },
				{ header: "When", align: "left", source: { kind: "aggregate", source: "recentMessages", field: "timestamp" } },
				{ header: "Project", align: "left", source: { kind: "label", source: "recentMessages", field: "folder" } },
				{ header: "Input", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.input" } },
				{ header: "Cache read", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.cacheRead" } },
				{ header: "Output", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.output" } },
				{ header: "Cost", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "usage.cost.total" } },
				{ header: "Duration", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "duration" } },
				{ header: "TTFT", align: "right", source: { kind: "aggregate", source: "recentMessages", field: "ttft" } },
				{
					header: "Status",
					align: "right",
					cell: "badge",
					source: { kind: "derived", name: "requestStatus", op: "sum", of: { kind: "aggregate", source: "recentMessages", field: "stopReason" } },
				},
			],
		},
	],
};

const errors: ScreenSpec = {
	id: "errors",
	label: "Errors",
	short: "Errors",
	needs: ["errors", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/ErrorsRoute.tsx",
		lines: "123-129 (header), 131-158 (StatGrid), 159-196 (Error signatures), 197-228 (By model), 229-295 (Failures), 296-340 (signature columns), 368-421 (failure columns)",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Failures",
					metric: { kind: "derived", name: "loaded", op: "count", of: { kind: "aggregate", source: "errorMessages", field: "id" } },
					emphasis: "primary",
				},
				{
					// `errorSignatureCount`, NOT a distinct count of raw messages:
					// `errorSignature` collapses request ids, hex hashes and counters, so
					// "req_abc… after 3 tries" and "req_zzz… after 7 tries" are ONE
					// signature. Counting raw strings counts the noise, and the noise
					// grows with traffic while the signature count stays flat.
					label: "Signatures",
					metric: { kind: "derived", name: "errorSignatureCount", op: "count", of: { kind: "aggregate", source: "errorMessages", field: "errorMessage" } },
				},
				{
					// `affectedModelCount`, NOT a distinct model-name count: identity is
					// `model::provider`, so one model behind two providers is two.
					label: "Affected models",
					metric: { kind: "derived", name: "affectedModelCount", op: "count", of: { kind: "label", source: "errorMessages", field: "model" } },
				},
				{
					label: "Last failure",
					metric: { kind: "aggregate", source: "errorMessages", field: "timestamp" },
				},
			],
		},
		{
			kind: "table",
			title: "Error signatures",
			source: "ErrorsRoute.tsx:159-196, 296-340",
			rows: { source: "errorGroups" },
			columns: [
				{ header: "Signature", align: "left", source: { kind: "label", source: "errorGroups", field: "signature" } },
				{ header: "Models", align: "left", source: { kind: "label", source: "errorGroups", field: "modelLabels" } },
				{ header: "Last seen", align: "right", source: { kind: "aggregate", source: "errorGroups", field: "lastSeen" } },
				{ header: "Failures", align: "right", cell: "meter", source: { kind: "aggregate", source: "errorGroups", field: "count" } },
			],
		},
		{
			kind: "chart",
			title: "Failures by model",
			source: "ErrorsRoute.tsx:197-228",
			chart: {
				type: "rankedBars",
				axis: "count",
				foldTo: { limit: 12, label: "Other" },
				series: [
					{
						key: "failures",
						label: "Failures per model",
						metric: { kind: "series", source: "errorModels", field: "count", groupBy: "model" },
					},
				],
			},
		},
		{
			kind: "table",
			title: "Failures",
			source: "ErrorsRoute.tsx:229-295, 368-421",
			rows: {
				source: "errorMessages",
				initialSort: {
					by: { kind: "aggregate", source: "errorMessages", field: "timestamp" },
					direction: "desc",
				},
			},
			columns: [
				{ header: "When", align: "left", source: { kind: "aggregate", source: "errorMessages", field: "timestamp" } },
				{ header: "Model", align: "left", source: { kind: "label", source: "errorMessages", field: "model" } },
				{
					header: "Error",
					align: "left",
					source: { kind: "label", source: "errorMessages", field: "errorMessage" },
				},
				{ header: "Project", align: "left", source: { kind: "label", source: "errorMessages", field: "folder" } },
				{ header: "Tokens", align: "right", source: { kind: "aggregate", source: "errorMessages", field: "usage.totalTokens" } },
				{ header: "Cost", align: "right", source: { kind: "aggregate", source: "errorMessages", field: "usage.cost.total" } },
			],
		},
		{
			kind: "note",
			text: "A failed request is still a request: it carries tokens and may carry an unknown price, so a failure row must never print $0.00 for an unpriced one.",
		},
	],
};

const tools: ScreenSpec = {
	id: "tools",
	label: "Tools",
	short: "Tools",
	needs: ["tools", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/ToolsRoute.tsx",
		lines: "74-78 (header), 84-119 (StatGrid), 121-140 (second StatGrid), 150-183 (calls-over-time card), 184-206 (By tool), 207-233 (By tool and model), 339-458 (columns), 486-560 (tool×model columns)",
		note: "The route's calls/errors Segmented control is recorded as the chart's two series rather than as a switch.",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Tool calls",
					metric: { kind: "derived", name: "calls", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "calls" } },
					emphasis: "primary",
				},
				{
					label: "Distinct tools",
					metric: { kind: "derived", name: "toolCount", op: "count", of: { kind: "label", source: "toolsByTool", field: "tool" } },
				},
				{
					label: "Error rate",
					metric: { kind: "derived", name: "errorRate", op: "share", of: { kind: "derived", name: "errors", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "errors" } }, against: { kind: "derived", name: "calls", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "calls" } } },
				},
				{
					label: "Attributed tokens",
					metric: { kind: "derived", name: "attributedTokens", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "totalTokensShare" } },
				},
				{
					label: "Attributed cost",
					metric: { kind: "derived", name: "attributedCost", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "costShare" } },
				},
			],
		},
		{
			kind: "statRow",
			stats: [
				{
					label: "Result text",
					metric: { kind: "derived", name: "resultChars", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "resultChars" } },
					size: "sm",
				},
				{
					label: "Call arguments",
					metric: { kind: "derived", name: "argsChars", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "argsChars" } },
					size: "sm",
				},
				{
					label: "Avg result per call",
					metric: { kind: "derived", name: "avgResult", op: "share", of: { kind: "derived", name: "resultChars", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "resultChars" } }, against: { kind: "derived", name: "calls", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "calls" } } },
					size: "sm",
				},
				{
					label: "Avg arguments per call",
					metric: { kind: "derived", name: "avgArgs", op: "share", of: { kind: "derived", name: "argsChars", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "argsChars" } }, against: { kind: "derived", name: "calls", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "calls" } } },
					size: "sm",
				},
			],
		},
		{
			kind: "chart",
			title: "Calls over time",
			source: "ToolsRoute.tsx:150-183",
			chart: {
				type: "bars",
				axis: "count",
				foldTo: { limit: 6, label: "Other" },
				series: [
					{
						key: "calls",
						label: "Calls",
						metric: { kind: "series", source: "toolsSeries", field: "calls", groupBy: "tool" },
					},
					{
						key: "errors",
						label: "Errors",
						metric: { kind: "series", source: "toolsSeries", field: "errors", groupBy: "tool" },
					},
				],
			},
		},
		{
			kind: "table",
			title: "By tool",
			source: "ToolsRoute.tsx:184-206, 339-458",
			rows: {
				source: "toolsByTool",
				initialSort: {
					by: { kind: "aggregate", source: "toolsByTool", field: "calls" },
					direction: "desc",
				},
			},
			columns: [
				{ header: "Tool", align: "left", source: { kind: "label", source: "toolsByTool", field: "tool" } },
				{
					header: "Trend",
					align: "right",
					cell: "sparkline",
					source: { kind: "series", source: "toolsSeries", field: "calls", groupBy: "tool" },
				},
				{ header: "Calls", align: "right", cell: "meter", source: { kind: "aggregate", source: "toolsByTool", field: "calls" } },
				{ header: "Errors", align: "right", cell: "badge", source: { kind: "aggregate", source: "toolsByTool", field: "errors" } },
				{ header: "Args", align: "right", source: { kind: "aggregate", source: "toolsByTool", field: "argsChars" } },
				{ header: "Result", align: "right", source: { kind: "aggregate", source: "toolsByTool", field: "resultChars" } },
				{ header: "Result / call", align: "right", source: { kind: "derived", name: "avgResultChars", op: "share", of: { kind: "aggregate", source: "toolsByTool", field: "resultChars" }, against: { kind: "aggregate", source: "toolsByTool", field: "calls" } } },
				{ header: "Attr. tokens", align: "right", source: { kind: "aggregate", source: "toolsByTool", field: "totalTokensShare" } },
				{ header: "Attr. cost", align: "right", source: { kind: "aggregate", source: "toolsByTool", field: "costShare" } },
				{ header: "Last used", align: "right", source: { kind: "aggregate", source: "toolsByTool", field: "lastUsed" } },
			],
		},
		{
			kind: "table",
			title: "By tool and model",
			source: "ToolsRoute.tsx:207-233, 486-560",
			rows: {
				source: "toolsByToolModel",
				initialSort: {
					by: { kind: "aggregate", source: "toolsByToolModel", field: "calls" },
					direction: "desc",
				},
			},
			columns: [
				{ header: "Tool", align: "left", source: { kind: "label", source: "toolsByToolModel", field: "tool" } },
				{ header: "Model", align: "left", source: { kind: "label", source: "toolsByToolModel", field: "model" } },
				{ header: "Provider", align: "left", source: { kind: "label", source: "toolsByToolModel", field: "provider" } },
				{ header: "Calls", align: "right", source: { kind: "aggregate", source: "toolsByToolModel", field: "calls" } },
				{ header: "Errors", align: "right", cell: "badge", source: { kind: "aggregate", source: "toolsByToolModel", field: "errors" } },
				{ header: "Result", align: "right", source: { kind: "aggregate", source: "toolsByToolModel", field: "resultChars" } },
				{ header: "Attr. tokens", align: "right", source: { kind: "aggregate", source: "toolsByToolModel", field: "totalTokensShare" } },
				{ header: "Attr. cost", align: "right", source: { kind: "aggregate", source: "toolsByToolModel", field: "costShare" } },
				{ header: "Last used", align: "right", source: { kind: "aggregate", source: "toolsByToolModel", field: "lastUsed" } },
			],
		},
		{
			kind: "note",
			text: "Attributed tokens and cost are per-call SHARES of the assistant turn that asked for them, never per-call measurements.",
		},
	],
};

const providers: ScreenSpec = {
	id: "providers",
	label: "Providers",
	short: "Provider",
	needs: ["providers", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/ProvidersRoute.tsx",
		lines: "146-188 (StatGrid), 189-205 (Provider totals), 206-249 (Burn by provider), 250-310 (Subscription windows), 311-422 (columns)",
		note: "S1-S4 (stats, totals, burn, peak hours) read the DB-backed /api/stats/providers aggregates. The subscription-window sections (insights + utilization) do broker network I/O per load and stay out of the panel; the note below names that boundary.",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Providers",
					metric: { kind: "derived", name: "providerCount", op: "count", of: { kind: "aggregate", source: "providerStats", field: "provider" } },
				},
				{
					label: "Requests",
					metric: { kind: "derived", name: "providerRequests", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "totalRequests" } },
					hint: { kind: "derived", name: "providerFailed", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "failedRequests" } },
				},
				{
					label: "Tokens",
					metric: { kind: "derived", name: "providerTokens", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "totalTokens" } },
				},
				{
					label: "API-equivalent cost",
					metric: { kind: "derived", name: "providerCost", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "totalCost" } },
					emphasis: "primary",
					hint: { kind: "derived", name: "providerUnpriced", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "unpricedRequests" } },
				},
				{ label: "Error rate", metric: { kind: "derived", name: "providerErrorRate", op: "share", of: { kind: "derived", name: "providerFailed", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "failedRequests" } }, against: { kind: "derived", name: "providerRequests", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "totalRequests" } } } },
			],
		},
		{
			kind: "chart",
			title: "Burn by provider",
			source: "ProvidersRoute.tsx:206-249",
			chart: {
				type: "rankedBars",
				axis: "tokens",
				series: [
					{
						key: "tokens",
						label: "Token burn per provider",
						metric: { kind: "series", source: "providerStats", field: "totalTokens", groupBy: "provider" },
					},
				],
			},
		},
		{
			kind: "table",
			title: "Provider totals",
			source: "ProvidersRoute.tsx:189-205, 311-422",
			rows: {
				source: "providerStats",
				initialSort: { by: { kind: "aggregate", source: "providerStats", field: "totalTokens" }, direction: "desc" },
			},
			columns: [
				// Drop order, from the panel outward. The web declares no
				// priority — CSS drops nothing, it scrolls horizontally — so this
				// is the terminal's own decision, and it follows the web's column
				// ORDER: what the route lists first is what a narrow terminal
				// keeps. Provider, Requests, Tokens and Cost are the four the
				// `ProviderTotalsTable` is about; Premium, Tokens/s, Models, Share
				// and Error rate go first.
				{ header: "Provider", align: "left", source: { kind: "label", source: "providerStats", field: "provider" } },
				{ header: "Requests", align: "right", cell: "meter", source: { kind: "aggregate", source: "providerStats", field: "totalRequests" } },
				{ header: "Tokens", align: "right", cell: "meter", source: { kind: "aggregate", source: "providerStats", field: "totalTokens" } },
				{ header: "Cost", align: "right", source: { kind: "aggregate", source: "providerStats", field: "totalCost" } },
				{
					// The web's Share is `p.totalTokens / grandTokens`
					// (ProvidersRoute.tsx:371-379). Ours pointed at `totalTokens`
					// again, so the column printed a SECOND copy of the Tokens
					// figure — and at narrow widths the squeeze left it blank. It is
					// a fraction of the GRAND total, which is what
					// `againstScope: "total"` resolves.
					header: "Share",
					align: "right",
					priority: 4,
					source: {
						kind: "derived",
						name: "providerTokenShare",
						op: "share",
						of: { kind: "aggregate", source: "providerStats", field: "totalTokens" },
						against: { kind: "derived", name: "providerTokens", op: "sum", of: { kind: "aggregate", source: "providerStats", field: "totalTokens" } },
						againstScope: "total",
					},
				},
				{ header: "Error rate", align: "right", cell: "badge", priority: 3, source: { kind: "derived", name: "errorRate", op: "share", of: { kind: "aggregate", source: "providerStats", field: "failedRequests" }, against: { kind: "aggregate", source: "providerStats", field: "totalRequests" } } },
				{ header: "Models", align: "right", priority: 5, source: { kind: "aggregate", source: "providerStats", field: "models" } },
				{ header: "Tokens/s", align: "right", priority: 2, source: { kind: "aggregate", source: "providerStats", field: "avgTokensPerSecond" } },
				{ header: "Premium", align: "right", priority: 1, source: { kind: "aggregate", source: "providerStats", field: "totalPremiumRequests" } },
			],
		},
		{
			kind: "note",
			text: "Subscription windows need broker network I/O per load, so the insights and utilization sections stay out of the panel; burn, totals and peak hours above are the local aggregates.",
		},
	],
};

const gain: ScreenSpec = {
	id: "gain",
	label: "Gain",
	short: "Gain",
	needs: ["gain", "rollupStatus"],
	source: {
		file: "@oh-my-pi/omp-stats/src/client/routes/GainRoute.tsx",
		lines: "128-152 (StatGrid), 154-170 (Savings over time), 171-173 (By source), 181-227 (columns)",
		note: "Token savings from snapcompact (jsonl beside the DB), NOT cache savings: savedBytes is tokens x 4, reductionPercent stays null, and the route reads /api/stats/gain. The project <select> has no terminal equivalent; the screen reads the unfiltered payload and names the active project in a note when set.",
	},
	bands: [
		{
			kind: "statRow",
			stats: [
				{
					label: "Saved tokens",
					metric: gainOverall("savedTokens"),
					emphasis: "primary",
					hint: gainOverall("savedTokens"),
				},
				{ label: "Saved bytes", metric: gainOverall("savedBytes") },
				{
					label: "Reduction",
					metric: gainOverall("reductionPercent"),
					hint: { text: "original size not recorded" },
				},
				{ label: "Hits", metric: gainOverall("hits") },
				{
					label: "Saved per hit",
					metric: { kind: "derived", name: "savedPerHit", op: "sum", of: gainOverall("savedTokens") },
					hint: { text: "tokens" },
				},
			],
		},
		{
			kind: "table",
			title: "By source",
			source: "GainRoute.tsx:171-173, 181-227",
			rows: {
				source: "gainBySource",
				initialSort: { by: { kind: "aggregate", source: "gainBySource", field: "savedTokens" }, direction: "desc" },
			},
			columns: [
				{ header: "Source", align: "left", source: { kind: "label", source: "gainBySource", field: "source" } },
				{ header: "Saved tokens", align: "right", cell: "meter", source: { kind: "aggregate", source: "gainBySource", field: "savedTokens" } },
				{ header: "Share", align: "right", source: { kind: "derived", name: "sourceShare", op: "share", of: { kind: "aggregate", source: "gainBySource", field: "savedTokens" }, against: { kind: "aggregate", source: "gainOverall", field: "savedTokens" }, againstScope: "total" } },
				{ header: "Saved bytes", align: "right", source: { kind: "aggregate", source: "gainBySource", field: "savedBytes" } },
				{ header: "Hits", align: "right", source: { kind: "aggregate", source: "gainBySource", field: "hits" } },
				{ header: "Reduction", align: "right", source: { kind: "aggregate", source: "gainBySource", field: "reductionPercent" } },
			],
		},
		{
			kind: "note",
			text: "Reduction stays null for snapcompact — original sizes are never recorded — so the tile reads the web's dash, never 0%. Savings are estimated at four bytes per token.",
		},
	],
};

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * The whole grammar, in tab order. Frozen because a screen spec that can be
 * mutated at runtime is a screen spec that will be.
 */
export const SCREEN_SPECS: readonly ScreenSpec[] = Object.freeze([
	overview,
	activity,
	models,
	costs,
	projects,
	requests,
	errors,
	tools,
	providers,
	gain,
	{ id: "traces", label: "Traces", short: "Traces", needs: ["rollupStatus"],
		source: { file: "@oh-my-pi/omp-stats/src/client/routes/TracesRoute.tsx", lines: "interactive timeline" }, bands: [] },
	{ id: "frustration", label: "Frustration", short: "Frustr.", needs: ["rollupStatus"],
		source: { file: "@oh-my-pi/omp-stats/src/client/routes/FrustrationRoute.tsx", lines: "passive metrics and explicit judge actions" }, bands: [] },
]);

// ─── The one answer to "is this a screen?" ───────────────────────────────────

/**
 * Can this screen id actually be DRAWN? THE SINGLE ANSWER, and the reason the
 * panel and the sidebar cannot drift apart.
 *
 * THE DUPLICATION THIS REPLACES. Two modules independently decided what a screen
 * is, from the same registry and the same spec table:
 *
 *   - `panel.ts`'s `SELECTABLE_SCREENS` filtered the `SCREENS` registry down to
 *     ids with a spec;
 *   - `chrome.ts`'s `NAV_GROUPS` filtered a hand-written `GROUPS` map down to
 *     ids that have a spec AND a jump hotkey.
 *
 * Same inputs, two rules. Nothing made them agree, so nothing would have
 * noticed when they stopped: a screen could become arrow-selectable and vanish
 * from the sidebar, or appear in the nav with no body to draw, and each module
 * would still be internally consistent — which is precisely the shape of bug
 * that hides.
 *
 * Both now call THIS, so "drawable" is stated once: an id is drawable when the
 * IR describes it. An id with no spec has no body to draw.
 */
export function isDrawableScreen(id: string): boolean {
	return SCREEN_SPECS.some(candidate => candidate.id === id);
}

/** The spec for `id`, or `undefined` when the IR does not describe it. */
export function specForScreen(id: string): ScreenSpec | undefined {
	return SCREEN_SPECS.find(candidate => candidate.id === id);
}

/** Every distinct metric reference anywhere in the spec data. */
export const ALL_METRIC_REFS: readonly MetricRef[] = SCREEN_SPECS.flatMap(spec =>
	spec.bands.flatMap(band => refsInBand(band)),
);
