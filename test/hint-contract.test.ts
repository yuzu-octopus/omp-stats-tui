/**
 * `test/hint-contract.test.ts` — footer hints round-trip through the real keymap.
 *
 * A hint for a key the panel does not handle is a lie the user acts on: they
 * press it, nothing happens, and the panel told them it would. So every hint the
 * footer prints is resolved through `panelAction` with the raw bytes the
 * terminal sends, not the `KeyName` the footer names.
 */

import { expect, test } from "bun:test";

import { hintsFor } from "../src/tui/footer";
import { panelAction } from "../src/tui/panel";
import { __testing } from "../src/tui/panel";
import type { ScreenId } from "../src/tui/screens/types";

/**
 * Raw byte sequences for the `KeyName`s the footer advertises. `panelAction`
 * takes what the terminal sends, not the name `matchesKey` matches on, so a
 * hint is only honest if its raw form is owned by the panel.
 */
const RAW_KEY: Record<string, string> = {
	escape: "\x1b",
	"ctrl+c": "\x03",
	"ctrl+p": "\x0e",
	"ctrl+n": "\x10",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x1b[H",
	end: "\x1b[F",
	"[": "[", "]": "]",
	r: "r", "shift+r": "R", s: "s", g: "g", q: "q",
	f2: "\x1bOQ",
	"1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
	"6": "6", "7": "7", "8": "8", "9": "9", "0": "0",
};

const FOOTER_MODES = ["idle", "scrollable", "syncing", "error"] as const;

test("every footer hint names a key panelAction owns", () => {
	for (const mode of FOOTER_MODES) {
		for (const hint of hintsFor(mode)) {
			expect(hint.keys.length, `${mode}/${hint.label} names no key`).toBeGreaterThan(0);
			for (const key of hint.keys) {
				const raw = RAW_KEY[key];
				expect(raw, `${mode}/${hint.label}: no raw byte for ${key}`).toBeDefined();
				expect(panelAction(raw!), `${mode}/${hint.label}: ${key} is not bound`).not.toBeNull();
			}
		}
	}
});

test("the digit hint follows screen digit ownership; close stays pinned last", () => {
	for (const mode of FOOTER_MODES) {
		const withDigits = hintsFor(mode);
		const without = hintsFor(mode, true);
		expect(without, mode).toEqual(withDigits.filter(hint => hint.label !== "screens"));
		expect(without[without.length - 1]!.label, mode).toBe("close");
	}
	for (const mode of ["idle", "scrollable", "syncing"] as const) {
		expect(hintsFor(mode).some(hint => hint.label === "screens"), mode).toBe(true);
		expect(hintsFor(mode, true).some(hint => hint.label === "screens"), mode).toBe(false);
	}
	// The panel derives the flag from the screen identity: Overview's digits
	// switch screens, Frustration and Traces consume them in their controllers.
	const footerOf = (id: ScreenId): string => {
		const panel = __testing.makePanel({ screenId: id });
		const lines = panel.render(200);
		return (lines[lines.length - 2] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	};
	expect(footerOf("overview")).toContain(" screens");
	for (const id of ["frustration", "traces"] as const) {
		expect(footerOf(id), id).not.toContain(" screens");
		expect(footerOf(id), id).toContain("close");
	}
});
