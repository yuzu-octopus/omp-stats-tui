# Plan 005: Consolidate width helpers and the empty-chart sentence

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- src/tui/charts/bars.ts src/tui/charts/heatmap.ts src/tui/charts/sparkline.ts src/tui/charts/time-series.ts src/tui/charts/host-adapter.ts src/tui/band.ts test/bars.test.ts test/heatmap.test.ts test/chart-primitives.test.ts test/band.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (every chart/band width test touches the shared helper)
- **Depends on**: plan 003 (do the date cleanup first so the width diff stays reviewable); plan 004 is independent
- **Category**: tech-debt + perf
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Four private copies of measure/pad/clamp with two width systems:
`band.ts` and `sparkline.ts` measure ANSI-aware cells via `visibleWidth`;
`bars.ts` and `heatmap.ts` measure byte-counting `Bun.stringWidth` on
already-styled strings. Any ANSI-bearing readout therefore measures wider
than it renders — bars shrink, lines clip on themed output while passing
on plain-text fixtures. The O(n²) clamp (remeasure the whole prefix per
character) rides along in the same functions. And three copies of the
empty-chart sentence must agree by hand. One implementation, one system,
one sentence — then the width tests pin the winner instead of four
divergent copies.

## Current state

- `src/tui/band.ts:209-222` — `clamp`, `padEndTo`, `padStartTo` via `visibleWidth`. THE WINNER: ANSI-aware, used by the band grammar every production metric grid goes through.
- `src/tui/charts/sparkline.ts:159-183` — `ellipsize`, `padStartTo`, `padEndTo`, `clampLine` via `visibleWidth`/`truncateToWidth`. Same system as the winner; converge names onto it.
- `src/tui/charts/bars.ts:249-255` — `clamp` via `Bun.stringWidth` with a per-character remeasure loop (the O(n²)). LOSER.
- `src/tui/charts/heatmap.ts:137-155` — `clip` hand-walks escapes then counts `visible++` per UTF-16 unit (wrong for wide glyphs). LOSER.
- `src/tui/charts/time-series.ts:96-101` — inline `visibleWidth` + `truncateToWidth` legend budget. Already on the winning system; just route through the shared helper.
- `src/tui/charts/sparkline.ts:359-360` — `Bun.stringWidth(fitted)` on an already-fitted ANSI string. Must become `visibleWidth`.
- `src/tui/charts/heatmap.ts:107` vs `:134` — same row measured both ways. Must converge.
- Empty sentences: `bars.ts:239` ("No activity recorded in this range."), `host-adapter.ts:347` (same, retyped), `time-series.ts:34-46` (`emptyState` with three distinct claims — deliberately distinct, NOT part of the consolidation; leave it alone).

Excerpts (the two losers):

```ts
// bars.ts:249-255
function clamp(text: string, width: number): string {
    if (Bun.stringWidth(text) <= width) return text;
    let out = "";
    for (const ch of text) {
        if (Bun.stringWidth(out + ch) > width) break;
        out += ch;
    }
    return out;
}
```

```ts
// heatmap.ts:137-155 (clip hand-walk — escape-aware but cell-wrong)
function clip(row: string, width: number): string {
    if (width <= 0) return "";
    let visible = 0;
    let out = "";
    for (let i = 0; i < row.length; ) {
        if (row[i] === "") { ... out += row.slice(i, stop); i = stop; continue; }
        if (visible >= width) break;
        out += row[i];
        visible++;
        i++;
    }
    return out;
}
```

The winner's shape (`band.ts:209-222`, and `truncateToWidth` from `@oh-my-pi/pi-tui`):

```ts
function clamp(text: string, width: number): string {
    if (width <= 0) return "";
    return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}
```

Repo conventions: data ink is one cell wide; `theme-fidelity.test.ts`
scans `src/tui/features/**` for hand-drawn glyphs — keep helpers in
`charts/`, never duplicate into features. G5 (no full-width rule in bands)
is asserted literally; consolidation must not introduce rule characters.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun check`              | exit 0, no errors   |
| Tests     | `bun test test/bars.test.ts test/heatmap.test.ts test/chart-primitives.test.ts test/band.test.ts test/sparkline.test.ts` | all pass |
| Full suite| `bun test`               | 670 pass + new, 0 fail |
| Probes    | `bun scripts/probe-render.ts all --width 100 --width 60` | OVERWIDE 0 |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/charts/bars.ts` (clamp only)
- `src/tui/charts/heatmap.ts` (clip only)
- `src/tui/charts/sparkline.ts` (`Bun.stringWidth(fitted)` line + helper convergence only)
- `src/tui/charts/time-series.ts` (legend budget lines only)
- `src/tui/charts/host-adapter.ts` (NO_ACTIVITY import only — sentence moves, logic untouched)
- New shared module OR `band.ts` export (one decision, see step 1)
- `src/tui/band.ts` (only if it hosts the shared helper)
- Width tests that pin the changed outputs (update expectations only where the OLD output was byte-measure-wrong on ANSI input — each such update needs a comment naming why)

**Out of scope**:

- `time-series.ts` `emptyState` three-sentence logic — deliberately distinct claims, not drift. Do not touch.
- Chart geometry, gates, plans, `bypassLineCap` — untouched.
- `src/tui/features/**` — `theme-fidelity` pins no hand-drawn helpers there; do not add any.
- Probe scripts, docs, CI.

## Git workflow

- Branch: `advisor/005-width-consolidation`
- Commit style: `refactor: ...` / `test: ...` per `git log` convention.
- Do NOT push or open a PR.

## Steps

### Step 1: Pick the home for the single implementation

Decision: export from `band.ts` if the charts layer may import from the
band grammar without creating a cycle (check imports: `band.ts` imports
from `palette`/`glyphs`, not from `charts/` — verify with grep before
deciding). Else create `src/tui/charts/measure.ts` with `clampCells`,
`padEndCells`, `padStartCells`, `ellipsizeCells` — all on
`visibleWidth`/`truncateToWidth`, all handling width <= 0, all with doc
comments naming the ANSI rationale (copy the `sparkline.ts:ellipsize`
comment — it is the best statement of the why).

Verify no cycle: `bun check` after wiring the import (a cycle is a typecheck-visible error here, plus runtime `undefined` — the test suite catches it).

**Verify**: `bun check` → exit 0 with the new module imported by one caller.

### Step 2: Replace the losers, one file at a time

For each of `bars.ts` (clamp), `heatmap.ts` (clip), `sparkline.ts`
(`Bun.stringWidth(fitted)` → `visibleWidth(fitted)`; helpers →
shared), `time-series.ts` (legend budget → shared): replace, run that
file's tests, confirm green before the next file. The incremental
`visible++` vs remeasure question disappears — `truncateToWidth` owns the
single walk.

The O(n²) clamp fix comes free with the replacement; do not write a
separate "incremental loop" — deleting the loop IS the fix.

**Verify** (after each file): its test file passes; then `bun scripts/probe-render.ts all --width 40 --width 150` spot-check for OVERWIDE.

### Step 3: Consolidate the empty-chart sentence (the two identical ones)

`bars.ts:239` and `host-adapter.ts:347` are byte-identical
("No activity recorded in this range."). Own the sentence in ONE module
(the new `measure.ts` if created, else `bars.ts` as exporter — NOT a third
location) and import at the other site. `time-series.ts emptyState` stays
untouched — its three sentences are load-bearing distinctions.

**Verify**: `grep -rn "No activity recorded" src/` → exactly one definition site + imports.

### Step 4: Full verification

**Verify**: `bun test` → 0 fail; `bun check` → exit 0; `probe-render` at 40/60/100/150 → OVERWIDE 0 on all presets (`--preset unicode --preset ascii`).

## Test plan

- Existing width tests must pass; where an expectation changes, the old expectation must be demonstrably byte-measure-wrong (ANSI input measured with `Bun.stringWidth`) — comment each such change with the input that proves it.
- New tests (in the shared module's test or `test/bars.test.ts`): ANSI-styled input clamped to the same cells as its plain equivalent; wide-glyph (CJK, emoji-width) input counted by cells not UTF-16 units; width <= 0 returns "".
- Structural pattern: existing chart width tests (plain `bun:test`, `expect(...).toBe(...)` on rendered lines).

## Done criteria

- [ ] `bun check` exits 0
- [ ] `bun test` exits 0; new cell-measurement tests exist and pass
- [ ] No `Bun.stringWidth` remains in `src/tui/charts/` for post-style measurement (grep proves it)
- [ ] `No activity recorded` defined once
- [ ] `time-series.ts emptyState` untouched (three distinct sentences intact)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts don't match live code (drifted since `b147593`; plan 003 touched `time-series.ts` — reconcile first).
- Importing the shared helper creates a cycle `band ↔ charts` — stop and create `measure.ts` instead (or vice versa); do not ship a cycle.
- A width test pins an output that your change alters AND the old output is correct on ANSI input too (i.e. the divergence is real behavior, not measurement) — list it and stop.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- All future width code uses the shared helper — reviewers should reject new local clamp/clip functions on sight.
- If the host changes `truncateToWidth` semantics, every chart changes at once now — that is the intended trade, and the cell-measurement tests are the tripwire.
