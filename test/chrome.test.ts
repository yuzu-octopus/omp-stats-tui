/**
 * Web-shell chrome port: sidebar nav, topbar, live chip, progress line.
 *
 * Source of truth is the omp-stats web Shell (read-only host files, never
 * modified): `app/Shell.tsx` (topbar + sidebar + progress three-state),
 * `app/nav.ts` (NAV groups, hotkeys), `app/LiveChip.tsx` (chip branch order),
 * `client/data/range.ts` (TIME_RANGES order). Every behavior below cites the
 * web line it mirrors; deviations are marked OURS with reasoning.
 *
 * KEYMAP DECISION (the brief asks for it stated once):
 * - Web binds `1`-`6` to RANGES and `g then letter` to sections (Shell.tsx
 *   useShortcuts). We mirror `g then letter` for screens, but we do NOT mirror
 *   digits-as-range: our digits already select screens (`1`-`9`/`0`, enforced by
 *   the number-row block at the end of this file), and a digit cannot pick both
 *   a range and a screen. Range stays on `r`/`R` cycle.
 * - So digits and `g`-letters are ALIASES for the same target (screen): `1`
 *   and `g o` both land on overview. No collision is possible because the two
 *   sequences share no prefix key: digits act immediately, letters act only
 *   while a `g` prefix is armed (1200 ms window, Shell.tsx parity).
 * - Consequence, mirrored exactly from the web: while the prefix is armed the
 *   next letter is CONSUMED even on no match — so `g r` jumps to requests and
 *   never cycles the range, `g s` does not start a sync, `g 1` does nothing.
 *   A stale prefix (>1200 ms) falls through to the normal keymap, exactly as
 *   the web's timestamp check does (no timer, no visual indicator, same as web).
 * - Hotkeys are the web's verbatim (nav.ts) except `activity`, which has no web
 *   section (OURS: `a`). `NAV_GROUPS` keeps a row only when `specForScreen` and
 *   `isDrawableScreen` agree there is a body to draw, so a spec-less screen gets
 *   neither a sidebar row nor a letter — a jump that paints a page the panel
 *   cannot honestly fill wastes the keystroke. Today every entry of
 *   `SELECTABLE_SCREENS` clears that filter, so all twelve have a row and a
 *   letter; `traces` and `frustration` (`g t`, `g f`) are the two screens PAST
 *   THE NUMBER ROW, not jump exceptions.
 */
import { expect, test } from "bun:test";
import { ensureThemeSync, setSymbolPreset, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

import { SCREEN_SPECS } from "../src/layout/spec";
import {
	JUMP_TIMEOUT_MS,
	NAV_GROUPS,
	SIDEBAR_ZIP_PREFIX,
	ago,
	chipFor,
	progressLineFor,
	screenForHotkey,
	sidebar,
	topbar,
	zipSidebar,
	type NavGroup,
} from "../src/tui/chrome";
import { SELECTION_BG, SIDEBAR_INK, TAB_INK } from "../src/tui/palette";
import { __testing, SELECTABLE_SCREENS, panelAction } from "../src/tui/panel";
import type { SyncEvent } from "../src/sync/client";
import { liveData } from "./fixtures/panel";

ensureThemeSync();

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ESC = String.fromCharCode(27);
const FG_RESET = `${ESC}[39m`;
const BG_RESET = `${ESC}[49m`;
const SGR = /\x1b\[([0-9;]*)m/g;

type ThemeColor = Parameters<typeof theme.fg>[0];
type ThemeBg = Parameters<typeof theme.bg>[0];

/**
 * The SGR the host writes to put `token` on the wire, with no payload between it
 * and the trailing reset.
 *
 * `theme.fg(token, "")` is already exactly that — a zero-length payload between
 * the same two escapes the renderer writes around real text — so splitting on
 * the reset leaves the select sequence alone.
 *
 * `text` selects NOTHING. It IS the terminal's default foreground, which is why
 * `SIDEBAR_INK.headingActive` and `.rowActive` are `text` (the web's `--ink-1`
 * IS the default text colour), and so its escape is the empty string.
 *
 * WHY A PREFIX AND NOT A COLOUR. Under `256color` the host quantises on the way
 * out, so the wire carries `38;5;N` where a truecolor host carries
 * `38;2;R;G;B` for the SAME token — `getColorHex("dim")` says `#5f6673` while an
 * 8-bit host writes index 242. Decoding those parameters would turn every
 * assertion below into a claim about the host's quantiser, which is a property
 * of the runner's TTY rather than of this repo: the tests then go red on CI for
 * saying nothing about the palette, and go green again on a maintainer's laptop
 * for the same reason. Nothing here decodes a parameter. Both sides of every
 * comparison come from the same encoder in the same process, so the answer is
 * the same in either encoding.
 */
const inkEscape = (token: ThemeColor): string => theme.fg(token, "").split(FG_RESET)[0] ?? "";

/** The `--selected` band prefix, {@link inkEscape} on the background axis. */
const ACTIVE_BG = theme.bg(SELECTION_BG.band, "").split(BG_RESET)[0] ?? "";

/**
 * The tokens the sidebar can paint with, deduplicated. Several ROLES share one
 * token (`headingActive`, `rowActive` and `rowHover` are all the default
 * foreground) and a role is not an identity — the theme token is, so that is
 * what every assertion in this file compares.
 */
const INK_TOKENS: readonly ThemeColor[] = [...new Set(Object.values(SIDEBAR_INK))];

/** The inverse map every ink assertion in this file reads through: from the
 * escape on the wire back to the token that asked for it, for the live
 * rendering in whatever colour mode this process resolved. */
const INK_BY_ESCAPE: ReadonlyMap<string, ThemeColor> = new Map(
	INK_TOKENS.map(token => [inkEscape(token), token]),
);

/**
 * The TOKEN every visible run of `line` was painted with, in order.
 *
 * Each SGR is applied to a running foreground state exactly as a terminal would
 * apply it, and the gaps between SGRs that contain visible characters become
 * entries. Background and weight sequences leave the foreground alone.
 *
 * `\x1b[39m` and a bare full reset both put the foreground back to the terminal
 * default, which is the `text` token — it emits no select escape at all, only a
 * trailing reset — and "unset" is not a state the wire can express.
 *
 * An escape that no declared token asked for is reported AS ITSELF rather than
 * dropped, so a run wearing an undeclared colour fails the assertion that names
 * its position instead of quietly vanishing from the array.
 */
const resolveInks = (line: string, lookup: ReadonlyMap<string, ThemeColor>): string[] => {
	const runs: string[] = [];
	let current: string = "text";
	let cursor = 0;
	for (const match of line.matchAll(SGR)) {
		if (line.slice(cursor, match.index).trim() !== "") runs.push(current);
		const params = match[1] ?? "";
		if (params === "" || params === "0" || params === "39") current = "text";
		else if (params.startsWith("38;")) current = lookup.get(match[0]) ?? match[0];
		cursor = match.index + match[0].length;
	}
	if (line.slice(cursor).trim() !== "") runs.push(current);
	return runs;
};

/** {@link resolveInks} over the live rendering. */
const inksIn = (line: string): string[] => resolveInks(line, INK_BY_ESCAPE);

/**
 * `token` as an 8-bit terminal receives it: the index the host's quantiser
 * picks out of the 256-colour palette. Derived from `getColorHex` plus Bun's own
 * quantiser rather than from `theme.fg`, so it is `38;5;N` whether or not the
 * runner happens to have a truecolor terminal. That is what lets the test below
 * pin the 8-bit path WITHOUT asking the environment for it.
 */
const eightBitInkEscape = (token: ThemeColor): string =>
	token === "text" ? "" : Bun.color(theme.getColorHex(token), "ansi-256") ?? "";

const EIGHT_BIT_BY_ESCAPE: ReadonlyMap<string, ThemeColor> = new Map(
	INK_TOKENS.map(token => [eightBitInkEscape(token), token]),
);

/**
 * Every SELECTING foreground on `line`, re-emitted the way an 8-bit terminal
 * reads it. `\x1b[39m` is deliberately left alone: the default foreground is not
 * a colour, so quantising it would be inventing something, and deleting it
 * would drop the reset that ends the run before it.
 */
const asEightBit = (line: string): string =>
	line.replace(
		SGR,
		(esc, params: string) =>
			params.startsWith("38;") ? eightBitInkEscape(INK_BY_ESCAPE.get(esc) ?? "text") : esc,
	);


/** Frame row index of a nav GROUP HEADING, derived from NAV_GROUPS. These used
 * to be the literals 4 and 8, which shifted the moment `providers` joined Usage
 * and silently moved the thing these tests are about. */
const headingRowOf = (heading: string): number => {
	let row = 0;
	for (const g of NAV_GROUPS) {
		if (g.heading === heading) return row;
		row += 1 + g.items.length;
	}
	throw new Error(`no nav heading ${heading}`);
};
/** Frame row index of a nav ROW, derived the same way. */
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

const idle = (over: Record<string, unknown> = {}) => ({
	syncing: false,
	current: 0,
	total: 0,
	determinate: false,
	error: null as string | null,
	dirtyHours: 0,
	lastSyncedAt: null as number | null,
	now: 1_000_000,
	...over,
});

// ─── nav groups: the web's NAV, minus screens we cannot draw ─────────────────

test("nav groups are Usage / Activity / Insights in web order, with the drawable subset", () => {
	expect(NAV_GROUPS.map(g => g.heading)).toEqual(["Usage", "Activity", "Insights"]);
	const ids = NAV_GROUPS.flatMap(g => g.items.map(i => i.id));
	// Derived from SELECTABLE_SCREENS, never restated: every screen the arrow
	// keys can land on has a nav row, in nav-group order. This used to be a
	// literal eight-id list, which is how `providers` and `gain` came to be
	// reachable with no row to show them on.
	expect(ids).toEqual(SELECTABLE_SCREENS.map(s => s.id).sort(
		(a, b) => ids.indexOf(a) - ids.indexOf(b),
	));
});

test("every nav label matches the layout IR, so the sidebar cannot drift from the strip", () => {
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			const spec = SCREEN_SPECS.find(s => s.id === item.id);
			expect(spec, item.id).toBeDefined();
			expect(item.label, item.id).toBe(spec!.label);
		}
	}
});

test("hotkeys are the web's verbatim; tools takes l because t is traces'", () => {
	const seen: Record<string, string> = {};
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			expect(item.hotkey, item.id).toMatch(/^[a-z]$/);
			expect(seen[item.hotkey], `${item.id} collides on ${item.hotkey}`).toBeUndefined();
			seen[item.hotkey] = item.id;
		}
	}
	expect(seen["o"]).toBe("overview");
	expect(seen["m"]).toBe("models");
	expect(seen["c"]).toBe("costs");
	expect(seen["r"]).toBe("requests");
	expect(seen["e"]).toBe("errors");
	expect(seen["l"]).toBe("tools");
	expect(seen["j"]).toBe("projects");
	// OURS: activity has no web section, so it takes the free initial.
	expect(seen["a"]).toBe("activity");
});

test("screenForHotkey resolves case-insensitively; undrawable screens have no hotkey", () => {
	expect(screenForHotkey("o")).toBe("overview");
	expect(screenForHotkey("O")).toBe("overview");
	expect(screenForHotkey("r")).toBe("requests");
	expect(screenForHotkey("l")).toBe("tools");
	expect(screenForHotkey("g")).toBeNull();
	expect(screenForHotkey("p")).toBeNull();
	expect(screenForHotkey("1")).toBeNull();
	expect(screenForHotkey("")).toBeNull();
});

test("the jump window matches the web's 1200 ms", () => {
	expect(JUMP_TIMEOUT_MS).toBe(1200);
});

// ─── sidebar ─────────────────────────────────────────────────────────────────

test("sidebar has one row per screen under its group heading, with a G-letter hint", () => {
	const { width, lines } = sidebar(theme, "unicode", "overview");
	const plain = lines.map(strip);
	// Derived from NAV_GROUPS, never restated: one heading row per group plus one
	// row per screen. This was `3 + 8` and went stale when `providers` and `gain`
	// gained nav rows.
	expect(plain).toHaveLength(NAV_GROUPS.reduce((n, g) => n + 1 + g.items.length, 0));
	// Every row carries the host's 2-column prefix slot: cursor + space when
	// selected, two spaces otherwise (settings-list.ts:939-940).
	expect(plain[0]!.trim()).toBe("Usage");
	expect(plain[headingRowOf("Activity")]!.trim()).toBe("Activity");
	expect(plain[headingRowOf("Insights")]!.trim()).toBe("Insights");
	expect(plain[1]).toMatch(/Overview/);
	expect(plain[1]).toMatch(/G O/);
	expect(plain[navRowOf("requests")]).toMatch(/Requests/);
	expect(plain[navRowOf("requests")]).toMatch(/G R/);
	for (const line of plain) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	expect(width).toBeLessThanOrEqual(26);
});

test("the active sidebar row wears the web's selected fill, with the accent ONLY on its icon", () => {
	// `.nav-row[data-active="true"]` is `background: var(--selected); color:
	// var(--ink-1)` (styles.css:547-550) and only its `svg` takes the accent
	// (:557-559). So the ACTIVE NAV ROW IS A FILLED ROW with an ink-1 label —
	// ours painted accent TEXT on no fill, which is why the nav read as a list of
	// coloured words instead of a control with a position in it.
	//
	// The 2-cell cursor prefix stays (settings-list.ts:939-940): the web tells
	// active from hover with background ALPHA, which no terminal can render.
	const { lines } = sidebar(theme, "unicode", "costs");
	const active = lines.find(l => strip(l).includes("Costs"));
	expect(active).toBeDefined();
	expect(strip(active!)).toStartWith(`${theme.nav.cursor} `);
	expect(active!).toContain(ACTIVE_BG);
	// Exactly ONE accent run on the row: the icon. Label and cursor are ink-1,
	// and the jump hint is ink-4 — the web's own three rungs for that row.
	expect(inksIn(active!).filter(ink => ink === SIDEBAR_INK.iconActive)).toHaveLength(1);
	expect(inksIn(active!)).toContain(SIDEBAR_INK.rowActive);
	expect(inksIn(active!).at(-1)).toBe(SIDEBAR_INK.jumpKey);
	// No other row gets the fill: one selected row per panel.
	for (const line of lines) {
		if (line === active) continue;
		expect(line).not.toContain(ACTIVE_BG);
	}
});

test("the group headings are two different levels, not one colour repeated three times", () => {
	// THE REPORTED DEFECT: "the sidebar group headings are all the same colour".
	// Two of the three were `muted`, so the only heading that differed was the
	// one in the active group — and it differed by HUE, the same hue the active
	// ROW's icon uses, so the heading stopped being structure and became another
	// selection marker.
	//
	// `.nav-heading` is `--ink-3` @500 (styles.css:515-520) for every group and
	// the web has NO active-group variant. The active group's heading stepping up
	// one ink is OURS, and it borrows the web's own selection rule — `.nav-row`
	// ink-2 → `[data-active]` ink-1 (styles.css:547-550) — rather than inventing
	// one.
	const { lines } = sidebar(theme, "unicode", "overview");
	expect(strip(lines[0]!).trim()).toBe("Usage");
	expect(strip(lines[headingRowOf("Activity")]!).trim()).toBe("Activity");
	expect(inksIn(lines[0]!)).toEqual([SIDEBAR_INK.headingActive]);
	expect(inksIn(lines[headingRowOf("Activity")]!)).toEqual([SIDEBAR_INK.headingInactive]);
	// Two different colours, not merely different weights — asserted on the
	// RENDER, so a theme that ever merged the two inks fails HERE, naming the
	// level, rather than satisfying a comparison of two constants.
	expect(inksIn(lines[0]!)).not.toEqual(inksIn(lines[headingRowOf("Activity")]!));
	expect(lines[0]!).not.toBe(lines[4]!);
	// A heading is never a row: no cursor, no jump key.
	expect(lines[headingRowOf("Activity")]!).not.toContain(theme.nav.cursor);
	expect(strip(lines[headingRowOf("Activity")])).not.toMatch(/G [A-Z]/);
});

test("the four sidebar levels are four different renderings, each tied to its own token", () => {
	// The acceptance test for the hierarchy. Four levels — heading-active,
	// heading-inactive, active row, inactive row — that must not be textually
	// identical and must each paint with the token its role names.
	const { lines } = sidebar(theme, "unicode", "overview");
	const headingActive = lines[0]!; // "Usage"
	const rowActive = lines[1]!; // Overview
	const rowInactive = lines[navRowOf("models")]!;
	const headingInactive = lines[headingRowOf("Activity")]!;
	const four = [headingActive, headingInactive, rowActive, rowInactive];
	expect(new Set(four).size, "two sidebar levels rendered byte-identically").toBe(4);

	expect(inksIn(headingActive)).toEqual([SIDEBAR_INK.headingActive]);
	expect(inksIn(headingInactive)).toEqual([SIDEBAR_INK.headingInactive]);
	// An inactive row is exactly three runs: icon, label, jump hint — one level
	// each, which is the whole claim that a row is not a flat line of text.
	expect(inksIn(rowInactive)).toEqual([
		SIDEBAR_INK.iconInactive,
		SIDEBAR_INK.rowInactive,
		SIDEBAR_INK.jumpKey,
	]);
	// The active row is the same three runs with the icon stepped to the accent,
	// plus the cursor in the label's ink — so no heading level leaks into it.
	expect(inksIn(rowActive)).toEqual([
		SIDEBAR_INK.rowActive,
		SIDEBAR_INK.iconActive,
		SIDEBAR_INK.rowActive,
		SIDEBAR_INK.jumpKey,
	]);
});

test("a row's jump hint is the faintest run on that row", () => {
	// `.nav-row kbd` is `--ink-4` (styles.css:565-570) against a `--ink-2` label:
	// one full ink step below, so the hint never competes with what it annotates.
	// Ours painted it `dim`, which is the heading's ink, so the hint and the
	// structure above it were the same colour.
	for (const id of ["overview", "models", "costs"]) {
		const { lines } = sidebar(theme, "unicode", id);
		const rows = lines.filter(l => /G [A-Z]$/.test(strip(l)));
		expect(rows.length).toBe(NAV_GROUPS.reduce((n, g) => n + g.items.length, 0));
		for (const line of rows) {
			expect(inksIn(line).at(-1), "the jump hint is the last run").toBe(SIDEBAR_INK.jumpKey);
		}
	}
});

test("the row icon is a level of its own, quieter than its label", () => {
	// `.nav-row svg { color: var(--ink-3) }` against a `--ink-2` label
	// (styles.css:552-555): the icon is chrome for the label, not more label.
	// Ours painted icon and label the same colour, so each row was one flat run.
	const inactive = sidebar(theme, "unicode", "models").lines.find(l => strip(l).includes("Costs"))!;
	expect(inksIn(inactive).slice(0, 2)).toEqual([
		SIDEBAR_INK.iconInactive,
		SIDEBAR_INK.rowInactive,
	]);
	expect(SIDEBAR_INK.iconInactive).not.toBe(SIDEBAR_INK.rowInactive);
	// The ACTIVE row's icon is the ONE accent on the row (styles.css:557-559),
	// and its LABEL is not: the active row is ink-1 with an accent glyph.
	const active = sidebar(theme, "unicode", "costs").lines.find(l => strip(l).includes("Costs"))!;
	expect(inksIn(active)[1]).toBe(SIDEBAR_INK.iconActive);
	expect(inksIn(active)[0]).toBe(SIDEBAR_INK.rowActive);
	expect(inksIn(active)[2]).toBe(SIDEBAR_INK.rowActive);
	expect(SIDEBAR_INK.iconActive).not.toBe(SIDEBAR_INK.rowActive);
});

test("hover and active share the band and the label ink, and differ by the three cues the web has", () => {
	// `.nav-row:hover` is `background: var(--hover); color: var(--ink-1)`
	// (styles.css:538-541); `[data-active]` is `background: var(--selected);
	// color: var(--ink-1)` (:547-550). The web separates those two states by
	// background ALPHA ALONE — 0.035 against 0.075 — and a terminal has one
	// background token and no alpha, so the terminal has to spend the difference
	// elsewhere. It spends it on the three cues the web already owns and which a
	// hover row never gets: the accent icon, the cursor, and the weight.
	const { lines } = sidebar(theme, "unicode", "overview", "models");
	const hovered = lines.find(l => strip(l).includes("Models"))!;
	const active = lines.find(l => strip(l).includes("Overview"))!;
	// Same band, same label ink — exactly the web's ink-1.
	expect(hovered).toContain(ACTIVE_BG);
	expect(inksIn(hovered)[1]).toBe(SIDEBAR_INK.rowHover);
	expect(inksIn(active)[2]).toBe(SIDEBAR_INK.rowActive);
	// And three differences, none of them the fill.
	expect(inksIn(hovered)[0]).not.toBe(inksIn(active)[1]); // icon: ink-3, not accent
	expect(strip(hovered)).not.toStartWith(theme.nav.cursor); // no cursor
	// Weight, asserted against `theme.bold`'s OWN escape rather than a literal
	// `\x1b[1m`: the host's styler is a no-op wherever colour is unavailable,
	// which is every non-TTY runner — CI among them — so a literal would pass
	// there without ever having looked at the row.
	// `theme.bold` WRAPS rather than prefixes, so the opener is what precedes the
	// payload and the closer what follows it; take the opener, or the assertion
	// would look for two escapes adjacent in a string where they never are.
	const BOLD = theme.bold("x").split("x")[0] ?? "";
	if (BOLD) {
		expect(active).toContain(BOLD);
		expect(hovered).not.toContain(BOLD);
	}
	expect(hovered).not.toBe(active);
	// A hovered ID that names a group HEADING paints nothing special: the
	// heading is structure, not a target, so hovering it must not band it. The
	// active row still carries its own band, so only the heading row is checked.
	const { lines: plain } = sidebar(theme, "unicode", "overview", "Usage");
	expect(plain[0]).toBe(lines[0]);
	expect(plain[0]).not.toContain(ACTIVE_BG);
});

test("the ink ladder reads the same tokens out of an 8-bit rendering", () => {
	// The property every ink assertion in this file rests on: a run's identity is
	// the TOKEN that asked for it, and an 8-bit host writing `38;5;242` where a
	// truecolor host writes `38;2;95;102;115` has asked for the SAME token.
	//
	// Pinned here by BUILDING the 8-bit form out of `getColorHex` and Bun's own
	// quantiser, so this test runs identically on a developer's truecolor
	// terminal and on a TTY-less CI box, instead of inheriting whichever one the
	// runner happened to be.
	expect(eightBitInkEscape(SIDEBAR_INK.iconActive)).toStartWith(`${ESC}[38;5;`);
	const ladder = [
		SIDEBAR_INK.rowActive,
		SIDEBAR_INK.iconActive,
		SIDEBAR_INK.rowActive,
		SIDEBAR_INK.jumpKey,
	];
	const eightBitRow = ladder.map(t => `${eightBitInkEscape(t)}X${FG_RESET}`).join("");
	expect(resolveInks(eightBitRow, EIGHT_BIT_BY_ESCAPE)).toEqual(ladder);
	// And the frames the sidebar REALLY renders, every foreground re-emitted at 8
	// bits, resolve to the identical token sequence.
	for (const id of ["overview", "costs", "requests"]) {
		for (const line of sidebar(theme, "unicode", id, "models").lines) {
			expect(resolveInks(asEightBit(line), EIGHT_BIT_BY_ESCAPE)).toEqual(inksIn(line));
		}
	}
});

test("the sidebar inks stay distinguishable at this terminal's colour depth", () => {
	// `inksIn` reports tokens, so it cannot separate two inks the host has already
	// quantised onto one 8-bit index — and at that point the ladder really has
	// collapsed on this terminal. That is a real defect, so it gets one named
	// assertion here rather than a baffling failure three tests further down.
	const pairs: [what: string, a: ThemeColor, b: ThemeColor][] = [
		["group heading: active vs inactive", SIDEBAR_INK.headingActive, SIDEBAR_INK.headingInactive],
		["inactive row: icon vs label", SIDEBAR_INK.iconInactive, SIDEBAR_INK.rowInactive],
		["active row: icon vs label", SIDEBAR_INK.iconActive, SIDEBAR_INK.rowActive],
		["label vs jump hint", SIDEBAR_INK.rowInactive, SIDEBAR_INK.jumpKey],
	];
	for (const [what, a, b] of pairs) {
		expect(a, `${what}: the roles must name different tokens`).not.toBe(b);
		expect(inkEscape(a), `${what}: indistinguishable on this terminal`).not.toBe(inkEscape(b));
	}
});

test("an omitted hover id paints byte-identical output to the 3-arg call", () => {
	expect(sidebar(theme, "unicode", "overview")).toEqual(sidebar(theme, "unicode", "overview", undefined));
	expect(sidebar(theme, "unicode", "overview")).toEqual(sidebar(theme, "unicode", "overview", null));
});

test("sidebar columns align: icon gutter, label column, and a right-aligned jump-key column", () => {
	// Defect 4. The web's `.nav-row` is `display: flex` with
	// `.nav-row-label { flex: 1 }` and the `kbd` after it
	// (styles.css:522-573) — so the jump hint is pushed to the ROW'S TRAILING
	// EDGE, right-aligned across every row. Ours appended `G <letter>` right
	// after a variable-length label, so the hints formed a ragged staircase and
	// the rows read as prose. These assertions pin the column geometry.
	const { width, lines } = sidebar(theme, "unicode", "overview");
	const plain = lines.map(strip);
	const bodyRows = plain.filter(row => /G [A-Z]$/.test(row));
	expect(bodyRows).toHaveLength(NAV_GROUPS.reduce((n, g) => n + g.items.length, 0));

	// Every jump key ends in the SAME cell — the trailing edge, as in the web
	// where `.nav-row-label { flex: 1 }` pushes the `kbd` to the row's end.
	expect(bodyRows.every(row => visibleWidth(row) === width)).toBe(true);

	// The ICON occupies one fixed gutter cell on every row, so every label
	// starts in one column regardless of which icon the preset drew. Scoped to
	// body rows because `Activity` is BOTH a group heading and a screen label —
	// a collision the web's own nav shares (nav.ts: `Usage`/`Activity`/`Insights`
	// headings with an `Activity` item in the second).
	// Measured in CELLS, not UTF-16 units: the emoji icons are surrogate pairs,
	// so `String.indexOf` reports different offsets for rows whose labels sit
	// in the same terminal column.
	const labelColumn = (label: string): number => {
		const row = bodyRows.find(candidate => candidate.includes(label))!;
		return visibleWidth(row.slice(0, row.indexOf(label)));
	};
	const labels = NAV_GROUPS.flatMap(g => g.items.map(i => i.label));
	const columns = labels.map(labelColumn);
	expect(new Set(columns).size).toBe(1);

	// Group headings carry no jump key, so structure never reads as content —
	// the web's `.nav-heading` is a plain 12px label (styles.css:515-520).
	const headings = plain.filter(row => /^\s*(Usage|Activity|Insights)\s*$/.test(row));
	expect(headings).toHaveLength(3);
	for (const heading of headings) expect(heading).not.toMatch(/G [A-Z]/);
});

test("sidebar rows stay within one cell of each other, so the column has no ragged edge", () => {
	// A ragged right edge is what made the block read as text rather than as a
	// control. Every body row is padded to the block's common width, and the
	// heading rows are padded to the same width, so the whole sidebar is one
	// rectangle.
	const { width, lines } = sidebar(theme, "unicode", "overview");
	for (const line of lines) expect(visibleWidth(line)).toBe(width);
	expect(width).toBeLessThanOrEqual(26);
});

test("sidebar rows are one rectangle on every preset, even though the block width follows the icon gutter", () => {
	// The gutter is data ink, so the block width legitimately tracks the
	// preset's icon width (1 cell nerd, 2 unicode, up to 4 ascii). What must
	// hold on every preset is INTERNAL consistency: all rows, headings
	// included, are padded to one common width, so the sidebar never reads as a
	// ragged block of text.
	for (const preset of ["unicode", "nerd", "ascii"] as const) {
		const { width, lines } = sidebar(theme, preset, "costs");
		expect(width, preset).toBeGreaterThan(0);
		expect(width, preset).toBeLessThanOrEqual(26);
		for (const line of lines) expect(visibleWidth(line), preset).toBe(width);
	}
});

test("sidebar paints an INJECTED nav list through the same geometry, not a fork", () => {
	// The showcase's sections are not screen ids, so the nav must be a PARAMETER.
	// This is the seam `showcase/nav.ts` asked for: same measurements, same ink
	// ladder, same hover/active rules, different rows.
	const injected: readonly NavGroup[] = [
		{ heading: "Grammar", items: [
			{ id: "tiles", label: "Tiles", hotkey: "t", icon: "tokens" },
			{ id: "charts", label: "Charts", hotkey: "c", icon: "cost" },
		] },
		{ heading: "Edges", items: [{ id: "awkward", label: "Awkward", hotkey: "a", icon: "warning" }] },
	];
	const { width, lines } = sidebar(theme, "unicode", "charts", null, injected);
	const plain = lines.map(strip);
	expect(plain).toHaveLength(5);
	expect(plain[0]!.trim()).toBe("Grammar");
	expect(plain[1]).toContain("Tiles");
	expect(plain[1]).toContain("G T");
	expect(plain[2]).toContain("Charts");
	expect(plain[2]).toContain("G C");
	expect(lines[2]).toContain(ACTIVE_BG);
	expect(plain[3]!.trim()).toBe("Edges");
	expect(plain[4]).toContain("Awkward");
	for (const line of plain) expect(visibleWidth(line)).toBe(width);
	// The injected list is cached separately from the real nav.
	expect(sidebar(theme, "unicode", "overview").lines).not.toEqual(lines);
});

test("zipSidebar keeps the whole nav when the body is shorter, and its prefix is the declared constant", () => {
	// The nav sets a FLOOR on the frame: a short body pads the body, never clips
	// the nav. The prefix is `sidebarWidth + SIDEBAR_ZIP_PREFIX`, the number the
	// body plan subtracts, so the two cannot drift.
	const zipped = zipSidebar(theme, ["one"], ["A", "B", "C"], 1, "unicode");
	expect(zipped).toHaveLength(3);
	expect(strip(zipped[0]!)).toBe("A │ one");
	expect(strip(zipped[1]!).startsWith("B ")).toBe(true);
	expect(strip(zipped[2]!).startsWith("C ")).toBe(true);
	expect(strip(zipped[0]!).indexOf("one")).toBe(1 + SIDEBAR_ZIP_PREFIX);
});

test("the sidebar gutter is the dim column bar, settings split-layout parity", () => {
	// settings-list.ts:989: the split column separator is theme.hint("│ ").
	// panel.ts zips sidebar and body with the same dim bar between them.
	const panel = __testing.makePanel({ data: liveData(), rows: 40 });
	return __testing.settled(panel).then(() => {
		const frame = panel.render(100).map(strip);
		const navRow = frame.find(row => row.includes("Overview") && row.includes("G O"));
		expect(navRow).toBeDefined();
		expect(navRow!).toMatch(/│/);
	});
});

test("the sidebar gutter follows the preset: │ under unicode, | under ascii", async () => {
	// Follow-up to the gutter commit: `#bodyLines` hardcoded "│", so ascii
	// rendered a unicode bar in an ascii frame. The gutter is data ink, so it
	// comes from glyph(preset, "columnGap") like every other mark. Asserted
	// by ABSENCE under ascii: the frame borders are "|" and "+" there, so any
	// remaining "│" is the hardcoded gutter leaking through.
	const current = theme.getSymbolPreset();
	await setSymbolPreset("unicode");
	const upanel = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(upanel);
	const urow = upanel.render(100).map(strip).find(row => row.includes("Overview") && row.includes("G O"));
	expect(urow).toBeDefined();
	expect(urow!).toContain("│");
	await setSymbolPreset("ascii");
	const apanel = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(apanel);
	const arow = apanel.render(100).map(strip).find(row => row.includes("Overview") && row.includes("G O"));
	expect(arow).toBeDefined();
	expect(arow!).not.toContain("│");
	expect(arow!).toContain("|");
	await setSymbolPreset(current);
});
// ─── live chip: LiveChip.tsx branch order, minus connected ────────────────────

test("chip shows Live only when settled: syncing, error and backlog all override it", () => {
	expect(strip(chipFor(theme, idle()))).toMatch(/Live/);
	expect(strip(chipFor(theme, idle({ syncing: true })))).toMatch(/Syncing/);
	expect(strip(chipFor(theme, idle({ error: "boom" })))).toMatch(/Sync failed/);
	expect(strip(chipFor(theme, idle({ dirtyHours: 30 })))).toMatch(/Indexing/);
	expect(strip(chipFor(theme, idle({ dirtyHours: 30 })))).toMatch(/30h left/);
	// A handful of dirty hours is normal churn (LiveChip.tsx INDEXING_VISIBLE_HOURS = 24).
	expect(strip(chipFor(theme, idle({ dirtyHours: 24 })))).toMatch(/Live/);
});

test("chip shows the count only when the total is known, mirroring total > 0", () => {
	expect(strip(chipFor(theme, idle({ syncing: true, current: 25, total: 100, determinate: true })))).toMatch(
		/25\/100/,
	);
	const bare = strip(chipFor(theme, idle({ syncing: true })));
	expect(bare).toMatch(/Syncing/);
	expect(bare).not.toMatch(/\d/);
});

test("ago reads like the web's relative age", () => {
	expect(ago(1_000_000, 1_000_000 - 10_000)).toBe("just now");
	expect(ago(1_000_000, 1_000_000 - 5 * 60_000)).toBe("5m ago");
	expect(ago(1_000_000, 1_000_000 - 3 * 3_600_000)).toBe("3h ago");
	expect(ago(1_000_000, 1_000_000 - 2 * 86_400_000)).toBe("2d ago");
});

// ─── progress line: Shell.tsx three-state, indeterminate by phase ────────────

test("progress line is determinate only for ingest with a known total", () => {
	const ingest: SyncEvent = { type: "progress", phase: "ingest", current: 25, total: 100 };
	expect(progressLineFor(ingest, 60)).toContain("25%");
	const scan: SyncEvent = { type: "progress", phase: "scan", current: 0, total: 0 };
	const scanLine = progressLineFor(scan, 60);
	expect(scanLine).not.toContain("NaN");
	expect(scanLine).not.toMatch(/\d+%/);
	// Rollup carries a remaining count, not a denominator: indeterminate by phase.
	const rollup: SyncEvent = { type: "progress", phase: "rollup", current: 0, total: 50 };
	const rollupLine = progressLineFor(rollup, 60);
	expect(rollupLine).not.toMatch(/\d+%/);
	expect(rollupLine).toMatch(/[a-z]/i);
});

test("progress line is hidden for settled states and always fits", () => {
	expect(progressLineFor(null, 60)).toBe("");
	for (const width of [0, 1, 3, 8, 10, 12, 20, 60, 100]) {
		const line = progressLineFor({ type: "progress", phase: "ingest", current: 1, total: 2 }, width);
		expect(visibleWidth(strip(line)), `w=${width}`).toBeLessThanOrEqual(width);
	}
});

// ─── topbar: the web's three-region topbar ────────────────────────────────────
//
// Shell.tsx's `<header class="topbar">` is THREE regions, not one run of
// words: `.topbar-brand`, a `flex: 1` `.topbar-spacer`, then
// `.topbar-actions` holding the LiveChip and the `Segmented` range control.
// The spacer is the whole mechanism — it is what stops the chip reading as
// part of the wordmark. In a terminal there is no flexbox, so the spacer has
// to be PAINTED: the brand sits left, the action cluster sits right, and the
// gap between them is what separates the two. Every test below is about that
// gap and about the cluster reading as two widgets rather than one sentence.

test("topbar at 96 paints the brand left and the action cluster right, with a real gap between", () => {
	// The bug this fixes: `omp/stats  ● Live   1h  24h …` — one left-aligned
	// run, so the chip reads as the tail of the wordmark. The web separates them
	// with `flex: 1` (styles.css:453-455); the terminal has to spend real cells
	// on the same gap.
	const row = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "", innerWidth: 96 });
	const plain = strip(row);
	expect(plain).toContain("omp/stats");
	expect(plain).toContain("Live");
	for (const label of ["1h", "24h", "7d", "30d", "90d", "All"]) expect(plain).toContain(label);
	// Brand flush left, and the chip is nowhere near it: the gap between the
	// wordmark and the cluster is at least three cells, which is what the web's
	// 12px topbar gap buys on screen.
	expect(plain.startsWith("omp/stats")).toBe(true);
	const gap = visibleWidth(plain.slice(plain.indexOf("omp/stats") + "omp/stats".length).split("●")[0] ?? "");
	expect(gap).toBeGreaterThanOrEqual(3);
	expect(visibleWidth(row)).toBeLessThanOrEqual(96);
});

test("the live chip is an enclosed surface and the brand is naked text", () => {
	// The web's own rule for what makes a control read as a control: the brand
	// has NO enclosure, while `.live-chip` is filled + bordered + full-pill
	// radius (styles.css:1596-1598). A terminal has no border-radius, so the
	// faithful form of "this is a surface" is a BACKGROUND. Before the fix both
	// were plain foreground runs, which is exactly why the chip read as the
	// tail of the wordmark.
	const row = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "", innerWidth: 96 });
	const chipBg = row.indexOf("\x1b[48;");
	expect(chipBg).toBeGreaterThan(-1);
	// Everything before the chip's surface is the wordmark and its spacer, and
	// carries no background at all.
	expect(row.slice(0, chipBg)).not.toContain("\x1b[48;");
	expect(strip(row.slice(0, chipBg))).toMatch(/^omp\/stats\s+$/);
	// The chip's surface is the chip's OWN padding, so it is a box rather than a
	// coloured word: one cell of background on each side of the label.
	expect(row).toContain(theme.bg("selectedBg", ` ${chipFor(theme, idle())} `));
	// And the wordmark itself is the brightest thing on the bar, with only the
	// slash dropped a step (styles.css:432, :441-445).
	expect(row).toContain(theme.bold(theme.fg("accent", "omp")));
	expect(row).toContain(theme.fg("dim", "/"));
	expect(row).toContain(theme.bold(theme.fg("accent", "stats")));
});

test("the range control reads as ONE control: uniform inactive styling and a single active pill", () => {
	// Defect 3. Before: the active pill was the only thing that looked
	// different, so the six labels read as five words plus one button. The
	// web's `Segmented` (styles.css:1057-1103) is a container with a shared
	// background and one raised thumb — in a terminal, the honest equivalent is
	// a uniform inactive style on every segment plus exactly one filled pill,
	// with the segments packed tight enough to read as a group.
	const row = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "", innerWidth: 96 });
	const plain = strip(row);
	// Exactly one selectedBg pill belongs to the RANGE control. The chip has its
	// own surface now, so the pill count is asserted against the segment run
	// alone by asking for the row with no chip.
	const bare = topbar(theme, { range: "24h", chip: "", freshness: "", innerWidth: 96 });
	const pills = bare.split(ACTIVE_BG).length - 1;
	expect(pills).toBe(1);
	// Every inactive segment is styled identically — one style, applied to all
	// five, never a per-segment special case.
	const inactive = ["1h", "7d", "30d", "90d", "All"].map(label => theme.fg(TAB_INK.inactive, ` ${label} `));
	for (const styled of inactive) expect(bare, styled).toContain(styled);
	// The active one is the pill, and it carries its label.
	expect(plain).toContain(" 24h ");
	// Tight packing: the six segments are one run, not six space-separated
	// words. A single space separates them and nothing else.
	expect(plain).toMatch(/ 1h\s+24h\s+7d\s+30d\s+90d\s+All /);
});

test("the chip drops before the range control when width runs out, mirroring topbar-hide-narrow", () => {
	// The web hides `.live-chip` (styles.css:455 wraps it in
	// `.topbar-hide-narrow`) but keeps the range control, because the range IS
	// the window you are looking at. Order of sacrifice is therefore fixed:
	// freshness, then chip, then segments — never the reverse.
	const full = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "3 dirty hours", innerWidth: 96 });
	expect(strip(full)).toMatch(/3 dirty hours/);
	expect(strip(full)).toMatch(/Live/);
	// Squeeze until the chip cannot fit: the range control survives.
	for (const width of [70, 60, 56, 50, 44, 40]) {
		const row = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "", innerWidth: width });
		const plain = strip(row);
		expect(visibleWidth(row), `w=${width}`).toBeLessThanOrEqual(width);
		expect(plain, `w=${width}`).toContain("omp/stats");
		expect(plain, `w=${width}`).toMatch(/1h|24h|7d|30d|90d|All/);
	}
	// And at 56 the chip is gone while the brand and the control remain.
	const narrow = topbar(theme, { range: "24h", chip: chipFor(theme, idle()), freshness: "", innerWidth: 56 });
	expect(strip(narrow)).not.toContain("Live");
	expect(strip(narrow)).toContain("24h");
	expect(strip(narrow)).toContain("omp/stats");
});

test("the topbar never clips at any width from 1 to 200", async () => {
	// The acceptance criterion, stated as a sweep rather than four samples: a
	// row that overflows is torn by `OverlayPanel.row`'s padToWidth and the
	// right-hand control is the thing that disappears.
	for (let width = 1; width <= 200; width++) {
		for (const range of ["1h", "24h", "7d", "30d", "90d", "all"] as const) {
			for (const chip of [chipFor(theme, idle()), chipFor(theme, idle({ syncing: true, current: 25, total: 100, determinate: true })), ""]) {
				for (const freshness of ["", "96 dirty hours"]) {
					const row = topbar(theme, { range, chip, freshness, innerWidth: width });
					expect(visibleWidth(row), `w=${width} range=${range}`).toBeLessThanOrEqual(width);
				}
			}
		}
	}
	// The real frame at the four widths the brief names, with a chip, a sync in
	// flight, and a large freshness string all at once.
	for (const width of [40, 60, 100, 150]) {
		const panel = __testing.makePanel({ data: liveData(), rows: 40 });
		await __testing.settled(panel);
		for (const row of panel.render(width)) {
			expect(visibleWidth(row), `w=${width}`).toBeLessThanOrEqual(width);
		}
	}
});

// ─── frame: sidebar + topbar + body + footer, one divider ─────────────────────

test("frame composes topbar, sidebar, body and footer with exactly one divider at 60 and 100", async () => {
	for (const width of [60, 100]) {
		const panel = __testing.makePanel({ data: liveData(), rows: 40 });
		await __testing.settled(panel);
		const frame = panel.render(width);
		const plain = frame.map(strip);
		expect(frame.length, `width=${width}`).toBe(40);
		// Exactly one divider row: split at 100, plain at 60. Borders use
		// corners, never tees, and no body emits a rule (G5), so one is exact.
		expect(plain.filter(r => /[├┤┬┴┼]/.test(r)), `width=${width}`).toHaveLength(1);
		for (const row of frame) expect(visibleWidth(row), `width=${width}`).toBeLessThanOrEqual(width);
		expect(plain.slice(0, 3).join("\n"), `width=${width}`).toContain("omp/stats");
		expect(plain[plain.length - 2]).toContain("close");
	}
	// Wide gets the grouped sidebar COLUMN; below that width the nav is the
	// strip row, which TabBar collapses to one-cell shorts on its own.
	const wide = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(wide);
	const widePlain = wide.render(100).map(strip);
	// The nav is a COLUMN, so each heading/row starts its own frame row.
	expect(widePlain.some(r => r.replace(/^│ /, "").trimStart().startsWith("Usage"))).toBe(true);
	expect(widePlain.some(r => /Overview/.test(r) && /G O/.test(r))).toBe(true);
	const medium = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(medium);
	const mediumPlain = medium.render(60).map(strip);
	expect(mediumPlain.some(r => /Overview/.test(r))).toBe(true);
});

// ─── g-prefix keymap ──────────────────────────────────────────────────────────

test("g arms a jump: the next letter selects the screen and is consumed", async () => {
	const panel = __testing.makePanel({ data: liveData(), screenId: "overview" });
	await __testing.settled(panel);
	panel.handleInput("g");
	panel.handleInput("r");
	await __testing.settled(panel);
	expect(__testing.debugScreenId(panel)).toBe("requests");
	// The range the web would have cycled on a bare r is untouched.
	expect(__testing.debugRange(panel)).toBe("24h");
});


test("a stale g prefix falls through to the normal keymap", async () => {
	let now = 5_000_000;
	const panel = __testing.makePanel({ data: liveData(), now: () => now });
	await __testing.settled(panel);
	panel.handleInput("g");
	now += 2000;
	panel.handleInput("r");
	await __testing.settled(panel);
	expect(__testing.debugRange(panel)).toBe("7d");
});


// ─── the number row ───────────────────────────────────────────────────────────

/**
 * The number row is TEN keys against TWELVE drawable screens, so the row cannot
 * name every screen and no eleventh digit exists. The contract that actually
 * matters is therefore not "every screen has a digit" — that is unsatisfiable,
 * and encoding it only produces a permanently red build, which is how a team
 * learns to ignore red. The contract is:
 *
 *   1. every digit is LIVE and indexes a DISTINCT selectable screen;
 *   2. every screen WITHOUT a digit is reachable by every other affordance —
 *      the arrows, `tab`/`shift+tab`, and its `g` jump letter;
 *   3. the number of digitless screens is stated, not implied.
 *
 * `DIGIT_KEYS` is the one restatement here, and it is deliberate: `panel.ts`
 * keeps `DIGITS` module-private, and observing the row from outside IS the
 * guard. Everything else is DERIVED — `panelAction` is the real keymap,
 * `SELECTABLE_SCREENS` the real registry, `NAV_GROUPS` the real jump map — so
 * nothing here can go stale the way a literal eight-id list did when
 * `providers` and `gain` arrived.
 */
const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

/**
 * How many drawable screens the row may leave without a digit: twelve minus
 * ten, today.
 *
 * This is a TRIPWIRE, not a restatement — the tests below derive the digitless
 * set and prove each member reachable, so a thirteenth screen would still pass
 * on those counts. Pinning the number is what makes the gap a DECISION. When
 * this fails, someone added a screen and must choose, in the same change:
 * re-declare the row so it can name thirteen (`panel.ts`'s `DIGITS` plus the
 * `DIGIT_KEYS` mirror here, which is why both must move together), drop a
 * screen, or accept a larger tab-only tail and raise this number on purpose.
 * Silently letting it grow is the one option this exists to prevent.
 */
const DIGITLESS_SCREENS = 2;

test("every digit on the number row is live and indexes a distinct selectable screen", () => {
	// The base asserted the panel's own `DIGIT_KEYS` list, which is gone; this
	// asks the keymap instead. A digit that indexes nothing, indexes past the
	// end, or lands on the same screen as another digit is a dead or aliased
	// key, and neither is observable from the constant alone.
	const landed: string[] = [];
	for (let index = 0; index < DIGIT_KEYS.length; index++) {
		const key = DIGIT_KEYS[index]!;
		expect(panelAction(key), `digit ${key} is not owned by the panel`).toEqual({ type: "screenIndex", index });
		const screen = SELECTABLE_SCREENS[index];
		expect(screen, `digit ${key} indexes past the end of SELECTABLE_SCREENS`).toBeDefined();
		landed.push(screen!.id);
	}
	expect(new Set(landed).size, `two digits select the same screen: ${landed.join(" ")}`).toBe(landed.length);
});

test("a screen past the number row is still reachable: arrows, tab, and its jump letter", async () => {
	// Which screens the row cannot name, DERIVED — the row is positional, so
	// "past the row" is `SELECTABLE_SCREENS` past `DIGIT_KEYS`. Nothing here
	// hardcodes `traces` or `frustration`; those ids fall out of the registries
	// and the assertion names them in its failure message if one is orphaned.
	const onRow = DIGIT_KEYS.map((_, index) => SELECTABLE_SCREENS[index]?.id);
	const digitless = SELECTABLE_SCREENS.map(screen => screen.id).filter(id => !onRow.includes(id));

	expect(
		digitless.length,
		`digitless screens are now [${digitless.join(", ") || "none"}] — the row holds ${DIGIT_KEYS.length} keys for ${SELECTABLE_SCREENS.length} screens; re-declare the row, drop a screen, or raise DIGITLESS_SCREENS deliberately`,
	).toBe(DIGITLESS_SCREENS);

	// Raw key bytes, because `panelAction` takes what the terminal sends, not
	// the name `matchesKey` matches on — `panelAction("left")` is null.
	const ARROW_RIGHT = "\x1b[C";
	const ARROW_LEFT = "\x1b[D";
	const TAB = "\t";
	const SHIFT_TAB = "\x1b[Z";

	// The arrows and tab are the same verb: `tab` is an ALIAS for the arrow,
	// not a second one, so the alias is asserted as an identity rather than two
	// literals that could drift apart.
	expect(panelAction(ARROW_RIGHT), "the right arrow no longer changes screen").toEqual({ type: "screen", by: 1 });
	expect(panelAction(ARROW_LEFT), "the left arrow no longer changes screen").toEqual({ type: "screen", by: -1 });
	expect(panelAction(TAB), "tab is not an alias for the right arrow").toEqual(panelAction(ARROW_RIGHT));
	expect(panelAction(SHIFT_TAB), "shift+tab is not an alias for the left arrow").toEqual(panelAction(ARROW_LEFT));

	// Then drive the REAL panel — not an index formula — and collect the ids it
	// actually lands on. `#selectScreen` wraps modulo `SELECTABLE_SCREENS`, so
	// `length` steps from one start is one full lap; if a screen were skipped
	// the visited set would be short and the diff below would name it.
	const everyId = SELECTABLE_SCREENS.map(screen => screen.id);
	for (const [label, key] of [["right", ARROW_RIGHT], ["left", ARROW_LEFT], ["tab", TAB], ["shift+tab", SHIFT_TAB]] as const) {
		const panel = __testing.makePanel({ data: liveData(), rows: 40, screenId: SELECTABLE_SCREENS[0]!.id });
		await __testing.settled(panel);
		const visited = new Set<string>([__testing.debugScreenId(panel)]);
		for (let step = 0; step < everyId.length; step++) {
			panel.handleInput(key);
			await __testing.settled(panel);
			visited.add(__testing.debugScreenId(panel));
		}
		expect(
			[...visited].sort(),
			`${label} never reaches: ${everyId.filter(id => !visited.has(id)).join(", ")}`,
		).toEqual([...everyId].sort());
	}

	// Finally the jump letter, resolved from the nav rows themselves rather than
	// a letter list: a digitless screen with no row has no letter, and this is
	// the affordance that can silently go missing when a screen is added.
	const rows = NAV_GROUPS.flatMap(group => group.items);
	for (const id of digitless) {
		const row = rows.find(item => item.id === id);
		expect(row, `${id} has no nav row, so it has no jump letter either`).toBeDefined();
		expect(screenForHotkey(row!.hotkey), `${id} claims ${row!.hotkey}, which resolves elsewhere`).toBe(id);

		// Press the keys, not the resolver: `g` arms, the letter jumps.
		const panel = __testing.makePanel({ data: liveData(), rows: 40, screenId: SELECTABLE_SCREENS[0]!.id });
		await __testing.settled(panel);
		panel.handleInput("g");
		panel.handleInput(row!.hotkey);
		await __testing.settled(panel);
		expect(__testing.debugScreenId(panel), `g ${row!.hotkey} does not reach ${id}`).toBe(id);
	}
});

test("digits index the SELECTABLE screens, so a number never lands on one the IR cannot draw", () => {
	// The selectable set is spec-driven: every screen the IR can describe. A digit
	// that could reach a screen with no body would spend a keystroke on a page the
	// panel cannot honestly fill.
	expect(__testing.debugScreenIds()).toEqual(SELECTABLE_SCREENS.map(screen => screen.id));
	for (let index = 0; index < DIGIT_KEYS.length; index++) {
		const screen = SELECTABLE_SCREENS[index];
		expect(screen, `digit ${DIGIT_KEYS[index]} has nothing to select`).toBeDefined();
		expect(__testing.debugScreenIds(), `digit ${DIGIT_KEYS[index]}`).toContain(screen!.id);
	}
});

// ─── jump letters ────────────────────────────────────────────────────────────

test("every jump letter resolves back to the row that shows it, and none is claimed twice", () => {
	// The base pinned eight specific letters. This derives the whole set from
	// `NAV_GROUPS`, which is what `screenForHotkey` itself reads, so a letter
	// can no longer be added to one and forgotten in the other: `HOTKEYS` is
	// module-private in `chrome.ts`, and this asserts its observable projection
	// — every row has exactly one single lowercase letter, no two rows share
	// one, and `screenForHotkey` round-trips each of them in both cases.
	const rows = NAV_GROUPS.flatMap(group => group.items);
	const claimed = new Map<string, string>();
	for (const row of rows) {
		expect(row.hotkey, `${row.id} has no jump letter`).toMatch(/^[a-z]$/);
		expect(screenForHotkey(row.hotkey), `${row.id} claims ${row.hotkey}, which resolves elsewhere`)
			.toBe(row.id);
		expect(screenForHotkey(row.hotkey.toUpperCase()), `${row.id} is not case-insensitive`).toBe(row.id);
		const prior = claimed.get(row.hotkey);
		expect(prior, `letter ${row.hotkey} is claimed by both ${prior} and ${row.id}`).toBeUndefined();
		claimed.set(row.hotkey, row.id);
	}
	// `g` is the ARM, never a jump target: a row that claimed it would make
	// `g g` a screen and the prefix unexplainable.
	expect(claimed.has("g")).toBe(false);
	// Every selectable screen has a row, and therefore a letter — otherwise it
	// is reachable by arrow and by digit and not by jump.
	for (const screen of SELECTABLE_SCREENS) {
		expect(rows.map(row => row.id), `${screen.id} has no nav row and no jump letter`).toContain(screen.id);
	}
});

test("no jump letter resolves to a screen with no nav row to show it on", () => {
	// `screenForHotkey` reads `NAV_GROUPS`, so this cannot drift from it — but
	// the invariant is worth stating, because it is what makes `g` + a letter
	// safe: a keystroke never lands on a route the sidebar cannot name.
	for (let code = 97; code <= 122; code++) {
		const letter = String.fromCharCode(code);
		const id = screenForHotkey(letter);
		if (id === null) continue;
		expect(NAV_GROUPS.flatMap(group => group.items.map(row => row.id)), letter).toContain(id);
	}
});
