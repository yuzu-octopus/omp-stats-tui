/**
 * `test/unpriced-render.test.ts` — unknown spend reads N/A, real zero reads $0.
 *
 * The no-card-vs-free distinction is asserted at render level in
 * `test/models-screen.test.ts` (Cost column) and `test/overview-screen.test.ts`
 * (cost tile + hint). This file checks the headline-cost pipeline on isolated
 * fixture data; it never reads or initializes the user's database.
 */

import { test, expect } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";


import { glyphsFor } from "../src/tui/glyphs";
import { stripForTest } from "../src/tui/palette";
import type { PanelData } from "../src/data/api";
import { createSummaryFeature } from "../src/tui/features/core/summary";
import type { FeatureContext } from "../src/tui/features/types";
import { AGGREGATE, FIXTURE_NOW, liveData, type DailyActivityFixture } from "./fixtures/panel";
import type { ModelStats } from "@oh-my-pi/omp-stats/shared-types";

ensureThemeSync();

function model(name: string, cost: number, unpriced: number, requests: number): ModelStats {
	return {
		model: name,
		provider: "openai",
		totalRequests: requests,
		successfulRequests: requests,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 1000,
		totalOutputTokens: 1000,
		totalCacheReadTokens: 1000,
		totalCacheWriteTokens: 0,
		cacheRate: 0.5,
		cacheSavings: 0,
		totalCost: cost,
		unpricedRequests: unpriced,
		totalPremiumRequests: 0,
		avgDuration: 1,
		avgTtft: 1,
		avgTokensPerSecond: 1,
		firstTimestamp: 0,
		lastTimestamp: 1,
	};
}

/**
 * A priced model, a genuinely free one, and a NO-CARD one whose spend is
 * unknown. The no-card model is the bug; the free one is the regression guard
 * beside it.
 */
const payload: PanelData = {
	overview: {
		overall: {
			totalRequests: 50_000,
			successfulRequests: 50_000,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 1e8,
			totalOutputTokens: 1e8,
			totalCacheReadTokens: 1e8,
			totalCacheWriteTokens: 0,
			cacheRate: 0.5,
			cacheSavings: 0,
			totalCost: 900,
			unpricedRequests: 4197,
			totalPremiumRequests: 0,
			avgDuration: 1,
			avgTtft: 1,
			avgTokensPerSecond: 1,
			firstTimestamp: 0,
			lastTimestamp: 1,
		},
		byAgentType: [],
		timeSeries: [],
	},
	modelDashboard: {
		byModel: [
			model("gpt-5.6-sol", 900, 0, 20_000),
			// NO catalog card, spend unknown. Must read N/A.
			model("gemini-3.7-flash-high", 0, 4197, 4205),
			// EXPLICIT all-zero card, spend really free. Must stay $0.
			model("space-bunny-free", 0, 0, 36_496),
		],
		modelSeries: [],
		modelPerformanceSeries: [],
	},
} as PanelData;



test("the headline cost carries the corrected unpriced count", async () => {
	// The pipeline cost tile reads its unpriced count from its own hint, so
	// "$900.00" beside "4,197 unpriced" is one honest figure, never a total
	// that silently excludes the unmeasured requests.
	const feature = createSummaryFeature("overview", featureContext(payload));
	await feature.load("24h");
	const body = stripForTest(feature.render(100, 24).join("\n"));
	expect(body).toContain("$900.00");
	expect(body).toContain("4197 unpriced");
	feature.dispose();
});

function featureContext(data: PanelData): FeatureContext {
	return {
		theme, now: () => FIXTURE_NOW, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {},
		reader: { fetch: async () => data, async api<T>(): Promise<T> { return [] as unknown as T; } },
	};
}

test("the activity Recorded days table reads N/A for a day whose spend is unknown", async () => {
	// A day with requests but no price card: its spend is unknown, not free.
	const days: DailyActivityFixture[] = [
		{ day: "2026-07-15", cost: 0, requests: 12, totalTokens: 4_000, unpricedRequests: 12 },
		{ day: "2026-07-14", cost: 5, requests: 3, totalTokens: 900 },
	];
	const feature = createSummaryFeature("activity", featureContext(liveData({ dailyActivity: days })));
	await feature.load("24h");
	const body = stripForTest(feature.render(100, 24).join("\n"));
	expect(body).toContain("N/A");
	expect(body).not.toContain("$0.00");
	feature.dispose();
});

test("the overview cost chart reads N/A for an all-unpriced bucket, never $0.00", async () => {
	// The overall tile keeps a real figure; the single bucket carries only
	// unpriced requests, so the chart's own readout is what must say N/A.
	const bucket = { timestamp: FIXTURE_NOW - 86_400_000, requests: 100, errors: 0, tokens: 1_000, cost: 0, unpricedRequests: 4_197 };
	const data = liveData({
		overview: {
			overall: { ...AGGREGATE, totalCost: 900, unpricedRequests: 0 },
			byAgentType: [],
			timeSeries: [bucket],
		},
	});
	const feature = createSummaryFeature("overview", featureContext(data));
	await feature.load("24h");
	feature.handleInput("\t");
	feature.handleInput("m");
	feature.handleInput("m");
	const body = stripForTest(feature.render(120, 40).join("\n"));
	expect(body).toContain("$900.00");
	expect(body).toContain("N/A");
	expect(body).not.toContain("$0.00");
	feature.dispose();
});

test("the activity heatmap renders four distinct colours across the four levels", async () => {
	const base = new Date(FIXTURE_NOW);
	const day = (offset: number): string => {
		const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	};
	// Costs chosen so sqrt-compression lands on levels 1, 2, 3 and 4.
	const days: DailyActivityFixture[] = [
		{ day: day(-1), cost: 6.25, requests: 1, totalTokens: 100 },
		{ day: day(-2), cost: 25, requests: 1, totalTokens: 100 },
		{ day: day(-3), cost: 50, requests: 1, totalTokens: 100 },
		{ day: day(-4), cost: 100, requests: 1, totalTokens: 100 },
	];
	const feature = createSummaryFeature("activity", featureContext(liveData({ dailyActivity: days })));
	await feature.load("24h");
	const raw = feature.render(120, 40).join("\n");
	const heat = glyphsFor(theme.getSymbolPreset()).heatCell;
	const cell = Array.isArray(heat) ? heat[0]! : heat;
	const sequences = new Set(raw.match(/\x1b\[[0-9;]*m./g)?.filter(sequence => sequence.endsWith(cell)) ?? []);
	expect(sequences.size, "four heat levels rendered four distinct colours").toBe(4);
	feature.dispose();
});

