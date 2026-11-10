/**
 * `src/tui/screens/traces.ts` — registry identity for the Traces screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 */

import type { Screen } from "./types";

export const tracesScreen: Screen = {
	id: "traces",
	label: "Traces",
	short: "Traces",
};
