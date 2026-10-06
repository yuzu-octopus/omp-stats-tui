import { getKeybindings, matchesKey, routeSgrMouseInput, TabBar, type Component, type SgrMouseEvent, type TUI } from "@oh-my-pi/pi-tui";
import { OverlayPanel, PanelDivider, PanelRows } from "@oh-my-pi/pi-tui/chrome";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme as activeTheme, type Theme, type ThemeColor } from "@oh-my-pi/pi-tui/theme";

import type { DataNeed, PanelData } from "../data/api";
import { StatsReadClient } from "../data/client";
import { copyToClipboard } from "@oh-my-pi/pi-natives";
import { createCoreFeature } from "./features/core";
import { createProvidersFeature } from "./features/providers";
import { createGainFeature } from "./features/gain";
import { createTracesFeature } from "./features/traces";
import { createFrustrationFeature } from "./features/frustration";
import type { FeatureContext, FeatureController } from "./features/types";
import type { ReadStage } from "../data/protocol";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";
import { DEFAULT_RANGE, nextRange, type Range } from "../data/ranges";
import type { SyncEvent } from "../sync/client";
import { glyph, glyphsFor, type SymbolPreset } from "./glyphs";
import { statsIcon } from "./icons";
// `MIN_USABLE_WIDTH` floors the narrowed body plan — see `render`.
import { MIN_USABLE_WIDTH, planLayout, type LayoutPlan } from "./layout";
import { SCREENS, screenById, type Screen, type ScreenId } from "./screens/types";
import { isDrawableScreen, specForScreen } from "../layout/spec";
import { renderScreenWith } from "./render/screen";
import {
	JUMP_TIMEOUT_MS,
	chipFor,
	progressLineFor,
	screenForHotkey,
	sidebar,
	topbar,
	type ChromeSync,
} from "./chrome";
import { framePolicy } from "./responsive";
import { TAB_BAR_INDENT, buildTabs, tabBarTheme } from "./tabs";
import { MIN_PANEL_ROWS as FRAME_MIN_PANEL_ROWS, bodyRows } from "./frame";
import { footerHints, hintsFor, type HintMode, type PanelHint } from "./footer";
import { hitTest, type MouseFrame } from "./mouse";

/**
 * THE MOUNT SEAM.
 *
 * Everything above the class is data, layout or charts. Everything below is the
 * part no unit test can reach, and the header comment of test/panel.test.ts
 * lists what a human has to check for it by hand.
 *
 * Three measured facts decide the shape of this file:
 *
 *  1. `render(width)` is a pure function of state, so the frame budget, the
 *     scroll clamp, the loading/error split and the whole keymap are testable
 *     without a terminal. Every invariant below is checked through that.
 *  2. Height comes from `tui.terminal.rows` on EVERY frame, because there is no
 *     resize hook. Scroll is therefore clamped inside `render` and never in the
 *     key handler, which makes shrink-on-resize automatic instead of a second
 *     code path that has to be remembered.
	 *  3. Database initialization and reads run in a persistent standalone Bun
	 *     process. The loading state keeps the host thread free for input/rendering.
 */

/**
 * Copied, not imported, from
 * `pi-coding-agent/src/extensibility/custom-commands/bundled/annotate/fullscreen.ts:13-20`.
 * Eight lines of constants; importing a private extension's constant couples
 * this project to that file's layout.
 *
 * `fullscreen: true` is NOT optional. It borrows the terminal's alternate screen
 * buffer — the same `?1049h` mechanism `btop` and `bottom` use — which is what
 * stops a full-height panel from fighting the transcript for the last row and
 * the last column. Mouse tracking stays on the host default: while a fullscreen
 * overlay holds the alt screen the engine emits `1000h/1003h/1006h`, so clicks,
 * wheel and motion arrive as SGR text on stdin, which `routeSgrMouseInput`
 * understands and the editor behind the overlay does not — a click cannot leak
 * through to it. `/settings` and `/usage` rely on the same default; opting out
 * would cost clicks and hover, not just the wheel.
 */
export const STATS_OVERLAY_OPTIONS = {
	anchor: "top-left",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
} as const;

/**
 * Rows `OverlayPanel` actually draws around the body: top border, header,
 * divider, footer, bottom border. Counted from `OverlayPanel.render` rather
 * than from `layout.ts`'s advisory `CHROME_ROWS`, so the claim about the frame
 * and the frame itself cannot drift apart.
 */
const PANEL_CHROME_ROWS = 5;

/** The shortest terminal the panel will paint: the chrome plus one body row. */
export const MIN_PANEL_ROWS = FRAME_MIN_PANEL_ROWS;

/**
 * Shortest terminal that still gets the full grouped sidebar: its eleven nav
 * rows (three headings + eight screens) plus the topbar, the divider, the
 * footer, one body row and the two borders. Below this the sidebar degrades to
 * the one-row icon rail rather than overflowing the frame.
 */
const MIN_SIDEBAR_ROWS = 20;
/**
 * Past this many dirty hours the host stops unioning dirty hours with the
 * facts and returns stale rows with holes in them, so the chrome escalates from
 * "pending" to a warning. The number is the host's, quoted from the
 * `RollupStatus` doc in src/data/api.ts; it is a named constant because a bare
 * 96 in a comparison reads as a typo the moment someone edits one side of it.
 */
export const EXACT_DIRTY_LIMIT = 96;


const NO_ROWS: readonly string[] = [];



/** The fetch the panel drives, narrowed so a test can answer with fixtures. */
export type PanelFetch = (needs: readonly DataNeed[], range: Range) => Promise<PanelData>;

/** Which of the three states the panel is in. Never inferred from empty data. */
export type PanelPhase = "loading" | "ready" | "error";

export interface StatsPanelOptions {
	tui: TUI;
	theme: Theme;
	/** Resolves the mount's promise. At most once, only from the close path. */
	done: () => void;
	/** Defaults to `tui.requestRender()`. Injected so a test can count repaints. */
	requestRender?: () => void;
	/** Production reads run in a cancellable standalone worker. */
	fetch?: PanelFetch;
	/** Opening range. Defaults to the closed set's own default. */
	range?: Range;
	/** Opening screen. Defaults to the first selectable one. */
	screenId?: ScreenId;
	/** Test seam for terminal height; production reads `tui.terminal.rows`. */
	rows?: number;
	/** Test seam for the chart's time axis; production reads the wall clock. */
	now?: () => number;
}

/**
 * What one keystroke means. Exported and pure so the entire key surface is
 * testable without a terminal; `handleInput` below only applies the result.
 */
export type PanelAction =
	| { type: "close" }
	| { type: "scroll"; rows?: number; viewport?: 1 | -1 }
	| { type: "scrollTo"; edge: "top" | "bottom" }
	| { type: "screen"; by: 1 | -1 }
	| { type: "screenIndex"; index: number }
	| { type: "screenId"; id: string }
	| { type: "armJump" }
	| { type: "noop" }
	| { type: "range"; by: 1 | -1 }
	| { type: "sync" };


/**
 * The IR spec for a screen id, or `undefined` when the registry has no spec.
 *
 * A named delegation rather than an inline `SCREEN_SPECS.find`, so the lookup and
 * the drawability predicate below are stated side by side in one place: they are
 * two questions about the same table, and the second is derived from the first.
 */
export function specById(id: ScreenId) {
	return specForScreen(id);
}

/**
 * The screens a key can land on, in the order the DIGIT ROW uses — which is the
 * registry's own order and deliberately NOT the sidebar's, because the two answer
 * different questions (`1`-`9`/`0` index this list; the nav is grouped for
 * reading). Order is part of this constant's contract and is not derived from
 * `NAV_GROUPS`.
 *
 * `excluded` stays, and stays the registry's own call: a tab that says "excluded
 * from the port" is a real answer, but arrowing onto it wastes a keystroke.
 *
 * "Drawable" is NOT decided here. This filter asks {@link isDrawableScreen} — the
 * same predicate `NAV_GROUPS` uses — so the number row and the sidebar cannot
 * disagree about which screens exist. That duplication is what
 * `test/screens.test.ts` now pins shut.
 *
 * TWELVE SCREENS, TEN DIGITS — and that is the design, not a conflict. PR #1
 * added `traces` and `frustration`, taking this registry to twelve while the
 * digit row stays at ten keys, because there is no eleventh digit. The row is
 * therefore positional and covers the FIRST TEN entries of this list; the last
 * two are digitless by construction.
 *
 * What holds for every screen here, and is enforced in
 * `test/chrome.test.ts`'s number-row block, is three things — not "every screen
 * has a digit", which is unsatisfiable at twelve and only ever yields a red
 * build:
 *
 *   - every digit is live and indexes a DISTINCT screen in this order;
 *   - every screen PAST the row is reachable by the arrows, by `tab` /
 *     `shift+tab`, and by its `g` jump letter;
 *   - the count of digitless screens is pinned, so a thirteenth screen fails
 *     deliberately instead of quietly lengthening the tab-only tail.
 *
 * Adding a screen to this registry therefore forces one of three decisions:
 * extend the row (move `DIGITS` here AND the `DIGIT_KEYS` mirror in that test,
 * which must move together), drop a screen, or raise the pinned count on
 * purpose. Dropping is not a silent option — every affordance above reads this
 * same list, so removing an entry also removes the screen from the tab strip,
 * the sidebar and arrow cycling.
 */
export const SELECTABLE_SCREENS: readonly Screen[] = SCREENS.filter(
	screen => isDrawableScreen(screen.id) && screen.status !== "excluded",
);

/**
 * Translate one input into one action, or null for a key this panel does not
 * own. Null matters as much as any mapping: swallowing an unowned key would
 * silently eat typing the user expected to reach the editor behind.
 *
 * The ORDER is load-bearing and it is the order `usage-dashboard.ts:1367-1405`
 * uses. The mouse router first, because its escape prefix swallows real keys;
 * then cancel, so a remapped cancel still closes; then the literal letters;
 * then the arrows and tab; then the digits.
 *
 * Selector actions resolve through `getKeybindings()`, the host's configured
 * module-global manager. Raw keys use `matchesKey`. The manager passed to the
 * custom factory is deliberately not used: it contains only static defaults.
 */

/**
 * Screen shortcuts. `1`-`9` for the first nine, `0` for the tenth — the
 * convention every numbered overlay uses, because there is no eleventh digit.
 * `screenIndex` resolves through `SELECTABLE_SCREENS` in this order, so digit
 * N is `SELECTABLE_SCREENS[N]` and nothing else.
 *
 * WHAT THIS LIST PROMISES. Ten keys against twelve drawable screens, so the row
 * is a deliberate SHORT row, not a gap. `SELECTABLE_SCREENS[10]` and `[11]` —
 * `traces` and `frustration` — have no digit and none is invented. Every
 * affordance except the number row reaches them: `←`/`→`, `tab`/`shift+tab`,
 * `[`/`]`, `g t`/`g f`, the sidebar, and the mouse.
 *
 * WHERE THAT IS ENFORCED. `test/chrome.test.ts`'s number-row block is the one
 * place, and it asserts the three properties that actually hold:
 *
 *   - each digit here is live and indexes a DISTINCT `SELECTABLE_SCREENS`
 *     entry (it reads this row from its own ten-key mirror, since `DIGITS` is
 *     module-private — the two lists must change together);
 *   - each digitless screen is reachable by the arrows, by `tab`, and by
 *     pressing `g` then its jump letter, driven through a real panel;
 *   - the COUNT of digitless screens is pinned, so growing the registry past
 *     twelve fails on purpose rather than quietly extending the tab-only tail.
 *
 * It deliberately does NOT assert `SELECTABLE_SCREENS.length <= 10`: that
 * invariant is unsatisfiable here, and a permanently red assertion trains
 * everyone to ignore red. See the handover note on `SELECTABLE_SCREENS` for
 * what a thirteenth screen forces someone to decide.
 */
const DIGITS: readonly string[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

/** Global fallback keys; focused controllers consume row/chart/search keys first. */


export function panelAction(data: string, jumpArmed = false): PanelAction | null {
	// Wheel-only: clicks and motion route through `#routeMouse`, which needs
	// the last frame's geometry. The wheel needs none — it scrolls the body
	// from anywhere, exactly like `usage-dashboard.ts:1369-1373` (`wheel * 2`).
	let wheel: number | null = null;
	if (
		routeSgrMouseInput(data, event => {
			if (event.wheel === null) return false;
			wheel = event.wheel;
			return true;
		})
	) {
		return wheel === null || wheel === 0 ? null : { type: "scroll", rows: wheel * 2 };
	}
	// The `g` prefix (Shell.tsx parity): while armed, a single letter is
	// CONSUMED — a jump on match, a no-op otherwise — so `g r` jumps and never
	// cycles the range and `g s` never syncs. Resolution lives in chrome.ts.
	if (jumpArmed && data.length === 1) {
		const id = screenForHotkey(data);
		return id === null ? { type: "noop" } : { type: "screenId", id };
	}
	if (getKeybindings().matches(data, "tui.select.cancel") || matchesKey(data, "q")) return { type: "close" };
	if (data === "g" || data === "G") return { type: "armJump" };
	// Explicit host selector overrides take precedence over optional screen shortcuts.
	if (getKeybindings().matches(data, "tui.select.up")) return { type: "scroll", rows: -1 };
	if (getKeybindings().matches(data, "tui.select.down")) return { type: "scroll", rows: 1 };
	if (getKeybindings().matches(data, "tui.select.pageUp")) return { type: "scroll", viewport: -1 };
	if (getKeybindings().matches(data, "tui.select.pageDown")) return { type: "scroll", viewport: 1 };
	if (data === "[" || matchesKey(data, "ctrl+p")) return { type: "screen", by: -1 };
	if (data === "]" || matchesKey(data, "ctrl+n")) return { type: "screen", by: 1 };
	if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) return { type: "screen", by: -1 };
	if (matchesKey(data, "right") || matchesKey(data, "tab")) return { type: "screen", by: 1 };
	// The RANGE cluster, on the keys that are called range. Nothing is left over
	// to carry it after the arrows went back to screens, which is the point: no
	// key in this map means two things.
	if (matchesKey(data, "shift+r")) return { type: "range", by: -1 };
	if (matchesKey(data, "r")) return { type: "range", by: 1 };
	if (matchesKey(data, "s")) return { type: "sync" };
	const digit = DIGITS.indexOf(data);
	if (digit !== -1) return { type: "screenIndex", index: digit };
	if (matchesKey(data, "home")) return { type: "scrollTo", edge: "top" };
	if (matchesKey(data, "end")) return { type: "scrollTo", edge: "bottom" };
	return null;
}

// ---------------------------------------------------------------------------
/**
 * Panel state, held in a module-level WeakMap rather than in `#private` fields.
 *
 * This is the test seam, and it is deliberately not a set of public getters:
 * a debugger surface invites production code to read it. The class reaches
 * state through `STATE.get(this)` exactly as `__testing` does, so the two can
 * never disagree about what "the current range" means.
 */
interface PanelState {
	range: Range;
	screenId: ScreenId;
	/** `Date.now()` when `g` armed the section jump, else 0 (Shell.tsx `pendingG` parity). */
	jumpArmedAt: number;
	scroll: number;
	maxScroll: number;
	data: PanelData | null;
	error: string | null;
	identity: string;
	generation: number;
	readStage: ReadStage;
	closed: boolean;
	done: boolean;
	syncEvent: SyncEvent | null;
	/** Wall clock of the last settled sync, for the Live chip's relative age (`s`/`done`). */
	lastSyncedAt: number | null;
	syncError: string | null;
	/** `done()` calls so far. The mount promise must resolve exactly once. */
	doneCalls: number;
	/** Screen id under the pointer, or null. Painted with the host's `hoverTab` token. */
	hoveredSidebarId: string | null;
	/** Strip tab under the pointer, mirrored from the TabBar (which keeps its own private). */
	hoveredStripId: string | null;
	/** Last frame's geometry for the mouse router. Null until the first render. */
	mouse: MouseFrame | null;
	/** Last frame's outputs, untruncated, so a test reads what was composed. */
	source: readonly string[];
	chart: readonly string[];
	header: string;
	title: string;
}

const STATE = new WeakMap<StatsPanel, PanelState>();

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export class StatsPanel implements Component {
	readonly #options: StatsPanelOptions;
	readonly #tui: TUI;
	#theme: Theme;
	readonly #panel: OverlayPanel;
	readonly #tabBar: TabBar;
	readonly #header: PanelRows;
	readonly #body: PanelRows;
	readonly #footer: PanelRows;
	readonly #state: PanelState;
	readonly #reads = new StatsReadClient();
	readonly #features = new Map<ScreenId, FeatureController>();
	#featureContext: FeatureContext | undefined;
	#traceOrigin: ScreenId | undefined;
	#liveStatus: LiveStatus | undefined;
	#refreshTimer: Timer | undefined;

	constructor(options: StatsPanelOptions) {
		this.#options = options;
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#state = {
			range: options.range ?? DEFAULT_RANGE,
			screenId: options.screenId ?? (SELECTABLE_SCREENS[0]?.id ?? "overview"),
			jumpArmedAt: 0,
			scroll: 0,
			maxScroll: 0,
			data: null,
			error: null,
			identity: "",
			generation: 0,
			readStage: "initializing",
			closed: false,
			done: false,
			syncEvent: null,
			lastSyncedAt: null,
			syncError: null,
			doneCalls: 0,
			hoveredSidebarId: null,
			hoveredStripId: null,
			mouse: null,
			source: NO_ROWS,
			chart: NO_ROWS,
			header: "",
			title: "Stats",
		};
		STATE.set(this, this.#state);

		this.#panel = new OverlayPanel("Stats", "omp.overlay.stats");
		this.#tabBar = new TabBar("", [], tabBarTheme(this.#theme));
		// The strip folds its own hints into the footer, so it must not spend a
		// cell on `(tab to cycle)`.
		this.#tabBar.showHint = false;
		this.#header = new PanelRows();
		this.#header.setHeight(1);
		this.#body = new PanelRows();
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);

		// The worker owns initialization and synchronous queries; rendering never waits.
		if (!options.fetch) this.#reads.subscribe(status => {
			if (this.#state.closed) return;
			const previous = this.#liveStatus;
			this.#liveStatus = status;
			this.#state.lastSyncedAt = status.sync.lastSyncedAt;
			this.#state.syncError = status.sync.error;
			this.#state.syncEvent = status.sync.phase === "syncing"
				? { type: "progress", phase: "ingest", current: status.sync.current, total: status.sync.total } : null;
			if (previous && (previous.version !== status.version ||
				previous.sync.lastSyncedAt !== status.sync.lastSyncedAt)) this.#load();
			this.#changed();
		}, error => {
			if (this.#state.closed) return;
			this.#state.syncEvent = null;
			this.#state.syncError = error.message;
			this.#changed();
		});
		this.#load();
	}

	// --- load ----------------------------------------------------------------

	/**
	 * `rollupStatus` is requested on EVERY load, whatever the screen declares.
	 * It is the only read that refuses to answer when the database was never
	 * initialised, and that refusal is the whole difference between "no usage
	 * in this window" and "the panel has no idea". Every other read degrades to
	 * `[]` or to zeroes silently, which is why the panel must never be allowed
	 * to reach that state unannounced.
	 */
	#needs(): readonly DataNeed[] {
		// The SPEC's needs, or the registry's when no spec exists — never a
		// hand-maintained map beside them, which is the shim this replaced.
		const declared = specById(this.#state.screenId)?.needs ?? screenById(this.#state.screenId).needs;
		return declared.includes("rollupStatus") ? declared : [...declared, "rollupStatus"];
	}

	#feature(): FeatureController | undefined {
		if (this.#options.fetch) return undefined;
		const id = this.#state.screenId;
		let feature = this.#features.get(id);
		if (feature) return feature;
		const ctx = this.#featureContext ??= {
			reader: this.#reads, theme: this.#theme, changed: () => this.#changed(),
			copy: async text => { copyToClipboard(text); },
			now: () => this.#options.now?.() ?? Date.now(),
			openScreen: target => this.#selectScreen(this.#indexOf(target as ScreenId)),
			backToOrigin: () => {
				const origin = this.#traceOrigin;
				if (!origin) return false;
				this.#traceOrigin = undefined;
				this.#selectScreen(this.#indexOf(origin));
				return true;
			},
			openTrace: (file, entryId) => {
				if (this.#state.screenId !== "traces") this.#traceOrigin = this.#state.screenId;
				this.#selectScreen(this.#indexOf("traces"));
				void this.#feature()?.openTrace?.(file, entryId);
			},
		};
		feature = createCoreFeature(id, ctx) ?? (
			id === "providers" ? createProvidersFeature(ctx) :
			id === "gain" ? createGainFeature(ctx) :
			id === "traces" ? createTracesFeature(ctx) :
			id === "frustration" ? createFrustrationFeature(ctx) : undefined);
		if (feature) this.#features.set(id, feature);
		return feature;
	}

	#load(): void {
		const state = this.#state;
		if (state.closed) return;
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		const identity = `${state.screenId}:${state.range}`;
		// A different question invalidates the old answer, so the panel says
		// "loading" rather than painting one window's numbers under another's
		// heading. A reload of the SAME question keeps the last frame up instead
		// of flashing empty at the user.
		if (identity !== state.identity) {
			state.identity = identity;
			state.data = null;
			state.error = null;
			state.scroll = 0;
		}
		state.generation++;
		const generation = state.generation;
		LOADS.set(
			this,
			(async () => {
				try {
					const range = state.range;
					const feature = this.#feature();
					await feature?.load(range);
					if (this.#superseded(generation)) return;
					const needs = feature ? ["rollupStatus"] as const : this.#needs();
					const data = this.#options.fetch
						? await this.#options.fetch(needs, range)
						: await this.#reads.fetch(needs, range, stage => {
							if (this.#superseded(generation)) return;
							state.readStage = stage;
							this.#changed();
						});
					if (this.#superseded(generation)) return;
					state.data = data;
					state.error = null;
				} catch (error) {
					if (this.#superseded(generation)) return;
					// Initialization/read failures are not empty usage.
					const diagnostic = error instanceof Error ? error.message : String(error);
					if (state.data) state.syncError = diagnostic;
					else state.error = diagnostic;
				} finally {
					if (!this.#superseded(generation)) {
						this.#changed();
						if (!this.#options.fetch) this.#refreshTimer = setTimeout(() => {
							this.#refreshTimer = undefined;
							this.#load();
						}, state.screenId === "traces" ? 1_000 : 30_000);
					}
				}
			})(),
		);
	}

	/** A superseded load must not write state, repaint, or move the phase. */
	#superseded(generation: number): boolean {
		return this.#state.closed || generation !== this.#state.generation;
	}

	#changed(): void {
		(this.#options.requestRender ?? (() => this.#tui.requestRender()))();
	}

	// --- live sync -----------------------------------------------------------

	#beginSync(): void {
		const state = this.#state;
		if (state.closed) return;
		void this.#reads.requestSync().catch(error => {
			if (state.closed) return;
			state.syncError = error instanceof Error ? error.message : String(error);
			this.#changed();
		});
	}


	// --- render --------------------------------------------------------------

	/** The live worker owns the sync phase and counters for the topbar. */
	#chromeSync(): ChromeSync {
		const state = this.#state;
		const sync = this.#liveStatus?.sync;
		return {
			syncing: sync?.phase === "syncing",
			current: sync?.current ?? 0,
			total: sync?.total ?? 0,
			determinate: sync?.phase === "syncing" && sync.total > 0,
			error: state.syncError,
			dirtyHours: state.data?.rollupStatus?.dirtyHours ?? 0,
			live: this.#options.fetch ? false : this.#liveStatus !== undefined,
			lastSyncedAt: state.lastSyncedAt,
			now: this.#options.now?.() ?? Date.now(),
		};
	}

	render(width: number): readonly string[] {
		const state = this.#state;
		const rows = this.#options.rows ?? this.#tui.terminal.rows ?? 40;
		if (!this.#options.fetch && activeTheme && this.#theme !== activeTheme) {
			this.#theme = activeTheme;
			if (this.#featureContext) this.#featureContext.theme = activeTheme;
		}
		// The one and only `getSymbolPreset()` read in this feature. Every path
		// below receives the preset; none of them branch on it.
		const preset = this.#theme.getSymbolPreset();
		const policy = framePolicy(width);
		const innerWidth = Math.max(1, width - 4);

		const dirty = state.data?.rollupStatus?.dirtyHours ?? 0;
		// Above the host's exact limit the union stops happening, so this is no
		// longer "pending" — it is holes in the numbers below.
		const freshness =
			dirty > 0
				? this.#theme.fg(
						dirty > EXACT_DIRTY_LIMIT ? "warning" : "dim",
						`${dirty} dirty ${dirty === 1 ? "hour" : "hours"}`,
					)
				: "";
		state.header = freshness;

		// THE TOPBAR is the chrome's first row (web parity: Shell.tsx's fixed
		// topbar), plus the thin progress line while a sync streams — the bar the
		// web paints under that topbar. The tab strip is NOT gone: below the
		// sidebar's width it becomes the nav row (see below).
		const chip = this.#phase() === "error"
			? this.#theme.fg("error", `${this.#theme.symbol("status.error")} Read failed`)
			: chipFor(this.#theme, this.#chromeSync());
		const top = topbar(this.#theme, { range: state.range, chip, freshness, innerWidth });
		const progress = progressLineFor(state.syncEvent, innerWidth);
		const topLines = progress === "" ? [top] : [top, progress];

		// WIDE GETS THE SIDEBAR COLUMN; EVERYTHING NARROWER GETS THE STRIP.
		// The web's medium band keeps a 64px icon rail beside the panel, but in a
		// terminal that rail is a whole column of width spent on one row of
		// glyphs, and the strip ALREADY collapses itself to those same one-cell
		// `TAB_SHORT` forms when the width runs out (`TabBar`'s collapse order,
		// measured by `TAB_ROWS`). One rule, no second nav grammar.
		//
		// A terminal shorter than the chrome keeps NO nav row at all: a row the
		// frame cannot afford pushes the bottom border off the screen, which is
		// the one failure a `render(width)`-only assertion never catches.
		const spec = specById(state.screenId);
		const column = policy.sidebar === "full" && rows >= MIN_SIDEBAR_ROWS;
		let strip: readonly string[] = NO_ROWS;
		if (!column && spec !== undefined && rows > MIN_PANEL_ROWS) {
			const tabs = buildTabs(preset, this.#theme, spec.id);
			const stripWidth = Math.max(1, width - TAB_BAR_INDENT);
			// A narrow viewport shows the active route and its neighbours, not two
			// rows of twelve anonymous icons. Keyboard jumps/cycling retain all routes.
			const count = stripWidth < 16 ? 1 : stripWidth < 32 ? 3 : stripWidth < 60 ? 5 : tabs.length;
			const active = tabs.findIndex(tab => tab.id === spec.id);
			const start = Math.max(0, Math.min(tabs.length - count, active - Math.floor(count / 2)));
			this.#tabBar.setTabs(count === tabs.length ? tabs : tabs.slice(start, start + count), spec.id);
			strip = this.#tabBar.render(stripWidth);
		}
		const nav = column ? sidebar(this.#theme, preset, state.screenId, state.hoveredSidebarId) : null;
		const sidebarWidth = nav?.width ?? 0;
		// The routers hit-test against THIS frame, exactly as `/settings` reads
		// its `#tabRowStart` bookkeeping: strip zones come from the `TabBar`'s
		// own last render, sidebar rows from `NAV_GROUPS`, range segments from
		// the stripped topbar row.
		const tabBar = this.#tabBar;
		state.mouse = {
			topbarRows: topLines.length,
			stripRows: strip.length,
			sidebarWidth: column ? sidebarWidth : 0,
			sidebarRows: column ? (nav?.lines.length ?? 0) : 0,
			topbar: stripAnsi(top),
			tabAt: (line, col) => tabBar.tabAt(line, col)?.id,
		};

		// `bodyRows` is the same one row arithmetic `/settings` uses: one for the
		// chrome row that replaced the header, one more per wrap.
		const headerLines = [...topLines, ...strip];
		const body = bodyRows(rows, headerLines.length);
		// THE BODY IS PLANNED AT THE WIDTH IT WILL BE DRAWN IN. When a nav column
		// exists it is zipped BESIDE the body by `#zipSidebar`, whose prefix is
		// `sidebarWidth + 3` cells — the sidebar, a space, the gutter, a space. The
		// plan used the overlay's full inner width anyway, so every body row was
		// drawn wider than the room it had and `PanelRows` truncated the excess:
		// 21 cells lost off the right of every line, which is where the stray `…`
		// at the end of the stat rows came from.
		//
		// The number is the ZIP'S OWN prefix width, not a guessed gutter — the
		// plan and the composition have to agree on it, or the same cut returns at
		// a different size. `band.ts` treats `plan.innerWidth` as a hard ceiling
		// and responds by DROPPING COLUMNS BY PRIORITY rather than overflowing,
		// so narrowing here degrades honestly instead of silently clipping.
		//
		// `Math.max(MIN_USABLE_WIDTH, …)`: a terminal narrower than the nav would
		// otherwise plan a negative inner width. Only the BODY plan narrows —
		// `this.#panel.render(width)` still gets the raw width, and the progress
		// line above already used the full inner width, because both are chrome
		// rows and both stay full-bleed.
		const sidebarCols = column ? sidebarWidth + 3 : 0;
		const plan = { ...planLayout(Math.max(MIN_USABLE_WIDTH, width - sidebarCols), rows, preset), bodyRows: body };

		// The BODY is the only thing that scrolls, and it is sliced as plain
		// full-width lines. The nav column is attached AFTER the slice
		// (`#zipSidebar`), which is what pins it: a frame region recomputed from
		// width and screen must never be a function of scroll. It used to be
		// zipped in here, which put the nav inside the scrolled document and made
		// `Usage` and `Overview` scroll off the top of the frame.
		state.source = this.#bodyLines(plan, preset);
		state.maxScroll = Math.max(0, state.source.length - plan.bodyRows);
		// Clamped HERE, not in the key handler, so a terminal that shrank
		// between two keypresses cannot leave the view scrolled past its end.
		state.scroll = Math.max(0, Math.min(state.scroll, state.maxScroll));

		// THE TITLE ANSWERS "WHICH PAGE", NEVER "WHICH WINDOW". It used to read
		// `Stats · <range>` while the topbar one row below carried the
		// `omp/stats` wordmark AND the range's active pill — so the window was
		// named twice and the page was named nowhere, which is why the two
		// chrome regions read as one awkward block.
		//
		// The range is not lost by moving it: the topbar's segmented control
		// shows the active window in every mode down to `minimal`, which keeps
		// `brand + active range` (chrome.ts's topbar). Host parity for the shape
		// is `/usage`, whose panel title is `Usage · Details` — panel, then
		// section (usage-dashboard.ts:913).
		state.title = `Stats · ${spec?.label ?? "Overview"}`;
		this.#panel.title = state.title;
		this.#header.setLines(headerLines);
		this.#header.setHeight(headerLines.length);
		const visible = state.source.slice(state.scroll, state.scroll + plan.bodyRows);
		this.#body.setLines(nav === null ? visible : this.#zipSidebar(visible, nav.lines, sidebarWidth, preset));
		// At least as tall as the nav: `#zipSidebar` may have added rows to keep the
		// whole nav visible, and `setHeight` would clip them straight back off.
		this.#body.setHeight(Math.max(plan.bodyRows, nav?.lines.length ?? 0));
		this.#footer.setLines([this.#footerLine(plan, innerWidth)]);
		return this.#panel.render(width);
	}

	#phase(): PanelPhase {
		const state = this.#state;
		if (state.error !== null) return "error";
		return state.data !== null ? "ready" : "loading";
	}

	/**
	 * The BODY's lines, at full width, with NO nav column attached.
	 *
	 * It used to take the sidebar and zip it in here (`${side} ${gutter} ${line}`),
	 * which put the nav inside the list `render` slices by scroll — so scrolling
	 * the body scrolled the nav with it and `Usage` / `Overview` walked off the
	 * top of the frame. The nav is a FRAME region: it is recomputed every render
	 * from the current width and screen, and must never be a function of scroll.
	 * So the composition moved to {@link zipSidebar}, which runs on the SLICED
	 * window rather than on the source.
	 */
	#bodyLines(plan: LayoutPlan, preset: SymbolPreset): readonly string[] {
		const state = this.#state;
		const phase = this.#phase();
		state.chart = NO_ROWS;
		if (phase === "loading") return loadingLines(this.#theme, state.readStage);
		if (phase === "error") return errorLines(this.#theme, preset, state.error ?? "", state.syncError)
			.flatMap(line => wrapTextWithAnsi(line, plan.innerWidth));

		const data = state.data as PanelData;
		const notices: string[] = [];
		if (state.syncError) notices.push(this.#theme.fg("warning",
			`Stats service failed; retained cached data. ${stripTerminalSequences(state.syncError)}`));
		if (data.freshness?.pendingSessions) {
			notices.push(this.#theme.fg("warning",
				`${data.freshness.pendingSessions} transcript files have un-ingested changes. Press s to sync.`));
		}
		if (data.freshness?.records === 0) {
			notices.push(this.#theme.fg("muted", data.freshness.pendingSessions
				? "No ingested requests yet; this is not measured zero usage."
				: "No recorded requests found."));
		}
		if (data.recent && state.screenId === "requests") {
			notices.push(this.#theme.fg("muted",
				`Loaded ${data.recent.length} requests in the selected range${data.recent.length === 50
					? "; latest 50 may not cover the complete range." : "."}`));
		}
		if (data.freshness?.records === 0 && data.freshness.pendingSessions > 0) {
			return notices.flatMap(line => wrapTextWithAnsi(line, plan.innerWidth));
		}
		const feature = this.#feature();
		if (feature) {
			const noticeLines = notices.flatMap(line => wrapTextWithAnsi(line, plan.innerWidth));
			return [...noticeLines, ...feature.render(plan.innerWidth, Math.max(1, plan.bodyRows - noticeLines.length))];
		}
		const spec = specById(state.screenId);
		// Pure IR fixtures/probes use declarative layouts; production controllers render above.
		if (!spec) return [this.#theme.fg("muted", `No layout spec for "${state.screenId}".`)];
		const rendered = renderScreenWith({
			spec,
			data,
			plan,
			preset,
			range: state.range,
			now: this.#options.now?.() ?? Date.now(),
			fg: (color, text) => this.#theme.fg(color, text),
			bold: text => this.#theme.bold(text),
			palette: this.#theme,
			seriesColorFor: index => this.#seriesColor(index),
			glyphs: glyphsFor(preset),
		});
		// The chart rows the IR composed, kept for the tests that assert cost
		// scaling against the REAL frame. The charts are the IR's now, so this
		// captures what the screen drew rather than keeping a second local chart.
		state.chart = rendered.chart;
		if (!state.syncError && notices.length === 0) return rendered.lines;
		return [
			...(state.syncError ? [
				this.#theme.fg("error", "Background sync failed"),
				...wrapTextWithAnsi(stripTerminalSequences(state.syncError), plan.innerWidth)
					.map(line => this.#theme.fg("warning", line)),
				"",
			] : []),
			...notices.flatMap(line => wrapTextWithAnsi(line, plan.innerWidth)),
			...(notices.length ? [""] : []),
			...rendered.lines,
		];
	}

	/**
	 * Put the nav column beside a window of body rows: sidebar row first, a DIM
	 * column bar between them, body row after. The bar copies the split layout's
	 * `theme.hint("│ ")` (settings-list.ts:989): it is the one vertical in the
	 * body, and G5 bans full-width rules, not columns.
	 *
	 * DIVERGENCE (deliberate, noted): the host draws no gutters around the
	 * outer frame — OverlayPanel's `row()` already insets both sides — so only
	 * this inner column carries the bar. The mark comes from
	 * glyph(preset, "columnGap") — "│" under unicode/nerd, "|" under ascii
	 * (glyphs.ts:58,80; never theme.symbol("sep.pipe"), which measures 3 cells)
	 * — so the gutter matches the frame it sits in on every preset.
	 * CALLED ON THE SLICED WINDOW, never on the source. That is what pins it:
	 * the nav is frame chrome, so zipping it after the slice means `index` here is
	 * the BODY's visible row rather than its document row.
	 *
	 * THE NAV SETS A FLOOR ON THE FRAME, NEVER THE OTHER WAY ROUND. This used to
	 * map over `bodyRows` alone, which made the nav column exactly as tall as the
	 * body happened to be — so a screen with a short body silently DROPPED the
	 * bottom of the nav. That is a function of the BODY, and the nav is not the
	 * body's: `gain` is the last row of the nav and `overview` has a 50-line body
	 * against `gain`'s 12, so arrowing from overview to gain made the entire
	 * active marker disappear — the nav appeared to jump to a screen it never
	 * showed. It is the same class of defect as zipping the nav before the slice,
	 * which put `Usage` and `Overview` in the scrolled document.
	 *
	 * THE RULE: a screen reachable by arrow key must be visible in the frame you
	 * reach it from. So the frame is at least `max(body rows, nav lines)` tall and
	 * the body is padded with blanks to fill — never the nav clipped to fit.
	 */
	#zipSidebar(
		bodyRows: readonly string[],
		sidebarLines: readonly string[],
		sidebarWidth: number,
		preset: SymbolPreset,
	): readonly string[] {
		const gutter = this.#theme.fg("dim", glyph(preset, "columnGap"));
		const height = Math.max(bodyRows.length, sidebarLines.length);
		return Array.from({ length: height }, (_, index) => {
			const side = index < sidebarLines.length ? sidebarLines[index]! : " ".repeat(sidebarWidth);
			const body = index < bodyRows.length ? bodyRows[index]! : "";
			return `${side} ${gutter} ${body}`;
		});
	}

	/** Series hue by rank, matching the web's `buildColorLookup`. */
	#seriesColor(index: number): ThemeColor {
		return SERIES_COLORS[((index % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];
	}


	#footerLine(plan: LayoutPlan, width: number): string {
		const state = this.#state;
		// DERIVED, never stored (F23 §3.2): an error shows a retry and a close
		// rather than a range switch that would only discard the message the user
		// has not read yet.
		const mode: HintMode =
			state.error !== null
				? "error"
				: this.#liveStatus?.sync.phase === "syncing"
					? "syncing"
					: state.maxScroll > 0
						? "scrollable"
						: "idle";
		const hints: readonly PanelHint[] = this.#feature()?.inputMode === "text" ? [
			{ keys: ["escape"], label: "finish search" },
			{ keys: ["ctrl+p", "ctrl+n"], label: "screen" },
			{ keys: ["ctrl+c"], label: "close" },
		] : hintsFor(mode);
		const scrollPosition = state.maxScroll > 0 ? `${state.scroll + 1}–${Math.min(state.source.length, state.scroll + plan.bodyRows)}/${state.source.length}` : "";
		// Keep the close hint usable when the viewport cannot also fit the counter.
		const position = visibleWidth(scrollPosition) + 12 <= width ? scrollPosition : "";
		const reserve = position ? visibleWidth(position) + 2 : 0;
		const hintWidth = Math.max(0, width - reserve);
		const [row = ""] = footerHints(hints, this.#theme, hintWidth);
		return position
			? row + " ".repeat(Math.max(2, width - visibleWidth(row) - visibleWidth(position))) + this.#theme.fg("muted", position)
			: row;
	}

	// --- input ---------------------------------------------------------------

	handleInput(data: string): void {
		const state = this.#state;
		if (state.closed) return;
		// The mouse router first, because its escape prefix swallows real keys —
		// the same ORDER `usage-dashboard.ts:1367-1405` uses. Keyboard handling
		// below is untouched: the mouse is additive, never required.
		if (routeSgrMouseInput(data, event => this.#routeMouse(event))) return;
		// The `g` prefix expires on TIME, not on a timer (Shell.tsx parity: the
		// web compares timestamps on the next keypress and never clears).
		const armed =
			state.jumpArmedAt !== 0 && (this.#options.now?.() ?? Date.now()) - state.jumpArmedAt < JUMP_TIMEOUT_MS;
		const feature = this.#feature();
		const editing = feature?.inputMode === "text";
		if (matchesKey(data, "ctrl+c") || !editing && matchesKey(data, "q")) { this.#finish(); return; }
		let action: PanelAction | null = null;
		if (matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+n")) {
			action = panelAction(data, armed);
			if (action?.type === "screen") {
				this.#selectScreen(this.#indexOf(state.screenId) + action.by); return;
			}
		}
		if (!editing && (data === "[" || data === "]")) {
			this.#selectScreen(this.#indexOf(state.screenId) + (data === "[" ? -1 : 1)); return;
		}
		if (!armed && feature?.handleInput(data)) {
			if (editing || this.#feature()?.inputMode === "text" || matchesKey(data, "tab") || matchesKey(data, "shift+tab") ||
				matchesKey(data, "enter") || matchesKey(data, "escape")) state.scroll = 0;
			return;
		}
		action ??= panelAction(data, armed);
		if (action === null) return;
		state.jumpArmedAt = 0;
		switch (action.type) {
			case "close":
				this.#finish();
				return;
			case "scroll":
				this.#scrollBy(action.viewport ? action.viewport * Math.max(1, state.maxScroll) : (action.rows ?? 0));
				return;
			case "scrollTo":
				state.scroll = action.edge === "top" ? 0 : state.maxScroll;
				this.#changed();
				return;
			case "screen":
				this.#selectScreen(this.#indexOf(state.screenId) + action.by);
				return;
			case "screenIndex":
				this.#selectScreen(action.index);
				return;
			case "screenId": {
				const index = SELECTABLE_SCREENS.findIndex(screen => screen.id === action.id);
				// A jump only ever lands on a drawable screen: NAV_GROUPS filters
				// deferred and excluded screens out, so an unknown id is inert.
				if (index !== -1) this.#selectScreen(index);
				return;
			}
			case "armJump":
				state.jumpArmedAt = this.#options.now?.() ?? Date.now();
				return;
			case "noop":
				return;
			case "range":
				state.range = nextRange(state.range, action.by);
				this.#load();
				return;
			case "sync":
				this.#beginSync();
				return;
		}
	}

	/**
	 * The mouse router: clicks, wheel and motion over the last frame.
	 *
	 * Shape copied from `settings-selector.ts:1224-1275`: wheel scrolls the
	 * body from anywhere; motion arms hover (strip tab via the TabBar's own
	 * `setHoverTab`, sidebar row via state both painted on the next render);
	 * a left click on a hit selects it through the SAME `#selectScreen` and
	 * range paths the keys use. Releases and non-left buttons are consumed
	 * and ignored — swallowing a click the panel does not own would eat it,
	 * but every SGR report IS owned here, and returning false would hand a
	 * click prefix to the keymap. Anything off every hit area is inert.
	 */
	#routeMouse(event: SgrMouseEvent): boolean {
		const state = this.#state;
		if (event.wheel !== null) {
			this.#scrollBy(event.wheel * 2);
			return true;
		}
		const frame = state.mouse;
		if (frame === null) return true;
		if (event.motion) {
			const hit = hitTest(frame, event.row, event.col);
			if (hit.type === "screen" && hit.via === "strip") {
				this.#tabBar.setHoverTab(hit.id);
				state.hoveredStripId = hit.id;
				state.hoveredSidebarId = null;
			} else {
				this.#tabBar.setHoverTab(null);
				state.hoveredStripId = null;
				state.hoveredSidebarId = hit.type === "screen" && hit.via === "sidebar" ? hit.id : null;
			}
			this.#changed();
			return true;
		}
		if (!event.leftClick) return true;
		const hit = hitTest(frame, event.row, event.col);
		if (hit.type === "screen") {
			const index = SELECTABLE_SCREENS.findIndex(screen => screen.id === hit.id);
			if (index !== -1) this.#selectScreen(index);
		} else if (hit.type === "range" && hit.id !== state.range) {
			state.range = hit.id;
			this.#load();
		}
		return true;
	}

	#indexOf(id: ScreenId): number {
		return SELECTABLE_SCREENS.findIndex(screen => screen.id === id);
	}
	#selectScreen(index: number): void {
		const state = this.#state;
		const count = SELECTABLE_SCREENS.length;
		if (count === 0) return;
		const screen = SELECTABLE_SCREENS[((index % count) + count) % count];
		if (screen.id === state.screenId) return;
		if (state.screenId === "traces" && screen.id !== "traces") this.#traceOrigin = undefined;
		// The pointer no longer points at what the old highlight meant, so a
		// hover pill left on the old tab would lie — `/settings` clears on
		// select the same way.
		this.#tabBar.setHoverTab(null);
		state.hoveredStripId = null;
		state.hoveredSidebarId = null;
		state.screenId = screen.id;
		state.scroll = 0;
		this.#load();
	}
	#scrollBy(delta: number): void {
		this.#state.scroll = Math.max(0, Math.min(this.#state.scroll + delta, this.#state.maxScroll));
		this.#changed();
	}
	// --- teardown ------------------------------------------------------------

	/** Close from the keyboard. `done()` runs at most once, whatever the host does. */
	#finish(): void {
		const state = this.#state;
		if (state.done) return;
		state.done = true;
		this.dispose();
		state.doneCalls++;
		this.#options.done();
	}

	/**
	 * Idempotent by contract, because the host ALSO calls `component.dispose()`
	 * in its own cleanup after hiding the overlay. It deliberately does not call
	 * `done()`: teardown and "the user asked to leave" are different events, and
	 * conflating them resolves the mount's promise from a path the user never
	 * took.
	 */
	dispose(): void {
		const state = this.#state;
		if (state.closed) return;
		state.closed = true;
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		for (const feature of this.#features.values()) feature.dispose();
		this.#features.clear();
		this.#reads.close();
		this.#panel.dispose();
	}
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function loadingLines(theme: Theme, stage: ReadStage): readonly string[] {
	return [
		theme.fg("muted", stage === "initializing" ? "Initializing stats database…" : "Reading usage…"),
		"",
		theme.fg("muted", "Stats work runs in a separate process. Navigation and close remain available."),
	];
}

function errorLines(theme: Theme, preset: SymbolPreset, error: string, syncError: string | null): readonly string[] {
	const lines = [
		`${statsIcon(preset, "warning", theme)} ${theme.fg("warning", theme.bold("Usage could not be read"))}`,
		"",
		error,
		"",
		// An unreadable source must never masquerade as measured zero usage.
		theme.fg("muted", "No observations loaded. Usage and cost are unavailable, not zero."),
	];
	if (syncError) lines.push("", `Background sync: ${syncError}`);
	return lines;
}


/** Theme colour names, so a theme switch restyles the series without a code change. */
const SERIES_COLORS: readonly ThemeColor[] = ["accent", "success", "warning", "error", "muted", "borderAccent"];


/** The in-flight load per panel, so a test can await a settle without a timer. */
const LOADS = new WeakMap<StatsPanel, Promise<void>>();

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export interface PanelTestState {
	data?: PanelData;
	fetch?: PanelFetch;
	range?: Range;
	screenId?: ScreenId;
	rows?: number;
	now?: () => number;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");
/**
 * The interface the tests assert against — the invariants a terminal would
 * otherwise be needed to check. `makePanel` builds a real `StatsPanel` with a
 * stub `tui` and the live theme, so `render(width)` keeps its production
 * signature and stays a pure function of state.
 */
export const __testing = {
	makePanel(state: PanelTestState = {}): StatsPanel {
		ensureThemeSync();
		const panel = new StatsPanel({
			// A TUI with no terminal behind it: nothing here reads it, because
			// `rows` is supplied and the frame size comes from state.
			tui: { terminal: { rows: state.rows ?? 40 }, requestRender: () => {} } as unknown as TUI,
			theme: activeTheme,
			done: () => {},
			requestRender: () => {},
			fetch: state.fetch ?? (async () => state.data as PanelData),
			range: state.range,
			screenId: state.screenId,
			rows: state.rows ?? 40,
			now: state.now,
		});
		return panel;
	},

	/** Resolves when the panel's current load settles, however it settled. */
	async settled(panel: StatsPanel): Promise<StatsPanel> {
		await (LOADS.get(panel) ?? Promise.resolve());
		return panel;
	},

	debugState: (panel: StatsPanel) => STATE.get(panel) as PanelState,
	debugPhase: (panel: StatsPanel) => phaseOf(panel),
	debugRange: (panel: StatsPanel) => STATE.get(panel)!.range,
	debugScreenId: (panel: StatsPanel) => STATE.get(panel)!.screenId,
	debugScreenIds: () => SELECTABLE_SCREENS.map(screen => screen.id),
	debugScroll: (panel: StatsPanel) => STATE.get(panel)!.scroll,
	debugMaxScroll: (panel: StatsPanel) => STATE.get(panel)!.maxScroll,
	debugClosed: (panel: StatsPanel) => STATE.get(panel)!.closed,
	debugDoneCalls: (panel: StatsPanel) => STATE.get(panel)!.doneCalls,
	debugFrame: (panel: StatsPanel) => STATE.get(panel)!.mouse,
	debugHoverTab: (panel: StatsPanel) => STATE.get(panel)!.hoveredStripId,
	debugHoverSidebar: (panel: StatsPanel) => STATE.get(panel)!.hoveredSidebarId,
	debugChartRows: (panel: StatsPanel, width = 120): readonly string[] => {
		panel.render(width);
		return STATE.get(panel)!.chart;
	},
	debugBody: (panel: StatsPanel): readonly string[] => {
		panel.render(120);
		return STATE.get(panel)!.source.map(stripAnsi);
	},
	debugHeader: (panel: StatsPanel) => {
		panel.render(120);
		return stripAnsi(STATE.get(panel)!.header);
	},
	debugTitle: (panel: StatsPanel) => {
		panel.render(120);
		return stripAnsi(STATE.get(panel)!.title);
	},
};

function phaseOf(panel: StatsPanel): PanelPhase {
	const state = STATE.get(panel) as PanelState;
	if (state.error !== null) return "error";
	return state.data !== null ? "ready" : "loading";
}
