/**
 * Assert the locked `@oh-my-pi/omp-stats` patch is applied IN FULL.
 *
 * `patchedDependencies` applies the patch on install, but a partial apply or an
 * upstream drift in any single correction is invisible unless every marker is
 * checked. Each correction is load-bearing: the worker depends on `StatsLive`
 * accepting `workers`, the unpriced backfill is what makes an unpriced model
 * read as unknown spend, `ROLLUP_VERSION = 3` is what re-marks every dirty hour,
 * provider `outputTokens` feeds the token mix, and range-before-limit is what
 * keeps `/api/stats/recent` from returning rows outside the window.
 */

export {};

const HOST = "node_modules/@oh-my-pi/omp-stats/src";

const CHECKS: readonly (readonly [file: string, marker: string, label: string])[] = [
	["db.ts", "messages_cost_unpriced_v2", "unpriced cost backfill"],
	["live.ts", "#workers", "StatsLive({ workers })"],
	["rollup.ts", 'ROLLUP_VERSION = "3"', "rollup version 3"],
	["rollup.ts", "outputTokens: row.output_tokens", "provider outputTokens"],
	["shared-types.ts", "outputTokens: number", "provider outputTokens type"],
	["aggregator.ts", "getRecentRequests(limit?: number, range?: string | null)", "range-before-limit recent requests"],
	["db.ts", "getRecentRequests(limit = 100, cutoff?: number | null)", "cutoff-filtered recent requests"],
	["server.ts", 'getRecentRequests(limit ? parseInt(limit, 10) : undefined, url.searchParams.get("range"))', "server forwards the range"],
];

let failed = false;
for (const [file, marker, label] of CHECKS) {
	const path = `${HOST}/${file}`;
	let source: string;
	try {
		source = await Bun.file(path).text();
	} catch {
		console.error(`MISSING ${path} — ${label}`);
		failed = true;
		continue;
	}
	if (!source.includes(marker)) {
		console.error(`PATCH NOT APPLIED: ${path} has no ${JSON.stringify(marker)} (${label})`);
		failed = true;
	}
}

if (failed) process.exit(1);
console.log(`dependency patch applied: ${CHECKS.length} corrections present in ${HOST}`);
