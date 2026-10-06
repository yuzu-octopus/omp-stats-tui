import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { PanelData } from "../src/data/api";
import type { FeatureContext } from "../src/tui/features/types";
import { createSummaryFeature } from "../src/tui/features/core/summary";
import { ChartState, ListState } from "../src/tui/features/core/shared";
import { stripForTest } from "../src/tui/palette";
import { AGGREGATE, FIXTURE_NOW, liveData, messageRow } from "./fixtures/panel";

ensureThemeSync();

interface Fixture { ctx: FeatureContext; screens: string[]; detailIds: string[]; set(data: PanelData): void; }
function fixture(initial: PanelData): Fixture {
	let data = initial;
	const screens: string[] = [], detailIds: string[] = [];
	return { screens, detailIds, set(next) { data = next; }, ctx: {
		theme, now: () => FIXTURE_NOW, changed() {}, copy: async () => {}, openTrace() {}, openScreen(id) { screens.push(id); },
		reader: { fetch: async () => data, async api<T>(path: string): Promise<T> {
			if (path === "/api/stats/recent") return (data.recent ?? []) as T;
			detailIds.push(path);
			const id = Number(path.split("/").at(-1));
			return { ...messageRow({ id, model: `detail-${id}` }), messages: [], output: { text: `output-${id}` } } as T;
		} },
	} };
}

test("overview selected request survives refresh, details are lazy, and all requests navigation is explicit", async () => {
	const f = fixture(liveData({ recent: [messageRow({ id: 1, timestamp: FIXTURE_NOW - 1000 }), messageRow({ id: 2, timestamp: FIXTURE_NOW - 2000 })] }));
	const feature = createSummaryFeature("overview", f.ctx);
	await feature.load("24h");
	expect(f.detailIds).toEqual([]);
	feature.handleInput("j");
	feature.handleInput("\r");
	await Promise.resolve(); await Promise.resolve();
	expect(f.detailIds).toEqual(["/api/request/2"]);
	expect(stripForTest(feature.render(40, 24).join("\n"))).toContain("detail-2");
	feature.handleInput("b");
	await feature.load("7d");
	feature.handleInput("\r");
	expect(f.detailIds).toEqual(["/api/request/2", "/api/request/2"]);
	feature.handleInput("\x1b");
	feature.handleInput("A");
	expect(f.screens).toEqual(["requests"]);
	expect(feature.handleInput("q")).toBe(false);
	feature.dispose();
});

test("overview tokens mode does not reset hidden request series and search owns mode letters until committed", async () => {
	const f = fixture(liveData());
	const feature = createSummaryFeature("overview", f.ctx);
	await feature.load("24h");
	feature.handleInput("\t");
	feature.handleInput("v");
	feature.handleInput("m");
	feature.handleInput("m"); feature.handleInput("m");
	expect(stripForTest(feature.render(100, 24).join("\n"))).not.toMatch(/Succeeded\s+\d/);
	feature.handleInput("v");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toMatch(/Succeeded\s+\d/);
	feature.handleInput("\t"); feature.handleInput("/"); feature.handleInput("m");
	expect(feature.handleInput("\x1b[C")).toBe(false);
	expect(feature.handleInput("]")).toBe(true);
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain("m]");
	feature.handleInput("\r"); feature.handleInput("\x1b");

	feature.dispose();
});

test("projects temporary exclusion and search do not change unfiltered totals; ranking selection filters and back clears", async () => {
	const folders = [
		{ ...AGGREGATE, folder: "/tmp-benchmark/", totalRequests: 9, totalCost: 100 },
		{ ...AGGREGATE, folder: "/work-alpha/", totalRequests: 3, totalCost: 2 },
		{ ...AGGREGATE, folder: "/work-beta/", totalRequests: 4, totalCost: 1 },
	];
	const f = fixture(liveData({ folders }));
	const feature = createSummaryFeature("projects", f.ctx);
	await feature.load("24h");
	let text = stripForTest(feature.render(100, 28).join("\n"));
	expect(text).not.toContain("/tmp-benchmark/");
	feature.handleInput("\t"); feature.handleInput("\r");
	text = stripForTest(feature.render(100, 28).join("\n"));
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 28).join("\n"))).toContain("folder: /work-alpha/");
	feature.handleInput("b");
	feature.handleInput("\x1b"); feature.handleInput("t");
	text = stripForTest(feature.render(100, 28).join("\n"));
	feature.handleInput("\r");
	text = stripForTest(feature.render(30, 28).join("\n"));
	expect(text).toContain("Project details");
	expect(text).toContain("totalCacheWriteTokens");
	expect(feature.handleInput("q")).toBe(false);
	feature.handleInput("b");
	feature.dispose();
});

test("activity lookback is honest and recorded days outside narrow calendar remain reachable", async () => {
	const f = fixture(liveData({ dailyActivity: Array.from({ length: 120 }, (_, index) => ({ day: new Date(FIXTURE_NOW - index * 86400000).toISOString().slice(0, 10), cost: index, requests: index + 1, totalTokens: index * 10 })) }));
	const feature = createSummaryFeature("activity", f.ctx);
	await feature.load("1h");

	for (let index = 0; index < 119; index++) feature.handleInput("j");
	feature.handleInput("\r");
	const text = stripForTest(feature.render(35, 20).join("\n"));
	expect(text).toContain("requests: 120");
	expect(text).toContain("totalTokens: 1190");
	feature.handleInput("b");
	await feature.load("all");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(35, 20).join("\n"))).toContain("requests: 120");
	feature.dispose();
});

test("sorting a retained selected row beyond initial reveal still keeps it in local viewport", () => {
	const f = fixture(liveData());
	const rows = Array.from({ length: 180 }, (_, id) => ({ id, value: id }));
	const list = new ListState<{ id: number; value: number }>(row => String(row.id), "value", 10);
	list.selected = "179";
	list.descending = false;
	const sorted = list.rows(rows, { value: row => row.value });
	const text = stripForTest(list.render(sorted, 40, 20, [{ key: "row", header: "Row", align: "left", value: row => `row ${row.id}` }], f.ctx, "Records").join("\n"));
	expect(text).toContain("row 179");
	expect(list.current(sorted)?.id).toBe(179);
});

test("initial chart focus uses a recorded bucket and refresh retains an explicitly inspected timestamp", () => {
	const chart = new ChartState();
	const buckets = [10, 20, 30];
	chart.seedLatestPoint(buckets, [20, 10]);
	chart.reconcile(buckets, ["requests"]);
	expect(buckets[chart.point]).toBe(20);
	chart.input(",", ["requests"]);
	chart.reconcile(buckets, ["requests"]);
	const refreshed = [0, 10, 20, 30, 40];
	chart.seedLatestPoint(refreshed, [40]);
	chart.reconcile(refreshed, ["requests"]);
	expect(refreshed[chart.point]).toBe(10);
});

test("summary newer range wins and disposed late payload cannot publish", async () => {
	const f = fixture(liveData());
	const pending: Array<(data: PanelData) => void> = [];
	f.ctx.reader.fetch = () => {
		const { promise, resolve } = Promise.withResolvers<PanelData>();
		pending.push(resolve);
		return promise;
	};
	const feature = createSummaryFeature("projects", f.ctx);
	const old = feature.load("24h"), newer = feature.load("7d");
	pending[1](liveData({ folders: [{ ...AGGREGATE, folder: "newer-range" }] }));
	await newer;
	pending[0](liveData({ folders: [{ ...AGGREGATE, folder: "old-range" }] }));
	await old;
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain("newer-range");
	expect(stripForTest(feature.render(100, 24).join("\n"))).not.toContain("old-range");
	const late = feature.load("30d"); feature.dispose();
	pending[2](liveData({ folders: [{ ...AGGREGATE, folder: "closed-range" }] }));
	await late;
	expect(stripForTest(feature.render(100, 24).join("\n"))).not.toContain("closed-range");
});


test("calendar focus navigates quiet local days, historical windows, boundaries and retained selection", async () => {
	const today = new Date(FIXTURE_NOW);
	const day = (offset: number): string => {
		const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	};
	const f = fixture(liveData({ dailyActivity: [{ day: day(-140), requests: 17, cost: 2, totalTokens: 900 }] }));
	const feature = createSummaryFeature("activity", f.ctx);
	await feature.load("24h");
	feature.handleInput("\t");
	expect(feature.handleInput("j")).toBe(true);
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain(`day: ${day(0)}`);
	feature.handleInput("b");
	feature.handleInput("k"); feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain(`day: ${day(-1)}`);
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain("requests: 0");
	feature.handleInput("b"); feature.handleInput("t");
	for (let index = 0; index < 20; index++) feature.handleInput("h");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(24, 24).join("\n")).replace(/\n/g, "")).toContain(`day: ${day(-140)}`);
	feature.handleInput("b");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain("requests: 17");
	feature.handleInput("b");
	await feature.load("all");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain(`day: ${day(-140)}`);
	feature.handleInput("b");
	for (let index = 0; index < 100; index++) feature.handleInput("h");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain(`day: ${day(-370)}`);
	feature.handleInput("b");
	feature.handleInput("t");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(100, 24).join("\n"))).toContain(`day: ${day(0)}`);
	feature.handleInput("b");
	expect(feature.handleInput("\x1b[C")).toBe(false);
	feature.dispose();
});

test("the initially displayed request retains identity when a newer row arrives, even without movement", async () => {
	const f = fixture(liveData({ recent: [messageRow({ id: 1, timestamp: FIXTURE_NOW - 1000 })] }));
	const feature = createSummaryFeature("overview", f.ctx);
	await feature.load("24h"); feature.render(100, 24);
	f.set(liveData({ recent: [messageRow({ id: 2, timestamp: FIXTURE_NOW }), messageRow({ id: 1, timestamp: FIXTURE_NOW - 1000 })] }));
	await feature.load("7d");
	feature.handleInput("\r");
	expect(f.detailIds).toEqual(["/api/request/1"]);
	feature.dispose();
});

test("narrow list search keeps its full input and sort state visible when no observations match", () => {
	const f = fixture(liveData());
	const list = new ListState<{ id: number }>(row => String(row.id), "id");
	list.input("/", [{ id: 1 }]); list.input("long-project-name", [{ id: 1 }]);
	const text = stripForTest(list.render([], 12, 12, [{ key: "id", header: "ID", align: "left", value: row => String(row.id) }], f.ctx, "Records").join("\n")).replace(/\n/g, "");
	expect(text).toContain("long-project-name");
});

test("project rows distinguish long Windows paths and retain the original detail identity", async () => {
	const prefix = "C:\\Users\\local\\Documents\\Projects\\shared-parent\\";
	const f = fixture(liveData({ folders: [
		{ ...AGGREGATE, folder: `${prefix}alpha`, totalCost: 2 },
		{ ...AGGREGATE, folder: `${prefix}beta`, totalCost: 1 },
	] }));
	const feature = createSummaryFeature("projects", f.ctx);
	await feature.load("all");
	const text = stripForTest(feature.render(120, 38).join("\n"));
	expect(text).toContain("alpha");
	expect(text).toContain("beta");
	feature.handleInput("j");
	feature.handleInput("\r");
	expect(stripForTest(feature.render(120, 38).join("\n"))).toContain(`${prefix}beta`);
	feature.dispose();
});
