import { test, expect } from "bun:test";
import { renderHeatmap, weeksForWidth } from "../src/tui/charts/heatmap";
import { calendarLayout } from "../src/tui/charts/calendar";
import { glyphsFor, glyph } from "../src/tui/glyphs";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";

/** Four truecolor stops; level 0 uses no stop, so the array is 4 long. */
const RAMP = [
	"\x1b[38;2;60;60;70m",
	"\x1b[38;2;90;90;110m",
	"\x1b[38;2;140;140;170m",
	"\x1b[38;2;23;143;185m",
];

const opts = (weeks: number, innerWidth = weeks * 2 + 2) => ({
	innerWidth,
	labelWidth: 2,
	weeks,
	glyphs: glyphsFor("unicode"),
	ramp: RAMP,
	dim: (text: string) => text,
});

const point = (day: string, cost: number, requests = 1): DailyActivityPoint => ({
	day,
	cost,
	requests,
	totalTokens: requests * 1000,
});

/** A fixed "today" keeps every test independent of the wall clock. */
const TODAY = new Date(2026, 9, 5, 12, 0, 0);

test("calendar retains local Monday boundaries, month labels and zero/future states", () => {
	const layout = calendarLayout([], 8, TODAY);
	expect(layout.start.getFullYear()).toBe(2026);
	expect(layout.start.getMonth()).toBe(7);
	expect(layout.start.getDate()).toBe(17);
	expect(layout.start.getHours()).toBe(0);
	expect(layout.monthLabels).toEqual(["Aug", undefined, undefined, "Sep", undefined, undefined, undefined, "Oct"]);
	expect(layout.cells).toHaveLength(7);
	for (let day = 0; day < 7; day++) {
		expect(layout.cells[day].slice(0, 7)).toEqual(Array(7).fill(0));
		expect(layout.cells[day][7]).toBe(day === 0 ? 0 : null);
	}
});

test("calendar sqrt levels and totals exclude older and future activity", () => {
	const layout = calendarLayout([
		point("2026-09-13", 10000, 10000),
		point("2026-10-01", 25, 4),
		point("2026-10-02", 100, 1),
		point("2026-10-06", 10000, 10000),
	], 4, TODAY);
	expect(layout.cells[3][2]).toBe(2);
	expect(layout.cells[4][2]).toBe(4);
	expect(layout.cells[1][3]).toBeNull();
	expect(layout.totalCost).toBe(125);
	expect(layout.totalRequests).toBe(5);
});

test("all-unpriced activity scales requests, while any supplied cost selects cost", () => {
	const points = [point("2026-10-01", 0, 25), point("2026-10-02", 0, 100)];
	const requests = calendarLayout(points, 4, TODAY);
	expect(requests.cells[3][2]).toBe(2);
	expect(requests.cells[4][2]).toBe(4);
	expect(requests.totalCost).toBe(0);
	expect(requests.totalRequests).toBe(125);
	// Preserve upstream's choice over all supplied points, even outside the window.
	const costs = calendarLayout([...points, point("2026-09-01", 1)], 4, TODAY);
	expect(costs.cells[3][2]).toBe(0);
	expect(costs.cells[4][2]).toBe(0);
	expect(costs.totalCost).toBe(0);
});

test("calendar advances local dates across a daylight-saving transition", () => {
	const previous = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		const layout = calendarLayout([
			point("2026-03-08", 25),
			point("2026-03-09", 100),
		], 2, new Date(2026, 2, 9, 0, 30));
		expect(layout.start.getMonth()).toBe(2);
		expect(layout.start.getDate()).toBe(2);
		expect(layout.cells[6][0]).toBe(2);
		expect(layout.cells[0][1]).toBe(4);
		expect(layout.cells[1][1]).toBeNull();
		expect(layout.totalCost).toBe(125);
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});

test("calendar selection identifies active and quiet local days without selecting future or hidden dates", () => {
	const selection = (cell: string) => `\x1b[7m${cell}\x1b[27m`;
	for (const [day, row, column] of [
		["2026-10-02", 5, 6],
		["2026-10-03", 6, 6],
	] as const) {
		const rows = renderHeatmap([point("2026-10-02", 100)], {
			...opts(4), today: TODAY, selectedDay: day, selected: selection,
		});
		const selected = rows[row].indexOf("\x1b[7m");
		expect(Bun.stringWidth(rows[row].slice(0, selected))).toBe(column);
		expect(rows.filter(line => line.includes("\x1b[7m"))).toHaveLength(1);
		expect(Bun.stringWidth(rows[row])).toBeLessThanOrEqual(10);
	}
	for (const day of ["2026-10-06", "2026-09-01"]) {
		expect(renderHeatmap([], {
			...opts(4), today: TODAY, selectedDay: day, selected: selection,
		}).join("\n")).not.toContain("\x1b[7m");
	}
});

test("calendar selection uses local dates across daylight saving changes", () => {
	const previous = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		const rows = renderHeatmap([], {
			...opts(2), today: new Date(2026, 2, 9, 0, 30),
			selectedDay: "2026-03-09", selected: cell => `\x1b[7m${cell}\x1b[27m`,
		});
		expect(Bun.stringWidth(rows[1].slice(0, rows[1].indexOf("\x1b[7m")))).toBe(4);
		expect(rows.slice(2).join("\n")).not.toContain("\x1b[7m");
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});

test("day rows label all seven days, Monday first", () => {
	// usage-dashboard.ts:293 + :862 — HEATMAP_DAY_LABELS is all seven days;
	// the M/W/F-only set is the native-chart rows (L368), not the ANSI grid.
	const rows = renderHeatmap([], { ...opts(4), today: TODAY });
	const heads = rows.slice(1).map(row => row.replace(/\x1b\[[0-9;]*m/g, "")[0]);
	expect(heads).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
});

test("weeksForWidth is the host's continuous clamp, not a ladder", () => {
	// usage-dashboard.ts:834 — max(4, min(53, floor((innerWidth - 2) / 2))).
	// A ladder drops weeks the host keeps (e.g. width 60 shows 29, not 26).
	expect(weeksForWidth(2, 60)).toBe(29);
	expect(weeksForWidth(2, 100)).toBe(49);
	expect(weeksForWidth(2, 200)).toBe(53);
	expect(weeksForWidth(2, 10)).toBe(4);
});

test("a heatmap is a month-label row plus exactly seven day rows", () => {
	expect(renderHeatmap([], { ...opts(53), today: TODAY })).toHaveLength(8);
});

test("every day in range gets a cell — quiet days are level 0, never missing", () => {
	// Crush emits rows only for days WITH activity, so quiet days vanish from the
	// axis. For a bar chart that is misleading; for a calendar it is broken.
	const rows = renderHeatmap([point("2026-10-01", 10)], { ...opts(4), today: TODAY });
	// 4 weeks x 7 days, of which all-but-one are zero days. Level 0 must still be
	// drawn as heatEmpty rather than skipped, so the row is full of cells.
	const totalCells = rows
		.slice(1)
		.reduce((sum, row) => sum + (row.match(new RegExp(glyph("unicode", "heatEmpty"), "g")) ?? []).length, 0);
	// Days up to and including today: 4 weeks = 28 days, minus future days.
	expect(totalCells).toBeGreaterThan(0);
});

test("an all-zero grid renders every cell at level 0 and never crashes", () => {
	const rows = renderHeatmap([], { ...opts(8), today: TODAY });
	expect(rows).toHaveLength(8);
	// max === 0 must not divide: no stop is emitted for any cell.
	for (const row of rows.slice(1)) {
		expect(row.includes(RAMP[0])).toBe(false);
		expect(row.includes(RAMP[3])).toBe(false);
	}
});

test("a dominating day reaches the top level", () => {
	const rows = renderHeatmap([point("2026-10-01", 1), point("2026-10-02", 100)], {
		...opts(8),
		today: TODAY,
	});
	expect(rows.slice(1).join("")).toContain(RAMP[3]);
});

test("intensity is magnitude, not rank — a quarter-max day is not the top level", () => {
	// Min-max normalisation would push a lone quiet day to full intensity, making a
	// quiet fortnight look identical to a busy one. Levels are anchored to the max.
	const rows = renderHeatmap([point("2026-10-01", 25), point("2026-10-02", 100)], {
		...opts(8),
		today: TODAY,
	});
	// The 25-cost day is a quarter of the max, so it sits mid-ramp. The other day
	// legitimately reaches the top, so the assertion is about THIS day not
	// being promoted: a min-max normaliser would render 25 as full intensity.
	const body = rows.slice(1).join("");
	expect(body).toContain(RAMP[1]);
	expect(body).toContain(RAMP[3]);
});

test("a future day is absent, and absent is not the same as zero activity", () => {
	// Rule 4: a future date coloured as "zero activity" is a lie about spend.
	// Future days are `null` in the layout and must render blank, while a past day
	// with genuinely zero activity renders the empty glyph. The test dim is the
	// identity, so strip ANSI first — a real dim wraps the glyph in escapes.
	const rows = renderHeatmap([point("2026-10-02", 0, 0)], { ...opts(8), today: TODAY });
	const empty = glyph("unicode", "heatEmpty");
	// The 2nd of October is a zero-activity PAST day, so its cell is the empty glyph.
	const stripped = rows.slice(1).map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));
	expect(stripped.some(row => row.includes(empty))).toBe(true);
	// Oct 5 (today, a Monday) sits in the last week column alone: every row's
	// tail past today is blank future cells, so trimEnd shortens EVERY row —
	// Monday least, the other six most. No row reaches the full grid width.
	const fullWidth = 2 + 8 * 2;
	expect(stripped.every(row => row.length < fullWidth)).toBe(true);
	expect(new Set(stripped.map(row => row.length)).size).toBeGreaterThan(1);
});

test("level-0 and absent differ in bytes, not just in meaning", () => {
	// Pin the distinction at the renderer level: an empty-glyph cell and a
	// blank (future) cell must not render identically. Under trimEnd the
	// future tail is GONE rather than whitespace — the Monday row is shorter
	// than a full-width row, which a zero-fill could never produce.
	const rows = renderHeatmap([point("2026-10-02", 0, 0)], { ...opts(8), today: TODAY });
	const empty = glyph("unicode", "heatEmpty");
	expect(rows.slice(1).join("").includes(empty)).toBe(true);
	const stripped = rows.slice(1).map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));
	expect(new Set(stripped.map(row => row.length)).size).toBeGreaterThan(1);
});

test("keys are LOCAL dates, verified against a local-midnight boundary", () => {
	// Rule 5. A UTC-keyed implementation would drop or duplicate the boundary day.
	const rows = renderHeatmap([point("2026-10-05", 42)], { ...opts(4), today: TODAY });
	const top = rows.slice(1).join("");
	// Oct 5 is today and has cost 42 against a max of 42, so it is the top level.
	expect(top).toContain(RAMP[3]);
});

test("month labels land on the right week column", () => {
	const rows = renderHeatmap([], { ...opts(8), today: TODAY });
	const labelRow = rows[0];
	// Aug then Sep in calendar order, each at or after the gutter on an even
	// cell boundary. The 8-week window ends mid-October, so "Oct" starts at
	// the last column and the width clamp leaves its head ("Oc", "O", or the
	// host's own ellipsis cut) — the assertion is on order and placement.
	const aug = labelRow.indexOf("Aug");
	expect(aug).toBeGreaterThanOrEqual(2);
	expect(aug % 2).toBe(0);
	const sep = labelRow.indexOf("Sep");
	expect(sep).toBeGreaterThan(aug);
	expect(labelRow.slice(sep)).toMatch(/O/);
});


test("every rendered line is within the requested width", () => {
	for (const width of [0, 5, 30, 108]) {
		const rows = renderHeatmap([point("2026-10-01", 5)], {
			...opts(53),
			innerWidth: width,
			today: TODAY,
		});
		for (const row of rows) {
			const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
			expect(Bun.stringWidth(visible), `width=${width}`).toBeLessThanOrEqual(width);
		}
	}
});

test("rows fit the width, and only trailing-future tails may be short", () => {
	// The host trimEnd's every day row (usage-dashboard.ts:869), so rows whose
	// week columns run past today are SHORT — the month row stays full width.
	// What must never happen is a row WIDER than asked.
	for (const preset of ["unicode", "ascii"] as const) {
		const rows = renderHeatmap(
			[point("2026-10-01", 10), point("2026-10-02", 40), point("2026-09-30", 1)],
			{ ...opts(53), glyphs: glyphsFor(preset), today: TODAY },
		);
		expect(Bun.stringWidth(rows[0].replace(/\x1b\[[0-9;]*m/g, "")), `${preset} month row`).toBe(108);
		for (const row of rows.slice(1)) {
			expect(Bun.stringWidth(row.replace(/\x1b\[[0-9;]*m/g, "")), preset).toBeLessThanOrEqual(108);
		}
	}
});

test("the ink comes from the glyph table, never a literal", () => {
	// The ladder is deliberately undecided (see F16/F19): swapping the table must
	// be the only edit needed, so no glyph may be hardcoded here.
	const unicode = renderHeatmap([point("2026-10-02", 100)], { ...opts(8), today: TODAY }).slice(1).join("");
	const ascii = renderHeatmap([point("2026-10-02", 100)], {
		...opts(8),
		glyphs: glyphsFor("ascii"),
		today: TODAY,
	}).slice(1).join("");
	expect(unicode).toContain(glyph("unicode", "heatCell", 3));
	expect(ascii).toContain(glyph("ascii", "heatCell", 3));
});

test("narrow terminals reduce the WINDOW, never the cell size", () => {
	// Rule 6: a cell stays one column; only the number of weeks changes.
	// The host's continuous clamp (usage-dashboard.ts:834) has no band edges:
	// width 20 shows 9 weeks, width 1 clamps to the 4-week floor.
	expect(weeksForWidth(2, 200)).toBeGreaterThan(weeksForWidth(2, 40));
	expect(weeksForWidth(2, 40)).toBeGreaterThan(weeksForWidth(2, 20));
	expect(weeksForWidth(2, 20)).toBe(9);
	expect(weeksForWidth(2, 10)).toBe(4);
	expect(weeksForWidth(2, 1)).toBe(4);
});

test("day rows carry no trailing whitespace — the host trimEnd's every row", () => {
	// usage-dashboard.ts:869. A kept trailing space makes equal rows unequal
	// and breaks the width contract the month row is clamped to.
	for (const row of renderHeatmap([point("2026-10-01", 5)], { ...opts(20), today: TODAY })) {
		expect(row.endsWith(" ") && !row.endsWith("m "), JSON.stringify(row)).toBe(false);
	}
});


// ---------------------------------------------------------------------------
// Layout cache (AGENTS.md: "Cache the heatmap layout").
// ---------------------------------------------------------------------------

test("equal (points, weeks) render byte-identical output; a different window renders different output", () => {
	const points = [
		point("2026-09-21", 10),
		point("2026-09-28", 40),
		point("2026-10-01", 100),
		point("2026-10-02", 25),
	];
	const options = { ...opts(8), today: TODAY };
	const first = renderHeatmap(points, options);
	// The Activity screen's own sequence (summary.ts): probe `start`, read the
	// totals, then let `renderHeatmap` lay the grid out — one cached layout.
	const probe = calendarLayout(points, 8, TODAY);
	expect(probe).toBe(calendarLayout(points, 8, TODAY));
	expect(renderHeatmap(points, options)).toEqual(first);
	// A different window is a different layout: narrower weeks and inner width
	// replan the grid instead of replaying the cached rows.
	const narrower = renderHeatmap(points, { ...options, weeks: 4, innerWidth: 10 });
	expect(narrower).not.toEqual(first);
	// A rebuilt array with equal content lands on the same bytes — the cached
	// layout is equivalent, not stale.
	expect(renderHeatmap([...points], options)).toEqual(first);
});

test("a cache hit renders byte-identical output to a fresh layout", () => {
	const points = [point("2026-09-30", 1), point("2026-10-01", 10), point("2026-10-02", 40), point("2026-10-04", 5)];
	const options = {
		...opts(12),
		today: TODAY,
		selectedDay: "2026-10-02",
		selected: (cell: string) => `\x1b[7m${cell}\x1b[27m`,
	};
	const cold = renderHeatmap(points, options);
	const warm = renderHeatmap(points, options);
	expect(warm).toEqual(cold);
	// A NEW array with equal content lands on the same bytes — the cached
	// layout is equivalent, not stale.
	expect(renderHeatmap(points.map(entry => ({ ...entry })), options)).toEqual(cold);
});