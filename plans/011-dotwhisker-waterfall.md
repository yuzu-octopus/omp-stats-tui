# Plan 011: Terminal geometries for DotWhisker and Waterfall series

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7acf0ad..HEAD -- src/tui/charts/sparkline.ts src/tui/charts/bars.ts src/tui/charts/measure.ts src/tui/charts/host-adapter.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (new modules + one host-adapter branch; existing renderers untouched)
- **Depends on**: plan 008 (only for the spotlight consumer — the geometries stand alone with synthetic tests; build them first, wire to spotlight after 008 scopes it)
- **Category**: direction (parity gap)
- **Planned at**: commit `7acf0ad`, 2026-11-11

## Why this matters

Two web geometries have no terminal equivalent: DotWhisker (per-group
marks with ranges — fetch-back groups, model rankings) and Waterfall
(cumulative savings steps). Today the host draws them and our adapter
redraws them as plain bands, silently discarding the range/cumulative
semantics. A band that hides a confidence interval is a prettier lie than
no chart. Each needs one honest terminal geometry in the shared chart
layer, reusing the width-one cell policy.

## Current state

- Web consumers: `DotWhisker` rows/marks (`FetchBack.tsx:51-114`, `Ranking.tsx:108-156`); `Waterfall({steps, format})` (`charts/Waterfall.tsx:3-36`); `DotWhiskerRow/Mark/Guide/Band` (`charts/DotWhisker.tsx:5-36`). Read-only reference in `node_modules`.
- Our layer: `src/tui/charts/sparkline.ts` (ranked bars, share bar), `bars.ts` (daily/model bars), `measure.ts` (single width implementation, plan 005), `host-adapter.ts` (kind→band fallback for unimplemented kinds — the branch this plan narrows).
- Policy: data ink is width-one cells, ANSI-aware measurement only (`measure.ts`), no emoji/braille/Nerd codepoints (ADR 0005). Series colors via `resolveSeries`/palette.
- Tests: `test/chart-primitives.test.ts` pins geometries; `test/measure.test.ts` pins cells.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run check`          | exit 0, no errors   |
| Tests     | `bun test test/chart-primitives.test.ts test/measure.test.ts` | all pass |
| Probes    | `bun scripts/probe-render.ts` (or a throwaway script for the new geometries) | no OVERWIDE |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- New: `src/tui/charts/dot-whisker.ts` (range-mark rows: label, track, mark cells + whisker extents, null-safe)
- New: `src/tui/charts/waterfall.ts` (cumulative steps: running-total bars with signed direction, subtotal honesty)
- `src/tui/charts/host-adapter.ts` (route the two host kinds to the new geometries INSTEAD of the band fallback — one branch each, fallback stays for the rest)
- `test/chart-primitives.test.ts` (new geometry tests)

**Out of scope**:

- Spotlight wiring (plan 008 owns the consumer; test with synthetic series here).
- Any change to existing bars/sparkline/series renderers.
- Legend/empty-state changes (plan 005 owns the sentence; reuse it).

## Git workflow

- Branch: `advisor/011-dotwhisker-waterfall`
- Commit per geometry. Do NOT push or open a PR.

## Steps

### Step 1: DotWhisker rows

Geometry: per row — label, then a track of N cells mapping the value
domain, with the mark cell(s) filled and whisker extents dimmed. Multiple
marks per row overlay (later marks win the cell, all marks listed in the
legend detail). Null mark → gap (no cell), never zero. Width-budget like
ranked bars (shared divisor per table so rows compare). Read the web
`DotWhiskerRow` shape once for field parity (label, marks[{value,
lo?,hi?}], guides?), then close the reference and design terminal-first.

**Verify**: unit tests — two-mark overlap, null mark gap, all-zero domain, width bounds at 40/100.

### Step 2: Waterfall steps

Geometry: running total across steps; each step a signed bar from the
previous total (up filled, down dimmed/empty-cell, totals full-row
markers). The final total must equal the sum — assert it in the renderer
(debug-assert, not silent clamp). Negative intermediate totals render
below the axis baseline honestly (no clipping to zero).

**Verify**: unit tests — cumulative sum assertion, negative intermediate, empty steps → shared NO_ACTIVITY sentence.

### Step 3: Route the host kinds + full verification

In `host-adapter.ts`, replace the band fallback for exactly the two kinds
the host returns for these series (grep the host `ChartPlan` kind names
first — use the real kind strings, not guesses). Everything else keeps the
fallback. Eth: the plan-005 TECH-DEBT-04 tripwire — the fallback stays for
truly unimplemented kinds.

**Verify**: `bun test` → 0 fail; `bun run check` → exit 0; probe OVERWIDE 0.

## Test plan

- DotWhisker: overlap, null gap, zero domain, width bounds (new tests in `test/chart-primitives.test.ts`).
- Waterfall: sum assertion, negatives, empty → NO_ACTIVITY.
- Host routing: a spec of each kind renders the new geometry, not bands (pin the kind strings).

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun test` exits 0; both geometries tested
- [ ] Host kinds route to the new renderers; other kinds keep the fallback
- [ ] Every line within width at 40/100 (measured, not eyeballed)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The host kind strings for these series aren't what the web suggests (grep first; if the planner never returns them, record that — the geometries still stand alone, routing waits).
- Width-one cells can't express whisker extents legibly at 40 cols — drop to mark-only below a threshold, record the threshold, do not fake precision.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- Plan 008 consumes these for spotlight sections; keep the modules consumer-agnostic (synthetic series in, lines out).
- If the host adds kinds, the fallback + TECH-DEBT-04 note still applies — these two are now claimed, the rest are not.
