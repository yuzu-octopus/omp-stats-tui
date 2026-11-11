# Paid smoke runbook (DRAFT — maintainer approval required before any execution)

Human-run protocol for the two explicitly-unverified boundaries: broker
quota reads and paid judging. Never CI, never automated spend.

## Prerequisites (all must hold, checked in order)

1. A configured `judge` model role the maintainer names for this run.
2. Provider credentials present in the isolated `--profile` environment.
3. Spend cap agreed and recorded below before starting.
4. Explicit per-run maintainer authorization (a "go" for THIS run, not a standing approval).

Record here before starting: date, authorizer, cap, profile name.

## Broker quota smoke

1. Open Providers → Subscription windows / Account utilization on the isolated profile.
2. Compare quota/capacity readings against the broker's own dashboard (snapshot, not live polling).
3. Redact account IDs and quota numbers before pasting anything into issues/logs.

## Paid-judge smoke

The Frustration controls enforce estimate → explicit-`y` → progress →
`x`-cancel. The runbook keeps estimate and confirm as SEPARATE commands
with this checklist between them:

- [ ] Estimate received and amount is within the recorded cap.
- [ ] Profile is the isolated one (check `omp --profile` output).
- [ ] You typed `y` deliberately after reading the estimate (never scripted).

Cancel with `x` at any point; a cancelled run is a successful smoke of the
cancel path. Failed quote/cancel actions are retryable per the UI; do not
retry a paid start after a failure without re-authorization.

## Redaction rules

Credential shapes, account IDs, quota numbers, and judge model internals
never land in logs, issues, or committed files. Finding: `file:line` +
type only.

## Non-goals

No load testing. No standing credentials in CI. No automated spend. No
network-dependence in the unit suite — this runbook stays human-run by design.
