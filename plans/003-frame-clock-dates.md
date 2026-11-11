# Plan 003: Narrow the frame-clock invalidation and stop per-frame date garbage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b147593..HEAD -- src/tui/panel.ts src/tui/charts/host-adapter.ts src/tui/charts/time-series.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `b147593`, 2026-11-11

## Why this matters

Every minute boundary recomposes the entire frame — chrome, nav, plan, and
the full feature body — even with identical data, scroll, and selection,
because `#frameKey` ends with `Math.floor(Date.now() / 60_000)`. And every
chart render allocates one `Date` plus one ISO string per bucket just so the
host reads the column as temporal, plus three more for header/footer labels.
Both are pure per-frame garbage on a render path that already memoizes the
frame; the clock fix makes the memo actually hold across minute boundaries,
and the date fix removes O(buckets) allocations per chart.

## Current state

- `src/tui/panel.ts` — `#frameKey` (line ~670) builds the memo key; `#frame` (~686) recomposes on key change. The minute bucket is the last key element.
- `src/tui/charts/host-adapter.ts` — `planTimeline` (~120-144) builds the host table with per-bucket ISO strings.
- `src/tui/charts/time-series.ts` — `renderTimeSeries` (~64-104) formats three label dates per render.

Excerpts:

```ts
// src/tui/panel.ts:670-685
#frameKey(width: number, rows: number, preset: SymbolPreset): string {
    const state = this.#state;
    const event = state.syncEvent;
    return [
        width, rows, state.screenId, state.range, preset, state.generation,
        state.error ?? "", state.syncError ?? "", state.readStage,
        event === null ? "" : `${event.type} ${event.phase} ${event.current} ${event.total}`,
        state.lastSyncedAt ?? -1,
        state.hoveredSidebarId, state.hoveredStripId,
        this.#featureRevision,
        // Read once, here, so the whole frame agrees on one clock.
        Math.floor((this.#options.now?.() ?? Date.now()) / 60_000),
    ].join(" ");
}
```

```ts
// src/tui/charts/host-adapter.ts:128-135
const table = analyzeTable(
    ["Bucket", ...rows.map((row) => row.label)],
    axis.map((timestamp, index) => [
      // An ISO timestamp, so the host reads the column as temporal.
      new Date(timestamp).toISOString(),
      ...rows.map((row, column) => cell(row.values[index], currency[column]!)),
    ]),
);
```

```ts
// src/tui/charts/time-series.ts:71,89-90 (three label conversions per render)
const date = new Date(axis[selected]).toISOString().slice(5, 16).replace("T", " ");
...
const first = new Date(axis[0]).toISOString().slice(5, 16).replace("T", " ");
const last = new Date(axis[axis.length - 1]).toISOString().slice(5, 16).replace("T", " ");
```

Repo conventions: `#frameKey` is documented as "the whole frame agrees on
one clock" — preserve that property for the pieces that read relative time
(`ago`, `today` in chrome), just don't invalidate the body for it.
`planTimeline` geometry stays the host's; only the table construction
changes.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun check`              | exit 0, no errors   |
| Tests     | `bun test test/panel.test.ts test/chart-primitives.test.ts test/body-layout.test.ts` | all pass |
| Full suite| `bun test`               | 670 pass + new, 0 fail |

Runtime is Bun 1.4.4.

## Scope

**In scope**:

- `src/tui/panel.ts` (frame key only)
- `src/tui/charts/host-adapter.ts` (table construction only)
- `src/tui/charts/time-series.ts` (label formatting only)

**Out of scope**:

- `bypassLineCap` / plan logic — the audit's PERFORMANCE-01 was rejected (the second build only runs when the host caps at 6 lines); do not "optimize" it.
- Any change to chart geometry, gates, or empty-state sentences (plan 005 owns the sentence consolidation; keep the strings byte-identical here).
- `scripts/data-worker.ts` — plan 004's territory.

## Git workflow

- Branch: `advisor/003-frame-clock-dates`
- Commit style: `fix: ...` / `perf: ...` per `git log` convention.
- Do NOT push or open a PR.

## Steps

### Step 1: Move the minute bucket out of the global frame key

Remove the `Math.floor(.../60_000)` element from `#frameKey`. The pieces
that render relative time (topbar `ago`, calendar `today`) must still
update across minute boundaries: find them (`grep -rn "Date.now()" src/tui/chrome.ts src/tui/chrome/ 2>/dev/null` plus the topbar/calendar readers)
and give them their own narrow memo keyed on the minute bucket, or render
them outside the cached frame. The body, plan, nav, and feature render
must NOT recompose on a bare minute tick.

How to prove it: the panel test seam (`__testing.makePanel`) exposes frame
caching — write a test that fixes `now` via `options.now`, renders, advances
`now` by 61s with no other state change, and asserts the body lines are
byte-identical (and, if the seam exposes it, that `#frame` returned the
cache). A topbar-relative-time test asserts the chrome DID update.

**Verify**: `bun test test/panel.test.ts` → all pass including the new test.

### Step 2: Type the temporal column once

In `planTimeline`, replace the per-bucket `new Date(timestamp).toISOString()`
with a single ISO-shaped sample for column typing plus raw numeric
timestamps for the rest — IF `analyzeTable` types by column sample. Read
`analyzeTable` in `@oh-my-pi/pi-tui/charts/chart-plan` first (read-only
reference in `node_modules`): if it sniffs the first row only, pass one
ISO string in row 0 and numbers elsewhere; if it requires uniform types,
pass a precomputed ISO string array built ONCE per axis (memoize on the
axis identity in the caller, not per render). Do not change what the host
infers — the plan output for the existing chart-plan tests must be
byte-identical.

**Verify**: `bun test test/chart-primitives.test.ts` → all pass (these pin plan output).

### Step 3: Reuse one date formatter for the three label conversions

In `renderTimeSeries`, hoist the `toISOString().slice(5,16).replace("T"," ")`
pattern into a module-local `formatBucket(dateMs)` helper and call it for
`date`, `first`, `last`. Same output, three calls instead of three inline
allocations-plus-slices. This is readability + allocation locality, not a
behavior change — assert byte-identical lines in the new test.

**Verify**: `bun test test/body-layout.test.ts test/chart-primitives.test.ts` → all pass.

### Step 4: Full verification

**Verify**: `bun test` → 0 fail; `bun check` → exit 0.

## Test plan

- Frame-clock test: same state + 61s later ⇒ identical body lines; chrome relative-time still advances (in `test/panel.test.ts`, following the existing `__testing.makePanel` pattern).
- Chart-plan output tests already pin the geometry — they must pass unchanged (no new tests needed for step 2 beyond the existing pins).
- Label-format test: assert header/footer date strings for a fixed axis (or rely on existing body-layout assertions if they cover it — check first, add only if uncovered).

## Done criteria

- [ ] `bun check` exits 0
- [ ] `bun test` exits 0; new frame-clock test exists and passes
- [ ] No `60_000` / `60000` in `#frameKey`
- [ ] `planTimeline` allocates at most O(1) Dates per render for column typing
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts don't match live code (drifted since `b147593`).
- `analyzeTable` requires uniform column types AND offers no memoization point — report the signature; do not restructure the host call.
- The chrome-relative-time readers cannot be scoped without touching files outside scope — list them and stop.
- Verification fails twice after reasonable fixes.

## Maintenance notes

- If new chrome starts reading wall-clock time, it must join the narrow minute-keyed memo, not the global frame key — note this in review.
- The `formatBucket` helper is UTC by construction (`toISOString`); any future local-time label needs its own helper, not a flag on this one.
