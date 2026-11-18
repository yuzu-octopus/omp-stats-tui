# Dashboard refactor design (2026-11-18)

**Goal.** Make `/stats-tui` read like one dashboard instead of stacked reports: a stable frame, a visible active pane, and useful data in the first screenful at 40×30 and 100×40. Preserve every route workflow and every money/freshness distinction.

**Approach.** Keep the `FeatureController` seam, the isolated worker and the band drawing grammar. Add one shared side-by-side composition primitive to `features/presentation.ts`; use it where two independent panels currently consume full-width rows. Shorten duplicated instructional prose and move secondary tables below the primary data. Do not add a third render grammar, React, a webserver, custom colours, or extra dependencies.

## Scope

- `src/tui/features/presentation.ts`: new `sideBySide(ctx, width, left, right, options?)` returning measured lines; no line exceeds `width`; pad with spaces using `visibleWidth`; ANSI-safe; gap 2; stack when width < 80.
- `src/tui/features/core/summary.ts`: Overview composes metrics → primary list/chart pair → token/agent tables behind it. At width ≥ 80, list and chart are side by side; at narrower widths keep current stack but remove duplicated hint line. Keep hit offsets correct after composition.
- `src/tui/features/core/analytics.ts`: Models/Costs/Tools use a metric strip followed by chart and table side by side at ≥ 80; shorter hints; no change to sort/focus/detail semantics.
- `src/tui/features/core/requests.ts`: Requests/Errors show loaded population and filters once; no repeated hint line in both the table body and footer.
- `src/tui/features/core/shared.ts`: `ListState.render` accepts an option to omit the built-in hint line when the controller supplies its own contextual hint; do not remove the hint at narrow widths.
- `src/tui/panel.ts` and `src/tui/chrome.ts`: only after correctness fixes; unify active route naming and compact status without changing keybindings or mouse zones.
- Tests: `test/body-layout.test.ts`, `test/panel.test.ts`, `test/core-summary-workflows.test.ts`, `test/core-analytics.test.ts`, `test/fixture-consistency.test.ts`.

## Acceptance

1. `bun scripts/probe-render.ts overview --width 100 --rows 40` has no `OVER WIDE`, no full-width rule, metrics plus selected request plus chart within the first 24 body rows, and both secondary tables reachable below.
2. `bun scripts/probe-render.ts overview --width 40 --rows 30` has no `OVER WIDE`, metrics plus primary chart/list within the first 24 body rows, and no duplicated hint line.
3. `bun scripts/probe-render.ts models --width 100` renders populated fixture data with no error sentence; same for `frustration`.
4. Panel tests assert consumer-visible workflow continuity: focus tabs, selection, hit offsets, search, reveal, details, money caveats, dirty-hour notice.
5. `bun test`, `bun run check`, `bun run build`, `bun run verify:patch` pass; committed `dist/` is rebuilt after all source edits.

## Shell redesign

- One fixed toolbar row owns the single authoritative route label, status, freshness and range. Border says only `Stats`. Wide keeps the grouped sidebar; narrow uses a route widget. The anonymous 12-glyph strip is removed from production use.
- One `budgetFrame(width, rows, headerRows, preset)` owns all body-row math, including progress. Sync must not change body height or clip the last sidebar row.
- Mouse route-widget hit spans replace strip hits; keyboard map stays byte-identical.

## Rejected

- Reintroducing `ScreenSpec`/`renderScreen` (ADR 0007).
- A new card system, colour table, glyph system or bespoke chart renderer.
- Removing data from a screen just to shorten it; secondary data moves below the primary region, never away.
## Status

Shipped and verified with 735 passing tests, clean typecheck, rebuilt `dist/`, and extension load.

