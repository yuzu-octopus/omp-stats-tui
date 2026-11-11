# Plan 004: Serve fetch payloads without blocking on the freshness walk

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- scripts/data-worker.ts test/data-worker-client.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (freshness semantics are load-bearing for the topbar)
- **Depends on**: none (plan 001 changes the payload shape; if it lands first, carry the `errors` field through the freshness attach)
- **Category**: perf
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Every fetch whose arrival crosses the 30s freshness interval pays for a
full session-directory stat walk (128-file batches, `getFileOffsets` +
`stat` per file) before the panel sees its payload — the cheapest
freshness-adjacent request becomes intermittently the slowest. The payload
does not depend on the scan; only the attached `freshness.pendingSessions`
count does. Serving the payload first and refreshing the count in the
background removes the latency spike without changing what the topbar
displays — at most the pending count lags one interval behind, which is
already its documented staleness semantic.

## Current state

- `scripts/data-worker.ts` — worker main loop; `scanPendingSessions` (~52-66), the live-subscription throttle (~68-76), the per-fetch await (~92-99).

Excerpts (read live before editing; line numbers from audit):

```ts
// throttle on the live path — the pattern to reuse
live.subscribe(status => {
    void emit({ type: "live", status }).catch(...);
    if (Date.now() - pendingSessionsScannedAt >= FRESHNESS_SCAN_INTERVAL_MS) {
        void scanPendingSessions().catch(error => console.error(error));
    }
});
```

```ts
// per-fetch: payload first computed, then scan awaited, then freshness attached
const payload = await fetchFor(request.needs, request.range);
const rollupOnly = request.needs.length === 1 && request.needs[0] === "rollupStatus";
if (!rollupOnly && Date.now() - pendingSessionsScannedAt >= FRESHNESS_SCAN_INTERVAL_MS) {
    await scanPendingSessions();
}
payload.freshness = { records: getMessageCount(), pendingSessions, observedAt: Date.now() };
data = payload;
```

The `rollupOnly` carve-out already acknowledges the scan is the expensive
part of the cheapest request — this plan generalizes that insight: the scan
is never on the payload's critical path.

Repo conventions: worker errors go to stderr + `process.exit(1)` for fatal,
`console.error` for background-scan failures (never reject a fetch for a
scan failure). CONTEXT.md: dirty-hour/pending counts are freshness states
with explicit staleness semantics — a count one interval stale is honest as
long as `observedAt` says when it was scanned.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun check`              | exit 0, no errors   |
| Tests     | `bun test test/data-worker-client.test.ts` | all pass |
| Full suite| `bun test`               | 670 pass + new, 0 fail |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `scripts/data-worker.ts` (fetch path + scan scheduling only)
- `test/data-worker-client.test.ts` (scan-timing test only — coordinate with plans 001/002 additions to the same file)

**Out of scope**:

- `src/data/client.ts`, `src/data/api.ts` — plans 001/002 territory.
- `scanPendingSessions` internals (batching, stat logic) — not this plan.
- The live-subscription throttle — already correct, reuse as exemplar.
- Any change to what `pendingSessions` MEANS — only when it is refreshed.

## Git workflow

- Branch: `advisor/004-freshness-off-path`
- Commit style: `fix: ...` / `perf: ...` per `git log` convention.
- Do NOT push or open a PR.

## Steps

### Step 1: Attach the last-known freshness and refresh in the background

Change the per-fetch path so it NEVER awaits the scan:

1. After `fetchFor` resolves, attach `freshness` from the last-known `pendingSessions` + `pendingSessionsScannedAt` (as `observedAt`) immediately and emit the payload.
2. Then, if the interval has elapsed (same `FRESHNESS_SCAN_INTERVAL_MS` check, minus the `rollupOnly` carve-out — it is no longer needed), kick `scanPendingSessions()` WITHOUT awaiting (same `void ... .catch(console.error)` shape as the live path), and let the NEXT live-status emission or next fetch carry the refreshed count.

Delete the `rollupOnly` special case — with the scan off the critical path, rollup-only and full fetches share one code path again.

The topbar contract is unchanged: it already renders `observedAt`-aged counts; the only behavioral delta is a fetch arriving mid-interval carries the previous interval's count instead of stalling for the new one.

**Verify**: existing scan-count tests in `test/data-worker-client.test.ts` (the `SCAN_PRELOAD` suite) still pass — they assert scan FREQUENCY, which this change preserves (scans still happen at most once per interval, now triggered post-emit rather than pre-emit).

### Step 2: Pin the non-blocking behavior with a timing test

Extend the `SCAN_PRELOAD` suite: with a stubbed slow scan (or a large fake session dir via the existing isolation helper), assert that a `fetch` resolves BEFORE the scan completes — e.g. record emission order (payload emitted, then scan done) via the `STATS_SCAN_DONE` log the preload already supports. Assert the payload's `freshness.observedAt` equals the pre-scan timestamp (stale-by-design, honestly dated).

**Verify**: `bun test test/data-worker-client.test.ts` → all pass.

### Step 3: Full verification

**Verify**: `bun test` → 0 fail; `bun check` → exit 0.

## Test plan

- Existing `SCAN_PRELOAD` frequency tests must pass unchanged (frequency preserved).
- New ordering test: payload emission precedes scan completion; `observedAt` is pre-scan (in `test/data-worker-client.test.ts`, following the preload pattern already in that file).

## Done criteria

- [ ] `bun check` exits 0
- [ ] `bun test` exits 0; new ordering test exists and passes
- [ ] No `await scanPendingSessions()` on the fetch path (only fire-and-forget)
- [ ] `rollupOnly` carve-out removed (one path for all fetches)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts don't match live code (drifted since `b147593`; the worker loop moved during plan 001 — reconcile first).
- The topbar or any feature reads `freshness` in a way that assumes it was scanned during THIS fetch (grep `freshness` consumers first; if one does, list it and stop).
- A scan failure currently rejects the fetch and some test pins that — report; do not silently convert to `console.error` without updating the pinned test deliberately.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- If the scan interval changes, both trigger sites (live path + fetch path) must move together — consider a shared `maybeRefreshScan()` helper in review.
- Reviewer should confirm the worst case: a fetch storm with a huge session dir now emits N payloads with the same stale count, then one scan — that is the intended trade.
