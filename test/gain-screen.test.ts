/**
 * `test/gain-screen.test.ts` — the IR-rendered gain screen.
 *
 * Gain is token savings from snapcompact (a jsonl beside the DB), not cache
 * savings: no dollars, no ratio that goes negative. `reductionPercent` is
 * ALWAYS null (the aggregator never sets originalBytes), so the Reduction
 * tile reads the web's dash with its "original size not recorded" hint.
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
import { gainScreen } from "../src/tui/screens/gain";

ensureThemeSync();

const spec = SCREEN_SPECS.find(s => s.id === "gain")!;

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

test("gain: the stat row carries the web's five tiles, and reduction is the web's dash", () => {
	// GainRoute.tsx:131-151. Saved per hit is the inline `savedTokens / hits`
	// guarded `hits > 0`; reduction is ALWAYS null with its recorded-size caveat
	// in the note band below, not as a static hint (a static hint never drops,
	// so the empty state could never be empty).
	expect(
		spec.bands.flatMap(b => (b.kind === "statRow" ? b.stats.map(t => t.label) : [])),
	).toEqual(["Saved tokens", "Saved bytes", "Reduction", "Hits", "Saved per hit"]);
	const gain = liveData().gain!;
	expect(resolveNumber(spec.bands.flatMap(b => (b.kind === "statRow" ? b.stats : [])).find(t => t.label === "Saved tokens")!.metric, liveData())).toBe(gain.overall.savedTokens);
	expect(resolveNumber(spec.bands.flatMap(b => (b.kind === "statRow" ? b.stats : [])).find(t => t.label === "Saved per hit")!.metric, liveData())).toBeCloseTo(gain.overall.savedTokens / gain.overall.hits, 9);
	const rendered = text(renderScreen(opts(liveData())));
	expect(rendered).toContain("–");
	expect(rendered).toContain("original size not recorded");
	expect(rendered).not.toMatch(/\$\d/);
});

test("gain: the By source table names the host's source rows, not invented models", () => {
	// One row per key of `bySource` — today exactly `snapcompact`. A table
	// reading any other row set would still show plausible token figures.
	const band = spec.bands.find(b => b.kind === "table" && b.title === "By source");
	expect(band, `"By source" table band missing`).toBeTruthy();
	if (band === undefined || band.kind !== "table") throw new Error(`"By source" is not a table band`);
	expect(band.rows.source).toBe("gainBySource");
	const rendered = text(renderScreen(opts(liveData())));
	expect(rendered).toContain("snapcompact");
});

test("gain: an unfetched gain payload renders a defined state", () => {
	const rows = renderScreen(opts({}));
	expect(text(rows)).not.toMatch(/NaN|undefined|Infinity/);
	expect(text(rows).length).toBeGreaterThan(0);
});

test("gain: the registry entry defers to the spec's pipeline, not a scaffold body", () => {
	expect(gainScreen.id).toBe("gain");
	expect([...gainScreen.needs]).toEqual([...spec.needs]);
});
