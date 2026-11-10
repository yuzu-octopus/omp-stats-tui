/**
 * `src/tui/screens/providers.ts` — registry identity for the Providers screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * The local aggregates (`/api/stats/providers`) are DB-backed rollup. The
 * NETWORK route (`/api/stats/provider-windows`) does broker I/O and the panel
 * never calls it from a load path.
 */

import type { Screen } from "./types";

export const providersScreen: Screen = {
	id: "providers",
	label: "Providers",
	short: "Provider",
};
