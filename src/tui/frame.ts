/**
 * `src/tui/frame.ts` — the panel's FRAME BUDGET.
 *
 * WHY THIS EXISTS. `OverlayPanel` draws a fixed number of rows around the body,
 * and the body must be sized from the terminal height minus those rows. Getting
 * the count wrong spends a row the terminal does not have, and the bottom border
 * falls off the screen — the failure a user sees as "the panel is broken at 60
 * columns" and which no assertion on `render(width)` alone would catch.
 *
 * The count itself lives in `panel-constants.ts`, the one chrome-row
 * measurement, so the budget and the frame cannot drift apart. The strip's own
 * wrap is measured by the panel from the rows `TabBar.render` actually returns.
 *
 * PURE. No theme, no terminal, no data.
 */

import { PANEL_CHROME_ROWS } from "./panel-constants";

/** The shortest terminal the panel will paint: the chrome plus one body row. */
export const MIN_PANEL_ROWS = PANEL_CHROME_ROWS + 1;

/**
 * The body floor. `/settings` uses 7, `/usage` 5, and `layout.ts` 1. Seven is
 * right for this panel because the first band is a `statRow` that is three or
 * four rows tall; below that the first thing a reader sees is a truncated
 * headline rather than a screen.
 */
export const MIN_BODY_ROWS = 7;

/**
 * Rows the body gets, from the terminal height and the LIVE tab-row count.
 *
 * The `+ 1` is the header row the tab row replaces — the tab strip took its
 * place in the frame, so it costs nothing extra at one row and costs exactly
 * one row more per wrap. Mirrors the arithmetic at `settings-selector.ts:739`.
 */
export function bodyRows(height: number, tabRows: number): number {
	const safe = Number.isFinite(height) ? Math.trunc(height) : MIN_PANEL_ROWS;
	// Clamped at MIN_PANEL_ROWS rather than below: a terminal shorter than its own
	// chrome still paints a coherent frame, because `OverlayPanel` clips.
	const frame = Math.max(MIN_PANEL_ROWS, safe);
	return Math.max(1, frame - PANEL_CHROME_ROWS - Math.max(0, tabRows - 1));
}
