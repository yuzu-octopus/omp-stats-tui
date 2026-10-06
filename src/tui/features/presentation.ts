import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { renderBands, type BandRenderOptions, type Column, type StatTile } from "../band";
import { glyph, glyphsFor } from "../glyphs";
import { renderSparkline } from "../charts/sparkline";
import { PALETTE, resolveSeries, SELECTION_BG } from "../palette";
import type { FeatureContext } from "./types";

function options(ctx: FeatureContext, width: number): BandRenderOptions {
	const preset = ctx.theme.getSymbolPreset();
	return {
		width, innerWidth: width, preset, glyphs: glyphsFor(preset),
		fg: (color, text) => ctx.theme.fg(color === PALETTE.dim ? PALETTE.muted : color === PALETTE.primary ? PALETTE.label : color, text), bold: text => ctx.theme.bold(text),
		barHeight: 4, labelWidth: 14, valueWidth: 12,
		identityWidth: Math.max(8, Math.floor(width * 0.42)),
		selected: text => ctx.theme.bg(SELECTION_BG.band, text + " ".repeat(Math.max(0, width - visibleWidth(text)))),
	};
}

export interface PanelOptions { meta?: string; active?: boolean; minimumHeight?: number; }
export interface DashboardPanel extends PanelOptions { title: string; render(width: number): readonly string[]; }

const pad = (text: string, width: number): string => {
	const clipped = truncateToWidth(text, Math.max(1, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

/** A bounded widget surface; callers render content at the supplied inner width. */
export function panel(ctx: FeatureContext, width: number, title: string, body: readonly string[], opts: PanelOptions = {}): string[] {
	const w = Math.max(1, Math.floor(width));
	if (w < 8) return [truncateToWidth(title, w), ...body.flatMap(line => wrapTextWithAnsi(line, w))];
	const theme = ctx.theme, inner = w - 4;
	const edge = (text: string) => theme.fg(opts.active ? PALETTE.primary : PALETTE.muted, text);
	const rule = theme.symbol("boxRound.horizontal"), vertical = theme.symbol("boxRound.vertical");
	const heading = truncateToWidth(title, Math.max(1, w - 6));
	const caption = ` ${theme.bold(theme.fg(PALETTE.heading, heading))} `;
	const top = edge(theme.symbol("boxRound.topLeft") + rule) + caption + edge(rule.repeat(Math.max(0, w - 3 - visibleWidth(caption))) + theme.symbol("boxRound.topRight"));
	const content = [...(opts.meta ? wrapTextWithAnsi(theme.fg(PALETTE.muted, opts.meta), inner) : []), ...body.flatMap(line => wrapTextWithAnsi(line, inner))];
	const minimum = Math.max(0, (opts.minimumHeight ?? 0) - 2);
	while (content.length < minimum) content.push("");
	return [top, ...content.map(line => edge(vertical) + " " + pad(line, inner) + " " + edge(vertical)), edge(theme.symbol("boxRound.bottomLeft") + rule.repeat(w - 2) + theme.symbol("boxRound.bottomRight"))];
}

/** Full-width cards with a balanced column count instead of a three-column text dump. */
export function metricGrid(ctx: FeatureContext, width: number, tiles: readonly StatTile[]): string[] {
	if (!tiles.length) return [];
	const w = Math.max(1, Math.floor(width));
	let columns = Math.min(4, tiles.length, Math.max(1, Math.floor((w + 2) / 19)));
	while (columns > 2 && tiles.length % columns !== 0) columns--;
	const gap = 2, base = Math.floor((w - gap * (columns - 1)) / columns);
	const result: string[] = [];
	for (let start = 0; start < tiles.length; start += columns) {
		const row = tiles.slice(start, start + columns);
		const sizes = row.map((_, i) => base + (i === columns - 1 ? w - (base * columns + gap * (columns - 1)) : 0));
		const cards = row.map((tile, i) => {
			const inner = Math.max(1, sizes[i] - 4);
			const value = ctx.theme.bold(ctx.theme.fg(tile.emphasis === "primary" ? PALETTE.primary : PALETTE.label, tile.value));
			const body = [...wrapTextWithAnsi(value, inner), ctx.theme.fg(PALETTE.muted, truncateToWidth(tile.hint ?? "", inner))];
			if (tile.spark?.length) body.push(renderSparkline(tile.spark, { width: inner, preset: ctx.theme.getSymbolPreset(), accent: cell => ctx.theme.fg(PALETTE.primary, cell) }));
			return { title: tile.label, body };
		});
		const height = Math.max(4, ...cards.map(card => card.body.length + 2));
		const rendered = cards.map((card, i) => panel(ctx, sizes[i], card.title, card.body, { minimumHeight: height }));
		if (result.length) result.push("");
		for (let y = 0; y < height; y++) result.push(rendered.map((card, i) => pad(card[y] ?? "", sizes[i])).join(" ".repeat(gap)));
	}
	return result;
}

/** Exact inner-width rendering, with paired surfaces on wide terminals and stacked surfaces below. */
export function dashboardPanels(ctx: FeatureContext, width: number, panels: readonly DashboardPanel[], opts: { ratio?: number } = {}): string[] {
	const w = Math.max(1, Math.floor(width)), output: string[] = [];
	for (let i = 0; i < panels.length;) {
		if (output.length) output.push("");
		const pair = w >= 100 && i + 1 < panels.length;
		const firstWidth = pair ? Math.max(44, Math.min(w - 46, Math.floor((w - 2) * (opts.ratio ?? 0.58)))) : w;
		const widths = pair ? [firstWidth, w - 2 - firstWidth] : [w];
		const group = panels.slice(i, i + widths.length);
		const bodies = group.map((item, n) => item.render(Math.max(1, widths[n] - 4)));
		const minimumHeight = Math.max(...bodies.map((body, n) => body.reduce((count, line) => count + wrapTextWithAnsi(line, Math.max(1, widths[n] - 4)).length, 0) + (group[n].meta ? wrapTextWithAnsi(group[n].meta!, Math.max(1, widths[n] - 4)).length : 0) + 2));
		const surfaces = group.map((item, n) => panel(ctx, widths[n], item.title, bodies[n], { ...item, minimumHeight }));
		const height = Math.max(...surfaces.map(surface => surface.length));
		for (let y = 0; y < height; y++) output.push(surfaces.map((surface, n) => pad(surface[y] ?? "", widths[n])).join("  "));
		i += widths.length;
	}
	return output;
}

/** Measured quantities, nearby values and zero-safe data ink for real distributions. */
export function ranking(ctx: FeatureContext, width: number, rows: readonly { label: string; value: number; display: string }[]): string[] {
	const w = Math.max(1, Math.floor(width));
	const maximum = Math.max(0, ...rows.map(row => row.value));
	const colors = resolveSeries(rows.length, ctx.theme), preset = ctx.theme.getSymbolPreset();
	return rows.flatMap((row, i) => {
		const value = row.display;
		const label = truncateToWidth(row.label, Math.max(1, w - visibleWidth(value) - 2));
		const caption = ctx.theme.fg(PALETTE.label, label) + " ".repeat(Math.max(1, w - visibleWidth(label) - visibleWidth(value))) + ctx.theme.bold(value);
		const track = Math.min(32, w), filled = maximum > 0 && row.value > 0 ? Math.max(1, Math.round(row.value / maximum * track)) : 0;
		return [truncateToWidth(caption, w), ctx.theme.fg(colors[i], glyph(preset, "barFill").repeat(filled)) + ctx.theme.fg(PALETTE.muted, glyph(preset, "barEmpty").repeat(track - filled))];
	});
}

/** A purposeful unavailable/empty explanation, never a decorative fake plot. */
export function emptyState(ctx: FeatureContext, width: number, title: string, description: string, action?: string): string[] {
	const w = Math.max(1, Math.floor(width));
	return ["", ctx.theme.bold(ctx.theme.fg(PALETTE.heading, title)), "", ...wrapTextWithAnsi(ctx.theme.fg(PALETTE.muted, description), w), ...(action ? ["", ...wrapTextWithAnsi(ctx.theme.fg(PALETTE.label, action), w)] : []), ""];
}

/** Aligned identity-first tables; selected rows retain a marker even without color. */
export function dataTable(ctx: FeatureContext, width: number, title: string, columns: readonly Column[], rows: readonly Record<string, string>[], selectedRow?: number): string[] {
	return [...renderBands([{ kind: "table", title, columns, rows: { kind: "inline", rows }, selectedRow }], options(ctx, width))];
}

export function sectionHeading(ctx: FeatureContext, width: number, title: string, meta = "", active = false): string {
	return truncateToWidth(ctx.theme.bold(ctx.theme.fg(PALETTE.heading, title)) + (meta ? ctx.theme.fg(PALETTE.muted, `  ${meta}`) : "") + (active ? ctx.theme.fg(PALETTE.primary, `  ${glyph(ctx.theme.getSymbolPreset(), "rowCursor")}`) : ""), Math.max(1, width));
}

export function focusTabs(ctx: FeatureContext, width: number, labels: readonly string[], selected: number): string[] {
	const line = labels.map((label, index) => index === selected
		? ctx.theme.bg(SELECTION_BG.band, ctx.theme.bold(ctx.theme.fg(PALETTE.label, ` ${glyph(ctx.theme.getSymbolPreset(), "rowCursor")} ${label} `)))
		: ctx.theme.fg(PALETTE.muted, ` ${label} `)).join("  ");
	return wrapTextWithAnsi(line, Math.max(1, width));
}
