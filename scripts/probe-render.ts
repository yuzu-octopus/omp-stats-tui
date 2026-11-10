/**
 * Render a production screen body to stdout at any width, without a terminal.
 *
 * This is how a screen gets reviewed. The panel only exists inside an overlay on
 * someone else's terminal, which makes "does this look right" an expensive
 * question to answer; this script makes it a command. It builds the SAME
 * `FeatureContext` the tests use, serves the shared fixture payload from
 * `test/fixtures/panel.ts`, and prints the controller's rendered body.
 *
 * Usage:
 *   bun scripts/probe-render.ts [screenId|all] [--width N] [--width N]
 *     [--range 24h] [--preset unicode|nerd|ascii]
 *
 * Defaults to the overview at width 100 and width 60, which is the pair the plan
 * asks for: 100 is the common terminal, 60 is where the layout has to start
 * dropping things.
 */

import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SymbolPreset } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, setNativeSymbolPreset, theme } from "@oh-my-pi/pi-tui/theme";
import type { PanelData } from "../src/data/api";
import { RANGES, DEFAULT_RANGE, isRange, type Range } from "../src/data/ranges";
import { SCREENS, type ScreenId } from "../src/tui/screens/types";
import { createCoreFeature } from "../src/tui/features/core";
import { createProvidersFeature } from "../src/tui/features/providers";
import { createGainFeature } from "../src/tui/features/gain";
import { createTracesFeature } from "../src/tui/features/traces";
import { createFrustrationFeature } from "../src/tui/features/frustration";
import type { FeatureContext, FeatureController, FeatureReader } from "../src/tui/features/types";
import { FIXTURE_NOW, liveData } from "../test/fixtures/panel";

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

const known = SCREENS.map(screen => screen.id);
/**
 * EVERY screen by default, and one screen when named. A reviewer judging whether
 * this now looks like the web dashboard needs all of them side by side: a layout
 * that reads well on one screen and badly on the next is exactly the inconsistency
 * the shared drawing grammar exists to prevent, and it is invisible if the probe
 * only ever shows the first screen.
 */
const wanted = screenId === "all"
	? SCREENS
	: SCREENS.filter(screen => screen.id === screenId);
if (wanted.length === 0) {
	console.error(`unknown screen "${screenId}"; expected one of ${known.join(", ")}, all`);
	process.exit(1);
}

const ROWS = 40;
const data: PanelData = liveData();
const reader: FeatureReader = {
	fetch: async () => data,
	// The overview's recent list is the one eager API read a screen makes; every
	// other API call is on-demand detail, and the fixture answers it with an empty
	// list rather than a fabricated payload.
	api: async <T>(path: string): Promise<T> =>
		((data as unknown as Record<string, unknown>)[path.split("/").pop() ?? ""] ?? []) as T,
};

function createFeature(id: ScreenId, ctx: FeatureContext): FeatureController {
	return createCoreFeature(id, ctx) ?? (
		id === "providers" ? createProvidersFeature(ctx) :
		id === "gain" ? createGainFeature(ctx) :
		id === "traces" ? createTracesFeature(ctx) :
		createFrustrationFeature(ctx));
}

setNativeSymbolPreset(preset);

for (const width of widths) {
	for (const screen of wanted) {
		const ctx: FeatureContext = {
			reader,
			theme,
			now: () => FIXTURE_NOW,
			changed: () => {},
			copy: async () => {},
			openTrace: () => {},
			openScreen: () => {},
		};
		const feature = createFeature(screen.id, ctx);
		await feature.load(range);
		const rows = feature.render(width, ROWS);
		const over = rows.filter(row => visibleWidth(row) > width);

		console.log(`\n${"═".repeat(width)}`);
		console.log(`${screen.id}  width=${width}  range=${range}  preset=${preset}`);
		console.log(`${"─".repeat(width)}`);
		console.log(rows.join("\n"));
		console.log(`${"─".repeat(width)}`);
		console.log(`${rows.length} rows${over.length === 0 ? "" : `, ${over.length} OVER WIDE`}`);
		feature.dispose();
	}
}
