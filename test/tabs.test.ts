/**
 * The tab strip — the tests that make the two real bugs impossible.
 *
 * BUG 1: `short` wider than one cell. `TabBar` collapses to `short` when the
 * full labels overflow, then WRAPS. Twelve 5-cell ascii icons do not fit 80
 * columns, so the strip silently becomes two rows and the body loses a row for
 * no information. Every `short` must therefore be exactly one cell on every
 * preset, asserted here by measurement rather than by eye.
 *
 * BUG 2: reaching for the theme singleton. `getTabBarTheme()` closes over the
 * singleton, which ignores the `Theme` the mount hands us. The stub-theme test
 * below is what proves we do not do that: if the module reached for the
 * singleton, the stub would record zero calls and the assertion fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TabBar } from "@oh-my-pi/pi-tui";
import type { SymbolPreset, Theme } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { SCREENS } from "../src/tui/screens/types";
import { STATS_ICONS } from "../src/tui/icons";
import { TAB_BAR_INDENT, TAB_SHORT, buildTabs, tabBarTheme } from "../src/tui/tabs";
import { TAB_INK } from "../src/tui/palette";

const PRESETS: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];

/** The screens the strip actually shows. */
const SHOWN = SCREENS;

/** A background SGR — the luminance step the active tab must carry. */
const BG = /\x1b\[4[89];/;

/**
 * A theme that records which token each callback asked for and emits REAL SGR
 * escapes, so `visibleWidth` sees the strip's true cell count — an invented
 * `<fg:muted>` marker would inflate every tab and fake a wrap.
 */
function stubTheme() {
	const calls: { fn: "fg" | "bg" | "bold"; token?: string; text: string }[] = [];
	const stub = {
		fg: (color: string, text: string) => {
			calls.push({ fn: "fg", token: color, text });
			return `\x1b[38;5;7m${text}\x1b[0m`;
		},
		bg: (color: string, text: string) => {
			calls.push({ fn: "bg", token: color, text });
			return `\x1b[48;5;4m${text}\x1b[0m`;
		},
		bold: (text: string) => {
			calls.push({ fn: "bold", text });
			return `\x1b[1m${text}\x1b[0m`;
		},
		// The panel resolves icons through the live theme. One cell, so the
		// label budget is honest.
		symbol: (_key: string) => "•",
	};
	return { calls, theme: stub as unknown as Theme };
}

function barFor(preset: SymbolPreset, theme: Theme): TabBar {
	const bar = new TabBar("", buildTabs(preset, theme, "overview"), tabBarTheme(theme));
	bar.showHint = false;
	return bar;
}

describe("TAB_SHORT", () => {
	test("every short is exactly one cell on EVERY preset", () => {
		const offenders: string[] = [];
		for (const preset of PRESETS) {
			for (const [id, glyph] of Object.entries(TAB_SHORT[preset])) {
				const width = visibleWidth(glyph);
				if (width !== 1) offenders.push(`${preset}.${id} = ${JSON.stringify(glyph)} is ${width} cells`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("covers every screen, so no tab renders as an empty cell", () => {
		for (const preset of PRESETS) {
			for (const spec of SHOWN) {
				expect(TAB_SHORT[preset][spec.id] ?? "").not.toBe("");
			}
		}
	});

	test("keys are the screen ids, and nothing else", () => {
		for (const preset of PRESETS) {
			expect(new Set(Object.keys(TAB_SHORT[preset])).size).toBe(SCREENS.length);
			for (const spec of SCREENS) {
				expect(TAB_SHORT[preset]).toHaveProperty(spec.id);
			}
		}
	});

	test("nerd arm reuses the PUA forms pi-tui already registers", () => {
		// Plane 15 PUA too: the host registers some icons there (e.g. providers).
		const PUA = /^[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]$/u;
		// No invented PUA: every glyph is one STATS_ICONS.nerd already ships.
		const known = new Set(Object.values(STATS_ICONS.nerd));
		for (const spec of SCREENS) {
			expect(TAB_SHORT.nerd[spec.id]).toMatch(PUA);
			expect(known.has(TAB_SHORT.nerd[spec.id])).toBe(true);
		}
	});

	test("unicode literals measure one cell in the table as shipped", () => {
		// The geometric one-cell forms. Width is measured (via visibleWidth,
		// so SGR-wrapped values would still count right); the EAW classes
		// are pinned in comments because an Ambiguous glyph measures 1
		// everywhere EXCEPT CJK-locale terminals, where it measures 2 and the
		// tab strip wraps. ▣ ≡ ◈ are Ambiguous — accepted, and pinned here so
		// that acceptance stays a decision rather than drifting into an
		// accident.
		const literals: Record<string, string> = {
			"◫": "U+25EB WHITE SQUARE WITH VERTICAL BISECTING LINE, EAW=N",
			"⚒": "U+2692 HAMMER AND PICK bare, EAW=N — the VS16 form is 2 cells",
			"▣": "U+25A3 WHITE SQUARE CONTAINING BLACK SMALL SQUARE, EAW=A accepted",
			"≡": "U+2261 IDENTICAL TO, EAW=A accepted",
			"◈": "U+25C8 WHITE DIAMOND CONTAINING BLACK SMALL DIAMOND, EAW=A accepted",
			$: "U+0024 DOLLAR SIGN, EAW=Na",
		};
		for (const [glyph, evidence] of Object.entries(literals)) {
			expect(Object.values(TAB_SHORT.unicode), evidence).toContain(glyph);
			expect(visibleWidth(glyph), evidence).toBe(1);
		}
	});
});

describe("buildTabs", () => {
	test("one tab per shown screen", () => {
		const { theme } = stubTheme();
		const tabs = buildTabs("unicode", theme, "overview");
		expect(tabs.map(t => t.id)).toEqual(SHOWN.map(s => s.id));
	});

	test("label is icon + space + label, and short is the one-cell glyph", () => {
		const { theme } = stubTheme();
		const tabs = buildTabs("ascii", theme, "overview");
		for (const spec of SHOWN) {
			const tab = tabs.find(t => t.id === spec.id)!;
			// `statsIcon` prefers the host registry and falls back to our pure
			// table, so the icon is the stub glyph for a registered role and the
			// table glyph otherwise — either way it must be one non-space glyph.
			const [icon, ...rest] = tab.label.split(" ");
			expect(rest.join(" ")).toBe(spec.label);
			expect(icon).not.toBe("");
			expect(visibleWidth(tab.label)).toBe(visibleWidth(icon) + 1 + visibleWidth(spec.label));
			expect(tab.short).toBe(TAB_SHORT.ascii[spec.id]);
		}
	});

	test("activeId selects a real tab", () => {
		const { theme } = stubTheme();
		const tabs = buildTabs("ascii", theme, "costs");
		expect(tabs.some(t => t.id === "costs")).toBe(true);
	});
});

describe("strip geometry", () => {
	/** Inner width of the panel's tab row: border, inset, border. */
	const innerWidth = (outer: number) => outer - 2 * (TAB_BAR_INDENT + 1);

	test("the all-short worst case fits 80 columns without wrapping", () => {
		for (const preset of PRESETS) {
			const perTab = SHOWN.reduce((sum, spec) => sum + visibleWidth(TAB_SHORT[preset][spec.id]) + 2, 0);
			const gutters = 2 * (SHOWN.length - 1);
			expect(perTab + gutters).toBeLessThanOrEqual(innerWidth(80));
		}
	});

	test("rendering at 80 columns yields exactly one row, every preset", () => {
		const { theme } = stubTheme();
		for (const preset of PRESETS) {
			const lines = barFor(preset, theme).render(innerWidth(80));
			expect(lines.length).toBe(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(innerWidth(80));
		}
	});

	test("the indent is the reference's single-column row inset", () => {
		expect(TAB_BAR_INDENT).toBe(1);
	});
});

describe("tabBarTheme", () => {
	test("closes over the injected theme: bg for active, fg(TAB_INK.inactive) for inactive", () => {
		const { calls, theme } = stubTheme();
		const bar = tabBarTheme(theme);
		bar.activeTab("x");
		bar.inactiveTab("y");
		expect(calls.some(c => c.fn === "bg")).toBe(true);
		expect(calls.filter(c => c.fn === "bg")[0]!.token).toBe("selectedBg");
		// The token, not a literal: an inactive segment is `--ink-3` in the web
		// (styles.css:1083-1096), which is `dim` in this theme.
		expect(calls.filter(c => c.fn === "fg" && c.token === TAB_INK.inactive)).toHaveLength(1);
	});

	test("active tab differs from inactive by a LUMINANCE step, not a hue step", () => {
		const { theme } = stubTheme();
		const bar = tabBarTheme(theme);
		const active = bar.activeTab("Costs");
		const inactive = bar.inactiveTab("Costs");
		expect(active).not.toBe(inactive);
		// The active tab carries a BACKGROUND escape; the inactive one does not.
		// That is the contrast step, and it is what survives every theme.
		expect(active).toMatch(BG);
		expect(inactive).not.toMatch(BG);
	});

	test("every callback is defined and every colour came from a theme token", () => {
		const { calls, theme } = stubTheme();
		const bar = tabBarTheme(theme);
		for (const apply of [bar.label, bar.activeTab, bar.inactiveTab, bar.mutedTab, bar.hoverTab, bar.hint]) {
			expect(apply!("x")).toContain("x");
		}
		// Every colour in the output arrived through fg/bg — no literal escapes
		// were written into the module.
		const emitted = calls.length;
		expect(emitted).toBeGreaterThan(0);
		expect(bar.inactiveTab("x")).toMatch(/\x1b\[38;5;7m/);
	});

	test("no import of the theme singleton anywhere in the module", () => {
		const source = readFileSync(new URL("../src/tui/tabs.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from\s+["']@oh-my-pi\/pi-tui\/theme/);
		expect(source).not.toMatch(/from\s+["']\.\/theme/);
		expect(source).not.toMatch(/from\s+["'][^"']*chrome\/shared/);
		expect(source).not.toMatch(/^\s*(?:const|let|var)\s+\w+\s*=\s*theme\s*[;,]/m);
	});
});
