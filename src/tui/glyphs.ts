import type { SymbolPreset } from "@oh-my-pi/pi-tui";

// Re-exported so every consumer imports the one type from one place; render code
// should never have to reach into pi-tui for the vocabulary of this module.
export type { SymbolPreset };

/**
 * Roles this module owns. Everything that carries a magnitude in a rendered cell
 * is a GlyphRole; nothing else may branch on the symbol preset.
 */
export type GlyphRole =
	| "barFill"
	| "barEmpty"
	| "sparkRamp"
	| "heatCell"
	| "heatEmpty"
	| "columnGap"
	| "axisLine"
	| "trendUp"
	| "trendFlat"
	/**
	 * The keyboard cursor on the selected row of a list. `▶` is the row pointer,
	 * NOT a trend arrow — see {@link GlyphRole} `trendUp` for why the two must
	 * stay separate roles even though ascii gives them the same fallback shape.
	 */
	| "rowCursor"
	/**
	 * The legend key beside a series label. Distinct from `heatCell`, which is
	 * ONE square whose LEVEL is carried by colour: a legend key carries no level
	 * at all, and must not inherit a ramp.
	 */
	| "legendKey"
	/**
	 * A point on a scatter/line chart, hollow. `pointFilled` is the same mark
	 * made solid, for a series that is drawn filled rather than outlined.
	 */
	| "pointHollow"
	| "pointFilled"
	/**
	 * The horizontal run a plot's corner turns into. A rule with no corner is a
	 * different shape worth naming on its own; ascii needs `-` for it.
	 */
	| "axisRule"
	/**
	 * A vertical spine at the left edge of a plot — the same mark as
	 * `columnGap`, kept as its own role so a future change to one cannot
	 * silently restyle the other.
	 */
	| "plotSpine"
	/**
	 * A marker dropped on a track. Deliberately a filled diamond so it cannot
	 * be confused with `pointFilled` at a glance.
	 */
	| "trackMarker"
	/**
	 * The playhead: where "now" is on a time axis. It points DOWN because it sits
	 * above the axis it marks, and down is the direction of the thing it labels.
	 */
	| "playhead";

/**
 * A role resolves to either a single glyph or, for a ramp, an ordered ladder
 * indexed by level. `glyph()` hides the difference from render code.
 */
export type GlyphValue = string | readonly string[];
export type GlyphSet = Readonly<Record<GlyphRole, GlyphValue>>;

/** Ramp lengths, exported so charts can size a level domain without hardcoding numbers. */
export const HEAT_LEVELS = 4;
export const SPARK_LEVELS = 8;

/**
 * The unicode ladder. Block elements are font-independent rather than
 * Nerd-specific, so `nerd` reuses this exact object — see SETS below.
 *
 * Every value must measure `Bun.stringWidth === 1`. That is the whole reason
 * this module exists rather than a `theme.symbol()` call: the host registry is a
 * flat `Record<SymbolKey, string>` of 269 keys, none of which is a data-ink
 * ramp, so "the fourth of eight block fills" is inexpressible through it.
 */
const UNICODE_GLYPHS = {
	barFill: "█", // U+2588
	barEmpty: "░", // U+2591
	sparkRamp: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"], // U+2581..U+2588
// heatCell is ONE square at every level: `/usage` renders levels 1..4 as the
// same ■ with the level carried by the colour alone
// (usage-dashboard.ts:867). A shade ramp here would double-encode the level
// beside the colour and read as a different calendar next to the real one.
heatCell: ["■", "■", "■", "■"], // U+25A0 ×4 — every rung is BLACK SQUARE
	heatEmpty: "·", // U+00B7 — byte-identical to the host's own /usage heatmap
	// Bare U+2502, never `theme.symbol("sep.pipe")`: sep.pipe measures 3 cells
	// under unicode/ascii and 1 under nerd, so it would triple the gap on two
	// presets and look correct on the third.
	columnGap: "│", // U+2502 — matches boxRound.vertical
	// The chart baseline, as a MARK rather than a rule.
	//
	// DIVERGENCE FROM THE WEB, deliberate: the web strokes a real `<line>` at
	// y(0) in `--line-3` (Chart.tsx:304). G5 and /usage's zero-rules body forbid
	// a full-width rule here, so we MARK the floor instead of drawing one — and a
	// mark is the better terminal translation anyway, because a rule cannot be
	// distinguished from a section separator. `─`/`━`/`═` would also trip G5's
	// RULE_RUN, and this is deliberately not `sparkRamp[0]`: a floor mark and a
	// sparkline rung are different meanings and should be able to move apart.
	//
	// `_` in EVERY preset, and that is the whole reason it is `_` and not `·`.
	// A baseline belongs at the BOTTOM of the cell; `·` is vertically centred and
	// would float in the middle of the plot. The same argument made ascii `_`
	// rather than a dot, and unicode was simply inconsistent until this line was
	// made to match. It also makes the mark distinct from `heatEmpty` on every
	// preset, which it did not before.
	axisLine: "_", // U+005F
	trendUp: "▲", // U+25B2
	trendFlat: "─", // U+2500 — a flat value; live in the frustration connector row
	/**
	 * `▶` — the row the keyboard cursor is on. It is a POINTER, not a trend:
	 * `▶` and `▲` both point at something, and reading them as one mark is how
	 * "this row is selected" turns into "this value is rising".
	 */
	rowCursor: "▶", // U+25B6
	/**
	 * `■` — the key beside a legend label. Deliberately the SAME square as
	 * `heatCell`, one shape doing two jobs: a legend key carries no level, so
	 * sharing `heatCell`'s role would make the ascii ladder emit a different
	 * character per legend entry for no reason.
	 */
	legendKey: "■", // U+25A0
	/**
	 * `•` / `●` — an outlined point, and the same point made solid. Two disc
	 * sizes are the terminal's only way to say "this series is filled" without
	 * spending a second colour on it.
	 */
	pointHollow: "•", // U+2022
	pointFilled: "●", // U+25CF
	/**
	 * `─` — the run that follows a plot's corner. The corner says "origin", the
	 * rule says "this is where values are read from"; they are two roles because
	 * a rule with no corner is a different shape worth naming on its own.
	 */
	axisRule: "─", // U+2500
	/**
	 * `│` — the plot's left spine. Identical to `columnGap` and kept apart on
	 * purpose: one is the gap BETWEEN two columns of text, the other is the
	 * edge a plot's values hang off, and a change to one must not restyle the
	 * other.
	 */
	plotSpine: "│", // U+2502
	/**
	 * `◆` — an event marked on a track. A DIAMOND rather than a disc so it
	 * cannot be mistaken for `pointFilled` at a glance, which is the whole job
	 * of marking something that is not a plotted value.
	 */
	trackMarker: "◆", // U+25C6
	/**
	 * `▼` — the playhead on a time axis. Points DOWN because it sits above the
	 * axis and points at it; up would point away from the thing it labels.
	 */
	playhead: "▼", // U+25BC
} as const satisfies GlyphSet;

/**
 * The ascii ladder. ASCII has no vertical shading, so the spark ramp here is a
 * *ranking* ladder (distinct characters in a fixed order) rather than a density
 * one — an ascii chart gains resolution by stacking rows, never by inventing
 * sub-cell glyphs. heatEmpty is a real blank, which is why the width-1 test
 * carries exactly one documented exception for it.
 */
const ASCII_GLYPHS = {
	barFill: "#", // U+0023 — also omp's own ascii choice for sep.block
	barEmpty: ".",
	sparkRamp: [".", ":", "-", "=", "+", "*", "#", "@"], // 8 distinct rungs
	// Level 1 is "." rather than ":" so the zero cell (heatEmpty, a blank) stays
	// visually distinct from the faintest recorded day.
	heatCell: [".", "-", "+", "#"],
	heatEmpty: " ",
	columnGap: "|",
	// The same `_` the unicode set uses, for the same reason: a baseline sits at
	// the bottom of the cell. It is never a blank, or the floor would vanish under
	// ascii entirely.
	axisLine: "_", // U+005F
	trendUp: "^",
	trendFlat: "-",
	// Every fallback below is chosen for what it must DISAMBIGUATE from the
	// characters already in this set, not for how it looks alone.
	//
	// `>` matches the host's own ascii `nav.cursor` (symbols.ts:1182), so a list
	// row points the same way under ascii as it does in the sidebar. `*` is the
	// legend key because `.` is already both `barEmpty` and `sparkRamp[0]`;
	// `+` and `@` are the two point marks because `+` is `sparkRamp[5]` and
	// `@` is `sparkRamp[7]` — neither co-occurs with a sparkline in the same
	// view, which is the same bargain the existing ladder already makes. `|` is
	// the spine because it is literally `columnGap`'s character.
	rowCursor: ">", // U+003E — the host's ascii nav.cursor
	legendKey: "*", // U+002A — `.` is barEmpty/sparkRamp[0]
	pointHollow: "+", // U+002B
	pointFilled: "@", // U+0040 — sparkRamp[7]; never in the same view
	// `-` is also `trendFlat`, which is right: an axis and a flat value are both
	// one horizontal mark, and the two never share a view.
	axisRule: "-", // U+002D — same mark as trendFlat, never in the same view
	plotSpine: "|", // U+007C — the same vertical mark as columnGap
	trackMarker: "o", // U+006F — never in the same view as a point mark
	playhead: "v", // U+0076 — the only downward ASCII mark
} as const satisfies GlyphSet;

/**
 * One lookup, no branching — the module's contract is that this is the ONLY
 * place the symbol preset is consulted. `nerd` is the *same object* as
 * `unicode`, not a copy: no Nerd Font codepoint's semantics is magnitude, so
 * data ink must be byte-identical between the two presets, and sharing the
 * object makes that structural rather than a promise.
 */
const SETS: Record<SymbolPreset, GlyphSet> = {
	unicode: UNICODE_GLYPHS,
	nerd: UNICODE_GLYPHS,
	ascii: ASCII_GLYPHS,
};

export function glyphsFor(preset: SymbolPreset): GlyphSet {
	return SETS[preset];
}

/**
 * Resolve one glyph, clamping `level` into the ramp.
 *
 * Clamping rather than throwing is deliberate: a level is computed from a ratio
 * over live data, so an out-of-range value is an ordinary edge case (a first-ever
 * run, a degenerate bucket) and must not be able to crash a render pass.
 */
export function glyph(preset: SymbolPreset, role: GlyphRole, level = 0): string {
	const value = glyphsFor(preset)[role];
	if (typeof value === "string") return value;
	const clamped = Math.max(0, Math.min(value.length - 1, Math.round(level)));
	return value[clamped] ?? value[0];
}

const ALL_PRESETS: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];

/**
 * A regex character class matching every glyph the given roles can render, on
 * every preset — for tests that must recognise data ink by SHAPE rather than by
 * a hand-typed list.
 *
 * This exists because seventeen of those hand-typed lists existed across six
 * test files, and they drift the moment a role changes. The clearest instance:
 * `/^[█#░]{2} \S/` kept listing `░` after the charts stopped drawing `barEmpty`
 * as a track fill, so the class asserted something that could no longer happen
 * while implying something else still could. A class built from the roles
 * cannot be wrong that way — it is right by construction, in both directions.
 *
 * Union over ALL presets, because these classes are used against rendered output
 * whose preset the caller usually does not know. Returns a bare class BODY, so
 * callers write `new RegExp(`^[${glyphClass(...)}]+`)` and keep control of their
 * own anchors.
 */
export function glyphClass(...roles: readonly GlyphRole[]): string {
	const glyphs = new Set<string>();
	for (const preset of ALL_PRESETS) {
		for (const role of roles) {
			const value = glyphsFor(preset)[role];
			// `-` is escaped as well as the usual three: inside a class it would
			// otherwise read as a RANGE, and the ascii set is full of `.` `*` `+`
			// `#` `|`, any of which would change what the class matches.
			for (const g of typeof value === "string" ? [value] : value) {
				glyphs.add(g.replace(/[\\\]^-]/g, "\\$&"));
			}
		}
	}
	return [...glyphs].join("");
}

/**
 * Every glyph this module can render, on every preset. For detectors that mean
 * "this row contains ANY data ink" rather than "this row contains bars" — the
 * question that a per-chart-shape list answers incorrectly the moment a chart
 * adopts a new mark.
 */
export const ALL_GLYPH_CLASS = glyphClass(
	// Derived from the keys rather than hand-listed, because a hand-list is the
	// exact failure this module documents: `ALL_GLYPH_CLASS` is what detectors
	// use to recognise data ink by shape, so a role added without a line here
	// would be undetectable while every test still passed. Reading the keys
	// makes it right by construction — a new role cannot be forgotten.
	...(Object.keys(UNICODE_GLYPHS) as GlyphRole[]),
);