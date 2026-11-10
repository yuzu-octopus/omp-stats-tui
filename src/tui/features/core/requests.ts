import type { MessageStats, RequestDetails as Payload } from "@oh-my-pi/omp-stats/client/types";
import { type ErrorGroupView, errorSignature, groupErrorsBySignature, requestStatus, summarizeRequests } from "@oh-my-pi/omp-stats/client/data/view-models";
import { modelKey } from "@oh-my-pi/omp-stats/client/data/colors";
import { formatCompact, formatCost, formatDurationMs, formatEstimatedCost, formatInteger, formatMessageCost, formatTimestamp, formatTokensPerSecond } from "@oh-my-pi/omp-stats/client/data/formatters";
import type { Range } from "../../../data/ranges";
import type { FeatureContext, FeatureController } from "../types";
import { ListState, fields, wrap, type ListColumn } from "./shared";
import { dataTable, focusTabs, metricGrid, sectionHeading } from "../presentation";
interface JsonSection { title: string; data: unknown; }
interface AffectedModel { key: string; model: string; provider: string; count: number; }

/** Lazy request inspector shared by the overview, request log and failures. */
export class RequestDetails {
	active = false;
	private disposed = false;
	private generation = 0;
	private row: MessageStats | null = null;
	private payload: Payload | null = null;
	private error: string | null = null;
	private notice: string | null = null;
	private section = 0;
	private readonly collapsed = new Set(["Session entry", "Stats row"]);
	constructor(private readonly ctx: FeatureContext) {}
	async open(row: MessageStats): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.active = true;
		this.row = row;
		this.payload = null;
		this.error = null;
		this.notice = null;
		this.section = 0;
		this.collapsed.clear();
		this.collapsed.add("Session entry");
		this.collapsed.add("Stats row");
		this.ctx.changed();
		if (row.id === undefined) { this.error = "Request has no stored id; full payload unavailable."; this.ctx.changed(); return; }
		try {
			const payload = await this.ctx.reader.api<Payload>(`/api/request/${row.id}`);
			if (this.disposed || !this.active || generation !== this.generation) return;
			this.payload = payload;
		} catch (error) {
			if (this.disposed || !this.active || generation !== this.generation) return;
			this.error = String(error);
		}
		this.ctx.changed();
	}
	render(width: number): string[] | null {
		if (!this.active) return null;
		const lines = [sectionHeading(this.ctx, width, `Request #${this.row?.id ?? "–"}`)];
		if (this.notice) lines.push(this.notice);
		if (!this.payload) return wrap([...lines, this.error ? `Error: ${this.error}${this.row?.id === undefined ? "" : " · e retry"}` : "Loading request details…",
			this.ctx.theme.fg("dim", "b/Esc back"),
			...(this.row ? ["Loaded request metadata (session payload unavailable)", ...fields(this.row)] : [])], width);
		const d = this.payload;
		const sections = this.sections(d);
		const selected = sections[this.section % sections.length];
		lines.push(sectionHeading(this.ctx, width, `${d.model} · ${d.provider}`, requestStatus(d)),
			...(d.errorMessage ? [this.ctx.theme.fg("error", `${requestStatus(d) === "aborted" ? "Aborted" : "Error"}: ${d.errorMessage}`)] : []),
			...metricGrid(this.ctx, width, [
				{ label: "API estimate", value: formatMessageCost(d, 4), emphasis: "primary", hint: `unpriced requests: ${Number(d.costUnpriced ?? false)}` },
				{ label: "Duration", value: formatDurationMs(d.duration), hint: formatTimestamp(d.timestamp) },
				{ label: "TTFT", value: formatDurationMs(d.ttft) },
				{ label: "Throughput", value: `${formatTokensPerSecond(d.duration !== null && d.duration > 0 && d.usage.output > 0 ? d.usage.output * 1000 / d.duration : null)} tok/s` },
			]),
			...dataTable(this.ctx, width, "Tokens", [{ key: "bucket", header: "Bucket", align: "left" }, { key: "tokens", header: "Tokens", align: "right" }],
				Object.entries({ "Uncached input": d.usage.input, "Cache read": d.usage.cacheRead, "Cache write": d.usage.cacheWrite, Output: d.usage.output, Total: d.usage.totalTokens, "Premium requests": d.usage.premiumRequests ?? 0 }).map(([bucket, value]) => ({ bucket, tokens: Number.isInteger(value) ? formatInteger(value) : String(value) }))),
			sectionHeading(this.ctx, width, "Billing components"),
			...Object.entries(d.usage.cost).map(([component, value]) => `${component}: ${d.costUnpriced ? "unpriced request; component estimate unavailable" : formatCost(value)}`),
			sectionHeading(this.ctx, width, "Identity"), ...fields({ requestId: d.id, entryId: d.entryId, stopReason: d.stopReason, api: d.api, project: d.folder, sessionFile: d.sessionFile }),
			...focusTabs(this.ctx, width, sections.map(section => section.title), this.section % sections.length),
			this.ctx.theme.fg("dim", `n section · v ${this.collapsed.has(selected.title) ? "expand" : "collapse"} · c/C copy · t trace · b/Esc back`),
			...sections.flatMap(section => [sectionHeading(this.ctx, width, section.title, this.collapsed.has(section.title) ? "collapsed" : ""), ...(this.collapsed.has(section.title) ? [] : [JSON.stringify(section.data, null, 2) ?? "null"])]));
		return wrap(lines, width);
	}
	private sections(d: Payload): JsonSection[] {
		const { messages, output, ...stats } = d;
		return [...(output == null ? [] : [{ title: "Output message", data: output }]), { title: "Session entry", data: messages }, { title: "Stats row", data: stats }];
	}
	handleInput(data: string): boolean {
		if (!this.active || data === "q") return false;
		if (data === "b" || data === "\x1b") { this.close(); return true; }
		if (data === "e" && this.error && this.row) { void this.open(this.row); return true; }
		if (this.payload && (data === "n" || data === "v")) {
			const sections = this.sections(this.payload);
			if (data === "n") this.section = (this.section + 1) % sections.length;
			else {
				const title = sections[this.section % sections.length].title;
				this.collapsed.has(title) ? this.collapsed.delete(title) : this.collapsed.add(title);
			}
			this.ctx.changed();
			return true;
		}
		if (data === "t") {
			if (this.payload) { const d = this.payload; this.ctx.openTrace(d.sessionFile, d.entryId); }
			return true;
		}
		if (data === "c" || data === "C") {
			if (this.payload) {
				const generation = this.generation;
				const sections = this.sections(this.payload);
				const value = data === "C" ? sections[this.section % sections.length].data : this.payload;
				void this.ctx.copy(JSON.stringify(value, null, 2)).then(() => this.copied(generation, "JSON copied successfully."), error => this.copied(generation, `Copy failed: ${String(error)}`));
			} else { this.notice = "Copy unavailable until request details load."; this.ctx.changed(); }
			return true;
		}
		return false;
	}
	private copied(generation: number, notice: string): void { if (!this.disposed && this.active && generation === this.generation) { this.notice = notice; this.ctx.changed(); } }
	close(): void { this.active = false; ++this.generation; this.payload = null; this.ctx.changed(); }
	dispose(): void { this.disposed = true; this.active = false; ++this.generation; this.payload = null; }
}

const rowKey = (row: MessageStats) => String(row.id ?? `${row.sessionFile}:${row.entryId}`);
const statuses = ["all", "ok", "aborted", "failed"] as const;
const sorters: Record<string, (row: MessageStats) => string | number> = {
	time: r => r.timestamp, model: r => r.model, provider: r => r.provider, project: r => r.folder,
	input: r => r.usage.input, cacheRead: r => r.usage.cacheRead, cacheWrite: r => r.usage.cacheWrite,
	output: r => r.usage.output, total: r => r.usage.totalTokens, premium: r => r.usage.premiumRequests ?? 0,
	cost: r => r.usage.cost.total, inputCost: r => r.usage.cost.input, outputCost: r => r.usage.cost.output,
	cacheReadCost: r => r.usage.cost.cacheRead, cacheWriteCost: r => r.usage.cost.cacheWrite,
	duration: r => r.duration ?? -1, ttft: r => r.ttft ?? -1, status: requestStatus, error: r => r.errorMessage ?? "",
	id: r => r.id ?? -1, entry: r => r.entryId, session: r => r.sessionFile, api: r => r.api, stop: r => r.stopReason,
	unpriced: r => Number(r.costUnpriced ?? false),
};
const signatureSorters = { count: (group: ErrorGroupView) => group.count, signature: (group: ErrorGroupView) => group.signature, models: (group: ErrorGroupView) => group.models.length, last: (group: ErrorGroupView) => group.lastSeen };

const requestColumns: readonly ListColumn<MessageStats>[] = [
	{ key: "identity", header: "Request / model", align: "left", value: r => `#${r.id ?? "–"} ${r.model} · ${r.provider}` },
	{ key: "cost", header: "Estimate", align: "right", priority: 1, value: r => formatMessageCost(r) },
	{ key: "tokens", header: "Tokens", align: "right", priority: 2, value: r => formatCompact(r.usage.totalTokens) },
	{ key: "status", header: "Status", align: "left", priority: 3, value: requestStatus },
	{ key: "duration", header: "Duration", align: "right", priority: 4, value: r => formatDurationMs(r.duration) },
	{ key: "ttft", header: "TTFT", align: "right", priority: 5, value: r => formatDurationMs(r.ttft) },
	{ key: "time", header: "Started", align: "left", priority: 6, value: r => formatTimestamp(r.timestamp) },
	{ key: "project", header: "Project", align: "left", priority: 7, value: r => r.folder },
];
const errorColumns: readonly ListColumn<MessageStats>[] = [...requestColumns, { key: "error", header: "Error", align: "left", priority: 3, value: r => r.errorMessage ?? "—" }];
export function createRequestsFeature(id: "requests" | "errors", ctx: FeatureContext): FeatureController {
	const details = new RequestDetails(ctx);
	const list = new ListState<MessageStats>(rowKey, "time");
	list.descending = true;
	const signatures = new ListState<ErrorGroupView>(g => g.signature, "count", 100);
	signatures.descending = true;
	const models = new ListState<AffectedModel>(m => m.key, "count", 100);
	models.descending = true;
	const steps = id === "requests" ? [500, 2000, 10000] : [50, 200, 1000];
	let rows: MessageStats[] = [], range: Range = "24h", step = 0, generation = 0, closed = false, loading = false, error: string | null = null;
	let hasData = false;
	let status = 0, focus = 0, signature: string | null = null, model: string | null = null;
	const groups = () => groupErrorsBySignature(rows);
	const modelRows = () => {
		const map = new Map<string, AffectedModel>();
		for (const row of rows) { const key = modelKey(row.model, row.provider); const found = map.get(key); if (found) found.count++; else map.set(key, { key, model: row.model, provider: row.provider, count: 1 }); }
		return models.rows([...map.values()], { count: m => m.count, model: m => m.model, provider: m => m.provider });
	};
	const visible = () => {
		const needle = list.search.trim().toLowerCase();
		const effectiveSignature = groups().some(g => g.signature === signature) ? signature : null;
		const effectiveModel = modelRows().some(m => m.key === model) ? model : null;
		return list.rows(rows.filter(r => (id !== "requests" || status === 0 || requestStatus(r) === statuses[status]) &&
			(id !== "errors" || ((!effectiveSignature || errorSignature(r.errorMessage) === effectiveSignature) && (!effectiveModel || modelKey(r.model, r.provider) === effectiveModel))) &&
			(!needle || [r.model, r.provider, r.folder, ...(id === "errors" ? [r.errorMessage ?? ""] : [])].some(value => value.toLowerCase().includes(needle)))), sorters);
	};
	const load = async (nextRange: Range) => {
		if (closed) return;
		range = nextRange; const request = ++generation; loading = true; error = null; ctx.changed();
		try { const result = await ctx.reader.api<MessageStats[]>(id === "requests" ? "/api/stats/recent" : "/api/stats/errors", { range, limit: String(steps[step]) }); if (closed || request !== generation) return; rows = result; hasData = true; }
		catch (caught) { if (closed || request !== generation) return; error = String(caught); }
		loading = false; ctx.changed();
	};
	return {
		load,
		get inputMode() { return list.editing ? "text" as const : "navigation" as const; },
		render(width, height) {
			const detail = details.render(width); if (detail) return detail;
			if (!hasData) return wrap([sectionHeading(ctx, width, id === "requests" ? "Requests" : "Errors", range),
				ctx.theme.fg(error ? "error" : "dim", error ? `${error} · l retry` : loading ? "Loading observations…" : "No observations loaded yet."),
				...(list.editing || list.search ? [`Search: ${list.search || "—"} · Enter/Esc finish · Ctrl-U clear`] : [])], width);
			const filtered = visible();
			let hasTiming = false;
			const counts = { all: rows.length, ok: 0, aborted: 0, failed: 0 };
			for (const row of rows) {
				counts[requestStatus(row)]++;
				hasTiming ||= row.duration !== null && row.duration !== undefined;
			}
			const complete = !loading && !error && rows.length < steps[step];
			const summary = summarizeRequests(rows);
			const gs = signatures.rows(groups(), signatureSorters);
			const ms = modelRows();
			const scope = complete ? "Complete range" : `Latest ${rows.length}; older ${id === "errors" ? "failures" : "requests"} are not loaded`;
			const lines = [sectionHeading(ctx, width, id === "requests" ? "Requests" : "Errors", range),
				...metricGrid(ctx, width, [
					{ label: id === "errors" ? "Loaded failures" : "Loaded requests", value: formatInteger(rows.length), emphasis: "primary", hint: `${counts.ok} ok` },
					{ label: "Matching", value: formatInteger(filtered.length), hint: id === "errors" ? `${gs.length} signatures` : `${counts.failed} failed` },
					{ label: "API estimate", value: formatEstimatedCost(summary.cost, summary.unpriced), hint: `${formatInteger(summary.unpriced)} unpriced` },
					{ label: "Tokens", value: formatCompact(summary.tokens), hint: `${counts.aborted} aborted` },
					{ label: "Median latency", value: hasTiming ? formatDurationMs(summary.medianDuration) : "—" },
					{ label: "p95 latency", value: hasTiming ? formatDurationMs(summary.p95Duration) : "—" },
				])];
			if (loading) lines.push(ctx.theme.fg("dim", "Loading… previous rows retained")); if (error) lines.push(ctx.theme.fg("error", `${error} · showing retained rows · l retry`));
			lines.push(ctx.theme.fg("dim", `${scope} · ${formatInteger(summary.unpriced)} unpriced`));
			lines.push(...focusTabs(ctx, width, id === "errors" ? ["Signatures", "Models", "Failures"] : ["Request log"], focus));
			lines.push(ctx.theme.fg("dim", id === "requests" ? `f status: ${statuses[status]} · / search · o/O sort · Enter details · l load more` : "Tab pane · / search · o/O sort · Enter select/open · u latest · f/x/X clear"));
			const panelHeight = Math.max(5, height - lines.length);
			const failurePanel = id === "requests" || focus === 2 ? list.render(filtered, width, panelHeight, id === "errors" ? errorColumns : requestColumns, ctx, id === "errors" ? "Failures" : "Request log") : [];
			if (id === "requests") {
				lines.push(...failurePanel);
			} else {
				lines.push(`Signature: ${gs.some(group => group.signature === signature) ? signature : "all"} · model: ${ms.some(row => row.key === model) ? model : "all"}`);
				const panel = focus === 0
					? signatures.render(gs, width, panelHeight, [
						{ key: "signature", header: "Error signature", align: "left", value: g => g.signature },
						{ key: "count", header: "Failures", align: "right", value: g => formatInteger(g.count) },
						{ key: "models", header: "Models", align: "right", priority: 2, value: g => formatInteger(g.models.length) },
						{ key: "last", header: "Latest", align: "left", priority: 3, value: g => formatTimestamp(g.lastSeen) },
					], ctx, "Error signatures")
					: focus === 1 ? models.render(ms, width, panelHeight, [
						{ key: "identity", header: "Model / provider", align: "left", value: m => `${m.model} · ${m.provider}` },
						{ key: "count", header: "Failures", align: "right", value: m => formatInteger(m.count) },
					], ctx, "Affected models")
					: failurePanel;
				lines.push(...panel);
				const expanded = gs.find(group => group.signature === signature);
				if (expanded) {
					lines.push(sectionHeading(ctx, width, "Expanded signature", `${expanded.count} members`), expanded.signature,
						`First ${formatTimestamp(expanded.firstSeen)} · latest ${formatTimestamp(expanded.lastSeen)}`,
						`Latest error: ${expanded.latest.errorMessage ?? "—"}`,
						...expanded.models.map(member => `${member.model} · ${member.provider}: ${member.count} failures`));
				}
			}
			return wrap(lines, width);
		},
		handleInput(data) {
			if (closed || !list.editing && (data === "q" || data === "[" || data === "]") ||
				data === "\x1b[D" || data === "\x1b[C") return false;
			if (details.active) return details.handleInput(data);
			const filtered = visible();
			if (list.editing && (data === "\t" || data === "\x1b[Z") && id === "errors") { list.editing = false; focus = (focus + (data === "\t" ? 1 : 2)) % 3; ctx.changed(); return true; }
			if (list.editing) { const consumed = list.input(data, filtered); if (consumed) ctx.changed(); return consumed; }
			if (data === "l") { if (step + 1 < steps.length) step++; void load(range); return true; }
			if (data === "f") { if (id === "requests") status = (status + 1) % statuses.length; else { signature = null; model = null; list.search = ""; } ctx.changed(); return true; }
			if (id === "errors" && (data === "x" || data === "X")) { if (data === "x") signature = null; else model = null; ctx.changed(); return true; }
			if (data === "\x1b" && id === "errors" && (signature || model)) { signature = null; model = null; list.search = ""; ctx.changed(); return true; }
			if (data === "o" || data === "O") {
				const active = id !== "errors" || focus === 2 ? list : focus === 0 ? signatures : models;
				const keys = id !== "errors" || focus === 2 ? Object.keys(sorters) : focus === 0 ? Object.keys(signatureSorters) : ["count", "model", "provider"];
				if (data === "O") active.descending = !active.descending;
				else active.sort = keys[(keys.indexOf(active.sort) + 1) % keys.length];
				ctx.changed(); return true;
			}
			if (id === "errors" && (data === "\t" || data === "\x1b[Z")) { focus = (focus + (data === "\t" ? 1 : 2)) % 3; ctx.changed(); return true; }
			if (id === "errors" && data === "u") { const selected = groups().find(group => group.signature === signature); const latest = selected?.latest ?? rows.reduce<MessageStats | undefined>((best, r) => !best || r.timestamp > best.timestamp ? r : best, undefined); if (latest) void details.open(latest); return true; }
			if (data === "\r" || data === "\n") {
				if (id === "errors" && focus === 0) { const selected = signatures.current(signatures.rows(groups(), signatureSorters)); if (selected) signature = signature === selected.signature ? null : selected.signature; }
				else if (id === "errors" && focus === 1) { const selected = models.current(modelRows()); if (selected) model = model === selected.key ? null : selected.key; }
				else { const selected = list.current(filtered); if (selected) void details.open(selected); }
				ctx.changed(); return true;
			}
			// Search belongs to the failure list regardless of current panel focus.
			if (data === "/" && id === "errors") focus = 2;
			const consumed = data === "/" || data === "\x1b" || id === "requests" || focus === 2 ? list.input(data, filtered)
				: focus === 0 ? signatures.input(data, signatures.rows(groups(), signatureSorters)) : models.input(data, modelRows());
			if (consumed) ctx.changed(); return consumed;
		},
		dispose() { closed = true; ++generation; details.dispose(); },
	};
}
