/**
 * `src/tui/screens/tools.ts` — registry identity for the Tools screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * Per-tool token and cost figures are SHARES of the assistant turn that asked
 * for them, not measurements of each call, so this screen ranks calls and never
 * prints a per-call cost.
 */

import type { Screen } from "./types";

export const toolsScreen: Screen = {
	id: "tools",
	label: "Tools",
	short: "Tools",
};
