import type { DataNeed } from "../../data/api";

import { overviewScreen } from "./overview";
import { activityScreen } from "./activity";
import { modelsScreen } from "./models";
import { costsScreen } from "./costs";
import { projectsScreen } from "./projects";
import { requestsScreen } from "./requests";
import { errorsScreen } from "./errors";
import { toolsScreen } from "./tools";
import { providersScreen } from "./providers";
import { gainScreen } from "./gain";
import { tracesScreen } from "./traces";
import { frustrationScreen } from "./frustration";

/**
 * Every dashboard screen, and every screen's data contract, in one closed set.
 * This module is DATA: a `Screen` record per screen and nothing else. There is no
 * switch over `ScreenId` anywhere in the panel, because a switch is a second place
 * to add a screen and the registry is the only place that should know one exists.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007). A
 * registry entry carries the identity and the fetch contract the nav and the
 * panel read — never a render body, which would be a second grammar for the
 * same screen.
 */
export type ScreenId =
	| "overview"
	| "activity"
	| "models"
	| "costs"
	| "projects"
	| "requests"
	| "errors"
	| "tools"
	| "providers"
	| "gain"
	| "traces"
	| "frustration";

export interface Screen {
	id: ScreenId;
	/** Full name for headings. */
	label: string;
	/** Tab-strip label. Measured, not assumed: test/screens.test.ts pins this at 8 cells. */
	short: string;
	/**
	 * Exactly what this screen fetches, and nothing more. Empty means it fetches
	 * nothing — a design decision, not an omission.
	 */
	needs: readonly DataNeed[];
}

/** Frozen, ordered, and the ONLY list of screens. Tab order is registry order. */
export const SCREENS: readonly Screen[] = Object.freeze([
	overviewScreen,
	activityScreen,
	modelsScreen,
	costsScreen,
	projectsScreen,
	requestsScreen,
	errorsScreen,
	toolsScreen,
	providersScreen,
	gainScreen,
	tracesScreen,
	frustrationScreen,
]);

/**
 * Lookup that THROWS on an unknown id rather than returning undefined. A silent
 * undefined reaches the tab strip and paints an empty body, which reads as "this
 * screen has no data" rather than as "this screen does not exist".
 *
 * Linear over twelve records on purpose: a derived `Record<ScreenId, Screen>`
 * would need a cast that erases the very exhaustiveness this lookup proves.
 */
export function screenById(id: ScreenId): Screen {
	const screen = SCREENS.find(s => s.id === id);
	if (!screen) throw new Error(`unknown screen id: ${String(id)}`);
	return screen;
}
