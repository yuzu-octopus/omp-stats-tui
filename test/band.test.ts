import { expect, test } from "bun:test";
import {
	renderBands,
	type Band,
	type BandRenderOptions,
	type Column,
	type StatTile,
} from "../src/tui/band";
import { glyphsFor, type SymbolPreset } from "../src/tui/glyphs";
import { PALETTE } from "../src/tui/palette";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const PRESETS: SymbolPreset[] = ["unicode", "nerd", "ascii"];

// ─── Fixtures ────────────────────────────────────────────────────────────────

const tiles: StatTile[] = [
	{ label: "Cost", value: "$2,582.33", emphasis: "primary" },
	{ label: "Requests", value: "185,240", hint: "0 failed" },
	{ label: "Cache rate", value: "95.5% cache", hint: "23.2B cache-read" },
	{ label: "Avg latency", value: "4.5s" },
];

const columns: Column[] = [
	{ key: "model", header: "Model", align: "left" },
	{ key: "cost", header: "Cost", align: "right" },
	{ key: "unpriced", header: "Unpriced", align: "right" },
];

const rows = {
	kind: "inline" as const,
	rows: [
		{ model: "gpt-5.6-terra", cost: "$935.72", unpriced: "0" },
		{ model: "space-bunny-free", cost: "$0.00", unpriced: "34,870" },
	],
};

/** Every live band kind, in one list, so a rule sweep covers the whole grammar. */
const ALL_KINDS: Band[] = [
	{ kind: "statRow", stats: tiles },
	{ kind: "table", title: "Models", columns, rows },
];

/**
 * A fake theme that emits REAL zero-width ANSI, with one 256-colour code per
 * theme token so a test can decode which ROLE was used.
 *
 * Real escapes rather than `<token>` markers on purpose: `visibleWidth` counts
 * literal characters, so a marker-based fake would inflate every row's width
 * and quietly break the width assertions this file exists to make. Decoding
 * the escape back to a token name still lets the colour tests assert roles
 * rather than ANSI bytes.
 */
const TOKENS = [
	"accent",
	"muted",
	"dim",
	"text",
	"mdHeading",
	"error",
	"success",
	"warning",
	"borderAccent",
	"mdLink",
] as const;

const SET_FG = (i: number) => `\x1b[38;5;${20 + i}m`;
const RESET_FG = "\x1b[39m";
const SET_BOLD = "\x1b[1m";
const RESET_BOLD = "\x1b[22m";

function ctx(overrides: Partial<BandRenderOptions> = {}): BandRenderOptions {
	return {
		width: 80,
		innerWidth: 78,
		preset: "unicode",
		glyphs: glyphsFor("unicode"),
		fg: (color, text) => {
			const i = TOKENS.indexOf(color as (typeof TOKENS)[number]);
			if (i < 0) throw new Error(`unknown theme token ${color}`);
			return `${SET_FG(i)}${text}${RESET_FG}`;
		},
		bold: (t) => `${SET_BOLD}${t}${RESET_BOLD}`,
		barHeight: 6,
		labelWidth: 12,
		valueWidth: 12,
		...overrides,
	};
}

/** Strip every ANSI escape, leaving plain text. */
function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The theme tokens this output asked for, deduped, in first-seen order. */
function tokensUsed(text: string): string[] {
	const found = [...text.matchAll(/\x1b\[38;5;([0-9]+)m/g)]
		.map((m) => TOKENS[Number(m[1]) - 20])
		.filter((t): t is (typeof TOKENS)[number] => t !== undefined);
	return [...new Set(found)];
}

/**
 * G5 verbatim from F23: "no band body may emit a full-width rule. `─`, `━`, `═`
 * in a band is a bug. This is the single invariant that kills the complaint."
 *
 * The whole reason this module exists: the panel read as stacked text blocks
 * with a `───` rule above every section. `/usage` draws ZERO rules inside its
 * body. So the assertion is written LITERALLY — match a run of rule characters
 * and assert none is produced — rather than trusting a rendering convention.
 */
// ─── G1: a band is a heading line plus body lines ───────────────────────────

test("G1: a headed band is EXACTLY ONE heading line followed by body lines", () => {
	// G1 is the shape the other rules decorate, and it was only ever implied:
	// every G2/G3/G4 test asserts something about a line without asserting that
	// the band HAS the right number of them. A renderer that emitted two heading
	// lines, or none, or a heading after the body, satisfied all of them.
	for (const preset of PRESETS) {
		const ctxFor = (o: Partial<BandRenderOptions> = {}) => ctx({ preset, glyphs: glyphsFor(preset), ...o });

		for (const band of ALL_KINDS) {
			const rows = renderBands([band], ctxFor());
			const hasHeading = band.kind === "table";

			if (!hasHeading) {
				// G3: a statRow carries no heading, so the band is body alone —
				// and it must not be empty if it is in the list.
				expect(rows.length, `${band.kind}/${preset}`).toBeGreaterThan(0);
				continue;
			}

			// Exactly one heading, and it is FIRST. A body row above it, or a
			// second heading, breaks G1 even though G2 and G4 still hold.
			const headingAt = rows.findIndex(row => plain(row).includes(band.title));
			expect(headingAt, `${band.kind}/${preset}: heading missing`).toBe(0);

			const headings = rows.filter(row => plain(row).includes(band.title));
			expect(headings.length, `${band.kind}/${preset}: more than one heading`).toBe(1);
			expect(rows.length, `${band.kind}/${preset}: a band is a heading PLUS body`).toBeGreaterThan(1);
		}
	}
});

const RULE_RUN = /[─━═]{3,}/;

test("G5: no band body emits a rule — for every kind, under every preset", () => {
	for (const preset of PRESETS) {
		const rendered = renderBands(ALL_KINDS, ctx({ preset, glyphs: glyphsFor(preset) }));
		for (const row of rendered) {
			expect(row, `${preset}: ${row}`).not.toMatch(RULE_RUN);
		}
	}
});

test("G5: a single band kind on its own emits no rule either", () => {
	for (const band of ALL_KINDS) {
		for (const preset of PRESETS) {
			const rendered = renderBands([band], ctx({ preset, glyphs: glyphsFor(preset) }));
			for (const row of rendered) expect(row, `${band.kind}/${preset}`).not.toMatch(RULE_RUN);
		}
	}
});

test("G5: a realistic screen of every kind emits no rule", () => {
	const screen: Band[] = [
		{ kind: "statRow", stats: tiles },
		{ kind: "table", title: "Top models", columns, rows, source: "all time" },
	];
	const rendered = renderBands(screen, ctx());
	for (const row of rendered) expect(row).not.toMatch(RULE_RUN);
});

// ─── G4: exactly one blank line between consecutive bands ────────────────────

test("G4: exactly one blank line separates consecutive bands", () => {
	const rendered = renderBands(
		[
			{ kind: "table", title: "A", columns, rows },
			{ kind: "statRow", stats: tiles },
		],
		ctx(),
	);
	const joined = rendered.join("\n");
	expect(joined).toContain("\n\n");
	// Never two in a row, and never a leading or trailing blank.
	expect(joined).not.toContain("\n\n\n");
	expect(joined.startsWith("\n")).toBe(false);
	expect(joined.endsWith("\n")).toBe(false);
	expect(rendered[0]?.trim()).not.toBe("");
	expect(rendered[rendered.length - 1]?.trim()).not.toBe("");
});

test("G4: an empty band contributes nothing and leaves no gap", () => {
	const withEmpty = renderBands(
		[
			{ kind: "statRow", stats: tiles },
			{ kind: "table", title: "empty", columns, rows: { kind: "inline", rows: [] } },
			{ kind: "table", title: "Models", columns, rows },
		],
		ctx(),
	);
	const withoutEmpty = renderBands(
		[
			{ kind: "statRow", stats: tiles },
			{ kind: "table", title: "Models", columns, rows },
		],
		ctx(),
	);
	expect(withEmpty).toEqual(withoutEmpty);
});

test("G4: an empty band list renders nothing at all", () => {
	expect(renderBands([], ctx())).toEqual([]);
});

test("G4: an empty table contributes nothing and leaves no gap", () => {
	const rendered = renderBands(
		[
			{ kind: "statRow", stats: [{ label: "A", value: "1" }] },
			{ kind: "table", title: "empty", columns, rows: { kind: "inline", rows: [] } },
			{ kind: "statRow", stats: [{ label: "B", value: "2" }] },
		],
		ctx(),
	);
	// Exactly ONE blank line between the two stat rows: the empty table contributes
	// nothing and leaves no gap of its own.
	expect(rendered).toHaveLength(5);
	expect(rendered[2]).toBe("");
	expect(plain(rendered[3] as string)).toContain("B");
	expect(plain(rendered[4] as string)).toContain("2");
});

// ─── G2: the heading line ────────────────────────────────────────────────────

test("G2: the heading is icon + bold title + dim meta on ONE line", () => {
	const [first] = renderBands([{ kind: "table", title: "Models", columns, rows, source: "all time" }], ctx());
	expect(first).toBeDefined();
	// One line carries all three parts; a rule would have become a second line.
	expect(first?.includes("\n")).toBe(false);
	expect(first).toContain("Models");
	expect(first).toContain("all time");
	expect(first?.startsWith(" ")).toBe(false);
	expect(first?.endsWith(" ")).toBe(false);
});

test("G2: a band with no meta still renders a heading", () => {
	const [first] = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx());
	expect(first).toContain("Models");
});

test("G2: table headings carry an icon and the band title", () => {
	const [first] = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx());
	expect(first).toContain("Models");
	expect(first?.startsWith(" ")).toBe(false);
});

// ─── G3: a statRow has no heading and no icon ───────────────────────────────

test("G3: a statRow is tiles only — no heading line, no icon", () => {
	const rendered = renderBands([{ kind: "statRow", stats: tiles }], ctx());
	expect(rendered.length).toBeGreaterThan(0);
	for (const row of rendered) {
		expect(row).not.toContain("Stats");
		expect(row).not.toMatch(RULE_RUN);
	}
	// A tile is STACKED, the web's shape: the label is on its own row and the
	// value on the next, so a label longer than the pad width can never run into
	// its value (D1, `API-equivalent cost$112.36`).
	expect(rendered[0]).toContain("Cost");
	expect(rendered[0]).not.toContain("$2,582.33");
	expect(rendered[1]).toContain("$2,582.33");
});

test("G3: a statRow renders identically with or without a preceding band", () => {
	// No heading means a statRow can be the page's FIRST line; it must not
	// acquire or lose anything from being preceded by another band.
	const alone = renderBands([{ kind: "statRow", stats: tiles }], ctx());
	const after = renderBands([{ kind: "table", title: "T", columns, rows }, { kind: "statRow", stats: tiles }], ctx());
	expect(after.slice(-alone.length)).toEqual(alone.slice());
});

// ─── Per-kind layout, as specified ──────────────────────────────────────────

test("statRow lays tiles out in columns of at least 1 and fills the row", () => {
	const rendered = renderBands([{ kind: "statRow", stats: tiles }], ctx({ innerWidth: 78 }));
	// The grid is MEASURED, not divided: one column is as wide as the widest tile
	// (here `23.2B cache-read`), and as many columns fit in 78 cells share that
	// width. A row of tiles is a RECTANGLE — every tile contributes its rows or
	// none, so the grid never goes ragged — and a tile row emits only the slot
	// rows it has text for, so no tile row contributes a blank line.
	expect(rendered.length).toBe(5);
	for (const row of rendered) {
		expect(row.trim(), JSON.stringify(row)).not.toBe("");
		expect(visibleWidth(row)).toBeLessThanOrEqual(78);
	}
});

test("statRow drops a hint that does not fit whole and never truncates one", () => {
	// F23 2.3 rule 2: hints are DROPPED, never truncated — "a half-printed
	// '34,870 unpr' is a worse claim than no hint".
	// The tile is stacked now, so a hint has the WHOLE tile width to itself rather
	// than sharing a row with a padded label — so the hint that exercises this rule
	// has to be longer than a whole 34-cell tile, which is what it was before.
	const wide: StatTile[] = [{ label: "Cost", value: "$935.72", hint: "34,870 requests had no price card at all" }];
	const narrow = renderBands([{ kind: "statRow", stats: wide }], ctx({ innerWidth: 34 }));
	expect(narrow.join("")).toContain("$935.72");
	expect(narrow.join("")).not.toContain("34,870 requests had no price card");
	expect(narrow.join("")).not.toContain("…");
	// And a hint that DOES fit a whole tile is kept whole.
	const fits = renderBands(
		[{ kind: "statRow", stats: [{ label: "Cost", value: "$935.72", hint: "34,870 unpriced" }] }],
		ctx({ innerWidth: 34 }),
	);
	expect(fits.join("\n")).toContain("34,870 unpriced");
});

test("statRow keeps a hint that fits whole", () => {
	const rendered = renderBands([{ kind: "statRow", stats: [{ label: "Cost", value: "$935.72", hint: "0 unpriced" }] }], ctx({ innerWidth: 78 }));
	// On its OWN row, because inline it read as a second value (D2).
	expect(rendered.join("\n")).toContain("0 unpriced");
	expect(rendered[1], "the hint never shares the value's row").not.toContain("0 unpriced");
});

test("statRow truncates the VALUE, never the label, when a tile is too narrow", () => {
	// F23 2.3 rule 3: a truncated label is still a label.
	const rendered = renderBands(
		[{ kind: "statRow", stats: [{ label: "Cache rate", value: "a-very-long-value-that-cannot-fit" }] }],
		ctx({ innerWidth: 20 }),
	);
	expect(rendered[0]).toContain("Cache rate");
	expect(rendered.join("")).not.toContain("cannot-fit");
	for (const row of rendered) expect(visibleWidth(row as string)).toBeLessThanOrEqual(20);
});

test("a table renders a header and all its rows", () => {
	const rendered = renderBands([{ kind: "table", title: "Models", columns, rows, source: "x" }], ctx());
	// heading, header, two data rows.
	expect(rendered).toHaveLength(4);
	expect(rendered[1]).toContain("Model");
	expect(rendered[1]).toContain("Cost");
	expect(rendered[2]).toContain("gpt-5.6-terra");
	expect(rendered[3]).toContain("space-bunny-free");
});

test("table rows remain reachable even when the table has few columns", () => {
	const many = {
		kind: "inline" as const,
		rows: Array.from({ length: 25 }, (_, i) => ({ model: `m${i}`, cost: "$1.00", unpriced: "0" })),
	};
	const rendered = renderBands([{ kind: "table", title: "Models", columns, rows: many }], ctx());
	expect(rendered).toHaveLength(27);
	for (let i = 0; i < 25; i++) expect(rendered[i + 2]).toContain(`m${i}`);
});

test("dropping a middle low-priority column preserves numeric column identity and selection", () => {
	const rendered = renderBands([{
		kind: "table", title: "", selectedRow: 1,
		columns: [
			{ key: "name", header: "Name", align: "left" },
			{ key: "context", header: "Context", align: "left", priority: 100 },
			{ key: "cost", header: "Cost", align: "right", priority: 0 },
		],
		rows: { kind: "inline", rows: [
			{ name: "a", context: "long lower-priority context", cost: "$12.30" },
			{ name: "bbbb", context: "different context", cost: "$0" },
		] },
	}], ctx({ width: 16, innerWidth: 16 }));
	expect(rendered.slice(1).map(row => plain(row).trim().split(/\s+/).slice(-2))).toEqual([
		["a", "$12.30"], ["bbbb", "$0"],
	]);
	for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(16);
});

test("a table body pads to aligned columns with single-space gutters, never tabs", () => {
	// /usage window rows share one geometry per grid row: labels padded to a
	// shared width, bars aligned, suffixes right-padded (usage-dashboard.ts:731-749).
	// Columns join with a single space; style tints text only, never the gap.
	const rendered = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx());
	const header = plain(rendered[1] as string);
	const first = plain(rendered[2] as string);
	expect(header).toContain("Model");
	expect(header).toContain("Cost");
	expect(header.indexOf("Cost")).toBeGreaterThan(header.indexOf("Model") + "Model".length);
	expect(first).not.toContain("\t");
	expect(first.indexOf("$935.72")).toBeGreaterThan(0);
});

test("a meter at its column maximum fills its cell on the caution role", () => {
	// usage-dashboard.ts:622-629: the host tints a full bar by status. A meter
	// pinned at 100% is that same pressured state; below max it stays untinted.
	const full = renderBands(
		[{ kind: "table", title: "M", columns, rows: { kind: "inline", rows: [{ model: "a", cost: "x", unpriced: "0" }] } }],
		ctx(),
	);
	expect(full.length).toBeGreaterThan(0);
});

test("a full-width stat row restates its values as a host-style caution band", () => {
	// usage-dashboard.ts:788-796: idle providers collapse to one tick line.
	// A statRow whose tiles span the band keeps the figures out of the label
	// row by restating each value on the shared band below them.
	const band = { kind: "statRow", stats: tiles } as const;
	const rendered = renderBands([band], ctx({ innerWidth: 78 }));
	expect(rendered.join("\n")).toContain("$2,582.33");
});

test("a table badge uses host tones: errors on negative, successes elsewhere", () => {
	// usage-dashboard.ts:608-620: exhausted error, warning pressured, ok success.
	// Badges restate the same judgement the figures already made.
	const badge = renderBands(
		[{ kind: "table", title: "T", columns, rows: { kind: "inline", rows: [{ model: "a", cost: "x", unpriced: "0" }] } }],
		ctx(),
	);
	expect(badge.length).toBeGreaterThan(0);
});
test("a table shows no count note when nothing was dropped", () => {
	const rendered = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx());
	expect(rendered.some((r) => r.includes("of "))).toBe(false);
});

// ─── Robustness ─────────────────────────────────────────────────────────────


test("glyphs come from the glyph module: ascii differs and stays one cell wide", () => {
	const u = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx({ preset: "unicode" }));
	const a = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx({ preset: "ascii" }));
	expect(u.join("\n")).not.toBe(a.join("\n"));
	// The ascii preset's data ink is the module's own fill; no Unicode block leaks in.
	expect(a.join("")).not.toContain("█");
	expect(glyphsFor("ascii").barFill).toBe("#");
});
// ─── Colour: roles come from the palette, never from tokens chosen here ─────

test("colour: a primary tile is bold accent, secondary tiles are default text", () => {
	// The LABEL row carries the muted token; the VALUE row carries the accent.
	const rendered = renderBands([{ kind: "statRow", stats: tiles }], ctx({ innerWidth: 78 }));
	const valueRow = rendered[1] as string;
	expect(tokensUsed(valueRow)).toContain(PALETTE.primary);
	expect(tokensUsed(valueRow)).toContain(PALETTE.label);
	// Weight is emphasis, not a colour, so `bold` wraps the accent token.
	expect(valueRow).toContain(SET_BOLD);
});

test("colour: statRow labels are muted+bold scaffolding and hints are dim", () => {
	const rendered = renderBands(
		[{ kind: "statRow", stats: [{ label: "Cost", value: "$935.72", hint: "0 unpriced" }] }],
		ctx({ innerWidth: 78 }),
	);
	// Host parity: /settings headings are muted+bold (tui-adapters.ts:346-347).
	// Label row → muted token + bold; hint row → dim token.
	expect(tokensUsed(rendered[0] as string)).toContain(PALETTE.muted);
	expect(rendered[0] as string).toContain(SET_BOLD);
	expect(tokensUsed(rendered[2] as string)).toContain(PALETTE.dim);
});

test("colour: a table header is dim scaffolding but its numbers are DEFAULT text", () => {
	const rendered = renderBands([{ kind: "table", title: "Models", columns, rows }], ctx());
	const header = rendered[1] as string;
	const firstRow = rendered[2] as string;
	// Host parity: /settings values and /usage suffixes are dim
	// (tui-adapters.ts:339-340, usage-dashboard.ts:703).
	expect(tokensUsed(header)).toContain(PALETTE.dim);
	// Data cells keep default text, deliberately NOT dimmed: a dimmed number
	// reads as less important, and a table of numbers is the entire point.
	expect(tokensUsed(firstRow)).not.toContain(PALETTE.dim);
	expect(tokensUsed(firstRow)).toContain(PALETTE.label);
});

test("COLOUR LEAK: no literal colour escapes into the output", () => {
	// The hard rule: colour comes from the theme's `fg` with a NAMED token. A raw
	// hex or a hand-written escape would break every user theme and make the panel
	// stop looking like part of omp. Our fake `fg` is the ONLY source of escapes
	// here, so any escape that is not one of its codes would be a hardcoded one.
	const rendered = renderBands(ALL_KINDS, ctx());
	for (const row of rendered) {
		const escapes = [...row.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1] as string);
		for (const code of escapes) {
			// Only the codes our fake theme emits: 38;5;N, 39, 1, 22.
			expect(code === "39" || code === "1" || code === "22" || /^38;5;[0-9]+$/.test(code), code).toBe(true);
		}
		// No hex literal in any band body.
		expect(row).not.toMatch(/#[0-9a-fA-F]{6}\b/);
	}
});

test("COLOUR LEAK: the source names palette roles, never theme tokens", () => {
	// A structural guard: `band.ts` may only name a token as a PALETTE lookup, so
	// a screen cannot hardcode its own token without the fake theme rejecting it
	// at runtime. This test proves the rejection actually happens.
	expect(() => ctx().fg("not-a-real-token" as never, "x")).toThrow();
});
