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
