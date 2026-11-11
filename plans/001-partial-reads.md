# Plan 001: Make route reads settle independently and pin the behavior

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- src/data/api.ts src/tui/features/core/requests.ts src/tui/features/core/summary.ts test/api.test.ts test/data-worker-client.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (this is the foundation; plan 002's IPC guard is independent and may land in either order)
- **Category**: bug + tests
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Two fail-fast `Promise.all` sites mean one dead route blanks the whole
screen: `fetchFor` in `src/data/api.ts` rejects the entire `PanelData` when
any single need fails, and the overview loader in `summary.ts` discards a good
overview when the recent-requests read fails. A transient failure on
`/api/stats/recent` therefore renders as an empty screen instead of partial
data with a scoped error. The retry control (`l`/`e` key) exists precisely
for the scoped-error case, so the current behavior also strands that UX.
There are zero tests covering the multi-need path, so the fix needs
characterization tests written first — otherwise a weaker executor cannot
tell a correct partial result from a regression.

## Current state

The relevant files, each with one line on its role:

- `src/data/api.ts` — route fetchers + `fetchFor(needs, range, read, overrides)`; the panel's central read path. `PanelData` is the per-need result map (`src/data/api.ts:219`).
- `src/tui/features/core/requests.ts` — requests/errors list feature; its `load` early-returns on stale generations without resetting `loading`.
- `src/tui/features/core/summary.ts` — overview/projects/activity feature; guarded `finally` is the exemplar to copy.
- `test/api.test.ts` — only 3 tests, none invoking `fetchFor`. Pattern for stub readers: pass a `Fetcher` override or a stub `Reader`.
- `test/data-worker-client.test.ts` — `faultChild` harness exists for protocol tests.

Excerpts of the code as it exists today:

`fetchFor` rejects everything on one failure (`src/data/api.ts:282-285`):

```ts
const entries = await Promise.all(
    needs.map(async need => [need, await routes[need](range)] as const),
);
return Object.fromEntries(entries) as PanelData;
```

Stale-generation early return skips the loading reset (`src/tui/features/core/requests.ts:165-170`):

```ts
const load = async (nextRange: Range) => {
    if (closed) return;
    range = nextRange; const request = ++generation; loading = true; error = null; ctx.changed();
    try { const result = await ctx.reader.api<MessageStats[]>(id === "requests" ? "/api/stats/recent" : "/api/stats/errors", { range, limit: String(steps[step]) }); if (closed || request !== generation) return; rows = result; hasData = true; }
    catch (caught) { if (closed || request !== generation) return; error = String(caught); }
    loading = false; ctx.changed();
};
```

The exemplar guarded `finally` in summary (`src/tui/features/core/summary.ts:73-89`):

```ts
try {
    ...
    if (this.closed || generation !== this.generation) return;
    this.data = data;
} catch (error) {
    if (this.closed || generation !== this.generation) return;
    this.error = error instanceof Error ? error.message : String(error);
} finally {
    if (!this.closed && generation === this.generation) { this.loading = false; this.ctx.changed(); }
}
```

Repo conventions that apply: error handling follows the per-feature
`loading`/`error` + `ctx.changed()` pattern — match `summary.ts` exactly.
Vocabulary from CONTEXT.md: a failed read is a **loading state** distinct
from empty; partial data with a scoped error is the honest state, never a
measured zero. Money honesty is untouched here, but do not regress the
unpriced surfacing in `summary.ts` display code while editing the loader.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun check`              | exit 0, no errors   |
| Tests     | `bun test test/api.test.ts test/data-worker-client.test.ts` | all pass |
| Full suite| `bun test`               | 670 pass, 0 fail    |

`bun check` is the repo's typecheck entry (added by plan 006; if it does
not exist yet, use `bunx tsc --noEmit` and note it). Runtime is Bun
1.4.4.

## Scope

**In scope** (the only files you should modify):

- `src/data/api.ts`
- `src/tui/features/core/requests.ts`
- `src/tui/features/core/summary.ts` (loader only, lines ~73-89; display code out of scope)
- `test/api.test.ts` (extend)
- `test/data-worker-client.test.ts` (extend, happy-path multiplexing only)

**Out of scope** (do NOT touch, even though they look related):

- `src/data/client.ts` — IPC guard belongs to plan 002; do not combine.
- `scripts/data-worker.ts` — freshness walk belongs to plan 004.
- `patches/*`, `bun.lock` — nothing here changes the dependency.
- Any display/format code — the scoped-error rendering already exists (`errorLines`, `e`/`l` retry); only the settling behavior changes.

## Git workflow

- Branch: `advisor/001-partial-reads` (repo has no enforced convention; short conventional-style branch names match `git log`).
- Commit per step or per logical unit, message style: `fix: ...` / `test: ...` (match `git log`: `fix:`, `refactor:`, `test:`, `deps:` prefixes).
- Do NOT push or open a PR.

## Steps

### Step 1: Write the characterization tests for fetchFor

Add to `test/api.test.ts` (model new tests on the existing three — plain
`bun:test`, stub functions, no DB or worker):

1. Multi-need success shape: call `fetchFor(["overview", "recent"], "24h", stubRead)` with a stub `Reader` returning canned JSON per path; assert both keys present with the stubbed values.
2. Single-need rejection today rejects the whole call: `fetchFor` with one fetcher override that throws; assert the promise rejects. Mark this test with a comment `// documents pre-fix fail-fast; step 2 inverts it` — you will rewrite it in step 2.
3. Fixture-reader redirect: pass a non-live `read` and assert the route-backed fetches route through it (e.g. spy on which reader the fetcher received), while direct calls do not redirect.
4. Override precedence: pass `overrides: { recent: async () => CANNED }` and assert the override value wins over the reader.

**Verify**: `bun test test/api.test.ts` → all pass (existing 3 + new 4).

### Step 2: Settle route reads independently in fetchFor

Change `src/data/api.ts:282-285` from `Promise.all` to per-need
settlement. The contract: `fetchFor` returns `{ data: PanelData-partial, errors: Partial<Record<DataNeed, string>> }` — every need that succeeded
appears in `data`; every need that failed appears in `errors` with
`String(cause)`. If ALL needs fail, still return the shape (empty `data`,
full `errors`) — never throw for a need failure. (Throwing stays only for
programmer errors: unknown need key.)

Update the step-1 test #2 to assert the new shape: the failing need's
message in `errors`, the good need's value in `data`, no rejection.

Callers: find every `fetchFor` caller (`grep -rn "fetchFor(" src/ scripts/`)
and update each to read `.data` and surface `.errors` through the
feature's existing `error` field. The worker (`scripts/data-worker.ts`)
should attach `errors` to the payload so the panel can render scoped
errors beside retained data. Keep the payload JSON-serializable (string
messages only).

Money-honesty guard: `PanelData` money fields keep their unpriced counts;
a missing need must read as "not loaded", never as zero. Do not touch
`formatEstimatedCost`/`costWithUnpriced` call sites.

**Verify**: `bun test test/api.test.ts` → all pass; `bun check` → exit 0.

### Step 3: Fix the stale-generation loading reset in requests.ts

Apply the `summary.ts` guarded-`finally` pattern to
`src/tui/features/core/requests.ts:165-170`: wrap the try/catch so the
trailing `loading = false; ctx.changed()` runs only when
`!closed && request === generation`, inside a `finally`. The stale-return
branches (`return` inside try/catch) must skip state writes but still allow
the `finally` guard to evaluate false and do nothing for the stale
generation.

Also apply the same audit to `src/tui/features/core/summary.ts:76-79`
(the `Promise.all([overview fetch, recent api])`): with `fetchFor` now
settling independently, route this through the same partial shape — a
failed recent read must not discard a good overview. Reuse the
`fetchFor` contract rather than inventing a second partial shape.

**Verify**: `bun test test/request-workflows.test.ts test/core-summary-workflows.test.ts` → all pass; `bun check` → exit 0.

### Step 4: Cover StatsReadClient happy-path multiplexing

Extend `test/data-worker-client.test.ts` using the existing `faultChild`
pattern, but with a scripted-sequence child that speaks the
`DataWorkerResponse` union (see `src/data/protocol.ts` for the exact
shapes — `id`, `stage`, payload, live pushes):

1. Two concurrent `fetch` calls resolve to the right callers (id routing in `#receive`).
2. `stage` callbacks fire per request.
3. A `live` push broadcasts to subscribers without resolving any pending.
4. `close()` rejects pendings with "Stats panel closed".

**Verify**: `bun test test/data-worker-client.test.ts` → all pass.

### Step 5: Full verification

**Verify**: `bun test` → 670 pass + your new tests, 0 fail; `bun check` → exit 0.

## Test plan

- New tests in `test/api.test.ts`: multi-need success, single-need error
  shape (rewritten in step 2), reader redirect, override precedence.
- New tests in `test/data-worker-client.test.ts`: id routing, stage
  callbacks, live broadcast, close-drains-pendings.
- Structural pattern: existing tests in the same files (plain `bun:test`,
  stub readers, `faultChild` harness). No DB, no worker, no network.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun check` exits 0
- [ ] `bun test` exits 0 with 0 fail; new `fetchFor` + multiplexing tests exist and pass
- [ ] No `Promise.all(needs` fail-fast remains in `src/data/api.ts`
- [ ] `requests.ts` load has a guarded `finally` matching the `summary.ts` shape
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drifted since `b147593`).
- `PanelData` has additional required fields not visible in the excerpt, making a partial shape impossible without a type change — report the type first.
- A `fetchFor` caller renders `data` in a way that cannot tolerate a missing need (e.g. non-null assertion on a need) — list the caller, do not weaken the type with `!`.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Future needs added to `DATA_NEEDS` automatically get independent settlement; reviewers should check new callers handle the `errors` map.
- If pagination or polling is added to a need, the per-need error entry must carry the attempt that failed, not a stale earlier error.
- Deferred: rendering per-need errors inline per band (today: feature-level `error` field). That is a display change, not this plan.
