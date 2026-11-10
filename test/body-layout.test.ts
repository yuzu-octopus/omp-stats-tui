/**
 * `test/body-layout.test.ts` — the BODY layout defects a screenshot shows.
 *
 * Every test here was written by LOOKING at `bun scripts/probe-render.ts
 * providers --width 150` and finding something wrong with it, not by reading a
 * spec and imagining a defect. The five findings, in the order the reader sees
 * them:
 *
 *  D1 STAT TILES — three 48-cell columns holding 13-cell figures, and a bare
 *     `…` hanging off the right of every row. Cause: `renderStatRow` divided
 *     the inner width by the column COUNT (`floor(inner / 3)`) instead of
 *     measuring the tiles, so the join overflowed and `clamp` truncated it.
 *  D2 RANKED BARS — a solid block the full width of the panel, because the
 *     track was `innerWidth - label - figure`.
 *  D3 TABLE — headers over the wrong columns, an empty Share column, a raw
 *     `0.004` error rate, and 12-cell meter blocks that carry no figure at all.
 *  D4 TRUNCATION — `…` must never be a whole column.
 *  D5 COMPACT NOTATION — `26,805,348,752` where the web writes `26.8B`.
 *
 * The invariants are asserted against the REAL screens through the real
 * renderer, because the point of every one of them is that the composition is
 * legible — and a unit test of one function cannot see a misaligned header.
 */

import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui";

import { SCREEN_SPECS, type ScreenSpec } from "../src/layout/spec";
import { renderBands, type Band, type BandRenderOptions, type Column } from "../src/tui/band";
import { renderRankedBars } from "../src/tui/charts/sparkline";
import { renderScreen, screenBands, type ScreenRenderOptions } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { PALETTE, SERIES_COLORS, stripForTest } from "../src/tui/palette";
import { DEFAULT_RANGE } from "../src/data/ranges";
import type { PanelData } from "../src/data/api";
import { FIXTURE_NOW, liveData, type ProviderDashboardFixture } from "./fixtures/panel";
import { sidebar } from "../src/tui/chrome";
import { bodyRows } from "../src/tui/frame";
import type { FeatureContext, FeatureController } from "../src/tui/features/types";
import { createSummaryFeature } from "../src/tui/features/core/summary";
import { createAnalyticsFeature } from "../src/tui/features/core/analytics";
import { createRequestsFeature } from "../src/tui/features/core/requests";
import { createProvidersFeature } from "../src/tui/features/providers";
import { messageRow } from "./fixtures/panel";

ensureThemeSync();

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (text: string): string => text.replace(ANSI, "");
const text = (rows: readonly string[]): string => stripForTest(rows.join("\n"));

function opts(spec: ScreenSpec, data: PanelData, width = 150): ScreenRenderOptions {
	const preset: SymbolPreset = "unicode";
	return {
		spec,
		data,
		plan: planLayout(width, 40, preset),
		preset,
		range: DEFAULT_RANGE,
		now: FIXTURE_NOW,
		fg: (color: ThemeColor, value: string) => theme.fg(color, value),
		bold: value => theme.bold(value),
		palette: theme,
		seriesColorFor: index => SERIES_COLORS[index % SERIES_COLORS.length],
		glyphs: glyphsFor(preset),
	};
}

const specOf = (id: string): ScreenSpec => {
	const spec = SCREEN_SPECS.find(s => s.id === id);
	if (spec === undefined) throw new Error(`no screen spec ${id}`);
	return spec;
};

/** Every screen a reader can actually land on. */
const FILLABLE = SCREEN_SPECS;

/** The grid renders itself for every band kind and width it supports. */
const WIDTHS = [40, 48, 60, 72, 80, 100, 120, 150] as const;

function bandCtx(overrides: Partial<BandRenderOptions>): BandRenderOptions {
	return {
		width: 146,
		innerWidth: 146,
		preset: "unicode",
		glyphs: glyphsFor("unicode"),
		fg: (_color, value) => value,
		bold: value => value,
		barHeight: 6,
		labelWidth: 12,
		valueWidth: 12,
		...overrides,
	};
}

// ─── D4: `…` is never a whole column ─────────────────────────────────────────

/**
 * The rule, stated once so every other test can lean on it.
 *
 * A `…` is a truncated FIGURE — a tail on a real number or label. It is never a
 * cell of its own, because a column of `…` says "there is more here" without
 * saying what, which is the exact failure the truncation policy exists to
 * prevent: columns are DROPPED, not squeezed to nothing.
 */
const FLOATING_ELLIPSIS = /(^|\s{2,})…(\s|$)/;

test("D4: no screen renders a `…` standing alone as a cell", () => {
	const offenders: string[] = [];
	for (const spec of FILLABLE) {
		for (const width of WIDTHS) {
			renderScreen(opts(spec, liveData(), width)).forEach((row, index) => {
				const stripped = plain(row);
				if (FLOATING_ELLIPSIS.test(stripped)) {
					offenders.push(`${spec.id}@${width} row ${index}: ${JSON.stringify(stripped)}`);
				}
			});
		}
	}
	expect(offenders, offenders.slice(0, 8).join("\n")).toEqual([]);
});

test("D4: the providers stat row that produced a `…` on every line now has none", () => {
	// The reported render, verbatim in shape: five tiles at width 150 printed a
	// trailing `…` on the label row, the value row and the two hint rows.
	const rows = renderScreen(opts(specOf("providers"), liveData(), 150));
	expect(rows.length).toBeGreaterThan(4);
	for (const row of rows.slice(0, 8)) expect(plain(row), JSON.stringify(plain(row))).not.toContain("…");
});

// ─── D1: stat tiles fit their content and their cell ─────────────────────────

test("D1: a stat row is as wide as its tiles need, not as wide as the panel", () => {
	// The defect: `tileWidth = floor(inner / columns)`, so at inner 146 three
	// tiles were 48 cells each and a 13-cell figure sat in a 48-cell slot. The
	// grid must be sized by CONTENT and stop there.
	const stats = [
		{ label: "Providers", value: "11", hint: "Most tokens: opencode-go" },
		{ label: "Requests", value: "194,349", hint: "3,281 failed" },
		{ label: "Tokens", value: "26.8B" },
		{ label: "API-equivalent cost", value: "$2,589.50", hint: "1,204 unpriced" },
		{ label: "Error rate", value: "1.7%", hint: "191,068 succeeded" },
	];
	const content = Math.max(...stats.map(s => Math.max(s.label.length, s.value.length)));
	const rows = renderBands([{ kind: "statRow", stats }], bandCtx({}));
	const widest = Math.max(...rows.map(r => visibleWidth(r)));
	// Three columns of the widest tile plus two gutters, and no wider.
	expect(widest).toBeLessThanOrEqual(3 * content + 4);
	expect(widest).toBeLessThan(146);
});

test("D1: a stat row never overflows its inner width, so nothing is truncated away", () => {
	// The mechanism of the reported `…`: the joined row was
	// `columns * floor(inner/columns) + gutters` — four cells too wide whenever
	// the division had a remainder — and `clamp` cut it, printing `…`.
	for (const width of WIDTHS) {
		const rows = renderBands(
			[
				{
					kind: "statRow",
					stats: [
						{ label: "Providers", value: "11", hint: "Most tokens: opencode-go" },
						{ label: "Requests", value: "194,349", hint: "3,281 failed" },
						{ label: "Tokens", value: "26,805,348,752" },
					],
				},
			],
			bandCtx({ width, innerWidth: width }),
		);
		for (const row of rows) {
			expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width);
		}
		expect(rows.join(""), `width ${width}`).not.toContain("…");
	}
});

test("D1: every tile's own rows fit inside the one cell the grid gave it", () => {
	// A grid whose columns disagree about where they end is the same defect one
	// level down: the third tile's figure must start where the third tile's
	// LABEL starts, or the tiles are not a grid at all.
	const stats = [
		{ label: "A", value: "1" },
		{ label: "Bee", value: "22,222" },
		{ label: "Cee", value: "333,333,333" },
	];
	const rows = renderBands([{ kind: "statRow", stats }], bandCtx({ innerWidth: 60 }));
	const labelRow = plain(rows[0] as string);
	const valueRow = plain(rows[1] as string);
	for (const [index, tile] of stats.entries()) {
		const at = labelRow.indexOf(tile.label);
		expect(at, `${tile.label} label`).toBeGreaterThanOrEqual(0);
		expect(valueRow.slice(at).startsWith(tile.value), `${tile.value} starts under ${tile.label}`).toBe(true);
	}
});

test("D1: a hint is kept whole or dropped whole — never clipped to an ellipsis", () => {
	const rows = renderBands(
		[{ kind: "statRow", stats: [{ label: "Cost", value: "$2,589.50", hint: "34,870 requests had no price card" }] }],
		bandCtx({ innerWidth: 30 }),
	);
	expect(rows.join("\n")).not.toContain("…");
	expect(rows.join("\n")).toContain("$2,589.50");
	expect(rows.join("\n")).not.toContain("no price card");
});

// ─── D2: ranked bars are bounded to a readable track ─────────────────────────

test("D2: a ranked bar's track is bounded, so a dominant row is a bar not a wall", () => {
	// The defect: `track = width - label - readout`, so at inner 146 the top
	// provider painted 113 solid cells. A bar you cannot see past is a
	// background colour; the web's own meter is 64px.
	const rows = renderRankedBars(
		[
			{ label: "opencode-go", value: 1_045_814_212 },
			{ label: "google-antigravity", value: 602 },
		],
		{ width: 146, accent: t => t },
	);
	const widest = Math.max(...rows.map(r => visibleWidth(r)));
	expect(widest).toBeLessThan(146);
	expect(widest).toBeLessThanOrEqual(96);
});

test("D2: a ranked row carries a label, a bar and exactly one figure", () => {
	const rows = renderRankedBars(
		[
			{ label: "opencode-go", value: 1_045_814_212 },
			{ label: "google-antigravity", value: 602 },
		],
		{ width: 146, accent: t => t },
	);
	// Each row carries ITS OWN label — the renderer's label column is one width
	// for the whole list, so every label is padded (or ellipsized) to it — plus a
	// bar and a figure, and nothing after the figure.
	rows.forEach((row, index) => {
		const stripped = plain(row as string);
		expect(stripped.trimEnd(), JSON.stringify(stripped)).toBe(stripped);
		expect(stripped).toContain(index === 0 ? "opencode-go" : "google-antigravity");
		expect(stripped).toMatch(/[█░]/);
	});
	// Sorted descending: the largest row leads.
	expect(rows[0]).toContain("opencode-go");
	expect(rows[1]).toContain("google-antigravity");
	expect(rows.join("")).not.toContain("…");
});

test("D2: a ranked list drops its LABEL rather than reducing it to a bare `…`", () => {
	// The truncation policy's last step, at its narrowest: below the width a
	// label can keep, it goes entirely and the bar and figure carry the row.
	const rows = renderRankedBars(
		[
			{ label: "opencode-go", value: 1_045_814_212 },
			{ label: "google-antigravity", value: 602 },
		],
		{ width: 22, accent: t => t },
	);
	for (const row of rows) {
		const stripped = plain(row as string);
		expect(stripped, JSON.stringify(stripped)).not.toMatch(FLOATING_ELLIPSIS);
		expect(visibleWidth(stripped)).toBeLessThanOrEqual(22);
	}
});

test("D2: ANSI in a bar is not counted as width, so the row is not truncated", () => {
	// `renderRankedBars` measured with `Bun.stringWidth`, which counts escape
	// BYTES. Under a real theme every row measured over-wide and was cut — the
	// `…` at the right of the burn chart.
	const rows = renderRankedBars(
		[
			{ label: "opencode-go", value: 1_045_814_212 },
			{ label: "google-antigravity", value: 602 },
		],
		{
			width: 100,
			accent: t => `\x1b[38;2;180;120;255m${t}\x1b[39m`,
		},
	);
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(100);
	expect(rows.join("")).not.toContain("…");
});

test("D2: every ranked row fits its width, swept 10..200", () => {
	for (let width = 10; width <= 200; width++) {
		const rows = renderRankedBars(
			[
				{ label: "a-very-long-model-identifier-that-overflows-the-column", value: 935.72 },
				{ label: "short", value: 0 },
				{ label: "gpt-5.6-sol", value: 1292.85 },
			],
			{ width, accent: t => t },
		);
		for (const row of rows) expect(visibleWidth(row), `width ${width}: ${row}`).toBeLessThanOrEqual(width);
	}
});

// ─── D3: the table's headers sit over their own data ─────────────────────────

/**
 * Where a column's text starts and ends in a rendered row.
 *
 * Alignment is asserted by POSITION, not by eyeballing: a right-aligned
 * column's header must END where its figures end, and a left-aligned column's
 * header must START where its labels start. A width computed from the HEADERS
 * alone — the reported bug — passes a "does the header exist" test and fails
 * this one, because a 13-cell provider name in a 8-cell slot pushes every
 * later column one gutter to the right.
 */
function span(row: string, needle: string, align: "left" | "right"): { start: number; end: number } {
	const at = align === "right" ? row.lastIndexOf(needle) : row.indexOf(needle);
	expect(at, `${JSON.stringify(needle)} not found in ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(0);
	return { start: at, end: at + needle.length };
}

const TOTALS: readonly Column[] = [
	{ key: "Provider", header: "Provider", align: "left" },
	{ key: "Requests", header: "Requests", align: "right" },
	{ key: "Error rate", header: "Error rate", align: "right" },
	{ key: "Tokens", header: "Tokens", align: "right" },
];

const TOTALS_ROWS: { kind: "inline"; rows: readonly Readonly<Record<string, string>>[] } = {
	kind: "inline",
	rows: [
		{ Provider: "opencode-go", Requests: "36,616 ████████", "Error rate": "0.2%", Tokens: "1B ████████" },
		{ Provider: "google-antigravity", Requests: "4,197 ░░", "Error rate": "none", Tokens: "201.5M ░" },
	],
};

test("D3: every table header lines up with the column of data beneath it", () => {
	const rendered = renderBands(
		[{ kind: "table", title: "Provider totals", columns: TOTALS, rows: TOTALS_ROWS }],
		bandCtx({}),
	);
	const header = plain(rendered[1] as string);
	// Each rendered row is checked against ITS OWN cells, because a column's
	// width is the widest of its cells — so row 1's `none` is narrower than
	// row 0's `0.2%` and only the padding, not the position, may differ.
	TOTALS_ROWS.rows.forEach((expected, rowIndex) => {
		const data = plain(rendered[2 + rowIndex] as string);
		TOTALS.forEach((column, index) => {
			const cell = expected[column.key] as string;
			const h = span(header, column.header, column.align);
			const c = span(data, cell, column.align);
			if (column.align === "right") {
				expect(h.end, `${column.header} end vs ${cell}`).toBe(c.end);
			} else {
				expect(h.start, `${column.header} start vs ${cell}`).toBe(c.start);
			}
		});
	});
});

test("D3: the reported table — headers over the wrong cells — is fixed", () => {
	// The exact shape from the screenshot: a 13-cell provider name under an
	// 8-cell "Provider" header. Before the fix every column after the first sat
	// five cells right of its header.
	const columns: readonly Column[] = [
		{ key: "Provider", header: "Provider", align: "left" },
		{ key: "Requests", header: "Requests", align: "right" },
		{ key: "Models", header: "Models", align: "right" },
	];
	const rows = {
		kind: "inline" as const,
		rows: [{ Provider: "google-antigravity", Requests: "4,197", Models: "1" }],
	};
	const rendered = renderBands([{ kind: "table", title: "Provider totals", columns, rows }], bandCtx({}));
	const header = plain(rendered[1] as string);
	const data = plain(rendered[2] as string);
	expect(span(header, "Requests", "right").end).toBe(span(data, "4,197", "right").end);
	expect(span(header, "Models", "right").end).toBe(span(data, "1", "right").end);
	expect(span(header, "Provider", "left").start).toBe(span(data, "google-antigravity", "left").start);
});

test("D3: a column is sized by its DATA, not by its header", () => {
	// A header of 8 cells over 1-cell data must not leave an 8-cell hole; the
	// next column's content has to be able to use the space.
	const columns: readonly Column[] = [
		{ key: "Model", header: "Model", align: "left" },
		{ key: "n", header: "Requests", align: "right" },
	];
	const rows = { kind: "inline" as const, rows: [{ Model: "a", n: "7" }] };
	const rendered = renderBands([{ kind: "table", title: "T", columns, rows }], bandCtx({}));
	expect(visibleWidth(plain(rendered[2] as string)).valueOf()).toBe(
		visibleWidth(plain(rendered[1] as string)).valueOf(),
	);
});

test("D3: a meter cell shows its FIGURE beside a short bar, not a block of blocks", () => {
	// The web's MeterCell is `formatInteger(value)` + a 64px meter
	// (Table.tsx:199-207). Ours drew twelve glyph cells and no number, so the
	// header "Requests" sat over a block that said nothing — a magnitude with no
	// value under a header naming a figure that was not on the page.
	const body = text(renderScreen(opts(specOf("providers"), liveData(), 150)));
	// The FIGURE is there: opencode-go's 36,616 requests.
	expect(body).toContain("36,616");
	// And the bar beside it is short. Scoped to the TABLE row, because the
	// ranked chart above legitimately carries a longer track.
	const tableRow = body.split("\n").find(l => l.includes("36,616"));
	expect(tableRow, "the opencode-go table row").toBeDefined();
	for (const run of (tableRow as string).match(/[█░]+/g) ?? []) {
		expect(visibleWidth(run), `meter run ${JSON.stringify(run)}`).toBeLessThanOrEqual(16);
	}
});

test("D3: the providers Share column is a percentage, not an empty cell", () => {
	// The spec pointed Share at the same `totalTokens` field as the Tokens
	// column, so it printed a second token count — and at narrow widths the
	// squeeze left it blank. The web divides by the GRAND total.
	const spec = specOf("providers");
	const band = spec.bands.find(b => b.kind === "table" && b.title === "Provider totals");
	if (band === undefined || band.kind !== "table") throw new Error("no Provider totals band");
	const share = band.columns.find(c => c.header === "Share");
	expect(share, "Share column").toBeDefined();
	expect(share!.source.kind, "Share is a share, not a second token count").toBe("derived");
	if (share!.source.kind !== "derived") throw new Error("unreachable");
	expect(share!.source.op).toBe("share");
	expect(share!.source.againstScope).toBe("total");

	const body = text(renderScreen(opts(spec, liveData(), 150)));
	const shareLine = body.split("\n").find(l => l.includes("opencode-go") && l.includes("%"));
	expect(shareLine, "a provider row carrying its share").toBeDefined();
});

test("D3: an error rate is a percentage, never a raw fraction", () => {
	// `badgeCell` followed the derived ref down to `failedRequests`, saw no
	// "rate" in the field name, and printed `formatInteger(0.0024)` = "0".
	// The web prints `formatErrorRate` — and a rate below 0.005% says
	// `<0.01%` rather than rounding itself to a clean zero.
	const body = text(renderScreen(opts(specOf("providers"), liveData(), 150)));
	expect(body).not.toMatch(/\b0\.0\d{1,4}\b(?!\s*%)/);
	const errors = text(renderScreen(opts(specOf("errors"), liveData(), 150)));
	expect(errors).not.toMatch(/\b0\.\d{3,}\b/);
});

test("D3: no table cell renders as an EMPTY gutter", () => {
	// The reported Share column was blank at narrow widths: it resolved to
	// nothing, and an empty column is a hole where a figure should be.
	//
	// Asserted on the BAND'S OWN CELLS rather than on rendered text, because two
	// earlier attempts at a text heuristic were wrong for the same reason: a
	// stat grid and a table are both "words in columns" in plain text, so any
	// "find the header row" heuristic eventually matched a tile row instead. The
	// cells are already structured, so the invariant is one line of arithmetic:
	// no cell of a table that has data is empty.
	for (const spec of FILLABLE) {
		for (const band of screenBands(opts(spec, liveData(), 150))) {
			if (band.kind !== "table" || band.rows.kind !== "inline") continue;
			for (const row of band.rows.rows) {
				for (const column of band.columns) {
					expect(
						row[column.key],
						`${spec.id} "${band.title}": cell ${column.key} is empty`,
					).not.toBe("");
				}
			}
		}
	}
});

test("D3: a rendered table row has no gap where a column was dropped", () => {
	// The second half of the empty-cell defect: a column that prints nothing
	// still reserves its width, so the row keeps a blank gutter between two
	// populated columns — invisible to the per-cell assertion above.
	//
	// Asserted on the TABLE BAND alone, because a stat grid legitimately has
	// gaps between its tiles (that is what a grid is) and a whole screen's text
	// therefore cannot carry this invariant.
	for (const width of WIDTHS) {
		const band = screenBands(opts(specOf("providers"), liveData(), width)).find(
			(candidate): candidate is Extract<Band, { kind: "table" }> =>
				candidate.kind === "table" && candidate.title === "Provider totals",
		);
		if (band === undefined) continue;
		const lines = renderBands([band], bandCtx({ width: width - 4, innerWidth: width - 4 })).map(plain);
		for (const line of lines.slice(2)) {
			if (line.trim() === "" || /[█░]/.test(line)) continue;
			// Two or more spaces between two non-spaces is the shape of a column
			// that reserved its width and printed nothing.
			expect(line, `${width}: ${JSON.stringify(line)}`).not.toMatch(/\S {2,}\S/);
		}
	}
});

// ─── D3: the truncation policy, in the documented order ──────────────────────

test("D3: a too-narrow table DROPS the lowest-priority column instead of printing `…`", () => {
	// The policy, in the order it applies:
	//   1. shrink each column to its own widest cell;
	//   2. drop the LOWEST-PRIORITY column that makes the row fit;
	//   3. only then truncate a figure, and never to a bare `…`.
	const columns: readonly Column[] = [
		{ key: "Model", header: "Model", align: "left" },
		{ key: "cost", header: "Cost", align: "right" },
		{ key: "premium", header: "Premium", align: "right", priority: 10 },
	];
	const rows = {
		kind: "inline" as const,
		rows: [{ Model: "gpt-5.6-terra", cost: "$935.72", premium: "12,345" }],
	};
	const narrow = renderBands([{ kind: "table", title: "T", columns, rows }], bandCtx({ width: 24, innerWidth: 24 }));
	const body = plain(narrow.join("\n"));
	expect(body).toContain("gpt-5.6-terra");
	expect(body).not.toContain("Premium");
	expect(body).not.toMatch(FLOATING_ELLIPSIS);
	// At full width every column is present.
	const wide = renderBands([{ kind: "table", title: "T", columns, rows }], bandCtx({ width: 80, innerWidth: 80 }));
	expect(plain(wide.join("\n"))).toContain("Premium");
});

test("D3: the identity column outlives every other column", () => {
	const columns: readonly Column[] = [
		{ key: "Provider", header: "Provider", align: "left" },
		{ key: "a", header: "Alpha", align: "right" },
		{ key: "b", header: "Bravo", align: "right" },
		{ key: "c", header: "Charlie", align: "right" },
	];
	const rows = {
		kind: "inline" as const,
		rows: [{ Provider: "google-antigravity", a: "1", b: "22", c: "333" }],
	};
	for (const width of [16, 20, 24, 30, 40]) {
		const body = plain(renderBands([{ kind: "table", title: "T", columns, rows }], bandCtx({ width, innerWidth: width })).join("\n"));
		expect(body, `width ${width}`).toContain("google");
	}
});

// ─── D5: compact notation, where the web uses it ─────────────────────────────

test("D5: a token total prints compact, the way the web's formatCompact does", () => {
	// `formatCompact(26_805_348_752)` is `26.8B`. Ours printed the full figure,
	// which is what forced the giant Share column and the clipped tiles.
	const body = text(renderScreen(opts(specOf("providers"), liveData(), 150)));
	expect(body).toContain("1B");
	expect(body).not.toContain("1,017,800,000");
});

test("D5: no screen prints an 11-digit token count the web would compact", () => {
	// The reported figures: `26,805,348,752` and `16,690,883,110`. Wherever the
	// web calls `formatCompact` on a token count, so must the panel — the token
	// columns AND the token stat tiles.
	for (const spec of FILLABLE) {
		for (const width of WIDTHS) {
			for (const row of renderScreen(opts(spec, liveData(), width))) {
				expect(plain(row), `${spec.id}@${width}`).not.toMatch(/\b\d{1,3}(,\d{3}){3,}\b/);
			}
		}
	}
});

test("D5: compact notation still names the unit, so 1B is not a bare digit", () => {
	const body = text(renderScreen(opts(specOf("providers"), liveData(), 150)));
	expect(body).toMatch(/\b\d+(\.\d+)?[KMB]\b/);
});

// ─── the composition as a whole ──────────────────────────────────────────────

test("the providers body reads as a grid, a ranked list and an aligned table", () => {
	// One end-to-end read of the screen that was reported broken, asserting the
	// three shapes rather than any single figure.
	const rows = renderScreen(opts(specOf("providers"), liveData(), 150)).map(plain);
	const statRows = rows.slice(0, 8);
	// Compact: no stat row spans the panel.
	expect(Math.max(...statRows.map(r => visibleWidth(r)))).toBeLessThan(146);
	// The burn list is bounded and carries one figure per row.
	const burn = rows.filter(r => /opencode-go/.test(r) && /[█░]/.test(r) && !r.includes("Provider"));
	for (const row of burn) expect(visibleWidth(row)).toBeLessThan(146);
	// The table header and its data share column boundaries.
	const header = rows.find(r => r.includes("Provider") && r.includes("Tokens") && !/[█░]/.test(r));
	expect(header, "the Provider totals header").toBeDefined();
});

// ─── the unit of a bar's figure follows the CHART, not the caveat ────────────

test("D2: a TOKEN-scaled bar never prints its figure as money", () => {
	// Found by watching width 100, which is the band where the burn chart
	// actually has to fit. google-antigravity's row read
	// `$201,500,000.00 · 4,197 unpriced` — a dollar figure for 201,500,000 TOKENS.
	//
	// Two faults in one cell. The unit is wrong (this chart is token-scaled), and
	// the number is nonsense, because `formatCost` was handed a token count. The
	// cause is that the unpriced caveat forced `costWithUnpriced` regardless of
	// what the chart measures — but the unpriced rule is about COSTS. A token
	// chart has no unmeasured SPEND to caveat, so there is nothing for that
	// function to say.
	//
	// The web agrees: `burnFormat` follows the chart's own metric mode
	// (`ProvidersRoute.tsx:141`) and the unpriced count lives in the card
	// description (`:194-195`) — never on a burn row.
	// Scoped to the BURN chart, not every bar-ish row: the Provider totals TABLE
	// is cost-scaled and is supposed to print money. An earlier version of this
	// assertion swept every row with a bar glyph and failed on the table's own
	// Cost column — which is correct behaviour being tested as a bug.
	const body = text(renderScreen(opts(specOf("providers"), liveData(), 100)));
	const lines = body.split("\n");
	const heading = lines.findIndex(l => l.includes("Burn by provider"));
	expect(heading, "the burn chart").toBeGreaterThan(-1);
	// From the burn heading to the next band heading — the chart and its rows.
	const end = lines.findIndex((l, i) => i > heading && /^[⏱📊]/.test(l) && l !== lines[heading]);
	const burn = lines.slice(heading + 1, end === -1 ? lines.length : end).filter(l => l.trim() !== "");
	expect(burn.length, "the burn rows").toBeGreaterThan(1);
	for (const row of burn) expect(row, JSON.stringify(row)).not.toMatch(/\$[\d,]*\d/);
	// And the caveat is not simply dropped: it rides along in the chart's unit.
	expect(burn.join("\n")).toMatch(/202M · 4,197 unpriced/);
});

test("D2: a COST-scaled bar still carries its unpriced count", () => {
	// The rule that motivated the caveat is untouched: a row whose spend could
	// not be measured must never read as a free `$0.00`, and the unpriced count
	// must reach the reader beside the figure it qualifies. `costWithUnpriced`
	// owns both halves; the fix for the unit bug must not silence it.
	const rows = SCREEN_SPECS;
	const costScreens = rows.filter(spec =>
		spec.bands.some(band => band.kind === "chart" && band.chart.axis === "cost"),
	);
	expect(costScreens.length, "a cost-scaled chart exists to check").toBeGreaterThan(0);
	for (const spec of costScreens) {
		const body = text(renderScreen(opts(spec, liveData(), 150)));
		// Wherever the fixture carries an unpriced row, the count is stated.
		if (/unpriced/.test(body)) expect(body, spec.id).not.toMatch(/\$0\.00(?!\d)/);
	}
});

// ─── Task 2.1: production bodies fill the frame ─────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FILL_ROWS = 30;

/**
 * A payload with enough rows that every production screen CAN fill a 40-row
 * frame. The fill rule is about caps, not about inventing content: a table
 * with fewer rows than the frame cannot stretch, so the assertion is that no
 * screen leaves blank rows when its content can reach them, and that a screen
 * with more content than fits still scrolls (its source exceeds the frame).
 */
function fillData(): PanelData {
	const data = liveData();
	const models = Array.from({ length: FILL_ROWS }, (_, i) => ({
		...data.modelDashboard!.byModel[0]!,
		model: `model-${i}`,
		provider: `provider-${i % 4}`,
		totalRequests: 1000 - i,
		totalCost: 100 - i,
		unpricedRequests: i % 5 === 0 ? 5 : 0,
	}));
	const modelSeries = Array.from({ length: FILL_ROWS }, (_, m) =>
		Array.from({ length: 30 }, (_, b) => ({ timestamp: FIXTURE_NOW - (29 - b) * HOUR_MS, model: `model-${m}`, provider: `provider-${m % 4}`, requests: 10 + ((m + b) % 7) })));
	const costSeries = Array.from({ length: FILL_ROWS }, (_, m) =>
		Array.from({ length: 30 }, (_, b) => ({
			timestamp: Math.floor((FIXTURE_NOW - (29 - b) * DAY_MS) / DAY_MS) * DAY_MS,
			model: `model-${m}`, provider: `provider-${m % 4}`, requests: 10,
			unpricedRequests: m % 5 === 0 ? 2 : 0, cost: m === 0 ? 10 : 1,
			costInput: 0.5, costOutput: 0.5, costCacheRead: 0, costCacheWrite: 0,
		})));
	const folders = Array.from({ length: FILL_ROWS }, (_, i) => ({
		...data.folders![0]!, folder: `/project-${i}`, totalRequests: 500 - i, totalCost: 50 - i * 0.5, unpricedRequests: i % 4 === 0 ? 3 : 0,
	}));
	const tools = Array.from({ length: FILL_ROWS }, (_, i) => ({
		tool: `tool-${i}`, calls: 100 - i, errors: i % 3, argsChars: 10, resultChars: 20,
		totalTokensShare: 1000, outputTokensShare: 100, costShare: 1, unpricedRequestsShare: 0, lastUsed: FIXTURE_NOW,
	}));
	const byToolModel = Array.from({ length: FILL_ROWS }, (_, i) => ({ ...tools[i]!, model: `model-${i}`, provider: `provider-${i % 4}` }));
	const toolSeries = Array.from({ length: FILL_ROWS }, (_, t) =>
		Array.from({ length: 30 }, (_, b) => ({ timestamp: FIXTURE_NOW - (29 - b) * HOUR_MS, tool: `tool-${t}`, calls: 5 + ((t + b) % 5), errors: t % 3 })));
	const recent = Array.from({ length: FILL_ROWS }, (_, i) => messageRow({ id: i + 1, timestamp: FIXTURE_NOW - i * HOUR_MS }));
	const providers = Array.from({ length: FILL_ROWS }, (_, i) => ({
		provider: `provider-${i}`, totalRequests: 1000 - i * 10, failedRequests: i % 4, models: 2,
		totalInputTokens: 1000, totalOutputTokens: 500, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
		totalTokens: 1500, totalCost: 10 - i * 0.1, unpricedRequests: i % 5 === 0 ? 2 : 0,
		totalPremiumRequests: 0, avgTokensPerSecond: 50,
	}));
	const providerSeries = Array.from({ length: FILL_ROWS }, (_, p) =>
		Array.from({ length: 30 }, (_, b) => ({ timestamp: FIXTURE_NOW - (29 - b) * HOUR_MS, provider: `provider-${p}`, totalTokens: 100, outputTokens: 50, requests: 5, cost: 1, unpricedRequests: 0 })));
	const hourly = Array.from({ length: 24 }, (_, h) => ({ provider: "provider-0", hour: h, totalTokens: 100, outputTokens: 50, requests: 5 }));
	return {
		...data,
		overview: { ...data.overview!, timeSeries: Array.from({ length: 30 }, (_, b) => ({ timestamp: FIXTURE_NOW - (29 - b) * HOUR_MS, requests: 10, errors: 1, tokens: 1000, cost: 1 })) },
		modelDashboard: { byModel: models, modelSeries: modelSeries.flat(), modelPerformanceSeries: [] },
		costs: { costSeries: costSeries.flat() },
		folders,
		recent,
		errors: recent.map((row, i) => ({ ...row, errorMessage: `error-${i}` })),
		tools: { byTool: tools, byToolModel, series: toolSeries.flat() },
		providers: { providers, hourly, series: providerSeries.flat(), insights: (data.providers as ProviderDashboardFixture).insights },
	} as PanelData;
}

function productionScreens(data: PanelData): [string, FeatureController][] {
	const make = (api: (path: string) => unknown): FeatureContext => ({
		theme, now: () => FIXTURE_NOW, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {},
		reader: { api: async <T>(path: string) => api(path) as T, fetch: async () => data },
	});
	const recentOnly = make(path => (path === "/api/stats/recent" ? data.recent : data.errors));
	return [
		["overview", createSummaryFeature("overview", make(path => (path === "/api/stats/recent" ? data.recent : data)))],
		["projects", createSummaryFeature("projects", make(() => data))],
		["activity", createSummaryFeature("activity", make(() => data))],
		["models", createAnalyticsFeature("models", make(path => (path === "/api/stats/model-dashboard" ? data.modelDashboard : data)))],
		["costs", createAnalyticsFeature("costs", make(path => (path === "/api/stats/costs" ? data.costs : data)))],
		["tools", createAnalyticsFeature("tools", make(path => (path === "/api/stats/tools" ? data.tools : data)))],
		["requests", createRequestsFeature("requests", recentOnly)],
		["errors", createRequestsFeature("errors", recentOnly)],
		["providers", createProvidersFeature(make(path => (path === "/api/stats/providers" ? data.providers : { windowInsights: [], usageSeries: [] })))],
	];
}

/** The body width and height the panel hands a feature at this frame size. */
function frameBudget(width: number, rows: number): { inner: number; height: number } {
	const preset = theme.getSymbolPreset();
	const column = width >= 84 && rows >= 20;
	const nav = sidebar(theme, preset, "overview");
	return {
		inner: planLayout(Math.max(20, width - (column ? nav.width + 3 : 0)), rows, preset).innerWidth,
		height: Math.max(1, bodyRows(rows, column ? 1 : 2)),
	};
}

test("2.1: production bodies fill a 40-row frame and never exceed the frame width", async () => {
	const data = fillData();
	for (const [name, feature] of productionScreens(data)) {
		await feature.load("30d");
		for (const width of [40, 60, 100, 150]) {
			const { inner, height } = frameBudget(width, 40);
			const lines = feature.render(inner, height);
			for (const line of lines) expect(visibleWidth(line), `${name} @ ${width}`).toBeLessThanOrEqual(inner);
			if (width === 100) {
				const blank = Math.max(0, height - lines.length);
				expect(blank, `${name} leaves ${blank} blank rows at 100x40`).toBeLessThanOrEqual(3);
			}
		}
		feature.dispose();
	}
});