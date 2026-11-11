import { resolve } from "node:path";
declare const __STATS_READ_WORKER__: string;
import { spawnStatsWorker, type StatsWorkerProcess } from "../workers/process";
import type { DataNeed, PanelData } from "./api";
import type { DataWorkerRequest, DataWorkerResponse, ReadStage } from "./protocol";
import type { Range } from "./ranges";
import type { StatsApiOptions } from "../tui/features/types";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";

type RequestInput =
	| { type: "fetch"; needs: readonly DataNeed[]; range: Range }
	| { type: "sync" }
	| ({ type: "api"; path: string; params: Record<string, string> } & StatsApiOptions);

/** One persistent child per mounted panel; no database code runs in the UI. */
export class StatsReadClient {
	#child: StatsWorkerProcess | null = null;
	#pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; stage?: (stage: ReadStage) => void }>();
	#sequence = 0;
	#closed = false;
	#malformedLines = 0;
	#stderr = "";
	#writeError: unknown;
	readonly #spawn: () => StatsWorkerProcess;
	#live: LiveStatus | undefined;
	#serviceError: Error | undefined;
	readonly #listeners = new Set<{ status: (status: LiveStatus) => void; error?: (error: Error) => void }>();

	constructor(spawn = () => spawnStatsWorker(resolve(import.meta.dir,
		typeof __STATS_READ_WORKER__ === "string" ? __STATS_READ_WORKER__ : "../../scripts/data-worker.ts"),
		"Stats reads", "pipe")) {
		this.#spawn = spawn;
	}

	fetch(needs: readonly DataNeed[], range: Range, stage?: (stage: ReadStage) => void): Promise<PanelData> {
		return this.#request({ type: "fetch", needs, range }, stage) as Promise<PanelData>;
	}

	api<T>(path: string, params: Record<string, string> = {}, options: StatsApiOptions = {}): Promise<T> {
		return this.#request({ type: "api", path, params, ...options }) as Promise<T>;
	}
	subscribe(status: (status: LiveStatus) => void, error?: (error: Error) => void): () => void {
		const listener = { status, error };
		this.#listeners.add(listener);
		if (this.#live) status(this.#live);
		if (this.#serviceError) error?.(this.#serviceError);
		return () => { this.#listeners.delete(listener); };
	}

	requestSync(): Promise<LiveStatus> {
		return this.#request({ type: "sync" }) as Promise<LiveStatus>;
	}


	#request(input: RequestInput, stage?: (stage: ReadStage) => void): Promise<unknown> {
		if (this.#closed) return Promise.reject(new Error("Stats panel closed"));
		try {
			if (!this.#child) {
				const child = this.#spawn();
				this.#child = child;
				this.#stderr = "";
				this.#malformedLines = 0;
				this.#writeError = undefined;
				void this.#watch(child);
			}
			const id = ++this.#sequence;
			const result = Promise.withResolvers<unknown>();
			this.#pending.set(id, { resolve: result.resolve, reject: result.reject, stage });
			void this.#write(this.#child, { ...input, id });
			return result.promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #write(child: StatsWorkerProcess, request: DataWorkerRequest): Promise<void> {
		try {
			const stdin = child.stdin;
			if (typeof stdin === "number" || !stdin) throw new Error("Stats read worker stdin unavailable");
			stdin.write(JSON.stringify(request) + "\n");
			await stdin.flush();
		} catch (error) {
			if (this.#child !== child) return;
			// Reap and drain stderr before rejecting requests, including startup EPIPE races.
			this.#writeError = error;
			child.kill("SIGKILL");
		}
	}

	async #watch(child: StatsWorkerProcess): Promise<void> {
		const stderr = (async () => {
			const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#stderr = (this.#stderr + decoder.decode(value, { stream: true })).slice(-8192);
			}
			this.#stderr = (this.#stderr + decoder.decode()).slice(-8192);
		})().catch(error => {
			child.kill("SIGKILL");
			throw error;
		});
		const stdout = (async () => {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { value, done } = await reader.read();
				buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
				// Fold a trailing partial line into the same per-line handling below.
				if (done) buffer += "\n";
				let end: number;
				while ((end = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (!line.trim()) continue;
					let message: DataWorkerResponse;
					try {
						message = JSON.parse(line);
					} catch {
						this.#malformedLines++;
						this.#stderr = (this.#stderr + `\nmalformed worker stdout line ${this.#malformedLines}: ${line.slice(0, 200)}`).slice(-8192);
						if (this.#malformedLines > 10) throw new Error(`Stats read worker emitted ${this.#malformedLines} malformed stdout lines`);
						continue;
					}
					this.#receive(message);
				}
				if (done) break;
			}
		})().catch(error => {
			child.kill("SIGKILL");
			throw error;
		});
		const results = await Promise.allSettled([stdout, stderr, child.exited]);
		if (this.#child !== child) return;
		this.#child = null;
		const failure = results.find(result => result.status === "rejected");
		const exit = results[2];
		const diagnostic = failure?.status === "rejected" ? String(failure.reason)
			: this.#writeError !== undefined ? String(this.#writeError)
			: `Stats read worker exited (code ${exit.status === "fulfilled" ? exit.value : "unknown"})`;
		const error = new Error(diagnostic + (this.#stderr ? `\n${this.#stderr}` : ""));
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (!this.#closed) {
			this.#serviceError = error;
			for (const listener of this.#listeners) listener.error?.(error);
		}
	}

	#receive(message: DataWorkerResponse): void {
		if (this.#closed) return;
		// The live push is the only variant with no `id` — it is broadcast, not a
		// reply — so keying the guard on `id` PRESENCE (rather than
		// `"type" in message && message.type === "live"`) is what lets TypeScript
		// narrow the remainder to the three reply variants. A compound `&&` guard
		// leaves the union un-narrowed below, so `message.id` reads as an error.
		if (!("id" in message)) {
			this.#live = message.status;
			this.#serviceError = undefined;
			for (const listener of this.#listeners) listener.status(message.status);
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		if ("stage" in message) {
			pending.stage?.(message.stage);
			return;
		}
		this.#pending.delete(message.id);
		if ("error" in message) pending.reject(new Error(message.error));
		else pending.resolve(message.data);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(new Error("Stats panel closed"));
		this.#pending.clear();
		this.#listeners.clear();
		this.#child?.kill("SIGKILL");
	}
}
