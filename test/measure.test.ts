import { expect, test } from "bun:test";
import { clampCells, ellipsizeCells, padEndCells, padStartCells, NO_ACTIVITY } from "../src/tui/charts/measure";

test("ANSI-styled input clamps to the same cells as its plain equivalent", () => {
	const plain = "No activity recorded in this range.";
	const styled = `\x1b[2m${plain}\x1b[0m`;
	// Same visible text, codes preserved around the truncation.
	expect(clampCells(styled, 20)).toBe("\x1b[2mNo activity recorde\x1b[0m…");
	expect(clampCells(plain, 20)).toBe("No activity recorde…");
});

test("wide glyphs count by cells, not UTF-16 units", () => {
	// "🪙" is 2 cells; width 3 keeps the coin plus an ellipsis, never "🪙a"
	// (4 cells) and never a half glyph.
	expect(clampCells("🪙ab", 3)).toBe("🪙…");
});

test("width <= 0 returns empty, never a partial escape", () => {
	expect(clampCells("\x1b[2mhi\x1b[0m", 0)).toBe("");
	expect(ellipsizeCells("hi", -1)).toBe("");
});

test("pads and ellipsis are cell-exact on styled input", () => {
	expect(padEndCells("\x1b[2mhi\x1b[0m", 4)).toBe("\x1b[2mhi\x1b[0m  ");
	expect(padStartCells("\x1b[2mhi\x1b[0m", 4)).toBe("  \x1b[2mhi\x1b[0m");
	expect(ellipsizeCells("abcdef", 4)).toBe("abc…");
});

