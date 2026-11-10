/**
 * `test/screens.test.ts` — ONE screen list, and the test that says so.
 *
 * WHAT THIS FILE PINS. Two modules used to answer "is this a screen?" from the
 * same two inputs — the `SCREENS` registry and the `SCREEN_SPECS` table — with
 * two different rules:
 *
 *   - `panel.ts`'s `SELECTABLE_SCREENS` filtered the registry to ids with a
 *     spec;
 *   - `chrome.ts`'s `NAV_GROUPS` filtered a hand-written group map to ids with a
 *     spec AND a jump hotkey.
 *
 * Nothing connected them. Each was internally consistent, so the failure mode was
 * silent and asymmetric: a screen could become arrow-selectable while vanishing
 * from the sidebar, or appear in the nav with no body to draw, and every test in
 * the suite would still pass because each module was only ever compared with
 * itself. That is the class of duplication that let a real bug survive several
 * passes here.
 *
 * Both now derive from {@link isDrawableScreen}. These tests are the reason that
 * stays true.
 */

import { expect, test } from "bun:test";

import { NAV_GROUPS, screenForHotkey } from "../src/tui/chrome";
import { SELECTABLE_SCREENS, panelAction, specById } from "../src/tui/panel";
import { SCREENS, screenById } from "../src/tui/screens/types";
import { isDrawableScreen, specForScreen, SCREEN_SPECS } from "../src/layout/spec";

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

test("neither list can contain a screen the IR cannot draw", () => {
	// Both are derived from one predicate, so this is the invariant that would break
	// FIRST if someone reintroduced a second rule.
	for (const id of SELECTABLE_SCREENS.map(screen => screen.id)) expect(isDrawableScreen(id), id).toBe(true);
	for (const id of NAV_GROUPS.flatMap(group => group.items.map(item => item.id))) {
		expect(isDrawableScreen(id), id).toBe(true);
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
		expect(screenForHotkey(item.hotkey), item.id).toBe(item.id);
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
// The predicate itself
// ---------------------------------------------------------------------------

test("isDrawableScreen is the one rule, and it agrees with having a usable spec", () => {
	for (const spec of SCREEN_SPECS) {
		expect(isDrawableScreen(spec.id), spec.id).toBe(true);
	}
});

test("specById and specForScreen are the same lookup", () => {
	// `panel.ts`'s `specById` is now a delegation, so the panel's two questions
	// about the spec table cannot be answered by two different tables.
	for (const id of [...SELECTABLE_SCREENS.map(s => s.id), "traces", "nonsense"]) {
		expect(specById(id as never)?.id).toBe(specForScreen(id)?.id);
	}
});

test("every selectable screen's registry entry agrees with its spec", () => {
	// The registry carries identity; the IR carries the body. A screen
	// in one and not the other is the drift this whole refactor is about.
	for (const screen of SELECTABLE_SCREENS) {
		expect(screenById(screen.id).id).toBe(screen.id);
		expect(specById(screen.id)?.id).toBe(screen.id);
	}
});

// ---------------------------------------------------------------------------
// The structural guard, because a behavioural one CANNOT catch this
// ---------------------------------------------------------------------------

/**
 * WHY THIS TEST EXISTS ALONGSIDE THE BEHAVIOURAL ONES ABOVE.
 *
 * Every behavioural assertion here was checked against a mutation that
 * re-introduces the duplication — replacing `NAV_GROUPS`' call to
 * `isDrawableScreen` with its own private `spec !== undefined` rule — and ALL
 * FOURTEEN STILL PASSED. That is not a gap in those tests; it is the reason this
 * one exists.
 *
 * The two rules are currently EQUIVALENT, so a duplicated rule is behaviourally
 * INVISIBLE: it cannot be found by comparing outputs, because the outputs are
 * identical. Every behavioural test for "these cannot drift" is therefore vacuous
 * until the rules actually diverge — which is exactly the moment nobody is
 * watching.
 *
 * So the invariant is asserted where the duplication actually lives: the SOURCE.
 * Both modules must obtain "drawable" from the one predicate and neither may
 * re-state the rule. That is a fact about the code rather than about one run of
 * it, and it holds before the rules diverge as well as after.
 */
test("both screen lists derive drawability from the ONE predicate, not a private rule", async () => {
	for (const file of ["src/tui/panel.ts", "src/tui/chrome.ts"]) {
		const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
		expect(source, `${file} must call isDrawableScreen`).toContain("isDrawableScreen");
		// Neither consumer may read `deferred` AT ALL. They both delegate entirely,
		// so a `.deferred` anywhere in either file is a re-stated rule however it is
		// spelled — `!spec.deferred`, `spec?.deferred`, `specById(id)!.deferred`.
		// A pattern narrow enough to catch only one spelling was tried first and let
		// a `specById(...)!.deferred` re-statement through, which is the same trap
		// this guard exists to close.
		expect(source, `${file} must not read \`deferred\` itself`).not.toContain(".deferred");
	}
});

test("the predicate lives in the IR, so neither consumer owns the truth", async () => {
	// If it were moved into either consumer, one would own the truth and the other
	// would import it — the same coupling with a dependency edge added.
	const spec = await Bun.file(`${import.meta.dir}/../src/layout/spec.ts`).text();
	expect(spec).toContain("export function isDrawableScreen");
});
