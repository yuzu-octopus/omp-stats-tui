/**
 * `src/tui/footer.ts` — the panel's key hints, hand-rolled for the ANSI path.
 *
 * WHY HAND-ROLLED. `hintsRow` returns a `NativeNode`, so it is unusable
 * anywhere but the native renderer (F20: `native/overlay.ts:42-51`). `/usage`
 * builds its own hint string and renders it as a single dim span
 * (`overlays/usage-dashboard.ts:926`: `this.#footer.setLines([theme.fg("dim", hint)])`),
 * joining the pieces with `" · "`. `/settings` does the same for its ANSI twin
 * (`overlays/settings-selector.ts:107-145`, `settingsHintsNode`). This module is
 * that same shape, built from `formatKeyHints` so every keycap matches the rest
 * of the host UI rather than being spelled by hand.
 *
 * ONE TONE, NOT TWO. The row is wrapped ONCE in `theme.fg("dim", …)`. The
 * earlier split — dim keys beside muted labels — was this module's own idea,
 * and it is now wrong twice over: it is not what `/usage` does, and a footer is
 * a chrome line, not content. A hint row that competes with the data above it
 * is a chrome line nobody reads. Keycaps and labels are therefore the same
 * weight, and the only thing that separates two hints is the separator.
 *
 * `[`/`]` is the screen switch outside text entry; Ctrl+P/Ctrl+N is available
 * during search. Controllers own Tab/Shift+Tab focus and contextual arrows.
 * The range uses `r`/`R` outside text entry, so search terms remain literal.
 *
 * WHY THE HINTS ARE DATA. A footer built by concatenating strings is a footer
 * that drifts from the keymap: a key gets rebound, the hint does not, and the
 * panel advertises something it no longer does. {@link hintsFor} returns the keys
 * as `KeyName`s, so a test can round-trip every one of them through
 * `panelAction` and fail when a hint names an unbound key.
 *
 * PURE. The hint SET is a function of state; the colouring comes from an
 * injected `Theme`, so the module holds no singleton and loads before theme
 * init. No terminal reads, no data access, no timers.
 */

import { formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import type { KeyName } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

/** One hint: the keys that do it, and what they do. */
export interface PanelHint {
	keys: readonly KeyName[];
	label: string;
}

/**
 * What the panel is doing, which decides which hints are worth the row.
 *
 * DERIVED, never stored: an `error` state shows a retry and a close, not a range
 * switch that would only discard the message the user has not read.
 */
export type HintMode = "idle" | "scrollable" | "syncing" | "error";

/**
 * The hints for a state, in the order they read.
 *
 * ORDER IS THE READING ORDER: the most useful verb lands where the eye lands,
 * and `close` is always LAST because it is the only way out of the panel and
 * must never be the first thing a stray key hits.
 *
 * `scrollable` puts the scroll hint FIRST rather than in the middle. F23 §3.2's
 * argument: it is the one hint whose absence changes what the reader can DO, so
 * it belongs where the eye lands, and a footer that buries it mid-row teaches the
 * reader to skip the footer.
 *
 * EVERY KEY HERE IS BOUND BY `panelAction`. That is not a convention, it is an
 * assertion — `test/hint-contract.test.ts` maps every hint of every mode back
 * through `panelAction` and fails if it returns null. A hint for an unbound key
 * is a lie the user acts on. Feature-local keys are not duplicated here: the
 * focused feature prints its own inline hint (tables, charts, traces).
 */
export function hintsFor(mode: HintMode): readonly PanelHint[] {
	const scroll: PanelHint = { keys: ["up", "down", "home", "end"], label: "scroll" };
	// Contextual arrows and Tab belong to route controls; brackets stay global
	// outside text entry. Search mode uses a separate Ctrl+P/Ctrl+N hint.
	const screen: PanelHint = { keys: ["[", "]", "ctrl+p", "ctrl+n"], label: "screen" };
	const jump: PanelHint = { keys: ["g"], label: "jump" };
	const digits: PanelHint = { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], label: "screens" };
	const range: PanelHint = { keys: ["r", "shift+r"], label: "range" };
	const refresh: PanelHint = { keys: ["f2"], label: "refresh" };
	const sync: PanelHint = { keys: ["s"], label: "sync" };
	const close: PanelHint = { keys: ["escape", "q"], label: "close" };

	switch (mode) {
		case "idle":
			return [screen, jump, digits, range, refresh, sync, close];
		case "scrollable":
			return [scroll, screen, jump, digits, range, refresh, sync, close];
		case "syncing":
			// No `s`: a sync is already running, so offering to start another is
			// offering a key that does nothing.
			return [screen, jump, digits, range, refresh, close];
		case "error":
			// Retry, not "range": the message on screen is the thing to act on.
			return [{ keys: ["s"], label: "retry sync" }, close];
	}
}

/**
 * The footer row.
 *
 * ONE `dim` SPAN for the whole row, `/usage`-style. Hints are separated by a
 * `borderMuted` dot — one step quieter than the text it divides — and every
 * keycap renders through `formatKeyHints` so it looks like a keycap everywhere
 * else in the host.
 *
 * Hints are dropped WHOLE, never truncated. A hint that ends mid-word is worse
 * than a shorter footer, and `truncateToWidth` on a STYLED string can cut an
 * escape sequence in half and leak the remainder as literal text — which is why
 * the fit is measured on the assembled row with `visibleWidth` and the row is
 * rebuilt after each drop.
 *
 * THE LAST HINT IS PINNED. A plain "drop from the right" loop eats `close`
 * first, and `close` is the only exit from a fullscreen overlay that borrowed
 * the alt screen buffer: a user on a 60-column terminal would be told how to
 * scroll, switch screens, change range and sync, and never how to leave. So the
 * set is read as `head · middle… · tail`, where `head` is the scroll hint —
 * whose absence changes what the reader can DO, F23 §3.2's own argument for
 * putting it first — and `tail` is `close`. Both are load-bearing; the middle
 * hints (range, sync) are conveniences that degrade gracefully, and they are
 * the only things a narrow terminal gives up, in that order. If even
 * `head + tail` does not fit, `tail` alone does: showing how to leave beats
 * showing how to scroll.
 *
 * Returns `[]` rather than `undefined` for an empty hint set: a panel row is a
 * string, and `PanelRows` must never be handed nothing where a row is expected.
 */
export function footerHints(
	hints: readonly PanelHint[],
	theme: Theme,
	width = Number.POSITIVE_INFINITY,
): readonly string[] {
	if (hints.length === 0) return [];
	const separator = theme.fg("borderMuted", " · ");

	// A one-hint set has no middle and no separate tail, so the pinned shape
	// degenerates to the plain left-to-right loop.
	const head = hints[0]!;
	const tail = hints.length > 1 ? hints[hints.length - 1]! : undefined;
	const middle = hints.length > 2 ? hints.slice(1, -1) : [];

	const candidates: PanelHint[][] = [];
	for (let kept = middle.length; kept >= 0; kept--) {
		candidates.push(tail === undefined ? [head] : [head, ...middle.slice(0, kept), tail]);
	}
	if (tail !== undefined) candidates.push([tail]);

	for (const parts of candidates) {
		const row = theme.fg("dim", parts.map(hint => `${formatKeyHints(hint.keys)} ${hint.label}`).join(separator));
		if (visibleWidth(row) <= width) return [row];
	}
	// Nothing fits: drop the row entirely rather than emit a truncated word.
	return [];
}