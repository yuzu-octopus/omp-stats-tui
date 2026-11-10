/**
 * The layout IR contract.
 *
 * The IR is only worth having if it can be WRONG in the ways a hand-written
 * screen gets wrong: a band that reads a field the payload does not have, a
 * band that reads data the screen never fetched, and an IR that quietly grows
 * a glyph, a colour or a preset. Each of those is a test below, not a review
 * note, because a review note is not what stops the fifth screen from
 * reinventing the visual grammar.
 */

import { test, expect } from "bun:test";
import {
	SCREEN_SPECS,
	NEED_BY_SOURCE,
	ALL_METRIC_REFS,
	metricRefsOf,
	sourceOf,
	type Band,
	type Column,
	type MetricRef,
	type RowSource,
	type ScreenSpec,
} from "../src/layout/spec";
import { DATA_NEEDS, type DataNeed } from "../src/data/api";
import { SCREENS } from "../src/tui/screens/types";


/** Every metric reachable from a band: tiles, chart series, legend, columns. */
function refsInBand(band: Band): readonly MetricRef[] {
	switch (band.kind) {
		case "statRow":
			return band.stats.flatMap(t => metricRefsOf(t.metric));
		case "chart":
			return band.chart.series.flatMap(s => metricRefsOf(s.metric));
		case "legend":
			return band.items.flatMap(i => metricRefsOf(i.metric));
		case "table":
			return band.columns.flatMap((c: Column) => metricRefsOf(c.source));
		case "note":
			return [];
	}
}

function refsInSpec(spec: ScreenSpec): readonly MetricRef[] {
	return spec.bands.flatMap(refsInBand);
}

// ─── identity ────────────────────────────────────────────────────────────────

test("every screen id is unique", () => {
	const ids = SCREEN_SPECS.map(s => s.id);
	expect(new Set(ids).size).toBe(ids.length);
});

test("every IR screen corresponds to a screen the registry already knows", () => {
	const registered = new Set(SCREENS.map(s => s.id));
	for (const spec of SCREEN_SPECS) {
		expect(registered.has(spec.id as never), spec.id).toBe(true);
	}
});


// ─── the valuable test: a band that reads something the screen never fetched ─

test("every band references a metric its screen's needs actually fetch", () => {
	for (const spec of SCREEN_SPECS) {
		for (const ref of refsInSpec(spec)) {
			const need = NEED_BY_SOURCE[sourceOf(ref)];
			// Asserting this BEFORE the `toContain` is the point: a null need is a
			// screen band that can never be filled, and the test must say which.
			expect(need, `${spec.id}: source "${sourceOf(ref)}" has no declared need`).toBeTruthy();
			if (need === null) continue;
			expect([...spec.needs], `${spec.id} reads ${sourceOf(ref)} but fetches only ${spec.needs.join(",")}`).toContain(need);
		}
	}
});

test("every fetchable source maps to a real DataNeed", () => {
	for (const [source, need] of Object.entries(NEED_BY_SOURCE)) {
		// Every source the IR names is fetchable: `providerStats` reads the
		// DB-backed `/api/stats/providers` aggregates, and the network-only
		// windows payload has no source because the panel never fetches it.
		expect(need, `${source} has no declared need`).toBeTruthy();
		if (need === null) continue;
		expect(DATA_NEEDS as readonly string[], `${source} -> ${need}`).toContain(need);
	}
});


test("every source the IR names is one NEED_BY_SOURCE knows", () => {
	for (const ref of ALL_METRIC_REFS) {
		expect(Object.keys(NEED_BY_SOURCE), `unknown source "${sourceOf(ref)}"`).toContain(sourceOf(ref));
	}
	expect(ALL_METRIC_REFS.length).toBeGreaterThan(50);
});

// ─── structural soundness ────────────────────────────────────────────────────


test("stat tile labels are unique within a screen", () => {
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "statRow") continue;
			const labels = band.stats.map(t => t.label);
			expect(new Set(labels).size, `${spec.id}: ${labels.join(", ")}`).toBe(labels.length);
		}
	}
});

test("every table row source resolves to a real source", () => {
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "table") continue;
			const rows: RowSource = band.rows;
			expect(Object.keys(NEED_BY_SOURCE), `${spec.id}/${band.title}: ${rows.source}`).toContain(rows.source);
		}
	}
});

test("every table column has a header, an alignment and a source", () => {
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "table") continue;
			expect(band.columns.length, `${spec.id}/${band.title}`).toBeGreaterThan(0);
			for (const col of band.columns) {
				expect(col.header.length, `${spec.id}/${band.title}`).toBeGreaterThan(0);
				expect(["left", "right"], `${spec.id}/${band.title}/${col.header}`).toContain(col.align);
				expect(col.source, `${spec.id}/${band.title}/${col.header}`).toBeTruthy();
			}
		}
	}
});

test("every chart names a metric and a type, and never both a metric and nothing else", () => {
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "chart") continue;
			expect(["bars", "sparkline", "heatmap", "rankedBars", "shareBar"], `${spec.id}/${band.title}`).toContain(band.chart.type);
			expect(band.chart.series.length, `${spec.id}/${band.title}`).toBeGreaterThan(0);
		}
	}
});


// ─── the architectural test: the IR stays free of presentation ───────────────

test("the IR carries no glyphs, colours, widths or presets in its DATA", () => {
	const data = JSON.stringify(SCREEN_SPECS);
	// Block/shade/box glyphs.
	expect(data).not.toMatch(/[▀-▟░-▓]/);
	// CSS custom properties and hex colours.
	expect(data).not.toMatch(/var\(--|#[0-9a-f]{3,8}\b/i);
	// Preset names.
	expect(data).not.toMatch(/"(unicode|nerd|ascii)"/);
	// Layout primitives the renderer owns.
	expect(data).not.toMatch(/"(width|height|color|colour|glyph|padding|indent|preset|maxWidth|minWidth)":/);
});


// ─── the port, not a redesign ────────────────────────────────────────────────

test("the ported screens mirror the route's band order", () => {
	const overview = SCREEN_SPECS.find(s => s.id === "overview")!;
	// OverviewRoute.tsx renders: PageHeader, StatGrid (big), StatGrid (small),
	// then a grid of [Activity chart, Token mix], then Latest requests.
	expect(overview.bands.map(b => b.kind)).toEqual([
		"statRow",
		"statRow",
		"chart",
		"chart",
		"legend",
		"table",
		"note",
	]);

	const models = SCREEN_SPECS.find(s => s.id === "models")!;
	// ModelsRoute.tsx renders: StatGrid, "Request share" Card, "All models"
	// Table. The card's per-series Legend is togglable UI chrome the terminal
	// cannot host (no pointer, no per-row toggle); the shares live on the
	// chart readouts instead, so the IR carries no legend band here.
	expect(models.bands.map(b => b.kind)).toEqual(["statRow", "chart", "table", "note"]);
});

test("the activity screen derives from the usage dashboard, not a route", () => {
	const activity = SCREEN_SPECS.find(s => s.id === "activity")!;
	// The web dashboard has no activity route; the calendar lives in omp's own
	// /usage overlay. The citation must say so, or the port is unauditable.
	expect(activity.source.file).toContain("usage-dashboard");
	expect(activity.source.note).toMatch(/no activity route|usage/i);
	expect(activity.bands.some(b => b.kind === "chart" && b.chart.type === "heatmap")).toBe(true);
});


test("providers is fillable from the local aggregates; only the windows sections stay out", () => {
	// `/api/stats/providers` is DB-backed rollup; `/api/stats/provider-windows`
	// does broker network I/O per load and the panel never calls it. So the
		// spec carries needs and the windows boundary lives in a note band.
	const providers = SCREEN_SPECS.find(s => s.id === "providers")!;
	expect([...providers.needs]).toEqual(["providers", "rollupStatus"]);
	const kinds = providers.bands.map(b => b.kind);
	expect(kinds).toContain("note");
});

test("every screen declares its needs as real DataNeeds", () => {
	for (const spec of SCREEN_SPECS) {
		for (const need of spec.needs as readonly DataNeed[]) {
			expect(DATA_NEEDS as readonly string[], `${spec.id}/${need}`).toContain(need);
		}
	}
});
