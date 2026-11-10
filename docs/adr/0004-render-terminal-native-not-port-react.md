# Render terminal-native views; do not port the React dashboard

Status: terminal-native rendering **retained**; reduced scope **superseded** by the [dashboard-parity roadmap](../plans/2026-10-05-dashboard-parity.md). Twelve retained production `FeatureController`s implement all eleven web routes plus Activity, with focus/search/sort/selection/details, request-to-trace navigation, independent provider quota, project Gain history, nested traces and passive/explicit-confirmation Frustration judging. The original `ScreenSpec → renderScreen → renderBands` IR is **deleted** — see [ADR 0007](0007-retire-layout-ir-as-production-render-path.md), which supersedes this ADR's "pure chart/probe renderer" clause. The nav identity lives in `src/tui/screens/` and the band primitives survive as the shared drawing grammar behind `features/presentation.ts`. The complete mounted acceptance matrix remains pending. The text below records the historical subset decision, not exclusions from current scope.

The web dashboard is a React 19 application: eleven route components totalling **5,348** lines
(`docs/research/omp-stats-tui/REPORT.md` §8 — F7's own headline of 4,637 is an arithmetic
slip; F7's per-file table sums to 5,348, and the table is right), plus 9,244 lines of `.tsx`
in total. The TUI is the opposite shape — a hand-written component whose whole interface is
`render(width) => readonly string[]`. Porting the dashboard means rewriting every screen into a rendering
model it was not written for, and the traces view in particular (2,126 lines of wheel-zoomed flamegraph
with a draggable viewport) is not a dashboard at all but a different application with no terminal
equivalent. We build terminal-native views over the same data instead, reusing the host's component kit
and its first-party idioms.

## Consequences

**The subset itself is superseded.** All eleven web routes are now implemented, so what
remains true here is the *method* — terminal-native views over the same data, no React
components imported. Only the chart layer was ever cheap: a sparkline, a ranked bar list and
a proportional split bar each translate to a few lines, and 637 lines of chart code covers all
of them. The cost was concentrated in the screens, not the drawing primitives, and that is
where the effort went.