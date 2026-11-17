# Handoff: stop PLO flop solves from killing 16 GB GitHub runners

Repos: Victor-Liang-ChE/shadcn-testing (source, follow its AGENTS.md exactly) and Victor-Liang-ChE/poker-solver-compute
(public; holds the bundle `plo-solve.mjs` and `.github/workflows/plo-solve.yml`).

## What happened

Run 44023888524 (plo-solve, spot bb-btn-3bet): parts 7 and 9 died with "The runner has received a shutdown signal",
which is what a hosted runner does when it runs out of memory. Part 9 had just finished 2c2dJc (99 iterations, 2.7 h,
rss 15.46 GB on a 16 GB runner) and started 5cTdJh (10.33 GB of storage) about 90 s before it died. Because the runner
died, the `upload-artifact` step never ran, so every flop those two parts finished (hours of work) was lost.

Likely cause: in `scripts/poker/plo/solve-flops.ts` (`main()`), the previous flop's `PloSplitSolver` / game storage
(main thread, many GB of typed arrays) is still unreclaimed when the next flop's storage is allocated, so peak RSS is
roughly old + new. Confirm by logging rss right before and after building the next `PloSplitSolver`.

## Fix

1. In solve-flops.ts, after a flop's record is written and its shards closed, drop every reference to that flop's
   solver/game and force a collection before building the next one (run node with `--expose-gc` and call
   `globalThis.gc?.()`; check rss falls back). Do not change solver math or record bytes.
2. Add `--max-gb <n>`: skip a flop whose `estimateMemory(game, true)` exceeds n, logging "<flop>: too big for this
   machine, left for a bigger one". In plo-solve.yml pass `--max-gb 11` (16 GB runner) and `--expose-gc`.
3. In plo-solve.yml, give the `upload-artifact` step `if: always()` so a solver that fails (but whose runner survives)
   still keeps its finished flops.
4. Rebundle: in shadcn-testing run
   `npx esbuild scripts/poker/plo/solve-flops.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=<compute>/plo-solve.mjs`
   (rebuild the wasm first with `pnpm plo-solver:wasm:build` if assembly/ changed). Check one small flop gives a
   byte-identical .plo record to the current bundle, and that two big flops in a row stay under the old peak.
5. Commit the source change to shadcn-testing through a PR (do not merge), and the bundle + workflow to
   poker-solver-compute main. Do NOT cancel or re-run plo-solve runs that are in progress; the next scheduled round
   picks up the new bundle. Never print or log the R2 secrets.
