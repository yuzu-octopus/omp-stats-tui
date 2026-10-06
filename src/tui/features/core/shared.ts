import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { FeatureContext } from "../types";
import { renderTimeSeries, type TimeSeriesOptions } from "../../charts/time-series";
import type { Column } from "../../band";
import { dataTable, sectionHeading } from "../presentation";

/** Wrap prose/details; chart and list rows should be clipped instead. */
export function wrap(lines: readonly string[], width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	return lines.flatMap(line => wrapTextWithAnsi(line, w).map(part => truncateToWidth(part, w)));
}

/** Scalar-labelled details keep every omitted narrow-table column accessible. */
export function fields(value: unknown, prefix = ""): string[] {
	if (value === null || value === undefined) return [`${prefix || "Value"}: —`];
	if (typeof value !== "object") return [`${prefix || "Value"}: ${String(value)}`];
	return Object.entries(value).flatMap(([key, item]) => fields(item, prefix ? `${prefix}.${key}` : key));
}

export type SortValue = string | number | null | undefined;
export type Sorters<T> = Record<string, (row: T) => SortValue>;
export interface ListColumn<T> extends Omit<Column, "cell"> {
	value: (row: T) => string;
}
export class ListState<T> {
	search = "";
	editing = false;
	sort: string;
	descending = true;
	reveal: number;
	selected: string | null = null;
	constructor(readonly key: (row: T) => string, initialSort: string, readonly initialLimit = 100) {
		this.sort = initialSort;
		this.reveal = initialLimit;
	}
	rows(rows: readonly T[], sorters: Sorters<T>): T[] {
		const getter = sorters[this.sort];
		if (!getter) return [...rows];
		return [...rows].sort((a, b) => {
			const av = getter(a) ?? -Infinity, bv = getter(b) ?? -Infinity;
			const order = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : av < bv ? -1 : av > bv ? 1 : 0;
			return (this.descending ? -order : order) || this.key(a).localeCompare(this.key(b));
		});
	}
	current(rows: readonly T[]): T | undefined {
		const current = rows.find(row => this.key(row) === this.selected) ?? rows[0];
		if (this.selected === null && current) this.selected = this.key(current);
		return current;
	}
	move(rows: readonly T[], delta: number): void {
		if (!rows.length) return;
		const current = rows.findIndex(row => this.key(row) === this.selected);
		const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
		this.selected = this.key(rows[next]);
		this.reveal = Math.max(this.reveal, next + 1);
	}
	input(data: string, rows: readonly T[]): boolean {
		if (data === "\x0e" || data === "\x10" || data === "\x1b[C" || data === "\x1b[D" ||
			data === "\x1b[5~" || data === "\x1b[6~" || data === "\x1b[H" || data === "\x1b[F" ||
			data === "\x1b[1~" || data === "\x1b[4~") return false;
		if (this.editing) {
			if (data === "\x1b" || data === "\r" || data === "\n") this.editing = false;
			else if (data === "\x7f" || data === "\b") this.search = [...this.search].slice(0, -1).join("");
			else if (data === "\x15") this.search = "";
			else if (!/[\x00-\x1f\x7f]/.test(data)) this.search += data;
			return true;
		}
		if (data === "q" || data === "[" || data === "]") return false;
		if (data === "/") { this.editing = true; return true; }
		if (data === "\x1b" && this.search) { this.search = ""; return true; }
		if (data === "j" || data === "\x1b[B") { this.move(rows, 1); return true; }
		if (data === "k" || data === "\x1b[A") { this.move(rows, -1); return true; }
		if (data === "+") { this.reveal += this.initialLimit; return true; }
		if (data === "a") { this.reveal = Infinity; return true; }
		return false;
	}
	render(rows: readonly T[], width: number, height: number, columns: readonly ListColumn<T>[], ctx: FeatureContext, title: string): string[] {
		const search = this.editing ? [`Search: ${this.search || "—"}  · Enter/Esc finish · Ctrl-U clear`] : this.search ? [`Search: ${this.search}`] : [];
		if (!rows.length) return [sectionHeading(ctx, width, title), ...wrap(search, width),
			...wrap([ctx.theme.fg("muted", this.search ? "No matches. Esc clears search." : "No visible records. Change range or filters.")], width)];
		const current = this.current(rows)!;
		const index = rows.indexOf(current);
		this.reveal = Math.max(this.reveal, index + 1);
		const count = Math.max(1, Math.min(Math.max(1, height - 4 - search.length), this.reveal, rows.length));
		const start = Math.max(0, Math.min(index - Math.floor(count / 2), Math.min(rows.length, this.reveal) - count));
		const records = rows.slice(start, start + count).map(row => Object.fromEntries(columns.map(column => [column.key, column.value(row)])));
		return [sectionHeading(ctx, width, title, `${start + 1}–${start + count}/${rows.length} · ${this.sort} ${this.descending ? "↓" : "↑"}`),
			...wrap(search, width), ...dataTable(ctx, width, "", columns, records, index - start)];
	}
}

export interface CoreSeries { key: string; label: string; values: readonly (number | null)[]; }
export class ChartState {
	mode = 0;
	seriesIndex = 0;
	point = -1;
	private timestamp: number | null = null;
	private selectedSeries: string | null = null;
	readonly hidden = new Set<string>();
	input(data: string, keys: readonly string[]): boolean {
		if (data === "n") { this.seriesIndex = (this.seriesIndex + 1) % Math.max(1, keys.length); this.selectedSeries = keys[this.seriesIndex] ?? null; return true; }
		if (data === "v") {
			const key = keys[this.seriesIndex % Math.max(1, keys.length)];
			if (key) this.hidden.has(key) ? this.hidden.delete(key) : this.hidden.add(key);
			return true;
		}
		if (data === ",") { this.point = Math.max(0, this.point - 1); this.timestamp = null; return true; }
		if (data === ".") { this.point++; this.timestamp = null; return true; }
		return false;
	}
	/** Initial focus follows the newest recorded bucket, not a densified quiet endpoint. */
	seedLatestPoint(buckets: readonly number[], timestamps: Iterable<number>): void {
		if (this.point >= 0 || !buckets.length) return;
		let latest = -Infinity;
		for (const timestamp of timestamps) latest = Math.max(latest, timestamp);
		this.point = buckets.length - 1;
		for (let i = buckets.length - 1; i >= 0; i--) {
			if (buckets[i] <= latest) { this.point = i; break; }
		}
	}
	reconcile(buckets: readonly number[], keys: readonly string[]): void {
		const point = this.timestamp === null ? -1 : buckets.indexOf(this.timestamp);
		if (buckets.length) {
			this.point = point >= 0 ? point : Math.max(0, Math.min(this.point < 0 ? buckets.length - 1 : this.point, buckets.length - 1));
			if (this.timestamp === null) this.timestamp = buckets[this.point];
		}
		const series = this.selectedSeries === null ? -1 : keys.indexOf(this.selectedSeries);
		this.seriesIndex = series >= 0 ? series : this.seriesIndex % Math.max(1, keys.length);
		if (this.selectedSeries === null && keys.length) this.selectedSeries = keys[this.seriesIndex];
	}
	render(ctx: FeatureContext, width: number, buckets: readonly number[], series: readonly CoreSeries[], options: TimeSeriesOptions = {}): string[] {
		this.reconcile(buckets, series.map(row => row.key));
		return renderTimeSeries(ctx, buckets, series, width, this.point, {
			...options, hidden: this.hidden, selectedKey: series[this.seriesIndex]?.key,
		});
	}
}
