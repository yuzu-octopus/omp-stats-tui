/**
 * `src/layout/resolve.ts` — an IR value, made real.
 *
 * PROBE/TEST FIXTURE, NOT A PRODUCTION RENDER PATH. The ScreenSpec → renderScreen →
 * renderBands stack is live ONLY for /stats-test (its own showcase specs),
 * scripts/probe-render.ts, the panel's fixture branch, and tests — never a
 * production /stats-tui body.
 *
 * WHY THIS MODULE EXISTS. `MetricRef` is a DECLARATION: it names a value and
 * says nothing about how the value reads. That separation is what lets one
 * screen show a cost as a headline and another show the same cost as a table
 * cell without either hard-coding the other's choice. But a declaration that
 * nothing fulfils is a comment, so this module is where the declaration meets
 * a `PanelData` and produces a number or a string.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: a value that cannot be resolved is
 * `null`, never `undefined`, never `NaN`, never `"undefined"`. An unresolvable
 * ref produces a BLANK CELL, and a blank cell is invisible — the screen still
 * renders, still looks plausible, and the reader never learns a figure is
 * missing. That is the failure this project has already paid for once (the
 * no-catalog-card model reading `$0.00` for $935 of real spend). So the return
 * type carries `null` explicitly, every arithmetic path guards its divisor, and
 * `test/resolve.test.ts` walks EVERY ref in EVERY spec against a fixture shaped
 * like the real route response. An unresolvable ref is a test failure naming
 * the screen and the path, not a blank cell a human has to notice.
 *
 * `NEED_BY_SOURCE` decides fetchability, and it is the IR's own table rather
 * than a second one here. `explainUnresolved` uses it to say WHICH of three
 * very different failures it is looking at:
 *
 *   1. `providerStats` — no need fills it (its route does network I/O). A
 *      blank cell there is the honest answer: the panel never asks for it.
 *   2. the need was never fetched — a WIRING bug. `fetchFor` never asked, so
 *      "no data" here means "not asked", which is not the same as "nothing
 *      happened" and must not be painted as an empty range.
 *   3. the need was fetched and the payload is empty — the real, honest zero.
 *
 * PURE. No I/O, no theme, no database, no clock. Everything here is a function
 * of `(MetricRef, PanelData)` plus an optional row scope, which is what makes it
 * testable without a terminal and without a 321 MB database.
 */

import { modelKey } from "@oh-my-pi/omp-stats/client/data/colors";

import type { DataNeed, PanelData } from "../data/api";
import { hostDerived, normalizedErrorGroups } from "./host-derived";
import {
	NEED_BY_SOURCE,
	sourceOf,
	type AggregateRef,
	type DerivedRef,
	type LabelRef,
	type MetricRef,
	type MetricSource,
	type SeriesRef,
} from "./spec";

/** A payload row. Heterogeneous by nature — the IR names fields by string, so a
 *  row is only ever read through {@link readPath}, never indexed directly. */
export type DataRow = object;

/** Every kind of ref, minus the derived wrapper. What a resolution bottoms out in. */
export type BaseRef = AggregateRef | SeriesRef | LabelRef;

/**
 * What a ref resolves to. `null` means ABSENT, and it is a distinct case from
 * every other value on purpose:
 *
 *  - `null` is never rendered as text. `resolveCell` returns it, the caller
 *    emits an empty cell, and `explainUnresolved` explains why.
 *  - `0` is a MEASURED value and is rendered as `0`.
 *
 * Conflating them is how an unmeasured model reads as a free one.
 */
export type Resolved = number | string | null;

// ─── Reading the payload ─────────────────────────────────────────────────────

/**
 * Every row a source carries, or `[]`.
 *
 * ONE ROW ARRAY PER SOURCE, ALWAYS. `overall` and `rollupStatus` are single
 * objects, and every array source may be empty; normalising both to a list is
 * what lets `resolveNumber` and friends share one code path instead of a branch
 * per source shape. An absent payload is `[]` and NOT an exception — the panel
 * reaches this with a database that was never initialised, and a throw here
 * would blank the whole panel rather than one cell.
 */
export function rowsFor(source: MetricSource, data: PanelData): readonly DataRow[] {
	switch (source) {
		case "overall":
		case "rollupStatus":
			return singleRow(payloadFor(source, data));
		case "byAgentType":
		case "timeSeries":
			return asRows(data.overview?.[source === "byAgentType" ? "byAgentType" : "timeSeries"]);
		case "byModel":
		case "modelSeries":
		case "modelPerformanceSeries":
			return asRows(data.modelDashboard?.[source]);
		case "costSeries":
			return asRows(data.costs?.costSeries);
		case "folders":
			return asRows(data.folders);
		case "recentMessages":
			return asRows(data.recent);
		case "errorMessages":
			return asRows(data.errors);
		case "errorGroups":
			return normalizedErrorGroups(asRows(data.errors)).map(group => ({
				...group,
				modelLabels: group.models.map(model => modelKey(model.model, model.provider)).join(", "),
			}));
		case "errorModels": {
			const models = new Map<string, { model: string; provider: string; count: number }>();
			for (const group of normalizedErrorGroups(asRows(data.errors))) {
				for (const model of group.models) {
					const key = modelKey(model.model, model.provider);
					const current = models.get(key);
					if (current) current.count += model.count;
					else models.set(key, { ...model });
				}
			}
			return [...models.values()];
		}
		case "toolsByTool":
			return asRows(data.tools?.byTool);
		case "toolsByToolModel":
			return asRows(data.tools?.byToolModel);
		case "toolsSeries":
			return asRows(data.tools?.series);
		case "dailyActivity":
			return asRows(data.dailyActivity);
		case "providerStats":
			return asRows(data.providers?.providers);
		case "gainOverall":
			return singleRow(data.gain?.overall as DataRow | undefined);
		case "gainBySource":
			return Object.entries(data.gain?.bySource ?? {}).map(([source, totals]) => ({ source, ...(totals as object) }));
		case "gainSeries":
			return asRows(data.gain?.timeSeries);
	}
}

/** The payload a single-object source carries, or `undefined`. */
function payloadFor(source: MetricSource, data: PanelData): DataRow | undefined {
	if (source === "overall") return data.overview?.overall as DataRow | undefined;
	if (source === "rollupStatus") return data.rollupStatus as DataRow | undefined;
	return undefined;
}

/** One object becomes a one-element list; an absent value becomes an empty list. */
function singleRow(row: DataRow | undefined): readonly DataRow[] {
	return row ? [row] : [];
}

function asRows(value: readonly unknown[] | undefined): readonly DataRow[] {
	return Array.isArray(value) ? (value as readonly DataRow[]) : [];
}

// ─── Fetchability ────────────────────────────────────────────────────────────

/**
 * Which fetch fills this ref, or `null` when nothing can.
 *
 * Delegates to `NEED_BY_SOURCE` rather than restating it, so a source added to
 * the IR's table is fetchable here the moment it lands. `providerStats` reads
 * the DB-backed `/api/stats/providers` aggregates; the network-only windows
 * payload has no source because the panel never fetches it.
 */
export function metricNeed(ref: MetricRef): DataNeed | null {
	return NEED_BY_SOURCE[sourceOf(ref)] ?? null;
}

/**
 * Did the panel actually ask for this source?
 *
 * The distinction the panel's correctness rests on. A source that was never
 * fetched means `fetchFor` never issued the query — a wiring bug, which must
 * be reported rather than painted as an empty range. A source that WAS fetched
 * and came back empty means nothing happened in the window, which is a real
 * answer. Both look identical to `rowsFor`, and only this function can tell
 * them apart.
 */
export function isFetched(source: MetricSource, data: PanelData): boolean {
	const need = NEED_BY_SOURCE[source];
	if (need === null) return false;
	switch (need) {
		case "overview":
			return data.overview !== undefined;
		case "modelDashboard":
			return data.modelDashboard !== undefined;
		case "costs":
			return data.costs !== undefined;
		case "folders":
			return data.folders !== undefined;
		case "recent":
			return data.recent !== undefined;
		case "errors":
			return data.errors !== undefined;
		case "tools":
			return data.tools !== undefined;
		case "providers":
			return data.providers !== undefined;
		case "gain":
			return data.gain !== undefined;
		case "dailyActivity":
			return data.dailyActivity !== undefined;
		case "rollupStatus":
			return data.rollupStatus !== undefined;
	}
}

/**
 * Why a ref could not be resolved, in one clause. `""` when it DID resolve, so
 * a caller can accumulate failures by filtering on emptiness.
 *
 * Exported because the only way to hold a resolver to "no invisible blanks" is
 * to make the reason printable, and `test/resolve.test.ts` prints it in every
 * failure message. A blank cell with no stated cause is exactly the bug.
 */
export function explainUnresolved(ref: MetricRef, data: PanelData, row?: DataRow): string {
	if (resolveCell(ref, data, row) !== null) return "";
	const source = sourceOf(ref);
	if (NEED_BY_SOURCE[source] === null) {
		return `source "${source}" has no DataNeed — ${NEED_BY_SOURCE[source] === null ? "its route does network I/O" : ""}`;
	}
	if (!isFetched(source, data)) {
		return `source "${source}" is mapped to need "${NEED_BY_SOURCE[source]}" but that payload is absent from PanelData — not fetched`;
	}
	return `source "${source}" was fetched and is empty — nothing recorded for "${leafField(ref)}"`;
}

/** The field a ref bottoms out in, following `derived` to its base. */
function leafField(ref: MetricRef): string {
	return ref.kind === "derived" ? leafField(ref.of) : ref.field;
}

/** The innermost non-derived ref: what the arithmetic actually operates on. */
function baseOf(ref: MetricRef): BaseRef {
	return ref.kind === "derived" ? baseOf(ref.of) : ref;
}

// ─── Reading a field ─────────────────────────────────────────────────────────

/**
 * A dotted path into a row. `"usage.cost.total"` is legal, and every segment
 * after the first is the IR's own promise about the payload's shape.
 *
 * Returns `undefined` for a missing segment rather than throwing: a field the
 * payload does not have is a spec/payload disagreement, and the caller's job
 * is to report it, not to crash a render pass over it.
 */
function readPath(row: DataRow | undefined, path: string): unknown {
	if (row === undefined || row === null) return undefined;
	let node: unknown = row;
	for (const key of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

/** A finite number, or `null`. `NaN` and `Infinity` are failures, not values. */
function asNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return value;
}

/** Non-empty text, or `null`. A numeric field read as a label is `null`. */
function asLabel(value: unknown): string | null {
	if (typeof value !== "string" || value === "") return null;
	return value;
}

// ─── Base resolution ─────────────────────────────────────────────────────────

/**
 * The value of a non-derived ref.
 *
 * `AggregateRef` and `LabelRef` read ONE row: the first when unscoped, the
 * supplied one when the caller is inside a table. `SeriesRef` is a DIFFERENT
 * KIND of answer — a whole series, not a figure — so it resolves through
 * {@link resolveSeriesValues} and sums to a scalar here. That asymmetry is the
 * IR's own: a table cell reads a cell, a stat tile needs a number.
 */
function resolveBase(ref: BaseRef, data: PanelData, row?: DataRow): Resolved {
	const rows = row !== undefined ? [row] : rowsFor(ref.source, data);

	if (ref.kind === "series") {
		// A `SeriesRef` resolved to a scalar is its TOTAL. A stat tile reading
		// `timeSeries("cost")` means "cost over the window"; the per-bucket values
		// belong to {@link resolveSeriesValues}.
		const values = seriesValues(ref, data, row);
		return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
	}

	const value = readPath(rows[0], ref.field);
	if (ref.kind === "label") return asLabel(value);
	// `aggregate` does NOT insist on a number. The IR names text fields with it
	// (`recentMessages.model`, `recentMessages.provider`) while `label` names the
	// same idea elsewhere, and a resolver answering `null` for a field that plainly
	// holds a model name would paint a blank cell for a value it has. Arithmetic
	// callers narrow through {@link resolveNumber}, the only place the
	// number-vs-text distinction actually matters.
	return asNumber(value) ?? asLabel(value);
}

/** The rows a grouped `SeriesRef` covers, narrowed to `row`'s own group. */
function seriesRows(ref: SeriesRef, data: PanelData, row?: DataRow): readonly DataRow[] {
	const rows = rowsFor(ref.source, data);
	if (!ref.groupBy || row === undefined) return rows;
	const group = seriesGroup(row, ref.groupBy);
	if (group === null) return [];
	return rows.filter(candidate => seriesGroup(candidate, ref.groupBy!) === group);
}

/** The upstream model identity includes its provider, including in row trends. */
function seriesGroup(row: DataRow, field: NonNullable<SeriesRef["groupBy"]>): string | null {
	const value = readPath(row, field);
	if (typeof value !== "string") return null;
	if (field !== "model") return value;
	const provider = readPath(row, "provider");
	return modelKey(value, typeof provider === "string" ? provider : "");
}

/**
 * One field read per row, SPARSE — the buckets that have rows, in payload order.
 *
 * Sparse on purpose, and the reason is now narrow: without an axis there is
 * nothing to place a gap against. Callers holding a bucket axis pass one to
 * {@link resolveSeriesValues}, which densifies; callers that do not get exactly
 * the rows the payload reported, which is the contract that has always held.
 */
function seriesValues(ref: SeriesRef, data: PanelData, row?: DataRow): readonly number[] {
	const values: number[] = [];
	const isSucceeded = ref.field === "succeededRequests" && ref.source === "timeSeries";
	for (const candidate of seriesRows(ref, data, row)) {
		if (isSucceeded) {
			const requests = asNumber(readPath(candidate, "requests"));
			const errors = asNumber(readPath(candidate, "errors"));
			if (requests !== null && errors !== null) values.push(requests - errors);
			continue;
		}
		const value = asNumber(readPath(candidate, ref.field));
		if (value !== null) values.push(value);
	}
	return values;
}

/**
 * One field read per row, DENSE over `axis`: one value per bucket, oldest
 * first, and a bucket with no rows reads 0.
 *
 * This is the web's `pivotSeries` (`series.ts:41-79`) with the folding and
 * ranking left off, and it is what a plottable series actually needs. The payload
 * carries one row per (bucket, model) that HAS data — `getModelTimeSeries` groups
 * `BY 1, f.model, f.provider` and emits no row for a bucket where a model was
 * idle (`rollup.ts:670-676`) — so a sparse model arrives as `[5, 7]` for a
 * three-bucket axis, and `[5, 0, 7]` once placed against it.
 *
 * THE DIFFERENCE IS THE X-AXIS. A value is only a position if it knows its
 * bucket. Skip the gap and the second value slides one column left, so the
 * chart's x-axis becomes an array index and a resize re-maps every point. That
 * is why the axis is a parameter rather than something this function guesses.
 *
 * Rows are FILTERED FIRST (`seriesRows`) and the survivors densified, so a
 * row-scoped series stays that row's own trend. Several rows in one bucket SUM,
 * which is `densify`'s rule and the host's own behaviour.
 */
function denseSeriesValues(
	ref: SeriesRef,
	axis: readonly number[],
	data: PanelData,
	row?: DataRow,
): readonly number[] {
	const index = new Map<number, number>();
	for (const [position, timestamp] of axis.entries()) index.set(timestamp, position);
	const isSucceeded = ref.field === "succeededRequests" && ref.source === "timeSeries";
	const out = Array.from({ length: axis.length }, () => 0);
	for (const candidate of seriesRows(ref, data, row)) {
		const timestamp = asNumber(readPath(candidate, "timestamp"));
		if (timestamp === null) continue;
		const position = index.get(timestamp);
		// A row outside the axis is DROPPED, not appended: the axis is the window,
		// and a value past its edge has no column to occupy.
		if (position === undefined) continue;
		if (isSucceeded) {
			const requests = asNumber(readPath(candidate, "requests"));
			const errors = asNumber(readPath(candidate, "errors"));
			if (requests !== null && errors !== null) out[position] += requests - errors;
			continue;
		}
		const value = asNumber(readPath(candidate, ref.field));
		if (value !== null) out[position] += value;
	}
	return out;
}

// ─── Derived resolution ───────────────────────────────────────────────────────

/**
 * A derived value: the four generic ops the IR names, each with its own guard,
 * plus the HOST-DERIVED figures the dashboard computes itself.
 *
 * Every divisor is checked and every empty source answers 0. Those two guards
 * are the whole reason the ops live in a `switch` rather than four one-line
 * expressions: `0 / 0` is `NaN`, `NaN` prints as the literal text `NaN` inside
 * a stat tile, and a stat tile reading `NaN%` is a bug a user reports rather
 * than one a test catches later.
 *
 * The return is `number | string | null` because a derived figure is not always
 * a QUANTITY: "Top model" names a row. `resolveCell` is already typed that way
 * and `resolveNumber` narrows it, so widening here costs the callers nothing
 * and saves a second ref kind for the same answer.
 */
function resolveDerived(ref: DerivedRef, data: PanelData, row?: DataRow): Resolved {
	const base = baseOf(ref);
	// `conversationTokens` is the one derived that sums FOUR token kinds rather
	// than the two its `of`/`against` name, because the IR declares it by name
	// and the header comment in spec.ts states what it means: uncached input +
	// cache reads + cache writes + output. A single "total tokens" figure is
	// 95.5% cache reads in this database and describes nothing.
	if (ref.name === "conversationTokens") return sumTokenKinds(base, data, row);

	// `succeededRequests` is the one derived that SUBTRACTS rather than sums:
	// the web's Succeeded bar is `densify(p => p.requests - p.errors)` per
	// bucket (OverviewRoute.tsx:77), so the total is requests minus errors over
	// the same rows. Summing `requests` alone would double-count the failures.
	if (ref.name === "succeededRequests" && base.source === "timeSeries") {
		const rows = row !== undefined ? [row] : rowsFor(base.source, data);
		if (rows.length === 0 && !isFetched(base.source, data)) return null;
		let total = 0;
		let seen = false;
		for (const candidate of rows) {
			const requests = asNumber(readPath(candidate, "requests"));
			const errors = asNumber(readPath(candidate, "errors"));
			if (requests === null || errors === null) continue;
			total += requests - errors;
			seen = true;
		}
		return seen ? total : null;
	}

	// A HOST-DERIVED figure is not one of these four ops pointed at the wrong
	// question — it is a DIFFERENT question, answered by the function the
	// dashboard itself calls. `host-derived.ts` lists the six and, for each, what
	// the generic ops would have got wrong instead.
	const host = hostDerived(ref.name);
	if (host) {
		const fetched = isFetched(base.source, data);
		const rows = row !== undefined ? [row] : rowsFor(base.source, data);
		// The same absence rule as `sum`/`count`/`max`: a figure over a payload
		// nobody FETCHED is absent, never a zero.
		if (rows.length === 0 && !fetched) return null;
		return host.compute(rows, { data, fetched });
	}

	switch (ref.op) {
		case "sum":
			// A `sum` is a sum ACROSS ROWS. Its base is an `AggregateRef`, which on
			// its own reads only the FIRST row, so resolving the base directly would
			// answer "total cost across every model" with the first model's cost —
			// the one figure a per-model table is least able to detect.
			return sumOverRows(baseOf(ref.of), data, row);
		case "count": {
			const rows = row !== undefined ? [row] : rowsFor(base.source, data);
			// Same rule as `sum`: a count over a source nobody FETCHED is ABSENT.
			// "Models used 0" is a claim about the database, and the database was
			// never asked.
			if (rows.length === 0 && row === undefined && !isFetched(base.source, data)) return null;
			return distinctCount(base, rows);
		}
		case "share": {
			if (!ref.against) return null;
			const numerator = resolveNumber(ref.of, data, row);
			// `againstScope: "total"` divides by the GRAND total: a table Share
			// column divides the row by the screen total. The default is the
			// row's own scope, which is what per-row rates (a tool's Result /
			// call, a provider's Error rate) divide by — resolving those
			// against the grand total would make every row a fraction of
			// everything instead of its own rate.
			const denominator =
				ref.againstScope === "total"
					? resolveNumber(ref.against, data)
					: resolveNumber(ref.against, data, row);
			if (numerator === null || denominator === null) return null;
			// A measured zero denominator is 0, never Infinity. Every call failing
			// at once is "no calls happened", which is 0% and not a crash.
			return denominator === 0 ? 0 : numerator / denominator;
		}
		case "max": {
			// Same rule as `sum` and `count`: a maximum over a source nobody
			// FETCHED is ABSENT. A peak of $0 across a database that was never
			// queried is a claim, not a measurement.
			const peak = baseOf(ref.of);
			if (peak.kind !== "series") return resolveNumber(ref.of, data, row);
			const values = seriesValues(peak, data, row);
			if (values.length === 0) return isFetched(peak.source, data) ? 0 : null;
			return Math.max(...values);
		}
	}
}

/**
 * HOW MANY DISTINCT things a base ref names — the `count` op's whole meaning.
 *
 * Distinctness is NOT "distinct raw strings", and that distinction is the whole
 * reason this is its own function. Two fields need the HOST's own notion:
 *
 *  - `errorMessages.errorMessage` counts SIGNATURES. Two failures differing only
 *    by a request id and a retry count are one failure to a reader, and counting
 *    the raw strings overstates it by however many ids that failure carried. The
 *    host's `groupErrorsBySignature` is the definition — a second regex pipeline
 *    here would drift from the dashboard the moment either side changed.
 *  - `errorMessages.model` counts model::PROVIDER. One model served by two
 *    providers is two things as far as a per-provider table is concerned, and
 *    `modelKey` is the host's name for that identity.
 *
 * Everything else counts distinct raw values, which is what "distinct tools" and
 * "folders" mean.
 */
function distinctCount(base: BaseRef, rows: readonly DataRow[]): number {
	const field = base.field;

	// A NUMERIC field names no distinct things — "count byModel.totalRequests" is
	// the number of models, and counting distinct request TOTALS would collapse
	// every model that served the same number of requests into one. So a
	// non-label base counts ROWS.
	if (base.kind !== "label") {
		if (base.source === "errorMessages" && field === "model") {
			// The one numeric case that is genuinely not a row count: "affected
			// models" is the number of model::provider identities behind the
			// failures, and one model behind two providers is two of them.
			const seen = new Set<string>();
			for (const row of rows) {
				const model = asLabel(readPath(row, "model"));
				if (model === null) continue;
				seen.add(modelKey(model, asLabel(readPath(row, "provider")) ?? ""));
			}
			return seen.size;
		}
		return rows.length;
	}

	if (base.source === "errorMessages" && field === "errorMessage") {
		return normalizedErrorGroups(rows).length;
	}
	const seen = new Set<string>();
	for (const row of rows) {
		const value = asLabel(readPath(row, field));
		if (value !== null) seen.add(value);
	}
	return seen.size;
}

/**
 * One field, added up over every row of its source (or over `row` alone when
 * the caller is inside a table and means that row's own figure).
 */
function sumOverRows(base: BaseRef, data: PanelData, row?: DataRow): number | null {
	const rows = row !== undefined ? [row] : rowsFor(base.source, data);
	// A sum over NO ROWS is ABSENT, not zero — unless the source was genuinely
	// fetched and came back empty, which is a measured zero. The difference is
	// the whole silent-empty trap: a dashboard that prints "$0" for a query
	// nobody issued is claiming a free month, and only `isFetched` can tell the
	// two apart. `count` is the op that legitimately answers zero.
	if (rows.length === 0 && !isFetched(base.source, data)) return null;
	let total = 0;
	for (const candidate of rows) {
		const value = asNumber(readPath(candidate, base.field));
		if (value !== null) total += value;
	}
	return total;
}

/** input + cacheRead + cacheWrite + output, off one row of the base's source. */
function sumTokenKinds(base: BaseRef, data: PanelData, row?: DataRow): number | null {
	const rows = row !== undefined ? [row] : rowsFor(base.source, data);
	let total = 0;
	let seen = false;
	for (const candidate of rows) {
		for (const field of [
			"totalInputTokens",
			"totalCacheReadTokens",
			"totalCacheWriteTokens",
			"totalOutputTokens",
		]) {
			const value = asNumber(readPath(candidate, field));
			if (value !== null) {
				total += value;
				seen = true;
			}
		}
	}
	return seen ? total : null;
}

// ─── The public surface ──────────────────────────────────────────────────────

/**
 * Resolve a ref to a figure. `null` when absent — never `undefined`, never
 * `NaN`. A `LabelRef` resolves to text, so this returns `string` for one.
 */
export function resolveCell(ref: MetricRef, data: PanelData, row?: DataRow): Resolved {
	if (ref.kind === "derived") return resolveDerived(ref, data, row);
	return resolveBase(ref, data, row);
}

/** Resolve to a NUMBER, or `null`. A ref that names text is not a number. */
export function resolveNumber(ref: MetricRef, data: PanelData, row?: DataRow): number | null {
	const value = resolveCell(ref, data, row);
	return typeof value === "number" ? value : null;
}

/** Resolve to TEXT, or `null`. Used for "Most used" and "Top model". */
export function resolveLabel(ref: MetricRef, data: PanelData, row?: DataRow): string | null {
	const value = resolveCell(ref, data, row);
	return typeof value === "string" ? value : null;
}

/**
 * A ref's values as a plottable series, oldest bucket first.
 *
 * This is the ONLY path into a chart, which is what keeps charts honest: they
 * cannot invent a bucket, and a source with no rows yields `[]` rather than an
 * array of zeroes that would draw a flat "nothing happened" chart when the
 * truth is "nothing was fetched".
 *
 * `opts.axis` is what makes a value a POSITION. With it the series is DENSE:
 * one entry per bucket, gaps 0, the same length for every series so two
 * sparklines in one table line up column for column — which is what the web gets
 * from `pivotSeries`. Without it the series is the buckets that carry rows,
 * which is only safe for a caller drawing values positionally for something
 * other than time.
 *
 * The axis is passed in rather than derived here because deriving it needs the
 * range and the clock, and this module is pure. `screen.ts` builds it once from
 * the host's own `bucketAxis` and passes it down — ONE axis rule, not two that
 * agree today.
 */
export interface SeriesAxisOptions {
	/** Ascending bucket starts. Every value in the result sits on one of these. */
	axis: readonly number[];
}

export function resolveSeriesValues(
	ref: MetricRef,
	data: PanelData,
	row?: DataRow,
	opts?: SeriesAxisOptions,
): readonly number[] {
	const base = baseOf(ref);
	if (base.kind === "series") {
		return opts ? denseSeriesValues(base, opts.axis, data, row) : seriesValues(base, data, row);
	}
	// An aggregate or a derived total has no shape to plot; its single value is
	// the whole series. An axis does not apply: there is one point, and padding
	// it to the axis's length would draw a flat line for a single figure.
	const value = resolveNumber(ref, data, row);
	return value === null ? [] : [value];
}

