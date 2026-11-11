# Terminal stats dashboard: execution roadmap

## Goal and scope

Port every user-facing workflow in omp's web stats dashboard to `/stats-tui`, then polish the terminal presentation. Feature parity means reachable data and working interactions, not just matching fixture totals. Keep `/stats` as the host's browser command; this extension does not override built-ins.

Production now integrates twelve interactive screen controllers: Overview, Activity, Models, Costs, Projects, Requests, Errors, Tools, Providers, Gain, Traces and Frustration. Activity is the additional `/usage` calendar alongside the eleven web routes. Source implementation is not a claim of fully exercised acceptance; the complete mounted workflow matrix and integrated suite remain pending.

This roadmap supersedes the old implementation plan's scope exclusions, placeholder policy and universal read-only claims. Keep its reusable renderer and data helpers; do not copy its historical version/latency claims as current evidence.

## Architecture decisions

- Extension entry → host fullscreen custom overlay → retained feature controllers → persistent isolated read/live client → patched upstream stats library. The original IR remains the pure chart/probe renderer. No React port, independent SQL backend or HTTP listener.
- Synthetic localhost `Request`s invoke upstream `handleApi` inside the worker; they do not perform network I/O. Quota broker requests are separate, independent reads rather than a listener or prerequisite for local usage.
- Use supported host exports at runtime. Do not discover host source paths, duplicate theme/keybinding singletons or depend on unbundled catch-all TUI subpaths.
- Build a production plugin bundle containing locally owned stats/private modules with supported host APIs external. The manifest loads `dist/index.js`; ship `dist/data-worker.js`, not a copied TypeScript asset. Standard Bun `patchedDependencies`, committed patch and lockfile reproduce the corrected upstream code in the bundle.
- Support compiled omp 18.6.1 and standalone Bun 1.4.2 with aligned package pins. The runtime coding-agent dependency supplies real standalone judging in Bun; judge/auth resources open lazily only when requested, never via a dynamic import or fake judge.
- One persistent `StatsReadClient` per mounted panel owns the isolated worker. The child initializes the DB, reads facts/transcripts and owns patched upstream `StatsLive({ workers: 1 })` with initial ingest, transcript watching and live NDJSON invalidation. Manual `requestSync()` targets that same live owner, not a separate one-shot worker.
- Compiled omp is not a standalone Bun runtime: resolve `bun` from PATH. Source mode uses `scripts/data-worker.ts`; the build's `__STATS_READ_WORKER__` macro uses `./data-worker.js` relative to the bundle. Pass absolute worker paths and active agent directory/profile, inherit host cwd for project/judge configuration, and clear `PI_BUNDLED`.
- Initialization can create/migrate/backfill shared records in the child. No host-thread DB startup and no read-only SQLite guarantee. Upstream pricing-v2 replay/rollup-v3 invalidation correct absent-card semantics; recent requests apply range before limit, and provider series expose actual `outputTokens`. No plugin SQL workaround remains.
- Per-character sparkline/bar/calendar/timeline colours use supplied active omp theme roles. The panel updates mutable `FeatureContext.theme` per render; primitives take theme/paint arguments. Each cell has one foreground/background; do not promise independently coloured braille dots.
- Graph/legend identity includes model + provider. Resolve/dedupe active theme hues and preserve labels/glyphs when roles alias; never pin web hex colours. Dark/light/custom themes and truecolour/256-colour primitives have exercised evidence below.
- Request details, quota reads and paid judging load on demand. Frustration is passive for cached/regex reads; judging obtains an estimate, requires explicit `y` confirmation and supports cancellation. Missing credentials do not block implementing that UI.
- `Ctrl+P`/`Ctrl+N` navigate screens unless overridden by host selector bindings; `[`/`]` navigate outside text entry. `Tab` cycles route focus/view; focused analytics tables precede charts. `r`/`R` range and `s` sync apply outside search. `q` closes outside text entry; `Ctrl+C` always closes. `Esc` backs out before closing. Printable `q` and brackets are searchable. `g` jumps cover all twelve routes. Preserve transcript/controller state, dispose once, cancel work and guard query identities.

## Execution rules

Track implementation separately from acceptance gates. Checkboxes under **Work** record source implementation only, not mounted/broker/paid/custom-theme verification. Record only exercised checks, exact failures and remaining scope. The integration owner runs shared checks after related edits settle; retain consumer-visible regressions, not source-text/wiring snapshots. Update affected permanent documentation as each cutover ships.

## Phase 1 — Reliable host integration (complete)

### Work

- [x] Align stats/TUI/coding-agent version pins and compatibility reporting with the supported compiled host.
- [x] Migrate unsupported TUI import paths to bundled public exports; eliminate the incomplete native debug-only rendering surface rather than shipping a second fake UI.
- [x] Preserve the existing calendar semantics without depending on an unbundled private overlay module.
- [x] Build a reproducible production extension entry and ship its worker asset; the manifest loads the built entry, not an unsupported mixed source graph.
- [x] Launch the shipped sync worker with a real Bun executable, not `process.execPath` under compiled omp.
- [x] Surface spawn errors, stderr diagnostics and premature worker exits in the panel; close must cancel the worker without an error notification.
- [x] Verify theme-derived ANSI rendering and actual plugin load/mount/navigation/close in the host.

### Acceptance gate

Actual compiled-host extension load succeeds without extension errors. `/stats-tui` and its existing visual showcase mount, switch screens, scroll and dismiss without damaging the underlying transcript. Sync completes against isolated session data; missing Bun and early child failure report useful errors, and close cancels outstanding work. Dark/light and truecolour/256-colour probes prove per-cell colours, not only unstyled geometry. Installation instructions name the Bun prerequisite and supported host accurately.

### Exercised evidence

- Runtime: compiled omp 18.6.1, Bun 1.4.2, Linux arm64. Upstream clone 18.6.2 was inspected but is not the declared supported runtime.
- `bun run build` succeeded, emitting `dist/index.js` and its worker asset. `omp models -e …/dist/index.js` loaded without extension errors.
- `omp plugin link /tmp/omp-stats-tui` succeeded in an isolated HOME. A real host started from `/tmp`, without explicit `-e`, discovered the manifest entry, mounted `/stats-tui`, completed sync and restored the normal terminal on dismissal.
- Actual PTY/debug-socket frames exercised Overview/Activity/Costs navigation, `g` jumps, range cycling, scroll, widths 40/60/100, `q`/Esc dismissal and the Charts showcase. Alternate-screen state returned to false, overlays to zero, and the underlying transcript warning was retained.
- Real worker ingestion of an isolated JSONL session produced one request and 120 tokens; an independent `--profile phase1-smoke` scenario ingested its own profile fixture. Fixture costs were synthetic recorded values, not paid model calls.
- Missing standalone Bun reported the install/PATH/restart instruction while retaining cached data. An actual terminal check exposed truncated instructions; a failing-before regression led to wrapping, then mounted checks confirmed recovery text at widths 40/60/100.
- Explicit fault injection replaced only the smoke environment's Bun executable with an exit-7 child: the mounted panel showed both premature-exit status and captured stderr. Closing during sync returned to the chat without a late error overlay; subprocess regression coverage verifies SIGKILL and child reaping.
- Dark/light × truecolour/256-colour probes exercised the Phase 1 calendar/bar renderers: four distinct heat levels, theme-styled series glyphs and bounded widths. At that point dynamic/custom-theme refresh and remaining sparklines were still Phase 6 work; this is historical evidence, not acceptance of the later cutover.
- Final isolated suite: **854 passed, 0 failed, 54 files** <!-- as-of 2026-10-05, pre-merge baseline; do not update -->. Removed the incomplete native probe/wiring assertions and a nondeterministic test dependent on the user's live model population. No static typecheck result is claimed.
- All mounted scenarios used isolated HOME/config/session data, no credentials and no LLM calls. README, contributor constraints and affected ADRs now describe the production entry and current scope.

**Historical Phase 1 boundary:** request-range filtering, discarded rows, grouped identity, agent shares, pricing and blocking reads were not resolved by Phase 1. Their subsequent source implementation is recorded below; Phase 1's evidence alone does not prove dashboard parity or continuous freshness.


## Phase 2 — Data correctness and responsiveness

### Work

- [x] Use upstream `MessageStats`; apply selected-range cutoff before recent-request limit and distinguish loaded population from complete-range totals.
- [x] Remove the table row cap derived from column count; shared list reveal/selection makes every fetched row reachable.
- [x] Materialize normalized error groups and model failure counts from upstream complete groups, not individual rows or summed request IDs.
- [x] Use model + provider identity consistently in grouped charts, cost rows and performance lookups.
- [x] Correct agent token shares, succeeded/failed series, sparse bucket densification and timing units.
- [x] Correct unpriced semantics in the shipped upstream ingestion/aggregation patch: explicit free prices, recorded zero charges, absent cards, provider identity and per-bucket attribution; pricing-v2 historic replay and rollup-v3 invalidation replace the plugin's SQL approximation.
- [x] Isolate blocking initialization/fact scans/transcript reads behind persistent `StatsReadClient` and standalone worker; the host source entry does no DB initialization.
- [x] Distinguish initialization, empty data, failure, dirty rollups and un-ingested transcripts.

### Acceptance gate

Adversarial populated fixtures and isolated database scenarios cover range boundaries, sparse series, identical model IDs on different providers, repeated error signatures and unknown pricing. All rows can be reached. Compare upstream and terminal outputs on the same recorded data. Observe responsive input/rendering while initialization and expensive reads run; stale/unknown data is never presented as measured zero.

### Observed evidence and gate status

The source work above is implemented. Observed isolated compiled-host evidence: no main-thread DB startup; navigation/resize while a read worker was blocked at 86 ms (one observation, **not** a latency guarantee); actual unknown-price data displayed `N/A`. The persistent worker automatically ingested a recorded root plus two child JSONL sessions, totaling eight requests, and refreshed live data. Request details (timing/TTFT, tokens and component costs) and the associated trace were opened; close reaped the child and restored alternate-screen state. These scenarios used no credentials or LLM calls.

**Gate complete.** Real recorded sessions reached 612 requests, including 601 unknown-price requests across two providers with the same model ID and 201 failures. Mounted 500→2,000 loading reached the oldest recorded request and its timing/details; range, normalized error groups, token shares, sparse buckets, recorded-zero and unknown-price attribution have database/controller regressions. Oversized responses exposed a real partial-NDJSON/EAGAIN failure; serialized asynchronous stdout flushes repaired it, with a permanent 601-request subprocess regression.

## Phase 3 — Shared interaction model and core routes

### Work

- [x] Retain per-screen focus, row selection, sorting, search, selectors, reveal/load actions, chart mode/series toggles and point inspection.
- [x] Lazy request details: timing/TTFT/throughput, token categories/premium, component costs, status/error, identity, output, entry and raw stats JSON; copy/back/associated trace actions.
- [x] Requests: status counts/filter, model/provider/project search, 500/2,000/10,000 load stages, completeness notice, sortable/revealable rows and details.
- [x] Errors: 50/200/1,000 load stages, signature selection, model filter, search, clear filters, latest-request action and details.
- [x] Overview: requests/tokens/cost mode, token/agent shares, latest-request details and all-requests navigation.
- [x] Models: share/count time modes, series visibility, sortable/revealable table, expanded statistics and throughput/TTFT chart.
- [x] Costs: daily model/component modes, series toggles, unpriced bucket inspection and sortable/revealable component/model breakdown.
- [x] Tools: chart controls, selected-tool model breakdown, selector/reset and sortable/revealable tables.
- [x] Projects: default temporary-folder exclusion, search, keyboard-selectable cost/request rankings, temporary markers, unfiltered aggregate totals and sortable/revealable rows.

### Acceptance gate

Exercise every control with keyboard in the mounted host, plus supported mouse interactions. Selection/focus survives returning to a screen. Search/sort/filter changes affect the correct population. Narrow layouts keep omitted columns reachable in details. Clipboard errors are explicit. No static `expandable` metadata substitutes for actual expansion.

**Gate complete for local terminal workflows.** Mounted core routes exercised chart modes/visibility/point inspection, table focus/search/sort/reveal, request timing/TTFT/component details, associated-trace navigation, error groups and temporary-project filtering. At widths 40/60/100/160, frames remained bounded without NaN/undefined output. Installed-package mouse sidebar navigation selected Models. A real clipboard attempt reported the unreachable X11 clipboard explicitly; physical clipboard contents cannot be verified in this headless environment. Printable `q`/brackets remain searchable; Ctrl+C restores the transcript during text entry.

## Phase 4 — Complete Providers and Gain

### Work

- [x] Providers: expandable token mix, tokens/output/requests/cost burn modes, series controls and peak-hour/provider selection.
- [x] Independent provider windows/accounts: subscription capacity, demand, exhaustion/headroom, provider/window/account selection, utilization histories, latest/peak/reset readings and progressive account tables. Missing broker credentials are reported independently of local usage.
- [x] Gain: remembered project selector, project-scoped totals, daily savings/cumulative history, sparkline and sortable source breakdown.
- [x] Preserve Activity calendar with distinct empty/loading/error states and theme-derived intensity; latest 371 local days remain independent of the global range, and recorded-day focus/search/sort/reveal/details keep fetched days reachable at narrow widths.

### Acceptance gate

Exercise broker-configured, local fallback, absent quota data and network failure cases without freezing other screens. Changing provider/window/account or Gain project scopes both rows and charts correctly. Old requests cannot overwrite a new selection. Compare daily and cumulative gain values with the web calculations.

**Local gate complete; authenticated broker verification remains external.** Nine real usage-history snapshots across two accounts exercised latest/peak/headroom/reset/history and fleet demand/capacity/exhaustion calculations in mounted Providers. A real Gain journal plus a normal-project session produced 1,734 saved tokens globally versus 500 in the selected project, retained after navigation. Activity and provider/Gain boundary, selection, stale-request and independent-network-failure behavior have controller regressions. No credentialed broker connection is claimed.

## Phase 5 — Traces and Frustration

### Work

- [x] Traces: searchable/sortable/revealable root list, child summaries, open/back, time/turn/call axes, idle compression, hierarchical duration-preserving timeline, zoom/pan/fit/focus and selected spans. Upstream root discovery considers at most **300 candidates**, not exhaustive history.
- [x] Trace minimap, track collapse/expand, span search/match cycling, linked transcript/markers, tool duration/errors, entry/span details, JSON copy and child navigation. Keyboard cursor supplies a zoom anchor.
- [x] Passive Frustration: cached/regex metrics/coverage; class/family/sample/mostly-regex controls; layered rates/trend, sortable versions and raw model IDs.
- [x] Real standalone judge prerequisite and estimate/explicit `y` confirmation/start/cancel UI, with progress/cost/concurrency/results/errors. Lazy judge resources and explicit-action headers replace any fake judge or silent paid start.

### Acceptance gate

Navigate real nested session traces from a request, select spans and inspect matching entries; zoom/pan/axis changes preserve selection semantics. Cached frustration works without initiating paid requests. A configured real judge exercises quote, explicit confirmation, progress, cancel and results; if credentials are unavailable, report that prerequisite and verify all reachable passive/error paths without claiming the paid scenario passed.

**Nested/passive gate complete; paid execution remains external.** Mounted real root→Scout→Grandchild traces exercised recursive tracks, expansion, axes, idle compression, zoom/pan/fit, child open/back and request-linked entries. Passive Frustration read three recorded user turns without spending. The installed package invoked the genuine standalone quote path and displayed “No judge model is available. Configure the `judge` model role.” Explicit `y` authorization, action headers, polling, cancellation and disposal have controller regressions; no paid model execution is claimed without credentials and spend authorization.

## Phase 6 — Live lifecycle, polish and release

### Work

- [x] Persistent worker-owned initial/ongoing ingest and committed-data invalidation refresh active queries while retaining controller state; trace/session/job refresh and manual refresh/sync actions are implemented.
- [x] Dispose watchers/timers/controllers/workers on close and guard old/new query identities. Live state derives from upstream worker status, not a static label.
- [x] Source-level hierarchy, spacing, compact/wide layouts, graph axes/legends, route hints and empty/error presentation are integrated with the interactive controllers.
- [x] Active-theme per-cell/per-series graph styling covers sparklines, bars, calendar and timelines, with mutable injected theme refresh, alias hue resolution and retained labels/glyphs. Theme-change/light/256-colour/custom-theme acceptance is separate below.
- [x] Update permanent README/contributor/renderer/ADR documentation for twelve controllers and the isolated live worker, removing current subset/read-only/one-shot and SQL-workaround claims.

### Acceptance gate

Full web-route workflow matrix exercised in compiled omp; populated/empty/error/stale data, resize, narrow widths, Unicode/Nerd/ASCII presets, dark/light/custom themes, continuous transcript updates and cancellation. Installed plugin uses no server and leaves transcript intact. Run the affected suite once after integration; include actual terminal evidence separately from fixture tests. No excluded web route, unfinished selectable screen or pretend live state remains.

**Local lifecycle/theme gate complete.** Actual transcript additions automatically invalidated and refreshed mounted queries. Killing the installed read worker showed “Sync failed” with retained cached data; manual sync restarted the service. Closing restored normal-screen state and reaped workers. Dark→custom→light switches changed mounted graph ANSI ink without replacing the overlay; dark/light/custom × truecolour/256-colour primitive probes produced individually coloured measured spark cells, distinct heat levels, shared series/legend identity and bounded 40/60/100/160-column charts. Final suite/package evidence is recorded below.

### Final automated verification

- Supported runtime: compiled omp 18.6.1, standalone Bun 1.4.2, Linux arm64.
- Final plugin suite after remaining route workflows, terminal polish and unrelated-trace history regression, as observed at the time of this roadmap: **872 passed, 0 failed, 60 files**, 102,485 assertions. **Superseded** — the current suite is **895 passed, 0 failed, 61 files** <!-- as-of 2026-10-05, pre-merge baseline; do not update -->; see AGENTS.md §Testing & QA.
- Upstream source ingestion/cost/range/provider/rollup/incremental/serial suites: **56 passed, 0 failed, 7 files**. Filtered production workspace dependencies were installed; the runner used the released 18.6.1 Linux-arm64 native addon as a temporary fixture because the 18.6.2 workspace addon was not built. The temporary native link was removed afterward; no current-native build is claimed.
- Production build emits only `dist/index.js` and `dist/data-worker.js`. The packed distribution contains those two bundles, the standard dependency patch, package manifest and README; no scratch smoke scripts or one-shot worker are shipped.
- Clean tarball installation with production dependencies only was linked with `omp plugin link` and discovered from `/tmp` without `-e`. Actual recorded-session ingest, 612-request loading/details, clipboard failure presentation, mouse navigation and the genuine judge prerequisite path ran in compiled omp.
- A second clean installation of the final focused-viewport archive proved End→Tab→search keeps the no-match `q[]` query visible at 100×40 and 40×30. Ctrl+C closed active text entry; a settled narrow-terminal close matched the original normal-screen/cursor state, and the host exited 0. Immediate debug snapshots can precede the host's asynchronous overlay cleanup.

### Remaining-feature completion

- Core routes: keyboard calendar day/week selection, quiet-day inspection and historical narrow-window navigation; individual model/tool trends including identities folded into Other; request JSON section expansion/copy and failed-read retry; independent error-panel sorting and signature/model reset; retained initial row, timestamp and legend identities.
- Providers/Gain: selected provider/account identity survives sorting and refresh; account reads remain independent of blocked/failed local/fleet reads; burn details match hidden/top-six/Other series, exhausted snapshots remain visible independently of utilization; zero peak buckets have no fake bars; bounded project selectors and distinct daily/cumulative theme colors.
- Traces: interactive category-density minimap seek/range brush/edge resizing/movement; marker-only and empty tracks; rendered-cell picking, zero-duration events, collapsed-descendant exclusion and reverse-search boundaries; nested-history exhaustion returns to the originating retained request inspector.
- Frustration: running/start/cancel state survives missing/failed passive metrics, cancellation during post-start reads releases starting, stale loading clears without discarding coverage, externally observed runs invalidate estimates, failures remain retryable, class/family/message population totals and honest zero-rate presentation.
- Chrome: controllers receive the actual available body height; footer uses full frame width and shows the visible row interval without dropping close on narrow terminals. Provider/Gain control hints wrap instead of losing their trailing actions.
- Mounted compiled omp read 612 recorded requests; request #612 retained its expanded JSON section across associated-trace minimap brushing and return. Activity opened a quiet day and moved a 40-column historical calendar window. Providers exercised retained totals/token mix, real recorded window/account utilization and exhaustion; Models switched performance/request trends, Tools opened by-tool trends, Gain inspected UTC savings history, and passive Frustration inspected raw IDs and the genuine missing-judge quote error. Closing restored zero overlays, normal screen and visible editor cursor. No paid calls were made.
- Packed production-only installation was linked and discovered from `/tmp` without `-e`. Gain switched from 1,734 saved tokens across all projects to 500 tokens for `/home/recorded/code`; recorded quota accounts exposed capacity/headroom/reset/exhaustion details. The final packed navigation fix passed prior-unrelated-trace browsing → request #612 → associated trace → Back, restoring the expanded Session entry. Its 40-column calendar opened a quiet day and returned to today.
- Additional static checking was **not green** when this roadmap was written: the installed `@types/bun` package lacked its declared `index.d.ts`, and overriding with `--types bun-types` reported 19 diagnostics in seven files outside this remaining-feature edit set (`scripts/data-worker.ts`, `scripts/probe-data.ts`, `src/data/client.ts`, `src/tui/showcase/spec.ts`, `src/workers/process.ts`, `test/layout-ir.test.ts`, `test/upstream-unpriced.test.ts`). **Superseded** — `bunx tsc --noEmit` now exits 0 and is run in CI, so this gap no longer exists and the list should not be carried forward as current.


## Release prerequisites

- GitHub authentication is available. Plugin PR: https://github.com/yuzu-octopus/omp-stats-tui/pull/1. Upstream correctness PR: https://github.com/can1357/oh-my-pi/pull/14543.
- Paid smoke needs a configured judge role and provider credentials plus explicit user authorization to spend. Passive Frustration and all quote/error/cancel UI remain implemented and testable without inventing a judge.
- Broker quota scenarios require the relevant configured credentials; local provider data remains independently available.

## Historical verification baseline (before Phase 1)

- Installed runtime: omp 18.6.1, Bun 1.4.2; clone declares 18.6.2; plugin dependencies were 18.4.10 and warning was 18.5.0.
- Standalone frame probes: widths 40/60/100/150, no overwide rows, sidebar stable while scrolling.
- Disposable heatmap/series colour probe: dark/light × truecolour/256-colour, per-cell ANSI emitted, bounded widths.
- Isolated empty-DB in-process overview render succeeded.
- Actual compiled-host extension load failed on `@oh-my-pi/pi-natives` through a local `pi-tui/utils` import. Interactive mount was not verified.
