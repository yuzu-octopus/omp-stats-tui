# omp-stats-tui ground-up redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `/stats-tui` a dense, honest, keyboard-complete stats dashboard, and delete the dead render stack that makes the codebase lie about itself.

**Architecture (unchanged skeleton):** `StatsPanel` owns one `StatsReadClient` worker child and one retained `FeatureController` per screen. Production bodies are `feature.render()` strings. The `ScreenSpec → renderScreen → renderBands` IR is **not** the production path (ADR 0007); it is a test/probe fixture and is deleted in Phase 4.

**Tech stack:** Bun 1.4.4, TypeScript, `@oh-my-pi/pi-tui` 18.18.2 (ANSI path), `@oh-my-pi/omp-stats` 18.18.2 (locked patch), `bun:test`.

**Spec:** this document + `docs/adr/*` + `AGENTS.md`.

## Global Constraints

- Bun, never Node. `bun test`, `bun check`. Never `node`/`npm`/`npx`.
- **No SQL of our own.** All reads go through `@oh-my-pi/omp-stats` (`handleApi`, aggregator, rollup). `scripts/probe-data.ts` is the only SQL and it is read-only.
- **Never call `syncAllSessions` on the TUI thread** (7.1 s). The worker owns ingest.
- **Never call `/api/sync`, `getProviderWindowStats`, or `getRequestDetails` from a load path.** `getRequestDetails` is on-demand only.
- **A value that cannot be resolved is `null`, never `undefined`/`NaN`.** Production features must render an error state, never throw.
- **`cacheRate = totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)`** — cache writes are excluded from the denominator.
- **`totalCost` under-reports by unpriced requests. Render the unpriced count beside cost, always.** `formatEstimatedCost(value, unpriced)` → `N/A` when `value === 0 && unpriced > 0`. A `$0` row must mean an explicit all-zero price card.
- **`cacheSavings` is a ratio and can be negative.** Never print `-12.8% saved`.
- **Dirty hours > 96 (`EXACT_DIRTY_LIMIT`) mean stale rows, not zeroes.** The dirty-hour count stays visible.
- **`initDb()` is ~867 ms and returns `null` before first run.** Every read is gated behind it; `rollupStatus` is requested on every load and refuses a null DB.
- **Valid ranges are exactly `1h | 24h | 7d | 30d | 90d | all`.** `365d` is not a key and silently falls back to `24h`.
- **Data ink is hardcoded plain Unicode, one cell wide.** No emoji, no braille, no Nerd Font codepoints as data ink. Chrome glyphs go through `statsIcon`.
- **No full-width rule inside a body.** `─`/`━`/`═` inside a band is a bug. The only rule is the `PanelDivider` between body and footer.
- **Static imports only for `@oh-my-pi/*`.** Dynamic `import()` of any `@oh-my-pi/*` fails in the extension loader.
- **Never import the `theme` binding at module scope.** It is `undefined` until theme init. Use the theme passed to the `custom()` factory.
- **Nothing is printed to stdout from extension code.**
- **Subagents MUST skip build/lint/test/format gates.** The orchestrator verifies once per phase.

## Review Focus

1. A feature that receives a payload missing a field (no `insights`, no `overall`, no trace rows) must render a defined error state, never throw.
2. A cost figure must always carry its unpriced count; a day/model/provider row with unpriced requests must read `N/A`, not `$0`.
3. A load must not fire broker network I/O (`provider-windows`) or a full-session `stat` scan.
4. A key hint in the footer must round-trip through `panelAction`; a remapped key must reach features.
5. A fixture must not contradict another fixture (unpriced counts, per-model metrics).
6. A panel test must exercise the controller path, not only the injected-fetch fixture branch.

---

## Phase 0 — Stop the bleeding (user-visible correctness)

### Task 0.1: Features degrade instead of throwing

**Files:**
- Modify: `src/tui/features/providers.ts`, `src/tui/features/frustration.ts:222`, `src/tui/features/traces.ts`, `src/tui/features/traces/render.ts`
- Test: `test/provider-gain-features.test.ts`, `test/frustration-feature.test.ts`, `test/traces-feature.test.ts`

**Interfaces:**
- Consumes: `FeatureContext`, `FeatureController` (`src/tui/features/types.ts`).
- Produces: the controller's existing error state, rendered by the panel's error path; no new exports.

- [ ] **Step 1: Write the failing test.** For each of providers/frustration/traces, build a `FeatureContext` whose `reader.api` returns `{}` for the screen's route, `load(range)`, and assert `render(width, height)` returns lines containing a defined error sentence and does not throw.
- [ ] **Step 2: Run it, verify it fails** with a `TypeError`.
- [ ] **Step 3: Guard the loads.** Shape-check each payload (`Array.isArray`, required fields) and set the controller's error state with a one-line reason. No retry, no fallback payload.
- [ ] **Step 4: Run the three test files, verify pass.**
- [ ] **Step 5: Commit** `fix(features): degrade to an error state instead of throwing`.

### Task 0.2: Defer provider broker I/O out of the load path

**Files:**
- Modify: `src/tui/features/providers.ts:127,147-150`
- Test: `test/provider-gain-features.test.ts`

**Interfaces:**
- Consumes: `FeatureContext.reader.api`.
- Produces: `load(range)` performs no network call; windows load only when the Windows/Accounts view is entered.

- [ ] **Step 1: Write the failing test.** `load("30d")` with a reader that records paths; assert no `/api/stats/provider-windows` call.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Move `loadWindows()` from `load()` to the view-entry handler.** Keep the deferred caveat line.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(providers): defer broker window I/O to the view entry`.

### Task 0.3: Stop the traces refresh × freshness-scan amplification

**Files:**
- Modify: `src/tui/panel.ts:537-540`, `scripts/data-worker.ts:59-75`
- Test: `test/data-worker-client.test.ts`, `test/traces-feature.test.ts`

**Interfaces:**
- Consumes: `StatsReadClient`.
- Produces: the freshness scan runs on a slow timer or live status, never per `fetch`.

- [ ] **Step 1: Write the failing test.** A worker `fetch` of `["rollupStatus"]` must not trigger a session-file scan (assert the scan counter is 0).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Skip the scan when the request is `rollupStatus`-only; compute `pendingSessions` on live status or a 30 s timer. Raise the traces refresh timer from 1 s to 5 s.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `perf(worker): stop scanning every session per fetch`.

### Task 0.4: Unpriced beside cost everywhere; negative cache savings

**Files:**
- Modify: `src/tui/features/traces.ts:286,300`, `src/tui/features/traces/render.ts:139`, `src/tui/features/core/summary.ts:153,212,217,221`, `src/tui/format.ts:164-171`
- Test: `test/unpriced-render.test.ts`, `test/core-summary-workflows.test.ts`

**Interfaces:**
- Consumes: `formatEstimatedCost` from `@oh-my-pi/omp-stats/client/data/formatters`.
- Produces: `cacheSavingsNote` is called, not dead.

- [ ] **Step 1: Write the failing test.** A trace row with `costTotal === 0 && unpricedRequests > 0` renders `N/A` plus the count; `cacheSavings = -0.128` renders a sentence that is not `-12.8% saved`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Append the unpriced count beside every trace cost; wire `cacheSavingsNote` into `summary.ts:153`; for activity days, print `N/A` when the day's requests are unpriced (extend the payload or derive from the daily point).**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(money): unpriced beside cost in traces and activity`.

### Task 0.5: Fixture realism and cross-screen consistency

**Files:**
- Modify: `test/fixtures/panel.ts`
- Test: `test/showcase-fixtures.test.ts` (rewrite, see 5.3), `test/unpriced-render.test.ts`

**Interfaces:**
- Consumes: `PanelData` (`src/data/api.ts`).
- Produces: a fixture where `COST_SERIES` carries the same unpriced population as `BY_MODEL`; `PROVIDERS.insights` exists; frustration/traces payloads exist; per-model tokens/durations differ; `TIME_SERIES` spans the range.

- [ ] **Step 1: Write the failing test.** Sum `BY_MODEL.unpricedRequests` equals the costs route's unpriced total; `PROVIDERS.insights` is an array; two models differ in `totalCacheReadTokens` and `avgDuration`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Fix the fixture.** Keep the three-model semantics (priced / no-card / explicit-free) intact.
- [ ] **Step 4: Run the full suite, verify pass.**
- [ ] **Step 5: Commit** `test(fixtures): one population, distinct models, complete payloads`.

### Task 0.6: A controller-path panel test harness

**Files:**
- Modify: `src/tui/panel.ts` (`__testing.makePanel`), `test/panel.test.ts`
- Test: `test/panel.test.ts`

**Interfaces:**
- Consumes: `__testing.makePanel(state)`.
- Produces: `makePanel` can construct a panel with **no** injected `fetch`, so `#feature()` resolves a real `FeatureController`.

- [ ] **Step 1: Write the failing test.** A panel built without `fetch` renders the production overview feature's body (assert a string only `SummaryFeature` emits), not the IR spec's.
- [ ] **Step 2: Run, verify fail** (`makePanel` always injects `fetch` at `panel.ts:1127`).
- [ ] **Step 3: Let `makePanel` omit `fetch` and inject a reader instead; keep the fixture path available for IR tests.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `test(panel): exercise the controller path`.

---

## Phase 1 — Interaction surface

### Task 1.1: One keybinding grammar (corrected scope)

**Ruling:** the host `KEYBINDINGS` set (`packages/tui/src/app-keybindings.ts:89`) is a **closed** union of `app.*`/`tui.*` ids. There is no `stats.range`, `stats.sync` or `stats.close`, and an extension cannot register one. So "route every key through `getKeybindings()`" is **not implementable** for extension-local keys. The honest scope is: resolve the keys that DO have host bindings through the manager, delete the raw fallbacks that shadow them, and document the extension-local keys as non-remappable in one place.

**Files:**
- Modify: `src/index.ts:28-35`, `src/tui/panel.ts:231-308,906-918`, `src/tui/features/traces.ts:397-523`
- Test: `test/chrome.test.ts`, `test/hint-contract.test.ts`, `test/footer.test.ts`

**Interfaces:**
- Consumes: `getKeybindings()` (the user's configured manager, set by `KeybindingsManager.create`), `matchesKey`, `matchesSelectCancel` from `@oh-my-pi/pi-tui/keybinding-matchers`.
- Produces: no new exports; the factory `_keybindings` argument is either used or dropped, not silently ignored.

- [ ] **Step 1: Write the failing test.** A key that has a host binding (`tui.select.cancel`, `tui.select.up/down`) is remapped by the user; assert the remap wins and the raw fallback does not fire.
- [ ] **Step 2: Run, verify fail** (the raw `|| matchesKey(data, "q")` fallback fires).
- [ ] **Step 3: Delete the raw fallbacks for keys that have a host binding. Keep raw `matchesKey` only for extension-local actions, and say so in one comment above `panelAction`. Either use the factory `_keybindings` arg or delete the parameter and document that the global manager is authoritative.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `refactor(input): host bindings win, local keys documented`.

### Task 1.2: Range picker and chrome-level refresh

**Files:**
- Modify: `src/tui/panel.ts` (`range`, `panelAction`), `src/tui/chrome.ts` (topbar tray), `src/tui/mouse.ts`
- Test: `test/ranges.test.ts`, `test/chrome.test.ts`, `test/mouse.test.ts`

**Interfaces:**
- Consumes: `RANGES`, `nextRange` (`src/data/ranges.ts`).
- Produces: a direct preset walk over `RANGES` plus a chrome-level refresh key.

- [ ] **Step 1: Write the failing test.** Pressing the refresh key reloads the current screen:range without changing either.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Add a refresh key at chrome level (not `R`, which is range). Add a direct preset walk over `RANGES`. Never offer `365d`.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(panel): refresh key and direct range walk`.

### Task 1.3: Footer advertises the real keymap

**Files:**
- Modify: `src/tui/footer.ts:70-93`
- Test: `test/footer.test.ts`, `test/hint-contract.test.ts`

- [ ] **Step 1: Write the failing test.** Every key the panel and the focused feature accept appears in `hintsFor` output or in the feature's own hint line; no hint names an unbound key.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Add `g`-jump, digits, `ctrl+p/n`, `home/end`, mouse, and feature keys to the hint set, whole-hint dropping preserved.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(footer): advertise the real keymap`.

### Task 1.4: Mouse hit areas on the body

**Files:**
- Modify: `src/tui/mouse.ts`, `src/tui/panel.ts` (`#routeMouse`), `src/tui/features/core/shared.ts`, `src/tui/features/core/summary.ts`
- Test: `test/mouse.test.ts`, `test/sidebar-click-ground-truth.test.ts`

- [ ] **Step 1: Write the failing test.** A click on a table row selects it; a click on a heatmap cell selects that day.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Have feature `render` report hit spans (row range + action) through the existing context; extend `hitTest` to body rows.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(mouse): body hit areas for tables and the calendar`.

---

## Phase 2 — Visual density and consistency

### Task 2.1: Fill the frame

**Files:**
- Modify: `src/tui/features/core/shared.ts`, `src/tui/features/core/summary.ts`, `src/tui/features/core/analytics.ts`, `src/tui/panel.ts` (`#bodyLines`)
- Test: `test/body-layout.test.ts`, `test/panel.test.ts`

- [ ] **Step 1: Write the failing test.** At 40 rows and 100 cols, a screen with more content than fits scrolls; a screen with less does not leave more than N blank rows at the bottom (N asserted).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Distribute vertical space: grow tables/the calendar to the available height; keep section order stable.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(layout): fill the frame`.

### Task 2.2: Tile sub-labels and table columns

**Files:**
- Modify: `src/tui/features/core/analytics.ts`, `src/tui/features/core/summary.ts`, `src/tui/features/providers.ts`, `src/tui/features/core/requests.ts`
- Test: `test/models-screen.test.ts`, `test/providers-screen.test.ts`, `test/requests-screen.test.ts`

- [ ] **Step 1: Write the failing test.** No tile repeats a sub-label already carried by its neighbour; the requests table carries tokens and cost.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Dedup sub-labels; align table column sets across screens.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(screens): dedup tile sub-labels, align table columns`.

### Task 2.3: Chart empty states and legends

**Files:**
- Modify: `src/tui/charts/time-series.ts:40-51`, `src/tui/features/core/summary.ts`, `src/tui/features/presentation.ts`
- Test: `test/chart-primitives.test.ts`, `test/chart-ink.test.ts`

- [ ] **Step 1: Write the failing test.** A sparse series renders a sentence that distinguishes "too few buckets" from "no readings"; a legend never lists a series the chart above does not draw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Pass the host's reason through; scope legends to their own chart.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(charts): honest empty states, scoped legends`.

### Task 2.4: Chart correctness (audit-derived)

**Files:**
- Modify: `src/tui/features/core/summary.ts:144,216`, `src/tui/features/providers.ts:89-95,214,218-224`, `src/tui/charts/host-adapter.ts:112-135,290,428,437-440`, `src/tui/charts/bars.ts:284-287`, `src/tui/charts/time-series.ts:92-100`, `src/tui/charts/sparkline.ts:363-367`, `src/tui/palette.ts:584`
- Test: `test/chart-primitives.test.ts`, `test/chart-ink.test.ts`, `test/palette.test.ts`, `test/heatmap-ink.test.ts`

**Interfaces:**
- Consumes: host `columnSeries` (null for missing cells), host `planChart` (`MAX_LINES = 6`, `fitKind`), `heatRamp`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests.** (a) Four heatmap levels render four distinct colours from the real call site (`summary.ts:216`); (b) a null gap renders no mark, not a zero column; (c) `values.length > width` keeps the NEWEST sample; (d) plot series count equals legend series count; (e) an all-unpriced bucket renders `N/A`, never `$0.00`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Fix each.** (a) ramp `[0,1,2,3]` or a 1..4 `heatRamp`; (b) preserve `null` into both geometry engines; (c) clip to the last `width` samples instead of synthetic re-bucketing; (d) fold the 7th+ series into "Other" or bypass `MAX_LINES`; (e) route chart money labels through `costWithUnpriced`/host `formatEstimatedCost` with the real unpriced count, and delete the `unpriced=0` calls.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(charts): ramp, gaps, clipping, series cap, money labels`.

---

## Phase 3 — Performance

### Task 3.1: Line cache

**Files:**
- Modify: `src/tui/panel.ts` (`render`), `src/tui/chrome.ts`, `src/tui/layout.ts`
- Test: `test/panel.test.ts`, `test/responsive-frame.test.ts`

- [ ] **Step 1: Write the failing test.** Two renders at the same `(width, rows, screenId, range, preset, generation)` compose the body at most once (count via a spy on `#bodyLines`).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Memoize chrome + body lines on that key; invalidate on `generation` bump.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `perf(panel): line cache`.

### Task 3.2: Heatmap layout cache

**Files:**
- Modify: `src/tui/charts/heatmap.ts`, `src/tui/charts/calendar.ts`
- Test: `test/heatmap.test.ts`

- [ ] **Step 1: Write the failing test.** Two `renderHeatmap` calls with equal `(points, weeks)` build the layout once.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Memoize `calendarLayout` per `(points identity, weeks, today)`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `perf(heatmap): cache the layout`.

---

## Phase 4 — Delete the dead render stack

### Task 4.1: Delete the registry render layer

**Files:**
- Delete: `src/tui/screens/*.ts` render bodies and `src/tui/screens/render.ts`; keep identity metadata.
- Modify: `src/tui/screens/types.ts`, `src/tui/panel.ts:24-25,777-808`
- Test: delete `test/errors-screen.test.ts`, `test/activity.test.ts` IR assertions; keep heatmap tests.

- [ ] **Step 1: Write the failing test.** `panel.ts` no longer imports `renderScreenWith`; `grep` finds no `Screen.render` callers.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Remove `Screen.render`/`ScreenContext`, the 12 bodies, `screens/render.ts`, and the `renderScreenWith` branch in `#bodyLines`. Keep `id`/`label`/`short`/`status`/`needs`.
- [ ] **Step 4: Run the suite, verify pass.**
- [ ] **Step 5: Commit** `refactor(screens): delete the dead registry render layer`.

### Task 4.2: Re-scope the IR band stack as a labelled probe/test fixture

**Ruling (revised):** the audit offered "re-scope OR delete". Deletion removes `test/parity.test.ts` — the only test that can fail on a real arithmetic drift against the web's own functions — and the G4/G5 grammar guarantees, and it discards a working headless review path. **Re-scope instead.** The IR stays, but it stops wearing a production costume: the genuinely dead parts go (Task 4.1's registry bodies, Task 4.3's vestigial fields, the `renderScreenWith` branch), and what remains is labelled where it lives.

**Files:**
- Modify: `src/layout/spec.ts` (header comment: PROBE/TEST FIXTURE, not a production render path), `src/layout/resolve.ts` (same), `src/tui/render/screen.ts` (same), `src/tui/band.ts` (delete IR-only band kinds that nothing renders after 4.1), `src/tui/screens/types.ts`.
- Modify: `AGENTS.md`, `CONTEXT.md` (already de-drifted by Task 5.2; verify they say "probe/test fixture").
- Test: keep `test/parity.test.ts`, `test/resolve.test.ts`, `test/band.test.ts`, `test/render-screen.test.ts`, `test/layout-ir.test.ts`; delete only their assertions about the removed `custom`/`deferred`/`status` fields.

- [ ] **Step 1: Write the failing test.** A source scan asserts the three IR modules carry the probe/test-fixture label and that no `kind: "custom"` band or `deferred: true` spec remains.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Add the labels; delete the dead band kinds and fields.**
- [ ] **Step 4: Run the suite, verify pass.**
- [ ] **Step 5: Commit** `refactor(ir): label the probe fixture, delete its dead parts`.

### Task 4.3: Delete vestigial spec fields

**Files:**
- Modify: `src/layout/spec.ts` (or its replacement), `src/tui/screens/types.ts`, `src/tui/panel.ts:213-215`
- Test: `test/resolve.test.ts`, `test/render-screen.test.ts` (deleted in 4.2)

- [ ] **Step 1: Write the failing test.** No `custom` band, no `deferred` flag, no `status !== "excluded"` filter.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Delete `custom`, `deferred`, `status`/`reason`/`IMPLEMENTED_IDS`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `refactor(spec): delete custom, deferred, status`.

### Task 4.4: Parameterize the nav; delete the showcase fork

**Files:**
- Modify: `src/tui/chrome.ts` (`sidebar`), `src/tui/mouse.ts` (`hitTest`), `src/tui/showcase/panel.ts`, `src/tui/showcase/nav.ts`
- Test: `test/chrome.test.ts`, `test/mouse.test.ts`, `test/showcase-panel.test.ts`

- [ ] **Step 1: Write the failing test.** `sidebar(theme, preset, groups, activeId, hoveredId?)` and `hitTest(frame, row, col, sidebarHit)` are the only nav geometry; `showcase/panel.ts` contains no duplicated render/scroll/zip.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Parameterize; delete ~400 lines of fork.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `refactor(chrome): one nav grammar, showcase fork deleted`.

### Task 4.5: Merge the frame budget; delete dead constants

**Files:**
- Modify: `src/tui/layout.ts`, `src/tui/panel-constants.ts`, `src/tui/frame.ts`, `src/tui/panel.ts:91,1108`, `src/tui/responsive.ts`, `src/tui/footer.ts`
- Test: `test/responsive-frame.test.ts`, `test/layout.test.ts`, `test/palette.test.ts`

- [ ] **Step 1: Write the failing test.** Exactly one chrome-row constant exists; `planLayout(width, rows)` takes two args; `SERIES_COLORS` is imported from `palette.ts` everywhere.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Add `frameBudget(width, rows)`; delete `layout.CHROME_ROWS`, `panel.PANEL_CHROME_ROWS`, `panel.SERIES_COLORS`, `frame.TAB_ROWS`, `footer.clampFooter`, `layout._preset`, `panel.state.header`, the unreachable icon-rail branch.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `refactor(frame): one budget, dead constants deleted`.

### Task 4.6: Harden the patch guard and the dirty limit

**Files:**
- Modify: `package.json:19-21` (`verify:patch`), `src/tui/panel.ts:110`, `src/tui/showcase/panel.ts:79`
- Test: `test/theme-fidelity.test.ts` (or a new `test/patch-guard.test.ts`)

- [ ] **Step 1: Write the failing test.** `verify:patch` fails when any of the five corrections is missing from the installed tree.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Check all five markers; import or assert `EXACT_DIRTY_LIMIT`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `chore(patch): verify every correction, pin the dirty limit`.

---

## Phase 5 — Fixtures, tests, docs

### Task 5.1: Regression tests for Phase 0

**Files:**
- Modify: `test/unpriced-render.test.ts`, `test/provider-gain-features.test.ts`, `test/traces-feature.test.ts`, `test/frustration-feature.test.ts`
- Test: the same files.

- [ ] **Step 1: Write the tests.** One per fixed defect: missing payload → error state; no broker I/O on load; no session scan per fetch; unpriced beside cost; negative cache savings sentence.
- [ ] **Step 2: Run, verify pass** (they were written against the fix).
- [ ] **Step 3: Commit** `test(regressions): pin the Phase 0 fixes`.

### Task 5.2: Docs match the code

**Files:**
- Modify: `AGENTS.md`, `CONTEXT.md`, `README.md`, `docs/TESTING.md`, `docs/HANDOFF-renderer.md`, `docs/adr/0004`, `docs/adr/0007`, `docs/adr/0008`
- Test: none (docs).

- [ ] **Step 1: Write the failing test.** `AGENTS.md` names the production render path correctly; the test count is not stale; the pin matches `package.json`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Rewrite the IR-as-production claims; update every suite count to the post-redesign actual; set every version to `18.7.0`; fix ADR 0008's patch filename to `patches/@oh-my-pi%2Fomp-stats@18.7.0.patch`; document that `makePanel` always injects `fetch` and therefore tests the fixture branch.**
- [ ] **Step 4: Commit** `docs: the code is the IR's replacement`.

### Task 5.3: Test hygiene

**Files:**
- Delete: `test/showcase-fixtures.test.ts` (0 bytes), `test/fixtures/overview-24h.json`, `test/fixtures/model-dashboard-24h.json`, `docs/HOLDING-docs-owner.md`, `.sdd-chart-swap-task2r-report.md`, `.sdd-chart-swap-task4-report.md`
- Modify: `src/tui/showcase/spec.ts:44`, `src/tui/showcase/panel.ts:38`, `src/tui/showcase/fixtures.ts:37,655-664,679`, `test/theme-fidelity.test.ts:444-458`
- Test: `test/showcase-panel.test.ts` (or a new `test/showcase-needs.test.ts`), `test/theme-fidelity.test.ts`

- [ ] **Step 1: Write the failing test.** Every `needs` entry in `src/tui/showcase/spec.ts` is referenced by at least one showcase band; `SHOWCASE_RECORD.rollupStatus.dirtyHours` is non-zero as documented.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Write the guard (or delete the file and the three comments that cite it); delete the dead fixtures, the closed HOLDING note and the scratch reports; make `dirtyHours` non-zero or fix the comment. Also strengthen `theme-fidelity` check 2: it currently accepts any token that appears as a VALUE in `PALETTE`/`SIDEBAR_INK`/`TAB_INK`/`SERIES_COLORS`, so a bare `theme.fg("mdLink", …)` passes. Require the token to be a KEY of `PALETTE` (or a declared ladder key), and add a negative control that a bare non-role token fails.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `chore(tests): delete the phantom guard and dead fixtures`.

---

## Execution waves

| Wave | Parallel units (disjoint files) |
|---|---|
| 1 | 0.1+0.2+0.4 features correctness · 0.5 fixtures · 0.6 panel harness · 0.3 worker scan · 5.2 docs · 5.3 test hygiene |
| 2 | 1.1 keybindings · 1.2 range/refresh · 1.3 footer · 1.4 mouse |
| 3 | 2.1 fill · 2.2 tiles/tables · 2.3 charts · 3.1 line cache · 3.2 heatmap cache |
| 4 | 4.1 registry render · 4.2 IR stack + probe · 4.3 spec fields · 4.4 nav fork · 4.5 frame budget · 4.6 patch guard |
| 5 | 5.1 regression tests |

Review after each wave; re-verify before advancing.
