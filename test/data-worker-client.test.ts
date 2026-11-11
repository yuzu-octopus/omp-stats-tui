import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { StatsReadClient } from "../src/data/client";
import type { StatsWorkerProcess } from "../src/workers/process";
import { getActiveProfile, getAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./fixtures/stats-isolation";

installStatsTestIsolation("@stats-worker-scan-");

function faultChild(source: string): StatsWorkerProcess {
	return Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

test.each([false, true])("premature read-worker exit preserves stderr (already exited: %s)", async alreadyExited => {
	const child = faultChild('console.error("cannot read stats database"); process.exit(7);');
	if (alreadyExited) await child.exited;
	const client = new StatsReadClient(() => child);
	try {
		await expect(client.fetch(["overview"], "24h")).rejects.toThrow("cannot read stats database");
		expect(await child.exited).toBe(7);
	} finally { client.close(); }
});

/**
 * The worker's freshness scan calls `listAllSessionFiles`. This preload wraps
 * that one export and appends to `STATS_SCAN_LOG` for calls that originate in
 * `data-worker` itself — the live/ingest path imports the same parser export,
 * so the stack decides what counts as the per-fetch scan.
 */
const SCAN_PRELOAD = [
	'import { appendFileSync } from "node:fs";',
	'import { mock } from "bun:test";',
	'import * as parser from "@oh-my-pi/omp-stats/parser";',
	'const real = parser.listAllSessionFiles;',
	'mock.module("@oh-my-pi/omp-stats/parser", () => ({',
	'  ...parser,',
	'  listAllSessionFiles: async () => {',
	'    const fromWorker = (new Error().stack ?? "").includes("data-worker");',
	'    if (fromWorker) appendFileSync(process.env.STATS_SCAN_LOG ?? "/dev/null", "scan\\n");',
	'    const files = await real();',
	'    if (fromWorker) appendFileSync(process.env.STATS_SCAN_DONE ?? "/dev/null", "scanned\\n");',
	'    return files;',
	'  },',
	'}));',
].join("\n");
let preloadSeq = 0;

/** The real worker, with the scan-counting preload and an isolated profile. */
function spawnScannedWorker(preload: string, log: string, doneLog: string): StatsWorkerProcess {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required for the worker test");
	const profile = getActiveProfile() ?? "";
	return Bun.spawn([bun, "run", "--preload", preload, resolve(import.meta.dir, "../scripts/data-worker.ts")], {
		cwd: process.cwd(),
		env: {
			...process.env,
			STATS_SCAN_LOG: log,
			STATS_SCAN_DONE: doneLog,
			PI_BUNDLED: "",
			PI_CODING_AGENT_DIR: getAgentDir(),
			OMP_PROFILE: profile,
			PI_PROFILE: profile,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as StatsWorkerProcess;
}

test("a rollupStatus-only fetch never scans session files", async () => {
	const temp = TempDir.createSync("@stats-worker-scan-");
	// The preload must live inside the repo: a preload in the OS temp dir
	// resolves `@oh-my-pi/omp-stats/parser` from Bun's global cache, not the
	// project's node_modules, and the mock would miss the worker's import.
	const preload = resolve(import.meta.dir, "../scripts", `tmp-scan-preload-${process.pid}-${preloadSeq++}.ts`);
	const log = temp.join("scans.log");
	const doneLog = temp.join("scanned.done");
	await Bun.write(preload, SCAN_PRELOAD);
	let child: StatsWorkerProcess | undefined;
	const client = new StatsReadClient(() => child = spawnScannedWorker(preload, log, doneLog));
	let stopWatch: (() => void) | undefined;
	try {
		// Resolves when the worker's own startup/live scan completes, so a
		// preload that failed to intercept cannot make the zero-scan
		// assertions below vacuous.
		const { promise: scanned, resolve: resolveScanned, reject: rejectScanned } = Promise.withResolvers<void>();
		let watcher: FSWatcher | undefined;
		watcher = watch(temp.path(), (_event, filename) => {
			if (filename !== "scanned.done") return;
			watcher?.close();
			watcher = undefined;
			stopWatch = undefined;
			resolveScanned();
		});
		watcher.on("error", error => {
			watcher?.close();
			watcher = undefined;
			stopWatch = undefined;
			rejectScanned(error);
		});
		stopWatch = () => watcher?.close();
		const synced = Promise.withResolvers<void>();
		client.subscribe(status => {
			if (status.sync.phase === "idle" && status.sync.lastSyncedAt !== null) synced.resolve();
		}, error => synced.reject(error));
		await client.fetch(["rollupStatus"], "24h");
		await synced.promise;
		await scanned;
		await Bun.write(log, "");
		await client.fetch(["rollupStatus"], "24h");
		expect(await Bun.file(log).text()).toBe("");
		// A full fetch inside the 30 s window reuses the same cached count.
		await client.fetch(["overview"], "24h");
		expect(await Bun.file(log).text()).toBe("");
	} finally {
		stopWatch?.();
		client.close();
		if (child) await child.exited;
		await rm(preload, { force: true });
		temp.removeSync();
	}
}, 45_000);

// --- Plan 001 step 4: multiplexing over the DataWorkerResponse union ---------
// Each scripted child below speaks the protocol union from
// src/data/protocol.ts (id/stage replies plus id-less live pushes) and sends
// the LANDED { data, errors } settlement shape. Existing tests above are
// untouched.

let scriptedChildSeq = 0;

/** A scripted child speaking DataWorkerResponse lines (plans 001/002). */
async function spawnScripted(source: string): Promise<{ child: StatsWorkerProcess; file: string }> {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required for the worker test");
	const file = resolve(import.meta.dir, "../scripts", `tmp-scripted-child-${process.pid}-${scriptedChildSeq++}.ts`);
	await Bun.write(file, source);
	const child = Bun.spawn([bun, "run", file], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as StatsWorkerProcess;
	return { child, file };
}

/** The LANDED settlement shape, narrowed to the probe marker these children send. */
type SettlementProbe = { data: { marker: number }; errors: Record<string, string> };
function settlementOf(value: unknown): SettlementProbe {
	return value as SettlementProbe;
}

async function closeScripted(client: StatsReadClient, child: StatsWorkerProcess, file: string): Promise<void> {
	client.close();
	await child.exited;
	await rm(file, { force: true });
}

const SCRIPT_PRELUDE = [
	'import { createInterface } from "node:readline";',
	'const send = (value: unknown): void => { console.log(JSON.stringify(value)); };',
	'const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });',
];

/** Replies in reverse arrival order: routing must still deliver per id. */
const ROUTING_CHILD = [...SCRIPT_PRELUDE,
	'const seen: { id: number }[] = [];',
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  seen.push(JSON.parse(line) as { id: number });',
	'  if (seen.length === 2) {',
	'    for (const req of [...seen].reverse()) send({ id: req.id, data: { data: { marker: req.id }, errors: {} } });',
	'  }',
	'}',
].join("\n");

/** Stage reply first, then the payload, per request. */
const STAGE_CHILD = [...SCRIPT_PRELUDE,
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  const req = JSON.parse(line) as { id: number };',
	'  send({ id: req.id, stage: "reading" });',
	'  send({ id: req.id, data: { data: { marker: req.id }, errors: {} } });',
	'}',
].join("\n");

/** One id-less live push, then a delayed payload: the push must not settle the fetch. */
// The 500 ms gap is real inter-process ordering (child stdout vs parent pump):
// fake timers cannot advance the child process clock.
const LIVE_CHILD = [...SCRIPT_PRELUDE,
	'const status = { version: 7, sync: { phase: "idle", current: 0, total: 0, processed: 0, lastSyncedAt: null, error: null }, indexingHours: 0 };',
	'let liveSent = false;',
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  const req = JSON.parse(line) as { id: number };',
	'  if (!liveSent) {',
	'    liveSent = true;',
	'    send({ type: "live", status });',
	'    const gate = Promise.withResolvers<void>();',
	'    setTimeout(gate.resolve, 500);',
	'    await gate.promise;',
	'  }',
	'  send({ id: req.id, data: { data: { marker: req.id }, errors: {} } });',
	'}',
].join("\n");

/** Consumes requests, never replies: close() must reject the stranded pending. */
const SILENT_CHILD = [...SCRIPT_PRELUDE,
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  JSON.parse(line);',
	'}',
].join("\n");

/** One stray non-JSON line, then the valid reply for the same request. */
const GARBAGE_THEN_VALID_CHILD = [...SCRIPT_PRELUDE,
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  const req = JSON.parse(line) as { id: number };',
	'  console.log("stray log line {{{ not json");',
	'  send({ id: req.id, data: { data: { marker: req.id }, errors: {} } });',
	'}',
].join("\n");

/** Eleven stray lines and no reply: past the >10 threshold, the pump tears down. */
const ELEVEN_GARBAGE_CHILD = [...SCRIPT_PRELUDE,
	'for await (const line of reader) {',
	'  if (!line.trim()) continue;',
	'  JSON.parse(line);',
	'  for (let i = 0; i < 11; i++) console.log("stray log line " + i + " {{{ not json");',
	'}',
].join("\n");

describe("001 read-client multiplexing", () => {
	test("two concurrent fetches resolve to the right caller", async () => {
		const { child, file } = await spawnScripted(ROUTING_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			const first = client.fetch(["overview"], "24h");
			const second = client.fetch(["overview"], "24h");
			const [a, b] = await Promise.all([first, second]);
			expect(settlementOf(a).data.marker).toBe(1);
			expect(settlementOf(b).data.marker).toBe(2);
			expect(settlementOf(a).errors).toEqual({});
		} finally {
			await closeScripted(client, child, file);
		}
	});

	test("stage callbacks fire per request", async () => {
		const { child, file } = await spawnScripted(STAGE_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			const stages: string[] = [];
			const data = await client.fetch(["overview"], "24h", stage => { stages.push(stage); });
			expect(stages).toEqual(["reading"]);
			expect(settlementOf(data).data.marker).toBe(1);
		} finally {
			await closeScripted(client, child, file);
		}
	});

	test("live push broadcasts without resolving pendings", async () => {
		const { child, file } = await spawnScripted(LIVE_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			const seen: number[] = [];
			const liveArrived = Promise.withResolvers<void>();
			client.subscribe(status => { seen.push(status.version); liveArrived.resolve(); });
			let settled = false;
			const pending = client.fetch(["overview"], "24h").then(data => { settled = true; return data; });
			await liveArrived.promise;
			// Live arrived but the delayed payload has not: a broadcast live
			// push must leave the pending fetch unsettled.
			expect(settled).toBe(false);
			const data = await pending;
			expect(settlementOf(data).data.marker).toBe(1);
			expect(seen).toEqual([7]);
		} finally {
			await closeScripted(client, child, file);
		}
	});

	test("close rejects pendings with Stats panel closed", async () => {
		const { child, file } = await spawnScripted(SILENT_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			const pending = client.fetch(["overview"], "24h");
			client.close();
			await expect(pending).rejects.toThrow("Stats panel closed");
		} finally {
			await closeScripted(client, child, file);
		}
	});
});

describe("002 malformed stdout lines", () => {
	test("one garbage line survives and the valid response resolves", async () => {
		const { child, file } = await spawnScripted(GARBAGE_THEN_VALID_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			const first = await client.fetch(["overview"], "24h");
			expect(settlementOf(first).data.marker).toBe(1);
			const second = await client.fetch(["overview"], "24h");
			expect(settlementOf(second).data.marker).toBe(2);
		} finally {
			await closeScripted(client, child, file);
		}
	});

	test("eleven garbage lines tear down the worker", async () => {
		const { child, file } = await spawnScripted(ELEVEN_GARBAGE_CHILD);
		const client = new StatsReadClient(() => child);
		try {
			await expect(client.fetch(["overview"], "24h")).rejects.toThrow(/malformed/);
		} finally {
			await closeScripted(client, child, file);
		}
	});
});

// --- Plan 004 step 2: freshness rides along, never blocks --------------------
// Same SCAN_PRELOAD counting trick as above, but the freshness scan is slowed
// to 5 s: a blocking fetch path could not resolve before the done marker
// appears, so resolving first with the pre-scan observedAt pins the LANDED
// fire-and-forget behavior. Frequency semantics are unchanged, so the
// existing SCAN_PRELOAD tests above are untouched.

const SLOW_SCAN_PRELOAD = [
	'import { appendFileSync } from "node:fs";',
	'import { mock } from "bun:test";',
	'import * as parser from "@oh-my-pi/omp-stats/parser";',
	'const real = parser.listAllSessionFiles;',
	'mock.module("@oh-my-pi/omp-stats/parser", () => ({',
	'  ...parser,',
	'  listAllSessionFiles: async () => {',
	'    const fromWorker = (new Error().stack ?? "").includes("data-worker");',
	'    if (fromWorker) appendFileSync(process.env.STATS_SCAN_LOG ?? "/dev/null", "scan\\n");',
	'    if (fromWorker) { const gate = Promise.withResolvers<void>(); setTimeout(gate.resolve, 5000); await gate.promise; }',
	'    const files = await real();',
	'    if (fromWorker) appendFileSync(process.env.STATS_SCAN_DONE ?? "/dev/null", "scanned\\n");',
	'    return files;',
	'  },',
	'}));',
].join("\n");

describe("004 freshness off the critical path", () => {
	test("payload emits before the scan completes with pre-scan observedAt", async () => {
		const temp = TempDir.createSync("@stats-worker-scan-");
		const preload = resolve(import.meta.dir, "../scripts", `tmp-slow-scan-preload-${process.pid}-${preloadSeq++}.ts`);
		const log = temp.join("scans.log");
		const doneLog = temp.join("scanned.done");
		await Bun.write(preload, SLOW_SCAN_PRELOAD);
		let child: StatsWorkerProcess | undefined;
		const client = new StatsReadClient(() => child = spawnScannedWorker(preload, log, doneLog));
		let stopWatch: (() => void) | undefined;
		try {
			const payload = await client.fetch(["rollupStatus"], "24h");
			// With a 5 s scan, a blocking fetch path could not have resolved
			// yet — so the done marker must still be absent here.
			let doneAtPayload = "";
			try {
				doneAtPayload = await Bun.file(doneLog).text();
			} catch {
				// Not written yet: exactly the expected pre-scan state.
			}
			expect(doneAtPayload).not.toContain("scanned");
			// Stale-by-design, honestly dated: the last-known count from
			// before any scan completed, never a fresh count awaited inline.
			expect(payload.freshness?.observedAt).toBe(0);
			const settlement = payload as unknown as SettlementProbe; // worker sends the settlement union, typed as PanelData on the client
			expect(settlement.errors).toEqual({});
			// The fire-and-forget scan still runs: the done marker appears after.
			// Watch for it via the filesystem rather than polling on a clock.
			const { promise: scanned, resolve: resolveScanned, reject: rejectScanned } = Promise.withResolvers<void>();
			let watcher: FSWatcher | undefined;
			watcher = watch(temp.path(), (_event, filename) => {
				if (filename !== "scanned.done") return;
				watcher?.close();
				watcher = undefined;
				stopWatch = undefined;
				resolveScanned();
			});
			watcher.on("error", error => {
				watcher?.close();
				watcher = undefined;
				stopWatch = undefined;
				rejectScanned(error);
			});
			stopWatch = () => watcher?.close();
			const timeout = setTimeout(() => rejectScanned(new Error("timed out waiting for scanned.done")), 30_000);
			try {
				await scanned;
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			stopWatch?.();
			client.close();
			if (child) await child.exited;
			await rm(preload, { force: true });
			temp.removeSync();
		}
	}, 45_000);
});
