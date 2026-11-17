# Plan 015: Unicode fractional top row for bar charts

> **Executor instructions**: Follow this plan step by step. Run every verification command. STOP if current state differs from the excerpts. Do not commit; the orchestrator commits after verification.

## Status

- Priority P2 · Effort M · Risk MED · Depends on plan 014 (chart files must have landed first) · Category direction
- Planned at commit `49b2624`, 2026-11-17

## Why this matters

`renderDailyBars` quantizes every column to whole rows. At the 1–4 row budgets bands actually receive, a value a fiftieth of the scale is either rounded up to a full row (over-read) or, if guarded, under-read. The repo already owns a width-one Unicode density ramp (`▁…█`) and deliberately excludes it only because stacking it on every row creates a staircase top. Using a partial block **only on the top magnitude row** keeps one shared baseline, keeps contiguous columns, and carries the remainder without spending vertical space. ASCII must remain byte-identical: its ramp is a ranking, not density. Nerd must stay byte-identical to Unicode.

## Current state

- `src/tui/charts/bars.ts:118-122` documents the exclusion of the ramp; `:138-162` `heights()` rounds each value to an integer row count with a one-row floor; `:210-235` `compose()` paints full `barFill` rows then a floor `axisLine` row.
- `src/tui/glyphs.ts:84` — `sparkRamp: ["▁","▂","▃","▄","▅","▆","▇","█"]`; every candidate is width 1.
- `src/tui/charts/host-adapter.ts:340` is the only production `renderDailyBars` call; it receives `preset` in `opts`.
- Invariants to preserve: no gaps under a bar (`test/chart-ink.test.ts`), no full-width rule (`test/band.test.ts` G5), one foreground per cell, floor row always present including height 1.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Target tests | `bun test test/bars.test.ts test/chart-ink.test.ts test/chart-primitives.test.ts test/glyphs.test.ts` | all pass |
| Width sweep | `bun scripts/probe-render.ts all --width 40 --width 60 --width 100 --width 150 --preset unicode --preset ascii --preset nerd 2>&1 \| grep -c OVERWIDE` | `0` |
| Full suite | `bun test` | all pass |
| Typecheck | `bun run check` | exit 0 |

## Scope

In scope: `src/tui/charts/bars.ts`, `src/tui/charts/host-adapter.ts`, `test/bars.test.ts`, `test/chart-ink.test.ts`.
Out of scope: `src/tui/glyphs.ts` (no new glyph role or preset), `src/tui/palette.ts`, feature controllers, `src/tui/charts/time-series.ts`, package files.

## Steps

1. Add failing tests in `test/bars.test.ts`:
   - with `densityTop: true`, preset unicode, height 3 and a value at 35–45% of shared max, the topmost magnitude cell is a partial block from `sparkRamp` (not `barFill`) and all cells below it are `barFill`; the floor row is unchanged.
   - with `densityTop: true` and preset ascii, output is byte-identical to `densityTop: false` for the same values.
   - with height 1, the floor row is still the only row (no magnitude row appears).
2. Run target tests → the unicode case fails.
3. Add `densityTop?: boolean` to `BarsOptions`. Keep default false so every existing call is unchanged until step 5.
4. Change `heights()` or add a sibling helper so each nonzero column has `{ fullRows, remainder }` where `remainder ∈ [0,1)` is the fractional part of `value / max * rows`, preserving the existing one-row minimum: values below one row draw one partial block, never blank. In `compose()`, when `densityTop` and the Unicode/nerd ramp is in use, paint full rows with `barFill` and the topmost magnitude row with `glyph(preset, "sparkRamp", Math.max(0, Math.round(remainder * 7)))`; for ASCII keep the existing `barFill` behaviour. Detection must use the injected glyph set/preset, never a font probe.
5. Set `densityTop: true` on the production call in `host-adapter.ts` for non-ASCII presets only. Keep ASCII byte-identical and nerd identical to unicode.
6. Run target tests, width sweep, full suite and typecheck → all pass.

## Test plan

Three new tests in `test/bars.test.ts`; existing contiguity/width tests are the regression net. Verify preset equality by comparing rendered strings, not by reading source.

## Done criteria

- [ ] Partial glyph appears only on the top magnitude row, width 1 in every preset.
- [ ] ASCII output byte-identical to before; nerd equals unicode.
- [ ] OVERWIDE=0 across the four widths and three presets; full suite and typecheck pass.

## STOP conditions

If contiguity or baseline assertions cannot be satisfied without changing `test/chart-ink.test.ts` invariants, stop and report — those invariants are load-bearing. If the fractional computation changes ordering or ranking, stop.

## Maintenance notes

The floor row is chrome, not data ink. Any future stacked bar work must recompute remainders from the stacked total, not from one series.
