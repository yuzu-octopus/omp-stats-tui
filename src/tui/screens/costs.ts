/**
 * `src/tui/screens/costs.ts` — registry identity for the Costs screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id, labels and fetch contract the nav and panel read.
 */

import type { Screen } from "./types";

export const costsScreen: Screen = {
	id: "costs",
	label: "Costs",
	short: "Costs",
	needs: ["costs", "rollupStatus"],
};
