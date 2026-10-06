import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { clampFooter, footerHints, hintsFor, type HintMode, type PanelHint } from "../src/tui/footer";

/**
 * Footer behavior: hints describe bound keys, and close remains reachable when
 * the available width drops other hints. Exact theme escapes and formatter
 * forwarding are presentation details rather than consumer contracts.
 */

ensureThemeSync();

const MODES = ["idle", "scrollable", "syncing", "error"] as const satisfies readonly HintMode[];
const ALL_HINTS: Record<HintMode, readonly PanelHint[]> = {
	idle: hintsFor("idle"),
	scrollable: hintsFor("scrollable"),
	syncing: hintsFor("syncing"),
	error: hintsFor("error"),
};
const ESC = String.fromCharCode(27);
const SEPARATOR = " · ";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (text: string) => text.replace(ANSI, "");

/** The plain text one hint contributes to the row. */
const hintText = (hint: PanelHint): string => `${formatKeyHints(hint.keys)} ${hint.label}`;

// ─── the hint SET ───────────────────────────────────────────────────────────


test("the range hint names `r`/`R`, the keys that are literally called range", () => {
	// With the arrows back on screens, nothing is left over to carry the range —
	// so it keeps the one pair whose letters already say what they do.
	const range = hintsFor("idle").find(hint => hint.label === "range");
	expect(range).toBeDefined();
	expect(range!.keys).toEqual(["r", "shift+r"]);
	expect(range!.keys).not.toContain("left");
	expect(range!.keys).not.toContain("right");
});


test("close is present in every mode and always LAST", () => {
	// It is the only way out of the panel, so no mode decision can drop it and it
	// never sits where a stray key hits it first.
	for (const mode of MODES) {
		const hints = ALL_HINTS[mode];
		expect(hints.length, mode).toBeGreaterThan(0);
		expect(hints[hints.length - 1]!.label, mode).toBe("close");
		expect(hints[hints.length - 1]!.keys, mode).toEqual(["escape", "q"]);
	}
});

test("the hint set grows and shrinks with the state it describes", () => {
	expect(hintsFor("idle").map(h => h.label)).toEqual(["screen", "range", "sync", "close"]);
	expect(hintsFor("scrollable").map(h => h.label)).toEqual(["scroll", "screen", "range", "sync", "close"]);
	expect(hintsFor("syncing").map(h => h.label)).toEqual(["screen", "range", "close"]);
	expect(hintsFor("error").map(h => h.label)).toEqual(["retry sync", "close"]);
});

test("syncing offers no second sync, error offers a retry, scrollable leads with scroll", () => {
	// A sync is already running: offering `s` would be offering a key that does
	// nothing.
	expect(hintsFor("syncing").map(h => h.label)).not.toContain("sync");
	expect(hintsFor("syncing").flatMap(h => h.keys)).not.toContain("s");

	// The message on screen is the thing to act on, so `s` retries instead of
	// stepping a range the user has not read yet.
	expect(hintsFor("error").map(h => h.label)).toContain("retry sync");

	// Scroll is the one hint whose ABSENCE changes what the reader can do, so it
	// lands where the eye lands.
	expect(hintsFor("scrollable")[0]!.label).toBe("scroll");
	expect(hintsFor("idle").map(h => h.label)).not.toContain("scroll");
});



// ─── the fit ────────────────────────────────────────────────────────────────

test("the row never exceeds the width it was handed, across 20..200", () => {
	for (let width = 20; width <= 200; width++) {
		for (const mode of MODES) {
			const [row] = footerHints(hintsFor(mode), theme, width);
			if (row === undefined) continue; // nothing fit: the row is dropped
			expect(visibleWidth(row), `${mode}@${width}`).toBeLessThanOrEqual(width);
		}
	}
});

test("close is pinned: it survives every width at which ANY hint fits", () => {
	// The defect this pins: a plain "drop from the right" loop ate `close` first
	// at 60 columns, leaving a user in a fullscreen alt-screen overlay with no
	// advertised way out.
	for (const mode of MODES) {
		for (let width = 1; width <= 200; width++) {
			const [row] = footerHints(hintsFor(mode), theme, width);
			if (row === undefined) continue;
			expect(strip(row!), `${mode}@${width} dropped close`).toContain(hintText(ALL_HINTS[mode].at(-1)!));
		}
	}
	// The exact case from the bug report: scrollable at innerWidth 56. `range`
	// still fits there; the regression was that `close` did NOT.
	const row = footerHints(hintsFor("scrollable"), theme, 56)[0]!;
	expect(visibleWidth(row)).toBeLessThanOrEqual(56);
	for (const hint of [ALL_HINTS.scrollable[0]!, ALL_HINTS.scrollable[1]!, ALL_HINTS.scrollable.at(-1)!]) {
		expect(strip(row), `scrollable@56 lost ${hint.label}`).toContain(hintText(hint));
	}
	// And at the width where the middle must go, it is `range` that goes — not
	// the exit.
	const keep = [ALL_HINTS.scrollable[0]!, ALL_HINTS.scrollable[1]!, ALL_HINTS.scrollable.at(-1)!];
	const threeWide = visibleWidth(keep.map(hintText).join(SEPARATOR));
	expect(strip(footerHints(hintsFor("scrollable"), theme, threeWide)[0]!)).toBe(keep.map(hintText).join(SEPARATOR));
	const two = [ALL_HINTS.scrollable[0]!, ALL_HINTS.scrollable.at(-1)!];
	expect(strip(footerHints(hintsFor("scrollable"), theme, threeWide - 1)[0]!)).toBe(
		two.map(hintText).join(SEPARATOR),
	);
});

test("only the middle hints are dropped, whole, right to left", () => {
	// A hint ending mid-word is worse than a shorter footer, and truncating a
	// STYLED string can cut an escape in half. So every surviving row is
	// `head + a prefix of middle + tail`: whole hints, in order, never a
	// fragment and never a reordering.
	for (const mode of MODES) {
		const hints = ALL_HINTS[mode];
		const middle = hints.slice(1, -1);
		// Narrowest first, so a growing index means a growing row.
		const shapes = [hintText(hints.at(-1)!)];
		for (let kept = 0; kept <= middle.length; kept++) {
			shapes.push([hints[0]!, ...middle.slice(0, kept), hints.at(-1)!].map(hintText).join(SEPARATOR));
		}

		let widestKept = 0;
		for (let width = 1; width <= 200; width++) {
			const [row] = footerHints(hintsFor(mode), theme, width);
			if (row === undefined) continue;
			const kept = shapes.indexOf(strip(row!));
			expect(kept, `${mode}@${width} produced a row that is not head+middle-prefix+tail`).toBeGreaterThanOrEqual(0);
			// A wider terminal can never show FEWER hints.
			expect(kept, `${mode}@${width} lost hints as the width grew`).toBeGreaterThanOrEqual(widestKept);
			widestKept = kept;
		}
		expect(widestKept, `${mode} must fit every hint by width 200`).toBe(shapes.length - 1);
	}
});

test("a one- and two-hint set degrade to a plain left-to-right loop", () => {
	// No middle to give up: the pinned shape must not invent one.
	const closeOnly: PanelHint[] = [{ keys: ["escape", "q"], label: "close" }];
	const retry: PanelHint = { keys: ["s"], label: "retry sync" };
	const plain = (hints: readonly PanelHint[], width: number) => footerHints(hints, theme, width)[0];

	expect(plain(closeOnly, 200)).toBe(footerHints(closeOnly, theme)[0]);
	expect(plain([retry, closeOnly[0]!], 200)).toBe(footerHints([retry, closeOnly[0]!], theme)[0]);
	// Too narrow for both: the tail alone, because how to leave beats what to do.
	const twoWide = visibleWidth(plain([retry, closeOnly[0]!], 200)!);
	expect(strip(plain([retry, closeOnly[0]!], twoWide - 1)!)).toBe(hintText(closeOnly[0]!));
});

test("a row too narrow for even close is dropped, not truncated", () => {
	// A clipped keycap is worse than no row at all, and `PanelRows` must never be
	// handed `undefined` where a row is expected. The `close` hint on its own is
	// the floor the algorithm bottoms out at, so one column under IT is where the
	// row disappears entirely.
	const closeFloor = visibleWidth(hintText(ALL_HINTS.error.at(-1)!));
	expect(closeFloor).toBeGreaterThan(0);
	expect(strip(footerHints(hintsFor("error"), theme, closeFloor)[0]!)).toBe(hintText(ALL_HINTS.error.at(-1)!));
	expect(footerHints(hintsFor("error"), theme, closeFloor - 1)).toEqual([]);
	expect(footerHints(hintsFor("idle"), theme, 0)).toEqual([]);
	expect(footerHints([], theme)).toEqual([]);
	expect(footerHints([], theme, 80)).toEqual([]);
	expect(footerHints([], theme, 0)).toEqual([]);
});

test("no width argument means no fit constraint", () => {
	expect(footerHints(hintsFor("scrollable"), theme)[0]).toBe(
		footerHints(hintsFor("scrollable"), theme, Number.POSITIVE_INFINITY)[0],
	);
});

test("clampFooter shortens an already-composed row and leaves a fitting one alone", () => {
	const [row] = footerHints(hintsFor("idle"), theme);
	expect(clampFooter(row!, 200)).toBe(row!);
	expect(visibleWidth(clampFooter(row!, 12))).toBeLessThanOrEqual(12);
	expect(clampFooter("plain", 80)).toBe("plain");
});