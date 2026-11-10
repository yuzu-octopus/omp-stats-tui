import { hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils";
import { colorToAnsi } from "@oh-my-pi/pi-tui/theme/color";
import type { SymbolPreset } from "@oh-my-pi/pi-tui";
import type { ThemeColor } from "@oh-my-pi/pi-tui";
import type { ThemeBg } from "@oh-my-pi/pi-tui/theme";

/**
 * The colour layer.
 *
 * Every colour in the panel is a NAMED omp theme token, never a literal hex.
 * That is the whole point: the user asked for colours that "follow the omp
 * colour scheme", and a theme is a user's chosen set of hues. A hardcoded
 * `#f068c8` would look identical to the web dashboard today and wrong the moment
 * anyone switches theme — which is precisely the cohesion failure we are
 * avoiding. Resolving a token costs a lookup and inherits every future theme.
 *
 * The theme arrives INJECTED. The `theme` singleton throws when an extension
 * imports it at module scope, and reading it at import time would freeze the
 * colours of whichever theme happened to be active while this module loaded.
 */

/** The slice of omp's `Theme` this module needs. Narrow on purpose — it is the
 * whole dependency, and it makes tests injectable without building a Theme. */
export interface PaletteTheme {
	getColorHex(color: ThemeColor): string;
	getColorMode(): "truecolor" | "256color";
	getSymbolPreset(): SymbolPreset;
}

export type PaletteRole =
	| "primary"
	| "negative"
	| "positive"
	| "caution"
	| "heading"
	| "label"
	| "meta"
	| "muted"
	| "dim"
	| "faint";
/**
 * Role → theme token.
 *
 * Every role here stands in for a colour the web dashboard ACTUALLY paints, and
 * {@link PALETTE_TOKENS} names the CSS custom property and the line it was
 * declared on. That table is not documentation — `test/palette.test.ts` fails if
 * a role has no citation or if a citation names neither a `--token` nor a
 * `file:line`, because a role nobody can trace to a web rule is one that can
 * never be re-derived when the web moves.
 */
export const PALETTE = {
	/**
	 * `accent` — the one number a screen is about. `--accent`
	 * (styles.css:36). Reserved: css-tokens.md:104 restricts it to "the active
	 * sidebar item's icon" and the value flash, and says in as many words that a
	 * terminal must not use it as "the chart colour". It is spent sparingly here
	 * for the same reason — an accent on everything is an accent on nothing.
	 */
	primary: "accent",

	/**
	 * `error` — errors, failures and unpriced rows. `--bad` (styles.css:47).
	 * omp already routes tool failures through `theme.fg("error", …)`, so a
	 * failed request looks the same here as it does in a transcript.
	 */
	negative: "error",

	/**
	 * `success` — savings and successes. `--ok` (styles.css:43). Distinct from
	 * `warning`, so a saving never reads as a caution.
	 */
	positive: "success",

	/**
	 * `warning` — the pressured state: a meter pinned at its column maximum, a
	 * quota near exhaustion. `--warn` (styles.css:45); `/usage`'s `#statusColor`
	 * returns `warning` for exactly this state (usage-dashboard.ts:617-621).
	 */
	caution: "warning",

	/**
	 * `text` — screen and band TITLES. FIXED: this was `mdHeading`, which in
	 * omp's default dark theme resolves to `#febc38` — byte-identical to
	 * `accent` — so every title wore the hue css-tokens.md:104 reserves for the
	 * one number a screen is about, and a title stopped reading as a title.
	 *
	 * The web's headings are body ink, not a colour. `.page-title` declares
	 * 22px @600 and NO colour (styles.css:678-683) and `.card-title` declares
	 * 14px @550 and no colour (styles.css:770-777): both INHERIT `--ink-1` from
	 * `body` (styles.css:160). WEIGHT carries the emphasis, and the ink is
	 * simply the top of the ramp. A terminal's weight is a binary, so the INK has
	 * to carry the rank too — and ink-1 is that top rung.
	 */
	heading: "text",

	/**
	 * `text` — the value ink: the number a stat is about. `.stat-value`
	 * (styles.css:848-857) declares 24px @550 and no colour, inheriting
	 * `--ink-1` from `body` (styles.css:160).
	 *
	 * Same token as `heading`, on purpose. `.card-title` and `.stat-value` are
	 * both `--ink-1` on the web; they are told apart by SIZE, and a terminal row
	 * already tells them apart by position. Inventing a fifth ink here to make
	 * the map look busier would break the correspondence it exists to keep.
	 */
	label: "text",

	/**
	 * `dim` — secondary metadata: timestamps, "since", units, a table's meta
	 * column. FIXED: this was `muted` (`--ink-2`), one step TOO STRONG.
	 *
	 * Every piece of web metadata is `--ink-3`: `.stat-foot` (styles.css:867-874),
	 * `.table th` (styles.css:1269-1282), `.micro` (styles.css:267-273) and
	 * `.cell-secondary` (css-tokens.md:71, which lists them as the `ink-3`
	 * workhorses). Metadata drawn at label strength is metadata the eye reads as
	 * content — which is the whole reason the web keeps a separate rung for it.
	 */
	meta: "dim",

	/**
	 * `muted` — the label ink: a stat's label beside its value, a legend, muted
	 * secondary text. `--ink-2` (styles.css:28), which css-tokens.md:77 records
	 * as "stat labels, legends, muted secondary".
	 *
	 * This is the INK-2 rung and no more. The earlier comment here claimed it was
	 * "chrome that should recede entirely", which was not true of `--ink-2` and
	 * was the reason the nav looked flat: an off-section row dimmed to ink-3
	 * reads as DISABLED, so the group cue had nowhere to live but the heading.
	 */
	muted: "muted",

	/**
	 * `dim` — structure and hints: table headings, empty states, axis labels.
	 * `--ink-3` (styles.css:29), and `--chart-axis` is `#5c5c64`, dimmer still
	 * (styles.css:53).
	 */
	dim: "dim",

	/**
	 * `borderMuted` — the FAINTEST ink, one full step below `dim`. ADDED.
	 *
	 * The web has four inks and this ladder had three, so "the faintest thing on
	 * screen" had no name and every caller reached for `dim` instead. The
	 * consumer that needed it is `.nav-row kbd` (styles.css:565-570): a jump
	 * hint at `--ink-4` against a `--ink-2` label. `borderMuted` resolves to
	 * `#3d424a` in omp's default theme, one step under `dim`'s `#5f6673` — the
	 * same relative step the web takes from `#6c6c74` to `#46464c`.
	 */
	faint: "borderMuted",
} as const satisfies Record<PaletteRole, ThemeColor>;

/**
 * THE HEAT LADDER IS A RAMP, NOT ROLES. `heat0`..`heat3` used to be four
 * `PaletteRole`s; they are deleted. Nothing in `src/` rendered them — a cell's
 * colour comes from {@link heatRamp} and its glyph from the `heatCell`/
 * `heatEmpty` glyph roles — and the collapse-fallback claim their comment made
 * was never implemented. A role nobody renders is a colour a future reader will
 * wire to a different rule than its name implies.
 */

/**
 * What each {@link PaletteRole} matches in the web dashboard, as `--token` plus
 * the declaration site it was read from.
 *
 * Machine-checked by `test/palette.test.ts`: every role needs an entry, and
 * every entry must name a CSS custom property AND a `file:line`. This is the
 * acceptance criterion "each palette change cites the web token it now matches"
 * turned into something that fails rather than something that is promised.
 */
export const PALETTE_TOKENS = {
	primary: "--accent · `styles.css:36`",
	negative: "--bad · `styles.css:47`",
	positive: "--ok · `styles.css:43`",
	caution: "--warn · `styles.css:45`",
	// `heading` and `label` cite `body` (styles.css:160), not `.page-title` or
	// `.stat-value`: neither of those rules declares a colour at all, both
	// INHERIT ink-1. Citing the rules that do not declare the colour is how a
	// citation stops meaning anything.
	heading: "--ink-1 · `styles.css:160`",
	label: "--ink-1 · `styles.css:160`",
	meta: "--ink-3 · `styles.css:867`",
	muted: "--ink-2 · `styles.css:28`",
	dim: "--ink-3 · `styles.css:29`",
	faint: "--ink-4 · `styles.css:30`",
	// The web has NO heatmap — the ramp is `/usage`'s (usage-dashboard.ts:812).
	// The four `heatN` roles were deleted with their dead ladder; only the ramp
	// remains, and its stops are cited above.
} as const satisfies Record<PaletteRole, string>;

// ---------------------------------------------------------------------------
// THE NAVIGATION LADDER

/**
 * Every ink the sidebar and the tab strip draw with, as a NAMED level rather
 * than as a token chosen at the call site.
 *
 * The reported defect was "the group headings are all the same colour", and
 * the cause was not one bad pick — it was that there was no LADDER to pick
 * from. `chrome.ts` reached for `accent`, `muted` and `dim` directly, so the
 * heading, the active row, the inactive row and the jump hint all landed inside
 * one ink step and the block read as a list of words rather than a control.
 *
 * Naming the levels makes the ladder a thing tests can assert on, and makes the
 * four levels distinguishable by COLOUR rather than only by cursor glyph and
 * bold — which is the only way the hierarchy survives a terminal that renders
 * no bold at all.
 */
export type SidebarInkRole =
	| "headingActive"
	| "headingInactive"
	| "rowActive"
	| "rowHover"
	| "rowInactive"
	| "iconActive"
	| "iconInactive"
	| "jumpKey";

export const SIDEBAR_INK = {
	/**
	 * `text` (`--ink-1`) — the heading of the group you are IN.
	 *
	 * `.nav-heading` is `--ink-3` @500 for EVERY group (styles.css:515-520); the
	 * web has no "active group". Stepping the containing heading up one ink is
	 * OURS, and it borrows the web's own rule for selection rather than
	 * inventing one — `.nav-row` goes `--ink-2` → `--ink-1` when selected
	 * (styles.css:522-536, :547-551).
	 *
	 * It is deliberately NOT `accent`. That was the previous behaviour, and it
	 * is what made the nav flat: the active heading and the active ROW then wore
	 * the same hue, so the heading stopped being structure and became a second
	 * selection marker.
	 */
	headingActive: "text",

/** `dim` (`--ink-3`) — every other group's heading. `.nav-heading` (styles.css:515-520). */
	headingInactive: "dim",

	/**
	 * `text` (`--ink-1`) — the active row's label. `.nav-row[data-active="true"]`
	 * is `background: var(--selected); color: var(--ink-1)`
	 * (styles.css:547-550).
	 *
	 * CORRECTED. This was `accent`, on a reading of the css-tokens.md:97 table cell,
	 * which says `--accent` is "the active nav item's icon and text accent". That
	 * cell is wrong about the web — the doc's own prose at css-tokens.md:104 says
	 * "the active sidebar item's ICON and the value flash animation", and the
	 * CSS agrees — the active row's `color` is ink-1 and the accent appears only
	 * on `svg` (styles.css:557-559). So the accent is spent in exactly ONE place
	 * in the whole sidebar, the active row's icon, and the label is ink-1 like
	 * every other thing the reader has selected.
	 */
	rowActive: "text",

	/**
	 * `text` (`--ink-1`) — a hovered row. `.nav-row:hover` is
	 * `background: var(--hover); color: var(--ink-1)` (styles.css:538-541).
	 *
	 * Hover and active share this ink AND the same band, because the web spends
	 * `--hover` (0.035 alpha) versus `--selected` (0.075) on the BACKGROUND to
	 * separate two states that are otherwise both ink-1, and a terminal has one
	 * background token and no alpha. The two are told apart by the accent icon,
	 * the cursor and the weight instead — and every one of those survives a theme
	 * that renders no bold, because the icon does.
	 */
	rowHover: "text",

	/** `muted` (`--ink-2`) — an ordinary row. `.nav-row` (styles.css:522-536). */
	rowInactive: "muted",

	/** `accent` (`--accent`) — the active row's icon. `.nav-row[data-active] svg` (styles.css:557-559). */
	iconActive: "accent",

	/**
	 * `dim` (`--ink-3`) — every other row's icon. `.nav-row svg` (styles.css:552-555).
	 * One step below its own label, so the icon reads as chrome FOR the label
	 * rather than as a second label.
	 */
	iconInactive: "dim",

	/**
	 * `borderMuted` (`--ink-4`) — the `G O` jump hint. `.nav-row kbd` is
	 * `--ink-4` at 10.5px against a `--ink-2` row (styles.css:565-570): one full
	 * ink below its label, and the faintest thing in the nav.
	 */
	jumpKey: "borderMuted",
} as const satisfies Record<SidebarInkRole, ThemeColor>;

export type TabInkRole = "active" | "hover" | "inactive" | "muted" | "hint";

/**
 * The tab strip's inks, mirroring `.segmented` — the web's own treatment of
 * "a row of options with one of them selected".
 *
 * This matters because the strip is the panel's largest piece of chrome: at
 * twelve tabs it is more line than any band. Drawing every inactive segment at
 * `--ink-2` put the strip at the same strength as the nav labels beside it, and
 * a strip that reads as body text is not a control. At `--ink-3` options against
 * one `--ink-1` thumb it reads as ONE object with a position in it.
 */
export const TAB_INK = {
	/** `text` (`--ink-1`) — the selected segment, on the `--raised` thumb. `.segmented-option[data-active]` (styles.css:1100-1102, :1068-1080). */
	active: "text",
	/** `text` (`--ink-1`) — a hovered segment. `.segmented-option:hover` (styles.css:1096-1098). */
	hover: "text",
	/** `dim` (`--ink-3`) — every ordinary segment. `.segmented-option` (styles.css:1082-1094). */
	inactive: "dim",
	/**
	 * `borderMuted` (`--ink-4`) — a segment the reader should skip. There is no
	 * web equivalent: `.segmented` has no disabled state, and the dashboard's
	 * only "disabled" styling is an `opacity` on `.btn` (styles.css:936-938).
	 * So this is the web's FAINTEST INK (`--ink-4`, styles.css:30 — the rung
	 * css-tokens.md:79 assigns to disabled text and placeholders) used for the
	 * same reason. A "skipped" tab as loud as an ordinary one says nothing.
	 */
	muted: "borderMuted",
	/**
	 * `borderMuted` (`--ink-4`) — the strip's own cycle hint. Also OURS: the
	 * web has no cycle hint, because a browser tab strip has no keyboard. It is
	 * the faintest ink so it never competes with the twelve options it describes.
	 */
	hint: "borderMuted",
} as const satisfies Record<TabInkRole, ThemeColor>;

/**
 * What each nav level matches in the web dashboard. Same contract as
 * {@link PALETTE_TOKENS} — a level with no web rule behind it is a level that
 * will drift.
 */
export const NAV_TOKENS = {
	// The active group's heading has NO web rule — `.nav-heading` is ink-3 for
	// every group and there is no `[data-active]` variant. The step up to ink-1
	// is ours, borrowing the web's own "you are here = ink-1" from
	// `.nav-row[data-active]` (styles.css:547-550), and it is cited there
	// rather than to `.nav-heading` so the table does not imply a rule that
	// does not exist.
	headingActive: "--ink-1 · `styles.css:547`",
	headingInactive: "--ink-3 · `styles.css:515`",
	rowActive: "--ink-1 · `styles.css:547`",
	rowHover: "--ink-1 · `styles.css:538`",
	rowInactive: "--ink-2 · `styles.css:522`",
	iconActive: "--accent · `styles.css:557`",
	iconInactive: "--ink-3 · `styles.css:552`",
	jumpKey: "--ink-4 · `styles.css:565`",
} as const satisfies Record<SidebarInkRole, string>;

export const TAB_TOKENS = {
	active: "--ink-1 · `styles.css:1100`",
	hover: "--ink-1 · `styles.css:1096`",
	inactive: "--ink-3 · `styles.css:1082`",
	// `muted` and `hint` are OURS — `.segmented` has no disabled state and the
	// dashboard has no cycle hint — so they cite the INK they use, not a rule
	// they were lifted from. See the two JSDoc blocks on TAB_INK.
	muted: "--ink-4 · `styles.css:30`",
	hint: "--ink-4 · `styles.css:30`",
} as const satisfies Record<TabInkRole, string>;

// ---------------------------------------------------------------------------
// THE BACKGROUND AXIS

/**
 * The ONE background the panel fills, as a named role.
 *
 * WHY A SEPARATE TABLE, AND NOT A `PALETTE` ENTRY. The host declares TWO
 * unions, not one: `ThemeColor` for ink and `ThemeBg` for the seven
 * backgrounds (`@oh-my-pi/pi-tui/src/theme/schema.ts:174-179`). `selectedBg`
 * is in the second, and the two are not interchangeable — `theme.fg()` accepts
 * only `ThemeColor` and `theme.bg()` only `ThemeBg`. Folding this into
 * {@link PALETTE} would widen that table to `ThemeColor | ThemeBg` and every
 * `fg(PALETTE.x)` call site would stop compiling. Keeping the axes apart makes
 * "painted the wrong kind of token" a TYPE ERROR rather than a cell that
 * silently renders uncoloured.
 *
 * `test/palette.test.ts` asserts `isValidThemeColor` over every `PALETTE`
 * role, and `isValidThemeColor("selectedBg")` is FALSE — the token is real,
 * it is simply not ink. A role that could not pass its own table's membership
 * test does not belong in that table.
 *
 * WHY IT NEEDED NAMING AT ALL. `.nav-row[data-active="true"]` is
 * `background: var(--selected)` (styles.css:547-550), so the web FILLS the
 * selected row rather than merely tinting it. Five call sites each wrote the
 * bare literal `bg("selectedBg", …)`, which `test/theme-fidelity.test.ts`
 * correctly reports as a colour with no named role: the fill was real, but
 * nothing in the tree had given it a name, a citation, or a reason anybody
 * could later reconstruct.
 */
export type SelectionBgRole = "band";

export const SELECTION_BG = {
	/**
	 * `selectedBg` — the band behind whatever is selected: the nav's active row,
	 * the nav's hovered row, the tab strip's active thumb, and the topbar's live
	 * chip. `--selected` (styles.css:547, and the token table at
	 * css-tokens.md:43, which records it as `rgba(255,255,255,0.075)`).
	 *
	 * ONE role for all four sites is the point, not a simplification. The web
	 * spends `--hover` at 0.035 alpha against `--selected` at 0.075 to tell
	 * `hover` from `active`, and a terminal has one background token and no
	 * alpha — so the two states share the band here and are separated by the
	 * ink, the cursor and the weight instead (see `SIDEBAR_INK.rowHover`).
	 * That is a deliberate, already-documented divergence; a second
	 * "hoverBg" role would imply a distinction the host cannot render.
	 */
	band: "selectedBg",
} as const satisfies Record<SelectionBgRole, ThemeBg>;

/**
 * What the selection band matches in the web dashboard. Same machine-checked
 * contract as {@link PALETTE_TOKENS} — see `test/palette.test.ts`.
 */
export const SELECTION_BG_TOKENS = {
	band: "--selected · `styles.css:547`",
} as const satisfies Record<SelectionBgRole, string>;

// ---------------------------------------------------------------------------
// THE TRACE SPAN LADDER

/**
 * Span kind → theme token, for the traces timeline.
 *
 * Traces legitimately needs a per-kind colour: the whole point of a flamegraph
 * is that you can find "the tool spans" without reading a label. What it must
 * NOT do is keep that mapping in a private table beside its only renderer —
 * `test/theme-fidelity.test.ts` is right that a `Record<K, ThemeColor>` outside
 * this file has no citation and cannot be re-derived when a role moves. (A
 * lookup through a local table also carries no literal at the call site, so no
 * use-site scan can see it; that is why it needed its own check.)
 *
 * THE ORDER AND EVERY VALUE BELOW ARE THE WEB'S, NOT OURS. `CATEGORY_VARS` in
 * `@oh-my-pi/omp-stats/src/client/traces/trace-colors.ts:37-43` is the file the
 * dashboard's own flamegraph canvas reads its five category fills from, and
 * each entry here is the terminal's nearest ink for that CSS custom property.
 * The web has no traces parity document — `docs/research/omp-stats-tui/REPORT.md`
 * records traces as "excluded, a cursor-anchored app, not a dashboard" — so the
 * upstream source is the only provenance there is, and citing it beats citing
 * nothing.
 */
export type SpanKindRole = "turn" | "model" | "tool" | "subagent" | "background";

export const SPAN_COLORS = {
	/**
	 * `muted` (`--ink-2`) — a conversation turn. `CATEGORY_VARS.turn` is
	 * `--ink-2` (trace-colors.ts:38), and `muted` is our ink-2 rung
	 * (styles.css:28). NOT `success`: a turn is not a success state, and
	 * painting every turn green made an ordinary run look like a passing
	 * metric.
	 */
	turn: "muted",
	/**
	 * `accent` (`--chart-primary`) — a model call. `CATEGORY_VARS.model` is
	 * `--chart-primary` (trace-colors.ts:39), the web's default single-series
	 * chart colour (styles.css:55), and `accent` is the panel's one primary.
	 */
	model: "accent",
	/**
	 * `warning` (`--warn`) — a tool call. `CATEGORY_VARS.tool` is `--warn`
	 * (trace-colors.ts:40) and `caution` already rides `warning` (styles.css:45),
	 * so this is the one entry that is token-for-token the web's.
	 */
	tool: "warning",
	/**
	 * `mdLink` (`--chart-secondary`) — a subagent. `CATEGORY_VARS.subagent` is
	 * `--chart-secondary` (trace-colors.ts:41), the web's cost series
	 * (styles.css:56). The nearest terminal ink for that pink is `mdLink`.
	 */
	subagent: "mdLink",
	/**
	 * `borderMuted` (`--ink-4`) — background work. `CATEGORY_VARS.background` is
	 * `--ink-4` (trace-colors.ts:42), and `borderMuted` is the token behind our
	 * `faint` role (styles.css:30). It is that rung and not `muted` so idle
	 * background work recedes behind real spans instead of competing with turns.
	 */
	background: "borderMuted",
} as const satisfies Record<SpanKindRole, ThemeColor>;

/**
 * What each span kind matches on the web. Same machine-checked contract as
 * {@link PALETTE_TOKENS} — the upstream `CATEGORY_VARS` line, not a rule we
 * invented.
 */
export const SPAN_TOKENS = {
	turn: "--ink-2 · `trace-colors.ts:38`",
	model: "--chart-primary · `trace-colors.ts:39`",
	tool: "--warn · `trace-colors.ts:40`",
	subagent: "--chart-secondary · `trace-colors.ts:41`",
	background: "--ink-4 · `trace-colors.ts:42`",
} as const satisfies Record<SpanKindRole, string>;

/**
 * Categorical series colours, in preference order.
 *
 * This is deliberately omp's OWN ordering, taken from
 * `pi-tui/src/chrome/segment-track.ts` (`SEGMENT_COLOR_CANDIDATES`), which is
 * the closest thing the TUI has to a chart palette: the plan-mode model-tier
 * slider and the ctrl+p role cycle both colour by position from this list, so
 * reusing it means a chart series and a status segment share a hue identity.
 * Inventing a private palette here is exactly the divergence the user is
 * objecting to.
 *
 * `segment-track.ts` notes that themes alias many of these to one hue (its
 * `titanium` theme maps most of the syntax set onto its accent), which is why
 * {@link resolveSeries} dedupes by resolved colour rather than trusting the list.
 */
export const SERIES_COLORS: readonly ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

/**
 * Resolve `count` series colours under the active theme, deduping by the colour
 * actually rendered so adjacent series stay distinguishable on themes that alias
 * tokens together. Wraps by modulo when more series are requested than the theme
 * can distinguish, and never returns an empty palette — `accent` always resolves.
 * Mirrors `resolveSegmentPalette` in `chrome/segment-track.ts`.
 */
export function resolveSeries(count: number, theme: PaletteTheme): ThemeColor[] {
	const palette: ThemeColor[] = [];
	const seen = new Set<string>();
	for (const color of SERIES_COLORS) {
		const key = colorToAnsi(theme.getColorHex(color), theme.getColorMode());
		if (seen.has(key)) continue;
		seen.add(key);
		palette.push(color);
		if (palette.length >= count) break;
	}
	if (palette.length === 0) palette.push("accent");
	// Modulo-wrap so a 12-series chart is answerable even on a monochrome theme.
	const distinct = palette.length;
	while (palette.length < count) palette.push(palette[palette.length % distinct]);
	return palette.slice(0, count);
}

/**
 * Fractional stops for the four heat levels, lowest first. Copied from
 * `/usage`'s `#heatRamp` (`overlays/usage-dashboard.ts:812`), where level 1 sits
 * near-invisible against the background and level 4 is the full accent, so cell
 * brightness reads as amount of work.
 */
const HEAT_STOPS = [0.3, 0.5, 0.72, 1] as const;

/**
 * The foreground colour for heatmap level `level` (0–3), as an ANSI escape.
 *
 * `level` is CLAMPED to 0..3 and rounded. A caller that passes 1..4 (the
 * natural "level 1 is the first rung" indexing) gets rungs 1..3, so the top
 * level aliases rung 3 — the off-by-one that made levels 3 and 4 the same
 * colour. Callers index the ramp as `[0,1,2,3]`; the clamp keeps an out-of-range
 * level from throwing or reading `undefined`.
 *
 * Blend a near-background anchor, derived from the active text ink's complement,
 * toward the accent. Bright text yields a dark anchor and dark text a light one;
 * custom light/dark palettes do not inherit a fixed RGB background.
 *
 * Always routed through `colorToAnsi(hex, theme.getColorMode())`. `detectColorMode`
 * returns `"256color"` on any terminal without truecolor, and never a 16-colour
 * mode, so the terminal's own palette quantises our blend. Assuming truecolor
 * here would emit `38;2;…` sequences that render as garbage on those terminals.
 */
export function heatRamp(theme: PaletteTheme, level: number): string {
	const t = HEAT_STOPS[Math.max(0, Math.min(HEAT_STOPS.length - 1, Math.round(level)))];
	const text = hexToRgb(theme.getColorHex("text"));
	const from = { r: 255 - text.r, g: 255 - text.g, b: 255 - text.b };
	const to = hexToRgb(theme.getColorHex("accent"));
	return colorToAnsi(
		rgbToHex({
			r: Math.round(from.r + (to.r - from.r) * t),
			g: Math.round(from.g + (to.g - from.g) * t),
			b: Math.round(from.b + (to.b - from.b) * t),
		}),
		theme.getColorMode(),
	);
}

/**
 * Remove ANSI SGR sequences so a test can assert on glyphs independently of
 * colour. Matches CSI sequences ending in a letter, which covers every SGR
 * (`38;5;n`, `38;2;r;g;b`, `39`) without swallowing the printable text between
 * them.
 */
export function stripForTest(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR is the point
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
