import { matchesKey, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatEstimatedCost, formatInteger } from "@oh-my-pi/omp-stats/client/data/formatters";
import type { SessionSummary, SessionTrace, TraceToolStat } from "@oh-my-pi/omp-stats/shared-types";
import type { Range } from "../../data/ranges";
import type { FeatureContext, FeatureController } from "./types";
import { ancestors, buildScale, clampViewport, fit, localWindow, overviewViewport, remapViewport, resizeOverview, revealSpan, rowForEntry, spanCells, transcriptRows, visibleTracks, zoomViewport, type AxisMode, type TraceRow, type TraceScale, type Viewport } from "./traces/model";
import { bounded, clean, renderEntry, renderTimeline, rowLabel, sessionIdentity, traceDuration } from "./traces/render";
import { dashboardPanels, dataTable, emptyState, focusTabs, metricGrid, panel, sectionHeading } from "./presentation";
import { SPAN_COLORS } from "../palette";

type Focus = "timeline" | "transcript" | "tools" | "children" | "minimap";
type SessionSort = "started" | "title" | "duration" | "requests" | "tools" | "agents" | "tokens" | "cost";
type ToolSort = "total" | "tool" | "calls" | "errors" | "average" | "max";
const SESSION_SORTS: readonly SessionSort[] = ["started", "title", "duration", "requests", "tools", "agents", "tokens", "cost"];
const TOOL_SORTS: readonly ToolSort[] = ["total", "tool", "calls", "errors", "average", "max"];
const FOCI: readonly Focus[] = ["timeline", "transcript", "tools", "children", "minimap"];
interface ViewState {
	file: string; trace: SessionTrace | null; scale: TraceScale; viewport: Viewport; mode: AxisMode;
	compress: boolean; selected: string | null; collapsed: Set<string>; cursor: number; focus: Focus;
	search: string; toolFilter: string | null; toolSelected: string | null; childSelected: string | null;
	overviewCursor: number; overviewAnchor: number | null;
}

export function createTracesFeature(ctx: FeatureContext): FeatureController {
	let closed = false, generation = 0, entryGeneration = 0;
	let loading = false, error: string | null = null, notice = "";
	let sessions: SessionSummary[] = [], listSearch = "", sessionSelected: string | null = null;
	let sessionsLoaded = false;
	let listLimit = 200, revealed = 50, listSort: SessionSort = "started", listDescending = true;
	let toolSort: ToolSort = "total", toolDescending = true;
	let state: ViewState | null = null;
	const history: ViewState[] = [];
	let editing: "sessions" | "spans" | null = null, draft = "";
	let detail = false, raw = false, entry: unknown = null, entryLoading = false, entryError: string | null = null;
	let timelinePlotWidth = 1;
	let unmappedTarget: { file: string; id: string } | null = null;

	function changed(): void { if (!closed) ctx.changed(); }
	function rows(): TraceRow[] {
		if (!state?.trace) return [];
		const needle = state.search.trim().toLowerCase();
		return transcriptRows(state.trace.tracks).filter(row =>
			(!needle || `${row.span?.label ?? row.marker?.label} ${row.span?.detail ?? ""} ${row.track.label}`.toLowerCase().includes(needle)) &&
			(!state?.toolFilter || row.span?.kind === "tool" && row.span.label === state.toolFilter));
	}
	function selectedRow(): TraceRow | undefined {
		return state?.trace ? transcriptRows(state.trace.tracks).find(row => row.key === state?.selected) : undefined;
	}
	function sortedSessions(): SessionSummary[] {
		const needle = listSearch.trim().toLowerCase();
		const value = (row: SessionSummary): string | number => {
			switch (listSort) {
				case "title": return sessionIdentity(row.title, row.file, row.folder).toLowerCase();
				case "duration": return row.endedAt - row.startedAt;
				case "requests": return row.requests;
				case "tools": return row.toolCalls;
				case "agents": return row.subagents;
				case "tokens": return row.totalTokens;
				case "cost": return row.costTotal;
				default: return row.startedAt;
			}
		};
		return sessions.filter(row => !needle || `${row.title ?? ""} ${row.folder} ${row.file.split(/[\\/]/).pop()} ${row.models.join(" ")}`.toLowerCase().includes(needle))
			.sort((a, b) => {
				const av = value(a), bv = value(b);
				const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
				return (listDescending ? -result : result) || a.file.localeCompare(b.file);
			});
	}
	function sortedTools(): TraceToolStat[] {
		const value = (row: TraceToolStat): string | number => {
			switch (toolSort) {
				case "tool": return row.tool;
				case "calls": return row.calls;
				case "errors": return row.errors;
				case "average": return row.calls ? row.totalMs / row.calls : 0;
				case "max": return row.maxMs;
				default: return row.totalMs;
			}
		};
		return [...(state?.trace?.summary.toolStats ?? [])].sort((a, b) => {
			const av = value(a), bv = value(b);
			const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
			return (toolDescending ? -result : result) || a.tool.localeCompare(b.tool);
		});
	}
	function resetEntry(): void {
		entryGeneration++;
		entry = null;
		entryLoading = false;
		entryError = null;
		raw = false;
	}
	async function loadEntry(row: TraceRow | null, target?: { file: string; id: string }): Promise<void> {
		resetEntry();
		const request = target ?? (row?.span?.entryId ? { file: row.track.file, id: row.span.entryId } : null);
		if (!request) { changed(); return; }
		const id = ++entryGeneration, view = state, selection = state?.selected;
		entryLoading = true;
		changed();
		try {
			const response = await ctx.reader.api<{ entry: unknown }>("/api/session/entry", request);
			if (closed || id !== entryGeneration || state !== view || state?.selected !== selection) return;
			entry = response.entry;
		} catch (cause) {
			if (closed || id !== entryGeneration || state !== view) return;
			entryError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (!closed && id === entryGeneration && state === view) { entryLoading = false; changed(); }
		}
	}
	function select(row: TraceRow, open = false): void {
		if (!state?.trace) return;
		unmappedTarget = null;
		state.selected = row.key;
		for (const id of ancestors(state.trace.tracks, row.track.id)) state.collapsed.delete(id);
		if (row.span) state.viewport = revealSpan(state.scale, state.viewport, row.span);
		else {
			const u = state.scale.toU(row.time), size = state.viewport.u1 - state.viewport.u0;
			if (u < state.viewport.u0 || u > state.viewport.u1) state.viewport = clampViewport(state.scale, { u0: u - size / 2, u1: u + size / 2 });
		}
		const u = state.scale.toU(row.span ? (row.span.start + row.span.end) / 2 : row.time);
		state.cursor = Math.max(0, Math.min(1, (u - state.viewport.u0) / (state.viewport.u1 - state.viewport.u0)));
		resetEntry();
		detail = open;
		if (open) void loadEntry(row);
		changed();
	}
	async function loadSessions(): Promise<void> {
		const id = ++generation;
		loading = true; error = null; changed();
		try {
			// Upstream q omits model names; retain unfiltered candidates for the web's model search.
			const queries = [ctx.reader.api<SessionSummary[]>("/api/sessions", { limit: String(listLimit) })];
			if (listSearch) queries.push(ctx.reader.api<SessionSummary[]>("/api/sessions", { limit: String(listLimit), q: listSearch }));
			const responses = await Promise.all(queries);
			if (closed || id !== generation || state) return;
			const byFile = new Map<string, SessionSummary>();
			for (const response of responses) for (const row of response) byFile.set(row.file, row);
			sessions = [...byFile.values()];
			sessionsLoaded = true;
			const visible = sortedSessions();
			if (!visible.some(row => row.file === sessionSelected)) sessionSelected = visible[0]?.file ?? null;
		} catch (cause) {
			if (!closed && id === generation) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (!closed && id === generation) { loading = false; changed(); }
		}
	}
	async function loadTrace(view: ViewState, entryId?: string, requestedFile = view.file): Promise<void> {
		const id = ++generation;
		loading = true; error = null; changed();
		try {
			const trace = await ctx.reader.api<SessionTrace>("/api/session/trace", { file: view.file });
			if (closed || id !== generation || state !== view) return;
			const previous = view.scale;
			view.scale = buildScale(trace.tracks, view.mode, view.compress);
			view.viewport = view.trace ? remapViewport(previous, view.scale, view.viewport) : fit(view.scale);
			const firstLoad = !view.trace;
			view.trace = trace;
			if (firstLoad) for (const track of trace.tracks) if (track.parentId) view.collapsed.add(track.id);
			const all = transcriptRows(trace.tracks);
			const requested = entryId ? rowForEntry(trace, requestedFile, entryId) : undefined;
			const retained = all.find(row => row.key === view.selected);
			if (requested) select(requested, true);
			else if (!retained) {
				view.selected = all[0]?.key ?? null;
				resetEntry(); detail = false;
			}
			if (entryId && !requested) {
				notice = `Entry ${entryId} has no assembled span; timing is unavailable.`;
				unmappedTarget = { file: requestedFile, id: entryId };
				detail = true;
				await loadEntry(null, unmappedTarget);
			} else if (unmappedTarget && detail && !entryId) {
				void loadEntry(null, unmappedTarget);
			} else if (retained && detail && !entryId) void loadEntry(retained);
			view.toolSelected ??= trace.summary.toolStats[0]?.tool ?? null;
			view.childSelected ??= trace.tracks.find(track => track.parentId)?.id ?? trace.tracks[0]?.id ?? null;
		} catch (cause) {
			if (!closed && id === generation && state === view) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (!closed && id === generation && state === view) { loading = false; changed(); }
		}
	}
	async function openTrace(file: string, entryId?: string, recordHistory = true): Promise<void> {
		if (closed) return;
		if (state?.file === file) { await loadTrace(state, entryId, file); return; }
		if (state && recordHistory) history.push({ ...state, collapsed: new Set(state.collapsed) });
		resetEntry(); detail = false; notice = ""; editing = null; unmappedTarget = null;
		const scale = buildScale([], "time", true);
		state = { file, trace: null, scale, viewport: fit(scale), mode: "time", compress: true, selected: null,
			collapsed: new Set(), cursor: 0.5, focus: "timeline", search: "", toolFilter: null, toolSelected: null, childSelected: null,
			overviewCursor: 0.5, overviewAnchor: null };
		await loadTrace(state, entryId, file);
	}
	function back(): void {
		if (!history.length && ctx.backToOrigin?.()) return;
		generation++; loading = false; error = null; resetEntry(); detail = false; notice = ""; unmappedTarget = null;
		state = history.pop() ?? null;
		if (!state && !sessions.length) void loadSessions();
		changed();
	}
	function cycleMatch(direction: number): void {
		const matches = rows().filter(row => row.span);
		if (!matches.length) { notice = "No matching spans."; changed(); return; }
		const current = matches.findIndex(row => row.key === state?.selected);
		const next = current < 0 ? (direction > 0 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length;
		select(matches[next]!);
	}
	function changeAxis(mode: AxisMode, compress: boolean): void {
		if (!state?.trace) return;
		const next = buildScale(state.trace.tracks, mode, compress);
		const cursorTime = state.scale.toT(state.viewport.u0 + state.cursor * (state.viewport.u1 - state.viewport.u0));
		const [oldStart, oldEnd] = state.scale.domain;
		const overviewTime = state.scale.toT(oldStart + state.overviewCursor * (oldEnd - oldStart));
		const anchorTime = state.overviewAnchor === null ? null : state.scale.toT(oldStart + state.overviewAnchor * (oldEnd - oldStart));
		state.viewport = remapViewport(state.scale, next, state.viewport);
		state.scale = next; state.mode = mode; state.compress = compress;
		state.cursor = Math.max(0, Math.min(1, (next.toU(cursorTime) - state.viewport.u0) / (state.viewport.u1 - state.viewport.u0)));
		const [start, end] = next.domain;
		state.overviewCursor = Math.max(0, Math.min(1, (next.toU(overviewTime) - start) / (end - start)));
		state.overviewAnchor = anchorTime === null ? null : Math.max(0, Math.min(1, (next.toU(anchorTime) - start) / (end - start)));
		changed();
	}
	function childAction(openFile: boolean): void {
		if (!state?.trace) return;
		const selected = selectedRow();
		const id = state.focus === "children" ? state.childSelected : selected?.span?.childTrackId ?? selected?.track.id;
		const track = state.trace.tracks.find(item => item.id === id);
		if (!track) { notice = "Select a child track or agent span first."; changed(); return; }
		if (openFile) { void openTrace(track.file); return; }
		for (const ancestor of ancestors(state.trace.tracks, track.id)) state.collapsed.delete(ancestor);
		const first = transcriptRows([track])[0];
		if (first) { state.toolFilter = null; state.search = ""; state.focus = "timeline"; select(first); }
		else { notice = "This child has no recorded spans or markers."; changed(); }
	}
	async function copySelection(): Promise<void> {
		const id = entryGeneration, view = state;
		const row = selectedRow();
		const value = detail ? entry ?? (unmappedTarget ? undefined : row?.span ?? row?.marker) : row?.span ?? row?.marker ?? state?.trace ?? sessions.find(item => item.file === sessionSelected);
		if (entryLoading) { notice = "Entry is still loading; wait before copying its JSON."; changed(); return; }
		if (!value) { notice = "Nothing selected to copy."; changed(); return; }
		try {
			await ctx.copy(JSON.stringify(value, null, 2));
			if (!closed && state === view && id === entryGeneration) notice = "Copied JSON.";
		} catch (cause) {
			if (!closed && state === view && id === entryGeneration) notice = `Clipboard failed: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
		changed();
	}

	return {
		async load(_range: Range) { if (closed) return; if (state) await loadTrace(state); else await loadSessions(); },
		get inputMode() { return editing ? "text" as const : "navigation" as const; },
		openTrace(file, entryId) {
			// External request links start a new navigation chain, not browser history.
			history.length = 0;
			return openTrace(file, entryId, false);
		},
		dispose() { closed = true; generation++; entryGeneration++; history.length = 0; },
		render(width, height) {
			const w = Math.max(1, width);
			const lines: string[] = [];
			const add = (text: string) => lines.push(...wrapTextWithAnsi(text, w));
			const hint = (text: string) => add(ctx.theme.fg("muted", text));
			if (notice) add(ctx.theme.fg("warning", clean(notice)));
			if (error) add(ctx.theme.fg("error", `Trace read failed: ${clean(error)} · u retry`));
			if (loading) hint(state?.trace || sessions.length ? "Refreshing recorded data…" : "Loading recorded data…");
			if (editing) add(ctx.theme.fg("accent", `Search: ${clean(draft)}_ · Enter apply · Esc cancel`));
			if (!state) {
				const all = sortedSessions();
				const selectedIndex = all.findIndex(row => row.file === sessionSelected);
				if (selectedIndex >= revealed) revealed = Math.ceil((selectedIndex + 1) / 50) * 50;
				const shown = all.slice(0, revealed);
				let index = shown.findIndex(row => row.file === sessionSelected);
				if (index < 0 && shown.length) { sessionSelected = shown[0]!.file; index = 0; }
				const totals = all.reduce((sum, row) => ({
					requests: sum.requests + row.requests, children: sum.children + row.subagents,
					cost: sum.cost + row.costTotal, unpriced: sum.unpriced + row.unpricedRequests,
				}), { requests: 0, children: 0, cost: 0, unpriced: 0 });
				lines.push(sectionHeading(ctx, w, "Root sessions", "all recorded dates", true));
				lines.push(...metricGrid(ctx, w, [
					{ label: "Sessions", value: sessionsLoaded ? formatInteger(all.length) : "–", hint: sessionsLoaded ? `${sessions.length} fetched candidates` : "recorded candidates pending", emphasis: "primary" },
					{ label: "Requests", value: sessionsLoaded ? formatInteger(totals.requests) : "–", hint: sessionsLoaded ? `${totals.children} children included` : "waiting for recorded totals" },
					{ label: "Cost", value: sessionsLoaded ? formatEstimatedCost(totals.cost, totals.unpriced) : "–", hint: "matching candidates only" },
				]));
				hint(`At most 300 recent root candidates · ${Math.min(revealed, all.length)} revealed · ${all.length} matching · ${listSort} ${listDescending ? "↓" : "↑"}`);
				if (listSearch) add(`Filter: ${clean(listSearch)} · x clear`);
				const window = localWindow(shown, Math.max(0, index), Math.max(3, height - lines.length - 7));
				const selected = all.find(row => row.file === sessionSelected);
				lines.push(...dashboardPanels(ctx, w, [
					{
						title: "Recorded sessions", meta: "↑/↓ select · Enter open", active: true,
						render: innerWidth => all.length ? dataTable(ctx, innerWidth, "", [
							{ key: "identity", header: "Session", align: "left" },
							{ key: "requests", header: "Req", align: "right" },
							{ key: "duration", header: "Wall", align: "right", priority: 1 },
							{ key: "cost", header: "Cost", align: "right", priority: 2 },
							{ key: "children", header: "Child", align: "right", priority: 3 },
						], window.rows.map(row => ({
							identity: sessionIdentity(row.title, row.file, row.folder), requests: formatInteger(row.requests),
							duration: traceDuration(row.endedAt - row.startedAt), cost: formatEstimatedCost(row.costTotal, row.unpricedRequests),
							children: formatInteger(row.subagents),
						})), index - window.offset) : emptyState(ctx, innerWidth, loading ? "Reading recorded sessions" : error ? "Sessions unavailable" : listSearch ? "No matching sessions" : "No indexed root sessions",
							loading ? "The recorded session index is loading." : error ? "The recorded index could not be read." : listSearch ? "No recorded candidates match this search." : "Sync recorded transcripts to populate this index.",
							loading ? undefined : error ? "u retry" : listSearch ? "x clear search" : "s sync"),
					},
					{
						title: "Selected session", meta: selected ? "recorded identity" : "selection context",
						render: innerWidth => selected ? [
							ctx.theme.bold(ctx.theme.fg("text", sessionIdentity(selected.title, selected.file, selected.folder))),
							"",
							`Wall ${traceDuration(selected.endedAt - selected.startedAt)} · ${formatInteger(selected.requests)} requests`,
							`${formatInteger(selected.toolCalls)} tools · ${formatInteger(selected.subagents)} child agents`,
							`${formatInteger(selected.totalTokens)} tokens · ${formatEstimatedCost(selected.costTotal, selected.unpricedRequests)} · ${selected.unpricedRequests} unpriced`,
							"",
							ctx.theme.fg("muted", `Started ${new Date(selected.startedAt).toISOString()}`),
							ctx.theme.fg("muted", `Project: ${clean(selected.folder)}`),
							ctx.theme.fg("text", `Models: ${clean(selected.models.join(", ") || "no recorded models")}`),
							"",
							ctx.theme.fg("muted", `File: ${clean(selected.file)}`),
						].flatMap(line => wrapTextWithAnsi(line, innerWidth)) : emptyState(ctx, innerWidth, "No session selected", "Select a recorded session to inspect its duration, models and source journal."),
					},
				]));
				hint("/ search · o sort · D reverse · l reveal · + fetch · y copy · u refresh");
				return bounded(lines, w);
			}
			lines.push(sectionHeading(ctx, w, sessionIdentity(state.trace?.title, state.file, state.trace?.cwd), history.length ? `nested ${history.length} · b back` : "b back", true));
			const trace = state.trace;
			if (!trace) return bounded(lines, w);
			const summary = trace.summary;
			lines.push(...metricGrid(ctx, w, [
				{ label: "Wall time", value: traceDuration(summary.wallMs), hint: `${summary.turns} turns · ${summary.subagents} agents`, emphasis: "primary" },
				{ label: "Requests", value: formatInteger(summary.requests), hint: `${summary.toolCalls} tools · ${formatInteger(summary.totalTokens)} tok` },
				{ label: "Cost", value: formatEstimatedCost(summary.costTotal, summary.unpricedRequests), hint: `${summary.unpricedRequests} unpriced` },
			]));
			hint(`Model ${traceDuration(summary.modelMs)} · Tool ${traceDuration(summary.toolMs)} · Idle ${traceDuration(summary.idleMs)}`);
			lines.push(...focusTabs(ctx, w, ["Timeline", "Events", "Tools", "Tracks", "Minimap"], FOCI.indexOf(state.focus)));
			const selected = selectedRow();
			if (selected) add(ctx.theme.bold(ctx.theme.fg(selected.span?.isError ? "error" : selected.span ? SPAN_COLORS[selected.span.kind] : "text", clean(`Selected: ${rowLabel(selected, trace.startedAt)}`))));
			if (state.search || state.toolFilter) add(`Search: ${clean(state.search) || "all"} · ${rows().filter(row => row.span).length} spans · Tool: ${clean(state.toolFilter) || "all"} · x clear`);
			if (detail && (selected || unmappedTarget)) {
				hint("Esc trace · j raw JSON · y copy · o child · O child file");
				if (unmappedTarget) add(clean(`Journal entry ${unmappedTarget.id} · ${unmappedTarget.file} · no recorded span timing`));
				lines.push(...panel(ctx, w, "Journal entry", renderEntry(unmappedTarget ? null : selected ?? null, entry, entryLoading, entryError, raw, Math.max(1, w - 4), ctx.theme), { meta: raw ? "raw JSON visible" : "recorded content", active: true }));
				return bounded(lines, w);
			}
			if (state.focus === "timeline" || state.focus === "minimap") {
				timelinePlotWidth = Math.max(1, w - Math.min(22, Math.max(4, Math.floor(w * 0.27))) - 1);
				hint(state.focus === "minimap"
					? w < 60 ? "←/→ seek · Space anchor · Enter apply · m back" : "←/→ seek · Space anchor · Enter apply · h/l edges · a/d brush · +/- zoom · m timeline"
					: w < 60 ? "↑/↓ select · Space pick · Enter inspect · Tab panes"
						: `Tab panes · / search · n/N matches · +/- zoom · ←/→ pan · Space pick · f focus · m minimap · v ${state.mode} · i idle ${state.compress ? "compressed" : "real"}`);
				if (state.focus === "minimap") hint(`Overview ${(state.overviewCursor * 100).toFixed(0)}%${state.overviewAnchor === null ? "" : ` · anchor ${(state.overviewAnchor * 100).toFixed(0)}%`}`);
				lines.push(...renderTimeline({ trace, scale: state.scale, viewport: state.viewport, collapsed: state.collapsed, selected: state.selected, cursor: state.cursor, width: w, height: Math.max(8, height - lines.length), search: state.search, theme: ctx.theme,
					overviewCursor: state.focus === "minimap" ? state.overviewCursor : null, overviewAnchor: state.overviewAnchor }));
			} else if (state.focus === "transcript") {
				const all = rows(), index = all.findIndex(row => row.key === state?.selected);
				const window = localWindow(all, Math.max(0, index), Math.max(3, height - lines.length - 3));
				hint(`${all.length} linked events + markers · / search · n/N matches · Enter inspect · o child`);
				lines.push(...dataTable(ctx, w, "", [
					{ key: "event", header: "Event", align: "left" }, { key: "at", header: "At", align: "right" },
					{ key: "duration", header: "Wall", align: "right", priority: 1 }, { key: "track", header: "Track", align: "left", priority: 2 },
				], window.rows.map(row => ({
					event: ctx.theme.fg(row.span?.isError ? "error" : row.span ? SPAN_COLORS[row.span.kind] : "muted", clean(`${row.span?.isError ? "ERROR · " : ""}${row.span?.label ?? row.marker?.label}${row.span?.unterminated ? " · pending" : ""}`)),
					at: `+${traceDuration(row.time - trace.startedAt)}`, duration: row.span ? traceDuration(row.span.end - row.span.start) : "–", track: clean(row.track.id),
				})), index - window.offset));
				if (!all.length) add("No matching transcript events.");
			} else if (state.focus === "tools") {
				const tools = sortedTools();
				if (!tools.some(tool => tool.tool === state?.toolSelected)) state.toolSelected = tools[0]?.tool ?? null;
				const index = tools.findIndex(tool => tool.tool === state?.toolSelected);
				const window = localWindow(tools, index, Math.max(3, height - lines.length - 6));
				hint(`Per-tool duration · ${toolSort} ${toolDescending ? "↓" : "↑"} · o sort · D reverse · Enter linked calls`);
				lines.push(...dataTable(ctx, w, "", [
					{ key: "tool", header: "Tool", align: "left" }, { key: "total", header: "Total", align: "right" },
					{ key: "calls", header: "Calls", align: "right", priority: 1 }, { key: "errors", header: "Errors", align: "right", priority: 2 },
					{ key: "average", header: "Avg", align: "right", priority: 3 }, { key: "max", header: "Max", align: "right", priority: 4 },
				], window.rows.map(tool => ({
					tool: clean(tool.tool), total: traceDuration(tool.totalMs), calls: formatInteger(tool.calls), errors: formatInteger(tool.errors),
					average: traceDuration(tool.calls ? tool.totalMs / tool.calls : 0), max: traceDuration(tool.maxMs),
				})), index - window.offset));
				const tool = tools[index];
				if (tool) add(clean(`${tool.tool} · ${tool.calls} calls · ${tool.errors} errors · avg ${traceDuration(tool.calls ? tool.totalMs / tool.calls : 0)} · max ${traceDuration(tool.maxMs)}`));
				if (!tools.length) add("No recorded tool calls.");
			} else {
				const tracks = trace.tracks;
				if (!tracks.some(track => track.id === state?.childSelected)) state.childSelected = tracks.find(track => track.parentId)?.id ?? tracks[0]?.id ?? null;
				const index = tracks.findIndex(track => track.id === state?.childSelected);
				const window = localWindow(tracks, index, Math.max(3, height - lines.length - 6));
				hint("Track tree · ↑/↓ select · Enter reveal · O transcript · c collapse");
				lines.push(...dataTable(ctx, w, "", [
					{ key: "track", header: "Track", align: "left" }, { key: "requests", header: "Req", align: "right" },
					{ key: "tools", header: "Tools", align: "right", priority: 1 }, { key: "time", header: "Span sum", align: "right", priority: 2 },
				], window.rows.map(track => ({
					track: clean(`${"  ".repeat(ancestors(tracks, track.id).length)}${state!.collapsed.has(track.id) ? "+" : "−"} ${track.label || track.id} [${track.id}]`),
					requests: formatInteger(track.spans.filter(span => span.kind === "model").length), tools: formatInteger(track.spans.filter(span => span.kind === "tool").length),
					time: traceDuration(track.spans.reduce((sum, span) => sum + span.end - span.start, 0)),
				})), index - window.offset));
				const track = tracks[index];
				if (track) {
					add(clean(`Agent: ${track.agent ?? "main"} · Model: ${track.model ?? "unknown"} · ${track.spans.filter(span => span.isError).length} failed spans · ${track.markers.length} markers`));
					hint(clean(`File: ${track.file}`));
				}
			}
			return bounded(lines, w);
		},
		handleInput(data) {
			// Printable query characters belong to search; control navigation still passes through.
			if (closed || !editing && (data === "q" || data === "[" || data === "]") ||
				data === "\x0e" || data === "\x10") return false;
			if (editing) {
				if (matchesKey(data, "escape")) { editing = null; changed(); return true; }
				if (matchesKey(data, "enter")) {
					if (editing === "sessions") { listSearch = draft.trim(); revealed = 50; sessionSelected = null; editing = null; void loadSessions(); }
					else { if (state) { state.search = draft.trim(); state.toolFilter = null; } editing = null; cycleMatch(1); }
					return true;
				}
				if (matchesKey(data, "backspace")) draft = Array.from(draft).slice(0, -1).join("");
				else if (data === "\x15") draft = "";
				else if (!/[\x00-\x1f\x7f]/.test(data)) draft += clean(data);
				else return false;
				changed(); return true;
			}
			if (data === "r" || data === "R" || data === "s") return false;
			if (data === "/") { editing = state ? "spans" : "sessions"; draft = state?.search ?? listSearch; changed(); return true; }
			if (data === "u") { if (state) void loadTrace(state); else void loadSessions(); return true; }
			if (data === "y") { void copySelection(); return true; }
			if (!state) {
				const all = sortedSessions().slice(0, revealed);
				if (matchesKey(data, "up") || matchesKey(data, "down")) {
					const index = all.findIndex(row => row.file === sessionSelected);
					sessionSelected = all[Math.max(0, Math.min(all.length - 1, index + (matchesKey(data, "up") ? -1 : 1)))]?.file ?? null;
				} else if (matchesKey(data, "enter")) { if (sessionSelected) void openTrace(sessionSelected); }
				else if (data === "o") listSort = SESSION_SORTS[(SESSION_SORTS.indexOf(listSort) + 1) % SESSION_SORTS.length]!;
				else if (data === "D") listDescending = !listDescending;
				else if (data === "l") revealed += 50;
				else if (data === "+" || data === "=") { listLimit = 300; revealed = listLimit; void loadSessions(); }
				else if (data === "x") { listSearch = ""; void loadSessions(); }
				else return false;
				changed(); return true;
			}
			if (matchesKey(data, "escape")) {
				if (detail) { detail = false; resetEntry(); unmappedTarget = null; }
				else if (state.focus === "minimap" && state.overviewAnchor !== null) state.overviewAnchor = null;
				else if (state.search || state.toolFilter) { state.search = ""; state.toolFilter = null; }
				else back();
				changed(); return true;
			}
			if (data === "b") { back(); return true; }
			if (data === "x") { state.search = ""; state.toolFilter = null; changed(); return true; }
			if (data === "n" || data === "N") { cycleMatch(data === "n" ? 1 : -1); return true; }
			if (data === "o" && (detail || state.focus !== "tools")) { childAction(false); return true; }
			if (data === "O") { childAction(true); return true; }
			if (detail) {
				if (data === "j") { raw = !raw; changed(); return true; }
				return false;
			}
			if (matchesKey(data, "tab") || data === "\x1b[Z") {
				const direction = data === "\x1b[Z" ? -1 : 1;
				state.focus = FOCI[(FOCI.indexOf(state.focus) + direction + FOCI.length) % FOCI.length]!;
				changed(); return true;
			}
			if (data === "m") {
				if (state.focus === "minimap") { state.focus = "timeline"; state.overviewAnchor = null; }
				else {
					state.focus = "minimap";
					const [start, end] = state.scale.domain;
					state.overviewCursor = ((state.viewport.u0 + state.viewport.u1) / 2 - start) / (end - start);
				}
				changed(); return true;
			}
			if (state.focus === "minimap") {
				if (matchesKey(data, "left") || matchesKey(data, "right")) state.overviewCursor = Math.max(0, Math.min(1, state.overviewCursor + (matchesKey(data, "left") ? -0.05 : 0.05)));
				else if (matchesKey(data, "home") || matchesKey(data, "end")) state.overviewCursor = matchesKey(data, "home") ? 0 : 1;
				else if (data === " ") state.overviewAnchor = state.overviewCursor;
				else if (matchesKey(data, "enter")) {
					state.viewport = overviewViewport(state.scale, state.viewport, state.overviewCursor, state.overviewAnchor);
					state.overviewAnchor = null;
				} else if (data === "h" || data === "l") state.viewport = resizeOverview(state.scale, state.viewport, state.overviewCursor, data === "h" ? "start" : "end");
				else if (data === "a" || data === "d") {
					const [start, end] = state.scale.domain;
					const shift = (end - start) * (data === "a" ? -0.05 : 0.05);
					state.viewport = clampViewport(state.scale, { u0: state.viewport.u0 + shift, u1: state.viewport.u1 + shift });
				} else if (data === "+" || data === "=" || data === "-") state.viewport = zoomViewport(state.scale, state.viewport, data === "-" ? 1.5 : 1 / 1.5, 0.5);
				else if (data === "0") { state.viewport = fit(state.scale); state.overviewAnchor = null; }
				else if (data === "v") { const modes: readonly AxisMode[] = ["time", "turns", "calls"]; changeAxis(modes[(modes.indexOf(state.mode) + 1) % modes.length]!, state.compress); return true; }
				else if (data === "i") { changeAxis(state.mode, !state.compress); return true; }
				else return false;
				changed(); return true;
			}
			if (data === "c" || data === "C" || data === "E") {
				if (data === "E") state.collapsed.clear();
				else if (data === "C") state.collapsed = new Set(state.trace?.tracks.filter(track => track.parentId).map(track => track.id));
				else {
					const id = state.focus === "children" ? state.childSelected : selectedRow()?.track.id;
					if (id) { if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id); }
				}
				changed(); return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const direction = matchesKey(data, "up") ? -1 : 1;
				if (state.focus === "tools") {
					const tools = sortedTools(), index = tools.findIndex(tool => tool.tool === state?.toolSelected);
					state.toolSelected = tools[Math.max(0, Math.min(tools.length - 1, index + direction))]?.tool ?? null;
				} else if (state.focus === "children") {
					const tracks = state.trace?.tracks ?? [], index = tracks.findIndex(track => track.id === state?.childSelected);
					state.childSelected = tracks[Math.max(0, Math.min(tracks.length - 1, index + direction))]?.id ?? null;
				} else {
					const all = rows(), index = all.findIndex(row => row.key === state?.selected);
					const next = all[Math.max(0, Math.min(all.length - 1, index + direction))];
					if (next) select(next);
				}
				changed(); return true;
			}
			if (matchesKey(data, "enter")) {
				if (state.focus === "tools") {
					state.toolFilter = state.toolSelected ?? sortedTools()[0]?.tool ?? null; state.search = ""; state.focus = "transcript";
					const first = rows()[0]; if (first) select(first);
				} else if (state.focus === "children") childAction(false);
				else { const selected = selectedRow(); if (selected) select(selected, true); }
				changed(); return true;
			}
			if (state.focus === "tools") {
				if (data === "o") toolSort = TOOL_SORTS[(TOOL_SORTS.indexOf(toolSort) + 1) % TOOL_SORTS.length]!;
				else if (data === "D") toolDescending = !toolDescending;
				else return false;
				changed(); return true;
			}
			if (state.focus !== "timeline") return false;
			if (data === "v") { const modes: readonly AxisMode[] = ["time", "turns", "calls"]; changeAxis(modes[(modes.indexOf(state.mode) + 1) % modes.length]!, state.compress); return true; }
			if (data === "i") { changeAxis(state.mode, !state.compress); return true; }
			if (data === "+" || data === "=" || data === "w" || data === "-" || data === "S") state.viewport = zoomViewport(state.scale, state.viewport, data === "-" || data === "S" ? 1.5 : 1 / 1.5, state.cursor);
			else if (matchesKey(data, "left") || matchesKey(data, "right") || data === "a" || data === "d") {
				const shift = (state.viewport.u1 - state.viewport.u0) * 0.2 * (matchesKey(data, "left") || data === "a" ? -1 : 1);
				state.viewport = clampViewport(state.scale, { u0: state.viewport.u0 + shift, u1: state.viewport.u1 + shift });
			} else if (data === "h" || data === "l") state.cursor = Math.max(0, Math.min(1, state.cursor + (data === "h" ? -0.05 : 0.05)));
			else if (data === "0") state.viewport = fit(state.scale);
			else if (data === "f") { const selected = selectedRow(); if (selected?.span) state.viewport = revealSpan(state.scale, state.viewport, selected.span, true); }
			else if (data === " ") {
				const x = Math.min(timelinePlotWidth - 1, Math.floor(state.cursor * (timelinePlotWidth - 1)));
				const track = selectedRow()?.track.id;
				const visible = new Set(visibleTracks(state.trace?.tracks ?? [], state.collapsed).map(item => item.id));
				const candidates = rows().filter(row => {
					if (!visible.has(row.track.id)) return false;
					if (row.span) {
						const bounds = spanCells(state!.scale, state!.viewport, row.span, timelinePlotWidth);
						return !!bounds && x >= bounds[0] && x < bounds[1];
					}
					const u = state!.scale.toU(row.time);
					return u >= state!.viewport.u0 && u <= state!.viewport.u1 &&
						Math.min(timelinePlotWidth - 1, Math.floor((u - state!.viewport.u0) / (state!.viewport.u1 - state!.viewport.u0) * timelinePlotWidth)) === x;
				});
				const selected = candidates.find(row => row.track.id === track) ?? candidates[0];
				if (selected) select(selected); else { notice = "No event under the keyboard cursor; ↑/↓ selects neighbouring events."; }
			} else return false;
			changed(); return true;
		},
	};
}
