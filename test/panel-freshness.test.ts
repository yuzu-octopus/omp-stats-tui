import { expect, test } from "bun:test";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";
import { __testing, type PanelReads } from "../src/tui/panel";
import { blankData, liveData } from "./fixtures/panel";

test("un-ingested transcripts cannot present a fabricated zero-cost dashboard", async () => {
	const panel = __testing.makePanel({ data: {
		...blankData(), freshness: { records: 0, pendingSessions: 2, observedAt: 100 },
	} });
	try {
		await __testing.settled(panel);
		const body = __testing.debugBody(panel).join("\n");
		expect(body).toContain("un-ingested");
		expect(body).not.toContain("API-equivalent cost");
	} finally { panel.dispose(); }
});

test("cached usage remains visible while newer transcripts await ingest", async () => {
	const panel = __testing.makePanel({ data: liveData({
		freshness: { records: 10, pendingSessions: 2, observedAt: 100 },
	}) });
	try {
		await __testing.settled(panel);
		const body = __testing.debugBody(panel).join("\n");
		expect(body).toContain("un-ingested");
		expect(body).toContain("$112.36");
	} finally { panel.dispose(); }
});

function readsFetching(fetch: PanelReads["fetch"]): PanelReads {
	return {
		fetch,
		api: async <T>() => [] as unknown as T,
		subscribe: () => () => {},
		requestSync: async () => ({}) as LiveStatus,
		close: () => {},
	};
}

test("freshness on a worker settlement reaches the notices", async () => {
	const panel = __testing.makePanel({
		reads: readsFetching(async () => ({
			data: liveData(),
			errors: {},
			freshness: { records: 0, pendingSessions: 2, observedAt: 100 },
		})),
	});
	try {
		await __testing.settled(panel);
		const body = __testing.debugBody(panel).join("\n");
		expect(body).toContain("un-ingested");
		expect(body).toContain("No ingested requests yet; this is not measured zero usage.");
	} finally { panel.dispose(); }
});

test("freshness on a bare PanelData fetch reaches the notices", async () => {
	const panel = __testing.makePanel({
		reads: readsFetching(async () => liveData({
			freshness: { records: 10, pendingSessions: 2, observedAt: 100 },
		})),
	});
	try {
		await __testing.settled(panel);
		expect(__testing.debugBody(panel).join("\n")).toContain("un-ingested");
	} finally { panel.dispose(); }
});
