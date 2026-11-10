/**
 * `src/tui/responsive.ts` — the responsive FRAME policy: which band a total
 * width lands in and what chrome that band gets.
 *
 * WHY THIS MODULE EXISTS. `layout.ts` already owns the width table
 * (`BREAKPOINTS`, keyed by inner width) and the geometry (`planLayout`); the
 * panel already recomputes that table on EVERY render from the current width
 * and clamps scroll inside `render`, so shrink-on-resize is automatic. What no
 * module stated is the FRAME contract the chrome builds against: at this total
 * width, is the sidebar full/hidden, is the topbar full/condensed/
 * minimal. That mapping lives here, DERIVED from the table rather than
 * restated beside it — a retuned threshold flows through with no edit here,
 * which a second table would not.
 *
 * BANDS (totals = inner + the overlay's 4 insets; edges fall out of the table,
 * never restated):
 *
 * | band   | total     | inner  | chrome                        | intent                              |
 * |--------|-----------|--------|-------------------------------|-------------------------------------|
 * | wide   | ≥ 84      | ≥ 80   | sidebar full, topbar full     | two columns, 4 table cols           |
 * | medium | 48–83     | 44–79  | sidebar hidden, topbar condensed | one column, 3 table cols (web 1100px: grids → 1fr) |
 * | narrow | 34–47     | 30–43  | sidebar hidden, topbar condensed | 2 table cols, footer drops from right (web LiveChip hides) |
 * | tiny   | < 34      | < 30   | sidebar hidden, topbar minimal | footer hints off, body-first (web 900px: drawer + hamburger) |
 *
 * The ORDER mirrors the web's CSS (`styles.css`: 1360px sidebar narrows,
 * 1100px grids collapse, 900px drawer + `topbar-hide-narrow`), not its px
 * values — px have no terminal meaning. The 80/44/30 inner thresholds are
 * content minima: 80 holds two legible columns (total-80 ⇒ inner-76, so a
 * `>= 76` rule would tear the most common terminal); 44 holds three table
 * columns; 30 holds two plus a hint row beside content.
 *
 * WHAT THIS MODULE DOES NOT DO. No geometry (that is `planLayout`), no tab
 * measuring (the panel measures the strip's rendered rows and subtracts them
 * from the body budget), no scroll
 * state (the panel clamps inside `render`, following `usage-dashboard.ts:903-905`,
 * never in the key handler), no line cache (the panel holds none; if one is
 * ever added its key MUST include width AND data generation, per
 * `usage-dashboard.ts:887`). PURE: no theme, no terminal, no data.
 */

import { BREAKPOINTS, HORIZONTAL_INSET, MIN_USABLE_WIDTH } from "./layout";

/** What the sidebar costs the body at this width. */
export type SidebarMode = "full" | "hidden";

/** What the topbar keeps at this width. */
export type TopbarMode = "full" | "condensed" | "minimal";

/**
 * The frame's answer for one total width. `band`, `columns`, `footerHints`
 * and `tooNarrow` always agree with `planLayout` for the same width — asserted
 * in `test/responsive-frame.test.ts` across 1–200, so this can never drift
 * into a second convention.
 */
export interface FramePolicy {
	/** The breakpoint row that applied (`wide` | `medium` | `narrow` | `tiny`). */
	band: string;
	/** Sidebar cost: full row or gone. */
	sidebar: SidebarMode;
	/** Topbar density: everything, condensed, or brand-only. */
	topbar: TopbarMode;
	/** Column count, straight from the breakpoint row. */
	columns: 1 | 2;
	/** Whether a hint row fits beside content, straight from the row. */
	footerHints: boolean;
	/** Below any planned layout; the caller should say so, not tear. */
	tooNarrow: boolean;
}

/**
 * The policy for a total overlay width.
 *
 * Derived, never restated: the band is the same first-match scan `planLayout`
 * performs, and the chrome modes follow from the row's CAPABILITIES (two
 * columns ⇒ room for a full sidebar; hints ⇒ room for a condensed topbar),
 * so a new breakpoint row gets sensible chrome with no edit here.
 */
export function framePolicy(width: number): FramePolicy {
	// Same normalisation as `planLayout`: terminal numbers are external input.
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	const innerWidth = Math.max(0, safeWidth - HORIZONTAL_INSET);
	const row = BREAKPOINTS.find(candidate => innerWidth >= candidate.minInnerWidth) ?? BREAKPOINTS[0];

	// Capability-derived, so the table stays the single source of truth.
	const sidebar: SidebarMode = row.columns === 2 ? "full" : "hidden";
	const topbar: TopbarMode = !row.showFooterHints ? "minimal" : row.columns === 2 ? "full" : "condensed";

	return {
		band: row.name,
		sidebar,
		topbar,
		columns: row.columns,
		footerHints: row.showFooterHints,
		tooNarrow: safeWidth < MIN_USABLE_WIDTH,
	};
}
