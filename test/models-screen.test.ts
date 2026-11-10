/**
 * `test/models-screen.test.ts` — the IR-rendered models screen, against the shared fixture.
 *
 * Figure parity lives in `test/parity.test.ts` (Most-used identity, token sums,
 * cache-rate definition). These tests are what parity cannot see: that the
 * REGISTRY entry renders through the pipeline rather than a hand-written body,
 * that the All-models table ranks by request count with the host's top row
 * first, and that the Cost column reads N/A for the no-catalog-card row while
 * the explicit-zero-card row stays $0.
 *
 * Fixtures are the shared `test/fixtures/panel.ts` live set — the same live
 * data the pipeline tests render. Its `BY_MODEL` carries all three price
 * populations: a priced top spender, a no-card unpriced row, and an explicit
 * all-zero card.
 */

import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

import { SCREEN_SPECS } from "../src/layout/spec";
import { resolveLabel } from "../src/layout/resolve";
import { renderScreen, screenBands, type ScreenRenderOptions } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor } from "../src/tui/glyphs";
import { SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { FIXTURE_NOW, liveData } from "./fixtures/panel";
import { modelsScreen } from "../src/tui/screens/models";

ensureThemeSync();

const spec = SCREEN_SPECS.find(s => s.id === "models")!;

function opts(data: PanelData, width = 100): ScreenRenderOptions {
	return {
		spec,
		data,
		plan: planLayout(width, 40, "unicode"),
		preset: "unicode",
		range: DEFAULT_RANGE,
		now: FIXTURE_NOW,
		fg: (color: ThemeColor, text: string) => theme.fg(color, text),
		bold: text => theme.bold(text),
		palette: theme,
		seriesColorFor: index => SERIES_COLORS[index % SERIES_COLORS.length],
		glyphs: glyphsFor("unicode"),
	};
}

const text = (rows: readonly string[]): string => stripForTest(rows.join("\n"));

function allModelsBand(data: PanelData) {
	const bands = screenBands(opts(data));
	const band = bands.find(b => b.kind === "table" && b.title === "All models");
	expect(band, `"All models" table band missing`).toBeTruthy();
	if (band === undefined || band.kind !== "table") throw new Error(`"All models" is not a table band`);
	return band.rows.kind === "inline" ? band.rows.rows : [];
}

test("models: the registry entry defers to the spec's pipeline, not a hand-written body", () => {
	expect(modelsScreen.id).toBe("models");
	// The spec's needs, or the panel fetches what the body never reads.
	expect([...modelsScreen.needs]).toEqual([...spec.needs]);
});

test("models: 'All models' ranks by request count, busiest first", () => {
	// ModelsRoute.tsx:194 — initialSort requests desc. The fixture's busiest
	// row is space-bunny-free, which is neither the first payload row nor the
	// top spender, so payload order and cost order both fail here.
	const rows = allModelsBand(liveData());
	expect(rows.length).toBeGreaterThan(0);
	const busiest = [...liveData().modelDashboard!.byModel].sort((a, b) => b.totalRequests - a.totalRequests)[0]!;
	expect(rows[0]!["Model"]).toBe(busiest.model);
});

test("models: a no-card row reads N/A while an explicit-zero card stays $0", () => {
	// ModelsRoute.tsx:355 — formatEstimatedCost per row. gemini-3.7-flash-high
	// has no catalog card (unknown spend); space-bunny-free has an explicit
	// all-zero card (really free).
	const rows = allModelsBand(liveData());
	const noCard = rows.find(r => r["Model"] === "gemini-3.7-flash-high");
	const free = rows.find(r => r["Model"] === "space-bunny-free");
	expect(noCard, "the no-card model must be listed").toBeTruthy();
	expect(free, "the free model must be listed").toBeTruthy();
	expect(noCard!["Cost"]).toContain("N/A");
	expect(free!["Cost"]).toContain("$0");
	expect(free!["Cost"]).not.toContain("N/A");
});

test("models: the Trend column draws one sparkline per row", () => {
	// ModelsRoute.tsx:413-431 — per-model Trend sparkline over the dense
	// per-bucket requests.
	const rows = allModelsBand(liveData());
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		expect(row["Trend"] ?? "", `no trend for ${row["Model"]}`).not.toBe("");
	}
});
test("models: 'Most used' names the busiest model, not the first payload row", () => {
	// ModelsRoute.tsx:266-273 — top is the max-totalRequests row; the tile
	// value is its name and the hint carries its request share.
	const data = liveData();
	const busiest = [...data.modelDashboard!.byModel].sort((a, b) => b.totalRequests - a.totalRequests)[0]!;
	expect(resolveLabel({ kind: "label", source: "byModel", field: "model" }, data)).toBeDefined();
	const mostUsed = spec.bands
		.flatMap(b => (b.kind === "statRow" ? b.stats : []))
		.find(t => t.label === "Most used")!;
	expect(resolveLabel(mostUsed.metric, data)).toBe(busiest.model);
});

test("models: an unfetched modelDashboard renders a defined state", () => {
	const rows = renderScreen(opts({}));
	expect(text(rows)).not.toMatch(/NaN|undefined|Infinity/);
	expect(text(rows).length).toBeGreaterThan(0);
});
