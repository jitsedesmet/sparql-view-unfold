/**
 * @fileoverview Streaming subset generator for the (very large) BKR materialized
 * datasets.  The real BKR-Reification.ttl / BKR-Singleton.ttl files contain
 * ~100M+ triples which cannot be loaded into an in-memory RDF store.
 *
 * This script produces smaller, self-contained subsets that:
 *   1. ALWAYS include the "closure" of every benchmark query's target entities
 *      (so the queries return non-empty results), and
 *   2. add a uniform random sample of the remaining triples ("noise") to reach a
 *      set of target sizes, so we can measure how evaluation time scales with the
 *      dataset volume.
 *
 * Because the rewritten query and the hand-written baseline query are always run
 * against the *same* subset, their results are directly comparable regardless of
 * how the subset was sampled.
 *
 * Usage:
 *   node test/bench/makeSubset.mjs <input.ttl> <outDir> <schemeName>
 *
 * Turtle statements are recovered by accumulating physical lines until a line
 * whose last non-whitespace character is '.', which terminates a statement.
 *
 * The two reification schemes encode "is this statement about a query's SUBJECT
 * seed concept?" differently:
 *  - `reification`: an explicit reified block `<reifier> a rdf:Statement ;
 *    rdf:subject <seed> ; ...`, so the check is "does the statement contain the
 *    `rdf:subject> <seed>` substring".
 *  - `singleton`: the seed is the literal subject of the base triple itself
 *    (`<seed> <pred> <urn:bkr:blank:df_N> <obj> .`-style block, see
 *    BKR-Singleton.ttl), so the check is "does the statement's own subject equal
 *    the seed". The blank `df_N` id used as the singleton-property predicate is a
 *    *different* subject than `<seed>`, so once a base triple is pulled into the
 *    closure, any `urn:bkr:blank:df_*` id mentioned in it is also added to
 *    `keepReifiers` (scheme-agnostic) so its companion statement — the reification
 *    block for `reification`, the `rdf:singletonPropertyOf` statement for
 *    `singleton` — is kept too.
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const BKR = 'http://mor.nlm.nih.gov/bkr/';
const DERIVES = 'http://knoesis.wright.edu/provenir/derives_from';
const SUBJECT_PRED = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#subject';

/** Provenance sources used as query constants (A-Q1, B-Q1, B-Q2 ...). */
const PUBMED_SEEDS = [ 'PUBMED_99992-INST', 'PUBMED_10979521-INST' ].map(n => BKR + n);
/** Reified-statement SUBJECTS used as query constants (A-Q2..4, F-Q1..5). */
const SUBJECT_META_SEEDS = [ 'META_C0543467-INST', 'META_C0040300-INST' ].map(n => BKR + n);

/**
 * True if a statement belongs to a benchmark query's closure, i.e. it directly
 * mentions a query constant in the ROLE the queries use it:
 *  - a `derives_from` statement whose object list contains a seed PUBMED, or
 *  - (scheme `reification`) a reification block whose `rdf:subject` is a seed
 *    META concept, or
 *  - (scheme `singleton`) a base triple whose own subject is a seed META concept.
 * This is deliberately role-aware: seed concepts also appear as OBJECTS in
 * millions of unrelated statements, which must NOT be pulled into the closure.
 */
function isClosureSeed(text, scheme) {
  if (text.includes(DERIVES)) {
    for (const s of PUBMED_SEEDS) {
      if (text.includes(`<${s}>`)) {
        return true;
      }
    }
  }
  for (const s of SUBJECT_META_SEEDS) {
    if (scheme === 'singleton' ? text.startsWith(`<${s}>`) : text.includes(`${SUBJECT_PRED}> <${s}>`)) {
      return true;
    }
  }
  return false;
}

/** All `urn:bkr:blank:df_*` ids (without angle brackets) mentioned in a statement. */
function blankIdsIn(text) {
  return [ ...text.matchAll(/<(urn:bkr:blank:df_\d+(?:_\d+)?)>/gu) ].map(m => m[1]);
}

/** Target subset sizes, in number of quads. */
const SCALES = [
  { name: 'xs', quads: 100_000 },
  { name: 's', quads: 500_000 },
  { name: 'm', quads: 2_000_000 },
  { name: 'l', quads: 8_000_000 },
];

const [ , , input, outDir, scheme ] = process.argv;
if (!input || !outDir || !scheme) {
  console.error('usage: node makeSubset.mjs <input.ttl> <outDir> <schemeName>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/** Number of RDF quads a Turtle statement expands to (object list aware). */
function countQuads(text) {
  // Predicate-object pairs: count '#subject>' style predicates + object commas.
  // Reification block: 'a Statement' + subject + predicate + object = 4.
  // Simple triple: 1.  derives_from list: number of comma-separated objects.
  const objectCommas = (text.match(/>\s*,/gu) ?? []).length;
  const predicates = (text.match(/;/gu) ?? []).length + 1;
  return predicates + objectCommas;
}

/** Extracts the subject id (first <...>) of a statement. */
function subjectOf(text) {
  const m = /<([^>]+)>/u.exec(text);
  return m ? m[1] : '';
}

async function* statements(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  let buf = [];
  for await (const line of rl) {
    buf.push(line);
    const trimmed = line.trimEnd();
    if (trimmed.endsWith('.')) {
      yield buf.join('\n');
      buf = [];
    }
  }
  if (buf.length > 0) {
    yield buf.join('\n');
  }
}

// ---- Pass 1: collect the reifier ids that belong to the query closure, and
//      count total / closure quads so pass 2 can sample noise uniformly. ----
console.error(`[${scheme}] pass 1: collecting query closure ...`);
const keepReifiers = new Set();
let seen = 0;
let totalQuads = 0;
let closureQuadsP1 = 0;
for await (const stmt of statements(input)) {
  seen++;
  if (seen % 20_000_000 === 0) {
    console.error(`  pass1 ${seen} statements ...`);
  }
  totalQuads += countQuads(stmt);
  if (!isClosureSeed(stmt, scheme)) {
    continue;
  }
  // Any statement mentioning a seed contributes its subject, and any blank
  // `df_N` id it references, as reifiers to keep, so companion statements
  // (the reification block / derives_from line for `reification`, or the
  // `rdf:singletonPropertyOf` line for `singleton`) are retained together.
  closureQuadsP1 += countQuads(stmt);
  keepReifiers.add(subjectOf(stmt));
  for (const id of blankIdsIn(stmt)) {
    keepReifiers.add(id);
  }
}
console.error(
  `[${scheme}] closure reifiers=${keepReifiers.size} totalQuads=${totalQuads} closureQuads=${closureQuadsP1}`,
);

// ---- Pass 2: emit closure statements to all scales + sampled noise. ----
const writers = SCALES.map((s) => {
  const noiseQuads = Math.max(0, s.quads - closureQuadsP1);
  const noiseTotal = Math.max(1, totalQuads - closureQuadsP1);
  return {
    ...s,
    stream: createWriteStream(join(outDir, `${scheme}-${s.name}.ttl`)),
    emitted: 0,
    noiseProb: Math.min(1, noiseQuads / noiseTotal),
  };
});

seen = 0;
let closureQuads = 0;
for await (const stmt of statements(input)) {
  seen++;
  if (seen % 20_000_000 === 0) {
    console.error(`  pass2 ${seen} statements ...`);
  }
  const subj = subjectOf(stmt);
  // A statement belongs to the closure if it's itself a seed statement, its
  // subject is a kept reifier/blank id (companion statement keyed by that id,
  // e.g. reification blocks or `rdf:singletonPropertyOf`), OR it *mentions* a
  // kept blank id in another position — e.g. the singleton base triple
  // `<subject> <urn:bkr:blank:df_N> <object>` uses the blank id as its
  // PREDICATE, so it must be found via the reifier ids referenced in the
  // statement rather than its own subject.
  const isClosure = isClosureSeed(stmt, scheme) ||
    keepReifiers.has(subj) ||
    blankIdsIn(stmt).some(id => keepReifiers.has(id));
  const quads = countQuads(stmt);
  if (isClosure) {
    closureQuads += quads;
    for (const w of writers) {
      w.stream.write(`${stmt}\n`);
      w.emitted += quads;
    }
    continue;
  }
  // Noise: uniform random sample per scale so every scale is representative.
  const r = Math.random();
  for (const w of writers) {
    if (r < w.noiseProb) {
      w.stream.write(`${stmt}\n`);
      w.emitted += quads;
    }
  }
}

await Promise.all(writers.map(w => new Promise((res) => {
  w.stream.end(res);
})));
console.error(`[${scheme}] closure quads=${closureQuads}`);
for (const w of writers) {
  console.error(`[${scheme}] ${w.name}: ~${w.emitted} quads -> ${scheme}-${w.name}.ttl`);
}
console.error(`[${scheme}] input=${basename(input)} done.`);
