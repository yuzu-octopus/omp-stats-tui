/**
 * `test/showcase-needs.test.ts` — the showcase's declared needs against its bands.
 *
 * The showcase declares `needs` on every section even though it fetches nothing,
 * because a spec that reads a payload it never declared renders an empty band —
 * the panel's silent-empty trap. This file is the guard that the declaration and
 * the bands agree, in BOTH directions:
 *
 *   - every band ref resolves through `NEED_BY_SOURCE` to a need its own section
 *     declares. A ref with no declared need is a band that can never be filled.
 *   - every need the showcase declares is read by at least one band. A need no
 *     band reads is a fetch the showcase would pay for and throw away.
 *
 * It also carries the source-level "no database in the showcase" assertion that
 * `showcase/panel.ts` and `showcase/fixtures.ts` cite: a future edit reaching for
 * the DB would pass every behavioural test and only fail in someone's real
 * session, ~850 ms later, on the keystroke they just typed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { NEED_BY_SOURCE, metricRefsOf, sourceOf, type Band, type MetricRef } from "../src/layout/spec";
import { SHOWCASE_RECORD } from "../src/tui/showcase/fixtures";
import { SHOWCASE_SECTIONS } from "../src/tui/showcase/spec";

const ROOT = `${import.meta.dir}/..`;

/** Every metric reachable from a band: tiles, chart series, legend, columns. */
function refsInBand(band: Band): readonly MetricRef[] {
	switch (band.kind) {
		case "statRow":
			return band.stats.flatMap(tile => metricRefsOf(tile.metric));
		case "chart":
			return band.chart.series.flatMap(series => metricRefsOf(series.metric));
		case "legend":
			return band.items.flatMap(item => metricRefsOf(item.metric));
		case "table":
			return band.columns.flatMap(column => metricRefsOf(column.source));
		case "note":
			return [];
	}
}

/** Every need any band in the showcase reads, keyed by the section that reads it. */
function needsReadByBands(): ReadonlyMap<string, ReadonlySet<string>> {
	const read = new Map<string, Set<string>>();
	for (const section of SHOWCASE_SECTIONS) {
		const needs = new Set<string>();
		for (const band of section.spec.bands) {
			for (const ref of refsInBand(band)) {
				const need = NEED_BY_SOURCE[sourceOf(ref)];
				if (need !== null) needs.add(need);
			}
		}
		read.set(section.id, needs);
	}
	return read;
}

// ─── needs ↔ refs ────────────────────────────────────────────────────────────

test("every band ref resolves to a need its own section declares", () => {
	for (const section of SHOWCASE_SECTIONS) {
		for (const ref of section.spec.bands.flatMap(refsInBand)) {
			const source = sourceOf(ref);
			const need = NEED_BY_SOURCE[source];
			// Asserting this BEFORE the `toContain` is the point: a null need is a
			// band that can never be filled, and the failure must say which.
			expect(need, `${section.id}: source "${source}" has no declared need`).toBeTruthy();
			if (need === null) continue;
			expect(
				[...section.spec.needs],
				`${section.id} reads ${source} (${need}) but declares only ${section.spec.needs.join(", ")}`,
			).toContain(need);
		}
	}
});

test("every need the showcase declares is read by at least one band", () => {
	const read = new Set<string>();
	for (const needs of needsReadByBands().values()) {
		for (const need of needs) read.add(need);
	}
	const declared = new Set(SHOWCASE_SECTIONS.flatMap(section => section.spec.needs));
	// The scan must be looking at something, or the assertion below is vacuous.
	expect(declared.size, "the showcase declares no needs").toBeGreaterThan(5);
	for (const need of declared) {
		expect(read, `declared need "${need}" is read by no showcase band`).toContain(need);
	}
});

// ─── the fixture's documented dirty state ─────────────────────────────────────

test("the showcase record carries dirty hours, as its docblock documents", () => {
	// The freshness chrome cycles through dirty states; a fixture pinned at zero
	// would make the documented state a lie. Non-zero is the point.
	expect(SHOWCASE_RECORD.rollupStatus?.dirtyHours ?? 0).toBeGreaterThan(0);
});

// ─── no database in the showcase ─────────────────────────────────────────────

test("no module under showcase/ imports bun:sqlite or calls initDb/fetchFor", () => {
	const files = [...new Bun.Glob("src/tui/showcase/**/*.ts").scanSync({ cwd: ROOT })].sort();
	expect(files.length, "the showcase scan is not finding modules").toBeGreaterThan(3);
	const forbidden: ReadonlyArray<[RegExp, string]> = [
		[/from\s+["']bun:sqlite["']/, "imports bun:sqlite"],
		[/\binitDb\s*\(/, "calls initDb()"],
		[/\bfetchFor\s*\(/, "calls fetchFor()"],
	];
	const offenders: string[] = [];
	for (const file of files) {
		const source = readFileSync(`${ROOT}/${file}`, "utf8");
		for (const [pattern, label] of forbidden) {
			if (pattern.test(source)) offenders.push(`${file}: ${label}`);
		}
	}
	expect(offenders, `showcase/ must stay DB-free:\n${offenders.join("\n")}`).toEqual([]);
});
