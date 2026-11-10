/**
 * `test/patch-guard.test.ts` — the host patch's one COPIED value.
 *
 * `verify:patch` asserts the locked `@oh-my-pi/omp-stats` patch is applied in
 * full. `EXACT_DIRTY_LIMIT` is a different problem: the host declares it but
 * does not export it, so the panel's copy can drift from a host bump with no
 * error anywhere. Reading the host source keeps the copy honest — the panel
 * escalates "pending" to "stale" at exactly the host's threshold.
 */

import { expect, test } from "bun:test";

import { EXACT_DIRTY_LIMIT } from "../src/tui/panel";

test("EXACT_DIRTY_LIMIT matches the host's own value", async () => {
	const host = await Bun.file(
		`${import.meta.dir}/../node_modules/@oh-my-pi/omp-stats/src/rollup.ts`,
	).text();
	const match = host.match(/EXACT_DIRTY_LIMIT\s*=\s*(\d+)/);
	expect(match, "host rollup.ts no longer declares EXACT_DIRTY_LIMIT").not.toBeNull();
	expect(EXACT_DIRTY_LIMIT).toBe(Number(match![1]));
});
