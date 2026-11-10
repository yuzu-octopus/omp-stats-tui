/**
 * `src/tui/showcase/panel.ts` — `/stats-test`'s overlay.
 *
 * THE MOUNT, not the design. The showcase's contribution is that it exercises the
 * panel's whole visual grammar on fabricated fixtures, and the fastest way to make
 * that a lie would be to hand-build its body — a second renderer whose bugs are its
 * own. So nothing here composes lines. Every body line comes out of `renderScreen`
 * on a declared `ScreenSpec` (`showcase/spec.ts`), and every frame region is the one
 * `panel.ts` uses.
 *
 * WHAT IS REUSED, and why each reuse is load-bearing:
 *
 *   - `panelAction` for the KEYMAP. It is a pure function from a key to a VERB and
 *     has no opinion about what a screen is, so the showcase consumes its verbs and
 *     resolves them against its own sections. That is why the `g`-prefix, the SGR
 *     wheel routing, the cancel keys and the digit row are not reimplemented: a
 *     second keymap is the exact "second grammar" failure this codebase exists to
 *     prevent. The one thing the showcase does NOT inherit is `screenForHotkey`,
 *     whose letters belong to the real nav — `g` + a showcase letter jumps to a
 *     showcase section, and anything else is a no-op rather than a jump onto a real
 *     screen the showcase cannot draw.
 *   - `topbar` / `chipFor` / `progressLineFor` for the topbar, so the range control
 *     and the live chip are the panel's own, over a fabricated sync state.
 *   - `framePolicy` for the width decision, `bodyRows` for the frame budget, and
 *     `footerHints`/`hintsFor` for the hint row — none of them re-derived here.
 *   - `hitTest`/`MouseFrame` for the frame arithmetic and every hit area (topbar
 *     segments, strip zones, sidebar rows) — the panel's own router, with the
 *     showcase's nav passed in.
 *
 * WHAT USED TO BE FORKED, and is no longer: `sidebar()` and `buildTabs()` were
 * closed over the real screen registry, so the nav lived in `showcase/nav.ts` as
 * a second painter. The seams the fork asked for now exist: `sidebar(...)` takes
 * the nav list, `hitTest(...)` takes the sidebar row resolver, and `zipSidebar`
 * composes the column. `SHOWCASE_NAV` is data; `chrome.ts` owns the geometry, the
 * ink ladder and the hover/active rules for BOTH panels.
 *
 * NO DATABASE, EVER. The data is `showcaseData(sectionId)`, a fixture, resolved
 * synchronously. `test/showcase-needs.test.ts` asserts at the source level that no
 * module under `showcase/` imports `bun:sqlite` or calls `initDb`/`fetchFor`,
 * because a future edit reaching for the DB would pass every other
 * test here and only fail in someone's real session, ~850 ms later, on the
 * keystroke they just typed.
 */

import { TabBar, routeSgrMouseInput, type Component, type SgrMouseEvent, type TUI } from "@oh-my-pi/pi-tui";
import { OverlayPanel, PanelDivider, PanelRows } from "@oh-my-pi/pi-tui/chrome";
import { ensureThemeSync, theme as activeTheme, type Theme } from "@oh-my-pi/pi-tui/theme";

import { DEFAULT_RANGE, nextRange, type Range } from "../../data/ranges";
import {
	JUMP_TIMEOUT_MS,
	SIDEBAR_ZIP_PREFIX,
	chipFor,
	progressLineFor,
	sidebar,
	topbar,
	zipSidebar,
	type ChromeSync,
} from "../chrome";
import { footerHints, hintsFor, type HintMode } from "../footer";
import { MIN_PANEL_ROWS, bodyRows } from "../frame";
import { glyphsFor, type SymbolPreset } from "../glyphs";
import { MIN_USABLE_WIDTH, planLayout, type LayoutPlan } from "../layout";
import { hitTest, sidebarHit, type MouseFrame } from "../mouse";
import { EXACT_DIRTY_LIMIT, panelAction, type PanelAction } from "../panel";
import { SERIES_COLORS } from "../palette";
import { framePolicy } from "../responsive";
import { renderScreen } from "../render/screen";
import { SHOWCASE_NAV, buildShowcaseTabs, showcaseTabBarTheme } from "./nav";
import { SHOWCASE_NOW, SHOWCASE_SECTIONS, showcaseData, type ShowcaseSection } from "./spec";

export { SHOWCASE_NAV, SHOWCASE_SECTIONS } from "./nav";
export type { ShowcaseSection } from "./spec";

/**
 * Shortest terminal that still gets the full grouped sidebar: its nav rows (three
 * headings and six sections) plus the topbar, the divider, the footer, one body row
 * and the two borders. Below this the sidebar degrades to the tab strip rather than
 * overflowing the frame — the same rule `panel.ts` applies, with the row count
 * derived from the showcase's own nav rather than restated.
 */
const MIN_SIDEBAR_ROWS = SHOWCASE_NAV.reduce((rows, group) => rows + 1 + group.items.length, 0) + 9;

/** The one-cell inset every `row()` puts inside the overlay's chrome. */
const TAB_BAR_INDENT = 1;


const NO_ROWS: readonly string[] = [];
const ANSI = /\x1b\[[0-9;]*m/g;

// ─── Section lookup ──────────────────────────────────────────────────────────

/** One section by id, or `undefined` when the showcase has no such section. */
export function sectionById(id: string): ShowcaseSection | undefined {
	return SHOWCASE_SECTIONS.find(section => section.id === id);
}

/**
 * The section a digit selects. The panel's own convention — `1`-`9` for the first
 * nine, `0` for the tenth — and anything past the list WRAPS rather than falling
 * off, because a digit that selected nothing would be a dead key, which is worse
 * than a repurposed one.
 */
export function sectionForDigit(digit: number): string | undefined {
	if (!Number.isInteger(digit) || digit < 0) return undefined;
	return SHOWCASE_SECTIONS[digit % SHOWCASE_SECTIONS.length]?.id;
}

/**
 * The section a `g`+letter jump selects, case-insensitively like the web's
 * `e.key.toLowerCase()` lookup. `null` for a digit, for an empty string, and for
 * anything that is not a single letter.
 *
 * OUR OWN LETTERS, not `screenForHotkey`. That function reads the real nav, so
 * reusing it would make `g o` land on the real overview — a screen the showcase
 * cannot draw, reached from a key pressed inside it.
 */
export function sectionForHotkey(key: string): string | null {
	if (key.length !== 1) return null;
	const lower = key.toLowerCase();
	for (const group of SHOWCASE_NAV) {
		for (const item of group.items) {
			if (item.hotkey === lower) return item.id;
		}
	}
	return null;
}

/**
 * The showcase's sidebar rows through the SHARED walk: `sidebarHit` over
 * `SHOWCASE_NAV`, the same list `sidebar(...)` paints. The frame geometry lives
 * in `mouse.ts`; this is only the nav binding, so a regrouped showcase nav moves
 * its own hit rows.
 */
function hitShowcaseSidebar(navRow: number): string | null {
	return sidebarHit(navRow, SHOWCASE_NAV);
}

/** What one keystroke means to the showcase: the panel's verbs, plus our own two. */
export type ShowcaseAction = PanelAction | { type: "sectionId"; id: string } | { type: "noop" };


/**
 * Translate one input into one action, or null for a key the showcase does not own.
 *
 * `panelAction` does every bit of the work that is NOT about what a screen is: the
 * SGR wheel routing (whose escape prefix swallows real keys, so it must come
 * first), the cancel keys, the `g` prefix, the arrows and the digit row. Two
 * decisions are ours:
 *
 *   1. an ARMED jump resolves against OUR letters, so a jump can only ever land on a
 *      section this panel can draw; and
 *   2. `armJump` and the rest pass through verbatim, so the `g` prefix expires on
 *      TIME rather than on a timer, exactly as the web's `pendingG` does.
 *
 * The second argument is deliberately NOT forwarded: `panelAction`'s own jump
 * resolution would hand back a real screen id, which is the thing being avoided.
 */
export function showcaseAction(data: string, jumpArmed = false): ShowcaseAction | null {
	if (jumpArmed && data.length === 1) {
		const id = sectionForHotkey(data);
		return id === null ? { type: "noop" } : { type: "sectionId", id };
	}
	return panelAction(data, false);
}

// ─── The fabricated sync ─────────────────────────────────────────────────────

/**
 * How the showcase fabricates the panel's sync state. Each of the four is a real
 * branch of `chipFor` or `progressLineFor`, so cycling them exercises chrome that
 * is otherwise invisible: a playground that only ever showed `Live` would not be
 * showing the chip.
 */
export type ShowcaseSyncState = "live" | "syncing" | "indexing" | "failed";

const SYNC: Readonly<Record<ShowcaseSyncState, (now: number) => ChromeSync>> = {
	live: now => ({
		syncing: false,
		current: 0,
		total: 0,
		determinate: false,
		error: null,
		dirtyHours: 0,
		// A recent settle, so `ago` has something to render.
		lastSyncedAt: now - 7 * 60_000,
		now,
	}),
	syncing: now => ({
		syncing: true,
		current: 1_284,
		total: 3_401,
		determinate: true,
		error: null,
		dirtyHours: 12,
		lastSyncedAt: now - 60_000,
		now,
	}),
	// A backlog past the chip's own 24-hour visibility threshold, which is a
	// DIFFERENT chip from "syncing" and reads differently.
	indexing: now => ({
		syncing: false,
		current: 0,
		total: 0,
		determinate: false,
		error: null,
		dirtyHours: 168,
		lastSyncedAt: null,
		now,
	}),
	// The error branch, which takes precedence over everything else.
	failed: now => ({
		syncing: false,
		current: 0,
		total: 0,
		determinate: false,
		error: "the fabricated sync failed",
		dirtyHours: 0,
		lastSyncedAt: null,
		now,
	}),
};

/** The order a real panel passes through them: settled, working, backlog, failed. */
const SYNC_CYCLE: readonly ShowcaseSyncState[] = ["live", "syncing", "indexing", "failed"];

// ─── State ───────────────────────────────────────────────────────────────────

interface ShowcaseState {
	sectionId: string;
	range: Range;
	jumpArmedAt: number;
	scroll: number;
	maxScroll: number;
	closed: boolean;
	done: boolean;
	doneCalls: number;
	hoveredSidebarId: string | null;
	hoveredStripId: string | null;
	mouse: MouseFrame | null;
	source: readonly string[];
	sync: ShowcaseSyncState;
	section: ShowcaseSection;
	title: string;
}

const STATE = new WeakMap<ShowcasePanel, ShowcaseState>();

export interface ShowcasePanelOptions {
	tui: TUI;
	theme: Theme;
	/** Resolves the mount's promise. At most once, only from the close path. */
	done: () => void;
	/** Defaults to `tui.requestRender()`. Injected so a test can count repaints. */
	requestRender?: () => void;
	/** Opening section. Defaults to the first; an unknown id falls back rather than throwing. */
	sectionId?: string;
	/** Opening range. Defaults to the closed set's own default. */
	range?: Range;
	/** Test seam for terminal height; production reads `tui.terminal.rows`. */
	rows?: number;
	/** Test seam for the chart axis clock. Defaults to the fixtures' fixed one. */
	now?: () => number;
}

// ─── The panel ───────────────────────────────────────────────────────────────

/**
 * `/stats-test`'s overlay. A `Component`, mounted exactly as `StatsPanel` is:
 * `ctx.ui.custom(factory, { overlay: true, overlayOptions })` with
 * `fullscreen: true` borrowing the alternate screen buffer.
 */
export class ShowcasePanel implements Component {
	readonly #options: ShowcasePanelOptions;
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #panel: OverlayPanel;
	readonly #tabBar: TabBar;
	readonly #header: PanelRows;
	readonly #body: PanelRows;
	readonly #footer: PanelRows;
	readonly #state: ShowcaseState;

	constructor(options: ShowcasePanelOptions) {
		this.#options = options;
		this.#tui = options.tui;
		this.#theme = options.theme;
		// An unknown opening section falls back to the first rather than throwing: the
		// command takes an optional argument, and a typo in it should not crash a
		// panel the user asked for.
		const opening = (options.sectionId !== undefined ? sectionById(options.sectionId) : undefined) ?? SHOWCASE_SECTIONS[0];
		if (!opening) throw new Error("the showcase declares no sections");
		this.#state = {
			sectionId: opening.id,
			range: options.range ?? DEFAULT_RANGE,
			jumpArmedAt: 0,
			scroll: 0,
			maxScroll: 0,
			closed: false,
			done: false,
			doneCalls: 0,
			hoveredSidebarId: null,
			hoveredStripId: null,
			mouse: null,
			source: NO_ROWS,
			sync: "live",
			section: opening,
			title: `Showcase · ${opening.label}`,
		};
		STATE.set(this, this.#state);

		this.#panel = new OverlayPanel("Showcase", "omp.overlay.stats");
		this.#tabBar = new TabBar("", buildShowcaseTabs(this.#theme), showcaseTabBarTheme(this.#theme));
		// The strip folds its own hints into the footer, so it must not spend a cell on
		// `(tab to cycle)`.
		this.#tabBar.showHint = false;
		this.#header = new PanelRows();
		this.#body = new PanelRows();
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	#changed(): void {
		(this.#options.requestRender ?? (() => this.#tui.requestRender()))();
	}

	/** The one and only `getSymbolPreset()` read. Every path below receives it. */
	#preset(): SymbolPreset {
		return this.#theme.getSymbolPreset();
	}

	// --- render --------------------------------------------------------------

	render(width: number): readonly string[] {
		const state = this.#state;
		const rows = this.#options.rows ?? this.#tui.terminal.rows ?? 40;
		const preset = this.#preset();
		const policy = framePolicy(width);
		const innerWidth = Math.max(1, width - 4);

		// THE TOPBAR is chrome.ts's own, over a FABRICATED sync state — so the live
		// chip, the relative age, the backlog branch and the error branch are all the
		// panel's real rendering rather than a mock of it.
		const sync = SYNC[state.sync](this.#options.now?.() ?? Date.now());
		const chip = chipFor(this.#theme, sync);
		// Freshness is the panel's own escalation: dim below the exact limit, a warning
		// above it, because past that point the numbers have holes in them rather than
		// being merely late.
		const dirty = sync.dirtyHours;
		const freshness =
			dirty > 0
				? this.#theme.fg(dirty > EXACT_DIRTY_LIMIT ? "warning" : "dim", `${dirty} dirty ${dirty === 1 ? "hour" : "hours"}`)
				: "";
		const top = topbar(this.#theme, { range: state.range, chip, freshness, innerWidth });

		// The thin progress line under the topbar — a whole second chrome region,
		// drawn only while a sync streams, and the only one carrying a denominator
		// (ingest). There is no child process to report a real one, so the event is
		// fabricated here; the RENDERING of it is the panel's own.
		const progress =
			state.sync === "syncing"
				? progressLineFor({ type: "progress", phase: "ingest", current: sync.current, total: sync.total }, innerWidth)
				: "";
		const topLines = progress === "" ? [top] : [top, progress];

		// WIDE GETS THE SIDEBAR COLUMN; EVERYTHING NARROWER GETS THE STRIP. The width
		// decision is `framePolicy`'s and is never re-derived here.
		const column = policy.sidebar === "full" && rows >= MIN_SIDEBAR_ROWS;
		let strip: readonly string[] = NO_ROWS;
		if (!column && rows > MIN_PANEL_ROWS) {
			this.#tabBar.setTabs(buildShowcaseTabs(this.#theme), state.sectionId);
			strip = this.#tabBar.render(Math.max(1, width - TAB_BAR_INDENT));
		}
		const nav = column ? sidebar(this.#theme, preset, state.sectionId, state.hoveredSidebarId, SHOWCASE_NAV) : null;
		const sidebarWidth = nav?.width ?? 0;

		// The routers hit-test against THIS frame: strip zones come from the `TabBar`'s
		// own last render, sidebar rows from the nav, and range segments from the
		// STRIPPED topbar row — ANSI escapes are zero-width, so raw indices would miss.
		const tabBar = this.#tabBar;
		state.mouse = {
			topbarRows: topLines.length,
			stripRows: strip.length,
			sidebarWidth: column ? sidebarWidth : 0,
			sidebarRows: column ? (nav?.lines.length ?? 0) : 0,
			topbar: top.replace(ANSI, ""),
			tabAt: (line, col) => tabBar.tabAt(line, col)?.id,
		};

		const headerLines = [...topLines, ...strip];
		const body = bodyRows(rows, headerLines.length);
		// THE BODY IS PLANNED AT THE WIDTH IT WILL BE DRAWN IN. The nav column is
		// zipped BESIDE it by `zipSidebar`, whose prefix is `sidebarWidth + 3`; if the
		// plan used the overlay's full inner width anyway, every body row would be
		// drawn wider than the room it has and the border would cut the excess.
		const sidebarCols = column ? sidebarWidth + SIDEBAR_ZIP_PREFIX : 0;
		const plan: LayoutPlan = {
			...planLayout(Math.max(MIN_USABLE_WIDTH, width - sidebarCols), rows, preset),
			bodyRows: body,
		};

		// The body is the ONLY thing that scrolls, and it is sliced as plain full-width
		// lines. The nav column is attached AFTER the slice, which is what pins it: a
		// frame region recomputed from width and section must never be a function of
		// scroll.
		state.source = this.#bodyLines(plan, preset);
		state.maxScroll = Math.max(0, state.source.length - plan.bodyRows);
		// Clamped HERE, not in the key handler, so a terminal that shrank between two
		// keypresses cannot leave the view scrolled past its end.
		state.scroll = Math.max(0, Math.min(state.scroll, state.maxScroll));

		state.title = `Showcase · ${state.section.label}`;
		this.#panel.title = state.title;
		this.#header.setLines(headerLines);
		this.#header.setHeight(headerLines.length);
		const visible = state.source.slice(state.scroll, state.scroll + plan.bodyRows);
		this.#body.setLines(nav === null ? visible : zipSidebar(this.#theme, visible, nav.lines, sidebarWidth, preset));
		this.#body.setHeight(Math.max(plan.bodyRows, nav === null ? 0 : nav.lines.length));
		this.#footer.setLines([this.#footerLine(plan)]);
		return this.#panel.render(width);
	}

	/**
	 * The body's lines, through the SAME pipeline the real panel uses: `renderScreen`
	 * → `screenBands` → `renderBands` over the G1–G6 grammar. There is no
	 * `?? section.render()` fallback and no hand-built body, because either would be
	 * a second grammar and the showcase's entire value is proving the first one.
	 */
	#bodyLines(plan: LayoutPlan, preset: SymbolPreset): readonly string[] {
		const state = this.#state;
		const now = this.#options.now?.() ?? SHOWCASE_NOW;
		return renderScreen({
			spec: state.section.spec,
			data: showcaseData(state.section.id),
			plan,
			preset,
			range: state.range,
			now,
			fg: (color, text) => this.#theme.fg(color, text),
			bold: text => this.#theme.bold(text),
			palette: this.#theme,
			glyphs: glyphsFor(preset),
			today: new Date(now),
			// Web parity: a series' hue is assigned by RANK, so the same key keeps the
			// same hue across charts. The panel's own rule.
			seriesColorFor: index => SERIES_COLORS[index % SERIES_COLORS.length] ?? "accent",
		});
	}


	/** DERIVED, never stored: what the panel is doing decides which hints are worth a row. */
	#footerLine(plan: LayoutPlan): string {
		const state = this.#state;
		const mode: HintMode =
			state.sync === "failed" ? "error" : state.sync === "syncing" ? "syncing" : state.maxScroll > 0 ? "scrollable" : "idle";
		const [row] = footerHints(hintsFor(mode), this.#theme, plan.innerWidth);
		return row ?? "";
	}

	// --- input ---------------------------------------------------------------

	handleInput(data: string): void {
		const state = this.#state;
		if (state.closed) return;
		// The mouse router first, because its escape prefix swallows real keys — the
		// same ORDER `panel.ts` uses. Keyboard handling below is untouched: the mouse
		// is additive, never required.
		if (routeSgrMouseInput(data, event => this.#routeMouse(event))) return;
		// The `g` prefix expires on TIME, not on a timer: the web compares timestamps on
		// the next keypress and never clears, so a stale arm simply expires.
		const armed = state.jumpArmedAt !== 0 && (this.#options.now?.() ?? Date.now()) - state.jumpArmedAt < JUMP_TIMEOUT_MS;
		const action = showcaseAction(data, armed);
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
				this.#selectSection(this.#indexOf(state.sectionId) + action.by);
				return;
			case "screenIndex":
				this.#selectSection(action.index);
				return;
			case "sectionId":
				this.#selectSection(this.#indexOf(action.id));
				return;
			case "range":
				state.range = nextRange(state.range, action.by);
				this.#changed();
				return;
			case "armJump":
				state.jumpArmedAt = this.#options.now?.() ?? Date.now();
				return;
			case "sync":
				this.#cycleSync();
				return;
			case "noop":
				return;
		}
	}

	/**
	 * The mouse router: the wheel scrolls from anywhere, motion arms hover, and a
	 * left click selects through the SAME paths the keys use. Releases and non-left
	 * buttons are consumed and ignored — swallowing a click the panel does not own
	 * would eat it, but every SGR report IS owned here, and returning false would
	 * hand a click prefix to the keymap. Anything off every hit area is inert.
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
			const hit = hitTest(frame, event.row, event.col, hitShowcaseSidebar);
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
		const hit = hitTest(frame, event.row, event.col, hitShowcaseSidebar);
		if (hit.type === "screen") {
			this.#selectSection(this.#indexOf(hit.id));
		} else if (hit.type === "range" && hit.id !== state.range) {
			state.range = hit.id;
			this.#changed();
		}
		return true;
	}


	#indexOf(id: string): number {
		return SHOWCASE_SECTIONS.findIndex(section => section.id === id);
	}

	#selectSection(index: number): void {
		const state = this.#state;
		const count = SHOWCASE_SECTIONS.length;
		if (count === 0) return;
		const section = SHOWCASE_SECTIONS[((index % count) + count) % count];
		if (!section) return;
		// A hover pill left on the old section would point at something that is no
		// longer there, and `/settings` clears on select for the same reason.
		this.#tabBar.setHoverTab(null);
		state.hoveredStripId = null;
		state.hoveredSidebarId = null;
		state.sectionId = section.id;
		state.section = section;
		state.scroll = 0;
		this.#changed();
	}

	#scrollBy(delta: number): void {
		this.#state.scroll = Math.max(0, Math.min(this.#state.scroll + delta, this.#state.maxScroll));
		this.#changed();
	}

	/**
	 * `s` in the panel starts a background ingest. There is nothing to ingest here,
	 * so `s` walks the CHIP through the four states it can take instead — which is
	 * strictly more useful in a playground, and is the showcase's only key that
	 * means something different from the panel's. The chip, the progress line and
	 * the footer are all the panel's real rendering of the state.
	 */
	#cycleSync(): void {
		const state = this.#state;
		state.sync = SYNC_CYCLE[(SYNC_CYCLE.indexOf(state.sync) + 1) % SYNC_CYCLE.length] ?? "live";
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
	 * Idempotent by contract, because the host ALSO calls `component.dispose()` in
	 * its own cleanup after hiding the overlay. It deliberately does not call
	 * `done()`: teardown and "the user asked to leave" are different events, and
	 * conflating them resolves the mount's promise from a path the user never took.
	 */
	dispose(): void {
		const state = this.#state;
		if (state.closed) return;
		state.closed = true;
		this.#panel.dispose();
	}
}

// ─── Test seam ───────────────────────────────────────────────────────────────

/** What a test may override. The clock is injected so no fixture reads a wall clock. */
export interface ShowcaseTestState {
	sectionId?: string;
	range?: Range;
	rows?: number;
	now?: () => number;
}

/**
 * The interface the tests assert against — the invariants a terminal would otherwise
 * need a human to check. `makePanel` builds a real `ShowcasePanel` with a stub `tui`
 * and the live theme, so `render(width)` keeps its production signature and stays a
 * pure function of state.
 */
export const __testing = {
	makePanel(state: ShowcaseTestState = {}): ShowcasePanel {
		ensureThemeSync();
		return new ShowcasePanel({
			// A TUI with no terminal behind it: nothing here reads it, because `rows` is
			// supplied and the frame size comes from state.
			tui: { terminal: { rows: state.rows ?? 40 }, requestRender: () => {} } as unknown as TUI,
			// The active theme, read INSIDE the seam rather than at module scope:
			// `theme` is undefined until theme init runs (AGENTS.md), so a module-scope
			// read crashes at extension load.
			theme: activeTheme,
			done: () => {},
			requestRender: () => {},
			sectionId: state.sectionId,
			range: state.range,
			rows: state.rows ?? 40,
			now: state.now,
		});
	},
	debugState: (panel: ShowcasePanel) => STATE.get(panel) as ShowcaseState,
	debugSectionId: (panel: ShowcasePanel) => STATE.get(panel)!.sectionId,
	debugRange: (panel: ShowcasePanel) => STATE.get(panel)!.range,
	debugScroll: (panel: ShowcasePanel) => STATE.get(panel)!.scroll,
	debugMaxScroll: (panel: ShowcasePanel) => STATE.get(panel)!.maxScroll,
	debugClosed: (panel: ShowcasePanel) => STATE.get(panel)!.closed,
	debugDoneCalls: (panel: ShowcasePanel) => STATE.get(panel)!.doneCalls,
	debugFrame: (panel: ShowcasePanel) => STATE.get(panel)!.mouse,
	debugHoverSidebar: (panel: ShowcasePanel) => STATE.get(panel)!.hoveredSidebarId,
	debugHoverStrip: (panel: ShowcasePanel) => STATE.get(panel)!.hoveredStripId,
	debugSync: (panel: ShowcasePanel) => STATE.get(panel)!.sync,
	debugTitle: (panel: ShowcasePanel) => {
		panel.render(120);
		return STATE.get(panel)!.title;
	},
	debugBody: (panel: ShowcasePanel): readonly string[] => {
		panel.render(120);
		return STATE.get(panel)!.source.map(row => row.replace(ANSI, ""));
	},
};