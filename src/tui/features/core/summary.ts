import { buildAgentTokenShare, buildFolderRows, sumConversationTokens, requestStatus, type FolderRowView, type FolderTableView } from "@oh-my-pi/omp-stats/client/data/view-models";
import { bucketAxis } from "@oh-my-pi/omp-stats/client/data/range";
import { densify } from "@oh-my-pi/omp-stats/client/data/series";
import { formatCompact, formatEstimatedCost, formatDurationMs, formatPercent, formatTokensPerSecond, formatMessageCost, formatTimestamp } from "@oh-my-pi/omp-stats/client/data/formatters";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { PanelData, RecentRequest as MessageStats } from "../../../data/api";
import type { Range } from "../../../data/ranges";
import type { FeatureContext, FeatureController } from "../types";
import { renderHeatmap, weeksForWidth } from "../../charts/heatmap";
import { calendarLayout } from "../../charts/calendar";
import { glyphsFor } from "../../glyphs";
import { heatRamp, SELECTION_BG } from "../../palette";
import { ChartState, ListState, fields, wrap, type CoreSeries, type Sorters } from "./shared";
import { RequestDetails } from "./requests";
import { dashboardPanels, emptyState, focusTabs, metricGrid, panel, ranking, sectionHeading, type DashboardPanel } from "../presentation";

type SummaryId = "overview" | "projects" | "activity";
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
	private readonly days = new ListState<DailyActivityPoint>(row => row.day, "day", 30);
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
	private overviewChart(): { buckets: number[]; series: CoreSeries[]; mode: string } {
		const points = this.data?.overview?.timeSeries ?? [];
		const timestamps = points.map(point => point.timestamp);
		const buckets = bucketAxis(this.range, timestamps, undefined, this.ctx.now());
		this.chart.seedLatestPoint(buckets, timestamps);
		const mode = ["requests", "tokens", "cost"][this.chart.mode % 3];
		const series = mode === "requests" ? [
			{ key: "ok", label: "Succeeded", values: densify(points, buckets, point => point.requests - point.errors) },
			{ key: "err", label: "Failed", values: densify(points, buckets, point => point.errors) },
		] : [{ key: mode, label: mode === "cost" ? "Known-priced API cost" : "Tokens", values: densify(points, buckets, point => mode === "cost" ? point.cost : point.tokens) }];
		return { buckets, series, mode };
	}
	private projectRows(): { view: FolderTableView; scoped: FolderRowView[]; matching: FolderRowView[] } {
		const view = buildFolderRows(this.data?.folders ?? []);
		const scoped = this.hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows;
		const needle = this.projects.search.trim().toLowerCase();
		const matching = this.projects.rows(scoped.filter(row => !needle || row.folder.toLowerCase().includes(needle)), PROJECT_SORT);
		return { view, scoped, matching };
	}
	private selectedDay(): DailyActivityPoint {
		const day = this.calendarDay ?? localDay(new Date(this.ctx.now()));
		return this.data?.dailyActivity?.find(point => point.day === day) ?? { day, requests: 0, cost: 0, totalTokens: 0 };
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
			if (!payload) return wrap([...prefix, "Overview payload unavailable."], width);
			const overall = payload.overall;
			const chart = this.overviewChart();
			const needle = this.requests.search.trim().toLowerCase();
			const rows = this.requests.rows((this.data.recent ?? []).filter(row => !needle || `${row.model} ${row.provider} ${row.folder}`.toLowerCase().includes(needle)), REQUEST_SORT);
			const requestPanel: DashboardPanel = { title: "Latest requests", meta: "Enter details · A all requests · / search", active: this.focus === 0, render: inner => this.requests.render(rows, inner, Math.min(13, Math.max(6, height - 17)), [
				{ key: "model", header: "Model", align: "left", value: row => row.model },
				{ key: "provider", header: "Provider", align: "left", priority: 5, value: row => row.provider },
				{ key: "when", header: "When", align: "left", priority: 3, value: row => formatTimestamp(row.timestamp) },
				{ key: "status", header: "Status", align: "left", priority: 4, value: requestStatus },
				{ key: "cost", header: "API cost", align: "right", priority: 0, value: row => formatMessageCost(row, 4) },
				{ key: "tokens", header: "Tokens", align: "right", priority: 1, value: row => formatCompact(row.usage.totalTokens) },
				{ key: "duration", header: "Latency", align: "right", priority: 2, value: row => formatDurationMs(row.duration) },
			], this.ctx, "") };
			const graphPanel: DashboardPanel = { title: "Activity", meta: "m metric · n/v series · ,/. inspect", active: this.focus === 1, render: inner => [
				...(chart.mode === "cost" && overall.unpricedRequests > 0 ? wrap([this.ctx.theme.fg("muted", `Known-priced cost only · ${overall.unpricedRequests} unpriced; bucket counts unavailable.`)], inner) : []),
				...this.chart.render(this.ctx, inner, chart.buckets, chart.series, {
					height: 7, unit: chart.mode === "cost" ? "API-equivalent USD / bucket" : chart.mode === "tokens" ? "tokens / bucket" : "requests / bucket",
					stacked: true, format: chart.mode === "cost" ? value => formatEstimatedCost(value, 0) : formatCompact,
				})] };
			const total = sumConversationTokens(overall);
			const mix = [["Uncached input", overall.totalInputTokens], ["Cache read", overall.totalCacheReadTokens], ["Cache write", overall.totalCacheWriteTokens], ["Output", overall.totalOutputTokens]] as const;
			const agents = buildAgentTokenShare(payload.byAgentType);
			return [...wrap(prefix, width), ...metricGrid(this.ctx, width, [
				{ label: "Requests", value: formatCompact(overall.totalRequests), hint: `${formatCompact(overall.successfulRequests)} succeeded`, emphasis: "primary" },
				{ label: "API cost", value: formatEstimatedCost(overall.totalCost, overall.unpricedRequests), hint: `${overall.unpricedRequests} unpriced` },
				{ label: "Tokens", value: formatCompact(total), hint: `${formatCompact(overall.totalPremiumRequests)} premium req` },
				{ label: "Cache hit", value: formatPercent(overall.cacheRate), hint: `${formatPercent(overall.cacheSavings)} saved` },
				{ label: "Latency", value: formatDurationMs(overall.avgDuration), hint: `${formatDurationMs(overall.avgTtft)} TTFT` },
				{ label: "Failures", value: formatCompact(overall.failedRequests), hint: `${formatPercent(overall.errorRate)} error rate` },
			]), "", ...focusTabs(this.ctx, width, ["Requests", "Chart"], this.focus), "",
				...dashboardPanels(this.ctx, width, width >= 100 || this.focus === 1 ? [graphPanel, requestPanel] : [requestPanel, graphPanel]),
				"", ...dashboardPanels(this.ctx, width, [
					{ title: "Token composition", meta: `${formatPercent(overall.cacheRate)} cache hit · ${formatPercent(overall.cacheSavings)} saved`, render: inner => ranking(this.ctx, inner, mix.map(([label, value]) => ({ label, value, display: `${formatCompact(value)} · ${total > 0 ? formatPercent(value / total) : "—"}` }))) },
					{ title: "Agent token shares", render: inner => agents.segments.length ? ranking(this.ctx, inner, agents.segments.map(agent => ({ label: agent.agentType, value: agent.tokens, display: `${formatCompact(agent.tokens)} · ${formatPercent(agent.share)}` }))) : emptyState(this.ctx, inner, "No agent split recorded", "Agent attribution appears when recorded sessions include agent types.") },
				])];
		}
		if (this.id === "projects") {
			const { view, scoped, matching } = this.projectRows();
			const cost = this.costRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
			const requests = this.requestRanking.rows(scoped, PROJECT_SORT).slice(0, 8);
			const columns = [
				{ key: "folder", header: "Project", align: "left" as const, value: (row: FolderRowView) => `${row.temporary ? "[temp] " : ""}${row.folder.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "(root)"}` },
				{ key: "cost", header: "API cost", align: "right" as const, priority: 0, value: (row: FolderRowView) => formatEstimatedCost(row.totalCost, row.unpricedRequests) },
				{ key: "requests", header: "Req", align: "right" as const, priority: 1, value: (row: FolderRowView) => formatCompact(row.totalRequests) },
				{ key: "tokens", header: "Tokens", align: "right" as const, priority: 2, value: (row: FolderRowView) => formatCompact(row.conversationTokens) },
				{ key: "errors", header: "Error", align: "right" as const, priority: 3, value: (row: FolderRowView) => formatPercent(row.errorRate) },
				{ key: "cache", header: "Cache", align: "right" as const, priority: 4, value: (row: FolderRowView) => formatPercent(row.cacheRate) },
			];
			const lists = [this.projects, this.costRanking, this.requestRanking];
			const rowSets = [matching, cost, requests];
			const picked = lists[this.focus].current(rowSets[this.focus]);
			const titles = ["Projects", "Cost ranking · Enter filters projects", "Request ranking · Enter filters projects"];
			return [...wrap(prefix, width), ...metricGrid(this.ctx, width, [
				{ label: "Projects", value: String(view.rows.length), hint: `${view.temporaryCount} temporary`, emphasis: "primary" },
				{ label: "Requests", value: formatCompact(view.totalRequests), hint: `${view.failedRequests} failed` },
				{ label: "API cost", value: formatEstimatedCost(view.totalCost, view.unpricedRequests), hint: `${view.unpricedRequests} unpriced` },
				{ label: "Tokens", value: formatCompact(view.conversationTokens), hint: `${formatPercent(view.cacheRate)} cache hit` },
			]), ...wrap([this.ctx.theme.fg("muted", `Totals include all projects · t ${this.hideTemporary ? "show" : "hide"} temporary projects${this.hideTemporary && view.temporaryCount ? ` (${view.temporaryCount} hidden)` : ""}`)], width),
				"", ...focusTabs(this.ctx, width, ["Projects", "By cost", "By requests"], this.focus), "",
				...dashboardPanels(this.ctx, width, [
					{ title: titles[this.focus], active: true, meta: "/ search · o/O sort · Enter details · Tab rankings",
						render: inner => lists[this.focus].render(rowSets[this.focus], inner, Math.max(8, height - 12), columns, this.ctx, "") },
					{ title: this.focus === 1 ? "Request distribution" : "Known-priced cost distribution", meta: "Included projects · search does not change distribution",
						render: inner => scoped.length ? [
							...ranking(this.ctx, inner, (this.focus === 1 ? requests : cost).slice(0, 6).map(row => ({
								label: row.folder.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "(root)", value: this.focus === 1 ? row.totalRequests : row.totalCost,
								display: this.focus === 1 ? formatCompact(row.totalRequests) : formatEstimatedCost(row.totalCost, row.unpricedRequests),
							}))), "", sectionHeading(this.ctx, inner, "Selected project"),
							...wrap([picked ? picked.folder || "(root)" : "No project matches the current search.", ...(picked ? [`${formatCompact(picked.totalRequests)} requests · ${formatCompact(picked.conversationTokens)} tokens`, `${formatPercent(picked.errorRate)} errors · ${formatPercent(picked.cacheRate)} cache hit`] : [])], inner),
						] : emptyState(this.ctx, inner, "No projects visible", "No projects match the current search or temporary-folder filter.", "Clear search or press t to include temporary projects.") },
				])];
		}
		const points = this.data.dailyActivity ?? [];
		const weeks = weeksForWidth(2, Math.max(1, width - 4));
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
		const needle = this.days.search.trim().toLowerCase();
		const rows = this.days.rows(points.filter(point => !needle || point.day.includes(needle)), DAY_SORT);
		const recordedPanel: DashboardPanel = { title: "Recorded days", active: this.focus === 0, meta: "/ search · o/O sort · Enter inspect", render: inner => this.days.render(rows, inner, Math.min(12, Math.max(7, height - 19)), [
			{ key: "day", header: "Day", align: "left", value: point => point.day },
			{ key: "requests", header: "Req", align: "right", priority: 0, value: point => formatCompact(point.requests) },
			{ key: "cost", header: "API cost", align: "right", priority: 1, value: point => formatEstimatedCost(point.cost, 0) },
			{ key: "tokens", header: "Tokens", align: "right", priority: 2, value: point => formatCompact(point.totalTokens) },
		], this.ctx, "") };
		const calendar = panel(this.ctx, width, "Activity calendar", [
			...renderHeatmap(points, { innerWidth: Math.max(1, width - 4), labelWidth: 2, weeks, glyphs: glyphsFor(this.ctx.theme.getSymbolPreset()), ramp: [1, 2, 3, 4].map(level => heatRamp(this.ctx.theme, level)), dim: text => this.ctx.theme.fg("muted", text), today, selectedDay: selected.day, selected: text => this.ctx.theme.bg(SELECTION_BG.band, this.ctx.theme.fg("accent", text)) }),
			...wrap([this.ctx.theme.fg("muted", `${localDay(layout.start)}–${localDay(today)} · ${layout.totalRequests} requests · ${formatEstimatedCost(layout.totalCost, 0)}`)], Math.max(1, width - 4)),
		], { active: this.focus === 1, meta: `${weeks} weeks · j/k day · h/l week · t today · Enter inspect` });
		const dayPanel: DashboardPanel = { title: "Selected local day", render: inner => [
			this.ctx.theme.bold(selected.day), "",
			...ranking(this.ctx, inner, [
				{ label: "Requests", value: selected.requests, display: formatCompact(selected.requests) },
			]),
			"", `API cost ${formatEstimatedCost(selected.cost, 0)} · Tokens ${formatCompact(selected.totalTokens)}`,
			...wrap([selected.requests === 0 ? "No activity recorded for this local day." : "Enter on the calendar opens the recorded day details.", "Latest 371 local days · independent of the global range."], inner),
		] };
		return [...wrap(prefix, width), ...metricGrid(this.ctx, width, [
			{ label: "Day requests", value: formatCompact(selected.requests), hint: selected.day, emphasis: "primary" },
			{ label: "Day API cost", value: formatEstimatedCost(selected.cost, 0), hint: "selected local day" },
			{ label: "Day tokens", value: formatCompact(selected.totalTokens), hint: `${points.length} recorded days` },
		]), "", ...focusTabs(this.ctx, width, ["Recorded days", "Calendar"], this.focus), "",
			...(width < 100 && this.focus === 0
				? [...dashboardPanels(this.ctx, width, [recordedPanel, dayPanel]), "", ...calendar]
				: [...calendar, "", ...dashboardPanels(this.ctx, width, [recordedPanel, dayPanel])])];
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
	dispose(): void { this.closed = true; this.generation++; this.details.dispose(); }
}
