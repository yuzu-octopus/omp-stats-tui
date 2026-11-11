import { test, expect } from "bun:test";
import {
	apiGet,
	fetchFor,
	rollupStatusOrThrow,
	type OverviewPayload,
	type RecentRequest,
} from "../src/data/api";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
test("a non-OK response becomes a thrown error naming the path and status", async () => {
	const failing = async () => new Response("nope", { status: 404 });
	await expect(apiGet("/api/nope", {}, failing as never)).rejects.toThrow("/api/nope -> 404");
});

test("a 500 is surfaced as an error too, not parsed as a body", async () => {
	const failing = async () => new Response("boom", { status: 500 });
	await expect(apiGet("/api/stats/overview", {}, failing as never)).rejects.toThrow(
		"/api/stats/overview -> 500",
	);
});

test("THE SILENT-EMPTY TRAP: an uninitialised database is distinguishable from no data", () => {
	// getRollupStatus() returns {0,0} when currentDb() is null, which is
	// byte-identical to a genuinely clean database. The panel must be able to tell
	// them apart, or a first-run panel claims it is up to date while showing zeros.
	expect(() => rollupStatusOrThrow({ ready: false })).toThrow(/not initialised/);
	const clean = rollupStatusOrThrow({ ready: true, dirtyHours: 0, dirtySessions: 0 });
	expect(clean).toEqual({ dirtyHours: 0, dirtySessions: 0 });
});

// Partial shapes asserted by identity (toEqual), cast to the full payload
// types the fetchers promise. Structural completeness is the fetchers' own
// contract, covered by upstream types — not by these settlement tests.
const OVERVIEW_FIXTURE = { overall: { totalRequests: 3 } } as unknown as OverviewPayload;
const RECENT_FIXTURE = [{ id: 1 }, { id: 2 }] as unknown as RecentRequest[];

test("fetchFor settles every need independently when all succeed", async () => {
	const seen: Array<[string, Record<string, string>]> = [];
	const stubRead = async (path: string, params: Record<string, string>) => {
		seen.push([path, params]);
		if (path === "/api/stats/overview") return OVERVIEW_FIXTURE;
		if (path === "/api/stats/recent") return RECENT_FIXTURE;
		throw new Error(`unexpected path ${path}`);
	};
	const result = await fetchFor(["overview", "recent"], "24h", stubRead);
	expect(result.data.overview).toEqual(OVERVIEW_FIXTURE);
	expect(result.data.recent).toEqual(RECENT_FIXTURE);
	expect(result.errors).toEqual({});
	expect(seen.map(([path]) => path).sort()).toEqual(["/api/stats/overview", "/api/stats/recent"]);
	expect(seen.map(([, params]) => params)).toEqual([{ range: "24h" }, { range: "24h", limit: "50" }].map(params => expect.objectContaining(params)));
});

test("a failing need settles into errors while good needs stay in data", async () => {
	const result = await fetchFor(["overview", "recent"], "24h", async () => OVERVIEW_FIXTURE, {
		overview: async () => OVERVIEW_FIXTURE,
		recent: async () => { throw new Error("recent unavailable"); },
	});
	expect(result.data.overview).toEqual(OVERVIEW_FIXTURE);
	expect(result.data.recent).toBeUndefined();
	expect(result.errors.recent).toContain("recent unavailable");
	expect(result.errors.overview).toBeUndefined();
	// All failing still resolves (never rejects for need failures) with empty data.
	const empty = await fetchFor(["recent"], "24h", async () => { throw new Error("reader down"); });
	expect(empty.data).toEqual({});
	expect(String(empty.errors.recent)).toContain("reader down");
});

test("a fixture reader redirects route-backed fetches; direct calls never touch it", async () => {
	const seen: string[] = [];
	const stubRead = async (path: string) => { seen.push(path); return OVERVIEW_FIXTURE; };
	const direct = { marker: "direct" } as unknown as DailyActivityPoint[];
	const result = await fetchFor(["overview", "dailyActivity"], "24h", stubRead, {
		dailyActivity: async () => direct,
	});
	expect(result.data.overview).toEqual(OVERVIEW_FIXTURE);
	expect(result.data.dailyActivity).toEqual(direct);
	expect(seen).toEqual(["/api/stats/overview"]);
	// Direct needs resolve without a reader at all: a throwing reader is never called.
	const throwing = async () => { throw new Error("reader must not be called"); };
	const only = await fetchFor(["rollupStatus"], "24h", throwing, {
		rollupStatus: async () => ({ dirtyHours: 0, dirtySessions: 0 }),
	});
	expect(only.data.rollupStatus).toEqual({ dirtyHours: 0, dirtySessions: 0 });
	expect(only.errors).toEqual({});
});

test("an explicit override wins over the fixture reader", async () => {
	const stubRead = async (path: string) => {
		if (path === "/api/stats/overview") return OVERVIEW_FIXTURE;
		return { fromStub: true };
	};
	const canned = [{ id: 7 }] as unknown as RecentRequest[];
	const result = await fetchFor(["overview", "recent"], "24h", stubRead, {
		recent: async () => canned,
	});
	expect(result.data.recent).toEqual(canned);
	expect(result.data.overview).toEqual(OVERVIEW_FIXTURE);
	expect(result.errors).toEqual({});
});
