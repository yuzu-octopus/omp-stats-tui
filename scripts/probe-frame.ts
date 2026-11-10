// Capture the composed panel frame at several widths, ANSI stripped, and report
// the frame contract by measurement. Run: bun scripts/probe-frame.ts
//
// The four widths are the ones the chrome brief names — 40 (tiny topbar),
// 60 (condensed), 100 (the common terminal, wide sidebar) and 150 (the widest
// band). OVERWIDE must be 0 at every one: a row that overflows is torn by
// `OverlayPanel.row`, not squeezed, so the control on the trailing edge is what
// disappears.
//
// Each width is captured TWICE — at scroll 0 and at the bottom of the body's
// range — because the frame regions are supposed to be immune to scroll. The
// nav column is cut out and diffed: `SCROLL-STABLE` must be true wherever a nav
// column exists, and that single word is the whole regression this probe
// exists to catch. Scrolling used to take `Usage` and `Overview` off the top of
// the frame with it.
import { __testing, type StatsPanel } from "../src/tui/panel";
import { liveData } from "../test/fixtures/panel";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const ANSI = /\x1b\[[0-9;]*m/g;
const WIDTHS = [150, 100, 60, 40];
const summary: string[] = [];
const blocks: string[] = [];
const panels: StatsPanel[] = [];

/** The nav column's cells for the nav rows of the last frame. */
const navCells = (panel: StatsPanel, width: number): { cells: readonly string[]; width: number } | null => {
	// Render FIRST: `debugFrame` reads the geometry recorded by the LAST render,
	// so reading it before rendering reports the previous width's frame.
	const rendered = panel.render(width);
	const frame = __testing.debugFrame(panel);
	if (!frame || frame.sidebarWidth === 0) return null;
	const start = frame.topbarRows + frame.stripRows;
	return {
		width: frame.sidebarWidth,
		cells: rendered.slice(start, start + frame.sidebarRows).map(row => row.replace(ANSI, "").slice(0, frame.sidebarWidth + 3)),
	};
};

for (const width of WIDTHS) {
	const panel = __testing.makePanel({ data: liveData(), range: "30d", rows: 40 });
	panels.push(panel);
	await __testing.settled(panel);
	const atRest = navCells(panel, width);
	const frame = panel.render(width);
	const plain = frame.map(line => line.replace(ANSI, ""));
	const dividers = plain.filter(row => row.includes("├")).length;
	const widest = Math.max(...plain.map(row => visibleWidth(row)));
	const over = plain.filter(row => visibleWidth(row) > width).length;
	const maxScroll = __testing.debugMaxScroll(panel);

	// Drive the real wheel path down to the bottom of the body's range.
	while (__testing.debugScroll(panel) < maxScroll) panel.handleInput("\x1b[<65;50;10M");
	const scrolled = panel.render(width).map(line => line.replace(ANSI, ""));
	const after = navCells(panel, width);
	const stable = atRest === null || after === null || (atRest.cells.length === after.cells.length && atRest.cells.every((cell, i) => cell === after.cells[i]));
	const bodyMoved = scrolled.some((row, i) => row.slice(atRest?.width ?? 0) !== plain[i]?.slice(atRest?.width ?? 0));

	summary.push(
		`  FRAME@${width} — ${plain.length} rows, widest ${widest}, ${dividers} divider(s), OVERWIDE: ${over}, scroll 0..${maxScroll}, SCROLL-STABLE: ${stable}${atRest === null ? " (no nav column at this band)" : ""}`,
	);
	blocks.push(
		`--- FRAME@${width} @scroll0: rows=${plain.length} widest=${widest} dividers=${dividers} OVERWIDE=${over}\n${plain.join("\n")}`,
	);
	blocks.push(
		`--- FRAME@${width} @scroll${maxScroll} (body scrolled=${bodyMoved}, nav SCROLL-STABLE=${stable})\n${scrolled.join("\n")}`,
	);
}
for (const panel of panels) panel.dispose();
console.log(summary.join("\n"));
console.log(blocks.join("\n\n"));