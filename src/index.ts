import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import { STATS_OVERLAY_OPTIONS, StatsPanel } from "./tui/panel";
import { ShowcasePanel } from "./tui/showcase/panel";
import { SHOWCASE_SECTIONS } from "./tui/showcase/spec";

// The omp version this extension was built against. Every `@oh-my-pi/*` import
// below depends on host internals, so a host bump is the one failure mode that
// produces an obscure load failure rather than a clear error. Warn loudly, on
// stderr (stdout is the TUI's), and still load — refusing to load would leave
// the user with a working omp and no explanation.
const PINNED = "18.8.6";

export default function (pi: ExtensionAPI): void {
	if (VERSION !== PINNED) {
		console.error(
			`[stats-tui] built against omp ${PINNED}, host is ${VERSION}`,
		);
	}

	pi.registerCommand("stats-tui", {
		description: "Local usage stats, fullscreen",
		handler: async (_args, ctx) => {
			// `ctx.mode === "tui"`, not `ctx.hasUI`: `hasUI` is true in RPC mode,
			// where `custom()` is implemented as *unsupported UI* and returns
			// `undefined as never` — a promise that never resolves.
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/stats-tui needs an interactive terminal", "warning");
				return;
			}
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new StatsPanel({
						tui,
						theme,
						done: () => done(undefined),
						requestRender: () => tui.requestRender(),
					}),
				{ overlay: true, overlayOptions: STATS_OVERLAY_OPTIONS },
			);
		},
	});
	// `/stats-test` — the SHOWCASE. A fullscreen overlay bound to nothing: it
	// exercises the panel's whole visual grammar on fabricated fixtures, so colour,
	// hierarchy and chart choices can be judged side by side, and so the limits of
	// what `@oh-my-pi/pi-tui` can actually draw are visible rather than assumed.
	//
	// It reads no database and takes no warm handle: a visual playground must
	// remain usable without recorded usage or initialization work.
	pi.registerCommand("stats-test", {
		description: "Showcase: the panel's whole visual grammar on fixtures",
		// An optional section or jump letter: `/stats-test charts`, `/stats-test c`.
		// Costs one lookup, and an argument the panel ignores is an argument the user
		// typed for nothing.
		handler: async (args, ctx) => {
			// The same `ctx.mode === "tui"` guard as `/stats-tui`, and for the same
			// reason: `hasUI` is true in RPC mode, where `custom()` is implemented as
			// *unsupported UI* and returns `undefined as never` — a promise that never
			// resolves, so the command would hang rather than fail.
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/stats-test needs an interactive terminal", "warning");
				return;
			}
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new ShowcasePanel({
						tui,
						theme,
						done: () => done(undefined),
						requestRender: () => tui.requestRender(),
						sectionId: showcaseSectionFrom(args.trim()),
					}),
				{ overlay: true, overlayOptions: STATS_OVERLAY_OPTIONS },
			);
		},
	});
}

/**
 * Which section `/stats-test <arg>` opens, or `undefined` for the first.
 *
 * Accepts a section id, a jump letter, or a label — the three things a reader who
 * has seen one of them would try. An argument that matches none of them yields
 * `undefined`, which the panel treats as "open the first section", because a typo
 * in an argument to a playground should not be an error dialog.
 */
export function showcaseSectionFrom(arg: string): string | undefined {
	if (arg === "") return undefined;
	const lower = arg.toLowerCase();
	const byId = SHOWCASE_SECTIONS.find((section) => section.id === lower);
	if (byId) return byId.id;
	const byLabel = SHOWCASE_SECTIONS.find(
		(section) => section.label.toLowerCase() === lower,
	);
	if (byLabel) return byLabel.id;
	if (lower.length === 1) {
		const byLetter = SHOWCASE_SECTIONS.find(
			(section) => section.hotkey === lower,
		);
		if (byLetter) return byLetter.id;
	}
	return undefined;
}
