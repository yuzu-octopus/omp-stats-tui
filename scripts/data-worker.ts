import { mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { initDb, getFileOffsets, getMessageCount } from "@oh-my-pi/omp-stats/db.js";
import { listAllSessionFiles } from "@oh-my-pi/omp-stats/parser";
import { fetchFor } from "../src/data/api";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import type { DataWorkerRequest } from "../src/data/protocol";
import { openStandaloneJudge, type StandaloneJudge } from "@oh-my-pi/pi-coding-agent/judgment/standalone";
import { cancelFrustrationRun, setStatsJudgeProvider } from "@oh-my-pi/omp-stats/frustration";
// `.js` subpath: the package ships `dist/types/*.d.ts` built from UNPATCHED
// source, so `StatsLive({ workers })` — added by patches/@oh-my-pi%2Fomp-stats
// @18.7.0.patch — has no declaration. This subpath resolves to `src/live.ts`,
// the code that actually runs. Verified the same resolved module as the bare
// specifier, so this changes types only, never the runtime instance.
import { StatsLive } from "@oh-my-pi/omp-stats/live.js";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
const live = new StatsLive({ workers: 1 });

let standaloneJudge: StandaloneJudge | undefined;
setStatsJudgeProvider(async () => {
	standaloneJudge ??= await openStandaloneJudge(process.cwd(), "stats_frustration");
	return standaloneJudge.judge;
});
process.on("exit", () => {
	live.stop();
	cancelFrustrationRun();
	standaloneJudge?.close();
});

const output = Bun.stdout.writer();
let pendingOutput = Promise.resolve();
function emit(value: unknown): Promise<void> {
	const line = JSON.stringify(value) + "\n";
	pendingOutput = pendingOutput.then(async () => {
		output.write(line);
		await output.flush();
	});
	return pendingOutput;
}
live.subscribe(status => {
	void emit({ type: "live", status }).catch(error => {
		console.error(error);
		process.exit(1);
	});
});
let initialized = false;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const request = JSON.parse(line) as DataWorkerRequest;
	try {
		if (!initialized) {
			await emit({ id: request.id, stage: "initializing" });
			await initDb();
			await mkdir(getSessionsDir(), { recursive: true });
			live.start();
			initialized = true;
		}
		await emit({ id: request.id, stage: "reading" });
		let data: unknown;
		if (request.type === "fetch") {
			const payload = await fetchFor(request.needs, request.range);
			const files = await listAllSessionFiles();
			let pendingSessions = 0;
			for (let start = 0; start < files.length; start += 128) {
				const batch = files.slice(start, start + 128);
				const cursors = getFileOffsets(batch);
				const stats = await Promise.all(batch.map(file => stat(file)));
				for (let index = 0; index < batch.length; index++) {
					const cursor = cursors.get(batch[index]);
					if (!cursor || cursor.parserState?.size !== stats[index].size || cursor.lastModified !== stats[index].mtimeMs) pendingSessions++;
				}
			}
			payload.freshness = { records: getMessageCount(), pendingSessions, observedAt: Date.now() };
			data = payload;
		} else if (request.type === "sync") {
			live.requestSync();
			data = live.status();
		} else {
			const url = new URL(request.path, "http://localhost");
			if (url.pathname === "/api/status") {
				await emit({ id: request.id, data: live.status() });
				continue;
			}
			if (url.pathname === "/api/sync") {
				if (request.method !== "POST") throw new Error("POST required");
				live.requestSync();
				await emit({ id: request.id, data: live.status() });
				continue;
			}
			for (const [key, value] of Object.entries(request.params)) url.searchParams.set(key, value);
			// `url.toString()`, not the `URL`: with `lib: ESNext` (no DOM) Bun's
			// `Request` overloads take a string, a `RequestInit & {url}`, or a
			// `Request` — a `URL` object matches none of them.
			const response = await handleApi(new Request(url.toString(), { method: request.method, headers: request.headers }));
			data = await response.json();
			if (!response.ok) throw new Error(`${request.path} -> ${response.status}: ${JSON.stringify(data)}`);
		}
		await emit({ id: request.id, data });
	} catch (error) {
		await emit({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
}
live.stop();
await pendingOutput;
process.exit(0);
