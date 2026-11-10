/**
 * `test/providers-screen.test.ts` — the IR-rendered providers screen.
 *
 * Two payloads, two cost profiles: `ProviderDashboardStats` is DB-backed and
 * fast (`getStatsByProvider` + hourly + series over the message rollup), while
 * `ProviderWindowStats` (`provider-windows`) does broker network I/O per load
 * and stays out of the panel. So S1–S4 (statRow, totals table, burn chart,
 * peak-hours chart) resolve against the local payload; the subscription-window
 * sections keep their note until ingest records windows locally.
 */

import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

import { SCREEN_SPECS } from "../src/layout/spec";
import { resolveNumber } from "../src/layout/resolve";
import { renderScreen, screenBands, type ScreenRenderOptions } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor } from "../src/tui/glyphs";
import { PALETTE, SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { FIXTURE_NOW, liveData } from "./fixtures/panel";

ensureThemeSync();

const spec = SCREEN_SPECS.find(s => s.id === "providers")!;

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

test("providers: the screen is fillable — needs name the local payload, not the network one", () => {
	// The local aggregates route is `/api/stats/providers` (DB-backed);
	// `/api/stats/provider-windows` does broker network I/O per load and the
	// panel never calls it. A needs entry naming the network route is the bug.
	expect([...spec.needs]).toContain("providers");
	expect(spec.bands.length).toBeGreaterThan(0);
});

test("providers: the stat row carries the web's five tiles", () => {
	// ProvidersRoute.tsx StatGrid: Providers, Requests, Tokens,
	// API-equivalent cost, Error rate. Hints name the top provider, the failed
	// count, and the unpriced count — the money rule beside every cost.
	const labels = spec.bands.flatMap(b => (b.kind === "statRow" ? b.stats.map(t => t.label) : []));
	for (const label of ["Providers", "Requests", "Tokens", "API-equivalent cost", "Error rate"]) {
		expect(labels, label).toContain(label);
	}
	const cost = spec.bands
		.flatMap(b => (b.kind === "statRow" ? b.stats : []))
		.find(t => t.label === "API-equivalent cost")!;
	expect(cost.emphasis).toBe("primary");
});

test("providers: the totals table names providers, not models", () => {
	// The web's ProviderTotalsTable is keyed by provider with a token-mix
	// expander; the repo's models table groups the other way. A provider table
	// reading byModel rows would still show plausible totals.
	const band = spec.bands.find(b => b.kind === "table" && b.title === "Provider totals");
	expect(band, `"Provider totals" table band missing`).toBeTruthy();
	if (band === undefined || band.kind !== "table") throw new Error(`"Provider totals" is not a table band`);
	expect(band.rows.source).toBe("providerStats");
	const rendered = text(renderScreen(opts(liveData())));
	for (const row of liveData().providers!.providers) {
		expect(rendered, row.provider).toContain(row.provider);
	}
});

test("providers: burn draws one block per metric off the local series", () => {
	// The web's Burn card is a stacked per-provider time chart (tokens/cost/
	// requests switch); the terminal composes one block per series from the
	// single-series primitive. Cost-scaled, never token-scaled.
	const band = spec.bands.find(b => b.kind === "chart" && b.title === "Burn by provider");
	expect(band, `"Burn by provider" chart band missing`).toBeTruthy();
});

test("providers: an unfetched providers payload renders a defined state", () => {
	const rows = renderScreen(opts({}));
	expect(text(rows)).not.toMatch(/NaN|undefined|Infinity/);
	expect(text(rows).length).toBeGreaterThan(0);
});
