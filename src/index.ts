import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import { STATS_OVERLAY_OPTIONS, StatsPanel } from "./tui/panel";

// The omp version this extension was built against. Every `@oh-my-pi/*` import
// below depends on host internals, so a host bump is the one failure mode that
// produces an obscure load failure rather than a clear error. Warn loudly, on
// stderr (stdout is the TUI's), and still load — refusing to load would leave
// the user with a working omp and no explanation.
const PINNED = "18.18.2";


export default function (pi: ExtensionAPI): void {
	if (VERSION !== PINNED) {
		console.error(`[stats-tui] built against omp ${PINNED}, host is ${VERSION}`);
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
				// The factory's third argument is the host's STATIC DEFAULT keybindings.
				// It is deliberately ignored: `getKeybindings()` is the user's configured
				// manager and the authoritative source for every `tui.select.*` remap.
				// Extension-local keys (`r`, `s`, `[`, `]`, digits, `g`, `home`, `end`,
				// `ctrl+p/n`, `f2`) are raw and not remappable — see `panelAction`.
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
}
