/**
 * `src/tui/screens/errors.ts` — registry identity for the Errors screen.
 *
 * Production bodies are `FeatureController.render()` strings (ADR 0007); this
 * entry carries the id and labels the nav and panel read.
 *
 * Error signatures come from the host's `groupErrorsBySignature` and affected
 * models are `modelKey(model, provider)` identities, both resolved by the
 * production feature — never by a second regex pipeline here.
 */

import type { Screen } from "./types";

export const errorsScreen: Screen = {
	id: "errors",
	label: "Errors",
	short: "Errors",
};
