import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * The single width implementation for every chart line. All helpers measure
 * in ANSI-AWARE cells: `Bun.stringWidth` counts the escape BYTES of a styled
 * string, so a themed figure measured wider than it rendered and rows were
 * clipped on themed output while passing on plain-text fixtures. Never use
 * `Bun.stringWidth` on a post-style string — route through here.
 */

/** Clamp to `width` cells. A guard, never an ellipsis source. */
export function clampCells(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}

/** Pad on the right to exactly `width` cells. */
export function padEndCells(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** Pad on the left to exactly `width` cells. */
export function padStartCells(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? " ".repeat(gap) + text : text;
}

/**
 * Truncate to `width` cells with a trailing ellipsis. The only helper that
 * adds an ellipsis — every other truncation is a silent clamp.
 */
export function ellipsizeCells(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return truncateToWidth(text, width);
}

/**
 * What a range with no buckets says. Owned here so the band renderer and the
 * host-adapter defensive path cannot drift into two sentences for one state.
 * (The time-series `emptyState` three-sentence distinction is separate and
 * deliberate — not this sentence.)
 */
export const NO_ACTIVITY = "No activity recorded in this range.";

/** A clickable bucket span, rows relative to the chart's own output. The caller adds its layout offset and series identity. */
export interface BucketSpan { rowStart: number; rowEnd: number; colStart: number; colEnd: number; index: number; }
