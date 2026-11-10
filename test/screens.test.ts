/**
 * `test/screens.test.ts` — ONE screen registry, and the test that says so.
 *
 * WHAT THIS FILE PINS. Two modules answer "is this a screen?" from the same
 * input — the `SCREENS` registry — with no second rule:
 *
 *   - `panel.ts`'s `SELECTABLE_SCREENS` IS `SCREENS`;
 *   - `chrome.ts`'s `NAV_GROUPS` resolves every id through `screenById`.
 *
 * Nothing connects them except the registry, so a screen cannot be
 * arrow-selectable while missing from the sidebar, or present in the sidebar
 * with no identity to draw. These tests are the reason that stays true.
 */

import { expect, test } from "bun:test";

import { NAV_GROUPS, screenForHotkey } from "../src/tui/chrome";
import { SELECTABLE_SCREENS, panelAction } from "../src/tui/panel";
import { SCREENS, screenById, type ScreenId } from "../src/tui/screens/types";

// ---------------------------------------------------------------------------
// The drift assertion — the whole point
// ---------------------------------------------------------------------------

test("every nav row is a screen the panel can select", () => {
	// The direction that hides the most: a nav row with no selectable screen paints
	// an entry that cannot be reached by any other means.
	// Annotated as `Set<string>`, not inferred: `screen.id` is the `ScreenId` literal
	// union, so an inferred Set would refuse the plain `string` this filter carries.
	const selectable = new Set<string>(SELECTABLE_SCREENS.map(screen => screen.id));
	const orphans = NAV_GROUPS.flatMap(group => group.items.map(item => item.id)).filter(id => !selectable.has(id));
	expect(orphans).toEqual([]);
});

test("every selectable screen appears in the nav", () => {
	// The other direction: a screen the digit row can reach but the sidebar never
	// names. Nobody finds that by arrowing, because arrowing lands on an invisible
	// target.
	const inNav = new Set(NAV_GROUPS.flatMap(group => group.items.map(item => item.id)));
	const missing = SELECTABLE_SCREENS.map(screen => screen.id).filter(id => !inNav.has(id));
	expect(missing).toEqual([]);
});

test("the two sets are equal in MEMBERSHIP, and that is the only equality claimed", () => {
	const selectable = SELECTABLE_SCREENS.map(screen => screen.id).sort();
	const inNav = NAV_GROUPS.flatMap(group => group.items.map(item => item.id)).sort();
	expect(inNav).toEqual(selectable);
});

test("neither list can contain a screen the registry does not know", () => {
	// Both are derived from the one registry, so this is the invariant that would
	// break FIRST if someone reintroduced a second list.
	const known = new Set<string>(SCREENS.map(screen => screen.id));
	for (const id of SELECTABLE_SCREENS.map(screen => screen.id)) expect(known.has(id), id).toBe(true);
	for (const id of NAV_GROUPS.flatMap(group => group.items.map(item => item.id))) {
		expect(known.has(id), id).toBe(true);
	}
});

// ---------------------------------------------------------------------------
// What is NOT unified, stated so nobody "finishes" it by accident
// ---------------------------------------------------------------------------

test("the two lists have DIFFERENT orders, and both orders are load-bearing", () => {
	// The digit row indexes `SELECTABLE_SCREENS`; the sidebar reads `NAV_GROUPS`.
	// They are deliberately not the same order — the nav is grouped for reading and
	// the number row is not — so "derive one from the other" would be a BEHAVIOUR
	// CHANGE, not a cleanup. This test exists to make that un-doing loud.
	const selectable = SELECTABLE_SCREENS.map(screen => screen.id);
	const inNav = NAV_GROUPS.flatMap(group => group.items.map(item => item.id));
	expect(inNav).not.toEqual(selectable);
	// The divergence is REAL and CONCRETE, named rather than merely "not equal":
	// the nav puts `providers` with the usage screens it bills alongside, while the
	// registry order — which the digit row follows — puts it last. Deriving one
	// order from the other would change which screen `4` selects, which is why this
	// unification stopped at MEMBERSHIP and did not touch order.
	expect(inNav.indexOf("providers")).toBeLessThan(inNav.indexOf("activity"));
	expect(selectable.indexOf("providers")).toBeGreaterThan(selectable.indexOf("activity"));
});

test("the digit row still indexes SELECTABLE_SCREENS positionally", () => {
	for (const [index, digit] of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].entries()) {
		const action = panelAction(digit);
		expect(action, digit).toEqual({ type: "screenIndex", index });
	}
});

test("the sidebar row count covers every group heading and every screen", () => {
	// `sidebarHit` walks NAV_GROUPS to map a row to a screen, so its arithmetic
	// depends on this exact shape: one heading row per group, then one per item.
	// A group that lost a row would shift every row beneath it.
	const expected = NAV_GROUPS.reduce((rows, group) => rows + 1 + group.items.length, 0);
	expect(expected).toBe(NAV_GROUPS.length + SELECTABLE_SCREENS.length);
});

// ---------------------------------------------------------------------------
// The jump letters, which are the other half of the nav
// ---------------------------------------------------------------------------

test("every nav row has a jump letter, and every letter resolves to that row", () => {
	// A row with no letter is unreachable by `g`, and a letter that resolves
	// elsewhere is worse than a missing one: it takes the user somewhere they did
	// not ask to go.
	const letters = NAV_GROUPS.flatMap(group => group.items.map(item => item.hotkey));
	expect(new Set(letters).size).toBe(letters.length);
	for (const item of NAV_GROUPS.flatMap(group => group.items)) {
		expect(item.hotkey).not.toBe("");
		expect(screenForHotkey(item.hotkey), item.id).toBe(item.id as ScreenId);
	}
});

test("a letter belonging to no nav row resolves to nothing", () => {
	// `screenForHotkey` returns null rather than guessing, so a jump can only land
	// on a row that exists.
	expect(screenForHotkey("~")).toBeNull();
	expect(screenForHotkey("")).toBeNull();
	expect(screenForHotkey("1")).toBeNull();
});

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test("SCREENS is the one list, and SELECTABLE_SCREENS is that same list", () => {
	// `SELECTABLE_SCREENS` is `SCREENS`, not a filtered copy: a screen the registry
	// knows is a screen the digit row can reach.
	expect(SELECTABLE_SCREENS).toBe(SCREENS);
});

test("screenById resolves every registry entry and throws on anything else", () => {
	for (const screen of SCREENS) {
		expect(screenById(screen.id).id).toBe(screen.id);
		expect(screenById(screen.id).label).toBe(screen.label);
	}
	expect(() => screenById("nonsense" as never)).toThrow();
});

test("every nav item's identity comes from the registry, not a second table", () => {
	// The nav carries labels resolved through `screenById`; a label that disagrees
	// with the registry is the drift this whole refactor is about.
	for (const item of NAV_GROUPS.flatMap(group => group.items)) {
		expect(screenById(item.id as never).label).toBe(item.label);
	}
});

// ---------------------------------------------------------------------------
// The structural guard, because a behavioural one CANNOT catch this
// ---------------------------------------------------------------------------

/**
 * WHY THIS TEST EXISTS ALONGSIDE THE BEHAVIOURAL ONES ABOVE.
 *
 * Every behavioural assertion here was checked against a mutation that
 * re-introduces a second screen list — and ALL OF THEM STILL PASSED. That is not
 * a gap in those tests; it is the reason this one exists.
 *
 * So the invariant is asserted where the duplication would live: the SOURCE.
 * Neither consumer may name the deleted IR spec table, and both must obtain
 * identity from the registry.
 */
test("both consumers derive identity from the registry, not a private table", async () => {
	const panel = await Bun.file(`${import.meta.dir}/../src/tui/panel.ts`).text();
	const chrome = await Bun.file(`${import.meta.dir}/../src/tui/chrome.ts`).text();
	expect(panel).toContain("SELECTABLE_SCREENS");
	expect(panel).not.toContain("specById");
	expect(panel).not.toContain("isDrawableScreen");
	expect(chrome).toContain("screenById");
	expect(chrome).not.toContain("specForScreen");
});
