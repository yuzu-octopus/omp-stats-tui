/**
 * `test/overview-screen.test.ts` — the IR-rendered overview screen, against the shared fixture.
 *
 * Figure parity lives in `test/parity.test.ts` (cost N/A rule, conversation-token
 * sums, cache-rate definition). These tests are what parity cannot see: that the
 * REGISTRY entry renders through the pipeline rather than a hand-written body,
 * that the Activity chart carries the Succeeded/Failed pair the route draws,
 * that Token mix carries the four token kinds, and that Latest requests is
 * newest-first even when the payload arrives oldest-first.
 *
 * Fixtures are the shared `test/fixtures/panel.ts` live set — the same live
 * data the pipeline tests render.
 */

import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

import { SCREEN_SPECS } from "../src/layout/spec";
import { resolveNumber } from "../src/layout/resolve";
import { renderScreen, screenBands, renderScreenWith, type ScreenRenderOptions } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor } from "../src/tui/glyphs";
import { SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { FIXTURE_NOW, liveData, messageRow } from "./fixtures/panel";
import { overviewScreen } from "../src/tui/screens/overview";

ensureThemeSync();

const spec = SCREEN_SPECS.find(s => s.id === "overview")!;

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

test("overview: the registry entry defers to the spec's pipeline, not a hand-written body", () => {
	expect(overviewScreen.id).toBe("overview");
	// The spec's needs, or the panel fetches what the body never reads.
	expect([...overviewScreen.needs]).toEqual([...spec.needs]);
});

test("overview: the Activity chart carries the route's Succeeded/Failed pair", () => {
	// OverviewRoute.tsx:86-90 — two bar series, Succeeded beside Failed.
	const { chart } = renderScreenWith(opts(liveData()));
	expect(chart.length).toBeGreaterThan(0);
	const joined = chart.join("\n");
	for (const label of ["Succeeded", "Failed"]) {
		expect(joined, label).toContain(label);
	}
});

test("overview: Token mix carries the four conversation-token kinds", () => {
	// OverviewRoute.tsx:56-61 TOKEN_MIX — Uncached input, Cache read, Cache write, Output.
	const { chart } = renderScreenWith(opts(liveData()));
	const joined = chart.join("\n");
	for (const label of ["Uncached input", "Cache read", "Cache write", "Output"]) {
		expect(joined, label).toContain(label);
	}
});

test("overview: the legend names the agent types beside the token kinds", () => {
	// OverviewRoute.tsx:212-238 — the By-agent ShareBar and its rows.
	const bands = screenBands(opts(liveData()));
	const legend = bands.find(b => b.kind === "legend");
	expect(legend, "legend band missing").toBeTruthy();
	if (legend === undefined || legend.kind !== "legend") throw new Error("legend is not a legend band");
	const labels = legend.items.map(i => i.label);
	for (const label of ["Main agent", "Subagents", "Advisor"]) {
		expect(labels, label).toContain(label);
	}
});

test("overview: Latest requests is newest-first even when the payload arrives oldest-first", () => {
	// The `recent` route returns arrival order; the table declares its own
	// newest-first sort, which is what makes the order PROVABLE rather than
	// coincidental.
	const oldest = messageRow({ id: 101, timestamp: FIXTURE_NOW - 20 * 3_600_000, model: "probe-old" });
	const newest = messageRow({ id: 102, timestamp: FIXTURE_NOW - 60_000, model: "probe-new" });
	expect(newest.timestamp).toBeGreaterThan(oldest.timestamp);
	const bands = screenBands(opts({ recent: [oldest, newest] as unknown as PanelData["recent"] }));
	const band = bands.find(b => b.kind === "table" && b.title === "Latest requests");
	expect(band, `"Latest requests" table band missing`).toBeTruthy();
	if (band === undefined || band.kind !== "table") throw new Error(`"Latest requests" is not a table band`);
	const rows = band.rows.kind === "inline" ? band.rows.rows : [];
	expect(rows.length).toBe(2);
	expect(rows[0]!["Model"]).toBe("probe-new");
	expect(rows[1]!["Model"]).toBe("probe-old");
});
test("overview: the Succeeded series is requests-minus-errors per bucket, as the web plots it", () => {
	// OverviewRoute.tsx:69-83 — `requests: densify(points, buckets, p => p.requests - p.errors)`.
	// Succeeded plus Failed must re-add to the Requests spark; a Succeeded
	// series reading raw requests would double-count the failures.
	const data = liveData();
	const ok = resolveNumber({ kind: "series", source: "timeSeries", field: "succeededRequests" }, data);
	const failed = resolveNumber({ kind: "series", source: "timeSeries", field: "errors" }, data);
	const all = resolveNumber({ kind: "series", source: "timeSeries", field: "requests" }, data);
	expect(ok).not.toBeNull();
	expect(ok! + failed!).toBe(all!);
});

test("overview: an unfetched overview payload renders a defined state", () => {
	const rows = renderScreen(opts({}));
	expect(text(rows)).not.toMatch(/NaN|undefined|Infinity/);
	expect(text(rows).length).toBeGreaterThan(0);
});
