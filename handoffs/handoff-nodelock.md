# Handoff: nodelocking in the postflop solver

Repo Victor-Liang-ChE/shadcn-testing, branch from master (or claude/project-thread-xuy5vm if you need its unmerged work). Read AGENTS.md, agents/UI_RULES.md (Poker pages section), agents/SPACING.md, agents/STATE_PATTERNS.md completely first. Exact results only: no accuracy loss, never weaken a test tolerance; benchmark cold and warm (medians, p95, >=21 paired samples). UI checks against a LOCAL pnpm build && pnpm start only (never crawl the live site or previews), MacBook 1470x830 and phone 390x844, run pnpm test:ui-rules and tests/browser/poker-layout-stability.regression.spec.ts. Commit with git commit --only -- <paths>, never --no-verify, Node heap >= 4096, no model ids in commits. One PR per brief; report with ONE combined MacBook+phone screenshot and a concrete example. Reviewer: the postflop solver thread.

Goal: on /misc/poker/postflop-solver, let the user lock a strategy at any decision node (per hand class, or a whole-range
frequency like "bet 70%") and re-solve the rest of the tree against it, then compare EVs before/after.
Engine: src/lib/poker-postflop/reference-solver.ts (f64 oracle) and assembly/postflop-cfr.ts + wasm-solver.ts (SIMD).
A locked node keeps its strategy fixed (no regret updates, its average = the lock); everything else solves normally.
Frequency locks: scale each hand's action probabilities so the range-wide frequency hits the target while staying as
close as possible to the solved strategy (document the rule behind an info hover). Tests: a lock equal to the solved
strategy changes nothing (1e-9 in the reference); a known exploit (e.g. lock river OOP to never bluff) makes IP
fold bluff-catchers; WASM matches reference. UI: a lock toggle on the strategy grid of the selected node, a small
locked badge on locked nodes in the action path, an EV-change readout in bb; works with stored flops (lock re-solves
live from that node down).
