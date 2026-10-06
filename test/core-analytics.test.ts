import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { CostTimeSeriesPoint, ToolDashboardStats, ToolUsageStats } from "@oh-my-pi/omp-stats/shared-types";
import type { CostPayload, ModelDashboardPayload } from "../src/data/api";
import type { FeatureContext, FeatureReader } from "../src/tui/features/types";
import { createAnalyticsFeature } from "../src/tui/features/core/analytics";
import { stripForTest } from "../src/tui/palette";
import { AGGREGATE } from "./fixtures/panel";

ensureThemeSync();
const NOW = Date.UTC(2026, 8, 21);
const DAY = 86_400_000;

function context(payload: unknown, changed: () => void = () => {}): FeatureContext {
	const reader: FeatureReader = {
		api: async <T>() => payload as T,
		fetch: async () => { throw new Error("Analytics must use its actual dashboard API reader"); },
	};
	return { reader, theme, changed, copy: async () => {}, openTrace: () => {}, openScreen: () => {}, now: () => NOW };
}

const MODELS: ModelDashboardPayload = {
	byModel: [
		{ ...AGGREGATE, model: "same-model", provider: "provider-a", totalRequests: 10, avgTtft: 250, avgTokensPerSecond: 12.5 },
		{ ...AGGREGATE, model: "same-model", provider: "provider-b", totalRequests: 20, avgTtft: 1500, avgTokensPerSecond: 80 },
	],
	modelSeries: [
		{ timestamp: NOW - DAY, model: "same-model", provider: "provider-a", requests: 10 },
		{ timestamp: NOW - DAY, model: "same-model", provider: "provider-b", requests: 20 },
	],
	modelPerformanceSeries: [
		{ timestamp: NOW - DAY, model: "same-model", provider: "provider-a", requests: 10, avgTtft: 250, avgTokensPerSecond: 12.5 },
		{ timestamp: NOW - DAY, model: "same-model", provider: "provider-b", requests: 20, avgTtft: 1500, avgTokensPerSecond: 80 },
		{ timestamp: NOW, model: "same-model", provider: "provider-a", requests: 3, avgTtft: 500, avgTokensPerSecond: 25 },
	],
};

function tool(tool: string, calls: number): ToolUsageStats {
	return { tool, calls, errors: 1, argsChars: calls * 2, resultChars: calls * 4, totalTokensShare: calls * 10, outputTokensShare: calls * 3, costShare: calls / 10, unpricedRequestsShare: 0, lastUsed: NOW };
}
const TOOLS: ToolDashboardStats = {
	byTool: [tool("alpha", 10), tool("beta", 5)],
	byToolModel: [
		{ ...tool("alpha", 6), model: "same-model", provider: "provider-a" },
		{ ...tool("alpha", 4), model: "same-model", provider: "provider-b" },
		{ ...tool("beta", 5), model: "beta-model", provider: "provider-b" },
	],
	series: [{ timestamp: NOW, tool: "alpha", calls: 10, errors: 1 }, { timestamp: NOW, tool: "beta", calls: 5, errors: 1 }],
};

const COST_POINTS: CostTimeSeriesPoint[] = [
	{ timestamp: NOW - DAY, model: "same-model", provider: "provider-a", requests: 3, unpricedRequests: 0, cost: 2, costInput: 1, costOutput: 1, costCacheRead: 0, costCacheWrite: 0 },
	{ timestamp: NOW - DAY, model: "same-model", provider: "provider-b", requests: 7, unpricedRequests: 7, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 },
	{ timestamp: NOW, model: "same-model", provider: "provider-a", requests: 2, unpricedRequests: 0, cost: 4, costInput: 0, costOutput: 4, costCacheRead: 0, costCacheWrite: 0 },
];

// Consumer assertions deliberately inspect only public render/input behavior.
// No private state, React routes, network or database participates.
test("model provider identity isolates expansion, TTFT conversion and performance point units", async () => {
	const feature = createAnalyticsFeature("models", context(MODELS));
	await feature.load("all");
	const initial = feature.render(180, 60).map(stripForTest).join("\n");
	expect(initial).toContain("same-model · provider-a");
	expect(initial).toContain("same-model · provider-b");
	feature.handleInput("\t");
	feature.handleInput("/");
	feature.handleInput("provider-a");
	feature.handleInput("\r");
	feature.handleInput("\r");
	const expanded = feature.render(180, 60).map(stripForTest).join("\n");
	expect(expanded).toContain("Details: same-model · provider-a");
	expect(expanded).toContain("avgTtft: 0.25s");
	expect(expanded).toContain("avgTokensPerSecond: 12.5 tok/s");
	expect(expanded).not.toContain("80.0 tok/s");
	feature.handleInput(".");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("25.0 tok/s");
	feature.handleInput("n");
	feature.handleInput("v");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("> off TTFT (seconds)");
	feature.handleInput("b");
	await feature.load("all");
	expect(feature.inputMode).toBe("navigation");
});

test("tool selection scopes the model table only, preserves chart totals, and resets", async () => {
	const feature = createAnalyticsFeature("tools", context(TOOLS));
	await feature.load("all");
	feature.handleInput("\t");
	feature.handleInput("\r");
	let text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("Tool filter: alpha");
	expect(text).toContain("Tool call counts (all tools)");

	expect(text).toContain("alpha · same-model · provider-a");
	expect(text).toContain("alpha · same-model · provider-b");
	expect(text).not.toContain("beta · beta-model");
	await feature.load("all");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Tool filter: alpha");
	feature.handleInput("x");
	text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("Tool filter: All tools");
	expect(text).toContain("beta · beta-model · provider-b");
	feature.handleInput("f");
	feature.handleInput("f");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Tool filter: beta");
	feature.handleInput("\x1b");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Tool filter: All tools");
});

test("cost model and component details retain unpriced attribution", async () => {
	const payload: CostPayload = { costSeries: COST_POINTS };
	const feature = createAnalyticsFeature("costs", context(payload));
	await feature.load("all");
	feature.handleInput("\t");
	feature.handleInput("/");
	feature.handleInput("provider-b");
	feature.handleInput("\r");
	feature.handleInput("\r");
	const text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("Details: same-model · provider-b");
	expect(text).toContain("unpricedRequests: 7");
	expect(text).toContain("perPricedRequest: N/A");
	feature.handleInput("b");
	feature.handleInput("\t");
	feature.handleInput("\r");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Details: Output");
});

test("analytics reserves global keys even during search and remembers sorting and modes", async () => {
	const feature = createAnalyticsFeature("tools", context(TOOLS));
	await feature.load("all");
	feature.handleInput("m");
	feature.handleInput("\t");
	feature.handleInput("O");
	feature.handleInput("a");
	feature.handleInput("/");
	for (const key of ["\x0e", "\x10", "\x1b[C", "\x1b[D"]) expect(feature.handleInput(key)).toBe(false);
	for (const key of ["q", "[", "]"]) expect(feature.handleInput(key)).toBe(true);
	expect(feature.render(180, 24).slice(0, 24).map(stripForTest).join("\n")).toContain("q[]");
	for (let i = 0; i < 3; i++) feature.handleInput("\x7f");
	feature.handleInput("alpha");
	feature.handleInput("\r");
	await feature.load("all");
	const text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("Tool error counts (all tools)");
	expect(text).toContain("calls ↑");
	expect(text).toContain("alpha");
});

test("all model rows remain reachable beyond the initial reveal limit", async () => {
	const payload: ModelDashboardPayload = { ...MODELS, byModel: Array.from({ length: 31 }, (_, i) => ({ ...MODELS.byModel[0], model: `model-${i}`, totalRequests: 31 - i })) };
	const feature = createAnalyticsFeature("models", context(payload));
	await feature.load("all");
	feature.handleInput("\t");
	for (let i = 0; i < 30; i++) feature.handleInput("j");
	feature.handleInput("\r");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Details: model-30 · provider-a");
});

test("late load success and errors cannot overwrite a newer range or mutate a disposed screen", async () => {
	let resolveOld!: (payload: ModelDashboardPayload) => void;
	let rejectClosed!: (error: Error) => void;
	let changes = 0;
	const ctx = context(MODELS, () => { changes++; });
	ctx.reader.api = <T>(_path: string, params?: Record<string, string>): Promise<T> => {
		if (params?.range === "24h") return new Promise<ModelDashboardPayload>(resolve => { resolveOld = resolve; }) as Promise<T>;
		if (params?.range === "7d") return new Promise<ModelDashboardPayload>((_resolve, reject) => { rejectClosed = reject; }) as Promise<T>;
		return Promise.resolve({ ...MODELS, byModel: [] } as T);
	};
	const feature = createAnalyticsFeature("models", ctx);
	const old = feature.load("24h");
	await feature.load("all");
	const before = feature.render(180, 60).map(stripForTest).join("\n");
	resolveOld(MODELS);
	await old;
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toBe(before);
	const pending = feature.load("7d");
	feature.dispose();
	const afterDispose = changes;
	rejectClosed(new Error("late failure"));
	await pending;
	expect(changes).toBe(afterDispose);
	expect(feature.handleInput("m")).toBe(false);
	expect(feature.render(180, 60).map(stripForTest).join("\n")).not.toContain("late failure");
});

test("tool share modes and selected legend visibility survive a range reload", async () => {
	const feature = createAnalyticsFeature("tools", context(TOOLS));
	await feature.load("all");
	feature.handleInput("m");
	feature.handleInput("m");
	let text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("Tool call share (all tools)");

	feature.handleInput("n");
	feature.handleInput("v");
	await feature.load("all");
	text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toMatch(/beta\s+hidden/);
});

test("unknown-only costs never become zero-spend or no-activity graphs and keep attribution in details", async () => {
	const feature = createAnalyticsFeature("costs", context({ costSeries: [COST_POINTS[1]] }));
	await feature.load("all");
	let text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("No priced cost / unknown 7 requests");
	expect(text).not.toContain("No activity recorded");
	feature.handleInput("m");
	feature.handleInput("\t");
	feature.handleInput("\r");
	text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("costInput: N/A · Unknown requests: 7");
	expect(text).toContain("costCacheWrite: N/A · Unknown requests: 7");
	feature.handleInput("b");
	feature.handleInput("\t");
	feature.handleInput("\r");
	text = feature.render(180, 60).map(stripForTest).join("\n");
	expect(text).toContain("cost: N/A · Unknown requests: 7");
	expect(text).toContain("unpricedRequests: 7");
});

test("a remembered tool pick is temporarily inactive, not erased, when absent from a range", async () => {
	const ctx = context(TOOLS);
	let payload = TOOLS;
	ctx.reader.api = async <T>() => payload as T;
	const feature = createAnalyticsFeature("tools", ctx);
	await feature.load("all");
	feature.handleInput("f");
	payload = { byTool: [TOOLS.byTool[1]], byToolModel: [TOOLS.byToolModel[2]], series: [TOOLS.series[1]] };
	await feature.load("7d");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Tool filter: All tools");
	payload = TOOLS;
	await feature.load("all");
	expect(feature.render(180, 60).map(stripForTest).join("\n")).toContain("Tool filter: alpha");
});

test("model request trends expose identities outside the top chart and retain inspected timestamps across refresh", async () => {
	let payload: ModelDashboardPayload = {
		byModel: Array.from({ length: 8 }, (_, index) => ({ ...MODELS.byModel[0], model: `rank-${index}`, totalRequests: 20 - index })),
		modelSeries: Array.from({ length: 8 }, (_, index) => ({ timestamp: NOW, model: `rank-${index}`, provider: "provider-a", requests: 20 - index })),
		modelPerformanceSeries: [],
	};
	const ctx = context(payload);
	ctx.reader.api = async <T>() => payload as T;
	const feature = createAnalyticsFeature("models", ctx);
	await feature.load("all");
	feature.handleInput("\t"); feature.handleInput("/"); feature.handleInput("rank-7"); feature.handleInput("\r"); feature.handleInput("\r");
	feature.handleInput("m");
	let text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toContain("Model request trend");
	expect(text).toMatch(/rank-7 · provider-a\s+13/);
	payload = { ...payload, modelSeries: [...payload.modelSeries, { timestamp: NOW - DAY, model: "rank-7", provider: "provider-a", requests: 4 }] };
	await feature.load("all");
	text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toMatch(/rank-7 · provider-a\s+13/);
	feature.handleInput(",");
	expect(feature.render(100, 40).map(stripForTest).join("\n")).toMatch(/rank-7 · provider-a\s+4/);
});

test("tool details expose every by-tool metric and per-tool trend without changing the model filter", async () => {
	const feature = createAnalyticsFeature("tools", context(TOOLS));
	await feature.load("all");
	feature.handleInput("\t"); feature.handleInput("d");
	let text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toContain("Details: alpha");
	expect(text).toContain("Tool call trend (all models)");
	expect(text).toContain("10");
	expect(text).toContain("resultChars: 40");
	expect(text).toContain("argsChars: 20");
	feature.handleInput("b");
	text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toContain("Tool filter: All tools");
	feature.handleInput("\r");
	expect(feature.render(100, 40).map(stripForTest).join("\n")).toContain("Tool filter: alpha");
});

test("chart legend selection retains the tool identity when ranking changes and earlier buckets arrive", async () => {
	let payload = TOOLS;
	const ctx = context(payload);
	ctx.reader.api = async <T>() => payload as T;
	const feature = createAnalyticsFeature("tools", ctx);
	await feature.load("all"); feature.handleInput("n"); feature.render(100, 40);
	payload = { ...TOOLS, series: [...TOOLS.series, { timestamp: NOW - DAY, tool: "beta", calls: 20, errors: 1 }] };
	await feature.load("all");
	let text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toContain("beta");
	feature.handleInput("v");
	text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).toMatch(/beta\s+hidden/);
	expect(text).toContain("alpha");
});

test("a model detail absent from the new range cannot trap the visible table keyboard", async () => {
	let payload = MODELS;
	const ctx = context(payload);
	ctx.reader.api = async <T>() => payload as T;
	const feature = createAnalyticsFeature("models", ctx);
	await feature.load("all");
	feature.handleInput("\t"); feature.handleInput("\r");
	payload = { ...MODELS, byModel: [{ ...MODELS.byModel[0], model: "new-model" }, { ...MODELS.byModel[0], model: "other-model", totalRequests: 1 }] };
	await feature.load("7d");
	expect(feature.handleInput("j")).toBe(true);
	feature.handleInput("\r");
	expect(feature.render(100, 40).map(stripForTest).join("\n")).toContain("Details: other-model · provider-a");
});

test("analytics tables keep formatted numbers and searched identity within narrow widths", async () => {
	for (const [id, payload] of [["models", MODELS], ["costs", { costSeries: COST_POINTS }], ["tools", TOOLS]] as const) {
		const feature = createAnalyticsFeature(id, context(payload));
		await feature.load("all"); feature.handleInput("\t"); feature.handleInput("/");
		feature.handleInput(id === "tools" ? "alpha" : "provider-b");
		for (const width of [24, 40, 100]) expect(feature.render(width, 30).every(line => visibleWidth(line) <= width)).toBe(true);
		feature.handleInput("\r"); feature.handleInput(id === "tools" ? "d" : "\r");
		expect(feature.render(100, 40).map(stripForTest).join("\n")).toContain(id === "tools" ? "Details: alpha" : "Details: same-model · provider-b");
	}
});

test("performance retains missing samples as gaps, separately from measured zero", async () => {
	const missing = { ...MODELS, modelPerformanceSeries: MODELS.modelPerformanceSeries.map(point => ({ ...point, avgTtft: null, avgTokensPerSecond: null })) };
	const feature = createAnalyticsFeature("models", context(missing));
	await feature.load("all"); feature.handleInput("\t"); feature.handleInput("\r");
	const text = feature.render(100, 40).map(stripForTest).join("\n");
	expect(text).not.toMatch(/(?:^|\s)0\.0 tok\/s/);
	feature.handleInput("n"); feature.handleInput("v");
	const zero = { ...MODELS, modelPerformanceSeries: MODELS.modelPerformanceSeries.map(point => ({ ...point, avgTtft: 0, avgTokensPerSecond: 0 })) };
	const measured = createAnalyticsFeature("models", context(zero));
	await measured.load("all"); measured.handleInput("\t"); measured.handleInput("\r");
	const measuredText = measured.render(100, 40).map(stripForTest).join("\n");
	expect(measuredText).toMatch(/(?:^|\s)0\.0 tok\/s/);
});
