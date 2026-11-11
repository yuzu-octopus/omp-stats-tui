# Plan 007: Spike the mutation signal, the probe entrypoint, and the verification runbook

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- scripts/mutate.ts scripts/probe-render.ts docs/TESTING.md .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M (three spikes; time-boxed, none lands production code by default)
- **Risk**: LOW (spikes are branch-only evidence; the only mergeable output is explicitly marked)
- **Depends on**: plan 006 (probe entries + `--rows` make the D2 matrix measurable; run after or mock the matrix by hand)
- **Category**: direction (spikes, not builds)
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Three grounded opportunities, each with the harness already in the repo
but the evidence missing: the mutation harness exists (`test:mutation`)
yet never runs, so suite size (670) is strength nobody measured — the
first score on the money-honesty and G4/G5 mutations tells whether the
highest-leverage assertions catch anything. Six probes exist but review
still hand-rolls commands and the 40x30 checklist case has no producing
command. And the two paths that spend money or touch the network
(broker quota, paid judging) are declared-unverified in three separate
docs — the highest-risk untested surface, needing a human-run protocol,
never CI. Each spike ends in a DECISION with numbers, not in merged code.

## Current state

- `scripts/mutate.ts:1-40` — one-mutation-one-verdict harness (CONTROL no-op + money/G4/G5 mutations like `format-unpriced-marker-dropped`); never invoked by CI (`.github/workflows/ci.yml` has only `test` + `extension-load` jobs).
- Probes: `probe-render/data/glyphs` (manifest entries) + `probe-band-heights/frame/mouse-truth` (no entries — plan 006 fixes); `probe-render.ts` hardcodes `ROWS = 40`, no `--rows` (plan 006 fixes); TESTING.md demands 40x30 review.
- Declared-unverified in three docs: README NOTE ("credentialed broker and paid-judge execution remain unverified"), TESTING.md §5 (broker networking, clipboard, paid judging NOT verified), AGENTS.md Known external boundaries (creds + judge role + explicit auth as paid-smoke prerequisites).

Repo conventions: spikes happen on branches, evidence lands in the plan
file or a dated note — never as unreviewed production code. Paid judging
requires estimate → explicit `y` → progress → `x`-cancel (CONTEXT.md
"Passive frustration"); broker reads need credentials the repo never
stores. The runbook must make accidental `y` structurally hard.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Mutations | `bun run test:mutation` (time-boxed subset — see step 1) | finishes; score recorded |
| Probes    | `bun scripts/probe-render.ts all --width 40 --rows 30` (after plan 006) | renders |
| Typecheck | `bun run check`          | exit 0 |

Runtime is Bun 1.4.4.

## Scope

**In scope (spike outputs only)**:

- A dated mutation-score note (new file under `docs/plans/` or plan-file appendix — NOT a CI change)
- A probe-usage log + wrapper proposal (branch-only script allowed; mergeable only if it deletes more hand-rolled commands than it adds)
- A verification-runbook draft (new file `docs/PAID-SMOKE-RUNBOOK.md` — human-run protocol only)

**Out of scope (explicitly NOT this plan)**:

- Making mutation score gating in CI — decision only, no workflow edit.
- Merging any probe wrapper without the usage log proving it covers the real matrix.
- Running paid judging or storing credentials anywhere — the runbook is a protocol document; executing it needs maintainer authorization beyond this plan and is a separate scheduled activity.
- Any production-code change.

## Git workflow

- Branch: `advisor/007-direction-spikes`
- Spikes stay on the branch. Mergeable output (if any): the runbook doc ONLY, as its own commit, and only if the maintainer approves the draft in review.
- Do NOT push or open a PR.

## Steps

### Step 1: Time-box the mutation subset and score it (D1)

Run ONLY the money-honesty + grammar mutations (`format-unpriced-marker-dropped` and siblings, G4/G5 mutations — list them with `grep -n "id:" scripts/mutate.ts`): `bun run test:mutation` if it accepts a filter, else run the harness per-mutation for that subset on a quiet machine and record wall-clock per mutation + total.

Write the score next to the suite count: `X/Y mutations DIED (caught), Z SURVIVED, T minutes`. For each SURVIVOR, one line: which assertion should have caught it and why it didn't (read the test, don't guess). End with a DECISION section: gate-vs-signal recommendation with the measured wall-clock as the evidence (if the full suite takes >10 min, gating is off the table regardless of score).

**Verify**: the score note exists with numbers; `git status` shows no production/test modifications (harness reverts itself — confirm clean).

### Step 2: Log probe usage and propose the smallest wrapper (D2)

For one review cycle (your own verification of plans 001-006, or a
simulated matrix pass): log every probe invocation (command + flags +
purpose). Then compute the matrix TESTING.md demands: all screens ×
{40,60,100,150} × {unicode,nerd,ascii} × ranges, noting which cells the
current shelf cannot produce (40x30 before plan 006, etc.).

Propose the smallest wrapper covering the log: either one `probe` script
with a matrix mode or a documented copy-pasteable command. Rule: the
proposal must delete more hand-rolled commands than it adds in code. If no
wrapper beats the documented command, the deliverable is the documented
command + the gap list — that is a valid spike outcome.

**Verify**: the proposal + usage log exist in the branch; the matrix gap list names every unproducible cell or "none".

### Step 3: Draft the paid/broker verification runbook (D3)

Write `docs/PAID-SMOKE-RUNBOOK.md` as a HUMAN-RUN protocol (never CI):

1. Prerequisites checklist: judge model role configured, broker credentials present, isolated `--profile`, spend cap, what "authorized" means (explicit maintainer go-ahead per run).
2. Broker quota smoke: read vs snapshots, expected vs redacted, following TESTING.md §4 style.
3. Paid-judge smoke: estimate → explicit-`y` → progress → `x`-cancel, with the runbook making accidental `y` structurally hard (e.g. the estimate step and confirm step are separate commands with a checklist between).
4. Redaction rules: what never lands in logs/issues (credential shapes, account IDs).
5. Explicit non-goals: no load testing, no standing credentials in CI, no automated spend.

Ground every step in the existing controls (CONTEXT.md "Passive
frustration" flow, TESTING.md §4/§5 structure). Mark unknowns as open
questions, not guesses.

**Verify**: the draft exists; a second read confirms no step can execute spend without the explicit-confirm gate.

### Step 4: Record decisions

Append a `## Spike outcomes` section to THIS plan file (or a dated note in
`docs/plans/`): mutation score + gate/signal call, probe wrapper
adopt-or-drop with the usage log, runbook draft status. Each with one-line
reasoning so a future auditor doesn't re-run the spikes.

## Test plan

No production tests — spike evidence is numbers + documents. The mutation
step uses the existing harness; the probe step uses the existing probes;
the runbook step produces a doc. Regression risk is zero by construction
(branch-only, no production edits).

## Done criteria

- [ ] Mutation subset score recorded with wall-clock + gate/signal decision
- [ ] Probe usage log + smallest-wrapper proposal (or documented-command outcome) recorded
- [ ] `docs/PAID-SMOKE-RUNBOOK.md` draft exists (branch-only unless maintainer approves)
- [ ] `## Spike outcomes` recorded with reasoning
- [ ] No production or test files modified (`git status` proves it)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `scripts/mutate.ts` harness does not run on this tree (harness drift) — record the failure mode, do not fix the harness here (that is its own plan).
- Any spike step implies spending money or storing credentials to proceed — stop that step immediately; the runbook stays a protocol doc.
- Verification of sibling plans (001-006) is red — spikes measure a moving tree; wait for green, do not score it.
- A "small wrapper" proposal exceeds ~100 lines — it is not the smallest wrapper; stop and write the documented command instead.

## Maintenance notes

- Re-run the mutation subset after any money/format change — the score is the tripwire for decorative tests.
- The runbook, once approved, needs an owner and a schedule (per release? per broker change?) — that decision belongs to the maintainer, recorded in the outcomes section.
- If the probe matrix grows (new screens), the usage log — not the wrapper — is the artifact to update first.
