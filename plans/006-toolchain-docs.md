# Plan 006: Pin the toolchain and make docs tell one truth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- package.json bun.lock .github/workflows/ci.yml README.md AGENTS.md docs/TESTING.md docs/HANDOFF-renderer.md docs/plans/2026-11-09-ground-up-redesign.md scripts/probe-render.ts tsconfig.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs + manifest; the lockfile regen is the only live change)
- **Depends on**: none (plan 001's table references `bun check` — this plan creates it; land this early or have 001 use `bunx tsc --noEmit` with a note)
- **Category**: dx + docs
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Five paper cuts that each cost a contributor one confused loop: the docs
say `bun check` but the manifest has no `check` script; CI typechecks with
unpinned `bunx tsc` (green today can go red with no repo change); the target
runtime is Bun **1.4.4** (maintainer decision, verified installed) while
README/AGENTS.md/CI pin 1.4.2; evergreen docs disagree on the suite count
(669 vs 916 vs 905) with no date; TESTING.md's checkout targets a dead fork
branch; three probes lack manifest entries and `probe-render` cannot do the
40x30 review TESTING.md demands. None is a bug; together they are the
onboarding tax every future executor pays.

## Current state

Facts, all read directly:

- `package.json` scripts: `build / test / verify:patch / probe:data / probe:glyphs / probe:render / test:mutation` — no `check`, no `probe:frame`/`probe:band-heights`/`probe:mouse-truth`.
- `.github/workflows/ci.yml:89-93` confesses the unpinned tsc verbatim ("it tracks whatever tsc is latest that day") and runs `bunx tsc --noEmit`; `bun-version: 1.4.2` at lines 61 and 103.
- Installed runtime: Bun 1.4.4 (verified `bun --version`). README:12, AGENTS.md:192, docs/TESTING.md:13, both plans pin 1.4.2; the 2026-11-09 redesign plan says 1.4.4. **Maintainer decision: 1.4.4 everywhere.**
- Counts: README:119, AGENTS.md:113, AGENTS.md:203, TESTING.md:112 claim 669/44; HANDOFF-renderer.md:57 claims 916/61; 2026-10-06 plan claims 905/61; 2026-10-05 plan carries 854/54, 872/60, 895/61. None dated.
- TESTING.md:22 clones `--branch omp/dashboard-terminal-parity` from the mitnichiter fork; framing (PR #1 merged) makes the branch history, not head.
- `scripts/probe-render.ts` hardcodes `const ROWS = 40`, treats `--help` as `unknown flag` + exit 1, has no `--rows`.

Repo conventions: AGENTS.md §CI documents the pipeline; CI steps mirror
contributor commands (the file's own header rule — "If a step here is not
something you would type by hand, it does not belong here"). Counts live
with commits, never bare.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `bun install`            | exit 0 (regenerates lock with pinned tsc) |
| Typecheck | `bun run check` (new)    | exit 0, no errors   |
| Tests     | `bun test`               | 670 pass, 0 fail    |
| Patch     | `bun run verify:patch`   | exit 0 (re-run after 1.4.4 move) |

Runtime target is Bun 1.4.4 — verify with `bun --version` first.

## Scope

**In scope**:

- `package.json` (add `check`, three probe entries, `typescript` devDep, Bun note if the repo pins engines anywhere)
- `bun.lock` (regen only)
- `.github/workflows/ci.yml` (check step → `bun run check`; `bun-version: 1.4.4` both spots)
- `README.md`, `AGENTS.md` (1.4.4, `bun run check`, count link, probe list)
- `docs/TESTING.md` (main checkout, count link)
- `docs/HANDOFF-renderer.md` (count link/as-of)
- `docs/plans/2026-11-09-ground-up-redesign.md` (already 1.4.4 — confirm, no change expected)
- `scripts/probe-render.ts` (`--help`, `--rows`, no behavior change)

**Out of scope**:

- Any production code, any test file, any ADR.
- Old plan counts (2026-10-05/06) — they are point-in-time records; add `as-of` lines, do not rewrite numbers.
- Lint/format decision (plan 007's D2 follow-up owns the Biome-or-document choice; this plan only wires the check script the docs already name).

## Git workflow

- Branch: `advisor/006-toolchain-docs`
- Commit style: `chore: ...` / `docs: ...` per `git log` convention.
- Do NOT push or open a PR.

## Steps

### Step 1: Pin typescript and add the check script

1. `bun add -d typescript@<version>` — pick the version `bunx tsc` resolved most recently (or latest stable); record it.
2. Add `"check": "tsc --noEmit"` to `package.json` scripts.
3. Change CI's typecheck step to `run: bun run check` and delete the now-false confession comment (replace with one line: pinned via devDependencies).
4. Update README:119 + AGENTS.md:203 to name `bun run check` (they already say `bun check` — correct to the real command).

**Verify**: `bun run check` → exit 0; `bunx tsc --noEmit` → exit 0 (same compiler now).

### Step 2: Move everything to Bun 1.4.4

Replace every `1.4.2` toolchain pin with `1.4.4`: README:12, AGENTS.md:192, TESTING.md:13, CI `bun-version` (both), and confirm the redesign plan's 1.4.4 needs no edit. Then `bun install --frozen-lockfile`Fresh? No — the tsc pin from step 1 already changed the lock; run `bun install` (unfrozen, to regen) then `bun run verify:patch` to prove the patch still applies under 1.4.4, then `bun test` for the full suite. This is the re-verification ADR 0008 demands after any toolchain move.

**Verify**: `bun --version` → 1.4.4; `bun run verify:patch` → exit 0; `bun test` → 0 fail.

### Step 3: Single-source the suite count

AGENTS.md §Testing & QA owns the live count. Replace every other evergreen claim (README:119, TESTING.md:112, AGENTS.md:203's inline number) with a link to that section. HANDOFF-renderer.md:57 keeps its 916/61 but gains an `as-of b147593-ancestors` line (it describes the pre-IR-deletion tree — true for its time, misleading without the date). Old plans keep numbers, gain `as-of` commit lines. Format: `<!-- as-of <sha> <date> -->` or a visible one-liner — match whatever the file already does with dates, else the HTML comment.

**Verify**: `grep -rn "669\|916\|905\|854" README.md AGENTS.md docs/TESTING.md docs/HANDOFF-renderer.md` → evergreen files show exactly one live number (in AGENTS.md) plus links; the rest are as-of'd history.

### Step 4: Fix the TESTING checkout + probe shelf

1. TESTING.md §2: primary path becomes `git clone <origin> && git checkout main` (+ tag/sha when cut); fork-branch clone moves under a `History` note.
2. `package.json`: add `probe:band-heights`, `probe:frame`, `probe:mouse-truth` entries pointing at the existing scripts.
3. `probe-render.ts`: add `--help` (usage + exit 0) and `--rows N` (default 40, preserving current behavior); unknown flags still error.
4. README Develop block: list all six probes + flags, including the `40x30` matrix command TESTING.md demands (`--width 40 --rows 30`).

**Verify**: `bun run probe:frame --help`-equivalent works for each new entry; `bun scripts/probe-render.ts --help` → exit 0; `bun scripts/probe-render.ts overview --width 40 --rows 30` renders.

### Step 5: Full verification

**Verify**: `bun test` → 0 fail; `bun run check` → exit 0; `bun run verify:patch` → exit 0; `git status` shows only in-scope files.

## Test plan

No new tests — this plan is manifest/docs/CI. Verification is the four
gates above plus grep-proofs for single-sourcing. If `bun install` regen
changes unrelated lock entries, inspect the diff: only `typescript` + Bun
version drift is acceptable; anything else is a STOP.

## Done criteria

- [ ] `bun run check` exists and exits 0; CI uses it; confession comment gone
- [ ] `typescript` pinned in devDependencies; lockfile regen clean
- [ ] Every toolchain pin reads 1.4.4 (README, AGENTS.md, TESTING.md, CI x2)
- [ ] Evergreen docs carry one linked count; history is as-of'd
- [ ] TESTING checkout targets main; all six probes runnable + documented; `--help`/`--rows` work
- [ ] `bun test`, `bun run check`, `bun run verify:patch` all exit 0
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `bun --version` on the executor is not 1.4.4 — stop; do not "verify" a toolchain move on the wrong toolchain.
- Lockfile regen pulls unrelated dependency moves — list them and stop.
- `probe-render.ts` flag parsing is load-bearing elsewhere (grep callers first); if a caller passes positional args your flag loop breaks, stop.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- The count link rots every suite change — the executor adding tests under any plan should update AGENTS.md's number + as-of in the same commit.
- If Dependabot/Renovate ever touches `typescript`, the pin policy (exact, like `@oh-my-pi/*`) must be enforced in review.
