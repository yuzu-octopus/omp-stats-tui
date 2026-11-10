import { expect, test } from "bun:test";
import { describeSyncProgress, type SyncEvent } from "../src/sync/client";

/**
 * The sync indicator: determinate and indeterminate.
 *
 * The errors screen's IR render path is gone (ADR 0007); the production errors
 * body is `FeatureController.render()`. What this file owns is the sync
 * indicator, which is chrome rather than a screen body.
 */

test("determinate sync renders a percentage against the known total", () => {
	const line = describeSyncProgress({ type: "progress", phase: "ingest", current: 25, total: 100 }, 40);
	expect(line).toContain("25%");
	expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});

test("indeterminate sync renders a phase word and no percentage, never NaN", () => {
	// total 0 means the worker reported no denominator (the rollup phase reports
	// only a remaining count). The recommended default is indeterminate here.
	for (const phase of ["scan", "ingest", "rollup"] as const) {
		const event: SyncEvent = { type: "progress", phase, current: 5, total: 0 };
		const line = describeSyncProgress(event, 40);
		expect(line).not.toContain("NaN");
		expect(line).not.toMatch(/\d+%/);
		expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		expect(line.length).toBeGreaterThan(0);
	}
});

test("sync indicator fits the one-row footer budget at every width", () => {
	// The footer is PanelRows.setHeight(1): the indicator must fit inside that row
	// rather than stealing a body row.
	const events: SyncEvent[] = [
		{ type: "progress", phase: "ingest", current: 25, total: 100 },
		{ type: "progress", phase: "rollup", current: 5, total: 0 },
		{ type: "progress", phase: "scan", current: 9999, total: 3 },
	];
	for (const width of [10, 20, 40, 100, 200]) {
		for (const event of events) {
			const line = describeSyncProgress(event, width);
			expect(line.split("\n").length).toBe(1);
			expect(Bun.stringWidth(line), `w=${width}`).toBeLessThanOrEqual(width);
		}
	}
});

test("an over-reporting worker cannot push the bar past 100 or past the width", () => {
	// total smaller than current is corrupt input, not a reason to overflow.
	const event: SyncEvent = { type: "progress", phase: "ingest", current: 9999, total: 3 };
	const line = describeSyncProgress(event, 40);
	expect(line).not.toContain("NaN");
	expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});
