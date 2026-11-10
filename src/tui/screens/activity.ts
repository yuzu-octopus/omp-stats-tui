/**
 * `src/tui/screens/activity.ts` — registry identity for the Activity screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 */

import type { Screen } from "./types";

export const activityScreen: Screen = {
	id: "activity",
	label: "Activity",
	short: "Activity",
};
