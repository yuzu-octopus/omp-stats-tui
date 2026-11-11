/**
 * The three thin chart primitives: sparkline, ranked bar list, share bar.
 *
 * Pure render functions. No I/O, no theme singleton, no database. Every mark
 * comes from the glyph module through `glyph()`, so the ASCII preset degrades
 * without this file knowing that a preset exists.
 *
 * ── Four rules, each one a rule against a specific lie ──────────────────────
 * F17 (Crush/btop/bottom/gnuplot/VisiData), F18 (ratatui) and F19 (glyph audit)
 * surveyed independently and converged on all four. They are not style choices:
 *
 * 1. **ZERO-BASELINED AGAINST A CALLER-SUPPLIED MAX. NEVER MIN-MAX.**
 *    Min-max stretches each series to fill the ramp, so a quiet week renders
 *    identically to a busy one — precisely backwards for a stats panel. Every
 *    function here takes an explicit `max` and scales against it.
 *    DO NOT "improve" this into min-max. Ratatui states the rule in as many
 *    words: "there is no min-max stretch, so a flat series renders as a solid
 *    row rather than as noise."
 *
 * 2. **`max === 0` IS A REAL CASE, NOT A CRASH.** A week with no activity must
 *    render as a zero-baseline run of glyphs. Crush's guard is `if (max === 0)
 *    max = 1`; we take the equivalent, and never return "" for a series that
 *    has data — an empty line inside a bordered panel reads as a layout bug.
 *
 * 3. **CLIP, DO NOT DOWNSAMPLE — AND KEEP THE NEWEST.** Averaging adjacent
 *    samples invents values that were never observed, which on a stats panel is
 *    a fabricated data point. Ratatui clips to the OLDEST `width` samples, which
 *    is wrong for a live panel because it hides today; we take the LAST `width`.
 *    (The one exception is cost, where SUMMING is the semantics — that is
 *    `densify`, used by `bars.ts`, not this file.)
 *
 * 4. **A ZERO-VALUED ROW MUST BE VISIBLE.** In a ranked list a zero row emits
 *    at least one cell, so it reads as "measured, and zero" rather than as
 *    "no data". Same reasoning as bars.ts: a not-yet-built bucket must never
 *    look like a cheap one.
 *
 * The cost of unpriced requests is handled by `costWithUnpriced` from
 * `../format`, which is the single implementation of that rule (Task 4). It is
 * reused, never re-derived here.
 */

import { costWithUnpriced, formatInteger } from "../format";
import { glyph, glyphsFor, type GlyphValue, type SymbolPreset } from "../glyphs";
import { visibleWidth, truncateToWidth } from "@oh-my-pi/pi-tui";
// Single width implementation: local ellipsize/pad*/clampLine were byte-identical
// to these; see ./measure.
import { clampCells as clampLine, ellipsizeCells as ellipsize, padEndCells as padEndTo, padStartCells as padStartTo } from "./measure";

/** Gap between a share bar's track and its readout, in cells. */
const SHARE_GAP = 1;
/**
 * The most cells a horizontal bar may occupy.
 *
 * Web parity, not taste: `MeterCell`'s meter is `width: 64px` (styles.css:
 * 1401-1403) next to a 13px figure, so the bar is roughly three times the
 * figure's width. A terminal cell is about as wide as the web's 13px figure
 * column, so 48 cells is the same proportion — and far short of the 113 cells
 * a 146-cell panel used to hand the top row, which read as a solid block rather
 * than as a measurement.
 *
 * Exported so the share-bar rows budget against the SAME bound. A share bar is a
 * ranked bar with one row, and letting the two
 * primitives disagree about how wide a bar may be is how one of them ends up
 * full-bleed again.
 */
export const BAR_TRACK_MAX = 48;

// ─── Sparkline ───────────────────────────────────────────────────────────────

export interface SparklineOptions {
	/** Columns to emit. Output is exactly this many cells. */
	width: number;
	/**
	 * The value that maps to the top of the ramp. Omit to use the series'
	 * own maximum, which is still zero-baselined (rule 1).
	 */
	max?: number;
	/** Symbol preset. Passed through to `glyph()`; never branched on here. */
	preset?: SymbolPreset;
	/** Data ink, applied to each measured cell (level 0–7), never blank padding. */
	accent?: (cell: string, level: number) => string;
}

/**
 * One character per sample, magnitude on the eighth-block ramp.
 *
 * `level = clamp(round(v / max * (levels - 1)), 0, levels - 1)` — ratatui's
 * linear tick model with an 8-slot ladder, implemented in integer arithmetic.
 */
export function renderSparkline(values: readonly number[], opts: SparklineOptions): string {
	const width = Math.max(0, Math.floor(opts.width));
	if (width === 0) return "";

	// Rule 3: clip to the last `width` samples, so the newest data survives.
	// A shorter series is right-aligned, which puts its newest sample on the
	// right edge — including the single-point case, where anchoring right is the
	// whole point: a one-column panel should show now, not a one-character
	// history pinned to the past.
	const start = Math.max(0, values.length - width);
	const padding = Math.max(0, width - values.length);

	// Invalid samples sit on the baseline without poisoning the valid scale.
	let max = opts.max ?? 0;
	if (opts.max === undefined) {
		for (const value of values) if (Number.isFinite(value) && value > max) max = value;
	}
	const scale = Number.isFinite(max) && max > 0;

	const ramp = glyphsFor(opts.preset ?? "unicode").sparkRamp;
	// THE PADDING IS BLANK, NOT THE ZERO RUNG. It used to repeat
	// `sparkRamp[0]`, which is the very glyph a measured zero draws — so a cell
	// holding no data and a cell that recorded nothing were the same mark, which
	// is the exact conflation rule 4 exists to prevent. In the tools table this
	// read `▁▁▁▂▅▆…`, where nothing said the first three days were absent rather
	// than quiet. The web's in-cell `Sparkline` has no padding concept at all:
	// it draws `n` points and the container is whatever width it is
	// (`Sparkline.tsx:20-38`).
	let result = " ".repeat(padding);
	for (let index = start; index < values.length; index++) {
		const value = values[index]!;
		const level = scale && Number.isFinite(value)
			? Math.max(0, Math.min(7, Math.round((Math.max(0, value) / max) * 7)))
			: 0;
		const cell = typeof ramp === "string" ? ramp : ramp[level]!;
		result += opts.accent ? opts.accent(cell, level) : cell;
	}
	return result;
}

// ─── Ranked bar list ─────────────────────────────────────────────────────────

export interface RankedRow {
	label: string;
	value: number;
	/** Display figure; defaults to a formatted count (or cost, if unpriced). */
	display?: string;
	/** Requests that could not be priced. Non-zero ⇒ the figure is a floor. */
	unpriced?: number;
}

export interface RankedBarsOptions {
	width: number;
	/**
	 * Scale maximum. Omit to use the largest value in the SHOWN set — one
	 * divisor across every row, which is what makes the bars directly
	 * comparable and removes the need for an axis or a legend.
	 */
	max?: number;
	preset?: SymbolPreset;
	/** Data ink: the bar only. The web's BarList paints its fill and nothing else. */
	accent: (text: string) => string;
}

/**
 * A ranked horizontal bar list: label, bar, figure, one row per entry.
 *
 * Every row shares ONE divisor — `maxShown`, the largest value in the shown
 * set — which is what makes the bars directly comparable and removes the need
 * for an axis, ticks or a legend.
 *
 * **The track is BOUNDED.** The defect this fixes: `track = width - label -
 * readout` handed the bar every cell the label and figure did not want, so at
 * 146 columns the top provider painted 113 solid cells and the second provider
 * painted one — a solid purple block with a stray tick under it, which reads as
 * a background, not a measurement. The web's own `MeterCell` meter is 64px
 * (styles.css:1401-1403) beside the figure; the terminal equivalent is the
 * same proportion, so the bar takes at most {@link BAR_TRACK_MAX} cells.
 *
 * A bounded track means the row is SHORTER than the panel, which is the point:
 * a ranked list is a column of marks, not a full-bleed background.
 */
export function renderRankedBars(rows: readonly RankedRow[], opts: RankedBarsOptions): readonly string[] {
	// The one case where returning nothing is right: an empty list has genuinely
	// nothing to draw, and unlike a sparkline it draws no track.
	if (rows.length === 0) return [];

	const width = Math.max(0, Math.floor(opts.width));
	const preset = opts.preset ?? "unicode";
	const fill = glyph(preset, "barFill");

	// Descending by rank. An unpriced row ranks by its unpriced REQUEST count
	// rather than by its zero cost, so a heavily-used model whose spend could not
	// be measured is not buried at the bottom where nobody sees the marker.
	const rank = (r: RankedRow) => (r.unpriced && r.unpriced > 0 ? r.unpriced : r.value);
	const sorted = [...rows].sort((a, b) => rank(b) - rank(a));

	const maxShown = opts.max ?? Math.max(0, ...sorted.map((r) => r.value));
	// Rule 2: a zero max makes every row a measured zero rather than a division
	// by zero. Rule 4 then still emits a cell, so the row stays visible.
	const divisor = maxShown > 0 ? maxShown : 1;

	// ── The budget, spent in PRIORITY ORDER ──────────────────────────────────
	//
	// Three parts compete for the row, and the order below IS the truncation
	// policy for a ranked list:
	//
	//   1. the FIGURE — the measurement. Never truncated, never dropped; a row
	//      with no figure says nothing at all.
	//   2. the BAR — the ranking. It yields first, because a shorter bar still
	//      compares correctly against its neighbours (one divisor across the
	//      list) whereas a missing bar is merely honest.
	//   3. the LABEL — the identity. Truncated last, and only while it keeps
	//      enough characters to identify the row; below that it is DROPPED rather
	//      than reduced to a bare `…`, which is the floating ellipsis the policy
	//      forbids.
	//
	// The defect this replaces: the row was `label bar figure` with the bar
	// taking `width - label - figure`, so at a narrow width the label was
	// ellipsized to nothing and the figure was pushed off the end, leaving
	// `openrouter █ …` — an ellipsis standing alone as a cell.
	const readoutWidth = Math.max(...sorted.map((r) => visibleWidth(readoutFor(r))));
	const wantedLabel = Math.max(...sorted.map((r) => visibleWidth(r.label)));
	// A label worth printing: enough characters to tell two rows apart, and never
	// more than a third of the row so the bar keeps a share of it.
	const minLabel = Math.min(6, wantedLabel);
	const labelWidth = Math.max(0, Math.min(wantedLabel, Math.floor(width / 3), Math.max(0, width - readoutWidth - 1)));
	// The BOUND. Below it the bar still reads a ratio across ten orders of
	// magnitude (a tenth of a cell per percent); above it a bar stops being a bar
	// and becomes a background.
	const track = Math.max(0, Math.min(BAR_TRACK_MAX, width - labelWidth - readoutWidth - 2));
	// Whether the label survives at all. `label + figure + one gutter` must fit in
	// `width`, or the label goes: a label squeezed to one cell of `…` is the
	// floating ellipsis, and dropping it leaves a bar and a figure that both
	// still mean something.
	const keepLabel = labelWidth >= minLabel && labelWidth + readoutWidth + 1 <= width;

	return sorted.map((row) => {
		// Rule 4: the one-cell floor on the bar. A row that rendered no bar at all
		// would be indistinguishable from a row the query never returned — and
		// this may be the unpriced model the reader most needs to see.
		const filled = track === 0 ? 0 : Math.max(1, Math.min(track, Math.round((row.value / divisor) * track)));

		// Measured in ANSI-AWARE cells. `Bun.stringWidth` counts the escape BYTES
		// of a coloured glyph, so under a real theme every row measured over-wide
		// and was truncated — the `…` at the right of the burn chart.
		const readout = padStartTo(readoutFor(row), readoutWidth);
		const label = keepLabel ? `${padEndTo(ellipsize(row.label, labelWidth), labelWidth)} ` : "";
		// THE TRACK IS BLANK, NOT A SHADE BLOCK. `dim(barEmpty)` used to fill it,
		// so a ranked list read `████░░░░░░░░░░░` — a field of texture whose
		// unfilled part is louder than its filled part. The web's `BarList` has no
		// track at all: `span.bar-list-fill` is `width: pct%` with no sibling
		// behind it (`BarList.tsx:26-36`), and the one track on the page is
		// `.meter`'s `rgba(255,255,255,0.06)` — a background, not a glyph.
		// The cells are still RESERVED, so the figures stay in one column down
		// the list and the bars remain directly comparable.
		const bar =
			track === 0
				? ""
				: `${opts.accent(fill.repeat(filled))}${" ".repeat(track - filled)}${keepLabel ? " " : ""}`;

		// One row, clamped to the width it was given. Every part above was
		// budgeted against the same `width`, so this is a guard rather than a
		// source of an ellipsis: the parts are the row's own label, bar and figure.
		return clampLine(`${label}${bar}${readout}`, width);
	});
}

/**
 * A row's trailing figure. An unpriced row is `N/A · 34,870 unpriced` — never
 * `$0.00` — and the rule lives in `costWithUnpriced` so there is exactly one
 * implementation of it (Task 4).
 */
function readoutFor(row: RankedRow): string {
	if (row.display !== undefined) return row.display;
	if (row.unpriced !== undefined && row.unpriced > 0) return costWithUnpriced(row.value, row.unpriced);
	return formatInteger(row.value);
}

// ─── Share bar ───────────────────────────────────────────────────────────────

export interface ShareBarOptions {
	width: number;
	preset?: SymbolPreset;
	/**
	 * Data ink, and it is REQUIRED rather than optional: the web colours every
	 * share segment from the series palette (`ShareBar.tsx:19`,
	 * `background: s.color`), and the legend directly beneath this bar paints
	 * its swatches from the same list (`band.ts`'s `seriesToken`). A share bar
	 * with no colour was a bar whose key wore a hue the bar itself did not.
	 *
	 * It must resolve through `resolveSeries`, never a private list — the two
	 * have to agree by construction, which is the whole point of a shared
	 * `SERIES_COLORS`.
	 */
	accent: (text: string) => string;
}

/**
 * A single-share bar: filled cells, empty cells, then a readout.
 *
 * The algorithm is transcribed from Charm's bubbles `progress.ViewAs` (F17):
 *
 *     textWidth = Bun.stringWidth(readout)     // the number is rendered FIRST
 *     track     = Math.max(0, width - textWidth - gap)
 *     filled    = Math.max(0, Math.min(track, Math.round(track * share)))
 *
 * The ordering is the point. Measuring the number before laying out the bar is
 * what stops the readout being pushed off the end of the row, and it means that
 * at a narrow width the bar disappears and the number wins — the right trade,
 * since the number is the fact and the bar is the decoration.
 *
 * No eighth-block ramp here: one cell is 1/track of the scale, which is plenty
 * for a share, and eighths would imply resolution this does not have.
 *
 * The unfilled track is BLANK. It used to be `barEmpty`, and with the fill
 * painted in a series colour a 0.0% row read as a solid field of texture that
 * was louder than the 96.9% row above it. The web's share bar is a set of
 * segments on `.share-bar`'s `rgba(255,255,255,0.06)` background — a
 * background, not a glyph — and a zero segment is omitted outright
 * (`ShareBar.tsx:15`).
 */
export function renderShareBar(share: number, opts: ShareBarOptions, readout = ""): string {
	const width = Math.max(0, Math.floor(opts.width));
	const preset = opts.preset ?? "unicode";
	// NOTE: `barEmpty` is deliberately NOT fetched here. The floor is a blank
	// cell, so naming the shade glyph would leave a reader to work out why it
	// is looked up and discarded // see the divergence note below.
	const fill = glyph(preset, "barFill");

	// Render the number FIRST, then give the bar what is left. The gap is
	// reserved and then EMITTED, so the line is exactly `width` cells whenever
	// the readout fits; reserving a gap and not printing it loses a cell per row.
	//
	// A readout WIDER THAN THE ROW is truncated to the row, never returned whole.
	// The old behaviour printed it in full, so a long figure pushed the line past
	// the panel and corrupted the overlay around it — the one over-wide line a
	// chart must never cause. The bar has already yielded completely at that
	// width (track === 0), so nothing is traded away by clipping the fact.
	const fitted = visibleWidth(readout) > width ? truncateToWidth(readout, width) : readout;
	const textWidth = visibleWidth(fitted);
	const gap = fitted ? Math.min(SHARE_GAP, Math.max(0, width - textWidth)) : 0;
	const track = Math.max(0, width - textWidth - gap);

	// Rule 2: a share of zero is a measured zero — an all-empty track, never a
	// division by zero and never a missing line. A share above 1 clamps to full
	// so a percentage over 100 cannot overflow the column.
	const clamped = Math.max(0, Math.min(1, share));
	const filled = Math.max(0, Math.min(track, Math.round(track * clamped)));

	return `${opts.accent(fill.repeat(filled))}${" ".repeat(track - filled)}${" ".repeat(gap)}${fitted}`;
}