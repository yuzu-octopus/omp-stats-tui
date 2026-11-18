/**
 * `test/fixtures/panel.ts` is ONE fixture standing in for every route. These
 * tests pin the cross-route invariants the redesign's Review Focus #5 names:
 * two screens that read the same population must agree, a payload the panel
 * expects must exist, and the per-model rows must be distinct enough that a
 * column can vary. The last test drives the real feature controllers through a
 * recording reader; it pins the routes a consumer actually issues, not source
 * text.
 */
import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { PanelData } from "../src/data/api";
import { DEFAULT_RANGE } from "../src/data/ranges";
import { createCoreFeature } from "../src/tui/features/core";
import { createFrustrationFeature } from "../src/tui/features/frustration";
import { createGainFeature } from "../src/tui/features/gain";
import { createProvidersFeature } from "../src/tui/features/providers";
import { createTracesFeature } from "../src/tui/features/traces";
import type { FeatureContext, FeatureController, FeatureReader } from "../src/tui/features/types";
import { SCREENS, type ScreenId } from "../src/tui/screens/types";
import { CANONICAL_API_PATHS, apiPath, canonicalApiPath, canonicalApiPayload } from "../scripts/probe-render";
import { BY_MODEL, COST_SERIES, FIXTURE_NOW, PROVIDERS, liveData } from "./fixtures/panel";

ensureThemeSync();

function createFeature(id: ScreenId, ctx: FeatureContext): FeatureController {
	return createCoreFeature(id, ctx) ?? (
		id === "providers" ? createProvidersFeature(ctx) :
		id === "gain" ? createGainFeature(ctx) :
		id === "traces" ? createTracesFeature(ctx) :
		createFrustrationFeature(ctx));
}

test("the models route and the costs route carry one unpriced population", () => {
	const byModel = BY_MODEL.reduce((sum, model) => sum + model.unpricedRequests, 0);
	const costs = COST_SERIES.reduce((sum, point) => sum + point.unpricedRequests, 0);
	expect(byModel, "BY_MODEL unpriced total disagrees with the costs route").toBe(costs);
});

test("the providers payload carries window insights", () => {
	expect(Array.isArray(PROVIDERS.insights)).toBe(true);
	expect(PROVIDERS.insights.length).toBeGreaterThan(0);
});

test("the fixture's models differ in cache-read tokens and in average duration", () => {
	const cacheReads = BY_MODEL.map(model => model.totalCacheReadTokens);
	const durations = BY_MODEL.map(model => model.avgDuration);
	expect(new Set(cacheReads).size, "every model carries the same cache-read tokens").toBeGreaterThan(1);
	expect(new Set(durations).size, "every model carries the same average duration").toBeGreaterThan(1);
});

test("the probe's canonical path map covers all twelve controllers and every key is live", async () => {
	const fixture: PanelData = liveData();
	const overrides: Record<string, unknown> = {
		[apiPath("api", "request", ":id")]: { id: 1, model: "probe", provider: "probe", usage: { cost: {} }, messages: [], output: null },
		[apiPath("api", "sessions")]: [{
			file: "probe.jsonl", folder: "probe", title: "Probe", startedAt: 1, endedAt: 2,
			requests: 1, toolCalls: 0, subagents: 0, totalTokens: 1, costTotal: 0,
			unpricedRequests: 0, models: ["probe"],
		}],
		[apiPath("api", "session", "trace")]: {
			file: "probe.jsonl", title: "Probe", cwd: null, startedAt: 1, endedAt: 2, mtimeMs: 2, etag: "probe",
			tracks: [{ id: "main", parentId: null, label: "main", agent: null, model: null, file: "probe.jsonl",
				spans: [{ id: "main:e1", kind: "model", start: 1, end: 2, label: "model", entryId: "entry" }], markers: [] }],
			summary: { wallMs: 1, modelMs: 1, toolMs: 0, idleMs: 0, turns: 1, requests: 1, toolCalls: 0,
				subagents: 0, totalTokens: 1, costTotal: 0, unpricedRequests: 0, toolStats: [] },
		},
		[apiPath("api", "session", "entry")]: { entry: {} },
		[apiPath("api", "stats", "provider-windows")]: {
			windowInsights: [{ provider: "probe", windowKey: "w", windowLabel: "w", accounts: 1, cycles: 0,
				fractionConsumed: 0.5, estTokensPerWindow: null }],
			usageSeries: [],
		},
		[apiPath("api", "stats", "frustration")]: { overall: {}, byModel: [], job: { state: "idle" } },
		[apiPath("api", "frustration", "estimate")]: { available: true, messages: 12 },
		[apiPath("api", "frustration", "judge")]: { state: "running" },
		[apiPath("api", "frustration", "cancel")]: { state: "idle" },
	};
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	const seen = new Set<string>();
	const readerFor = (): FeatureReader => ({
		fetch: async () => ({ data: fixture, errors: {} }),
		api: async <T>(path: string): Promise<T> => {
			const key = canonicalApiPath(path);
			seen.add(key);
			const payload = Object.hasOwn(overrides, key) ? overrides[key] : canonicalApiPayload<unknown>(fixture, path);
			return payload as T;
		},
	});
	const contextFor = (): FeatureContext => ({
		reader: readerFor(), theme, now: () => FIXTURE_NOW, changed: () => {},
		copy: async () => {}, openTrace: () => {}, openScreen: () => {},
	});
	const drivers: Partial<Record<ScreenId, (controller: FeatureController) => Promise<void>>> = {
		requests: async controller => { controller.handleInput("\r"); await settle(); },
		errors: async controller => { controller.handleInput("u"); await settle(); },
		providers: async controller => {
			controller.handleInput("\t");
			controller.handleInput("\t");
			controller.handleInput("\t");
			await settle();
			await settle();
		},
		traces: async controller => { await controller.openTrace?.("probe.jsonl", "entry"); },
		frustration: async controller => {
			controller.handleInput("j");
			await settle();
			controller.handleInput("y");
		},
	};

	expect(SCREENS.length, "the controller sweep must cover all twelve screens").toBe(12);
	for (const screen of SCREENS) {
		const controller = createFeature(screen.id, contextFor());
		await controller.load(DEFAULT_RANGE);
		await drivers[screen.id]?.(controller);
		controller.dispose();
	}

	expect([...seen].sort(), "a controller issued a route absent from the probe map").toEqual(
		Object.keys(CANONICAL_API_PATHS).sort());
	const modelDashboard = fixture.modelDashboard;
	if (modelDashboard === undefined) throw new Error("liveData is missing modelDashboard");
	expect(canonicalApiPayload<typeof modelDashboard>(fixture, apiPath("api", "stats", "model-dashboard")),
		"the models route must resolve to its camelCase fixture key").toBe(modelDashboard);
	for (const [path, key] of Object.entries(CANONICAL_API_PATHS)) {
		if (key === null) continue;
		expect(Object.hasOwn(fixture, key), `${path} resolves to a key absent from liveData()`).toBe(true);
	}
});
