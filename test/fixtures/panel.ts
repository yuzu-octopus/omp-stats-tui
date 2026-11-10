/**
 * ONE fixture, shaped like the real route responses.
 *
 * WHY THIS FILE IS ITS OWN MODULE. Every renderer test needs the same thing: a
 * `PanelData` whose every payload has the shape `src/data/api.ts` promises, with
 * figures in the ranges the live database actually produces. When each test file
 * grows its own copy they drift, and a drift between the fixture and
 * `rowToMessageStats` is INVISIBLE: the tests pass against a payload the real
 * route would never produce, which is exactly the class of bug this panel has
 * already paid for once (a zero-cost model with no price card).
 *
 * The numbers are lifted from the measured captures in
 * `docs/research/omp-stats-tui/RENDER-OUTPUT.txt` rather than invented, so a
 * formatted figure in a test can be checked by hand against the probe output.
 *
 * Pure data. No database, no theme, no I/O.
 */

import type { PanelData } from "../../src/data/api";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import type {
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	DailyActivityPoint,
	FolderStats,
	GainDashboardStats,
	ModelStats,
	ModelTimeSeriesPoint,
	ProviderDashboardStats,
	ProviderWindowInsight,
	TimeSeriesPoint,
	ToolDashboardStats,
} from "@oh-my-pi/omp-stats/shared-types";

/** Day boundary, so every cost bucket lands on the axis the costs route uses. */
export const FIXTURE_NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const dayStart = (daysAgo: number): number =>
	Math.floor((FIXTURE_NOW - daysAgo * DAY) / DAY) * DAY;
export const hourStart = (hoursAgo: number): number =>
	Math.floor((FIXTURE_NOW - hoursAgo * HOUR) / HOUR) * HOUR;

// ─── Aggregates ──────────────────────────────────────────────────────────────

/**
 * The overall aggregate. `cacheRate` is cacheRead / (input + cacheRead) to four
 * decimals, so a test that recomputes it from the counts gets the number the
 * panel prints.
 */
export const AGGREGATE: AggregatedStats = {
	totalRequests: 65_460,
	successfulRequests: 64_145,
	failedRequests: 1_315,
	errorRate: 0.0201,
	totalInputTokens: 47_100_000,
	totalOutputTokens: 9_400_000,
	totalCacheReadTokens: 1_204_000_000,
	totalCacheWriteTokens: 12_800_000,
	cacheRate: 0.9624,
	cacheSavings: 0.8142,
	totalCost: 112.36,
	// The SAME population `BY_MODEL` carries, so a screen that totals the model
	// rows and a screen that reads the overall aggregate cannot disagree. The
	// live database splits this across two no-card models; here it is one, and
	// the figure is what that one model carries.
	unpricedRequests: 4_197,
	totalPremiumRequests: 1.5,
	avgDuration: 12_300,
	avgTtft: 430,
	avgTokensPerSecond: 61.2,
	firstTimestamp: FIXTURE_NOW - 30 * DAY,
	lastTimestamp: FIXTURE_NOW,
};

function modelRow(over: Partial<AggregatedStats> & { model: string; provider: string }): ModelStats {
	return { ...AGGREGATE, ...over };
}

/**
 * Three models, each standing for a distinct real situation:
 *
 *  - `gpt-5.6-terra` — priced, the top spender.
 *  - `gemini-3.7-flash-high` — NO catalog card. Its $0.00 is UNMEASURED and the
 *    panel must print `N/A`, never `$0.00`. This is the single most important row
 *    in the fixture (see `src/data/api.ts`'s workaround block).
 *  - `space-bunny-free` — an EXPLICIT all-zero card. Its $0 is a real price and
 *    must stay `$0`. Without this row the N/A rule would pass by marking every
 *    free model unknown.
 */
export const BY_MODEL: readonly ModelStats[] = [
	modelRow({
		model: "gpt-5.6-terra",
		provider: "openrouter",
		totalRequests: 1_280,
		failedRequests: 4,
		errorRate: 0.0031,
		totalCost: 935.72,
		unpricedRequests: 0,
		totalCacheReadTokens: 512_000_000,
		avgDuration: 9_800,
		cacheRate: 0.961,
	}),
	modelRow({
		model: "gemini-3.7-flash-high",
		provider: "google-antigravity",
		totalRequests: 4_197,
		failedRequests: 0,
		errorRate: 0,
		totalCost: 0,
		unpricedRequests: 4_197,
		totalCacheReadTokens: 571_773_459,
		avgDuration: 14_200,
		cacheRate: 0.955,
	}),
	modelRow({
		model: "space-bunny-free",
		provider: "opencode-go",
		totalRequests: 36_616,
		failedRequests: 88,
		errorRate: 0.0024,
		totalCost: 0,
		unpricedRequests: 0,
		totalCacheReadTokens: 120_226_541,
		avgDuration: 18_600,
		cacheRate: 0.981,
	}),
];

export const MODEL_SERIES: readonly ModelTimeSeriesPoint[] = BY_MODEL.flatMap((m, index) =>
	[0, 1, 2, 3].map(daysAgo => ({
		timestamp: dayStart(daysAgo),
		model: m.model,
		provider: m.provider,
		requests: Math.max(1, Math.round(m.totalRequests / 40) - index - daysAgo),
	})),
);

export const MODEL_PERFORMANCE_SERIES = MODEL_SERIES.map(p => ({
	...p,
	avgTtft: 430 + (p.model.length % 7) * 10,
	avgTokensPerSecond: 61.2,
}));

/**
 * Two days. The older one burned 9M tokens for one cent and the newer spent $42
 * on a thousand — the 41x price spread at comparable volume, which is why
 * charts scale by cost. Token scaling would put the peak at the free day.
 */
function costPoint(
	timestamp: number,
	model: string,
	cost: number,
	tokens: number,
	unpricedRequests = 0,
): CostTimeSeriesPoint {
	return {
		timestamp,
		model,
		provider: "openrouter",
		cost,
		unpricedRequests,
		costInput: cost * 0.1,
		costOutput: cost * 0.05,
		costCacheRead: cost * 0.8,
		costCacheWrite: cost * 0.05,
		requests: Math.max(1, Math.round(tokens / 1_000)),
	};
}

// The SAME unpriced population BY_MODEL carries: the no-card model's 4,197
// requests appear here too, so the costs route and the models route agree.
export const COST_SERIES: readonly CostTimeSeriesPoint[] = [
	costPoint(dayStart(20), "space-bunny-free", 0.01, 9_000_000),
	costPoint(dayStart(0), "gpt-5.6-terra", 42, 1_000),
	costPoint(dayStart(0), "space-bunny-free", 0.02, 4_000_000),
	costPoint(dayStart(0), "gemini-3.7-flash-high", 0, 571_773_459, 4_197),
];

/**
 * A series that reaches both ends of the range set: daily buckets across the
 * aggregate's 30-day window, then hourly buckets across the last 24 h. A chart
 * at 24 h reads the hourly tail; a chart at 30 d reads the daily span. The error
 * rate varies per point so Succeeded and Failed are not proportional — a
 * proportional pair is a restatement, not two series.
 */
export const TIME_SERIES: readonly TimeSeriesPoint[] = [
	...Array.from({ length: 29 }, (_, index) => {
		const requests = 90 + ((index * 37) % 240);
		return {
			timestamp: dayStart(29 - index) + 12 * HOUR,
			requests,
			errors: 1 + ((index * 7) % 9),
			tokens: requests * 4_000,
			cost: Math.round(requests * 0.03 * 100) / 100,
		};
	}),
	...Array.from({ length: 24 }, (_, index) => {
		const requests = 420 - index * 12;
		return {
			timestamp: hourStart(23 - index),
			requests,
			errors: [4, 2, 9, 1][index % 4]!,
			tokens: requests * 90_000,
			cost: Math.round(requests * 0.09 * 100) / 100,
		};
	}),
];

export const BY_AGENT_TYPE: readonly AgentTypeStats[] = [
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

export const FOLDERS: readonly FolderStats[] = [
	{
		...AGGREGATE,
		folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
		totalRequests: 31_002,
		totalCost: 74.1,
		unpricedRequests: 0,
		lastTimestamp: FIXTURE_NOW - HOUR,
	},
	{
		...AGGREGATE,
		folder: "/Users/yuzu/Documents/Projects/other",
		totalRequests: 18_458,
		totalCost: 31.26,
		unpricedRequests: 0,
		lastTimestamp: FIXTURE_NOW - 9 * HOUR,
	},
	{
		...AGGREGATE,
		folder: "scratch",
		totalRequests: 16_000,
		totalCost: 7,
		unpricedRequests: 4_197,
		lastTimestamp: FIXTURE_NOW - 30 * HOUR,
	},
];

/** Recorded requests use the actual upstream contract. */
export type MessageRow = MessageStats & { id: number; costUnpriced: boolean };

/** What a test may override: `usage` and `usage.cost` merge one level deep. */
export type MessageRowOverride = Partial<Omit<MessageRow, "usage">> & {
	usage?: Partial<Omit<MessageRow["usage"], "cost">> & {
		cost?: Partial<MessageRow["usage"]["cost"]>;
	};
};

export function messageRow(over: MessageRowOverride = {}): MessageRow {
	const { usage, ...rest } = over;
	const cost = usage?.cost ?? {};
	return {
		id: 1,
		sessionFile: "/Users/yuzu/.omp/sessions/a.jsonl",
		entryId: "e1",
		folder: "/Users/yuzu/Documents/Projects/omp-stats-tui",
		model: "gpt-5.6-terra",
		provider: "openrouter",
		api: "openai-completions",
		timestamp: FIXTURE_NOW - 4 * 60_000,
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
				total: cost.total ?? 0.42,
				...cost,
			},
		},
	};
}

export const RECENT: readonly MessageRow[] = [
	messageRow({ id: 1 }),
	messageRow({
		id: 2,
		timestamp: FIXTURE_NOW - 40 * 60_000,
		model: "space-bunny-free",
		provider: "opencode-go",
		folder: "scratch",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 1_000,
			cacheWrite: 0,
			totalTokens: 1_000,
			cost: { total: 0 },
		},
		costUnpriced: true,
	}),
	messageRow({
		id: 3,
		timestamp: FIXTURE_NOW - 3 * HOUR,
		provider: "google-antigravity",
		stopReason: "error",
		errorMessage: "429 Too Many Requests",
		costUnpriced: true,
		usage: { cost: { total: 0 } },
	}),
];

export const ERRORS: readonly MessageRow[] = RECENT.filter(r => r.errorMessage !== null);

export const TOOLS: ToolDashboardStats = {
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
			lastUsed: FIXTURE_NOW - 5 * 60_000,
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
			lastUsed: FIXTURE_NOW - 2 * 60_000,
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
			lastUsed: FIXTURE_NOW - HOUR,
		},
	],
	byToolModel: [
		{
			tool: "read",
			model: "gpt-5.6-terra",
			provider: "openrouter",
			calls: 2_400,
			errors: 1,
			argsChars: 50_000,
			resultChars: 240_000,
			totalTokensShare: 55_000_000,
			outputTokensShare: 7_500_000,
			costShare: 12.2,
			unpricedRequestsShare: 0,
			lastUsed: FIXTURE_NOW - 5 * 60_000,
		},
		{
			tool: "read",
			model: "space-bunny-free",
			provider: "opencode-go",
			calls: 1_621,
			errors: 2,
			argsChars: 38_120,
			resultChars: 172_880,
			totalTokensShare: 35_100_000,
			outputTokensShare: 4_900_000,
			costShare: 6.2,
			unpricedRequestsShare: 0,
			lastUsed: FIXTURE_NOW - 5 * 60_000,
		},
	],
	series: [
		{ timestamp: hourStart(23), tool: "read", calls: 120, errors: 0 },
		{ timestamp: hourStart(12), tool: "read", calls: 96, errors: 1 },
		{ timestamp: hourStart(23), tool: "bash", calls: 41, errors: 2 },
		{ timestamp: hourStart(12), tool: "bash", calls: 33, errors: 1 },
		{ timestamp: hourStart(23), tool: "grep", calls: 12, errors: 0 },
		{ timestamp: hourStart(12), tool: "grep", calls: 9, errors: 0 },
	],
};

export type ProviderDashboardFixture = ProviderDashboardStats & { insights: ProviderWindowInsight[] };
export const PROVIDERS: ProviderDashboardFixture = {
	providers: [
		{
			provider: "openrouter",
			totalRequests: 1_280,
			failedRequests: 4,
			models: 1,
			totalInputTokens: 2_100_000,
			totalOutputTokens: 400_000,
			totalCacheReadTokens: 51_000_000,
			totalCacheWriteTokens: 500_000,
			totalTokens: 54_000_000,
			totalCost: 935.72,
			unpricedRequests: 0,
			totalPremiumRequests: 0,
			avgTokensPerSecond: 61.2,
		},
		{
			provider: "google-antigravity",
			totalRequests: 4_197,
			failedRequests: 0,
			models: 1,
			totalInputTokens: 8_000_000,
			totalOutputTokens: 1_500_000,
			totalCacheReadTokens: 190_000_000,
			totalCacheWriteTokens: 2_000_000,
			totalTokens: 201_500_000,
			totalCost: 0,
			unpricedRequests: 4_197,
			totalPremiumRequests: 0,
			avgTokensPerSecond: null,
		},
		{
			provider: "opencode-go",
			totalRequests: 36_616,
			failedRequests: 88,
			models: 1,
			totalInputTokens: 37_000_000,
			totalOutputTokens: 7_500_000,
			totalCacheReadTokens: 963_000_000,
			totalCacheWriteTokens: 10_300_000,
			totalTokens: 1_017_800_000,
			totalCost: 0,
			unpricedRequests: 0,
			totalPremiumRequests: 1.5,
			avgTokensPerSecond: 58.4,
		},
	],
	hourly: [
		{ provider: "openrouter", hour: 9, totalTokens: 9_400_000, outputTokens: 800_000, requests: 210 },
		{ provider: "opencode-go", hour: 14, totalTokens: 88_000_000, outputTokens: 7_000_000, requests: 3_100 },
	],
	series: [
		{ timestamp: dayStart(1), provider: "openrouter", totalTokens: 20_000_000, cost: 310.4, unpricedRequests: 0, requests: 420 },
		{ timestamp: dayStart(0), provider: "opencode-go", totalTokens: 300_000_000, cost: 0, unpricedRequests: 0, requests: 9_100 },
	],
	insights: [
		{ provider: "openrouter", windowKey: "day", windowLabel: "Daily", accounts: 2, cycles: 12, fractionConsumed: 0.42, estTokensPerWindow: 48_000_000, peakConcurrentFraction: 1.1, idealAccounts: 2, exhaustedEvents: 0 },
		{ provider: "opencode-go", windowKey: "week", windowLabel: "Weekly", accounts: 1, cycles: 3, fractionConsumed: 0.08, estTokensPerWindow: 900_000_000, peakConcurrentFraction: 0.31, idealAccounts: 1, exhaustedEvents: 0 },
	],
};

/**
 * Token savings: one source today (`snapcompact`). `reductionPercent` is
 * ALWAYS null for snapcompact — the aggregator never sets originalBytes —
 * so the Reduction tile reads "–" with its "original size not recorded" hint.
 */
export const GAIN: GainDashboardStats = {
	overall: { savedTokens: 1_204_000, savedBytes: 4_816_000, hits: 96, outputBytes: 0, originalBytes: 0, reductionPercent: null },
	bySource: {
		snapcompact: { savedTokens: 1_204_000, savedBytes: 4_816_000, hits: 96, outputBytes: 0, originalBytes: 0, reductionPercent: null },
	},
	timeSeries: [
		{ date: "2026-07-13", snapcompact: 401_000, total: 401_000 },
		{ date: "2026-07-14", snapcompact: 803_000, total: 803_000 },
	],
	project: null,
	projects: ["/Users/yuzu/Documents/Projects/omp-stats-tui"],
};
export type DailyActivityFixture = DailyActivityPoint & { unpricedRequests?: number };
/** 40 days of activity, with one conspicuously busy day for the heatmap peak. */
export const DAILY_ACTIVITY: readonly DailyActivityFixture[] = Array.from({ length: 40 }, (_, i) => {
	const daysAgo = 39 - i;
	const busy = daysAgo === 12;
	const requests = busy ? 2_004 : (i % 7) + 1;
	return {
		day: new Date(FIXTURE_NOW - daysAgo * DAY).toISOString().slice(0, 10),
		cost: busy ? 611.4 : Math.round((i % 7) * 3.11 * 100) / 100,
		requests,
		totalTokens: (i % 7) * 1_200_000,
		// Every seventh day is a no-card model's usage: unmeasured spend, not free.
		unpricedRequests: i % 7 === 0 ? requests : 0,
	};
});

export function liveData(over: Partial<PanelData> = {}): PanelData {
	const recent = [...RECENT];
	const errors = [...ERRORS];
	return {
		overview: {
			overall: AGGREGATE,
			byAgentType: [...BY_AGENT_TYPE],
			timeSeries: [...TIME_SERIES],
		},
		modelDashboard: {
			byModel: [...BY_MODEL],
			modelSeries: [...MODEL_SERIES],
			modelPerformanceSeries: [...MODEL_PERFORMANCE_SERIES],
		},
	costs: { costSeries: [...COST_SERIES] },
	folders: [...FOLDERS],
	recent,
	errors,
	tools: TOOLS,
		providers: { providers: [...PROVIDERS.providers], hourly: [...PROVIDERS.hourly], series: [...PROVIDERS.series], insights: [...PROVIDERS.insights] } as ProviderDashboardFixture,
	gain: { ...GAIN, bySource: { ...GAIN.bySource }, timeSeries: [...GAIN.timeSeries], projects: [...GAIN.projects] },
	dailyActivity: [...DAILY_ACTIVITY],
	rollupStatus: { dirtyHours: 0, dirtySessions: 0 },
	...over,
	};
}

/**
 * NOTHING WAS FETCHED — every need absent from the record entirely.
 *
 * This is the silent-empty trap at its worst (CONTEXT.md): a database that was
 * never initialised answers every read this way, and `fetchRollupStatus` is the
 * one read that refuses instead of degrading. A screen must render a DEFINED
 * empty state here, never a crash and never a figure it did not measure — the
 * distinction `isFetched` exists to preserve.
 */
export function emptyData(): PanelData {
	return {};
}

/**
 * EVERY NEED WAS FETCHED and every payload came back empty.
 *
 * The other half of the same trap, and the one that is genuinely "nothing
 * happened in this window": the queries ran, the rollup was fresh, and there
 * was no usage. A count of `0` here is a MEASURED zero and may be printed; a
 * cost of `0` may not be printed as free spend without its unpriced caveat.
 */
export function blankData(): PanelData {
	return {
		overview: {
			overall: {
				totalRequests: 0,
				successfulRequests: 0,
				failedRequests: 0,
				errorRate: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				cacheRate: 0,
				cacheSavings: 0,
				totalCost: 0,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgDuration: 0,
				avgTtft: 0,
				avgTokensPerSecond: 0,
				firstTimestamp: 0,
				lastTimestamp: 0,
			},
			byAgentType: [],
			timeSeries: [],
		},
		modelDashboard: { byModel: [], modelSeries: [], modelPerformanceSeries: [] },
		costs: { costSeries: [] },
		folders: [],
		recent: [],
		errors: [],
		tools: { byTool: [], byToolModel: [], series: [] },
		providers: { providers: [], hourly: [], series: [], insights: [] } as ProviderDashboardFixture,
		gain: { overall: { savedTokens: 0, savedBytes: 0, hits: 0, outputBytes: 0, originalBytes: 0, reductionPercent: null }, bySource: { snapcompact: { savedTokens: 0, savedBytes: 0, hits: 0, outputBytes: 0, originalBytes: 0, reductionPercent: null } }, timeSeries: [], project: null, projects: [] },
		dailyActivity: [],
		rollupStatus: { dirtyHours: 0, dirtySessions: 0 },
	};
}
