import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { ProviderAggregate, ProviderDashboardStats, ProviderWindowInsight, ProviderWindowStats, UsageWindowSeries } from "@oh-my-pi/omp-stats/shared-types";
import type { Range } from "../../data/ranges";
import { compactTokens, costWithUnpriced, formatCost, formatInteger, formatPercent } from "../format";
import type { FeatureContext, FeatureController } from "./types";
import { accountNames, accountReadings, rangeAxis, rangeStep, resolveWindow, utilization, type AccountReadings, type WindowRef } from "./provider-gain-data";
import { boundLines, recordViewport } from "./provider-gain-chart";
import { renderTimeSeries } from "../charts/time-series";
import { dashboardPanels, dataTable, emptyState, focusTabs, metricGrid, panel, ranking } from "./presentation";
import { densify, pivotSeries } from "@oh-my-pi/omp-stats/client/data/series";
import { glyph } from "../glyphs";

const VIEWS = ["Provider totals", "Burn by provider", "Peak local hours", "Subscription windows", "Account utilization"];
const METRICS = ["tokens", "output", "requests", "cost"] as const;
const TOTAL_SORTS = ["tokens", "provider", "requests", "errors", "models", "share", "output", "cost", "premium", "speed"];
const WINDOW_SORTS = ["consumed", "window", "accounts", "cycles", "capacity", "peak", "ideal", "exhausted"];
const ACCOUNT_SORTS = ["latest", "account", "window", "status", "peak", "samples", "recorded", "resets"];
type AccountRow = AccountReadings & { series: UsageWindowSeries; name: string };

export function createProvidersFeature(ctx: FeatureContext): FeatureController {
	let range: Range = "24h";
	let data: ProviderDashboardStats | null = null;
	let insights: ProviderWindowInsight[] | null = null;
	let accountData: ProviderWindowStats | null = null;
	let picked: WindowRef | null = null;
	let accountProvider: string | null = null;
	let localGeneration = 0;
	let windowsGeneration = 0;
	let accountsGeneration = 0;
	let closed = false;
	let localLoading = false;
	let windowsLoading = false;
	let accountsLoading = false;
	let localError: string | null = null;
	let windowsError: string | null = null;
	let accountsError: string | null = null;
	let view = 0;
	let row = 0;
	let providerRow = 0;
	let selectedProvider: string | null = null;
	let expanded: string | null = null;
	let metric = 0;
	let point = -1;
	let utilPoint = -1;
	let hour = 0;
	let peakProvider: string | null = null;
	let legend = 0;
	let reveal = 12;
	let totalSort = 0;
	let windowSort = 0;
	let accountSort = 0;
	let descending = true;
	let selectedAccount: string | null = null;
	const hiddenBurn = new Set<string>();
	const hiddenAccounts = new Set<string>();

	function sortedTotals(): ProviderAggregate[] {
		const key = TOTAL_SORTS[totalSort];
		const value = (p: ProviderAggregate): string | number => key === "provider" ? p.provider : key === "requests" ? p.totalRequests : key === "errors" ? p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0 : key === "models" ? p.models : key === "output" ? p.totalOutputTokens : key === "cost" ? p.totalCost : key === "premium" ? p.totalPremiumRequests : key === "speed" ? p.avgTokensPerSecond ?? -1 : p.totalTokens;
		return [...data?.providers ?? []].sort((a, b) => {
			const av = value(a), bv = value(b);
			return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
		});
	}
	function sortedWindows(): ProviderWindowInsight[] {
		const key = WINDOW_SORTS[windowSort];
		const value = (i: ProviderWindowInsight): string | number => key === "window" ? `${i.provider} ${i.windowLabel}` : key === "accounts" ? i.accounts : key === "cycles" ? i.cycles : key === "capacity" ? i.estTokensPerWindow ?? -1 : key === "peak" ? i.peakConcurrentFraction : key === "ideal" ? i.idealAccounts - i.accounts : key === "exhausted" ? i.exhaustedEvents : i.fractionConsumed;
		return [...insights ?? []].sort((a, b) => {
			const av = value(a), bv = value(b);
			return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
		});
	}
	function accountRows(): AccountRow[] {
		const series = (accountData?.usageSeries ?? []).filter(s => s.provider === picked?.provider && accountProvider === picked?.provider);
		const names = accountNames(series);
		const key = ACCOUNT_SORTS[accountSort];
		const value = (r: AccountRow): string | number => key === "account" ? r.name : key === "window" ? r.series.windowLabel : key === "status" ? r.latest?.exhausted ? 2 : (r.latest?.fraction ?? 0) >= 0.8 ? 1 : 0 : key === "peak" ? r.peak ?? -1 : key === "samples" ? r.samples : key === "recorded" ? r.latest?.timestamp ?? 0 : key === "resets" ? r.resets : r.latest?.fraction ?? -1;
		return series.map(s => ({ ...accountReadings(s), series: s, name: names.get(s.accountKey) ?? s.accountLabel })).sort((a, b) => {
			const av = value(a), bv = value(b);
			return (typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv)) * (descending ? -1 : 1);
		});
	}
	function burn() {
		const axis = rangeAxis(range, (data?.series ?? []).map(p => p.timestamp), ctx.now());
		const step = rangeStep(range);
		const metricName = METRICS[metric];
		const value = (p: ProviderDashboardStats["series"][number]): number | null => metricName === "tokens" ? p.totalTokens : metricName === "requests" ? p.requests : metricName === "cost" ? p.cost : (p as typeof p & { outputTokens?: number }).outputTokens ?? null;
		const rows = pivotSeries((data?.series ?? []).filter(p => value(p) !== null), {
			buckets: axis,
			key: p => `provider:${p.provider}`,
			label: key => key.slice("provider:".length),
			value: p => value(p)!,
			limit: 6,
		}).map(s => ({ key: s.key, label: s.label, values: s.values.map(v => v || null) }));
		return { axis, rows, step, metricName };
	}
	async function loadAccounts(provider: string): Promise<void> {
		const request = ++accountsGeneration;
		const requestedRange = range;
		if (accountProvider !== provider) { accountData = null; selectedAccount = null; row = 0; }
		accountProvider = provider; accountsLoading = true; accountsError = null; ctx.changed();
		try {
			const next = await ctx.reader.api<ProviderWindowStats>("/api/stats/provider-windows", { range: requestedRange, provider });
			if (closed || request !== accountsGeneration || picked?.provider !== provider || range !== requestedRange) return;
			accountData = next;
			const rows = accountRows();
			const retained = rows.findIndex(r => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount);
			row = retained >= 0 ? retained : Math.max(0, rows.findIndex(r => r.series.windowKey === picked?.windowKey));
			utilPoint = -1;
		} catch (cause) {
			if (closed || request !== accountsGeneration) return;
			accountsError = cause instanceof Error ? cause.message : String(cause);
		} finally { if (!closed && request === accountsGeneration) { accountsLoading = false; ctx.changed(); } }
	}
	function selectWindow(next: WindowRef): void {
		const changedProvider = next.provider !== picked?.provider;
		picked = next; utilPoint = -1;
		if (changedProvider || accountProvider !== next.provider || (!accountData && !accountsLoading)) void loadAccounts(next.provider);
	}
	async function loadWindows(): Promise<void> {
		const request = ++windowsGeneration;
		const requestedRange = range;
		const accountRequest = accountsGeneration;
		windowsLoading = true; windowsError = null; ctx.changed();
		try {
			const next = await ctx.reader.api<ProviderWindowStats>("/api/stats/provider-windows", { range: requestedRange });
			if (closed || request !== windowsGeneration || range !== requestedRange) return;
			insights = next.windowInsights;
			const resolved = resolveWindow(insights, picked);
			if (resolved) { selectWindow(resolved); if (accountsGeneration === accountRequest && !accountsLoading) void loadAccounts(resolved.provider); }
			else { picked = null; accountData = null; accountProvider = null; accountsGeneration++; accountsLoading = false; }
		} catch (cause) {
			if (closed || request !== windowsGeneration) return;
			windowsError = cause instanceof Error ? cause.message : String(cause);
		} finally { if (!closed && request === windowsGeneration) { windowsLoading = false; ctx.changed(); } }
	}
	async function load(nextRange: Range): Promise<void> {
		if (closed) return;
		if (range !== nextRange) {
			data = null; insights = null; accountData = null; accountsGeneration++; accountsLoading = false; point = -1; utilPoint = -1;
		}
		range = nextRange;
		const request = ++localGeneration;
		localLoading = true; localError = null;
		try {
			const localRead = ctx.reader.api<ProviderDashboardStats>("/api/stats/providers", { range });
			void loadWindows();
			if (picked) void loadAccounts(picked.provider);
			const next = await localRead;
			if (closed || request !== localGeneration) return;
			data = next;
			const axis = rangeAxis(range, next.series.map(p => p.timestamp), ctx.now());
			point = point < 0 ? axis.length - 1 : Math.min(point, axis.length - 1);
			if (peakProvider && !next.providers.some(p => p.provider === peakProvider)) peakProvider = null;
			providerRow = Math.min(providerRow, Math.max(0, next.providers.length - 1));
		} catch (cause) {
			if (closed || request !== localGeneration) return;
			localError = cause instanceof Error ? cause.message : String(cause);
		} finally { if (!closed && request === localGeneration) { localLoading = false; ctx.changed(); } }
	}

	return {
		load,
		render(width, height) {
			const preset = ctx.theme.getSymbolPreset();
			const lines = [ctx.theme.bold(`Providers · ${range}`)];
			if (localError) lines.push(ctx.theme.fg("error", `Local usage: ${localError}`));
			if (windowsError) lines.push(ctx.theme.fg("warning", `Subscription snapshots: ${windowsError} (local usage remains available)`));
			if (accountsError && view === 4) lines.push(ctx.theme.fg("warning", `Account snapshots: ${accountsError}`));
			if (data) {
				const totals = data.providers.reduce((t, p) => ({ tokens: t.tokens + p.totalTokens, requests: t.requests + p.totalRequests, failed: t.failed + p.failedRequests, cost: t.cost + p.totalCost, unpriced: t.unpriced + p.unpricedRequests }), { tokens: 0, requests: 0, failed: 0, cost: 0, unpriced: 0 });
				const axis = rangeAxis(range, data.series.map(p => p.timestamp), ctx.now());
				lines.push(...metricGrid(ctx, width, [
					{ label: "Tokens", value: compactTokens(totals.tokens), emphasis: "primary", hint: `${data.providers.length} providers`, spark: densify(data.series, axis, p => p.totalTokens) },
					{ label: "Requests", value: formatInteger(totals.requests), hint: `${formatPercent(totals.requests > 0 ? totals.failed / totals.requests : 0)} errors` },
					{ label: "API-equivalent", value: costWithUnpriced(totals.cost, totals.unpriced), hint: "Public API rates" },
				]));
			}
			lines.push(...focusTabs(ctx, width, ["Totals", "Burn", "Local hours", "Windows", "Accounts"], view));
			const hint = view === 0 ? "j/k provider · Enter detail · o sort · d direction · + reveal" : view === 1 ? "m metric · h/l point · n/N legend · Space hide" : view === 2 ? "h/l hour · p/P provider" : view === 3 ? "j/k window · Enter accounts · o sort · u retry" : "j/k account · h/l point · p/P provider · w/W window · n/N legend · Space hide";
			lines.push(...wrapTextWithAnsi(ctx.theme.fg("muted", `Tab view · ${hint}`), width));
			if (localLoading || windowsLoading || accountsLoading) lines.push(ctx.theme.fg("muted", `Loading ${[localLoading ? "usage" : "", windowsLoading ? "windows" : "", accountsLoading ? "accounts" : ""].filter(Boolean).join(" · ")} independently`));
			if (view <= 2 && !data) {
				lines.push(...panel(ctx, width, "Local usage", emptyState(ctx, Math.max(1, width - 4), localLoading ? "Loading local usage…" : "Local usage unavailable", localError ? "The usage request failed. Subscription views remain available." : "Provider activity will appear when local usage is available.")));
				return boundLines(lines, width);
			}
			if (view === 0) {
				const rows = sortedTotals();
				const retained = rows.findIndex(p => p.provider === selectedProvider);
				providerRow = retained >= 0 ? retained : Math.max(0, Math.min(providerRow, rows.length - 1));
				const p = rows[providerRow];
				if (p) selectedProvider = p.provider;
				const viewport = recordViewport(rows, providerRow, Math.max(1, height - lines.length + 3), reveal);
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Provider totals", meta: `${TOTAL_SORTS[totalSort]} ${descending ? "↓" : "↑"} · ${rows.length} providers`, active: true,
						render: innerWidth => rows.length ? [
							...dataTable(ctx, innerWidth, "", [
								{ key: "provider", header: "Provider", align: "left" },
								{ key: "tokens", header: "Tokens", align: "right" },
								{ key: "requests", header: "Requests", align: "right", priority: 1 },
								{ key: "cost", header: "API-equiv.", align: "right", priority: 2 },
								{ key: "output", header: "Output", align: "right", priority: 3 },
							], viewport.rows.map(p => ({ provider: p.provider, tokens: compactTokens(p.totalTokens), requests: formatInteger(p.totalRequests), cost: costWithUnpriced(p.totalCost, p.unpricedRequests), output: compactTokens(p.totalOutputTokens) })), providerRow - viewport.start),
							"",
							...wrapTextWithAnsi(ctx.theme.fg("muted", "Token distribution · selected range"), innerWidth),
							...ranking(ctx, innerWidth, viewport.rows.map(p => ({ label: p.provider, value: p.totalTokens, display: compactTokens(p.totalTokens) }))),
						] : emptyState(ctx, innerWidth, "No provider activity in this range", "Provider totals reflect recorded local requests.", "Try a longer range."),
					},
					{
						title: p ? `Selected ${p.provider}` : "Token mix", meta: p ? `${p.models} models · ${p.avgTokensPerSecond === null ? "—" : p.avgTokensPerSecond.toFixed(1)} tok/s` : undefined,
						render: innerWidth => {
							if (!p) return emptyState(ctx, innerWidth, "No provider selected", "A measured token mix appears alongside provider activity.");
							const mix = [["Uncached input", p.totalInputTokens], ["Cache read", p.totalCacheReadTokens], ["Cache write", p.totalCacheWriteTokens], ["Output", p.totalOutputTokens]] as const;
							return [
								...wrapTextWithAnsi(`${formatInteger(p.totalRequests)} requests · ${formatPercent(p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0)} errors`, innerWidth),
								...wrapTextWithAnsi(`API-equivalent cost ${costWithUnpriced(p.totalCost, p.unpricedRequests)}`, innerWidth),
								"",
								...ranking(ctx, innerWidth, mix.map(([label, value]) => ({ label, value, display: `${formatInteger(value)} · ${p.totalTokens > 0 ? formatPercent(value / p.totalTokens) : "—"}` }))),
								...(expanded === p.provider ? [
									"",
									...wrapTextWithAnsi(`${formatInteger(p.failedRequests)} failed · ${formatInteger(p.totalPremiumRequests)} premium · Output ${formatInteger(p.totalOutputTokens)}`, innerWidth),
									...wrapTextWithAnsi("Token mix is measured local usage; API-equivalent costs use public rates, not subscription billing.", innerWidth),
								] : []),
							];
						},
					},
				]));
			} else if (view === 1) {
				const chart = burn(); point = Math.max(0, Math.min(chart.axis.length - 1, point));
				const format = chart.metricName === "cost" ? formatCost : formatInteger;
				const rows = chart.rows.map(r => {
					const total = r.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
					return { ...r, total, legendValue: format(total) };
				});
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Burn by provider", meta: `${chart.metricName} · top six + Other`, active: true,
						render: innerWidth => [
							...(chart.metricName === "output" && data!.series.some(p => (p as typeof p & { outputTokens?: number }).outputTokens === undefined) ? wrapTextWithAnsi("Output burn unavailable for older payload points (gaps, not zero).", innerWidth) : []),
							...renderTimeSeries(ctx, chart.axis, rows, innerWidth, point, { hidden: hiddenBurn, stacked: true, format: chart.metricName === "cost" ? formatCost : compactTokens, unit: chart.metricName === "cost" ? "USD API-equiv." : chart.metricName, height: 4, selectedKey: chart.rows[legend % Math.max(1, chart.rows.length)]?.key }),
						],
					},
					{
						title: "Range distribution", meta: chart.metricName === "cost" ? "API-equivalent · public rates" : `Recorded ${chart.metricName}`,
						render: innerWidth => [
							...ranking(ctx, innerWidth, rows.filter(r => !hiddenBurn.has(r.key)).map(r => ({ label: r.label, value: r.total, display: r.legendValue }))),
							"",
							...wrapTextWithAnsi(ctx.theme.fg("muted", `Buckets: ${chart.step < 3_600_000 ? "5 minutes" : chart.step < 86_400_000 ? "hour" : "day"} · legend shows selected bucket and range total. Hidden providers are excluded from the distribution.`), innerWidth),
						],
					},
				]));
			} else if (view === 2) {
				const hours = Array.from({ length: 24 }, () => ({ tokens: 0, output: 0, requests: 0 }));
				for (const p of data!.hourly) if (peakProvider === null || p.provider === peakProvider) { hours[p.hour].tokens += p.totalTokens; hours[p.hour].output += p.outputTokens; hours[p.hour].requests += p.requests; }
				const peak = hours.reduce((best, p, i) => p.tokens > hours[best].tokens ? i : best, 0);
				const max = Math.max(0, ...hours.map(p => p.tokens));
				const rankedHours = hours.map((p, i) => ({ ...p, hour: i })).filter(p => p.tokens > 0).sort((a, b) => b.tokens - a.tokens || a.hour - b.hour).slice(0, 6);
				if (!rankedHours.some(p => p.hour === hour)) rankedHours.push({ ...hours[hour], hour });
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Peak local hours", meta: peakProvider ?? "All providers", active: true,
						render: innerWidth => max > 0 ? ranking(ctx, innerWidth, rankedHours.map(p => ({ label: `${p.hour === hour ? glyph(preset, "rowCursor") : " "} ${String(p.hour).padStart(2, "0")}:00`, value: p.tokens, display: compactTokens(p.tokens) }))) : emptyState(ctx, innerWidth, "No activity in this range", "Local-hour totals use recorded provider requests.", "Try a longer range or another provider."),
					},
					{
						title: "Hour context",
						render: innerWidth => [
							...wrapTextWithAnsi(`Provider ${peakProvider ?? "All providers"} · peak ${hours[peak].tokens > 0 ? `${String(peak).padStart(2, "0")}:00` : "none"}`, innerWidth),
							"",
							...wrapTextWithAnsi(`Hour ${String(hour).padStart(2, "0")}:00 local · ${formatInteger(hours[hour].tokens)} tokens · ${formatInteger(hours[hour].output)} output · ${formatInteger(hours[hour].requests)} requests`, innerWidth),
							"",
							...wrapTextWithAnsi(ctx.theme.fg("muted", "Ranked hours show the six busiest local hours plus your selection. Hours aggregate the selected range; provider selection applies to tokens, output and requests together."), innerWidth),
						],
					},
				]));
			} else if (view === 3) {
				const rows = sortedWindows();
				const selected = rows.findIndex(i => i.provider === picked?.provider && i.windowKey === picked?.windowKey);
				const i = rows[selected];
				const viewport = recordViewport(rows, Math.max(0, selected), Math.max(1, height - lines.length + 3), reveal);
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Subscription windows", meta: `${WINDOW_SORTS[windowSort]} ${descending ? "↓" : "↑"} · ${rows.length} windows`, active: true,
						render: innerWidth => rows.length ? dataTable(ctx, innerWidth, "", [
							{ key: "window", header: "Provider / window", align: "left" },
							{ key: "burned", header: "Burned", align: "right" },
							{ key: "accounts", header: "Accounts", align: "right", priority: 1 },
							{ key: "capacity", header: "Capacity", align: "right", priority: 2 },
							{ key: "exhaustions", header: "Exhaustions", align: "right", priority: 3 },
						], viewport.rows.map(i => ({ window: `${i.provider} / ${i.windowLabel}`, burned: i.fractionConsumed.toFixed(2), accounts: formatInteger(i.accounts), capacity: i.estTokensPerWindow === null ? "—" : compactTokens(i.estTokensPerWindow), exhaustions: formatInteger(i.exhaustedEvents) })), selected - viewport.start) : emptyState(ctx, innerWidth, insights === null ? windowsLoading ? "Loading subscription windows…" : "Subscription window payload unavailable" : "No usage snapshots in this range", "Snapshots accumulate when limits are fetched (footer, /usage, omp usage).", "Local usage remains available in the other views."),
					},
					{
						title: i ? `${i.provider} · ${i.windowLabel}` : "Capacity context",
						render: innerWidth => [
							...(i ? [
								`Windows burned ${i.fractionConsumed.toFixed(2)} · resets ${i.cycles} · capacity ${i.estTokensPerWindow === null ? "— (too little consumed to estimate)" : `${compactTokens(i.estTokensPerWindow)} tokens/window`}`,
								`Peak ${formatPercent(i.peakConcurrentFraction)} summed · fleet ${i.accounts} accounts · fleet load ${i.accounts ? formatPercent(i.peakConcurrentFraction / i.accounts) : "—"}`,
								`Accounts needed ${i.idealAccounts} at <90% · have ${i.accounts} · ${i.idealAccounts > i.accounts ? `short ${i.idealAccounts - i.accounts}` : `headroom ${i.accounts - i.idealAccounts}`} · exhaustions ${i.exhaustedEvents}`,
								"",
							] : []),
							"Capacity uses upstream broker fleet tokens when present, otherwise local provider tokens; it is an estimate, not billing.",
						].flatMap(line => wrapTextWithAnsi(ctx.theme.fg("text", line), innerWidth)),
					},
				]));
			} else {
				const rows = accountRows();
				const retained = rows.findIndex(r => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount);
				row = retained >= 0 ? retained : Math.max(0, Math.min(row, rows.length - 1));
				const current = rows[row];
				if (current) selectedAccount = JSON.stringify([current.series.windowKey, current.series.accountKey]);
				const viewport = recordViewport(rows, row, Math.max(1, height - lines.length + 3), reveal);
				const matching = rows.filter(r => r.series.windowKey === picked?.windowKey).sort((a, b) => a.name.localeCompare(b.name));
				const chart = utilization(matching.map(r => r.series));
				utilPoint = utilPoint < 0 ? chart.axis.length - 1 : Math.min(utilPoint, chart.axis.length - 1);
				const chartRows = chart.rows.map(r => ({ ...r, label: matching.find(a => a.series.accountKey === r.key)?.name ?? r.key }));
				lines.push(...wrapTextWithAnsi(ctx.theme.fg("text", `Provider ${picked?.provider ?? "—"} · window ${insights?.find(i => i.provider === picked?.provider && i.windowKey === picked?.windowKey)?.windowLabel ?? "—"}`), width));
				lines.push(...dashboardPanels(ctx, width, [
					{
						title: "Accounts / all provider windows", meta: `${ACCOUNT_SORTS[accountSort]} ${descending ? "↓" : "↑"}`, active: true,
						render: innerWidth => [
							...(rows.length ? dataTable(ctx, innerWidth, "", [
								{ key: "account", header: "Account / window", align: "left" },
								{ key: "latest", header: "Latest", align: "right" },
								{ key: "peak", header: "Peak", align: "right", priority: 1 },
								{ key: "samples", header: "Snapshots", align: "right", priority: 2 },
								{ key: "resets", header: "Resets", align: "right", priority: 3 },
							], viewport.rows.map(r => ({ account: `${r.name} / ${r.series.windowLabel}`, latest: `${r.latest ? formatPercent(r.latest.fraction) : "—"}${r.latest?.exhausted ? " exhausted" : ""}`, peak: r.peak === null ? "—" : formatPercent(r.peak), samples: formatInteger(r.samples), resets: formatInteger(r.resets) })), row - viewport.start) : emptyState(ctx, innerWidth, !picked ? insights?.length === 0 ? "No usage snapshots in this range" : "Waiting for subscription windows" : accountsLoading ? "Loading account histories…" : "No account-history payload available", "Account histories are fetched independently of local usage.")),
							...(current ? [
								"",
								...[
									`${current.name} · ${current.series.windowLabel}`,
									`Account key ${current.series.accountKey}`,
									`Latest ${current.latest ? `${formatPercent(current.latest.fraction)} · ${new Date(current.latest.timestamp).toISOString()} · ${current.latest.exhausted ? "EXHAUSTED" : current.latest.fraction >= 0.8 ? "HIGH" : "OK"}` : "No numeric reading"}`,
									`Peak ${current.peak === null ? "—" : formatPercent(current.peak)} · headroom ${current.latest ? formatPercent(1 - current.latest.fraction) : "—"} · resets ${current.resets} · snapshots ${current.samples}`,
								].flatMap(line => wrapTextWithAnsi(line, innerWidth)),
							] : []),
						],
					},
					{
						title: "Account utilization", meta: "100% = exhausted capacity",
						render: innerWidth => {
							const exhausted = chart.exhausted[utilPoint] ?? [];
							return [
								...(chart.axis.length ? renderTimeSeries(ctx, chart.axis, chartRows, innerWidth, utilPoint, { hidden: hiddenAccounts, percent: true, format: value => formatPercent(value, 1), formatValue: (_key, value) => value === null || value === undefined ? "No reading (gap)" : formatPercent(value, 1), unit: "capacity", height: 3, selectedKey: chartRows[legend % Math.max(1, chartRows.length)]?.key }) : emptyState(ctx, innerWidth, "No utilization readings for this window", "Recorded snapshots will appear here; missing readings are not zero.")),
								...(exhausted.length ? wrapTextWithAnsi(ctx.theme.fg("error", `EXHAUSTED: ${exhausted.map(key => chartRows.find(r => r.key === key)?.label ?? key).join(", ")}`), innerWidth) : []),
								"",
								...wrapTextWithAnsi(ctx.theme.fg("muted", "Readings hold at most six hours; longer silence is a gap, not zero."), innerWidth),
							];
						},
					},
				]));
			}
			return boundLines(lines, width);
		},
		handleInput(input) {
			if (closed || input === "q") return false;
			if (input === "\t" || input === "v" || input === "\x1b[Z") { view = (view + (input === "\x1b[Z" ? VIEWS.length - 1 : 1)) % VIEWS.length; legend = 0; }
			else if (input === "m" && view === 1) metric = (metric + 1) % METRICS.length;
			else if (input === "o") { if (view === 0) totalSort = (totalSort + 1) % TOTAL_SORTS.length; else if (view === 3) windowSort = (windowSort + 1) % WINDOW_SORTS.length; else if (view === 4) accountSort = (accountSort + 1) % ACCOUNT_SORTS.length; else return false; }
			else if (input === "d" && (view === 0 || view >= 3)) descending = !descending;
			else if ((input === "+" || input === "=") && (view === 0 || view >= 3)) reveal += view === 4 ? 16 : 12;
			else if (input === "u") { void loadWindows(); if (picked) void loadAccounts(picked.provider); }
			else if (input === "p" || input === "P") {
				if (view < 2) return false;
				const choices: (string | null)[] = view === 2 ? [null, ...(data?.providers.map(p => p.provider) ?? [])] : [...new Set((insights ?? []).map(i => i.provider))];
				if (choices.length) {
					const current = view === 2 ? peakProvider : picked?.provider ?? null;
					const next = choices[(Math.max(0, choices.indexOf(current)) + (input === "p" ? 1 : choices.length - 1)) % choices.length];
					if (view === 2) peakProvider = next;
					else { const i = insights?.find(i => i.provider === next); if (i) selectWindow(i); }
				}
			} else if (input === "w" || input === "W") {
				if (view < 3) return false;
				const choices = (insights ?? []).filter(i => i.provider === picked?.provider);
				if (choices.length) { const index = choices.findIndex(i => i.windowKey === picked?.windowKey); selectWindow(choices[(Math.max(0, index) + (input === "w" ? 1 : choices.length - 1)) % choices.length]); }
			} else if (input === "h" || input === "l") {
				const delta = input === "l" ? 1 : -1;
				if (view === 1) point = Math.max(0, Math.min(burn().axis.length - 1, point + delta));
				else if (view === 2) hour = (hour + delta + 24) % 24;
				else if (view === 4) { const chart = utilization(accountRows().filter(r => r.series.windowKey === picked?.windowKey).map(r => r.series)); utilPoint = Math.max(0, Math.min(chart.axis.length - 1, (utilPoint < 0 ? chart.axis.length - 1 : utilPoint) + delta)); }
				else return false;
			} else if (input === "j" || input === "k" || input === "\x1b[A" || input === "\x1b[B") {
				const delta = input === "j" || input === "\x1b[B" ? 1 : -1;
				if (view === 0) {
					const rows = sortedTotals();
					const retained = rows.findIndex(p => p.provider === selectedProvider);
					providerRow = Math.max(0, Math.min(rows.length - 1, (retained >= 0 ? retained : providerRow) + delta));
					selectedProvider = rows[providerRow]?.provider ?? null;
				}
				else if (view === 2) hour = (hour + delta + 24) % 24;
				else if (view === 3) { const rows = sortedWindows(); const index = rows.findIndex(i => i.provider === picked?.provider && i.windowKey === picked?.windowKey); const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]; if (next) selectWindow(next); }
				else if (view === 4) { const rows = accountRows(); const retained = rows.findIndex(r => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount); row = Math.max(0, Math.min(rows.length - 1, (retained >= 0 ? retained : row) + delta)); const r = rows[row]; if (r) selectedAccount = JSON.stringify([r.series.windowKey, r.series.accountKey]); }
				else return this.handleInput(delta > 0 ? "l" : "h");
			} else if ((input === "n" || input === "N") && (view === 1 || view === 4)) { const count = view === 1 ? burn().rows.length : accountRows().filter(r => r.series.windowKey === picked?.windowKey).length; legend = (legend + (input === "n" ? 1 : Math.max(0, count - 1))) % Math.max(1, count); }
			else if (input === " " && (view === 1 || view === 4)) {
				const rows = view === 1 ? burn().rows : accountRows().filter(r => r.series.windowKey === picked?.windowKey).sort((a, b) => a.name.localeCompare(b.name)).map(r => ({ key: r.series.accountKey }));
				const r = rows[legend % Math.max(1, rows.length)]; const hidden = view === 1 ? hiddenBurn : hiddenAccounts;
				if (r) { if (hidden.has(r.key)) hidden.delete(r.key); else hidden.add(r.key); }
			} else if (input === "\r" || input === "\n") {
				if (view === 0) { const rows = sortedTotals(); const p = rows.find(p => p.provider === selectedProvider) ?? rows[providerRow]; if (p) { selectedProvider = p.provider; expanded = expanded === p.provider ? null : p.provider; } }
				else if (view === 3) view = 4;
				else if (view === 4) { const rows = accountRows(); const r = rows.find(r => JSON.stringify([r.series.windowKey, r.series.accountKey]) === selectedAccount) ?? rows[row]; if (r) selectWindow(r.series); }
				else return false;
			} else if (input === "\x1b" && expanded && view === 0) expanded = null;
			else return false;
			ctx.changed(); return true;
		},
		dispose() { closed = true; localGeneration++; windowsGeneration++; accountsGeneration++; },
	};
}
