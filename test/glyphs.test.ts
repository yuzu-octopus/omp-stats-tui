import { test, expect } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";
import {
	type GlyphSet,
	type GlyphRole,
	glyphClass,
	ALL_GLYPH_CLASS,
	glyph,
	glyphsFor,
	HEAT_LEVELS,
	SPARK_LEVELS,
} from "../src/tui/glyphs";
import {
	STATS_ICONS,
	HOST_ICON_KEYS,
	NEW_ICON_ROLES,
	ICON_GUTTER,
	statsIcon,
} from "../src/tui/icons";

const PRESETS = ["unicode", "nerd", "ascii"] as const;

/** The one measured exception to the width-1 rule, keyed `preset/role`. */
const BLANK_BY_DESIGN: Record<string, boolean> = { "ascii/heatEmpty": true };

// ensureThemeSync() returns void, so the module-scope binding is only readable
// after the call. Fine in a test; forbidden in extension code (see AGENTS.md).
ensureThemeSync();

const liveTheme = theme;

test("every data-ink glyph in every preset is exactly one cell wide", () => {
	for (const preset of PRESETS) {
		const set = glyphsFor(preset);
		for (const [role, value] of Object.entries(set)) {
			const glyphs = typeof value === "string" ? [value] : value;
			for (const g of glyphs) {
			if (BLANK_BY_DESIGN[`${preset}/${role}`]) continue;
				expect(Bun.stringWidth(g), `${preset}/${role}/${g}`).toBe(1);
			}
		}
	}
});

// ─── the roles added for src/tui/features/** ─────────────────────────────────

/** Every role added when the feature modules stopped hand-drawing their ink. */
const FEATURE_ROLES = [
	"rowCursor",
	"legendKey",
	"pointHollow",
	"pointFilled",
	"axisRule",
	"plotSpine",
	"trackMarker",
	"playhead",
] as const satisfies readonly GlyphRole[];

test("every feature-module role is exactly one cell wide under ALL THREE presets", () => {
	// Stated separately from the table-wide sweep above because these are the
	// roles that replaced hand-written literals in `src/tui/features/**`, and the
	// failure they exist to prevent is precisely one an ascii user would hit: a
	// `█` or `▓` surviving where the rest of the panel degraded to `#`.
	for (const role of FEATURE_ROLES) {
		for (const preset of PRESETS) {
			const g = glyph(preset, role);
			expect(Bun.stringWidth(g), `${preset}/${role}/${g}`).toBe(1);
			expect(g, `${preset}/${role} must never be a blank`).not.toBe(" ");
		}
	}
});

test("the feature roles are all reachable from ALL_GLYPH_CLASS, so a detector cannot miss one", () => {
	// `ALL_GLYPH_CLASS` is derived from the role keys rather than hand-listed, so
	// a new role cannot be added without becoming detectable. This asserts that
	// derivation still holds for the roles added here.
	const every = new RegExp(`^[${ALL_GLYPH_CLASS}]`);
	for (const preset of PRESETS) {
		for (const role of FEATURE_ROLES) {
			expect(every.test(glyph(preset, role)), `${preset}/${role} missing from ALL_GLYPH_CLASS`).toBe(true);
		}
	}
});

test("ascii picks a fallback that disambiguates rather than one that merely looks right", () => {
	// Each fallback below was chosen against the characters already in the ascii
	// set. The one that could plausibly have gone wrong is pinned: a playhead
	// that reused `|` would be indistinguishable from the plot spine.
	expect(glyph("ascii", "playhead")).toBe("v");
	expect(glyph("ascii", "playhead")).not.toBe(glyph("ascii", "plotSpine"));
	// The row cursor deliberately matches the host's own ascii `nav.cursor`, so a
	// list row points the same way under ascii as it does in the sidebar.
	expect(glyph("ascii", "rowCursor")).toBe(">");
});

test("nerd emits byte-identical feature ink to unicode", () => {
	// The same structural guarantee the spark/bar ramps rely on: no Nerd Font
	// codepoint means magnitude, so the two presets must not diverge here either.
	for (const role of FEATURE_ROLES) {
		expect(glyphsFor("nerd")[role], `nerd/${role}`).toEqual(glyphsFor("unicode")[role]);
	}
});

// ─── axisLine ─────────────────────────────────────────────────────────────────

test("axisLine is a floor mark, not a rule run and not a sparkline rung", () => {
	// Added for the chart baseline. The constraints are all measured rather than
	// argued, because each one was a way this glyph could have been wrong:
	//
	// - G5 forbids a full-width run of box-drawing rules in a body
	//   (band.test.ts:166, RULE_RUN = /[─━═]{3,}/) and /usage draws zero rules
	//   there, so the baseline must not be `─`, `━` or `═`. It is a MARK that
	//   sits on the floor, not a rule that draws one.
	// - It must be its own role rather than a borrowed one. `sparkRamp[0]` is
	//   width-1 and is not a rule char, but reusing it would make the floor mark
	//   and the first rung of a sparkline the same character, so a change to one
	//   would silently restyle the other.
	for (const preset of PRESETS) {
		const mark = glyph(preset, "axisLine");
		expect(Bun.stringWidth(mark), `${preset}/axisLine/${mark}`).toBe(1);
		expect(`${mark.repeat(3)}`, `${preset} axisLine ×3 must not be a rule run`).not.toMatch(/[─━═]{3,}/);
		expect(glyphsFor(preset).sparkRamp, `${preset} axisLine must not be a sparkline rung`).not.toContain(mark);
	}
});

test("axisLine is `_` on every preset, and distinct from every other role's glyph", () => {
	// `_` and not `·` because a baseline belongs at the BOTTOM of the cell and
	// `·` is vertically centred — the mark would float in the middle of the plot.
	// It was `·` in unicode only, which also made it identical to `heatEmpty`
	// there: the one preset where the two marks could not be told apart, while
	// ascii `heatEmpty` is a blank and a dot would have been invisible anyway.
	for (const preset of PRESETS) {
		expect(glyph(preset, "axisLine"), preset).toBe("_");
		// Distinct from every other single-glyph role, so no meaning is expressed
		// twice by accident — which is the property the swap actually bought.
		const set = glyphsFor(preset);
		const others = (Object.keys(set) as GlyphRole[])
			.filter(role => role !== "axisLine" && typeof set[role] === "string")
			.map(role => glyph(preset, role));
		expect(others, `${preset} axisLine collides with another role`).not.toContain("_");
		// Never a blank, under any preset.
		expect(glyph(preset, "axisLine")).not.toBe(" ");
	}
});

test("glyphClass matches exactly the roles it is given, and nothing else", () => {
	// The whole point of deriving it: a class built from the roles cannot go
	// stale the way `/^[█#░]{2} \S/` did when `barEmpty` stopped being drawn.
	for (const preset of PRESETS) {
		const fill = new RegExp(`[${glyphClass("barFill")}]`);
		expect(fill.test(glyph(preset, "barFill")), `${preset} barFill`).toBe(true);
		expect(fill.test(glyph(preset, "barEmpty")), `${preset} barEmpty is not a fill`).toBe(false);
		expect(fill.test(glyph(preset, "heatCell")), `${preset} heatCell is not a fill`).toBe(false);
		// And the ascii metacharacters in the set did not escape into a range or a
		// quantifier: `.` must match a dot, not "any character".
		const all = new RegExp(`^[${ALL_GLYPH_CLASS}]+$`);
		expect(all.test(glyph(preset, "sparkRamp", 0))).toBe(true);
		expect(all.test("xyz"), "the class must not match arbitrary letters").toBe(false);
	}
	// Every role the module can render is in ALL_GLYPH_CLASS — including the
	// ones added later, which is what makes the union safe to rely on.
	const every = new RegExp(`^[${ALL_GLYPH_CLASS}]`);
	for (const preset of PRESETS) {
		for (const role of Object.keys(glyphsFor(preset)) as GlyphRole[]) {
			expect(every.test(glyph(preset, role)), `${preset}/${role} missing from ALL_GLYPH_CLASS`).toBe(true);
		}
	}
});


test("every ramp has its declared length, so a typo cannot silently shorten one", () => {
	expect(glyphsFor("unicode").sparkRamp).toHaveLength(SPARK_LEVELS);
	expect(glyphsFor("ascii").sparkRamp).toHaveLength(SPARK_LEVELS);
	expect(glyphsFor("unicode").heatCell).toHaveLength(HEAT_LEVELS);
	expect(glyphsFor("ascii").heatCell).toHaveLength(HEAT_LEVELS);
});

test("sparkRamp is the eight vertical eighths, lowest first", () => {
	expect(glyph("unicode", "sparkRamp", 0)).toBe("▁");
	expect(glyph("unicode", "sparkRamp", 7)).toBe("█");
	expect(glyphsFor("unicode").sparkRamp).toHaveLength(8);
});

test("barFill is the full block, barEmpty the light shade — the daily-bar pair", () => {
	expect(glyph("unicode", "barFill")).toBe("█"); // U+2588
	expect(glyph("unicode", "barEmpty")).toBe("░"); // U+2591
});

test("heatCell is one repeated rung, so a codepoint swap is the only edit", () => {
	// Every level is one cell wide under every preset; that is what keeps a
	// ladder swap free. The U+25A0 identity itself is pinned by the next test.
	for (const preset of PRESETS) {
		expect(glyphsFor(preset).heatCell).toHaveLength(HEAT_LEVELS);
		for (let level = 0; level < HEAT_LEVELS; level++) {
			expect(Bun.stringWidth(glyph(preset, "heatCell", level)), `${preset} heat level ${level}`).toBe(1);
		}
	}
});

test("heatCell is the single U+25A0 square at every level under unicode/nerd", () => {
	// usage-dashboard.ts:867 renders every level 1..4 as the same square; the
	// ramp lives in the colour, not the glyph. Distinct rungs would
	// double-encode the level beside the colour.
	for (const preset of ["unicode", "nerd"] as const) {
		for (let level = 0; level < HEAT_LEVELS; level++) {
			expect(glyph(preset, "heatCell", level).codePointAt(0), `${preset} level ${level}`).toBe(0x25a0);
		}
	}
});

test("MEASUREMENT TRAP: sep.pipe is 3 cells under unicode but 1 under nerd — never a column separator", () => {
	// Using sep.pipe would triple the gap on two presets and leave the third correct:
	// an alignment bug invisible under `nerd`.
	expect(Bun.stringWidth(theme.symbol("sep.pipe"))).toBe(3);
	expect(Bun.stringWidth(SYMBOL_PRESETS.nerd["sep.pipe"])).toBe(1);
	for (const preset of PRESETS) {
		expect(Bun.stringWidth(glyph(preset, "columnGap")), `${preset} columnGap`).toBe(1);
		expect(glyph(preset, "columnGap"), `${preset} columnGap`).not.toBe(SYMBOL_PRESETS[preset]["sep.pipe"]);
	}
});

test("MEASUREMENT TRAP: bare ⚠ is 1 cell, ⚠️ with VS16 is 2 — the warning icon uses the bare form", () => {
	expect(Bun.stringWidth("⚠")).toBe(1);
	expect(Bun.stringWidth("⚠️")).toBe(2);
	expect(statsIcon("unicode", "warning")).toBe("⚠");
	expect(statsIcon("unicode", "warning")).not.toContain("️");
	for (const preset of PRESETS) {
		expect(statsIcon(preset, "warning")).not.toContain("️");
	}
});

test("icons: unicode preset uses emoji, nerd uses PUA, ascii uses plain ASCII labels", () => {
	expect(statsIcon("unicode", "cost")).toBe("💲");
	expect(statsIcon("nerd", "cost")).toBe("");
	expect(statsIcon("ascii", "cost")).toBe("$");
	for (const icon of Object.values(STATS_ICONS.ascii)) {
		expect(/^[\x20-\x7E]+$/.test(icon), `ascii icon must be ASCII: ${icon}`).toBe(true);
	}
});

test("icons: only four roles are new; twelve route through a host key", () => {
	expect([...NEW_ICON_ROLES].sort()).toEqual(["calendar", "gains", "trendDown", "trendUp"]);
	expect(Object.keys(STATS_ICONS.unicode)).toHaveLength(16);
	expect(Object.keys(HOST_ICON_KEYS)).toHaveLength(12);
});

test("icons: every role has a non-empty value in all three presets", () => {
	for (const preset of PRESETS) {
		for (const role of Object.keys(STATS_ICONS[preset]) as (keyof typeof STATS_ICONS.unicode)[]) {
			expect(STATS_ICONS[preset][role].length, `${preset}/${role}`).toBeGreaterThan(0);
		}
	}
});

test("icons: every unicode icon is one or two cells, and ICON_GUTTER matches the widest", () => {
	for (const [role, icon] of Object.entries(STATS_ICONS.unicode)) {
		expect([1, 2], `${role}=${icon}`).toContain(Bun.stringWidth(icon));
	}
	expect(ICON_GUTTER.unicode).toBe(2); // emoji are 2 cells; headings reserve the wider gutter
	expect(ICON_GUTTER.nerd).toBe(1);
	// The gutter must be wide enough for the icons actually shipped, or every
	// heading after the first misaligns.
	const widestUnicode = Math.max(...Object.values(STATS_ICONS.unicode).map(i => Bun.stringWidth(i)));
	expect(ICON_GUTTER.unicode).toBeGreaterThanOrEqual(widestUnicode);
	const widestNerd = Math.max(...Object.values(STATS_ICONS.nerd).map(i => Bun.stringWidth(i)));
	expect(ICON_GUTTER.nerd).toBeGreaterThanOrEqual(widestNerd);
});

test("every role not in HOST_ICON_KEYS is genuinely absent from omp's SYMBOL_PRESETS", () => {
	// Guards the reuse direction. If a future omp release registers a key we could
	// have reused, this fails and the role should be moved into HOST_ICON_KEYS
	// rather than left shadowing the host's choice.
	const hostKeys = new Set(Object.keys(SYMBOL_PRESETS.unicode));
	for (const key of Object.values(HOST_ICON_KEYS)) {
		expect(hostKeys.has(key), `host key ${key} must exist`).toBe(true);
	}
	for (const role of NEW_ICON_ROLES) {
		const stem = role.replace(/[A-Z]/g, c => `.${c.toLowerCase()}`);
		const derived = [stem, stem.replace(".", ""), `icon.${role}`];
		for (const candidate of derived) {
			expect(hostKeys.has(candidate), `${role}: ${candidate} is now registered by the host`).toBe(false);
		}
	}
});

test("statsIcon prefers the host registry when a theme is supplied", () => {
	for (const [role, key] of Object.entries(HOST_ICON_KEYS)) {
		expect(statsIcon("unicode", role as never, liveTheme)).toBe(liveTheme.symbol(key));
	}
	// Without a theme the pure table is used — that is the load-order-safe path.
	expect(statsIcon("unicode", "calendar")).toBe(STATS_ICONS.unicode.calendar);
});

test("ascii heat ladder is . - + #, distinct per level", () => {
	const set = glyphsFor("ascii");
	expect(set.heatCell).toEqual([".", "-", "+", "#"]);
	expect(new Set(set.heatCell as readonly string[]).size).toBe(4);
	expect(set.heatEmpty).toBe(" ");
});

test("ascii sparkline is an eight-rung ranking ladder, all distinct", () => {
	const ramp = glyphsFor("ascii").sparkRamp as readonly string[];
	expect(ramp).toHaveLength(8);
	expect(new Set(ramp).size).toBe(8);
	for (const g of ramp) expect(Bun.stringWidth(g)).toBe(1);
});

test("glyph clamps the level into the ramp instead of returning undefined", () => {
	expect(glyph("unicode", "sparkRamp", 99)).toBe("█");
	expect(glyph("unicode", "sparkRamp", -5)).toBe("▁");
	expect(glyph("unicode", "heatCell", 7)).toBe(glyph("unicode", "heatCell", HEAT_LEVELS - 1));
});

test("a 7x53 heatmap is exactly 108 cells wide on every row, under both ladders", () => {
	// Review Focus line 5: an ASCII ladder that misaligns by one cell is worse
	// than the Unicode one. This is the reason the whole module exists.
	for (const preset of ["unicode", "ascii"] as const) {
		const set: GlyphSet = glyphsFor(preset);
		const gap = glyph(preset, "columnGap");
		const widths = new Set<number>();
		for (let day = 0; day < 7; day++) {
			const label = `${["M", "T", "W", "T", "F", "S", "S"][day]} `;
			let row = label;
			for (let week = 0; week < 53; week++) {
				const level = (day * 7 + week) % (HEAT_LEVELS + 1);
				row += (level === 0 ? glyph(preset, "heatEmpty") : glyph(preset, "heatCell", level - 1)) + gap;
			}
			widths.add(Bun.stringWidth(row));
		}
		expect([...widths], `${preset} heatmap row widths`).toEqual([108]);
		expect(set.heatCell).toBeDefined();
	}
});


/**
 * The `nf-*` name each nerd PUA value is supposed to be. Source: the
 * nerd-fonts cheat sheet CSS
 * (https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/css/nerd-fonts-generated.css),
 * read codepoint-first: the glyph at a codepoint IS whatever name the sheet
 * assigns that codepoint to. A name that matches nothing makes its column tofu
 * under a Nerd Font; a wrong name fails this test before it ships.
 */
const NERD_CP_BY_ROLE: Record<string, { cp: string; nf: string }> = {
	cost: { cp: "F155", nf: "nf-fa-dollar" },
	tokens: { cp: "E26B", nf: "nf-fae-coins" },
	requests: { cp: "F201", nf: "nf-fa-line_chart" },
	time: { cp: "F017", nf: "nf-fa-clock_o" },
	models: { cp: "EC19", nf: "nf-cod-chip" },
	providers: { cp: "F048B", nf: "nf-md-server" },
	tools: { cp: "F0AD", nf: "nf-fa-wrench" },
	projects: { cp: "F07C", nf: "nf-fa-folder_open" },
	errors: { cp: "F057", nf: "nf-fa-times_circle" },
	calendar: { cp: "F073", nf: "nf-fa-calendar" },
	gains: { cp: "F0535", nf: "nf-md-trending_up" },
	trendUp: { cp: "F062", nf: "nf-fa-arrow_up" },
	trendDown: { cp: "F063", nf: "nf-fa-arrow_down" },
	unknown: { cp: "F059", nf: "nf-fa-circle_question" },
	cache: { cp: "F1C0", nf: "nf-fa-database" },
	warning: { cp: "F071", nf: "nf-fa-warning" },
};

test("nerd codepoints are the cheat-sheet codepoints for their nf-* names", () => {
	const mismatches: string[] = [];
	for (const [role, want] of Object.entries(NERD_CP_BY_ROLE)) {
		const actual = STATS_ICONS.nerd[role as keyof typeof STATS_ICONS.nerd];
		const actualCp = [...actual].map((c) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase()).join("+");
		if (actualCp !== want.cp) mismatches.push(`${role}: table has U+${actualCp}, cheat sheet has ${want.nf} = U+${want.cp}`);
	}
	expect(mismatches).toEqual([]);
});

test("icons: every unicode emoji is exactly the width the gutter expects", () => {
	// Heading-only entries must measure 2 (heading layout reserves the
	// 2-cell gutter); the five Narrow entries must measure 1 because they are
	// legal in a data cell too. A VS16 variant would silently change either
	// number, so both arms are asserted by MEASUREMENT, not by eye.
	const WANT2 = [
		["cost", "💲", "U+1F4B2"], ["tokens", "🪙", "U+1FA99"], ["requests", "📊", "U+1F4CA"],
		["projects", "📁", "U+1F4C1"], ["errors", "❌", "U+274C"], ["calendar", "📅", "U+1F4C5"],
		["gains", "💹", "U+1F4B9"], ["unknown", "❓", "U+2753"], ["cache", "💾", "U+1F4BE"],
	] as const;
	const WANT1 = [
		["time", "⏱", "U+23F1"], ["models", "⬢", "U+2B22"], ["providers", "🛰", "U+1F6F0"],
		["tools", "🛠", "U+1F6E0 bare — the VS16 form is 2"], ["warning", "⚠", "U+26A0 bare"],
	] as const;
	for (const [role, glyph, evidence] of WANT2) {
		expect(Bun.stringWidth(glyph), `${role} ${evidence}`).toBe(2);
		expect(STATS_ICONS.unicode[role as keyof typeof STATS_ICONS.unicode], role).toBe(glyph);
	}
	for (const [role, glyph, evidence] of WANT1) {
		expect(Bun.stringWidth(glyph), `${role} ${evidence}`).toBe(1);
		expect(STATS_ICONS.unicode[role as keyof typeof STATS_ICONS.unicode], role).toBe(glyph);
	}
});