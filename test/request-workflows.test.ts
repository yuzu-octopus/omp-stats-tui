import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { MessageStats, RequestDetails as Payload } from "@oh-my-pi/omp-stats/client/types";
import type { FeatureContext } from "../src/tui/features/types";
import { createRequestsFeature, RequestDetails } from "../src/tui/features/core/requests";
import { stripForTest } from "../src/tui/palette";

ensureThemeSync();
function row(id: number, overrides: Partial<MessageStats> = {}): MessageStats {
	return { id, sessionFile: `session-${id}`, entryId: `entry-${id}`, folder: "project", model: `model-${id}`, provider: "provider", api: "api", timestamp: id * 1000, duration: 100, ttft: 10, stopReason: "stop", errorMessage: null, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, premiumRequests: 0.5, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } }, ...overrides };
}
function context(api: FeatureContext["reader"]["api"]): FeatureContext {
	return { reader: { api, fetch: async () => { throw new Error("unexpected eager scan"); } }, theme, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {}, now: () => 0 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function payload(id: number): Payload { return { ...row(id), output: { text: `output-${id}` }, messages: [{ entry: id }] }; }

test("request inspector suppresses stale selections, back and dispose completions", async () => {
	const pending = [deferred<Payload>(), deferred<Payload>(), deferred<Payload>(), deferred<Payload>()];
	let calls = 0;
	const inspector = new RequestDetails(context(async <T>() => pending[calls++].promise as Promise<T>));
	const first = inspector.open(row(1)); const second = inspector.open(row(2));
	pending[0].resolve(payload(1)); await first;
	expect(inspector.render(120)?.join("\n")).not.toContain("output-1");
	pending[1].resolve(payload(2)); await second;
	expect(inspector.render(120)?.join("\n")).toContain("output-2");
	expect(inspector.handleInput("q")).toBe(false);
	const third = inspector.open(row(3)); expect(inspector.handleInput("\x1b")).toBe(true);
	pending[2].resolve(payload(3)); await third; expect(inspector.render(120)).toBeNull();
	const fourth = inspector.open(row(4)); inspector.dispose(); pending[3].resolve(payload(4)); await fourth;
	expect(inspector.active).toBe(false); expect(inspector.render(120)).toBeNull();
});

test("status intersects search while status counts stay unfiltered", async () => {
	const rows = [row(1, { model: "needle" }), row(2, { model: "needle", stopReason: "error", errorMessage: "failure" }), row(3)];
	const feature = createRequestsFeature("requests", context(async <T>() => rows as T)); await feature.load("24h");
	feature.handleInput("f"); feature.handleInput("/"); for (const char of "needle") feature.handleInput(char); feature.handleInput("\r");
	const text = feature.render(200, 40).map(stripForTest).join("\n");
	expect(text).toContain("#1 needle");
	expect(text).not.toContain("#2 needle");
	expect(text).toContain("Loaded status distribution");
	expect(text).toMatch(/ok\s+2/);
	expect(text).toMatch(/failed\s+1/);
});

test("full server limit reports incomplete and load-more uses next limit", async () => {
	const limits: string[] = [];
	const feature = createRequestsFeature("requests", context(async <T>(_path: string, params?: Record<string, string>) => { limits.push(params!.limit); return Array.from({ length: 500 }, (_, index) => row(index)) as T; }));
	await feature.load("24h"); expect(feature.render(160, 30).join("\n")).toContain("older requests are not loaded");
	const shortRows = new Set([...feature.render(160, 30).map(stripForTest).join("\n").matchAll(/#\d+ model-\d+/g)].map(match => match[0]));
	const tallRows = new Set([...feature.render(160, 60).map(stripForTest).join("\n").matchAll(/#\d+ model-\d+/g)].map(match => match[0]));
	expect(tallRows.size).toBeGreaterThan(shortRows.size);
	feature.handleInput("l"); await Promise.resolve();
	expect(limits).toEqual(["500", "2000"]); expect(feature.render(160, 30).join("\n")).toContain("Complete range");
});

test("expanded error signature exposes every member, not only the latest", async () => {
	const failures = Array.from({ length: 150 }, (_, index) => row(index + 1, { model: `unique-model-${index + 1}`, stopReason: "error", errorMessage: "same failure" }));
	const calls: string[] = [];
	const feature = createRequestsFeature("errors", context(async <T>(path: string) => { calls.push(path); return (path.includes("/request/") ? payload(Number(path.split("/").at(-1))) : failures) as T; }));
	await feature.load("24h"); feature.handleInput("\r");
	expect(feature.render(180, 40).join("\n")).toContain("Expanded signature");
	feature.handleInput("\t"); feature.handleInput("\t"); feature.handleInput("a");
	for (let index = 0; index < 149; index++) feature.handleInput("j");
	expect(feature.render(180, 40).join("\n")).toContain("unique-model-1");
	feature.handleInput("\r"); await Promise.resolve(); expect(calls).toContain("/api/request/1");
	feature.handleInput("b"); await feature.load("24h"); feature.handleInput("\r"); await Promise.resolve();
	expect(calls.filter(path => path === "/api/request/1")).toHaveLength(2);
});

test("inspector displays copy result and routes trace identity", async () => {
	const ctx = context(async <T>() => payload(7) as T); const traces: string[] = [];
	ctx.openTrace = (file, entry) => { traces.push(`${file}:${entry}`); };
	const inspector = new RequestDetails(ctx); await inspector.open(row(7)); inspector.handleInput("c"); await Promise.resolve();
	expect(inspector.render(160)?.join("\n")).toContain("JSON copied successfully");
	ctx.copy = async () => { throw new Error("clipboard denied"); }; inspector.handleInput("c"); await Promise.resolve();
	expect(inspector.render(160)?.join("\n")).toContain("Copy failed: Error: clipboard denied");
	inspector.handleInput("t"); expect(traces).toEqual(["session-7:entry-7"]); expect(inspector.active).toBe(true);
	expect(inspector.render(160)?.join("\n")).toContain("output-7");
	inspector.handleInput("b"); expect(inspector.active).toBe(false);
});

test("log ignores stale range and disposed reads; global navigation survives search", async () => {
	const reads = [deferred<MessageStats[]>(), deferred<MessageStats[]>(), deferred<MessageStats[]>()];
	let calls = 0;
	const feature = createRequestsFeature("requests", context(async <T>() => reads[calls++].promise as Promise<T>));
	const old = feature.load("24h"); const current = feature.load("7d");
	reads[1].resolve([row(2)]); await current; reads[0].resolve([row(1)]); await old;
	expect(feature.render(160, 40).join("\n")).toContain("#2 model-2");
	expect(feature.render(160, 40).join("\n")).not.toContain("#1 model-1");
	feature.handleInput("/");
	expect(feature.inputMode).toBe("text");
	for (const key of ["q", "[", "]"]) expect(feature.handleInput(key)).toBe(true);
	expect(feature.render(160, 40).join("\n")).toContain("Search: q[]");
	for (const key of ["\x0e", "\x10", "\x1b[D", "\x1b[C"]) expect(feature.handleInput(key)).toBe(false);
	feature.handleInput("\r");
	expect(feature.handleInput("q")).toBe(false);
	const closing = feature.load("all"); feature.dispose(); reads[2].resolve([row(3)]); await closing;
	expect(feature.render(160, 40).join("\n")).not.toContain("#3 model-3");
});

test("unpriced detail components are unavailable estimates rather than zero spend", async () => {
	const unpriced = { ...payload(8), costUnpriced: true };
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) unpriced.usage.cost[key] = 0;
	const inspector = new RequestDetails(context(async <T>() => unpriced as T));
	await inspector.open(unpriced);
	const text = inspector.render(160)!.join("\n");
	expect(text).toContain("unpriced requests: 1");
	for (const component of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
		expect(text).toContain(`${component}: unpriced request; component estimate unavailable`);
	}
});

test("expanded signature retains real metadata while focused panels remain first", async () => {
	const failure = row(9, { stopReason: "error", errorMessage: "actual failure" });
	const ctx = context(async <T>() => [failure] as T);
	const errors = createRequestsFeature("errors", ctx); await errors.load("24h"); errors.handleInput("\r");
	const expanded = errors.render(180, 30).join("\n");
	expect(expanded).toContain("Latest error: actual failure");
	expect(expanded).toContain("model-9 · provider: 1 failures");
});

test("failed initial reads do not claim zero spend and failed refreshes retain observed spending", async () => {
	let available = false;
	const feature = createRequestsFeature("requests", context(async <T>() => {
		if (!available) throw new Error("read unavailable");
		return [row(1)] as T;
	}));
	await feature.load("24h");
	expect(feature.render(40, 30).join("\n")).not.toMatch(/\$\d/);
	available = true;
	await feature.load("24h");
	expect(feature.render(40, 30).join("\n")).toContain("$10.00");
	available = false;
	await feature.load("7d");
	expect(feature.render(40, 30).join("\n")).toContain("$10.00");
	feature.dispose();
});

test("request JSON sections collapse independently, copy the selected payload, and retry failed reads", async () => {
	let attempts = 0;
	const ctx = context(async <T>() => { if (++attempts === 1) throw new Error("read denied"); return payload(7) as T; });
	const copies: string[] = [];
	ctx.copy = async text => { copies.push(text); };
	const inspector = new RequestDetails(ctx);
	await inspector.open(row(7));
	expect(inspector.render(100)?.join("\n")).toContain("read denied");
	expect(inspector.handleInput("e")).toBe(true);
	await Promise.resolve(); await Promise.resolve();
	expect(inspector.render(100)?.join("\n")).toContain("output-7");
	inspector.handleInput("C"); await Promise.resolve();
	expect(JSON.parse(copies[0])).toEqual({ text: "output-7" });
	inspector.handleInput("v");
	expect(inspector.render(100)?.join("\n")).not.toContain("output-7");
	inspector.handleInput("n"); inspector.handleInput("v");
	expect(inspector.render(100)?.join("\n")).toContain('"entry": 7');
	inspector.handleInput("C"); await Promise.resolve();
	expect(JSON.parse(copies[1])).toEqual([{ entry: 7 }]);
	inspector.handleInput("c"); await Promise.resolve();
	expect(JSON.parse(copies[2])).toEqual(payload(7));
});

test("error panels sort independently and clearing one filter preserves the other", async () => {
	const failures = [
		row(1, { model: "alpha", stopReason: "error", errorMessage: "zeta failure" }),
		row(2, { model: "beta", stopReason: "error", errorMessage: "alpha failure" }),
		row(3, { model: "alpha", stopReason: "error", errorMessage: "alpha failure" }),
	];
	const feature = createRequestsFeature("errors", context(async <T>() => failures as T));
	await feature.load("24h");
	feature.handleInput("o"); feature.handleInput("O");
	const sorted = feature.render(180, 40).join("\n");
	expect(sorted).toContain("signature ↑");
	expect(sorted.indexOf("alpha failure")).toBeLessThan(sorted.indexOf("zeta failure"));
	feature.handleInput("\r");
	feature.handleInput("\t"); feature.handleInput("\r");
	feature.handleInput("\t"); // the filtered failure table is its own focused panel
	expect(feature.render(180, 40).join("\n")).toContain("#3 alpha");
	feature.handleInput("x");
	expect(feature.render(180, 40).join("\n")).toContain("#1 alpha");
	expect(feature.render(180, 40).join("\n")).not.toContain("#2 beta");
	feature.handleInput("X");
	expect(feature.render(180, 40).join("\n")).toContain("#2 beta");
	feature.handleInput("/"); feature.handleInput("beta");
	const narrow = feature.render(24, 24).join("\n").replace(/\n/g, "");
	expect(feature.inputMode).toBe("text");
	expect(narrow).toContain("beta");
});

test("requests without a stored id still expose fetched columns in the narrow inspector", async () => {
	let calls = 0;
	const inspector = new RequestDetails(context(async <T>() => { calls++; return payload(1) as T; }));
	await inspector.open(row(1, { id: undefined, model: "unstored-model", duration: 678, ttft: 54 }));
	const text = inspector.render(24)!.map(stripForTest).map(line => line.replace(/^[│|] ?| ?[│|]$/g, "").trimEnd()).join("");
	expect(text).toContain("unstored-model");
	expect(text).toContain("duration: 678");
	expect(text).toContain("usage.cacheWrite: 4");
	expect(calls).toBe(0);
});

test("request and error tables keep selected searchable identities inside narrow widths", async () => {
	for (const id of ["requests", "errors"] as const) {
		const feature = createRequestsFeature(id, context(async <T>(path: string) => (path.startsWith("/api/request/") ? payload(2) : [row(1), row(2, { model: "needle", stopReason: "error", errorMessage: "failure" })]) as T));
		await feature.load("24h");
		feature.handleInput("/"); feature.handleInput("needle");
		for (const width of [24, 40, 100]) {
			const lines = feature.render(width, 30);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		}
		feature.handleInput("\r"); feature.handleInput("\r"); await Promise.resolve();
		expect(feature.render(100, 30).join("\n")).toContain("Request #2");
	}
});

test("priced detail components format decimals instead of exposing arithmetic tails", async () => {
	const data = payload(7);
	data.usage.cost.input = 0.1 + 0.2;
	const inspector = new RequestDetails(context(async <T>() => data as T));
	await inspector.open(data);
	const lines = inspector.render(100)!;
	const component = lines.map(stripForTest).find(line => line.includes("input:"));
	expect(component).toContain("$");
	expect(component).not.toContain("00000000000000004");
});
