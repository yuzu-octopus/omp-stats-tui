/**
 * Render any screen to stdout at any width, without launching a terminal.
 *
 * This is how a screen gets reviewed. The panel only exists inside an overlay on
 * someone else's terminal, which makes "does this look right" an expensive
 * question to answer; this script makes it a command. It renders the screen's
 * spec through the same `renderScreen` the fixture path uses, with a real
 * `planLayout` and real `glyphsFor`, fetches the screen's declared needs through
 * the same worker boundary the panel uses, and prints the rows.
 *
 * Usage:
 *   bun scripts/probe-render.ts [screenId] [--width N] [--width N] [--range 24h]
 *
 * Defaults to the overview at width 100 and width 60, which is the pair the plan
 * asks for: 100 is the common terminal, 60 is where the layout has to start
 * dropping things.
 */

import type { PanelData } from "../src/data/api";
import { StatsReadClient } from "../src/data/client";
import { RANGES, DEFAULT_RANGE, isRange, type Range } from "../src/data/ranges";
import { SCREEN_SPECS, type ScreenSpec } from "../src/layout/spec";
import { renderScreen } from "../src/tui/render/screen";
import { planLayout } from "../src/tui/layout";
import { glyphsFor } from "../src/tui/glyphs";
import { SERIES_COLORS } from "../src/tui/palette";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { SymbolPreset, ThemeColor } from "@oh-my-pi/pi-tui";

ensureThemeSync();

const args = process.argv.slice(2);
const widths: number[] = [];
let screenId = "overview";
let range: Range = DEFAULT_RANGE;
let preset: SymbolPreset = "unicode";

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--width" || arg === "-w") {
		widths.push(Number(args[++i]));
	} else if (arg === "--range" || arg === "-r") {
		const next = args[i + 1] ?? "";
		if (!isRange(next)) {
			console.error(`unknown range "${next}"; expected one of ${RANGES.join(", ")}`);
			process.exit(1);
		}
		range = next;
		i++;
	} else if (arg === "--preset" || arg === "-p") {
		const next = args[i + 1] ?? "";
		if (next !== "unicode" && next !== "nerd" && next !== "ascii") {
			console.error(`unknown preset "${next}"; expected unicode, nerd or ascii`);
			process.exit(1);
		}
		preset = next;
		i++;
	} else if (!arg.startsWith("-")) {
		screenId = arg;
	} else {
		console.error(`unknown flag ${arg}`);
		process.exit(1);
	}
}

if (widths.length === 0) widths.push(100, 60);

const specs = SCREEN_SPECS;
const known = specs.map(s => s.id);
/**
 * EVERY screen by default, and one screen when named. A reviewer judging whether
 * this now looks like the web dashboard needs all of them side by side: a layout
 * that reads well on one screen and badly on the next is exactly the inconsistency
 * the band grammar exists to prevent, and it is invisible if the probe only ever
 * shows the first screen.
 */
const wanted: readonly ScreenSpec[] =
	screenId === "all"
		? specs
		: specs.filter(spec => spec.id === screenId);
if (wanted.length === 0) {
	console.error(`unknown screen "${screenId}"; expected one of ${known.join(", ")}, all`);
	process.exit(1);
}

const ROWS = 40;

// Use the mounted panel's worker boundary rather than initializing on this thread.
const reads = new StatsReadClient();
const data: PanelData = {};
const timings: string[] = [];
for (const spec of wanted) {
	const started = performance.now();
	Object.assign(data, await reads.fetch(spec.needs, range));
	timings.push(`${spec.id}: ${spec.needs.length} route(s) in ${Math.round(performance.now() - started)}ms`);
}
reads.close();

const now = Date.now();
for (const width of widths) {
	for (const spec of wanted) {
		const plan = planLayout(width, ROWS, preset);
		const rendered = renderScreen({
			spec,
			data,
			plan,
			preset,
			range,
			now,
			fg: (color, text) => theme.fg(color, text),
			bold: text => theme.bold(text),
			palette: theme,
			seriesColorFor: (index): ThemeColor => SERIES_COLORS[index % SERIES_COLORS.length],
			glyphs: glyphsFor(preset),
		});
		const over = rendered.filter(r => Bun.stringWidth(r) > plan.innerWidth);

		console.log(`\n${"═".repeat(width)}`);
		console.log(`${spec.id}  width=${width}  range=${range}  preset=${preset}  inner=${plan.innerWidth}`);
		console.log(`${"─".repeat(width)}`);
		console.log(rendered.join("\n"));
		console.log(`${"─".repeat(width)}`);
		console.log(`${rendered.length} rows${over.length === 0 ? "" : `, ${over.length} OVER WIDE`}`);
	}
}

console.log(`\nfetched ${timings.join(", ")}`);