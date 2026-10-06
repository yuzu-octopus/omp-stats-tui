/**
 * ANSI footer: host-formatted keycaps, readable neutral ink and state-owned hints.
 * Close survives width pressure; contextual route controls remain controller-owned.
 * Theme is injected so this module does not read an uninitialized host singleton.
 */

import { formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import type { KeyName } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { PALETTE } from "./palette";

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
 * assertion — `test/footer.test.ts` maps every hint of every mode back through
 * `panelAction` and fails if it returns null. A hint for an unbound key is a lie
 * the user acts on.
 */
export function hintsFor(mode: HintMode): readonly PanelHint[] {
	const scroll: PanelHint = { keys: ["up", "down"], label: "scroll" };
	// Contextual arrows and Tab belong to route controls; brackets stay global
	// outside text entry. Search mode uses a separate Ctrl+P/Ctrl+N hint.
	const screen: PanelHint = { keys: ["[", "]"], label: "screen" };
	const range: PanelHint = { keys: ["r", "shift+r"], label: "range" };
	const sync: PanelHint = { keys: ["s"], label: "sync" };
	const close: PanelHint = { keys: ["escape", "q"], label: "close" };

	switch (mode) {
		case "idle":
			return [screen, range, sync, close];
		case "scrollable":
			return [scroll, screen, range, sync, close];
		case "syncing":
			// No `s`: a sync is already running, so offering to start another is
			// offering a key that does nothing.
			return [screen, range, close];
		case "error":
			// Retry, not "range": the message on screen is the thing to act on.
			return [{ keys: ["s"], label: "retry sync" }, close];
	}
}

/**
 * The footer row.
 *
 * One readable muted span; decorative separators stay a step quieter.
 * Every keycap renders through `formatKeyHints` so it looks like a keycap everywhere
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
		const row = theme.fg(PALETTE.muted, parts.map(hint => `${formatKeyHints(hint.keys)} ${hint.label}`).join(separator));
		if (visibleWidth(row) <= width) return [row];
	}
	// Nothing fits: drop the row entirely rather than emit a truncated word.
	return [];
}

/**
 * Truncate a footer row that has already been composed — used when a caller has
 * exactly one row and needs it to fit rather than to vanish.
 */
export function clampFooter(row: string, width: number): string {
	return visibleWidth(row) > width ? truncateToWidth(row, width) : row;
}