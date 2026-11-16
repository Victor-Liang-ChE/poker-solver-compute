# Poker solver compute

Batch solver for the stored heads-up flop library of the postflop solver page. `solve-flops.mjs` is a
self-contained build of `scripts/poker/postflop-library/solve-flops.ts` from the site repo. Each run of the
`solve` workflow solves every strategically different flop of one spot on 20 runners and keeps one artifact
per part with the compressed flop records.
