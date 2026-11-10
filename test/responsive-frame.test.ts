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
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";

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

test("chrome modes per band, pinned for the chrome to build against", () => {
	expect(framePolicy(120)).toMatchObject({
		band: "wide",
		sidebar: "full",
		topbar: "full",
		columns: 2,
		footerHints: true,
	});
	expect(framePolicy(100)).toMatchObject({ band: "wide", sidebar: "full", topbar: "full" });
	expect(framePolicy(84)).toMatchObject({ band: "wide", sidebar: "full" });
	expect(framePolicy(83)).toMatchObject({ band: "medium", sidebar: "hidden", topbar: "condensed" });
	expect(framePolicy(60)).toMatchObject({
		band: "medium",
		sidebar: "hidden",
		topbar: "condensed",
		columns: 1,
		footerHints: true,
	});
	expect(framePolicy(48)).toMatchObject({ band: "medium", sidebar: "hidden" });
	expect(framePolicy(47)).toMatchObject({ band: "narrow", sidebar: "hidden", topbar: "condensed" });
	expect(framePolicy(40)).toMatchObject({
		band: "narrow",
		sidebar: "hidden",
		topbar: "condensed",
		columns: 1,
		footerHints: true,
	});
	expect(framePolicy(34)).toMatchObject({ band: "narrow", sidebar: "hidden" });
	expect(framePolicy(33)).toMatchObject({
		band: "tiny",
		sidebar: "hidden",
		topbar: "minimal",
		columns: 1,
		footerHints: false,
	});
});

test("the policy never disagrees with planLayout about the fields they share", () => {
	// The no-second-convention test: bands, columns, footer hints and the narrow
	// flag come from layout.ts's table, so a retune there flows through here.
	for (let width = 1; width <= 200; width++) {
		const plan = planLayout(width, 40, "unicode");
		const policy = framePolicy(width);
		expect(policy.band, `w=${width}`).toBe(plan.breakpoint);
		expect(policy.columns, `w=${width}`).toBe(plan.columns);
		expect(policy.footerHints, `w=${width}`).toBe(plan.showFooterHints);
		expect(policy.tooNarrow, `w=${width}`).toBe(plan.tooNarrow);
	}
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

test("framePolicy never throws, whatever the terminal reports", () => {
	for (const bad of [-100, -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => framePolicy(bad)).not.toThrow();
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
