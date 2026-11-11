# Plan 012: Small web-parity gaps batch — population header, empty states, provider select

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7acf0ad..HEAD -- src/tui/features/core/requests.ts src/tui/charts/time-series.ts src/tui/features/providers.ts test/request-workflows.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (copy + header text + one selection wiring; no contracts change)
- **Depends on**: plan 009 (provider row-click consumes the hit contract — if 009 hasn't landed, do items 1–2 first and leave item 3 behind a STOP)
- **Category**: direction (parity gaps)
- **Planned at**: commit `7acf0ad`, 2026-11-11

## Why this matters

Three small places where the web is precise and we are vague: the requests
table can be misread as a total (the loaded-population distinction is one
dim notice); empty states don't name the active filter (so "no data" reads
the same with and without a search); provider windows require view
navigation where the web selects directly into the chart. Each is an hour;
together they close the honesty gap the adversarial pass found.

## Current state

- Requests: web header `"N of latest M requests"` / `"N of M in window"` (RequestsRoute.tsx:163-164). Ours: a dim panel notice (`panel.ts` freshness/population notice) but the requests table header (`src/tui/features/core/requests.ts`) doesn't restate population. The `recent` payload carries the loaded rows; the complete-range total comes from the overview/summary totals.
- Empty states: ours is three shared sentences (`src/tui/charts/time-series.ts:34-46` `emptyState` — deliberately distinct claims, keep them). Web names the filter (`EmptyState title="No model versions match the filters"`, FrustrationRoute.tsx:780). The gap is CONTEXT (which filter), not the sentence taxonomy.
- Providers: web row-click scopes the chart (`onSelect→setPicked`, ProvidersRoute.tsx:261-269). Ours: `selectWindow` fires on view entry (`providers.ts:127-178`); the windows table has selection but selecting doesn't scope the chart without Tab navigation.
- Tests: `test/request-workflows.test.ts` (requests), feature tests per screen.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run check`          | exit 0, no errors   |
| Tests     | `bun test test/request-workflows.test.ts test/provider-gain-features.test.ts test/chart-primitives.test.ts` | all pass |
| Full suite| `bun test`               | 688 + new, 0 fail   |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/features/core/requests.ts` (table header restates loaded-population: "N of latest M" / "N of M in window")
- `src/tui/charts/time-series.ts` (empty-state callers pass optional filter context — signature-additive only; the three sentences stay)
- `src/tui/features/providers.ts` (row selection scopes the utilization chart, keyboard path first per plan 009's rule)
- Tests for all three

**Out of scope**:

- The `FeatureHitAction` contract itself (plan 009 owns it — this plan consumes; if 009 is unlanded, STOP on item 3).
- New empty-state sentences (context suffix only, taxonomy unchanged).
- Any money-display change.

## Git workflow

- Branch: `advisor/012-small-parity-gaps`
- Commit per item (3 commits). Do NOT push or open a PR.

## Steps

### Step 1: Population header in requests

Table header line reads `"N of latest M requests in {range}"` (or `"N of
M in window"` when a filter narrows to the complete set — mirror the web's
two phrasings). Source M from the same totals the summary uses; when M is
unknown (unloaded need — plan 001's partial shape), say `"N loaded
(total unavailable)"` — never a bare N that reads as a total.

**Verify**: tests for all three phrasings (complete, narrowed, unknown total).

### Step 2: Filter context on empty states

`emptyState` (and the band-level empties if they exist) take an optional
`{filter?: string}`. When set, append `" matching {filter}"` to the
chosen sentence — the taxonomy (no readings / all zero / not chart-worthy)
is picked first, context appended second. No-filter calls render
byte-identical strings (existing tests pin this — they must pass
unchanged).

**Verify**: existing empty-state tests pass UNCHANGED (byte-identical); new tests cover the suffix.

### Step 3: Provider row selection scopes the chart (needs 009)

If plan 009 landed: wire windows-table selection to `selectWindow` (same
state the Tab path sets — one state, two inputs, keyboard equivalent
already exists). If 009 hasn't landed: STOP, record, land items 1–2 and
close the plan with item 3 open (do not invent a parallel hit path).

**Verify**: selecting a window row updates the utilization chart without Tab; keyboard path unchanged.

## Test plan

- Population phrasings × 3 (in `test/request-workflows.test.ts`).
- Empty-state suffix + byte-identical no-filter (in `test/chart-primitives.test.ts`).
- Provider select-scopes-chart (in `test/provider-gain-features.test.ts`).

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun test` exits 0; all new tests pass; empty-state olds pass unchanged
- [ ] No bare-N population header anywhere (`grep` the old phrasing)
- [ ] Item 3 either wired via 009's contract or explicitly deferred with a STOP record
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The complete-range total M isn't available to the requests feature without a new fetch — use "total unavailable" phrasing, do not add a fetch.
- 009 unlanded when reaching item 3 — defer item 3, do not duplicate the contract.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- Population phrasing must survive plan 001's partial shape (unknown total is a first-class case, not an edge).
- If new filters are added to any screen, their empty states get the context suffix by updating the caller, not the taxonomy.
