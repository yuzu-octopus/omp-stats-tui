# Testing the terminal stats dashboard PR

Review target: [dashboard composition PR #3](https://github.com/yuzu-octopus/omp-stats-tui/pull/3), from [the fork branch](https://github.com/mitnichiter/omp-stats-tui/tree/omp/dashboard-composition). [Workflow PR #1](https://github.com/yuzu-octopus/omp-stats-tui/pull/1) and [initial refinement PR #2](https://github.com/yuzu-octopus/omp-stats-tui/pull/2) are merged; this revision addresses the subsequent twelve-screenshot feedback.

## 1. Check prerequisites

```sh
omp --version
bun --version
command -v bun
```

Verified runtime: compiled **omp 18.6.1**, standalone **Bun 1.4.2**, Linux arm64. Bun must be on the PATH inherited by omp: the compiled host still launches a separate Bun stats worker. Other omp versions/platforms are not claimed verified.

Use an interactive terminal, initially about 150 columns by 38 rows, then resize to 100 and 40 columns. Paired widgets require at least 100 content cells after chrome/sidebar, not merely 100 terminal columns. Print/headless/RPC modes cannot display this overlay. No browser server or upstream omp source checkout is required.

## 2. Check out the PR and build

From a directory that does not already contain `omp-stats-tui-review`:

```sh
git clone --branch omp/dashboard-composition --single-branch https://github.com/mitnichiter/omp-stats-tui.git omp-stats-tui-review
cd omp-stats-tui-review
bun install --frozen-lockfile
bun run build
```

The build must produce `dist/index.js` and `dist/data-worker.js`. Keep `node_modules` installed; the worker's real standalone judge depends on runtime packages. Bun applies the committed dependency patch during installation; do not manually edit installed packages.

Check extension loading without sending a model request:

```sh
omp models -e "$PWD/dist/index.js"
```

Read stderr for extension-load errors, not just the exit code. `-e` belongs **after** the `models` subcommand; `omp --help` does not load extensions.

## 3. Launch

### Existing local history

```sh
omp plugin link .
omp plugin
omp
```

The plugin list should include `omp-stats-tui`. Start a new omp process after linking or rebuilding; extensions do not hot reload. Inside omp:

```text
/stats-tui
```

Expect a fullscreen Stats panel, an initial loading state, then data or an explicit empty/error state. Close restores the existing transcript. Built-in `/stats` remains the separate browser command.

Opening the dashboard is not read-only: its isolated worker can initialize/migrate the stats database and ingest recorded sessions. It does not send paid model requests simply by opening.

### Separate review profile

To avoid testing against your normal profile, use the supported explicit extension entry instead:

```sh
omp --profile stats-tui-review -e "$PWD/dist/index.js"
```

Complete or skip any first-run setup before entering `/stats-tui`. A fresh profile can legitimately have no recorded usage, quota readings, savings or nested sessions. Do not interpret that as populated-workflow coverage; use an existing history/profile for the corresponding scenarios. Do not fabricate records in your normal database.

## 4. Manual acceptance checklist

Press jump keys sequentially: `g`, then the letter. Finish text entry before using jumps. After each route change, wait for its data/loading state to settle before interacting. `Tab` changes the route's focused area; controls are contextual, not universal shortcuts.

Visual acceptance must exercise production controllers, not just `/stats-test` or injected `StatsPanelOptions.fetch` (the latter uses the pure IR path). Review sparse data too: one model, two cost buckets, two projects, four failures, no savings, and frustration samples below the default threshold. Expect balanced cards, readable neutral metadata, bounded chart marks, nearby legends, selected context beside sparse tables, and intentional empty explanations. Wide layout stacks on smaller content areas; scrolling is legitimate, overflowing borders or losing identities is not. Passing tests alone is not visual acceptance.


| Scenario | Actions | Expected result |
|---|---|---|
| Overview | `g o`; Tab between latest requests and chart; select a row and Enter | Recent rows expose request identity/time/duration; details open lazily. Chart controls and complete-range totals remain available |
| Search and staged requests | `g r`; `/`, type `q[]`; Ctrl+U clears the query, Enter finishes; `l` increases the loaded limit; use arrows or `j`/`k` | Literal `q` and brackets remain input, not close/navigation. Query and no-match state remain visible. Loaded population/completeness is distinct from complete-range totals; every loaded row is reachable |
| Request JSON sections | Open a request; `n` selects a section, `v` expands/collapses it; `c` copies full JSON, `C` copies selected section | Timing, token categories, costs and identity are visible. Section state changes independently. Copy either succeeds or reports a clipboard error; a headless clipboard failure is not silent success |
| Request to trace and back | First browse any other trace. Then `g r`, open a request, expand a JSON section, `t`; Esc leaves trace entry details, then `b` returns | Return restores the same request inspector and expanded section, not the unrelated earlier trace. Child opens have their own nested back history |
| Models | `g m`; Tab until All models; select and Enter; `m` switches detail trend | Performance and individual request trends are inspectable, including models grouped into Other in the top-level chart |
| Costs | `g c`; Tab between chart and tables; use `m` on chart, select/expand a table row | Cost modes retain their units and series identity. Unpriced counts remain visible; wholly unknown spend is not presented as free |
| Errors | `g e`; Tab signatures/models/failures; `o`/`O` sort focused panel; Enter filters; `x`/`X` clear signature/model independently | One focused table is shown at a time; independent sort/selection survives pane changes. Clearing one filter retains the other. Opened request is a matching failure; no recorded failures is an honest empty state |
| Activity | `g a`; Tab to calendar; `j`/`k` day, `h`/`l` week; Enter on a quiet day; `b`, then `t` | Quiet-day details show zero activity, selected cell is themed, historical windows follow selection, and `t` restores today. Calendar lookback is 371 local days, independent of global range |
| Tools | `g l`; Tab until By tool; `d` opens selected tool detail; inspect its trend; use `f` on the appropriate tools view | Individual call trends and tool details remain accessible; opening full by-tool details does not change the model filter |
| Projects | `g j`; focus folders; search/sort/select/Enter; Tab to cost/request rankings; `t` toggles temporary folders | Selection/details and ranking-to-folder navigation work; unfiltered aggregate totals remain separately labeled |
| Providers | `g v`; Enter token mix; sort and check retained provider; Tab totals/burn/peak/windows/accounts; select window and Enter; inspect points and hide a series | Local usage is independent of quota loading/errors. Provider/account identity survives sorting; hidden series are marked off and removed from the plot; capacity, resets, headroom and exhausted snapshots stay explicit. Zero peak-hour buckets have no fake activity bars |
| Gain | `g n`; `p`/`P` project; Tab history/sources; `h`/`l` point; select source and Enter | Project selection scopes totals, daily/cumulative history and sources together. Daily and cumulative series have distinct theme colors. No savings/project data is an explicit empty condition |
| Nested traces | `g t`; select a root and Enter; `E` expands tracks; Tab children, select child, `O` opens it, `b` returns; `v` changes time/turn/call axis, `i` toggles idle compression | Recorded root/child/grandchild relationships and durations remain recognizable; linked event identity survives navigation/axis changes. Root discovery remains limited to 300 upstream candidates |
| Trace minimap | In an open trace, `m`; Home, Space, Right twice, Enter; `h`/`l` resize edges, `a`/`d` move brush, `+`/`-` zoom, `0` fit; Esc cancels an unfinished range | Range/seek visibly changes the timeline window without changing the linked selected event. Category strips retain overlapping activity; marker-only events remain selectable |
| Passive Frustration | `g f`; `m` includes small samples; Tab families, Space toggles one; `1`–`4` toggle rate layers/trend; Enter shows raw IDs | Cached/regex coverage, class/family counts and raw model details work without starting a judge. Missing passive data is distinct from failed reads |
| Range, freshness and retention | Outside text entry, `r`/`R` changes range, `s` requests sync; navigate away and back | Valid ranges are 1h/24h/7d/30d/90d/all. Loading/sync failures are visible; retained selections/search/sort survive refresh. Already-recorded transcript updates can refresh automatically without another paid call |
| Narrow layout and exit | Resize to 40 columns, then wider; scroll; Tab to another focus; Ctrl+C closes | Controls wrap, focused content remains reachable, scroll counter and close hint fit. Close restores transcript/cursor and does not leave a stats worker running |
| Visual hierarchy and plots | At 100x40 and 160x45, inspect Overview/Models/Costs/Tools and Providers/Gain; inspect passive Frustration | Metrics precede the main widget; quantities align; focus/selection is explicit. Plot scales and selected values have the correct units. Missing observations remain gaps or unavailable values, not fake activity |
| Theme and symbol presets | Repeat representative routes with light/Unicode, dark/ASCII and a custom theme/Nerd preset | Header, cards, selected rows and plot ink use the active theme. ASCII chart marks remain legible; custom colors are not replaced by a browser palette |
| Read failures | In an isolated launch only, omit standalone Bun from the host PATH; open the dashboard, jump to Requests, then close | Failed-read status and the actionable worker error appear without fabricated cost/usage values; navigation and transcript/cursor restoration remain usable |

A data-dependent row can be **not exercised** rather than failed when the necessary history is absent. Record which scenarios have real data; do not claim that an empty profile proves quota, savings, failures or nested-trace behavior.

## 5. Paid judging and external systems

Do not press `y` in the Frustration estimate dialog unless you explicitly intend to authorize paid judging. Passive browsing, tests and the extension-load command do not authorize it. `j` obtains the estimate/prerequisite state; `n`/Esc dismisses it. A missing judge role should produce an explicit configuration error.

A paid run requires a configured `judge` model role, provider credentials and explicit spend authorization. Only under those conditions test estimate → `y` start → progress/results, and `x` cancellation. Running/progress/cancel should remain available if passive metrics fail to load; externally observed runs should dismiss obsolete estimates. This paid scenario has **not** been verified by the contributor.

Authenticated broker networking and physical clipboard contents also require their real external prerequisites and are not claimed verified by fixture tests. Recorded quota histories have mounted coverage; that is not a credentialed network smoke.

## 6. Automated verification and known limits

```sh
bun test
bun run build
```

Latest observed suite: **894 passed, 0 failed, 61 files**, 102,931 assertions. Production build, full default TypeScript and the dependency-patch check passed. Actual production controllers were mounted through `TUI`/`ProcessTerminal`: all twelve sparse routes at **150×38**, all routes resized at **100×38 and 40×38**, and a separate populated run across all twelve routes. Captured ANSI state was inspected as images under amethyst-theme ink; the image renderer does not reproduce Windows Terminal's fonts or translucent background.

Current mounted checks included project search/details, lazy request inspection and JSON expansion, analytics pane focus, and close. The final distribution also mounted through `/stats-tui` inside compiled omp 18.6.1: Overview → Requests, 150→100-column resize, a real isolated worker's empty/live state, and close back to the editor. Earlier recorded quota, nested-trace, minimap, quiet-day, missing-judge and missing-Bun coverage remains historical workflow evidence, not fresh visual acceptance. Prior packed-install coverage is in the [workflow roadmap](plans/2026-10-05-dashboard-parity.md); screenshot-driven evidence is in the [composition plan](plans/2026-10-06-ui-polish.md).

Whole-repository TypeScript checking **passes** (`tsc --noEmit`, exit 0). The maintainer baseline's typing corrections were preserved, including the layout-test `DataNeed` import. The review machine's incomplete `@types/bun` installation needed a forced locked reinstall from an isolated cache; the subsequent default typecheck passed. The old 19-diagnostic list is historical, not the current UI branch's status.

CI (`.github/workflows/ci.yml`) runs locked installation, `bun run verify:patch`, tests and TypeScript, plus a separate compiled-host extension-load job. `verify:patch` remains required after installation: a passing build is not proof that the dependency's unknown-spend correction is installed.

## Troubleshooting and reporting

- **Command missing:** confirm `omp plugin` lists this checkout, both bundles exist, and restart omp. Use the explicit `-e` loading check above and inspect stderr or `~/.omp/logs/`.
- **Worker cannot start:** verify `command -v bun` in the environment that launches omp; standalone Bun is required. Preserve the displayed worker error rather than treating it as empty usage.
- **Rows absent:** wait for initial ingest, check range, and distinguish a new/empty profile from read/sync errors. Use `s` for manual sync.
- **Quota absent:** check local usage separately. No credentials/readings is not evidence of no provider usage.
- **Squares/tofu:** try the host's Unicode or ASCII symbol preset instead of Nerd; a Nerd Font is not required for chart marks.
- **Changed code not appearing:** rebuild and restart; changing the checkout alone cannot reload the running extension.

**Bun patch-cache recovery:** if installation reports `failed applying patch file: ENOENT`, first check that the tracked `patches/` file exists. A cache/path failure was observed on the review machine. Retry with a new cache directory, without deleting your global cache or editing the dependency patch:

```sh
bun install --frozen-lockfile --cache-dir "$(mktemp -d)"
bun run build
```

If that also fails, report the full installer error and Bun version; do not bypass the patch or describe the incomplete installation as working.

If an existing local `@types/bun` package contains metadata but lacks its declared typing entry, a normal locked install can report no changes. On the review machine, `bun install --force --frozen-lockfile --cache-dir "$(mktemp -d)"` restored the package; `bun run verify:patch`, build and the default TypeScript check then passed. This repairs the local installation without bypassing the dependency patch or deleting the global cache.

Report on [dashboard composition PR #3](https://github.com/yuzu-octopus/omp-stats-tui/pull/3): commit, omp/Bun versions, OS/architecture, terminal size and symbol preset/theme, route/range, exact key sequence, expected versus observed result, and whether the data-dependent prerequisite was present. Redact credentials, personal paths, account identifiers, request text and raw JSON before attaching screenshots/logs.
