import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { SessionSummary, SessionTrace, TraceSpan, TraceTrack } from "@oh-my-pi/omp-stats/shared-types";
import { createTracesFeature } from "../src/tui/features/traces";
import type { FeatureContext } from "../src/tui/features/types";
import { ancestors, buildLanes, buildScale, fit, overviewViewport, remapViewport, resizeOverview, rowForEntry, spanCells, transcriptRows, visibleTracks, zoomViewport } from "../src/tui/features/traces/model";
import { renderTimeline, sessionIdentity, traceDuration } from "../src/tui/features/traces/render";
import { glyph } from "../src/tui/glyphs";
import { SPAN_COLORS } from "../src/tui/palette";

ensureThemeSync();
const START = 1_700_000_000_000;
const ROOT = "/isolated/sessions/root.jsonl", CHILD = "/isolated/sessions/alpha.jsonl", GRANDCHILD = "/isolated/sessions/nested.jsonl";
function span(id: string, kind: TraceSpan["kind"], start: number, end: number, label: string, extra: Partial<TraceSpan> = {}): TraceSpan {
	return { id, kind, start: START + start, end: START + end, label, ...extra };
}
function track(id: string, parentId: string | null, file: string, spans: TraceSpan[]): TraceTrack {
	return { id, parentId, label: id, agent: parentId ? "worker" : null, model: "recorded-model", file, spans, markers: [] };
}
function nestedTrace(): SessionTrace {
	return {
		file: ROOT, title: "Recorded nested trace", cwd: "/isolated/project", startedAt: START, endedAt: START + 110_000,
		mtimeMs: START + 110_000, etag: "fixture",
		tracks: [
			track("main", null, ROOT, [
				span("main:turn", "turn", 0, 0, "First prompt", { entryId: "prompt" }),
				span("main:shared", "model", 100, 900, "Root response", { entryId: "shared", model: "recorded-model", tokens: 100 }),
				span("main:spawn", "subagent", 1000, 6000, "Agent alpha", { entryId: "spawn", childTrackId: "alpha", detail: "inspect nested work" }),
				span("main:bash1", "tool", 6000, 6500, "bash", { entryId: "bash1" }),
				span("main:bash2", "tool", 6200, 6800, "bash", { entryId: "bash2", isError: true }),
				span("main:turn2", "turn", 100_000, 100_000, "Second prompt"),
				span("main:later", "model", 100_000, 110_000, "Later response", { entryId: "later" }),
			]),
			track("alpha", "main", CHILD, [
				span("alpha:shared", "model", 1200, 2500, "Child response", { entryId: "shared" }),
				span("alpha:nested", "subagent", 3000, 5000, "Nested task", { entryId: "spawn", childTrackId: "alpha/nested" }),
			]),
			track("alpha/nested", "alpha", GRANDCHILD, [span("alpha/nested:shared", "model", 3200, 3900, "Grandchild response", { entryId: "shared" })]),
		],
		summary: { wallMs: 110_000, modelMs: 10_800, toolMs: 1100, idleMs: 90_000, turns: 2, requests: 4,
			toolCalls: 2, subagents: 2, totalTokens: 100, costTotal: 0.002, unpricedRequests: 0,
			toolStats: [{ tool: "bash", calls: 2, errors: 1, totalMs: 1100, maxMs: 600 }] },
	};
}
function childTrace(file: string): SessionTrace {
	const root = nestedTrace();
	const source = root.tracks.find(item => item.file === file)!;
	return { ...root, file, title: source.label, tracks: [{ ...source, id: "main", parentId: null, spans: source.spans.map(item => ({ ...item, id: `main:${item.entryId ?? item.id}` })) }] };
}
function context(entryReader?: (file: string, id: string) => Promise<unknown>): FeatureContext {
	return {
		theme, now: () => START + 110_000, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {},
		reader: {
			fetch: async () => ({}),
			async api<T>(path: string, params?: Record<string, string>): Promise<T> {
				if (path === "/api/session/trace") return (params?.file === ROOT ? nestedTrace() : childTrace(params!.file!)) as T;
				if (path === "/api/session/entry") {
					const entry = entryReader ? await entryReader(params!.file!, params!.id!) : { message: { role: "assistant", content: [{ type: "text", text: `Entry ${params!.id} in ${params!.file}` }] } };
					return { entry } as T;
				}
				if (path === "/api/sessions") return [] as T;
				throw new Error(`Unexpected fixture query ${path}`);
			},
		},
	};
}
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Consumer-visible arithmetic: no parent-relative stretching of nested calls.
test("root-child-grandchild spans share wall-time coordinates and retain their actual durations", () => {
	const trace = nestedTrace(), scale = buildScale(trace.tracks, "time", false), viewport = fit(scale);
	const parent = trace.tracks[0]!.spans.find(item => item.id === "main:spawn")!;
	const child = trace.tracks[1]!.spans[0]!, grandchild = trace.tracks[2]!.spans[0]!;
	expect(spanCells(scale, viewport, parent, 1100)).toEqual([10, 60]);
	expect(spanCells(scale, viewport, child, 1100)).toEqual([12, 25]);
	expect(spanCells(scale, viewport, grandchild, 1100)).toEqual([32, 39]);
	expect(scale.toT(scale.toU(grandchild.start))).toBe(grandchild.start);
	expect(grandchild.end - grandchild.start).toBe(700);
});

test("idle compression preserves active nested durations and round-trips selection times", () => {
	const trace = nestedTrace(), scale = buildScale(trace.tracks, "time", true);
	expect(scale.gaps).toHaveLength(1);
	for (const track of trace.tracks) for (const item of track.spans) {
		expect(scale.toT(scale.toU(item.start))).toBeCloseTo(item.start, 3);
		expect(scale.toU(item.end) - scale.toU(item.start)).toBeCloseTo(item.end - item.start, 3);
	}
	expect(scale.domain[1] - scale.domain[0]).toBeLessThan(110_000);
});

test("axis transitions preserve visible wall-time endpoints and nested identity", () => {
	const trace = nestedTrace();
	let scale = buildScale(trace.tracks, "time", true);
	let viewport = { u0: scale.toU(START + 1100), u1: scale.toU(START + 7000) };
	for (const mode of ["turns", "calls", "time"] as const) {
		const next = buildScale(trace.tracks, mode, true);
		viewport = remapViewport(scale, next, viewport);
		expect(next.toT(viewport.u0)).toBeCloseTo(START + 1100, 3);
		expect(next.toT(viewport.u1)).toBeCloseTo(START + 7000, 3);
		expect(rowForEntry(trace, GRANDCHILD, "shared")?.key).toBe("alpha/nested:shared");
		scale = next;
	}
});

test("keyboard zoom anchors a moved cursor instead of assuming the center", () => {
	const trace = nestedTrace(), scale = buildScale(trace.tracks, "calls", false), viewport = fit(scale);
	for (const cursor of [0.2, 0.8]) {
		const anchor = scale.toT(viewport.u0 + cursor * (viewport.u1 - viewport.u0));
		const zoomed = zoomViewport(scale, viewport, 0.5, cursor);
		expect(scale.toT(zoomed.u0 + cursor * (zoomed.u1 - zoomed.u0))).toBeCloseTo(anchor, 3);
	}
});

test("concurrent calls do not overwrite each other's lane and ancestor expansion is recursive", () => {
	const tracks = nestedTrace().tracks;
	const toolLanes = buildLanes(tracks, new Set()).filter(lane => lane.track.id === "main" && lane.kind === "tool");
	expect(toolLanes).toHaveLength(2);
	expect(toolLanes.flatMap(lane => lane.spans).map(item => item.id)).toEqual(["main:bash1", "main:bash2"]);
	expect(ancestors(tracks, "alpha/nested")).toEqual(["alpha", "main"]);
	const collapsed = new Set(["alpha"]);
	expect(visibleTracks(tracks, collapsed).map(item => item.id)).toEqual(["main", "alpha"]);
	for (const id of ancestors(tracks, "alpha/nested")) collapsed.delete(id);
	expect(visibleTracks(tracks, collapsed)).toHaveLength(3);
	expect(transcriptRows(tracks).find(row => row.span?.entryId === "shared")?.track.file).toBe(ROOT);
	expect(rowForEntry(nestedTrace(), CHILD, "shared")?.span?.label).toBe("Child response");
});

test("nested navigation, search, axis changes and file back preserve selected-span meaning", async () => {
	const controller = createTracesFeature(context());
	await controller.openTrace!(ROOT, "spawn");
	await settle();
	controller.handleInput("\x1b"); // close entry drawer
	controller.handleInput("o"); // reveal child track
	expect(stripTerminalSequences(controller.render(100, 36).join("\n"))).toContain("Selected: alpha · model · Child response");
	controller.handleInput("/");
	controller.handleInput("Nested task");
	controller.handleInput("\r");
	controller.handleInput("o"); // child -> grandchild
	for (const key of ["v", "v", "i", "+", "\x1b[C", "f", "v", "0"]) controller.handleInput(key);
	let lines = controller.render(100, 36);
	expect(stripTerminalSequences(lines.join("\n"))).toContain("Selected: alpha/nested · model · Grandchild response");
	for (const width of [12, 40, 80]) expect(controller.render(width, 24).every(line => visibleWidth(line) <= width)).toBe(true);
	controller.handleInput("O"); // own transcript
	await settle();
	expect(stripTerminalSequences(controller.render(100, 36).join("\n"))).toContain("Selected: main · model · Grandchild response");
	controller.handleInput("b");
	expect(stripTerminalSequences(controller.render(100, 36).join("\n"))).toContain("Selected: alpha/nested · model · Grandchild response");
	controller.handleInput("\r");
	await settle();
	lines = controller.render(100, 36);
	expect(stripTerminalSequences(lines.join("\n"))).toContain(`Entry shared in ${GRANDCHILD}`);
	expect(controller.handleInput("q")).toBe(false);
	expect(controller.handleInput("]")).toBe(false);
	controller.dispose();
});

test("late entry payload cannot replace a newer selected span's journal entry", async () => {
	let resolveOld!: (entry: unknown) => void;
	const old = new Promise<unknown>(resolve => { resolveOld = resolve; });
	const controller = createTracesFeature(context(async (_file, id) => id === "shared" ? old : { message: { content: "CURRENT selected task entry" } }));
	await controller.openTrace!(ROOT, "shared");
	await controller.openTrace!(ROOT, "spawn");
	await settle();
	resolveOld({ message: { content: "OBSOLETE model entry" } });
	await settle();
	const text = stripTerminalSequences(controller.render(100, 36).join("\n"));
	expect(text).toContain("Selected: main · subagent · Agent alpha");
	expect(text).toContain("CURRENT selected task entry");
	expect(text).not.toContain("OBSOLETE model entry");
	controller.dispose();
});

test("overview seeking, range creation and independent edge resizing respect the full domain", () => {
	const scale = buildScale(nestedTrace().tracks, "time", false);
	const initial = { u0: START + 10_000, u1: START + 30_000 };
	expect(overviewViewport(scale, initial, 0.9, null)).toEqual({ u0: START + 89_000, u1: START + 109_000 });
	const range = overviewViewport(scale, initial, 0.8, 0.2);
	expect(range).toEqual({ u0: START + 22_000, u1: START + 88_000 });
	expect(resizeOverview(scale, range, 0.3, "start")).toEqual({ u0: START + 33_000, u1: range.u1 });
	expect(resizeOverview(scale, range, 0.6, "end")).toEqual({ u0: range.u0, u1: START + 66_000 });
	expect(resizeOverview(scale, range, 1, "start")).toEqual({ u0: range.u1 - 10, u1: range.u1 });
	expect(overviewViewport(scale, initial, 0, null)).toEqual({ u0: START, u1: START + 20_000 });
});

test("keyboard minimap creates and seeks a brush without changing the linked selected event", async () => {
	const controller = createTracesFeature(context());
	await controller.openTrace!(ROOT, "spawn");
	controller.handleInput("\x1b");
	controller.handleInput("i"); // real wall time
	controller.handleInput("m");
	controller.handleInput("\x1b[H"); // full-domain start
	controller.handleInput(" ");
	controller.handleInput("\x1b[C");
	controller.handleInput("\x1b[C");
	controller.handleInput("\r");
	let text = stripTerminalSequences(controller.render(110, 45).join("\n"));
	expect(text).toMatch(/Window \+0\.00s → \+11\.0s/);
	expect(text).toContain("Selected: main · subagent · Agent alpha");
	controller.handleInput("\x1b[F");
	controller.handleInput("\r"); // seek to the end, retaining brush width
	text = stripTerminalSequences(controller.render(110, 45).join("\n"));
	expect(text).toMatch(/Window \+99\.0s → \+110\.0s/);
	expect(text).toContain("Selected: main · subagent · Agent alpha");
	controller.handleInput("m");
	controller.handleInput("f"); // linked event still focuses normally
	expect(stripTerminalSequences(controller.render(110, 45).join("\n"))).toContain("Selected: main · subagent · Agent alpha");
	controller.dispose();
});

test("marker-only child tracks remain visible, selectable and inspectable without inventing entries", async () => {
	const trace = nestedTrace();
	const markerTrack = track("marker-child", "main", CHILD, []);
	markerTrack.markers = [{ time: START + 4000, kind: "compaction", label: "Recorded compaction" }];
	trace.tracks = [trace.tracks[0]!, markerTrack, track("empty-child", "main", GRANDCHILD, [])];
	const ctx = context();
	ctx.reader.api = async <T>(path: string): Promise<T> => {
		if (path === "/api/session/trace") return trace as T;
		throw new Error(`Marker inspection must not fetch journal entries: ${path}`);
	};
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT);
	let text = stripTerminalSequences(controller.render(120, 60).join("\n"));
	expect(text).toContain("marker-child [marker-child]");
	expect(text).toContain(glyph(ctx.theme.getSymbolPreset(), "trackMarker"));
	expect(text).toContain("empty-child [empty-child]");
	for (let i = 0; i < 3; i++) controller.handleInput("\x1b[B");
	controller.handleInput("\r");
	await settle();
	text = stripTerminalSequences(controller.render(120, 60).join("\n"));
	expect(text).toContain("compaction · Recorded compaction");
	expect(text).toContain("No journal entry is associated");
	controller.handleInput("j");
	expect(stripTerminalSequences(controller.render(120, 60).join("\n"))).toContain('"kind": "compaction"');
	controller.dispose();
});

test("keyboard hit selection includes the rendered cell of a zero-duration input", async () => {
	const controller = createTracesFeature(context());
	await controller.openTrace!(ROOT, "later");
	controller.handleInput("\x1b");
	controller.handleInput("0");
	for (let i = 0; i < 20; i++) controller.handleInput("h");
	controller.render(100, 40);
	controller.handleInput(" ");
	expect(stripTerminalSequences(controller.render(100, 40).join("\n"))).toContain("Selected: main · turn · First prompt");
	controller.dispose();
});

test("previous search match starts with the last result when current selection is outside results", async () => {
	const controller = createTracesFeature(context());
	await controller.openTrace!(ROOT);
	controller.handleInput("/");
	controller.handleInput("response");
	controller.handleInput("\r");
	await controller.openTrace!(ROOT, "spawn"); // request-origin selection can be outside the active search
	controller.handleInput("\x1b");
	controller.handleInput("N");
	expect(stripTerminalSequences(controller.render(110, 40).join("\n"))).toContain("Selected: main · model · Later response");
	controller.dispose();
});

test("root discovery reveals and searches only actual candidates up to the upstream boundary", async () => {
	const candidates: SessionSummary[] = Array.from({ length: 300 }, (_, index) => ({
		file: `/isolated/sessions/root-${index}.jsonl`, folder: "/isolated/project", title: `Recorded ${index}`,
		startedAt: START - index * 1000, endedAt: START + 1000, requests: 1, toolCalls: 0, subagents: 0,
		totalTokens: index, costTotal: 0, unpricedRequests: 0, models: [index === 250 ? "Rare recorded model" : "Common model"],
	}));
	const ctx = context();
	ctx.reader.api = async <T>(path: string, params?: Record<string, string>): Promise<T> => {
		if (path !== "/api/sessions") throw new Error(`Unexpected root query: ${path}`);
		const limit = Number(params?.limit);
		expect(limit).toBeLessThanOrEqual(300);
		const filtered = params?.q ? candidates.filter(item => item.title!.includes(params.q!)) : candidates;
		return filtered.slice(0, limit) as T;
	};
	const controller = createTracesFeature(ctx);
	await controller.load("all");
	controller.handleInput("+");
	await settle();
	controller.handleInput("/");
	controller.handleInput("Rare recorded model");
	controller.handleInput("\r");
	await settle();
	const text = stripTerminalSequences(controller.render(120, 40).join("\n"));
	expect(text).toContain("Recorded 250");
	expect(text).toContain("1 matching");
	expect(text).toContain("At most 300");

	controller.dispose();
});

test("request-origin back waits for child history and preserves the retained root selection", async () => {
	let returns = 0;
	const ctx = context();
	ctx.backToOrigin = () => { returns++; return true; };
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT, "spawn");
	controller.handleInput("\x1b");
	controller.handleInput("O");
	await settle();
	controller.handleInput("b");
	expect(returns).toBe(0);
	expect(stripTerminalSequences(controller.render(110, 40).join("\n"))).toContain("Selected: main · subagent · Agent alpha");
	controller.handleInput("b");
	expect(returns).toBe(1);
	expect(stripTerminalSequences(controller.render(110, 40).join("\n"))).toContain("Selected: main · subagent · Agent alpha");
	controller.dispose();
});

test("request-linked external traces discard unrelated browser history but retain the linked view on return", async () => {
	let returns = 0;
	const ctx = context();
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT, "spawn");
	controller.handleInput("\x1b");
	controller.handleInput("O");
	await settle();
	ctx.backToOrigin = () => { returns++; return true; };
	await controller.openTrace!(GRANDCHILD);
	const linked = stripTerminalSequences(controller.render(110, 40).join("\n"));
	controller.handleInput("b");
	expect(returns).toBe(1);
	expect(stripTerminalSequences(controller.render(110, 40).join("\n"))).toBe(linked);
	controller.dispose();
});

test("request entries without assembled timing retain their own file identity and copy raw journal data", async () => {
	const copies: string[] = [];
	const ctx = context(async (file, id) => ({ id, file, message: { content: "Recorded unmapped entry" } }));
	ctx.copy = async value => { copies.push(value); };
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT, "unassembled");
	controller.handleInput("j");
	controller.handleInput("y");
	await settle();
	expect(JSON.parse(copies[0]!)).toMatchObject({ id: "unassembled", file: ROOT });
	controller.dispose();
});

test("failed trace reads can retry and older files cannot replace the current child trace", async () => {
	let resolveRoot!: (trace: SessionTrace) => void;
	const pending = new Promise<SessionTrace>(resolve => { resolveRoot = resolve; });
	let failChild = true;
	const ctx = context();
	ctx.reader.api = async <T>(path: string, params?: Record<string, string>): Promise<T> => {
		if (path === "/api/session/trace") {
			if (params?.file === ROOT) return await pending as T;
			if (failChild) throw new Error("Recorded child temporarily unreadable");
			return childTrace(CHILD) as T;
		}
		throw new Error(`Unexpected query: ${path}`);
	};
	const controller = createTracesFeature(ctx);
	const oldLoad = controller.openTrace!(ROOT);
	await controller.openTrace!(CHILD);
	expect(stripTerminalSequences(controller.render(100, 40).join("\n"))).toContain("Recorded child temporarily unreadable");
	failChild = false;
	controller.handleInput("u");
	await settle();
	resolveRoot(nestedTrace());
	await oldLoad;
	const text = stripTerminalSequences(controller.render(100, 40).join("\n"));
	expect(text).toContain("Selected: main · model · Child response");
	expect(text).not.toContain("Recorded nested trace");
	expect(text).not.toContain("temporarily unreadable");
	controller.dispose();
});

test("disposing a trace prevents pending journal responses from repainting or publishing data", async () => {
	let resolveEntry!: (entry: unknown) => void;
	const pending = new Promise<unknown>(resolve => { resolveEntry = resolve; });
	let changes = 0;
	const ctx = context(async () => pending);
	ctx.changed = () => { changes++; };
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT, "shared");
	controller.dispose();
	const before = changes;
	resolveEntry({ message: { content: "Disposed late journal data" } });
	await settle();
	expect(changes).toBe(before);
	expect(stripTerminalSequences(controller.render(100, 40).join("\n"))).not.toContain("Disposed late journal data");
});

test("model detail retains recorded metrics when the span has no resolved model name", async () => {
	const trace = nestedTrace();
	const recorded = trace.tracks[0]!.spans.find(item => item.id === "main:shared")!;
	delete recorded.model;
	recorded.tokens = 321;
	recorded.cost = 0.12;
	const ctx = context();
	const api = ctx.reader.api;
	ctx.reader.api = async <T>(path: string, params?: Record<string, string>): Promise<T> => path === "/api/session/trace" ? trace as T : api<T>(path, params);
	const controller = createTracesFeature(ctx);
	await controller.openTrace!(ROOT, "shared");
	await settle();
	const text = stripTerminalSequences(controller.render(110, 40).join("\n"));
	expect(text).toContain("Tokens: 321");
	expect(text).toContain("$0.12");
	controller.dispose();
});

test("blank Windows root titles stay compact and long wall durations preserve open and copy identity", async () => {
	expect(sessionIdentity("", ROOT, "/isolated/project")).toBe("project · root");
	expect(sessionIdentity("", String.raw`C:\sessions/mixed\root.jsonl`, String.raw`C:\work/project`)).toBe("project · root");
	expect(traceDuration(3_600_000)).toBe("1h 0m");
	expect(traceDuration(null)).not.toBe("0h 0m");
	const sourceFile = String.raw`C:\Users\recorded\omp\sessions\root.jsonl`;
	const project = String.raw`C:\work\project`;
	const wallMs = 2_450_022_700;
	const recorded: SessionSummary = {
		file: sourceFile, folder: project, title: " \t ",
		startedAt: START, endedAt: START + wallMs, requests: 4, toolCalls: 2, subagents: 2,
		totalTokens: 100, costTotal: 0.002, unpricedRequests: 1, models: ["recorded-model"],
	};
	const trace = { ...nestedTrace(), file: sourceFile, cwd: project, title: "   ", summary: { ...nestedTrace().summary, wallMs } };
	const copies: string[] = [];
	const opened: string[] = [];
	const ctx = context();
	ctx.copy = async value => { copies.push(value); };
	ctx.reader.api = async <T>(path: string, params?: Record<string, string>): Promise<T> => {
		if (path === "/api/sessions") return [recorded] as T;
		if (path === "/api/session/trace") { opened.push(params!.file!); return trace as T; }
		throw new Error(`Unexpected fixture query ${path}`);
	};
	const controller = createTracesFeature(ctx);
	await controller.load("all");
	for (const width of [40, 100, 160]) {
		const lines = controller.render(width, 30);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("project · root");
		expect(stripTerminalSequences(lines.join("\n"))).toContain("680h 33m");
	}
	controller.handleInput("y"); await settle();
	expect(JSON.parse(copies[0]!).file).toBe(sourceFile);
	controller.handleInput("\r"); await settle();
	expect(opened).toEqual([sourceFile]);
	for (const width of [40, 100, 160]) {
		const lines = controller.render(width, 30);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(stripTerminalSequences(lines[0]!)).toContain("project · root");
		expect(stripTerminalSequences(lines[0]!)).not.toContain("C:\\Users");
		expect(stripTerminalSequences(lines.join("\n"))).toContain("680h 33m");
	}
	controller.dispose();
});

test("native trace marks match the legend and retain selected backgrounds under every preset", () => {
	const trace = nestedTrace();
	trace.tracks[0]!.markers.push({ time: START + 4000, kind: "compaction", label: "Recorded compaction" });
	const scale = buildScale(trace.tracks, "time", false), viewport = fit(scale);
	for (const preset of ["ascii", "unicode", "nerd"] as const) {
		const colors: string[] = [];
		const nativeTheme = {
			getSymbolPreset: () => preset,
			fg: (token: Parameters<Theme["fg"]>[0], text: string) => { colors.push(token); return theme.fg(token, text); },
			bg: (_token: string, text: string) => `\x1b[44m${text}\x1b[49m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		} as unknown as Theme;
		const options = {
			trace, scale, viewport, collapsed: new Set<string>(), cursor: 0.5, width: 140, height: 80,
			search: "", theme: nativeTheme, overviewCursor: 0.25, overviewAnchor: 0.1,
		};
		const markerLines = renderTimeline({ ...options, selected: "main:marker:0" });
		const plain = markerLines.map(stripTerminalSequences);
		const markers = markerLines.find(line => stripTerminalSequences(line).includes("Markers"))!;
		expect(stripTerminalSequences(markers)).toContain(glyph(preset, "trackMarker"));
		expect(stripTerminalSequences(markers)).toContain(glyph(preset, "rowCursor"));
		expect(markers).toContain("\x1b[44m");
		expect(plain.join("\n")).toContain(`${glyph(preset, "trackMarker")} marker`);
		for (const name of ["Cursor", "Minimap"]) {
			const ruler = plain.find(line => line.startsWith(name))!;
			expect(ruler).toContain(glyph(preset, "axisRule"));
			expect(ruler).toContain(glyph(preset, "playhead"));
		}
		for (const kind of ["turn", "model", "tool", "subagent"] as const) expect(colors).toContain(SPAN_COLORS[kind]);
		const spanLines = renderTimeline({ ...options, selected: "main:later" });
		const selectedLane = spanLines.find(line => stripTerminalSequences(line).includes(`${glyph(preset, "rowCursor")} main model`))!;
		expect(selectedLane).toContain("\x1b[44m");
		expect(stripTerminalSequences(selectedLane).split(glyph(preset, "rowCursor"))).toHaveLength(3);
		for (const width of [40, 100, 160]) {
			expect(renderTimeline({ ...options, selected: "main:marker:0", width }).every(line => visibleWidth(line) <= width)).toBe(true);
		}
	}
});
