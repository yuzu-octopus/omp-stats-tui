import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { GainDashboardStats, GainSourceTotals } from "@oh-my-pi/omp-stats/shared-types";
import { compactTokens, formatBytes, formatInteger, formatPercent } from "../format";
import type { Range } from "../../data/ranges";
import type { FeatureContext, FeatureController } from "./types";
import { projectOptions, savingsHistory } from "./provider-gain-data";
import { boundLines, recordViewport } from "./provider-gain-chart";
import { renderTimeSeries } from "../charts/time-series";
import { dashboardPanels, dataTable, emptyState, focusTabs, metricGrid, panel, sectionHeading } from "./presentation";

const SORTS = ["tokens", "source", "share", "bytes", "hits", "reduction"] as const;
type SourceRow = GainSourceTotals & { source: string; share: number };
export function createGainFeature(ctx: FeatureContext): FeatureController {
	let range: Range = "24h";
	let project: string | null = null;
	let projects: string[] = [];
	let data: GainDashboardStats | null = null;
	let generation = 0;
	let closed = false;
	let loading = false;
	let error: string | null = null;
	let focus = 0;
	let point = -1;
	let selected = 0;
	let selectedSource: string | null = null;
	let sort = 0;
	let descending = true;
	let reveal = 12;
	let expanded = false;
	const rows = (): SourceRow[] => {
		if (!data) return [];
		const result = Object.entries(data.bySource).map(([source, totals]) => ({ ...totals, source, share: data!.overall.savedTokens > 0 ? totals.savedTokens / data!.overall.savedTokens : 0 }));
		const key = SORTS[sort];
		return result.sort((a, b) => {
			const av = key === "source" ? a.source : key === "tokens" ? a.savedTokens : key === "bytes" ? a.savedBytes : key === "hits" ? a.hits : key === "share" ? a.share : a.reductionPercent ?? -1;
			const bv = key === "source" ? b.source : key === "tokens" ? b.savedTokens : key === "bytes" ? b.savedBytes : key === "hits" ? b.hits : key === "share" ? b.share : b.reductionPercent ?? -1;
			return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
		});
	};
	async function load(nextRange: Range): Promise<void> {
		if (closed) return;
		if (range !== nextRange) { data = null; point = -1; }
		range = nextRange;
		const request = ++generation;
		const requestedProject = project;
		loading = true; error = null; ctx.changed();
		try {
			const next = await ctx.reader.api<GainDashboardStats>("/api/stats/gain", project === null ? { range } : { range, project });
			if (closed || request !== generation || requestedProject !== project) return;
			data = next; projects = [...next.projects];
			const history = savingsHistory(next.timeSeries, range, ctx.now());
			point = point < 0 ? history.axis.length - 1 : Math.min(point, history.axis.length - 1);
			selected = Math.min(selected, Math.max(0, rows().length - 1));
		} catch (cause) {
			if (closed || request !== generation) return;
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (!closed && request === generation) { loading = false; ctx.changed(); }
		}
	}
	return {
		load,
		render(width, height) {
			const lines = [ctx.theme.bold(`Gain · ${range} · ${project ?? "All projects"}`)];
			if (error) lines.push(ctx.theme.fg("error", `Savings error: ${error}${data ? " · showing previous reading for this scope" : ""}`));
			const empty = data !== null && data.overall.hits === 0 && data.timeSeries.length === 0;
			if (data && !empty) {
				const t = data.overall;
				lines.push(...metricGrid(ctx, width, [
					{ label: "Saved tokens", value: compactTokens(t.savedTokens), emphasis: "primary" },
					{ label: "Saved bytes", value: formatBytes(t.savedBytes), hint: `${formatInteger(t.hits)} recorded hits` },
					{ label: "Reduction", value: t.reductionPercent === null ? "—" : formatPercent(t.reductionPercent), hint: t.reductionPercent === null ? "original size not recorded" : "recorded original bytes" },
				]));
			}
			lines.push(...focusTabs(ctx, width, ["Projects", "History", "Sources"], focus));
			const hint = focus === 0 ? "p/P project · j/k select" : focus === 1 ? "h/l UTC day · p/P project" : "j/k source · o sort · d direction · Enter detail · + reveal";
			lines.push(...wrapTextWithAnsi(ctx.theme.fg("muted", `Tab focus · ${hint}${loading ? " · loading" : ""}`), width));
			if (!data) {
				lines.push(...panel(ctx, width, "Recorded savings", emptyState(ctx, Math.max(1, width - 4), loading ? "Loading scoped savings…" : "Savings unavailable", "Savings totals and history are requested for the selected project and range.")));
				return boundLines(lines, width);
			}
			const options = projectOptions(projects, project);
			const projectViewport = recordViewport(options, options.indexOf(project), Math.max(1, height - lines.length - 3), Math.min(reveal, 6));
			if (empty) {
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Recorded savings", meta: `${range} · selected project`,
						render: innerWidth => emptyState(ctx, innerWidth, "No savings recorded", `No savings recorded for ${project ?? "all projects"} in ${range}. Savings appear when snapcompact compacts tool output; only recorded reductions count here.`, range === "all" ? "Choose another project to inspect its recording history." : "Try a longer range or choose another project."),
					},
					{
						title: "Projects", meta: `${options.length - 1} available · p/P select`, active: focus === 0,
						render: innerWidth => [
							...dataTable(ctx, innerWidth, "", [{ key: "project", header: "Project", align: "left" }], projectViewport.rows.map(p => ({ project: p ?? "All projects" })), options.indexOf(project) - projectViewport.start),
							"",
							...wrapTextWithAnsi(ctx.theme.fg("muted", "Project selection scopes both totals and history. A project with no records in this range remains selectable."), innerWidth),
						],
					},
				]));
				return boundLines(lines, width);
			}
			const history = savingsHistory(data.timeSeries, range, ctx.now());
			const sourceRows = rows();
			const retained = sourceRows.findIndex(r => r.source === selectedSource);
			selected = retained >= 0 ? retained : Math.max(0, Math.min(selected, sourceRows.length - 1));
			const chosen = sourceRows[selected];
			if (chosen) selectedSource = chosen.source;
			const sourceViewport = recordViewport(sourceRows, selected, Math.max(1, height - lines.length - projectViewport.rows.length - 3), reveal);
			const i = Math.max(0, Math.min(history.axis.length - 1, point));
			lines.push(...dashboardPanels(ctx, width, [
				{
					title: "Projects & sources", meta: "Recorded scope", active: focus !== 1,
					render: innerWidth => [
						sectionHeading(ctx, innerWidth, "Projects", "p/P select", focus === 0),
						...dataTable(ctx, innerWidth, "", [{ key: "project", header: "Project", align: "left" }], projectViewport.rows.map(p => ({ project: p ?? "All projects" })), options.indexOf(project) - projectViewport.start),
						"",
						sectionHeading(ctx, innerWidth, "By source", `${SORTS[sort]} ${descending ? "↓" : "↑"} · ${sourceRows.length} sources`, focus === 2),
						...(sourceRows.length ? dataTable(ctx, innerWidth, "", [
							{ key: "source", header: "Source", align: "left" },
							{ key: "tokens", header: "Saved tokens", align: "right" },
							{ key: "hits", header: "Hits", align: "right", priority: 1 },
							{ key: "bytes", header: "Bytes", align: "right", priority: 2 },
							{ key: "share", header: "Share", align: "right", priority: 3 },
							{ key: "reduction", header: "Reduction", align: "right", priority: 4 },
						], sourceViewport.rows.map(r => ({ source: r.source, tokens: compactTokens(r.savedTokens), hits: formatInteger(r.hits), bytes: formatBytes(r.savedBytes), share: formatPercent(r.share), reduction: r.reductionPercent === null ? "—" : formatPercent(r.reductionPercent) })), selected - sourceViewport.start) : emptyState(ctx, innerWidth, "No source breakdown", "Recorded totals are available, but this payload has no per-source records.")),
						...(chosen && expanded ? [
							"",
							sectionHeading(ctx, innerWidth, chosen.source, "recorded source detail", focus === 2),
							...wrapTextWithAnsi(`Saved ${formatInteger(chosen.savedTokens)} tokens · ${formatBytes(chosen.savedBytes)} · ${formatInteger(chosen.hits)} hits · ${chosen.hits > 0 ? compactTokens(chosen.savedTokens / chosen.hits) : "—"} tokens/hit`, innerWidth),
							...wrapTextWithAnsi(`Share ${formatPercent(chosen.share)} · reduction ${chosen.reductionPercent === null ? "— (original size unknown)" : formatPercent(chosen.reductionPercent)} · original ${formatBytes(chosen.originalBytes)} · output ${formatBytes(chosen.outputBytes)}`, innerWidth),
						] : []),
					],
				},
				{
					title: "Savings history", meta: "UTC days · range-scoped", active: focus === 1,
					render: innerWidth => {
						if (!data!.timeSeries.length) return emptyState(ctx, innerWidth, "No daily history recorded", "Totals are available for this scope, but no daily savings observations were supplied.");
						const chartHeight = 3;
						return [
							...wrapTextWithAnsi(`Day ${new Date(history.axis[i]).toISOString().slice(0, 10)} · saved ${formatInteger(history.daily[i])} · cumulative ${formatInteger(history.cumulative[i])}`, innerWidth),
							"",
							sectionHeading(ctx, innerWidth, "Saved per UTC day"),
							...renderTimeSeries(ctx, history.axis, [{ key: "daily", label: "Saved per day", values: history.daily }], innerWidth, point, { format: compactTokens, unit: "tokens", height: chartHeight, legend: false }),
							"",
							sectionHeading(ctx, innerWidth, "Cumulative saved tokens"),
							...renderTimeSeries(ctx, history.axis, [{ key: "cumulative", label: "Cumulative", values: history.cumulative, colorIndex: 1 }], innerWidth, point, { cumulative: true, format: compactTokens, unit: "tokens", height: chartHeight, legend: false }),
						];
					},
				},
			], { ratio: 0.48 }));
			return boundLines(lines, width);
		},
		handleInput(input) {
			if (closed || input === "q") return false;
			if (input === "\t" || input === "v" || input === "\x1b[Z") focus = (focus + (input === "\x1b[Z" ? 2 : 1)) % 3;
			else if (input === "p" || input === "P") {
				const options = projectOptions(projects, project);
				project = options[(options.indexOf(project) + (input === "p" ? 1 : options.length - 1)) % options.length];
				data = null; point = -1; selected = 0; selectedSource = null; void load(range);
			} else if (input === "h" || input === "l") {
				const count = data ? savingsHistory(data.timeSeries, range, ctx.now()).axis.length : 0;
				point = Math.max(0, Math.min(count - 1, point + (input === "l" ? 1 : -1)));
				focus = 1;
			} else if (input === "j" || input === "k" || input === "\x1b[A" || input === "\x1b[B") {
				if (focus === 0) return this.handleInput(input === "j" || input === "\x1b[B" ? "p" : "P");
				const sourceRows = rows();
				const retained = sourceRows.findIndex(r => r.source === selectedSource);
				selected = Math.max(0, Math.min(sourceRows.length - 1, (retained >= 0 ? retained : selected) + (input === "j" || input === "\x1b[B" ? 1 : -1)));
				selectedSource = sourceRows[selected]?.source ?? null; focus = 2;
			} else if (input === "o") sort = (sort + 1) % SORTS.length;
			else if (input === "d") descending = !descending;
			else if (input === "+" || input === "=") reveal += 12;
			else if (input === "\r" || input === "\n") { expanded = !expanded; focus = 2; }
			else if (input === "\x1b" && expanded) expanded = false;
			else return false;
			ctx.changed(); return true;
		},
		dispose() { closed = true; generation++; },
	};
}
