/**
 * `src/tui/screens/overview.ts` — registry identity for the Overview screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * `recent` is a fixed-size list of the latest requests, not a window: the route
 * takes a limit rather than a range, so the screen's heading must not claim the
 * range covers it.
 */

import type { Screen } from "./types";

export const overviewScreen: Screen = {
	id: "overview",
	label: "Overview",
	short: "Overview",
};
