# Handoff: faster 9-handed three-way preflop solves

Repo Victor-Liang-ChE/shadcn-testing, branch from master (or claude/project-thread-xuy5vm if you need its unmerged work). Read AGENTS.md, agents/UI_RULES.md (Poker pages section), agents/SPACING.md, agents/STATE_PATTERNS.md completely first. Exact results only: no accuracy loss, never weaken a test tolerance; benchmark cold and warm (medians, p95, >=21 paired samples). UI checks against a LOCAL pnpm build && pnpm start only (never crawl the live site or previews), MacBook 1470x830 and phone 390x844, run pnpm test:ui-rules and tests/browser/poker-layout-stability.regression.spec.ts. Commit with git commit --only -- <paths>, never --no-verify, Node heap >= 4096, no model ids in commits. One PR per brief; report with ONE combined MacBook+phone screenshot and a concrete example. Reviewer: the postflop solver thread.

Now: /misc/preflop-solver with Calls = Three-way takes about 35-39 s at 6-max but about 5.5 min at 9-max.
Code: src/lib/poker-preflop/three-way.ts (ThreeWayEngine, padded tensors P=172), assembly/preflop-showdown.ts
(contract3 SIMD), src/lib/poker-preflop/solver.ts (threeWayValues, tripleMass), tree.ts (overcalls/squeezes).
Ideas to measure: profile first; cache tensors per realization/curve; contract only seats/pots with nonzero reach;
group three-way terminals that share player triple and contributions; multi-worker split of terminals; f32 SIMD
for the joint layout if NashConv is unchanged. Target 9-max under 60 s with identical solutions to 1e-6 and the
existing tests in src/lib/poker-preflop/__tests__/preflop-three-way.test.ts green.
