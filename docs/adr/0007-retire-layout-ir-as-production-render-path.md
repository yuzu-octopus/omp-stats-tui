# The `ScreenSpec → renderScreen → renderBands` IR is deleted

Status: **accepted**, then **superseded by deletion**. Adopted by `19245dc` as a
retirement, then deleted outright in the ground-up redesign: its only consumers were
the `/stats-test` showcase, the review probes, the panel's fixture/test branch and the
test suite, and every one of those now renders production `FeatureController`s.

PR #1 (`c1396d3`) made the layout IR unreachable as a production render path. The
ground-up redesign removed the last non-production consumers and deleted the IR rather
than keep a second grammar wearing a probe label.

## What was deleted

- `src/layout/spec.ts` — the `ScreenSpec` declarations and `Band[]` data.
- `src/layout/resolve.ts` — `MetricRef` resolution.
- `src/layout/host-derived.ts` — the IR's named figures.
- `src/tui/render/screen.ts` — `renderScreen` / `renderScreenWith`.
- `src/tui/showcase/` — the `/stats-test` showcase, unregistered from `src/index.ts`.
- The panel's fixture branch (`options.fetch` / `renderScreenWith`) and the injected
  `fetch` test seam.

## What replaced it

`/stats-tui` renders `FeatureController.render()` bodies only. Nav identity is data in
`src/tui/screens/` (`SCREENS` / `screenById`); `SELECTABLE_SCREENS` is `SCREENS`
directly. `src/tui/band.ts` survives as the shared drawing grammar — measured stat tiles
and tables — reused by `src/tui/features/presentation.ts`. `scripts/probe-render.ts`
builds the same `FeatureContext` the tests use and prints a controller's body.

## Considered options (historical)

- **Keep the IR live beside the controllers**, so a route change could still be expressed
  as bands. Rejected: this is the two-grammars-fighting state the IR existed to prevent.
  The conflict was already visible in this repo's history — `AGENTS.md:136` once forbade
  "a replacement interaction model" in the same sentence that told a contributor to add
  a `Band[]` for a production screen's layout. One instruction cannot be read two ways
  and still be an instruction.
- **Retire it as the production path and scope what is left.** Accepted first: the IR
  stopped wearing a production costume while the showcase and probes remained.
- **Delete the IR outright.** Accepted in the end: the remaining consumers were all
  probe/test machinery, and the showcase was a second renderer whose bugs were its own.
  The band primitives production actually reuses were kept; the declaration grammar and
  its resolver were not.

## Consequences

A production screen is a `FeatureController` under `src/tui/features/`; adding a screen
means a controller plus a registry identity row, not a static spec. The shared drawing
grammar's invariants (G4 one blank line between bands, G5 no full-width rule inside a
band) still bind the primitives in `src/tui/band.ts`. `/stats-tui`'s only rule is the
`PanelDivider` between body and footer.
