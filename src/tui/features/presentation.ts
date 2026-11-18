import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { renderBands, type BandRenderOptions, type Column, type StatTile } from "../band";
import { glyphsFor } from "../glyphs";
import { renderSparkline } from "../charts/sparkline";
import { PALETTE, SELECTION_BG } from "../palette";
import type { FeatureContext } from "./types";

function options(ctx: FeatureContext, width: number): BandRenderOptions {
	const preset = ctx.theme.getSymbolPreset();
	return {
		width, innerWidth: width, preset, glyphs: glyphsFor(preset),
		fg: (color, text) => ctx.theme.fg(color, text), bold: text => ctx.theme.bold(text),
		barHeight: 4, labelWidth: 14, valueWidth: 12,
		identityWidth: Math.max(8, Math.floor(width * 0.42)),
		sparkline: (values, columns) => renderSparkline(values, { width: columns, preset, accent: cell => ctx.theme.fg(PALETTE.primary, cell) }),
		selected: text => ctx.theme.bg(SELECTION_BG.band, text + " ".repeat(Math.max(0, width - visibleWidth(text)))),
	};
}

const RAIL_GAP = 2;
const SIDE_GAP = 2;
const CAVEAT = /unpriced|no price|not priced/i;

interface RailTile {
	full: string;
	plain: string;
	minimal: string;
	caveat: boolean;
}

function caveatParts(tile: StatTile): string {
	const parts: string[] = [];
	if (CAVEAT.test(tile.label)) parts.push(tile.label);
	if (CAVEAT.test(tile.value)) parts.push(tile.value);
	if (tile.hint && CAVEAT.test(tile.hint)) parts.push(`(${tile.hint})`);
	return parts.join(" ");
}

function buildRailTile(ctx: FeatureContext, tile: StatTile): RailTile {
	const label = ctx.theme.fg(PALETTE.muted, tile.label);
	const value = tile.emphasis === "primary"
		? ctx.theme.bold(ctx.theme.fg(PALETTE.primary, tile.value))
		: ctx.theme.fg(PALETTE.label, tile.value);
	const hint = tile.hint ? ctx.theme.fg(PALETTE.dim, ` (${tile.hint})`) : "";
	const caveat = caveatParts(tile);
	const caveatLabel = CAVEAT.test(tile.label) ? ctx.theme.fg(PALETTE.muted, tile.label) : "";
	const caveatValue = CAVEAT.test(tile.value) ? ctx.theme.fg(PALETTE.label, tile.value) : "";
	const caveatHint = tile.hint && CAVEAT.test(tile.hint) ? ctx.theme.fg(PALETTE.dim, `(${tile.hint})`) : "";
	return {
		full: `${label} ${value}${hint}`,
		plain: `${label} ${value}`,
		minimal: [caveatLabel, caveatValue, caveatHint].filter(Boolean).join(" "),
		caveat: caveat !== "",
	};
}

function fitRailCell(text: string, width: number, minimal: string): string {
	const cell = Math.max(0, width);
	if (cell === 0) return "";
	let candidate = text;
	if (visibleWidth(candidate) > cell && minimal !== "" && visibleWidth(minimal) <= cell) candidate = minimal;
	if (visibleWidth(candidate) > cell) candidate = truncateToWidth(candidate, cell, "");
	const padding = cell - visibleWidth(candidate);
	return padding > 0 ? candidate + " ".repeat(padding) : candidate;
}

function railRow(built: readonly RailTile[], available: number): string {
	const count = built.length;
	if (count === 0) return "";
	const gap = Math.min(RAIL_GAP, Math.max(0, Math.floor((available - count) / Math.max(1, count - 1))));
	const budget = Math.max(0, available - gap * (count - 1));
	const caveats = built.map((tile, index) => tile.caveat ? index : -1).filter(index => index >= 0);
	let texts = built.map(tile => tile.full);
	let widths = texts.map(text => visibleWidth(text));
	let used = widths.reduce((sum, width) => sum + width, 0);

	if (used > budget) {
		texts = built.map((tile, index) => tile.caveat ? texts[index]! : tile.plain);
		widths = texts.map(text => visibleWidth(text));
		used = widths.reduce((sum, width) => sum + width, 0);
	}
	const caveatWidth = () => caveats.reduce((sum, index) => sum + visibleWidth(texts[index]!), 0);
	if (used > budget && caveatWidth() > Math.max(0, budget - (count - caveats.length))) {
		for (const index of caveats) texts[index] = built[index]!.minimal || texts[index]!;
		widths = texts.map(text => visibleWidth(text));
		used = widths.reduce((sum, width) => sum + width, 0);
	}
	if (used > budget) {
		const others = built.map((_, index) => index).filter(index => !built[index]!.caveat);
		const share = Math.max(others.length, budget - caveatWidth());
		const natural = others.reduce((sum, index) => sum + visibleWidth(texts[index]!), 0) || 1;
		for (const index of others) {
			widths[index] = Math.max(1, Math.floor(share * visibleWidth(texts[index]!) / natural));
		}
		let total = widths.reduce((sum, width) => sum + width, 0);
		for (let index = 0; total < budget && others.length > 0; index = (index + 1) % others.length) {
			widths[others[index]!]!++;
			total++;
		}
		while (total > budget) {
			const shrink = others.find(index => widths[index]! > 1);
			if (shrink === undefined) break;
			widths[shrink]!--;
			total--;
		}
	}
	return built.map((tile, index) => fitRailCell(texts[index]!, widths[index]!, tile.minimal)).join(" ".repeat(gap));
}

function railMarker(ctx: FeatureContext, dropped: readonly StatTile[], width: number): string {
	if (dropped.length === 0) return "";
	let marker = ` +${dropped.length}`;
	for (const tile of dropped) {
		let excerpt = "";
		for (const text of [tile.label, tile.value, tile.hint ?? ""]) {
			if (!CAVEAT.test(text)) continue;
			excerpt = text.match(/\d[\d,]*\s+unpriced|no price[^,;]*|not priced|unpriced/i)?.[0]?.trim() ?? text;
			break;
		}
		if (excerpt === "") continue;
		const candidate = `${marker} · ${excerpt}`;
		if (visibleWidth(candidate) <= width) marker = candidate;
		else break;
	}
	if (visibleWidth(marker) > width) marker = truncateToWidth(marker, width, "");
	return ctx.theme.fg(PALETTE.dim, marker);
}

function sideCell(line: string | undefined, width: number): string {
	const text = line ?? "";
	const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const padding = width - visibleWidth(fitted);
	return padding > 0 ? fitted + " ".repeat(padding) : fitted;
}

/** Production controllers use the same measured tile grammar as the pure renderer. */
export function metricGrid(ctx: FeatureContext, width: number, tiles: readonly StatTile[]): string[] {
	return [...renderBands([{ kind: "statRow", stats: tiles }], options(ctx, width))];
}

/** Measured one-line stat pairs: three per row when wide, two when narrow. */
export function metricRail(ctx: FeatureContext, width: number, tiles: readonly StatTile[], options: { maxRows?: number } = {}): string[] {
	if (tiles.length === 0) return [];
	const columns = width >= 80 ? 3 : 2;
	const requested = options.maxRows ?? 2;
	const rows = Number.isFinite(requested) ? Math.max(1, Math.min(2, Math.floor(requested))) : 2;
	const visible = tiles.slice(0, columns * rows);
	const marker = railMarker(ctx, tiles.slice(columns * rows), width);
	const built = visible.map(tile => buildRailTile(ctx, tile));
	const lines: string[] = [];
	for (let start = 0; start < built.length; start += columns) {
		const row = built.slice(start, start + columns);
		const last = start + columns >= built.length;
		const available = Math.max(0, width - (last ? visibleWidth(marker) : 0));
		lines.push(railRow(row, available) + (last ? marker : ""));
	}
	return lines;
}

/** Aligned identity-first tables; selected rows retain a marker even without color. */
export function dataTable(ctx: FeatureContext, width: number, title: string, columns: readonly Column[], rows: readonly Record<string, string>[], selectedRow?: number): string[] {
	return [...renderBands([{ kind: "table", title, columns, rows: { kind: "inline", rows }, selectedRow }], options(ctx, width))];
}

/** Two measured blocks with a two-cell gutter; below 80 they stack with one blank. */
export function sideBySide(ctx: FeatureContext, width: number, left: readonly string[], right: readonly string[], options: { leftRatio?: number } = {}): string[] {
	void ctx;
	if (width < 80) {
		const rows = left.map(line => sideCell(line, width));
		if (rows.length > 0 && right.length > 0) rows.push("");
		for (const line of right) rows.push(sideCell(line, width));
		return rows;
	}
	const available = Math.max(SIDE_GAP + 2, width - SIDE_GAP);
	const requested = options.leftRatio ?? 0.5;
	const ratio = Number.isFinite(requested) ? Math.max(0, Math.min(1, requested)) : 0.5;
	const leftWidth = Math.max(1, Math.min(available - 1, Math.floor(available * ratio)));
	const rightWidth = available - leftWidth;
	const lines: string[] = [];
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		lines.push(sideCell(left[index], leftWidth) + " ".repeat(SIDE_GAP) + sideCell(right[index], rightWidth));
	}
	return lines;
}

export function sectionHeading(ctx: FeatureContext, width: number, title: string, meta = "", active = false): string {
	return truncateToWidth(ctx.theme.bold(ctx.theme.fg(active ? PALETTE.primary : PALETTE.muted, title)) + (meta ? ctx.theme.fg(PALETTE.dim, `  ${meta}`) : ""), Math.max(1, width));
}

/** Short, wrapping focus pills use the host's selection background and a plain `>` marker. */
export function focusTabs(ctx: FeatureContext, width: number, labels: readonly string[], selected: number): string[] {
	const line = labels.map((label, index) => index === selected
		? ctx.theme.bg(SELECTION_BG.band, ctx.theme.bold(ctx.theme.fg(PALETTE.primary, `> ${label} `)))
		: ctx.theme.fg(PALETTE.dim, ` ${label} `)).join("  ");
	return wrapTextWithAnsi(line, Math.max(1, width));
}
