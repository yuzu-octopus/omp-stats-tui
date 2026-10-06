import { modelKey } from "@oh-my-pi/omp-stats/client/data/colors";
import { formatCompact, formatCost, formatDurationMs, formatEstimatedCost, formatInteger, formatPercent, formatTokensPerSecond } from "@oh-my-pi/omp-stats/client/data/formatters";
import { bucketAxis, rangeMeta } from "@oh-my-pi/omp-stats/client/data/range";
import { densify, pivotSeries } from "@oh-my-pi/omp-stats/client/data/series";
import { buildCostSummary, buildModelPerformanceLookup, buildToolRows, sumConversationTokens, type ModelPerformanceDataPoint, type ToolRowView } from "@oh-my-pi/omp-stats/client/data/view-models";
import type { ModelStats, ToolDashboardStats } from "@oh-my-pi/omp-stats/shared-types";
import type { CostPayload, ModelDashboardPayload } from "../../../data/api";
import type { Range } from "../../../data/ranges";
import { renderTimeSeries } from "../../charts/time-series";
import type { StatTile } from "../../band";
import { dashboardPanels, emptyState, focusTabs, metricGrid, panel, ranking, sectionHeading } from "../presentation";
import type { FeatureContext, FeatureController } from "../types";
import { ChartState, ListState, fields, wrap, type CoreSeries, type ListColumn, type Sorters } from "./shared";

type AnalyticsId = "models" | "costs" | "tools";
interface Row {
	key: string;
	label: string;
	values: Record<string, unknown>;
	display: Record<string, unknown>;
	tool?: string;
}
interface Table {
	state: ListState<Row>;
	rows: Row[];
	title: string;
}
const COMPONENTS = [
	{ key: "costInput", label: "Input" },
	{ key: "costOutput", label: "Output" },
	{ key: "costCacheRead", label: "Cache read" },
	{ key: "costCacheWrite", label: "Cache write" },
] as const;
const DAY_MS = 86_400_000;
const row = (key: string, label: string, values: Record<string, unknown>, display: Record<string, unknown> = values, tool?: string): Row => ({ key, label, values, display, tool });
const table = (title: string, sort: string, limit: number): Table => ({ title, state: new ListState<Row>(r => r.key, sort, limit), rows: [] });
const sorters = (rows: readonly Row[]): Sorters<Row> => {
	const keys = new Set(rows.flatMap(r => Object.keys(r.values)));
	return Object.fromEntries([...keys].map(key => [key, (r: Row) => {
		const value = r.values[key];
		return typeof value === "number" || typeof value === "string" ? value : null;
	}]));
};
const denseSeries = (series: readonly { key: string; label: string; values: readonly (number | null)[] }[]): CoreSeries[] => series.map(s => ({ key: s.key, label: s.label, values: s.values.map(v => v ?? 0) }));
const shares = (series: readonly CoreSeries[], totals: readonly number[]): CoreSeries[] => series.map(s => ({ ...s, values: s.values.map((v, i) => totals[i] > 0 && v !== null ? v / totals[i] : null) }));
const identity = (model: string, provider: string): string => `${model || "(unknown)"} · ${provider}`;

class AnalyticsFeature implements FeatureController {
	private closed = false;
	private generation = 0;
	private loading = false;
	private error: string | null = null;
	private range: Range = "24h";
	private focus = 0;
	private expanded: { table: number; key: string } | null = null;
	private readonly chart = new ChartState();
	private readonly performanceChart = new ChartState();
	private readonly trendChart = new ChartState();
	private detailMode: "performance" | "trend" = "performance";
	private trends = new Map<string, CoreSeries>();
	private readonly tables: Table[];
	private buckets: number[] = [];
	private modes: { label: string; series: CoreSeries[]; unit: string }[] = [];
	private metrics: StatTile[] = [];
	private performance = new Map<string, ModelPerformanceDataPoint[]>();
	private unpriced: number[] = [];
	private costSeriesUnknown = new Map<string, number[]>();
	private costs: CostPayload | null = null;
	private toolFilter: string | null = null;
	private toolNames: string[] = [];

	constructor(private readonly id: AnalyticsId, private readonly ctx: FeatureContext) {
		this.tables = id === "models" ? [table("All models", "totalRequests", 25)] : id === "costs" ? [table("By model", "cost", 20), table("Billing components", "cost", 4)] : [table("By tool", "calls", 20), table("By tool and model", "calls", 25)];
	}

	async load(range: Range): Promise<void> {
		if (this.closed) return;
		const generation = ++this.generation;
		this.range = range;
		this.loading = true;
		this.error = null;
		this.ctx.changed();
		try {
			// Build and commit only the response belonging to this screen's latest load.
			if (this.id === "models") {
				const data = await this.ctx.reader.api<ModelDashboardPayload>("/api/stats/model-dashboard", { range });
				if (this.closed || generation !== this.generation) return;
				this.setModels(data, range);
			} else if (this.id === "costs") {
				const data = await this.ctx.reader.api<CostPayload>("/api/stats/costs", { range });
				if (this.closed || generation !== this.generation) return;
				this.setCosts(data, range);
			} else {
				const data = await this.ctx.reader.api<ToolDashboardStats>("/api/stats/tools", { range });
				if (this.closed || generation !== this.generation) return;
				this.setTools(data, range);
			}
			this.chart.reconcile(this.buckets, this.mode()?.series.map(series => series.key) ?? []);
			for (let i = 0; i < this.tables.length; i++) {
				const t = this.tables[i];
				if (t.state.selected === null) t.state.selected = this.rows(i)[0]?.key ?? null;
			}
		} catch (error) {
			if (!this.closed && generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.closed && generation === this.generation) {
				this.loading = false;
				this.ctx.changed();
			}
		}
	}

	private axis(range: Range, timestamps: Iterable<number>, bucketMs = rangeMeta(range).bucketMs): number[] {
		return bucketAxis(range, timestamps, bucketMs, this.ctx.now());
	}

	private setModels(data: ModelDashboardPayload, range: Range): void {
		const timestamps = data.modelSeries.map(p => p.timestamp);
		this.buckets = this.axis(range, timestamps);
		this.chart.seedLatestPoint(this.buckets, timestamps);
		const counts = denseSeries(pivotSeries(data.modelSeries, { buckets: this.buckets, key: p => modelKey(p.model, p.provider), label: key => {
			const m = data.byModel.find(m => modelKey(m.model, m.provider) === key);
			return m ? identity(m.model, m.provider) : key;
		}, value: p => p.requests, limit: 6 }));
		const totals = densify(data.modelSeries, this.buckets, p => p.requests);
		this.modes = [{ label: "Request share", series: shares(counts, totals), unit: "share" }, { label: "Request counts", series: counts, unit: "requests" }];
		this.performance = buildModelPerformanceLookup(data.modelPerformanceSeries);
		this.trends = new Map(denseSeries(pivotSeries(data.modelSeries, { buckets: this.buckets, key: p => modelKey(p.model, p.provider), label: key => {
			const model = data.byModel.find(model => modelKey(model.model, model.provider) === key);
			return model ? identity(model.model, model.provider) : key;
		}, value: p => p.requests })).map(series => [series.key, series]));
		this.tables[0].rows = data.byModel.map(m => row(modelKey(m.model, m.provider), identity(m.model, m.provider), { ...m, conversationTokens: sumConversationTokens(m) }, {
			...m, totalCost: formatEstimatedCost(m.totalCost, m.unpricedRequests), errorRate: formatPercent(m.errorRate), cacheRate: formatPercent(m.cacheRate), cacheSavings: formatPercent(m.cacheSavings),
			avgDuration: formatDurationMs(m.avgDuration), avgTtft: formatDurationMs(m.avgTtft), avgTokensPerSecond: `${formatTokensPerSecond(m.avgTokensPerSecond)} tok/s`, conversationTokens: sumConversationTokens(m),
		}));
		const sum = (key: "totalRequests" | "failedRequests" | "totalCost" | "unpricedRequests") => data.byModel.reduce((total, m) => total + m[key], 0);
		this.metrics = [
			{ label: "Requests", value: formatInteger(sum("totalRequests")), emphasis: "primary", spark: totals },
			{ label: "Models", value: formatInteger(data.byModel.length), hint: `${new Set(data.byModel.map(m => m.provider)).size} providers` },
			{ label: "Failed", value: formatInteger(sum("failedRequests")) },
			{ label: "API estimate", value: formatEstimatedCost(sum("totalCost"), sum("unpricedRequests")), hint: `${formatInteger(sum("unpricedRequests"))} unpriced` },
		];
	}

	private setCosts(data: CostPayload, range: Range): void {
		this.costs = data;
		const summary = buildCostSummary(data.costSeries);
		const timestamps = data.costSeries.map(p => p.timestamp);
		this.buckets = this.axis(range, timestamps, DAY_MS);
		this.chart.seedLatestPoint(this.buckets, timestamps);
		this.unpriced = densify(data.costSeries, this.buckets, p => p.unpricedRequests);
		const byKey = new Map(summary.models.map(m => [m.key, m]));
		const models = denseSeries(pivotSeries(data.costSeries, { buckets: this.buckets, key: p => modelKey(p.model, p.provider), label: key => {
			const m = byKey.get(key);
			return m ? identity(m.model, m.provider) : key;
		}, value: p => p.cost, limit: 6 }));
		const individualKeys = new Set(models.filter(s => s.key !== "__other__").map(s => s.key));
		this.costSeriesUnknown = new Map(models.map(s => [s.key, densify(data.costSeries, this.buckets, p => {
			const key = modelKey(p.model, p.provider);
			return (s.key === "__other__" ? !individualKeys.has(key) : key === s.key) ? p.unpricedRequests : 0;
		})]));
		this.modes = [{ label: "Daily estimate by model (UTC)", series: models, unit: "USD" }, { label: "Daily estimate by component (UTC)", series: COMPONENTS.map(c => ({ ...c, values: densify(data.costSeries, this.buckets, p => p[c.key]) })), unit: "USD" }];
		this.tables[0].rows = summary.models.map(m => {
			const perPricedRequest = m.requests > m.unpricedRequests ? m.cost / (m.requests - m.unpricedRequests) : null;
			return row(m.key, identity(m.model, m.provider), { ...m, perPricedRequest }, { ...m, cost: `${formatEstimatedCost(m.cost, m.unpricedRequests)} · Unknown requests: ${formatInteger(m.unpricedRequests)}`, share: m.cost === 0 && m.unpricedRequests > 0 ? "N/A" : formatPercent(m.share), ...Object.fromEntries(COMPONENTS.map(c => [c.key, `${formatEstimatedCost(m[c.key], m.unpricedRequests)} · Unknown requests: ${formatInteger(m.unpricedRequests)}`])), perPricedRequest: `${perPricedRequest === null ? "N/A" : perPricedRequest > 0 && perPricedRequest < 0.0001 ? "<$0.0001" : formatCost(perPricedRequest)} · Unknown requests excluded: ${formatInteger(m.unpricedRequests)}` });
		});
		this.tables[1].rows = COMPONENTS.map(c => {
			const values = { component: c.label, cost: summary[c.key], share: summary.totalCost > 0 ? summary[c.key] / summary.totalCost : 0, unpricedRequests: summary.unpricedRequests };
			return row(c.key, c.label, values, { ...values, cost: `${formatEstimatedCost(values.cost, summary.unpricedRequests)} · Unknown requests: ${formatInteger(summary.unpricedRequests)}`, share: summary.totalCost > 0 ? formatPercent(values.share) : "N/A" });
		});
		const priced = summary.requests - summary.unpricedRequests;
		this.metrics = [
			{ label: "API estimate", value: formatEstimatedCost(summary.totalCost, summary.unpricedRequests), emphasis: "primary", hint: "Public API rates", spark: densify(data.costSeries, this.buckets, p => p.cost) },
			{ label: "Requests", value: formatInteger(summary.requests), hint: `${formatInteger(summary.unpricedRequests)} unpriced` },
			{ label: "Per active day", value: formatEstimatedCost(summary.avgDailyCost, summary.unpricedRequests), hint: `${summary.activeDays} active UTC days` },
			{ label: "Per priced request", value: priced > 0 ? formatCost(summary.totalCost / priced) : "N/A", hint: "Priced requests only" },
		];
	}

	private setTools(data: ToolDashboardStats, range: Range): void {
		const timestamps = data.series.map(p => p.timestamp);
		this.buckets = this.axis(range, timestamps);
		this.chart.seedLatestPoint(this.buckets, timestamps);
		const calls = denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: p => p.tool, value: p => p.calls, limit: 6 }));
		const errors = denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: p => p.tool, value: p => p.errors, limit: 6 }));
		this.modes = [{ label: "Tool call counts (all tools)", series: calls, unit: "calls" }, { label: "Tool error counts (all tools)", series: errors, unit: "errors" }, { label: "Tool call share (all tools)", series: shares(calls, densify(data.series, this.buckets, p => p.calls)), unit: "share" }, { label: "Tool error share (all tools)", series: shares(errors, densify(data.series, this.buckets, p => p.errors)), unit: "share" }];
		this.trends = new Map(denseSeries(pivotSeries(data.series, { buckets: this.buckets, key: p => p.tool, value: p => p.calls })).map(series => [series.key, series]));
		const display = (t: ToolRowView): Record<string, unknown> => ({ ...t, costShare: formatEstimatedCost(t.costShare, t.unpricedRequestsShare), errorRate: formatPercent(t.errorRate), callFraction: formatPercent(t.callFraction), tokenFraction: formatPercent(t.tokenFraction), costFraction: formatPercent(t.costFraction) });
		this.tables[0].rows = buildToolRows(data.byTool).map(t => row(t.tool, t.tool, { ...t }, display(t), t.tool));
		// Reuse upstream rates/shares, retaining each tool/provider/model identity.
		this.tables[1].rows = buildToolRows(data.byToolModel).map((t, i) => {
			const m = data.byToolModel[i];
			return row(JSON.stringify([m.tool, modelKey(m.model, m.provider)]), `${m.tool} · ${identity(m.model, m.provider)}`, { ...m, ...t }, { ...m, ...display(t) }, m.tool);
		});
		this.toolNames = data.byTool.map(t => t.tool).sort((a, b) => a.localeCompare(b));
		const totals = data.byTool.reduce((s, t) => ({ calls: s.calls + t.calls, errors: s.errors + t.errors, tokens: s.tokens + t.totalTokensShare, output: s.output + t.outputTokensShare, cost: s.cost + t.costShare, unpriced: s.unpriced + t.unpricedRequestsShare, result: s.result + t.resultChars, args: s.args + t.argsChars }), { calls: 0, errors: 0, tokens: 0, output: 0, cost: 0, unpriced: 0, result: 0, args: 0 });
		this.metrics = [
			{ label: "Tool calls", value: formatInteger(totals.calls), emphasis: "primary", hint: `${data.byTool.length} distinct tools`, spark: densify(data.series, this.buckets, p => p.calls) },
			{ label: "Errors", value: formatInteger(totals.errors), hint: formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0) },
			{ label: "Attributed tokens", value: formatCompact(totals.tokens), hint: `${formatCompact(totals.output)} output` },
			{ label: "API estimate", value: formatEstimatedCost(totals.cost, totals.unpriced), hint: `${formatInteger(totals.unpriced)} unpriced` },
			{ label: "Result text", value: `${formatCompact(totals.result)} chars`, hint: `${formatCompact(totals.calls > 0 ? Math.round(totals.result / totals.calls) : 0)} / call` },
			{ label: "Call arguments", value: `${formatCompact(totals.args)} chars`, hint: `${formatCompact(totals.calls > 0 ? Math.round(totals.args / totals.calls) : 0)} / call` },
		];
	}

	private rows(index: number): Row[] {
		const t = this.tables[index];
		const search = t.state.search.toLocaleLowerCase();
		// Preserve the pick across ranges, but apply it only while that tool exists.
		const filter = this.toolFilter !== null && this.toolNames.includes(this.toolFilter) ? this.toolFilter : null;
		return t.state.rows(t.rows.filter(r => (this.id !== "tools" || index !== 1 || filter === null || r.tool === filter) && (!search || `${r.label} ${fields(r.values).join(" ")}`.toLocaleLowerCase().includes(search))), sorters(t.rows));
	}

	private mode() { return this.modes[this.chart.mode % Math.max(1, this.modes.length)]; }

	render(width: number, height: number): readonly string[] {
		const lines = [sectionHeading(this.ctx, width, this.id[0].toUpperCase() + this.id.slice(1), this.range)];
		const filter = this.toolFilter !== null && this.toolNames.includes(this.toolFilter) ? this.toolFilter : null;
		if (this.loading) lines.push(this.ctx.theme.fg("muted", this.modes.length ? "Loading… Previous observations remain visible." : "Loading observations…"));
		if (this.error) lines.push(this.ctx.theme.fg("error", this.error));
		if (!this.modes.length) {
			lines.push(...panel(this.ctx, width, "Observations", emptyState(this.ctx, Math.max(1, width - 4),
				this.loading ? "Reading the selected range" : this.error ? "Observations unavailable" : "No observations loaded yet",
				this.loading ? "Recorded metrics will appear when the read completes." : "Choose a range to load recorded metrics.")));
			return wrap(lines, width);
		}
		if (this.expanded) {
			const selected = this.rows(this.expanded.table).find(r => r.key === this.expanded?.key);
			if (selected) {
				lines.push(sectionHeading(this.ctx, width, `Details: ${selected.label}`));
				lines.push(...wrap([this.ctx.theme.fg("muted", this.id === "models"
					? `m ${this.detailMode === "performance" ? "requests trend" : "performance chart"} · n/v series · ,/. point · b/Esc back`
					: this.id === "tools" ? "n/v series · ,/. point · b/Esc back" : "b/Esc back")], width));
				const trend = this.trends.get(this.id === "tools" ? selected.tool ?? selected.key : selected.key);
				const panels = [];
				if (this.id === "models" || this.id === "tools") panels.push({
					title: this.id === "models" && this.detailMode === "performance" ? "Response performance" : this.id === "tools" ? "Tool call trend (all models)" : "Model request trend",
					render: (innerWidth: number) => this.id === "models" && this.detailMode === "performance"
						? this.renderPerformance(selected.key, innerWidth)
						: this.trendChart.render(this.ctx, innerWidth, this.buckets, trend ? [trend] : [], { height: 4, unit: this.id === "tools" ? "calls" : "requests", format: formatInteger }),
				});
				panels.push({ title: "Recorded metrics", render: (innerWidth: number) => wrap(fields(selected.display), innerWidth) });
				lines.push(...dashboardPanels(this.ctx, width, panels));
				return wrap(lines, width);
			}
		}
		lines.push(...metricGrid(this.ctx, width, this.metrics));
		if (this.id === "costs") lines.push(...wrap([this.ctx.theme.fg("muted", `${formatInteger(this.unpriced.reduce((total, count) => total + count, 0))} unpriced · API estimate excludes unpriced usage, not free. Shares use the priced estimate.`)], width));
		if (this.id === "tools") lines.push(...wrap([this.ctx.theme.fg("muted", "Attribution: invoking-turn tokens/cost split across tool calls.")], width));
		lines.push(...focusTabs(this.ctx, width, ["Chart", ...this.tables.map(table => table.title)], this.focus));
		lines.push(...wrap([this.ctx.theme.fg("muted", this.focus === 0 ? "Tab pane · m mode · n/v series · ,/. point"
			: `Tab pane · / search · j/k select · o/O sort · +/a reveal · ${this.id === "tools" ? "Enter filter · d details · f/x tool" : "Enter details"} · Esc clear`)], width));
		const primary = this.focus > 0 ? this.focus - 1 : 0;
		const tablePanel = (index: number) => ({
			title: this.tables[index].title,
			meta: this.id === "tools" && index === 1 ? `Tool filter: ${filter ?? "All tools"}` : undefined,
			active: this.focus === index + 1,
			render: (innerWidth: number) => this.renderTable(index, innerWidth, Math.max(7, height - lines.length - 4)),
		});
		const chartPanel = {
			title: this.mode()?.label ?? "Activity",
			active: this.focus === 0,
			render: (innerWidth: number) => this.renderChart(innerWidth),
		};
		// On narrow screens the active table comes first; wide screens keep it
		// beside the chart so a long legend cannot displace the working viewport.
		lines.push(...dashboardPanels(this.ctx, width, this.focus > 0 ? [tablePanel(primary), chartPanel] : [chartPanel, tablePanel(primary)], { ratio: this.focus > 0 ? 0.58 : 0.46 }));
		for (let index = 0; index < this.tables.length; index++) {
			if (index === primary) continue;
			const secondary = tablePanel(index);
			lines.push(...panel(this.ctx, width, secondary.title, secondary.render(Math.max(1, width - 4)), { meta: secondary.meta, active: secondary.active }));
		}
		return wrap(lines, width);
	}

	private renderChart(width: number): string[] {
		const mode = this.mode();
		if (!mode || !this.buckets.length) return emptyState(this.ctx, width, "No observations in this range", "Choose another range to inspect recorded activity.");
		this.chart.reconcile(this.buckets, mode.series.map(series => series.key));
		const lines: string[] = [];
		const unknown = this.unpriced.reduce((total, count) => total + count, 0);
		if (this.id === "costs" && unknown > 0 && mode.series.every(s => s.values.every(value => value === 0)))
			lines.push(...wrap([`No priced cost / unknown ${formatInteger(unknown)} requests. Unpriced usage is not zero spend.`], width));
		lines.push(...this.chart.render(this.ctx, width, this.buckets, mode.series, {
			unit: mode.unit === "USD" ? "known-priced USD / day" : mode.unit, percent: mode.unit === "share", stacked: true,
			format: mode.unit === "USD" ? formatCost : mode.unit === "share" ? formatPercent : formatCompact, height: this.buckets.length <= 2 ? 3 : 5,
			formatValue: mode.unit === "USD" ? (key, value, point) => value === null || value === undefined ? "—" : formatEstimatedCost(value, this.chart.mode % 2 === 0 ? this.costSeriesUnknown.get(key)?.[point] ?? 0 : this.unpriced[point] ?? 0) : undefined,
		}));
		if (this.id === "costs") {
			const point = this.chart.point;
			const hasPricedCost = this.tables[1].rows.some(component => Number(component.values.cost) > 0);
			lines.push(...wrap([this.ctx.theme.fg("muted", `${formatInteger(this.unpriced[point] ?? 0)} unpriced in selected UTC day`)], width));
			// Preserve attribution for identities that have no positive priced series.
			for (const p of this.costs?.costSeries ?? []) if (p.timestamp === this.buckets[point] && p.unpricedRequests > 0)
				lines.push(...wrap([`${identity(p.model, p.provider)} · ${formatEstimatedCost(p.cost, p.unpricedRequests)} · ${formatInteger(p.unpricedRequests)} unpriced`], width));
			lines.push(sectionHeading(this.ctx, width, "Component shares", "Priced estimate"),
				...ranking(this.ctx, width, this.tables[1].rows.map(component => ({
					label: component.label, value: Number(component.values.cost),
					display: `${formatEstimatedCost(Number(component.values.cost), unknown)} · ${hasPricedCost ? formatPercent(Number(component.values.share)) : "N/A"}`,
				}))));
		}
		return lines;
	}

	private renderTable(index: number, width: number, height: number): string[] {
		const table = this.tables[index];
		const numeric = (key: string, header: string, priority = 0): ListColumn<Row> => ({
			key, header, align: "right", priority, value: row => {
				const value = row.display[key];
				return typeof value === "number" ? Math.abs(value) < 10_000 ? formatInteger(value) : formatCompact(value) : value == null ? "—" : String(value).split(" · ")[0];
			},
		});
		const columns: ListColumn<Row>[] = [{ key: "identity", header: this.id === "tools" ? "Tool / model" : index === 1 ? "Component" : "Model / provider", align: "left", value: row => row.label }];
		if (this.id === "models") columns.push(numeric("totalRequests", "Requests"), numeric("totalCost", "Estimate", 1), numeric("errorRate", "Errors", 3), numeric("conversationTokens", "Tokens", 4), numeric("avgDuration", "Duration", 5), numeric("avgTtft", "TTFT", 6), numeric("avgTokensPerSecond", "tok/s", 7));
		else if (this.id === "costs") columns.push(numeric("cost", "Estimate"), numeric("unpricedRequests", "Unpriced", 1), numeric("share", "Share", 3), ...(index === 0 ? [numeric("requests", "Requests", 2), numeric("perPricedRequest", "/ priced req", 4)] : []));
		else columns.push(numeric("calls", "Calls"), numeric("errors", "Errors", 2), numeric("costShare", "Estimate", 1), numeric("totalTokensShare", "Tokens", 3), numeric("errorRate", "Error %", 4));
		return [...table.state.render(this.rows(index), width, Math.max(5, height), columns, this.ctx, "")];
	}

	private renderPerformance(key: string, width: number): string[] {
		const points = this.performance.get(key) ?? [];
		if (!points.length) return ["No performance samples. Timing is recorded for streamed responses."];
		this.performanceChart.reconcile(points.map(point => point.timestamp), ["tps", "ttft"]);
		const p = points[this.performanceChart.point];
		const series = [{ key: "tps", label: "Throughput (tok/s)", values: points.map(p => p.avgTokensPerSecond) }, { key: "ttft", label: "TTFT (seconds)", values: points.map(p => p.avgTtftSeconds) }];
		const lines = [...metricGrid(this.ctx, width, [
			{ label: "Throughput", value: `${formatTokensPerSecond(p.avgTokensPerSecond)} tok/s`, emphasis: "primary" },
			{ label: "TTFT", value: p.avgTtftSeconds === null ? "—" : formatDurationMs(p.avgTtftSeconds * 1000) },
			{ label: "Requests", value: formatInteger(p.requests), hint: new Date(p.timestamp).toISOString() },
		]), ...series.map((s, i) => `${i === this.performanceChart.seriesIndex % series.length ? ">" : " "} ${this.performanceChart.hidden.has(s.key) ? "off" : "on"} ${s.label}`)];
		// Different units retain independent scales and honest missing samples.
		for (const s of series) if (!this.performanceChart.hidden.has(s.key)) lines.push(...renderTimeSeries(this.ctx, points.map(point => point.timestamp), [s], width, this.performanceChart.point, {
			height: 4, unit: s.key === "tps" ? "tok/s" : "s", format: value => s.key === "tps" ? formatTokensPerSecond(value) : formatDurationMs(value * 1000), legend: false,
		}));
		return lines;
	}

	get inputMode(): "text" | "navigation" {
		return this.tables[this.focus - 1]?.state.editing ? "text" : "navigation";
	}
	handleInput(data: string): boolean {
		if (this.closed || this.inputMode !== "text" && (data === "q" || data === "[" || data === "]") ||
			data === "\x1b[C" || data === "\x1b[D") return false;
		const active = this.focus > 0 ? this.tables[this.focus - 1] : null;
		let consumed = false;
		if (active?.state.editing && data !== "\t" && data !== "\x1b[Z") consumed = active.state.input(data, this.rows(this.focus - 1));
		else if (data === "\t" || data === "\x1b[Z") {
			if (active) active.state.editing = false;
			this.focus = (this.focus + (data === "\t" ? 1 : this.tables.length)) % (this.tables.length + 1);
			consumed = true;
		} else if (data === "b" || data === "\x1b") {
			if (this.expanded) { this.expanded = null; consumed = true; }
			else if (active?.state.search) { active.state.search = ""; consumed = true; }
			else if (this.toolFilter !== null) { this.toolFilter = null; consumed = true; }
			else if (this.focus !== 0) { this.focus = 0; consumed = true; }
		} else if (this.id === "tools" && (data === "f" || data === "x")) {
			if (data === "x") this.toolFilter = null;
			else this.toolFilter = this.toolNames[this.toolFilter === null ? 0 : this.toolNames.indexOf(this.toolFilter) + 1] ?? null;
			this.expanded = null;
			consumed = true;
		} else if (this.expanded && this.rows(this.expanded.table).some(row => row.key === this.expanded?.key) && (this.id === "models" || this.id === "tools")) {
			const selected = this.rows(this.expanded.table).find(row => row.key === this.expanded?.key);
			if (this.id === "models" && data === "m") { this.detailMode = this.detailMode === "performance" ? "trend" : "performance"; consumed = true; }
			else if (this.id === "models" && this.detailMode === "performance") consumed = this.performanceChart.input(data, ["tps", "ttft"]);
			else consumed = this.trendChart.input(data, selected ? [this.id === "tools" ? selected.tool ?? selected.key : selected.key] : []);
		} else if (data === "m") { this.chart.mode = (this.chart.mode + 1) % Math.max(1, this.modes.length); consumed = true; }
		else if (this.focus === 0) consumed = this.chart.input(data, this.mode()?.series.map(s => s.key) ?? []);
		else if (active) {
			const rows = this.rows(this.focus - 1);
			if (data === "o" || data === "O") {
				if (data === "O") active.state.descending = !active.state.descending;
				else { const keys = Object.keys(sorters(active.rows)); active.state.sort = keys[(keys.indexOf(active.state.sort) + 1) % Math.max(1, keys.length)] ?? active.state.sort; }
				consumed = true;
			} else if (data === "\r" || data === "\n" || this.id === "tools" && data === "d") {
				const selected = active.state.current(rows);
				if (selected) {
					active.state.selected = selected.key;
					if (this.id === "tools" && this.focus === 1 && data !== "d") { this.toolFilter = this.toolFilter === selected.tool ? null : selected.tool ?? null; this.expanded = null; }
					else this.expanded = this.expanded?.table === this.focus - 1 && this.expanded.key === selected.key ? null : { table: this.focus - 1, key: selected.key };
				}
				consumed = true;
			} else consumed = active.state.input(data, rows);
		}
		if (consumed) this.ctx.changed();
		return consumed;
	}

	dispose(): void { this.closed = true; this.generation++; }
}

export function createAnalyticsFeature(id: AnalyticsId, ctx: FeatureContext): FeatureController {
	return new AnalyticsFeature(id, ctx);
}
