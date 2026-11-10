import type { SymbolPreset } from "./glyphs";
import { PANEL_CHROME_ROWS } from "./panel-constants";

/**
 * WHY THIS MODULE EXISTS
 *
 * A chart should never lay itself out. If each of the five charts decided its own
 * column widths, a 40-column terminal would produce five different and mutually
 * inconsistent answers — bars sized for a different width than the sparkline
 * beside them, a table that wraps where the chart above it did not. The failure
 * is not a crash; it is a panel that looks wrong in a way nobody can name.
 *
 * So one pure function decides every width threshold and every degradation, and
 * every render function downstream reads the numbers from here. It is pure on
 * purpose: no theme singleton (undefined at extension load, and reading it here
 * would throw), no database, no terminal. That is what makes the degradation
 * rules testable at all.
 *
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not compose the frame. `OverlayPanel` already insets content two
 * columns on each side, draws the titled top border, the bottom border and the
 * section rules, and `PanelRows` already clips and pads a body region to an
 * exact height. Duplicating that arithmetic here is how the two drift apart, so
 * the insets below are the only ones and they mirror the panel's documented
 * behaviour. This module answers "which regions exist and how wide is each";
 * the chrome components answer "how are they drawn".
 */

/** Content inset per side, matching `OverlayPanel`'s documented `│ … │` rows. */
export const SIDE_INSET = 2;
export const HORIZONTAL_INSET = SIDE_INSET * 2;


/** A region the plan gave up, and the condition that made it go. */
export interface DroppedRegion {
	region: string;
	reason: string;
}

/**
 * One breakpoint row. Descending by `minInnerWidth`, so the first row whose
 * threshold is met wins and the lookup is a single scan.
 *
 * This table IS the layout policy. Adding a breakpoint is a one-line edit here
 * and needs no test change, because the test walks these rows rather than
 * hand-writing a case per width.
 */
export interface Breakpoint {
	/** Stable label, also the value a test reports on failure. */
	name: string;
	/** Minimum `innerWidth` for this row to apply. */
	minInnerWidth: number;
	columns: 1 | 2;
	compact: boolean;
	/** Table columns kept; the rest are dropped, never squeezed. */
	tableColumns: number;
	showFooterHints: boolean;
	/** Regions this row gives up, computed from the widths it does keep. */
	dropped: DroppedRegion[];
}

/**
 * Thresholds measured against real overlay geometry.
 *
 * `minInnerWidth: 80` for two columns rather than the plan's draft 76: at a
 * total width of 80 the inner width is exactly 76, so a `>= 76` rule would put
 * an 80-column terminal into two columns and tear the widest common layout. The
 * draft threshold contradicts the plan's own test (`planLayout(80, 24).columns
 * === 1`); the test is the better spec, so the table matches it.
 */
export const BREAKPOINTS: readonly Breakpoint[] = [
	{
		name: "wide",
		minInnerWidth: 80,
		columns: 2,
		compact: false,
		tableColumns: 4,
		showFooterHints: true,
		dropped: [],
	},
	{
		name: "medium",
		minInnerWidth: 44,
		columns: 1,
		compact: true,
		tableColumns: 3,
		showFooterHints: true,
		dropped: [
			{ region: "secondColumn", reason: "inner width below 80 — two columns cannot both be legible" },
		],
	},
	{
		name: "narrow",
		minInnerWidth: 30,
		columns: 1,
		compact: true,
		tableColumns: 2,
		showFooterHints: true,
		dropped: [
			{ region: "secondColumn", reason: "inner width below 80 — two columns cannot both be legible" },
			{ region: "wideTableColumns", reason: "inner width below 44 — tables keep two columns" },
		],
	},
	{
		name: "tiny",
		minInnerWidth: 0,
		columns: 1,
		compact: true,
		tableColumns: 2,
		showFooterHints: false,
		dropped: [
			{ region: "secondColumn", reason: "inner width below 80 — two columns cannot both be legible" },
			{ region: "wideTableColumns", reason: "inner width below 44 — tables keep two columns" },
			{ region: "footerHints", reason: "inner width below 30 — no room for a hint row beside content" },
		],
	},
];

/**
 * The width fields a chart is handed, exported so a test can enumerate them
 * rather than keep a hand-written copy that would miss a field the day one is
 * added.
 */
export const WIDTH_FIELDS = [
	"innerWidth",
	"labelWidth",
	"valueWidth",
	"barWidth",
	"sparkWidth",
] as const;

export type WidthField = (typeof WIDTH_FIELDS)[number];

/**
 * The fields that partition a single column, and so may legitimately be summed
 * against `columnWidth`. The rest are containers and must not be added to them —
 * `innerWidth` already contains the column, so summing them would double-count.
 */
export const COLUMN_PARTITION_FIELDS = ["labelWidth", "valueWidth", "barWidth"] as const;

export interface LayoutPlan {
	// --- what was asked for, kept so a caller can report rather than assume ---
	/** Total width of the overlay, as given. */
	width: number;
	/** Rows requested, as given. */
	requestedRows: number;
	/** First breakpoint row that applied. */
	breakpoint: string;

	// --- the frame budget. OverlayPanel/PanelRows enforce these when drawing ---
	/** Usable content width: total width less the panel's own insets. */
	innerWidth: number;
	/** Content width of ONE column; the label/value/bar fields partition this. */
	columnWidth: number;
	/** Rows available to the body once chrome is spent. */
	bodyRows: number;
	/** Rows the caller wanted that do not fit; 0 when nothing overflows. */
	overflowRows: number;

	// --- which regions exist ---
	columns: 1 | 2;
	compact: boolean;
	tableColumns: number;
	showFooterHints: boolean;
	/** True when the terminal is narrower than any planned layout can fill. */
	tooNarrow: boolean;
	/** Regions deliberately not rendered, each with the condition that dropped it. */
	dropped: DroppedRegion[];

	// --- how wide each region is ---
	labelWidth: number;
	valueWidth: number;
	barWidth: number;
	barHeight: number;
	heatWeeks: number;
	sparkWidth: number;
}

/** Below this the plan is degraded past usefulness; callers should say so. */
export const MIN_USABLE_WIDTH = 20;

/**
 * Label column. Fixed rather than content-derived because the labels are a
 * closed vocabulary we own, and a fixed column is what keeps every row's value
 * starting in the same place between screens.
 */
export const LABEL_WIDTH = 12;

/** Value column, sized for the widest formatted figure the formatters produce. */
export const VALUE_WIDTH = 12;

/**
 * `planLayout` is PURE in `(width, rows, preset)` and the panel calls it on every
 * render, so it memoizes. The returned plan is SHARED and must be treated as
 * read-only: the panel spreads it before overriding `bodyRows`, and nothing
 * writes into it.
 *
 * Bounded because a resize drag walks every width: past the limit the map is
 * cleared rather than growing for the life of the process. Clearing is safe —
 * this is a cache, not state.
 */
const PLAN_CACHE = new Map<string, LayoutPlan>();
const PLAN_CACHE_LIMIT = 512;

export function planLayout(width: number, rows: number, preset: SymbolPreset): LayoutPlan {
	const key = `${width}\u0000${rows}\u0000${preset}`;
	const hit = PLAN_CACHE.get(key);
	if (hit !== undefined) return hit;
	const plan = computePlanLayout(width, rows);
	if (PLAN_CACHE.size >= PLAN_CACHE_LIMIT) PLAN_CACHE.clear();
	PLAN_CACHE.set(key, plan);
	return plan;
}

/** The memoized body of {@link planLayout}; see the note there on sharing. */
function computePlanLayout(width: number, rows: number): LayoutPlan {
	// Terminal numbers are external input and the panel calls this once per
	// frame, so non-finite and negative values are normalised rather than trusted.
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	const safeRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;

	// Mirrors OverlayPanel's `│ … │`: two columns of inset per side.
	const innerWidth = Math.max(0, safeWidth - HORIZONTAL_INSET);

	// A deliberately sub-terminal terminal still gets a body of one row, because
	// zero would leave every screen with nothing to render and no way to say so.
	const bodyRows = Math.max(1, safeRows - PANEL_CHROME_ROWS);
	// How far short of a renderable panel we are: a terminal too short for its own
	// chrome plus a one-row body. Zero means everything asked for is available.
	// Reported rather than hidden, because a silently squashed body looks like a
	// screen with less to say when it is really a screen with no room.
	const overflowRows = Math.max(0, PANEL_CHROME_ROWS + 1 - safeRows);

	const breakpoint = BREAKPOINTS.find(row => innerWidth >= row.minInnerWidth) ?? BREAKPOINTS[0];

	// One column's content width. With two columns each gets half and the other
	// column's share is simply not allocated — which is why the sum below can
	// never exceed innerWidth.
	const columnWidth =
		breakpoint.columns === 2
			? Math.floor((innerWidth - SIDE_INSET) / 2)
			: innerWidth;

	// The column's own padding is reserved first; the remainder is split three ways.
	// Label and value take from the column BEFORE the bar does, so a narrow
	// terminal loses label precision rather than losing the bar entirely: a chart
	// with no bar is a blank space, a truncated label is still a label.
	const contentWidth = Math.max(0, columnWidth - SIDE_INSET * 2);
	const barFloor = Math.min(4, contentWidth);
	const labelWidth = Math.max(0, Math.min(LABEL_WIDTH, Math.floor((contentWidth - barFloor) / 3)));
	const valueWidth = Math.max(0, Math.min(VALUE_WIDTH, contentWidth - labelWidth - barFloor));
	const barWidth = contentWidth - labelWidth - valueWidth;

	// Full-height bar chart when the body can hold one; the narrow rows shorten
	// it, and the body's own height wins over both.
	const requestedBarHeight = breakpoint.compact ? (breakpoint.minInnerWidth >= 44 ? 10 : 4) : 14;
	const barHeight = Math.max(1, Math.min(requestedBarHeight, bodyRows));
	const dropped = [...breakpoint.dropped];
	if (barHeight < requestedBarHeight) {
		dropped.push({
			region: "barHeight",
			reason: `body is ${bodyRows} rows — bar chart clamped from ${requestedBarHeight}`,
		});
	}

	// Mirrors /usage's formula exactly, so the panel's calendar heatmap has the
	// same week count as the host's own for the same width.
	const heatWeeks = Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));

	// A sparkline is a single row of marks; under 30 columns it is pinned to the
	// narrow width rather than squeezed further, because it has no second line
	// to fall back to.
	const sparkWidth =
		breakpoint.minInnerWidth < 30 ? Math.min(8, innerWidth) : Math.max(0, Math.min(barWidth, innerWidth));

	return {
		width: safeWidth,
		requestedRows: safeRows,
		breakpoint: breakpoint.name,
		innerWidth,
		columnWidth,
		bodyRows,
		overflowRows,
		columns: breakpoint.columns,
		compact: breakpoint.compact,
		tableColumns: breakpoint.tableColumns,
		showFooterHints: breakpoint.showFooterHints,
		tooNarrow: safeWidth < MIN_USABLE_WIDTH,
		dropped,
		labelWidth,
		valueWidth,
		barWidth,
		barHeight,
		heatWeeks,
		sparkWidth,
	};
}