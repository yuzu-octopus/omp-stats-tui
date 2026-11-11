# Plan 002: Fix the provider share sort and isolate malformed worker lines

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- src/tui/features/providers.ts src/data/client.ts test/provider-gain-features.test.ts test/data-worker-client.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of plan 001; both touch `data-worker-client.test.ts` — if plan 001 lands first, rebase the test additions)
- **Category**: bug
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Two small lies. The Providers totals table offers a `share` sort that
silently sorts by tokens under a false label — users cannot sort by cost or
request share at all, and the label claims they can. Separately, one stray
non-JSON line on the worker's stdout tears down the persistent child and
fails every in-flight read, turning a cosmetic log leak into a full panel
outage. Both fixes are one branch and one try/catch respectively; the risk
is in choosing the wrong share definition and in swallowing real protocol
drift, so both choices are pinned below.

## Current state

The relevant files, each with one line on its role:

- `src/tui/features/providers.ts` — Providers feature; `TOTAL_SORTS` + `sortedTotals()` own the sort contract.
- `src/data/client.ts` — `StatsReadClient.#watch` stdout pump; `#receive` routes by id.
- `src/data/protocol.ts` — `DataWorkerResponse` union; read it before touching the pump.
- `test/provider-gain-features.test.ts` — existing provider feature tests; extend for the sort.
- `test/data-worker-client.test.ts` — `faultChild` harness; extend for the malformed line (coordinate with plan 001's additions).

Excerpts:

Sort fallthrough (`src/tui/features/providers.ts:16`, `57-63`):

```ts
const TOTAL_SORTS = ["tokens", "provider", "requests", "errors", "models", "share", "output", "cost", "premium", "speed"];
...
function sortedTotals(): ProviderAggregate[] {
    const key = TOTAL_SORTS[totalSort];
    const value = (p: ProviderAggregate): string | number => key === "provider" ? p.provider : key === "requests" ? p.totalRequests : key === "errors" ? p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0 : key === "models" ? p.models : key === "output" ? p.totalOutputTokens : key === "cost" ? p.totalCost : key === "premium" ? p.totalPremiumRequests : key === "speed" ? p.avgTokensPerSecond ?? -1 : p.totalTokens;
```

Note the chain: `share` matches no branch, so it falls to `p.totalTokens` — identical to `tokens`.

Untracked `JSON.parse` in the pump (`src/data/client.ts:110-118`):

```ts
while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) this.#receive(JSON.parse(line));
}
if (done) {
    if (buffer.trim()) this.#receive(JSON.parse(buffer));
    break;
}
```

`#receive` is reached only after a successful parse; a throw escapes to the
pump's `.catch`, which SIGKILLs the child and rejects every pending
(`src/data/client.ts:120-123`, `127-133`).

Repo conventions: sort labels are user-visible strings asserted by feature
tests — check for a snapshot of sort labels before changing the array.
CONTEXT.md vocabulary: **cost** is known-priced spend with its unpriced
count; **share** elsewhere in the codebase (analytics `shares()`) means a
fraction of a total. Match that meaning.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun check`              | exit 0, no errors   |
| Tests     | `bun test test/provider-gain-features.test.ts test/data-worker-client.test.ts` | all pass |
| Full suite| `bun test`               | 670 pass + new, 0 fail |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/features/providers.ts`
- `src/data/client.ts`
- `test/provider-gain-features.test.ts` (extend)
- `test/data-worker-client.test.ts` (extend — malformed-line tests only)

**Out of scope**:

- `src/data/api.ts`, `src/tui/features/core/*` — plan 001's territory.
- Any change to the worker's stdout protocol — the fix is parent-side tolerance, not a protocol redesign.
- `ProviderAggregate` upstream type — read-only; if the share needs a field the type lacks, compute it locally (see STOP).

## Git workflow

- Branch: `advisor/002-share-sort-ipc-guard`
- Commit style: `fix: ...` / `test: ...` per `git log` convention.
- Do NOT push or open a PR.

## Steps

### Step 1: Give the share sort a real key

Open `ProviderAggregate` in `node_modules/@oh-my-pi/omp-stats/shared-types` (read-only reference) and check for an existing share-like field. Decision:

- If a share field exists, branch on it in `value()`.
- Else compute request share locally: `p.totalRequests / totalRequestsAcrossProviders` (guard divide-by-zero → 0). Cost share would hide unpriced providers (cost 0 with unpriced > 0 is unknown, not zero — CONTEXT.md), so **request share is the definition**. Name it honestly: if the header renders the sort key, it must read as request share, not bare "share".

Check for a sort-label snapshot test first (`grep -rn "TOTAL_SORTS\|share" test/`). Update it if and only if it pins the label you changed.

**Verify**: `bun test test/provider-gain-features.test.ts` → all pass; add a test cycling sort to `share` and asserting request-share order (two providers, distinct request counts, assert row order).

### Step 2: Isolate malformed worker stdout lines

In `src/data/client.ts`, wrap each `JSON.parse` (lines ~113, ~116) in a
per-line try/catch. On parse failure: increment a `#malformedLines`
counter, append the first ~200 chars of the offending line to `#stderr`
for diagnostics, and CONTINUE the pump (skip the line). If
`#malformedLines` exceeds 10 within one child lifetime, tear down exactly
as today (SIGKILL + reject pendings) — persistent garbage is protocol
drift, not a stray log. Reset the counter when a new child spawns.

Do NOT catch errors from `#receive` itself — only the parse. A well-formed
line that fails routing is a real bug and must still tear down loudly.

**Verify**: add tests to `test/data-worker-client.test.ts` with a child
that emits one garbage line then a valid response: assert the valid
request still resolves and the client survives. Then a child emitting 11
garbage lines: assert teardown. `bun test test/data-worker-client.test.ts` → all pass.

### Step 3: Full verification

**Verify**: `bun test` → 0 fail; `bun check` → exit 0.

## Test plan

- Provider share-sort order test (new, in `test/provider-gain-features.test.ts`).
- IPC: single-garbage-line survival + threshold teardown (new, in `test/data-worker-client.test.ts`), using the existing `faultChild` pattern with a scripted child.
- Existing sort-label snapshots updated only if they pin the changed label.

## Done criteria

- [ ] `bun check` exits 0
- [ ] `bun test` exits 0; new share-sort + IPC tests exist and pass
- [ ] Cycling Providers sort to `share` orders by request share, not tokens
- [ ] One malformed stdout line no longer kills the worker; 11 in a row do
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts don't match live code (drifted since `b147593`).
- `ProviderAggregate` already carries a share semantic that contradicts request-share (e.g. cost share) — stop and report which field, do not pick silently.
- A sort-label snapshot pins `share` with an order your new branch changes — report; do not update snapshots blindly.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- If upstream later adds a real share field, prefer it and delete the local computation — the test pins the behavior, not the implementation.
- The malformed-line threshold (10) is arbitrary; if the worker ever legitimately logs to stdout, fix the worker to use stderr instead of raising the threshold.
