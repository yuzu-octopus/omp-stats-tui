/**
 * `src/tui/screens/gain.ts` — registry identity for the Gain screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * Gain is token savings from snapcompact (a jsonl beside the DB), not cache
 * savings: no dollars, no ratio that goes negative, and reductionPercent stays
 * null because original sizes are never recorded.
 */

import type { Screen } from "./types";

export const gainScreen: Screen = {
	id: "gain",
	label: "Gain",
	short: "Gain",
};
