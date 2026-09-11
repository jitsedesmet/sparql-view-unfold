/**
 * @fileoverview Core benchmark runner.
 *
 * For each benchmark case and each engine it measures:
 *  - **rewriting**: rewrite the SPARQL 1.2 query into SPARQL 1.1 (this library) and
 *    execute it over the materialized RDF 1.1 dataset.
 *  - **native** (optional): execute the SPARQL 1.2 query directly over the native
 *    RDF 1.2 dataset — only on engines that support SPARQL 1.2.
 *
 * A single reference engine computes the "ground truth" answer once per case — the
 * hand-written `materialized` baseline where the case has one — so every engine's result
 * can be checked against it. See {@link runBenchmark} for why the baseline, and not the
 * rewriting being measured, is what the answers are judged against.
 */
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { transformFilterFalse } from '../../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { pullUpExtends } from '../../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../../lib/transformations/pushDownAssertions.js';
import { removeProjections } from '../../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../../lib/transformBgp.js';
import { transformContextFromConstructs } from '../../lib/transformContext.js';
import type { TransformContext } from '../../lib/transformContext.js';
import type { BenchEngine, EngineSource, SelectResult } from './engines.js';

/** The shape every transformation pass in a pipeline conforms to. */
type Transformation = (c: TransformContext, op: Algebra.Operation) => Algebra.Operation;

/** The standard rewriting pipeline used across the integration tests. */
const STANDARD_TRANSFORMATIONS = <const>[
  operationTransform,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  transformFilterFalse,
];

/**
 * The standard pipeline plus {@link removeProjections}: flattens the nested
 * sub-`SELECT`s that `operationTransform` wraps each mapper branch in (anonymizing
 * the variables they hide, so semantics are preserved) into a single flat tree of
 * `UNION`/`JOIN`/`FILTER`/`BIND`. Some SPARQL engines' query planners handle deeply
 * nested sub-`SELECT`s poorly; this variant tests whether that structural
 * simplification changes engine performance on the benchmark queries.
 */
const WITH_PROJECTION_REMOVAL_TRANSFORMATIONS = <const>[
  ...STANDARD_TRANSFORMATIONS,
  removeProjections,
];

/**
 * The standard pipeline plus {@link pushDownAssertions}: `FILTER(sameTerm(?x, c))`
 * assertion filters (both the mapping-head unification constraints and the outer
 * query's own equality constraints) are pushed as deep as possible instead of being
 * left as a post-hoc filter over the fully reconstructed pattern — substituting the
 * term into BGPs and paths (turning a free variable position into an indexed lookup),
 * pruning `VALUES` rows, emptying `UNION` branches that cannot bind the variable, and
 * turning an `OPTIONAL` over an asserted variable into a plain join. Unlike the earlier
 * `substituteVarsThatArePreBoundToTerms` prototype (see git history), this pass sees
 * through `UNION` and reaches constants that only arrive via a `FILTER`, which is how
 * every constant in this benchmark's rewritten queries actually appears.
 * `transformFilterFalse` runs once more afterwards to clean up any `FILTER(FALSE)`
 * branches the pushdown introduces (contradictory bindings). It collapses them through
 * sub-`SELECT`s too, so a `UNION` branch the pushdown proves empty disappears entirely.
 * Before that pass could see past a `PROJECT`, such a branch survived as a dead
 * `FILTER(FALSE)` over a full `?s ?p ?o` pattern in 20 of the 24 cases — harmless to the
 * answer, but it inflated Comunica's cardinality estimate enough to invert its join order
 * on `F-Q3`.
 *
 * `removeProjections` is appended last as a **required workaround, not an optional
 * extra**: the pushdown leaves `BIND`s directly over the sub-`SELECT`s that mapper
 * branches are wrapped in, with no `{ }` group around the sub-`SELECT` — an algebra shape
 * `STANDARD_TRANSFORMATIONS` never produces, and one the SPARQL 1.1 generator serializes
 * as syntactically invalid SPARQL (`Parse error: Expecting --> } <-- but found -->
 * 'BIND' <--`). It is not limited to branches the pushdown empties: without
 * `removeProjections`, every pushdown and pull-up rewrite of the 24 benchmark cases fails
 * to parse, `B-Q1` included, which has no emptied branch at all. Flattening away the
 * offending `PROJECT` nodes avoids the shape entirely; the order relative to
 * `pushDownAssertions` does not matter (verified both ways), so it runs last to also
 * pick up any new sub-`SELECT`s the pushdown itself introduces.
 */
const WITH_PUSH_DOWN_ASSERTIONS_TRANSFORMATIONS = <const>[
  ...STANDARD_TRANSFORMATIONS,
  pushDownAssertions,
  transformFilterFalse,
  removeProjections,
];

/**
 * The pushdown pipeline plus {@link pullUpExtends}, applied twice: `pushDownAssertions`
 * leaves an `EXTEND` at every leaf it substitutes into (see its own `@fileoverview`), and
 * `pullUpExtends` is the pass built to be its other half — floating those back up past
 * joins/optionals/unions to where they cost less, or dropping them outright when nothing
 * above ends up reading them. It runs once right after the pushdown to clean that up, and
 * once more after `removeProjections`: flattening away the nested sub-`SELECT`s changes the
 * join topology `pullUpExtends`'s soundness checks read (fewer, flatter operands to reason
 * about), so a second pass can float — or drop — binds the first pass could not have,
 * without the sub-`SELECT` boundaries in the way. `removeProjections` itself still runs
 * where the plain `pushDownAssertions` pipeline needs it (see that pipeline's own comment) —
 * a required workaround for a generator quirk on `BIND`s over sub-`SELECT`s, not an optional
 * extra.
 */
const WITH_PULL_UP_EXTENDS_TRANSFORMATIONS = <const>[
  ...STANDARD_TRANSFORMATIONS,
  pushDownAssertions,
  transformFilterFalse,
  pullUpExtends,
  transformFilterFalse,
  removeProjections,
  pullUpExtends,
];

/** A single benchmark case: one SPARQL 1.2 query against one reification pattern. */
export interface BenchCase {
  /** Unique id, e.g. `reification/A-Q1`. */
  id: string;
  /** Reification pattern name, e.g. `reification` or `singleton`. */
  pattern: string;
  /** CONSTRUCT mapper strings (RDF 1.1 -> RDF 1.2 view) driving the rewriting. */
  mappers: string[];
  /** The user's SPARQL 1.2 SELECT query (RDF 1.2 `rdf:reifies` / `<< >>` form). */
  userQuery12: string;
  /**
   * The hand-written baseline SPARQL 1.1 query written directly against the
   * materialized RDF 1.1 representation ("original query on the original data").
   * When present, it is benchmarked alongside the rewritten query.
   */
  baselineQuery?: string;
  /** The materialized RDF 1.1 dataset (reification / singleton / ...). */
  materialized: EngineSource;
  /** Optional native RDF 1.2 dataset (e.g. the RDF-star dump) for the baseline. */
  native12?: EngineSource;
}

/** One measurement of one engine on one case. */
export interface BenchRecord {
  caseId: string;
  pattern: string;
  engine: string;
  /**
   * How the SPARQL 1.2 query was answered:
   *  - `rewriting`: rewrite to SPARQL 1.1 and run over the materialized RDF 1.1 data;
   *  - `materialized`: run the hand-written baseline SPARQL 1.1 query over the same data;
   *  - `native`: run the SPARQL 1.2 query directly over native RDF 1.2 data.
   */
  approach: 'rewriting' | 'materialized' | 'native';
  durationMs: number | null;
  count: number | null;
  /**
   * Whether the result matched the reference answer (null if no reference). The
   * reference is computed once per case on the reference engine, so this is a genuine
   * cross-engine check for every other engine; the one row it cannot testify about is
   * the reference engine's own `materialized` record, which is compared to itself.
   */
  correct: boolean | null;
  error?: string;
}

/** Which optimization pipeline {@link rewriteToSparql11} should apply. */
export type RewriteVariant = 'standard' | 'removeProjections' | 'pushDownAssertions' | 'pullUpExtends';

function pipelineFor(variant: RewriteVariant): readonly Transformation[] {
  switch (variant) {
    case 'removeProjections': return WITH_PROJECTION_REMOVAL_TRANSFORMATIONS;
    case 'pushDownAssertions': return WITH_PUSH_DOWN_ASSERTIONS_TRANSFORMATIONS;
    case 'pullUpExtends': return WITH_PULL_UP_EXTENDS_TRANSFORMATIONS;
    default: return STANDARD_TRANSFORMATIONS;
  }
}

/**
 * Rewrites a SPARQL 1.2 query into an equivalent SPARQL 1.1 query using the given
 * CONSTRUCT mappers and the requested optimization pipeline (defaults to the standard
 * pipeline used across the integration tests).
 */
export function rewriteToSparql11(
  mappers: string[],
  userQuery12: string,
  variant: RewriteVariant = 'standard',
): string {
  const context = transformContextFromConstructs(mappers);
  const generated = queryTransform(context, userQuery12, [ ...pipelineFor(variant) ]);
  return lowercaseBooleanLiterals(generated);
}

/**
 * Works around a parser quirk in the installed Oxigraph build (`oxigraph@0.5.9`),
 * not a bug in this library: per the SPARQL grammar notes
 * (https://www.w3.org/TR/sparql12-query/#sparqlGrammar), "Keywords are matched in a
 * case-insensitive manner with the exception of the keyword `a`" — so the
 * `xsd:boolean` shorthand our generator emits (`FILTER(FALSE)`/`FILTER(TRUE)`,
 * uppercase) is spec-compliant. Oxigraph's parser nonetheless rejects it outright
 * (`error at N:M: expected ENCODE_FOR_URI` — a generic fallback message from deep in
 * its expression grammar) while accepting lowercase `false`/`true`; a direct repro
 * against the installed WASM build confirms it (`FILTER(TRUE)`/`FILTER(True)` both
 * error, only `FILTER(true)` parses) even though Oxigraph's own tagged source for
 * this version defines `BooleanLiteral` with the case-insensitive `i()` keyword
 * helper — so the published build appears to disagree with its own grammar source,
 * not just with the spec. Comunica's parser is lenient and never surfaced this.
 *
 * This mattered for this benchmark while `pushDownAssertions` proved 10/12 queries'
 * "already a native quad" `UNION` branch statically empty and the `FILTER(FALSE)` it
 * materialized survived into the query text. Now that `transformFilterFalse` collapses
 * such branches through sub-`SELECT`s, none of the benchmark rewrites contains a
 * boolean-literal `FILTER`; this stays as a guard for queries that still would.
 *
 * A narrow text-level fix scoped to exactly the shape the generator produces
 * (`FILTER ( TRUE|FALSE )`), applied only to the query text sent to engines here —
 * the generator itself is left alone, since its output is correct.
 */
function lowercaseBooleanLiterals(query: string): string {
  return query.replaceAll(/\bFILTER\s*\(\s*(TRUE|FALSE)\s*\)/gu, (_match, bool: string) =>
    `FILTER ( ${bool.toLowerCase()} )`);
}

/**
 * Whether two result sets are the same solution multiset. Both engines canonicalize
 * and sort their rows (see `engines.ts`'s `summarize`), so an element-wise comparison
 * of equally long row arrays is order-insensitive.
 */
export function sameSolutions(a: SelectResult, b: SelectResult): boolean {
  if (a.count !== b.count) {
    return false;
  }
  return a.rows.every((row, index) => row === b.rows[index]);
}

/**
 * Runs a full benchmark: every engine against every case, both approaches where
 * applicable. `referenceEngine` provides the ground truth.
 *
 * The ground truth is the **hand-written `materialized` baseline** query, run on the
 * reference engine, and only falls back to the reference engine's own `rewriting`
 * result when a case has no baseline. Using `rewriting` as the reference would make
 * the pipeline under test its own oracle — which silently inverts the verdict whenever
 * that pipeline is the broken one (exactly what the Fuseki/ARQ triple-term bug does on
 * Jena: `rewriting` returns 0 rows there, so every variant that agrees with the
 * baseline gets marked incorrect). The baseline is plain SPARQL 1.1 over plain RDF 1.1
 * with no triple terms anywhere, so it is the one query in the set that no engine's
 * RDF 1.2 support can get wrong.
 */
export async function runBenchmark(
  cases: BenchCase[],
  engines: BenchEngine[],
  referenceEngine: BenchEngine,
): Promise<BenchRecord[]> {
  const records: BenchRecord[] = [];

  for (const benchCase of cases) {
    const rewritten = rewriteToSparql11(benchCase.mappers, benchCase.userQuery12);
    const reference = await referenceAnswer(benchCase, rewritten, referenceEngine);

    for (const engine of engines) {
      records.push(
        await measure(benchCase, engine, 'rewriting', rewritten, benchCase.materialized, reference),
      );

      if (benchCase.baselineQuery !== undefined) {
        records.push(
          await measure(
            benchCase,
            engine,
            'materialized',
            benchCase.baselineQuery,
            benchCase.materialized,
            reference,
          ),
        );
      }

      if (engine.supportsSparql12 && benchCase.native12) {
        records.push(
          await measure(benchCase, engine, 'native', benchCase.userQuery12, benchCase.native12, reference),
        );
      }
    }
  }
  return records;
}

/**
 * The ground-truth answer for one case: the hand-written baseline on the reference
 * engine, falling back to that engine's rewriting result when the case has no
 * baseline. `undefined` when neither can be produced, which leaves `correct` unknown
 * rather than asserting agreement with nothing.
 */
async function referenceAnswer(
  benchCase: BenchCase,
  rewritten: string,
  referenceEngine: BenchEngine,
): Promise<SelectResult | undefined> {
  for (const query of [ benchCase.baselineQuery, rewritten ]) {
    if (query === undefined) {
      continue;
    }
    try {
      return await referenceEngine.runSelect(query, benchCase.materialized);
    } catch {
      // Try the next candidate; an unanswerable case simply has no reference.
    }
  }
  return undefined;
}

async function measure(
  benchCase: BenchCase,
  engine: BenchEngine,
  approach: 'rewriting' | 'materialized' | 'native',
  query: string,
  source: EngineSource,
  reference: SelectResult | undefined,
): Promise<BenchRecord> {
  const base = <const> { caseId: benchCase.id, pattern: benchCase.pattern, engine: engine.name, approach };
  try {
    const result = await engine.runSelect(query, source);
    return {
      ...base,
      durationMs: result.durationMs,
      count: result.count,
      correct: reference ? sameSolutions(result, reference) : null,
    };
  } catch (error: unknown) {
    return {
      ...base,
      durationMs: null,
      count: null,
      correct: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Renders benchmark records as a simple aligned text table. */
export function formatRecords(records: BenchRecord[]): string {
  const header = [ 'case', 'engine', 'approach', 'ms', 'rows', 'correct', 'error' ];
  const rows = records.map(r => [
    r.caseId,
    r.engine,
    r.approach,
    r.durationMs === null ? '-' : r.durationMs.toFixed(1),
    r.count === null ? '-' : String(r.count),
    r.correct === null ? '-' : (r.correct ? 'yes' : 'NO'),
    r.error ?? '',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(row => row[i].length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [ line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line) ].join('\n');
}
