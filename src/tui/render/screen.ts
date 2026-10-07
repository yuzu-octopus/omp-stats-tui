/**
 * `src/tui/render/screen.ts` — one `ScreenSpec` to rendered terminal lines.
 *
 * THIS IS THE SEAM THE WHOLE IR EXISTS TO REACH. Three hand-written screens each
 * invented their own visual structure, so consistency was something a reviewer
 * had to notice and a fourth screen would have had to reinvent. Here a screen is
 * DATA (`spec.ts`), the grammar is ONE function (`band.ts`), and this module is
 * the only place the two meet. Nothing below makes a layout decision: it turns
 * refs into formatted strings and hands bands to `renderBands`, which owns every
 * column width, every blank line, and the rule that a body may not draw a rule.
 *
 * ── What this module owns, and why it is not more ───────────────────────────
 *
 * Formatting. `MetricRef` deliberately does not say how a value reads, so
 * something has to. {@link FIELD_FORMAT} maps a payload field to the formatter
 * that makes it honest, and it is the whole reason "a $0.00 beside 4,359
 * unpriced requests" cannot happen here: a cost field goes through
 * `costWithUnpriced`, the single implementation of that rule in the project, and
 * a token field goes through a compact formatter, which is why the four token
 * kinds never collapse into one figure that is 95.5% cache reads.
 *
 * ── The four rules that are not formatting, and are therefore stated ─────────
 *
 *  1. **A band that resolves to nothing contributes nothing.** G4 in `band.ts`
 *     drops an empty band and leaves no gap behind it; this module is what makes
 *     a band empty. No rows, no tile with a value, no plottable series. The
 *     alternative — a heading over nothing — produces a screen that looks
 *     finished and shows no data.
 *
 *  2. **A multi-series bar chart draws one block per series and never sums
 *     them.** The IR declares `costs`' daily estimate as four cost COMPONENTS
 *     and `overview`'s activity as requests plus errors, where errors are a
 *     SUBSET of requests. Stacking the first is right; stacking the second
 *     overstates the total by the error rate. The IR carries no rule that tells
 *     them apart, so this renderer refuses to guess: each series gets its own
 *     block, the per-series height splits the band so a four-component chart is
 *     the same height as a one-series chart, and the paired `legend` band names
 *     the parts.
 *
 *  3. **A citation is not a subtitle.** `band.source` records where the port
 *     came from, for a reviewer diffing it against the route. Printing
 *     `OverviewRoute.tsx:247-273` on a terminal is developer-facing text in the
 *     user's face, so the renderer substitutes a human axis label for it.
 *
 *  4. **A meter cell draws a bar and no number.** The table already has a column
 *     for the figure; a meter that printed its own number would read as two
 *     numbers and invite the reader to compare them.
 *
 * PURE AND INJECTED. No theme singleton — `fg` and `bold` are injected — no
 * `Date.now()` (the axis reads `now`), no database, no terminal. Every screen
 * therefore renders headless at any width, which is what
 * `test/render-screen.test.ts` does across 40–200 columns × three presets ×
 * nine screens, and what `scripts/probe-render.ts` does for a human.
 */

import { bucketAxis } from "@oh-my-pi/omp-stats/client/data/range";
import { modelKey } from "@oh-my-pi/omp-stats/client/data/colors";
import { buildCostSummary } from "@oh-my-pi/omp-stats/client/data/view-models";
import type { CostTimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { ThemeColor } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

import type { PanelData } from "../../data/api";
import {
	isFetched,
	resolveCell,
	resolveNumber,
	resolveSeriesValues,
	rowsFor,
	type DataRow,
} from "../../layout/resolve";
import { bucketMsFor, type Range } from "../../data/ranges";
import { sourceOf } from "../../layout/spec";
import type {
	Band as IRBand,
	ChartSpec,
	Column as IRColumn,
	LegendItem as IRLegendItem,
	MetricRef,
	MetricSource,
	RowSource,
	ScreenSpec,
	StatTile as IRStatTile,
} from "../../layout/spec";
import { isProseHint, proseHintText } from "../../layout/spec";
import { renderBands, type Band, type BandRenderOptions } from "../band";
import { planSeries, renderHostChart } from "../charts/host-adapter";
import { calendarLayout } from "../charts/calendar";
import { renderHeatmap, weeksForWidth } from "../charts/heatmap";
import { BAR_TRACK_MAX, renderRankedBars, renderShareBar, renderSparkline, type RankedRow } from "../charts/sparkline";
import {
	costWithUnpriced,
	formatBytes,
	formatCost,
	formatDurationMs,
	formatInteger,
	formatPercent,
} from "../format";
import { glyph, glyphsFor, type GlyphSet, type SymbolPreset } from "../glyphs";
import type { LayoutPlan } from "../layout";
import { PALETTE, SERIES_COLORS, heatRamp, type PaletteTheme } from "../palette";

/** Bucket width of `costSeries`, in ms. DAY for every range — see `bucketedValues`. */
const COST_BUCKET_MS = 24 * 60 * 60 * 1000;

/** Weekday-label gutter for the heatmap, in cells. Two, for `M ` / `W `. */
const HEAT_LABEL_WIDTH = 2;

/** What a chart heading's meta reads when the IR supplied only a citation. */
const AXIS_LABEL: Record<ChartSpec["axis"], string> = {
	cost: "per day, by billing component",
	requests: "requests per bucket",
	tokens: "tokens per bucket",
	count: "calls per bucket",
	share: "share of the total",
	time: "over the range",
};

/**
 * The payload field each grouped source is keyed by.
 *
 * A `shareBar` or `rankedBars` needs a LABEL for every value it plots, and the
 * IR names a `groupBy` only when the grouping is itself part of the fact shown.
 * Where it does not, the dimension is still unambiguous from the route: one row
 * per model, per folder, per tool. A source missing from this table has its rows
 * grouped by nothing and its chart is skipped rather than drawn unlabelled.
 */
const GROUP_KEY: Partial<Record<MetricSource, string>> = {
	byModel: "model",
	modelSeries: "model",
	modelPerformanceSeries: "model",
	costSeries: "model",
	errorModels: "model",
	folders: "folder",
	toolsByTool: "tool",
	toolsByToolModel: "tool",
	toolsSeries: "tool",
	providerStats: "provider",
};
// ─── The option bag ──────────────────────────────────────────────────────────

/**
 * Everything one screen needs to render. The theme arrives as two injected
 * callbacks rather than as an object, so this module can never hold a reference
 * to the singleton the extension loader has not created yet.
 */
export interface ScreenRenderOptions {
	spec: ScreenSpec;
	data: PanelData;
	plan: LayoutPlan;
	preset: SymbolPreset;
	range: Range;
	/** Injected clock. The bucket axis is derived from it, never from `Date.now()`. */
	now: number;
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
	seriesColorFor?: (index: number) => ThemeColor;
	/**
	 * The palette's own slice of a `Theme`. Injected rather than imported because
	 * `heatRamp` resolves real hex values, and a renderer that reached for the
	 * singleton would both crash at extension load and freeze whichever theme
	 * happened to be active while the module loaded.
	 */
	palette: PaletteTheme;
	/** Injected "today" for the heatmap's `null` future cells. */
	today?: Date;
	/**
	 * True while a background sync is still streaming activity in: the summary
	 * carries the host's own ` · syncing…` suffix (usage-dashboard.ts:847).
	 * Absent means settled — no suffix, exactly like the host after `#loadActivity`.
	 */
	syncing?: boolean;
	glyphs?: GlyphSet;
	/**
	 * The shares every `shareBar` ABOVE this band published, in band order, so a
	 * legend adopts them rather than re-deriving the same number. Populated by
	 * {@link screenBands} on the way through; callers never set it.
	 */
	publishedShares?: readonly ReadonlyMap<string, number>[];
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Turns one resolved value into the text a cell shows. */
type Formatter = (value: number, row: DataRow | undefined) => string;

const count = (value: number | string | null): number | null =>
	typeof value === "number" ? value : null;

/**
 * The unmeasured-request count a row carries, or `null` when it carries none.
 *
 * Two shapes exist because two payloads do: an aggregate row has a real
 * `unpricedRequests` count, while a request row has only the boolean
 * `costUnpriced` that `rowToMessageStats` sets. Reading a count out of that
 * boolean would print "1 unpriced" for each of 4,197 requests and understate
 * the gap by three orders of magnitude.
 */
function unpricedOf(row: DataRow | undefined): number | null {
	if (!row) return null;
	const record = row as Record<string, unknown>;
	if (typeof record.unpricedRequests === "number") return record.unpricedRequests;
	return record.costUnpriced === true ? 1 : null;
}

/**
 * A money figure for a CELL: the cost, and the unmeasured requests beside it.
 *
 * This is the rule the whole panel is built around. `$0.00` beside 4,359
 * unpriced requests reads as a bargain or as a bug; it is neither — it is money
 * nobody has measured. The count is read off the SAME ROW rather than from the
 * screen total, because a folder's row and the overall aggregate carry different
 * populations and only the row is the one being printed.
 */
const cellCost: Formatter = (value, row) => {
	const unpriced = unpricedOf(row);
	return unpriced === null ? formatCost(value) : costWithUnpriced(value, unpriced);
};

/**
 * A money figure for a STAT TILE, where the unpriced count is the hint.
 *
 * The suffix `cellCost` appends is dropped here because the tile's hint already
 * names the same number from the same row, and a tile reading "N/A · 4,359
 * unpriced" beside a hint reading "4,359" would print the caveat twice. What
 * survives is the one thing a bare figure must never do: claim a zero price for
 * spend nobody has measured.
 */
const tileCost: Formatter = (value, row) => {
	const unpriced = unpricedOf(row);
	return value === 0 && unpriced !== null && unpriced > 0 ? "N/A" : formatCost(value);
};

/** Compact notation: `1.2B` is readable where `1,204,000,000` wraps the row. */
const compact: Formatter = value =>
	value < 1000 ? formatInteger(value) : value.toLocaleString("en-US", { notation: "compact" });

/** A fraction as a percentage. An absent fraction is blank, never `NaN%`. */
const percent: Formatter = value => formatPercent(value);

/**
 * An error rate, the web's way.
 *
 * The web has a DEDICATED formatter for this (`formatErrorRate`,
 * formatters.ts:60-64) rather than reusing `formatPercent`, and the reason is
 * the two-digit band: a provider failing 4 of 1,280 requests is 0.31%, which
 * one decimal rounds to `0.3%` — fine — but 1 of 36,616 is 0.0027%, which one
 * decimal rounds to `0.0%`. A rate that reads `0.0%` when requests actually
 * failed is the panel lying, so below 0.005% the web prints `<0.01%`.
 *
 * Transcribed rather than imported: `formatErrorRate` is not exported from the
 * host's `formatters.ts`, and re-deriving the two bands here keeps the rule in
 * one place beside every other formatter this module owns.
 */
function errorRate(value: number): string {
	const scaled = value * 100;
	if (scaled > 0 && scaled < 0.005) return "<0.01%";
	return formatPercent(value, scaled > 0 && scaled < 0.1 ? 2 : 1);
}
/**
 * The same rule as a `FIELD_FORMAT` entry, which is a `Formatter` and so takes
 * the row it never reads. Named so both call sites — the table below and the
 * derived-name branch in `formatValue` — share one implementation.
 */
const errorRateField: Formatter = value => errorRate(value);

/** Request and aggregate latency fields from upstream are milliseconds. */
const duration: Formatter = value => formatDurationMs(value);

/**
 * A rate of throughput keeps its unit. The host's `formatTokensPerSecond`
 * prints one decimal (`61.2`), so this does too — a rounded `61/s` beside the
 * web's `61.2` would read as a different measurement.
 *
 * An ABSENT rate is handled one layer up, in `formatValue`, because a `Formatter`
 * never sees a `null` — the resolver's early return happens before this table is
 * consulted. That is why the dash rule lives there and not here.
 */
const speed: Formatter = value => `${value.toFixed(1)}/s`;

/**
 * An unpriced COUNT only carries information when it is non-zero, so it says
 * "4,359 unpriced" or a plain "0" and never "0 unpriced".
 */
const unpricedCount: Formatter = value => (value > 0 ? `${formatInteger(value)} unpriced` : "0");

/**
 * Premium requests is a multiplier (1.5×), not a count, so it keeps its
 * decimals where every other count in this table is an integer.
 */
const premium: Formatter = value =>
	value === 0 ? "0" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Byte sizes, the host's way. The gain route's `formatBytes` is the contract;
 * this alias keeps the table keyed on field names while the implementation
 * stays in one place.
 */
const bytes: Formatter = value => formatBytes(value);
/**
 * Reduction is a fraction that is ALWAYS null today (snapcompact never sets
 * originalBytes), so the tile reads the web's dash, never `0.0%` and never a
 * blank the leak walk would flag as a missing value.
 */
const reduction: Formatter = value => formatPercent(value);

/**
 * The payload field → formatter table. This IS the "how it reads" half of the
 * IR, and it is keyed on the field names the routes actually use.
 *
 * A field absent from this table is not silently blank: it falls through to
 * {@link formatValue}'s grouped-integer default, so a newly added payload field
 * shows up as a plausible figure rather than as an empty cell, and the leak walk
 * in `test/render-screen.test.ts` catches it if the type was wrong.
 */
const FIELD_FORMAT: Readonly<Record<string, Formatter>> = {
	// Money. `totalCost`/`cost` are what the tiles and the ranked bars print; the
	// four `cost*` fields are the daily-estimate breakdown and must not be summed
	// into one figure by this table — `band.ts` stacks them as separate blocks.
	totalCost: cellCost,
	cost: cellCost,
	"usage.cost.total": cellCost,
	costInput: cellCost,
	costOutput: cellCost,
	costCacheRead: cellCost,
	costCacheWrite: cellCost,

	// Token counts, kept as four separate cells by design.
	totalInputTokens: compact,
	totalOutputTokens: compact,
	totalCacheReadTokens: compact,
	totalCacheWriteTokens: compact,
	/**
	 * Token TOTALS are compact, the web's way: `formatCompact(p.totalTokens)` at
	 * `ProvidersRoute.tsx:366`, `formatCompact(summary.tokens)` at
	 * `RequestsRoute.tsx:133`, `formatCompact(tokens)` at `ModelsRoute.tsx:368`.
	 * `1,017,800,000` is thirteen cells of digits where `1B` is two, and the
	 * extra precision buys a reader nothing at table density — while costing the
	 * table two columns, which is how the reported clipping happened.
	 *
	 * The exact figure is still available: a stat tile's `hint` may name it, and
	 * `format.ts`'s `exactTokens` exists for any row that must be auditable.
	 */
	totalTokens: compact,
	totalTokensShare: compact,
	outputTokensShare: compact,
	tokens: compact,
	"usage.totalTokens": compact,
	"usage.input": compact,
	"usage.output": compact,
	"usage.cacheRead": compact,
	"usage.cacheWrite": compact,

	// Counts.
	totalRequests: formatInteger,
	requests: formatInteger,
	successfulRequests: formatInteger,
	failedRequests: formatInteger,
	unpricedRequests: unpricedCount,
	unpricedRequestsShare: formatInteger,
	calls: formatInteger,
	errors: formatInteger,
	resultChars: compact,
	argsChars: compact,
	unpriced: formatInteger,
	loaded: formatInteger,
	failed: formatInteger,
	hits: formatInteger,
	premiumRequests: formatInteger,
	totalPremiumRequests: premium,
	dirtyHours: formatInteger,
	dirtySessions: formatInteger,
	savedTokens: compact,
	savedBytes: bytes,
	reductionPercent: reduction,
	cacheRate: percent,
	errorRate: errorRateField,
	cacheSavings: percent,
	share: percent,
	avgResult: percent,
	perPricedRequest: percent,
	attributedCost: formatInteger,
	attributedTokens: compact,

	// Latencies.
	avgDuration: duration,
	duration: duration,
	avgTtft: duration,
	ttft: duration,
	medianDuration: duration,
	p95Duration: duration,
	medianTtft: duration,
	avgTokensPerSecond: speed,
};

/**
 * `when` is a formatter over a TIMESTAMP, and it needs the clock — which is why
 * it is a factory and not a table entry. Relative inside a week, absolute beyond
 * it: the reader of a dashboard is usually asking "was that just now?", and a
 * bare epoch or a bare ISO date answers a question nobody asked.
 */
function when(value: number, now: number): string {
	if (value <= 0) return "";
	const delta = now - value;
	if (delta < 0) return new Date(value).toISOString().slice(0, 10);
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
	if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
	return new Date(value).toISOString().slice(0, 10);
}

const WHEN_FIELDS: readonly string[] = ["timestamp", "lastTimestamp", "firstTimestamp", "lastUsed", "lastSeen", "firstSeen"];

/**
 * Does this field name money?
 *
 * Answered by asking {@link FIELD_FORMAT} rather than by a pattern: that table is
 * already the one place deciding how a field reads, and a regex here would be a
 * second list that silently disagrees with it the day a field is added.
 */
function isCostField(field: string): boolean {
	return FIELD_FORMAT[field] === cellCost;
}

/** The field a ref bottoms out in, following `derived` down to its base. */
function leafFieldOf(ref: MetricRef): string {
	return ref.kind === "derived" ? leafFieldOf(ref.of) : ref.field;
}

/**
 * One resolved value as the text of a cell.
 *
 * `null` is ALWAYS the empty string. That is the reason the resolver returns
 * `null` rather than `undefined`: an absent value must be a blank cell, and a
 * blank cell is invisible, so the absence has to have been caught upstream by
 * `test/resolve.test.ts` rather than here where nobody would see it.
 */
function formatValue(
	ref: MetricRef,
	value: number | string | null,
	row: DataRow | undefined,
	opts: ScreenRenderOptions,
): string {
	// An ABSENT value is a dash in exactly two places, and blank everywhere else.
	//
	// The two are TABLE CELLS, and only there. A table column reserves its width
	// whether or not it has a figure, so a blank cell leaves a visible hole under
	// a header that promises one — the reported empty Share and Tokens/s columns.
	// A STAT TILE has no such gutter: a tile with no figure is a tile that says
	// nothing, and `toStatTile` drops it so the screen can still answer "no usage
	// recorded". `row !== undefined` is exactly that distinction — a row-scoped
	// call is a table cell, an unscoped one is a tile.
	//
	// The two dashes are NOT the same character, and each is the host's own:
	//
	//  - `reductionPercent` is ALWAYS null (snapcompact never records an original
	//    size) and `GainRoute.tsx` renders `–`, an EN DASH — U+2013. It is shown on
	//    a stat tile too, because that tile's whole subject is the absent figure.
	//  - `avgTokensPerSecond` is null for a provider or model the payload
	//    measured no throughput for, and `formatTokensPerSecond`
	//    (formatters.ts:81-84) returns `-`, a HYPHEN, for exactly that case.
	//
	// Everything else stays blank: an absent value must be caught upstream by
	// `test/resolve.test.ts`, where an absence is visible, rather than here where
	// nobody would see it.
	if (value === null) {
		const absent = leafFieldOf(ref);
		if (absent === "reductionPercent") return "–";
		if (absent === "avgTokensPerSecond" && row !== undefined) return "-";
		return "";
	}
	// A label is a name, not a figure. `aggregate` also names text fields — the
	// IR uses it for `recentMessages.model` and `label` for the same idea
	// elsewhere — so text is returned as-is and only numbers are formatted.
	if (typeof value === "string") return value;
	const field = leafFieldOf(ref);
	if (WHEN_FIELDS.includes(field)) return when(value, opts.now);
	// Named derived figures read through their NAME, not their field: a Share
	// column bottoms out in `cost` (money) but prints a percent, and a
	// per-request figure bottoms out in `requests` (a count) but prints money
	// with the web's sub-cent bound. Keyed on names the IR declares, so a new
	// derived name falls through to its field rather than to a wrong format.
	//
	// The name is a CONTRACT, not a per-figure patch, and two of its three rules
	// are general:
	if (ref.kind === "derived") {
		// A derived SHARE is a fraction of something, so it reads as a percent.
		// The IR already names these — `modelCostShare`, `providerTokenShare`,
		// `sourceShare` — and every one is a share. The defect this fixes:
		// providers' Share divided `totalTokens` by the grand total, so
		// `leafFieldOf` found the TOKEN formatter and printed the raw fraction
		// `0.0424` where a percentage belongs.
		//
		// `op: "share"` is deliberately NOT the test: `perPricedRequest` shares
		// cost by requests and is money, not a percentage. The NAME is what the
		// IR author declared the figure to be.
		if (/share$/i.test(ref.name)) return formatPercent(value);
		// A derived RATE — providers' `providerErrorRate`, overview's
		// `errorRate` — bottoms out in a COUNT field, so `FIELD_FORMAT[field]`
		// would print `formatInteger(0.017)` = "0.017". That is the raw fraction,
		// which is what the reported Error rate tile showed. Same contract: the
		// name says what the figure measures, with the web's sub-0.005% bound.
		if (/rate$/i.test(ref.name)) return errorRate(value);
		// `modelUnitCost` is the one name whose shape is not general — it is money
		// below a cent, which `formatCost` alone would round to `$0.00`.
		if (ref.name === "modelUnitCost") return value > 0 && value < 0.0001 ? "<$0.0001" : formatCost(value);
	}
	return (FIELD_FORMAT[field] ?? formatInteger)(value, row);
}

// ─── Band conversion ─────────────────────────────────────────────────────────

/**
 * A stat tile. Returned as a plain object rather than through a helper because
 * every field is optional and the grammar already drops what does not fit: the
 * only decision here is which tiles survive at all.
 */
function toStatTile(tile: IRStatTile, opts: ScreenRenderOptions): StatTileOut | null {
	const value = resolveCell(tile.metric, opts.data);
	// A cost tile reads its unpriced count from its own HINT when the hint names
	// one. A stat tile is not row-scoped, so `unpricedOf(undefined)` cannot see it
	// — and a tile printing `$0` beside "34,870 unpriced" is the one lie this
	// panel exists not to tell. Overview's cost tile declares exactly this shape:
	// `metric: totalCost`, `hint: unpricedRequests`.
	const field = leafFieldOf(tile.metric);
	// PROSE is rejected before anything reaches `leafFieldOf`, and that ordering
	// is the point rather than a detail. A bare string handed to `leafFieldOf`
	// reads `ref.kind` off a primitive and comes back `""`, so a cost tile with a
	// prose hint would print `$0.00` where its 34,870 unpriced requests belong —
	// a wrong answer rather than a crash, which is why it needed its own test.
	// `proseHintText` is the IR's narrowing, not one re-derived here: it knows all
	// three legal shapes and normalises both prose spellings to one string.
	const prose = proseHintText(tile.hint);
	// Narrowed ONCE, here, and every use below reads through it: `isProseHint`
	// is a type guard, so its negation leaves `MetricRef` and the compiler
	// proves the two `leafFieldOf`/`resolveNumber` calls cannot be handed prose.
	// Three separate `prose === null` tests would each re-narrow by hand.
	const hintRef: IRStatTile["metric"] | undefined = isProseHint(tile.hint) ? undefined : tile.hint;
	const costHint =
		hintRef !== undefined && /unpriced/i.test(leafFieldOf(hintRef))
			? resolveNumber(hintRef, opts.data)
			: null;
	const text =
		typeof value === "number" && isCostField(field)
			? tileCost(value, costHint === null ? undefined : ({ unpricedRequests: costHint } as DataRow))
			: formatValue(tile.metric, value, undefined, opts);
	// A tile with nothing to say is DROPPED rather than rendered blank: a
	// three-across grid with an empty cell reads as a rendering fault.
	if (text === "") return null;

	// Prose prints verbatim; a figure is resolved against the payload and
	// formatted by its OWN field, which is why the hint is not formatted by the
	// tile's axis.
	const rawHint =
		tile.hint === undefined
			? undefined
			: hintRef !== undefined
				? formatValue(hintRef, resolveCell(hintRef, opts.data), undefined, opts)
				: (prose ?? undefined);
	// The requests screen's median tile pairs its p95 beside it, as the web's
	// `Median duration` stat does. The IR names the value; the prefix is
	// presentation, so it lives here beside the value. `P95`, not `p95`: the
	// D1 stat-tile invariant rejects any lowercase letter touching a digit
	// (`/[a-z]\d/`), because that is the shape a jammed label makes.
	//
	// PROSE NEVER GETS THE PREFIX. `P95` names a QUANTILE, and the tile takes it
	// only when the hint really is the p95 figure — prefixing a sentence would
	// have the row claim a percentile it never measured.
	const hint =
		rawHint === undefined || rawHint === ""
			? undefined
			: tile.label === "Median duration" && hintRef !== undefined
				? `P95 ${rawHint}`
				: rawHint;

	return {
		label: tile.label,
		value: text,
		...(hint === undefined || hint === "" ? {} : { hint }),
		...(tile.emphasis === "primary" ? { emphasis: "primary" as const } : {}),
		...(tile.spark ? { spark: resolveSeriesValues(tile.spark, opts.data, undefined, axisFor(opts, tile.spark)) } : {}),
	};
}

/** The one stat-tile shape the grammar takes, restated so this module owns it. */
interface StatTileOut {
	label: string;
	value: string;
	hint?: string;
	emphasis?: "primary";
	spark?: readonly number[];
}

function statRowBand(stats: readonly IRStatTile[], opts: ScreenRenderOptions): Band | null {
	// The figures THIS statRow states, by metric identity. A hint that is zero
	// and restates one of them is the same figure twice: the costs screen's
	// `API-equivalent estimate` printed the hint `0` while the `Unpriced
	// requests` tile in the same row printed the same `0`, and the extra row
	// pushed the next tile row down. Scoped narrowly — ONLY a hint that
	// resolves to numeric zero is eligible, because a non-zero hint is a second
	// figure (the money caveat at work: `7 unpriced` says how much of the total
	// above is a floor, and the sibling stating it does not make this one
	// redundant, it makes it confirmed). And it fires only when the statRow
	// still states the figure elsewhere: a zero hint that is the ONLY place its
	// figure appears is kept, because dropping it would delete information —
	// nothing else on the row says nothing went unmeasured. Prose hints are not
	// figures at all, so they never qualify.
	//
	// The comparison is by the IR's own metric identity (`groupKeyOf`, the same
	// rule that pairs chart series with legend items), so the two tiles resolve
	// through the same aggregator and print the same text. And the scope is the
	// statRow BAND rather than the rendered tile row: below three-across the
	// grid wraps the tiles into several visual rows, which is a width accident —
	// the statRow is the declared row of figures, so a figure stated anywhere
	// in it is stated. The caveat survives where it belongs either way: at zero
	// there is nothing to caveat, and the sibling tile is on screen with it.
	const stated: Record<string, true> = Object.fromEntries(stats.map(tile => [groupKeyOf(tile.metric), true]));
	const tiles = stats
		.map(tile => {
			const out = toStatTile(tile, opts);
			if (out?.hint === undefined) return out;
			// Narrowed here: prose is words, never a figure, so only a real
			// `MetricRef` can restate a sibling tile.
			const hintRef = isProseHint(tile.hint) ? undefined : tile.hint;
			if (hintRef === undefined) return out;
			const hintValue = resolveNumber(hintRef, opts.data);
			return hintValue === 0 && stated[groupKeyOf(hintRef)] ? { ...out, hint: undefined } : out;
		})
		.filter((tile): tile is StatTileOut => tile !== null);
	return tiles.length === 0 ? null : { kind: "statRow", stats: tiles };
}

/** One IR band as one grammar band, or `null` when it has nothing to say. */
function toBand(band: IRBand, opts: ScreenRenderOptions): Band | null {
	switch (band.kind) {
		case "statRow":
			return statRowBand(band.stats, opts);
		case "chart":
			return chartBand(band.title, band.chart, opts);
		case "table":
			return tableBand(band.title, band.columns, band.rows, opts);
		case "legend":
			return legendBand(band.items, opts, opts.publishedShares ?? []);
		case "note":
			// The one place the IR's own words reach the user unchanged, and that
			// is the point: `note` is where "This is not a zero", the per-call
			// attribution caveat and the rollup staleness live.
			return { kind: "note", text: band.text };
		case "custom":
			// The IR's single `custom` band is `providers`' subscription windows,
			// and that screen is deferred because its payload does not exist.
			// Saying so is the honest body for an unrenderable band; inventing a
			// rendering would be exactly the per-screen grammar this module exists
			// to remove.
			return {
				kind: "note",
				text:
					opts.spec.deferredReason ??
					`${band.id} has no terminal renderer: the layout IR describes it, nothing draws it.`,
			};
	}
}

/** The bands for one screen, in IR order. Empty bands are already dropped. */
export function screenBands(options: ScreenRenderOptions): readonly Band[] {
	// Walks the bands in ORDER, accumulating what each chart published, so a
	// legend can adopt the shares of the chart above it. A copy of the options is
	// threaded rather than the caller's object mutated: `renderScreen` runs once
	// per frame per resize, and a leaked accumulator would make the second frame
	// disagree with the first.
	const published: ReadonlyMap<string, number>[] = [];
	const opts: ScreenRenderOptions = { ...options, publishedShares: published };
	return options.spec.bands.flatMap(band => {
		if (band.kind === "chart" && band.chart.type === "shareBar") {
			published.push(chartShares(band.chart, options.data));
		}
		const converted = toBand(band, opts);
		return converted ? [converted] : [];
	});
}

/**
 * One screen, rendered.
 *
 * When every band turns out to be empty the screen says so in one dim line. The
 * wording covers both causes without choosing between them — the window really
 * had no usage, or the payload was never fetched — because at this layer the two
 * are indistinguishable and a heading over nothing would read as a finished
 * screen showing no data.
 */
export function renderScreen(opts: ScreenRenderOptions): readonly string[] {
	return renderScreenWith(opts).lines;
}

/**
 * A screen rendered, plus the chart rows it drew.
 *
 * The chart rows are RETURNED rather than re-derived because the panel needs them
 * for the tests that assert COST scaling against the real frame, and a second
 * local chart would be exactly the duplication this module removed.
 */
export function renderScreenWith(opts: ScreenRenderOptions): {
	lines: readonly string[];
	chart: readonly string[];
} {
	const bands = screenBands(opts);
	// A screen whose only surviving bands are NOTES has no data to qualify. Its
	// caveats are prose about figures ("the panel has no mode switch, so this
	// screen draws requests") and printing them under no figures reads as a
	// complete page. Say what is actually true instead.
	// A DEFERRED screen answers with WHY, whatever its bands resolved to: its
	// whole point is that the data cannot be fetched, and "no usage recorded"
	// would blame the reader's quiet month for a missing route.
	if (opts.spec.deferred) {
		return {
			lines: [opts.fg(PALETTE.dim, opts.spec.deferredReason ?? "This screen is deferred.")],
			chart: [],
		};
	}
	if (!bands.some(band => band.kind !== "note")) {
		return { lines: [opts.fg(PALETTE.dim, "No usage recorded in this range.")], chart: [] };
	}
	const chart = bands
		.filter((band): band is Extract<Band, { kind: "chart" }> => band.kind === "chart")
		.flatMap(band => band.chart.render());
	return { lines: renderBands(bands, bandOptions(opts)), chart };
}

/** The grammar's options for one screen. Every width comes from the plan. */
function bandOptions(opts: ScreenRenderOptions): BandRenderOptions {
	return {
		width: opts.plan.innerWidth,
		innerWidth: opts.plan.innerWidth,
		preset: opts.preset,
		glyphs: opts.glyphs ?? glyphsFor(opts.preset),
		fg: opts.fg,
		bold: opts.bold,
		seriesColorFor: opts.seriesColorFor,
		barHeight: opts.plan.barHeight,
		labelWidth: opts.plan.labelWidth,
		valueWidth: opts.plan.valueWidth,
		// F23 §2.3's sparkline seam. Injected rather than imported so the band
		// layer never depends on the chart layer.
		sparkline: (values, width) => renderSparkline(values, {
			width, preset: opts.preset, accent: cell => opts.fg(seriesHue(opts, 0), cell),
		}),
	};
}

// ─── Charts ──────────────────────────────────────────────────────────────────

/**
 * The Nth series' hue — the SAME resolution `band.ts` gives a legend swatch.
 *
 * Written out rather than imported so the bar above a legend key and the key
 * itself cannot disagree: they read the same `seriesColorFor`, fall back to the
 * same `SERIES_COLORS` slot, and so a reader who learns "cyan is Cache read"
 * from one gets it from the other. That agreement is the whole point of a
 * shared palette — a private list here is how a share bar and its legend drift
 * into two different colour languages.
 */
const seriesHue = (opts: ScreenRenderOptions, index: number): ThemeColor =>
	opts.seriesColorFor?.(index) ?? SERIES_COLORS[index % SERIES_COLORS.length];

/**
 * One chart band, or `null` when there is nothing honest to draw.
 *
 * A chart over a source the panel never FETCHED is DROPPED, not drawn empty. An
 * empty chart says "nothing happened in this window"; an absent payload says
 * "nobody asked", and drawing the first when the second is true is precisely the
 * silent-empty trap CONTEXT.md names — a screen that looks finished and shows
 * a flat baseline for data nobody queried.
 */
function chartBand(title: string, chart: ChartSpec, opts: ScreenRenderOptions): Band | null {
	if (!chart.series.some(series => isFetched(sourceOf(series.metric), opts.data))) return null;
	const cost = chart.series.find(series => isCostField(leafFieldOf(series.metric)));
	const unknown = cost
		? rowsFor(sourceOf(cost.metric), opts.data).reduce((sum, row) => sum + (unpricedOf(row) ?? 0), 0)
		: 0;
	if (unknown > 0 && chart.series.every(series =>
		resolveSeriesValues(series.metric, opts.data, undefined, axisFor(opts, series.metric))
			.every(value => value === 0))) {
		return { kind: "note", text: `${title}: no priced cost recorded; ${unknown} requests have unknown spend.` };
	}
	const body = chartRows(chart, opts);
	if (body.length === 0) return null;
	return {
		kind: "chart",
		title,
		chart: { type: chart.type, axis: AXIS_LABEL[chart.axis], render: () => body },
	};
}


function chartRows(chart: ChartSpec, opts: ScreenRenderOptions): readonly string[] {
	const width = Math.max(1, opts.plan.innerWidth);
	switch (chart.type) {
		case "heatmap":
			return heatmapRows(opts, width);
		case "shareBar":
			return shareBarRows(chart, opts, width);
		case "rankedBars":
			return rankedBarRows(chart, opts, width);
		case "sparkline": {
			const series = chart.series[0];
			if (!series) return [];
			return [
				renderSparkline(
					resolveSeriesValues(series.metric, opts.data, undefined, axisFor(opts, series.metric)),
					{ width, preset: opts.preset, accent: cell => opts.fg(seriesHue(opts, 0), cell) },
				),
			];
		}
		case "bars":
			return barRows(chart, opts, width);
	}
}

/**
 * A calendar heatmap over `dailyActivity`, coloured through the palette's ramp.
 *
 * Grid and totals use the terminal-owned port of `/usage`'s local-calendar
 * algorithm, keeping zero-fill, sqrt levels and future-date absence identical.
 */
function heatmapRows(opts: ScreenRenderOptions, width: number): readonly string[] {
	const points = rowsFor("dailyActivity", opts.data);
	if (points.length === 0) return [];
	const weeks = weeksForWidth(HEAT_LABEL_WIDTH, width);
	const grid = renderHeatmap(points as never, {
		innerWidth: width,
		labelWidth: HEAT_LABEL_WIDTH,
		weeks,
		glyphs: opts.glyphs ?? glyphsFor(opts.preset),
		// Four stops, one per level (usage-dashboard.ts:812 + :867) — a
		// three-stop ramp leaves level 4 uncoloured.
		ramp: [0, 1, 2, 3].map(level => heatRamp(opts.palette, level)),
		dim: text => opts.fg("dim", text),
		...(opts.today ? { today: opts.today } : {}),
	});
	// The host's own summary shape (usage-dashboard.ts:839-848): bold-accent
	// head, dim "$COST · N requests · last W weeks", dim sync suffix while
	// syncing. Cost $X integer ≥1 else 2dp; requests compact 1dp.
	const totals = gridTotals(points as never, weeks, opts.today);
	const head = opts.bold(opts.fg("accent", "Activity"));
	const detail = opts.fg("dim", `${totals.cost} · ${totals.requests} requests · last ${weeks} weeks`);
	const syncing = opts.syncing === true ? opts.fg("dim", " · syncing…") : "";
	return [`${head} ${detail}${syncing}`, "", ...grid];
}

/**
 * The window's totals in the host's own number formats
 * (usage-dashboard.ts:839-844, shared with formatActivityTotals:467-475).
 */
function gridTotals(points: readonly DataRow[], weeks: number, today?: Date): { cost: string; requests: string } {
	const layout = calendarLayout(
		points.map(row => {
			const record = row as Record<string, unknown>;
			const day = typeof record.day === "string" ? record.day : "";
			const cost = typeof record.cost === "number" ? record.cost : 0;
			const requests = typeof record.requests === "number" ? record.requests : 0;
			return { day, cost, requests };
		}),
		weeks,
		today,
	);
	const cost =
		layout.totalCost >= 1
			? `$${layout.totalCost.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
			: `$${layout.totalCost.toFixed(2)}`;
	const requests = layout.totalRequests.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
	return { cost, requests };
}

/**
 * One block per series, heights split so a four-component chart is the same
 * height as a one-series chart. NEVER summed — see the module header.
 */
function barRows(chart: ChartSpec, opts: ScreenRenderOptions, width: number): readonly string[] {
	// GEOMETRY IS THE HOST'S. `planSeries` builds the host table, `planChart`
	// picks the kind and `worthCharting` is the gate — a range the host will not
	// chart returns `undefined` and gets our own sentence instead.
	// `renderHostChart` redraws the spec with our glyphs. Writing a
	// multi-series path here is exactly how this chart broke four times in one
	// session — a second encoding nobody compares against the primitive.
	const spec = planSeries(
		chart.series.map(series => ({ label: series.label, values: bucketedValues(series.metric, opts) })),
		{},
	);
	if (!spec) return [opts.fg(PALETTE.dim, "No chart-worthy data in this range.")];
	return renderHostChart(spec, {
		width,
		height: Math.max(1, opts.plan.barHeight),
		preset: opts.preset,
		theme: opts.palette,
		paint: (color, text) => opts.fg(color, text),
		// The floor is CHROME: the web keeps its baseline at `--line-3` and
		// its gridlines at 5.5% white, never in a series hue.
		dim: text => opts.fg(PALETTE.dim, text),
	});
}

/**
 * One series' values on the range's OWN bucket axis.
 *
 * The axis comes from the host's `bucketAxis`, never a hand-built loop, because
 * `densify` matches bucket timestamps EXACTLY: a chart on a different alignment
 * silently drops every point that misses, and a dropped point is lost spend.
 *
 * `costSeries` is DAY-bucketed for every range — the costs route aggregates by
 * day whatever window is asked, and the dashboard's own costs page passes
 * `DAY_MS` explicitly (`CostsRoute.tsx:201`). Deriving its axis from the range
 * instead would put hourly buckets under midnight-aligned rows for `24h`, and
 * the chart would be silently empty.
 */
/** Use the web's real range axis; terminal width only compresses its buckets. */
function bucketAxisFor(opts: ScreenRenderOptions, source: MetricSource): readonly number[] {
	const timestamps = rowsFor(source, opts.data).flatMap(row => {
		const timestamp = (row as Record<string, unknown>).timestamp;
		return typeof timestamp === "number" ? [timestamp] : [];
	});
	const bucketMs = source === "costSeries" ? COST_BUCKET_MS : bucketMsFor(opts.range);
	return bucketAxis(opts.range, timestamps, bucketMs, opts.now);
}

/** The axis a SPARKLINE is drawn against, or `undefined` when there is none. */
function axisFor(opts: ScreenRenderOptions, ref: MetricRef) {
	const axis = bucketAxisFor(opts, sourceOf(ref));
	return axis.length === 0 ? undefined : { axis };
}

function bucketedValues(ref: MetricRef, opts: ScreenRenderOptions): readonly number[] {
	const base = ref.kind === "derived" ? ref.of : ref;
	if (base.kind !== "series") return [];
	// The resolver owns dense bucketing (`denseSeriesValues`, the web's
	// `pivotSeries` minus folding): one value per bucket, gaps zero, several
	// rows in one bucket summed. This used to re-bucket by hand here and
	// disagree with the sparklines; now the chart and the sparkline share one
	// code path and cannot diverge.
	const axis = bucketAxisFor(opts, base.source);
	if (axis.length === 0) return [];
	return [...resolveSeriesValues(base, opts.data, undefined, { axis })];
}

/** One item's value and its share of the group it belongs to. */
interface ShareEntry {
	label: string;
	value: number;
	share: number;
}

/** A legend or bar item, carrying the metric that decides its composition. */
interface ShareItem {
	label: string;
	metric: MetricRef;
	value: number | null;
}

/**
 * The metric identity two items must share to belong to ONE composition.
 *
 * Overview's three agent rows carry three different LABELS reading the same
 * field, so grouping by label would give each a 100% of itself and no
 * composition at all. Grouping by the metric's own identity makes the token four
 * sum to 100% and the agent three sum to 100%, each against its own total — which
 * is what the web draws as two separate `ShareBar`s.
 */
function groupKeyOf(metric: MetricRef): string {
	const base = metric.kind === "derived" ? metric.of : metric;
	return base.kind === "derived" ? groupKeyOf(base.of) : `${base.source}.${base.field}`;
}

/**
 * Items → their shares, each against its OWN metric group's total.
 *
 * The fallback for a composition no chart published: an item nobody plotted still
 * belongs to a group with the items reading the same field, and a share with no
 * denominator at all would print `NaN`.
 */
function sharesOf(items: readonly ShareItem[]): readonly ShareEntry[] {
	const groups = new Map<string, number[]>();
	for (const item of items) {
		if (item.value === null) continue;
		const key = groupKeyOf(item.metric);
		const rows = groups.get(key) ?? [];
		rows.push(item.value);
		groups.set(key, rows);
	}
	return items.flatMap(item => {
		if (item.value === null) return [];
		const total = (groups.get(groupKeyOf(item.metric)) ?? []).reduce((sum, value) => sum + value, 0);
		return [{ label: item.label, value: item.value, share: total === 0 ? 0 : item.value / total }];
	});
}

/**
 * The shares a `shareBar` chart PUBLISHES, keyed by metric identity, so the
 * legend beneath it can adopt them instead of re-deriving.
 *
 * THIS IS THE D4 FIX, and it is a map rather than a second computation because
 * the two renderings previously disagreed: the bar divided the entries it
 * plotted while the legend divided by unrelated agent-request totals. Each
 * composition now publishes its own denominator; agent items use their actual
 * conversation-token totals from the upstream agent view.
 *
 * The web has one number and two renderings of it — `mix[key] / total`
 * (`OverviewRoute.tsx:186-224`). A `shareBar` chart IS that `total`: its series
 * are by construction one composition even though they read four DIFFERENT
 * fields, which is exactly why grouping by field cannot work here. So the chart
 * computes the shares and the legend looks them up.
 */
function chartShares(chart: ChartSpec, data: PanelData): ReadonlyMap<string, number> {
	const entries = chart.series.flatMap(series => {
		const value = resolveNumber(series.metric, data);
		return value === null ? [] : [{ metric: series.metric, value }];
	});
	const total = entries.reduce((sum, entry) => sum + entry.value, 0);
	const shares = new Map<string, number>();
	for (const entry of entries) {
		shares.set(groupKeyOf(entry.metric), total === 0 ? 0 : entry.value / total);
	}
	return shares;
}

/**
 * A share row's three parts, budgeted so the row always FITS.
 *
 * THE DEFECT THIS FIXES. The label column was `min(widestLabel, width / 2)` and
 * the label was then `padEndTo`'d into it — but `padEndTo` only PADS. A folder
 * path is 31 cells where the column was 22, so the row came out 53 cells wide in
 * a 44-cell panel and `clampLine` truncated the tail off. That was invisible
 * while the bar's track was a run of `░`: the truncation landed on a shade block
 * and read as a clipped bar. With a blank track the same overflow ends in a
 * floating `…`, which is the failure D4 exists to forbid — so the label is now
 * ELLIPSIZED to its column, exactly as `renderRankedBars` does.
 *
 * The order of sacrifice is the ranked list's, and it is not a taste call: the
 * FIGURE is the measurement and is never touched, the BAR shortens first, and
 * the LABEL — the only part that can be read without losing a quantity — goes
 * last.
 */
function shareRowLayout(
	labels: readonly string[],
	readouts: readonly string[],
	width: number,
): { labelWidth: number; barWidth: number } {
	const readoutWidth = Math.max(0, ...readouts.map(visibleWidth));
	const widestLabel = Math.max(0, ...labels.map(visibleWidth));
	// Never more than half the row: a label that eats the bar leaves a
	// magnitude with nothing to compare it against.
	const labelWidth = Math.max(1, Math.min(widestLabel, Math.floor(width / 2)));
	// Whatever is left after the label and the figure, and never a full-bleed
	// bar — see `BAR_TRACK_MAX`.
	const barWidth = Math.max(0, Math.min(BAR_TRACK_MAX, width - labelWidth - readoutWidth - 2));
	return { labelWidth, barWidth };
}

/**
 * One share bar per series: label, bar, and the share the chart published.
 *
 * An item the chart does not publish falls back to its own metric group, so the
 * bar set and the legend set are computed by the same rule and agree wherever
 * they overlap.
 */
function shareBarRows(chart: ChartSpec, opts: ScreenRenderOptions, width: number): readonly string[] {
	// A SINGLE-series chart over a GROUPED source (models Request share plots
	// one entry per model) folds to `foldTo` like the web's `pivotSeries`
	// Other-fold. A multi-series chart (costs Where-it-went plots four
	// component totals; overview Token mix plots four token kinds) keeps the
	// per-series path: each series already resolves to its own grand total.
	const single = chart.series.length === 1 && chart.series[0] !== undefined;
	const grouped = single && GROUP_KEY[seriesSource(chart.series[0].metric)] !== undefined;
	if (grouped) return groupedShareBarRows(chart, opts, width);
	const published = chartShares(chart, opts.data);
	const entries = chart.series.flatMap(series => {
		const value = resolveNumber(series.metric, opts.data);
		return value === null ? [] : [{ label: series.label, value }];
	});
	const fallback = sharesOf(
		entries.map(entry => ({ label: entry.label, metric: chart.series[entries.indexOf(entry)].metric, value: entry.value })),
	);
	const resolved = entries.map(entry => {
		const series = chart.series.find(candidate => candidate.label === entry.label);
		const share = (series ? published.get(groupKeyOf(series.metric)) : undefined) ??
			fallback.find(candidate => candidate.label === entry.label)?.share ??
			0;
		// The FIGURE is the SERIES' own figure, formatted by its own metric — not
		// by the chart's axis. That distinction is the whole point: overview's
		// Token mix is a `share` axis over four TOKEN kinds, so an axis-driven
		// formatter printed `1,204,000,000` beside `97.3%` where the web prints
		// `1.2B` (`OverviewRoute.tsx:233`). `formatValue` routes each series
		// through `FIELD_FORMAT`, which already knows a token total is compact.
		return {
			label: entry.label,
			share,
			readout: `${formatPercent(share)} ${series ? formatValue(series.metric, entry.value, undefined, opts) : formatInteger(entry.value)}`,
		};
	});
	const { labelWidth, barWidth } = shareRowLayout(
		resolved.map(row => row.label),
		resolved.map(row => row.readout),
		width,
	);
	return resolved.map((row, index) => {
		const label = `${padEndTo(truncateToWidth(row.label, labelWidth), labelWidth)} `;
		const bar = renderShareBar(row.share, {
			width: barWidth,
			preset: opts.preset,
			// The web colours every share segment from the series palette
			// (`ShareBar.tsx:19`, `background: s.color`) and the legend directly
			// below paints its swatches from the same list. Ours emitted the bar
			// with NO colour at all, so a key below it wore a hue the bar above it
			// did not — the legend was describing something the chart never drew.
			accent: text => opts.fg(seriesHue(opts, index), text),
		});
		return clampLine(`${label}${bar} ${row.readout}`, width);
	});
}


/**
 * One share bar per GROUP (folded to `foldTo`), each against the folded
 * total — the web's `pivotSeries` Other-fold as a composition. Shares come
 * from the same entries the bars draw, so bar and readout cannot disagree.
 */
function groupedShareBarRows(chart: ChartSpec, opts: ScreenRenderOptions, width: number): readonly string[] {
	const entries = foldTo(chart.foldTo, groupedEntries(chart, opts));
	if (entries.length === 0) return [];
	const total = entries.reduce((sum, entry) => sum + entry.value, 0);
	const resolved = entries.map(entry => {
		const share = total === 0 ? 0 : entry.value / total;
		return { label: entry.label, share, readout: `${formatPercent(share)} ${entryFigure(entry, chart.axis, opts)}` };
	});
	const { labelWidth, barWidth } = shareRowLayout(
		resolved.map(row => row.label),
		resolved.map(row => row.readout),
		width,
	);
	return resolved.map((row, index) => {
		// A folder path is 31 cells where the column may be 22, so the label is
		// ellipsized to its column — see `shareRowLayout`.
		const label = `${padEndTo(truncateToWidth(row.label, labelWidth), labelWidth)} `;
		const bar = renderShareBar(row.share, {
			width: barWidth,
			preset: opts.preset,
			// Ranked by value, which is exactly what the web's `buildColorLookup`
			// does — a hue is assigned by descending weight so the same key keeps
			// the same hue wherever it appears (`data/colors.ts:42-45`).
			accent: text => opts.fg(seriesHue(opts, index), text),
		});
		return clampLine(`${label}${bar} ${row.readout}`, width);
	});
}

/** A ranked bar list: label, bar, figure. One divisor across every row. */
function rankedBarRows(chart: ChartSpec, opts: ScreenRenderOptions, width: number): readonly string[] {
	const rows: RankedRow[] = foldTo(chart.foldTo, groupedEntries(chart, opts)).map(entry => ({
		label: entry.label,
		value: entry.value,
		// The FIGURE is built HERE, by `entryFigure`, so `renderRankedBars` never
		// has to know what a token count or a dollar figure looks like — and an
		// unpriced row reads `N/A · 4,197 unpriced` rather than `$0.00`.
		//
		// It used to be built inside the primitive from `formatInteger`, which is
		// why a burn row read `1,045,814,212` where the web's own burn legend
		// reads `1B` (`ProvidersRoute.tsx:236`, `burnFormat`).
		display: entryFigure(entry, chart.axis, opts),
	}));
	return renderRankedBars(rows, {
		width,
		preset: opts.preset,
		// ONE hue for the whole list, deliberately. `BarList`'s default colour is
		// `--chart-primary` and its callers pass one colour for every row
		// (`ProjectsRoute.tsx:133`), because a ranked list compares MAGNITUDES:
		// a different hue per row would spend the reader's colour attention on
		// rank, which the bar's own length already states.
		accent: text => opts.fg(PALETTE.primary, text),
	});
}

/** One entry per group a share or ranked chart plots. */
interface ChartEntry {
	label: string;
	value: number;
	unpriced: number;
	/**
	 * The metric this entry's value was read through, so the readout formats it
	 * the way that METRIC reads rather than the way the chart's axis is spelled.
	 *
	 * The two differ whenever a chart plots one kind of thing: overview's Token
	 * mix is declared `axis: "share"` — because the BARS are shares — while its
	 * four series are token counts the web prints compact
	 * (`OverviewRoute.tsx:233`). Formatting by axis printed `1,204,000,000`
	 * there; formatting by metric prints `1.2B`.
	 */
	metric: MetricRef;
}

/**
 * A share bar's or ranked bar's trailing FIGURE, in the CHART's own unit.
 *
 * Two rules, and they are not the same rule:
 *
 * 1. The figure is formatted through the entry's METRIC, not the chart's axis.
 *    They differ whenever a chart plots one kind of thing: overview's Token mix
 *    is declared `axis: "share"` — because the BARS are shares — while its four
 *    series are token counts the web prints compact (`OverviewRoute.tsx:233`).
 *    Formatting by axis printed `1,204,000,000` there; by metric it prints `1.2B`.
 *
 * 2. The UNPRICED caveat applies only to MONEY, and so only on a cost-scaled
 *    chart. This is the fix for a unit bug found by watching width 100: a
 *    token-scaled burn row read `$201,500,000.00 · 4,197 unpriced` — a dollar
 *    figure for 201,500,000 tokens, because the caveat forced `costWithUnpriced`
 *    whatever the chart measured. But "unpriced" means a price could not be
 *    determined, and a chart of TOKENS has no price to determine. The web agrees:
 *    `burnFormat` follows the chart's metric mode (`ProvidersRoute.tsx:141`) and
 *    the unpriced count lives in the card description (`:194-195`), never on a
 *    burn row.
 *
 * On a non-cost chart the count still rides along, in the chart's own unit —
 * `202M · 4,197 unpriced` — because a reader still wants to know that some of
 * that row's REQUESTS went unmeasured, and dropping the count silently would
 * lose a caveat the cost table already states. Only the UNIT follows the chart.
 */
function entryFigure(entry: ChartEntry, axis: ChartSpec["axis"], opts: ScreenRenderOptions): string {
	const figure = formatValue(entry.metric, entry.value, undefined, opts);
	if (entry.unpriced <= 0) return figure;
	// A cost-scaled chart: `costWithUnpriced` owns the `N/A` — never `$0.00` — and
	// the count, in one place by design.
	if (axis === "cost") return costWithUnpriced(entry.value, entry.unpriced);
	return `${figure} · ${formatInteger(entry.unpriced)} unpriced`;
}

/**
 * The rows a share or ranked chart plots, grouped by the source's dimension.
 *
 * A single-row source (`overall`) contributes ONE entry per SERIES rather than
 * one per row, because the token-mix bar is a composition of four FIELDS and not
 * of four rows of one payload.
 */
function groupedEntries(chart: ChartSpec, opts: ScreenRenderOptions): readonly ChartEntry[] {
	const groupable = chart.series.filter(series => GROUP_KEY[seriesSource(series.metric)] !== undefined);
	if (groupable.length === 0) {
		return chart.series.map(series => ({
			label: series.label,
			value: resolveNumber(series.metric, opts.data) ?? 0,
			unpriced: 0,
			metric: series.metric,
		}));
	}
	return groupable.flatMap(series => {
		const key = GROUP_KEY[seriesSource(series.metric)] as string;
		const base = series.metric.kind === "derived" ? series.metric.of : series.metric;
		const byGroup = new Map<string, ChartEntry>();
		for (const row of rowsFor(seriesSource(series.metric), opts.data)) {
			const record = row as Record<string, unknown>;
			const rawGroup = record[key];
			const group = key === "model" && typeof rawGroup === "string"
				? modelKey(rawGroup, typeof record.provider === "string" ? record.provider : "")
				: rawGroup;
			// ACCUMULATE across rows: the payload carries one row per (bucket,
			// group), so a group's total is the sum over its buckets — the
			// web's `pivotSeries` sums each series' values the same way. The
			// time-bucketed plots go through `bucketedValues`, not here, so no
			// double counting with the bar charts.
			if (typeof group !== "string") continue;
			const value = resolveNumber(
				base.kind === "series" ? { kind: "aggregate", source: base.source, field: base.field } : base,
				opts.data,
				row,
			);
			if (value === null) continue;
			// The `metric` carried on the entry is the series' OWN ref, not `base`:
			// `base` is what the VALUE is summed through, but the readout formats
			// through the series so a derived series keeps its own notation.
			const entry = byGroup.get(group) ?? { label: group, value: 0, unpriced: 0, metric: series.metric };
			entry.value += value;
			const unpriced = (row as Record<string, unknown>).unpricedRequests;
			if (typeof unpriced === "number") entry.unpriced += unpriced;
			byGroup.set(group, entry);
		}
		// A group with no value and nothing unpriced is a group the payload had
		// nothing to say about; printing it as `0.0%` would draw a share bar for a
		// slice that does not exist.
		return [...byGroup.values()].filter(entry => entry.value > 0 || entry.unpriced > 0);
	});
}

/**
 * The payload a chart series reads. `sourceOf` is the IR's own rule and it
 * already follows `derived` to its base, so this function is a name rather than
 * a second implementation — a divergent copy is how `costSeries` and
 * `modelSeries` end up reading different payloads on two different screens.
 */
function seriesSource(ref: MetricRef): MetricSource {
	return sourceOf(ref);
}

/**
 * Keep the largest `foldTo.limit` entries and fold the rest into one labelled
 * row, as `pivotSeries`'s `Other (n)` does in the web dashboard.
 */
function foldTo(
	fold: ChartSpec["foldTo"],
	entries: readonly ChartEntry[],
): readonly ChartEntry[] {
	if (!fold || entries.length <= fold.limit) return entries;
	const sorted = [...entries].sort((a, b) => b.value - a.value);
	const tail = sorted.slice(fold.limit);
	// The fold is a COMPOSITION of the rows it absorbs, so it reads as whatever
	// they read as. `tail[0]`'s metric represents the whole group because a fold
	// only ever groups rows of ONE series together: `groupedEntries` emits one
	// series' groups per call and `foldTo` runs on a single chart's entries. The
	// `!` is honest — `entries.length > fold.limit` is the guard above, so `tail`
	// holds at least one row.
	const [first] = tail;
	return [
		...sorted.slice(0, fold.limit),
		{
			label: `${fold.label} (${tail.length})`,
			value: tail.reduce((sum, entry) => sum + entry.value, 0),
			unpriced: tail.reduce((sum, entry) => sum + entry.unpriced, 0),
			metric: first!.metric,
		},
	];
}


// ─── Tables ──────────────────────────────────────────────────────────────────

/**
 * A table: header row, one row per payload row.
 *
 * `cell: "meter"` and `cell: "sparkline"` are composed HERE rather than by the
 * grammar, because both need a scale the grammar cannot know: a meter divides by
 * the largest value in its own COLUMN and a sparkline needs one row's series.
 * The grammar still owns the column widths and the clamping, so a table is laid
 * out in exactly one place like every other band.
 */
function tableBand(
	title: string,
	columns: readonly IRColumn[],
	rowSource: RowSource,
	opts: ScreenRenderOptions,
): Band | null {
	// The By-model table folds (bucket, model) rows to one row per MODEL: the
	// cost payload carries one row per day per model, and a table that listed
	// bucket rows would print the same model once per day it was active.
	const folded = rowSource.source === "costSeries"
		? buildCostSummary(rowsFor("costSeries", opts.data) as readonly CostTimeSeriesPoint[]).models
		: rowsFor(rowSource.source, opts.data);
	const all = sortRows(folded, rowSource, opts);
	if (all.length === 0) return null;

	// A column that resolves to zero in EVERY row is noise, not a figure: the
	// costs screen's `By model` printed Cache read and Cache write as `$0` down
	// all three rows — a header, a gutter and a digit restating "nothing
	// happened here". Dropped HERE, where the composition decision is made, and
	// against the FULL ordered set rather than the shown prefix: dropping on a
	// prefix would hide a non-zero model past the row limit. Two columns survive
	// whatever the rows say. The identity (index 0, as in the truncation policy)
	// because a row whose subject the reader cannot see cannot be read at all.
	// The money caveat — a column reading `unpricedRequests`, the same test the
	// stat tiles use — because AGENTS.md:228 renders it beside cost ALWAYS: a
	// cost figure shown without it is a wrong number, not a rounded one, and a
	// dropped caveat would REMOVE a claim where every other dropped column only
	// stops repeating one. A `null` keeps its column: a value that cannot be
	// resolved is not a zero measurement.
	const kept = columns.filter((column, index) =>
		index === 0
		|| /unpriced/i.test(leafFieldOf(column.source))
		|| !all.every(row => resolveNumber(column.source, opts.data, row) === 0),
	);

	const maxes = columnMaxes(kept, all, opts);
	const cellWidth = Math.max(1, opts.plan.valueWidth);

	return {
		kind: "table",
		title,
		columns: kept.map(column => ({
			key: column.header,
			header: column.header,
			align: column.align,
			...(column.cell && column.cell !== "sparkline" ? { cell: column.cell } : {}),
			// The IR's own drop order, passed through so the grammar can apply the
			// truncation policy without knowing what any column measures.
			...(column.priority === undefined ? {} : { priority: column.priority }),
		})),
		rows: {
			kind: "inline",
			rows: all.map(row => {
				const record: Record<string, string> = {};
				for (const column of kept) {
					record[column.header] = renderCell(column, row, maxes.get(column.header) ?? 0, cellWidth, opts);
				}
				return record;
			}),
		},
	};
}

/** The largest value in each meter column, which is that column's one divisor. */
function columnMaxes(
	columns: readonly IRColumn[],
	rows: readonly DataRow[],
	opts: ScreenRenderOptions,
): ReadonlyMap<string, number> {
	const maxes = new Map<string, number>();
	for (const column of columns) {
		if (column.cell !== "meter") continue;
		let max = 0;
		for (const row of rows) {
			const value = resolveNumber(column.source, opts.data, row);
			if (value !== null && value > max) max = value;
		}
		maxes.set(column.header, max);
	}
	return maxes;
}
/**
 * How many cells a TABLE cell's meter bar occupies.
 *
 * The web's `.meter-cell .meter` is 64px beside a 13px figure (styles.css:
 * 1401-1403) — roughly three times the figure. A terminal cell is about as wide
 * as that figure, so 12 cells is the same proportion. It is a quarter of the
 * ranked list's own track on purpose: a cell bar ranks rows against each other,
 * while the ranked list IS the measurement.
 */
const METER_BAR_CELLS = 12;


function renderCell(
	column: IRColumn,
	row: DataRow,
	columnMax: number,
	cellWidth: number,
	opts: ScreenRenderOptions,
): string {

	switch (column.cell) {
		case "meter":
			return meterCell(column, resolveNumber(column.source, opts.data, row) ?? 0, columnMax, row, opts);
		case "sparkline":
			// The axis is threaded so a table sparkline is DENSE over it, matching
			// the web's `pivotSeries` rather than skipping the buckets a model was
			// idle for. A gap read as "no data" is a claim the payload does not make.
			return renderSparkline(
				resolveSeriesValues(column.source, opts.data, row, axisFor(opts, column.source)),
				{ width: cellWidth, preset: opts.preset, accent: cell => opts.fg(seriesHue(opts, 0), cell) },
			);
		case "badge":
			return badgeCell(column, row, opts);
		default:
			return formatValue(column.source, resolveCell(column.source, opts.data, row), row, opts);
	}
}

/**
 * A meter cell: the FIGURE, then a short bar beside it.
 *
 * This is the web's `MeterCell` (Table.tsx:189-209) translated: a
 * `<span class="num">{display}</span>` followed by a 64px `.meter`. The old
 * cell drew the bar ALONE across the whole column, which is why the reported
 * table showed `Requests` as a header over twelve yellow/white/grey blocks that
 * said nothing — the reader got a magnitude with no value and a header naming
 * a figure that was not on the page.
 *
 * The bar is bounded by {@link METER_BAR_CELLS}, a third of the ranked list's
 * track, because a cell bar is decoration for a figure that is already there:
 * its job is the ranking at a glance, not the measurement.
 *
 * Host parity: `/usage` tints each bar by quota status (`#miniBar` +
 * `#statusColor`, usage-dashboard.ts:617-629). The only status a column apex
 * can state honestly is "this is the most": a full bar is `caution`, a zero bar
 * is dim (measured none, not missing), everything between is plain. The tint
 * covers the FILL only, never the track — colouring the empties would tint the
 * gutter the figures align against.
 */
function meterCell(
	column: IRColumn,
	value: number,
	columnMax: number,
	row: DataRow,
	opts: ScreenRenderOptions,
): string {
	const fill = glyph(opts.preset, "barFill");
	const empty = glyph(opts.preset, "barEmpty");
	// The FIGURE comes first and is never dropped: it is the measurement, and a
	// magnitude column that shows only a bar has told the reader nothing.
	const figure = formatValue(column.source, value, row, opts);
	const track =
	columnMax <= 0
		? opts.fg("dim", empty.repeat(METER_BAR_CELLS))
		// The one-cell floor: a row that rendered nothing would be
		// indistinguishable from a row the query never returned, and this may be
		// the unpriced model the reader most needs to see.
		: (() => {
				const drawn = Math.max(
					value > 0 ? 1 : 0,
					Math.min(METER_BAR_CELLS, Math.round((value / columnMax) * METER_BAR_CELLS)),
				);
				const marks = fill.repeat(drawn) + empty.repeat(METER_BAR_CELLS - drawn);
				if (value <= 0) return opts.fg("dim", marks);
				if (value >= columnMax) return opts.fg(PALETTE.caution, marks);
				return marks;
			})();
	return figure === "" ? track : `${figure} ${track}`;
}

/**
 * A status badge. An error is `error`-coloured and says so; a clean row is
 * `success`-coloured and says `ok`.
 *
 * A null `errorMessage` on a request row is the MEASURED ABSENCE of a failure,
 * which is the one null in this panel that means good news rather than unknown.
 * That distinction is why a request's status reads "ok" and not "—".
 */
function badgeCell(column: IRColumn, row: DataRow, opts: ScreenRenderOptions): string {
	// The request log's Status is the host's `requestStatus`, not the raw
	// `errorMessage`: an aborted request carries no error and must not read
	// "failed". Aborted is `caution` — interrupted work, not a failure — and
	// only genuinely failed rows take `negative`.
	const statusValue = resolveCell(column.source, opts.data, row);
	if (leafFieldOf(column.source) === "stopReason" && typeof statusValue === "string") {
		if (statusValue === "aborted") return opts.fg(PALETTE.caution, "aborted");
		if (statusValue === "failed") return opts.fg(PALETTE.negative, "failed");
		return opts.fg(PALETTE.positive, "ok");
	}
	// A Status column keyed on `errorMessage` (the overview's Latest-requests
	// table) resolves an absent error to `null`, not `""` — and the `null` used
	// to fall through to the empty return, leaving a BLANK cell under a header
	// that names a column every row is supposed to fill. The web's
	// `requestStatus` (view-models.ts:325-328) treats a missing error as `ok`,
	// which is also the only honest reading: the payload WAS fetched and this
	// request did not fail.
	if (typeof statusValue === "string") {
		return statusValue === "" ? opts.fg(PALETTE.positive, "ok") : opts.fg(PALETTE.negative, "failed");
	}
	const figure = count(statusValue);
	if (figure === null) {
		// A numeric badge column whose value is absent. `stopReason` is the one
		// field where absence is a verdict rather than an unknown, so only it
		// claims `ok`; anything else has nothing to say and says nothing.
		return leafFieldOf(column.source) === "stopReason" ? opts.fg(PALETTE.positive, "ok") : "";
	}
	// A RATE is a percentage, and the test for "is this a rate" has to look at
	// the ref's NAME as well as its field. The defect: providers' Error rate is
	// a `derived` share, so `leafFieldOf` followed it down to `totalRequests`,
	// found no "rate" in that, and printed `formatInteger(0.0024)` = "0" — a
	// rate that reads as a clean zero while requests were failing.
	//
	// The NAME is the IR's own declaration of what the figure measures, so a
	// derived ref named `*Rate` is a rate regardless of which field it divides.
	const named = column.source.kind === "derived" ? column.source.name : "";
	if (/rate/i.test(named) || leafFieldOf(column.source).toLowerCase().includes("rate")) {
		return figure > 0 ? opts.fg(PALETTE.negative, errorRate(figure)) : opts.fg(PALETTE.positive, "none");
	}
	return figure > 0 ? opts.fg(PALETTE.negative, formatInteger(figure)) : opts.fg(PALETTE.positive, "none");
}

/** A table's rows in the order the IR asked for, never in payload order. */
function sortRows(
	rows: readonly DataRow[],
	rowSource: RowSource,
	opts: ScreenRenderOptions,
): readonly DataRow[] {
	const sort = rowSource.initialSort;
	if (!sort) return rows;
	const direction = sort.direction === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = resolveCell(sort.by, opts.data, a);
		const right = resolveCell(sort.by, opts.data, b);
		if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
		return String(left).localeCompare(String(right)) * direction;
	});
}

// ─── Legend ──────────────────────────────────────────────────────────────────

/**
 * A legend: one row per item, its share of a stated whole.
 *
 * A CONTINUATION of the chart above it rather than a band with a heading, which
 * is `band.ts`'s rule and the reason no blank line precedes it. Every item
 * resolving to nothing makes the band disappear rather than drawing a column of
 * `0.0%` that reads as a measurement.
 *
 * AND IT DISAPPEARS WHEN IT HAS NOTHING OF ITS OWN TO SAY. A legend exists
 * because most chart kinds CANNOT name their own series: `bars` writes each
 * series' label under its marks with nothing beside it saying how much that
 * series is of anything, so the shares have to live somewhere. A `shareBar` is
 * the opposite — every one of its rows is `label bar… pct figure`, the label
 * AND the share AND the figure, published (CostsRoute.tsx:284-318, the web's
 * `ComponentBreakdown` renders the same rows inside the card). A legend under
 * one repeats all four labels at all four percentages, which is what the costs
 * screen was doing: eight rows for four figures.
 *
 * So: a legend whose every item ADOPTED a share from a chart above is a second
 * rendering of that chart and is dropped. All-or-nothing, never per item —
 * `renderLegend` wears each swatch in its item index's hue, so dropping the
 * first four of Overview's seven would slide the three agent keys onto the
 * hues the shareBar already spent on the token kinds, and a key naming the
 * wrong series is worse than a repeated one. The exemption is the case that
 * makes the rule safe: Overview's legend names three agent rows its shareBar
 * has no series for, so it keeps all seven (`test/redundant-layout.test.ts`).
 */
function legendBand(
	items: readonly IRLegendItem[],
	opts: ScreenRenderOptions,
	published: readonly ReadonlyMap<string, number>[],
): Band | null {
	if (items.length === 0) return null;
	const measured = items.map(item => ({
		label: item.label,
		metric: item.metric,
		value: resolveNumber(item.metric, opts.data),
	}));

	// Chart-published items keep their shares. Agent-token items form their own
	// composition, independently of the input/cache/output token mix.
	const entries = measured.map(item => {
		const adopted = published.map(shares => shares.get(groupKeyOf(item.metric))).find(v => v !== undefined);
		return { label: item.label, metric: item.metric, value: item.value, share: adopted };
	});
	const own = sharesOf(entries.filter(entry => entry.share === undefined));
	// Every item published by a chart above => this band restates that chart.
	if (entries.length > 0 && entries.every(entry => entry.share !== undefined)) return null;
	return entries.some(entry => (entry.share ?? own.find(c => c.label === entry.label)?.share ?? 0) > 0)
		? {
				kind: "legend",
				items: entries.map(entry => ({
					label: entry.label,
					share: entry.share ?? own.find(candidate => candidate.label === entry.label)?.share ?? 0,
				})),
			}
		: null;
}

// ─── Measured helpers ────────────────────────────────────────────────────────

function padEndTo(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/**
 * Clamp to the inner width, measured in CELLS. Every cell here passed through a
 * formatter and some carry ANSI, so `.length` would be the wrong measure — and
 * one over-wide row overwrites the panel's right border.
 */
function clampLine(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}
