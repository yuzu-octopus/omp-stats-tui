import { expect, test } from "bun:test";
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
	const preload = resolve(import.meta.dir, "../scripts", `tmp-scan-preload-${process.pid}.ts`);
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
