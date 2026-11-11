# 007 spike outcomes (2026-11-11, executed by orchestrator — spawn path was down, spikes run inline)

## D1 mutation signal: RUN — 13/13 DIED

`bun run scripts/mutate.ts --allow-dirty`, 3.14s wall. All 13 mutations
caught (G4/G5 grammar, statRow/table, format percent/cost/unpriced,
bars zero/fill/empty, CONTROL). Verdict counts show `? fail` (harness
regex quirk vs current `bun test` output format) but DIED/SURVIVED
classification is exit-code based and valid.

**Decision: gate-worthy.** 3s for the full harness means cost is no
objection. Recommend adding the harness to CI as a blocking job once the
`? fail` counter regex is fixed to parse current output (cosmetic, one
line). Until then it runs as a signal: `bun run test:mutation`.

## D2 probe entrypoint: documented command wins, no wrapper

Probe invocations during this wave's verification: `probe-render all
--width 40/60/100/150 --preset unicode/ascii` covers the TESTING matrix
(one command, plan 006 added `--rows`). Remaining probes
(data/glyphs/band-heights/frame/mouse-truth) are single-purpose and each
used ≤1× per cycle. A wrapper would add code to save zero commands.

**Decision: adopt the documented matrix command, no wrapper.** The gap
that mattered (40x30 unproducible) is closed by `--rows`. Revisit if a
seventh probe appears.

## D3 paid/broker verification runbook: drafted

See `docs/PAID-SMOKE-RUNBOOK.md` (human-run protocol, never CI).
Status: draft, needs maintainer approval before any execution —
scheduling a run is a separate decision, not this plan.
