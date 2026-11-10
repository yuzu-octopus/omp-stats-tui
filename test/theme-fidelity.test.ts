/**
 * Theme fidelity: every colour the panel paints comes from an omp theme token,
 * and every one of those tokens is a NAMED role in `src/tui/palette.ts`.
 *
 * This file restores the two structural guards the pre-merge base carried in
 * `test/render-screen.test.ts` — "every colour role the renderer emits is one
 * `PALETTE` names" and "the renderer imports no theme VALUE and no dynamic
 * module load" — and EXTENDS them from the single renderer file to every module
 * under `src/`. The base could scope itself to one file because that file was
 * the only renderer. After the merge it is not: `src/tui/features/**` is ~2,800
 * lines of hand-rolled rendering, and no test looked at it.
 *
 * Why these are STRUCTURAL assertions and not behavioural ones: every one of
 * them catches a defect that renders perfectly in the test that triggers it. A
 * hand-written `#0088fa` restyles fine until the user switches theme. A module
 * scope `theme.fg(...)` reads `undefined` before init and takes the extension
 * loader down at import, which no fixture can reproduce because the fixtures
 * initialise the theme first. A dynamic `import("@oh-my-pi/…")` works under
 * `bun test` and fails in the loader, because the loader's resolve hook
 * rewrites static specifiers only. Each of those is invisible to every other
 * test in this suite, which is precisely why they need one.
 *
 * The standing rule, from AGENTS.md §Code Conventions: "Do not hardcode colours
 * or heading glyphs. Use active omp theme roles via `src/tui/palette.ts`
 * (`PALETTE`/`SERIES_COLORS`, resolved for the current theme)." And §Runtime &
 * Tooling Constraints: "Do not read the host `theme` eagerly at module scope" /
 * "Do not use dynamic `import()` of `@oh-my-pi/*`."
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not repair what it finds.
 * A guard that fires forty times and gets edited until it fires zero times has
 * stopped guarding. The offenders are named, counted and reported; the owner
 * decides.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isValidThemeBg, isValidThemeColor, type ThemeColor } from "@oh-my-pi/pi-tui/theme/schema";

import { PALETTE, SERIES_COLORS, SIDEBAR_INK, TAB_INK } from "../src/tui/palette";

const ROOT = `${import.meta.dir}/..`;
const sourceFiles = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: ROOT })].sort();
/** The files PR #1 added and no test scanned. */
const featureFiles = sourceFiles.filter(file => file.startsWith("src/tui/features/"));

// ─── lexical layer ───────────────────────────────────────────────────────────
//
// Every check below is a claim about SOURCE TEXT, so the text has to be read
// the way TypeScript reads it: comments are not code, and a `{` inside a string
// does not open a scope. The base version of this guard used two regexes and
// got away with it on one hand-written file. Applied to ~2,800 lines of feature
// code it would report a comment mentioning `█` as a glyph literal and a
// template string containing `}` as unbalanced braces, so it needs a real walk.

interface StringSpan {
	/** Offset of the opening quote. */
	start: number;
	/** Offset just past the closing quote. */
	end: number;
	/** Index into the ORIGINAL source, quotes included. */
	text: string;
	/** A template with no `${…}` is still a literal; one with a substitution is not. */
	plain: boolean;
}

interface Lexed {
	/** Source with every comment replaced by spaces. Offsets and line breaks survive. */
	code: string;
	/** 1 where the original character is real code, 0 inside a comment or string. */
	isCode: Uint8Array;
	/** Bracket depth at each offset. 0 means module scope. */
	depth: Int32Array;
	strings: StringSpan[];
}

/**
 * Walk `source` once, recording comment/string structure and bracket depth.
 *
 * Depth is what makes the module-scope check possible: `theme` read inside any
 * `{` — a function body, a class method, an object literal, a call — is at
 * depth ≥ 1 and is the injected/captured case the rule permits. The same
 * identifier at depth 0 is read while the module is still evaluating, which is
 * exactly the case that crashes.
 */
function lex(source: string): Lexed {
	const n = source.length;
	const code = source.split("");
	const isCode = new Uint8Array(n);
	const depth = new Int32Array(n);
	const strings: StringSpan[] = [];
	/** 0 code, 3 template text, 4 inside a `${…}` substitution. */
	let mode = 0;
	/**
	 * What a template must return to when it ENDS. A template opened inside a
	 * `${…}` substitution returns to the substitution, not to top level:
	 * returning to code instead makes the substitution's own `}` an ordinary
	 * brace and desynchronises the rest of the file.
	 */
	let templateParent = 0;
	let d = 0;
	/** For each open bracket: the depth it opened at, and the mode to resume. */
	const stack: { depth: number; resume: number }[] = [];

	const blank = (from: number, to: number) => {
		for (let i = from; i < to && i < n; i++) {
			if (code[i] !== "\n") code[i] = " ";
		}
	};
	/** Ordinary bracket: remembers which mode it was opened in. */
	const open = (i: number, resume: number) => {
		isCode[i] = 1;
		depth[i] = d;
		stack.push({ depth: d, resume });
		d += 1;
	};
	/** `${` — the only bracket whose closing `}` returns to TEMPLATE TEXT. */
	const openSubstitution = (i: number) => {
		isCode[i] = 1;
		depth[i] = d;
		stack.push({ depth: d, resume: 3 });
		d += 1;
		mode = 4;
	};
	const close = (i: number) => {
		const top = stack.pop();
		d = top ? top.depth : 0;
		depth[i] = d;
		if (mode === 4) mode = top ? top.resume : 0;
	};

	for (let i = 0; i < n; ) {
		const c = source[i]!;
		const next = source[i + 1] ?? "";

		if (mode === 3) {
			if (c === "\\") i += 2;
			else if (c === "`") {
				mode = templateParent;
				i += 1;
			} else if (c === "$" && next === "{") {
				openSubstitution(i);
				i += 2;
			} else i += 1;
			continue;
		}

		if (mode === 4) {
			// Inside `${…}` this is ordinary code again, except that a `${` here
			// is another substitution rather than an object-literal brace, and a
			// backtick opens a template that returns HERE when it closes.
			if (c === "`") {
				templateParent = 4;
				mode = 3;
				i += 1;
				continue;
			}
			if (c === "$" && next === "{") {
				openSubstitution(i);
				i += 2;
				continue;
			}
			if (c === "}") {
				isCode[i] = 1;
				close(i);
				i += 1;
				continue;
			}
		}

		// ── code, comments, strings ──
		// A string inside `${…}` must hand control back to the substitution, not
		// to top-level code: losing that makes the substitution's own `}` an
		// ordinary brace and everything after it is mis-read.
		const resume = mode;
		if (c === "/" && next === "/") {
			const nl = source.indexOf("\n", i);
			const end = nl === -1 ? n : nl;
			blank(i, end);
			i = end;
			continue;
		}
		if (c === "/" && next === "*") {
			const closeComment = source.indexOf("*/", i + 2);
			const end = closeComment === -1 ? n : closeComment + 2;
			blank(i, end);
			i = end;
			continue;
		}
		if (c === "'" || c === '"') {
			const from = i;
			i += 1;
			while (i < n) {
				if (source[i] === "\\") i += 2;
				else if (source[i] === c) {
					i += 1;
					break;
				} else i += 1;
			}
			strings.push({ start: from, end: i, text: source.slice(from + 1, i - 1), plain: true });
			mode = resume;
			continue;
		}
		if (c === "`") {
			const from = i;
			i += 1;
			while (i < n) {
				if (source[i] === "\\") i += 2;
				else if (source[i] === "`") {
					i += 1;
					break;
				} else if (source[i] === "$" && source[i + 1] === "{") {
					// A substitution. The leading text is a literal of its own,
					// but `plain: false` keeps it out of the colour-token scan —
					// only a whole `'…'`/`"…"` can be a theme token. `i` stays ON
					// the `$` so mode 3 consumes `${` as an opener; advancing past
					// it here would leave the `{` to be read as template text
					// and everything after it as a string.
					strings.push({ start: from, end: i, text: source.slice(from + 1, i), plain: false });
					templateParent = resume;
					mode = 3;
					break;
				} else i += 1;
			}
			if (mode !== 3) {
				strings.push({ start: from, end: i, text: source.slice(from + 1, i - 1), plain: true });
				mode = resume;
			}
			continue;
		}
		if (c === "{" || c === "(" || c === "[") {
			open(i, resume);
			i += 1;
			continue;
		}
		if (c === "}" || c === ")" || c === "]") {
			close(i);
			i += 1;
			continue;
		}
		isCode[i] = 1;
		depth[i] = d;
		i += 1;
	}
	return { code: code.join(""), isCode, depth, strings };
}

const readSource = (file: string): string => readFileSync(`${ROOT}/${file}`, "utf8");

const LEXED = new Map<string, Lexed>();
const lexedFor = (file: string): Lexed => {
	let lexed = LEXED.get(file);
	if (!lexed) {
		lexed = lex(readSource(file));
		LEXED.set(file, lexed);
	}
	return lexed;
};

const lineStarts = new Map<string, number[]>();
const lineOf = (file: string, offset: number): number => {
	let starts = lineStarts.get(file);
	if (!starts) {
		starts = [0];
		const text = readSource(file);
		for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
		lineStarts.set(file, starts);
	}
	const starts_ = starts;
	let lo = 0;
	let hi = starts_.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts_[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
};

interface Offender {
	where: string;
	what: string;
}

/**
 * Tokens a NAMED role stands behind, as a lookup table rather than a set: the
 * question being asked is "is this token named?", which is a lookup, and the
 * union is built from three imported tables so it cannot be a static literal.
 */
const ownedBy = (...groups: readonly (readonly string[])[]): Record<string, true> =>
	Object.fromEntries(groups.flat().map(token => [token, true]));

const at = (file: string, offset: number): string => `${file}:${lineOf(file, offset)}`;
const report = (offenders: Offender[]): string =>
	offenders.length === 0
		? "none"
		: `${offenders.length}\n` + offenders.map(o => `    ${o.where}  ${o.what}`).join("\n");

/**
 * Every string literal a `fg(`/`bg(` call receives as its FIRST argument.
 *
 * Only the first argument. `theme.fg("accent", "No recorded points")` names a
 * colour in arg 1 and prose in arg 2, and a scan that cannot tell them apart
 * reports every label in the panel as a misspelt theme token. A ternary —
 * `fg(i === peak ? "warning" : "success", …)` — is still one first argument and
 * is read as both of its literals, because both of them are colour choices the
 * author made at that call site.
 */
function colourArgumentLiterals(file: string): { method: "fg" | "bg"; token: string; offset: number }[] {
	const { code, isCode, depth, strings } = lexedFor(file);
	const out: { method: "fg" | "bg"; token: string; offset: number }[] = [];
	// `fg` and `bg` are kept apart because the host declares two different
	// unions: `ThemeColor` for ink, `ThemeBg` for the seven background tokens.
	// Validating a `bg("selectedBg", …)` against `isValidThemeColor` reports a
	// correct call as a misspelt token.
	const call = /\.\s*(fg|bg)\s*\(/g;
	for (let match = call.exec(code); match; match = call.exec(code)) {
		const method = match[1] as "fg" | "bg";
		const open = match.index + match[0].length - 1;
		if (!isCode[open]) continue;
		// `depth` records the depth OUTSIDE an open bracket, so the `(` itself
		// carries the call's depth and everything after it carries that plus one.
		const inner = depth[open]! + 1;
		// The first argument ends at the first comma at the call's own level.
		let end = code.length;
		for (let i = open + 1; i < code.length; i++) {
			if (!isCode[i]) continue;
			if (depth[i] === inner && code[i] === ",") {
				end = i;
				break;
			}
			if (depth[i] < inner) {
				end = i;
				break;
			}
		}
		for (const span of strings) {
			if (span.plain && span.start > open && span.end <= end + 1) {
				out.push({ method, token: span.text, offset: span.start + 1 });
			}
		}
	}
	return out;
}

// ─── the lexer itself ────────────────────────────────────────────────────────

/**
 * `colourArgumentLiterals` is the instrument every check below is read through,
 * so the instrument gets its own test. A lexer that loses track of a template
 * does not fail loudly: it silently returns FEWER strings, so the guards pass on
 * the cases they should have reported. Three bugs of exactly that shape were
 * written and caught while this file was built — a string inside `${…}`
 * resetting the mode to top-level code, a template closing inside a
 * substitution returning to code instead of to the substitution, and `${` inside
 * a substitution being read as an object-literal brace. All three showed up as
 * a quietly shortened offender list, never as an error.
 *
 * The real tree already gives the strongest end-to-end evidence: all 94 colour
 * tokens it extracts are valid theme tokens, and a desynchronised lexer emits
 * source text as tokens. These cases pin the specific shapes that broke.
 */
test("the source lexer keeps its place through comments, braces and nested templates", () => {
	const lines = [
		'import { theme } from "@oh-my-pi/pi-tui/theme"; // theme.fg("commented", …)',
		"/* a block comment with theme.fg(\"blocked\", …) and a } brace */",
		"export function chipFor(theme: Theme) {",
		'\tconst mark = theme.fg("accent", theme.symbol("status.running"));',
		"\treturn `${mark} ${theme.fg(\"dim\", `${a}/${b}`)}`;",
		'}',
	].join("\n");
	const { code, isCode, depth, strings } = lex(lines);
	// Comments are blanked, not merely skipped, so offsets and line numbers hold.
	expect(code).not.toContain("commented");
	expect(code).not.toContain("blocked");
	expect(code.split("\n")).toHaveLength(6);
	// The whole module body is at depth ≥ 1 — never back at 0 part-way through,
	// which is the signature of every desync found while building this file.
	expect(depth[lines.indexOf("const mark")]).toBe(1);
	expect(depth[lines.indexOf("\treturn")]).toBe(1);
	expect(depth[lines.length - 1], "the final `}` closes the function, back at module scope").toBe(0);
	// The two quoted token names inside the substitutions survive, and the
	// comment's `"commented"` never becomes a string at all.
	const tokens = strings.filter(span => span.plain).map(span => span.text);
	expect(tokens).toEqual(["@oh-my-pi/pi-tui/theme", "accent", "status.running", "dim"]);
	// And the closing brace of `chipFor` is code, not swallowed by the template.
	expect(isCode[lines.length - 1], "the final `}` is code, not swallowed by a template").toBe(1);
});

test("the lexer reads a colour token from a live module, by line", () => {
	// Named, not aggregate: a lexer regression should name the site it lost,
	// not print a shorter offender list and let the reader guess.
	//
	// The fixture is `fg("accent")` and NOT the former `bg("selectedBg")`. That
	// token was the only `bg()` literal left in the tree, so routing the
	// selection band through `SELECTION_BG.band` (see `src/tui/palette.ts`)
	// deleted the fixture and took this self-test down with it. An `fg()` site is
	// the better fixture anyway: it exercises the same lexer path, and it is
	// stable rather than being the one literal a colour-role refactor removes.
	const chrome = colourArgumentLiterals("src/tui/chrome.ts").filter(site => site.token === "accent");
	expect(chrome.length, "chrome.ts lost the accent foreground sites").toBe(4);
	// Line numbers are deliberately NOT pinned: chrome.ts gains lines on every
	// refactor and a pinned list fails on each one. What must hold is that every
	// reported offset really lands on a line carrying an `accent` literal.
	const chromeSource = readSource("src/tui/chrome.ts").split("\n");
	for (const site of chrome) {
		expect(chromeSource[lineOf("src/tui/chrome.ts", site.offset) - 1]).toContain("accent");
	}
});

/** Tokens a NAMED role stands behind. The whole point of `palette.ts`. */
const ROLE_BACKED = ownedBy(Object.values(PALETTE), Object.values(SIDEBAR_INK), Object.values(TAB_INK));
const PALETTE_BACKED = ownedBy(Object.values(PALETTE));
const SERIES_BACKED = ownedBy(SERIES_COLORS);

// ─── 1. colour tokens are real theme tokens ──────────────────────────────────

test("every colour token passed to fg()/bg() is a token the theme declares", () => {
	// `isValidThemeColor` is the runtime guard over the SAME union the compiler
	// checks, so a typo fails here even where a `as ThemeColor` would silence it.
	// The scan covers ALL of `src/`, because a misspelt token renders as an
	// uncoloured cell — it never throws and no behavioural test can see it.
	const offenders: Offender[] = [];
	const painting: string[] = [];
	let sites = 0;
	for (const file of sourceFiles) {
		const found = colourArgumentLiterals(file);
		if (found.length) painting.push(file);
		for (const { method, token, offset } of found) {
			sites += 1;
			const declared = method === "bg" ? isValidThemeBg(token) : isValidThemeColor(token);
			if (!declared) offenders.push({ where: at(file, offset), what: `${method}(${JSON.stringify(token)}, …)` });
		}
	}
	// The scan must actually be looking at something, or every check below is
	// vacuous — which is the exact failure mode `test/stat-tile.test.ts` already
	// suffered once in this repo, when a hand-maintained glyph class went stale.
	// Both floors are below what this tree measures (94 sites across 17 files)
	// so they catch a broken scan rather than tracking every edit to the tree.
	expect(sites, "the colour scan is not finding fg()/bg() first arguments").toBeGreaterThanOrEqual(80);
	expect(painting.length, "the colour scan is not reaching most painting modules").toBeGreaterThanOrEqual(12);
	expect(offenders, `theme tokens the host does not declare:\n${report(offenders)}`).toEqual([]);
});

test("the same check rejects a token that does not exist, so the scan above is not vacuous", () => {
	expect(isValidThemeColor("chartSeries1" as ThemeColor)).toBe(false);
	expect(isValidThemeColor("accent")).toBe(true);
});

// ─── 2. every colour token is a NAMED role ───────────────────────────────────

test("every colour token at a use site is one PALETTE names, not a bare literal", () => {
	// `PALETTE` is the only colour table. A module calling `theme.fg("accent", …)`
	// restyles correctly today and drifts the moment a role moves: the literal
	// has no web citation, no ladder position and no reason anybody could later
	// reconstruct. `SERIES_COLORS` counts as named (it is a table with an
	// ordinal and a stated provenance); `SIDEBAR_INK`/`TAB_INK` count for the
	// nav, because that ladder is its own named ink table.
	const offenders: Offender[] = [];
	for (const file of sourceFiles) {
		for (const { method, token, offset } of colourArgumentLiterals(file)) {
			if (PALETTE_BACKED[token] === true || SERIES_BACKED[token] === true) continue;
			if (ROLE_BACKED[token] !== true) {
				offenders.push({ where: at(file, offset), what: `${method}("${token}", …) — no PALETTE/SERIES role` });
			}
		}
	}
	expect(offenders, `bare colour tokens with no named role:\n${report(offenders)}`).toEqual([]);
});

test("PALETTE, SIDEBAR_INK and TAB_INK are non-empty, so check 2 has a reference set", () => {
	// Without this, deleting every role would make check 2 pass by having
	// nothing to compare against.
	expect(Object.keys(PALETTE).length).toBeGreaterThan(5);
	expect(Object.keys(SIDEBAR_INK).length).toBeGreaterThan(3);
	expect(Object.keys(TAB_INK).length).toBeGreaterThan(2);
	expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(6);
});

// ─── 3. no hex literal outside palette.ts ────────────────────────────────────

test("no hex literal outside palette.ts: every hue is a token, not a value", () => {
	// `palette.ts` is the ONE place a raw hex is legitimate — it is the module
	// that documents why each token resolves where it does. Everywhere else a
	// `#rrggbb` survives every behavioural test in this suite and breaks the
	// moment the user switches theme.
	const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;
	const offenders: Offender[] = [];
	for (const file of sourceFiles) {
		if (file === "src/tui/palette.ts") continue;
		const { code } = lexedFor(file);
		for (let match = HEX.exec(code); match; match = HEX.exec(code)) {
			offenders.push({ where: at(file, match.index), what: `hex literal ${match[0]}` });
		}
	}
	expect(offenders, `hardcoded hex outside palette.ts:\n${report(offenders)}`).toEqual([]);
});

// ─── 4. no colour-setting SGR outside palette.ts ─────────────────────────────

test("palette.ts is the only module that emits a colour escape", () => {
	// Ported from the base verbatim. A colour-SETTING SGR: 30–37/90–97 (basic
	// fg), 38/48/58 (extended fg/bg/underline), 40–47/100–107 (basic bg). A bare
	// reset like `\x1b[39m` is not a colour choice and is deliberately not
	// matched — and neither is a cursor move, which `\x1b[` alone would catch.
	const COLOUR_ESCAPE = /\\x1b\\?\[\s*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38|48|58)\b/;
	const offenders: Offender[] = [];
	for (const file of sourceFiles) {
		if (file === "src/tui/palette.ts") continue;
		const { code } = lexedFor(file);
		for (let match = COLOUR_ESCAPE.exec(code); match; match = COLOUR_ESCAPE.exec(code)) {
			offenders.push({ where: at(file, match.index), what: "hand-written colour escape" });
		}
	}
	expect(offenders, `colour escapes outside palette.ts:\n${report(offenders)}`).toEqual([]);
});

// ─── 5. no module-scope read of the theme singleton ──────────────────────────

test("no module reads the host theme singleton at import time", () => {
	// `export var theme: Theme` is `undefined` until the host initialises it,
	// and the extension loader imports this bundle BEFORE that happens. A
	// module-scope `theme.fg(...)` therefore throws while the loader is still
	// building the module graph, which no fixture reproduces — every fixture
	// calls `ensureThemeSync()` first, because the tests themselves need it.
	//
	// The rule is not "never import `theme`". AGENTS.md requires the panel to
	// refresh from the initialised active host binding in its RENDER PATH, and
	// that read is legitimate. The rule is about WHERE: at depth 0 the binding is
	// read while the module body is still evaluating; at depth ≥ 1 it is read
	// from a function body, where the host has long since initialised it.
	const offenders: Offender[] = [];
	for (const file of sourceFiles) {
		const source = readSource(file);
		const { isCode, depth } = lexedFor(file);
		const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](@oh-my-pi\/[^"']*)["']/g;
		/** Aliases bound to the host's mutable `theme` export, with their import range. */
		const aliases: { alias: string; from: number; to: number }[] = [];
		for (let match = IMPORT.exec(source); match; match = IMPORT.exec(source)) {
			for (const raw of match[2]!.split(",")) {
				const spec = raw.trim();
				if (!spec || spec.startsWith("type ")) continue;
				const parts = spec.split(/\s+as\s+/);
				if (parts[0]!.trim() !== "theme") continue;
				aliases.push({
					alias: (parts[1] ?? parts[0]!).trim(),
					from: match.index,
					to: match.index + match[0].length,
				});
			}
		}
		for (const { alias, from, to } of aliases) {
			const use = new RegExp(`(?<![\\w$.])${alias.replace(/[$]/g, "\\$")}(?![\\w$])`);
			for (let i = 0; i < source.length; i++) {
				if (!isCode[i] || depth[i] !== 0) continue;
				if (i >= from && i < to) continue;
				if (use.test(source.slice(i, i + alias.length))) {
					offenders.push({ where: at(file, i), what: `module-scope read of \`${alias}\` (the host theme is undefined until init)` });
					break;
				}
			}
		}
	}
	expect(offenders, `theme singleton read at module scope:\n${report(offenders)}`).toEqual([]);
});

// ─── 6. no dynamic import of an @oh-my-pi specifier ──────────────────────────

test("no module dynamically imports an @oh-my-pi specifier", () => {
	// AGENTS.md §Code Conventions, stated as a dead end already disproven:
	// "Dynamic `import()` of *any* `@oh-my-pi/*` fails inside the extension
	// loader, including `pi-tui` and `pi-coding-agent`, which work fine as
	// static imports. The loader's resolve hook rewrites the specifier for static
	// imports only; the dynamic path re-enters resolution into Bun's flat
	// install cache."
	//
	// Built without spelling the forbidden call out, so this file does not
	// itself contain the pattern it forbids.
	const specifier = ["@oh-my-pi", ""].join("/");
	const deferred = new RegExp(`${"import"}\\s*\\(\\s*["'\`][^"'\`]*${specifier.replace("/", "\\/")}`, "g");
	const offenders: Offender[] = [];
	for (const file of sourceFiles) {
		const { code } = lexedFor(file);
		for (let match = deferred.exec(code); match; match = deferred.exec(code)) {
			offenders.push({ where: at(file, match.index), what: "dynamic import() of an @oh-my-pi specifier" });
		}
	}
	expect(offenders, `dynamic @oh-my-pi imports:\n${report(offenders)}`).toEqual([]);
});

// ─── 7. features/** draws its colours and glyphs from the palette tables ─────

/**
 * Characters that are DATA INK or a rule, never prose. `·` is deliberately
 * absent: it is this codebase's sentence separator ("Models: 4 · Providers: 2")
 * and banning it outright would flag every hint line in every feature. It is
 * caught on its own, by the narrow rule below.
 */
const INK = "█▓▒░■□─━│═┄┌┐└┘●•▲▼▶◆";

test("no features module hand-draws a data-ink or rule glyph", () => {
	// The base asserted this on the renderer, where `glyphsFor(preset).barFill`
	// is the one way to get a `█`. AGENTS.md: "Heading glyphs use `statsIcon`;
	// data ink uses the chart glyph policy." A literal here is a SECOND glyph
	// table: it cannot answer to the symbol preset, so an ascii user gets block
	// characters where the rest of the panel degraded to `#`.
	expect(featureFiles.length, "src/tui/features/** is empty — this guard is scanning nothing").toBeGreaterThan(5);
	const ink = new RegExp(`[${INK}]`, "g");
	/** `·` is ink only when a WHOLE literal is EXACTLY one dot — the empty-cell
	 * marker `glyphs.ts` already names `heatEmpty`. `.join(" · ")` is this
	 * codebase's sentence separator and is not ink, and `` ` · ${x}` `` is not
	 * even a plain span, so neither reaches this rule. */
	const dotIsInk = (file: string): Offender[] =>
		lexedFor(file)
			.strings.filter(span => span.plain && span.text === "·")
			.map(span => ({ where: at(file, span.start), what: "hand-drawn ramp cell `·`" }));
	const offenders: Offender[] = [];
	for (const file of featureFiles) {
		const { code } = lexedFor(file);
		for (let match = ink.exec(code); match; match = ink.exec(code)) {
			offenders.push({ where: at(file, match.index), what: `hand-drawn glyph ${JSON.stringify(match[0])}` });
		}
		offenders.push(...dotIsInk(file));
	}
	expect(offenders, `glyph literals in src/tui/features/**:\n${report(offenders)}`).toEqual([]);
});

test("no features module hand-draws a second colour table", () => {
	// A `Record<K, ThemeColor>` outside `palette.ts` is the shape of a private
	// palette: it has no citation, no ladder position and no way to be
	// re-derived when a role moves. This is the form
	// `src/tui/features/traces/render.ts` takes, and it is the one no other
	// check in this suite can see — a lookup through a local table carries no
	// literal at the call site at all, so the use-site scan above never sees it.
	//
	// The second form is shape-based, because a colour table does not have to
	// annotate its type: two or more `"key": "<theme-token>"` siblings inside
	// ONE object literal is a lookup table whatever it is called. One on its own
	// is not — `{ state: "error" }` is a discriminated union member, not a
	// palette — which is why the count is two and not one.
	const TOKENS = "accent|error|success|warning|text|dim|muted|border|borderAccent|borderMuted|toolTitle|toolOutput|mdHeading|mdLink";
	const offenders: Offender[] = [];
	for (const file of featureFiles) {
		const { code, depth } = lexedFor(file);
		const annotation = /Record<\s*[^,>]+\s*,\s*ThemeColor\s*>/g;
		for (let match = annotation.exec(code); match; match = annotation.exec(code)) {
			offenders.push({ where: at(file, match.index), what: `private colour table (${match[0].replace(/\s+/g, " ")})` });
		}
		/** Entries per object-literal depth level: the depth a `{` opens at. */
		const byDepth = new Map<number, number>();
		const entry = new RegExp(`(?:^|[,{]\\s*)(\\w+)\\s*:\\s*"(${TOKENS})"`, "g");
		for (let match = entry.exec(code); match; match = entry.exec(code)) {
			const owner = depth[match.index]!;
			const seen = (byDepth.get(owner) ?? 0) + 1;
			byDepth.set(owner, seen);
			if (seen === 2) {
				offenders.push({
					where: at(file, match.index),
					what: `colour table declared inline: … ${match[1]}: "${match[2]}" … (two or more token entries in one object literal)`,
				});
			}
		}
	}
	expect(offenders, `private colour tables in src/tui/features/**:\n${report(offenders)}`).toEqual([]);
});
