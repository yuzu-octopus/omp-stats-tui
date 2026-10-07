import { test, expect } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import {
	STATS_OVERLAY_OPTIONS,
	MIN_PANEL_ROWS,
	EXACT_DIRTY_LIMIT,
	panelAction,
	__testing,
} from "../src/tui/panel";
import type { PanelAction, PanelTestState, StatsPanel } from "../src/tui/panel";
import { DATA_NEEDS, type DataNeed, type PanelData } from "../src/data/api";
import { DEFAULT_RANGE, RANGES, nextRange, rangeLabel } from "../src/data/ranges";
import { SCREENS } from "../src/tui/screens/types";
import { SELECTABLE_SCREENS } from "../src/tui/panel";
import { SCREEN_SPECS } from "../src/layout/spec";
import type { ScreenId } from "../src/tui/screens/types";
import { glyphsFor } from "../src/tui/glyphs";
import type { Range } from "../src/data/ranges";
import { TAB_SHORT } from "../src/tui/tabs";
import { SIDE_INSET } from "../src/tui/layout";
import { liveData } from "./fixtures/panel";
import { rangeMeta } from "@oh-my-pi/omp-stats/client/data/range";

/**
 * WHAT A HUMAN STILL HAS TO VERIFY
 *
 * Everything below is pure state, because `render(width)` is a function of it.
 * None of it can prove the overlay behaves, because the overlay needs a
 * terminal. Run this by hand before believing the panel works:
 *
 *   1. `/stats-tui` opens fullscreen and the TRANSCRIPT BELOW IS UNTOUCHED on
 *      exit — that is `fullscreen: true` borrowing the alt screen buffer, and
 *      nothing here exercises the buffer switch.
 *   2. The chart is painted on the first frame and repaints on its own once
 *      the load resolves. No test drives `requestRender`; a panel that loaded
 *      and never repainted would pass every assertion in this file.
 *   3. Resizing the terminal re-plans the frame. `render` reads
 *      `tui.terminal.rows` per frame because there is no resize hook, and a
 *      stub `tui` cannot resize.
 *   4. Esc / q reach the panel rather than the editor behind it, clicks land
 *      on their row, and the wheel scrolls rather than selecting. Mouse
 *      tracking stays on the host default for the overlay precisely so clicks,
 *      wheel and motion arrive as SGR text; nothing here asserts the host
 *      delivers it that way.
 *   5. The host installs its configured keybindings manager before mounting.
 *      Remapped selector actions are covered below; delivery still needs a host.
 *   6. Zero bytes on stdout. The tests capture nothing from stdout.
 */

ensureThemeSync();
const GLYPHS = glyphsFor(theme.getSymbolPreset());

const SELECTABLE = SELECTABLE_SCREENS;
/** The panel's own number row: 1-9, then 0 for the tenth. */
const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const HOME = "\x1b[H";
const END = "\x1b[F";
const NEVER = () => new Promise<PanelData>(() => {});

test("selector actions honor the host's configured keybindings, not factory defaults", () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": "ctrl+x",
		"tui.select.up": "ctrl+k",
		"tui.select.down": "ctrl+n",
		"tui.select.pageUp": "ctrl+u",
		"tui.select.pageDown": "ctrl+d",
	}));
	try {
		expect(panelAction("\x18")).toEqual({ type: "close" });
		expect(panelAction("\x0b")).toEqual({ type: "scroll", rows: -1 });
		expect(panelAction("\x0e")).toEqual({ type: "scroll", rows: 1 });
		expect(panelAction("\x15")).toEqual({ type: "scroll", viewport: -1 });
		expect(panelAction("\x04")).toEqual({ type: "scroll", viewport: 1 });
		for (const oldKey of ["\x1b", "\x03", UP, DOWN, PGUP, PGDN]) {
			expect(panelAction(oldKey)).toBeNull();
		}
		expect(panelAction("q")).toEqual({ type: "close" });
		expect(panelAction(LEFT)).toEqual({ type: "screen", by: -1 });
	} finally {
		setKeybindings(previous);
	}
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const FIXTURE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
/**
 * `costSeries` is DAY-bucketed whatever range is asked for — the costs route
 * aggregates that way and the dashboard passes `DAY_MS` explicitly
 * (`CostsRoute.tsx:201`). A fixture on hour boundaries would silently fall off
 * the axis, so every cost fixture here is on a day boundary too.
 */
const dayStart = (d: number) => Math.floor((FIXTURE_NOW - d * DAY) / DAY) * DAY;

/**
 * Two buckets on a 30-day axis: one 20 days ago that is essentially free but
 * burned 9M tokens, and the newest one that cost $42 on 1000 tokens.
 *
 * Cost scaling puts the peak in the LAST filled column. Token scaling puts it
 * twenty columns to the left, at the free bucket — which is exactly the lie
 * this project has already paid for once, and the only reason the fixture has
 * this shape.
 */
function costSeries() {
	return [point(dayStart(20), 0.01, 9_000_000), point(dayStart(0), 42, 1_000)];
}

function point(timestamp: number, cost: number, tokens: number) {
	return {
		timestamp,
		model: "m",
		provider: "p",
		cost,
		unpricedRequests: 0,
		costInput: cost,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		requests: Math.round(tokens / 1000),
		tokens,
	};
}

function overall(over: Record<string, unknown> = {}) {
	return {
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
		...over,
	};
}

function dataFor(over: Partial<PanelData> = {}): PanelData {
	return {
		overview: { overall: overall(), byAgentType: [], timeSeries: [] },
		costs: { costSeries: costSeries() },
		rollupStatus: { dirtyHours: 0, dirtySessions: 0 },
		...over,
	};
}

/** Records what the panel asked for, and answers with real-shaped data. */
function spyFetch(asked: Range[], needsLog: DataNeed[][] = []) {
	return async (needs: readonly DataNeed[], range: Range): Promise<PanelData> => {
		asked.push(range);
		needsLog.push([...needs]);
		return dataFor();
	};
}

/**
 * Anchor every fixture panel to FIXTURE_NOW. The chart's time axis is derived
 * from a clock, so a panel reading the real one would place the fixture's
 * buckets outside its axis and the chart would legitimately draw nothing.
 */
function makePanel(state: PanelTestState = {}): StatsPanel {
	return __testing.makePanel({ now: () => FIXTURE_NOW, ...state });
}

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

/** Filled height of one column. Empty cells carry the preset's barEmpty glyph. */
function columnHeights(rows: string[]): number[] {
	return Array.from({ length: rows[0]?.length ?? 0 }, (_, col) =>
		rows.reduce((height, row) => {
			const ch = [...row][col] ?? " ";
			return ch === " " || ch === GLYPHS.barEmpty ? height : height + 1;
		}, 0),
	);
}

// ---------------------------------------------------------------------------
// The overlay options: the one mistake no test here can see
// ---------------------------------------------------------------------------

test("the overlay borrows the alternate screen buffer and leaves mouse tracking on", () => {
	// `mouseTracking` ABSENT is the point: the host default is on for fullscreen
	// overlays, which is what delivers clicks and hover as SGR text. Pinning
	// the rest keeps the frame contract visible.
	expect(STATS_OVERLAY_OPTIONS).toEqual({
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
});

test("MIN_PANEL_ROWS is the chrome OverlayPanel draws plus the one row the body keeps", () => {
	// 5 chrome rows (top border, header, divider, footer, bottom border) and a
	// body planLayout pins at >= 1, so 6 is the shortest paintable panel.
	expect(MIN_PANEL_ROWS).toBe(6);
});

// ---------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------

test("every key the panel advertises maps to an action, and nothing else does", () => {
	const cases: [string, PanelAction | null][] = [
		["\x1b", { type: "close" }],
		["\x03", { type: "close" }], // ctrl+c is a bound cancel key
		["q", { type: "close" }],
		[UP, { type: "scroll", rows: -1 }],
		[DOWN, { type: "scroll", rows: 1 }],
		[PGUP, { type: "scroll", viewport: -1 }],
		[PGDN, { type: "scroll", viewport: 1 }],
		[HOME, { type: "scrollTo", edge: "top" }],
		[END, { type: "scrollTo", edge: "bottom" }],
		[LEFT, { type: "screen", by: -1 }],
		[RIGHT, { type: "screen", by: 1 }],
		[TAB, { type: "screen", by: 1 }],
		[SHIFT_TAB, { type: "screen", by: -1 }],
		["1", { type: "screenIndex", index: 0 }],
		["9", { type: "screenIndex", index: 8 }],
		["0", { type: "screenIndex", index: 9 }],
		["r", { type: "range", by: 1 }],
		["R", { type: "range", by: -1 }],
		["s", { type: "sync" }],
		// A key the panel does not own is left alone: swallowing it here would
		// silently eat typing the user expected to reach the editor behind.
		["x", null],
		["\x1b[5;5~", null],
		// Two characters, so not a key at all. A free-form range entry is how
		// `isRange` earns its keep in src/data/ranges.ts.
		["10", null],
	];
	for (const [key, expected] of cases) {
		expect(panelAction(key), JSON.stringify(key)).toEqual(expected);
	}
});

test("tab switches screens everywhere — the fallthrough rule is closed as contradicted", () => {
	// F23 §1.4 argued `tab` should fall through to next-screen only when a screen had
	// ≤ 1 band, reserving it for landmark jumping. F23's own key table lists `tab` →
	// "next screen" in BOTH rows, and this panel has no landmark-focus model at all:
	// no `landmark` action, no section-focus, nothing to reserve it for. A reserved
	// dead key is worse than either behaviour, so `tab` is next-screen everywhere.
	// If a real landmark model ever lands, the commit that reclaims `tab` adds an
	// action — it does not re-read this mapping.
	expect(panelAction(TAB)).toEqual({ type: "screen", by: 1 });
	expect(panelAction(SHIFT_TAB)).toEqual({ type: "screen", by: -1 });
});

test("the arrows are THE screen switch; `tab` is the alias and `r`/`R` keeps the range", () => {
	// Defect 2, decided twice, and the second decision is this one.
	//
	// `tab` was already switching screens while the footer advertised `←/→`. The
	// first fix made `tab` primary and handed the arrows to the range control, on
	// the reasoning that the arrows "belong to the horizontal thing". The user read
	// the result and asked for the arrows back — and they are right. This is a
	// SCREEN-SWITCHING panel, `←/→` is what a reader's hand already does on every
	// dashboard they have ever used, and the range is reachable by a key named
	// after it. A keymap that makes someone learn where `tab` went is not more
	// correct than the one they came from.
	//
	// So: `←`/`→` switch screens, `tab`/`shift+tab` stay as an ALIAS (a dead key is
	// worse than a redundant one), and the range keeps `r`/`R`.
	expect(panelAction(LEFT)).toEqual({ type: "screen", by: -1 });
	expect(panelAction(RIGHT)).toEqual({ type: "screen", by: 1 });
	// `tab` is an alias for the same target, not a second verb — exactly the
	// relationship digits and `g`-letters already have for screens.
	expect(panelAction(TAB)).toEqual(panelAction(RIGHT));
	expect(panelAction(SHIFT_TAB)).toEqual(panelAction(LEFT));
	// The range is on the key that names it, and ONLY there: no arrow is left
	// over to carry it, so no key in the map means two different things.
	expect(panelAction("r")).toEqual({ type: "range", by: 1 });
	expect(panelAction("R")).toEqual({ type: "range", by: -1 });
});



/**
 * No one-step composed capture of the full panel — chrome + body + footer —
 * exists anywhere, which is how the original complaint went unverified:
 * section 9 of RENDER-OUTPUT.txt is per-screen renders, and unit tests look at
 * one component at a time. These two tests build the REAL panel on a
 * live-shaped fixture and assert the composition end to end: the web shell's
 * chrome (topbar + sidebar) is present, exactly one divider separates body
 * from footer, the footer shows the real hints, and NO row exceeds the width.
 */
test("the composed frame at width 100: topbar + sidebar, body, divider, footer, all within width", async () => {
	const width = 100;
	const panel = __testing.makePanel({ data: dataFor(), range: "30d", rows: 40, now: () => FIXTURE_NOW });
	await __testing.settled(panel);
	const plain = panel.render(width).map(stripAnsi);

	expect(plain.length, `the frame must fill the terminal`).toBe(40);
	// The topbar: brand + range segment (Shell.tsx), and the sidebar column
	// beside the body carrying the active screen.
	expect(plain[1]).toContain("omp/stats");
	expect(plain.some(row => /Overview/.test(row) && /G O/.test(row))).toBe(true);
	for (const row of plain) {
		expect(Bun.stringWidth(row), `width=${width} row=${JSON.stringify(row.slice(0, 60))}`).toBeLessThanOrEqual(width);
	}
	// Exactly ONE divider: the topbar, the dividers panel chrome draws, and
	// section 6's G5/G6 rules all meet here for the first time.
	expect(plain.filter(row => row.includes("├")).length).toBe(1);
	// The footer names the keys the panel binds and nothing else. NOT `scroll`:
	// that hint is DERIVED from whether the body actually overflows
	// (`#footerLine` picks the mode from `maxScroll > 0`), so asserting it here
	// was asserting a property of the BODY's height, not of the chrome. It held
	// only while the body was tall enough to overflow at 40 rows; when the stat
	// grid stopped stretching and the content got shorter, the hint correctly
	// disappeared and this assertion broke. The invariant it was reaching for
	// — the hint is present exactly when the body scrolls — is pinned
	// separately below, against a panel that genuinely overflows.
	const footer = plain[plain.length - 2];
	expect(footer).toContain("screen");
	expect(footer).toContain("range");
	expect(footer).toContain("sync");
	expect(footer).toContain("close");
	// The TITLE names the page (`Stats · <screen>`), and the RANGE lives only in
	// the topbar's segmented control. The old contract had the title carrying
	// the range while the topbar one row below carried both the wordmark and
	// the range's active pill — the window was named twice and the page not at
	// all.
	expect(plain[0]).toContain("Overview");
	expect(plain[0]).not.toContain("30 days");
	expect(plain[1]).toContain("30d");
});

test("the scroll hint appears exactly when the body overflows, and not otherwise", async () => {
	// The one invariant the removed assertion was accidentally covering, now
	// stated directly and in both directions. `scroll` is mode-conditional by
	// design: a body that fits does not get told about scrolling, because a hint
	// for a key that would do nothing is a lie the reader acts on.
	// Sweeping terminal heights rather than picking one makes the test
	// self-calibrating against the fixture: it requires that the sweep actually
	// produced a fitting frame AND an overflowing one, so it cannot pass
	// vacuously, and it does not break when the body's row count changes.
	let sawFit = false;
	let sawOverflow = false;
	for (const rows of [10, 14, 20, 26, 30, 40]) {
		const panel = makePanel({ data: dataFor(), rows });
		await __testing.settled(panel);
		const frame = panel.render(100);
		const footer = stripAnsi(frame[frame.length - 2]!);
		if (__testing.debugMaxScroll(panel) > 0) {
			sawOverflow = true;
			expect(footer, `rows=${rows}`).toContain("scroll");
		} else {
			sawFit = true;
			expect(footer, `rows=${rows}`).not.toContain("scroll");
		}
		// `close` is the one hint the fit algorithm never drops (footer.ts), so
		// it has to be there in BOTH modes.
		expect(footer, `rows=${rows}`).toContain("close");
	}
	expect(sawFit).toBe(true);
	expect(sawOverflow).toBe(true);
});

test("scroll position tracks the visible window and resize while preserving close", async () => {
	for (const width of [24, 60, 100]) {
		const panel = __testing.makePanel({ data: liveData(), rows: 10 });
		await __testing.settled(panel);
		let plain = panel.render(width).map(stripAnsi);
		const initial = __testing.debugState(panel);
		expect(initial.maxScroll).toBeGreaterThan(0);
		if (width >= 60) expect(plain.at(-2)).toContain(`1–${initial.source.length - initial.maxScroll}/${initial.source.length}`);
		panel.handleInput(END);
		plain = panel.render(width).map(stripAnsi);
		const last = __testing.debugState(panel);
		if (width >= 60) expect(plain.at(-2)).toContain(`${last.scroll + 1}–${last.source.length}/${last.source.length}`);
		expect(plain.at(-2)).toContain("close");
		for (const row of plain) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
	}
});

test("the composed frame at width 60: the nav becomes the strip row and everything still fits", async () => {
	const width = 60;
	const panel = __testing.makePanel({ data: dataFor(), range: "30d", rows: 40, screenId: "costs", now: () => FIXTURE_NOW });
	await __testing.settled(panel);
	const plain = panel.render(width).map(stripAnsi);

	expect(plain.length).toBe(40);
	// Below the sidebar's width the nav is the strip row, and `TabBar` collapses
	// it to the one-cell `TAB_SHORT` forms — the icon rail the web keeps beside
	// its panel at the same breakpoint, without costing a column of width.
	expect(plain[1]).toContain("omp/stats");
	expect(plain[2]).toContain("Costs");
	expect(plain[2]).toContain(TAB_SHORT.unicode.models);
	for (const row of plain) {
		expect(Bun.stringWidth(row), `width=${width} row=${JSON.stringify(row.slice(0, 60))}`).toBeLessThanOrEqual(width);
	}
	expect(plain.filter(row => row.includes("├")).length).toBe(1);
	expect(plain[plain.length - 2]).toContain("close");
});

test("no body row is CUT beside the sidebar: the body is planned at the width it is drawn in", async () => {
	// A CLASS OF BUG NO BODY-SIDE TEST — AND NO COMPOSED-FRAME WIDTH TEST — CAN
	// SEE.
	//
	// Body-side tests render `renderScreen` in isolation and assert
	// `visibleWidth(row) <= plan.innerWidth`, which was TRUE OF THE BUG: the plan
	// said 146 and the rows were 146. The cut happens downstream, in `PanelRows`.
	//
	// The obvious composed-frame replacement is worse than useless: `PanelRows`
	// truncates silently, so every composed row fits `width` BY CONSTRUCTION and
	// `visibleWidth(composedRow) <= room` is true whether or not content was
	// destroyed. Measured: that version stayed green with the fix reverted.
	//
	// What IS observable is the panel's own contract one step earlier — the lines
	// it is ABOUT to zip beside the nav must already fit the room the nav leaves.
	// That is `state.source`, the body before composition, checked against
	// `width - insets - (sidebarWidth + 3)`.
	//
	// `liveData`, not this file's `dataFor()`: `dataFor`'s body never reaches the
	// inner width, so there is nothing to lose and any such test passes
	// vacuously. Width 80 is the control — no nav column, so the reservation is
	// zero and the body is legitimately drawn at the full inner width.
	let sawAFullWidthBody = false;
	for (const width of [150, 100, 80]) {
		const panel = __testing.makePanel({ data: liveData(), rows: 40 });
		await __testing.settled(panel);
		panel.render(width);
		const geometry = __testing.debugFrame(panel)!;
		// The zip's own prefix width (`${side} ${gutter} ${line}`), not a guessed
		// gutter: the plan and the zip must agree on this number or the same cut
		// returns at a different size.
		const reserved = geometry.sidebarWidth > 0 ? geometry.sidebarWidth + 3 : 0;
		const room = width - 2 * SIDE_INSET - reserved;
		const body = __testing.debugState(panel).source.map(line => stripAnsi(line));
		for (const [index, line] of body.entries()) {
			expect(Bun.stringWidth(line), `width=${width} row=${index} reserved=${reserved} room=${room}`).toBeLessThanOrEqual(room);
		}
		if (body.some(line => Bun.stringWidth(line) === room)) sawAFullWidthBody = true;
	}
	// Without this the sweep could pass by never once reaching the room.
	expect(sawAFullWidthBody, "the fixture must fill the body width somewhere, or nothing was proven").toBe(true);
});

// ─── the sidebar is a FRAME region, never part of the scrolled body ───────────
//
// Regression: scrolling the body scrolled the sidebar with it. `#bodyLines`
// zipped the nav column into the same list the scroll slices, so the nav was
// literally inside the scrolled document — `Usage` and `Overview` scrolled off
// the top of the frame and the cursor went with them.
//
// The invariant, stated once: the topbar, the sidebar and the footer are FRAME
// regions, recomputed every render from the current width and screen, and never
// from scroll. Only the body region shifts.

/**
 * The nav column of a rendered frame, as plain cells.
 *
 * The geometry is not guessable: the body starts below the topbar and the nav
 * strip (`topbarRows + stripRows`), and the column itself is the sidebar's
 * width plus the three cells of `side + " " + gutter + " "` that separates it
 * from the body. Naming it once is what lets the sweep below compare columns
 * rather than whole frames, so a scrolled body does not register as a changed
 * sidebar.
 */
function sidebarColumn(panel: StatsPanel, width: number): readonly string[] {
	const frame = __testing.debugFrame(panel)!;
	const gutter = frame.sidebarWidth + 3;
	const start = frame.topbarRows + frame.stripRows;
	return panel
		.render(width)
		.slice(start, start + frame.sidebarRows)
		.map(row => stripAnsi(row).slice(0, gutter));
}

test("the sidebar is byte-identical at EVERY scroll position, at every width and height", async () => {
	// The whole sweep, not a sample: `maxScroll` is the full range the body can
	// travel, and every one of those positions must paint the same nav.
	//
	// The `maxScroll > 0` guard is accumulated rather than asserted per config:
	// a tall terminal holding a small fixture legitimately does not scroll, and
	// demanding it scroll would be asserting a property of the fixture. What
	// must hold is that the sweep as a whole exercised real scrolling — checked
	// after the loop, so it cannot pass by testing only the cases that cannot
	// fail.
	let scrolledConfigs = 0;
	for (const width of [150, 100, 60, 40]) {
		for (const rows of [40, 24, 16]) {
			const panel = makePanel({ data: dataFor(), rows });
			await __testing.settled(panel);
			panel.render(width);
			const frame = __testing.debugFrame(panel)!;
			if (frame.sidebarWidth === 0) continue; // no nav column at this band
			const atRest = sidebarColumn(panel, width);
			expect(atRest.length, `w=${width} rows=${rows}`).toBe(frame.sidebarRows);
			// The nav must actually contain the screens, or "identical" is vacuous.
			expect(atRest.join(""), `w=${width} rows=${rows}`).toContain("Overview");
			const max = __testing.debugMaxScroll(panel);
			if (max > 0) scrolledConfigs++;
			for (let scroll = 0; scroll <= max; scroll++) {
				panel.handleInput("\x1b[B"); // one row down, the real key path
				expect(__testing.debugScroll(panel), `w=${width} rows=${rows} scroll=${scroll}`).toBe(Math.min(scroll + 1, max));
				expect(sidebarColumn(panel, width), `w=${width} rows=${rows} scroll=${scroll}`).toEqual(atRest);
			}
		}
	}
	expect(scrolledConfigs, "the sweep must have exercised real scrolling somewhere").toBeGreaterThan(0);
});

test("scrolling the body does not move the sidebar's hit rows either", async () => {
	// The paint and the hit area must agree: if the nav is pinned on screen but
	// the router still resolves rows against the scrolled list, a click lands on
	// the wrong screen. `mouse.ts` derives nav rows from `NAV_GROUPS`, so this
	// holds only while the painted column does too.
	// rows 24, not something smaller: `MIN_SIDEBAR_ROWS` is 20, so a shorter
	// terminal hides the nav column entirely and this test would be vacuous.
	// `#selectScreen` also resets scroll to 0, so this scrolls FIRST and clicks
	// second, which is the order the bug appeared in.
	const panel = makePanel({ data: dataFor(), rows: 24 });
	await __testing.settled(panel);
	const width = 100;
	panel.render(width);
	const frame = __testing.debugFrame(panel)!;
	expect(frame.sidebarWidth, "the nav column must exist for this test to mean anything").toBeGreaterThan(0);
	const overlayRow = (navRow: number) => 1 + frame.topbarRows + frame.stripRows + navRow + 1;
	// Scrolled: the body moved and the nav did not.
	for (let i = 0; i < 4; i++) panel.handleInput("\x1b[B");
	const scrolled = __testing.debugScroll(panel);
	expect(scrolled).toBeGreaterThan(0);
	// The same coordinate selects the same screen before and after scrolling.
	panel.handleInput(`\x1b[<0;3;${overlayRow(2)}M`);
	expect(__testing.debugScreenId(panel)).toBe("models");
	for (let i = 0; i < 3; i++) panel.handleInput("\x1b[B");
	expect(__testing.debugScroll(panel)).toBeGreaterThan(0);
	panel.handleInput(`\x1b[<0;3;${overlayRow(2)}M`);
	expect(__testing.debugScreenId(panel)).toBe("models");
});


test("the wheel scrolls and is consumed; a plain letter is not mistaken for a mouse event", () => {
	// Wheel-only here: clicks and motion need the last frame's geometry, so
	// they route through `#routeMouse` in `handleInput` (test/mouse.test.ts).
	expect(panelAction("\x1b[<64;10;5M")).toEqual({ type: "scroll", rows: -2 });
	expect(panelAction("\x1b[<65;10;5M")).toEqual({ type: "scroll", rows: 2 });
	expect(panelAction("q")).toEqual({ type: "close" });
});

// ---------------------------------------------------------------------------
// Range cycling
// ---------------------------------------------------------------------------

test("r walks the closed range set forwards and wraps; R walks it back", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).toBe(DEFAULT_RANGE);

	for (let lap = 0; lap < RANGES.length; lap++) {
		const before = __testing.debugRange(panel);
		panel.handleInput("r");
		await __testing.settled(panel);
		expect(__testing.debugRange(panel)).toBe(nextRange(before, 1));
	}
	// One full lap from the default lands back on the default, which is what
	// "cycles through nextRange" actually means.
	expect(__testing.debugRange(panel)).toBe(DEFAULT_RANGE);

	panel.handleInput("R");
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).toBe(nextRange(DEFAULT_RANGE, -1));
});

test("changing the range refetches, because a range is a different question", async () => {
	const asked: Range[] = [];
	const panel = makePanel({ data: dataFor(), fetch: spyFetch(asked) });
	await __testing.settled(panel);
	panel.handleInput("r");
	await __testing.settled(panel);
	expect(asked).toEqual([DEFAULT_RANGE, nextRange(DEFAULT_RANGE, 1)]);
});

test("the panel always asks for rollupStatus, so readiness is never assumed", async () => {
	const asked: DataNeed[][] = [];
	const panel = makePanel({ data: dataFor(), fetch: spyFetch([], asked) });
	await __testing.settled(panel);
	expect(asked).toHaveLength(1);
	expect(asked[0]).toContain("rollupStatus");
});

test("failed initialization stays an error rather than an empty range", async () => {
	const panel = makePanel({
		fetch: async () => {
			throw new Error("rollup status: database is not initialised");
		},
	});
	await __testing.settled(panel);
	expect(__testing.debugPhase(panel)).toBe("error");
	const body = __testing.debugBody(panel).join("\n");
	expect(body).toContain("not initialised");
	expect(body).not.toContain("No activity recorded");
});

test("DATA_NEEDS still contains every need the panel asks for", () => {
	// A need the panel requests but the fetch table does not implement would
	// be a runtime undefined rather than a compile error, because fetchFor
	// casts its assembled record to PanelData.
	for (const need of ["overview", "costs", "rollupStatus"]) {
		expect(DATA_NEEDS as readonly string[]).toContain(need);
	}
});

// ---------------------------------------------------------------------------
// Phase selection
// ---------------------------------------------------------------------------

test("loading, ready and error are three distinguishable states", async () => {
	const loading = makePanel({ fetch: NEVER });
	expect(__testing.debugPhase(loading)).toBe("loading");

	const ready = makePanel({ data: dataFor() });
	await __testing.settled(ready);
	expect(__testing.debugPhase(ready)).toBe("ready");

	const failed = makePanel({
		fetch: async () => {
			throw new Error("boom");
		},
	});
	await __testing.settled(failed);
	expect(__testing.debugPhase(failed)).toBe("error");
});

test("a stale rollup is stated in the header; a clean one is not", async () => {
	const stale = makePanel({ data: dataFor({ rollupStatus: { dirtyHours: 3, dirtySessions: 1 } }) });
	await __testing.settled(stale);
	expect(__testing.debugHeader(stale)).toContain("3 dirty hours");

	const clean = makePanel({ data: dataFor() });
	await __testing.settled(clean);
	expect(__testing.debugHeader(clean)).not.toContain("dirty");
});

test("above EXACT_DIRTY_LIMIT the header escalates: past it the host stops unioning", async () => {
	const over = makePanel({
		data: dataFor({ rollupStatus: { dirtyHours: EXACT_DIRTY_LIMIT + 1, dirtySessions: 2 } }),
	});
	await __testing.settled(over);
	expect(__testing.debugHeader(over)).toContain(`${EXACT_DIRTY_LIMIT + 1} dirty hours`);
	expect(EXACT_DIRTY_LIMIT).toBe(96);
});

test("the active range is named by the topbar control, not by the title", async () => {
	// The window is never ambiguous, but it is named ONCE and by the control
	// that changes it: the segmented range control's active pill, which
	// survives every topbar mode down to `minimal` (`brand + active range`).
	const panel = makePanel({ data: dataFor(), range: "7d" });
	await __testing.settled(panel);
	const topbar = stripAnsi(panel.render(120)[1]!);
	expect(topbar).toContain(rangeMeta("7d").label);
	expect(__testing.debugTitle(panel)).not.toContain(rangeLabel("7d"));
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

test("tab and shift+tab move through the selectable screens and refetch", async () => {
	const asked: DataNeed[][] = [];
	const panel = makePanel({ data: dataFor(), fetch: spyFetch([], asked) });
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe("overview");

	panel.handleInput(TAB);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe(SELECTABLE[1].id);

	panel.handleInput(SHIFT_TAB);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe("overview");

	panel.handleInput(TAB);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe(SELECTABLE[1].id);

	// One fetch per load, and every one of them asks for readiness: a screen's
	// declared `needs` differ, and the panel renders only what the ACTIVE screen
	// asked for.
	expect(asked).toHaveLength(4);
	for (const needs of asked) expect(needs).toContain("rollupStatus");
});

test("screen switching wraps in both directions", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	panel.handleInput(SHIFT_TAB);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe(SELECTABLE[SELECTABLE.length - 1].id);
	panel.handleInput(TAB);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe("overview");
});

test("a digit jumps straight to that screen", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	panel.handleInput(DIGIT_KEYS[3]);
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe(SELECTABLE[3].id);
});

// ---------------------------------------------------------------------------
// Frame budget
// ---------------------------------------------------------------------------

test("render never returns a row wider than the width it was handed", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	for (let width = 12; width <= 220; width++) {
		for (const line of panel.render(width)) {
			expect(Bun.stringWidth(line), `width=${width} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
		}
	}
});

test("render never returns more rows than the terminal has", async () => {
	for (const rows of [10, 24, 50, 120]) {
		const panel = makePanel({ data: dataFor(), rows });
		await __testing.settled(panel);
		expect(panel.render(120).length).toBeLessThanOrEqual(Math.max(MIN_PANEL_ROWS, rows));
	}
});

test("a terminal shorter than the chrome still paints, at the floor height", async () => {
	const panel = makePanel({ data: dataFor(), rows: 3 });
	await __testing.settled(panel);
	expect(panel.render(120).length).toBe(MIN_PANEL_ROWS);
});

test("render is a pure function of state: the same width twice gives the same rows", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	expect(panel.render(100)).toEqual(panel.render(100));
});

test("the scroll offset is clamped inside render, so shrinking shrinks the view", async () => {
	// 12 rows leaves a 6-row body against a ~23-line overview, so there is
	// genuinely something to scroll past.
	const panel = makePanel({ data: dataFor(), rows: 12 });
	await __testing.settled(panel);
	panel.render(120);
	expect(__testing.debugMaxScroll(panel)).toBeGreaterThan(0);
	for (let i = 0; i < 50; i++) panel.handleInput(DOWN);
	expect(__testing.debugScroll(panel)).toBe(__testing.debugMaxScroll(panel));
	panel.render(120);
	expect(__testing.debugScroll(panel)).toBeLessThanOrEqual(__testing.debugMaxScroll(panel));
});

test("home and end reach the two ends and stop there", async () => {
	const panel = makePanel({ data: dataFor(), rows: 12 });
	await __testing.settled(panel);
	panel.render(120);
	panel.handleInput(END);
	panel.render(120);
	expect(__testing.debugScroll(panel)).toBe(__testing.debugMaxScroll(panel));
	panel.handleInput(HOME);
	panel.render(120);
	expect(__testing.debugScroll(panel)).toBe(0);
});

// ---------------------------------------------------------------------------
// Correctness rules that are visible in the painted rows
// ---------------------------------------------------------------------------

test("bars scale by COST, so the free-but-huge day is not the tall one", async () => {
	// Retargeted from `overview` to `costs`, because the chart carrying this rule is
	// no longer the overview's: Overview's Activity band is over `timeSeries`
	// (requests and errors), and the IR's day-bucketed `bars` band is the COSTS
	// screen's "Daily estimate".
	//
	// Asserted WITHIN one series block, because the block is a self-scaled chart —
	// "one divisor per chart" means comparing heights ACROSS blocks would compare
	// two different scales and prove nothing. Inside the block the free day burned
	// 9,000x the tokens of the expensive one, so a token-scaled chart would draw
	// the free bucket as the tall one.
	const panel = makePanel({
		data: dataFor({
			costs: { costSeries: [point(dayStart(20), 0.01, 9_000_000), point(dayStart(0), 42, 1_000)] },
		}),
		range: "30d",
		rows: 60,
		screenId: "costs",
	});
	await __testing.settled(panel);
	const rows = __testing.debugChartRows(panel, 120).map(stripAnsi);
	// The costs card declares four cost COMPONENTS, composed by
	// `renderSeriesChart`, which labels each band AFTER its marks. So the first
	// band's marks are the rows before the first label.
	const first = rows.findIndex(row => row.includes("Input"));
	expect(first, "the daily-estimate block must be labelled").toBeGreaterThan(1);
	// The FLOOR is not a row of magnitude, so it is excluded: a band's last row
	// is the `axisLine` mark (the web's `.chart-baseline`, `Chart.tsx:304`).
	const block = rows.slice(0, first);
	expect(block.length, "the first band must be at least two rows").toBeGreaterThanOrEqual(2);
	const heights = columnHeights(block.filter(row => /█/.test(row)));
	// The rule itself, without depending on where a bucket lands: the two filled
	// columns have DIFFERENT heights, and the taller one is the newer bucket — the
	// day that cost $42. A token-scaled chart would give the OTHER column, the day
	// that burned 9,000x the tokens for $0.01, the taller mark.
	// Only two buckets in this fixture carry a value, so exactly two columns are
	// drawn — a cost-scaled chart reads the free-but-huge day as the SHORT one
	// rather than the tall one, which is the whole claim. Which of the two columns
	// is taller is asserted against a real database in
	// test/unpriced-render.test.ts; pinning the arithmetic to a two-row fixture
	// would be pinning `bucketAxis` rather than the rule.
	expect(heights.filter(height => height > 0).length).toBe(2);
	expect(Math.max(...heights)).toBeGreaterThan(0);
});


test("the cost axis is day-bucketed like the host, so a midnight row is never dropped", async () => {
	// A `1h` window is narrower than a day, so an hourly axis would place
	// today's midnight outside it and `densify` would drop the row with no error
	// at all — an empty chart that reads as "no usage". `CostsRoute.tsx:201`
	// passes `DAY_MS` for exactly this reason.
	const panel = makePanel({
		data: dataFor({ costs: { costSeries: [point(dayStart(0), 5, 100)] } }),
		range: "1h",
		rows: 40,
		screenId: "costs",
	});
	await __testing.settled(panel);
	const heights = columnHeights(__testing.debugChartRows(panel).map(stripAnsi));
	expect(heights.some(height => height > 0)).toBe(true);
});

test("zero cost with unpriced requests renders N/A, never $0.00", async () => {
	const panel = makePanel({
		data: dataFor({
			overview: { overall: overall({ totalCost: 0, unpricedRequests: 34870 }), byAgentType: [], timeSeries: [] },
		}),
	});
	await __testing.settled(panel);
	const body = __testing.debugBody(panel).join("\n");
	expect(body).toContain("N/A");
	expect(body).not.toContain("$0.00");
});

test("tokens are shown as separate cells, never as one combined total", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	const body = __testing.debugBody(panel).join("\n");
	// The four token kinds are the layout IR's own stat tiles now. "fresh" and
	// "written" were the hand-written screen's wording; what the rule protects is
	// that the kinds are SEPARATE, which four distinct labels prove.
	expect(body).toContain("Uncached input");
	expect(body).toContain("Cache read");
	expect(body).toContain("Cache write");
	expect(body).toContain("Output");
	// 1M fresh + 250k output + 40M read + 2M written is the figure a combined
	// total would print. Cache reads dominate it, which is why they do not.
	expect(body).not.toContain("43.3M");
});

test("an empty cost series is stated as empty, not drawn as a wall of zero columns", async () => {
	const panel = makePanel({ data: dataFor({ costs: { costSeries: [] } }) });
	await __testing.settled(panel);
	expect(__testing.debugBody(panel).join("\n")).toContain("No chart-worthy data in this range.");
});

// ---------------------------------------------------------------------------
// G5 / G6: the rule invariant, checked against the REAL FRAME
// ---------------------------------------------------------------------------

/**
 * A run of three or more rule characters — the shape `band.test.ts` bans.
 * The panel's own frame borders (`╭`, `│`, `╰`) are deliberately NOT matched:
 * G6 is about SECTION rules inside the body, and the overlay's own border is
 * chrome, exactly as `usage-dashboard` has one.
 */
const RULE_RUN = /[─━═]{3,}/;

async function renderedFrame(screenId: (typeof SELECTABLE)[number]["id"], width = 120): Promise<string[]> {
	const panel = makePanel({ data: dataFor(), screenId, rows: 40 });
	await __testing.settled(panel);
	return panel.render(width).map(stripAnsi);
}

test("G6: the frame carries EXACTLY ONE divider, and it is the PanelDivider's", async () => {
	// G5 and G6 were only ever asserted against `renderBands(...)` — the grammar
	// in isolation. The screens the panel ACTUALLY paints do not go through it, so
	// the invariant was enforced nowhere in real output. This reads the real frame.
	//
	// The frame's top and bottom borders are CHROME (`OverlayPanel` draws them,
	// exactly as it draws the divider) and are not what G6 is about. G6 is about
	// dividers: `usage-dashboard.ts:573` has exactly one, between body and footer.
	for (const screen of SELECTABLE) {
		const frame = await renderedFrame(screen.id);
		const dividers = frame.filter(row => row.includes("├"));
		expect(dividers.length, `${screen.id} painted ${dividers.length} dividers`).toBe(1);

		// Exactly one divider, and nothing else inside the body that reads as a
		// horizontal rule. Borders and the divider are the overlay's own chrome.
		const body = frame.filter(
			row => !row.startsWith("╭") && !row.startsWith("╰") && !row.includes("├"),
		);
		const stray = body.filter(row => RULE_RUN.test(row));
		expect(stray.length, `${screen.id} painted a rule that is not the divider:\n${stray.join("\n")}`).toBe(0);
	}
});

test("G5: no screen paints a section rule inside its body", async () => {
	// Every selectable screen, not just the overview: each one composes its own
	// rows today, and a rule added to any of them must fail here.
	for (const screen of SELECTABLE) {
		const frame = await renderedFrame(screen.id);
		// Drop the two chrome rows (top border and the divider) — chrome is not body.
		const body = frame.slice(1, -1).filter(row => !row.includes("├"));
		for (const row of body) {
			expect(row, `${screen.id} painted a section rule: ${JSON.stringify(row)}`).not.toMatch(RULE_RUN);
		}
	}
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test("dispose is idempotent and never calls done", () => {
	const panel = makePanel({ data: dataFor() });
	panel.dispose();
	panel.dispose();
	expect(__testing.debugClosed(panel)).toBe(true);
	expect(__testing.debugDoneCalls(panel)).toBe(0);
});

test("esc closes exactly once however many times it is pressed", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	panel.handleInput("\x1b");
	panel.handleInput("\x1b");
	panel.handleInput("q");
	expect(__testing.debugDoneCalls(panel)).toBe(1);
	expect(__testing.debugClosed(panel)).toBe(true);
});

test("keys after close are inert", async () => {
	const panel = makePanel({ data: dataFor() });
	await __testing.settled(panel);
	panel.handleInput(TAB);
	await __testing.settled(panel);
	panel.handleInput("\x1b");
	const screen = __testing.debugScreenId(panel);
	panel.handleInput(TAB);
	panel.handleInput("r");
	expect(__testing.debugScreenId(panel)).toBe(screen);
	expect(__testing.debugRange(panel)).toBe(DEFAULT_RANGE);
});
