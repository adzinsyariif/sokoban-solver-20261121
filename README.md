# Sokoban solver — push-optimal, room by room

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/adzinsyariif/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/adzinsyariif/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver for the make.fun bounty **sokoban-solver-01-run-20261121**
("Build the best Sokoban solver, 21 November 2026"). `main.ts` (Node 22,
standard library only) reads every instance of a set from `/input/<id>/level.txt`
and writes its moves to `/output/<id>/solution.txt`, in one run.

## Why it is push-optimal

The checker pays the full 1,000 points for an instance only when the solution
uses the level's push-optimal count P\* — a single push more already pays
under 500. And P\* has structure: every level the generator draws is one
hallway across the board with one to four independent rooms off it. No box
can ever leave its room (a box pushed through a door into the hallway can
never be pushed back), so a level's optimum is exactly the sum of its rooms'
optima, and the rooms are independent problems joined only by the player's
walk.

The solver exploits that directly:

1. **Room decomposition.** The dead squares of the player's row — the
   hallway, where a box reaches no goal — are cut out of the floor; each
   remaining component that holds boxes is a room.
2. **A\* over pushes per room.** A state is the room's box squares plus the
   player's reachable region (named by its lowest square). The estimate is a
   minimum-cost matching of boxes to goals over true push distances (per
   goal, a reverse search gives the fewest pushes that bring a box from any
   square to it, ignoring the other boxes). The estimate never overestimates,
   so the first solution A\* settles is push-optimal.
3. **Sound deadlock pruning.** Pushes that land a box on a dead square, and
   pushes that freeze a 2×2 block of walls and boxes with a box off its
   goal, are dropped; neither can cut a solvable state.
4. **Deterministic by construction.** Budgets are counts of stored states,
   never the clock; ties break by insertion order. Two runs of the program
   write byte-identical answers. A room that ever resisted the first budget
   is retried with a far larger one before the level falls back to a single
   whole-level search.

## Results on the kit's practice set

Scored with the kit's own scorer (`program/scorer/score.ts`):

| entry | score | per instance |
| --- | --- | --- |
| this solver | **1,000,000** | every instance solved in exactly P\* pushes (13, 16, 29, 47, 60) |
| house baseline plain-astar 1.0.0 | 200,000 | solves only the first instance; gives up on the other four |

The whole practice set solves in about a quarter of a second, against the
60-second budget for a set. On six further sets drawn with the kit generator
from arbitrary seeds (30 more instances from the same distribution as the
scored set), the solver again scored 1,000,000 on every set — every instance
in exactly P\* pushes.

## Verify locally

With the unpacked competition kit at hand:

```
node tools/verify.mjs <kit-dir> [extra-sets]
```

It runs the solver twice on the practice set and diffs the outputs, scores
it and the baseline with the kit scorer, then draws fresh sets with the kit
generator and scores those too.

## Layout

- `main.ts` — the solver (the entry).
- `tools/verify.mjs` — the local verification above.
- `LICENSE` — MIT.
