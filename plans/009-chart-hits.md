# Plan 009: Make charts inspectable — shared hit contract for bars and series

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7acf0ad..HEAD -- src/tui/features/types.ts src/tui/mouse.ts src/tui/charts/bars.ts src/tui/charts/host-adapter.ts src/tui/charts/time-series.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches hit-testing all features share)
- **Depends on**: none (plan 012's provider-select consumes this contract — land first)
- **Category**: direction (parity gap)
- **Planned at**: commit `7acf0ad`, 2026-11-11

## Why this matters

Web charts are controls, not pictures: clicking a Projects bar scopes the
table to that folder, clicking a provider row charts it, selecting a
bucket inspects it. Our charts return lines only — the one exception is
tables, which already report hits. A bar a user cannot interrogate is a
dead end: they see the spike, then hunt the table to find what caused it.
The contract already exists (`FeatureHit`/`reportHits`/`handleHit`); charts
just don't speak it.

## Current state

- Hit contract (`src/tui/features/types.ts:10-60`): `FeatureHitAction = {selectRow} | {selectDay}`; `FeatureHit{rowStart,rowEnd,colStart,colEnd,action}`; `reportHits?`, `handleHit?`. Mouse router (`src/tui/mouse.ts:24-54`) translates hits by notice offset + scroll.
- Chart renderers return `readonly string[]` with no hit output: `renderDailyBars` (`src/tui/charts/bars.ts:277`), `renderModelCostBars` (`:315`), `renderHostChart`/`renderSeriesChart` (`src/tui/charts/host-adapter.ts`), `renderTimeSeries` (`src/tui/charts/time-series.ts:71`). Tables already call `reportHits`; charts never do.
- Web precedent: `TimeChart({onSelectBucket})` (`TimeChart.tsx:12-18`); `BarList onSelect→setSearch` (ProjectsRoute.tsx:135,155); provider `onRowClick→chart` (ProvidersRoute.tsx:582).
- Precedent in-repo: calendar heatmap cells already select days (requests `selectDay` action exists) — extend the pattern, don't invent.
- Vocabulary (CONTEXT.md): **bucket** (the slice one column stands for); **band** (vertical unit). New actions name the bucket index.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run check`          | exit 0, no errors   |
| Tests     | `bun test test/mouse.test.ts test/chart-primitives.test.ts` | all pass |
| Full suite| `bun test`               | 688 + new, 0 fail   |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/features/types.ts` (extend `FeatureHitAction` with `selectBucket {series, index}` — additive only, existing variants untouched)
- `src/tui/charts/bars.ts`, `src/tui/charts/host-adapter.ts`, `src/tui/charts/time-series.ts` (return hits alongside lines — new return shape or out-param; see step 1 decision)
- `src/tui/mouse.ts` (route the new action; translation logic reused)
- 1–2 pilot features (analytics overview chart + projects bars — NOT all twelve at once)
- `test/mouse.test.ts` + `test/chart-primitives.test.ts` (extend)

**Out of scope**:

- All-feature rollout — pilot first; the pattern, once proven, replicates per feature.
- Trace minimap drag parity (finding 8: keyboard stepping is the honest equivalent; density jumps belong to a later plan).
- Tooltip parity (accepted non-goal).

## Git workflow

- Branch: `advisor/009-chart-hits`
- Commit per step; style `feat: ...` per `git log`. Do NOT push or open a PR.

## Steps

### Step 1: Decide the hit-plumbing shape

Two options: (a) charts return `{lines, hits}` (breaks every caller at
once — grep callers first, count them; if >15, prefer b); (b) charts take
an optional `reportHits?` callback like features do (additive, no
signature break). Pick (b) unless the repo's chart call sites are few —
record the caller count and the choice in the commit message.

**Verify**: caller count recorded; choice justified in one commit-message line.

### Step 2: Emit bucket hits from bars + series

Bars: each column maps to a bucket index — hit span is the column's cell
range, action `{selectBucket {series: key, index}}`. Series/host charts:
same per plotted point. Null-gap columns emit NO hit (a gap is not
selectable — same honesty rule as rendering). Width-clamped (invisible)
columns emit no hit.

**Verify**: new tests: click-map for a 5-bucket bar row (hits at the
right columns, none for null gaps); `bun test test/chart-primitives.test.ts` → pass.

### Step 3: Route + pilot in two features

Mouse router passes `selectBucket` through the existing translation.
Pilot: overview analytics chart (select bucket → set selected point, which
already exists via `,`/`.` keys — wire the same state) and projects bars
(select bar → set search filter, mirroring web `onSelect→setSearch`).
Both must also work keyboard-first (the click is an alias, not the only
path — every mouse action needs a key equivalent per the repo's input
contract).

**Verify**: `bun test test/mouse.test.ts test/panel.test.ts` → pass, including a keyboard-equivalence test per pilot.

### Step 4: Full verification + probe

**Verify**: `bun test` → 0 fail; `bun run check` → exit 0; `probe-render` at 40/150 shows pilot selection markers (the selected-bucket highlight must render in the static probe).

## Test plan

- Hit-map unit tests (columns, null gaps, clamped columns) in `test/chart-primitives.test.ts`.
- Router test: `selectBucket` survives notice-offset + scroll translation in `test/mouse.test.ts`.
- Pilot tests: bucket click == `,`/`.` keypress state; bar click == search filter text (extend existing feature tests).

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun test` exits 0; hit-map + router + pilot tests exist and pass
- [ ] Null/clamped columns emit no hits
- [ ] Every click pilot has a keyboard equivalent (tested)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Chart caller count makes (a) a 15+-file change — take (b), do not rewire the world.
- `FeatureHitAction` extension breaks an exhaustive switch somewhere (grep `selectRow`/`selectDay` exhaustiveness first; if a switch needs the new variant, handle it explicitly, never `default:`-swallow).
- A pilot feature's selection state doesn't exist yet as keyboard state — build the keyboard path first, click second; never click-only.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- Every future chart must emit hits or record why not (reviewer checklist).
- If upstream adds host kinds that draw as bands (TECH-DEBT-04), the band fallback must also emit hits or explicitly opt out.
