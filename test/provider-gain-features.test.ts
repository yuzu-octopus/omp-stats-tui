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
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
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
	// Broker I/O starts only when the Windows view is entered.
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
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
	await settle();
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
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
	await controller.load("1h");
	current.resolve({ windowInsights: [], usageSeries: [] });
	await settle();
	old.reject(new Error("obsolete broker failure"));
	await settle();
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
	controller.render(120, 40);
	controller.handleInput("j");
	controller.handleInput("o");
	controller.handleInput("d");
	controller.handleInput("\r");
	let text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("Selected b");
	expect(text).toContain("Cache read: 75");
	providers = [{ ...b, totalTokens: 2_000 }, a];
	await controller.load("24h");
	text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("Selected b");
	expect(text).toContain("Cache read: 75");
	controller.dispose();
});

test("burn tooltips aggregate Other and honor hidden series while legends expose range totals", async () => {
	const series = [80, 70, 60, 50, 40, 30, 20, 10].map((tokens, i) => ({
		timestamp: now, provider: `p${i}`, totalTokens: tokens, outputTokens: tokens / 2, requests: 1, cost: tokens / 100, unpricedRequests: 0,
	}));
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, series } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("v");
	let text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text).toContain("Other (2): 30 tokens");
	expect(text.split("\n").some(line => /p0\s+80\s*·\s*80/.test(line))).toBe(true);
	expect(text.split("\n").some(line => /Other \(2\)\s+30\s*·\s*30/.test(line))).toBe(true);
	expect(text).not.toContain("p6: 20");
	for (let i = 0; i < 6; i++) controller.handleInput("n");
	controller.handleInput(" ");
	text = stripForTest(controller.render(120, 50).join("\n"));

	expect(text).not.toContain("Other (2): 30 tokens");
	controller.handleInput(" ");
	controller.handleInput("m");
	text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text).toContain("Other (2): 15 output");
	controller.dispose();
});

test("retained account histories refresh independently of local and fleet-window failures", async () => {
	const refreshWindows = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	const failedWindows = deferred<{ windowInsights: ProviderWindowInsight[]; usageSeries: UsageWindowSeries[] }>();
	let refreshed = false;
	let failing = false;
	let accountLoads = 0;
	const windows = [insight("a", "day")];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) {
			if (refreshed) throw new Error("local refresh unavailable");
			return local as T;
		}
		if (!params?.provider) return (failing ? await failedWindows.promise : refreshed ? await refreshWindows.promise : { windowInsights: windows, usageSeries: [] }) as T;
		accountLoads++;
		return { windowInsights: windows, usageSeries: [account("a", "remembered", refreshed ? 0.95 : 0.2)] } as T;
	}));
	await controller.load("24h");
	controller.handleInput("\x1b[Z");
	await settle();
	controller.render(140, 50);
	refreshed = true;
	await controller.load("7d");
	await settle();
	let text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("local refresh unavailable");
	expect(text).toContain("Loading windows independently");
	refreshWindows.resolve({ windowInsights: windows, usageSeries: [] });
	await settle();
	text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("Account key remembered");
	expect(text).toContain("Latest 95.0%");
	expect(text).toContain("headroom 5.0%");
	failing = true;
	controller.handleInput("u");
	await settle();
	failedWindows.reject(new Error("fleet offline"));
	await settle();
	text = stripForTest(controller.render(140, 50).join("\n"));
	expect(text).toContain("fleet offline");
	expect(text).toContain("Latest 95.0%");
	expect(accountLoads).toBe(3);
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
	controller.handleInput("\x1b[Z");
	await settle();
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
	controller.handleInput("\x1b[Z");
	await settle();
	controller.render(150, 50);
	controller.handleInput("j");
	controller.handleInput("o");
	controller.handleInput("\r");
	let text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("window week");
	expect(text).toContain("Account key key-week");
	expect(text).toContain("headroom 60.0% · resets 1");
	expect(text).toContain("shared@example #2: 40.0%");
	controller.handleInput("\x1b[Z");
	text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("fleet 2 accounts");
	expect(text).toContain("Accounts needed 3 at <90% · have 2 · short 1");
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
	controller.handleInput("\x1b[Z");
	await settle();
	let text = stripForTest(controller.render(150, 50).join("\n"));
	expect(text).toContain("Latest No numeric reading");
	expect(text).toContain("shared@example: No reading (gap)");
	expect(text).toContain("EXHAUSTED: shared@example");
	controller.handleInput(" ");
	text = stripForTest(controller.render(150, 50).join("\n"));

	expect(text).not.toContain("shared@example: No reading (gap)");
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

test("a malformed providers payload renders a defined error state instead of throwing", async () => {
	const controller = createProvidersFeature(context(async <T>() => ({}) as T));
	await controller.load("30d");
	let lines: readonly string[] = [];
	expect(() => { lines = controller.render(110, 30); }).not.toThrow();
	expect(stripForTest(lines.join("\n"))).toContain("Providers payload missing");
	controller.dispose();
});

test("load performs no broker window call; entering the Windows view does", async () => {
	const paths: string[] = [];
	const controller = createProvidersFeature(context(async <T>(path: string) => {
		paths.push(path);
		return (path.endsWith("/providers") ? local : { windowInsights: [], usageSeries: [] }) as T;
	}));
	await controller.load("30d");
	expect(paths.some(path => path.includes("provider-windows"))).toBe(false);
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
	await settle();
	expect(paths.some(path => path.includes("provider-windows"))).toBe(true);
	controller.dispose();
});

test("an all-unpriced cost bucket reads N/A in the burn legend, never $0.00", async () => {
	const series = [
		{ timestamp: now - 24 * 3_600_000, provider: "p", totalTokens: 10, outputTokens: 5, requests: 2, cost: 5, unpricedRequests: 0 },
		{ timestamp: now, provider: "p", totalTokens: 10, outputTokens: 5, requests: 2, cost: 0, unpricedRequests: 2 },
	];
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, series } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("v");
	controller.handleInput("m"); controller.handleInput("m"); controller.handleInput("m");
	const text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text).toContain("N/A · 2 unpriced");
	expect(text).not.toContain("$0.00");
	controller.dispose();
});

test("provider totals sort by request share, not tokens", async () => {
	const many = { ...local.providers[0], provider: "many-requests", totalRequests: 90, totalTokens: 100 };
	const few = { ...local.providers[0], provider: "few-requests", totalRequests: 10, totalTokens: 900 };
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, providers: [few, many] } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	let text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text.indexOf("few-requests")).toBeLessThan(text.indexOf("many-requests"));
	for (let i = 0; i < 5; i++) controller.handleInput("o");
	text = stripForTest(controller.render(120, 40).join("\n"));
	expect(text).toContain("request share");
	expect(text.indexOf("many-requests")).toBeLessThan(text.indexOf("few-requests"));
	controller.dispose();
});

test("clicking a windows row scopes the utilization chart like j/k does", async () => {
	const windows = [insight("a", "day", 2), insight("b", "day", 1)];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => {
		if (path.endsWith("/providers")) return local as T;
		if (!params?.provider) return { windowInsights: windows, usageSeries: [] } as T;
		return { windowInsights: windows, usageSeries: [account(params.provider, "k")] } as T;
	}));
	await controller.load("24h");
	// Three "v" presses reach the Windows view (Totals -> Burn -> Hours -> Windows).
	controller.handleInput("v"); controller.handleInput("v"); controller.handleInput("v");
	await settle();
	const before = stripForTest(controller.render(130, 50).join("\n"));
	expect(before).toContain("Subscription windows");
	// Keyboard: move selection with j/k (selects via selectWindow already).
	controller.handleInput("j");
	const viaKeys = stripForTest(controller.render(130, 50).join("\n"));
	// Click the first window row directly: same scoping without Tab navigation.
	expect(typeof controller.handleHit).toBe("function");
	controller.handleHit!({ type: "selectRow", key: "a::day" });
	const viaClick = stripForTest(controller.render(130, 50).join("\n"));
	// The windows detail block names the selected window; Enter would navigate,
	// clicks select in place.
	expect(viaClick).toContain("a · day");
	controller.dispose();
});

test("output burn names older points without output tokens as gaps, never zero", async () => {
	const old = now - 20 * 3_600_000;
	const series = [
		{ timestamp: old, provider: "p", totalTokens: 10, requests: 1, cost: 1, unpricedRequests: 0 },
		{ timestamp: now, provider: "p", totalTokens: 10, outputTokens: 5, requests: 1, cost: 1, unpricedRequests: 0 },
	];
	const controller = createProvidersFeature(context(async <T>(path: string) => (
		path.endsWith("/providers") ? { ...local, series } : { windowInsights: [], usageSeries: [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("v");
	controller.handleInput("m");
	for (let i = 0; i < 20; i++) controller.handleInput("h");
	const text = stripForTest(controller.render(120, 50).join("\n"));
	expect(text).toContain("Output burn unavailable for older payload points (gaps, not zero).");
	expect(text).toContain(new Date(old).toISOString());
	expect(text).not.toContain(": 0 output");
	expect(text).toMatch(/p\s+— · 5/);
	controller.dispose();
});

test("utilization keeps null readings as gaps while exhausted accounts stay named", async () => {
	const numeric = account("a", "one", 0.5);
	const gap = account("a", "two", 0.5);
	gap.points = [{ timestamp: now, usedFraction: null, exhausted: true }];
	const windows = [insight("a", "day")];
	const controller = createProvidersFeature(context(async <T>(path: string, params?: Record<string, string>) => (
		path.endsWith("/providers") ? local : { windowInsights: windows, usageSeries: params?.provider ? [numeric, gap] : [] }
	) as T));
	await controller.load("24h");
	controller.handleInput("\x1b[Z");
	await settle();
	const text = stripForTest(controller.render(150, 50).join("\n"));
	const gapLine = text.split("\n").find(line => line.includes("shared@example #2:"));
	expect(gapLine).toContain("No reading (gap)");
	expect(gapLine).not.toContain("%");
	expect(text).toContain("shared@example #1: 50.0%");
	expect(text).toContain("EXHAUSTED: shared@example #2");
	controller.dispose();
});
