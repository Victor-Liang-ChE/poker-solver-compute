# Handoff: uneven stacks and side pots in the postflop solver

Repo Victor-Liang-ChE/shadcn-testing, branch from master (or claude/project-thread-xuy5vm if you need its unmerged work). Read AGENTS.md, agents/UI_RULES.md (Poker pages section), agents/SPACING.md, agents/STATE_PATTERNS.md completely first. Exact results only: no accuracy loss, never weaken a test tolerance; benchmark cold and warm (medians, p95, >=21 paired samples). UI checks against a LOCAL pnpm build && pnpm start only (never crawl the live site or previews), MacBook 1470x830 and phone 390x844, run pnpm test:ui-rules and tests/browser/poker-layout-stability.regression.spec.ts. Commit with git commit --only -- <paths>, never --no-verify, Node heap >= 4096, no model ids in commits. One PR per brief; report with ONE combined MacBook+phone screenshot and a concrete example. Reviewer: the postflop solver thread.

Goal: on /misc/poker/postflop-solver, each player gets their own stack (the spot builder already has blinds/stacks
controls; today both players share one effective stack). Heads-up, effective stack decides everything, so first make
the HU engine take per-player stacks and use the smaller as effective, showing the extra chips as untouchable.
Then in the three-way engine (src/lib/poker-postflop/three-way/, only once the three-way speed handoff has merged,
otherwise branch from claude/project-thread-xuy5vm): per-seat stacks, all-ins below others' stacks, and correct
main/side pot showdowns (a short all-in player can win only the main pot; side pot goes between the two others).
Exactness tests: brute-force triple sum over all hands for side-pot payoffs at 1e-9; a player all-in for less never
wins more than the main pot; chips conserved (zero-sum) in every terminal. Bunching (card removal from folded
seats) is a separate later item; do not mix it in.
