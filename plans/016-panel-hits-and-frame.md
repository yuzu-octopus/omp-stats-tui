# Plan 016: Panel mouse targets and 20-row sync frame stay honest

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P1 · Effort M · Risk MED · Depends on none · Category bug/tests
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

Four panel-level failures: (1) once a sync is 1h/7d/30d/90d old, the live chip contains the same text as a range segment, so `rangeSpans()` finds the chip instead of the range control and clicks change the wrong thing; (2) after `g` followed by `[`, Ctrl+P/N or an unbound multi-byte key, `jumpArmedAt` stays set and swallows the next single key; (3) at 20 terminal rows with a sync progress line, the sidebar makes the fullscreen panel emit 21 rows and the bottom border falls off; (4) the footer advertises digit screen shortcuts on Frustration and Traces, where those digits are consumed by the controller. Existing click/warning integration coverage is also missing for notice offsets and worker error callbacks.

## Current state

- `src/tui/mouse.ts:93-103` — `rangeSpans(line)` uses `line.indexOf(" " + rangeMeta(id).label + " ")` from the start of the stripped topbar. `src/tui/chrome.ts:198-205,248` — stale sync ages are `1h ago`, `7d ago` etc.; chip is composed before the range tray at `chrome.ts:590-604`.
- `src/tui/panel.ts:981-1011` — Ctrl+P/N and `[`/`]` return before resetting `state.jumpArmedAt`; reset happens only after non-null `panelAction`.
- `src/tui/panel.ts:773,792,887` — sidebar uses `rows >= MIN_SIDEBAR_ROWS(20)` before progress rows are known; `#body.setHeight(Math.max(plan.bodyRows, nav.lines.length))` can force body rows back. Probe at width 100, rows 20: idle 20 lines, syncing 21.
- `src/tui/footer.ts:72-96` — the `digits` hint is unconditional for idle/scrollable/syncing; `src/tui/features/frustration.ts:365-368` consumes `1`–`4`, `src/tui/features/traces.ts:476,528` consumes `0`. `src/tui/panel.ts:964-967` builds hints without screen context.
- `src/tui/panel.ts:920-921,476-480` — `syncError` warning; `test/panel.test.ts` subscribe stub never fires it. `src/tui/panel.ts:939-945,1101-1103` — feature hits offset by notices, then dispatched from `#routeMouse`; no test clicks through both transforms.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/mouse.test.ts test/panel.test.ts test/hint-contract.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/mouse.ts`, `src/tui/panel.ts`, `src/tui/footer.ts`, `test/mouse.test.ts`, `test/panel.test.ts`, `test/hint-contract.test.ts`.
Out of scope: `src/tui/chrome.ts`, `src/tui/responsive.ts`, other features and tests. Do not change the public `rangeSpans`/`FrameCache` signatures beyond adding fields.

## Steps

1. Add failing tests in `test/mouse.test.ts`: build a stripped topbar with a stale chip containing `" 1h ago "` plus range segments; assert `rangeHit()` on the segment column returns `1h` and on the chip-age column returns null. Add a `jumpArmedAt` test in `test/panel.test.ts`: `g`, `[`, then `q` must close (or state must be disarmed); assert the next key is not swallowed.
2. Add a frame-height test in `test/panel.test.ts`: with `rows: 20`, width 100, and a live sync status fired through the `reads.subscribe` stub, `panel.render(100).length` must be 20. Idle height must also stay 20.
3. Run target tests → all three fail.
4. Fix `rangeSpans` by bounding the search to the trailing range tray. Preferred: have the panel pass the range tray's start column in `MouseFrame`; if that requires `chrome.ts` changes, stop and report instead of broadening scope. A local `lastIndexOf` search is acceptable only if a test proves it cannot match a chip that follows the tray.
5. Reset `state.jumpArmedAt = 0` on every input that is not the bare `g`/`G` arm key, including Ctrl+P/N and bracket early returns and unbound multi-byte keys. Preserve the 1200 ms timeout behaviour for genuine `g`-then-letter.
6. Choose the sidebar using the post-progress row count: only allow `column` when `rows - (topLines.length - 1) >= MIN_SIDEBAR_ROWS`; then cap the body height so `headerLines + max(bodyRows, nav.lines.length) + PANEL_CHROME_ROWS <= rows` without dropping the footer. Run the height test.
7. Extend `test/panel.test.ts`: capture `reads.subscribe`'s status/error callbacks, fire an error, and assert the body contains `Stats service failed; retained cached data.` while cached figures remain visible. Add a click test with a notice row and a scrolled body that reaches `handleHit` and changes observable feature state. In `footer.ts`, make the digits hint conditional on the active screen: add an optional `ownsDigits` argument to `hintsFor`, omit the digits hint for `frustration` and `traces`, and pass the flag from `#footerLine` in `panel.ts`. Add a `test/hint-contract.test.ts` case asserting the hint is present on Overview and absent on those two screens, while `close` remains pinned last.
8. Run target tests, full suite and typecheck → all pass.

## Test plan

Five new/updated tests across `test/mouse.test.ts`, `test/panel.test.ts` and `test/hint-contract.test.ts` as above. Existing tests are the regression net for chrome geometry and key contracts.

## Done criteria

- [ ] Stale chip no longer steals range clicks; `g` leak fixed; 20-row syncing frame emits exactly 20 lines.
- [ ] Digit hint is omitted on screens that own digits; close hint remains pinned; panel error warning and notice-offset click dispatch are covered by tests.
- [ ] Full suite and typecheck pass; only in-scope files changed.

## STOP conditions

If fixing the mouse geometry requires editing `src/tui/chrome.ts`, stop and report. If capping body height changes normal (24+ row) frames, stop and report.

## Maintenance notes

The frame cache key deliberately excludes wall-clock time; any new chrome field must be derived in render, not cached across minute ticks.
