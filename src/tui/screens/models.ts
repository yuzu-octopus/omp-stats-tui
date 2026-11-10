/**
 * `src/tui/screens/models.ts` — registry identity for the Models screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * Row expansion (`ModelDetail` in the route) has no terminal renderer; the
 * production table carries `expandable: true` on its Model column so the
 * contract is declared even though nothing expands it.
 */

import type { Screen } from "./types";

export const modelsScreen: Screen = {
	id: "models",
	label: "Models",
	short: "Models",
};
