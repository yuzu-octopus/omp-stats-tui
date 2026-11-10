/**
 * `src/tui/screens/activity.ts` — registry identity for the Activity screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id, labels and fetch contract the nav and panel read.
 *
 * `dailyActivity` is the slow raw-table scan, declared on its own so it fetches
 * independently of the cheap rollup-backed reads; `costs` and `rollupStatus`
 * back the summary and the freshness line.
 */

import type { Screen } from "./types";

export const activityScreen: Screen = {
	id: "activity",
	label: "Activity",
	short: "Activity",
	needs: ["dailyActivity", "costs", "rollupStatus"],
};
