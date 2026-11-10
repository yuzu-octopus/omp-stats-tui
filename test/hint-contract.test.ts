/**
 * `test/hint-contract.test.ts` — the THREE hint shapes, and the guard that
 * distinguishes them.
 *
 * A stat tile's `hint` is three different things and the IR has to say which:
 *
 *   - a `MetricRef` — a SECOND FIGURE, read against the payload and formatted by
 *     its own field's formatter;
 *   - a `string` — PROSE, printed verbatim;
 *   - `{ text: string }` — that same prose, spelled as an object.
 *
 * WHY THIS FILE EXISTS. The IR originally admitted only the first and third, so a
 * spec author writing `hint: "a caveat in prose"` — the obvious reading — was not
 * wrong, and nothing said so until RENDER time: the consumer's `"text" in hint`
 * threw a `TypeError`, because `in` requires an object on its right. The failure
 * appeared in someone's session, inside one tile, rather than at compile time.
 *
 * So the type now admits all three, and {@link isProseHint} /
 * {@link proseHintText} are the one narrowing rule. These tests pin the RULES, not
 * the current call sites: a consumer that re-invents its own `in` check is exactly
 * the bug this contract exists to prevent, and a test that only asserted "a string
 * hint does not throw" would be satisfied by the type alone while leaving both
 * prose-rendering paths unproven.
 */

import { expect, test } from "bun:test";

import { isProseHint, proseHintText, type MetricRef, type StatTile } from "../src/layout/spec";
import { SCREEN_SPECS } from "../src/layout/spec";
import { hintsFor } from "../src/tui/footer";
import { panelAction } from "../src/tui/panel";

const FIGURE: MetricRef = { kind: "aggregate", source: "overall", field: "unpricedRequests" };

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

test("a figure is not prose", () => {
	expect(isProseHint(FIGURE)).toBe(false);
	expect(proseHintText(FIGURE)).toBeNull();
});

test("a bare string IS prose — the shape that used to crash the renderer", () => {
	// This is the whole point. `"text" in "prose"` throws a TypeError, which is how
	// the trap reached a real session; `isProseHint` must answer the question
	// without touching the primitive that way.
	const hint: StatTile["hint"] = "a caveat in prose";
	expect(() => "text" in (hint as unknown as object)).toThrow();
	expect(isProseHint(hint)).toBe(true);
	expect(proseHintText(hint)).toBe("a caveat in prose");
});

test("the object form is prose and normalises to the same string", () => {
	const hint: StatTile["hint"] = { text: "a caveat in prose" };
	expect(isProseHint(hint)).toBe(true);
	expect(proseHintText(hint)).toBe("a caveat in prose");
});

test("both prose forms normalise identically, so a consumer never branches on form", () => {
	// The reason `proseHintText` exists: printing a hint must not care whether the
	// spec author chose the primitive or the wrapper.
	expect(proseHintText("same words")).toBe(proseHintText({ text: "same words" }));
});

test("an absent hint is neither prose nor a figure", () => {
	expect(isProseHint(undefined)).toBe(false);
	expect(proseHintText(undefined)).toBeNull();
});

test("an empty prose hint is still prose — emptiness is a value, not an absence", () => {
	// `""` must classify as prose rather than falling through to "figure that
	// resolved to nothing", because the two mean different things to a caller: the
	// first is an author who wrote nothing, the second is data that is missing.
	expect(isProseHint("")).toBe(true);
	expect(proseHintText("")).toBe("");
});

test("a derived ref is a figure like any other, never mistaken for prose", () => {
	// Every real spec's hint is a derived ref (the unpriced counts), so if this
	// misclassified, every cost tile in the panel would lose its caveat.
	const derived: MetricRef = { kind: "derived", name: "unpricedRequests", op: "sum", of: FIGURE };
	expect(isProseHint(derived)).toBe(false);
	expect(proseHintText(derived)).toBeNull();
});

// ---------------------------------------------------------------------------
// The type as the compiler sees it
// ---------------------------------------------------------------------------

test("all three hint shapes type-check on a StatTile", () => {
	// A compile-time assertion: this file fails `tsc` if any of the three stops
	// being legal, which is the check a runtime test cannot make.
	const tiles: readonly StatTile[] = [
		{ label: "figure", metric: FIGURE, hint: FIGURE },
		{ label: "prose", metric: FIGURE, hint: "prose" },
		{ label: "wrapped prose", metric: FIGURE, hint: { text: "prose" } },
		{ label: "no hint", metric: FIGURE },
	];
	expect(tiles).toHaveLength(4);
});

test("no shipped spec uses a hint shape the guard cannot classify", () => {
	// Every hint in every spec must narrow through the one rule. A spec that slipped
	// past it would be invisible until render time, which is the failure mode this
	// whole file exists to close.
	const unclassifiable: string[] = [];
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "statRow") continue;
			for (const tile of band.stats) {
				if (tile.hint === undefined) continue;
				const label = `${spec.id}/${tile.label}`;
				// Exactly one branch must match, and the three are disjoint by
				// construction: prose covers string and {text}, the rest is a ref.
				const branches = [isProseHint(tile.hint), !isProseHint(tile.hint)];
				if (branches.filter(Boolean).length !== 1) unclassifiable.push(label);
				if (proseHintText(tile.hint) === null && typeof tile.hint !== "object") {
					unclassifiable.push(`${label} — a figure that is not an object`);
				}
			}
		}
	}
	expect(unclassifiable).toEqual([]);
});

test("every prose hint in the shipped specs carries non-empty words", () => {
	// `{ text: "" }` would render an empty hint row and, per band.ts, contribute
	// nothing — so it is indistinguishable from declaring no hint at all while
	// looking declared. Cheap to forbid, and it is a spec-authoring trap of the same
	// family as the one this file is about.
	const empty: string[] = [];
	for (const spec of SCREEN_SPECS) {
		for (const band of spec.bands) {
			if (band.kind !== "statRow") continue;
			for (const tile of band.stats) {
				const text = proseHintText(tile.hint);
				if (text !== null && text.trim() === "") empty.push(`${spec.id}/${tile.label}`);
			}
		}
	}
	expect(empty).toEqual([]);
});

// ---------------------------------------------------------------------------
// Footer hints round-trip through the real keymap
// ---------------------------------------------------------------------------

/**
 * Raw byte sequences for the `KeyName`s the footer advertises. `panelAction`
 * takes what the terminal sends, not the name `matchesKey` matches on, so a
 * hint is only honest if its raw form is owned by the panel. A hint naming an
 * unbound key is a lie the user acts on.
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