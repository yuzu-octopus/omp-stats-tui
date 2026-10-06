import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { glyph } from "../src/tui/glyphs";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { GainDashboardStats, ProviderDashboardStats, ProviderWindowInsight, UsageWindowSeries } from "@oh-my-pi/omp-stats/shared-types";
import type { FeatureContext, FeatureReader } from "../src/tui/features/types";
import { createProvidersFeature } from "../src/tui/features/providers";
import { createGainFeature } from "../src/tui/features/gain";
import { accountNames, accountReadings, resolveWindow, savingsHistory, utilization } from "../src/tui/features/provider-gain-data";
import { stripForTest } from "../src/tui/palette";

ensureThemeSync();
const now = Date.UTC(2026, 9, 5, 12);
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function context(api: FeatureReader["api"]): FeatureContext {
	return { reader: { api, fetch: async () => ({}) }, theme, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {}, now: () => now };
}
function insight(provider: string, windowKey: string, consumed = 1): ProviderWindowInsight {
	return { provider, windowKey, windowLabel: windowKey, accounts: 1, cycles: 0, fractionConsumed: consumed, estTokensPerWindow: 100, peakConcurrentFraction: 0.5, idealAccounts: 1, exhaustedEvents: 0 };
}
function account(provider: string, key: string, fraction = 0.5): UsageWindowSeries {
	return { provider, accountKey: key, accountLabel: "shared@example", windowKey: "day", windowLabel: "Daily", points: [{ timestamp: now, usedFraction: fraction, exhausted: fraction >= 1 }] };
}
const local: ProviderDashboardStats = {
	providers: [{ provider: "local-only", totalRequests: 9, failedRequests: 1, models: 2, totalInputTokens: 100, totalOutputTokens: 500, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalTokens: 600, totalCost: 2, unpricedRequests: 1, totalPremiumRequests: 0, avgTokensPerSecond: null }],
	hourly: [{ provider: "local-only", hour: 12, totalTokens: 600, outputTokens: 500, requests: 9 }],
	series: [],
};
function gain(project: string | null, savedTokens: number, projects = ["/a", "/ab"]): GainDashboardStats {
	const totals = { savedTokens, savedBytes: savedTokens * 4, hits: 1, outputBytes: 0, originalBytes: 0, reductionPercent: null };
	return { project, projects, overall: totals, bySource: { snapcompact: totals }, timeSeries: [{ date: "2026-10-05", snapcompact: savedTokens, total: savedTokens }] };
}

test("windows resolve by provider + limit identity, then same provider, then highest burn", () => {
	const rows = [insight("a", "day", 1), insight("b", "day", 9), insight("a", "week", 2)];
	expect(resolveWindow(rows, { provider: "a", windowKey: "week" })).toEqual({ provider: "a", windowKey: "week" });
	expect(resolveWindow(rows, { provider: "a", windowKey: "gone" })).toEqual({ provider: "a", windowKey: "day" });
	expect(resolveWindow(rows, { provider: "gone", windowKey: "day" })).toEqual({ provider: "b", windowKey: "day" });
	expect(resolveWindow([], null)).toBeNull();
});

test("duplicate account labels retain stable sorted-key identities across windows", () => {
	const a = account("a", "key-a"), b = account("a", "key-b");
	const secondWindow = { ...a, windowKey: "week" };
	expect([...accountNames([b, secondWindow, a])]).toEqual([["key-a", "shared@example #1"], ["key-b", "shared@example #2"]]);
});

test("account readings ignore missing fractions, reset jitter, and six-hour history gaps", () => {
	const a = account("a", "one");
	a.points = [
		{ timestamp: now - 8 * 3_600_000, usedFraction: 0.8, exhausted: false },
		{ timestamp: now - 7 * 3_600_000, usedFraction: 0.78, exhausted: false },
		{ timestamp: now, usedFraction: null, exhausted: true },
	];
	const reading = accountReadings(a);
	expect(reading.resets).toBe(0);
	expect(reading.peak).toBe(0.8);
	expect(reading.latest?.fraction).toBe(0.78);
	const chart = utilization([a]);
	expect(chart.rows[0].values.at(-1)).toBeNull();
	expect(chart.exhausted.at(-1)).toEqual(["one"]);
});

test("local provider load resolves and stays interactive while broker windows are pending or fail", async () => {
	const windows = deferred<never>();
	const controller = createProvidersFeature(context(async <T>(path: string) => (path.endsWith("/providers") ? local : await windows.promise) as T));
	await controller.load("24h");
	expect(stripForTest(controller.render(110, 30).join("\n"))).toContain("local-only");
	expect(controller.handleInput("v")).toBe(true);
	windows.reject(new Error("broker offline"));
	await Promise.resolve(); await Promise.resolve();
	const text = stripForTest(controller.render(110, 30).join("\n"));
	expect(text).toContain("broker offline");
	expect(text).toMatch(/\b600\b/);
	expect(controller.handleInput("q")).toBe(false);
	controller.dispose();
});

test("late account response never replaces the selected provider or duplicate account identity", async () => {
	const a = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	const b = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	const windows = [insight("a", "day", 2), insight("b", "day", 1)];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) return local as T;
		if (!params?.provider) return { windowInsights: windows, usageSeries: [] } as T;
		return await (params.provider === "a" ? a.promise : b.promise) as T;
	}));
	await controller.load("24h");
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
	controller.handleInput("p");
	b.resolve({ windowInsights: windows, usageSeries: [account("b", "b-first", 0.9), account("b", "b-second", 0.3)] });
	await Promise.resolve(); await Promise.resolve();
	a.resolve({ windowInsights: windows, usageSeries: [account("a", "wrong-provider", 1)] });
	await Promise.resolve(); await Promise.resolve();
	const text = stripForTest(controller.render(130, 50).join("\n"));
	expect(text).toContain("Provider b");
	expect(text).toContain("shared@example #1");
	expect(text).toContain("shared@example #2");
	expect(text).not.toContain("wrong-provider");
	controller.dispose();
});

test("gain scopes totals and history through server project requests, never local prefix matches", async () => {
	const first = deferred<GainDashboardStats>(), second = deferred<GainDashboardStats>();
	const queries: (string | null)[] = [];
	const controller = createGainFeature(context(async <T>(_path: string, params?: Record<string, string>) => {
		const project = params?.project ?? null; queries.push(project);
		return (project === null ? gain(null, 900) : await (project === "/a" ? first.promise : second.promise)) as T;
	}));
	await controller.load("24h");
	const overview = stripForTest(controller.render(120, 50).join("\n"));
	expect(overview).toContain(`${glyph(theme.getSymbolPreset(), "rowCursor")} All projects`);
	expect(overview).toContain("snapcompact");
	expect(overview).toContain("saved 900 · cumulative 900");
	controller.handleInput("p"); // /a
	controller.handleInput("p"); // /ab
	second.resolve(gain("/ab", 17));
	await Promise.resolve(); await Promise.resolve();
	first.resolve(gain("/a", 800));
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("v");
	const text = stripForTest(controller.render(120, 50).join("\n"));
	expect(queries).toEqual([null, "/a", "/ab"]);
	expect(text).toContain("Gain · 24h · /ab");
	expect(text).toMatch(/\b17\b/);
	expect(text).toContain("saved 17 · cumulative 17");
	expect(text).not.toMatch(/\b800\b/);
	controller.dispose();
});

test("gain remembers selected project outside current range and shows unknown reduction explicitly", async () => {
	let selectedLoads = 0;
	const controller = createGainFeature(context(async <T>(_path: string, params?: Record<string, string>) => {
		if (!params?.project) return gain(null, 2, ["/remember"]) as T;
		selectedLoads++;
		return gain(params.project, selectedLoads === 1 ? 2 : 0, []) as T;
	}));
	await controller.load("24h"); controller.handleInput("p");
	await Promise.resolve(); await Promise.resolve();
	await controller.load("1h");
	const text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text.split("\n").some(line => line.includes(`${glyph(theme.getSymbolPreset(), "rowCursor")} /remember`))).toBe(true);
	expect(text).toContain("original size not recorded");
	controller.handleInput("P");
	await Promise.resolve(); await Promise.resolve();
	expect(stripForTest(controller.render(120, 40).join("\n"))).toContain("All projects");
	controller.dispose();
});

test("gain history densifies UTC days and cumulative starts at the scoped range", () => {
	const history = savingsHistory([{ date: "2026-10-03", snapcompact: 2 }, { date: "2026-10-05", snapcompact: 7 }], "7d", now);
	expect(history.daily.slice(-3)).toEqual([2, 0, 7]);
	expect(history.cumulative.slice(-3)).toEqual([2, 2, 9]);
});

test("disposed controllers ignore late reads without changed callbacks", async () => {
	const pending = deferred<GainDashboardStats>();
	let changes = 0;
	const ctx = context(async <T>() => await pending.promise as T); ctx.changed = () => { changes++; };
	const controller = createGainFeature(ctx);
	const loading = controller.load("7d");
	controller.dispose();
	const before = changes;
	pending.resolve(gain(null, 500));
	await loading;
	expect(changes).toBe(before);
	expect(stripForTest(controller.render(110, 30).join("\n"))).not.toMatch(/\b500\b/);
});

test("old-range window failure cannot replace the newest empty-snapshot state", async () => {
	const old = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	const current = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) return local as T;
		return await (params?.range === "24h" ? old.promise : current.promise) as T;
	}));
	await controller.load("24h");
	await controller.load("1h");
	current.resolve({ windowInsights: [], usageSeries: [] });
	await Promise.resolve(); await Promise.resolve();
	old.reject(new Error("obsolete broker failure"));
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
	const text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("No usage snapshots in this range");
	expect(text).not.toContain("obsolete broker failure");
	expect(controller.handleInput("\x1b[C")).toBe(false);
	controller.dispose();
});

test("provider totals keep the chosen token mix through sorting and refreshed rankings", async () => {
	const a = { ...local.providers[0], provider: "a", totalTokens: 900 };
	const b = { ...local.providers[0], provider: "b", totalTokens: 600, totalCacheReadTokens: 75 };
	let providers = [a, b];
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, providers } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	expect(stripForTest(controller.render(120, 40).join("\n"))).toMatch(/Uncached input\s+100/);
	controller.handleInput("j");
	controller.handleInput("o");
	controller.handleInput("d");
	controller.handleInput("\r");
	let text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("Selected b");
	expect(text).toMatch(/Cache read\s+75/);
	providers = [{ ...b, totalTokens: 2_000 }, a];
	await controller.load("24h");
	text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("Selected b");
	expect(text).toMatch(/Cache read\s+75/);
	controller.dispose();
});

test("burn legends aggregate Other and honor hidden series while exposing range totals", async () => {
	const series = [80, 70, 60, 50, 40, 30, 20, 10].map((tokens, i) => ({
		timestamp: now, provider: `p${i}`, totalTokens: tokens, outputTokens: tokens / 2, requests: 1, cost: tokens / 100, unpricedRequests: 0,
	}));
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, series } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("v");
	let text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text.split("\n").some(line => /p0\s+80\s*·\s*80/.test(line))).toBe(true);
	expect(text.split("\n").some(line => /Other \(2\)\s+30\s*·\s*30/.test(line))).toBe(true);
	expect(text).not.toMatch(/p6\s+20/);
	for (let i = 0; i < 6; i++) controller.handleInput("n");
	controller.handleInput(" ");
	text = stripForTest(controller.render(120, 50).join("\n"));

	expect(text).not.toMatch(/Other \(2\)\s+30/);
	controller.handleInput(" ");
	controller.handleInput("m");
	text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text).toMatch(/Other \(2\)\s+15\s*·\s*15/);
	controller.dispose();
});

test("retained account histories refresh independently of local and fleet-window failures", async () => {
	const refreshWindows = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	let refreshed = false;
	let accountLoads = 0;
	const windows = [insight("a", "day")];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) {
			if (refreshed) throw new Error("local refresh unavailable");
			return local as T;
		}
		if (!params?.provider) return (refreshed ? await refreshWindows.promise : { windowInsights: windows, usageSeries: [] }) as T;
		accountLoads++;
		return { windowInsights: windows, usageSeries: [account("a", "remembered", refreshed ? 0.95 : 0.2)] } as T;
	}));
	await controller.load("24h");
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("\x1b[Z");
	controller.render(140, 50);
	refreshed = true;
	await controller.load("7d");
	await Promise.resolve(); await Promise.resolve();
	let text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("local refresh unavailable");
	expect(text).toContain("Loading windows independently");
	expect(text).toContain("Account key remembered");
	expect(text).toContain("Latest 95.0%");
	expect(text).toContain("headroom 5.0%");
	refreshWindows.reject(new Error("fleet offline"));
	await Promise.resolve(); await Promise.resolve();
	text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("fleet offline");
	expect(text).toContain("Latest 95.0%");
	expect(accountLoads).toBe(2);
	controller.dispose();
});

test("retrying fleet and accounts does not issue a second account read when fleet completes later", async () => {
	const retryWindows = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	let retry = false;
	let accountLoads = 0;
	const windows = [insight("a", "day")];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) return local as T;
		if (!params?.provider) return (retry ? await retryWindows.promise : { windowInsights: windows, usageSeries: [] }) as T;
		accountLoads++;
		return { windowInsights: windows, usageSeries: [account("a", "one", retry ? 0.6 : 0.3)] } as T;
	}));
	await controller.load("24h");
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("\x1b[Z");
	retry = true; controller.handleInput("u");
	await Promise.resolve(); await Promise.resolve();
	expect(stripForTest(controller.render(130, 50).join("\n"))).toContain("Latest 60.0%");
	retryWindows.resolve({ windowInsights: windows, usageSeries: [] });
	await Promise.resolve(); await Promise.resolve();
	expect(accountLoads).toBe(2);
	expect(stripForTest(controller.render(130, 50).join("\n"))).toContain("Latest 60.0%");
	controller.dispose();
});

test("account rows select independent limit windows and retain identity through sorting", async () => {
	const day = account("a", "key-day", 0.9);
	const week = { ...account("a", "key-week", 0.4), windowKey: "week", windowLabel: "Weekly" };
	week.points = [
		{ timestamp: now - 3_600_000, usedFraction: 0.8, exhausted: false },
		{ timestamp: now, usedFraction: 0.4, exhausted: false },
	];
	const windows = [insight("a", "day", 2), { ...insight("a", "week"), accounts: 2, idealAccounts: 3, peakConcurrentFraction: 2.4, exhaustedEvents: 1 }];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => (
		path.endsWith("/providers") ? local : { windowInsights: windows, usageSeries: params?.provider ? [day, week] : [] }
	) as T));
	await controller.load("24h");
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("\x1b[Z");
	controller.render(150, 50);
	controller.handleInput("j");
	controller.handleInput("o");
	controller.handleInput("\r");
	let text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("window week");
	expect(text).toContain("Account key key-week");
	expect(text).toContain("headroom 60.0% · resets 1");
	expect(text).toMatch(/shared@example #2\s+40\.0%/);
	controller.handleInput("\x1b[Z");
	text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("fleet 2 accounts");
	expect(text).toContain("Accounts needed 3 at <90%");
	expect(text).toContain("short 1");
	controller.dispose();
});

test("gain keeps long project selections in a bounded viewport and exposes selected-day and source details", async () => {
	const projects = Array.from({ length: 30 }, (_, i) => `/project-${i}`);
	const controller = createGainFeature(context(async <T>(_path: string, params?: Record<string, string>) => gain(params?.project ?? null, 25, projects) as T));
	await controller.load("7d");
	for (let i = 0; i < 26; i++) controller.handleInput("p");
	await Promise.resolve(); await Promise.resolve();
	let text = stripForTest(controller.render(130, 24).join("\n"));
	expect(text).toContain(`${glyph(theme.getSymbolPreset(), "rowCursor")} /project-25`);
	expect(text).not.toContain(`${glyph(theme.getSymbolPreset(), "rowCursor")} All projects`);
	expect(text).toMatch(/\b25\b/);
	expect(text).not.toContain("/project-0");
	controller.handleInput("\t");
	controller.handleInput("h");
	text = stripForTest(controller.render(130, 50).join("\n"));
	expect(text).toContain("Day 2026-10-04 · saved 0 · cumulative 0");
	controller.handleInput("l");
	controller.handleInput("\r");
	text = stripForTest(controller.render(130, 50).join("\n"));
	expect(text).toContain("25 tokens");
	expect(text).toContain("original size unknown");
	expect(text).toContain("original 0 B · output 0 B");
	controller.handleInput("\x1b");
	expect(stripForTest(controller.render(130, 50).join("\n"))).not.toContain("25 tokens");
	controller.dispose();
});

test("peak local hours filters all metrics, retains provider across views, and leaves zero hours empty", async () => {
	const providers = ["a", "b"].map(provider => ({ ...local.providers[0], provider }));
	const hourly = [
		{ provider: "a", hour: 23, totalTokens: 50, outputTokens: 20, requests: 2 },
		{ provider: "b", hour: 12, totalTokens: 100, outputTokens: 70, requests: 3 },
	];
	let empty = false;
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, providers, hourly: empty ? [] : hourly } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("v"); controller.handleInput("v");
	expect(stripForTest(controller.render(140, 50).join("\n"))).toContain("Provider All providers · peak 12:00");
	controller.handleInput("p"); controller.handleInput("h");
	let text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("Provider a · peak 23:00");
	expect(text).toContain("Hour 23:00 local · 50 tokens · 20 output · 2 requests");
	controller.handleInput("v"); controller.handleInput("\x1b[Z");
	expect(stripForTest(controller.render(140, 50).join("\n"))).toContain("Provider a · peak 23:00");
	empty = true; await controller.load("24h");
	text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("No activity in this range");
	expect(text).not.toContain(glyph(theme.getSymbolPreset(), "barFill"));
	controller.dispose();
});

test("hidden account utilization omits numeric tooltip but preserves exhausted snapshots without fractions", async () => {
	const missing = account("a", "one");
	missing.points = [{ timestamp: now, usedFraction: null, exhausted: true }];
	const windows = [insight("a", "day")];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => (
		path.endsWith("/providers") ? local : { windowInsights: windows, usageSeries: params?.provider ? [missing] : [] }
	) as T));
	await controller.load("24h");
	await Promise.resolve(); await Promise.resolve();
	controller.handleInput("\x1b[Z");
	let text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("Latest No numeric reading");
	expect(text).toMatch(/shared@example\s+No reading \(gap\)/);
	expect(text).toContain("EXHAUSTED: shared@example");
	controller.handleInput(" ");
	text = stripForTest(controller.render(150, 50).join("\n"));

	expect(text).not.toContain("No reading (gap)");
	expect(text).toContain("EXHAUSTED: shared@example");
	controller.dispose();
});

test("empty gain journals do not render pretend source records or daily plots at any focus", async () => {
	const payload = gain(null, 0);
	payload.overall.hits = 0;
	payload.timeSeries = [];
	const controller = createGainFeature(context(async <T>() => payload as T));
	await controller.load("24h");
	for (let focus = 0; focus < 3; focus++) {
		for (const width of [28, 40, 100]) {
			const lines = controller.render(width, 30);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(stripForTest(lines.join("\n"))).not.toContain(`${glyph(theme.getSymbolPreset(), "rowCursor")} snapcompact`);
			expect(stripForTest(lines.join("\n"))).not.toContain("2026-10-05");
			expect(stripForTest(lines.join("\n"))).toContain("Projects");
		}
		controller.handleInput("\t");
	}
	controller.dispose();
});

test("provider tables and populated gain charts stay within narrow panel widths", async () => {
	const provider = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? local : { windowInsights: [insight("a", "day")], usageSeries: [account("a", "one")] }
	) as T));
	const savings = createGainFeature(context(async <T>() => gain(null, 1234) as T));
	await provider.load("24h");
	await savings.load("7d");
	await Promise.resolve(); await Promise.resolve();
	for (const width of [28, 40, 100]) {
		for (let view = 0; view < 5; view++) {
			expect(provider.render(width, 30).every(line => visibleWidth(line) <= width)).toBe(true);
			provider.handleInput("\t");
		}
		for (let focus = 0; focus < 3; focus++) {
			expect(savings.render(width, 30).every(line => visibleWidth(line) <= width)).toBe(true);
			savings.handleInput("\t");
		}
	}
	provider.dispose(); savings.dispose();
});
