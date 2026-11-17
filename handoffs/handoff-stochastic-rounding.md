# Handoff: 16-bit stochastic rounding for the postflop solver's compact mode

Repo Victor-Liang-ChE/shadcn-testing, branch from master (or claude/project-thread-xuy5vm if you need its unmerged work). Read AGENTS.md, agents/UI_RULES.md (Poker pages section), agents/SPACING.md, agents/STATE_PATTERNS.md completely first. Exact results only: no accuracy loss, never weaken a test tolerance; benchmark cold and warm (medians, p95, >=21 paired samples). UI checks against a LOCAL pnpm build && pnpm start only (never crawl the live site or previews), MacBook 1470x830 and phone 390x844, run pnpm test:ui-rules and tests/browser/poker-layout-stability.regression.spec.ts. Commit with git commit --only -- <paths>, never --no-verify, Node heap >= 4096, no model ids in commits. One PR per brief; report with ONE combined MacBook+phone screenshot and a concrete example. Reviewer: the postflop solver thread.

Finding (2026-11-16 study, /mnt/project-files/postflop-solver/multiway-research.md "Compression measurements"): the shipped
16-bit compact mode stalls at about 0.09-0.11% pot exploitability, while 16-bit with STOCHASTIC rounding matched f64
(0.036% vs 0.034%). Implement stochastic rounding for the 16-bit regret/strategy-sum storage in
assembly/postflop-cfr.ts (cheap per-lane xorshift RNG, deterministic seed so runs are reproducible), keep the f32 path
unchanged. Prove it with paired runs on the default spots and several random flops: exploitability vs iterations for
f64, f32, 16-bit nearest, 16-bit stochastic; speed per iteration must not regress noticeably. Ship only if it is a
Pareto improvement. Record results in docs/design (new short markdown).
