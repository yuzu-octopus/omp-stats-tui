# Plan 008: Scope the Spotlight TUI surface (design spike, not a build)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan produces DECISIONS and a scoped
> follow-up plan, not production code. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7acf0ad..HEAD -- src/data/api.ts scripts/data-worker.ts src/tui/screens/types.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (spike; time-box 2–3 hours, then decide)
- **Risk**: LOW (no production edits)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `7acf0ad`, 2026-11-11

## Why this matters

Spotlight is a whole second dashboard with zero TUI counterpart: fetch-back
waste analysis, compounding savings, per-tool economics, model rankings, and
a hero summary — served by its own aggregator (`spotlight-aggregator.ts`)
through `/api/stats/spotlight`, with 11 section components. Our Gain screen
covers cost-savings totals, but none of the behavioral layer (which tools
waste calls, what a session would have cost unshaped). The question is not
whether to copy all eleven sections — it is which 2–3 survive the terminal
and what they cost in worker payload.

## Current state

- Web entry: `~/.bun/install/global/node_modules/@oh-my-pi/omp-stats/src/client/routes/SpotlightRoute.tsx:1-13` imports 11 sections (`Compounding`, `Coverage`, `Economics`, `FetchBack`, `Hero`, `Overhead`, `Ranking`, + `ResultsFeed`, `Savings`, `ShareTrend`, `Steps`, `TimeCost` — see `src/client/spotlight/` directory, 16 files).
- Server seam: `~/.bun/install/global/node_modules/@oh-my-pi/omp-stats/src/server.ts:335-336` serves `/api/stats/spotlight` via `spotlightView(range, agent)` backed by `getSpotlightDashboardStats(range, agent)` (`src/spotlight-aggregator.ts:1175`).
- Types: `SpotlightDashboardStats` + `SpotlightEstimate` in `src/shared-types.ts:346,538,600-635` (read-only reference).
- Our side: `src/data/api.ts:203-216` `DATA_NEEDS` has no spotlight need; `scripts/data-worker.ts` has no spotlight fetch; `src/tui/screens/types.ts` registry has 12 screens. Our Gain feature (`src/tui/features/gain.ts:12-13`) covers `GainDashboardStats` totals only.
- Conventions: new data needs follow the `fetchFor` `{data, errors}` contract (plan 001); new screens register in `src/tui/screens/types.ts` with a `FeatureController`; money honesty (cost beside unpriced) applies to every spotlight dollar figure.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run check`          | exit 0, no errors   |
| Tests     | `bun test`               | 688 pass, 0 fail    |

Runtime is Bun 1.4.4.

## Scope

**In scope (read-only + notes only)**:

- Web spotlight sections (read-only in `node_modules`)
- `src/data/api.ts`, `scripts/data-worker.ts`, `src/tui/screens/types.ts` (READ to scope, DO NOT EDIT)
- New: `docs/plans/2026-11-11-spotlight-scope.md` (the deliverable)

**Out of scope (do NOT touch)**:

- Any `src/`, `test/`, `scripts/` production edit — this spike ends in a scoped build plan, not code.
- The paid-judge runbook — unrelated surface.

## Git workflow

- Branch: `advisor/008-spotlight-scope`
- One commit with the scope note. Do NOT push or open a PR.

## Steps

### Step 1: Size the payload

Call the spotlight aggregator through a throwaway script (do NOT add a
worker need): `bun -e` importing `getSpotlightDashboardStats` from the
installed dep for range `24h`, print `JSON.stringify(stats).length` and
the top-level keys. Record bytes + keys in the note. If the payload
exceeds ~500KB for 24h, the follow-up plan must page or summarize —
record which.

**Verify**: byte count + key list recorded; script deleted afterwards (throwaway, not committed).

### Step 2: Judge each section for terminal-fitness

For each of the 11 sections, one line: TERMINAL-FIT (table/bars/text carry
it), ADAPT (needs a geometry from plan 011), or BROWSER-ONLY (drag,
canvas, hover-density — name which). Default to 2–3 FIT sections for the
first scope; name the rest as explicitly deferred with one line each.

**Verify**: every section has a verdict; FIT set is ≤3.

### Step 3: Write the scope note + follow-up plan sketch

`docs/plans/2026-11-11-spotlight-scope.md`: payload size, section
verdicts, the proposed screen(s) (registry entries, needs, worker
payload shape), what reuses Gain's charts vs needs plan 011 geometries,
money-honesty notes per dollar figure, and open questions. End with a
build-plan sketch (files, steps, tests) detailed enough that a future
plan can be written without re-reading the web source.

**Verify**: `bun run check` → exit 0 (no src changes, trivially true); note exists.

## Test plan

No production tests — spike evidence is the note. The follow-up build
plan (not this plan) will specify tests per the repo's controller-test
pattern (`test/provider-gain-features.test.ts`: render-string assertions
+ width bounds).

## Done criteria

- [ ] Payload bytes + keys recorded
- [ ] All 11 sections have FIT/ADAPT/BROWSER-ONLY verdicts, FIT ≤3
- [ ] `docs/plans/2026-11-11-spotlight-scope.md` exists with build-plan sketch
- [ ] No `src/`/`test/`/`scripts/` files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The spotlight aggregator import fails outside the worker (bundling boundary) — record the failure mode; the follow-up plan routes through `handleApi` instead.
- Payload is an order of magnitude larger than estimated (>5MB for 24h) — stop, record, do not design around it here.
- `DATA_NEEDS`/registry shape drifted from "Current state" — reconcile first.

## Maintenance notes

- If upstream adds spotlight sections, re-run step 2 for the new ones only.
- The FIT set is a ceiling, not a floor — reviewer may cut further.
- Finding 9 from the audit (frustration error parity) was REJECTED during vetting: our `frustration.ts` already separates quote-error/actionError/starting/cancelling with generation guards — no plan.
