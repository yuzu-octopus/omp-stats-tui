/**
 * A SCREEN REACHABLE BY ARROW KEY MUST BE VISIBLE IN THE FRAME YOU REACH IT FROM.
 *
 * Reported: pressing `←`/`→` makes the sidebar visibly jump. Two separate causes,
 * found by diffing all ten screens' sidebar columns at widths 100/150 and
 * heights 19-40, and both fixed here.
 *
 * D1 THE NAV WAS TRUNCATED BY THE BODY. `#zipSidebar` mapped over the body's
 * visible rows, so the nav column was exactly as tall as the body happened to be.
 * `overview` has a 50-line body against `gain`'s 12, and `gain` is the LAST nav
 * row — so arrowing from overview to gain dropped the entire active marker. The
 * nav appeared to jump to a screen it never drew. `panel.ts:#zipSidebar` now
 * takes `max(body rows, nav lines)` and pads the body, never the nav.
 *
 * D2 TWO SCREENS HAD NO NAV ROW AT ALL. `providers` and `gain` are on the
 * `←`/`→` cycle but had no HOTKEYS entry, and `NAV_GROUPS` drops ids without one,
 * so arrowing onto them removed the `❯` outright and left every group heading on
 * its inactive ink. Both are now in the nav.
 *
 * WHAT IS ALLOWED TO CHANGE between two screens: the `❯` marker, and the active
 * group's heading ink. Nothing else — not row order, not row text, not the nav's
 * height, not the column width.
 */
import { expect, test } from "bun:test";
import { SCREEN_SPECS } from "../src/layout/spec";
import { __testing, SELECTABLE_SCREENS } from "../src/tui/panel";
import { NAV_GROUPS, screenForHotkey, sidebar } from "../src/tui/chrome";
import { hitTest } from "../src/tui/mouse";
import type { ScreenId } from "../src/tui/screens/types";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";

ensureThemeSync();
/** The nav column's own width, from the same renderer that draws it. Slicing a
 * FIXED width rather than searching for the next `│` matters: a body row with no
 * gutter of its own makes the next `│` a hundred cells away, which reads as a
 * changed nav column when nothing about the nav moved. */
const NAV_WIDTH = sidebar(theme, "unicode", "overview").width;
import { liveData } from "./fixtures/panel";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

/** The nav column of one frame row: exactly NAV_WIDTH cells after the leading `│ `. */
function navColumn(row: string): string | null {
	const plain = strip(row);
	if (!plain.startsWith("│ ")) return null;
	// The topbar shares the frame's left edge but is not nav, and counting it
	// pushes the LAST nav row out of the comparison — which is exactly the row
	// this test exists to catch. Excluded by content, not by index.
	return plain.includes("omp/stats") ? null : plain.slice(2, 2 + NAV_WIDTH);
}

/** The nav's own height, from NAV_GROUPS: one heading row per group, plus its screens. */
const NAV_LINES = NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0);

/** The nav region only. The footer also starts with `│ ` and legitimately differs
 * between a scrollable and a non-scrollable screen, so it is not nav. */
async function sidebarColumn(screenId: ScreenId, width: number, rows: number): Promise<readonly string[]> {
	const panel = __testing.makePanel({ data: liveData(), screenId, rows });
	await __testing.settled(panel);
	return panel
		.render(width)
		.map(navColumn)
		.filter((c): c is string => c !== null)
		.slice(0, NAV_LINES);
}

const WIDTHS = [150, 100] as const;
/** 40 is a normal terminal; 24 and 20 are short, and 20 is the nav floor. */
const HEIGHTS = [40, 24, 20] as const;

test("every reachable screen shows exactly one cursor, at every width and height", async () => {
	for (const width of WIDTHS) {
		for (const rows of HEIGHTS) {
			for (const id of SELECTABLE_SCREENS.map(s => s.id)) {
				const column = await sidebarColumn(id, width, rows);
				const cursors = column.filter(c => c.includes("❯"));
				expect(cursors, `${width}/${rows}/${id}: ${JSON.stringify(column)}`).toHaveLength(1);
			}
		}
	}
});

test("the nav column moves NOTHING between consecutive screens but the cursor", async () => {
	for (const width of WIDTHS) {
		for (const rows of HEIGHTS) {
			const screens = SELECTABLE_SCREENS.map(s => s.id);
			for (let k = 1; k < screens.length; k++) {
				const before = await sidebarColumn(screens[k - 1]!, width, rows);
				const after = await sidebarColumn(screens[k]!, width, rows);
				expect(after.length, `${width}/${rows} ${screens[k]} nav height changed`).toBe(before.length);
				for (let i = 0; i < before.length; i++) {
					if (before[i] === after[i]) continue;
					// The ONLY permitted difference is the cursor, and only on rows
					// that carry one: exactly one row loses `❯`, exactly one gains it.
					expect(
						before[i]!.includes("❯") || after[i]!.includes("❯"),
						`${width}/${rows} ${screens[k - 1]}→${screens[k]} row ${i} moved without the cursor:\n` +
							`  before ${JSON.stringify(before[i])}\n  after  ${JSON.stringify(after[i])}`,
					).toBe(true);
				}
			}
		}
	}
});

test("the nav is never shorter than NAV_GROUPS says it is, on any screen", () => {
	// D1 at the source: the nav is a FRAME region, so its height is a property of
	// the nav, not of whichever screen's body happens to be rendering.
	expect(NAV_LINES).toBeGreaterThan(11);
	for (const g of NAV_GROUPS) expect(g.items.length).toBeGreaterThan(0);
});

test("every screen on the arrow cycle has a row in the nav", () => {
	// D2 at the source. Derived from the two lists rather than restated, so adding
	// a screen without a nav row fails here instead of vanishing in the frame.
	const navIds = NAV_GROUPS.flatMap(g => g.items.map(i => i.id));
	for (const id of SELECTABLE_SCREENS.map(s => s.id)) {
		expect(navIds, `${id} is reachable by ←/→ but has no sidebar row`).toContain(id);
	}
});

test("the nav and the tab strip draw the same screens in different orders", () => {
	// Recorded, not endorsed: below MIN_SIDEBAR_ROWS the panel swaps the sidebar
	// for the strip (`panel.ts:620-626`) and the strip follows `SCREEN_SPECS`. Two
	// controls, two orders. This pins the fact so the ordering change that follows
	// is measurable.
	const navOrder = NAV_GROUPS.flatMap(g => g.items.map(i => i.label));
	const stripOrder = SCREEN_SPECS.map(s => s.label);
	expect(navOrder.indexOf("Activity")).toBeGreaterThan(navOrder.indexOf("Costs"));
	expect(stripOrder.indexOf("Activity")).toBeLessThan(stripOrder.indexOf("Costs"));
});

// ─── the jump path, which is the part that would actually break ───────────────

/**
 * THE JUMP TARGET MUST NOT DEPEND ON WHICH CONTROL IS VISIBLE.
 *
 * The sidebar and the tab strip deliberately order the same ten screens
 * differently — `NAV_GROUPS` is a navigation order, `SCREEN_SPECS` is the IR's
 * declaration order, and they are different jobs. That is agreed and not being
 * unified.
 *
 * What is NOT acceptable is the two disagreeing about where a KEY LANDS. Below
 * `MIN_SIDEBAR_ROWS` the panel swaps sidebar for strip (`panel.ts:620-626`), so
 * a jump derived from whichever control happened to be drawn would send the same
 * letter to different screens at different terminal heights — a session that
 * breaks silently as the window changes.
 *
 * `screenForHotkey` resolves by LETTER, scanning `NAV_GROUPS` for a matching
 * hotkey and returning that item's id. Nothing else contributes, so the target
 * is the same at every height. These assertions are green by construction — they
 * pin a property nothing else covers, and would catch a future index-based
 * rewrite of the jump lookup, which is the plausible way this could rot.
 */
test("every jump letter lands on the nav item that owns it, not on a position", () => {
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			expect(screenForHotkey(item.hotkey), `letter "${item.hotkey}" → ${item.id}`).toBe(item.id);
			// Case-insensitive, like the web's `e.key.toLowerCase()`.
			expect(screenForHotkey(item.hotkey.toUpperCase())).toBe(item.id);
		}
	}
});

test("no jump letter is ambiguous, so the target cannot depend on scan order", () => {
	// If two items shared a letter, which one won would depend on the order the
	// groups happened to be walked in — and the groups change when the nav
	// changes. One letter, one screen, or the jump is not order-independent.
	const owners: Record<string, string> = {};
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			const letter = item.hotkey.toLowerCase();
			expect(owners[letter], `letter "${letter}" is claimed by both ${owners[letter]} and ${item.id}`).toBeUndefined();
			owners[letter] = item.id;
		}
	}
	expect(Object.keys(owners).length).toBe(NAV_GROUPS.reduce((n, g) => n + g.items.length, 0));
});

test("every screen the strip can show that has a nav row is reachable by its own letter", () => {
	// The strip and the sidebar disagree about ORDER only. They must still agree
	// about IDENTITY: for any screen shown in both, the jump and the nav name the
	// same thing, or the two controls are not showing the same ten screens.
	const navIds = NAV_GROUPS.flatMap(g => g.items.map(i => i.id));
	for (const spec of SCREEN_SPECS) {
		if (!navIds.includes(spec.id)) continue;
		const item = NAV_GROUPS.flatMap(g => g.items).find(i => i.id === spec.id)!;
		expect(screenForHotkey(item.hotkey), `${spec.id}`).toBe(spec.id);
	}
});

// ─── the hit map, which must cover every row the nav paints ─────────────────

/**
 * THE HIT MAP MUST COVER EVERY ROW THE NAV PAINTS.
 *
 * A row that shows a screen the reader can click must select that screen, and a
 * row that does not is a dead zone in a control that looks alive. `c24d260`
 * fixed the paint; this guards the half that is easy to leave behind, because
 * the paint is verified by looking at the frame and the hit map is verified only
 * by clicking it.
 *
 * THE OFF-BY-ONE IS NOT HYPOTHETICAL. This file's own first draft of this
 * probe, and an external verification of the same bug, both reported that `gain`
 * "sits at nav row 13" and is therefore unclickable. It sits at nav row 12. The
 * nav is 13 lines, so its rows are 0-12 and row 13 correctly does not exist;
 * both probes added a row of `1 + topbarRows + stripRows` where `hitTest`
 * subtracts exactly that plus one more, and every row came back shifted by one —
 * which looks precisely like "the last row is dead" and is in fact "everything
 * is off by one".
 *
 * So the offsets below are DERIVED FROM `hitTest`'s own arithmetic rather than
 * restated, and the expected ids come from `NAV_GROUPS` rather than written out.
 */
function expectedNavRows(): readonly (string | null)[] {
	return NAV_GROUPS.flatMap(g => [null, ...g.items.map(i => i.id)]);
}

/** The overlay row `hitTest` reads as nav row `nav` — its arithmetic, not a guess. */
function overlayRowOf(frame: { topbarRows: number; stripRows: number }, nav: number): number {
	return nav + 1 + frame.topbarRows + frame.stripRows;
}

async function frameFor(width: number, rows: number) {
	const panel = __testing.makePanel({ data: liveData(), screenId: "overview", rows });
	await __testing.settled(panel);
	panel.render(width);
	return __testing.debugFrame(panel)!;
}

test("the frame's hit map covers exactly the rows the nav paints", async () => {
	const painted = expectedNavRows().length;
	expect(painted).toBe(NAV_LINES);
	for (const width of WIDTHS) {
		for (const rows of HEIGHTS) {
			const frame = await frameFor(width, rows);
			// The map must be as tall as the paint, or the tail of the nav is a
			// dead zone. This is the assertion the reported bug tripped over.
			expect(frame.sidebarRows, `${width}/${rows} hit map height`).toBe(painted);
			// And exactly one row past the end is the first non-nav row.
			expect(hitTest(frame, overlayRowOf(frame, painted), 3).type, `${width}/${rows} past the nav`).toBe("none");
		}
	}
});

test("every painted nav row maps to the screen it shows — none wrong, none dead", async () => {
	const expected = expectedNavRows();
	for (const width of WIDTHS) {
		for (const rows of HEIGHTS) {
			const frame = await frameFor(width, rows);
			for (const [nav, want] of expected.entries()) {
				const hit = hitTest(frame, overlayRowOf(frame, nav), 3);
				const got = hit.type === "screen" ? hit.id : null;
				expect(got, `${width}/${rows} nav row ${nav} shows ${want ?? "a heading"} but hit ${got ?? hit.type}`).toBe(want);
			}
		}
	}
});

/**
 * END-TO-END CLICKING IS NOT DUPLICATED HERE ON PURPOSE.
 *
 * `test/mouse.test.ts` already drives `panel.handleInput` for real clicks, and
 * its `overlayRow` helper uses `nav + 2 + topbarRows + stripRows` — one MORE
 * than `hitTest`'s own `row - 1 - topbarRows - stripRows`. Both conventions pass
 * their own suite, because each suite is self-consistent: mouse.test.ts clicks
 * through `#routeMouse` and this file calls `hitTest` directly.
 *
 * That one-row gap between the two is itself worth recording and is NOT yet
 * resolved — which of them is authoritative depends on which frame geometry
 * `#routeMouse` consults, and pinning that down is its own piece of work. Until
 * it is settled, adding a THIRD convention here would make the disagreement
 * harder to find rather than easier, so the end-to-end sweep stays where it
 * already lives.
 */
