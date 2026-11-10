import { expect, test } from "bun:test";
import { colorLuma, hexToRgb } from "@oh-my-pi/pi-utils";
import { colorToAnsi, FG_RESET } from "@oh-my-pi/pi-tui/theme/color";
import { isValidThemeBg, isValidThemeColor, type ThemeColor } from "@oh-my-pi/pi-tui/theme/schema";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import {
	heatRamp,
	NAV_TOKENS,
	PALETTE,
	PALETTE_TOKENS,
	SERIES_COLORS,
	SELECTION_BG,
	SELECTION_BG_TOKENS,
	SPAN_COLORS,
	SPAN_TOKENS,
	SIDEBAR_INK,
	TAB_INK,
	TAB_TOKENS,
	resolveSeries,
	stripForTest,
	type PaletteRole,
	type SidebarInkRole,
	type TabInkRole,
	type SelectionBgRole,
	type SpanKindRole,
} from "../src/tui/palette";
import { KINDS } from "../src/tui/features/traces/model";

/**
 * From here down the tests run against the REAL default theme, not `fakeTheme`.
 *
 * The reason is the class of bug this section exists for: two roles that
 * resolve to the SAME colour. `fakeTheme` maps every token it has not been
 * given an explicit hex for to `#cccccc`, so on that fake every pair of roles
 * already collides and the green tests would prove nothing — and worse, the
 * real defect was invisible there. The four `heatRamp` stops are the same
 * trap: two stops that blend to one hex are indistinguishable on a fake theme.
 */
ensureThemeSync();
const hexOf = (token: ThemeColor): string => theme.getColorHex(token);
const lumaOf = (token: ThemeColor): number => colorLuma(hexOf(token)) ?? 0;

/**
 * The colour layer. Every assertion here is about the module taking colours from
 * omp's own theme rather than from a private palette: a wrong token, a hardcoded
 * hex, or an assumed-truecolor path all break user-visible cohesion.
 *
 * Colour and glyphs are INDEPENDENT axes — `getSymbolPreset() === "ascii"` must
 * not perturb a single colour value, or the panel would change palette as well
 * as shape when a user switches preset.
 */

/** A Theme stand-in: only the surface `palette.ts` is allowed to touch. */
function fakeTheme(overrides: Partial<{ mode: "truecolor" | "256color"; preset: "unicode" | "nerd" | "ascii" }> = {}) {
	const hex: Record<ThemeColor, string> = new Proxy(
		{ accent: "#ff79c6", text: "#e5e5e7", success: "#50fa7b", error: "#ff5555", dim: "#6272a4" } as Record<
			ThemeColor,
			string
		>,
		{
			get: (target, key: string) => target[key as ThemeColor] ?? "#cccccc",
		},
	);
	return {
		getColorHex: (c: ThemeColor) => hex[c],
		getColorMode: () => overrides.mode ?? "truecolor",
		getSymbolPreset: () => overrides.preset ?? "unicode",
		fg: (c: ThemeColor, text: string) => `${colorToAnsi(hex[c], overrides.mode ?? "truecolor")}${text}${FG_RESET}`,
	};
}

test("every palette entry is a member of the real ThemeColor union", () => {
	const roles = Object.keys(PALETTE) as PaletteRole[];
	expect(roles.length).toBeGreaterThan(0);
	for (const role of roles) {
		// isValidThemeColor is the runtime guard over the SAME union the compiler
		// checks, so a typo fails here even though `as ThemeColor` would silence it.
		expect(isValidThemeColor(PALETTE[role])).toBe(true);
	}
});

// A deliberately wrong token: if this ever passed, the membership test above is
// vacuous and the palette is not being validated at all.
test("a bogus token is rejected by the same check that validates the palette", () => {
	expect(isValidThemeColor("chartSeries1" as ThemeColor)).toBe(false);
	expect(isValidThemeColor("accent")).toBe(true);
});

test("the panel's roles are all present", () => {
	for (const role of [
		"primary",
		"negative",
		"positive",
		"caution",
		"heading",
		"label",
		"meta",
		"muted",
		"dim",
		"faint",
	] as PaletteRole[]) {
		expect(PALETTE[role]).toBeDefined();
	}
});

test("the four heat rungs resolve to four DIFFERENT colours in luma order", () => {
	// The four stops `heatRamp` blends between. Measured on the real theme,
	// because a fake theme maps every unknown token to one hex and a collision
	// between two stops would be invisible there.
	const lumas = [0, 1, 2, 3].map(level => {
		const ansi = heatRamp(theme, level);
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
		expect(m, `heatRamp(${level}) is truecolor`).not.toBeNull();
		return 0.299 * Number(m![1]) + 0.587 * Number(m![2]) + 0.114 * Number(m![3]);
	});
	for (let i = 1; i < lumas.length; i++) {
		expect(lumas[i], `rung ${i - 1}→${i} is not brighter`).toBeGreaterThan(lumas[i - 1]);
	}
});

test("the series palette offers at least 6 colours for multi-series charts", () => {
	expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(6);
	for (const c of SERIES_COLORS) expect(isValidThemeColor(c)).toBe(true);
	// Position colouring is only useful if positions can differ; a theme that
	// aliases several tokens to one hue would collapse them (segment-track.ts
	// dedupes for exactly this reason).
	const distinct = new Set(resolveSeries(SERIES_COLORS.length, fakeTheme()));
	expect(distinct.size).toBeGreaterThanOrEqual(1);
});

test("adjacent series colours are resolvable and repeat past the end via modulo", () => {
	const theme = fakeTheme();
	const series = resolveSeries(4, theme);
	expect(series).toHaveLength(4);
	expect(series[0]).not.toBe(series[1]);
	// Asking for more than exist wraps rather than returning undefined.
	expect(resolveSeries(20, theme)).toHaveLength(20);
	for (const token of resolveSeries(20, theme)) expect(token).toBeDefined();
});

test("resolveSeries never returns an empty palette, even for a monochrome theme", () => {
	// Every token maps to the same hex: the degenerate case a theme like
	// `titanium` produces. It must still yield one usable colour.
	const monochrome = {
		getColorHex: () => "#888888",
		getColorMode: () => "truecolor" as const,
		getSymbolPreset: () => "unicode" as const,
		fg: (c: ThemeColor, t: string) => `${t}${FG_RESET}`,
	};
	expect(resolveSeries(3, monochrome).length).toBeGreaterThan(0);
});

test("heatRamp is monotonic: level 0 is the most background-ish, level 3 the most accent-ish", () => {
	const theme = fakeTheme();
	const luma = [0, 1, 2, 3].map(level => {
		// Recover the hex behind the escape so luminance is measurable.
		const ansi = heatRamp(theme, level);
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
		expect(m).not.toBeNull(); // truecolor path yields 38;2;…
		return 0.299 * Number(m![1]) + 0.587 * Number(m![2]) + 0.114 * Number(m![3]);
	});
	for (let i = 1; i < luma.length; i++) expect(luma[i]).toBeGreaterThan(luma[i - 1]);
	expect(luma[3]).toBeGreaterThan(luma[0]);
});

test("the four heat levels all differ from each other", () => {
	const theme = fakeTheme();
	const outputs = [0, 1, 2, 3].map(l => heatRamp(theme, l));
	expect(new Set(outputs).size).toBe(4);
});

test("heatRamp output carries no literal hex — it must be an escape from a theme token", () => {
	const theme = fakeTheme();
	for (const level of [0, 1, 2, 3]) {
		const out = heatRamp(theme, level);
		expect(out).not.toMatch(/#[0-9a-f]{6}/i);
		// And it must actually be coloured, not a bare space.
		expect(out).not.toBe(" ");
		expect(out.length).toBeGreaterThan(1);
	}
});

test("heatRamp works under 256color without throwing and still emits a real escape", () => {
	const theme = fakeTheme({ mode: "256color" });
	for (const level of [0, 1, 2, 3]) {
		const out = heatRamp(theme, level);
		expect(out).toMatch(/\x1b\[38;5;\d+m/);
		expect(out).not.toMatch(/#[0-9a-f]{6}/i);
	}
	expect(new Set([0, 1, 2, 3].map(l => heatRamp(theme, l))).size).toBe(4);
});

test("heatRamp anchors to a near-background end, so level 0 recedes on dark themes", () => {
	const theme = fakeTheme(); // text = #e5e5e7, i.e. a dark background
	const zero = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(heatRamp(theme, 0))!;
	const l = colorLuma(theme.getColorHex("accent"))!;
	// Level 0 must be dimmer than the accent it ramps toward, otherwise an empty
	// day would read as "full activity".
	const luma0 = 0.299 * Number(zero[1]) + 0.587 * Number(zero[2]) + 0.114 * Number(zero[3]);
	expect(luma0).toBeLessThan(l * 255);
	expect(hexToRgb(theme.getColorHex("accent"))).toBeDefined();
});

test("the palette survives getSymbolPreset() === 'ascii' unchanged", () => {
	const unicode = fakeTheme({ preset: "unicode" });
	const ascii = fakeTheme({ preset: "ascii" });
	// Colour and glyph are independent axes: the same theme must yield the same
	// colours whatever the preset says.
	expect([0, 1, 2, 3].map(l => heatRamp(ascii, l))).toEqual([0, 1, 2, 3].map(l => heatRamp(unicode, l)));
	expect(resolveSeries(6, ascii)).toEqual(resolveSeries(6, unicode));
	expect(ascii.getSymbolPreset()).toBe("ascii");
	// Every role resolves, and every role is a token the host's validator
	// accepts — a misspelled token is a compile error here and a runtime
	// uncoloured cell if it ever slips through.
	for (const role of Object.keys(PALETTE) as PaletteRole[]) {
		expect(isValidThemeColor(PALETTE[role]), role).toBe(true);
	}
});

test("stripForTest removes ANSI so glyph assertions ignore colour", () => {
	const coloured = heatRamp(fakeTheme(), 2) + "▄" + FG_RESET;
	const stripped = stripForTest(coloured);
	expect(stripped).toBe("▄");
	expect(stripped).not.toMatch(/\x1b/);
	// Plain text passes through untouched, so it is safe to call unconditionally.
	expect(stripForTest("plain")).toBe("plain");
	expect(stripForTest("")).toBe("");
});

test("palette.ts is the ONLY module allowed to emit a colour escape", async () => {
	// The behavioural test in `band.test.ts` proves the band grammar does not
	// leak a literal escape, but the screens compose their own rows and do not
	// go through it — so a screen could hand-write `\x1b[38;2;…` and break every
	// user theme without anything failing. This is the structural version of the
	// same rule, and it covers every module regardless of how it renders.
	//
	// A colour-SETTING SGR: 30–37/90–97 (basic fg), 38/48/58 (extended fg/bg/
	// underline), 40–47/100–107 (basic bg). A bare reset like `\x1b[39m` is not
	// a colour choice and is deliberately not matched.
	const COLOUR_ESCAPE = /\\x1b\\?\[\s*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38|48|58)\b/;

	// `palette.ts` owns the ramp; the host owns everything else. Nothing else may
	// name a colour directly.
	const ALLOWED = new Set(["src/tui/palette.ts"]);
	const offenders: string[] = [];

	for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: import.meta.dir + "/.." })) {
		if (ALLOWED.has(file)) continue;
		const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
		// Comments document escapes legitimately; only code can leak one.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		if (COLOUR_ESCAPE.test(code)) offenders.push(file);
	}

	expect(offenders, `hardcoded colour escape in: ${offenders.join(", ")}`).toEqual([]);
});

// ─── THE WEB-TOKEN CITATIONS ──────────────────────────────────────────────────

/**
 * Every colour in this panel stands in for something the web dashboard actually
 * paints, and the citation is machine-checked rather than promised in prose.
 *
 * The failure this prevents is the quiet one: a role is added, given whatever
 * token was nearest, and six months later nobody can say which web rule it was
 * matching — so it can never be re-derived when the web changes. A citation that
 * names no CSS custom property and no host line is not a citation.
 */
const CITATION_SHAPE = /^--[a-z0-9-]+ .*`[\w./-]+:\d+`$/;

test("every palette role cites the web token it now matches", () => {
	const roles = Object.keys(PALETTE) as PaletteRole[];
	expect(roles.length).toBeGreaterThan(0);
	for (const role of roles) {
		expect(PALETTE_TOKENS[role], `PALETTE_TOKENS has no entry for PALETTE.${role}`).toBeDefined();
		expect(PALETTE_TOKENS[role], `PALETTE.${role} citation`).toMatch(CITATION_SHAPE);
	}
});

test("every sidebar ink level cites the web token it now matches", () => {
	const roles = Object.keys(SIDEBAR_INK) as SidebarInkRole[];
	expect(roles.length).toBeGreaterThan(0);
	for (const role of roles) {
		expect(NAV_TOKENS[role], `NAV_TOKENS has no entry for SIDEBAR_INK.${role}`).toBeDefined();
		expect(NAV_TOKENS[role], `SIDEBAR_INK.${role} citation`).toMatch(CITATION_SHAPE);
	}
});

test("every tab ink level cites the web token it now matches", () => {
	const roles = Object.keys(TAB_INK) as TabInkRole[];
	expect(roles.length).toBeGreaterThan(0);
	for (const role of roles) {
		expect(TAB_TOKENS[role], `TAB_TOKENS has no entry for TAB_INK.${role}`).toBeDefined();
		expect(TAB_TOKENS[role], `TAB_INK.${role} citation`).toMatch(CITATION_SHAPE);
	}
});

test("every selection band role cites the web token it now matches", () => {
	// The BACKGROUND axis gets the same machine-checked contract as the two ink
	// ladders. `selectedBg` was the one colour five call sites wrote as a bare
	// literal, precisely because nothing in the tree had given it a name; a
	// table with no citation requirement is how that happens again.
	const roles = Object.keys(SELECTION_BG) as SelectionBgRole[];
	expect(roles.length).toBeGreaterThan(0);
	for (const role of roles) {
		expect(SELECTION_BG_TOKENS[role], `SELECTION_BG_TOKENS has no entry for SELECTION_BG.${role}`).toBeDefined();
		expect(SELECTION_BG_TOKENS[role], `SELECTION_BG.${role} citation`).toMatch(CITATION_SHAPE);
	}
});

test("the selection band is a real ThemeBg, and is NOT a ThemeColor", () => {
	// The host declares two disjoint unions (`schema.ts:174-179`): `fg` takes
	// only `ThemeColor`, `bg` only `ThemeBg`. `selectedBg` belongs to the second,
	// and this pins that so a future edit cannot quietly fold the background
	// axis into `PALETTE`, where `test/palette.test.ts` asserts `isValidThemeColor`
	// over every role and would fail for a reason that reads like a typo.
	expect(isValidThemeBg(SELECTION_BG.band)).toBe(true);
	expect(isValidThemeColor(SELECTION_BG.band)).toBe(false);
});

test("no PALETTE role is a background token, so the two axes cannot be confused", () => {
	// The inverse of the test above, stated over the whole ink table: every
	// `PALETTE` role must be INK. This is what makes "painted the wrong kind of
	// token" a type error rather than a cell that silently renders uncoloured.
	for (const role of Object.keys(PALETTE) as PaletteRole[]) {
		expect(isValidThemeBg(PALETTE[role]), `PALETTE.${role} is a background token`).toBe(false);
	}
});

test("every span kind cites the upstream CATEGORY_VARS entry it now matches", () => {
	// The trace span ladder has the same contract as the ink ladders. It exists
	// because traces legitimately needs per-kind colour, but a `Record<K,
	// ThemeColor>` kept private beside its renderer has no provenance and cannot
	// be re-derived when a role moves.
	const roles = Object.keys(SPAN_COLORS) as SpanKindRole[];
	expect(roles.length).toBeGreaterThan(0);
	// Every kind the trace model can produce must have a colour, or a span kind
	// added upstream renders as uncoloured — which throws nothing and is
	// invisible to every behavioural test.
	expect([...roles].sort()).toEqual([...KINDS].sort());
	for (const role of roles) {
		expect(SPAN_TOKENS[role], `SPAN_TOKENS has no entry for SPAN_COLORS.${role}`).toBeDefined();
		expect(SPAN_TOKENS[role], `SPAN_COLORS.${role} citation`).toMatch(CITATION_SHAPE);
		expect(isValidThemeColor(SPAN_COLORS[role]), `SPAN_COLORS.${role}`).toBe(true);
	}
});

test("the span ladder is the web's CATEGORY_VARS, not a private ordering", () => {
	// `CATEGORY_VARS` in the dashboard's own `trace-colors.ts:37-43` is the file
	// its flamegraph canvas reads five category fills from. Three entries are
	// pinned because they are the ones most likely to drift back toward a
	// private preference: `turn` must be ink-2 and NOT a success green,
	// `background` must be the faintest rung and NOT `muted`, and `tool` must be
	// the one entry that is token-for-token the web's `--warn`.
	expect(SPAN_COLORS.turn).toBe("muted");
	expect(SPAN_COLORS.background).toBe("borderMuted");
	expect(SPAN_COLORS.tool).toBe("warning");
});

// ─── DEFECT 3: THE PALETTE AUDIT ──────────────────────────────────────────────

test("a heading is body ink, not the accent hue the web reserves for one number", () => {
	// DEFECT. `PALETTE.heading` was `mdHeading`, which in omp's default dark
	// theme resolves to `#febc38` — byte-identical to `accent`. So every screen
	// and band title wore the exact hue css-tokens.md:104 reserves for "the one
	// number a screen is about", and a title stopped reading as a title.
	//
	// The web's own headings are ink-1: `.page-title` is `--ink-1` @600
	// (styles.css:678-683) and `.card-title` is `--ink-1` @550
	// (styles.css:770-777). Weight carries the emphasis; colour does not.
	expect(hexOf(PALETTE.heading)).not.toBe(hexOf(PALETTE.primary));
	expect(lumaOf(PALETTE.heading)).toBeGreaterThan(lumaOf(PALETTE.meta));
	// And it is the brightest ink in the panel, which is what "the heaviest
	// heading on the page" means in a terminal.
	expect(lumaOf(PALETTE.heading)).toBeGreaterThanOrEqual(lumaOf("text"));
});

test("metadata is one ink step below labels, because the web puts foot/header on ink-3", () => {
	// DEFECT. `PALETTE.meta` was `muted`, i.e. `--ink-2`, but every piece of web
	// metadata is `--ink-3`: `.stat-foot` (styles.css:867-874), `.table th`
	// (styles.css:1269-1282), `.micro` (styles.css:267-273), `.cell-secondary`
	// (css-tokens.md:72). Metadata drawn at label strength is metadata the eye
	// reads as content.
	expect(lumaOf(PALETTE.meta)).toBeLessThan(lumaOf(PALETTE.muted));
	// And still above the faintest ink — it is present, not chrome.
	expect(lumaOf(PALETTE.meta)).toBeGreaterThan(lumaOf(PALETTE.faint));
});

test("`faint` is the ink-4 level the web keeps for kbd hints and disabled text", () => {
	// MISSING LEVEL, not a mis-set one. The web has four inks and the terminal
	// ladder had three, so "the faintest thing on screen" had no name and every
	// caller reached for `dim`. `.nav-row kbd` (styles.css:565-570) is the
	// consumer that needed it: a jump hint one step below every label.
	expect(PALETTE.faint).toBe("borderMuted");
	expect(lumaOf(PALETTE.faint)).toBeLessThan(lumaOf(PALETTE.dim));
	expect(hexOf(PALETTE.faint)).not.toBe(hexOf(PALETTE.dim));
});


// ─── DEFECT 2: THE SIDEBAR LADDER ─────────────────────────────────────────────

/**
 * The complaint was "the group headings are all the same colour". The cause was
 * not one bad choice, it was that the nav had no LADDER: two headings and two
 * rows all resolved inside one ink step, so the eye had nothing to climb and the
 * block read as a list of words rather than a control.
 *
 * These are the four levels the brief names. They must be four distinct RESOLVED
 * colours — measured on the real theme, because a token list hides a collision
 * between two different tokens that happen to render the same.
 */
const LEVELS = ["headingActive", "headingInactive", "rowActive", "rowInactive"] as const;

test("the four levels are three rungs, and the one shared rung is the 'you are here' rung", () => {
	// The brief asks for four distinguishable levels, and they are — but not four
	// distinct INKS, because the web does not use four. `.nav-heading` is ink-3
	// for every group and there is no active-group variant, so our active heading
	// borrows the row's own selection rule (ink-1) rather than inventing a fifth
	// ink above it. That shared rung is meaningful, not a collapse: the heading
	// of the group you are inside and the row you are on are the same level of
	// "here", and `test/chrome.test.ts` proves the two still render as four
	// different LINES.
	const hexes = LEVELS.map(role => hexOf(SIDEBAR_INK[role]));
	expect(new Set(hexes).size, `sidebar levels: ${LEVELS.join(" / ")} = ${hexes.join(" ")}`).toBe(3);
	expect(SIDEBAR_INK.headingActive).toBe(SIDEBAR_INK.rowActive);
	// Every OTHER pair is a different colour, and in the web's order:
	// heading-idle (ink-3) is quieter than the row label (ink-2), which is
	// quieter than anything selected (ink-1).
	const [headingActive, headingInactive, rowActive, rowInactive] = LEVELS.map(role => SIDEBAR_INK[role]);
	expect(headingActive).not.toBe(headingInactive);
	expect(headingInactive).not.toBe(rowInactive);
	expect(rowInactive).not.toBe(rowActive);
	expect(rowActive).not.toBe(headingInactive);
});

test("the sidebar ladder is ordered the way the web orders it: kbd < heading < label < selected", () => {
	// `--ink-4` (kbd, styles.css:565-570) < `--ink-3` (heading, :515-520) <
	// `--ink-2` (row label, :522-536) < `--ink-1` (hover and selected,
	// :538-541 and :547-550). Every step is strict, because every step is a
	// step the web actually takes.
	expect(lumaOf(SIDEBAR_INK.jumpKey)).toBeLessThan(lumaOf(SIDEBAR_INK.headingInactive));
	expect(lumaOf(SIDEBAR_INK.headingInactive)).toBeLessThan(lumaOf(SIDEBAR_INK.rowInactive));
	expect(lumaOf(SIDEBAR_INK.rowInactive)).toBeLessThan(lumaOf(SIDEBAR_INK.rowHover));
	// The active heading is ink-1 for the same reason the active row is: it is
	// the thing the reader is inside. It is NOT a fifth rung above the row.
	expect(SIDEBAR_INK.headingActive).toBe("text");
	expect(SIDEBAR_INK.headingInactive).toBe("dim");
	expect(SIDEBAR_INK.rowInactive).toBe("muted");
	expect(SIDEBAR_INK.rowHover).toBe("text");
	// Off-section rows stay at ink-2 rather than being dimmed: a dimmed row
	// reads as DISABLED, and the group cue lives in the heading instead.
	expect(lumaOf(SIDEBAR_INK.rowInactive)).toBeGreaterThan(lumaOf(SIDEBAR_INK.headingInactive));
});

test("the accent is spent ONCE in the sidebar, on the active row's icon", () => {
	// css-tokens.md:104 restricts `--accent` to "the active sidebar item's icon"
	// and the value flash, and the CSS agrees: `.nav-row[data-active="true"]` sets
	// `color: var(--ink-1)` (:547-550) and only its `svg` takes the accent
	// (:557-559). An earlier version of this table read that line as "icon and
	// text" and painted the active LABEL with it — which put the active row, its
	// icon and the active group's heading all in one hue, and that is exactly
	// why the nav read as flat.
	expect(SIDEBAR_INK.iconActive).toBe("accent");
	expect(SIDEBAR_INK.rowActive).not.toBe("accent");
	const accentRoles = (Object.keys(SIDEBAR_INK) as SidebarInkRole[]).filter(
		role => SIDEBAR_INK[role] === "accent",
	);
	expect(accentRoles).toEqual(["iconActive"]);
	// …and the accent is genuinely the brightest thing in the nav, so the one
	// run of it is findable rather than merely different.
	expect(lumaOf(SIDEBAR_INK.iconActive)).toBeGreaterThan(lumaOf(SIDEBAR_INK.jumpKey));
});

test("the jump hint is the faintest ink in the sidebar, one step below its own label", () => {
	// `.nav-row kbd` is `--ink-4` (styles.css:565-570) against a `--ink-2` row.
	// Ours painted it `dim`, the same ink as the heading, so the hint and the
	// structure it annotates were indistinguishable.
	expect(lumaOf(SIDEBAR_INK.jumpKey)).toBeLessThan(lumaOf(SIDEBAR_INK.rowInactive));
	expect(SIDEBAR_INK.iconInactive).toBe("dim"); // `.nav-row svg` is ink-3 (styles.css:552)
});

// ─── DEFECT 4: THE TAB STRIP ──────────────────────────────────────────────────

test("the tab strip is a three-level control: inactive, hovered, active", () => {
	// `.segmented-option` is `--ink-3`, `:hover` is `--ink-1`, and
	// `[data-active]` is `--ink-1` on the `--raised` thumb
	// (styles.css:1083-1103). Ours drew inactive at `--ink-2`, which put the
	// whole strip at the same strength as the nav labels it sits beside, so it
	// read as more text rather than as one control.
	expect(TAB_INK.inactive).toBe("dim");
	expect(TAB_INK.hover).toBe("text");
	expect(TAB_INK.active).toBe("text");
	expect(lumaOf(TAB_INK.inactive)).toBeLessThan(lumaOf(TAB_INK.hover));
	expect(hexOf(TAB_INK.inactive)).not.toBe(hexOf(TAB_INK.hover));
	// The hint is ink-4, below the options themselves.
	expect(lumaOf(TAB_INK.hint)).toBeLessThan(lumaOf(TAB_INK.inactive));
	expect(TAB_INK.muted).toBe("borderMuted");
});

test("the tab strip and the sidebar draw the SAME inactive ink, so the chrome agrees", () => {
	// Both are nav: a row in the sidebar and a segment in the strip are the same
	// kind of thing at the same depth, and the earlier split (`muted` in one,
	// `dim` in the other) is what made the two read as unrelated objects.
	expect(TAB_INK.inactive).toBe(SIDEBAR_INK.iconInactive);
	expect(TAB_INK.hover).toBe(SIDEBAR_INK.rowHover);
});

// ─── SERIES_COLORS: UNCHANGED, AND NOW PROVEN ────────────────────────────────

test("SERIES_COLORS is untouched and every adjacent pair is distinguishable", () => {
	// The brief allows changing a series colour only with proof, so none changed.
	// This is the proof that the standing list does not need it: on the real
	// default theme every ADJACENT pair resolves to different colours, which is
	// the property a reader actually depends on (consecutive swatches in a
	// legend, consecutive segments in a stacked bar).
	expect(SERIES_COLORS.length).toBe(12);
	const resolved = SERIES_COLORS.map(hexOf);
	for (let i = 1; i < resolved.length; i++) {
		expect(resolved[i], `series ${i - 1} and ${i} are the same colour: ${SERIES_COLORS[i - 1]}/${SERIES_COLORS[i]}`)
			.not.toBe(resolved[i - 1]);
	}
	// resolveSeries dedupes by resolved colour, so it must never hand back a
	// palette whose neighbours collide.
	const six = resolveSeries(6, theme);
	const sixHex = six.map(hexOf);
	for (let i = 1; i < sixHex.length; i++) expect(sixHex[i]).not.toBe(sixHex[i - 1]);
});

test("the series palette is identical under every symbol preset", () => {
	// Colour and glyph are independent axes. `resolveSeries` takes no preset, and
	// that is the point: a user switching unicode→nerd→ascii must not also
	// switch chart colours. Built by delegation rather than a spread, because
	// `theme` is a class instance and spreading it drops its methods.
	const atPreset = (preset: "unicode" | "nerd" | "ascii") => ({
		getColorHex: (c: ThemeColor) => theme.getColorHex(c),
		getColorMode: () => theme.getColorMode(),
		getSymbolPreset: () => preset,
	});
	for (const preset of ["unicode", "nerd", "ascii"] as const) {
		expect(resolveSeries(6, atPreset(preset)), preset).toEqual(resolveSeries(6, theme));
	}
});
