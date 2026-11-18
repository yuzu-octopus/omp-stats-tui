/**
 * The tab strip: the `Tab[]` the panel hands to `TabBar`, the one-cell `short`
 * table that keeps it on ONE row, and a `TabBarTheme` closed over OUR injected
 * `Theme` rather than the host singleton.
 *
 * WHY `short` IS A SEPARATE TABLE
 *
 * `TabBar` renders full labels and, only if they overflow, collapses the tabs
 * FURTHEST FROM THE ACTIVE ONE to `short`, then wraps (`tab-bar.ts:271-286`).
 * So `short` is not decoration — it is the budget that decides whether the strip
 * costs the body one row. Our `Screen.short` values are 6-8 cell words, and
 * `statsIcon` cannot stand in: the ascii arm of `STATS_ICONS` is VARIABLE
 * (`"tok:"` = 4 cells, `"[!!]"` = 4, `"cache"` = 5, `src/tui/icons.ts:106-124`),
 * and 12 tabs of 5 cells plus padding plus gutters is 108 columns. Hence
 * {@link TAB_SHORT}, which is one cell on all three presets and is asserted to
 * be by measurement in `test/tabs.test.ts`.
 *
 * WHY THE UNICODE ARM IS NOT `STATS_ICONS`
 *
 * Two cells is the rule for an ICON (`icons.ts:5-9`: an emoji is fine where the
 * heading reserves `ICON_GUTTER`). A tab cell has no gutter. Every emoji in the
 * unicode arm measures 2, so the strip would need 58 + 9 columns; one cell is
 * the only form that fits 80. Where a 1-cell form already exists in
 * `STATS_ICONS.unicode` (`trendUp`, `models`, `warning`) it is reused verbatim;
 * the rest are the geometric symbols that read as overview / calendar /
 * folder / chart / tools / host, and are asserted 1 cell by test rather than by
 * eye.
 *
 * WHY THE ACTIVE TAB IS A FILL AND A LUMINANCE STEP
 *
 * The strip is the panel's largest piece of chrome — at twelve tabs it is more
 * line than any band — so what it is NOT allowed to be is more body text. Ours
 * drew every inactive segment at `muted`, which put the strip at the same
 * strength as the nav labels beside it, and a strip that reads as content is
 * not a control.
 *
 * So this adapter mirrors `.segmented`, the web's own treatment of "a row of
 * options with one selected" (styles.css:1056-1102): every option is
 * `--ink-3` (:1083-1096), `:hover` is `--ink-1` (:1097-1099), and
 * `[data-active]` is `--ink-1` on the `--raised` thumb (:1100-1102, :1068-1080).
 * `selectedBg` is the terminal's stand-in for that thumb — a terminal has no
 * border-radius, so a filled background IS "an enclosed surface", which is the
 * same rule `.live-chip` obeys (styles.css:1595-1597).
 *
 * `hoverTab` deliberately takes NO fill. The active segment already owns the
 * band, so if hover took it too the two states would be told apart by bold
 * alone — which a theme that renders no bold cannot express. Instead hover is
 * ink-1 on no fill and active is ink-1 on the fill: one background, two inks,
 * and the distinction survives a monochrome theme.
 *
 * `label` is the bar's own LEADING LABEL, not a tab style — `TabBar` renders it
 * once, before the first tab (components/tab-bar.ts:191, :240-243), and the
 * panel passes an empty label. It is kept for host parity and is deliberately
 * NOT the accent: the accent is spent on the active row of the nav and the one
 * number a screen is about (css-tokens.md:104), not on a prefix we never draw.
 */

import { visibleWidth, type SymbolPreset, type Tab, type TabBarTheme, type Theme } from "@oh-my-pi/pi-tui";
import { SCREENS, screenById, type ScreenId } from "./screens/types";
import { STATS_ICONS, statsIcon, type IconRole } from "./icons";
import { SELECTION_BG, TAB_INK } from "./palette";

/**
 * The icon each screen carries. `overview` takes `trendUp` rather than `cost`
 * so it does not collide with the `costs` row; only one is ever active, and the
 * labels disambiguate regardless. Exported because chrome.ts reuses this exact
 * mapping for the sidebar rows — one icon table, not two.
 */
export const TAB_ICON: Record<ScreenId, IconRole> = {
	overview: "trendUp",
	activity: "calendar",
	models: "models",
	costs: "cost",
	projects: "projects",
	requests: "requests",
	errors: "errors",
	tools: "tools",
	providers: "providers",
	gain: "gains",
	traces: "time",
	frustration: "warning",
};

/**
 * One cell per preset, ALWAYS. Twelve tabs of one-cell glyphs plus padding and
 * gutters fit 58 columns; anything wider wraps the strip to two rows.
 *
 * The nerd arm is the PUA form `STATS_ICONS.nerd` already registers for the same
 * role, so a font that has the icon renders the same glyph as the heading.
 */
export const TAB_SHORT: Record<SymbolPreset, Record<ScreenId, string>> = {
	unicode: {
		overview: STATS_ICONS.unicode.trendUp,
		activity: "◫",
		models: STATS_ICONS.unicode.models,
		costs: "$",
		projects: "▣",
		requests: "≡",
		errors: STATS_ICONS.unicode.warning,
		tools: "⚒",
		providers: "◈",
		gain: "+",
		traces: "⌁",
		frustration: "?",
	},
	nerd: {
		overview: STATS_ICONS.nerd.trendUp,
		activity: STATS_ICONS.nerd.calendar,
		models: STATS_ICONS.nerd.models,
		costs: STATS_ICONS.nerd.cost,
		projects: STATS_ICONS.nerd.projects,
		requests: STATS_ICONS.nerd.requests,
		errors: STATS_ICONS.nerd.errors,
		tools: STATS_ICONS.nerd.tools,
		providers: STATS_ICONS.nerd.providers,
		gain: STATS_ICONS.nerd.gains,
		traces: STATS_ICONS.nerd.time,
		frustration: STATS_ICONS.nerd.warning,
	},
	ascii: {
		overview: "*",
		activity: "#",
		models: "M",
		costs: "$",
		projects: "D",
		requests: "R",
		errors: "!",
		tools: "T",
		providers: "H",
		gain: "+",
		traces: "~",
		frustration: "?",
	},
};

/**
 * The `TabBarTheme` adapter. Host-shaped — the same six callbacks
 * `getTabBarTheme()` exposes (chrome/shared.ts:18-27) — but closed over the
 * `Theme` the mount hands us, because that function hardcodes the `theme`
 * singleton and would ignore ours entirely.
 *
 * Every ink comes from {@link TAB_INK}, which is the web's `.segmented` ladder
 * with a `styles.css` line on each rung. `mutedTab` and `hoverTab` are supplied
 * explicitly rather than left to the host's `?? inactiveTab` fallback
 * (declared optional with that fallback documented at components/tab-bar.ts:42
 * and :44; applied at :251 and :255), because a fallback that silently reverted
 * to the previous ink is exactly the drift this table exists to prevent.
 */
export function tabBarTheme(theme: Theme): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg(TAB_INK.active, text)),
		activeTab: (text: string) => theme.bold(theme.bg(SELECTION_BG.band, theme.fg(TAB_INK.active, text))),
		inactiveTab: (text: string) => theme.fg(TAB_INK.inactive, text),
		mutedTab: (text: string) => theme.fg(TAB_INK.muted, text),
		// No fill: see the header note on why hover must not share the thumb.
		hoverTab: (text: string) => theme.fg(TAB_INK.hover, text),
		hint: (text: string) => theme.fg(TAB_INK.hint, text),
	};
}

/**
 * The strip, built from the screen registry `SCREENS` — one source of truth
 * shared with the nav and the digit row.
 *
 * `label` is `icon + space + label`, matching `/settings`
 * (`settings-selector.ts:546-553`); `short` is {@link TAB_SHORT}.
 */
export function buildTabs(preset: SymbolPreset, theme: Theme, activeId: ScreenId): Tab[] {
	if (!SCREENS.some(screen => screen.id === activeId)) {
		throw new Error(`unknown screen id: ${activeId}`);
	}
	return SCREENS.map(screen => ({
		id: screen.id,
		label: `${statsIcon(preset, TAB_ICON[screen.id], theme)} ${screen.label}`,
		short: TAB_SHORT[preset][screen.id],
		muted: false,
	}));
}

/**
 * The one-column inset every `row()` puts inside its `│ … │` chrome
 * (`chrome/overlay-box.ts:46-49`), which is what `/settings` renders its tab
 * strip through (`settings-selector.ts:761-763`). Read from the reference
 * rather than guessed: the tab row must not collide with the panel border.
 */
export const TAB_BAR_INDENT = 1;

/**
 * The route widget is the toolbar's `< Label >` run: the brackets are the two
 * neighbours of the active screen, and the label is the active screen itself.
 * Unlike the retired twelve-glyph strip it costs NO row — it is measured over
 * the one toolbar row the topbar already paints.
 *
 * Spans are derived from the PAINTED row, not from a second copy of the markup:
 * `routeSpans` reads the stripped topbar and the registry order, so a relabelled
 * screen or a changed marker moves its own hit area with it.
 */
export interface RouteSpan {
	id: ScreenId;
	/** Content-row cell offsets, half-open. */
	start: number;
	end: number;
	part: "prev" | "label" | "next";
}

export function routeSpans(line: string, activeId: ScreenId): readonly RouteSpan[] {
	if (!SCREENS.some(screen => screen.id === activeId)) return [];
	// The bare label on the wide band is NOT a route widget: only the bracketed
	// form is clickable, because only it carries the neighbour controls.
	if (!line.startsWith("< ")) return [];
	const index = SCREENS.findIndex(screen => screen.id === activeId);
	const previous = SCREENS[(index - 1 + SCREENS.length) % SCREENS.length]!.id;
	const next = SCREENS[(index + 1) % SCREENS.length]!.id;
	const labelStart = visibleWidth("< ");
	const labelEnd = labelStart + visibleWidth(screenById(activeId).label);
	const nextStart = labelEnd + 1; // the painted space before the closing bracket
	const painted = visibleWidth(line);
	const spans: RouteSpan[] = [];
	if (painted >= 1) spans.push({ id: previous, start: 0, end: 1, part: "prev" });
	if (painted > labelStart) {
		spans.push({ id: activeId, start: labelStart, end: Math.min(painted, labelEnd), part: "label" });
	}
	if (painted > nextStart) spans.push({ id: next, start: nextStart, end: nextStart + 1, part: "next" });
	return spans;
}

/** The raw prefix of `line` covering `cells` terminal cells (ANSI kept intact). */
function rawPrefix(line: string, cells: number): string {
	let index = 0;
	let width = 0;
	while (index < line.length && width < cells) {
		if (line.charCodeAt(index) === 27) {
			const end = line.indexOf("m", index + 1);
			if (end === -1) break;
			index = end + 1;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index)!);
		width += visibleWidth(char);
		index += char.length;
	}
	return line.slice(0, index);
}

/**
 * Paint the route widget's hover with the same `selectedBg` thumb the host's
 * `TabBar` uses for a hovered tab. Only the widget's own cells are wrapped, so
 * the status chip, freshness, progress and range tray keep their own ink.
 */
export function paintRouteHover(theme: Theme, line: string, activeId: ScreenId): string {
	const spans = routeSpans(line.replace(/\x1b\[[0-9;]*m/g, ""), activeId);
	if (spans.length === 0) return line;
	const end = Math.max(...spans.map(span => span.end));
	const prefix = rawPrefix(line, end);
	return theme.bg(SELECTION_BG.band, prefix) + line.slice(prefix.length);
}