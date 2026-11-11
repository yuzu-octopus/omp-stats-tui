import { expect, test } from "bun:test";
import { KNOWN_INVALID_RANGES, resolveRange } from "../scripts/lib/ranges";
import {
	bucketLabel,
	coldCall,
	formatTimingTable,
	meanMs,
	warmCalls,
	type RangeTiming,
} from "../scripts/lib/timing";
import {
	KNOWN_TRAPS,
	codepoints,
	findWidthViolations,
	formatGlyphTable,
	type GlyphSample,
} from "../scripts/lib/glyph-width";


test("365d silently resolves to 24h, which is why it may never be offered", () => {
	expect(KNOWN_INVALID_RANGES).toContain("365d");
	expect(resolveRange("365d")).toEqual({ requested: "365d", resolved: "24h", valid: false });
	expect(resolveRange("7d")).toEqual({ requested: "7d", resolved: "7d", valid: true });
});

function timing(overrides: Partial<RangeTiming> = {}): RangeTiming {
	return {
		requested: "7d",
		resolved: "7d",
		valid: true,
		bucketMs: 3600_000,
		firstBucket: "2026-10-02T17:00",
		calls: [
			{ run: 0, ms: 434.2 },
			{ run: 1, ms: 4.8 },
			{ run: 2, ms: 4.8 },
		],
		...overrides,
	};
}

test("run0 is separated from the warm runs so a cold artefact is never averaged in", () => {
	const t = timing();
	expect(coldCall(t)?.ms).toBe(434.2);
	expect(warmCalls(t).map((c) => c.ms)).toEqual([4.8, 4.8]);
	expect(meanMs(warmCalls(t))).toBeCloseTo(4.8, 5);
	expect(meanMs(coldCall(t) ? [coldCall(t)!] : [])).toBeCloseTo(434.2, 5);
});

test("a range with no successful calls reports null rather than a fake zero", () => {
	expect(meanMs([])).toBeNull();
	expect(coldCall(timing({ calls: [] }))).toBeUndefined();
});

test("the timing table shows the invalid key, its fallback and the reason", () => {
	const lines = formatTimingTable(
		[timing(), timing({ requested: "365d", resolved: "24h", valid: false, calls: [{ run: 0, ms: 1.2 }] })],
		3,
	);
	const text = lines.join("\n");
	expect(text).toContain("365d");
	expect(text).toContain("-> 24h");
	expect(text).toContain("<- INVALID");
	expect(text).toContain("434.2"); // cold
	expect(text).toContain("4.8"); // warm
	expect(text).toContain("warm ms = mean of runs 1..2");
});

test("a failed call shows as a dash, not as zero milliseconds", () => {
	const lines = formatTimingTable([timing({ calls: [{ run: 0, ms: 9.9 }] })], 3);
	expect(lines.join("\n")).toContain("cold ms");
	expect(lines.join("\n")).toContain("9.9");
	expect(lines.join("\n")).toContain("-");
});

test("bucket widths label to the coarsest window that fits", () => {
	expect(bucketLabel(60_000)).toBe("1m");
	expect(bucketLabel(300_000)).toBe("5m");
	expect(bucketLabel(3600_000)).toBe("1h");
	expect(bucketLabel(21_600_000)).toBe("6h");
	expect(bucketLabel(86_400_000)).toBe("1d");
	expect(bucketLabel(999)).toBe("999ms");
});

const sample = (glyph: string, dataInk: boolean, role = "barFill"): GlyphSample => ({
	preset: "unicode",
	role,
	glyph,
	dataInk,
});

test("data ink measuring other than one cell is reported with its cause", () => {
	// " " measures 1 — a blank still occupies a cell — so only the emoji and the
	// empty string are violations here.
	const violations = findWidthViolations(
		[sample("█", true), sample("🪙", true, "icon.tokens"), sample(" ", true, "heatEmpty"), sample("", true)],
		(g) => Bun.stringWidth(g),
	);
	expect(violations).toHaveLength(2);
	expect(violations[0].sample.glyph).toBe("🪙");
	expect(violations[0].width).toBe(2);
	expect(violations[0].reason).toContain("misaligns by 1");
	expect(violations[1].reason).toContain("blank");
});
test("chrome may be two cells wide; only data ink is width-constrained", () => {
	expect(findWidthViolations([sample("🪙", false, "icon.tokens")], (g) => Bun.stringWidth(g))).toHaveLength(0);
});

test("codepoints distinguish the bare warning from the variation-selector form", () => {
	expect(codepoints(KNOWN_TRAPS.warningBare)).toBe("26A0");
	expect(codepoints(KNOWN_TRAPS.warningWithVariationSelector)).toBe("26A0 FE0F");
	expect(Bun.stringWidth(KNOWN_TRAPS.warningBare)).toBe(1);
	expect(Bun.stringWidth(KNOWN_TRAPS.warningWithVariationSelector)).toBe(2);
});

test("the padded separator is 3 cells under unicode and the bare bar is 1", () => {
	// The measured trap: " │ " must never be a column separator.
	expect(Bun.stringWidth(KNOWN_TRAPS.sepPipe.padded)).toBe(3);
	expect(Bun.stringWidth(KNOWN_TRAPS.sepPipe.bare)).toBe(1);
});

test("every block, shade and eighth-block data candidate is exactly one cell", () => {
	const marks = ["█", "░", "▒", "▓", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "■", "·", "#", "@"];
	expect(findWidthViolations(marks.map((g) => sample(g, true)), (g) => Bun.stringWidth(g))).toEqual([]);
});

test("the glyph table lists codepoint, width and whether the cell is repeated", () => {
	const text = formatGlyphTable([sample("█", true), sample("🪙", false, "icon.tokens")], (g) =>
		Bun.stringWidth(g),
	).join("\n");
	expect(text).toContain("2588");
	expect(text).toContain("1FA99");
	expect(text).toContain("data");
	expect(text).toContain("chrome");
});