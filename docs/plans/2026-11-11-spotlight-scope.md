# Spotlight TUI scope (spike 008, 2026-11-11)

Measured on this machine (`bun -e` against the installed dep, deleted after):
`getSpotlightDashboardStats("24h"|"all", null)` → **1361 bytes, 0.16s**.
20 top-level keys: sessions(number), experimentStart, gross, clawback,
compounding, series[0], share[0], recent[0], sessionList[0], holdouts,
scoreFree, adjusted, ranking, steps[0], timeCost, coverage[0], fetchBack[0],
economics[0], gaps[0], overhead. This DB has no spotlight-ingestible
sessions, so arrays are empty here — a production DB will be larger, but
the shape is small arrays + summary objects, not a dump. Payload risk: LOW.

## Section verdicts (terminal-first, not ported)

| Section | Verdict | Why |
|---|---|---|
| Hero (headline figures) | FIT | Numbers + one sentence; a metricGrid band |
| Savings (unit toggle) | FIT | Table + mode switch (`m`-style); needs plan 011 Waterfall for the cumulative view, table stands alone first |
| Economics (per-tool cuts) | FIT | Table with folded "rest" rows (`+/a` reveal pattern already in repo) |
| FetchBack (waste groups) | ADAPT | Needs plan 011 DotWhisker; table fallback first (groups × rates), geometry later |
| Ranking (model ranks) | ADAPT | Same as FetchBack: table first, DotWhisker later |
| Compounding (session select) | ADAPT | `<select>` → ListState picker (repo pattern); per-session share bars reuse renderShareBar |
| Coverage | ADAPT | Depends on its geometry (check at build: likely bars/table) |
| ShareTrend | ADAPT | Time series — renderTimeSeries carries it directly |
| Steps | ADAPT | Expandable tool lists — `expanded` state exists in analytics; geometry check at build |
| ResultsFeed (selected row detail) | BROWSER-ONLY for v1 | Row-select + detail drawer; our request-detail pattern covers the shape but the feed's density needs a second pass — explicitly deferred |
| TimeCost / Overhead / gaps | BROWSER-ONLY for v1 | Canvas/density-first visuals; revisit after FIT set lands |

FIT set (v1 scope): **Hero + Savings(table) + Economics**. No new
geometries required; all three are tables/metric bands the repo already draws.

## Build-plan sketch (for a future plan, not this spike)

1. Worker: add `spotlight` need — `fetchFor` gains `spotlight: range => apiGet("/api/stats/spotlight")`, DATA_NEEDS + PanelData extended, freshness attach unchanged. Payload is small; no paging.
2. Registry: `spotlight` screen (id, label, `g` letter — check chrome.ts for a free letter first).
3. Feature `createSpotlightFeature`: three bands (hero grid, savings table + unit mode, economics table + folded rest). Money honesty: every dollar figure carries its unpriced context per CONTEXT.md; spotlight economics are estimates — label them API-equivalent like providers burn.
4. Tests: controller render assertions (figures present, folded rest expands, unit toggle switches) + width sweep 40/150.

## Open questions

- Do production DBs keep the payload small (this machine: 1.3KB)? First build should log bytes at `all` range on a real DB; if >500KB, page `sessionList`.
- Does `experimentStart == null` (no shaping experiment) need an explicit empty state? The web presumably handles it — check `emptyDashboard` (aggregator:1094) at build.
- Savings cumulative view wants plan 011's Waterfall; table-only v1 must say "cumulative view follows" rather than faking it.
