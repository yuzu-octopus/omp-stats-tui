# omp stats in the terminal

The vocabulary for reading one person's own agent usage: what was recorded, what each recorded thing
actually means, and what a terminal panel is allowed to claim about it. Every term here exists because a
looser word for it was already in use and the looser word was wrong.

## Language

### Packaging

**Extension**:
A module the host loads at startup and calls once, so that it can register commands, tools, hooks and
user interface into the running agent.
_Avoid_: Plugin, Add-on, Integration

**Plugin**:
A distribution container — an installable package that carries extensions and other resources to a user.
The plugin is how an extension travels; the extension is what runs once it has arrived.
_Not to be confused with_: extension. A plugin may carry several extensions, and carries none of them
running.

**Built-in command**:
A command the host provides itself, which the host resolves before any extension command of the same name.
An extension that claims a built-in's name appears in the command palette and is never run.
_Not to be confused with_: extension command.

### What was recorded

**Request**:
One API call to a provider — the atom from which every token, cost and latency figure is counted. A request
may succeed, fail, or carry tokens with no recorded price, and each of those is still one request.
_Avoid_: Message, Query, Completion. "Message" means a chat item elsewhere in this system (see User message),
and a row of this kind is not one.

**User message**:
Something the person actually typed, recorded apart from anything the agent said. It carries no model, no
tokens and no cost of its own.
_Not to be confused with_: Request. One user message is answered by many requests.

**Turn**:
One typed prompt together with everything the agent did in answer to it — many requests and many tool calls.
The unit a person recognises as "one thing I asked for".
_Not to be confused with_: assistant turn.

**Assistant turn**:
The batch of tool calls a single assistant response emitted. The whole batch shares one request's usage, so
per-tool token and cost figures are shares of that request, not measurements of each call.
_Avoid_: Turn

**Tool call**:
One invocation of one tool, recorded against the assistant turn that asked for it.

**Session**:
One session file — a conversation's persisted history, and the unit that ingestion reads and reconciles. Every
request, user message and tool call belongs to exactly one session, even when a subagent produced it.

**Agent type**:
Which agent produced a request: the main agent, a task subagent, or an advisor. Nested agents can have their
own child session files; agent type and the trace's parent/child relationships preserve that identity.

**Ingest**:
The write path that reads session files and records their requests, tool calls and user messages, then
refreshes the rollups. Everything readable downstream of it is exactly as fresh as ingest left it.

### Facts and rollups

**Fact table**:
Per-event rows — one row per request, one per tool call, one per typed prompt. Exact and complete, and
expensive to aggregate over a long window.

**Rollup table**:
Hourly buckets holding pre-summed, additive figures over the same events. Reading a window from rollups
instead of facts is orders of magnitude cheaper, and is the reason a rollup exists at all. Rollups are
marked dirty by trigger whenever a fact changes and are rebuilt afterwards, so a rollup table can lag behind
the facts it summarizes.
_Not to be confused with_: fact table. The two are not interchangeable: a rollup row cannot be asked a
question a fact row can, and its absence means "not yet built" rather than "did not happen".

**Dirty hour**:
An hour whose rollup rows are stale or not yet built. While few are dirty, a reader can union them with the
facts and stay exact; past a threshold it stops and reports stale rows with holes in them.
_Avoid_: Staleness, stale data. There is a specific count of hours that are behind, and it is knowable.

**Range**:
The window a view reads, drawn from a fixed set — `1h`, `24h`, `7d`, `30d`, `90d`, `all`. A range fixes both
where the window starts and the width of the buckets its answer is grouped into.

**Bucket**:
The slice of time one column or one row of a series stands for. Bucket width decides which table an answer is
read from: an hourly or wider bucket is answered from rollups, and anything narrower falls back to facts.
_Avoid_: Granularity, interval.

### Money

**Fresh tokens**:
Input tokens billed at the full input price because the cache did not supply them.

**Cache-read tokens**:
Input tokens the cache supplied from an earlier identical prompt, billed at the cache-read price.

**Cache-write tokens**:
Input tokens written into the cache, billed at the cache-write price. They are neither fresh tokens nor a
cache hit, and they are outside the denominator of the cache rate.
_Not to be confused with_: cache-read tokens. A write is an investment in future reads, not a read.

**Cache rate**:
Cache-read tokens as a share of fresh plus cache-read input tokens. It is not "how much of the input was
cached": cache writes never enter the denominator, so the rate can read low while the cache is doing most of
the work.
_Not to be confused with_: cache savings.

**Cache savings**:
The money saved by caching rather than billing the same tokens uncached — a ratio, not a token count, and
negative when cache writes cost more than cache reads save.

**Cost**:
The money recorded against priced requests. Unknown-price requests make a containing total a floor rather
than complete spend, so cost is displayed together with its unpriced count.

**Unpriced request**:
A request whose provider/model price card is absent and whose spend cannot be determined. Unknown spend
reads `N/A`, not `$0.00`. A recorded zero charge or explicit all-zero/free price card is not unknown.
The locked upstream patch (ADR 0008) uses pricing-v2 replay and rollup-v3 invalidation to repair
historic markers; the panel does not infer or approximate missing prices with its own SQL, and the
patch is applied by Bun at install time rather than computed at runtime.
_Not to be confused with_: free request. A measured zero and an unmeasured cost are different facts.

### The two surfaces

**Stats panel**:
A full-screen interactive view of the person's own usage, drawn inside the terminal from upstream stats
records. Twelve retained controllers provide focus, search, sorting, selection, details and route actions.
Its isolated live worker initializes/ingests shared records; it is not a read-only SQLite connection.
_Not to be confused with_: stats dashboard.

**Stats dashboard**:
A multi-screen browser view over the same records, reached through a separate command that starts a local
server. It is a different application, not a source for the panel.

**Overlay**:
A component composited over the mutable viewport, sharing the terminal with the conversation underneath it.

**Fullscreen overlay**:
An overlay that borrows the terminal's alternate screen buffer, so it claims the whole screen and leaves the
conversation untouched beneath it.

**Seam**:
A place where behaviour can be altered without editing the thing that holds it. The data seam reuses upstream
queries inside an isolated process; the feature seam owns route state/actions; the view seam converts data
to terminal lines; the mount seam borrows the alternate screen and restores the underlying transcript.

**Feature controller**:
The production route contract: `load(range)`, `render(width, height)`, `handleInput(data)` and `dispose()`
(`src/tui/features/types.ts`). Returning true consumes a key; returning false leaves it to the parent.
Controllers retain focus, search, sort, selection and chart controls across screen changes. The panel
owns global navigation, scrolling and mount lifetime, and updates the mutable injected theme per render.

**Production presentation**:
`src/tui/features/presentation.ts` bridges retained controllers to shared band metric grids and
measured tables, adding current-theme selection, compact focus tabs and section headings.
`src/tui/charts/time-series.ts` renders production native-bucket plots for core analytics, Providers
and Gain with formatted units, real null gaps, stable series identity and selected-point legends.
It does not fabricate observations or replace domain-specific calendars, version-rate plots or traces.
**Stats read client**:
One persistent isolated child per mounted panel, with request/reply and unsolicited live NDJSON over pipes
(`src/data/client.ts`, `scripts/data-worker.ts`). The worker owns DB initialization, queries/transcript reads
and patched upstream `StatsLive({ workers: 1 })`: initial ingest, transcript watching and manual sync share
one live owner. Synchronous work is off the host rendering thread, not merely scheduled through a promise.

**Passive frustration**:
Cached judge/regex metrics and coverage. Reading or filtering them spends nothing. Paid judging is a
separate estimate → explicit `y` confirmation → progress/results/cancel workflow, requiring a configured
`judge` model role, provider credentials and user authorization. Judge resources open lazily
only when requested; missing credentials do not make the passive view or its implemented controls absent.

**Provider windows**:
Subscription-window capacity/demand and per-account quota/utilization histories, loaded independently of
local provider request/token/cost data. A missing broker credential, failed network read or absent snapshot
does not imply no local usage.

**Trace**:
A root/child session hierarchy with duration-preserving spans, markers and linked transcript entries.
The terminal supports time/turn/call axes, idle compression, zoom/pan/fit/focus, minimap, track visibility,
span search/details, tool durations/errors and child navigation. Upstream root discovery considers at most
300 candidates; a searchable loaded list is not exhaustive session history.

### The drawing grammar

**Band**:
The unit of vertical layout a controller composes from — a measured `statRow` of tiles or a
`table` (`src/tui/band.ts`). Bands are stacked with exactly one blank line between consecutive
bands, and no band body may emit a full-width rule (`src/tui/band.ts` G4–G5).
_Not to be confused with_: a web card. A card carries its own border and header; a band carries
neither and gets both from the grammar.

**Screen**:
One dashboard screen's identity — `id`, `label`, `short` (`src/tui/screens/types.ts`). The
registry is nav data: `SELECTABLE_SCREENS`, the tab strip and the sidebar read it, and `/stats-tui`
renders a `FeatureController` body for the active id. A screen declares no layout and no fetch
contract; the controller owns both.
_Not to be confused with_: `FeatureController`. The registry names a screen; the controller
renders it.

**Which test exercises production.** `__testing.makePanel` builds a stub `PanelReads` from the
passed `data` (or the caller's `reads`), so `#feature()` always resolves a real controller and
`#bodyLines` renders `feature.render(...)`. Panel body tests built on `makePanel` therefore
exercise the production controller path.

**Symbol preset**:
The person's choice of glyph repertoire — `unicode`, `nerd`, or `ascii`. It is a setting and never a
detection: nothing probes the terminal to guess which repertoire is safe.
_Not to be confused with_: capability detection. Colour depth and cell size can be detected; whether a
glyph exists cannot.

**Data ink**:
The glyphs that carry a magnitude — bar fills, ramp steps, heat cells — as distinct from the chrome drawn
around them. Data ink must read correctly under every symbol preset; chrome only has to match the panel.


**Frame band**:
The width class a total terminal width falls into — `wide`, `medium`, `narrow`, `tiny`
(`src/tui/responsive.ts`). Each band fixes what chrome the frame may spend: a full sidebar, an icon
rail, or none; and a full, condensed or minimal topbar. The band is derived from the breakpoint table
(`BREAKPOINTS` in `src/tui/layout.ts`) rather than restated beside it, so a retuned threshold flows
through. Do not confuse it with a band in the drawing grammar, which is vertical space rather than width.

**Frame policy**:
One width's answer: its frame band, sidebar and topbar modes, column count and whether a hint row fits
(`framePolicy` in `src/tui/responsive.ts`). It states no geometry — `planLayout` owns that — and it must
always agree with `planLayout` at the same width.

**Loading state**:
The panel's statement that a figure has not arrived yet. It is distinct from a fetched-empty result and
from a failed read. None may be silently rendered as a measured zero; dirty rollups and pending transcript
ingest also have explicit freshness states.

Activity reads the latest 371 local days independently of the global stats range. Narrow calendars show
fewer weeks, while the recorded-day list keeps every fetched day reachable through focus, search, sorting,
selection, reveal and details. A day with no requests is different from missing data or an empty lookback;
the controller states an empty lookback explicitly rather than hiding that boundary.
