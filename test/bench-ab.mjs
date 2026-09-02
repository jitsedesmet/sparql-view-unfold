/**
 * Runs `yarn bench` against two revisions of `lib`, alternating between them, and reports the paired
 * result.
 *
 * A single `--compare` cannot answer whether a change made the rewriting faster. Running one revision
 * and then the other puts every sample of the first before every sample of the second, so anything the
 * machine does in between - another process starting, the CPU changing its mind about frequency - lands
 * entirely on one side and reads as a difference. On this file's own benchmarks that is enough to move the
 * parse control, which is byte-identical on both sides and so must be 1.00x, well away from it.
 *
 * Alternating fixes it, because drift then falls on both sides equally. The order *within* a round is
 * alternated too: running one side first every time would put whatever the machine does over a round -
 * a core heating up, a cache filling - on the same side each time, which is a bias no number of rounds
 * washes out, and which reads as a difference in whichever side goes second.
 *
 * What is reported per benchmark is how many rounds each side won, and the ratios round by round: an
 * effect shows up as nearly every round agreeing, noise as a coin flip. The parse benchmarks are the
 * control - they should come out near half the rounds each, and if they do not, the machine is too busy
 * to measure on. Passing `HEAD` as the revision measures HEAD against itself, which is the null run: if
 * that reports anything but coin flips, the harness is lying and nothing else it says is worth reading.
 *
 * Usage:
 *
 *   yarn bench:ab <revision> [rounds]
 *   yarn bench:ab 8638c96 8
 *
 * `lib` is checked out at that revision and back again on every round, so the working tree has to be
 * clean - the run refuses to start otherwise, rather than discarding uncommitted work. However the run
 * ends, including on a Ctrl-C, `lib` goes back to HEAD before it does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [ revision, roundsArg ] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 8);

if (revision === undefined) {
  process.stderr.write('usage: yarn bench:ab <revision> [rounds]\n');
  process.exit(64);
}
if (!Number.isInteger(rounds) || rounds < 1) {
  process.stderr.write(`rounds must be a positive whole number, not ${JSON.stringify(roundsArg)}\n`);
  process.exit(64);
}

/**
 * Runs a command, handing back what it wrote.
 *
 * Its stderr is kept rather than discarded, so that a checkout this refuses to do says why instead of
 * failing as a bare `Command failed` - the two things that can go wrong here, a checkout that will not
 * apply and a benchmark that will not run, are both unreadable without it.
 * @param file - The command
 * @param args - Its arguments
 * @returns its stdout
 */
function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ]});
  } catch (error) {
    // A child that died of a signal rather than an exit code is a Ctrl-C: it reaches every process in the
    // terminal's group, so the benchmark hears it at the same moment this does. Marked, rather than
    // reported as a failure, so that the end of the run can tell an interrupt from a checkout that would
    // not apply and say something shorter than a stack trace about it.
    if (typeof error.signal === 'string') {
      throw Object.assign(new Error(`interrupted by ${error.signal}`), { interrupted: true });
    }
    const said = String(error.stderr ?? '').trim();
    throw new Error(`${file} ${args.join(' ')} failed${said === '' ? '' : `:\n${said}`}`, { cause: error });
  }
}

// Every round overwrites `lib`, so anything uncommitted there would be lost.
if (run('git', [ 'status', '--porcelain', '--', 'lib' ]).trim() !== '') {
  process.stderr.write('lib has uncommitted changes; commit or stash them first\n');
  process.exit(1);
}
// What the revision resolves to, and what is used from here on. Not the string that was typed: that is a
// revision expression, which is a grammar rather than a name - `origin/main` and `HEAD^{/regex}` are both
// valid ones - and it goes on to be both an argument to `git checkout` and part of a file name. A commit
// id can be neither an option nor a path that leaves the scratch directory, so nothing downstream has to
// be careful. The typed string is only reported back.
const base = run('git', [ 'rev-parse', '--verify', `${revision}^{commit}` ]).trim();

const scratch = mkdtempSync(join(tmpdir(), 'bench-ab-'));

/**
 * The median of every benchmark in one run, keyed by name.
 * @param path - The JSON vitest wrote
 * @returns the medians
 */
function mediansOf(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const medians = new Map();
  for (const file of report.files) {
    for (const group of file.groups) {
      for (const benchmark of group.benchmarks) {
        medians.set(benchmark.name, benchmark.median);
      }
    }
  }
  return medians;
}

/**
 * One `yarn bench`, with `lib` at the given revision.
 * @param at - A commit id to put `lib` at, or `HEAD`
 * @param round - Which round it is, for the file name
 * @returns the medians it measured
 */
function measure(at, round) {
  run('git', [ 'checkout', at, '--', 'lib' ]);
  const out = join(scratch, `${at}-${round}.json`);
  run('yarn', [ 'bench', `--outputJson=${out}` ]);
  return mediansOf(out);
}

/**
 * Puts `lib` back at HEAD and throws the scratch directory away.
 *
 * A round leaves `lib` at the base revision in the index as well as the working tree, so a run that ends
 * anywhere but the end leaves the wrong `lib` staged, quietly, ready for the next `git commit -a` to take
 * it. Hence the signal handlers below as well as the `finally`: an interrupted run has to put it back too.
 * Restoring and cleaning up are nested rather than sequential so that a checkout that will not apply still
 * cannot leak the scratch directory.
 */
function restore() {
  try {
    run('git', [ 'checkout', 'HEAD', '--', 'lib' ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Registering these is the whole of what they do, and the empty body is the point. Every round below is
// synchronous, so nothing here ever runs while one is in flight - the event loop does not turn until the
// run is over. What registering them changes is that Ctrl-C no longer kills this process where it stands,
// which is what used to skip the restore and leave the wrong `lib` staged; instead the benchmark dies of
// the same signal, `run` throws, and the `finally` gets its turn.
for (const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ]) {
  process.on(signal, () => {});
}

const results = { base: [], head: []};
let interrupted = false;
try {
  for (let round = 1; round <= rounds; round++) {
    // Whichever side went second last round goes first this one.
    if (round % 2 === 1) {
      results.base.push(measure(base, round));
      results.head.push(measure('HEAD', round));
    } else {
      results.head.push(measure('HEAD', round));
      results.base.push(measure(base, round));
    }
    process.stderr.write(`round ${round}/${rounds}\n`);
  }
} catch (error) {
  if (error.interrupted !== true) {
    throw error;
  }
  interrupted = true;
} finally {
  restore();
}

// After the `finally` rather than inside the `catch`, because `process.exit` does not let a `finally` run
// and the restore is the one thing that has to happen.
if (interrupted) {
  process.stderr.write('interrupted; `lib` is back at HEAD\n');
  process.exit(130);
}

const names = [ ...results.base[0].keys() ];

/**
 * A duration in milliseconds, at a width that reads for a sub-millisecond parse as well as for a pushdown
 * orders of magnitude slower.
 * @param ms - The duration
 * @returns it, formatted
 */
function millis(ms) {
  return ms < 1 ? ms.toFixed(4) : ms.toFixed(2);
}

/**
 * The middle value of a list.
 * @param values - The values, which this sorts a copy of
 * @returns the median
 */
function medianOf(values) {
  const sorted = [ ...values ].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const rows = names.map((name) => {
  const bases = results.base.map(round => round.get(name));
  const heads = results.head.map(round => round.get(name));
  const ratios = bases.map((base, round) => base / heads[round]);
  return {
    name,
    base: medianOf(bases),
    head: medianOf(heads),
    won: `${ratios.filter(ratio => ratio > 1).length}/${rounds}`,
    // The median of the paired ratios rather than their mean, geometric or otherwise: one round the
    // machine spoiled would drag a mean far enough to disagree with the two columns beside it, which is
    // how a summary stops being readable. Paired rather than the ratio of the two columns, since the
    // pairing is what the alternating is for.
    ratio: medianOf(ratios),
    ratios,
  };
});

const width = Math.max(...names.map(name => name.length), 'benchmark'.length);
const header = `${'benchmark'.padEnd(width)}  ${'base ms'.padStart(8)}  ${'HEAD ms'.padStart(8)}  ` +
  `${'HEAD won'.padStart(8)}  ${'ratio'.padStart(6)}  ratios per round (base/head)`;
process.stdout.write(`\n${revision} (base) against HEAD, ${rounds} alternating rounds\n\n`);
process.stdout.write(`${header}\n${'-'.repeat(header.length + rounds * 6 - 'ratios per round (base/head)'.length)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(width)}  ${millis(row.base).padStart(8)}  ${millis(row.head).padStart(8)}  ` +
    `${row.won.padStart(8)}  ${row.ratio.toFixed(3).padStart(6)}  ` +
    `${row.ratios.map(ratio => ratio.toFixed(2).padStart(5)).join(' ')}\n`,
  );
}
process.stdout.write(`
Milliseconds are the median across rounds of each run's own median, and \`ratio\` the median of the paired
per-round ratios, so that one round the machine spoiled cannot move any of the three. Above 1.000 means
HEAD is the faster of the two, and "HEAD won" counts the rounds in which it was.

Read the parse benchmarks first: they are byte-identical on both sides, so whatever they report is this
machine's noise, and nothing smaller is a result. Run \`yarn bench:ab HEAD ${rounds}\` for the null - HEAD
against itself - to see what this many rounds produces here from no difference at all. How wide that comes
out is what decides how big a ratio has to be to mean anything on this machine, and it is wide enough on a
busy one that a win count on its own decides nothing.
`);
