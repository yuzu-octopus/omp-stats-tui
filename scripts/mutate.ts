#!/usr/bin/env bun
/**
 * Mutation harness — one mutation, one verdict.
 *
 * Apply a production-code mutation, run the named test files, record whether the
 * suite DIED (the mutation was caught) or SURVIVED (the test is decorative for
 * that mutation), then revert. Never leaves the tree dirty.
 */
import { $ } from "bun";

interface Mutation {
	id: string;
	file: string;
	find: string;
	replace: string;
	tests: string[];
	expectation: string;
	/** Deliberate no-op: verifies the harness itself can see a green run. */
	control?: boolean;
}

const MUTATIONS: Mutation[] = [
	// ── band.ts / G1–G6 ──────────────────────────────────────────────────────
	{
		id: "G4-blank-line-unconditional",
		file: "src/tui/band.ts",
		find: 'if (lines.length > 0) lines.push("");',
		replace: 'lines.push("");',
		tests: ["test/band.test.ts"],
		expectation: "G4: a trailing blank line appears after the last band",
	},
	{
		id: "G5-heading-becomes-rule",
		file: "src/tui/band.ts",
		find: 'const parts = [statsIcon(preset, icon), ctx.bold(ctx.fg(PALETTE.heading, title))];',
		replace:
			'const parts = ["─".repeat(60), statsIcon(preset, icon), ctx.bold(ctx.fg(PALETTE.heading, title))];',
		tests: ["test/band.test.ts"],
		expectation: "G5: a band heading emits a full-width rule",
	},
	{
		id: "statRow-label-clamped-to-nothing",
		file: "src/tui/band.ts",
		find: "slots[0].push(padEndTo(clamp(ctx.bold(ctx.fg(PALETTE.muted, tile.label)), cell), cell));",
		replace: "slots[0].push(padEndTo(clamp(ctx.bold(ctx.fg(PALETTE.muted, tile.label)), 0), cell));",
		tests: ["test/band.test.ts"],
		expectation: "F23 2.3 r3: the LABEL is truncated away instead of the value",
	},
	{
		id: "statRow-hint-always-rendered",
		file: "src/tui/band.ts",
		find: 'slots[2].push(padEndTo(visibleWidth(hint) <= cell ? ctx.fg(PALETTE.dim, hint) : "", cell));',
		replace: "slots[2].push(padEndTo(ctx.fg(PALETTE.dim, hint), cell));",
		tests: ["test/band.test.ts"],
		expectation: "F23 2.3 r2: an oversized hint is truncated rather than dropped",
	},
	{
		id: "table-numbers-dimmed",
		file: "src/tui/band.ts",
		find: "(t) => ctx.fg(selected ? PALETTE.primary : PALETTE.label, t),",
		replace: "(t) => ctx.fg(selected ? PALETTE.primary : PALETTE.dim, t),",
		tests: ["test/band.test.ts"],
		expectation: "table data cells become dim instead of default text",
	},
	{
		id: "statRow-columns-ignore-grid",
		file: "src/tui/band.ts",
		find: "const columns = tileColumns(inner, tileWidth);",
		replace: "const columns = stats.length;",
		tests: ["test/band.test.ts"],
		expectation: "statRow lays every tile in one row, ignoring the measured grid",
	},
	{
		id: "colour-leak-hardcoded-escape",
		file: "src/tui/band.ts",
		find: "ctx.bold(ctx.fg(PALETTE.heading, title))",
		replace: 'ctx.bold(`\\x1b[38;2;255;0;0m${title}\\x1b[0m`)',
		tests: ["test/band.test.ts"],
		expectation: "a literal truecolor escape enters a band body",
	},
	// ── format.ts ────────────────────────────────────────────────────────────
	{
		id: "format-percent-drops-decimals",
		file: "src/tui/format.ts",
		find: "return `${(value * 100).toFixed(digits)}%`;",
		replace: "return `${(value * 100).toFixed(0)}%`;",
		tests: ["test/format.test.ts", "test/band.test.ts"],
		expectation: "formatPercent ignores the requested decimals",
	},
	{
		id: "format-cost-ignores-subcent-digits",
		file: "src/tui/format.ts",
		find: "export function formatCost(value: number, digits?: number): string {",
		replace: "export function formatCost(value: number, digits?: number): string {\n\tdigits = 2;",
		tests: ["test/format.test.ts"],
		expectation: "formatCost forces 2 digits, losing sub-cent precision",
	},
	{
		id: "format-unpriced-marker-dropped",
		file: "src/tui/format.ts",
		find: "export function costWithUnpriced(cost: number, unpricedRequests: number, digits?: number): string {",
		replace:
			"export function costWithUnpriced(cost: number, unpricedRequests: number, digits?: number): string {\n\treturn formatCost(cost, digits);",
		tests: ["test/format.test.ts", "test/unpriced-render.test.ts"],
		expectation: "costWithUnpriced stops marking unpriced spend — the one lie this panel avoids",
	},
	// ── bars.ts ──────────────────────────────────────────────────────────────
	{
		id: "bars-zero-gets-a-cell",
		file: "src/tui/charts/bars.ts",
		find: "return values.map((v) => (v === null || v <= 0 ? 0 : Math.max(1, Math.min(rows, Math.round((v / max) * rows)))));",
		replace: "return values.map((v) => (v === null ? 0 : Math.max(1, Math.min(rows, Math.round((v / max) * rows)))));",
		tests: ["test/bars.test.ts"],
		expectation: "a ZERO value renders a filled cell — \"nothing happened\" looks like spend",
	},
	{
		id: "bars-compose-inverts-fill",
		file: "src/tui/charts/bars.ts",
		find: '.map(h => (h >= threshold ? opts.accent(fill) : " "))',
		replace: '.map(h => (h < threshold ? opts.accent(fill) : " "))',
		tests: ["test/bars.test.ts"],
		expectation: "the bar chart fills from the BOTTOM (staircase inverted)",
	},
	{
		id: "bars-empty-state-removed",
		file: "src/tui/charts/bars.ts",
		find: "return [opts.dim(clamp(NO_ACTIVITY, Math.max(0, Math.floor(opts.width))))];",
		replace: "return [];",
		tests: ["test/bars.test.ts"],
		expectation: "an empty range renders nothing instead of saying so",
	},
	// ── controls ─────────────────────────────────────────────────────────────
	{
		id: "CONTROL-no-op",
		file: "src/tui/band.ts",
		find: "const TILE_MAX_WIDTH = 34;",
		replace: "const TILE_MAX_WIDTH = 34;",
		tests: ["test/band.test.ts"],
		expectation: "CONTROL: harness must report a green run here",
		control: true,
	},
];

interface Row {
	id: string;
	expectation: string;
	verdict: "DIED" | "SURVIVED" | "ERROR";
	detail: string;
}

/**
 * Restore from an in-memory snapshot — NEVER from git.
 *
 * The first version of this harness ran `git checkout -- src test` after every
 * mutation. On a shared working tree that discards every uncommitted change
 * under those paths, not just the mutation this script wrote. It ate a sibling
 * agent's in-progress edits to `src/tui/palette.ts` and `test/heatmap.test.ts`.
 *
 * Snapshotting the one file we are about to touch is both safer and sufficient:
 * the only change this script makes is a single `Bun.write` to `m.file`.
 */
async function run(m: Mutation): Promise<Row> {
	const original = await Bun.file(m.file).text();
	try {
		if (!original.includes(m.find)) {
			return { id: m.id, expectation: m.expectation, verdict: "ERROR", detail: `anchor not found in ${m.file}` };
		}
		await Bun.write(m.file, original.replace(m.find, m.replace));

		const proc = Bun.spawn(["bun", "test", ...m.tests], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		const exit = await proc.exited;

		const failed = /^ (\d+) fail/m.exec(out)?.[1] ?? "?";
		const passed = /^ (\d+) pass/m.exec(out)?.[1] ?? "?";
		if (m.control) {
			return {
				id: m.id,
				expectation: m.expectation,
				verdict: exit === 0 ? "DIED" : "SURVIVED",
				detail: `CONTROL ${passed} pass ${failed} fail`,
			};
		}
		return exit !== 0
			? { id: m.id, expectation: m.expectation, verdict: "DIED", detail: `${failed} fail / ${passed} pass` }
			: { id: m.id, expectation: m.expectation, verdict: "SURVIVED", detail: `${passed} pass, 0 fail` };
	} finally {
		// Always restore, even if the test run threw. `git` is never involved, so
		// a sibling's uncommitted work in any other file is untouchable.
		await Bun.write(m.file, original);
	}
}

// Refuse to run on a dirty tree rather than risk it, unless explicitly forced.
const dirty = await $`git status --porcelain`.quiet().text();
if (dirty.trim() && !process.argv.includes("--allow-dirty")) {
	console.error("Refusing to run: the working tree has uncommitted changes.");
	console.error("This script snapshots the files it touches, so it is safe, but run");
	console.error("`bun run scripts/mutate.ts --allow-dirty` if you know that is fine.\n");
	console.error(dirty);
	process.exit(2);
}

const rows: Row[] = [];
for (const m of MUTATIONS) rows.push(await run(m));

console.log("\n=== MUTATION RESULTS ===");
for (const r of rows) {
	console.log(`${r.verdict.padEnd(9)} ${r.id.padEnd(42)} ${r.detail}`);
}
const scored = rows.filter(r => r.verdict !== "ERROR" && !r.id.startsWith("CONTROL"));
console.log(`\nDIED: ${scored.filter(r => r.verdict === "DIED").length} / ${scored.length}`);
