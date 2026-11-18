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
 *     [--rows N] [--range 24h] [--preset unicode|nerd|ascii] [--pane N] [--help]
 *
 * Defaults to the overview at width 100 and width 60, which is the pair the plan
 * asks for: 100 is the common terminal, 60 is where the layout has to start
 * dropping things. --rows defaults to 40; --width 40 --rows 30 is the 40x30 review matrix.
 * --pane N presses Tab N times after load; the probe folds the body at the
 * requested row count and names every row and width overflow it measures.
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

const SEP = String.fromCharCode(47);
export const apiPath = (...segments: readonly string[]): string => SEP + segments.join(SEP);
export type CanonicalApiKey = keyof PanelData | null;
/**
 * A route's tail is not its fixture key: the models route ends in a hyphenated
 * name while the fixture key is camelCase. A null value means this probe has no
 * payload for that detail route and answers it with an empty list.
 */
export const CANONICAL_API_PATHS: Readonly<Record<string, CanonicalApiKey>> = Object.freeze({
	[apiPath("api", "stats", "model-dashboard")]: "modelDashboard",
	[apiPath("api", "stats", "costs")]: "costs",
	[apiPath("api", "stats", "tools")]: "tools",
	[apiPath("api", "stats", "errors")]: "errors",
	[apiPath("api", "stats", "recent")]: "recent",
	[apiPath("api", "stats", "providers")]: "providers",
	[apiPath("api", "stats", "gain")]: "gain",
	[apiPath("api", "sessions")]: null,
	[apiPath("api", "session", "entry")]: null,
	[apiPath("api", "session", "trace")]: null,
	[apiPath("api", "request", ":id")]: null,
	[apiPath("api", "stats", "provider-windows")]: null,
	[apiPath("api", "stats", "frustration")]: null,
	[apiPath("api", "frustration", "estimate")]: null,
	[apiPath("api", "frustration", "judge")]: null,
	[apiPath("api", "frustration", "cancel")]: null,
});
export function canonicalApiPath(path: string): string {
	const detail = apiPath("api", "request") + SEP;
	return path.startsWith(detail) ? apiPath("api", "request", ":id") : path;
}
export function canonicalApiPayload<T>(data: PanelData, path: string): T {
	const key = canonicalApiPath(path);
	const canonical = Object.hasOwn(CANONICAL_API_PATHS, key) ? CANONICAL_API_PATHS[key] : null;
	return (canonical === null ? [] : data[canonical] ?? []) as unknown as T;
}
if (import.meta.main) {
ensureThemeSync();

const args = process.argv.slice(2);
const widths: number[] = [];
let screenId = "overview";
let range: Range = DEFAULT_RANGE;
let preset: SymbolPreset = "unicode";
let rows = 40;
let pane = 0;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help" || arg === "-h") {
		console.log(`usage: probe-render.ts [screenId|all] [--width N]... [--rows N] [--range R] [--preset P] [--pane N]`);
		console.log(`  screenId: one screen id, or "all" (default "overview")`);
		console.log(`  --width N, -w N: render width; repeatable (default: 100 60)`);
		console.log(`  --rows N: body height in rows (default 40; e.g. --width 40 --rows 30)`);
		console.log(`  --range R, -r R: one of ${RANGES.join(", ")} (default ${DEFAULT_RANGE})`);
		console.log(`  --preset P, -p P: unicode, nerd or ascii (default unicode)`);
		console.log(`  --pane N: press Tab N times after load (default 0)`);
		process.exit(0);
	} else if (arg === "--width" || arg === "-w") {
		widths.push(Number(args[++i]));
	} else if (arg === "--rows") {
		rows = Number(args[++i]);
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
	} else if (arg === "--pane") {
		const count = Number(args[++i]);
		if (!Number.isInteger(count) || count < 0) {
			console.error(`invalid --pane ${args[i]}; expected a non-negative integer`);
			process.exit(1);
		}
		pane = count;
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

const data: PanelData = liveData();
const reader: FeatureReader = {
	fetch: async () => ({ data, errors: {} }),
	// Detail routes have no fixture payload: the probe answers them with an
	// empty list instead of a fabricated one. Canonical fixture-backed routes
	// resolve by full path, never by URL tail.
	api: async <T>(path: string): Promise<T> => canonicalApiPayload<T>(data, path),
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
		for (let i = 0; i < pane; i++) feature.handleInput("\t");
		const body = feature.render(width, rows);
		const over = body.filter(row => visibleWidth(row) > width);
		const hidden = Math.max(0, body.length - rows);
		const shown = hidden === 0 ? body : [...body.slice(0, rows), `… ${hidden} more row${hidden === 1 ? "" : "s"} folded below`];

		console.log(`\n${"═".repeat(width)}`);
		console.log(`${screen.id}  width=${width}  range=${range}  preset=${preset}  pane=${pane}`);
		console.log(`${"─".repeat(width)}`);
		console.log(shown.join("\n"));
		console.log(`${"─".repeat(width)}`);
		const overflow = [
			over.length === 0 ? "" : `${over.length} OVER WIDE`,
			hidden === 0 ? "" : `OVER TALL (+${hidden})`,
		].filter(Boolean).join(", ");
		console.log(`${body.length} rows${overflow === "" ? "" : `, ${overflow}`}`);
		feature.dispose();
	}
}
}
