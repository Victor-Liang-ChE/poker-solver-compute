# Poker solver compute

Batch solver for the stored heads-up flop library of the postflop solver page. `solve-flops.mjs` is a
self-contained build of `scripts/poker/postflop-library/solve-flops.ts` from the site repo. Each run of the
`solve` workflow solves every strategically different flop of one spot on 20 runners and keeps one artifact
per part with the compressed flop records.

`run-league.mjs` is a build of `scripts/poker/arena/run-league.ts`; the `league` workflow runs the Bot Arena league on 20 runners against the hu-sb-bb library in R2.

`plo-solve.mjs` is a build of `scripts/poker/plo/solve-flops.ts`; the `plo-solve` workflow solves PLO 3-bet pot flops exactly (in the priority order of `todo/plo-<spot>.txt`, from `scripts/poker/plo/flop-order.ts`) and uploads the records to R2 under `plo-v1/`. `plo-rankings.json` is the starting-hand ranking the ranges come from.
