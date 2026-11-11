import { handleApi } from "@oh-my-pi/omp-stats/server";
import { currentDb, getDailyActivity } from "@oh-my-pi/omp-stats/db";
import { getRollupStatus } from "@oh-my-pi/omp-stats/rollup";
import type {
	AggregatedStats,
	DashboardStats,
	DailyActivityPoint,
	FolderStats,
	GainDashboardStats,
	ModelStats,
	ModelTimeSeriesPoint,
	ProviderDashboardStats,
	TimeSeriesPoint,
	ToolDashboardStats,
} from "@oh-my-pi/omp-stats/shared-types";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import type { Range } from "./ranges";

/**
 * THE DATA SEAM.
 *
 * `handleApi` is a plain `async (req: Request) => Promise<Response>` exported
 * from `@oh-my-pi/omp-stats/server`. Its body reads the request only through
 * `new URL(req.url)`, `req.method`, `req.headers.get(...)` and
 * `url.searchParams` — never `req.json()`, `req.body` or `req.signal` — and it
 * contains zero references to the Bun server object. The only `server.*` call in
 * that file lives in `createDashboardServer`'s SSE branch, outside `handleApi`.
 *
 * So `new Request("http://localhost/api/stats/overview")` is a complete input.
 * NO SOCKET IS BOUND AND NO SERVER IS STARTED: the host part of the URL is a
 * formality that makes the string a valid absolute URL, and nothing dials it.
 * Calling it in-process is what lets all the read routes run inside the panel
 * instead of behind a local webserver.
 */

/**
 * The reader is injected in tests to serve fixtures, so it may hand back either
 * an already-parsed body or a real `Response`. Both are accepted: the `Response`
 * branch is where a non-OK status becomes an error, and a fixture reader that
 * skips it would let a 404 parse into a body that renders as zeroes.
 */
export type Reader = (path: string, params: Record<string, string>) => Promise<unknown>;

const liveReader: Reader = async (path, params) => {
	const url = new URL("http://localhost" + path);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return handleApi(new Request(url.toString()));
};

export async function apiGet<T>(
	path: string,
	params: Record<string, string> = {},
	read: Reader = liveReader,
): Promise<T> {
	const result = await read(path, params);
	if (result instanceof Response) {
		if (!result.ok) throw new Error(`${path} -> ${result.status}`);
		return (await result.json()) as T;
	}
	return result as T;
}

// --- Payload shapes, all derived from the host's own types ------------------
// Re-declaring these would be a silent-bug generator: a shape change upstream
// would surface as `undefined` painted into a cell rather than as an error.

/** `/api/stats/overview` — the three keys the host actually returns. */
export type OverviewPayload = Pick<DashboardStats, "overall" | "byAgentType" | "timeSeries">;
export type ModelDashboardPayload = Pick<
	DashboardStats,
	"byModel" | "modelSeries" | "modelPerformanceSeries"
>;
export type CostPayload = Pick<DashboardStats, "costSeries">;
export type RecentRequest = MessageStats;

/**
 * Rollup freshness. Above 96 dirty hours the host stops unioning dirty hours
 * with the facts and returns stale rows with holes in them — so the panel must
 * show this count rather than presenting not-yet-built hours as zeroes.
 */
export interface RollupStatus {
	dirtyHours: number;
	dirtySessions: number;
}

/**
 * THE SILENT-EMPTY TRAP, and the reason this type exists.
 *
 * `getRollupStatus()` returns `{dirtyHours: 0, dirtySessions: 0}` when
 * `currentDb()` is null — byte-identical to a genuinely clean database. Every
 * rollup-backed getter likewise degrades to `[]` or a zeroed aggregate before
 * `initDb()` has run, with no error at all. Measured cost of `initDb()` is
 * 866.9 ms, so "query too early" is an ordinary race, not an exotic one.
 *
 * A discriminated union forces the distinction to be represented rather than
 * remembered: the uninitialised case has no counts to report, so it cannot be
 * mistaken for a report of zero.
 */
export type DbReadiness = { ready: false } | ({ ready: true } & RollupStatus);

export function rollupStatusOrThrow(readiness: DbReadiness): RollupStatus {
	if (!readiness.ready) {
		throw new Error(
			"rollup status: database is not initialised — call initDb() before querying",
		);
	}
	return { dirtyHours: readiness.dirtyHours, dirtySessions: readiness.dirtySessions };
}

export async function fetchOverview(
	range: Range,
	read: Reader = liveReader,
): Promise<OverviewPayload> {
	return apiGet<OverviewPayload>("/api/stats/overview", { range }, read);
}

export async function fetchModelDashboard(
	range: Range,
	read: Reader = liveReader,
): Promise<ModelDashboardPayload> {
	return apiGet<ModelDashboardPayload>("/api/stats/model-dashboard", { range }, read);
}
export async function fetchCosts(
	range: Range,
	read: Reader = liveReader,
): Promise<CostPayload> {
	return apiGet<CostPayload>("/api/stats/costs", { range }, read);
}

export function fetchFolders(range: Range, read: Reader = liveReader): Promise<FolderStats[]> {
	return apiGet<FolderStats[]>("/api/stats/folders", { range }, read);
}

export function fetchRecent(range: Range, limit: number, read: Reader = liveReader): Promise<RecentRequest[]> {
	return apiGet<RecentRequest[]>("/api/stats/recent", { range, limit: String(limit) }, read);
}

export function fetchErrors(
	range: Range,
	limit: number,
	read: Reader = liveReader,
): Promise<RecentRequest[]> {
	return apiGet<RecentRequest[]>("/api/stats/errors", { range, limit: String(limit) }, read);
}

export function fetchTools(range: Range, read: Reader = liveReader): Promise<ToolDashboardStats> {
	return apiGet<ToolDashboardStats>("/api/stats/tools", { range }, read);
}

/**
 * DB-backed provider aggregates: per-provider totals, the hourly burn
 * histogram, and the per-provider time series. This is the ONLY provider
 * payload the panel reads — `/api/stats/provider-windows` does broker
 * network I/O per load (see `getProviderWindowStats`), so it stays out of
 * the load path and the windows sections stay deferred.
 */
export function fetchProviders(range: Range, read: Reader = liveReader): Promise<ProviderDashboardStats> {
	return apiGet<ProviderDashboardStats>("/api/stats/providers", { range }, read);
}

/**
 * Token savings from the snapcompact jsonl beside the database. Missing files
 * read as zero records, never an error — so an empty gain payload is a real
 * answer, and the screen's empty state names the range rather than a failure.
 */
export function fetchGain(
	range: Range,
	read: Reader = liveReader,
	project: string | null = null,
): Promise<GainDashboardStats> {
	return apiGet<GainDashboardStats>(
		"/api/stats/gain",
		project === null ? { range } : { range, project },
		read,
	);
}

/**
 * No route exposes daily activity, so this reads the package directly. Static
 * import only: dynamic `import()` of any `@oh-my-pi/*` fails inside the
 * extension loader, which rewrites specifiers for static imports alone.
 *
 * Measured 195.6 ms — the query that forced `/usage` into a subprocess. A
 * rollup-backed panel does not call it on the hot path; see the calendar
 * screen's note before wiring it into a first paint.
 */
export function fetchDailyActivity(days = 371): Promise<DailyActivityPoint[]> {
	return getDailyActivity(days);
}

/**
 * Dirty-hour counts for the freshness line. Reads `currentDb()` rather than
 * calling `getRollupStatus()` blindly, so an uninitialised database raises
 * instead of reporting a fabricated zero.
 */
export function fetchRollupStatus(): RollupStatus {
	return rollupStatusOrThrow(currentDb() ? { ready: true, ...getRollupStatus() } : { ready: false });
}

// --- Screen contract ---------------------------------------------------------

/** What a screen declares it needs. A scaffolded screen declares none. */
export const DATA_NEEDS = [
	"overview",
	"modelDashboard",
	"costs",
	"folders",
	"recent",
	"errors",
	"tools",
	"providers",
	"gain",
	"dailyActivity",
	"rollupStatus",
] as const;

export type DataNeed = (typeof DATA_NEEDS)[number];

export interface PanelData {
	overview?: OverviewPayload;
	modelDashboard?: ModelDashboardPayload;
	costs?: CostPayload;
	folders?: FolderStats[];
	recent?: RecentRequest[];
	errors?: RecentRequest[];
	tools?: ToolDashboardStats;
	providers?: ProviderDashboardStats;
	gain?: GainDashboardStats;
	dailyActivity?: DailyActivityPoint[];
	rollupStatus?: RollupStatus;
	/** Worker-observed facts and transcript cursors, not inferred from zero totals. */
	freshness?: { records: number; pendingSessions: number; observedAt: number };
}

/**
 * `rollupStatus` and `dailyActivity` are not route-backed, so they are resolved
 * directly rather than through the reader; the override parameter exists so a
 * test can exercise the mapping without a 321 MB database. Production passes
 * nothing and gets the real fetcher.
 */
type Fetcher = (range: Range) => Promise<unknown>;

const ROUTE_FETCHERS: Record<DataNeed, Fetcher> = {
	overview: range => fetchOverview(range),
	modelDashboard: range => fetchModelDashboard(range),
	costs: range => fetchCosts(range),
	folders: range => fetchFolders(range),
	recent: range => fetchRecent(range, 50),
	errors: range => fetchErrors(range, 50),
	tools: range => fetchTools(range),
	providers: range => fetchProviders(range),
	gain: range => fetchGain(range),
	dailyActivity: () => fetchDailyActivity(),
	rollupStatus: async () => fetchRollupStatus(),
};

/**
 * Per-need settlement: every need that succeeded appears in `data`, every
 * need that failed appears in `errors` with its `String(cause)` message.
 * String-only messages keep the settlement JSON-serializable across the
 * worker boundary. A missing need reads as not loaded, never as zero.
 */
export interface FetchSettlement {
	data: Partial<PanelData>;
	errors: Partial<Record<DataNeed, string>>;
	/** Attached by the worker after settlement; never set by fetchFor itself. */
	freshness?: { records: number; pendingSessions: number; observedAt: number };
}

/** Fetch declared upstream reads. Production executes this in the data worker. */
export async function fetchFor(
	needs: readonly DataNeed[],
	range: Range,
	read: Reader = liveReader,
	overrides: Partial<Record<DataNeed, Fetcher>> = {},
): Promise<FetchSettlement> {
	for (const need of needs) {
		if (!(need in ROUTE_FETCHERS)) throw new Error(`unknown data need: ${String(need)}`);
	}
	const routes = { ...ROUTE_FETCHERS };
	// A reader only redirects the route-backed reads; the two direct calls have
	// no HTTP shape to redirect.
	if (read !== liveReader) {
		routes.overview = r => fetchOverview(r, read);
		routes.modelDashboard = r => fetchModelDashboard(r, read);
		routes.costs = r => fetchCosts(r, read);
		routes.folders = r => fetchFolders(r, read);
		routes.recent = r => fetchRecent(r, 50, read);
		routes.errors = r => fetchErrors(r, 50, read);
		routes.tools = r => fetchTools(r, read);
		routes.providers = r => fetchProviders(r, read);
		routes.gain = r => fetchGain(r, read);
	}
	// Explicit overrides win over both the defaults and the fixture reader.
	for (const [need, fetcher] of Object.entries(overrides) as [DataNeed, Fetcher][]) {
		routes[need] = fetcher;
	}

	const settled = await Promise.allSettled(
		needs.map(async need => [need, await routes[need](range)] as const),
	);
	const data = {} as Partial<PanelData>;
	const errors: Partial<Record<DataNeed, string>> = {};
	settled.forEach((outcome, index) => {
		if (outcome.status === "fulfilled") {
			const [need, value] = outcome.value;
			(data as Record<DataNeed, unknown>)[need] = value;
		} else {
			errors[needs[index] as DataNeed] = String(outcome.reason);
		}
	});
	// NOTE: `errors` is attached to the worker payload in scripts/data-worker.ts
	// (owned by another task) so the panel can render scoped errors beside
	// retained data; string messages keep the payload JSON-serializable.
	return { data, errors };
}
// Deliberately absent, and each absence is load-bearing:
//   /api/stats/provider-windows — getProviderWindowStats does network I/O.
//   /api/sync                   — starts real background ingest; 7141 ms of
//                                  synchronous SQLite that must never run on
//                                  the TUI thread. Task 12 owns it, in a child.
//   /api/request/{id}           — getRequestDetails parses session transcripts
//                                  off disk; it is not a load-path read.
// If a screen ever needs one of these, it needs the sync worker, not a wrapper
// here. Types re-exported for consumers: AggregatedStats, ModelStats,
// TimeSeriesPoint, ModelTimeSeriesPoint.
export type { AggregatedStats, ModelStats, TimeSeriesPoint, ModelTimeSeriesPoint };