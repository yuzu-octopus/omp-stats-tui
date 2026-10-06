import type { FrustrationDashboardStats, FrustrationEstimate, FrustrationJobStatus } from "@oh-my-pi/omp-stats/shared-types";
import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Range } from "../../data/ranges";
import { formatCost, formatElapsed, formatInteger, formatPercent } from "../format";
import { resolveSeries, SELECTION_BG } from "../palette";
import { activeModelClass, classTotals, familyKey, filterFrustrationRows, fraction, FRUSTRATION_SORTS, layerFraction, MIN_MESSAGES, mostlyRegex, sortFrustrationRows, type FrustrationLayer, type FrustrationSort } from "./frustration-data";
import type { FeatureContext, FeatureController } from "./types";
import { dashboardPanels, dataTable, emptyState, focusTabs, metricGrid, sectionHeading } from "./presentation";
import { glyph } from "../glyphs";

// Upstream's server.ts and client/api.ts require this exact explicit-action header.
const ACTION_OPTIONS = { method: "POST" as const, headers: { "X-Omp-Stats-Action": "1" } };
const LAYERS: readonly FrustrationLayer[] = ["angry", "assistant", "other"];
const LAYER_LABELS: Record<FrustrationLayer, string> = { angry: "Angry at assistant", assistant: "At assistant, not angry", other: "Annoyed at other targets" };
type QuoteState = { state: "closed" } | { state: "loading"; range: Range } | { state: "error"; range: Range; error: string } | { state: "ready"; range: Range; estimate: FrustrationEstimate };

/** Passive reads never start judging. A fresh quote and a separate y input authorize a paid run. */
export function createFrustrationFeature(ctx: FeatureContext): FeatureController {
	let range: Range = "24h";
	let data: FrustrationDashboardStats | undefined;
	let dataRange: Range | undefined;
	let job: FrustrationJobStatus | undefined;
	let error: string | undefined;
	let actionError: string | undefined;
	let copyNotice: string | undefined;
	let loading = false;
	let disposed = false;
	let readGeneration = 0;
	let quoteGeneration = 0;
	let actionGeneration = 0;
	let timer: Timer | undefined;
	let quote: QuoteState = { state: "closed" };
	let starting = false;
	let cancelling = false;
	let modelClass: string | null = null;
	const hiddenFamilies = new Set<string>();
	let familyCursor = 0;
	let showSmall = false;
	let hideRegex = false;
	const hiddenLayers = new Set<FrustrationLayer>();
	let trend = true;
	let sort: FrustrationSort = "version";
	let descending = false;
	let selectedKey: string | undefined;
	let selectedIndex = 0;
	let revealed = 20;
	let details = false;
	let focus: "versions" | "families" = "versions";

	function stopPoll(): void {
		clearTimeout(timer);
		timer = undefined;
	}
	function schedulePoll(): void {
		stopPoll();
		if (!disposed && job?.state === "running") {
			timer = setTimeout(() => { timer = undefined; void readStats(); }, 1_000);
		}
	}
	async function readStats(): Promise<void> {
		if (disposed) return;
		const generation = ++readGeneration;
		const requestedRange = range;
		loading = true;
		ctx.changed();
		try {
			const result = await ctx.reader.api<FrustrationDashboardStats>("/api/stats/frustration", { range: requestedRange });
			if (disposed || generation !== readGeneration) return;
			data = result;
			dataRange = requestedRange;
			job = result.job;
			if (job.state === "running" && !starting && quote.state !== "closed") {
				quote = { state: "closed" };
				++quoteGeneration;
			}
			error = undefined;
		} catch (err) {
			if (disposed || generation !== readGeneration) return;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (!disposed && generation === readGeneration) {
				loading = false;
				schedulePoll();
				ctx.changed();
			}
		}
	}
	async function openQuote(): Promise<void> {
		if (disposed || starting || cancelling || job?.state === "running") return;
		const generation = ++quoteGeneration;
		const quotedRange = range;
		quote = { state: "loading", range: quotedRange };
		actionError = undefined;
		ctx.changed();
		try {
			const estimate = await ctx.reader.api<FrustrationEstimate>("/api/frustration/estimate", { range: quotedRange });
			if (disposed || generation !== quoteGeneration) return;
			quote = { state: "ready", range: quotedRange, estimate };
		} catch (err) {
			if (disposed || generation !== quoteGeneration) return;
			quote = { state: "error", range: quotedRange, error: err instanceof Error ? err.message : String(err) };
		}
		if (!disposed) ctx.changed();
	}
	async function startRun(): Promise<void> {
		if (disposed || starting || cancelling || quote.state !== "ready" || !quote.estimate.available || quote.estimate.messages === 0 || job?.state === "running") return;
		const quotedRange = quote.range;
		const generation = ++actionGeneration;
		starting = true;
		actionError = undefined;
		++readGeneration;
		loading = false;
		stopPoll();
		ctx.changed();
		try {
			const startedJob = await ctx.reader.api<FrustrationJobStatus>("/api/frustration/judge", { range: quotedRange }, ACTION_OPTIONS);
			if (disposed) {
				// Closing while the server resolves the judge must not leave a newly started paid run behind.
				if (startedJob.state === "running") await ctx.reader.api("/api/frustration/cancel", undefined, ACTION_OPTIONS).catch(() => undefined);
				return;
			}
			if (generation !== actionGeneration) return;
			job = startedJob;
			starting = false;
			quote = { state: "closed" };
			++quoteGeneration;
			await readStats();
		} catch (err) {
			if (!disposed && generation === actionGeneration) actionError = err instanceof Error ? err.message : String(err);
		} finally {
			if (!disposed && generation === actionGeneration) {
				starting = false;
				schedulePoll();
				ctx.changed();
			}
		}
	}
	async function cancelRun(): Promise<void> {
		if (disposed || starting || cancelling || job?.state !== "running") return;
		const generation = ++actionGeneration;
		cancelling = true;
		actionError = undefined;
		++readGeneration;
		loading = false;
		stopPoll();
		ctx.changed();
		try {
			const cancelledJob = await ctx.reader.api<FrustrationJobStatus>("/api/frustration/cancel", undefined, ACTION_OPTIONS);
			if (disposed || generation !== actionGeneration) return;
			job = cancelledJob;
			await readStats();
		} catch (err) {
			if (!disposed && generation === actionGeneration) actionError = err instanceof Error ? err.message : String(err);
		} finally {
			if (!disposed && generation === actionGeneration) {
				cancelling = false;
				schedulePoll();
				ctx.changed();
			}
		}
	}
	function population() {
		const models = data?.byModel ?? [];
		const active = activeModelClass(models, modelClass);
		const inClass = models.filter(row => active === "*" || row.modelClass === active);
		const familyMessages = new Map<string, number>();
		for (const row of inClass) familyMessages.set(familyKey(row), (familyMessages.get(familyKey(row)) ?? 0) + row.messages);
		const families = [...familyMessages.keys()];
		const visibleFamilies = inClass.filter(row => !hiddenFamilies.has(familyKey(row)));
		const smallCount = visibleFamilies.filter(row => row.messages < MIN_MESSAGES).length;
		const regexCount = visibleFamilies.filter(mostlyRegex).length;
		const chartRows = filterFrustrationRows(models, { modelClass, hiddenFamilies, showSmall, hideRegex });
		const rows = sortFrustrationRows(chartRows, sort, descending);
		const rememberedIndex = rows.findIndex(row => row.key === selectedKey);
		selectedIndex = rememberedIndex >= 0 ? rememberedIndex : Math.min(selectedIndex, Math.max(0, rows.length - 1));
		selectedKey = rows[selectedIndex]?.key;
		revealed = Math.max(revealed, selectedIndex + 1);
		familyCursor = Math.min(familyCursor, Math.max(0, families.length - 1));
		return { active, families, familyMessages, smallCount, regexCount, chartRows, rows };
	}

	return {
		async load(nextRange) {
			if (disposed) return;
			if (range !== nextRange) {
				range = nextRange;
				quote = { state: "closed" };
				++quoteGeneration;
			}
			stopPoll();
			await readStats();
		},
		render(width, height) {
			const w = Math.max(1, Math.floor(width));
			const lines: string[] = [];
			const add = (text: string) => { lines.push(...wrapTextWithAnsi(text, w)); };
			const fg = ctx.theme.fg.bind(ctx.theme);
			const rate = (part: number, whole: number) => whole > 0 ? formatPercent(fraction(part, whole)) : "–";
			// Confirmation is rendered first and captures input before every filter/control.
			if (quote.state !== "closed") {
				lines.push(sectionHeading(ctx, w, "CLASSIFY WITH JUDGE", `quoted ${quote.range}`, true));
				if (quote.state === "loading") add("Loading prerequisites and cost quote… Nothing has been spent.");
				else if (quote.state === "error") add(fg("error", quote.error));
				else if (!quote.estimate.available) add(fg("warning", quote.estimate.reason));
				else {
					const estimate = quote.estimate;
					add(`Judge ${estimate.judge}`);
					add(`${formatInteger(estimate.messages)} unique unjudged messages · ${formatInteger(estimate.chars)} prose characters`);
					add(`Estimated input ${formatInteger(estimate.inputTokens)} tokens · cost ≈ ${formatCost(estimate.cost)}`);
					add("Adaptive concurrency · identical messages share cached verdicts.");
					add(fg("warning", "Estimate ≠ spending cap; retries can cost more."));
					add(estimate.messages === 0 ? "Everything in this range is already judged; nothing to classify." : fg("warning", starting ? "Starting the confirmed run…" : "Press y to confirm paid judging. Enter does NOT spend. Esc/n backs out; q closes."));
				}
				if (actionError) add(fg("error", actionError));
				add("Esc/n dismiss · q close");
				return lines;
			}
			lines.push(sectionHeading(ctx, w, "Frustration", `${range} · passive cache`, true));
			if (data) {
				const overall = data.overall;
				lines.push(...metricGrid(ctx, w, [
					{ label: "User messages", value: formatInteger(overall.messages), hint: `annoyed ${rate(overall.annoyed, overall.messages)}`, emphasis: "primary" },
					{ label: "At assistant", value: rate(overall.atAssistant, overall.messages), hint: `angry ${rate(overall.angry, overall.messages)}` },
					{ label: "Judge coverage", value: rate(overall.judged, overall.messages), hint: `regex ${formatInteger(overall.messages - overall.judged)}` },
				]));
			}
			if (loading) add(fg("muted", data ? "Refreshing cached metrics…" : "Loading cached metrics…"));
			if (error) add(fg("error", `${data ? "Cached data retained; refresh failed: " : "Unable to read metrics: "}${error}`));
			if (dataRange && dataRange !== range) add(fg("warning", `Stale ${dataRange} metrics · requested ${range}${loading ? " loading" : ""}`));
			if (job) {
				const elapsed = job.startedAt === null ? "" : ` · ${formatElapsed((job.finishedAt ?? ctx.now()) - job.startedAt)}`;
				add(fg(job.state === "failed" ? "error" : job.state === "running" ? "success" : "muted", `Judge ${job.state} · ${job.done}/${job.total} judged · ${job.failed} failed · ${formatCost(job.cost)}${elapsed}`));
				if (job.state === "running") {
					const completed = Math.min(1, fraction(job.done + job.failed, job.total));
					const cells = Math.max(1, Math.min(20, w - 10));
					add(Array.from({ length: cells }, (_, i) => fg(i < completed * cells ? "success" : "muted", glyph(ctx.theme.getSymbolPreset(), i < completed * cells ? "barFill" : "barEmpty"))).join("") + ` ${formatPercent(completed)}`);
					add(`${job.concurrency} in flight${job.startedAt !== null && job.done > 0 ? ` · ${(job.done / Math.max(1, (ctx.now() - job.startedAt) / 1000)).toFixed(1)}/s` : ""} · x ${cancelling ? "cancelling…" : "cancel run"}${job.judge ? ` · ${job.judge}` : ""}`);
				} else add(fg("muted", `j quote/confirm paid classification${job.judge ? ` · ${job.judge}` : ""}`));
				if (job.error) add(fg("error", job.error));
			} else add(fg("muted", "j quote prerequisites · no paid calls on load"));
			if (data && !data.judgeAvailable) add(fg("warning", "Regex + cached verdicts · judge not registered · j prerequisites"));
			if (actionError) add(fg("error", actionError));
			if (copyNotice) add(fg("success", copyNotice));
			if (!data) return lines;
			const { active, families, familyMessages, smallCount, regexCount, chartRows, rows } = population();
			const selected = rows[selectedIndex];
			lines.push(...focusTabs(ctx, w, ["Versions", "Families"], focus === "versions" ? 0 : 1));
			add(fg("muted", w < 60
				? `Class ${active} [c] · ${showSmall ? "all samples" : "≥50 msgs"} [m] · regex ${hideRegex ? "off" : "on"} [h]`
				: `Class ${active} [c] · ${showSmall ? "including" : "excluding"} <50 messages (${smallCount} versions) [m] · regex ${hideRegex ? "hidden" : "shown"} (${regexCount}) [h]`));
			if (selected) {
				add(ctx.theme.bold(fg("accent", `Point ${selectedIndex + 1}/${rows.length}: ${selected.label} · ${formatInteger(selected.messages)} messages${mostlyRegex(selected) ? " · mostly regex" : ""}`)));
				add(w < 60
					? `assistant ${rate(selected.atAssistant, selected.messages)} · judged ${rate(selected.judged, selected.messages)}`
					: `Judged ${rate(selected.judged, selected.messages)} · annoyed ${rate(selected.annoyed, selected.messages)} · assistant ${rate(selected.atAssistant, selected.messages)} · angry ${rate(selected.angry, selected.messages)}`);
				if (details) {
					lines.push(sectionHeading(ctx, w, "Model detail", "Enter/Esc back · p copy JSON", true));
					add(`Identity ${selected.key} · class ${selected.modelClass} · family ${selected.family ?? "unclassified"} · revision ${selected.revision ?? "unclassified"}`);
					add(`Counts: judged ${selected.judged}; annoyed ${selected.annoyed}; assistant ${selected.atAssistant}; angry ${selected.angry}`);
					add(`Layers: angry ${rate(selected.angry, selected.messages)} · assistant-not-angry ${rate(selected.atAssistant - selected.angry, selected.messages)} · other ${rate(selected.annoyed - selected.atAssistant, selected.messages)}`);
					for (const id of selected.models) add(`Raw model ID: ${id}`);
					add(`First seen ${new Date(selected.firstSeen).toISOString()}`);
					return lines;
				}
			}
			const colors = resolveSeries(Math.max(1, families.length), ctx.theme);
			const classRows = data.byModel.filter(row => active === "*" || row.modelClass === active);
			const classMessages = classRows.reduce((sum, row) => sum + row.messages, 0);
			const classJudged = classRows.reduce((sum, row) => sum + row.judged, 0);
			lines.push(...dashboardPanels(ctx, w, [
				{
					title: "Rates by version", meta: "catalog order · not time", active: focus === "versions",
					render: innerWidth => {
						if (!rows.length) return emptyState(ctx, innerWidth,
							data!.byModel.length ? "No model versions match the filters" : "No user messages with prose",
							data!.byModel.length
								? `${formatInteger(classMessages)} messages available in class ${active}; ${rate(classJudged, classMessages)} judge coverage. ${showSmall ? "Small samples included" : `${smallCount} versions below ${MIN_MESSAGES} messages excluded`}; ${hideRegex ? `${regexCount} mostly-regex versions hidden` : "regex + cached verdicts included"}. ${families.filter(family => hiddenFamilies.has(family)).length} families hidden.`
								: "There are no indexed user messages with prose in this range. No rate can be estimated from an empty sample.",
							data!.byModel.length ? "m include small samples · c class · h regex · Tab/Space families" : "Choose a longer range or sync recorded transcripts");
						const chart: string[] = [];
						const chartAdd = (text: string) => chart.push(...wrapTextWithAnsi(text, innerWidth));
						if (chartRows.every(row => row.messages > 0 && row.annoyed === 0)) chartAdd(fg("muted", "No frustrated messages for these models; all annoyance rates are zero."));
						const chartIndex = Math.max(0, chartRows.findIndex(row => row.key === selectedKey));
						const slots = Math.max(1, Math.min(chartRows.length, Math.floor(Math.max(2, innerWidth - 9) / 2)));
						const chartStart = Math.max(0, Math.min(chartRows.length - slots, chartIndex - Math.floor(slots / 2)));
						const plot = chartRows.slice(chartStart, chartStart + slots);
						const barWidth = Math.max(1, Math.min(8, Math.floor((innerWidth - 9) / slots) - 1));
						const preset = ctx.theme.getSymbolPreset();
						const plotHeight = Math.max(3, Math.min(6, Math.floor(height / 6)));
						const peak = Math.max(0.05, ...plot.map(row => LAYERS.reduce((sum, layer) => sum + (hiddenLayers.has(layer) ? 0 : layerFraction(row, layer)), 0)), ...(trend ? plot.map(row => fraction(row.atAssistant, row.messages)) : []));
						for (let y = plotHeight - 1; y >= 0; y--) {
							const threshold = ((y + 0.5) / plotHeight) * peak;
							let marks = "";
							for (const [index, row] of plot.entries()) {
								if (row.messages === 0) {
									marks += fg("muted", y === 0 ? "–" + " ".repeat(barWidth) : " ".repeat(barWidth + 1));
									continue;
								}
								let top = 0;
								let mark = " ";
								let layerToken: "error" | "warning" | "muted" = "muted";
								for (const layer of LAYERS) {
									if (hiddenLayers.has(layer)) continue;
									top += layerFraction(row, layer);
									if (mark === " " && threshold <= top) { mark = glyph(preset, "barFill"); layerToken = layer === "angry" ? "error" : layer === "assistant" ? "warning" : "muted"; }
								}
								const familyIndex = families.indexOf(familyKey(row));
								if (mostlyRegex(row) && mark !== " " && y % 2 === 0) mark = "/";
								const trendY = Math.min(plotHeight - 1, Math.floor(fraction(row.atAssistant, row.messages) / peak * plotHeight));
								const middle = Math.floor(barWidth / 2);
								let cell = trend && y === trendY
									? fg(layerToken, mark.repeat(middle)) + ctx.theme.bold(fg("text", "*")) + fg(layerToken, mark.repeat(barWidth - middle - 1))
									: fg(layerToken, mark.repeat(barWidth));
								const next = plot[index + 1];
								const connectorY = next && next.messages > 0 ? Math.min(plotHeight - 1, Math.floor((fraction(row.atAssistant, row.messages) + fraction(next.atAssistant, next.messages)) / (2 * peak) * plotHeight)) : -1;
								cell += trend && y === connectorY ? fg("text", glyph(preset, "trendFlat")) : fg(colors[Math.max(0, familyIndex) % colors.length], row.key === selectedKey ? glyph(preset, "columnGap") : y === 0 ? glyph(preset, "heatEmpty") : " ");
								marks += row.key === selectedKey ? ctx.theme.bg(SELECTION_BG.band, cell) : cell;
							}
							chart.push(truncateToWidth(`${formatPercent(((y + 1) / plotHeight) * peak, 1).padStart(6)} ${glyph(preset, "columnGap")} ${marks}`, innerWidth));
						}
						chart.push(truncateToWidth("  0.0%   " + plot.map(row => " ".repeat(Math.floor(barWidth / 2)) + fg(row.key === selectedKey ? "accent" : "muted", glyph(preset, row.key === selectedKey ? "trendUp" : "heatEmpty")) + " ".repeat(barWidth - Math.floor(barWidth / 2))).join(""), innerWidth));
						chartAdd(fg("muted", `Versions ${chartStart + 1}–${chartStart + plot.length}/${chartRows.length}: ${plot[0].label} → ${plot[plot.length - 1].label}`));
						chartAdd(LAYERS.map((layer, index) => fg(hiddenLayers.has(layer) ? "muted" : layer === "angry" ? "error" : layer === "assistant" ? "warning" : "muted", `${index + 1} ${hiddenLayers.has(layer) ? "off" : "on"} ${LAYER_LABELS[layer]}`)).join(" · ") + ` · 4 trend ${trend ? "on" : "off"}`);
						return chart;
					},
				},
				{
					title: "Families & coverage", meta: focus === "families" ? "↑/↓ family · Space toggle" : "Tab to filter", active: focus === "families",
					render: innerWidth => {
						const slots = Math.max(3, Math.min(6, families.length));
						const start = Math.max(0, Math.min(Math.max(0, families.length - slots), familyCursor - Math.floor(slots / 2)));
						return [
							...dataTable(ctx, innerWidth, "", [
								{ key: "family", header: "Family", align: "left" }, { key: "messages", header: "Msgs", align: "right" },
								{ key: "visible", header: "Shown", align: "right", priority: 1 },
							], families.slice(start, start + slots).map((family, index) => ({
								family: fg(colors[(start + index) % colors.length], family), messages: formatInteger(familyMessages.get(family) ?? 0),
								visible: hiddenFamilies.has(family) ? "off" : "on",
							})), focus === "families" ? familyCursor - start : undefined),
							"",
							`${formatInteger(classMessages)} class messages · ${rate(classJudged, classMessages)} judged`,
							fg("muted", `${formatInteger(classMessages - classJudged)} regex-only messages; cached verdicts retained.`),
							fg("muted", `Class messages: ${[...classTotals(data!.byModel)].map(([key, messages]) => `${key} ${formatInteger(messages)}`).join(" · ")}`),
							fg("muted", "Rates describe recorded messages, not model quality. Small samples can vary sharply."),
							...(!families.length ? ["No model families in this range."] : []),
						].flatMap(line => wrapTextWithAnsi(line, innerWidth));
					},
				},
			]));
			if (!rows.length || focus === "families") return lines;
			const reachable = Math.min(rows.length, revealed);
			const pageSize = Math.max(3, Math.min(12, height - lines.length - 4));
			const tableStart = Math.max(0, Math.min(Math.max(0, reachable - pageSize), selectedIndex - Math.floor(pageSize / 2)));
			lines.push(...dataTable(ctx, w, "Versions", [
				{ key: "identity", header: "Model version", align: "left" }, { key: "assistant", header: "Assist", align: "right" },
				{ key: "messages", header: "Msgs", align: "right", priority: 1 }, { key: "angry", header: "Angry", align: "right", priority: 2 },
				{ key: "judged", header: "Judged", align: "right", priority: 3 }, { key: "annoyed", header: "Annoy", align: "right", priority: 4 },
			], rows.slice(tableStart, Math.min(reachable, tableStart + pageSize)).map(row => ({
				identity: `${row.label}${mostlyRegex(row) ? " /" : ""}`, assistant: rate(row.atAssistant, row.messages),
				messages: formatInteger(row.messages), angry: rate(row.angry, row.messages), judged: rate(row.judged, row.messages), annoyed: rate(row.annoyed, row.messages),
			})), selectedIndex - tableStart));
			add(fg("muted", `${reachable}/${rows.length} revealed · ↑/↓ version · Enter details · o/O ${sort} ${descending ? "↓" : "↑"} · v more · / mostly regex`));
			return lines;
		},
		handleInput(input) {
			if (disposed || input === "q") return false;
			if (quote.state !== "closed") {
				if (input === "\x1b" || input === "n") {
					if (!starting) { quote = { state: "closed" }; ++quoteGeneration; ctx.changed(); }
				} else if (input === "y") void startRun();
				return true;
			}
			const { families, rows } = population();
			if (input === "j") { void openQuote(); return true; }
			if (input === "x" && job?.state === "running") { void cancelRun(); return true; }
			if (input === "\t") focus = focus === "versions" ? "families" : "versions";
			else if (input === "c") {
				const options = ["*", ...classTotals(data?.byModel ?? []).keys()];
				modelClass = options[(options.indexOf(activeModelClass(data?.byModel ?? [], modelClass)) + 1) % options.length];
				selectedIndex = 0; selectedKey = undefined;
			} else if (input === "m") showSmall = !showSmall;
			else if (input === "h") hideRegex = !hideRegex;
			else if (input === "o") sort = FRUSTRATION_SORTS[(FRUSTRATION_SORTS.indexOf(sort) + 1) % FRUSTRATION_SORTS.length];
			else if (input === "O") descending = !descending;
			else if (input === "v") revealed = Math.min(rows.length, Math.max(20, revealed * 2));
			else if (input === "1" || input === "2" || input === "3") {
				const layer = LAYERS[Number(input) - 1];
				if (hiddenLayers.has(layer)) hiddenLayers.delete(layer); else hiddenLayers.add(layer);
			} else if (input === "4") trend = !trend;
			else if (input === " " && focus === "families" && families[familyCursor]) {
				const key = families[familyCursor];
				if (hiddenFamilies.has(key)) hiddenFamilies.delete(key); else hiddenFamilies.add(key);
			} else if (input === "\x1b[A" || input === "\x1b[B") {
				const delta = input === "\x1b[A" ? -1 : 1;
				if (focus === "families") familyCursor = Math.max(0, Math.min(families.length - 1, familyCursor + delta));
				else {
					selectedIndex = Math.max(0, Math.min(Math.min(rows.length, revealed) - 1, selectedIndex + delta));
					selectedKey = rows[selectedIndex]?.key;
				}
			} else if (input === "\r" || input === "\n") details = !details;
			else if (input === "\x1b" && details) details = false;
			else if (input === "p" && details && rows[selectedIndex]) {
				void ctx.copy(JSON.stringify(rows[selectedIndex], null, 2)).then(() => {
					if (!disposed) { actionError = undefined; copyNotice = "Selected model row copied."; ctx.changed(); }
				}, err => { if (!disposed) { copyNotice = undefined; actionError = `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`; ctx.changed(); } });
			} else return false;
			ctx.changed();
			return true;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			++readGeneration; ++quoteGeneration; ++actionGeneration;
			stopPoll();
			if (job?.state === "running" || starting) void ctx.reader.api("/api/frustration/cancel", undefined, ACTION_OPTIONS).catch(() => undefined);
		},
	};
}
