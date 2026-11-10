/**
 * `src/tui/showcase/nav.ts` — the showcase's nav LIST, and nothing else.
 *
 * WHY THIS FILE EXISTS: `/stats-test` has its own sections (`tiles`, `charts`,
 * `tables`, `awkward`, `states`, `empty`), which are not real screen ids. The
 * nav identity (labels, hotkeys, icons) still has to live somewhere, and the
 * strip still needs `Tab`s — so this module declares the rows and the tabs.
 *
 * WHAT IS NO LONGER HERE. This file used to paint its own sidebar and walk its
 * own hit rows: a fork of `chrome.ts`'s `sidebar` and `mouse.ts`'s `sidebarHit`,
 * which is the "second nav grammar" the redesign exists to remove. Both are now
 * PARAMETERS — `sidebar(theme, preset, activeId, hovered?, groups)` and
 * `hitTest(frame, row, col, hitSidebar)` take the nav list / row resolver — so
 * `SHOWCASE_NAV` is data and `chrome.ts` owns the only geometry. The ink ladder
 * (`SIDEBAR_INK`) and the strip adapter (`tabBarTheme`) were already shared and
 * stay shared.
 *
 * THE ICONS are the real screen icons where one exists, so a reader who knows
 * the panel's sidebar reads the showcase's without a key. The sections with no
 * real counterpart take the nearest geometric role rather than a new glyph.
 */

import type { Tab, TabBarTheme, Theme } from "@oh-my-pi/pi-tui";

import type { IconRole } from "../icons";
import { tabBarTheme } from "../tabs";
import { SHOWCASE_SECTIONS } from "./spec";

// Re-exported so `panel.ts` (and its consumers) have one showcase entry point:
// the nav and the sections are one module from a caller’s point of view.
export { SHOWCASE_SECTIONS };


// ─── The nav ─────────────────────────────────────────────────────────────────

/** One row in a group. */
export interface ShowcaseNavItem {
	readonly id: string;
	readonly label: string;
	/** Second key of the `g <key>` jump. */
	readonly hotkey: string;
	readonly icon: IconRole;
}

/** One group of rows, under one heading. */
export interface ShowcaseNavGroup {
	readonly heading: string;
	readonly items: readonly ShowcaseNavItem[];
}

/**
 * THE ICON PER SECTION. Reusing the real screen icons where one exists keeps the
 * two navs visually related — a reader who knows the panel's sidebar reads the
 * showcase's without a key. The sections with no real counterpart take the nearest
 * geometric role rather than a new glyph.
 */
const ICONS: Readonly<Record<string, IconRole>> = {
	tiles: "tokens",
	charts: "cost",
	tables: "requests",
	awkward: "warning",
	states: "cache",
	empty: "unknown",
};

/**
 * THE NAV, in three groups, so the sidebar's own grouping is exercised too: a
 * playground that drew one flat list would never show whether the heading ink
 * ladder reads at three groups or at one, nor whether a one-item group looks
 * broken.
 */
export const SHOWCASE_NAV: readonly ShowcaseNavGroup[] = Object.freeze([
	{ heading: "Grammar", items: [navItem("tiles"), navItem("charts"), navItem("tables")] },
	{ heading: "Edges", items: [navItem("awkward"), navItem("states")] },
	{ heading: "Ranges", items: [navItem("empty")] },
]);

function navItem(id: string): ShowcaseNavItem {
	const section = SHOWCASE_SECTIONS.find(candidate => candidate.id === id);
	if (!section) throw new Error(`showcase nav references unknown section "${id}"`);
	return { id: section.id, label: section.label, hotkey: section.hotkey, icon: ICONS[section.id] ?? "unknown" };
}

// ─── The tab strip ───────────────────────────────────────────────────────────

/**
 * The `TabBarTheme` adapter, reused verbatim from `tabs.ts` rather than rebuilt.
 *
 * It is a host-shaped six-callback object closed over the injected `Theme` rather
 * than the singleton, and every one of its inks already carries a `styles.css`
 * citation. A showcase strip with its own adapter would be a second ink ladder,
 * which is exactly the drift `TAB_INK` was extracted to prevent — so the adapter
 * is the real one and only the TAB LIST is ours.
 */
export function showcaseTabBarTheme(theme: Theme): TabBarTheme {
	return tabBarTheme(theme);
}

/**
 * The strip's tabs, from the showcase's sections rather than `SCREEN_SPECS`.
 *
 * `activeId` is read from the theme's own preset so the `short` form is the one
 * that preset can actually draw — the rule `TAB_SHORT` obeys, because a strip that
 * wraps costs the body a row.
 */
export function buildShowcaseTabs(theme: Theme): Tab[] {
	const preset = theme.getSymbolPreset();
	return SHOWCASE_SECTIONS.map(section => ({
		id: section.id,
		label: section.label,
		short: section.short[preset],
	}));
}