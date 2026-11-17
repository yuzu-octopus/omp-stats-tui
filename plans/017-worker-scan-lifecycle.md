# Plan 017: Worker freshness scan runs once and recovers after a crash

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P1 · Effort S · Risk LOW · Depends on none · Category bug/tests
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

`scanPendingSessions()` walks every session file and `stat`s each one, but only stamps `pendingSessionsScannedAt` at the end. Both the live-status subscriber and the fetch handler check the same elapsed condition, so at startup and on any 30 s boundary a status push plus a fetch can launch two overlapping full-directory scans. Separately, the client is designed to respawn after a worker crash and replay live/error state to late subscribers, but neither behaviour is tested.

## Current state

- `scripts/data-worker.ts:46-64` — `FRESHNESS_SCAN_INTERVAL_MS = 30_000`; `scanPendingSessions()` stamps the time only at `:63`. `:71-72` and `:95-96` each call it on the same elapsed test with no in-flight guard.
- `scripts/data-worker.ts:10-14` — stale comment names `patches/@oh-my-pi%2Fomp-stats@18.7.0.patch`; real artifact is `@18.18.2.patch` (`package.json:40`).
- `src/data/client.ts:42-47` — `subscribe()` replays `#live` and `#serviceError`; `:55-65` spawns a child when `#child` is null; `:135-149` clears `#child` and broadcasts the service error on exit.
- `test/data-worker-client.test.ts:16-24` asserts first fetch rejection on premature exit; `:105-107,270` subscribe before live pushes; no respawn or late-replay test.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/data-worker-client.test.ts test/data-worker-large-response.test.ts` | all pass |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `scripts/data-worker.ts`, `test/data-worker-client.test.ts`.
Out of scope: `src/data/client.ts` (behaviour is correct; tests pin it), `src/tui/panel.ts`, other tests, package files.

## Steps

1. Add failing tests in `test/data-worker-client.test.ts`:
   - "a dead worker is replaced on the next fetch": first scripted child exits without replying, first fetch rejects; second fetch resolves with its marker; assert two children were spawned.
   - "late subscribers receive the last live status and the stored service error": push a live status before subscribing and assert synchronous replay; kill the worker, then subscribe and assert the error callback receives the stored error.
2. Run target tests → both fail.
3. In `scripts/data-worker.ts`, replace the two call sites with one `maybeScanPendingSessions()` helper that reuses an in-flight promise and advances the scan timestamp at start (not only at completion). Both live-status and fetch paths call the helper; no duplicate directory walk can start while one is running.
4. Update the stale patch-filename comment at `scripts/data-worker.ts:10-14` to `18.18.2` without changing the import or patch logic.
5. Run target tests, full suite and typecheck → all pass.

## Test plan

Two new tests in `test/data-worker-client.test.ts` above. Existing worker/multiplexing tests are the regression net. Real subprocess tests must reap their children (follow the existing scripted-child helper).

## Done criteria

- [ ] Two scripted children prove respawn; late replay of both live status and error is asserted.
- [ ] No two concurrent scans can start from the same elapsed condition.
- [ ] Stale 18.7.0 patch reference gone from `scripts/data-worker.ts`.
- [ ] Full suite and typecheck pass; only in-scope files changed.

## STOP conditions

If the scripted-child helper cannot express two sequential children, stop and report rather than changing production client code. If scan behaviour changes (count or cadence), stop.

## Maintenance notes

`pendingSessions` is a last-known count with its own observation timestamp; never block a fetch on a fresh scan.
