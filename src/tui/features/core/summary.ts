import { buildAgentTokenShare, buildFolderRows, sumConversationTokens, requestStatus, type FolderRowView, type FolderTableView } from "@oh-my-pi/omp-stats/client/data/view-models";
import { bucketAxis } from "@oh-my-pi/omp-stats/client/data/range";
import { densify } from "@oh-my-pi/omp-stats/client/data/series";
import { formatCompact, formatCost, formatEstimatedCost, formatDurationMs, formatPercent, formatTokensPerSecond, formatMessageCost, formatTimestamp } from "@oh-my-pi/omp-stats/client/data/formatters";
import type { DailyActivityPoint, TimeSeriesPoint } from "@oh-my-pi/omp-stats/shared-types";
import { cacheSavingsNote } from "../../format";
import type { PanelData, RecentRequest as MessageStats } from "../../../data/api";
import type { Range } from "../../../data/ranges";
import type { FeatureContext, FeatureController, FeatureHit, FeatureHitAction } from "../types";
import { renderHeatmap, weeksForWidth } from "../../charts/heatmap";
import { calendarLayout } from "../../charts/calendar";
import { glyphsFor } from "../../glyphs";
import { heatRamp, SELECTION_BG } from "../../palette";
import { ChartState, ListState, fields, wrap, type CoreSeries, type ListColumn, type Sorters } from "./shared";
import { RequestDetails } from "./requests";
import { dataTable, focusTabs, metricGrid, sectionHeading } from "../presentation";

type SummaryId = "overview" | "projects" | "activity";
/** The overview series can carry a per-bucket unpriced count; the live route does not. */
type OverviewTimePoint = TimeSeriesPoint & { unpricedRequests?: number };
/** Daily activity points carry an unpriced count only when the payload provides one. */
type ActivityPoint = DailyActivityPoint & { unpricedRequests?: number };
const PROJECT_SORT: Sorters<FolderRowView> = {
	folder: row => row.folder, cost: row => row.totalCost, requests: row => row.totalRequests,
	tokens: row => row.conversationTokens, cacheRate: row => row.cacheRate, cacheSavings: row => row.cacheSavings, errorRate: row => row.errorRate,
	duration: row => row.avgDuration, ttft: row => row.avgTtft, last: row => row.lastTimestamp,
};
const REQUEST_SORT: Sorters<MessageStats> = {
	time: row => row.timestamp, model: row => `${row.model} ${row.provider}`, project: row => row.folder,
	input: row => row.usage.input, cache: row => row.usage.cacheRead, output: row => row.usage.output,
	cost: row => row.usage.cost.total, duration: row => row.duration, ttft: row => row.ttft, status: requestStatus,
};
const DAY_SORT: Sorters<DailyActivityPoint> = { day: row => row.day, requests: row => row.requests, cost: row => row.cost, tokens: row => row.totalTokens };
function localDay(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayDate(day: string): Date {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(year, month - 1, date);
}

export function createSummaryFeature(id: SummaryId, ctx: FeatureContext): FeatureController {
	return new SummaryFeature(id, ctx);
}

class SummaryFeature implements FeatureController {
	private range: Range = "24h";
	private data: PanelData | null = null;
	private loading = false;
	private error: string | null = null;
	private generation = 0;
	private closed = false;
	private focus = 0;
	private hideTemporary = true;
	private expanded: FolderRowView | DailyActivityPoint | null = null;
	private readonly chart = new ChartState();
	private readonly requests = new ListState<MessageStats>(row => String(row.id ?? `${row.sessionFile}:${row.entryId}`), "time", 12);
	private readonly projects = new ListState<FolderRowView>(row => row.folder, "cost", 100);
	private readonly costRanking = new ListState<FolderRowView>(row => row.folder, "cost", 8);
	private readonly requestRanking = new ListState<FolderRowView>(row => row.folder, "requests", 8);
	private readonly days = new ListState<ActivityPoint>(row => row.day, "day", 30);
	private calendarDay: string | null = null;
	private calendarEnd: string | null = null;
	private readonly details: RequestDetails;
	constructor(private readonly id: SummaryId, private readonly ctx: FeatureContext) { this.details = new RequestDetails(ctx); }
	async load(range: Range): Promise<void> {
		if (this.closed) return;
		this.range = range;
		const generation = ++this.generation;
		this.loading = true;
		this.error = null;
		this.ctx.changed();
		try {
			let data: PanelData;
			if (this.id === "overview") {
				const [overview, recent] = await Promise.all([
					this.ctx.reader.fetch(["overview"], range),
					this.ctx.reader.api<MessageStats[]>("/api/stats/recent", { range, limit: "12" }),
				]);
				data = { ...overview, recent };
			} else data = await this.ctx.reader.fetch([this.id === "projects" ? "folders" : "dailyActivity"], range);
			if (this.closed || generation !== this.generation) return;
			this.data = data;
		} catch (error) {
			if (this.closed || generation !== this.generation) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.closed && generation === this.generation) { this.loading = false; this.ctx.changed(); }
		}
	}

	private overviewChart(): { buckets: number[]; series: CoreSeries[]; mode: string; unpriced: number[]; requests: number[]; carriesUnpriced: boolean } {
		const points = (this.data?.overview?.timeSeries ?? []) as OverviewTimePoint[];
		const timestamps = points.map(point => point.timestamp);
		const buckets = bucketAxis(this.range, timestamps, undefined, this.ctx.now());
		this.chart.seedLatestPoint(buckets, timestamps);
		const mode = ["requests", "tokens", "cost"][this.chart.mode % 3];
		const series = mode === "requests" ? [
			{ key: "ok", label: "Succeeded", values: densify(points, buckets, point => point.requests - point.errors) },
			{ key: "err", label: "Failed", values: densify(points, buckets, point => point.errors) },
		] : [{ key: mode, label: mode === "cost" ? "Known-priced API cost" : "Tokens", values: densify(points, buckets, point => mode === "cost" ? point.cost : point.tokens) }];
		return {
			buckets, series, mode,
			unpriced: densify(points, buckets, point => point.unpricedRequests ?? 0),
			requests: densify(points, buckets, point => point.requests),
			carriesUnpriced: points.some(point => point.unpricedRequests !== undefined),
		};
	}
	private projectRows(): { view: FolderTableView; scoped: FolderRowView[]; matching: FolderRowView[] } {
		const view = buildFolderRows(this.data?.folders ?? []);
		const scoped = this.hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows;
		const needle = this.projects.search.trim().toLowerCase();
		const matching = this.projects.rows(scoped.filter(row => !needle || row.folder.toLowerCase().includes(needle)), PROJECT_SORT);
		return { view, scoped, matching };
	}
	private selectedDay(): ActivityPoint {
		const day = this.calendarDay ?? localDay(new Date(this.ctx.now()));
		return (this.data?.dailyActivity?.find(point => point.day === day) as ActivityPoint | undefined) ?? { day, requests: 0, cost: 0, totalTokens: 0 };
	}
	private moveCalendar(delta: number): void {
		const today = new Date(this.ctx.now());
		const earliest = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 370));
		const date = dayDate(this.selectedDay().day);
		const next = localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta));
		this.calendarDay = next < earliest ? earliest : next > localDay(today) ? localDay(today) : next;
	}
	render(width: number, height: number): readonly string[] {
		const detail = this.details.render(width);
		if (detail) return detail;
		if (this.expanded) return wrap([this.ctx.theme.bold(this.id === "projects" ? "Project details" : "Day details"), "b/Esc back · all narrow-table columns below", ...fields(this.expanded)], width);
		const prefix = [sectionHeading(this.ctx, width, this.id[0].toUpperCase() + this.id.slice(1), this.id === "activity" ? "371 local days" : this.range, true),
			...(this.loading ? [this.data ? "Refreshing… existing observations are stale." : "Loading… no observations yet."] : []),
			...(this.error ? [this.ctx.theme.fg("error", `Read failed: ${this.error}${this.data ? " · showing stale observations" : ""}`)] : [])];
		if (!this.data) return wrap(prefix, width);
		if (this.id === "overview") {
			const payload = this.data.overview;
			if (!payload?.overall) return wrap([...prefix, "Overview payload unavailable."], width);
			const overall = payload.overall;
			const chart = this.overviewChart();
			const needle = this.requests.search.trim().toLowerCase();
			const rows = this.requests.rows((this.data.recent ?? []).filter(row => !needle || `${row.model} ${row.provider} ${row.folder}`.toLowerCase().includes(needle)), REQUEST_SORT);
			const columns: ListColumn<MessageStats>[] = [
				{ key: "model", header: "Model", align: "left", value: row => row.model },
				{ key: "provider", header: "Provider", align: "left", priority: 5, value: row => row.provider },
				{ key: "when", header: "When", align: "left", priority: 3, value: row => formatTimestamp(row.timestamp) },
				{ key: "status", header: "Status", align: "left", priority: 4, value: requestStatus },
				{ key: "cost", header: "API cost", align: "right", priority: 0, value: row => formatMessageCost(row, 4) },
				{ key: "tokens", header: "Tokens", align: "right", priority: 1, value: row => formatCompact(row.usage.totalTokens) },
				{ key: "duration", header: "Latency", align: "right", priority: 2, value: row => formatDurationMs(row.duration) },
			];
			const total = sumConversationTokens(overall);
			const mix = [["Uncached input", overall.totalInputTokens], ["Cache read", overall.totalCacheReadTokens], ["Cache write", overall.totalCacheWriteTokens], ["Output", overall.totalOutputTokens]] as const;
			const agents = buildAgentTokenShare(payload.byAgentType);
			const prefixLines = wrap(prefix, width);
			const metrics = metricGrid(this.ctx, width, [
				{ label: "Requests", value: formatCompact(overall.totalRequests), hint: `${formatCompact(overall.successfulRequests)} succeeded`, emphasis: "primary" },
				{ label: "API cost", value: formatEstimatedCost(overall.totalCost, overall.unpricedRequests), hint: `${overall.unpricedRequests} unpriced` },
				{ label: "Tokens", value: formatCompact(total), hint: `${formatCompact(overall.totalPremiumRequests)} premium req` },
				{ label: "Cache hit", value: formatPercent(overall.cacheRate), hint: cacheSavingsNote(overall.cacheSavings) },
				{ label: "Latency", value: formatDurationMs(overall.avgDuration), hint: `${formatDurationMs(overall.avgTtft)} TTFT` },
				{ label: "Failures", value: formatCompact(overall.failedRequests), hint: `${formatPercent(overall.errorRate)} error rate` },
			]);
			const tabs = focusTabs(this.ctx, width, ["Requests", "Chart"], this.focus);
			const tokenMix = dataTable(this.ctx, width, "Token mix", [
				{ key: "label", header: "Category", align: "left" },
				{ key: "tokens", header: "Tokens", align: "right", priority: 0 },
				{ key: "share", header: "Share", align: "right", priority: 1 },
			], mix.map(([label, value]) => ({ label, tokens: formatCompact(value), share: total > 0 ? formatPercent(value / total) : "—" })));
			const agentShares = dataTable(this.ctx, width, "Agent token shares", [
				{ key: "agent", header: "Agent", align: "left" },
				{ key: "tokens", header: "Tokens", align: "right", priority: 0 },
				{ key: "share", header: "Share", align: "right", priority: 1 },
				{ key: "requests", header: "Req", align: "right", priority: 2 },
			], agents.segments.map(agent => ({ agent: agent.agentType, tokens: formatCompact(agent.tokens), share: formatPercent(agent.share), requests: String(agent.requests) })));
			// The log and the chart are the only flexible regions; everything else
			// on the screen is fixed, so the frame's remainder is split between them.
			const fixed = prefixLines.length + metrics.length + 1 + tabs.length
				+ 1 + tokenMix.length + 1 + agentShares.length;
			const available = Math.max(1, height - fixed);
			const notice = chart.mode === "cost" && overall.unpricedRequests > 0
				? wrap([this.ctx.theme.fg("dim", `Known-priced cost only · ${overall.unpricedRequests} unpriced requests; per-bucket unknown counts unavailable.`)], width) : [];
			const chartOverhead = 4 + notice.length + chart.series.length;
			const listHeight = Math.max(6, Math.round(available * 0.5));
			const chartHeight = Math.max(5, available - listHeight - chartOverhead);
			const list = this.requests.render(rows, width, listHeight, columns, this.ctx, "Latest requests · A opens all");
			const graph = [sectionHeading(this.ctx, width, "Activity", chart.mode, this.focus === 1),
				...notice,
				...this.chart.render(this.ctx, width, chart.buckets, chart.series, {
					height: chartHeight, unit: chart.mode === "cost" ? "API-equivalent USD / bucket" : chart.mode === "tokens" ? "tokens / bucket" : "requests / bucket",
					stacked: true, format: chart.mode === "cost" ? formatCost : formatCompact,
					formatValue: chart.mode === "cost" ? (key, value, point) => {
						const unpriced = chart.unpriced[point] ?? 0;
						// Without a per-bucket count, a busy zero-cost bucket is unknown spend, not free.
						const unknown = unpriced > 0 ? unpriced : !chart.carriesUnpriced && (chart.requests[point] ?? 0) > 0 ? 1 : 0;
						return formatEstimatedCost(value ?? 0, unknown);
					} : undefined,
				})];
			const listOffset = prefixLines.length + metrics.length + 1 + tabs.length
				+ (this.focus === 0 ? 0 : graph.length + 1);
			this.ctx.reportHits?.(this.requests.lastHits.map(hit => ({
				...hit, rowStart: hit.rowStart + listOffset, rowEnd: hit.rowEnd + listOffset,
			})));
			return [...prefixLines, ...metrics, "", ...tabs,
				...(this.focus === 0 ? list : graph), "", ...(this.focus === 0 ? graph : list), "",
				...tokenMix, "", ...agentShares];
		}
		if (this.id === "projects") {
			const { view, scoped, matching } = this.projectRows();
			const cost = this.costRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
			const requests = this.requestRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
			const columns = [
				{ key: "folder", header: "Project", align: "left" as const, value: (row: FolderRowView) => `${row.folder || "(root)"}${row.temporary ? " [temp]" : ""}` },
				{ key: "cost", header: "API cost", align: "right" as const, priority: 0, value: (row: FolderRowView) => formatEstimatedCost(row.totalCost, row.unpricedRequests) },
				{ key: "requests", header: "Req", align: "right" as const, priority: 1, value: (row: FolderRowView) => formatCompact(row.totalRequests) },
				{ key: "tokens", header: "Tokens", align: "right" as const, priority: 2, value: (row: FolderRowView) => formatCompact(row.conversationTokens) },
				{ key: "errors", header: "Error", align: "right" as const, priority: 3, value: (row: FolderRowView) => formatPercent(row.errorRate) },
				{ key: "cache", header: "Cache", align: "right" as const, priority: 4, value: (row: FolderRowView) => formatPercent(row.cacheRate) },
			];
			const lists = [this.projects, this.costRanking, this.requestRanking];
			const rowSets = [matching, cost, requests];
			const titles = ["Projects", "Cost ranking · Enter filters projects", "Request ranking · Enter filters projects"];
		const prefixLines = wrap(prefix, width);
		const metrics = metricGrid(this.ctx, width, [
			{ label: "Projects", value: String(view.rows.length), hint: `${view.temporaryCount} temporary`, emphasis: "primary" },
			{ label: "Requests", value: formatCompact(view.totalRequests), hint: `${view.failedRequests} failed` },
			{ label: "API cost", value: formatEstimatedCost(view.totalCost, view.unpricedRequests), hint: `${view.unpricedRequests} unpriced` },
			{ label: "Tokens", value: formatCompact(view.conversationTokens), hint: `${formatPercent(view.cacheRate)} cache hit` },
		]);
		const dimLine = wrap([this.ctx.theme.fg("dim", `Totals include all projects · t ${this.hideTemporary ? "show" : "hide"} temporary projects${this.hideTemporary && view.temporaryCount ? ` (${view.temporaryCount} hidden)` : ""}`)], width);
		const tabs = focusTabs(this.ctx, width, ["Projects", "By cost", "By requests"], this.focus);
		const used = prefixLines.length + metrics.length + dimLine.length + 1 + tabs.length;
		const list = lists[this.focus].render(rowSets[this.focus], width, Math.max(5, height - used), columns, this.ctx, titles[this.focus]);
		const listOffset = prefixLines.length + metrics.length + dimLine.length + 1 + tabs.length;
		this.ctx.reportHits?.(lists[this.focus].lastHits.map(hit => ({
			...hit, rowStart: hit.rowStart + listOffset, rowEnd: hit.rowEnd + listOffset,
		})));
		return [...prefixLines, ...metrics, ...dimLine, "", ...tabs, ...list];
		}
		const points = (this.data.dailyActivity ?? []) as ActivityPoint[];
		const weeks = weeksForWidth(2, width);
		const actualToday = new Date(this.ctx.now());
		const selected = this.selectedDay();
		let today = this.calendarEnd ? dayDate(this.calendarEnd) : actualToday;
		const visibleStart = localDay(calendarLayout(points, weeks, today).start);
		if (selected.day < visibleStart || selected.day > localDay(today)) {
			const date = dayDate(selected.day);
			const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 6 - (date.getDay() + 6) % 7);
			today = end > actualToday ? actualToday : end;
			this.calendarEnd = localDay(today);
		}
		const layout = calendarLayout(points, weeks, today);
		const windowUnpriced = points.filter(point => point.day >= localDay(layout.start) && point.day <= localDay(today)).reduce((sum, point) => sum + (point.unpricedRequests ?? 0), 0);
		const needle = this.days.search.trim().toLowerCase();
		const rows = this.days.rows(points.filter(point => !needle || point.day.includes(needle)), DAY_SORT);
		const calendar = [sectionHeading(this.ctx, width, "Activity calendar", `${weeks} weeks`, this.focus === 1),
			...renderHeatmap(points, { innerWidth: width, labelWidth: 2, weeks, glyphs: glyphsFor(this.ctx.theme.getSymbolPreset()), ramp: [0, 1, 2, 3].map(level => heatRamp(this.ctx.theme, level)), dim: text => this.ctx.theme.fg("dim", text), today, selectedDay: selected.day, selected: text => this.ctx.theme.bg(SELECTION_BG.band, this.ctx.theme.fg("accent", text)) }),
			...wrap([this.ctx.theme.fg("dim", `${localDay(layout.start)}–${localDay(today)} · ${layout.totalRequests} requests · ${formatEstimatedCost(layout.totalCost, windowUnpriced)}`),
				this.ctx.theme.fg("dim", "j/k day · h/l week · t today · Enter details")], width)];
		const prefixLines = wrap(prefix, width);
		const metrics = metricGrid(this.ctx, width, [
			{ label: "Day requests", value: formatCompact(selected.requests), hint: selected.day, emphasis: "primary" },
			{ label: "Day API cost", value: formatEstimatedCost(selected.cost, selected.unpricedRequests ?? 0), hint: "selected local day" },
			{ label: "Day tokens", value: formatCompact(selected.totalTokens), hint: `${points.length} recorded days` },
		]);
		const tabs = focusTabs(this.ctx, width, ["Recorded days", "Calendar"], this.focus);
		const tail = wrap([this.ctx.theme.fg("dim", "Latest 371 local days · independent of the range selector; quiet selected days are zero.")], width);
		// The calendar is fixed; the day list absorbs every row the frame has left.
		const used = prefixLines.length + metrics.length + 1 + tabs.length + calendar.length + 1 + tail.length;
		const list = this.days.render(rows, width, Math.max(5, height - used), [
			{ key: "day", header: "Day", align: "left", value: point => point.day },
			{ key: "requests", header: "Req", align: "right", priority: 0, value: point => formatCompact(point.requests) },
			{ key: "cost", header: "API cost", align: "right", priority: 1, value: point => formatEstimatedCost(point.cost, point.unpricedRequests ?? 0) },
			{ key: "tokens", header: "Tokens", align: "right", priority: 2, value: point => formatCompact(point.totalTokens) },
		], this.ctx, "Recorded days");
		const leading = this.focus === 0 ? list : calendar;
		const trailing = this.focus === 0 ? calendar : list;
		const calendarOffset = prefixLines.length + metrics.length + 1 + tabs.length
			+ (this.focus === 0 ? list.length + 1 : 0);
		const listOffset = prefixLines.length + metrics.length + 1 + tabs.length
			+ (this.focus === 0 ? 0 : calendar.length + 1);
		this.ctx.reportHits?.(this.days.lastHits.map(hit => ({
			...hit, rowStart: hit.rowStart + listOffset, rowEnd: hit.rowEnd + listOffset,
		})));
		// The heatmap is `sectionHeading` + month row + seven day rows, so cell
		// `(dayIndex, week)` sits at `calendarOffset + 2 + dayIndex`; its two
		// cells start after the 2-cell weekday gutter.
		const hits: FeatureHit[] = [];
		for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
			for (let week = 0; week < weeks; week++) {
				if (layout.cells[dayIndex][week] === null) continue;
				const date = new Date(layout.start.getFullYear(), layout.start.getMonth(), layout.start.getDate() + week * 7 + dayIndex);
				hits.push({
					rowStart: calendarOffset + 2 + dayIndex,
					rowEnd: calendarOffset + 3 + dayIndex,
					colStart: 2 + week * 2,
					colEnd: 2 + week * 2 + 2,
					action: { type: "selectDay", day: localDay(date) },
				});
			}
		}
		this.ctx.reportHits?.(hits);
		return [...prefixLines, ...metrics, "", ...tabs, ...leading, "", ...trailing, ...tail];
	}
	get inputMode(): "text" | "navigation" {
		return (this.id === "overview" ? this.requests.editing : this.id === "projects" ? this.projects.editing : this.days.editing)
			? "text" : "navigation";
	}
	handleInput(data: string): boolean {
		if (this.closed || data === "q" && this.inputMode !== "text") return false;
		if (this.details.active) return this.details.handleInput(data);
		if (this.expanded) {
			if (data === "b" || data === "\x1b") { this.expanded = null; this.ctx.changed(); return true; }
			return false;
		}
		let handled = false;
		if (this.id === "overview") {
			const needle = this.requests.search.trim().toLowerCase();
			const rows = this.requests.rows((this.data?.recent ?? []).filter(row => !needle || `${row.model} ${row.provider} ${row.folder}`.toLowerCase().includes(needle)), REQUEST_SORT);
			if (this.requests.editing) handled = this.requests.input(data, rows);
			else if (data === "A") { this.ctx.openScreen("requests"); handled = true; }
			else if (data === "\t") { this.focus = (this.focus + 1) % 2; handled = true; }
			else if (this.focus === 1 && data === "m") { this.chart.mode = (this.chart.mode + 1) % 3; handled = true; }
			else if (this.focus === 1) handled = this.chart.input(data, this.overviewChart().series.map(series => series.key));
			else if (data === "\r" || data === "\n") { const row = this.requests.current(rows); if (row) void this.details.open(row); handled = true; }
			else if (data === "o" || data === "O") {
				if (data === "O") this.requests.descending = !this.requests.descending;
				else { const sorts = Object.keys(REQUEST_SORT); this.requests.sort = sorts[(sorts.indexOf(this.requests.sort) + 1) % sorts.length]; }
				handled = true;
			} else handled = this.requests.input(data, rows);
		} else if (this.id === "projects") {
			const { scoped, matching } = this.projectRows();
			const list = [this.projects, this.costRanking, this.requestRanking][this.focus];
			const rows = this.focus === 0 ? matching : list.rows(scoped, PROJECT_SORT).slice(0, 8);
			if (this.projects.editing) handled = this.projects.input(data, matching);
			else if (data === "\t") { this.focus = (this.focus + 1) % 3; handled = true; }
			else if (data === "t") { this.hideTemporary = !this.hideTemporary; handled = true; }
			else if (data === "/") { this.focus = 0; handled = this.projects.input(data, matching); }
			else if (data === "\r" || data === "\n") {
				const row = list.current(rows);
				if (row) { if (this.focus === 0) this.expanded = row; else { this.projects.search = row.folder; this.projects.selected = row.folder; this.focus = 0; } }
				handled = true;
			} else if (data === "o" || data === "O") {
				if (data === "O") list.descending = !list.descending;
				else { const sorts = Object.keys(PROJECT_SORT); list.sort = sorts[(sorts.indexOf(list.sort) + 1) % sorts.length]; }
				handled = true;
			} else if (data === "\x1b" && this.projects.search) { this.projects.search = ""; handled = true; }
			else handled = list.input(data, rows);
		} else {
			const points = this.data?.dailyActivity ?? [];
			const rows = this.days.rows(points.filter(point => !this.days.search || point.day.includes(this.days.search.trim())), DAY_SORT);
			if (this.days.editing) handled = this.days.input(data, rows);
			else if (data === "\t") { this.focus = (this.focus + 1) % 2; handled = true; }
			else if (data === "/") { this.focus = 0; handled = this.days.input(data, rows); }
			else if (this.focus === 0 && (data === "\r" || data === "\n")) { this.expanded = this.days.current(rows) ?? null; handled = true; }
			else if (this.focus === 1 && (data === "j" || data === "k" || data === "\x1b[B" || data === "\x1b[A" || data === "h" || data === "l")) {
				this.moveCalendar(data === "h" ? -7 : data === "l" ? 7 : data === "k" || data === "\x1b[A" ? -1 : 1); handled = true;
			} else if (this.focus === 1 && data === "t") { this.calendarDay = localDay(new Date(this.ctx.now())); this.calendarEnd = null; handled = true; }
			else if (this.focus === 1 && (data === "\r" || data === "\n")) { this.expanded = this.selectedDay(); handled = true; }
			else if (this.focus === 0 && (data === "o" || data === "O")) {
				if (data === "O") this.days.descending = !this.days.descending;
				else { const sorts = Object.keys(DAY_SORT); this.days.sort = sorts[(sorts.indexOf(this.days.sort) + 1) % sorts.length]; }
				handled = true;
			} else if (this.focus === 0) handled = this.days.input(data, rows);
		}
		if (handled) this.ctx.changed();
		return handled;
	}
	handleHit(action: FeatureHitAction): void {
		if (action.type === "selectRow") {
			if (this.id === "overview") this.requests.selected = action.key;
			else if (this.id === "projects") {
				const list = [this.projects, this.costRanking, this.requestRanking][this.focus];
				if (list) list.selected = action.key;
			} else this.days.selected = action.key;
		} else {
			this.calendarDay = action.day;
			this.calendarEnd = null;
		}
		this.ctx.changed();
	}
	dispose(): void { this.closed = true; this.generation++; this.details.dispose(); }
}
