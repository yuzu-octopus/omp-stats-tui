# Ship upstream correctness corrections as a locked Bun `patchedDependencies` patch, not as plugin SQL and not at runtime

Status: **accepted**. Replaces the plugin-owned SQL workaround that PR #1 removed from
`src/data/api.ts`, and amends ADR 0001's own-SQL decision, which had already been
superseded for its dependency-resolution half.

The panel's money honesty now depends on a patch that **Bun must apply at install time**. That
is a real architectural commitment: it moves a correctness requirement from source we own
into a build step a contributor can silently skip.

## Why the panel cannot compute this itself

Upstream `@oh-my-pi/omp-stats` classified an absent provider/model price card as **free**,
so a model with no card reported `$0.00` instead of unknown spend. Recorded zero charges and
explicit all-zero price cards were correct and had to stay zero — only the *absent card* was
misclassified. `docs/research/omp-stats-tui/UNPRICED-COST-BUG.md` documents the diagnosis:
upstream's `unpricedRequestSql` keyed on `provider = 'xai-oauth' OR cost_unpriced = 1`, so a
genuine unpriced model on any other provider read as priced-and-free.

The panel therefore faced three options.

The patch replaces that provider allowlist with "consumed-token requests whose stored zero
represents unknown spend", so ingest marks an absent price instead of guessing from the
provider name.

- **A plugin-owned SQL exception**, counting unpriced requests with panel-written SQL over
  `~/.omp/stats.db`. Implemented and then deleted in PR #1. Rejected on principle, not taste:
  it re-implements the rollup union, the dirty-hour staleness rule, the aggregate column list
  and the schema-version check, and it discards `syncAllSessions` entirely. It is also
  *incomplete* — a plugin query can count unpriced rows but cannot make the upstream rollups,
  which already cache the wrong answer, stop serving that wrong answer.
- **Repair the dependency at runtime** with a `Bun.plugin` resolve/onResolve hook or host-root
  discovery. Rejected: it mutates installed packages, works only if the extension loader
  happens to take that path, and cannot be reviewed in a diff.
- **Ship a locked `patchedDependencies` patch.** Accepted.

## The decision

`patches/@oh-my-pi%2Fomp-stats@18.18.2.patch`, applied through `package.json`'s
`patchedDependencies` and recorded in `bun.lock`. Four corrections, each with its own
CHANGELOG entry in the patch:

1. **Absent price card reads as unknown spend**, preserving recorded zero charges and
   explicit free cards. Historic repair is a one-time backfill keyed
   `messages_cost_unpriced_v2` (`db.ts`) plus a `ROLLUP_VERSION` bump `2` → `3`, so cached
   rollups are invalidated and rebuilt rather than left holding the old classification.
2. **The selected range is applied to recent requests before sorting and limiting**, so
   `getRecentRequests` (`aggregator.ts`) answers about the window the user selected. Omitting
   the range keeps the historic all-range API.
3. **Provider `outputTokens`** are exposed on time-series points, which output-burn charts
   read.
4. **`StatsLive({ workers })`** can configure parser concurrency; omitting it preserves the
   dashboard's automatic pool. The panel passes `workers: 1`.

Upstream PR: <https://github.com/can1357/oh-my-pi/pull/14543>.

## Consequences

`bun install` is not optional and not incidental. `node_modules/@oh-my-pi/omp-stats` is a
function of `bun.lock` **and** the patch file. A `node_modules` cache keyed only on
`bun.lock` can restore an unpatched tree and report green on money-honesty behaviour that is
not present — the silent-green failure this decision makes possible, and the reason CI caches
nothing beyond `setup-bun` and asserts the patch immediately after install via
`bun run verify:patch`, which greps the installed `db.ts` for the `messages_cost_unpriced_v2`
marker. **Any future `actions/cache` over `node_modules` must key on both
`hashFiles('bun.lock')` and `hashFiles('patches/*.patch')`.**

The corrected dependency is bundled into `dist/`, not repaired at runtime, so a packed
installation carries the behaviour. `scripts/build.ts` bundles local stats/private
dependencies and externalises only supported host API specifiers.

The panel still must not render `$0.00` for unknown spend: `costWithUnpriced` in
`src/tui/format.ts` prints `N/A` when cost is zero and the unpriced count is non-zero, and a
priced total containing unpriced requests is a **floor** shown with its unpriced count. That
is presentation, and it is not a substitute for the patch: the patch is what makes the count
correct.

This is the second dependency patch the project has needed. It is recorded as an ADR because
the repo's convention is to record exactly this kind of commitment — a correctness property
that depends on an install step, a lockfile and a pending upstream PR — and because ADR 0001's
supersession note now points at a real, named artifact rather than a plan.