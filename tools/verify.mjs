// Local verification for the sokoban-solver entry, against the competition kit's own tools.
//
//   node tools/verify.mjs <kit-dir> [extra-sets]
//
// <kit-dir> is the unpacked sokoban-solver-01 kit (the directory holding practice/, program/ and
// baselines/). The script:
//   1. runs main.ts twice on the practice set and diffs the outputs (determinism),
//   2. scores those outputs with the kit scorer and prints the score and per-instance detail,
//   3. runs the house baseline plain-astar on the practice set and scores it the same way,
//   4. draws `extra-sets` fresh sets with the kit generator (arbitrary seeds: the subject generator
//      turns any seed into a set from the same distribution as the scored one), runs main.ts on
//      each, scores it, and reports the wall time of every solver run.
// A perfect entry scores 1,000,000 on every set: every instance solved in exactly P* pushes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = process.argv[2];
const extraSets = Number(process.argv[3] ?? 6);
if (!kit || !existsSync(join(kit, 'practice', 'reference', 'manifest.json'))) {
  console.error('usage: node tools/verify.mjs <kit-dir> [extra-sets]');
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'sokoban-verify-'));
let failures = 0;

function run(file, env, label) {
  const t0 = Date.now();
  execFileSync(process.execPath, [file], { env: { ...process.env, ...env }, stdio: 'pipe', timeout: 300_000 });
  const ms = Date.now() - t0;
  console.log(`  ${label}: ${ms} ms`);
  return ms;
}

function score(outDir, refDir, label) {
  const scoresDir = join(work, `scores-${label}`);
  execFileSync(process.execPath, [join(kit, 'program', 'scorer', 'score.ts')], {
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: outDir, MAKEFUN_REFERENCE_DIR: refDir, MAKEFUN_SCORES_DIR: scoresDir },
    stdio: 'pipe',
    timeout: 120_000,
  });
  const scores = JSON.parse(readFileSync(join(scoresDir, 'scores.json'), 'utf8'));
  const checks = JSON.parse(readFileSync(join(scoresDir, 'checks.json'), 'utf8'));
  console.log(`  score ${scores.score} (passed ${scores.passed}, answered ${scores.answered}/${scores.instances})`);
  for (const c of checks) console.log(`    ${c.key}: ${c.earned} — ${c.detail}`);
  return scores;
}

function solveAndScore(inputDir, refDir, label) {
  const outDir = join(work, `out-${label}`);
  run(join(repo, 'main.ts'), { MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir }, `solver (${label})`);
  return { outDir, scores: score(outDir, refDir, label) };
}

console.log('== practice set: determinism (two runs, byte-identical outputs)');
const first = solveAndScore(join(kit, 'practice', 'input'), join(kit, 'practice', 'reference'), 'practice-1');
const secondOut = join(work, 'out-practice-2');
run(join(repo, 'main.ts'), { MAKEFUN_INPUT_DIR: join(kit, 'practice', 'input'), MAKEFUN_OUTPUT_DIR: secondOut }, 'solver (practice-2)');
for (const id of ['i001', 'i002', 'i003', 'i004', 'i005']) {
  const a = readFileSync(join(first.outDir, id, 'solution.txt'));
  const b = readFileSync(join(secondOut, id, 'solution.txt'));
  if (!a.equals(b)) {
    failures++;
    console.log(`  FAIL: ${id} differs between the two runs`);
  }
}
console.log('  outputs identical');
if (first.scores.score !== 1_000_000) failures++;

console.log('== practice set: house baseline plain-astar');
const baseOut = join(work, 'out-baseline');
run(join(kit, 'baselines', 'plain-astar', 'main.ts'), { MAKEFUN_INPUT_DIR: join(kit, 'practice', 'input'), MAKEFUN_OUTPUT_DIR: baseOut }, 'baseline');
score(baseOut, join(kit, 'practice', 'reference'), 'baseline');

console.log(`== ${extraSets} fresh sets drawn with the kit generator`);
for (let s = 0; s < extraSets; s++) {
  const seed = createHash('sha256').update(`sokoban-solver-verify-${s}`).digest('hex');
  const seedDir = join(work, `seed-${s}`);
  const drawDir = join(work, `draw-${s}`);
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(join(seedDir, 'seed.json'), JSON.stringify({ schema: 'agent-fun/instance-seed/v1', seed }));
  execFileSync(process.execPath, [join(kit, 'program', 'generator', 'draw.ts')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: seedDir, MAKEFUN_OUTPUT_DIR: drawDir },
    stdio: 'pipe',
    timeout: 300_000,
  });
  const { scores } = solveAndScore(join(drawDir, 'input'), join(drawDir, 'reference'), `set-${s}`);
  if (scores.score !== 1_000_000) {
    failures++;
    console.log(`  FAIL: set ${s} scored ${scores.score}, not 1000000`);
  }
}

console.log(failures === 0 ? 'VERIFY: PASS' : `VERIFY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
