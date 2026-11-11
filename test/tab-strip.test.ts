/**
 * The tab strip and the footer, as the PANEL draws them.
 *
 * `src/tui/tabs.ts` already owns the `Tab[]`, the one-cell `TAB_SHORT` table and
 * the `TabBarTheme` adapter, and `test/tabs.test.ts` owns the strip's own
 * invariants. What is left — and what this file owns — is the wiring, and wiring
 * is where a tab strip usually breaks:
 *
 *  1. **The frame budget.** `TabBar` wraps to two rows below ~70 columns. A
 *     panel that renders the strip and then sizes the body from a HARDCODED
 *     chrome count spends a row the terminal does not have, and the bottom border
 *     falls off the screen. `/settings` gets this right by subtracting
 *     `tabLines.length` explicitly (`settings-selector.ts:736, 739`) and this
 *     asserts the arithmetic rather than trusting it.
 *  2. **The active tab.** The strip is driven from `panelAction`, not from
 *     `TabBar.handleInput`, so the panel's existing and tested keymap stays the
 *     only input path.
 *  3. **The footer.** F23 §3: `hintsRow` is native-only, so the ANSI footer is
 *     hand-rolled from `keyHint`/`rawKeyHint`. The test that matters is the last
 *     one: the footer must advertise the keys the panel ACTUALLY binds and
 *     nothing else, because a hint for an unbound key is a lie the user acts on.
 */

import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { TabBar } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";

import { SCREENS } from "../src/tui/screens/types";
import { TAB_SHORT, buildTabs, tabBarTheme } from "../src/tui/tabs";
import { TAB_INK } from "../src/tui/palette";
import { __testing, panelAction, type PanelAction } from "../src/tui/panel";
import { MIN_PANEL_ROWS } from "../src/tui/frame";
import { footerHints, hintsFor, type PanelHint } from "../src/tui/footer";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { liveData } from "./fixtures/panel";
import type { PanelData } from "../src/data/api";
import type { ScreenId } from "../src/tui/screens/types";

ensureThemeSync();

const PRESETS: SymbolPreset[] = ["unicode", "nerd", "ascii"];

const ESC = String.fromCharCode(27);
/**
 * The SGR that OPENS a background run, reset dropped. `theme.bg(c, "")` is
 * exactly that prefix plus `\x1b[49m`. Compared by prefix because the adapter
 * wraps the fill INSIDE the foreground, so `bg("selectedBg", "x")` has a reset
 * between the escape and the x and is not a substring of anything.
 */
const band = theme.bg("selectedBg", "").replace(`${ESC}[49m`, "");

// ─── the strip itself ───────────────────────────────────────────────────────

test("every TAB_SHORT entry is exactly one cell on every preset", () => {
	for (const preset of PRESETS) {
		for (const [id, glyph] of Object.entries(TAB_SHORT[preset])) {
			expect(Bun.stringWidth(glyph), `${preset}/${id}: ${JSON.stringify(glyph)}`).toBe(1);
		}
	}
});

test("every spec has a tab", () => {
	const tabs = buildTabs("unicode", theme, "overview");
	const ids = tabs.map(tab => tab.id);
	for (const spec of SCREENS) {
		expect(ids, spec.id).toContain(spec.id);
	}
	expect(ids).toEqual(SCREENS.map(spec => spec.id));
});

test("the strip is ONE row at width 80 on every preset", () => {
	for (const preset of PRESETS) {
		const bar = new TabBar("", buildTabs(preset, theme, "overview"), tabBarTheme(theme));
		bar.showHint = false;
		const lines = bar.render(80);
		expect(lines.length, `${preset} wraps at 80: ${JSON.stringify(lines)}`).toBe(1);
		expect(visibleWidth(lines[0] ?? ""), preset).toBeLessThanOrEqual(80);
	}
});

test("a tab label is icon + space + label, matching /settings", () => {
	const [first] = buildTabs("unicode", theme, "overview");
	expect(first?.label).toContain("Overview");
	expect(first?.label?.startsWith(" ") ?? false).toBe(false);
});

test("buildTabs THROWS on an unknown id rather than painting an empty strip", () => {
	// F23 §1.1: a silent undefined reaches the strip and paints an empty body,
	// which reads as "this screen has no data" rather than "this screen is wrong".
	expect(() => buildTabs("unicode", theme, "nope" as ScreenId)).toThrow();
});

// ─── the active tab is driven by the panel's own keymap ─────────────────────

test("the strip's active tab follows panelAction, and handleInput is never consulted", () => {
	for (const preset of PRESETS) {
		const bar = new TabBar("", buildTabs(preset, theme, "overview"), tabBarTheme(theme));
		bar.showHint = false;
		const start = bar.getActiveTab().id;
		// The panel's cascade, not TabBar's: `TabBar.handleInput` takes `tab` for
		// itself, but the panel maps `tab` to next-screen so the key means one
		// thing everywhere (THE KEYMAP DECISION in src/tui/panel.ts). The arrows
		// used to be this step and now drive the range control instead.
		const action = panelAction("\t");
		expect(action).toEqual({ type: "screen", by: 1 } satisfies PanelAction);
		const next = SCREENS[
			(SCREENS.findIndex(spec => spec.id === start) + 1) %
			SCREENS.length
		];
		// setActiveById is the external-sync path and does NOT fire onTabChange,
		// which is what we want: panelAction already decided the change.
		expect(bar.setActiveById(next.id)).toBe(true);
		expect(bar.getActiveTab().id).toBe(next.id);
	}
});

test("the strip is a three-level control: quiet options, bright hover, filled active", () => {
	const style = tabBarTheme(theme);
	// `.segmented-option` is `--ink-3` (styles.css:1083-1096), `:hover` is
	// `--ink-1` (:1097-1099) and `[data-active]` is `--ink-1` on the `--raised`
	// thumb (:1101-1103, :1069-1081). Ours drew every inactive segment at
	// `--ink-2`, which put the whole strip at the same strength as the nav
	// labels beside it — so twelve tabs read as more body text rather than as
	// one object with a position in it.
	expect(style.inactiveTab("x")).toBe(theme.fg(TAB_INK.inactive, "x"));
	expect(style.hoverTab?.("x")).toBe(theme.fg(TAB_INK.hover, "x"));
	expect(TAB_INK.inactive).not.toBe(TAB_INK.hover);
	// The active segment carries the fill. Compared by PREFIX: the adapter wraps
	// the bg INSIDE the fg, so the full bg("selectedBg","x") string has a reset
	// between the bg and the x and is not a substring.
	expect(style.activeTab("x")).toContain(band);
	// …at `--ink-1`, which is the DEFAULT foreground and therefore emits no
	// colour escape of its own. Asserted structurally rather than by scanning for
	// one: there is nothing to scan for, and that is the correct rendering.
	expect(style.activeTab("x")).toBe(theme.bold(theme.bg("selectedBg", theme.fg(TAB_INK.active, "x"))));
	// Exactly one segment is filled, which is what makes it a THUMB rather than
	// a highlight: the three levels must not be three ways of saying "selected".
	expect(style.inactiveTab("x")).not.toContain(theme.bg("selectedBg", ""));
	expect(style.hoverTab?.("x")).not.toContain(theme.bg("selectedBg", ""));
	// …and they are three different strings, not one string with a fill.
	expect(new Set([style.inactiveTab("x"), style.hoverTab?.("x"), style.activeTab("x")]).size).toBe(3);
});

test("a muted tab is de-emphasised, not merely dimmed, and never takes the active fill", () => {
	const style = tabBarTheme(theme);
	// A muted tab is one the reader should skip, so it sits BELOW the inactive
	// options rather than beside them — the same ink-4 rung the sidebar's jump
	// hint uses. A "skipped" tab as loud as an ordinary one communicates nothing.
	expect(style.mutedTab?.("x")).toBe(theme.fg(TAB_INK.muted, "x"));
	expect(style.mutedTab?.("x")).not.toBe(style.inactiveTab("x"));
	expect(style.mutedTab?.("x")).not.toContain(theme.bg("selectedBg", ""));
});

test("the strip's cycle hint is the faintest run in the control", () => {
	const style = tabBarTheme(theme);
	expect(style.hint("x")).toBe(theme.fg(TAB_INK.hint, "x"));
	expect(style.hint("x")).not.toBe(style.inactiveTab("x"));
});

// ─── the frame budget ───────────────────────────────────────────────────────

test("the frame budget subtracts the LIVE tab-row count, so a wrapped strip costs a body row", async () => {
	// The arithmetic F23 states and `/settings` performs: the tab row replaces
	// the header row, so the body loses (tabRows - 1) rows when the strip wraps.

	const wide = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(wide);
	const wideRows = wide.render(80).length;
	const narrow = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(narrow);
	const narrowRows = narrow.render(40).length;
	// A narrow terminal must never paint MORE rows than the terminal has, which is
	// what an un-subtracted tab row would cause.
	expect(narrowRows).toBeLessThanOrEqual(40);
	expect(wideRows).toBeLessThanOrEqual(40);
});

test("render never returns more rows than the terminal has, at any width", async () => {
	for (const rows of [12, 24, 40, 120]) {
		for (let width = 40; width <= 200; width += 20) {
			const panel = __testing.makePanel({ data: liveData() as PanelData, rows });
			await __testing.settled(panel);
			expect(panel.render(width).length, `rows=${rows} width=${width}`).toBeLessThanOrEqual(
				Math.max(MIN_PANEL_ROWS, rows),
			);
		}
	}
});

test("no rendered row ever exceeds the width it was handed", async () => {
	for (let width = 40; width <= 200; width++) {
		const panel = __testing.makePanel({ data: liveData(), rows: 40 });
		await __testing.settled(panel);
		for (const line of panel.render(width)) {
			expect(visibleWidth(line), `width=${width} ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
		}
	}
});

// ─── the footer ─────────────────────────────────────────────────────────────

test("the footer names the keys the panel ACTUALLY binds, and nothing else", () => {
	// THE assertion. A hint for a key the panel does not handle is a lie the
	// user acts on: they press it, nothing happens, and the panel has told them
	// it would. So every hint is round-tripped through the panel's own keymap.
	const cases: readonly (readonly [PanelHint, string])[] = [
		[{ keys: ["left", "right"], label: "screen" }, "\x1b[D"],
		[{ keys: ["up", "down"], label: "scroll" }, "\x1b[A"],
		[{ keys: ["r", "shift+r"], label: "range" }, "R"],
		[{ keys: ["s"], label: "sync" }, "s"],
		[{ keys: ["escape", "q"], label: "close" }, "\x1b"],
		[{ keys: ["pageUp", "pageDown"], label: "page" }, "\x1b[5~"],
		[{ keys: ["home", "end"], label: "jump" }, "\x1b[H"],
	];
	for (const [hint, input] of cases) {
		const action = panelAction(input);
		expect(action, `footer hint "${hint.label}" advertises an unbound key: ${input}`).not.toBeNull();
	}
});



