/**
 * `src/tui/showcase/fixtures.ts` — fabricated payloads for `/stats-test`.
 *
 * THE ONE FILE THAT IS ALLOWED TO LIE. Every real screen is bound to
 * `~/.omp/stats.db`; this one is bound to nothing, deliberately, because its job
 * is to be a design playground and a capability probe of what `@oh-my-pi/pi-tui`
 * can actually draw. A figure here is a test vector, not a claim about anyone's
 * usage, and nothing in this file is ever shown to a user as a fact.
 *
 * WHY FABRICATED SHAPES RATHER THAN A RECORDED ONES. The showcase has to survive
 * changes to the host's own types: a recorded payload from `/api/stats/overview`
 * would be frozen at eight top-level keys, and when the route gained a ninth the
 * playground would keep rendering the old shape without complaint. Declaring the
 * shapes here means the compiler fails when the host moves, which is the only
 * mechanism in this codebase that can do that. The real fixture
 * (`test/fixtures/panel.ts`) still exists and still pins route-shaped data for
 * the real screens; the showcase is deliberately a DIFFERENT exercise.
 *
 * THE AWKWARD VALUES, and why each one earns its place. Every case here is a
 * place the grammar has a decision to make, and a fixture that stops being
 * awkward stops testing the decision it exists to test:
 *
 *   - {@link AWKWARD_LABEL}, 40 cells. The stat grid measures tiles from the
 *     widest label and clamps the tile at `TILE_MAX_WIDTH` (34), so a 40-cell
 *     label is past the ceiling: the VALUE truncates and the label does not.
 *   - {@link AWKWARD_COST}, which renders 25 characters — past `VALUE_WIDTH` (12)
 *     and past every column the grammar keeps, so it lands on the truncation
 *     policy's step 3, the one place a `…` is allowed.
 *   - {@link ZERO_MODEL}, a measured zero. A zero spend must read differently
 *     from an absent one, and only a fixture that carries one can prove it.
 *   - Negative `cacheSavings`, because that figure is a dollar-savings RATIO and
 *     goes negative whenever cache writes cost more than cache reads save.
 *
 * WHAT IS NOT HERE, and why:
 *
 *   - No database. The showcase never imports `bun:sqlite` or calls
 *     `initDb`/`fetchFor`; `test/showcase-needs.test.ts` asserts that at
 *     the source level, because a future edit reaching for the DB would pass
 *     every other test and only fail in someone's real session.
 *   - No `theme`. Colour arrives injected, through the panel's own theme object.
 *   - No clock. {@link SHOWCASE_NOW} is fixed, because `renderScreen` derives its
 *     bucket axis from an injected clock and a wall-clock fixture would place its
 *     buckets outside that axis whenever the suite ran on a different day — the
 *     charts would legitimately draw nothing and the failure would look like a
 *     chart bug.
 */

import type {
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	DailyActivityPoint,
	FolderStats,
	GainDashboardStats,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
} from "@oh-my-pi/omp-stats/shared-types";

/**
 * The showcase's fixed clock: a Wednesday midday UTC, so the calendar heatmap's
 * weekday rows have a plausible shape and no bucket lands on a day boundary the
 * axis would round away.
 */
export const SHOWCASE_NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** A day boundary, so every cost bucket lands on the axis the costs route uses. */
const dayStart = (daysAgo: number): number => Math.floor((SHOWCASE_NOW - daysAgo * DAY) / DAY) * DAY;
const hourStart = (hoursAgo: number): number => Math.floor((SHOWCASE_NOW - hoursAgo * HOUR) / HOUR) * HOUR;

/**
 * A 40-cell model name. Deliberately longer than `TILE_MAX_WIDTH` (34) so it
 * forces the stat grid's ceiling rather than its ordinary measure, and long
 * enough to be truncated as a table's identity column at every width.
 */
export const AWKWARD_LABEL = "vendor/experimental-model-2026-07-previe";

/**
 * A cost with FIFTEEN digits before the decimal point, which `formatCost` renders as
 * 23 characters — comfortably past `VALUE_WIDTH` (12) and past every column the
 * grammar keeps, so it exercises the truncation policy's last step: the one place
 * a `…` may appear, and only at the end of a real number rather than as a cell of
 * its own.
 *
 * TWO NOTES ON THE BRIEF'S "20-DIGIT NUMBER", both of which changed this fixture.
 *
 * 1. `formatCost` can never render EXACTLY 20 characters. Its comma grouping
 *    yields 17, 18, 19, 21, 22 … at successive magnitudes and skips 20 entirely,
 *    so a figure pinned to a 20-character render does not exist. The awkward
 *    figure is therefore pinned by its RENDERED LENGTH (23) — the property the
 *    truncation policy actually cares about — and 23 tests it harder than 20
 *    would have.
 *
 * 2. A literal 20-digit `totalCost` is not usable either: at that magnitude a JS
 *    double cannot hold the cents, so the value arriving at the formatter is
 *    already rounded (987654321012345678.9 becomes …700) and the fixture would be
 *    testing float precision rather than layout. This value has 15 significant
 *    digits before the point and survives the round trip exactly, which is what
 *    lets the test assert on the digits AND the rendered width honestly.
 */
export const AWKWARD_COST = 123_456_789_012_345.67;

/**
 * A model whose cost is a MEASURED zero, distinct from a model with no price
 * card at all. The panel prints `$0` for the first and `N/A` for the second, and
 * the difference is the one lie the panel is built not to tell, so a fixture has
 * to carry both shapes for that distinction to be demonstrable.
 */
export const ZERO_MODEL = "locally-hosted-free-tier";

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * The window totals. The four token kinds are carried SEPARATELY and never
 * collapsed into one total: on data like this a single token figure is true and
 * useless, which is exactly what the panel is not allowed to print.
 */
const OVERALL: AggregatedStats = {
	totalRequests: 65_460,
	successfulRequests: 64_145,
	failedRequests: 1_315,
	errorRate: 0.0201,
	totalInputTokens: 47_100_000,
	totalOutputTokens: 9_400_000,
	totalCacheReadTokens: 1_204_000_000,
	totalCacheWriteTokens: 12_800_000,
	cacheRate: 0.9624,
	// POSITIVE here: caching saved money. `showcaseData("awkward")` carries the
	// negative case, because one figure cannot be both.
	cacheSavings: 0.8142,
	totalCost: 112.36,
	unpricedRequests: 0,
	totalPremiumRequests: 1.5,
	avgDuration: 12_300,
	avgTtft: 430,
	avgTokensPerSecond: 61.2,
	firstTimestamp: SHOWCASE_NOW - 30 * DAY,
	lastTimestamp: SHOWCASE_NOW,
};

function modelRow(over: Partial<AggregatedStats> & { model: string; provider: string }): ModelStats {
	return { ...OVERALL, ...over };
}

/**
 * Four models, each standing for a situation the panel has to tell apart:
 *
 *  - the top spender, priced, at a 20-cell figure;
 *  - {@link AWKWARD_LABEL}, the 40-cell label, with NEGATIVE cache savings;
 *  - {@link ZERO_MODEL}, whose `$0` is a real price and must stay `$0`;
 *  - a model with NO price card, whose `$0` is UNMEASURED and must read `N/A`.
 *
 * The last two are the pair the whole `unpricedRequests` seam exists for. A
 * fixture carrying only one of them would let the `N/A` rule pass by marking
 * every free model unknown.
 */
const BY_MODEL: readonly ModelStats[] = [
	modelRow({
		model: "gpt-5.6-terra",
		provider: "openrouter",
		totalRequests: 1_280,
		failedRequests: 4,
		errorRate: 0.0031,
		totalCost: AWKWARD_COST,
		unpricedRequests: 0,
		cacheRate: 0.961,
	}),
	modelRow({
		model: AWKWARD_LABEL,
		provider: "experimental-endpoint",
		totalRequests: 512,
		failedRequests: 0,
		errorRate: 0,
		totalCost: 3.14,
		unpricedRequests: 0,
		cacheRate: 0.94,
		// NEGATIVE: cache writes cost more than cache reads save. A real figure, not
		// a sentinel — the formatter has to be honest about the sign.
		cacheSavings: -0.128,
	}),
	modelRow({
		model: ZERO_MODEL,
		provider: "opencode-go",
		totalRequests: 36_616,
		failedRequests: 88,
		errorRate: 0.0024,
		totalCost: 0,
		unpricedRequests: 0,
		cacheRate: 0.981,
	}),
	modelRow({
		model: "gemini-3.7-flash-high",
		provider: "google-antigravity",
		totalRequests: 4_197,
		failedRequests: 0,
		errorRate: 0,
		totalCost: 0,
		// No catalog card: the zero is UNMEASURED. This row is why the panel renders
		// `N/A` beside an unpriced count rather than `$0.00`.
		unpricedRequests: 4_197,
		cacheRate: 0.955,
	}),
];

const MODEL_SERIES: readonly ModelTimeSeriesPoint[] = BY_MODEL.flatMap((row, index) =>
	[0, 1, 2, 3, 4, 5].map(daysAgo => ({
		timestamp: dayStart(daysAgo),
		model: row.model,
		provider: row.provider,
		requests: Math.max(1, Math.round(row.totalRequests / 60) - index * 3 - daysAgo),
	})),
);

const MODEL_PERFORMANCE_SERIES = MODEL_SERIES.map(point => ({
	...point,
	avgTtft: 430 + (point.model.length % 7) * 10,
	avgTokensPerSecond: 61.2,
}));

/**
 * Cost per day, across TWO models per day — so a table over `costSeries` has to
 * fold (bucket, model) rows into one row per model, which is a rendering
 * decision the showcase should be exercising rather than hiding.
 *
 * The 20-days-ago point is the case the panel's one correctness rule exists for:
 * a day that burned millions of tokens for a cent. Scale those by tokens and the
 * chart confidently puts the cheapest day at the top.
 */
function costPoint(daysAgo: number, model: string, cost: number, tokens: number): CostTimeSeriesPoint {
	return {
		timestamp: dayStart(daysAgo),
		model,
		provider: "openrouter",
		cost,
		unpricedRequests: 0,
		costInput: cost * 0.1,
		costOutput: cost * 0.05,
		costCacheRead: cost * 0.8,
		costCacheWrite: cost * 0.05,
		requests: Math.max(1, Math.round(tokens / 1_000)),
	};
}

const COST_SERIES: readonly CostTimeSeriesPoint[] = [
	costPoint(20, "gpt-5.6-terra", 0.01, 9_000_000),
	costPoint(18, "gpt-5.6-terra", 2.4, 400_000),
	costPoint(12, AWKWARD_LABEL, 18.2, 120_000),
	costPoint(6, ZERO_MODEL, 0, 4_000_000),
	costPoint(3, "gemini-3.7-flash-high", 0, 210_000),
	costPoint(0, "gpt-5.6-terra", 42, 1_000),
	costPoint(0, ZERO_MODEL, 0.02, 4_000_000),
];

/**
 * Hourly points for the whole window, so a bar chart has a real axis at every
 * range the showcase can cycle through. `succeededRequests` is carried alongside
 * `requests` because a two-series chart of succeeded/failed is the shape the web
 * draws, and the panel must never derive one from the other silently.
 */
const TIME_SERIES: readonly TimeSeriesPoint[] = Array.from({ length: 30 * 24 }, (_, index) => {
	const hoursAgo = 30 * 24 - 1 - index;
	const weekday = new Date(hourStart(hoursAgo)).getUTCDay();
	const quiet = weekday === 0 || weekday === 6;
	const wave = Math.abs(Math.sin(index / 7));
	const requests = Math.round((quiet ? 40 : 180) * wave) + 8;
	const errors = requests > 90 ? Math.round(requests * 0.03) : 0;
	return {
		timestamp: hourStart(hoursAgo),
		requests,
		errors,
		tokens: requests * (1_200 + Math.round(wave * 4_000)),
		cost: Number((requests * 0.011 * (1 + wave)).toFixed(4)),
		succeededRequests: requests - errors,
	};
});

const BY_AGENT_TYPE: readonly AgentTypeStats[] = [
	{
		agentType: "main",
		totalRequests: 40_000,
		totalInputTokens: 30e6,
		totalOutputTokens: 6e6,
		totalCacheReadTokens: 900e6,
		totalCacheWriteTokens: 9e6,
		totalCost: 62.4,
	},
	{
		agentType: "subagent",
		totalRequests: 22_000,
		totalInputTokens: 12e6,
		totalOutputTokens: 3e6,
		totalCacheReadTokens: 280e6,
		totalCacheWriteTokens: 3e6,
		totalCost: 44.1,
	},
	{
		agentType: "advisor",
		totalRequests: 3_460,
		totalInputTokens: 5.1e6,
		totalOutputTokens: 0.4e6,
		totalCacheReadTokens: 24e6,
		totalCacheWriteTokens: 0.8e6,
		totalCost: 5.86,
	},
];

/**
 * Folders, including one path past forty cells — the case that used to overwrite
 * the panel's right border, because padding can only ADD space and a cell wider
 * than its column overflowed instead of being cut.
 */
const FOLDERS: readonly FolderStats[] = [
	{
		...OVERALL,
		folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
		totalRequests: 31_002,
		totalCost: 74.1,
		lastTimestamp: SHOWCASE_NOW - HOUR,
	},
	{
		...OVERALL,
		folder: "/Users/yuzu/Documents/Projects/a-very-long-directory-name-for-testing/omp",
		totalRequests: 18_458,
		totalCost: 31.26,
		lastTimestamp: SHOWCASE_NOW - 9 * HOUR,
	},
	{
		...OVERALL,
		folder: "scratch",
		totalRequests: 16_000,
		totalCost: 7,
		lastTimestamp: SHOWCASE_NOW - 30 * HOUR,
	},
];

// ---------------------------------------------------------------------------
// Request rows
// ---------------------------------------------------------------------------

/**
 * One request row, in the shape `rowToMessageStats` builds.
 *
 * `MessageStats` is not re-exported from `@oh-my-pi/omp-stats`'s public barrel,
 * so the literal is declared here — which is the point: if the host renames
 * `usage.cacheRead`, this file stops type-checking rather than quietly painting
 * a blank.
 */
export interface ShowcaseRequestRow {
	id: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		premiumRequests: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	agentType: string;
	costUnpriced: boolean;
}

/** What a caller may override; `usage` and `usage.cost` merge one level deep. */
export interface ShowcaseRequestOverride extends Partial<Omit<ShowcaseRequestRow, "usage">> {
	usage?: Partial<Omit<ShowcaseRequestRow["usage"], "cost">> & {
		cost?: Partial<ShowcaseRequestRow["usage"]["cost"]>;
	};
}

export function requestRow(over: ShowcaseRequestOverride = {}): ShowcaseRequestRow {
	const { usage, ...rest } = over;
	return {
		id: 1,
		sessionFile: "/Users/yuzu/.omp/sessions/a.jsonl",
		entryId: "e1",
		folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
		model: "gpt-5.6-terra",
		provider: "openrouter",
		api: "openai-completions",
		timestamp: SHOWCASE_NOW - 4 * 60_000,
		duration: 12_300,
		ttft: 430,
		stopReason: "stop",
		errorMessage: null,
		agentType: "main",
		costUnpriced: false,
		...rest,
		usage: {
			input: 47_100,
			output: 9_400,
			cacheRead: 1_204_000,
			cacheWrite: 12_800,
			totalTokens: 1_273_300,
			premiumRequests: 0,
			...usage,
			cost: {
				input: 0.04,
				output: 0.02,
				cacheRead: 0.34,
				cacheWrite: 0.02,
				total: 0.42,
				...usage?.cost,
			},
		},
	};
}

/**
 * Requests carrying every badge outcome the grammar can draw: a clean `stop`, an
 * `aborted` turn (interrupted work, which is NOT a failure and must never wear the
 * error ink), and a genuine failure with a message.
 */
const RECENT: readonly ShowcaseRequestRow[] = [
	requestRow({ id: 1 }),
	requestRow({
		id: 2,
		model: ZERO_MODEL,
		provider: "opencode-go",
		folder: "scratch",
		timestamp: SHOWCASE_NOW - 40 * 60_000,
		usage: { input: 12_000, output: 900, cacheRead: 480_000, cacheWrite: 1_100, totalTokens: 494_000 },
	}),
	requestRow({
		id: 3,
		model: AWKWARD_LABEL,
		provider: "experimental-endpoint",
		// ABORTED: carries no `errorMessage` and must still not read as "ok", nor as
		// "failed" — `badgeCell` has its own `stopReason` branch for exactly this.
		stopReason: "aborted",
		timestamp: SHOWCASE_NOW - 95 * 60_000,
		duration: 4_100,
	}),
	requestRow({
		id: 4,
		stopReason: "error",
		errorMessage: "upstream returned 502 after 3 retries",
		timestamp: SHOWCASE_NOW - 2 * HOUR,
		duration: 30_400,
	}),
	requestRow({
		id: 5,
		model: "gemini-3.7-flash-high",
		provider: "google-antigravity",
		stopReason: "error",
		errorMessage: "context length exceeded",
		timestamp: SHOWCASE_NOW - 3 * HOUR,
		duration: 890,
	}),
];

/** A NULL duration and a null TTFT: an absent latency must render as a dash. */
const ABSENT_LATENCY: ShowcaseRequestRow = requestRow({
	id: 6,
	timestamp: SHOWCASE_NOW - 5 * HOUR,
	duration: null,
	ttft: null,
	stopReason: "aborted",
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * 40 days of calendar activity, deliberately irregular: one conspicuously busy
 * day for the heatmap peak, a run of zero days so the "present but no activity"
 * cell is exercised beside the "future date" cell, and a weekday/weekend rhythm so
 * the grid does not read as a uniform wash.
 */
const DAILY_ACTIVITY: readonly DailyActivityPoint[] = Array.from({ length: 40 }, (_, index) => {
	const daysAgo = 39 - index;
	const busy = daysAgo === 12;
	const quiet = daysAgo >= 30 && daysAgo <= 33;
	const cost = busy ? 611.4 : quiet ? 0 : Math.round((index % 7) * 3.11 * 100) / 100;
	return {
		day: new Date(SHOWCASE_NOW - daysAgo * DAY).toISOString().slice(0, 10),
		cost,
		requests: busy ? 2_004 : quiet ? 0 : (index % 7) + 1,
		totalTokens: quiet ? 0 : (index % 7) * 1_200_000,
	};
});

// ---------------------------------------------------------------------------
// Gain
// ---------------------------------------------------------------------------

/**
 * Token savings. `reductionPercent` is ALWAYS null for `snapcompact` — the
 * aggregator never records an original size — so the Reduction tile reads the
 * web's en dash with its "not recorded" hint rather than `0.0%`.
 */
const GAIN: GainDashboardStats = {
	overall: {
		savedTokens: 1_204_000,
		savedBytes: 4_816_000,
		hits: 96,
		outputBytes: 0,
		originalBytes: 0,
		reductionPercent: null,
	},
	bySource: {
		snapcompact: {
			savedTokens: 1_204_000,
			savedBytes: 4_816_000,
			hits: 96,
			outputBytes: 0,
			originalBytes: 0,
			reductionPercent: null,
		},
	},
	timeSeries: [
		{ date: "2026-07-13", snapcompact: 401_000, total: 401_000 },
		{ date: "2026-07-14", snapcompact: 803_000, total: 803_000 },
	],
	project: null,
	projects: ["/Users/yuzu/Documents/Projects/omp-stats-tui"],
};

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** A window's payload, in the shape `fetchFor` would have assembled. */
export interface ShowcaseRecord {
	overview?: {
		overall: AggregatedStats;
		byAgentType: readonly AgentTypeStats[];
		timeSeries: readonly TimeSeriesPoint[];
	};
	modelDashboard?: {
		byModel: readonly ModelStats[];
		modelSeries: readonly ModelTimeSeriesPoint[];
		modelPerformanceSeries: readonly ModelTimeSeriesPoint[];
	};
	costs?: { costSeries: readonly CostTimeSeriesPoint[] };
	folders?: readonly FolderStats[];
	recent?: readonly ShowcaseRequestRow[];
	errors?: readonly ShowcaseRequestRow[];
	tools?: ShowcaseTools;
	gain?: GainDashboardStats;
	dailyActivity?: readonly DailyActivityPoint[];
	rollupStatus?: { dirtyHours: number; dirtySessions: number };
}

export interface ShowcaseTools {
	byTool: readonly ShowcaseToolRow[];
	byToolModel: readonly ShowcaseToolModelRow[];
	series: readonly ShowcaseToolPoint[];
}

export interface ShowcaseToolRow {
	tool: string;
	calls: number;
	errors: number;
	argsChars: number;
	resultChars: number;
	totalTokensShare: number;
	outputTokensShare: number;
	costShare: number;
	unpricedRequestsShare: number;
	lastUsed: number;
}

export interface ShowcaseToolModelRow extends ShowcaseToolRow {
	model: string;
	provider: string;
}

export interface ShowcaseToolPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

const TOOLS: ShowcaseTools = {
	byTool: [
		{
			tool: "read",
			calls: 4_021,
			errors: 3,
			argsChars: 88_120,
			resultChars: 412_880,
			totalTokensShare: 90_100_000,
			outputTokensShare: 12_400_000,
			costShare: 18.4,
			unpricedRequestsShare: 0,
			lastUsed: SHOWCASE_NOW - 5 * 60_000,
		},
		{
			tool: "bash",
			calls: 1_884,
			errors: 41,
			argsChars: 21_400,
			resultChars: 96_220,
			totalTokensShare: 30_400_000,
			outputTokensShare: 4_100_000,
			costShare: 6.9,
			unpricedRequestsShare: 0,
			lastUsed: SHOWCASE_NOW - 2 * 60_000,
		},
		{
			tool: "grep",
			calls: 610,
			errors: 0,
			argsChars: 9_100,
			resultChars: 51_800,
			totalTokensShare: 8_900_000,
			outputTokensShare: 1_200_000,
			costShare: 1.1,
			unpricedRequestsShare: 0,
			lastUsed: SHOWCASE_NOW - HOUR,
		},
	],
	byToolModel: BY_MODEL.flatMap((row, index) => [
		{
			tool: index % 2 === 0 ? "read" : "bash",
			model: row.model,
			provider: row.provider,
			calls: Math.max(1, Math.round(row.totalRequests / 4)),
			errors: Math.round(row.failedRequests / 2),
			argsChars: 20_000 + index * 4_000,
			resultChars: 90_000 + index * 12_000,
			totalTokensShare: 30_000_000 - index * 4_000_000,
			outputTokensShare: 4_000_000 - index * 500_000,
			costShare: 6.2 - index,
			unpricedRequestsShare: 0,
			lastUsed: SHOWCASE_NOW - (index + 1) * HOUR,
		},
	]),
	series: Array.from({ length: 14 }, (_, index) => {
		const tool = ["read", "bash", "grep"][index % 3] as string;
		return {
			timestamp: hourStart(13 - index),
			tool,
			calls: Math.round(120 * (1 - index / 20)),
			errors: index % 4 === 0 ? 2 : 0,
		};
	}),
};

/**
 * The record every section but `empty` and `awkward` draws.
 *
 * `rollupStatus.dirtyHours` is non-zero on purpose: a fresh database is the
 * easiest state to build and the least interesting, and the freshness line is
 * chrome the showcase is here to exercise.
 */
export const SHOWCASE_RECORD: ShowcaseRecord = {
	overview: { overall: OVERALL, byAgentType: BY_AGENT_TYPE, timeSeries: TIME_SERIES },
	modelDashboard: {
		byModel: BY_MODEL,
		modelSeries: MODEL_SERIES,
		modelPerformanceSeries: MODEL_PERFORMANCE_SERIES,
	},
	costs: { costSeries: COST_SERIES },
	folders: FOLDERS,
	recent: [...RECENT, ABSENT_LATENCY],
	errors: RECENT.filter(row => row.errorMessage !== null),
	tools: TOOLS,
	gain: GAIN,
	dailyActivity: DAILY_ACTIVITY,
	rollupStatus: { dirtyHours: 12, dirtySessions: 3 },
};

/**
 * EVERYTHING FETCHED AND EVERY PAYLOAD EMPTY.
 *
 * This is the empty RANGE, and it is deliberately distinct from "nothing was
 * fetched": the keys are present, the arrays are empty, and `rollupStatus` is
 * still there. `renderScreen` answers it in one line of words, because a grid of
 * empty cells is a claim about someone's usage that happens to be wrong.
 */
export const SHOWCASE_EMPTY: ShowcaseRecord = {
	overview: { overall: OVERALL, byAgentType: [], timeSeries: [] },
	modelDashboard: { byModel: [], modelSeries: [], modelPerformanceSeries: [] },
	costs: { costSeries: [] },
	folders: [],
	recent: [],
	errors: [],
	tools: { byTool: [], byToolModel: [], series: [] },
	dailyActivity: [],
	rollupStatus: { dirtyHours: 0, dirtySessions: 0 },
};

/**
 * The awkward record. Same shapes as the ordinary one, carrying the values that
 * exist only to be difficult:
 *
 *   - exactly ONE request row, so a single-record table must still draw its
 *     header and its one row rather than collapsing to nothing;
 *   - exactly 100 error rows, so scrolling reaches failures beyond the initial viewport;
 *   - a NULL duration and TTFT, so an absent latency renders as the host's own
 *     hyphen rather than as a blank cell under a header that promises a figure.
 */
export const SHOWCASE_AWKWARD: ShowcaseRecord = {
	...SHOWCASE_RECORD,
	recent: [RECENT[0] as ShowcaseRequestRow],
	errors: Array.from({ length: 100 }, (_, index) =>
		requestRow({
			id: 1_000 + index,
			stopReason: "error",
			errorMessage: `provider rejected request ${index}: upstream 503 after ${(index % 4) + 1} retries`,
			timestamp: SHOWCASE_NOW - index * 9 * 60_000,
			duration: index % 11 === 0 ? null : 8_000 + index * 37,
		}),
	),
};

/**
 * A fetched series whose values are ALL ZERO — a third state, and the one most
 * easily lost: a payload that was fetched and returned rows that cost nothing
 * draws a REAL flat chart. Dropping it would collapse "the work happened and cost
 * nothing" into "nobody asked", which is the silent-empty trap this panel is
 * built not to fall into.
 */
export const SHOWCASE_FLAT: ShowcaseRecord = {
	...SHOWCASE_RECORD,
	overview: {
		overall: OVERALL,
		byAgentType: BY_AGENT_TYPE,
		// A fetched series whose every value is zero. `succeededRequests` is carried
		// alongside `requests` by the fixture (the panel reads both), which the host
		// type does not declare — the cast is at this one seam and nowhere else.
		timeSeries: TIME_SERIES.map(point => ({
			...point,
			cost: 0,
			errors: 0,
			succeededRequests: point.requests,
		})) as unknown as readonly TimeSeriesPoint[],
	},
};