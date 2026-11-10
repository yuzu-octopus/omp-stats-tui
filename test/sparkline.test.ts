import { expect, test } from "bun:test";
import { renderRankedBars, renderShareBar, renderSparkline } from "../src/tui/charts/sparkline";
import { glyphsFor } from "../src/tui/glyphs";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const identity = (t: string) => t;
const U = glyphsFor("unicode");
const A = glyphsFor("ascii");
const ramp = U.sparkRamp as readonly string[];

// ─── Rule 1: zero-baselined against a caller-supplied max, never min-max ──────

test("min-max is impossible: the same max renders different shapes differently", () => {
	// Both series peak at 10. A min-max renderer would stretch each to fill the
	// ramp, so a quiet week would look exactly like a busy one — the opposite of
	// a stats panel's job. Zero-baselined against the shared max of 10, the
	// spiky series must differ from the steady one.
	const spiky = [10, 1, 10, 1, 10, 1];
	const steady = [9, 9, 9, 10, 9, 9];
	const opts = { width: 6, max: 10 };
	expect(renderSparkline(spiky, opts)).not.toBe(renderSparkline(steady, opts));

	// Both reach the top of the ramp at their peak, which is what "shares a
	// maximum" has to mean.
	expect(renderSparkline(spiky, opts)[0]).toBe(ramp[7]);
	expect(renderSparkline(steady, opts)[3]).toBe(ramp[7]);
});

test("an omitted max falls back to the data's own maximum", () => {
	// The convenience case, and still zero-baselined: the peak touches the top.
	const s = renderSparkline([2, 4, 8, 4], { width: 4 });
	// 8/8*7 = 7 → top rung; 2/8*7 = 1.75 → level 2.
	expect(s[2]).toBe(ramp[7]);
	expect(s[0]).toBe(ramp[2]);
});

test("a value at exactly the max is the top rung and never overflows it", () => {
	expect(renderSparkline([10], { width: 1, max: 10 })).toBe(ramp[7]);
	// A value ABOVE the supplied max is clamped, never drawn taller.
	expect(renderSparkline([999], { width: 1, max: 10 })).toBe(ramp[7]);
});

test("an all-zero series emits width cells of level-0, never an empty string", () => {
	const s = renderSparkline([0, 0, 0, 0, 0], { width: 5, max: 100 });
	expect(Bun.stringWidth(s)).toBe(5);
	expect(s).toBe(ramp[0].repeat(5));
});

test("a max of zero does not divide by zero", () => {
	// Padding is blank and measured zero is `ramp[0]`, so these two differ.
	expect(renderSparkline([0, 0], { width: 4, max: 0 })).toBe(`  ${ramp[0]}${ramp[0]}`);
	expect(renderSparkline([5, 5], { width: 4, max: 0 })).toBe(`  ${ramp[0]}${ramp[0]}`);
	// An EMPTY series is all padding, and padding is blank: a cell holding no
	// data must not wear the glyph a measured zero draws.
	expect(renderSparkline([], { width: 4, max: 0 })).toBe("    ");
});

test("a flat series renders identical glyphs, not noise and not empty", () => {
	// Zero-baselined, so a constant non-zero series is a solid low run — and it
	// is IDENTICAL across columns, which is exactly what min-max noise would
	// destroy.
	const s = renderSparkline([7, 7, 7, 7], { width: 4, max: 10 });
	expect(Bun.stringWidth(s)).toBe(4);
	expect(new Set(s.split("")).size).toBe(1);
	expect(s).not.toContain("NaN");
});

test("an empty series still emits width cells", () => {
	// An empty line inside a bordered panel reads as a layout bug.
	expect(Bun.stringWidth(renderSparkline([], { width: 8 }))).toBe(8);
	expect(Bun.stringWidth(renderSparkline([], { width: 1 }))).toBe(1);
});

test("a zero width returns an empty string and does not throw", () => {
	expect(renderSparkline([1, 2, 3], { width: 0 })).toBe("");
	expect(renderSparkline([], { width: 0 })).toBe("");
});

// ─── Rule 3: clip and keep the NEWEST ───────────────────────────────────────

test("narrowing keeps the NEWEST samples, so today stays visible", () => {
	// ratatui keeps the OLDEST `width` points, which on a live panel hides the
	// current day. We clip from the left: the last 5 of 16 values are 12..15,99.
	const series = [...Array.from({ length: 15 }, (_, i) => i + 1), 99];
	const s = renderSparkline(series, { width: 5, max: 100 });
	expect(Bun.stringWidth(s)).toBe(5);
	// The last sample is the peak and must be the rightmost, top-rung glyph.
	expect(s[4]).toBe(ramp[7]);
	// 12 / 100 * 7 = 0.84 → level 1.
	expect(s[0]).toBe(ramp[1]);
});

test("clipping never averages: the last sample survives exactly", () => {
	const series = [50, 50, 50, 50, 50, 50, 50, 50, 50, 7];
	// The last two samples are 50 and 7. Averaging them would produce 28.5 and
	// render a value that was never observed.
	expect(renderSparkline(series, { width: 2, max: 50 })).toBe(`${ramp[7]}${ramp[1]}`);
});

test("a single point anchors RIGHT, so a one-column panel shows now", () => {
	expect(renderSparkline([10], { width: 1, max: 10 })).toBe(ramp[7]);
	// A short series right-aligns too, so "today" is always the rightmost cell.
	// 1 / 10 * 7 = 0.7 → level 1.
	// The two leading cells are PADDING and read as blanks — before the fix they
	// repeated `ramp[0]`, so "no data yet" and "recorded nothing" were one mark.
	expect(renderSparkline([1, 10], { width: 4, max: 10 })).toBe(`  ${ramp[1]}${ramp[7]}`);
});

// ─── Shape, ramp and width ───────────────────────────────────────────────────

test("a sparkline uses only the eighth-block ramp", () => {
	const s = renderSparkline([1, 5, 3, 9, 2, 7], { width: 6, max: 10 });
	expect(Bun.stringWidth(s)).toBe(6);
	for (const ch of s) expect(ramp).toContain(ch);
});

test("every sparkline is within its width, swept 10..200", () => {
	for (let width = 10; width <= 200; width++) {
		for (const values of [[], [0], [5], [1, 2, 3], Array.from({ length: 97 }, (_, i) => (i * 37) % 91)]) {
			const s = renderSparkline(values, { width, max: 91 });
			expect(Bun.stringWidth(s), `width ${width}: ${s}`).toBe(width);
		}
	}
});

test("unicode and nerd render identically; ascii differs but is the same width", () => {
	// Verified, not assumed: the eighth blocks are font-independent, so `nerd`
	// shares the object. The ascii ladder is a ranking ladder, so it must differ.
	const values = [1, 5, 3, 9, 2, 7];
	const opts = { width: 6, max: 10 };
	const u = renderSparkline(values, { ...opts, preset: "unicode" });
	const n = renderSparkline(values, { ...opts, preset: "nerd" });
	const a = renderSparkline(values, { ...opts, preset: "ascii" });
	expect(n).toBe(u);
	expect(a).not.toBe(u);
	expect(Bun.stringWidth(a)).toBe(6);
	expect([...a].every((ch) => (A.sparkRamp as readonly string[]).includes(ch))).toBe(true);
});

// ─── Ranked bar list ─────────────────────────────────────────────────────────

test("a ranked list is one row per entry and every row fits the width", () => {
	const rows = renderRankedBars(
		[
			{ label: "gpt-5.6-terra", value: 935.72 },
			{ label: "deepseek-v4-flash", value: 22.85 },
		],
		{ width: 40, accent: identity },
	);
	expect(rows).toHaveLength(2);
	for (const r of rows) expect(Bun.stringWidth(r)).toBe(40);
});

test("a ranked list sorts descending by value", () => {
	const rows = renderRankedBars(
		[
			{ label: "small", value: 1 },
			{ label: "big", value: 100 },
			{ label: "mid", value: 50 },
		],
		{ width: 40, accent: identity },
	);
	expect(rows[0]).toContain("big");
	expect(rows[1]).toContain("mid");
	expect(rows[2]).toContain("small");
});

test("every ranked row shares ONE divisor, so the bars are directly comparable", () => {
	// The longest bar belongs to the largest row, and a row at half the max is
	// about half the track. Because maxShown is the largest row in the SHOWN
	// set, no axis or legend is needed for the list to be readable.
	const rows = renderRankedBars(
		[
			{ label: "half", value: 50 },
			{ label: "full", value: 100 },
		],
		{ width: 60, accent: identity },
	);
	const filled = (row: string) => [...row].filter((c) => c === U.barFill).length;
	// Sorted descending, so rows[0] ("full", 100) carries the longest bar and
	// rows[1] ("half", 50) about half the track — both measured against the
	// SAME divisor, which is the whole point.
	expect(filled(rows[1] as string)).toBeLessThan(filled(rows[0] as string));
});

test("a zero-valued row emits a VISIBLE cell, so it reads as measured-zero", () => {
	// Rule 4. A row that rendered nothing would be indistinguishable from a row
	// the query never returned.
	const rows = renderRankedBars([{ label: "quiet-model", value: 0 }], {
		width: 40,
		accent: identity,
	});
	expect(rows).toHaveLength(1);
	expect(Bun.stringWidth(rows[0] as string)).toBe(40);
	expect(rows[0]).toContain("quiet-model");
});

test("an unpriced row renders as N/A with its count, never as a free $0.00", () => {
	// Review Focus line 1's second half: a $0.00 model whose spend could not be
	// measured must not read as free. costWithUnpriced owns that rule; this test
	// exists so a caller cannot bypass it by formatting inline.
	const rows = renderRankedBars([{ label: "muse-spark-free", value: 0, unpriced: 55 }], {
		width: 48,
		accent: identity,
	});
	expect(rows[0]).toContain("N/A");
	expect(rows[0]).toContain("55 unpriced");
	expect(rows[0]).not.toContain("$0.00");
});

test("a row's display value can be supplied and overrides the default", () => {
	const rows = renderRankedBars([{ label: "x", value: 5, display: "custom" }], {
		width: 40,
		accent: identity,
	});
	expect(rows[0]).toContain("custom");
});

test("an all-zero ranked list does not divide by zero", () => {
	const rows = renderRankedBars(
		[
			{ label: "a", value: 0 },
			{ label: "b", value: 0 },
		],
		{ width: 40, accent: identity },
	);
	expect(rows).toHaveLength(2);
	for (const r of rows) expect(Bun.stringWidth(r)).toBe(40);
});

test("an empty ranked list returns [], the one case where an empty line is right", () => {
	expect(renderRankedBars([], { width: 40, accent: identity })).toEqual([]);
});

test("every ranked row FITS its width, swept 10..200, with long labels", () => {
	// "Fits", not "fills": a ranked row is a label, a bar and a figure, and the
	// bar is now BOUNDED (`BAR_TRACK_MAX`) and the label is dropped rather than
	// squeezed when the row is too narrow for all three. So a row may be SHORTER
	// than the width — which is the fix for the reported solid block, not a
	// regression. It may never be LONGER.
	for (let width = 10; width <= 200; width++) {
		const rows = renderRankedBars(
			[
				{ label: "a-very-long-model-identifier-that-overflows-the-column", value: 935.72 },
				{ label: "short", value: 0 },
				{ label: "gpt-5.6-sol", value: 1292.85 },
			],
			{ width, accent: identity },
		);
		for (const r of rows) expect(visibleWidth(r), `width ${width}: ${r}`).toBeLessThanOrEqual(width);
	}
});

test("a ranked row's bar is bounded, so a wide panel leaves whitespace rather than a block", () => {
	// The BOUND in action: at width 60 the bar stops at `BAR_TRACK_MAX` (48) and
	// the row comes out narrower than the panel. That is the fix for the reported
	// solid block — a bar you cannot see past is a background, not a measurement —
	// and the leftover width is whitespace, which is honest.
	const rows = renderRankedBars(
		[
			{ label: "alpha", value: 10 },
			{ label: "beta", value: 5 },
		],
		{ width: 60, accent: identity },
	);
	for (const row of rows) {
		expect(visibleWidth(row), row).toBeLessThanOrEqual(60);
		// But every row is the SAME width, so the figures still align down the
		// column — that is what makes the list scannable.
		expect(visibleWidth(row), row).toBe(visibleWidth(rows[0] as string));
	}
});

// ─── Share bar ───────────────────────────────────────────────────────────────

test("a share bar is exactly width cells", () => {
	const bar = renderShareBar(0.75, { width: 40, accent: identity }, "75.0% cache");
	expect(Bun.stringWidth(bar)).toBe(40);
});

test("the readout is rendered FIRST, and the bar takes the remainder", () => {
	// Transcribed from Charm's bubbles progress.ViewAs: measure the number, give
	// the track whatever is left. At narrow widths the number wins.
	const bar = renderShareBar(1, { width: 20, accent: identity }, "100%");
	expect(bar.endsWith("100%")).toBe(true);
	expect(Bun.stringWidth(bar)).toBe(20);
	// 20 - 4 (readout) - 1 (gap) = 15 cells of track, all filled at share 1.
	expect([...bar].filter((c) => c === U.barFill).length).toBe(15);
});

test("a share over 1 clamps to full instead of overflowing", () => {
	const bar = renderShareBar(1.5, { width: 20, accent: identity }, "150%");
	expect(Bun.stringWidth(bar)).toBe(20);
	expect([...bar].filter((c) => c === U.barFill).length).toBe(15);
});

test("a zero share is an all-empty track, never a division by zero", () => {
	// width 20 − readout "0%" (2) − gap (1) = 17 track cells, and every one of
	// them is BLANK: the web omits a zero segment outright (`ShareBar.tsx:15`)
	// rather than filling its slot with a shade block.
	const bar = renderShareBar(0, { width: 20, accent: identity }, "0%");
	expect(Bun.stringWidth(bar)).toBe(20);
	expect([...bar].filter((c) => c === U.barFill).length).toBe(0);
	expect([...bar].filter((c) => c !== " " && c !== "0" && c !== "%").length).toBe(0);
});

test("the bar disappears at narrow widths and the readout is truncated to the row", () => {
	// track === 0: the number wins and the bar yields. The readout is 5 cells
	// in a 4-cell row, so the fact is clipped to the row rather than printed
	// whole — an over-wide line corrupts the panel around it, which is the one
	// thing a chart line must never do.
	const bar = renderShareBar(0.5, { width: 4, accent: identity }, "50.0%");
	expect(Bun.stringWidth(bar)).toBe(4);
	expect(bar).toBe("50.…");
});

test("a share bar never overflows, even when the readout is longer than the width", () => {
	for (const width of [1, 2, 4, 6, 10, 20, 40]) {
		for (const readout of ["", "5", "50.0%", "a-very-long-readout-indeed"]) {
			const bar = renderShareBar(0.5, { width, accent: identity }, readout);
			expect(Bun.stringWidth(bar), `width ${width} readout ${readout}`).toBeLessThanOrEqual(width);
		}
	}
});

test("a share bar is exactly width cells for a fitting readout, swept 10..200", () => {
	for (let width = 10; width <= 200; width++) {
		const bar = renderShareBar(0.37, { width, accent: identity }, "37%");
		expect(Bun.stringWidth(bar), `width ${width}`).toBe(width);
	}
});

test("an empty readout leaves the whole width for the bar", () => {
	const bar = renderShareBar(0.5, { width: 10, accent: identity }, "");
	expect(Bun.stringWidth(bar)).toBe(10);
	expect([...bar].filter((c) => c === U.barFill).length).toBe(5);
});

test("the share bar's glyphs come from the glyph module, under every preset", () => {
	for (const preset of ["unicode", "ascii"] as const) {
		const bar = renderShareBar(0.5, { width: 20, preset, accent: identity }, "50%");
		const set = glyphsFor(preset);
		for (const ch of [...bar]) {
			expect([set.barFill, set.barEmpty, ...bar.split("")]).toContain(ch);
		}
		// ascii must differ from unicode and still be exactly 20 cells.
		expect(Bun.stringWidth(bar)).toBe(20);
	}
	expect(renderShareBar(0.5, { width: 20, preset: "nerd", accent: identity }, "50%")).toBe(
		renderShareBar(0.5, { width: 20, preset: "unicode", accent: identity }, "50%"),
	);
});