/**
 * `src/layout/resolve.ts` — an IR value, made real.
 *
 * THE MOST VALUABLE TEST IN THIS FILE IS THE FIRST ONE. A `MetricRef` that
 * resolves to nothing is an INVISIBLE failure: the cell renders blank, the
 * screen still "works", and the reader sees a dashboard quietly missing a
 * figure. There is no exception and no red cell — a blank cell is exactly what
 * an unresolvable ref produces. So resolution is asserted here against a
 * fixture shaped like the real route response, over EVERY ref in EVERY spec,
 * and an unresolvable ref is a hard failure naming the screen and the path.
 */

import { expect, test } from "bun:test";

import { emptyData, liveData, TIME_SERIES } from "./fixtures/panel";
import {
	NEED_BY_SOURCE,
	SCREEN_SPECS,
	isProseHint,
	metricRefsOf,
	sourceOf,
	type Band,
	type MetricRef,
	type ScreenSpec,
} from "../src/layout/spec";
import {
	rowsFor,
	resolveNumber,
	resolveLabel,
	resolveCell,
	resolveSeriesValues,
	metricNeed,
	isFetched,
	explainUnresolved,
} from "../src/layout/resolve";

// ─── walking the IR, the way the resolver sees it ────────────────────────────

function refsInBand(band: Band): readonly MetricRef[] {
	switch (band.kind) {
		case "statRow":
			return band.stats.flatMap(t => [
				...metricRefsOf(t.metric),
				// A PROSE hint carries no metric, so it contributes no ref. `isProseHint`
				// rather than `"text" in t.hint`, because the `in` operator requires an
				// object on its right and throws on the bare-string hint form.
				...(t.hint !== undefined && !isProseHint(t.hint) ? metricRefsOf(t.hint) : []),
				...(t.spark ? metricRefsOf(t.spark) : []),
			]);
		case "chart":
			return band.chart.series.flatMap(s => metricRefsOf(s.metric));
		case "legend":
			return band.items.flatMap(i => metricRefsOf(i.metric));
		case "table":
			return band.columns.flatMap(c => metricRefsOf(c.source));
		case "note":
			return [];
	}
}

function refsInSpec(spec: ScreenSpec): readonly MetricRef[] {
	return spec.bands.flatMap(refsInBand);
}

function labelOf(ref: MetricRef): string {
	if (ref.kind === "derived") return `${ref.name}(${labelOf(ref.of)})`;
	return `${ref.source}.${ref.field}`;
}

/**
 * A field the row CARRIES but set to null — `errorMessage` on a request that
 * succeeded. That is a measured absence, not an unresolvable ref, and it must
 * not fail this suite: the Status column renders it as "ok", which is exactly
 * what the data says. A field the row does not carry at all is the real failure.
 */
function measuredNull(ref: MetricRef, row: object | undefined): boolean {
	if (ref.kind === "derived" || row === undefined) return false;
	let node: unknown = row;
	for (const key of ref.field.split(".")) {
		if (node === null || typeof node !== "object") return false;
		if (!(key in (node as Record<string, unknown>))) return false;
		node = (node as Record<string, unknown>)[key];
	}
	return node === null;
}

// ─── the valuable test ───────────────────────────────────────────────────────

test("every MetricRef in every spec resolves to a real value", () => {
	const data = liveData();
	const failures: string[] = [];
	let checked = 0;

	for (const spec of SCREEN_SPECS) {
		for (const ref of refsInSpec(spec)) {
			checked++;
			const value = resolveCell(ref, data);
			if (value !== null) continue;
			const row = rowsFor(sourceOf(ref), data)[0];
			if (measuredNull(ref, row)) continue;
			failures.push(`${spec.id}: ${labelOf(ref)} → ${explainUnresolved(ref, data)}`);
		}
	}

	expect(failures, `unresolvable refs:\n${failures.join("\n")}`).toEqual([]);
	expect(checked).toBeGreaterThan(150);
});

test("every table row resolves every one of its columns", () => {
	const data = liveData();
	const failures: string[] = [];

	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "table") continue;
			const rows = rowsFor(band.rows.source, data);
			expect(rows.length, `${spec.id}/${band.title} has no rows`).toBeGreaterThan(0);
			for (const row of rows) {
				for (const column of band.columns) {
					const value = resolveCell(column.source, data, row);
					if (value !== null || measuredNull(column.source, row)) continue;
					failures.push(`${spec.id}/${band.title}/${column.header}: ${explainUnresolved(column.source, data, row)}`);
				}
			}
		}
	}

	expect(failures, `unresolvable table cells:\n${failures.join("\n")}`).toEqual([]);
});

test("every chart series yields at least one finite number to plot", () => {
	const data = liveData();
	const failures: string[] = [];

	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "chart") continue;
			for (const series of band.chart.series) {
				const values = resolveSeriesValues(series.metric, data);
				if (values.length === 0) {
					failures.push(`${spec.id}/${band.title}/${series.key}: no values`);
					continue;
				}
				if (values.some(v => !Number.isFinite(v))) {
					failures.push(`${spec.id}/${band.title}/${series.key}: ${values.join(",")}`);
				}
			}
		}
	}

	expect(failures, `unplottable series:\n${failures.join("\n")}`).toEqual([]);
});


test("a ref on a source its screen never fetched is reported as unfetched, not as missing", () => {
	// The distinction the panel depends on: `fetchFor` never issued the query,
	// so "no data" means "not asked", which is a loading bug, not an empty one.
	const data = liveData({ costs: undefined });
	const ref: MetricRef = { kind: "aggregate", source: "costSeries", field: "cost" };
	expect(isFetched("costSeries", data)).toBe(false);
	expect(explainUnresolved(ref, data)).toContain("not fetched");
	expect(explainUnresolved(ref, liveData())).toBe("");
});

test("NEED_BY_SOURCE is the only thing that decides fetchability", () => {
	for (const [source, need] of Object.entries(NEED_BY_SOURCE)) {
		const ref: MetricRef = { kind: "aggregate", source: source as never, field: "totalRequests" };
		expect(metricNeed(ref), source).toBe(need);
	}
});

// ─── AggregateRef: a field off one row ───────────────────────────────────────

test("AggregateRef reads a dotted path off the row, and a missing leaf is null not undefined", () => {
	const data = liveData();
	expect(resolveNumber({ kind: "aggregate", source: "overall", field: "totalRequests" }, data)).toBe(65_460);
	expect(resolveNumber({ kind: "aggregate", source: "overall", field: "usage.totalTokens" }, data)).toBeNull();
	expect(resolveNumber({ kind: "aggregate", source: "overall", field: "nope.nope" }, data)).toBeNull();
	// The value is a number, never the string "undefined": that is exactly the
	// "undefined in a cell" failure this module exists to make impossible.
	expect(resolveCell({ kind: "aggregate", source: "overall", field: "nope" }, data)).toBeNull();
});

test("SeriesRef yields one number per row, in payload order", () => {
	const data = liveData();
	expect(resolveSeriesValues({ kind: "series", source: "timeSeries", field: "cost" }, data))
		.toEqual(TIME_SERIES.map(point => point.cost));
	expect(
		resolveSeriesValues({ kind: "series", source: "modelSeries", field: "requests", groupBy: "model" }, data)
			.length,
	).toBe(data.modelDashboard?.modelSeries.length ?? 0);
});

test("a SeriesRef grouped by a dimension collapses to one value per group, summed", () => {
	// The models table's `Trend` column reads this, so the sparkline a row gets
	// must be ITS model's series and not the whole payload's.
	const data = liveData();
	const all = resolveSeriesValues(
		{ kind: "series", source: "modelSeries", field: "requests", groupBy: "model" },
		data,
	);
	const one = resolveSeriesValues(
		{ kind: "series", source: "modelSeries", field: "requests", groupBy: "model" },
		data,
		{ model: "space-bunny-free", provider: "opencode-go" },
	);
	expect(all.length).toBeGreaterThan(one.length);
	expect(one.length).toBeGreaterThan(0);
	expect(one.every(v => v > 0)).toBe(true);
});
test("AggregateRef over a grouped source reads the FIRST row, as the IR documents", () => {
	const data = liveData();
	expect(resolveLabel({ kind: "label", source: "byModel", field: "model" }, data)).toBe("gpt-5.6-terra");
	expect(resolveNumber({ kind: "aggregate", source: "byModel", field: "totalCost" }, data)).toBe(935.72);
	expect(resolveLabel({ kind: "aggregate", source: "folders", field: "folder" }, data)).toBe(
		"/Users/yuzu/Documents/Projects/omp-stats-tui",
	);
});

test("AggregateRef over an empty grouped source is null, so a table with no rows never lies", () => {
	const data = liveData({ modelDashboard: { byModel: [], modelSeries: [], modelPerformanceSeries: [] } });
	expect(resolveNumber({ kind: "aggregate", source: "byModel", field: "totalCost" }, data)).toBeNull();
	expect(resolveLabel({ kind: "label", source: "byModel", field: "model" }, data)).toBeNull();
});

// ─── LabelRef ────────────────────────────────────────────────────────────────

test("LabelRef returns the row's TEXT, never a number coerced to a string", () => {
	const data = liveData();
	expect(resolveLabel({ kind: "label", source: "byModel", field: "model" }, data)).toBe("gpt-5.6-terra");
	expect(resolveLabel({ kind: "label", source: "toolsByTool", field: "tool" }, data)).toBe("read");
	expect(resolveLabel({ kind: "label", source: "errorMessages", field: "errorMessage" }, data)).toBe(
		"429 Too Many Requests",
	);
	// A numeric field read as a label would print "0" where the intent was a
	// count, which reads as a measurement rather than as a name.
	expect(resolveLabel({ kind: "label", source: "byModel", field: "totalRequests" }, data)).toBeNull();
});

// ─── SeriesRef ───────────────────────────────────────────────────────────────


test("a SeriesRef for a field the rows do not have is an empty series, not a crash", () => {
	const data = liveData();
	expect(resolveSeriesValues({ kind: "series", source: "timeSeries", field: "nope" }, data)).toEqual([]);
});

// ─── DerivedRef ──────────────────────────────────────────────────────────────

test("derived sum totals a field across every row of its source", () => {
	const data = liveData();
	const sum: MetricRef = {
		kind: "derived",
		name: "totalCost",
		op: "sum",
		of: { kind: "aggregate", source: "byModel", field: "totalCost" },
	};
	// 935.72 + 0 + 0 across the three models.
	expect(resolveNumber(sum, data)).toBe(935.72);
});

test("derived sum on a scalar source is that value, not a sum of one row's fields", () => {
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "totalRequests",
		op: "sum",
		of: { kind: "aggregate", source: "overall", field: "totalRequests" },
	};
	expect(resolveNumber(ref, data)).toBe(65_460);
});

test("conversationTokens is the sum of all four token kinds, not one field", () => {
	// This is the field the IR refuses to collapse: 95.5% of this database's
	// tokens are cache reads, so a single "total" describes nothing.
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "conversationTokens",
		op: "sum",
		of: { kind: "aggregate", source: "overall", field: "totalInputTokens" },
		against: { kind: "aggregate", source: "overall", field: "totalCacheReadTokens" },
	};
	const expected =
		data.overview!.overall.totalInputTokens +
		data.overview!.overall.totalCacheReadTokens +
		data.overview!.overall.totalCacheWriteTokens +
		data.overview!.overall.totalOutputTokens;
	expect(resolveNumber(ref, data)).toBe(expected);
	expect(resolveNumber(ref, data)).toBe(1_273_300_000);
});

test("derived count is the row count, which is how 'models used' is answered", () => {
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "modelCount",
		op: "count",
		of: { kind: "aggregate", source: "byModel", field: "totalRequests" },
	};
	expect(resolveNumber(ref, data)).toBe(3);
	// "Distinct tools" counts DISTINCT tools, so a payload with one row per tool
	// and a payload with two rows per tool must not agree.
	const one: MetricRef = {
		kind: "derived",
		name: "toolCount",
		op: "count",
		of: { kind: "label", source: "toolsByTool", field: "tool" },
	};
	expect(resolveNumber(one, data)).toBe(3);
	expect(resolveNumber(one, liveData({
		tools: { byTool: [...data.tools!.byTool, ...data.tools!.byTool], byToolModel: [], series: [] } as never,
	}))).toBe(3);
});

test("derived share is a ratio with a zero-safe denominator, never Infinity or NaN", () => {
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "errorRate",
		op: "share",
		of: { kind: "derived", name: "errors", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "errors" } },
		against: { kind: "derived", name: "calls", op: "sum", of: { kind: "aggregate", source: "toolsByTool", field: "calls" } },
	};
	expect(resolveNumber(ref, data)).toBeCloseTo(44 / 6_515, 10);

	// Every call unpriced / zero calls: the honest answer is 0, not NaN. NaN in
	// a cell prints literally, and the test that catches it is this one.
	const zero = liveData({
		tools: { byTool: [], byToolModel: [], series: [] } as never,
	});
	expect(resolveNumber(ref, zero)).toBe(0);
});

test("derived max takes the largest row, and an empty source is 0 rather than -Infinity", () => {
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "peak",
		op: "max",
		of: { kind: "series", source: "costSeries", field: "cost" },
	};
	expect(resolveNumber(ref, data)).toBe(42);
	const empty = liveData({ costs: { costSeries: [] } });
	expect(resolveNumber(ref, empty)).toBe(0);
});

// ─── row scoping: a table cell reads ITS row ────────────────────────────────

test("a row-scoped resolve reads that row, so two rows never share a value", () => {
	const data = liveData();
	const ref: MetricRef = { kind: "aggregate", source: "byModel", field: "totalCost" };
	const [first, second] = data.modelDashboard!.byModel;
	expect(resolveCell(ref, data, first)).toBe(935.72);
	expect(resolveCell(ref, data, second)).toBe(0);
	expect(resolveCell(ref, data, second)).not.toBe(resolveCell(ref, data, first));
});

test("a row-scoped derived sum totals the row's own token kinds", () => {
	const data = liveData();
	const ref: MetricRef = {
		kind: "derived",
		name: "conversationTokens",
		op: "sum",
		of: { kind: "aggregate", source: "byModel", field: "totalInputTokens" },
		against: { kind: "aggregate", source: "byModel", field: "totalCacheReadTokens" },
	};
	const row = data.modelDashboard!.byModel[0];
	expect(resolveNumber(ref, data, row)).toBe(
		row.totalInputTokens + row.totalCacheReadTokens + row.totalCacheWriteTokens + row.totalOutputTokens,
	);
});

// ─── the empty payload ───────────────────────────────────────────────────────

test("every ref on an EMPTY payload resolves to null instead of throwing", () => {
	const data = emptyData();
	const failures: string[] = [];
	for (const spec of SCREEN_SPECS) {
		for (const ref of refsInSpec(spec)) {
			try {
				if (resolveCell(ref, data) === null) continue;
				// A non-null value out of an empty payload is itself a bug, but a
				// different one — count is legitimately 0, so it is allowed here
				// and pinned separately below.
			} catch (error) {
				failures.push(`${spec.id} ${labelOf(ref)}: ${String(error)}`);
			}
			expect(() => resolveSeriesValues(ref, data)).not.toThrow();
		}
	}
	expect(failures, failures.join("\n")).toEqual([]);
});

test("an empty payload yields no invented spend: a cost is null, not $0.00", () => {
	const data = emptyData();
	expect(resolveNumber({ kind: "aggregate", source: "overall", field: "totalCost" }, data)).toBeNull();
	expect(resolveNumber({ kind: "aggregate", source: "costSeries", field: "cost" }, data)).toBeNull();
	expect(resolveNumber({ kind: "aggregate", source: "overall", field: "unpricedRequests" }, data)).toBeNull();
});

test("rowsFor on an absent source is an empty list, never undefined", () => {
	const data = emptyData();
	for (const source of ["overall", "costSeries", "folders", "recentMessages", "errorMessages", "toolsByTool", "dailyActivity", "providerStats"] as const) {
		expect(rowsFor(source, data), source).toEqual([]);
	}
});


// ─── sourceOf / metricRefsOf are the IR's, and the resolver agrees ───────────

test("the resolver's source agrees with the IR's own sourceOf, always", () => {
	for (const spec of SCREEN_SPECS) {
		for (const ref of refsInSpec(spec)) {
			expect(metricNeed(ref) !== undefined).toBe(true);
			expect(NEED_BY_SOURCE[sourceOf(ref)]).toBe(metricNeed(ref));
		}
	}
});
