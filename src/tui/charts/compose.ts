/**
 * `src/tui/charts/compose.ts` — the band allocator for multi-series bar charts.
 *
 * WHY THIS FILE IS AN ALLOCATOR AND NOT A RENDERER. Charts in this panel broke
 * four times in one session, always the same way: a working single-series
 * renderer existed, and someone wrote a NEW multi-series rendering path beside
 * it. The result looked like `░█░░░░█░░░░█░░░█░░░█░░░░` — one glyph per sample,
 * series interleaved, no reader able to say which series any column belonged to.
 * It did not throw, and it passed its own tests, because it was internally
 * consistent and nobody compared it to the primitive it should have been built
 * from.
 *
 * So this module has no geometry of its own. It answers two questions the band
 * renderer in `host-adapter.ts` cannot answer for itself: how many rows each
 * series gets (`bandHeights`) and the single scale every band draws against
 * (`bandMax`, the web's `leftMax` in `Chart.tsx:98`). The marks come out of
 * `renderDailyBars`, called once per series by the host pipeline.
 *
 * ── THE COMPOSITION MODEL, AND WHY ──────────────────────────────────────────
 *
 * The web stacks its series INSIDE one column, in one row-set, against one
 * shared y-scale: `charts/Chart.tsx:83-97` accumulates a stack base per series
 * and a running top across slots, and `stacked` defaults to `true`. Two series
 * are one column of two colours, so the reader compares heights within a column.
 *
 * A terminal cell holds one glyph, so a column cannot carry two stacked values
 * legibly — that is exactly what the broken `░█░█░█` output was attempting, and
 * it is why it read as noise. The faithful translation is to give each series its
 * OWN BAND of rows, vertically, and to preserve the one property the web's
 * stacking actually communicates: a SINGLE SCALE across all series.
 *
 * That last part is load-bearing. Simply calling `renderDailyBars` per series at
 * equal heights is still wrong, because each primitive call scales against its
 * OWN maximum: Succeeded (peak 44) and Failed (peak 4) would each fill its band
 * and the failure rate would read as 100%. So a series' band is sized by its
 * peak RELATIVE to the maximum across all series, and
 * `renderDailyBars` then fills exactly those rows. Magnitude therefore reads
 * across series the way column height reads within one.
 *
 * Rows that do not divide evenly go to NOBODY: a 5-row budget across 3 series is
 * 1 row each, and handing the remainder to the last series would make its
 * apparent magnitude a function of its position in the list.
 *
 * ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
 *
 * No glyph or colour literal: hues come from `resolveSeries`, geometry from the
 * primitives. And no new scale axis — series values are whatever the payload
 * supplies (COSTS, request counts), and the cost invariant belongs to the
 * primitives. See the 41x price spread note in `bars.ts`, and the tests proving
 * the dearer model draws the taller bar.
 */

/** One series' values. Gaps are `0`: a day with no spend is a zero, not a hole. */
export interface SeriesChartSeries {
	/** The series' name, from the route or the IR. Labels the band. */
	label: string;
	/** One value per bucket, oldest first. The same axis for every series. */
	values: readonly number[];
}

/**
 * Rows each series gets, from the whole chart's row budget.
 *
 * A series peaking at a tenth of the loudest gets a tenth of the rows, so band
 * height carries magnitude ACROSS series. That is only half the rule, and the
 * half that was missing is what made the two bands look identical: with peak
 * share alone, a 4%-failure band got one row and then FILLED it, because the
 * primitive inside the band re-scaled against that band's OWN peak. The
 * allocation said the quiet series was quiet and the geometry said it was not,
 * and the geometry is what a reader sees.
 *
 * So the allocation stays AND {@link bandMax} is passed to every band as `max`
 * beside it. Together they reproduce the web's single y-axis
 * (`Chart.tsx:83-98`, where `leftMax` is the maximum over every stackable
 * series): the ROW COUNT carries the cross-series magnitude, and the maximum
 * stops a band over-filling the rows it was handed.
 *
 * The floor of 1 is the same one-cell minimum the renderer's `meterCell`
 * applies: a series that recorded something must not vanish, or "it drew
 * nothing" and "it recorded nothing" become indistinguishable.
 *
 * Rows that do not divide evenly go to NOBODY. Handing the remainder to the
 * last series would make its apparent magnitude a function of its position in
 * the list, which is exactly the kind of quiet lie a chart must not tell.
 *
 * EXPORTED so the composition tests can build the exact expected band for each
 * series. That is deliberate: a test that reimplemented this arithmetic would be
 * a second copy of the rule, and it would agree with a wrong implementation
 * just as readily as with a right one.
 */
export function bandHeights(peaks: readonly number[], budget: number): readonly number[] {
	const count = peaks.length;
	if (count === 0 || budget <= 0) return peaks.map(() => 0);

	// `budget` is the WHOLE chart's row budget, not a per-series allowance: the
	// rows of one band are taken from the same pool as the rows of every other,
	// which is the only way band height can carry magnitude ACROSS series. It
	// used to be an even per-band slice that this function then scaled by peak
	// share, so a band could never claim a row another band was not using — and
	// at four series that slice is two rows, which is too few to tell 16x apart.
	//
	// A BAND'S ROWS ARE ITS MAGNITUDE PLUS ITS FLOOR, and the floor is now
	// mandatory for every band at every height (see `compose`). So a band that
	// RECORDED something needs TWO rows to be a chart at all — one row of ink and
	// the baseline under it — while a band that recorded NOTHING needs exactly
	// ONE, which is its floor and its only ink.
	//
	// Handing both to one row each is what produced the defect: a live band
	// allocated a single row drew its ink with no baseline under it, and an
	// all-zero band allocated a single row drew an empty row that read as the
	// padding between two cards. Both were "the band is there" and neither looked
	// like a chart.
	const loudest = peaks
		.map((peak, index) => ({ index, peak }))
		.sort((a, b) => b.peak - a.peak || a.index - b.index);
	// PASS ONE — EVERY band gets its floor. Not "as many as fit": all of them.
	//
	// A band with no rows draws nothing at all — no floor, no ink, not even the
	// label — so a series the chart declares and then silently omits is
	// indistinguishable from one that was never declared at all. That is the one
	// claim a chart must never make by omission, and it is exactly what happened
	// when the budget was smaller than the series count: the tail bands were left
	// with nothing, and the all-zero series — being last, being quietest — was
	// always among them.
	//
	// So every band is guaranteed its floor row even when the budget is short, and
	// the chart gives up the OVERFLOW instead: the band renderer clamps the total
	// to the height it was given rather than letting bands claim rows past it.
	// A chart too short to hold every band shows the loudest ones in full and the
	// quietest as a bare baseline, which reads as "recorded, no room to show it" —
	// an honest reading — rather than as a series that stopped existing.
	const rows = new Array<number>(count).fill(1);
	let left = Math.max(0, budget - count);
	// PASS TWO — a band that RECORDED something is upgraded to two rows, so it has
	// one row of ink standing on its floor and is a chart rather than a bare
	// baseline. Loudest first again: when the budget cannot upgrade every live
	// band, the ones that keep their ink are the ones that recorded the most.
	for (const { index, peak } of loudest) {
		if (left <= 0 || peak <= 0) continue;
		rows[index] = 2;
		left -= 1;
	}

	// WHAT IS LEFT OVER IS APPORTIONED BY PEAK SHARE, one row at a time, to
	// whichever band is furthest below its share — the highest-averages method.
	// Handing the remainder to the LAST series would make its apparent magnitude a
	// function of its position in the list, which is exactly the kind of quiet lie
	// a chart must not tell; and splitting it by `round(share)` alone overspends
	// the budget, since every band's rounding error points the same way.
	//
	// Rows that no band can claim — an all-zero chart, where the series count has
	// taken the budget and there is no magnitude to divide — go to NOBODY.
	for (let spare = left; spare > 0; spare--) {
		let best = -1;
		let furthest = Number.POSITIVE_INFINITY;
		for (let index = 0; index < count; index++) {
			if (peaks[index]! <= 0) continue;
			const below = rows[index]! / peaks[index]!;
			if (below >= furthest) continue;
			furthest = below;
			best = index;
		}
		if (best < 0) break;
		rows[best] = (rows[best] ?? 0) + 1;
	}
	return rows;
}

/**
 * The maximum a multi-series chart scales EVERY band against.
 *
 * The peak across all series — `leftMax` in the web's layout pass
 * (`Chart.tsx:98`). Exported because a test asserting a band's geometry has to
 * know the divisor, and re-deriving it in the test would be a second copy of the
 * rule.
 */
export function bandMax(series: readonly SeriesChartSeries[]): number {
	return series.reduce(
		(shared, entry) => entry.values.reduce((peak, value) => (value > peak ? value : peak), shared),
		0,
	);
}