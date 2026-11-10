/**
 * `src/tui/screens/projects.ts` — registry identity for the Projects screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * `folders` groups by working directory, which is the one grouping the panel
 * can present without inventing a project concept the host does not have.
 */

import type { Screen } from "./types";

export const projectsScreen: Screen = {
	id: "projects",
	label: "Projects",
	short: "Projects",
};
