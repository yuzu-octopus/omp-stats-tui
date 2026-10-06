import { expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { FrustrationDashboardStats, FrustrationEstimate, FrustrationJobStatus, FrustrationModelStats } from "@oh-my-pi/omp-stats/shared-types";
import { createFrustrationFeature } from "../src/tui/features/frustration";
import { activeModelClass, familyKey, filterFrustrationRows, layerFraction, mostlyRegex, sortFrustrationRows } from "../src/tui/features/frustration-data";
import { stripForTest } from "../src/tui/palette";
import type { FeatureContext, StatsApiOptions } from "../src/tui/features/types";

const IDLE: FrustrationJobStatus = { state: "idle", total: 0, done: 0, failed: 0, cost: 0, judge: null, error: null, startedAt: null, finishedAt: null, concurrency: 0 };
const QUOTE: FrustrationEstimate = { available: true, messages: 4, chars: 100, inputTokens: 2262, cost: 0.013, judge: "judge/test" };
function model(key: string, overrides: Partial<FrustrationModelStats> = {}): FrustrationModelStats {
	return { key, label: key, modelClass: "anthropic", family: "opus", revision: "4.5.0", models: [`raw/${key}`], firstSeen: 1_000, messages: 100, judged: 75, annoyed: 30, atAssistant: 20, angry: 5, ...overrides };
}
function dashboard(rows: FrustrationModelStats[] = [model("opus 4.5")], job: FrustrationJobStatus = IDLE): FrustrationDashboardStats {
	const overall = { messages: 0, judged: 0, annoyed: 0, atAssistant: 0, angry: 0 };
	for (const row of rows) for (const key of ["messages", "judged", "annoyed", "atAssistant", "angry"] as const) overall[key] += row[key];
	return { overall, byModel: rows, judgeAvailable: true, job };
}
interface RequestRecord { path: string; params?: Record<string, string>; options?: StatsApiOptions }
function harness(respond: (request: RequestRecord) => unknown | Promise<unknown>) {
	const requests: RequestRecord[] = [];
	const copied: string[] = [];
	const theme = {
		fg: (token: string, text: string) => `\x1b[${token === "error" ? 31 : token === "warning" ? 33 : token === "text" ? 37 : 36}m${text}\x1b[0m`,
		bg: (_token: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		getColorHex: (token: string) => `#${(token.length * 7919).toString(16).padStart(6, "0").slice(-6)}`,
		getColorMode: () => "truecolor",
		getSymbolPreset: () => "ascii",
		symbol: (key: string) => ({
			"boxRound.topLeft": "+", "boxRound.topRight": "+", "boxRound.bottomLeft": "+", "boxRound.bottomRight": "+",
			"boxRound.horizontal": "-", "boxRound.vertical": "|",
		} as Record<string, string>)[key],
	} as unknown as Theme;
	const ctx: FeatureContext = {
		reader: {
			async api<T>(path: string, params?: Record<string, string>, options?: StatsApiOptions): Promise<T> {
				const request = { path, params, options };
				requests.push(request);
				return await respond(request) as T;
			},
			fetch: async () => { throw new Error("Frustration uses its domain endpoint"); },
		},
		theme, changed() {}, copy: async text => { copied.push(text); }, openTrace() {}, openScreen() {}, now: () => 5_000,
	};
	const feature = createFrustrationFeature(ctx);
	return { feature, requests, copied, text: () => feature.render(100, 40).map(stripForTest).join("\n") };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("filters match web sample and regex boundaries, families use class identity, and layers partition rates", () => {
	const rows = [model("a", { messages: 50, judged: 25 }), model("b", { messages: 49, judged: 49 }), model("c", { judged: 49 }), model("d", { modelClass: "openai", family: "opus", messages: 20, judged: 5, annoyed: 4, atAssistant: 3, angry: 1 })];
	expect(activeModelClass(rows, null)).toBe("anthropic");
	expect(mostlyRegex(rows[0])).toBe(false);
	expect(mostlyRegex(rows[2])).toBe(true);
	const filters = { modelClass: "*", hiddenFamilies: new Set<string>(), showSmall: false, hideRegex: true };
	expect(filterFrustrationRows(rows, filters).map(row => row.key)).toEqual(["a"]);
	expect(filterFrustrationRows(rows, { ...filters, showSmall: true }).map(row => row.key)).toEqual(["a", "b"]);
	expect(filterFrustrationRows(rows, { ...filters, hideRegex: false, showSmall: true, hiddenFamilies: new Set([familyKey(rows[0])]) }).map(row => row.key)).toEqual(["d"]);
	const row = model("layers");
	expect(layerFraction(row, "angry") + layerFraction(row, "assistant") + layerFraction(row, "other")).toBeCloseTo(0.3);
	const rates = [model("large", { messages: 1000, annoyed: 50 }), model("small", { messages: 50, annoyed: 20 })];
	expect(sortFrustrationRows(rates, "annoyed", true).map(row => row.key)).toEqual(["small", "large"]);
	expect(sortFrustrationRows(rates, "version", false)).toEqual(rates);
});

test("passive cached view, controls, and load never spend; confirmation captures all controls and Enter", async () => {
	const quote = deferred<FrustrationEstimate>();
	let starts = 0;
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) return quote.promise;
		if (request.path.endsWith("/judge")) { starts++; return { ...IDLE, state: "done", total: 4, done: 4, cost: 0.014 }; }
		return dashboard();
	});
	await h.feature.load("7d");
	expect(h.text()).toContain("regex 25");
	expect(starts).toBe(0);
	h.feature.handleInput("j");
	for (const input of ["y", "\r", "m", "c", "x", "r", "\x1b[B"]) expect(h.feature.handleInput(input)).toBe(true);
	expect(starts).toBe(0);
	quote.resolve(QUOTE);
	await settle();
	expect(h.text()).toContain("Estimated input 2,262 tokens");
	expect(h.text()).toContain("Press y to confirm paid judging");
	h.feature.handleInput("\r");
	expect(starts).toBe(0);
	h.feature.handleInput("y");
	h.feature.handleInput("y");
	await settle();
	expect(starts).toBe(1);
	expect(h.requests.find(request => request.path.endsWith("/judge"))?.params).toEqual({ range: "7d" });
	expect(h.requests.find(request => request.path.endsWith("/judge"))?.options).toEqual({ method: "POST", headers: { "X-Omp-Stats-Action": "1" } });
	expect(h.text()).toContain("excluding <50");
	h.feature.dispose();
});

test("Esc/q and range change discard quotes; late prerequisites cannot restore confirmation or spend", async () => {
	const quotes = [deferred<FrustrationEstimate>(), deferred<FrustrationEstimate>()];
	let quoteIndex = 0;
	const h = harness(request => request.path.endsWith("/estimate") ? quotes[quoteIndex++].promise : dashboard());
	await h.feature.load("24h");
	h.feature.handleInput("j");
	expect(h.feature.handleInput("q")).toBe(false);
	expect(h.feature.handleInput("\x1b")).toBe(true);
	quotes[0].resolve(QUOTE);
	await settle();
	expect(h.text()).not.toContain("CLASSIFY WITH JUDGE");
	h.feature.handleInput("j");
	await h.feature.load("30d");
	quotes[1].resolve(QUOTE);
	await settle();
	h.feature.handleInput("y");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.dispose();
});

test("unavailable, empty quote, and start failure are honest non-spending states", async () => {
	let estimate: FrustrationEstimate = { available: false, reason: "Configure the judge model role and credentials" };
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) return estimate;
		if (request.path.endsWith("/judge")) throw new Error("Missing API key for judge/test");
		return dashboard();
	});
	await h.feature.load("all");
	h.feature.handleInput("j"); await settle();
	expect(h.text()).toContain("Configure the judge model role and credentials");
	h.feature.handleInput("y");
	expect(h.requests.some(request => request.path.endsWith("/judge"))).toBe(false);
	h.feature.handleInput("\x1b");
	estimate = { ...QUOTE, messages: 0 };
	h.feature.handleInput("j"); await settle();
	h.feature.handleInput("y");
	expect(h.text()).toContain("nothing to classify");
	expect(h.requests.some(request => request.path.endsWith("/judge"))).toBe(false);
	h.feature.handleInput("\x1b");
	estimate = QUOTE;
	h.feature.handleInput("j"); await settle();
	h.feature.handleInput("y"); await settle();
	expect(h.text()).toContain("Missing API key for judge/test");
	expect(h.text()).not.toContain("Judge running");
	h.feature.dispose();
});

test("older range payload and older running refresh cannot overwrite cancellation", async () => {
	const running = { ...IDLE, state: "running" as const, total: 8, done: 2, cost: 0.004, judge: "judge/test", startedAt: 1_000, concurrency: 4 };
	const cancelled = { ...running, state: "cancelled" as const, finishedAt: 5_000 };
	const stale = deferred<FrustrationDashboardStats>();
	let reads = 0;
	let cancelledRun = false;
	const h = harness(request => {
		if (request.path.endsWith("/cancel")) { cancelledRun = true; return cancelled; }
		if (++reads === 2) return stale.promise;
		return dashboard([model(cancelledRun ? "new range" : "initial")], cancelledRun ? cancelled : running);
	});
	await h.feature.load("24h");
	const refresh = h.feature.load("7d");
	h.feature.handleInput("x"); await settle();
	stale.resolve(dashboard([model("obsolete")], running));
	await refresh;
	expect(h.text()).toContain("Judge cancelled");
	expect(h.text()).toContain("new range");
	expect(h.text()).not.toContain("obsolete");
	expect(h.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(1);
	h.feature.dispose();
	expect(h.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(1);
});

test("close during pending start cancels the later real job and ignores late data", async () => {
	const start = deferred<FrustrationJobStatus>();
	const h = harness(request => request.path.endsWith("/estimate") ? QUOTE : request.path.endsWith("/judge") ? start.promise : request.path.endsWith("/cancel") ? { ...IDLE, state: "cancelled" } : dashboard());
	await h.feature.load("24h");
	h.feature.handleInput("j"); await settle();
	h.feature.handleInput("y");
	h.feature.dispose();
	start.resolve({ ...IDLE, state: "running", total: 4 });
	await settle();
	expect(h.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(2);
	expect(h.feature.handleInput("y")).toBe(false);
});

test("every version is reachable after reveal and raw IDs remain available at narrow widths", async () => {
	const h = harness(() => dashboard(Array.from({ length: 47 }, (_, i) => model(`version-${i}`, { models: [`raw/模型-${i}`, `other/${i}`] }))));
	await h.feature.load("24h");
	h.feature.handleInput("v"); h.feature.handleInput("v");
	for (let i = 0; i < 46; i++) h.feature.handleInput("\x1b[B");
	h.feature.handleInput("\r");
	expect(h.text()).toContain("Point 47/47: version-46");
	expect(h.text()).toContain("Raw model ID: raw/模型-46");
	h.feature.handleInput("p"); await settle();
	expect(JSON.parse(h.copied[0]).key).toBe("version-46");
	for (const width of [20, 40, 60, 100]) {
		const lines = h.feature.render(width, 40);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
	}
	h.feature.handleInput("\x1b"); // return from details before changing chart layers
	h.feature.handleInput("1"); h.feature.handleInput("2"); h.feature.handleInput("3"); h.feature.handleInput("4");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.dispose();
});

test("job polling exists only while running, refreshes cached coverage, and disposal clears its timer", async () => {
	const callbacks: Array<() => void> = [];
	const scheduled: Timer[] = [];
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
		callbacks.push(handler as () => void);
		const timer = { id: scheduled.length } as unknown as Timer;
		scheduled.push(timer);
		return timer;
	}) as typeof setTimeout);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
	let reads = 0;
	const h = harness(request => {
		if (request.path.endsWith("/cancel")) return { ...IDLE, state: "cancelled" };
		reads++;
		return dashboard([model("coverage", { judged: reads === 1 ? 25 : 100 })], { ...IDLE, state: reads < 3 ? "running" : "done", total: 100, done: reads === 1 ? 25 : 100 });
	});
	try {
		await h.feature.load("24h");
		expect(h.text()).toContain("regex 75");
		expect(callbacks).toHaveLength(1);
		callbacks.shift()!();
		await settle();
		expect(h.text()).toContain("regex 0");
		expect(callbacks).toHaveLength(1);
		callbacks.shift()!();
		await settle();
		expect(h.text()).toContain("Judge done");
		expect(callbacks).toHaveLength(0);
		expect(reads).toBe(3);
		await h.feature.load("24h");
		expect(callbacks).toHaveLength(0);
		reads = 0;
		await h.feature.load("24h");
		expect(callbacks).toHaveLength(1);
		const lateTimer = callbacks.shift()!;
		h.feature.dispose();
		expect(clear).toHaveBeenCalledWith(scheduled[scheduled.length - 1]);
		lateTimer();
		await settle();
		expect(reads).toBe(1);
		expect(h.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(1);
	} finally {
		h.feature.dispose();
		timeout.mockRestore();
		clear.mockRestore();
	}
});

test("a confirmed run stays visible and cancellable when passive metrics have never loaded", async () => {
	const running: FrustrationJobStatus = { ...IDLE, state: "running", total: 4, done: 1, failed: 1, cost: 0.006, judge: "judge/test", startedAt: 1_000, concurrency: 2 };
	const cancelled: FrustrationJobStatus = { ...running, state: "cancelled", finishedAt: 5_000 };
	let cancelFails = true;
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) return QUOTE;
		if (request.path.endsWith("/judge")) return running;
		if (request.path.endsWith("/cancel")) {
			if (cancelFails) throw new Error("Cancellation unavailable");
			return cancelled;
		}
		throw new Error("Metrics unavailable");
	});
	await h.feature.load("7d");
	h.feature.handleInput("j"); await settle();
	h.feature.handleInput("y"); await settle();
	expect(h.text()).toContain("Metrics unavailable");
	expect(h.text()).toContain("Judge running");
	expect(h.text()).toContain("1/4 judged");
	expect(h.text()).toContain("50.0%");
	expect(h.text()).toContain("2 in flight");
	h.feature.handleInput("x"); await settle();
	expect(h.text()).toContain("Cancellation unavailable");
	expect(h.text()).toContain("Judge running");
	cancelFails = false;
	h.feature.handleInput("x"); await settle();
	expect(h.text()).toContain("Judge cancelled");
	expect(h.text()).not.toContain("Cancellation unavailable");
	expect(h.text()).not.toContain("Loading cached metrics");
	expect(h.requests.filter(request => request.options?.method === "POST").every(request => request.options?.headers?.["X-Omp-Stats-Action"] === "1")).toBe(true);
	const cancellations = h.requests.filter(request => request.path.endsWith("/cancel")).length;
	h.feature.dispose();
	expect(h.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(cancellations);
});

test("a newly observed external run closes a pending quote and exposes cancellation", async () => {
	const estimate = deferred<FrustrationEstimate>();
	let job: FrustrationJobStatus = IDLE;
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) return estimate.promise;
		if (request.path.endsWith("/cancel")) return job = { ...job, state: "cancelled" };
		return dashboard(undefined, job);
	});
	await h.feature.load("24h");
	h.feature.handleInput("j");
	job = { ...IDLE, state: "running", total: 4 };
	await h.feature.load("24h");
	estimate.resolve(QUOTE); await settle();
	expect(h.text()).not.toContain("CLASSIFY WITH JUDGE");
	expect(h.text()).toContain("Judge running");
	expect(h.feature.handleInput("y")).toBe(false);
	expect(h.requests.some(request => request.path.endsWith("/judge"))).toBe(false);
	h.feature.handleInput("x"); await settle();
	expect(h.text()).toContain("Judge cancelled");
	h.feature.dispose();
});

test("cancelling during the post-start refresh permits another fresh quote after the old refresh settles", async () => {
	const stale = deferred<FrustrationDashboardStats>();
	const running: FrustrationJobStatus = { ...IDLE, state: "running", total: 4 };
	const cancelled: FrustrationJobStatus = { ...running, state: "cancelled" };
	let reads = 0;
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) return QUOTE;
		if (request.path.endsWith("/judge")) return running;
		if (request.path.endsWith("/cancel")) return cancelled;
		if (++reads === 2) return stale.promise;
		return dashboard(undefined, reads > 2 ? cancelled : IDLE);
	});
	await h.feature.load("24h");
	h.feature.handleInput("j"); await settle();
	h.feature.handleInput("y"); await settle();
	expect(h.text()).toContain("Judge running");
	h.feature.handleInput("x"); await settle();
	stale.resolve(dashboard(undefined, running)); await settle();
	expect(h.text()).toContain("Judge cancelled");
	h.feature.handleInput("j"); await settle();
	expect(h.text()).toContain("CLASSIFY WITH JUDGE");
	expect(h.requests.filter(request => request.path.endsWith("/judge"))).toHaveLength(1);
	h.feature.dispose();
});

test("failed cancellation clears an invalidated pending refresh without losing cached coverage", async () => {
	const stale = deferred<FrustrationDashboardStats>();
	const running: FrustrationJobStatus = { ...IDLE, state: "running", total: 4 };
	let reads = 0;
	const h = harness(request => {
		if (request.path.endsWith("/cancel")) throw new Error("Cannot cancel right now");
		if (++reads === 2) return stale.promise;
		return dashboard(undefined, running);
	});
	await h.feature.load("24h");
	const refresh = h.feature.load("7d");
	h.feature.handleInput("x"); await settle();
	expect(h.text()).toContain("Cannot cancel right now");
	expect(h.text()).not.toContain("Refreshing cached metrics");
	expect(h.text()).toContain("regex 25");
	stale.resolve(dashboard([model("stale")], { ...running, state: "done" }));
	await refresh;
	expect(h.text()).toContain("Judge running");
	expect(h.text()).not.toContain("Point 1/1: stale");
	h.feature.dispose();
});

test("class and family filtering retains real selected identity and known zero-rate detail", async () => {
	const rows = [
		model("boundary", { messages: 50, judged: 25 }),
		model("small", { messages: 49, judged: 25 }),
		model("regex", { family: "sonnet", judged: 49 }),
		model("other", { modelClass: "openai", family: "opus", messages: 1_000 }),
	];
	const h = harness(() => dashboard(rows));
	await h.feature.load("24h");
	h.feature.handleInput("c");
	h.feature.handleInput("\t"); h.feature.handleInput(" ");
	h.feature.handleInput("\t"); h.feature.handleInput("\r"); h.feature.handleInput("p");
	await settle();
	expect(JSON.parse(h.copied[0]).key).toBe("regex");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.dispose();

	const zero = harness(() => dashboard([model("calm", { annoyed: 0, atAssistant: 0, angry: 0 })]));
	await zero.feature.load("24h");
	expect(zero.text()).toContain("No frustrated messages for these models");
	zero.feature.handleInput("\r");
	expect(zero.text()).toContain("Raw model ID: raw/calm");
	zero.feature.dispose();

	const sparse = harness(() => dashboard([model("small-sample", { messages: 20, judged: 10, annoyed: 3, atAssistant: 2, angry: 1 })]));
	await sparse.feature.load("24h");
	const empty = sparse.feature.render(240, 40).map(stripForTest).join("\n");
	expect(empty).toContain("No model versions match the filters");
	expect(empty).toContain("20 messages available");
	expect(empty).toContain("50.0% judge coverage");
	expect(empty).toContain("1 versions below 50 messages excluded");
	sparse.feature.handleInput("m");
	expect(sparse.text()).toContain("Point 1/1: small-sample");
	expect(sparse.requests.some(request => request.options?.method === "POST")).toBe(false);
	sparse.feature.dispose();
});

test("quote errors can be dismissed and retried without authorizing a run", async () => {
	let quotes = 0;
	const h = harness(request => {
		if (request.path.endsWith("/estimate")) {
			if (++quotes === 1) throw new Error("Quote unavailable");
			return QUOTE;
		}
		return dashboard();
	});
	await h.feature.load("24h");
	h.feature.handleInput("j"); await settle();
	expect(h.text()).toContain("Quote unavailable");
	h.feature.handleInput("y");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.handleInput("n");
	h.feature.handleInput("j"); await settle();
	expect(h.text()).toContain("Press y to confirm paid judging");
	expect(h.text()).not.toContain("Quote unavailable");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.dispose();
});

test("known zero rates and unavailable denominators remain distinct in compact version views", async () => {
	const known = model("known-zero", { annoyed: 0, atAssistant: 0, angry: 0 });
	const unavailable = model("no-sample", { messages: 0, judged: 0, annoyed: 0, atAssistant: 0, angry: 0 });
	const h = harness(() => dashboard([known, unavailable]));
	await h.feature.load("24h");
	h.feature.handleInput("m");
	for (const width of [40, 100, 160]) {
		const lines = h.feature.render(width, 30);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		const row = lines.map(stripForTest).find(line => line.includes("known-zero") && line.includes("0.0%"));
		expect(row).toBeDefined();
	}
	h.feature.handleInput("\x1b[B");
	h.feature.handleInput("\r");
	h.feature.handleInput("p"); await settle();
	const copied = JSON.parse(h.copied[0]);
	expect(copied.key).toBe("no-sample");
	expect(copied.messages).toBe(0);
	const text = h.text();
	expect(text).toContain("assistant –");
	expect(text).not.toContain("No frustrated messages");
	expect(h.requests.some(request => request.options?.method === "POST")).toBe(false);
	h.feature.dispose();
});
