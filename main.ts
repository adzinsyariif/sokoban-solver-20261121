// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// Why it wins: the checker pays 1,000 points only for a solution in the level's push-optimal count P*
// (one push more already pays under 500), and P* is by construction the sum of the optima of the
// level's rooms: the generator lays one hallway across the board with 1-4 independent rooms off it,
// no box can ever leave its room, and the player only walks between rooms. So this solver cuts the
// level into its rooms exactly the way the generator's own reference does (the dead squares of the
// player's row are the hallway) and solves every room push-optimally on its own, then walks the
// player from room to room. A whole-level search would meet the product of the rooms' positions;
// the room searches meet only their own.
//
// Each room is solved by A* over pushes (never over steps): a state is the room's box squares plus
// the player's reachable region, named by its lowest square. The estimate is a minimum-cost
// matching of boxes to goals over true push distances (a box's distance to a goal is the fewest
// pushes that bring it there ignoring the other boxes, computed once per goal by a reverse search),
// which never overestimates, so the first solution A* settles is push-optimal. Two deadlock prunes,
// both sound (they never cut a solvable state): a push that lands a box on a dead square (one from
// which no push sequence brings a box to any goal) is dropped, and so is a push that freezes a
// 2 x 2 block of walls and boxes with a box off its goal.
//
// Everything is budgeted by work, never by the clock: searches stop after a fixed count of stored
// states, ties in the open list break by insertion order, and no answer depends on the time, the
// environment or anything else that could differ between the two graded executions.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, the walk letter, the push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Stored-state budget of one room search: work, never the clock. The generator keeps only rooms
 *  its own breadth-first search solves within 250,000 states, so this is generous headroom. */
const ROOM_STATES = 1_000_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: width and height, walls, goals, boxes and the player. Short rows and the
 *  outermost frame count as walls, as in the generator's own parser. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal, pulled back from the goals over
 *  open floor. A box on any other square is dead: it can never reach a goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Marks the player's reachable region from `from` with `occupied` in the way into `seen` (stamp
 *  `stamp`) and returns the region's lowest square, the region's name in a state's key. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off
 *  its goal in it: such a box can never move again. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** For every goal, every square's push distance to it: the fewest pushes that bring a box from that
 *  square onto the goal, ignoring the other boxes (walls alone in the way), by a reverse search from
 *  the goal. INF where a box can never get there. */
function pushDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const size = wall.length;
  const INF = 1 << 28;
  return goals.map((g) => {
    const dist = new Int32Array(size).fill(INF);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (!wall[y] && !wall[y - d] && dist[y] === INF) {
          dist[y] = dist[x]! + 1;
          queue.push(y);
        }
      }
    }
    return dist;
  });
}

/** The A* estimate of a box set: the cheapest matching of boxes to distinct goals over the push
 *  distances (an exact assignment for the few boxes of a room, by permutations; the sum of each
 *  box's own nearest goal beyond that, still a lower bound). Never overestimates the pushes a
 *  solution still needs: every push moves one box one square, so the pushes spent on a box are at
 *  least its distance to the goal it finally occupies. INF when some box reaches no goal. */
function estimate(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  const INF = 1 << 28;
  if (n === 0) return 0;
  if (n > 6) {
    let sum = 0;
    for (const b of boxes) {
      let best = INF;
      for (const dist of dists) if (dist[b]! < best) best = dist[b]!;
      if (best >= INF) return INF;
      sum += best;
    }
    return sum;
  }
  // Try every assignment of goals to boxes (boxes and goals are equal in number in a room).
  const used = new Uint8Array(dists.length);
  let best = INF;
  const walk = (bi: number, acc: number): void => {
    if (acc >= best) return;
    if (bi === n) {
      best = acc;
      return;
    }
    const b = boxes[bi]!;
    for (let gi = 0; gi < dists.length; gi++) {
      if (used[gi]) continue;
      const c = dists[gi]![b]!;
      if (c >= INF) continue;
      used[gi] = 1;
      walk(bi + 1, acc + c);
      used[gi] = 0;
    }
  };
  walk(0, 0);
  return best;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The push-optimal solution of one (sub)level by A* over pushes: {pushes, moves} with the moves in
 * LURD (a lower letter a step, an upper one a push), or null when the state budget runs out first.
 * A state is the boxes' squares and the player's region (its lowest square); a state's stored player
 * square is where the player stands in it, the square the last pushed box came from.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dists = pushDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // The states, in the order stored: boxes, the player's square, pushes so far, parent, and the
  // push that made the state (the box's square before the push, and its direction's index).
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  best.set(keyOf(level.boxes, startLow), 0);

  // The open list: a binary heap on (f, then more pushes first, then insertion order).
  const heap: number[] = [0];
  const hF: number[] = [estimate(level.boxes, dists)];
  const less = (a: number, b: number): boolean => {
    const fa = hF[a]! + sG[a]!;
    const fb = hF[b]! + sG[b]!;
    if (fa !== fb) return fa < fb;
    if (sG[a] !== sG[b]) return sG[a]! > sG[b]!;
    return a < b;
  };
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  while (heap.length > 0) {
    const s = heapPop();
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue; // a better path to this state was stored after this heap entry was made
    }
    if (solved(boxes)) {
      found = s;
      for (const b of boxes) occupied[b] = 0;
      break;
    }
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = di === 0 ? -w : di === 1 ? w : di === 2 ? -1 : 1;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let nLow = 0;
        let nH = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          nLow = reach(level, occupied, b, mark, ++stamp, stack);
          nH = estimate(next, dists);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || nH >= 1 << 28) continue;
        const key = keyOf(next!, nLow);
        const known = best.get(key);
        if (known !== undefined && known <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const t2 = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sG.push(g + 1);
        sParent.push(s);
        sFrom.push(b);
        sDir.push(di);
        hF.push(nH);
        heapPush(t2);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's stand square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = sFrom[s]!;
    const di = sDir[s]!;
    const d = di === 0 ? -w : di === 1 ? w : di === 2 ? -1 : 1;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di]![3];
    player = from;
    boxes = sBoxes[s]!;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms, as the generator's reference cuts them: the dead squares of the player's row
 * (the hallway: a box there reaches no goal) are cut out of the floor, and each part left that holds
 * a box is a room, its squares, boxes and goals. Null when the level is no set of rooms: some part
 * holding more or fewer boxes than goals, a goal in the hallway, or a box starting in the hallway.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** One room of a level as its own level: the room's boxes and goals on the whole board, the other
 *  rooms' boxes standing as walls (on their goals once their room is done), the player where the
 *  walk so far left it. */
function roomLevel(level: Level, rooms: { boxes: number[]; goals: number[] }[], index: number, done: boolean[], player: number): Level {
  const wall = level.wall.slice();
  for (let j = 0; j < rooms.length; j++) {
    if (j === index) continue;
    for (const b of done[j] ? rooms[j]!.goals : rooms[j]!.boxes) wall[b] = 1;
  }
  return {
    w: level.w,
    h: level.h,
    wall,
    goals: rooms[index]!.goals.slice().sort((a, b) => a - b),
    boxes: rooms[index]!.boxes.slice().sort((a, b) => a - b),
    player,
  };
}

/** The moves that solve a level: each room push-optimally in turn, the player walking on from where
 *  the last room left it. A room the search gives up on is retried once with a far larger state
 *  budget before the level falls back to one push-optimal search over the whole level; every budget
 *  is a count of states, never the clock, so the answers are the same on every run. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms === null || rooms.length === 0) {
    const whole = solvePushOptimal(level, ROOM_STATES * 8);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  const done = rooms.map(() => false);
  for (let i = 0; i < rooms.length; i++) {
    const sub = roomLevel(level, rooms, i, done, player);
    const solvedRoom = solvePushOptimal(sub, ROOM_STATES) ?? solvePushOptimal(sub, ROOM_STATES * 8);
    if (solvedRoom === null) {
      const whole = solvePushOptimal(level, ROOM_STATES * 8);
      return whole === null ? '' : whole.moves;
    }
    moves += solvedRoom.moves;
    player = endOf(level.w, player, solvedRoom.moves);
    done[i] = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
