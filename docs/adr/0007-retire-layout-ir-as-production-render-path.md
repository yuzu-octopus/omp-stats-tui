# The `ScreenSpec → renderScreen → renderBands` IR is retired as the production render path and kept for the showcase, the nav identity and the probes

Status: **accepted**. Adopted by `19245dc`, which recorded the decision in `AGENTS.md` and
`CONTEXT.md`; this file is the ADR that commit announced and did not write.

PR #1 (`c1396d3`) made the layout IR unreachable as a production render path. Before this ADR
nobody had established that by reachability, only by assertion.

## The evidence

Established by a source scan at the PR #1 baseline, before the UI refinement. A
production screen is a `FeatureController` (`src/tui/features/types.ts`) whose
`render(width, height)` returns `readonly string[]`; it does not render a static `ScreenSpec`.
`src/tui/panel.ts` reaches `renderScreenWith` only at `:772`, *after* the
`if (feature)` branch at `:765` returns, and `#feature()` returns `undefined` only when
`options.fetch` is injected — the fixture path, not the worker path.

What survives, and who still reaches it:

| Consumer | Reaches | Job |
|---|---|---|
| `src/tui/showcase/panel.ts:59` | `renderScreen` | `/stats-test`, a **shipped** command registered in `src/index.ts:50` |
| `src/tui/tabs.ts`, `src/tui/chrome.ts` | `SCREEN_SPECS`, `isDrawableScreen` | the real nav: sidebar rows, tab strip, `g` jump letters |
| `src/tui/panel.ts:24` | `isDrawableScreen`, `specForScreen` | `SELECTABLE_SCREENS` and therefore the digit row and arrow cycling |
| `scripts/probe-render.ts`, `scripts/probe-showcase.ts` | the whole IR | headless review at any width |

`src/tui/screens/*.ts` is metadata only in production. Its `render` bodies are unreachable;
after `7c55cf3` the only surviving direct callers are `test/activity.test.ts` and
`test/errors-screen.test.ts`.

## Considered Options

- **Keep the IR live beside the controllers**, so a route change could still be expressed
  as bands. Rejected: this is the two-grammars-fighting state the IR existed to prevent. The
  conflict is already visible in this repo's history — `AGENTS.md:136` once forbade "a
  replacement interaction model" in the same sentence that told a contributor to add a
  `Band[]` for a production screen's layout. One instruction cannot be read two ways and
  still be an instruction.
- **Delete the IR outright.** Rejected: it is not dead. `/stats-test` is a registered
  command that renders through `renderScreen`, and the production nav reads `SCREEN_SPECS`.
  Deleting it would delete a shipped command and break the sidebar.
- **Retire it as the production path and scope what is left.** Accepted.

## Consequences

A `Band[]` in `src/layout/spec.ts` changes what `/stats-test` draws and which ids
`tabs.ts`/`chrome.ts` expose. It changes **nothing** a user sees in `/stats-tui`. A
contributor adding a production screen writes a `FeatureController` under
`src/tui/features/`, not a static screen spec. The UI refinement's `features/presentation.ts`
reuses `renderBands` locally for metric-grid/table drawing, with already formatted values,
current theme and selection styling. It does not restore the `MetricRef` resolution pipeline
as a production interaction model: focus, search, sort, staged loading and retained state
remain controller-owned.

`src/tui/charts/*` is the deliberate exception and is **not** IR: `features/core/*` imports
`compose.ts`, `sparkline.ts`, `heatmap.ts` and `calendar.ts` directly, so those are
production chart code shared by both paths. CONTEXT.md's IR scope map carries the
file-by-file table so this split is not re-derived.

The IR's own invariants (G4 one blank line between bands, G5 no full-width rule inside a
band) still bind `/stats-test` and are still asserted in `test/band.test.ts`. They no longer
constrain `/stats-tui`, whose production composition now uses shared native rounded
widget frames as well as the body/footer `PanelDivider`. The trace timeline remains
unframed to preserve plot and minimap hit geometry.