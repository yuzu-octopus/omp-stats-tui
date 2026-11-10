# HANDOFF — terminal rendering and interactive routes

## Current architecture

Supported runtime: compiled omp 18.18.2 and standalone Bun 1.4.2. The manifest loads `dist/index.js` after `bun install` and `bun run build`; direct source loading is not the supported compiled-host entry. This handoff replaces the former IR-only migration ledger and its historical version, keymap and test-count claims. See [the active roadmap](plans/2026-10-05-dashboard-parity.md) for mounted/package/theme evidence and external paid/broker prerequisites.

There are twelve production `FeatureController`s: Overview, Activity, Models, Costs, Projects, Requests, Errors, Tools, Providers, Gain, Traces and Frustration. `StatsPanel` retains their state and renders their interactive bodies. The original `ScreenSpec → renderScreen → renderBands` path is **not the production render path** (ADR 0007): it survives for the shipped `/stats-test` showcase, the nav/tabs identity, the review probes and the panel's fixture/test branch (`options.fetch` injected). The screen registry is not a dead directory, and static IR metadata is not an implementation of interaction.

Read the relevant sections of `AGENTS.md`, `CONTEXT.md`, `src/tui/features/types.ts`, the route controller, `src/tui/panel.ts` and the chart primitive being changed. Reuse the established contracts rather than introducing a second grammar or a second data owner.

## Runtime/data contract

- The source entry only registers/mounts the command; it does not initialize the DB on the host thread.
- `StatsReadClient` owns one persistent standalone Bun child per panel. Request/reply and unsolicited live status travel over NDJSON pipes. The child initializes the DB and runs synchronous DB queries/transcript reads; a loading promise on the UI thread would not provide isolation.
- `scripts/data-worker.ts` owns patched upstream `StatsLive({ workers: 1 })`: initial/ongoing ingest, transcript watching, live status and committed-data invalidation. Manual `s` calls this same owner's `requestSync()`, not a separate one-shot sync worker. Active queries refresh without resetting retained route controls.
- Upstream handlers receive synthetic localhost `Request`s inside the worker, not through an HTTP listener. There is no independent plugin SQL backend or unpriced-count SQL workaround.
- The committed standard Bun patch and lockfile ship pricing-v2 historic replay, rollup-v3 invalidation, recent-request range filtering before limit, provider `outputTokens` and standalone live worker support (ADR 0008). Missing cards mean unknown spend; recorded zero charges and explicit free cards remain zero. Because the patch is applied at install time, `bun install` is correctness-critical and `bun run verify:patch` runs immediately after it in CI.
- The build's `__STATS_READ_WORKER__` macro points to `./data-worker.js` relative to the production bundle. Source-mode Bun resolves `../../scripts/data-worker.ts` relative to `src/data/client.ts`. Use an absolute worker path, standalone `bun` from PATH, inherited host cwd, explicit active agent directory/profile and cleared `PI_BUNDLED`.
- The installed runtime coding-agent dependency provides the real standalone judge. Its resources are opened lazily only when requested. No dynamic import or compiled-host private-subpath discovery is needed.
- Close disposes controllers/watchers/jobs, rejects pending work, kills/reaps the child and restores the transcript. Query/selection generations prevent stale responses replacing a newer selection.

## Interaction interfaces

`FeatureController` provides `load(range)`, `render(width, height)`, `handleInput(data): boolean`, `dispose()` and optional readonly `inputMode: "text" | "navigation"`. `true` consumes input; `false` leaves it to the parent. Text mode preserves printable global-shortcut characters as search input. `FeatureContext` supplies the reader, mutable active theme, `changed()`, clipboard, clock and screen/trace navigation. The parent owns scrolling and mount lifetime; retained controllers own focus, search, sorting, selection, reveal/load stages, details and chart controls.

Global navigation is `Ctrl+P`/`Ctrl+N` unless overridden by host selector bindings, or `[`/`]` outside text entry. `Tab` cycles route focus/view; focused analytics tables precede charts. Focus/details/back/search transitions reset body scroll. `r`/`R` range and `s` sync apply outside text entry. `q` closes outside text entry; `Ctrl+C` always closes. Printable `q` and brackets remain searchable. `Esc` leaves details/search/filter/back stack before closing. `g` then `o/m/c/v/a/r/e/t/l/j/n/f` reaches all twelve routes. Arrows/digits are contextual. See the [README key tables](../README.md#global-keys).

Request details lazily expose timing/TTFT/throughput, token categories/premium, component costs, status/error, output, transcript entry and raw stats. They support JSON copy and associated-trace navigation; the parent records the originating route and supplies `backToOrigin(): boolean`. After nested trace history is exhausted, back returns to the retained request inspector rather than discarding its payload. Requests and Errors distinguish loaded populations and staged limits from complete-range totals.

Public controller `openTrace(file, entryId)` starts a new external navigation chain and clears unrelated browser history while retaining same-file view controls. Internal child opens retain the current view on the nested stack. This distinction is covered by a regression and mounted packed-host reproduction; do not unify the two paths.

Provider windows/account quota are independent reads from local provider usage; retained account histories refresh even if local/fleet reads fail or remain pending. Sorting keeps provider/account identity, and point details match hidden-series/top-six/Other chart aggregation. Gain remembers project selection, keeps long selectors bounded and scopes totals, daily/cumulative history and source rows; daily and cumulative lines use distinct theme roles.

Traces uses nested duration-preserving tracks, time/turn/call axes, idle compression, zoom/pan/fit/focus, track visibility, span search, linked transcript/markers, tool duration/errors, entry/span details, JSON copy and child navigation. The interactive minimap supports keyboard seek, range brushing, independent edge resizing, brush movement and zoom/fit; category density strips preserve overlapping events. Marker-only tracks remain visible/selectable; picking uses rendered cells, including zero-duration events, and excludes collapsed descendants. Upstream root discovery is limited to **300 candidates**, so root search is not exhaustive history. File-aware entry identity prevents collisions between children.

Frustration's cached/regex metrics and coverage are passive; class/family/sample/mostly-regex controls, layered rates/trend, sortable versions and raw model IDs are implemented. Judge lifecycle is independent of passive metrics: running/progress/cancel remains reachable after read failures; externally observed runs dismiss obsolete estimates. `j` obtains an estimate, `y` explicitly confirms paid start, `n`/`Esc` dismisses the estimate and `x` cancels a running job. Paid acceptance requires a configured judge role, provider credentials and explicit authorization; no paid-smoke claim is permitted without exercising those prerequisites.

## Pure renderer interfaces and semantics

The IR remains in `src/layout/spec.ts`; `src/layout/resolve.ts` resolves refs; `src/tui/render/screen.ts` converts them to concrete bands; `src/tui/band.ts` owns band geometry. Keep these functions pure and reusable by probes. `renderBands` handles stacked stat tiles, chart/table/legend/note composition and exactly one blank line between bands. No full-width rule belongs inside a band; the panel divider is frame chrome. These invariants bind `/stats-test`, **not** `/stats-tui`, whose only rule is the `PanelDivider` between body and footer.

- Unresolvable values are `null`, not blank/undefined/NaN. Unfetched aggregates are absent; fetched-empty counts are zero. Loading, empty, error, dirty rollups and un-ingested changes are distinct states.
- `sum` aggregates across rows rather than accidentally reading the first aggregate row. Error distinctness uses upstream normalized signatures; grouped model identity uses model **and provider**.
- Conversation tokens are input + cache read + cache write + output. Agent shares use token weights, not equal row counts. Cache rate excludes cache writes from its denominator.
- Cost charts use upstream day buckets; sparse series densify against the proper aligned axis. Timing units remain explicit (duration/TTFT milliseconds versus chart seconds, throughput tokens/second).
- Share-bar/legend figures use published shares by metric identity (`chartShares`/`publishedShares`), with the same series identity/colour.
- Multi-series composition uses the existing `src/tui/charts/compose.ts` primitives, not a hand-written second chart encoding. Ranked bars and share bars keep the existing injected styling contracts; sparkline rendering accepts caller-provided styling. Glyph geometry and measured ANSI-aware widths remain separate from colouring.

## Active theme and glyph contract

Sparkline, bar, calendar, heatmap and feature timeline characters are coloured per cell/series from active omp theme roles. `StatsPanel` refreshes the initialized active host theme at render time and mutates `FeatureContext.theme`; feature rendering must read that current context instead of capturing the opening theme. Pure renderers receive theme/paint callbacks and do not eagerly read the host singleton.

Use the existing palette/series resolver, shared graph/legend identity and hue de-duplication for aliased theme roles. Preserve labels/glyph distinctions when hues alias. Never pin browser hex colours or private theme/keybinding singletons. A terminal character has one foreground/background; independently coloured braille dots are impossible. Standard width-one chart glyphs and explicit Unicode/Nerd/ASCII presets remain the policy, not terminal-font detection.

## Verification ownership and evidence

The integration owner runs shared checks after related edits settle, not each worker mid-flight. Suggested checks: `bun run build`, affected/full `bun test`, pure render probes at narrow/wide widths, and compiled-host loading with `omp models -e /abs/path/to/dist/index.js`. Read stderr; the exit code alone is not an extension-load assertion. Pure probes cannot validate retained controller state or keyboard workflows. CI (`.github/workflows/ci.yml`) automates exactly this list on every push and PR, plus `bun run verify:patch` and `bunx tsc --noEmit`; the current suite is 916 pass / 0 fail across 61 files with a clean typecheck.

Observed later-phase evidence supplied by the integration workstream: no main-thread DB startup; navigation/resize during a blocked read-worker scenario at 86 ms (an observation, not a guarantee); actual unknown-price `N/A`; persistent-worker automatic ingest of a root plus two children totaling eight recorded requests; request details including timing/tokens/component costs and associated trace opened; child reaping and alternate-screen restoration. Those isolated mounted scenarios used no credentials or LLM calls.

The local compiled-host route/installation/theme matrix and integrated suite have exercised evidence in the roadmap. Do not infer paid execution, authenticated broker coverage or physical clipboard verification from those results. Both plugin and upstream PRs are published. A configured judge role/provider credentials plus explicit user authorization remain paid-smoke prerequisites, not reasons to leave the UI unimplemented.
