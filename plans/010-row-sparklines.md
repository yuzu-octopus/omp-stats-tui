# Plan 010: Per-row sparklines in Models, Costs and Tools tables

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7acf0ad..HEAD -- src/tui/features/core/analytics.ts src/tui/charts/sparkline.ts src/tui/charts/measure.ts test/chart-primitives.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (additive column; existing columns untouched)
- **Depends on**: none
- **Category**: direction (parity gap)
- **Planned at**: commit `7acf0ad`, 2026-11-11

## Why this matters

Web model/tool rows carry an 80×20 inline Sparkline — the table shows the
shape, not just the total. Our tables show numbers only; spotting the
model whose usage spiked mid-range means opening each detail in turn. The
primitive already exists (`renderSparkline`); no table embeds it. One
additive column, three tables.

## Current state

- Primitive: `renderSparkline(values, opts)` (`src/tui/charts/sparkline.ts:87`); width-one cells, ANSI-aware via the plan-005 `measure.ts` consolidation.
- Web precedent: per-row `<Sparkline values width=80 height=20 color>` (ModelsRoute.tsx:429, ToolsRoute.tsx:359).
- Tables: `src/tui/features/core/analytics.ts` owns Models/Costs/Tools tables (rows built ~lines 132-193; `ListState` + `row()` helpers in `shared.ts`). Check the table column-budget code first — narrow widths drop secondary columns by priority, and the sparkline must be FIRST to drop (numbers beat shapes when space is scarce).
- Width rule: every rendered line stays within width (plan 005 `clampCells`); the sparkline column is budgeted like any other column.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run check`          | exit 0, no errors   |
| Tests     | `bun test test/chart-primitives.test.ts test/core-analytics.test.ts` | all pass |
| Probes    | `bun scripts/probe-render.ts models --width 100 --width 60` | spark column at 100, dropped at 60 |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/features/core/analytics.ts` (sparkline column in Models/Costs/Tools tables; column-priority order)
- `test/core-analytics.test.ts` or `test/chart-primitives.test.ts` (new: spark column renders at wide, drops at narrow, never overflows)

**Out of scope**:

- New sparkline geometry — reuse `renderSparkline` as-is.
- Costs component-split sparklines (one trend per row is the ask; per-component is a later plan if ever).
- Any change to sort/filter/selection behavior.

## Git workflow

- Branch: `advisor/010-row-sparklines`
- Commit per table or one commit; style `feat: ...`. Do NOT push or open a PR.

## Steps

### Step 1: Read the column-budget code

Find the priority-based column dropping in `analytics.ts` (search
"priority" or the column-width fitting logic). Record the drop order.
The sparkline column goes LAST in priority (first dropped). If no
explicit priority list exists, add the sparkline as the first candidate
in the existing narrowing branch — do not build a new priority system.

**Verify**: drop order recorded in the commit message.

### Step 2: Add the column to three tables

Series per row already exist in the table models (the chart above plots
them — reuse the same per-row values, do NOT recompute). Render with
`renderSparkline(values, {width: sparkWidth, ...})` where `sparkWidth`
comes from the column budget (fixed ~12 cells at wide, never a
percentage). Dim when the row is not selected (shapes support scanning,
not shouting).

**Verify**: probe at 100 shows the column in all three tables; at 60 it is gone; no OVERWIDE.

### Step 3: Tests + full verification

New tests: wide → spark cells present in the row string; narrow → absent;
every line within width at 40/60/100/150 (extend the existing width-sweep
pattern if the file has one, else assert per width).

**Verify**: `bun test` → 0 fail; `bun run check` → exit 0.

## Test plan

- Column presence/absence by width (3 tables × wide/narrow).
- No-overflow sweep at 40/60/100/150.
- Pattern: existing analytics/chart width tests in the same files.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun test` exits 0; sparkline column tests exist and pass
- [ ] Probe: column at 100, dropped at 60, OVERWIDE 0 everywhere
- [ ] Sparkline is first-dropped (numbers survive narrowing)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Per-row series values don't exist in the table models (only aggregates) — stop and report the recompute cost; do not fetch per row.
- No column-budget code exists (tables overflow instead of dropping) — stop; that is a different plan (column budgeting first).
- Verification fails twice after reasonable fixes.

## Maintenance notes

- If the host changes sparkline semantics, the shared primitive updates once (plan 005) — tables inherit.
- Reviewer: check dim-vs-selected contrast at all three presets.
