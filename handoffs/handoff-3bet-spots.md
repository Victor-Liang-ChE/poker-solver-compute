# Handoff: more stored-flop spots (3-bet pots) for the postflop solver library

Repo: Victor-Liang-ChE/shadcn-testing. Start from branch `claude/project-thread-xuy5vm` (head 1c75834fe or later).
Compute repo: Victor-Liang-ChE/poker-solver-compute (public; free runners; R2 secrets already set).
Read `AGENTS.md` first. Reviewer: the postflop solver thread ("Postflop GTO solver roadmap").

## Goal
Grow the stored flop library with four more 3-bet pot spots, solved on free compute and uploaded to R2, then
switched on in the site. Spot ids: `co-bb-3bet`, `hj-bb-3bet`, `utg-bb-3bet`, `hj-co-3bet`.

## Steps
1. Code (site repo): add the four spots to `src/lib/poker-postflop/presets.ts`, modelled on the existing
   `btn-bb-3bet`, `btn-sb-3bet`, `co-btn-3bet`, `sb-bb-3bet` entries (ranges come from the 6-max preflop solver
   solution the same way). APPEND ONLY: stored records keep the spot's index, so never reorder or insert.
   Add a test like the existing preset tests that each new spot builds a tree and has non-empty ranges.
2. Bundle the solver for the compute repo the same way the existing `solve-flops.mjs` was made (esbuild bundle of
   `scripts/poker/postflop-library/solve-flops.ts`, see its header and the compute repo README); commit it there.
3. Solve: `.github/workflows/solve.yml` in poker-solver-compute (20 runners, one spot per run, ~20-40 min for a 3-bet
   spot), then `r2-upload.yml` for that spot. Upload from runners, not the Mac (memory rule: never per-file process
   spawning on the Mac). Verify 1,755 objects under `v2/<spot>/` before switching a spot on. Victor's 4070 and 2060
   PCs may also be used (no asking needed), but never the 4070 while Deadlock runs (about 8:30-11:30 PM Pacific),
   and keep a real free-RAM floor on it (it crashed 2026-11-17 at ~7 GB free).
4. Switch on: add each fully uploaded spot to `LIBRARY_SPOTS` in
   `src/app/misc/poker/postflop-solver/stored-client.ts`.
5. Flop reports: rebuild with `pnpm flop-reports:build -- --spot <id> --source <library base>` on the Mac
   (cloud containers cannot reach r2.dev), commit the JSONs.
6. Commit with `git commit --only -m "..." -- <paths>`, never `--no-verify`, Node heap >= 4096, no model ids in
   commits. One PR to master with all of it; report the R2 object counts per spot and a stored-flop example
   (screenshot of the postflop page loading one of the new spots instantly, MacBook + phone in one image).

## Then, if time remains
The approved 75% flop bet-size pass (adds one flop size; costs about 1.5x time and storage per spot). Measure the
size before uploading and keep R2 under 8 GB total (free tier is 10 GB; Victor pays nothing).
