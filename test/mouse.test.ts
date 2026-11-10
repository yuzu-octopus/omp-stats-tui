import { test, expect } from "bun:test";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import { rangeMeta } from "@oh-my-pi/omp-stats/client/data/range";
import { NAV_GROUPS, type NavGroup } from "../src/tui/chrome";

/** Overlay nav-row index of a screen, derived from NAV_GROUPS. The literals 2/0/9
 * below are now derived: `tools` was nav row 9 when the nav had eleven rows and
 * moved to row 10 when `providers` and `gain` gained rows. */
const navRowOf = (id: string): number => {
	let row = 0;
	for (const g of NAV_GROUPS) {
		row += 1;
		const hit = g.items.findIndex(i => i.id === id);
		if (hit !== -1) return row + hit;
		row += g.items.length;
	}
	throw new Error(`no nav row for ${id}`);
};
import { __testing } from "../src/tui/panel";
import type { StatsPanel } from "../src/tui/panel";
import type { PanelData } from "../src/data/api";
import { RANGES } from "../src/data/ranges";
import type { Range } from "../src/data/ranges";
import { hitTest, rangeHit, rangeSpans, sidebarHit, type MouseFrame } from "../src/tui/mouse";

/**
 * Mouse support: clicks, wheel, hover. Hit areas are pure geometry over the
 * last rendered frame (fullscreen paints from row 0, so SGR rows map 1:1;
 * `OverlayPanel` costs one top-border row and two content columns).
 *
 * Keyboard stays the full path — every assertion here has a keyboard twin in
 * test/panel.test.ts, and nothing here removes one.
 */

ensureThemeSync();

// SGR reports are 1-based; the panel's geometry is 0-based.
const sgr = (button: number, col1: number, row1: number) => `\x1b[<${button};${col1};${row1}M`;
const CLICK = 0;
const MOTION = 35;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (panel: StatsPanel, width: number) => panel.render(width).map(line => line.replace(ANSI, ""));

// ---------------------------------------------------------------------------
// Fixtures (the shape test/panel.test.ts serves: cost on day boundaries)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const FIXTURE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const dayStart = (d: number) => Math.floor((FIXTURE_NOW - d * DAY) / DAY) * DAY;

function dataFor(): PanelData {
	return {
		overview: {
			overall: {
				totalRequests: 1200,
				successfulRequests: 1180,
				failedRequests: 20,
				errorRate: 20 / 1200,
				totalInputTokens: 1_000_000,
				totalOutputTokens: 250_000,
				totalCacheReadTokens: 40_000_000,
				totalCacheWriteTokens: 2_000_000,
				cacheRate: 0.93,
				cacheSavings: 0.18,
				totalCost: 42.03,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgDuration: 4200,
				avgTtft: 800,
				avgTokensPerSecond: 61,
				firstTimestamp: dayStart(20),
				lastTimestamp: dayStart(0),
			},
			byAgentType: [],
			timeSeries: [],
		},
		costs: {
			costSeries: [
				{
					timestamp: dayStart(20),
					model: "m",
					provider: "p",
					cost: 0.01,
					unpricedRequests: 0,
					costInput: 0.01,
					costOutput: 0,
					costCacheRead: 0,
					costCacheWrite: 0,
					requests: 9000,
					tokens: 9_000_000,
				},
			],
		},
		rollupStatus: { dirtyHours: 0, dirtySessions: 0 },
	} as unknown as PanelData;
}

async function settledPanel(state: { rows?: number } = {}): Promise<StatsPanel> {
	const panel = __testing.makePanel({ data: dataFor(), rows: state.rows ?? 40, now: () => FIXTURE_NOW });
	return __testing.settled(panel);
}

// ---------------------------------------------------------------------------
// sidebarHit: NAV_GROUPS order, headings inert
// ---------------------------------------------------------------------------

test("sidebar rows follow NAV_GROUPS: one heading row per group, then its screens", () => {
	const expected: (string | null)[] = [];
	for (const group of NAV_GROUPS) {
		expected.push(null);
		for (const item of group.items) expected.push(item.id);
	}
	// Derived, never restated: three headings plus one row per screen. The count
	// used to be hardcoded as 11 and went stale the moment `providers` and `gain`
	// became reachable — which is the bug this file's siblings now pin.
	expect(expected.length).toBe(NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0));
	for (let row = 0; row < expected.length; row++) {
		expect(sidebarHit(row), `row ${row}`).toBe(expected[row]);
	}
});

test("sidebarHit is null past the nav and for negative rows", () => {
	expect(sidebarHit(-1)).toBeNull();
	expect(sidebarHit(NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0))).toBeNull();
	expect(sidebarHit(40)).toBeNull();
});

test("sidebarHit walks an injected nav list, so a non-registry nav moves its own rows", () => {
	// The showcase's sections are not screen ids, so the walk must be a PARAMETER.
	const injected: readonly NavGroup[] = [
		{ heading: "Grammar", items: [{ id: "tiles", label: "Tiles", hotkey: "t", icon: "tokens" }] },
		{ heading: "Edges", items: [{ id: "awkward", label: "Awkward", hotkey: "a", icon: "warning" }] },
	];
	expect(sidebarHit(0, injected)).toBeNull();
	expect(sidebarHit(1, injected)).toBe("tiles");
	expect(sidebarHit(2, injected)).toBeNull();
	expect(sidebarHit(3, injected)).toBe("awkward");
	expect(sidebarHit(4, injected)).toBeNull();
	// The default is unchanged: the real nav still walks itself.
	expect(sidebarHit(1)).toBe("overview");
});

// ---------------------------------------------------------------------------
// rangeSpans / rangeHit: segments found by label, gaps inert
// ---------------------------------------------------------------------------

function syntheticTopbar(): string {
	const segments = RANGES.map(id => ` ${rangeMeta(id as Range).label} `).join(" ");
	return ["omp/stats", "Live", segments].join("  ");
}

test("every range segment resolves to its range, and only its own cells do", () => {
	const line = syntheticTopbar();
	const spans = rangeSpans(line);
	expect(spans.map(span => span.id)).toEqual([...RANGES]);
	for (const span of spans) {
		expect(span.end - span.start).toBeGreaterThan(0);
		for (let col = span.start; col < span.end; col++) {
			expect(rangeHit(line, col), `col ${col}`).toBe(span.id);
		}
	}
});

test("brand, chip and the gaps between segments hit nothing", () => {
	const line = syntheticTopbar();
	expect(rangeHit(line, 0)).toBeNull();
	expect(rangeHit(line, 4)).toBeNull();
	const first = rangeSpans(line)[0]!;
	expect(rangeHit(line, first.start - 1)).toBeNull();
	expect(rangeHit(line, -1)).toBeNull();
	expect(rangeHit(line, line.length + 10)).toBeNull();
});

// ---------------------------------------------------------------------------
// hitTest: frame-level routing with synthetic coordinates
// ---------------------------------------------------------------------------

function syntheticFrame(over: Partial<MouseFrame> = {}): MouseFrame {
	return {
		topbarRows: 1,
		stripRows: 1,
		sidebarWidth: 0,
		sidebarRows: 0,
		topbar: syntheticTopbar(),
		tabAt: () => undefined,
		...over,
	};
}

test("the top border row and negative coordinates hit nothing", () => {
	const frame = syntheticFrame();
	expect(hitTest(frame, 0, 5)).toEqual({ type: "none" });
	expect(hitTest(frame, -1, 5)).toEqual({ type: "none" });
	expect(hitTest(frame, 1, 0)).toEqual({ type: "none" });
	expect(hitTest(frame, 1, 1)).toEqual({ type: "none" });
});

test("a progress row under the topbar is not the topbar", () => {
	const frame = syntheticFrame({ topbarRows: 2, stripRows: 0 });
	const span = rangeSpans(frame.topbar)[0]!;
	// Overlay row 1 is the topbar: its segment still routes.
	expect(hitTest(frame, 1, span.start + 2)).toEqual({ type: "range", id: span.id });
	// Overlay row 2 is the progress line: the same columns route nowhere.
	expect(hitTest(frame, 2, span.start + 2)).toEqual({ type: "none" });
});

test("strip rows route through tabAt; misses and missing cols are inert", () => {
	const frame = syntheticFrame({ tabAt: (line, col) => (line === 0 && col >= 4 && col < 12 ? "models" : undefined) });
	expect(hitTest(frame, 2, 6)).toEqual({ type: "screen", id: "models", via: "strip" });
	expect(hitTest(frame, 2, 3)).toEqual({ type: "none" });
	expect(hitTest(syntheticFrame(), 2, 6)).toEqual({ type: "none" });
});

test("sidebar rows route only inside the sidebar width; body cols are inert", () => {
	const frame = syntheticFrame({ stripRows: 0, sidebarWidth: 24, sidebarRows: 11 });
	// Overlay row = 1 (border) + topbarRows + stripRows + nav row, so nav row
	// 1 (`overview`) sits at overlay row 3 and nav row 2 (`models`) at row 4.
	expect(hitTest(frame, 3, 5)).toEqual({ type: "screen", id: "overview", via: "sidebar" });
	expect(hitTest(frame, 4, 5)).toEqual({ type: "screen", id: "models", via: "sidebar" });
	// Same row, past the sidebar width, is body text: no target.
	expect(hitTest(frame, 4, 2 + 24 + 5)).toEqual({ type: "none" });
	// Nav row 0 is the group heading: inert even inside the width.
	expect(hitTest(frame, 2, 5)).toEqual({ type: "none" });
	// Past the eleven nav rows the padding column is inert too.
	expect(hitTest(frame, 1 + 1 + 11, 5)).toEqual({ type: "none" });
});

test("hitTest routes sidebar rows through an injected resolver", () => {
	// The frame geometry is one function; only the nav binding changes. This is
	// the seam that lets the showcase reuse `hitTest` instead of forking it.
	const frame = syntheticFrame({ stripRows: 0, sidebarWidth: 24, sidebarRows: 3 });
	const resolver = (navRow: number): string | null => (navRow === 2 ? "charts" : null);
	expect(hitTest(frame, 4, 5, resolver)).toEqual({ type: "screen", id: "charts", via: "sidebar" });
	// The default resolver still reads NAV_GROUPS.
	expect(hitTest(frame, 3, 5)).toEqual({ type: "screen", id: "overview", via: "sidebar" });
	// A resolver that names nothing leaves the column inert.
	expect(hitTest(frame, 4, 5, () => null)).toEqual({ type: "none" });
});

test("a hidden sidebar leaves no dead click zone", () => {
	const frame = syntheticFrame({ stripRows: 0, sidebarWidth: 0, sidebarRows: 0 });
	expect(hitTest(frame, 3, 2)).toEqual({ type: "none" });
	expect(hitTest(frame, 3, 30)).toEqual({ type: "none" });
});

test("body clicks route through feature-reported hit spans, in document rows", () => {
	const action = { type: "selectDay", day: "2026-01-10" } as const;
	const frame = syntheticFrame({
		stripRows: 0,
		bodyScroll: 3,
		bodyHits: [{ rowStart: 5, rowEnd: 7, colStart: 4, colEnd: 20, action }],
	});
	// Overlay row 5 = 1 border + 1 topbar + bodyRow 3, and docRow 3 + scroll 3
	// = 6, inside [5, 7). Column 6 is contentCol 4, inside [4, 20).
	expect(hitTest(frame, 5, 6)).toEqual({ type: "feature", action });
	// docRow 4 is above the span.
	expect(hitTest(frame, 3, 6)).toEqual({ type: "none" });
	// docRow 7 is past the span's half-open end.
	expect(hitTest(frame, 6, 6)).toEqual({ type: "none" });
	// Past the span's columns is inert body text.
	expect(hitTest(frame, 5, 30)).toEqual({ type: "none" });
});

// ---------------------------------------------------------------------------
// Panel integration: clicks switch screens and ranges
// ---------------------------------------------------------------------------

test("clicking a sidebar row switches screens; headings do nothing", async () => {
	const panel = await settledPanel();
	const width = 100;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.sidebarRows).toBe(NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0));
	const overlayRow = (navRow: number) => 1 + frame.topbarRows + frame.stripRows + navRow + 1;
	// `models`, wherever the nav puts it; content col 0 is overlay col 2.
	panel.handleInput(sgr(CLICK, 3, overlayRow(navRowOf("models"))));
	expect(__testing.debugScreenId(panel)).toBe("models");
	// Nav row 0 is the `Usage` heading: the screen does not move.
	panel.handleInput(sgr(CLICK, 3, overlayRow(0)));
	expect(__testing.debugScreenId(panel)).toBe("models");
	// `tools` in the third group: groups all map.
	panel.handleInput(sgr(CLICK, 3, overlayRow(navRowOf("tools"))));
	expect(__testing.debugScreenId(panel)).toBe("tools");
});

test("clicking a tab-strip tab switches screens", async () => {
	const panel = await settledPanel();
	const width = 60;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.stripRows).toBeGreaterThan(0);
	expect(frame.sidebarRows).toBe(0);
	const stripStart = 1 + frame.topbarRows;
	// Scan the TabBar's own zones for the `models` tab: the strip collapses to
	// one-cell shorts at this width, so full labels are not on screen.
	let hit: { row: number; col: number } | null = null;
	for (let line = 0; line < frame.stripRows && hit === null; line++) {
		for (let col = 0; col < 60 && hit === null; col++) {
			if (frame.tabAt(line, col) === "models") hit = { row: stripStart + line, col: col + 2 };
		}
	}
	expect(hit).not.toBeNull();
	panel.handleInput(sgr(CLICK, hit!.col + 1, hit!.row + 1));
	expect(__testing.debugScreenId(panel)).toBe("models");
});

test("clicking a topbar range segment changes the range; clicking body does nothing", async () => {
	const panel = await settledPanel();
	const width = 100;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	const col = frame.topbar.indexOf(` ${rangeMeta("7d").label} `);
	expect(col).not.toBe(-1);
	panel.handleInput(sgr(CLICK, col + 2 + 1, 1 + 1));
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).toBe("7d");
	const before = __testing.debugScreenId(panel);
	const overlayRow = 1 + frame.topbarRows + frame.stripRows + 12 + 1;
	panel.handleInput(sgr(CLICK, 60, overlayRow));
	expect(__testing.debugScreenId(panel)).toBe(before);
	expect(__testing.debugRange(panel)).toBe("7d");
});

/**
 * Just the nav column's cells, for every nav row of the last frame.
 *
 * The body cells beside them change on every scroll — that is the whole point
 * of the test — so comparing whole body rows would prove nothing. The geometry
 * is not guessable either: the body starts below the topbar and the nav strip,
 * and the column is `sidebarWidth + 3` cells, the extra three being the
 * `side + " " + gutter + " "` that separates it from the body.
 */
function navCells(panel: StatsPanel, width: number, frame: MouseFrame): readonly string[] {
	const start = frame.topbarRows + frame.stripRows;
	return panel
		.render(width)
		.slice(start, start + frame.sidebarRows)
		.map(row => row.replace(ANSI, "").slice(0, frame.sidebarWidth + 3));
}

test("range hit areas survive the topbar's move to the right edge, at every width", async () => {

	// The chrome pass moved the action cluster from the left of the topbar to
	// the right (the web's `.topbar-spacer { flex: 1 }`, styles.css:453-455), so
	// every range segment changed column. `rangeSpans` finds segments by
	// substring on the stripped row, which is position-independent by
	// construction — this pins that, at all four widths the brief names, and
	// through a real click rather than by inspecting the geometry.
	for (const width of [40, 60, 100, 150]) {
		const panel = await settledPanel();
		plain(panel, width);
		const frame = __testing.debugFrame(panel)!;
		// Whatever segments the topbar actually shows at this width — the
		// control collapses to its active member below the six-segment minimum,
		// so asking for `7d` at width 40 would test the wrong thing. Driven off
		// the real hit-test geometry, not a hand-computed column.
		const spans = rangeSpans(frame.topbar);
		expect(spans.length, `w=${width}`).toBeGreaterThan(0);
		for (const span of spans) {
			panel.handleInput(sgr(CLICK, span.start + 2 + 1, 1 + 1));
			await __testing.settled(panel);
			expect(__testing.debugRange(panel), `w=${width} ${span.id}`).toBe(span.id);
		}
	}
});

test("the brand and the spacer are not clickable: only the segments own the topbar row", async () => {
	// The wordmark and the painted spacer between it and the action cluster are
	// chrome, not targets. A click there must not select a screen or a range.
	//
	// The inert columns are DERIVED from the frame rather than hardcoded: the
	// spacer is bounded by the cluster's own width (chrome.ts's cap), so at
	// width 150 it ends around column 47 and a fixed list of columns would
	// silently start clicking the range control the moment the cap bound — which
	// is exactly what happened when this test was written against an uncapped
	// row.
	const panel = await settledPanel();
	const width = 150;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	const spans = rangeSpans(frame.topbar);
	const firstControl = Math.min(...spans.map(span => span.start));
	expect(firstControl, "the test needs at least one segment to bound the inert region").toBeGreaterThan(0);
	const before = __testing.debugRange(panel);
	for (let col = 0; col < firstControl; col++) {
		panel.handleInput(sgr(CLICK, col + 2, 1 + 1));
	}
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).toBe(before);
	expect(__testing.debugScreenId(panel)).toBe("overview");
});

test("the wheel scrolls the body when it is over the NAV column, and the nav does not move", async () => {
	// The nav is chrome that happens to sit over the body region, so a wheel
	// report inside its column is a BODY scroll — never a nav scroll, and never
	// a nav shift. `/settings` and `/usage` both scroll the sheet from anywhere
	// (usage-dashboard.ts:1369-1373), and so does the panel: `#routeMouse` takes
	// the wheel before it hit-tests anything.
	const panel = await settledPanel({ rows: 24 });
	const width = 100;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.sidebarWidth, "the nav column must exist for this test to mean anything").toBeGreaterThan(0);
	const navColumn = Math.max(1, Math.floor(frame.sidebarWidth / 2));
	const navRow = 2 + 1 + frame.topbarRows + frame.stripRows;
	const bodyStart = frame.topbarRows + frame.stripRows;

	const atRest = navCells(panel, width, frame);
	panel.handleInput(sgr(WHEEL_DOWN, navColumn, navRow));
	expect(__testing.debugScroll(panel)).toBeGreaterThan(0);
	expect(navCells(panel, width, frame)).toEqual(atRest);
	// The screen did not change either: a wheel over the nav is not a selection.
	expect(__testing.debugScreenId(panel)).toBe("overview");
});

test("hovering the nav is unaffected by scroll: the same cell is the same row", async () => {
	// Hover paints the frame, so a shifted nav would put the band on a
	// different screen's row. Same coordinate, before and after scrolling.
	const panel = await settledPanel({ rows: 24 });
	const width = 100;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.sidebarWidth, "the nav column must exist for this test to mean anything").toBeGreaterThan(0);
	const col = Math.max(1, Math.floor(frame.sidebarWidth / 2));
	const overlayRow = 1 + frame.topbarRows + frame.stripRows + 2 + 1;
	panel.handleInput(sgr(MOTION, col, overlayRow));
	expect(__testing.debugHoverSidebar(panel)).toBe("models");
	for (let i = 0; i < 4; i++) panel.handleInput(sgr(WHEEL_DOWN, col, overlayRow));
	expect(__testing.debugScroll(panel)).toBeGreaterThan(0);
	panel.handleInput(sgr(MOTION, col, overlayRow));
	expect(__testing.debugHoverSidebar(panel)).toBe("models");
});

// ---------------------------------------------------------------------------
// Wheel and hover through the real input path
// ---------------------------------------------------------------------------

test("the wheel scrolls the body through handleInput", async () => {
	const panel = await settledPanel({ rows: 10 });
	plain(panel, 100);
	expect(__testing.debugMaxScroll(panel)).toBeGreaterThan(0);
	expect(__testing.debugScroll(panel)).toBe(0);
	panel.handleInput(sgr(WHEEL_DOWN, 50, 8));
	expect(__testing.debugScroll(panel)).toBe(2);
	panel.handleInput(sgr(WHEEL_UP, 50, 8));
	expect(__testing.debugScroll(panel)).toBe(0);
});

test("hover over a strip tab arms the host hover style; leaving clears it", async () => {
	const panel = await settledPanel();
	const width = 60;
	plain(panel, width);
	const frame = __testing.debugFrame(panel)!;
	const stripStart = 1 + frame.topbarRows;
	let hit: { row: number; col: number } | null = null;
	for (let line = 0; line < frame.stripRows && hit === null; line++) {
		for (let col = 0; col < 60 && hit === null; col++) {
			if (frame.tabAt(line, col) === "models") hit = { row: stripStart + line, col: col + 2 };
		}
	}
	expect(hit).not.toBeNull();
	const before = panel.render(width)[stripStart]!;
	panel.handleInput(sgr(MOTION, hit!.col + 1, hit!.row + 1));
	expect(__testing.debugHoverTab(panel)).toBe("models");
	const hovered = panel.render(width)[stripStart]!;
	// The paint is the host's own `hoverTab` token (selectedBg + text), never
	// an invented style — so the row must differ by ESCAPES, not by cells.
	expect(hovered).not.toBe(before);
	expect(hovered.replace(ANSI, "")).toBe(before.replace(ANSI, ""));
	// The pointer over the body clears the tab hover and restores the row.
	panel.handleInput(sgr(MOTION, 40, stripStart + frame.stripRows + 3 + 1));
	expect(__testing.debugHoverTab(panel)).toBeNull();
	expect(panel.render(width)[stripStart]).toBe(before);
});

test("hover over a sidebar row paints the 4th-arg hover band; leaving clears it", async () => {
	const panel = await settledPanel();
	const width = 100;
	const lines = panel.render(width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.sidebarRows).toBe(NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0));
	const bodyStart = 1 + frame.topbarRows + frame.stripRows;
	// Nav row 2 is `models` (overview is active): motion over its cells arms
	// the sidebar hover, and the painted frame must carry the band while the
	// active row keeps its own style.
	panel.handleInput(sgr(MOTION, 5, bodyStart + 2 + 1));
	expect(__testing.debugHoverSidebar(panel)).toBe("models");
	const hovered = panel.render(width).map(line => line.replace(ANSI, ""));
	expect(hovered[bodyStart + 2]).toContain("Models");
	// The pointer over the heading row clears the hover and restores the row.
	panel.handleInput(sgr(MOTION, 5, bodyStart + 0 + 1));
	expect(__testing.debugHoverSidebar(panel)).toBeNull();
	expect(panel.render(width)).toEqual(lines);
});

test("clicks never leak to the keyboard map and the keys still work", async () => {
	const panel = await settledPanel();
	plain(panel, 100);
	// A release report and a click on empty chrome change nothing.
	panel.handleInput("\x1b[<0;50;20m");
	panel.handleInput(sgr(CLICK, 90, 39));
	expect(__testing.debugScreenId(panel)).toBe("overview");
	// Keyboard stays the full path.
	panel.handleInput("r");
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).not.toBe("24h");
});
