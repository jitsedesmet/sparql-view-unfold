import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { bench, describe } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVars } from '../lib/transformations/nullifyUnbindableVars.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery, transformContextFromConstructs } from '../lib/transformContext.js';
import { nonTripleTermConstruct, testQuery, tripleTermConstruct } from './queryConsts.js';

/**
 * @fileoverview How long the rewriting takes, at the three levels a change can move: the whole of
 * {@link transformBgp!queryTransform}, the pushdown on its own, and the parse the first of those
 * includes.
 *
 * Run with `yarn bench` for a single set of numbers.
 *
 * To measure a *change*, use `yarn bench:ab <revision>` (`test/bench-ab.mjs`), which alternates
 * between the two revisions of `lib` and reports the paired result. A single run of each side and a
 * `--compare` between them cannot do it: every sample of one revision then falls before every sample of
 * the other, so anything the machine does in between reads as a difference - on these benchmarks, enough
 * of one to move the parse control that is byte-identical on both sides, and to invent an end-to-end
 * regression that alternating rounds show is not there.
 *
 *     yarn bench:ab 8638c96 8      # the commit the revision-stamp memos went on top of
 *     yarn bench:ab HEAD 8         # the null: HEAD against itself, to calibrate the noise
 *
 * Nothing here is a regression test, and no numbers from a past run are written down: what any of these
 * benchmarks reports depends on the machine running it, so a ratio is only worth reading beside the parse
 * control measured in the same run.
 *
 * **What each level is for.** `queryTransform` is what a caller experiences, parse included, so it is
 * the honest end-to-end figure and the least sensitive one - the memos need a bigger conjunction than a
 * hand-written filter builds before they reach it. The pushdown is where
 * {@link utils/assertionConjunction!AssertionConjunction} does its work, and so where a change to the
 * memos shows up: it is not part of the standard chain the integration tests run, being a transformation
 * a caller opts into, so it is measured both ways below.
 */

/** The chain the integration tests run, which does not include the pushdown. */
const standardTransformations = <const>[
  operationTransform,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  nullifyUnbindableVars,
  transformFilterFalse,
  pullUpExtends,
  removeProjections,
];

/** The same chain with the assertion pushdown in it, which is what drives Θ. */
const withPushdown = <const>[
  operationTransform,
  pushDownAssertions,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  nullifyUnbindableVars,
  transformFilterFalse,
  pullUpExtends,
  removeProjections,
];

// Built once: parsing the mappers is not what any of this is measuring.
const mapped = transformContextFromConstructs([ tripleTermConstruct, nonTripleTermConstruct ]);
const bare = <TransformContext> createPartialContext();

const prefixes = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>
`;

/** A user query whose filters make the cliques and shapes the pushdown moves around. */
const filterHeavyQuery = `${prefixes}SELECT * WHERE {
  ?t rdf:reifies <<( ?s ?p ?o )>> .
  ?s :knows ?friend .
  ?friend :name ?name .
  OPTIONAL { ?o :label ?label }
  FILTER(sameTerm(SUBJECT(?t), ?s) && sameTerm(?friend, ?s) && isIRI(?p) && sameTerm(?name, ?label))
}`;

/**
 * A join of `blocks` operands under one filter of `conditions` conditions - the shape the memo commits
 * were measured on. The conditions chain rather than pin, so the groups stay large and the walk over
 * them stays worth memoising.
 * @param blocks - How many operands to join
 * @param conditions - How many conditions to put in the filter above them
 * @returns the query text
 */
function synthetic(blocks: number, conditions: number): string {
  const names: string[] = [];
  const patterns: string[] = [];
  for (let block = 0; block < blocks; block++) {
    patterns.push(`{ ?s${block} :p ?o${block} . ?o${block} :q ?t${block} OPTIONAL { ?t${block} :r ?u${block} } }`);
    names.push(`s${block}`, `o${block}`, `t${block}`, `u${block}`);
  }
  const conds: string[] = [];
  for (let index = 0; index < conditions; index++) {
    conds.push(conditionAt(index, names));
  }
  return `${prefixes}SELECT * WHERE { ${patterns.join(' ')} FILTER(${conds.join(' && ')}) }`;
}

/**
 * One condition of the filter {@link synthetic} writes.
 * @param index - Which condition it is, which is what decides its form and the variables it names
 * @param names - Every variable the patterns bind
 * @returns the condition
 */
function conditionAt(index: number, names: readonly string[]): string {
  const here = names[index % names.length];
  switch (index % 4) {
    case 0:
      return `sameTerm(?${here}, ?${names[(index + 4) % names.length]})`;
    case 1:
      return `isIRI(?${here})`;
    case 2:
      // An accessor, which gives the group a shape and three positions of its own.
      return `sameTerm(SUBJECT(?${here}), ?${names[(index + 7) % names.length]})`;
    default:
      return `sameTerm(?${here}, ?${names[(index + 13) % names.length]})`;
  }
}

/**
 * Long enough to be worth reading. The default 100ms of warm-up leaves V8 still optimising when the
 * sampling starts - only a handful of iterations of a benchmark this size - and the default 500ms of
 * sampling then takes its few samples of whatever state it settled into. Both are what made a single run
 * of this file unable to tell a large difference from none.
 */
const settled = { warmupTime: 500, warmupIterations: 16, time: 2000, iterations: 24 };

// Parsed once, so that what the pushdown benchmarks time is the pushdown.
const parsed: Record<string, Algebra.Operation> = {
  'filter of 160 conditions, 16 blocks': parseQuery(bare, synthetic(16, 160)),
  '32 blocks': parseQuery(bare, synthetic(32, 160)),
  '64 blocks': parseQuery(bare, synthetic(64, 320)),
};

describe('the whole rewriting', () => {
  bench('a mapped query, standard chain', () => {
    queryTransform(mapped, testQuery, [ ...standardTransformations ]);
  }, settled);

  bench('a filter-heavy mapped query, standard chain', () => {
    queryTransform(mapped, filterHeavyQuery, [ ...standardTransformations ]);
  }, settled);

  bench('a filter-heavy mapped query, with the assertion pushdown', () => {
    queryTransform(mapped, filterHeavyQuery, [ ...withPushdown ]);
  }, settled);
});

describe('the parse the above includes', () => {
  bench('a mapped query', () => {
    parseQuery(mapped, testQuery);
  }, settled);

  bench('a filter-heavy mapped query', () => {
    parseQuery(mapped, filterHeavyQuery);
  }, settled);
});

describe('the assertion pushdown, over a parsed plan', () => {
  for (const [ label, plan ] of Object.entries(parsed)) {
    bench(label, () => {
      pushDownAssertions(bare, plan);
    }, settled);
  }
});
