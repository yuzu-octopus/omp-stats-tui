import { existsSync, watch, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils";
import { StatsReadClient } from "../src/data/client";
import type { StatsWorkerProcess } from "../src/workers/process";
import { installStatsTestIsolation } from "./fixtures/stats-isolation";

const isolation = installStatsTestIsolation("@stats-worker-concurrency-");

/** The real `handleApi`, with one path held open until the parent releases it. */
const SLOW_API_PRELOAD = [
	'import { appendFileSync, existsSync, watch } from "node:fs";',
	'import { mock } from "bun:test";',
	'import * as server from "@oh-my-pi/omp-stats/server";',
	"const realHandleApi = server.handleApi;",
	'mock.module("@oh-my-pi/omp-stats/server", () => ({',
	"  ...server,",
	"  handleApi: async request => {",
	'    if (!request.url.includes("/api/slow")) return realHandleApi(request);',
	'    appendFileSync(process.env.STATS_SLOW_START, "start\\n");',
	"    await new Promise(resolve => {",
	"      const target = process.env.STATS_SLOW_RELEASE;",
	"      if (existsSync(target)) { resolve(); return; }",
	"      const watcher = watch(process.env.STATS_SLOW_DIR, (_event, changed) => {",
	'        if (changed === "slow-api-release" && existsSync(target)) { watcher.close(); resolve(); }',
	"      });",
	"    });",
	'    appendFileSync(process.env.STATS_SLOW_DONE, "done\\n");',
	'    return new Response(JSON.stringify({ marker: "slow" }), { status: 200, headers: { "content-type": "application/json" } });',
	"  },",
	"}));",
].join("\n");

function spawnSlowWorker(preload: string, start: string, done: string, release: string, directory: string): StatsWorkerProcess {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required for the worker test");
	const profile = getActiveProfile() ?? "";
	return Bun.spawn([bun, "run", "--preload", preload, resolve(import.meta.dir, "../scripts/data-worker.ts")], {
		cwd: process.cwd(),
		env: {
			...process.env,
			STATS_SLOW_START: start,
			STATS_SLOW_DONE: done,
			STATS_SLOW_RELEASE: release,
			STATS_SLOW_DIR: directory,
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	const { promise: timedOut, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), ms);
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

async function waitForStart(directory: string, filename: string): Promise<void> {
	const target = resolve(directory, filename);
	if (existsSync(target)) return;
	const { promise, resolve: ready, reject } = Promise.withResolvers<void>();
	let watcher: FSWatcher | undefined;
	const close = () => { watcher?.close(); watcher = undefined; };
	watcher = watch(directory, (_event, changed) => {
		if (changed === filename && existsSync(target)) { close(); ready(); }
	});
	watcher.on("error", error => { close(); reject(error); });
	try {
		await withTimeout(promise, 10_000, `timed out waiting for ${target}`);
	} finally {
		close();
	}
}

/** Safety net only: a hung child must not outlive the test. */
async function reap(child: StatsWorkerProcess | undefined): Promise<void> {
	if (!child) return;
	const target = child;
	const { promise: expired, resolve: kill } = Promise.withResolvers<void>();
	const timer = setTimeout(kill, 10_000);
	try {
		await Promise.race([
			target.exited,
			expired.then(async () => { target.kill("SIGKILL"); return target.exited; }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test("a delayed API reply neither blocks a later fetch nor is lost at EOF", async () => {
	const temp = isolation.current();
	if (!temp) throw new Error("stats test isolation is not active");
	const preload = resolve(import.meta.dir, "../scripts", `tmp-worker-concurrency-preload-${process.pid}.ts`);
	const start = temp.join("slow-api-start");
	const done = temp.join("slow-api-done");
	const release = temp.join("slow-api-release");
	await Bun.write(preload, SLOW_API_PRELOAD);
	let child: StatsWorkerProcess | undefined;
	let stdinEnded = false;
	const client = new StatsReadClient(() => child = spawnSlowWorker(preload, start, done, release, temp.path()));
	try {
		const slow = client.api<{ marker: string }>("/api/slow", {}, { method: "GET" });
		await waitForStart(temp.path(), "slow-api-start");
		const fast = await client.fetch(["rollupStatus"], "24h");
		expect(fast).toBeDefined();
		expect(existsSync(done)).toBe(false);
		const stdin = child?.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("worker stdin unavailable");
		await stdin.end();
		stdinEnded = true;
		await Bun.write(release, "");
		expect(await slow).toEqual({ marker: "slow" });
		expect(existsSync(done)).toBe(true);
		expect(await child?.exited).toBe(0);
	} finally {
		if (!stdinEnded) client.close();
		await reap(child);
		await rm(preload, { force: true });
		await rm(start, { force: true });
		await rm(done, { force: true });
		await rm(release, { force: true });
	}
}, 45_000);
