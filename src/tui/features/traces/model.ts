import { buildScale, type AxisMode, type TraceScale } from "@oh-my-pi/omp-stats/client/traces/time-scale";
import type { SessionTrace, TraceMarker, TraceSpan, TraceSpanKind, TraceTrack } from "@oh-my-pi/omp-stats/shared-types";

export { buildScale };
export type { AxisMode, TraceScale };
export interface Viewport { u0: number; u1: number }
export interface TraceRow { key: string; time: number; track: TraceTrack; span?: TraceSpan; marker?: TraceMarker }
export interface Lane { track: TraceTrack; kind: TraceSpanKind; spans: TraceSpan[]; ordinal: number }
export const KINDS: readonly TraceSpanKind[] = ["turn", "model", "tool", "subagent", "background"];
export const MARKS: Record<TraceSpanKind, string> = { turn: "I", model: "M", tool: "T", subagent: "A", background: "B" };

export function transcriptRows(tracks: readonly TraceTrack[]): TraceRow[] {
	const rows: TraceRow[] = [];
	for (const track of tracks) {
		for (const span of track.spans) rows.push({ key: span.id, time: span.start, span, track });
		track.markers.forEach((marker, i) => rows.push({ key: `${track.id}:marker:${i}`, time: marker.time, marker, track }));
	}
	return rows.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
}

/** Entry ids are local to a transcript: prefer the requested file, never another child's same id. */
export function rowForEntry(trace: SessionTrace, file: string, entryId: string): TraceRow | undefined {
	return transcriptRows(trace.tracks).find(row => row.track.file === file && row.span?.entryId === entryId);
}

/** Reuse one id→track Map across a render; two-argument callers still work. */
export function trackMap(tracks: readonly TraceTrack[]): Map<string, TraceTrack> {
	return new Map(tracks.map(track => [track.id, track]));
}

export function ancestors(tracks: readonly TraceTrack[], id: string, byId: ReadonlyMap<string, TraceTrack> = trackMap(tracks)): string[] {
	const result: string[] = [];
	const seen = new Set<string>([id]);
	let parent = byId.get(id)?.parentId;
	while (parent && !seen.has(parent)) {
		result.push(parent);
		seen.add(parent);
		parent = byId.get(parent)?.parentId;
	}
	return result;
}

export function visibleTracks(tracks: readonly TraceTrack[], collapsed: ReadonlySet<string>, byId: ReadonlyMap<string, TraceTrack> = trackMap(tracks)): TraceTrack[] {
	return tracks.filter(track => !ancestors(tracks, track.id, byId).some(id => collapsed.has(id)));
}

/** Concurrent calls have separate lanes instead of overwriting each other's duration. */
export function buildLanes(tracks: readonly TraceTrack[], collapsed: ReadonlySet<string>, byId: ReadonlyMap<string, TraceTrack> = trackMap(tracks)): Lane[] {
	const lanes: Lane[] = [];
	for (const track of visibleTracks(tracks, collapsed, byId)) {
		for (const kind of KINDS) {
			const ends: number[] = [];
			const packed: Lane[] = [];
			for (const span of track.spans.filter(span => span.kind === kind).sort((a, b) => a.start - b.start)) {
				let index = ends.findIndex(end => end <= span.start);
				if (index < 0) index = ends.length;
				ends[index] = Math.max(span.end, span.start + Number.EPSILON);
				(packed[index] ??= { track, kind, spans: [], ordinal: index }).spans.push(span);
			}
			lanes.push(...packed);
		}
	}
	return lanes;
}

export function fit(scale: TraceScale): Viewport { return { u0: scale.domain[0], u1: scale.domain[1] }; }
export function clampViewport(scale: TraceScale, viewport: Viewport): Viewport {
	const [d0, d1] = scale.domain;
	const window = Math.min(d1 - d0, Math.max(Math.min(10, d1 - d0), viewport.u1 - viewport.u0));
	const u0 = Math.min(Math.max(d0, viewport.u0), d1 - window);
	return { u0, u1: u0 + window };
}
export function remapViewport(previous: TraceScale, next: TraceScale, viewport: Viewport): Viewport {
	return clampViewport(next, { u0: next.toU(previous.toT(viewport.u0)), u1: next.toU(previous.toT(viewport.u1)) });
}
export function zoomViewport(scale: TraceScale, viewport: Viewport, factor: number, cursor: number): Viewport {
	const fraction = Math.max(0, Math.min(1, cursor));
	const anchor = viewport.u0 + fraction * (viewport.u1 - viewport.u0);
	const window = (viewport.u1 - viewport.u0) * factor;
	return clampViewport(scale, { u0: anchor - window * fraction, u1: anchor + window * (1 - fraction) });
}

/** Seek or brush the full overview without changing the selected event. */
export function overviewViewport(scale: TraceScale, viewport: Viewport, cursor: number, anchor: number | null): Viewport {
	const [d0, d1] = scale.domain;
	const position = d0 + Math.max(0, Math.min(1, cursor)) * (d1 - d0);
	if (anchor !== null) {
		const start = d0 + Math.max(0, Math.min(1, anchor)) * (d1 - d0);
		return clampViewport(scale, { u0: Math.min(start, position), u1: Math.max(start, position) });
	}
	const size = viewport.u1 - viewport.u0;
	return clampViewport(scale, { u0: position - size / 2, u1: position + size / 2 });
}

/** Resize one brush edge while keeping its opposite edge fixed. */
export function resizeOverview(scale: TraceScale, viewport: Viewport, cursor: number, edge: "start" | "end"): Viewport {
	const [d0, d1] = scale.domain;
	const position = d0 + Math.max(0, Math.min(1, cursor)) * (d1 - d0);
	const minimum = Math.min(10, d1 - d0);
	return edge === "start"
		? { u0: Math.max(d0, Math.min(position, viewport.u1 - minimum)), u1: viewport.u1 }
		: { u0: viewport.u0, u1: Math.min(d1, Math.max(position, viewport.u0 + minimum)) };
}
export function revealSpan(scale: TraceScale, viewport: Viewport, span: TraceSpan, focus = false): Viewport {
	const start = scale.toU(span.start), end = scale.toU(span.end);
	if (!focus && start >= viewport.u0 && end <= viewport.u1) return viewport;
	const window = focus ? Math.max(10, (end - start) * 1.3) : Math.max(viewport.u1 - viewport.u0, end - start);
	return clampViewport(scale, { u0: (start + end - window) / 2, u1: (start + end + window) / 2 });
}

/** Cell bounds are always computed from original wall time, not parent-relative widths. */
export function spanCells(scale: TraceScale, viewport: Viewport, span: TraceSpan, width: number): [number, number] | undefined {
	if (width < 1) return undefined;
	const start = scale.toU(span.start), end = scale.toU(span.end);
	if (end < viewport.u0 || start > viewport.u1) return undefined;
	const window = viewport.u1 - viewport.u0;
	const x0 = Math.max(0, Math.min(width - 1, Math.floor((start - viewport.u0) / window * width)));
	const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((end - viewport.u0) / window * width)));
	return [x0, x1];
}

export function localWindow<T>(rows: readonly T[], index: number, count: number): { rows: readonly T[]; offset: number } {
	const size = Math.max(1, count);
	const offset = Math.max(0, Math.min(Math.max(0, rows.length - size), index - Math.floor(size / 2)));
	return { rows: rows.slice(offset, offset + size), offset };
}
