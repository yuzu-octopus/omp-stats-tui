/**
 * `test/fixtures/panel.ts` is ONE fixture standing in for every route. These
 * tests pin the cross-route invariants the redesign's Review Focus #5 names:
 * two screens that read the same population must agree, a payload the panel
 * expects must exist, and the per-model rows must be distinct enough that a
 * column can vary.
 */
import { expect, test } from "bun:test";
import { BY_MODEL, COST_SERIES, PROVIDERS } from "./fixtures/panel";

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
