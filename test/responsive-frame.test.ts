/**
 * The responsive FRAME: bands, chrome modes, and live-resize behavior.
 *
 * Owned by responsive-frame. Consumes `panel.ts` (via `__testing`), `layout.ts`
 * and the new `responsive.ts` read-only — it creates no frame code, it pins the
 * contract: which band a total width lands in, what chrome that band gets, and
 * that the composed panel survives a width change without a torn row or a lost
 * scroll position.
 *
 * The five widths are the brief's acceptance set (40/60/80/100/120): every one
 * must fill the terminal, keep every row within width, and draw exactly the one
 * G6 divider between body and footer (which is also the G5 pin: no body owns a
 * rule, so a second `├` row is a body leaking chrome).
 */

import { test, expect } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { chipFor, progressLineFor, sidebar, topbar } from "../src/tui/chrome";
import { budgetFrame } from "../src/tui/frame";
import { BREAKPOINTS, HORIZONTAL_INSET, planLayout } from "../src/tui/layout";
import { __testing, SELECTABLE_SCREENS } from "../src/tui/panel";
import { framePolicy } from "../src/tui/responsive";
import { liveData } from "./fixtures/panel";

ensureThemeSync();

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (row: string): string => row.replace(ANSI, "");

const END = "\x1b[F";

// ---------------------------------------------------------------------------
// Policy: total width -> band -> chrome modes
// ---------------------------------------------------------------------------

test("every breakpoint row owns the total widths that map to it", () => {
	// Edges derived from the table (`minInnerWidth + insets`), never restated:
	// a retuned threshold moves these expectations with it.
	for (const row of BREAKPOINTS) {
		const total = row.minInnerWidth + HORIZONTAL_INSET;
		expect(framePolicy(total).band, row.name).toBe(row.name);
		if (row.minInnerWidth > 0) {
			expect(framePolicy(total - 1).band, `${row.name} loses at ${total - 1}`).not.toBe(row.name);
		}
	}
});

test("chrome modes and nav location per band, pinned for the shell to build against", () => {
	expect(framePolicy(120)).toMatchObject({
		band: "wide", sidebar: "full", navMode: "sidebar", topbar: "full", columns: 2, footerHints: true,
	});
	expect(framePolicy(100)).toMatchObject({ band: "wide", sidebar: "full", navMode: "sidebar" });
	expect(framePolicy(84)).toMatchObject({ band: "wide", sidebar: "full", navMode: "sidebar" });
	expect(framePolicy(83)).toMatchObject({ band: "medium", sidebar: "hidden", navMode: "toolbarRoute", topbar: "condensed" });
	expect(framePolicy(60)).toMatchObject({
		band: "medium", sidebar: "hidden", navMode: "toolbarRoute", topbar: "condensed", columns: 1, footerHints: true,
	});
	expect(framePolicy(48)).toMatchObject({ band: "medium", navMode: "toolbarRoute" });
	expect(framePolicy(47)).toMatchObject({ band: "narrow", sidebar: "hidden", navMode: "toolbarRoute" });
	expect(framePolicy(40)).toMatchObject({
		band: "narrow", sidebar: "hidden", navMode: "toolbarRoute", topbar: "condensed", columns: 1, footerHints: true,
	});
	expect(framePolicy(34)).toMatchObject({ band: "narrow", navMode: "toolbarRoute" });
	expect(framePolicy(33)).toMatchObject({
		band: "tiny", sidebar: "hidden", navMode: "toolbarRoute", topbar: "minimal", columns: 1, footerHints: false,
	});
});

test("the policy never disagrees with planLayout about the fields they share", () => {
	// The no-second-convention test: bands, columns, footer hints and the narrow
	// flag come from layout.ts's table, so a retune there flows through here.
	for (let width = 1; width <= 200; width++) {
		const plan = planLayout(width, 40, "unicode", budgetFrame(width, 40, 1, "unicode").bodyRows);
		const policy = framePolicy(width);
		expect(policy.band, `w=${width}`).toBe(plan.breakpoint);
		expect(policy.columns, `w=${width}`).toBe(plan.columns);
		expect(policy.footerHints, `w=${width}`).toBe(plan.showFooterHints);
		expect(policy.tooNarrow, `w=${width}`).toBe(plan.tooNarrow);
	}
});

// ---------------------------------------------------------------------------
// Budget: one header row, one body calculation, no nav clipped by short frames
// ---------------------------------------------------------------------------

test("the budget spends exactly one header row and no strip at every acceptance size", () => {
	for (const width of [40, 60, 84, 100, 120]) {
		for (const rows of [20, 24, 30, 40]) {
			const budget = budgetFrame(width, rows, 1, "unicode");
			const where = `w=${width} h=${rows}`;
			expect(budget.topbarRows, where).toBe(1);
			expect(budget.stripRows, where).toBe(0);
			expect(budget.bodyRows, where).toBe(rows - 5);
			const navCols =
				framePolicy(width).navMode === "sidebar"
					? sidebar(theme, "unicode", "overview").width + 3
					: 0;
			expect(budget.bodyInnerWidth, where).toBe(width - HORIZONTAL_INSET - navCols);
		}
	}
});

test("the full sidebar fits from 20 rows, and compact progress cannot spend a body row", () => {
	const navRows = sidebar(theme, "unicode", "overview").lines.length;
	for (let rows = 20; rows <= 40; rows++) {
		const budget = budgetFrame(100, rows, 1, "unicode");
		expect(budget.bodyRows, `h=${rows}`).toBeGreaterThanOrEqual(navRows);
	}

	const event = { type: "progress", phase: "ingest", current: 25, total: 100 } as const;
	const quiet = budgetFrame(100, 40, 1, "unicode");
	const busy = budgetFrame(100, 40, 1, "unicode");
	expect(busy).toEqual(quiet);
	const row = topbar(theme, {
		screenLabel: "Overview",
		range: "24h",
		chip: chipFor(theme, {
			syncing: true, live: true, current: 25, total: 100, determinate: true,
			error: null, dirtyHours: 0, lastSyncedAt: null, now: 0,
		}),
		freshness: "",
		progress: progressLineFor(event, 96),
		innerWidth: 96,
	});
	expect(strip(row)).not.toContain("\n");
	expect(strip(row)).toContain("Ingest 25/100");
});

test("widening the terminal only ever restores chrome, never takes it away", () => {
	const sidebarRank = { hidden: 0, full: 1 } as const;
	const topbarRank = { minimal: 0, condensed: 1, full: 2 } as const;
	let sidebar = -1;
	let topbar = -1;
	for (let width = 1; width <= 200; width++) {
		const policy = framePolicy(width);
		expect(sidebarRank[policy.sidebar], `sidebar w=${width}`).toBeGreaterThanOrEqual(sidebar);
		expect(topbarRank[policy.topbar], `topbar w=${width}`).toBeGreaterThanOrEqual(topbar);
		sidebar = sidebarRank[policy.sidebar];
		topbar = topbarRank[policy.topbar];
	}
});


// ---------------------------------------------------------------------------
// Composed frame at the acceptance widths
// ---------------------------------------------------------------------------

for (const width of [40, 60, 80, 100, 120]) {
	test(`composed frame at ${width}: fills the terminal, rows fit, exactly one divider`, async () => {
		const panel = __testing.makePanel({ data: liveData(), rows: 40 });
		await __testing.settled(panel);
		const plain = panel.render(width).map(strip);
		expect(plain.length, `w=${width} must fill the terminal`).toBe(40);
		for (const row of plain) {
			expect(Bun.stringWidth(row), `w=${width} row=${JSON.stringify(row.slice(0, 60))}`).toBeLessThanOrEqual(
				width,
			);
		}
		expect(plain.filter(row => row.includes("├")).length, `w=${width} dividers`).toBe(1);
		// The single toolbar row is the only route label in chrome.
		expect(plain[1], `w=${width} toolbar`).toContain("Overview");
		expect(plain[1], `w=${width} toolbar`).not.toContain("omp/stats");
	});
}

test("every selectable screen composes within width at 60 and 100", async () => {
	for (const screen of SELECTABLE_SCREENS) {
		for (const width of [60, 100]) {
			const panel = __testing.makePanel({ data: liveData(), rows: 40, screenId: screen.id });
			await __testing.settled(panel);
			const plain = panel.render(width).map(strip);
			expect(plain.length, `${screen.id} w=${width}`).toBeLessThanOrEqual(40);
			for (const row of plain) {
				expect(Bun.stringWidth(row), `${screen.id} w=${width} row=${JSON.stringify(row.slice(0, 60))}`)
					.toBeLessThanOrEqual(width);
			}
			expect(plain.filter(row => row.includes("├")).length, `${screen.id} w=${width} dividers`).toBe(1);
		}
	}
});

test("a tiny terminal still paints an untorn frame", async () => {
	const panel = __testing.makePanel({ data: liveData(), rows: 24 });
	await __testing.settled(panel);
	const plain = panel.render(32).map(strip);
	expect(plain.length).toBeLessThanOrEqual(24);
	for (const row of plain) {
		expect(Bun.stringWidth(row), `row=${JSON.stringify(row.slice(0, 60))}`).toBeLessThanOrEqual(32);
	}
	expect(plain.filter(row => row.includes("├")).length).toBe(1);
});

// ---------------------------------------------------------------------------
// Live resize: recomputed per render, scroll survives a width change
// ---------------------------------------------------------------------------

test("width shrink keeps the view valid: scroll stays legal, rows stay within width", async () => {
	// 12 rows leaves a short body against live data, so there is genuinely
	// something to scroll past.
	const panel = __testing.makePanel({ data: liveData(), rows: 12 });
	await __testing.settled(panel);
	panel.render(120);
	expect(__testing.debugMaxScroll(panel)).toBeGreaterThan(0);
	panel.handleInput(END);
	panel.render(120);
	const scrolled = __testing.debugScroll(panel);
	expect(scrolled).toBe(__testing.debugMaxScroll(panel));
	expect(scrolled).toBeGreaterThan(0);

	// The shrink: same panel, narrower width, no keypress between.
	const narrow = panel.render(40).map(strip);
	expect(__testing.debugScroll(panel), "scroll must survive the shrink legally").toBeLessThanOrEqual(
		__testing.debugMaxScroll(panel),
	);
	expect(narrow.length).toBeLessThanOrEqual(12);
	for (const row of narrow) {
		expect(Bun.stringWidth(row), `row=${JSON.stringify(row.slice(0, 60))}`).toBeLessThanOrEqual(40);
	}
	expect(narrow.filter(row => row.includes("├")).length).toBe(1);
});

test("resize is stateless: wide -> narrow -> wide restores the exact rows", async () => {
	// There is no per-width cache to go stale: the layout is recomputed from the
	// current width on every render, so a round trip must be byte-identical.
	const panel = __testing.makePanel({ data: liveData(), rows: 40 });
	await __testing.settled(panel);
	const first = panel.render(120);
	panel.render(40);
	expect(panel.render(120)).toEqual(first);
});
