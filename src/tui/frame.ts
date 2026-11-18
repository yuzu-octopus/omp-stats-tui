/**
 * `src/tui/frame.ts` — the panel's ONE FRAME BUDGET.
 *
 * WHY THIS EXISTS. Every row and every body-column count is decided here, once.
 * The old frame had three row formulas (this module, `layout.ts` and the panel's
 * render path) and a progress line that added a second header row mid-sync, so
 * the body — and therefore maxScroll — changed while data arrived. It also let
 * a 15-line nav column be admitted at 21 rows and then clipped by the render
 * cap. The toolbar now composes status, freshness, range and compact progress
 * into ONE row, and this module is the only place that spends rows or sidebar
 * width against the body.
 *
 * PURE. No theme singleton, no terminal, no data. The preset names a measured
 * icon table; it does not reach into the host theme.
 */

import { SIDEBAR_ZIP_PREFIX, sidebarWidth } from "./chrome";
import type { SymbolPreset } from "./glyphs";
import { HORIZONTAL_INSET } from "./layout";
import { PANEL_CHROME_ROWS } from "./panel-constants";
import { framePolicy } from "./responsive";

/** The shortest terminal the panel will paint: the chrome plus one body row. */
export const MIN_PANEL_ROWS = PANEL_CHROME_ROWS + 1;

/**
 * The body floor. `/settings` uses 7, `/usage` 5, and `layout.ts` 1. Seven is
 * right for this panel because the first band is a `statRow` that is three or
 * four rows tall; below that the first thing a reader sees is a truncated
 * headline rather than a screen.
 */
export const MIN_BODY_ROWS = 7;

/** The complete, immutable answer a frame composer needs before it draws. */
export interface FrameBudget {
	/** Rows the toolbar occupies. One row in the redesigned frame. */
	topbarRows: number;
	/** The tab strip is gone; navigation lives in the toolbar or the sidebar. */
	stripRows: 0;
	/** Rows left for the scrollable body after ALL chrome. */
	bodyRows: number;
	/** Body width inside the overlay, less the sidebar column when it exists. */
	bodyInnerWidth: number;
}

function integerOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * The one row calculation. `PANEL_CHROME_ROWS` measures the five fixed rows
 * (top border, one header, divider, footer, bottom border); replacing its one
 * header with `headerRows` leaves four rows that never move. A compact sync
 * indicator lives INSIDE the header, so progress cannot change `headerRows`.
 */
function rowsForFrame(rows: number, headerRows: number): number {
	const totalRows = Math.max(MIN_PANEL_ROWS, integerOr(rows, MIN_PANEL_ROWS));
	const headers = Math.max(0, integerOr(headerRows, 1));
	return Math.max(1, totalRows - (PANEL_CHROME_ROWS - 1) - headers);
}

/**
 * Compatibility seam for the tab-strip callers that still measure a wrapped
 * strip. It is the SAME arithmetic, not a second formula: one header row plus
 * one more per wrap. Integration removes the caller; the calculation stays one.
 */
export function bodyRows(height: number, tabRows: number): number {
	return rowsForFrame(height, Math.max(1, integerOr(tabRows, 1)));
}

/**
 * The frame budget for one terminal size and one toolbar height.
 *
 * At 100x40 this is 35 body rows at 72 cells; at 40x30 it is 25 at 36 cells.
 * At 20 rows the sidebar's full 15-line column still fits exactly: the nav is
 * chosen by WIDTH (`framePolicy().navMode`), never by a second height guess.
 */
export function budgetFrame(
	width: number,
	rows: number,
	headerRows: number,
	preset: SymbolPreset,
): FrameBudget {
	const safeWidth = Math.max(0, integerOr(width, 0));
	const headers = Math.max(0, integerOr(headerRows, 1));
	const sidebarCols =
		framePolicy(safeWidth).navMode === "sidebar" ? sidebarWidth(preset) + SIDEBAR_ZIP_PREFIX : 0;

	return {
		topbarRows: headers,
		stripRows: 0,
		bodyRows: rowsForFrame(rows, headers),
		bodyInnerWidth: Math.max(0, safeWidth - HORIZONTAL_INSET - sidebarCols),
	};
}
