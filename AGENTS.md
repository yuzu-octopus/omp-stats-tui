# Repository Guidelines

## Project Overview

`omp-stats-tui` is a plugin extension for compiled omp **18.8.6**. `/stats-tui` mounts a fullscreen terminal overlay over the upstream stats records; built-in `/stats` remains the separate browser command.

The active [execution roadmap](docs/plans/2026-10-05-dashboard-parity.md) supersedes the older plan's subset, read-only and version constraints. Twelve interactive screen controllers are integrated in production, including Traces and Frustration. The local mounted workflow/theme/package matrix and integrated suite are verified; paid execution and credentialed broker verification remain external. Source lives under `src/`; compiled-host installation loads `dist/index.js` after `bun install` and `bun run build`.

Vocabulary is load-bearing. `CONTEXT.md` is the glossary; use its terms (request, turn, fact table, rollup table, dirty hour, range, bucket, cache rate, unpriced request, data ink, seam, symbol preset — and, for layout work, band, ScreenSpec, MetricRef, resolve, parity). Where a looser word is already in use and wrong — "message" for a request, "granularity" for bucket, "stale" for dirty hour — do not reintroduce it.

## Architecture & Data Flow

Settled design, in order:

1. The source entry registers `/stats-tui`, without database initialization on the host thread.
2. The command calls `ctx.ui.custom(factory, { overlay: true, overlayOptions })`; `fullscreen: true` borrows the alternate screen buffer and preserves the transcript.
3. `StatsPanel` mounts one retained `FeatureController` per screen from `src/tui/features/`. Controllers own focus/search/sort/selection/details and chart controls; the panel owns global navigation, scrolling and mount lifetime.
4. One persistent `StatsReadClient` (`src/data/client.ts`) talks by NDJSON pipes to `scripts/data-worker.ts`. That child owns initialization, synchronous DB/file reads, upstream `handleApi(Request)` routing and patched `StatsLive({ workers: 1 })`. Initial ingest and transcript watching publish unsolicited live status; committed-data invalidation refreshes the active route without resetting controller controls. Manual `s` requests sync on this same owner.
5. Local provider usage and subscription-window/account reads have independent states. Request details/transcripts and quota reads load on demand. Cached Frustration remains passive; the real standalone judge opens lazily only for requested judging, with estimate, explicit `y` confirmation and cancellation.
6. The `ScreenSpec → renderScreen → renderBands` IR is NOT the production render path (ADR 0007). Production screens are retained `FeatureController`s from `src/tui/features/`, which own focus/search/sort/selection/details and render their own bodies; no production screen renders from a `ScreenSpec`. The IR survives for three named jobs — the shipped `/stats-test` showcase (`src/tui/showcase/panel.ts` calls `renderScreen` on showcase specs), the nav/tabs identity (`src/tui/tabs.ts` and `src/tui/chrome.ts` read `SCREEN_SPECS`), and the review probes (`scripts/probe-render.ts`, `scripts/probe-showcase.ts`). `src/tui/panel.ts` also reaches `renderScreenWith`, but only on the fixture path (`options.fetch` injected), after the controller branch has already returned. Static `expandable` metadata is not an implemented action. The reason is settled, not stylistic: a static band grammar cannot express focus, search, sort, staged loading or retained state. See CONTEXT.md's IR scope map for which file survives for which reason.
7. Production `features/presentation.ts` reuses band drawing primitives for metric grids and measured tables; `charts/time-series.ts` owns shared core/Provider/Gain bucket plots. This is widget reuse, not a return to static `ScreenSpec` bodies or `MetricRef`-driven controller state.

**There is NO webserver and NO plugin-owned SQL workaround.** The 100-line unpriced-count `WORKAROUND` that once lived in `src/data/api.ts` was deleted in PR #1 and must not come back: it re-implemented the rollup union and could not correct rollups the dependency had already cached. Synthetic localhost `Request`s call upstream handlers inside the isolated worker without binding a socket. Reuse upstream aggregators, shared types and pure client/data helpers, not React components or a second data backend.

**Dependency corrections are shipped, not patched at runtime** (ADR 0008). Standard Bun `patchedDependencies` plus `bun.lock` apply the committed stats 18.8.6 patch: pricing-v2 historic replay, rollup-v3 invalidation, selected-range recent requests before limit, provider `outputTokens`, and standalone live ingestion. Absent provider/model cards are unknown spend; explicit free cards and recorded zero charges remain zero. The production bundle includes the corrected stats dependency. `bun install` is therefore correctness-critical, not just setup — see §CI for why `verify:patch` runs immediately after it and why `node_modules` is not cached.

**Theme is current per render.** The panel reads the initialized host theme at render time and updates mutable `FeatureContext.theme`; primitives receive theme/paint arguments. Sparkline, bar, calendar and timeline ink is coloured per character/series using active omp roles and shared series/legend identity. Avoid an eager module-scope singleton read or permanently captured theme. Each terminal cell has one foreground/background, not separately coloured braille dots.

**Workflow guidance:** `Ctrl+P`/`Ctrl+N` navigate screens unless overridden by host selector bindings; `[`/`]` navigate outside text entry. `Tab` cycles route focus/view; focused analytics tables precede charts. `r`/`R` range and `s` sync apply outside text entry; `q` closes outside text entry and `Ctrl+C` always closes. Printable `q` and brackets remain searchable. `Esc` backs out before closing. `g` jumps cover all twelve routes (`o m c v a r e t l j n f`, mapped in `chrome.ts`). Arrows/digits are contextual. See README's controller-derived key table.

**Known external boundaries:** Traces root discovery considers at most 300 upstream candidates. Missing broker credentials affect quota independently of local provider data. A paid smoke needs the configured `judge` model role, provider credentials and explicit user authorization; no paid run is claimed verified.

### Historical measured latencies (18.4.10, previous machine)

These historical measurements describe the former in-process adapter. `bun:sqlite` remains synchronous, but production now runs that work in a persistent isolated process. All measurements below are warm page-cache, one machine (M-series darwin-arm64).

| Operation | Measured | Note |
| --- | --- | --- |
| `handleApi(GET /api/stats/overview?range=7d)` | HTTP 200 | keys: `byAgentType`, `overall`, `timeSeries` |
| `getDashboardStats` per range (warm, steady state) | `1h` 4.8 ms · `24h` 1.2 ms · `7d` 5.8–6.4 ms · `30d` 9.5 ms · `90d` 13.8–14.1 ms · `all` 12.9–13.4 ms | historical warm-query sample, not a reason to query on the host thread |
| first query in a fresh process (`1h` run0) | 434.2 ms | page-cache warmup, **not** rollup cost |
| `initDb()` | 866.9 ms (also measured 864.1 ms) | That already-initialized sample had unchanged mtime/size. This is not a read-only guarantee: initialization can create/migrate/backfill records. |
| `syncAllSessions()` | **7141 ms**, 3401 files / 151,107 rows | genuinely writes (DB grew 305.6 MB → 307.1 MB). Blocks the TUI event loop. Never call it inline. |
| `getDailyActivity(371)` | 195.6 ms | the query that forced `/usage` to use a subprocess. A rollup-backed panel does not call it. |
| `bun install` for `@oh-my-pi/omp-stats` | **84 ms**, 12 packages | also measured at 146 ms in a second run |

These are historical measurements, not current latency guarantees. SQLite work blocks its owning thread even when scheduled through a promise. Production isolates initialization, reads and live ingest; never query before worker initialization succeeds or turn failures into an empty dashboard. One blocked-worker mounted navigation/resize observation was 86 ms, not a responsiveness guarantee.

## Key Directories

| Path | State | Contents |
| --- | --- | --- |
| `CONTEXT.md` | **exists** | The glossary. Source of truth for vocabulary. |
| `AGENTS.md` | **exists** | This file. |
| `docs/research/omp-stats-tui/REPORT.md` | **exists** | The synthesis. Read this first after `CONTEXT.md`. |
| `docs/research/omp-stats-tui/findings/` | **exists** | F1–F19, one file per investigation. F9 (import strategies), F10 (glyph system, numeric formatting) and F11 (zero-install paths) are the load-bearing ones for implementation; F12–F19 extend them (install footprint, morning cleanliness, glyph/icon measurements, web portable logic, first-query latency, chart scoping, chart iconography). |
| `docs/adr/0001…0008` | **exists** | Eight settled decisions. See §Settled Decisions. |
| `docs/plans/` | **exists** | `2026-10-05-dashboard-parity.md` — workflow roadmap; `2026-10-06-ui-polish.md` — production UI decisions and mounted review. The 2026-10-03 plan is historical. |
| `src/` | **exists** | Source entry, isolated data client/protocol/adapter, panel and twelve retained feature controllers (the production render path), registry/showcase/probe IR and shared drawing primitives. `features/presentation.ts` reuses band metric/table drawing without rendering a production `ScreenSpec`; `charts/*` is shared directly. `dist/index.js` is the production entry. |
| `src/tui/chrome.ts` | **exists** | The one nav grammar: `NAV_GROUPS`, `screenForHotkey`, `ago`, `chipFor`, `progressLineFor`, `sidebar`, `topbar`. The sidebar column appears when the frame band allows it; the tab strip stands in as the drawer below that. |
| `src/tui/responsive.ts` | **exists** | `framePolicy(width)` — the frame band (`wide`/`medium`/`narrow`/`tiny`) and the chrome each band gets, derived from `BREAKPOINTS` in `src/tui/layout.ts`. Pure: no theme, no terminal, no data. |
| `test/` | **exists** | `bun test`: fixture arithmetic, layout boundaries, keyboard behaviour, sync error/settlement/cancellation and real subprocess reaping. Keep tests deterministic and isolated from the user's database. |
| `scripts/` | **exists** | `build.ts`, render/data/glyph probes and persistent `data-worker.ts`. |

There is a `package.json`, a `bun.lock`, `node_modules`, and a `.gitignore`. All four exist.

## Development Commands

### Compiled-host commands (18.8.6)

```sh
# Fast feedback loop: loads extensions, prints load errors to stderr,
# no interactive TUI, no LLM call. Exit code is 0 either way —
# read stderr, do not check $?.
bun run build
omp models -e /abs/path/to/omp-stats-tui/dist/index.js
```

**`-e` must come AFTER the subcommand.** `omp -e /abs/path.ts models` silently ignores the extension — verified: a probe extension that prints to stderr under `omp models -e` prints nothing under `omp -e ... models`. Same for `omp --no-extensions -e /abs/path.ts`, which is the form to use when debugging a single module in isolation (explicit `-e` paths still work with `--no-extensions`).

**Do not use `omp --help` to check a build.** It does not load extensions — verified: the same probe prints under `omp models -e` and prints nothing under `omp --help -e`.

```sh
# List installed plugins
omp plugin

# Install or link a plugin directory persistently
omp plugin link <dir>      # `omp install <dir>` is an alias for plugin install|link

# Isolate auth, sessions, settings and caches while debugging
omp --profile <name> -e /abs/path/to/omp-stats-tui/dist/index.js

# Read the extension error log
ls -t ~/.omp/logs/ | head          # files are named omp.<DATE>.<PID>.log, e.g. omp.2026-09-29.3585.log
```

**Nothing is ever printed to stdout from extension code.** stdout is the TUI's; writing to it corrupts the display. The child worker's stdout is a separate NDJSON protocol pipe, not the terminal. Extension diagnostics go to stderr and to `~/.omp/logs/omp.<DATE>.<PID>.log`. There is no extension hot reload: changed modules require rebuild/restart. This is distinct from the live worker's transcript watcher.

### Installed (verified on this machine)

```sh
bun install

bun run build
# Tests cover observable behaviour and lifecycle boundaries.
bun test

# Render any screen to stdout at any width, without launching a terminal.
# This is how a screen gets reviewed.
bun scripts/probe-render.ts [screenId] [--width N] [--range 24h] [--preset P]
```

`bun test` is the runner: **905 pass / 0 fail across 61 files**. Pure IR tests assert bands/resolved refs; feature-controller tests assert consumer-visible workflows. Mounted host verification remains separate from fixture coverage.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR, in two jobs. Both are the commands documented above, in order — if a step is not something a contributor already runs by hand, it does not belong there.

- **`test`** — `bun install --frozen-lockfile` → `bun run verify:patch` → `bun test` → `bunx tsc --noEmit`.
- **`extension-load`** — install → `verify:patch` → `bun run build` → install the pinned omp host → `omp models -e "$PWD/dist/index.js"`, asserting on **stderr** for `Failed to load extension`, per the exit-code rule above.

Two things in that file are load-bearing and must not be "tidied":

**`bun run verify:patch` runs immediately after every install.** It greps the installed `node_modules/@oh-my-pi/omp-stats/src/db.ts` for the `messages_cost_unpriced_v2` marker. The patch is what makes an absent price card read as unknown spend (ADR 0008), so an unpatched tree reports green on money honesty while lying about money.

**`node_modules` is deliberately not cached.** Its contents are a function of `bun.lock` **and** `patches/*.patch`; a cache keyed on the lockfile alone can restore an unpatched tree. If you ever add `actions/cache` for it, the key must contain both `hashFiles('bun.lock')` and `hashFiles('patches/*.patch')`. `setup-bun` already caches the one download worth caching, and a cold `bun install --frozen-lockfile` is ~3.4 s against a 933 MB tree.

`typescript` is still not a declared devDependency, so `bunx` resolves it unpinned on each run. That is a real reproducibility gap and is deliberately left visible in the workflow rather than hidden.

## Code Conventions & Common Patterns

These are the non-obvious ones. Each has already cost a future agent time once.

**Static imports only for `@oh-my-pi/*`.** Dynamic `import()` of *any* `@oh-my-pi/*` fails inside the extension loader, including `pi-tui` and `pi-coding-agent`, which work fine as static imports. The loader's resolve hook rewrites the specifier for static imports only; the dynamic path re-enters resolution into Bun's flat install cache.

**The theme API is `theme.fg(color, text)` and `theme.bg(color, text)`.** There is no `theme.colors` property. `ThemeColor` is a 60-member string union (`@oh-my-pi/pi-tui/src/theme/schema.ts:44`); the ten this panel actually uses are `"accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text"` — do not read that list as exhaustive, because `bg()` takes `ThemeBg` instead, a **separate** 7-member union that shares no name with it (`schema.ts:177`, see `SELECTION_BG` below). Also on the class: `theme.symbol(key)` (`theme-class.ts:463`), `theme.getSymbolPreset()` (`:477`), `theme.getColorHex(color)` (`:242`).

**Do not read the host `theme` eagerly at module scope.** It is undefined before theme initialization. Start with the theme passed to `custom()`, then refresh it from the initialized active host binding in the panel's render path and update `FeatureContext.theme`. Pass it to pure renderers; do not capture an obsolete theme in a controller closure.

**Resolve configured keys through `getKeybindings()`.** The custom factory's keybindings argument contains defaults rather than the user's manager. Production uses the supported public `getKeybindings()` and `matchesKey()` exports, not an unbundled private keybinding matcher.

**Component names.** Use the existing supported host root/chrome/theme imports (`OverlayPanel`, `PanelRows`, `PanelDivider` from the chrome surface); do not introduce private overlay or catch-all TUI imports.

**`Table` cells must be `{ text, style? }` objects.** Passing raw strings throws `undefined is not an object (evaluating 'e.replaceAll')`. For a numbers table prefer `renderTableRow(cells, columns, maxWidth?, options?)`, a free function.

**`bun:sqlite` is synchronous.** A promise/loading state is not CPU isolation. Initialization, queries, transcript reads and live ingestion belong to the persistent standalone data worker, never the panel thread.

**Emoji cannot be data ink.** `Bun.stringWidth("🪙") === 2` and `Bun.stringWidth("⬛") === 2` — verified. Any repeated emoji cell destroys the column grid. Emoji are fine as a single label where the label column is measured with the same function; they are categorically forbidden as a ramp step or heat cell. `Bun.stringWidth` is exactly what pi-tui measures with, so it is the function to check candidates against.

**Free functions over classes, where the evidence says so.** `renderProgressBar(...)` has 4 first-party call sites; the `ProgressBar` class has 0.

**Keep interaction and pure rendering separate.** Production routes are retained `FeatureController`s. Extend their existing focus/list/chart state for workflow changes; reuse `features/presentation.ts` and shared production plots for presentation. The `src/tui/screens/` registry and `ScreenSpec → renderScreen → renderBands` path remain pure chart/probe composition, not a replacement interaction model. Band primitives are shared with production metric/table rendering.

**Scroll clamping happens in `render()`, never in the key handler.** The handler adds and calls `requestRender`; the clamp to `maxScroll` happens during render, which makes shrink-on-resize automatic.

**Guard the mount.** `ctx.hasUI` is `false` in print/headless/RPC/ACP modes, and RPC can report `hasUI === true` while still not supporting `custom()`. Check `ctx.mode === "tui"` before mounting. `done(...)` must be called exactly once and `dispose()` must be idempotent — the host also calls `component.dispose?.()` in its own cleanup.

**Cache the heatmap layout.** `buildHeatmapLayout` rebuilds the entire grid on every call and its cost is unmeasured. Cache it per `(points, weeks)`.

**A value that cannot be resolved is `null`, never `undefined`, never `NaN`, never `"undefined"`.** `src/layout/resolve.ts` returns null explicitly from `resolveCell` / `resolveNumber` / `resolveLabel`; `test/resolve.test.ts` walks every ref in every spec against a route-shaped fixture, and `test/parity.test.ts` walks the same fixture against the web's own functions. An unresolvable ref is a test failure naming the screen and the path, not a blank cell a human has to notice.

**Band order is panel order — for the showcase.** `Band[]` in the spec *is* the vertical order (`src/tui/band.ts` G4: exactly one blank line between consecutive bands, none leading or trailing). Reordering a `/stats-test` section is reordering its bands. This says nothing about a production screen, which is a controller and has no bands.

**One nav grammar, two shapes.** `src/tui/chrome.ts` owns the sidebar, the topbar, the live/sync chip and the hotkey map (`NAV_GROUPS`, `screenForHotkey`, `chipFor`, `progressLineFor`). The panel shows the sidebar column when `framePolicy(width)` says the band affords one and falls back to the tab strip as the drawer below that — so the width decision belongs to `src/tui/responsive.ts` and nowhere else. Never re-derive a width threshold in a chrome module.

**Loading, empty and error are distinct states.** Missing/unread data is not measured zero; failed reads remain errors, and dirty rollups/un-ingested changes remain visible. Activity reads the latest 371 local days independently of the global stats range. Its recorded-day list supports focus/search/sort/selection/reveal/details, so narrowing the visible calendar does not discard fetched days. Empty lookbacks are stated explicitly; do not freeze incidental status wording in tests.

## Important Files

Historical research paths on the previous machine, not runtime import targets. Installed host files remain read-only.

| Path | Why it matters |
| --- | --- |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/omp-stats/src/server.ts:165` | `export async function handleApi(req: Request): Promise<Response>` — the data seam. Not re-exported from the package root, but the `exports` map declares `"./*": {"import": "./src/*.ts"}`, so the deep subpath `@oh-my-pi/omp-stats/server` is legal. |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/omp-stats/src/shared-types.ts` | The aggregate types: `AggregatedStats`, `ModelStats`, `TimeSeriesPoint`, `DailyActivityPoint`, `DashboardStats` and 14 others. A pure type module — zero runtime exports, `import type` only. |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/overlays/usage-dashboard.ts:533` | `export class UsageDashboardComponent implements Component` — the structural template. Data-heavy, read-only, async-loaded with distinct loading and error states, self-scrolling, frame-composed via `OverlayPanel` regions. **Read it, do not import it** — it couples us to an uncovered constructor and option shape. |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/overlays/usage-dashboard.ts:313` | Historical calendar reference. Production uses terminal-owned `src/tui/charts/calendar.ts`; never import this private overlay. |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/stats/activity-worker.ts` | The subprocess pattern for background ingest — the shape to copy if a sync is ever needed. Spawn a worker, stream over a pipe, parent `SIGKILL`s the child on `done`, so synchronous SQLite never runs on the TUI thread. |
| `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/theme/symbols.ts` | The three symbol presets (`unicode`, `nerd`, `ascii`) over a 269-entry map each, drawn from a 338-member `SymbolKey` union. `theme.symbol()` is a plain map read and **none** of the keys is a data-ink ramp — which is why data ink is hardcoded (ADR 0005). |

Supporting source worth knowing:

- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/extension-ui-controller.ts` — `custom()` host implementation. `KeybindingsManager.inMemory()` at `:1136`; `showOverlay` at `:1186`.
- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/selector-controller.ts` — `#showFullscreenMenu` at `:189`, the `fullscreen: true` overlay options verbatim at `:195`.
- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/input-controller.ts` — built-in slash commands are dispatched before extension commands here. The reason `/stats` can never be overridden.
- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/commands/stats.ts` and `src/cli/stats-cli.ts` — the built-in `/stats` browser path, and the complete flag set (`port`, `host`, `json`, `summary`). There is no sync-free JSON mode.
- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/theme/theme.ts:93` — `export var theme: Theme;`, the mutable binding that is undefined until init.
- `/Users/yuzu/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/keybinding-matchers.ts:32` — `matchesSelectCancel`.

## Runtime & Tooling Constraints

- **Supported runtime:** compiled omp 18.8.6, standalone Bun 1.4.2; stats/TUI/coding-agent packages are pinned to 18.8.6.
- **Production entry:** `bun run build` emits `dist/index.js` and `dist/data-worker.js`; the manifest loads the bundle. Direct source loading is not the supported compiled-host entry.
- **Module ownership:** bundle local stats/private dependencies; externalize only supported host API specifiers through the exact-match build resolver. Preserve host theme/keybinding/native singletons. Never discover a host source root or mutate installed packages to repair runtime resolution. The committed Bun dependency patch is the reproducible upstream correction.
- **Imports:** static public TUI/coding-agent roots plus supported named theme/chrome subpaths. Private overlays are not runtime APIs. The real standalone judge subpath resolves from the installed runtime coding-agent dependency in standalone Bun, not the compiled host registry; its resources open lazily when requested.
- **Workers:** resolve standalone `bun` from PATH, not compiled `process.execPath`. Source mode resolves `../../scripts/data-worker.ts` relative to `src/data/client.ts`; the build substitutes `__STATS_READ_WORKER__` with `./data-worker.js` relative to the bundled entry. Pass an absolute worker path; inherit host cwd for project/judge configuration, explicitly pass `PI_CODING_AGENT_DIR`, `OMP_PROFILE` and `PI_PROFILE`, and clear `PI_BUNDLED`.
- **Lifetime:** one persistent child per panel. Drain stdout/stderr and await exit; reject outstanding requests on spawn/pipe/exit failure with diagnostics while retaining cached display data. Close disposes controllers/watchers/jobs and SIGKILLs/reaps the child, ignoring late payloads/errors. A sync request is not a child-process completion.
- **No hot reload:** rebuild and restart after implementation changes.
- **Database boundary:** initialization can create/migrate/backfill records in the isolated worker; WAL/busy timeouts do not make writes read-only or eliminate contention. Use isolated HOME/profile data for verification.

## Testing & QA

**Runner: `bun test`.** Test consumer-visible behaviour, boundaries and transitions; avoid source-text, forwarding and incidental implementation snapshots. Real subprocess tests must reap their children. Current state: **905 pass / 0 fail across 61 files**. Full TypeScript `--noEmit` checking passes after integrating maintainer corrections and repairing the local incomplete typing installation; do not repeat the roadmap's old 19 diagnostics as current.

**Unit-testable:**

- The glyph ramp and the preset resolution — one `switch`, no branches in render code. Assert per-role codepoints and per-level indices; assert `Bun.stringWidth === 1` for every data-ink candidate.
- Numeric formatters — compact vs integer split, the cache-split rule, unpriced surfacing, the `formatDurationMs`/`formatElapsed` switch at 60 s, the cache-rate denominator (cache **writes** are excluded).
- Range → bucket mapping, and range validation. `365d` is **not** a valid key and silently falls back to the `24h` default — a range picker offering "365 days" would show 24 hours of data with no error. The valid set is exactly `1h | 24h | 7d | 30d | 90d | all`.
- The data seam against recorded fixtures — freeze the `handleApi` JSON shapes (`/api/stats` gives 8 top-level keys; `/api/stats/overview` gives `byAgentType`, `overall`, `timeSeries`). The injected `Reader` serves the fixtures, so no test touches the database.
- The IR against a route-shaped fixture: every `MetricRef` in every spec resolves (`test/resolve.test.ts`), and the resolver answers identically to the web's own functions on the same input (`test/parity.test.ts`).
- Layout grammar invariants: every band stays within `innerWidth` — swept across **every width 40–200 on all three presets**, not a sample (`test/band.test.ts`), with a separate narrow case at `innerWidth` 20 — plus no rendered line containing a rule character (the G5 invariant, asserted literally in the same file), band order preserved, and N bands yielding exactly N−1 blank lines (G4).
- Multi-series composition by equality: with labels off, `renderSeriesChart(...)` must equal the hand-rolled per-series `renderDailyBars` calls byte for byte (`test/chart-primitives.test.ts`), so a second rendering path fails instead of shipping beside the first.
- Colour and tabs by measurement: every `PALETTE` role resolves to a real token and every `TAB_SHORT` entry is one cell on all three presets (`test/palette.test.ts`, `test/tabs.test.ts`).
- Layout functions, given a fixed width and a `process.stdout.rows`.

**Two guards are load-bearing and were restored deliberately — do not let them lapse:**

- `test/theme-fidelity.test.ts` scans **all of `src/**/*.ts`** (`Bun.Glob`), features included, and asserts that every colour token at a use site is one `PALETTE`/`SERIES_COLORS`/`SIDEBAR_INK`/`TAB_INK` role rather than a bare literal, that no hex literal appears outside `palette.ts`, and that `palette.ts` is the only module emitting a colour escape. It includes a negative control and a non-empty reference-set assertion, so the scan cannot pass vacuously. Feature modules are in scope because that is where a hand-picked colour actually appears; the file also pins that no features module hand-draws its own glyph or private colour table.
- `test/chrome.test.ts`'s number-row block pins the digit/jump contract for the **twelve**-screen registry: each of the ten digits is live and indexes a distinct `SELECTABLE_SCREENS` entry, each digitless screen is reachable by arrows, `tab` and its `g` letter, and the *count* of digitless screens is pinned so a thirteenth fails on purpose. It deliberately does **not** assert `SELECTABLE_SCREENS.length <= 10` — that invariant is unsatisfiable at twelve and would only ever yield a permanently red assertion. `DIGIT_KEYS` there is a deliberate mirror of `panel.ts`'s module-private `DIGITS`; the two must move together.
**Mounted verification is separate from unit tests.** Phase 1 exercised actual compiled-host mount/navigation/resize/sync/errors/dismissal. Later observations include no host DB startup, blocked-worker navigation/resize (86 ms, not a guarantee), actual unknown-price `N/A`, persistent-worker automatic ingestion of one root plus two child JSONL sessions (eight requests), and request details/associated trace opened. They do not establish the whole route/broker/paid/custom-theme matrix; the parent integration owner runs the affected suite and mounted matrix after edits settle.

**Correctness traps that tests should cover:**

- There is no `cachedTokens` field. `cacheRate = totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)` — writes are excluded from the denominator, so the rate can read low while the cache is doing most of the work.
- `totalCost` silently under-reports by the unpriced requests. **Render `unpricedRequests` beside cost, always.** A cost figure shown without it is a wrong number, not a rounded one.
- `cacheSavings` is a dollar-savings ratio, not a token count, and can be negative.
- Rollup staleness: above 96 dirty hours (`EXACT_DIRTY_LIMIT`) reads stop unioning dirty hours and return stale rows with not-yet-built hours missing. Show the dirty-hour count rather than presenting the gaps as zeroes. A `ROLLUP_VERSION` bump DROPs and rebuilds every rollup row, so a panel without `getRollupStatus()` shows holes as zeroes — a lie about money.

## Settled Decisions

Each is an ADR. Do not relitigate without new measurement.

| ADR | Decision | Why |
| --- | --- | --- |
| 0001 | Reuse the declared, patched upstream stats dependency; original own-SQL decision superseded. | Preserve the upstream rollup union, dirty-hour rules, shared types and aggregators. Pricing-v2/rollup-v3 corrections ship via Bun's locked patch; there is no plugin-owned narrow SQL exception. |
| 0002 | The command is `/stats-tui`, not `/stats`. | Built-in slash commands dispatch before extension commands. An extension registering `/stats` appears in the palette and never executes — the worst kind of bug, because it looks like it works. |
| 0003 | Historical no-write/no-sync policy is superseded. | Ingest is cancellable; initialization itself can create/migrate/backfill records. Do not claim a read-only DB handle. |
| 0004 | Terminal-native rendering remains; reduced feature scope is superseded. | The active roadmap requires all web workflows, including keyboard-operable Traces and Frustration, without porting React components. |
| 0005 | Terminal-owned width-one chart glyphs with explicit preset fallbacks and active-theme colours. | The original Unicode-only ASCII mismatch is superseded. Presets are settings, not font detection; theme colours arrive injected/current per render, and each cell has one foreground/background. |
| 0006 | One persistent isolated data/live subprocess, killed on close. | Standalone Bun runs the shipped JS worker; upstream `StatsLive` owns initial ingest, transcript watching and manual sync. Live status/invalidation travels over NDJSON, and failures remain visible beside cached data. |
| 0007 | The `ScreenSpec → renderScreen → renderBands` IR is retired as the production render path and kept for the showcase, the nav identity and the probes. | Screens grew focus, search, sort, staged loading and retained state, and a static band grammar cannot express any of it. `Band[]` as a rendering IR caps the product at static layouts; keeping it live alongside the controllers is the two-grammars-fighting state the IR existed to prevent. It is NOT dead: `/stats-test` (`src/index.ts`) is a shipped command that renders through `renderScreen`, and `tabs.ts`/`chrome.ts`/`panel.ts` read `SCREEN_SPECS` for the real nav. See CONTEXT.md's IR scope map for which file survives for which reason. |
| 0008 | Upstream correctness corrections ship as a locked Bun `patchedDependencies` patch, not as plugin SQL and not at runtime. | An absent price card is a classification bug inside the dependency, and a panel query cannot make already-cached rollups stop serving the wrong answer. It also fixes four more defects (range-before-limit recent requests, provider `outputTokens`, `StatsLive({ workers })`) in one reviewable diff instead of four plugin workarounds. The cost is that `bun install` becomes correctness-critical: `node_modules` is a function of `bun.lock` **and** `patches/*.patch`, so `bun run verify:patch` runs in CI immediately after install and no `node_modules` cache may key on the lockfile alone. Upstream PR `can1357/oh-my-pi#14543`. |

## Do Not

Dead ends already disproven by experiment. Re-testing any of these wastes hours.

- **Do not write our own SQL** over `~/.omp/stats.db`. Reuse the package. Owning SQL requires re-implementing the rollup union, the staleness rule, the aggregate column list and the schema-version check, and it discards `syncAllSessions` entirely. ADR 0001 is the only argument for it and research superseded it.
- **Do not use runtime `Bun.plugin` hooks or host-root discovery to repair dependency ownership.** Use the existing production build and supported host externals; `Bun.build` resolution is distinct from runtime-loader resolution.
- **Do not use dynamic `import()` of `@oh-my-pi/*`.** It fails in the extension loader even for packages that work fine as static imports. The loader's resolve hook rewrites static specifiers only.
- **Do not use braille for data ink.** One foreground colour per character cell, so per-day and per-level heatmap colour is impossible — it destroys exactly the channel a heatmap depends on. It also has the wrong aspect without a 2:1 fudge that breaks on resize, and renders as tofu rather than degrading gracefully. omp uses braille only for the decorative title spinner.
- **Do not use emoji for data ink.** `Bun.stringWidth` reports them as 2 cells (verified for `🪙` and `⬛`). Any repeated emoji cell destroys the column grid.
- **Do not use Nerd Font codepoints for chart marks.** There is no Nerd glyph whose semantics is magnitude; the candidates are powerline separators and icon glyphs meaning something unrelated. Under the `nerd` preset, emit byte-identical characters to `unicode`.
- **Do not silently substitute token count for a cost metric.** Request/token/output/cost modes are explicit controller choices; retain the matching units and scale for each. Comparable token volume need not imply comparable spend.
- **Do not print a bare token total.** The user is 95.13% cache-read by token, so a single "24.4B tokens" figure is true and useless. Show cache-read and fresh as separate columns, dim the cached portion, and print the cache share as a number.
- **Do not render `$0.00` for unknown spend.** Missing provider/model price cards are marked unpriced by the patched upstream pricing boundary, with historic replay and rollup invalidation. `costWithUnpriced` prints `N/A`; explicit free prices or recorded zero charges may legitimately be zero. Do not restore the removed plugin SQL workaround.
- **Do not call `syncAllSessions` on the TUI thread or create a second sync owner.** Persistent `StatsLive` in `scripts/data-worker.ts` owns automatic/manual sync and its standalone ingest worker. `StatsReadClient.requestSync()` targets it.
- **Do not offer `365d` in a range picker.** It is not a valid key and silently falls back to `24h`.
- **Do not query before worker `initDb()` succeeds.** Upstream rollup getters may silently answer empty/zero; initialization failures must remain errors rather than empty usage.
- **Do not make local provider aggregates wait for broker quota, or eagerly load request transcripts/judge resources.** Independent window/account reads and lazy request details use the isolated worker; provider-network errors are not an empty local dashboard. Paid judging requires estimate, explicit confirmation and cancellation.
- **Do not port the React dashboard**, and do not reuse `UsageDashboardComponent` directly — read it, do not import it.
- **Do not take the native/TSP rendering backend.** `usage-dashboard` implements a second rendering backend behind a capability probe; the ANSI path is the one we can rely on.
- **Do not print to stdout from extension code.** It corrupts the TUI.
- **Do not duplicate charts per feature.** Production bucket plots use `src/tui/charts/time-series.ts` with injected theme, formatted units and explicit null gaps. The separate pure IR/probe path uses `compose.ts` over `renderDailyBars`; its composition tests do not exercise production route interaction. Calendars, categorical version rates and trace timelines keep their existing domain-specific primitives.
- **Do not emit a full-width rule in any body.** `src/tui/band.ts` G5: `─`, `━` or `═` inside a band is a bug, full stop. The only rule in the whole panel is the `PanelDivider` between body and footer (G6). `test/band.test.ts` asserts G5 literally for every band kind and every preset.
- **Do not hardcode colours or heading glyphs.** Use active omp theme roles via `src/tui/palette.ts` (`PALETTE`/`SERIES_COLORS`, resolved for the current theme). Pure modules receive theme/paint arguments and the feature context is updated per render. Heading glyphs use `statsIcon`; data ink uses the chart glyph policy.
- **Do not fold the background table into `PALETTE`, and do not paint a `ThemeBg` through `fg()`.** `selectedBg` is a `ThemeBg`, not a `ThemeColor` — `isValidThemeColor("selectedBg")` is false — so the panel's only background fill keeps its own `SELECTION_BG` table, each role carrying a citation. `test/palette.test.ts` pins both directions: `isValidThemeBg(SELECTION_BG.band)` is true while `isValidThemeColor(...)` is false, and no `PALETTE` role is a background token. Folding the two axes together fails for a reason that reads like a typo rather than like the mistake it is.
- **Do not move a trace span colour out of `SPAN_COLORS`.** That ladder is the web's, not ours: every entry cites `CATEGORY_VARS` in `@oh-my-pi/omp-stats/src/client/traces/trace-colors.ts:37-43` and the CSS custom property behind it. A `Record<K, ThemeColor>` beside its only renderer has no citation and no use-site literal for a scan to find.
- **Do not reimplement `pivotSeries`, `densify`, or `buildCostSummary`.** Import them from `@oh-my-pi/omp-stats/client/data/*` and call the host's function on the same input. `test/parity.test.ts` calls the web's own functions and asserts our resolver answers identically, so a second implementation of the arithmetic fails rather than drifting.
