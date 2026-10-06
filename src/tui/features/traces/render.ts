import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { formatDurationMs, formatInteger, formatEstimatedCost } from "@oh-my-pi/omp-stats/client/data/formatters";
import type { SessionTrace, TraceTrack } from "@oh-my-pi/omp-stats/shared-types";
import { ancestors, buildLanes, KINDS, localWindow, MARKS, spanCells, visibleTracks, type Lane, type TraceRow, type TraceScale, type Viewport } from "./model";

import { SPAN_COLORS, SELECTION_BG } from "../../palette";
import { glyph } from "../../glyphs";
export function clean(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
export function bounded(lines: readonly string[], width: number): string[] {
	return lines.map(line => truncateToWidth(line, Math.max(1, width)));
}
/** Long recorded histories remain legible without losing sub-hour precision. */
export function traceDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || Math.abs(ms) < 3_600_000) return formatDurationMs(ms);
	const minutes = Math.floor(Math.abs(ms) / 60_000);
	return `${ms < 0 ? "−" : ""}${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** Empty transcript titles retain their recorded project and file identity. */
export function sessionIdentity(title: string | null | undefined, file: string, project?: string | null): string {
	const recorded = clean(title).trim();
	if (recorded) return recorded;
	const name = clean(file).split(/[\\/]/).filter(Boolean).pop()?.replace(/\.jsonl$/i, "") || clean(file);
	const folder = clean(project).split(/[\\/]/).filter(Boolean).pop();
	return folder ? `${folder} · ${name}` : name;
}
export function rowLabel(row: TraceRow, startedAt: number): string {
	const span = row.span;
	return `${row.track.id} · ${span?.kind ?? row.marker?.kind} · ${span?.label ?? row.marker?.label} · +${traceDuration(row.time - startedAt)}${span ? ` · ${traceDuration(span.end - span.start)}${span.isError ? " · ERROR" : ""}${span.unterminated ? " · pending" : ""}` : ""}`;
}

interface TimelineRow { track: TraceTrack; lane?: Lane; markers?: boolean }

export function renderTimeline(options: {
	trace: SessionTrace; scale: TraceScale; viewport: Viewport; collapsed: ReadonlySet<string>;
	selected: string | null; cursor: number; width: number; height: number; search: string; theme: Theme;
	overviewCursor?: number | null; overviewAnchor?: number | null;
}): string[] {
	const { trace, scale, viewport, collapsed, selected, cursor, theme, search } = options;
	// The ONE `getSymbolPreset()` read for this view, so every mark below
	// answers to the preset instead of being hardcoded into the module.
	const preset = theme.getSymbolPreset();
	const width = Math.max(1, options.width);
	const labelWidth = Math.min(22, Math.max(4, Math.floor(width * 0.27)));
	const plotWidth = Math.max(1, width - labelWidth - 1);
	const lines: string[] = [];
	const full = { u0: scale.domain[0], u1: scale.domain[1] };
	const domainSize = full.u1 - full.u0;
	const windowStart = Math.max(0, Math.floor((viewport.u0 - full.u0) / domainSize * plotWidth));
	const windowEnd = Math.min(plotWidth - 1, Math.floor((viewport.u1 - full.u0) / domainSize * (plotWidth - 1)));
	const brush = Array<string>(plotWidth).fill(" ");
	for (let x = windowStart; x <= windowEnd; x++) brush[x] = theme.fg("muted", glyph(preset, "axisRule"));
	brush[windowStart] = theme.fg("accent", "[");
	brush[windowEnd] = theme.fg("accent", "]");
	if (options.overviewAnchor !== null && options.overviewAnchor !== undefined) brush[Math.min(plotWidth - 1, Math.floor(options.overviewAnchor * (plotWidth - 1)))] = theme.fg("warning", "|");
	if (options.overviewCursor !== null && options.overviewCursor !== undefined) brush[Math.min(plotWidth - 1, Math.floor(options.overviewCursor * (plotWidth - 1)))] = theme.fg("accent", glyph(preset, "playhead"));
	lines.push(`${"Minimap".padEnd(labelWidth)} ${brush.join("")}`);
	// Separate categories retain concurrent activity instead of overwriting one another.
	for (const kind of KINDS) {
		const spans = trace.tracks.flatMap(track => track.spans.filter(span => span.kind === kind));
		if (!spans.length) continue;
		const density = Array<number>(plotWidth).fill(0), errors = Array<boolean>(plotWidth).fill(false);
		for (const span of spans) {
			const cells = spanCells(scale, full, span, plotWidth);
			if (cells) for (let x = cells[0]; x < cells[1]; x++) { density[x]++; errors[x] ||= !!span.isError; }
		}
		lines.push(`${`Overview ${kind}`.padEnd(labelWidth)} ${density.map((count, x) => count ? theme.fg(errors[x] ? "error" : SPAN_COLORS[kind], count > 1 ? glyph(preset, "barFill") : MARKS[kind]) : glyph(preset, "heatEmpty")).join("")}`);
	}
	lines.push(theme.fg("muted", `Window +${traceDuration(scale.toT(viewport.u0) - trace.startedAt)} → +${traceDuration(scale.toT(viewport.u1) - trace.startedAt)} · ${(domainSize / (viewport.u1 - viewport.u0)).toFixed(1)}×`));
	const ruler = Array<string>(plotWidth).fill(glyph(preset, "axisRule"));
	for (const gap of scale.gaps) {
		const x = Math.floor((gap.uMid - viewport.u0) / (viewport.u1 - viewport.u0) * plotWidth);
		if (x >= 0 && x < plotWidth) ruler[x] = theme.fg("warning", "~");
	}
	ruler[Math.min(plotWidth - 1, Math.floor(cursor * (plotWidth - 1)))] = theme.fg("accent", glyph(preset, "playhead"));
	lines.push(`${"Cursor".padEnd(labelWidth)} ${ruler.join("")}`);
	const lanes = buildLanes(trace.tracks, collapsed), timelineRows: TimelineRow[] = [];
	for (const track of visibleTracks(trace.tracks, collapsed)) {
		timelineRows.push({ track });
		if (track.markers.length) timelineRows.push({ track, markers: true });
		for (const lane of lanes.filter(lane => lane.track.id === track.id)) timelineRows.push({ track, lane });
	}
	const selectedIndex = timelineRows.findIndex(row => row.lane?.spans.some(span => span.id === selected) || row.markers && row.track.markers.some((_marker, index) => selected === `${row.track.id}:marker:${index}`));
	const visible = localWindow(timelineRows, Math.max(0, selectedIndex), Math.max(3, options.height - lines.length - 2));
	const needle = search.trim().toLowerCase();
	for (const row of visible.rows) {
		if (!row.lane && !row.markers) {
			const depth = ancestors(trace.tracks, row.track.id).length;
			const children = trace.tracks.filter(track => track.parentId === row.track.id).length;
			lines.push(theme.fg("muted", `${"  ".repeat(depth)}${collapsed.has(row.track.id) ? "+" : "−"} ${clean(row.track.label)} [${row.track.id}]${children ? ` · ${children} children` : ""}${!row.track.spans.length && !row.track.markers.length ? " · no recorded events" : ""}`));
			continue;
		}
		const cells = Array<string>(plotWidth).fill(" ");
		if (row.markers) {
			row.track.markers.forEach((marker, index) => {
				const u = scale.toU(marker.time);
				if (u < viewport.u0 || u > viewport.u1) return;
				const x = Math.min(plotWidth - 1, Math.floor((u - viewport.u0) / (viewport.u1 - viewport.u0) * plotWidth));
				const ink = theme.fg(selected === `${row.track.id}:marker:${index}` ? "accent" : "muted", glyph(preset, "trackMarker"));
				cells[x] = selected === `${row.track.id}:marker:${index}` ? theme.bg(SELECTION_BG.band, theme.bold(ink)) : ink;
			});
			const active = row.track.markers.some((_marker, index) => selected === `${row.track.id}:marker:${index}`);
			const label = truncateToWidth(`${active ? glyph(preset, "rowCursor") : " "} Markers`, labelWidth, "");
			lines.push(`${active ? theme.bg(SELECTION_BG.band, theme.fg("accent", label.padEnd(labelWidth))) : label.padEnd(labelWidth)} ${cells.join("")}`);
			continue;
		}
		const lane = row.lane!;
		// Selected span paints last if multiple very short calls share a terminal cell.
		const spans = [...lane.spans].sort((a, b) => Number(a.id === selected) - Number(b.id === selected));
		for (const span of spans) {
			const bounds = spanCells(scale, viewport, span, plotWidth);
			if (!bounds) continue;
			const [start, end] = bounds;
			const match = needle && `${span.label} ${span.detail ?? ""} ${lane.track.label}`.toLowerCase().includes(needle);
			const text = clean(span.label).replace(/\s+/g, " ");
			// Labels retain identity in the selected-span line; narrow bars use category glyphs.
			const label = end - start >= 7 ? Array.from(text).filter(char => visibleWidth(char) === 1) : [];
			for (let x = start; x < end; x++) {
				let mark = label[x - start - 1] ?? MARKS[span.kind];
				if (x === start && span.id === selected) mark = glyph(preset, "rowCursor");
				else if (x === start && match) mark = "*";
				const ink = theme.fg(span.isError ? "error" : SPAN_COLORS[span.kind], mark);
				cells[x] = span.id === selected ? theme.bg(SELECTION_BG.band, theme.bold(ink)) : ink;
			}
		}
		const active = lane.spans.some(span => span.id === selected);
		const label = truncateToWidth(`${active ? glyph(preset, "rowCursor") : MARKS[lane.kind]} ${lane.track.id} ${lane.kind}${lane.ordinal ? ` #${lane.ordinal + 1}` : ""}`, labelWidth, "");
		const padded = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
		lines.push(`${active ? theme.bg(SELECTION_BG.band, theme.bold(theme.fg("accent", padded))) : padded} ${cells.join("")}`);
	}
	if (!trace.tracks.some(track => track.spans.length || track.markers.length)) lines.push("No recorded spans or markers in this trace.");
	if (visible.rows.length < timelineRows.length) lines.push(theme.fg("muted", `Rows ${visible.offset + 1}–${visible.offset + visible.rows.length}/${timelineRows.length} · ↑/↓ reveal · Tab panes`));
	lines.push(...wrapTextWithAnsi(KINDS.map(kind => theme.fg(SPAN_COLORS[kind], `${MARKS[kind]} ${kind === "turn" ? "input" : kind === "subagent" ? "agent" : kind}`)).join(" · ") + theme.fg("muted", ` · ${glyph(preset, "trackMarker")} marker · ~ compressed idle`), width));
	return bounded(lines, width);
}

export function renderEntry(row: TraceRow | null, entry: unknown, loading: boolean, error: string | null, raw: boolean, width: number, theme: Theme): string[] {
	const span = row?.span;
	const lines = row ? [clean(rowLabel(row, row.time)), `Track: ${clean(row.track.label)} · ${clean(row.track.file)}`] : [];
	if (span) {
		lines.push(`Start: ${new Date(span.start).toISOString()} · End: ${new Date(span.end).toISOString()}`);
		if (span.detail) lines.push(`${span.kind === "subagent" ? "Task" : span.kind === "tool" ? "Arguments" : "Detail"}: ${clean(span.detail)}`);
		if (span.kind === "model") lines.push(`Model: ${clean(span.model ?? "unknown")} · Tokens: ${formatInteger(span.tokens ?? 0)} · Cost: ${formatEstimatedCost(span.cost ?? 0, 0)} · TTFT: ${traceDuration(span.ttft ?? null)}`);
		if (span.childTrackId) lines.push(`Child: ${clean(span.childTrackId)} · o reveal child · O open child's transcript`);
	}
	if (loading) lines.push("Loading full journal entry…");
	if (error) lines.push(`Entry unavailable: ${clean(error)}`);
	const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
	const msg = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : {};
	for (const key of ["role", "model", "provider", "stopReason", "duration", "ttft", "toolName", "isError", "errorMessage"]) {
		if (msg[key] !== undefined) lines.push(`${key}: ${clean(msg[key])}`);
	}
	if (msg.usage && typeof msg.usage === "object") {
		const usage = msg.usage as Record<string, unknown>;
		lines.push(`Usage: input ${clean(usage.input)} · output ${clean(usage.output)} · cache read ${clean(usage.cacheRead)} · cache write ${clean(usage.cacheWrite)} · total ${clean(usage.totalTokens)}`);
		if (usage.cost) lines.push(`Component costs: ${clean(JSON.stringify(usage.cost))}`);
	}
	if (typeof msg.content === "string") lines.push("", "Text:", clean(msg.content));
	else if (Array.isArray(msg.content)) for (const block of msg.content) {
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string") lines.push(`${clean(block.type)}:`, clean(block.text));
		else if (block.type === "toolCall") lines.push(`Tool call ${clean(block.name)} (${clean(block.id)}):`, clean(JSON.stringify(block.arguments, null, 2)));
	}
	if (msg.details !== undefined) lines.push("Tool details:", clean(JSON.stringify(msg.details, null, 2)));
	if (row && !loading && entry === null && span?.entryId === undefined) lines.push("No journal entry is associated with this span/marker.");
	if (raw) lines.push("", "Raw JSON:", clean(JSON.stringify(entry ?? span ?? row?.marker, null, 2)));
	return lines.flatMap((line, index) => {
		const token = index === 0 && row ? span?.isError ? "error" : span ? SPAN_COLORS[span.kind] : "muted"
			: line.startsWith("Entry unavailable:") ? "error"
				: /^(Track:|Start:|First seen|No journal|Loading full)/.test(line) ? "muted" : "text";
		const ink = theme.fg(token, line);
		return wrapTextWithAnsi(line.endsWith(":") ? theme.bold(ink) : ink, Math.max(1, width));
	});
}
