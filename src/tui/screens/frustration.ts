/**
 * `src/tui/screens/frustration.ts` — registry identity for the Frustration screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id, labels and fetch contract the nav and panel read.
 */

import type { Screen } from "./types";

export const frustrationScreen: Screen = {
	id: "frustration",
	label: "Frustration",
	short: "Frustr.",
	needs: [],
};
