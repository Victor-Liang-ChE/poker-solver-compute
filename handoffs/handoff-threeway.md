# Handoff: three-way postflop engine (speed + turn/river three-way on the postflop page)

Repo: Victor-Liang-ChE/shadcn-testing. Branch: `claude/project-thread-xuy5vm` (pushed, head 1c75834fe). Work on that
branch or a branch cut from it; open ONE PR to master when done. Owner thread for review: the postflop solver thread
("Postflop GTO solver roadmap"). Read `AGENTS.md`, `agents/UI_RULES.md` (incl. "Poker pages"), `agents/SPACING.md`,
`agents/STATE_PATTERNS.md`, and for charts `agents/CHART_PATTERNS.md`, completely, before UI work.

## Already on the branch (not yet in a PR)
- `src/lib/poker-postflop/three-way/reference.ts`: three-player turn+river CFR in f64, explicit per-card tree
  (`buildRiverTree`), `ThreeWayRiverSolver` with alternating discounted CFR (alpha 1.5, beta 0, gamma 2) as default,
  `measure()` gives per-seat EV, best-response gain and NashConv. Equal stacks only (no side pots).
- `src/lib/poker-postflop/three-way/showdown.ts`: exact O(52n) inclusion-exclusion showdown (`terminalValuesFast`,
  `only` seat param for alternating passes).
- Tests: `src/lib/__tests__/poker-postflop-three-way.test.ts` (fast vs plain triple sum at 1e-9 for all 7 fold
  patterns and each `only` seat; river convergence to <0.3% pot NashConv in 1000 iters; turn check-down pays exact
  equity over all 48 rivers). Keep all of these passing; never loosen tolerances.
- Also on the branch for the same PR: hj-bb and sb-bb-3bet in `LIBRARY_SPOTS`
  (`src/app/misc/poker/postflop-solver/stored-client.ts`), the refined 1M-trial `public/data/poker/three-way-equity.bin`
  + `scripts/poker/pack-three-way-equity.ts`, tighter preflop three-way test.

## Measured (2026-11-17, node, one thread)
- River, ~285 combos each, 1 bet + 1 raise + all-in, 63 decisions: 44 ms/iteration.
- Turn, same ranges, 14,175 decisions (48 rivers): 7.2 s/iteration. Far too slow; target well under 0.2 s/iter.
- CPU profile of the turn: `order()` in showdown.ts:154 (sorts hands by strength on EVERY terminal call) ~35%,
  `twoWaySums` 19%, `pairSum` 15%, `walk` 9%, `comboIndex` (also recomputed per call) ~3%, GC small.

## What is left
1. Speed, exact results only (output identity vs the reference at 1e-9 in f64; any f32/SIMD path must be shown to
   reach the same NashConv). In order of payoff:
   a. Cache `order()` and `comboIndex()` per river board (they depend only on board + hands). Easy ~1.5x.
   b. Template tree + preallocated per-depth Float64Array buffers; stop allocating in `walk` (`reach.map`,
      `Float64Array.from`, `childValues` arrays). Precompute per-river-card masks.
   c. Suit isomorphism for river cards on boards with suit symmetry (check with an exactness test).
   d. Skip subtrees where the non-updating seats' reach is all zero.
   e. WASM SIMD (AssemblyScript, see `assembly/postflop-cfr.ts` + `assembly/preflop-showdown.ts` for the existing
      build/manifest pattern) for the showdown sums and regret updates.
   Benchmark rules in AGENTS.md apply (cold and warm medians/p95, >=21 paired samples for final claims).
2. Run it in a Web Worker (follow STATE_PATTERNS: status union, run token, request ids) with progress and
   NashConv shown as "% of pot" like the HU page.
3. Page: add a three-way pot option to the postflop solver page's spot builder (`src/app/misc/poker/postflop-solver/`)
   for turn and river boards only (flop three-way is a later stored-library job; do not offer it live). Seats in
   postflop order, ranges from the preflop solver's three-way spots where available (`presets.ts`,
   `src/lib/poker-preflop/` three-way terminals), otherwise editable 13x13 grids. Results: per-seat strategy grid at
   the selected node, action frequencies, per-seat EV in bb. Poker theme, player notation, no dev readouts,
   no inert controls, one screen without vertical scroll at 1470x830, phone at 390x844, cards entered by tap only.
4. Verify in a real browser against a LOCAL `pnpm build && pnpm start` (never crawl the live site or previews; Vercel
   request budget), MacBook + phone sizes, hover/click everything, run
   `tests/browser/poker-layout-stability.regression.spec.ts`, `pnpm test:ui-rules`, `pnpm test:charts` if charts
   change, and the site typecheck (`npx tsrs --project tsconfig.site.json`, heap >= 4096).
5. Commit with `git commit --only ... -- <paths>`, never `--no-verify`, no screenshots in the repo, no model ids in
   commits/PRs. PR body ends with the Claude Code footer. Report back with MacBook + phone before/after screenshots
   in ONE combined labeled image and a concrete example (a real board, real frequencies, NashConv % of pot).

## Accuracy bar
GTO Wizard publishes ~0.24% pot for three-way turns and <0.1% for rivers. Meet or beat it, measured with
`measure().nashConv / pot` on the shipped default spots.
