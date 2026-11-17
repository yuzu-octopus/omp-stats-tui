# Plan 020: Docs, pins and tooling match current code

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P2 · Effort S · Risk LOW · Depends on none · Category docs/dx
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

Leading spaces make the `.omp` ignore rules inert, so machine-local plugin state shows up as untracked. Three docs still advertise 669 tests (baseline is 684 before this wave), the plan index rows 008–012 are stale, `AGENTS.md` understates `verify:patch` as one grep although it checks eight markers, and a historical plan still tells executors to pin 18.7.0. `@types/bun` is the only caret-pinned dependency, and stale 18.7.0 wording remains in `scripts/build.ts` and `src/data/api.ts`.

## Current state

- `.gitignore:17-19` — ` .omp/plugins/` and ` .omp/cache/` have leading spaces; `git check-ignore -v .omp/plugins/ .omp/cache/` currently reports no match.
- `README.md:120`, `AGENTS.md:203`, `docs/TESTING.md:114` — 669/44; baseline is 684/44 before this wave. `docs/TESTING.md:114` also has 85,872 assertions.
- `plans/README.md:7,20-24,28` — 008–012 marked TODO though `2b585f2`, `15a469b`, `cf028fc`, `6469608` and the sparkline work landed.
- `AGENTS.md:124` — single `messages_cost_unpriced_v2` marker; `scripts/verify-patch.ts:17-26` checks eight markers across six files.
- `docs/plans/2026-11-09-ground-up-redesign.md:390` — task says pin 18.7.0; current pins are 18.18.2.
- `package.json:36` — `"@types/bun": "^1.4.2"`; all other pins exact. `scripts/build.ts:4` says 18.7.0. `src/data/api.ts:317-325` says provider-windows/sync/request-details are "deliberately absent" though `ctx.reader.api()` reaches them on demand in the same worker.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Ignore check | `git check-ignore -v .omp/plugins/ .omp/cache/` | both match |
| Typecheck | `bun run check` | exit 0 |
| Full suite | `bun test` | all pass |

## Scope

In scope: `.gitignore`, `README.md`, `AGENTS.md`, `docs/TESTING.md`, `plans/README.md`, `docs/plans/2026-11-09-ground-up-redesign.md`, `scripts/build.ts`, `src/data/api.ts`, `package.json`.
Out of scope: `scripts/data-worker.ts` (plan 017 owns its comment), `bun.lock` (orchestrator regenerates after the pin edit), source behaviour, CI workflow, other plans.

## Steps

1. Strip the leading spaces from `.gitignore:17-19`; verify with the ignore command.
2. Update `plans/README.md`: mark 008–012 DONE with landing commits; state all twelve are merged; keep rejected findings and add one line recording the 013–020 wave as IN PROGRESS (orchestrator finalises statuses).
3. Fix `AGENTS.md:124` to say `verify:patch` asserts all eight markers across six files, pointing at `scripts/verify-patch.ts:17-26`.
4. Add a superseded note to `docs/plans/2026-11-09-ground-up-redesign.md` stating pins are 18.18.2 from `package.json` and the old 18.7.0 step must not be run.
5. Correct `scripts/build.ts:4` to 18.18.2 and rewrite the `src/data/api.ts:317-325` comment to state the real contract: these reads are excluded from `DATA_NEEDS`/first paint but available on demand via `StatsReadClient.api()` in the same isolated worker.
6. Change `package.json:36` to exact `"1.4.2"`. Do **not** edit `bun.lock`; the orchestrator runs `bun install` after all agents finish and verifies `verify:patch` again.
7. Update README's `g` documentation: `g` + letter jumps screens; `g` + digit `1`–`6` selects a range; note the 1200 ms arm window. Also document that `Shift+Tab` reverses focus only on analytics routes and falls through to previous screen elsewhere. Do not change source behaviour here.
8. Do **not** change test counts; the orchestrator updates the three count sites after the full suite settles.
9. Run typecheck and full suite → pass.

## Test plan

No new tests: this is a docs/config plan. Verification is the ignore check, typecheck, full suite and the orchestrator's lockfile refresh.

## Done criteria

- [ ] Ignore rules match; plan index current; verify:patch description accurate; stale 18.7.0 instructions gone from this plan's scope.
- [ ] README key table documents `g` + digit and the Shift+Tab asymmetry.
- [ ] Full suite and typecheck pass; only in-scope files changed (excluding the orchestrator's later `bun.lock` refresh).

## STOP conditions

If changing `@types/bun` to exact produces a lockfile mismatch when the orchestrator verifies, report it; do not hand-edit `bun.lock`.

## Maintenance notes

Test counts are deliberately orchestrator-owned so they are stamped once after all new tests land.
