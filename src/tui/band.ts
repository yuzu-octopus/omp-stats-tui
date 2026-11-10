/**
 * Shared band drawing primitives for the pure IR and production metric/table widgets.
 *
 * THE PROBLEM THIS FIXES. The panel read as a stack of text blocks with a
 * `───` rule above every section, which is what a terminal looks like when each
 * screen invented its own structure. `/usage` draws ZERO rules inside its body.
 * F21 found exactly four band shapes in the web dashboard; F23 turned them into
 * six invariants (G1–G6) that a renderer can follow without making a layout
 * decision. This module IS that renderer.
 *
 * ── The invariants, and why each exists ─────────────────────────────────────
 *
 * **G1 — a band is a heading line plus body lines.** The heading is omitted for
 * `statRow` and `note` (G3) and present for `chart`, `table`.
 *
 * **G2 — the heading is** `` `${icon} ${boldAccent(title)}` `` with, when meta
 * exists, `  ${dim(meta)}` appended on THE SAME LINE. Never a rule.
 *
 * **G3 — `statRow` and `note` have no heading and no icon.** They are the page's
 * first line and its inline caveat, mirroring F21's `StatGrid` sitting directly
 * under `PageHeader` and the web's prose caveats (`CostsRoute.tsx:77`).
 *
 * **G4 — exactly one blank line between consecutive bands.** No leading blank,
 * no trailing blank, no doubles. A band that renders nothing contributes
 * nothing and leaves no gap.
 *
 * **G5 — NO BAND BODY MAY EMIT A FULL-WIDTH RULE.** This is the invariant that
 * kills the complaint, and the reason this module exists at all. `─`, `━` or `═`
 * inside a band is a bug, full stop. F23 §2.2: "This is the single invariant
 * that kills the complaint." Do NOT reintroduce a rule as a section separator —
 * that is the exact regression being fixed. `test/band.test.ts` asserts it
 * literally against a rule-character pattern for every band kind and every
 * preset, so a rule cannot come back quietly.
 *
 * **G6 — the only rule in the whole panel is the `PanelDivider` between body and
 * footer**, exactly as `usage-dashboard.ts:573` has exactly one.
 *
 * `legend` is the deliberate exception to G4: in the web a legend lives INSIDE
 * the chart card, directly beneath it (`OverviewRoute.tsx:181-244`). So it is a
 * continuation — no heading, no blank line before, one after.
 *
 * ── Why `bands` is a parameter and not part of the data contract ────────────
 * F23's seam is deliberate. Putting presentation on the data contract would let
 * any screen bypass the grammar by returning pre-rendered lines — which is the
 * exact failure being fixed. The data contract is deliberately NOT extended;
 * bands are passed in beside it.
 *
 * ── Why the types below are declared here and not imported ─────────────────
 * `src/layout/spec.ts` is owned by another agent and is in flux, so importing
 * from it would make this file's compilation depend on their schedule. The
 * shapes below are MINIMAL STRUCTURAL mirrors of the IR's union: same fields,
 * same discriminants, no extra constraint, so they are assignable in both
 * directions and the two definitions can be reconciled without churn.
 */

import type { ThemeColor } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatPercent } from "./format";
import { glyph, type GlyphSet, type SymbolPreset } from "./glyphs";
import { statsIcon, type IconRole } from "./icons";
import { PALETTE, SERIES_COLORS } from "./palette";

// ─── Minimal structural types (mirror the IR; see the header note) ───────────

export interface StatTile {
	label: string;
	/** Pre-formatted. Numbers become strings via the caller's `read`, never here. */
	value: string;
	/** Only when the whole hint fits; dropped rather than truncated (see below). */
	hint?: string;
	emphasis?: "primary" | "normal";
	/** Render a sparkline under the tile, only when columns <= 2. */
	spark?: readonly number[];
}

export interface ChartSpec {
	type: "bars" | "heatmap" | "sparkline" | "rankedBars" | "shareBar";
	/** Human bucket label; becomes the heading meta when `source` is absent. */
	axis?: string;
	render: () => readonly string[];
}
export interface Column {
	key: string;
	header: string;
	align: "left" | "right";
	cell?: "text" | "meter" | "badge";
	/**
	 * How readily this column may be DROPPED when the row will not fit.
	 *
	 * Higher is dropped first; 0 (the default) means it survives until only the
	 * identity column is left. This is the whole of the truncation policy's
	 * second step, and it exists because the alternative — squeezing every
	 * column until something is one cell wide — is what produced the reported
 * defect: a row of headers over cells that belonged to their neighbours.
	 *
	 * The identity column (index 0) is NEVER dropped: a table row whose subject
 * * the reader cannot see* is a row that cannot be read at all.
	 */
	priority?: number;
}

export type RowSource =
	| { kind: "inline"; rows: readonly Record<string, string>[] }
	| { kind: "series"; series: readonly Record<string, string>[] };

export interface LegendItem {
	label: string;
	share: number;
}

export type Band =
	| { kind: "statRow"; stats: readonly StatTile[] }
	| { kind: "chart"; title: string; chart: ChartSpec; source?: string; preset?: SymbolPreset }
	| { kind: "table"; title: string; columns: readonly Column[]; rows: RowSource; source?: string; selectedRow?: number }
	| { kind: "legend"; items: readonly LegendItem[]; source?: string }
	| { kind: "note"; text: string }

// ─── Colour ──────────────────────────────────────────────────────────────────

/**
 * Colour comes from `palette.ts`, never from tokens chosen here.
 *
 * `PALETTE` is the one place that decides what a colour ROLE means, and each of
 * its entries already cites the web dashboard CSS variable or the `/usage`
 * equivalent it stands in for. A screen that hardcodes its own tokens is the
 * drift this whole refactor exists to prevent — so `band.ts` names roles
 * ("primary", "meta", "dim") and never tokens.
 *
 * Note the deliberate collapse inside `PALETTE`: `meta` and `muted` both
 * resolve to the `muted` token. Do NOT "fix" that. Two names for one colour
 * invite them to drift apart, and at terminal font sizes the distinction a
 * designer would draw is invisible.
 */

/**
 * The colour of the Nth chart series. Cycling `SERIES_COLORS` means a chart
 * series and an omp status segment share a hue identity, because both are drawn
 * from the same list.
 */
function seriesToken(ctx: BandRenderOptions, index: number): ThemeColor {
	return ctx.seriesColorFor?.(index) ?? SERIES_COLORS[index % SERIES_COLORS.length];
}

export interface BandRenderOptions {
	/** Outer width. No rendered row may exceed it. */
	width: number;
	/** Content width after the panel's side insets. Charts size against this. */
	innerWidth: number;
	preset: SymbolPreset;
	glyphs: GlyphSet;
	/**
	 * The theme's own `fg`, passed in rather than read from the singleton —
	 * `theme` is undefined until theme init runs (AGENTS.md), so importing it at
	 * module scope crashes at extension load. Every colour this module emits
	 * goes through here with a NAMED `ThemeColor` token.
	 *
	 * NEVER a raw hex and never a hand-written escape sequence: hardcoding a
	 * colour would break every user theme and the panel would stop looking like
	 * part of omp. `test/band.test.ts` asserts no literal colour escapes.
	 */
	fg: (color: ThemeColor, text: string) => string;
	/** The theme's `bold`. Weight is an emphasis, not a colour. */
	bold: (text: string) => string;
	/**
	 * Series colours for multi-series charts, already resolved to theme tokens
	 * by the caller. Web parity: the dashboard assigns hues by RANK
	 * (`buildColorLookup`), so the same key keeps the same hue across charts.
	 */
	seriesColorFor?: (index: number) => ThemeColor;
	barHeight: number;
	labelWidth: number;
	valueWidth: number;
	/**
	 * `renderSparkline`, injected rather than imported. F23 §2.3 asks for a trend
	 * line under a tile and the grammar must own WHERE it goes; importing the
	 * chart here would make the band layer depend on the chart layer, which is the
	 * dependency direction the whole refactor exists to remove.
	 */
	sparkline?: (values: readonly number[], width: number) => string;
	/** Optional host-themed selection background; the table also retains a text marker. */
	selected?: (text: string) => string;
	/** Production tables bound identity text so measured numeric columns remain useful. */
	identityWidth?: number;
}

/**
 * The MOST columns a stat row may use. Three is not a taste decision: it is
 * the widest tile that still leaves a hint legible at 34 cells, which is what
 * `/usage` card bodies are sized for (usage-dashboard.ts:731-749).
 */
const TILE_MAX_COLUMNS = 3;

/**
 * The gap BETWEEN tiles, in cells. Two, so a tile's own padding never reads as
 * the next tile's gutter — and never as a column.
 */
const TILE_GUTTER = 2;

/**
 * The ceiling on one tile's width. Below it a tile is as wide as its widest
 * line; above it, a label longer than this is truncated rather than allowed to
 * set the geometry for every other tile in the row.
 */
const TILE_MAX_WIDTH = 34;

/** The icon each headed band kind carries (F23 §2.3). */
const BAND_ICONS: Record<"chart" | "table", IconRole> = { chart: "time", table: "requests" };

/**
 * How wide one tile must be: the widest line it owns, clamped to the ceiling.
 *
 * This is the fix for the reported stat-grid defect. The old maths was
 * `floor(innerWidth / columns)` — DIVIDING the panel between slots — so at 146
 * cells three tiles were 48 wide each and `1,045,814,814` sat in a 48-cell slot
 * with 35 cells of nothing beside it. Worse, `columns * floor(inner/columns)`
 * is up to `columns - 1` cells short of `inner`, and the join added two more
 * cells of gutter, so the row overflowed and `clamp` printed a trailing `…` on
 * every single line.
 *
 * Measuring instead of dividing makes the two properties fall out for free:
 * the grid is exactly as wide as its content, and it can never overflow.
 */
function tileWidthOf(stats: readonly StatTile[]): number {
	let widest = 1;
	for (const tile of stats) {
		widest = Math.max(
			widest,
			visibleWidth(tile.label),
			visibleWidth(tile.value),
			tile.hint === undefined ? 0 : visibleWidth(tile.hint),
		);
	}
	return Math.min(widest, TILE_MAX_WIDTH);
}

/** How many columns of `tileWidth` fit in `inner`, gutters included. */
function tileColumns(inner: number, tileWidth: number): number {
	return Math.max(1, Math.min(TILE_MAX_COLUMNS, Math.floor((inner + TILE_GUTTER) / (tileWidth + TILE_GUTTER))));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Clamp to a width, measured — never by `.length`, which is wrong for ANSI. */
function clamp(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}

/** Pad on the right to exactly `width` cells, where the text is short enough. */
function padEndTo(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

function padStartTo(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? " ".repeat(gap) + text : text;
}

// ─── Per-kind layout, as F23 §2.3 determines it ──────────────────────────────

/**
 * `statRow` — a compact grid of tiles, each tile STACKED.
 *
 * The LAYOUT WITHIN a tile is the web's `Stat`: label above, value below, hint
 * under that (`Stat.tsx`: `.stat-label`, `.stat-value`, `.stat-foot`). That
 * fixes three things at once:
 *
 *  1. **A label never touches its value**, because they are on different rows.
 *     No pad width can promise that — `LABEL_WIDTH` is 12 and
 *     "API-equivalent cost" is 18.
 *  2. **One value per tile.** The hint used to be appended INLINE, so a tile
 *     read `Requests 65,460 1,315`: two figures in one cell and nothing in the
 *     layout to say which was the measurement.
 *  3. **Room for a sparkline** under the tile when the grid is one or two
 *     columns wide (F23 §2.3).
 *
 * The GEOMETRY BETWEEN tiles is measured, not divided. That is the fix for the
 * reported defect, and the reasoning is in `tileWidthOf`: dividing the panel
 * between slots left 48-cell tiles holding 13-cell figures, and the rounding
 * made the row overflow so `clamp` printed a bare `…` off the right of every
 * line. Measuring makes the grid exactly as wide as its widest tile, so it can
 * never overflow and never needs clamping.
 *
 * The F23 rules that survive unchanged, and are still load-bearing:
 *   - a hint is DROPPED rather than truncated ("a half-printed `34,870 unpr` is
 *     a worse claim than no hint", F23 §2.3 rule 2);
 *   - the VALUE is truncated and the LABEL never is ("a truncated label is
 *     still a label", F23 §2.3 rule 3);
 *   - `emphasis: "primary"` is bold + accent, the web's larger first tile.
 */
function renderStatRow(stats: readonly StatTile[], ctx: BandRenderOptions): readonly string[] {
	if (stats.length === 0) return [];

	const inner = Math.max(1, ctx.innerWidth);
	// A tile narrower than this cannot hold a hint, so a grid that cannot reach
	// it is one column: better a tall column of readable tiles than a wide row
	// of tiles each missing its own caveat.
	const tileWidth = tileWidthOf(stats);
	const columns = tileColumns(inner, tileWidth);
	// Recomputed against the columns that actually fit: the ceiling alone can
	// still be wider than the panel at one column.
	const cell = Math.max(1, Math.min(tileWidth, Math.floor((inner - (columns - 1) * TILE_GUTTER) / columns)));
	const sparkWidth = Math.max(0, cell - 1);
	const sparkVisible = columns <= 2;
	const lines: string[] = [];

	for (let start = 0; start < stats.length; start += columns) {
		const tiles = stats.slice(start, start + columns);
		// One row of slots PER TILE ROW. A shared set of slots across every tile
		// row would append each row's tiles onto the previous row's, so a
		// five-tile statRow rendered three tiles and dropped the other two.
		const slots: string[][] = [[], [], [], []];

		// Which slot-rows this tile row actually has something to print, decided
		// from the RAW text rather than the padded cell: a tile with no hint still
		// pushes `cell` spaces, and a `trim()` test on that reads "populated".
		const populated: boolean[] = [true, true, false, false];
		for (const tile of tiles) {
			// Host parity: `/settings` headings are muted+bold and `/usage` card
			// titles are bold (tui-adapters.ts:346-347, usage-dashboard.ts:641).
			// DIVERGENCE (deliberate): no underline — the host underlines a
			// heading that has rows beneath it to separate from, and a tile label
			// has only its own value, so an underline would read as a rule
			// fragment and fight G5.
			slots[0].push(padEndTo(clamp(ctx.bold(ctx.fg(PALETTE.muted, tile.label)), cell), cell));

			// Host parity: `/usage` tints a full/pressured figure by status
			// (#statusColor, usage-dashboard.ts:617-621). The primary value is the
			// tile the reader lands on, so it carries the emphasis the IR already
			// declares: bold + primary. Secondary values stay `label`.
			const value = tile.emphasis === "primary"
				? ctx.bold(ctx.fg(PALETTE.primary, tile.value))
				: ctx.fg(PALETTE.label, tile.value);
			// The VALUE truncates: it is the thing that can lose precision least
			// legibly.
			slots[1].push(padEndTo(clamp(value, cell), cell));

			// Rule 2: the whole hint or nothing, and never a bare `…`. A hint is
			// prose, so `dim`, and it lives on its OWN row — inline it read as a
			// second value (D2).
			const hint = tile.hint ?? "";
			slots[2].push(padEndTo(visibleWidth(hint) <= cell ? ctx.fg(PALETTE.dim, hint) : "", cell));
			// Populated is decided from the RAW text, never the padded cell: a tile
			// with no hint still pushes `cell` spaces, and a `trim()` test on that
			// reads "populated". That distinction IS the doubled-blank bug.
			if (hint !== "") populated[2] = true;

			// F23 §2.3: a sparkline under the tile, only when it will not be a
			// smear. Injected, so this module keeps no chart dependency.
			slots[3].push(
				padEndTo(
					tile.spark && sparkVisible && sparkWidth > 0
						? (ctx.sparkline ?? (() => ""))(tile.spark, sparkWidth)
						: "",
					cell,
				),
			);
			if (tile.spark && sparkVisible && sparkWidth > 0) populated[3] = true;
		}
		// The band emits as many slot-rows as its LAST populated one, and no more.
		//
		// That single rule fixes the doubled blank the grammar forbids. A hint row
		// exists only where some tile has a hint to print, and a sparkline row only
		// where one was drawn — so a tile row with neither emits neither, where the
		// old code emitted a blank line anyway. Interior to a multi-row grid that
		// blank was doubled by the next tile row, and at the end of a band it was
		// doubled by G4's separator: two consecutive blanks, which read as a section
		// break that is not there (`test/render-screen.test.ts` asserts none). The
		// errors and tools screens both hit it, each with two tile rows where the
		// first carried no hint.
		//
		// The floor of 1 is the value row: a tile always has a value, so a tile row
		// is never empty and the grid never collapses.
		const lastPopulated = populated.reduce((last, has, index) => (has ? index : last), 1);

		const rows = slots
			.slice(0, lastPopulated + 1)
			.map(cells => clamp(cells.join(" ".repeat(TILE_GUTTER)), Math.min(ctx.width, inner)).trimEnd());
		// And a tile row that still ends blank (a hint that did not fit its cell,
		// or a sparkline that was not drawn) is trimmed, so no tile row contributes
		// a trailing blank either.
		let end = rows.length;
		while (end > 0 && rows[end - 1]!.trim() === "") end--;
		lines.push(...rows.slice(0, end));
	}
	return lines;
}

/**
 * `chart` — heading, then the chart's own rows verbatim. Zero rows of overhead:
 * the chart contributes only its marks (F23 §2.3).
 */
function renderChart(band: Extract<Band, { kind: "chart" }>, ctx: BandRenderOptions): readonly string[] {
	const preset = band.preset ?? ctx.preset;
	// `source` wins; otherwise state the axis, which is what the web puts in
	// the card description ("Per hour", "Per UTC day"). Stating it beats a chart
	// that silently picks one (F23 §2.3).
	const meta = band.source ?? band.chart.axis ?? "";
	const body = band.chart.render().map((row) => clamp(row, ctx.innerWidth));
	return body.length === 0 ? [] : [heading(BAND_ICONS.chart, band.title, meta, preset, ctx), ...body];
}

/**
 * The width each column needs: the widest of its HEADER and its own cells.
 *
 * Deriving the width from the DATA is the fix for the reported table defect.
 * The old code took `max(header.length)` for the label column and a single
 * `valueWidth` for every other column, so a 13-cell provider name in an 8-cell
 * slot overflowed its padding — `padEndTo` cannot shrink text — and pushed
 * every later column a gutter to the right of its own header.
 */
function columnWidths(
	columns: readonly Column[],
	rows: readonly Readonly<Record<string, string>>[],
): number[] {
	return columns.map(column => {
		let widest = visibleWidth(column.header);
		for (const row of rows) {
			const value = row[column.key];
			if (value !== undefined) widest = Math.max(widest, visibleWidth(value));
		}
		return widest;
	});
}

/**
 * THE TRUNCATION POLICY, in the order it applies.
 *
 * A `…` is a truncated FIGURE — the tail of a real number or a real label. It
 * is never a cell of its own, because a column of `…` says "there is more"
 * without saying what, which is the exact failure this policy exists to
 * prevent. So, in order:
 *
 *   1. **Measure.** Each column is exactly as wide as its widest header or
 *      cell, so no column ever has to be squeezed to fit.
 *   2. **Drop.** The lowest-priority columns go, highest priority number
 *      first, until the row fits. Dropping is honest: the data is absent and
 *      the reader can see that it is absent.
 *   3. **Truncate, last.** Only if the identity column alone still overflows is
 *      its text cut — and the cut lands on that column's own figure.
 *
 * The identity column is exempt from step 2 entirely; see `Column.priority`.
 */
function fitColumns(
	columns: readonly Column[],
	widths: readonly number[],
	available: number,
): readonly { column: Column; width: number }[] {
	// One cell between columns: the web's cell padding is 12px either side of a
	// 13px font, which is about one terminal cell at this density.
	const gutter = 1;
	let kept = columns.map((_, index) => index);
	const cost = (indices: readonly number[]): number =>
		indices.reduce((sum, index) => sum + (widths[index] ?? 0), 0) + gutter * Math.max(0, indices.length - 1);

	while (cost(kept) > available && kept.length > 1) {
		// Drop the highest priority number; ties break toward the RIGHT, because a
		// table reads left to right and its later columns are the ones a reader
		// can most afford to lose.
		const candidates = kept.filter(index => index > 0);
		const victim = candidates.reduce((worst, index) =>
			(columns[index]?.priority ?? 0) >= (columns[worst]?.priority ?? 0) ? index : worst,
		);
		kept = kept.filter(index => index !== victim);
	}

	// Step 3, and only when even the identity column alone overflows.
	const surplus = cost(kept) - available;
	return kept.map((index, position) => ({
		column: columns[index]!,
		width: position === 0 && surplus > 0 ? Math.max(1, (widths[index] ?? 1) - surplus) : (widths[index] ?? 1),
	}));
}

/** `table` — heading, header row, and every fetched data row for panel scrolling. */
function renderTable(band: Extract<Band, { kind: "table" }>, ctx: BandRenderOptions): readonly string[] {
	const all = band.rows.kind === "inline" ? band.rows.rows : band.rows.series;
	if (band.columns.length === 0 || all.length === 0) return [];

	// Steps 1 and 2 of the policy above. `width` is a hard ceiling the caller may
	// set below `innerWidth` (a two-column panel), so the table honours both.
	const available = Math.max(1, Math.min(ctx.width, ctx.innerWidth));
	const measured = columnWidths(band.columns, all);
	if (ctx.identityWidth !== undefined) measured[0] = Math.min(measured[0] ?? 0, ctx.identityWidth);
	if (band.selectedRow !== undefined) measured[0] = (measured[0] ?? 0) + 2;
	const kept = fitColumns(band.columns, measured, available);

	// `style` is applied to the TEXT only, never to the padding — padding inside
	// a colour span would tint the whole column gutter.
	const line = (cells: readonly string[], style: (t: string) => string): string =>
		cells
			.map((cell, index) => {
				const width = kept[index]?.width ?? 0;
				// Step 3 of the policy, applied to the TEXT as well as the width:
				// `padEndTo`/`padStartTo` can only ADD space, never remove it, so a
				// cell wider than its column used to overflow the panel and eat the
				// right border. A 44-cell folder path in a 36-cell panel is the case
				// that produced it. Truncating here puts the cut on that column's own
				// value — a real figure with a real tail — which is the only place a
				// `…` is ever allowed to appear.
				const text = style(clamp(cell ?? "", width));
				// A left-aligned column pads on the right so the next column starts
				// at a fixed x; a right-aligned one pads on the left so its DIGITS
				// line up down the table.
				return kept[index]?.column.align === "left" ? padEndTo(text, width) : padStartTo(text, width);
			})
			.join(" ");

	const header = line(
		kept.map((c, index) => (index === 0 && band.selectedRow !== undefined ? "  " : "") + c.column.header),
		// Host parity: `/settings` value column and `/usage` reset/suffix text
		// are the quietest ink (tui-adapters.ts:339-340, usage-dashboard.ts:703).
		// A muted header competes with the figures; a dim header scaffolds.
		(t) => ctx.fg(PALETTE.dim, t),
	).trimEnd();
	// Data cells take DEFAULT TEXT explicitly rather than being left uncoloured:
	// the rule is "not dimmed", and naming the token keeps the table inside the
	// user's theme instead of inheriting whatever the terminal happens to
	// default to.
	const cursor = band.selectedRow === undefined ? "" : glyph(ctx.preset, "rowCursor");
	const body = all.map((r, rowIndex) => {
		const selected = rowIndex === band.selectedRow;
		const rendered = line(
			kept.map((c, index) => (index === 0 && band.selectedRow !== undefined ? `${selected ? cursor : " "} ` : "") + String(r[c.column.key] ?? "")),
			(t) => ctx.fg(selected ? PALETTE.primary : PALETTE.label, t),
		).trimEnd();
		return selected && ctx.selected ? ctx.selected(rendered) : rendered;
	});

	return [
		...(band.title ? [heading(BAND_ICONS.table, band.title, band.source ?? "", ctx.preset, ctx)] : []),
		header,
		...body,
	];
}

/**
 * `legend` — a CONTINUATION, not a band: no heading and no blank line before it
 * (G4's one deliberate exception), because in the web a legend lives inside the
 * chart card, directly beneath it (`OverviewRoute.tsx:181-244`). A terminal that
 * put a gap there would be reading the source less carefully than the browser
 * did (F23 §2.2).
 *
 * Shares sit in a fixed right-hand column so the decimal points line up.
 *
 * The swatch is ONE glyph. Two was a bar, not a key: the reader saw a magnitude
 * where the web's `.swatch` shows a single coloured square, and the extra cell
 * pushed the label one column right of where the chart's own row put it. The
 * COLOUR is what identifies the series; the glyph only has to exist.
 */
function renderLegend(band: Extract<Band, { kind: "legend" }>, ctx: BandRenderOptions): readonly string[] {
	if (band.items.length === 0) return [];
	const labelWidth = Math.max(...band.items.map((i) => i.label.length));
	const SHARE_COL = 7;

	return band.items.map((item, index) => {
		// Each swatch wears its OWN series colour, so a legend key is the same
		// hue as its series elsewhere on the page — the web's `Legend` and ours
		// are the same object for exactly this reason.
		const swatch = ctx.fg(seriesToken(ctx, index), glyph(ctx.preset, "barFill"));
		const label = ctx.fg(PALETTE.muted, padEndTo(item.label, labelWidth));
		const share = padStartTo(formatPercent(item.share), SHARE_COL);
		return clamp(`${swatch} ${label} ${share}`, ctx.width).trimEnd();
	});
}

/** `note` — one dim line. Where "this is not a zero" and the unpriced caveat go. */
function renderNote(band: Extract<Band, { kind: "note" }>, ctx: BandRenderOptions): readonly string[] {
	if (band.text === "") return [];
	return [clamp(ctx.fg(PALETTE.dim, band.text), ctx.width)];
}

/** G2: `${icon} ${boldAccent(title)}` plus `  ${dim(meta)}` on the same line. */
function heading(
	icon: IconRole,
	title: string,
	meta: string,
	preset: SymbolPreset,
	ctx: BandRenderOptions,
): string {
	const parts = [statsIcon(preset, icon), ctx.bold(ctx.fg(PALETTE.heading, title))];
	if (meta !== "") parts.push(ctx.fg(PALETTE.meta, meta));
	return clamp(parts.join(" "), ctx.width);
}

// ─── The grammar ─────────────────────────────────────────────────────────────

/**
 * Compose band bodies into panel lines. Every layout decision was made above;
 * this function only sequences them.
 *
 * G4 lives here and nowhere else: exactly one blank line between consecutive
 * bands, none leading, none trailing, none doubled. An empty band contributes
 * nothing and leaves no gap — so the blank line is attached to the END of a
 * non-empty band rather than inserted before the next one.
 */
export function renderBands(bands: readonly Band[], ctx: BandRenderOptions): readonly string[] {
	const lines: string[] = [];

	for (const band of bands) {
		const body =
			band.kind === "statRow"
				? renderStatRow(band.stats, ctx)
				: band.kind === "chart"
					? renderChart(band, ctx)
					: band.kind === "table"
						? renderTable(band, ctx)
						: band.kind === "legend"
							? renderLegend(band, ctx)
							: renderNote(band, ctx);

		if (body.length === 0) continue;

		// G4: a continuation (legend) follows its chart directly; every other
		// band is separated by one blank line.
		const isContinuation = band.kind === "legend";
		if (!isContinuation && lines.length > 0) lines.push("");
		lines.push(...body);
	}

	return lines;
}