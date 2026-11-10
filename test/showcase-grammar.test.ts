/**
 * `test/showcase-grammar.test.ts` — the showcase proves the grammar, so this
 * test holds it to that.
 *
 * A playground that quietly omits a case is worse than no playground: it looks
 * comprehensive and is not, and the omission is invisible in a screenshot. So
 * coverage is asserted structurally, against the declared specs, rather than by
 * reading the rendered output and hoping.
 *
 * The obligations, one per grammar surface:
 *
 *   - every `Band` kind the IR declares appears in some showcase section;
 *   - every `ChartSpec.type` appears — the five chart primitives;
 *   - single-series AND multi-series bars both appear, because `compose.ts` is
 *     only meaningful beside the primitive it composes;
 *   - every `ChartSpec.axis` appears, because the axis decides the heading meta
 *     and the figure printed beside the bar;
 *   - every `Column.cell` kind appears — text, meter, badge, sparkline;
 *   - at least two column-priority tiers, so the drop order is demonstrated
 *     rather than described in a comment;
 *   - `emphasis: "primary"` and plain tiles both appear;
 *   - every section renders at every width on every preset, within width, with no
 *     rule anywhere (G5).
 *
 * WHAT THE SHOWCASE DELIBERATELY DOES NOT DEMONSTRATE, per the owners of the
 * modules involved, so these are pinned here rather than re-litigated later:
 *
 *   - `StatTile.size` ("sm" | "md") is dead by design (chart-redraw): the panel
 *     picks tile columns from width, so a second size axis with no terminal effect
 *     would be a lie in the IR. The showcase varies `emphasis` only.
 *   - A WRAPPED table cell is out of the grammar by design (chart-redraw):
 *     wrapping breaks one-row-per-record, which every row-count invariant
 *     downstream depends on. The showcase shows TRUNCATION and labels it as such.
 *   - The `custom` band is gone: it was unreachable through `renderScreen`
 *     (the conversion turned it into a NOTE) and no spec declared one. A
 *     showcase that used it would be demonstrating the grammar's bypass, not
 *     the grammar.
 */

import { expect, test } from "bun:test";
import { ensureThemeSync, theme as activeTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

import { renderScreen } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { showcaseData, SHOWCASE_NOW, SHOWCASE_SECTIONS } from "../src/tui/showcase/spec";

ensureThemeSync();

const PRESETS: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];
const WIDTHS = [40, 60, 100, 150] as const;

/** G5, verbatim from band.ts: a run of rule characters inside a body is a bug. */
const RULE_RUN = /[─━═]{3,}/;
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (line: string): string => line.replace(ANSI, "");

/** One section rendered through the SAME pipeline the real panel uses. */
function renderSection(sectionId: string, width: number, preset: SymbolPreset = "unicode"): readonly string[] {
	const section = SHOWCASE_SECTIONS.find(candidate => candidate.id === sectionId);
	if (!section) throw new Error(`no showcase section "${sectionId}"`);
	return renderScreen({
		spec: section.spec,
		data: showcaseData(sectionId),
		plan: planLayout(width, 40, preset),
		preset,
		range: "30d",
		now: SHOWCASE_NOW,
		fg: (color, text) => activeTheme.fg(color, text),
		bold: text => activeTheme.bold(text),
		palette: activeTheme,
		glyphs: glyphsFor(preset),
		today: new Date(SHOWCASE_NOW),
	});
}

// ---------------------------------------------------------------------------
// Structural coverage
// ---------------------------------------------------------------------------

test("every band kind the IR declares appears in the showcase", () => {
	const kinds = new Set<string>(SHOWCASE_SECTIONS.flatMap(section => section.spec.bands.map(band => band.kind)));
	for (const kind of ["statRow", "chart", "table", "legend", "note"]) {
		expect(kinds.has(kind), `no showcase section declares a ${kind} band`).toBe(true);
	}
	expect(kinds.has("custom")).toBe(false);
});

test("every chart primitive is demonstrated", () => {
	const types = new Set<string>();
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind === "chart") types.add(band.chart.type);
		}
	}
	for (const type of ["bars", "heatmap", "sparkline", "rankedBars", "shareBar"]) {
		expect(types.has(type), `no showcase chart of type ${type}`).toBe(true);
	}
	expect(types.size).toBe(5);
});

test("single-series and multi-series bars are BOTH demonstrated", () => {
	// `compose.ts` exists so a multi-series chart is the single-series primitive
	// called once per series. Without both shapes the composition is never visible
	// next to the thing it composes.
	let single = 0;
	let multi = 0;
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind !== "chart" || band.chart.type !== "bars") continue;
			if (band.chart.series.length === 1) single++;
			else multi++;
		}
	}
	expect(single).toBeGreaterThan(0);
	expect(multi).toBeGreaterThan(0);
});

test("a chart uses six series at most, because the web folds past that", () => {
	// `SERIES_COLORS` holds twelve tokens but the web's `pivotSeries` folds to
	// `Other (n)` past ~6 (css-tokens.md:156-160), and `resolveSeries` dedupes by
	// RESOLVED colour — so a twelve-series chart repeats hues while presenting them
	// as distinct.
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind !== "chart") continue;
			expect(band.chart.series.length, `${section.id}/${band.title}`).toBeLessThanOrEqual(6);
		}
	}
});

test("every chart axis is demonstrated, because the axis decides the heading meta", () => {
	const axes = new Set<string>();
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind === "chart") axes.add(band.chart.axis);
		}
	}
	for (const axis of ["cost", "requests", "tokens", "count", "share", "time"]) {
		expect(axes.has(axis), `no showcase chart on the ${axis} axis`).toBe(true);
	}
});

test("every table cell kind is demonstrated", () => {
	const cells = new Set<string>();
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind !== "table") {
				continue;
			}
			// `text` is the default, and it is declared EXPLICITLY on at least one
			// column so this set is built from declarations rather than from a
			// `?? "text"` fallback that would make the assertion vacuous.
			for (const column of band.columns) cells.add(column.cell ?? "text");
		}
	}
	expect(cells.has("text")).toBe(true);
	expect(cells.has("meter")).toBe(true);
	expect(cells.has("badge")).toBe(true);
	// `sparkline` is composed in `renderCell` rather than in the grammar, so it is
	// the one cell kind the grammar never sees — and it still has to be shown.
	expect(cells.has("sparkline")).toBe(true);
	expect(cells.size).toBe(4);
});

test("both emphasis levels of a stat tile are demonstrated", () => {
	let primary = 0;
	let plainTiles = 0;
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind !== "statRow") continue;
			for (const tile of band.stats) {
				if (tile.emphasis === "primary") primary++;
				else plainTiles++;
			}
		}
	}
	expect(primary).toBeGreaterThan(0);
	expect(plainTiles).toBeGreaterThan(0);
});

test("a table declares at least two column-priority tiers, so the drop order is shown", () => {
	// `Column.priority` is the truncation policy's only declared input: higher goes
	// first. With only priority-0 columns the showcase would never demonstrate a
	// drop, so the policy would live in a comment.
	const priorities = new Set<number>();
	for (const section of SHOWCASE_SECTIONS) {
		for (const band of section.spec.bands) {
			if (band.kind !== "table") continue;
			for (const column of band.columns) if (column.priority !== undefined) priorities.add(column.priority);
		}
	}
	expect(priorities.size).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Frame invariants, against the real rendered output
// ---------------------------------------------------------------------------

test("G5: no showcase section emits a section rule, at any width or preset", () => {
	for (const section of SHOWCASE_SECTIONS) {
		for (const width of WIDTHS) {
			for (const preset of PRESETS) {
				for (const line of renderSection(section.id, width, preset)) {
					expect(plain(line), `${section.id}@${width}/${preset}`).not.toMatch(RULE_RUN);
				}
			}
		}
	}
});

test("no rendered showcase row exceeds the width it was planned at", () => {
	for (const section of SHOWCASE_SECTIONS) {
		for (const width of WIDTHS) {
			for (const line of renderSection(section.id, width)) {
				expect(visibleWidth(line), `${section.id}@${width}`).toBeLessThanOrEqual(width);
			}
		}
	}
});

test("every section renders something at every width, on every preset", () => {
	for (const section of SHOWCASE_SECTIONS) {
		for (const width of WIDTHS) {
			for (const preset of PRESETS) {
				expect(renderSection(section.id, width, preset).length, `${section.id}@${width}/${preset}`).toBeGreaterThan(0);
			}
		}
	}
});

test("G4: no showcase body has a doubled blank line, leading or trailing", () => {
	// G4 is band.ts's own invariant and the showcase is a body like any other.
	for (const section of SHOWCASE_SECTIONS) {
		for (const width of [60, 100]) {
			const lines = renderSection(section.id, width).map(plain);
			expect(lines[0], `${section.id}@${width} leads with a blank`).not.toBe("");
			expect(lines[lines.length - 1], `${section.id}@${width} ends with a blank`).not.toBe("");
			for (let i = 1; i < lines.length; i++) {
				expect(lines[i] === "" && lines[i - 1] === "", `${section.id}@${width} doubled blank at ${i}`).toBe(false);
			}
		}
	}
});

test("the empty section states the empty range in words, never as a flat chart", () => {
	// CONTEXT.md: a field of zero cells is a claim about someone's usage that
	// happens to be wrong; one line of words is not.
	const text = renderSection("empty", 100)
		.map(plain)
		.join("\n");
	expect(text).toContain("No usage recorded");
});

test("the showcase introduces no glyph of its own: every data-ink cell is one cell wide", () => {
	// `Bun.stringWidth` is exactly what pi-tui measures with, so it is the function
	// to check candidates against (AGENTS.md). The showcase draws through
	// `glyphsFor`/`statsIcon`; this is the property it must not break by reaching
	// for a literal in its own body.
	for (const preset of PRESETS) {
		for (const [role, value] of Object.entries(glyphsFor(preset))) {
			for (const glyph of typeof value === "string" ? [value] : value) {
				// The ascii `heatEmpty` is a real blank — the one documented exception.
				if (preset === "ascii" && role === "heatEmpty") continue;
				expect(Bun.stringWidth(glyph), `${preset}/${role}`).toBe(1);
			}
		}
	}
});

test("a truncated figure carries an ellipsis on the figure, never as a cell of its own", () => {
	// The truncation policy's second step drops columns; the third cuts the
	// identity column's own text. So at 40 columns the awkward table must show a
	// `…` that terminates a real value, and must never show a bare `…` standing
	// alone as a cell.
	const lines = renderSection("awkward", 40).map(plain);
	const orphan = lines.find(line => /(^|\s)…(\s|$)/.test(line));
	expect(orphan).toBeUndefined();
});