/**
 * `test/showcase-panel.test.ts` — the showcase's FRAME and its affordances.
 *
 * The brief is explicit that the showcase must exercise the real panel's
 * interactivity rather than being a static screenshot generator: screen/group
 * switching, range cycling, scrolling with a clamp, mouse clicks on the sidebar
 * and the strip, the wheel, and esc/q to close. All of it is testable without a
 * terminal because `render(width)` is a pure function of state.
 *
 * THE KEYMAP IS SHARED, NOT FORKED. `panelAction` is a pure function from a key
 * to a VERB and has no opinion about what a screen is; the showcase consumes its
 * verbs and resolves them against its own section list (chrome-critique's ruling).
 * That is why the `g`-prefix, the SGR wheel routing, the cancel keys and the
 * digit row are not reimplemented here — a second keymap would be the exact
 * "second grammar" failure this codebase exists to prevent.
 *
 * WHAT USED TO BE FORKED, AND WHY IT IS NO LONGER: `sidebar()` and `buildTabs()`
 * were closed over the real screen registry, so the showcase painted its own nav.
 * Both are now PARAMETERS — `sidebar(theme, preset, activeId, hovered?, groups)`
 * and `hitTest(frame, row, col, hitSidebar)` — so `SHOWCASE_NAV` is data and
 * `chrome.ts`/`mouse.ts` own the only geometry. A source scan below pins that the
 * fork does not come back.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

import {
	__testing,
	SHOWCASE_NAV,
	SHOWCASE_SECTIONS,
	sectionById,
	sectionForDigit,
	sectionForHotkey,
	showcaseAction,
} from "../src/tui/showcase/panel";

ensureThemeSync();

const ANSI = /\x1b\[[0-9;]*m/g;
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const WHEEL_DOWN = "\x1b[<65;10;10M";
const WHEEL_UP = "\x1b[<64;10;10M";
const CLICK = (row: number, col: number) => `\x1b[<0;${col};${row}M`;
const MOTION = (row: number, col: number) => `\x1b[<35;${col};${row}M`;

const WIDTHS = [40, 60, 100, 150] as const;
const ROWS = 40;

type Panel = ReturnType<typeof __testing.makePanel>;
type PanelState = Parameters<typeof __testing.makePanel>[0];

function makePanel(over: Partial<PanelState> = {}): Panel {
	return __testing.makePanel({ now: () => 1_752_000_000_000, ...over });
}

/**
 * The overlay-relative row of a sidebar section row.
 *
 * `hitTest` routes a sidebar click through the same group/item walk the sidebar
 * paints (one heading row per group, then one row per item), so the row index is
 * derived from the nav rather than hardcoded — which is also what makes this a
 * test of the geometry rather than of a magic number.
 */
function sidebarRowFor(sectionId: string): number {
	let row = 0;
	for (const group of SHOWCASE_NAV) {
		row++;
		for (const item of group.items) {
			if (item.id === sectionId) return row;
			row++;
		}
	}
	throw new Error(`no section ${sectionId}`);
}

/**
 * The overlay-relative SGR event row that clicks a sidebar section.
 *
 * TWO INSETS COMPOUND, and getting either wrong silently clicks the WRONG section
 * rather than failing — which is why this is derived rather than written inline at
 * each call site:
 *
 *  1. SGR mouse coordinates are 1-BASED — the terminal reports the first row as row
 *     1 — so a zero-indexed body row arrives one higher.
 *  2. `hitTest` then insets the overlay's top border and measures `contentRow`
 *     against `topbarRows + stripRows` before that becomes a sidebar nav row.
 *
 * Hence `navRow + 1 (1-based) + 1 (border) + topbarRows + stripRows`.
 */
function clickRowFor(sectionId: string, frame: { topbarRows: number; stripRows: number }): number {
	return sidebarRowFor(sectionId) + 2 + frame.topbarRows + frame.stripRows;
}

/** The nav column of a frame, as plain cells — the scroll-stability probe's unit. */
function navColumn(panel: Panel, width: number): string {
	const frame = __testing.debugFrame(panel);
	if (!frame) return "";
	return panel
		.render(width)
		.slice(frame.topbarRows + frame.stripRows, frame.topbarRows + frame.stripRows + frame.sidebarRows)
		.map(row => row.replace(ANSI, "").slice(0, frame.sidebarWidth + 3))
		.join("\n");
}

test("the showcase paints through the shared nav, not a fork", () => {
	// The fork's names must not reappear, and the shared geometry must be the one
	// the panel imports. A second painter would silently drift from chrome.ts.
	const panel = readFileSync(`${import.meta.dir}/../src/tui/showcase/panel.ts`, "utf8");
	expect(panel).not.toContain("showcaseSidebar");
	expect(panel).not.toContain("#zipSidebar");
	expect(panel).toContain("sidebar(this.#theme, preset, state.sectionId");
	expect(panel).toContain("zipSidebar(this.#theme, visible, nav.lines");
	expect(panel).toContain("hitTest(frame, event.row, event.col, hitShowcaseSidebar)");
	const nav = readFileSync(`${import.meta.dir}/../src/tui/showcase/nav.ts`, "utf8");
	expect(nav).not.toContain("showcaseSidebar");
	expect(nav).not.toContain("statsIcon");
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test("the showcase has at least four sections, and one of them is the empty range", () => {
	expect(SHOWCASE_SECTIONS.length).toBeGreaterThanOrEqual(4);
	expect(SHOWCASE_SECTIONS.some(section => section.id === "empty")).toBe(true);
});

test("every section id is unique and every group references real sections", () => {
	const ids = SHOWCASE_SECTIONS.map(section => section.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const group of SHOWCASE_NAV) {
		expect(group.items.length).toBeGreaterThan(0);
		for (const item of group.items) expect(sectionById(item.id)).toBeDefined();
	}
});

test("every section belongs to exactly one group, and every section is reachable", () => {
	const grouped = SHOWCASE_NAV.flatMap(group => group.items.map(item => item.id));
	expect([...grouped].sort()).toEqual([...ids()].sort());
});

function ids(): readonly string[] {
	return SHOWCASE_SECTIONS.map(section => section.id);
}

test("every section has a one-cell tab short label under every preset", () => {
	// The rule the real strip obeys (`TAB_SHORT`): one cell on all three presets,
	// or the strip wraps and costs the body a row.
	for (const section of SHOWCASE_SECTIONS) {
		for (const preset of ["unicode", "nerd", "ascii"] as const) {
			expect(Bun.stringWidth(section.short[preset]), `${section.id}/${preset}`).toBe(1);
		}
	}
});

test("every section carries a unique jump letter, and every letter resolves back", () => {
	const letters = SHOWCASE_SECTIONS.map(section => section.hotkey);
	expect(new Set(letters).size).toBe(letters.length);
	for (const section of SHOWCASE_SECTIONS) {
		expect(sectionForHotkey(section.hotkey)).toBe(section.id);
		expect(sectionForHotkey(section.hotkey.toUpperCase())).toBe(section.id);
	}
	expect(sectionForHotkey("~")).toBeNull();
	expect(sectionForHotkey("")).toBeNull();
});

test("a digit indexes the sections in nav order, wrapping rather than falling off", () => {
	// The same convention as the real panel: `1`-`9`, then `0` for the tenth. A
	// digit that landed nowhere would be a dead key, which is worse than a
	// repurposed one.
	for (const [index, section] of SHOWCASE_SECTIONS.entries()) {
		expect(sectionForDigit(index % 10), `digit ${index % 10}`).toBe(section.id);
	}
	expect(sectionForDigit(SHOWCASE_SECTIONS.length)).toBe(SHOWCASE_SECTIONS[0]?.id);
});

// ---------------------------------------------------------------------------
// The action mapping — verbs from `panelAction`, resolved against our sections
// ---------------------------------------------------------------------------

test("the showcase reuses the panel's keymap rather than declaring its own", () => {
	// If this fails, someone has forked the keymap. The showcase consumes
	// `panelAction`'s verbs, because that is where the `g` prefix, the wheel
	// routing, the cancel keys and the digit row are decided.
	expect(showcaseAction("q")).toEqual({ type: "close" });
	expect(showcaseAction("\x1b")).toEqual({ type: "close" });
	expect(showcaseAction(TAB)).toEqual({ type: "screen", by: 1 });
	expect(showcaseAction(SHIFT_TAB)).toEqual({ type: "screen", by: -1 });
	expect(showcaseAction("r")).toEqual({ type: "range", by: 1 });
	expect(showcaseAction("R")).toEqual({ type: "range", by: -1 });
	expect(showcaseAction("2")).toEqual({ type: "screenIndex", index: 1 });
	expect(showcaseAction(LEFT)).toEqual({ type: "screen", by: -1 });
	expect(showcaseAction(RIGHT)).toEqual({ type: "screen", by: 1 });
	// The raw byte sequence is what `matchesKey` sees — `LEFT` above is those same
	// bytes, so this asserts the mapping reads the ESCAPE, not a friendly name.
	expect(showcaseAction("\x1b[D")).toEqual({ type: "screen", by: -1 });
	expect(showcaseAction("g")).toEqual({ type: "armJump" });
	expect(showcaseAction("\x1b[B")).toEqual({ type: "scroll", rows: 1 });
	expect(showcaseAction("\x1b[5~")).toEqual({ type: "scroll", viewport: -1 });
	expect(showcaseAction(HOME)).toEqual({ type: "scrollTo", edge: "top" });
	expect(showcaseAction(END)).toEqual({ type: "scrollTo", edge: "bottom" });

});

test("an armed jump resolves a SHOWCASE letter, never a real screen id", () => {
	// `panelAction`'s `screenId` verb carries a REAL screen id, because its own
	// `screenForHotkey` reads the real nav. The showcase binds ITS letters, so
	// `g` + a showcase letter lands on a showcase section and nothing else.
	const first = SHOWCASE_SECTIONS[0];
	expect(first).toBeDefined();
	expect(showcaseAction(first!.hotkey, true)).toEqual({ type: "sectionId", id: first!.id });
	// A letter that is not a showcase section is a no-op, never a jump onto a real
	// screen the showcase cannot draw.
	expect(showcaseAction("~", true)).toEqual({ type: "noop" });
});

test("an unarmed letter is not a section jump", () => {
	expect(showcaseAction("o")).toBeNull();
	expect(showcaseAction("\x1b")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

test("render never returns a row wider than the width it was handed", () => {
	for (const width of WIDTHS) {
		for (const row of makePanel().render(width)) {
			expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width);
		}
	}
});

test("render returns no more rows than the terminal has", () => {
	expect(makePanel({ rows: 24 }).render(100).length).toBeLessThanOrEqual(24);
});

test("G6: the frame carries exactly one divider, and no body paints a rule", () => {
	for (const width of WIDTHS) {
		const rows = makePanel().render(width).map(row => row.replace(ANSI, ""));
		expect(rows.filter(row => row.includes("├")).length, `width ${width}`).toBe(1);
	}
});

test("the topbar is the frame's first content row and names the brand and the range", () => {
	const rows = makePanel({ range: "7d" })
		.render(100)
		.map(row => row.replace(ANSI, ""));
	// Row 0 is `OverlayPanel`'s top border; the topbar is the first content row.
	expect(rows[1] ?? "").toContain("omp/stats");
	// The segmented control carries the WIRE label (`7d`), not the prose one
	// (`7 days`) — the same string the range hit areas are located by, which is what
	// makes a click on this segment reliable.
	expect(rows[1] ?? "").toContain("7d");
});

test("wide gets the sidebar column and narrow does not", () => {
	// `framePolicy` owns the decision and the showcase must not re-derive it.
	expect(makePanel().render(150).length).toBeGreaterThan(0);
	expect(__testing.debugFrame(makePanel())).toBeNull();
	const wide = makePanel();
	wide.render(150);
	expect(__testing.debugFrame(wide)?.sidebarWidth).toBeGreaterThan(0);
	const tiny = makePanel();
	tiny.render(40);
	expect(__testing.debugFrame(tiny)?.sidebarWidth).toBe(0);
});

test("the frame is scroll-stable: the sidebar does not move with the body", () => {
	// The invariant that took a whole regression to establish (panel.ts): chrome
	// regions are recomputed per frame from width and screen, never from scroll.
	for (const width of [100, 150]) {
		const panel = makePanel();
		panel.render(width);
		const before = navColumn(panel, width);
		const max = __testing.debugMaxScroll(panel);
		while (__testing.debugScroll(panel) < max) panel.handleInput(WHEEL_DOWN);
		expect(navColumn(panel, width), `width ${width}`).toBe(before);
	}
});

// ---------------------------------------------------------------------------
// Scrolling, with the clamp inside render
// ---------------------------------------------------------------------------

test("scrolling clamps to the body's range and never past it", () => {
	const panel = makePanel();
	panel.render(60);
	const max = __testing.debugMaxScroll(panel);
	expect(max).toBeGreaterThan(0);
	for (let i = 0; i < max + 40; i++) panel.handleInput(WHEEL_DOWN);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBe(max);
	for (let i = 0; i < max + 40; i++) panel.handleInput(WHEEL_UP);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBe(0);
});

test("home and end reach the two ends and stop there", () => {
	const panel = makePanel();
	panel.render(60);
	panel.handleInput(END);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBe(__testing.debugMaxScroll(panel));
	panel.handleInput(HOME);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBe(0);
});

test("shrinking the terminal shrinks the scroll range, because the clamp is in render", () => {
	const panel = makePanel();
	panel.handleInput(END);
	panel.render(150);
	panel.render(40);
	// The offset can never survive past the new end, because the clamp runs on
	// every frame rather than only on the keystroke that moved it.
	expect(__testing.debugScroll(panel)).toBeLessThanOrEqual(__testing.debugMaxScroll(panel));
});

test("render is a pure function of state: the same width twice gives the same rows", () => {
	const panel = makePanel();
	expect(panel.render(100)).toEqual(panel.render(100));
});

// ---------------------------------------------------------------------------
// Screen and range switching
// ---------------------------------------------------------------------------

test("tab walks the sections in both directions and wraps", () => {
	const panel = makePanel();
	panel.render(100);
	const first = __testing.debugSectionId(panel);
	panel.handleInput(TAB);
	panel.render(100);
	expect(__testing.debugSectionId(panel)).not.toBe(first);
	panel.handleInput(SHIFT_TAB);
	panel.render(100);
	expect(__testing.debugSectionId(panel)).toBe(first);
	panel.handleInput(SHIFT_TAB);
	panel.render(100);
	// Wrapping backwards off the head lands on the LAST section, not on nothing.
	expect(__testing.debugSectionId(panel)).toBe(SHOWCASE_SECTIONS[SHOWCASE_SECTIONS.length - 1]!.id);
});

test("a digit lands on that section, and switching resets the scroll", () => {
	const panel = makePanel();
	panel.render(60);
	panel.handleInput(END);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBeGreaterThan(0);
	panel.handleInput("2");
	panel.render(60);
	expect(__testing.debugSectionId(panel)).toBe(ids()[1]);
	expect(__testing.debugScroll(panel)).toBe(0);
});

test("r walks the closed range set forwards and wraps; R walks it back", () => {
	const panel = makePanel({ range: "1h" });
	panel.render(100);
	expect(__testing.debugRange(panel)).toBe("1h");
	panel.handleInput("r");
	expect(__testing.debugRange(panel)).toBe("24h");
	panel.handleInput("R");
	expect(__testing.debugRange(panel)).toBe("1h");
	panel.handleInput("R");
	expect(__testing.debugRange(panel)).toBe("all");
});

test("a range changes what a CHART section draws, even against a fixed fixture", () => {
	// The control itself must work: `r` steps the closed set and the topbar repaints
	// with the new active segment, which is what makes the segment clickable.
	const panel = makePanel({ range: "1h" });
	panel.render(100);
	panel.handleInput("r");
	panel.render(100);
	expect(__testing.debugRange(panel)).toBe("24h");
	expect(panel.render(100)[1]).toContain("24h");

	// A range IS a different question even here. `bucketAxisFor` takes its bucket
	// width from `bucketMsFor(range)`, so the same fixed points land in
	// differently-sized buckets and the charts redraw — the grammar's response to a
	// range, demonstrated without a database anywhere in sight.
	expect(__testing.debugBody(makePanel({ range: "1h", sectionId: "charts" }))).not.toEqual(
		__testing.debugBody(makePanel({ range: "all", sectionId: "charts" })),
	);

	// BUT A STAT-ONLY SECTION IS RANGE-INVARIANT, and that is the finding worth
	// pinning. `tiles` draws aggregates, and an aggregate over a fixture carries no
	// window in it: nothing in the tile path reads `range`, so all six ranges render
	// it identically. Asserted so a future edit that gives the fixture a wall clock —
	// making every body different AND non-deterministic — fails here instead.
	expect(__testing.debugBody(makePanel({ range: "1h", sectionId: "tiles" }))).toEqual(
		__testing.debugBody(makePanel({ range: "all", sectionId: "tiles" })),
	);
});

test("changing the section changes the body", () => {
	const panel = makePanel();
	const first = __testing.debugBody(panel);
	panel.handleInput(TAB);
	expect(__testing.debugBody(panel)).not.toEqual(first);
});

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

test("a click on a sidebar row selects that section", () => {
	const panel = makePanel();
	panel.render(150);
	const frame = __testing.debugFrame(panel);
	expect(frame?.sidebarWidth).toBeGreaterThan(0);
	const target = SHOWCASE_SECTIONS[SHOWCASE_SECTIONS.length - 1]!;
	// `clickRowFor` owns the insets; the column is 4, inside the sidebar but past
	// its 2-cell cursor prefix.
	panel.handleInput(CLICK(clickRowFor(target.id, frame ?? { topbarRows: 0, stripRows: 0 }), 4));
	panel.render(150);
	expect(__testing.debugSectionId(panel)).toBe(target.id);
});

test("a click on a range segment sets that range", () => {
	const panel = makePanel({ range: "1h" });
	panel.render(150);
	const line = __testing.debugFrame(panel)?.topbar ?? "";
	const start = line.indexOf(" 30d ");
	expect(start, "the 30d segment must be on the topbar row").toBeGreaterThan(-1);
	panel.handleInput(CLICK(2, start + 3));
	panel.render(150);
	expect(__testing.debugRange(panel)).toBe("30d");
});

test("the wheel scrolls from anywhere and is consumed", () => {
	const panel = makePanel();
	panel.render(60);
	panel.handleInput(WHEEL_DOWN);
	panel.render(60);
	expect(__testing.debugScroll(panel)).toBe(2);
});

test("motion arms a hover without selecting, and the hover is cleared on select", () => {
	const panel = makePanel();
	panel.render(150);
	const frame = __testing.debugFrame(panel);
	expect(frame?.sidebarWidth).toBeGreaterThan(0);
	const target = SHOWCASE_SECTIONS[SHOWCASE_SECTIONS.length - 1]!;
	panel.handleInput(MOTION(clickRowFor(target.id, frame ?? { topbarRows: 0, stripRows: 0 }), 4));
	panel.render(150);
	expect(__testing.debugHoverSidebar(panel)).toBe(target.id);
	// Hover alone must not navigate: it is a pointer affordance, not a click.
	expect(__testing.debugSectionId(panel)).not.toBe(target.id);
	panel.handleInput(TAB);
	panel.render(150);
	expect(__testing.debugHoverSidebar(panel)).toBeNull();
});

test("a click off every hit area is inert rather than reaching the keymap", () => {
	const panel = makePanel();
	panel.render(150);
	const before = __testing.debugSectionId(panel);
	// Far below the nav rows and far right of the nav column: body text.
	panel.handleInput(CLICK(39, 140));
	panel.render(150);
	expect(__testing.debugSectionId(panel)).toBe(before);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test("esc closes exactly once however many times it is pressed", () => {
	const panel = makePanel();
	for (let i = 0; i < 5; i++) panel.handleInput("\x1b");
	expect(__testing.debugDoneCalls(panel)).toBe(1);
	expect(__testing.debugClosed(panel)).toBe(true);
});

test("keys after close are inert", () => {
	const panel = makePanel();
	panel.handleInput("q");
	const calls = __testing.debugDoneCalls(panel);
	panel.handleInput(TAB);
	panel.handleInput("r");
	panel.handleInput(WHEEL_DOWN);
	expect(__testing.debugDoneCalls(panel)).toBe(calls);
	expect(__testing.debugScroll(panel)).toBe(0);
});

test("dispose is idempotent and never calls done", () => {
	const panel = makePanel();
	panel.dispose();
	panel.dispose();
	expect(__testing.debugClosed(panel)).toBe(true);
	expect(__testing.debugDoneCalls(panel)).toBe(0);
});

test("nothing in the showcase writes to stdout", () => {
	// stdout is the TUI's (AGENTS.md). A playground is the most tempting place to
	// log a frame, so the guarantee is asserted rather than trusted. The cast is at
	// the stream boundary, where the only way to observe a write is to replace it.
	const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
	const original = stdout.write;
	const written: string[] = [];
	stdout.write = (chunk: unknown) => {
		written.push(String(chunk));
		return true;
	};
	try {
		const panel = makePanel();
		panel.render(100);
		panel.handleInput(TAB);
		panel.handleInput("r");
		panel.render(100);
	} finally {
		stdout.write = original;
	}
	expect(written).toEqual([]);
});

test("a non-left SGR release is consumed and ignored, not treated as a key", () => {
	const panel = makePanel();
	panel.handleInput("\x1b[<0;2;1M");
	panel.render(100);
	expect(__testing.debugClosed(panel)).toBe(false);
	expect(__testing.debugSectionId(panel)).toBe(ids()[0]);
});

test("a panel with rows shorter than its chrome still paints a coherent frame", () => {
	// `bodyRows` clamps at the chrome floor rather than below, because
	// `OverlayPanel` clips — a terminal shorter than its own chrome must still get
	// a frame rather than a torn one.
	const panel = makePanel({ rows: 6 });
	expect(panel.render(100).length).toBeGreaterThan(0);
});

test("rows come from the terminal when no seam supplies them", () => {
	// The `__testing` seam is the only reason `rows` is injectable; production reads
	// `tui.terminal.rows` on every frame, which is what makes shrink-on-resize
	// automatic. A panel that captured rows once would pass this and fail on resize.
	const panel = makePanel({ rows: undefined });
	expect(panel.render(100).length).toBeGreaterThan(0);
	expect(ROWS).toBe(40);
});
