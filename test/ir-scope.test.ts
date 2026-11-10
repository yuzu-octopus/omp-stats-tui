/**
 * `test/ir-scope.test.ts` — the IR band stack is a PROBE/TEST FIXTURE.
 *
 * Production `/stats-tui` renders `FeatureController.render()` strings. The
 * `ScreenSpec → renderScreen → renderBands` stack is live ONLY in `/stats-test`
 * (its own showcase specs), `scripts/probe-render.ts`, the panel's fixture
 * branch, and tests — never a production `/stats-tui` body. The label is
 * asserted against the SOURCE TEXT so the three modules cannot quietly start
 * describing themselves as a production render path again, and so the vestigial
 * `custom`/`deferred` fields removed in 4.1/4.3 cannot come back unnoticed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = `${import.meta.dir}/..`;
const IR_MODULES = ["src/layout/spec.ts", "src/layout/resolve.ts", "src/tui/render/screen.ts"] as const;

/** The exact scope sentence the three modules must carry (Task 4.2, verbatim). */
const LABEL =
	"live ONLY for /stats-test (its own showcase specs), scripts/probe-render.ts, the panel's fixture branch, and tests — never a production /stats-tui body";

const read = (file: string): string => readFileSync(`${ROOT}/${file}`, "utf8");

/** Source text as PROSE: comment line prefixes (` * `) removed, whitespace collapsed. */
const flat = (file: string): string =>
	read(file)
		.split("\n")
		.map(line => line.replace(/^\s*\*+\s?/, ""))
		.join(" ")
		.replace(/\s+/g, " ");

test("the three IR modules carry the probe/test-fixture label", () => {
	for (const file of IR_MODULES) {
		// Prose-normalised: the sentence is wrapped across comment lines, so a
		// line-break-aware marker would fail on a rewrap rather than on a removal.
		const prose = flat(file);
		expect(prose, `${file} lost the probe/test-fixture label`).toContain("PROBE/TEST FIXTURE");
		expect(prose, `${file} does not state the IR's live scope`).toContain(LABEL);
	}
});
test("the labelled IR declares no custom band kind and no deferred spec", () => {
	for (const file of [...IR_MODULES, "src/tui/band.ts"]) {
		const source = read(file);
		expect(source, `${file} still declares a custom band`).not.toContain('kind: "custom"');
		expect(source, `${file} still declares a deferred spec`).not.toContain("deferred");
	}
});
