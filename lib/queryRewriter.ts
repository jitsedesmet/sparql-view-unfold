import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { triplePositions } from './datastructures/TermClusterSet.js';
import { rangeOfPosition } from './RangeSet.js';
import { filterFalseTransformation } from './transformations/filterFalse.js';
import {
  nullifyJoinOverIncompatibleBoundsTransformation,
} from './transformations/nullifyJoinOverIncompatibleBounds.js';
import { rewriteNonRecursivePathsTransformation } from './transformations/pathTransformation.js';
import { pullUpExtendsTransformation } from './transformations/pullUpExtends.js';
import { pushDownAssertionsTransformation } from './transformations/pushDownAssertions.js';
import { removeProjectionsTransformation } from './transformations/removeProjections.js';
import type { UnfoldingOptions } from './transformations/unfolding.js';
import { unfoldingTransformation } from './transformations/unfolding.js';
import { createTransformationContext, parseQuery, resolveTransformationContextOptions } from './transformContext.js';
import type { TransformationContext, TransformationContextOptions } from './transformContext.js';
import type { Mapping, QueryTransformation } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';
import { queryFormTypes, solutionModifierTypes } from './utils/solutionModifierChain.js';
import { collectVariableNames, deepCopy, freshVarGenerator, markVariableNamesUsed, renameVariables } from './utils.js';

/**
 * @fileoverview The pipeline runner: a list of {@link QueryTransformation}s applied to a query in order.
 *
 * Around that list sits the bookkeeping every rewrite needs and no single pass should have to know about.
 * The pipeline runs over the *query part* of what it is handed - the pattern below a query's solution
 * modifiers, the `WHERE` of an update - and everything standing over that part is rebuilt on top of the
 * result, one rule per operation. The names of the whole query, modifiers and templates included, are
 * marked as used up front, so that no variable a pass coins takes one of them.
 *
 * **An update's templates are left as they stand.** Its `WHERE` reads the RDF 1.2 graph the mapping
 * denotes and so is rewritten, but that graph is virtual and nothing can be written to it: what the update
 * inserts and deletes goes to the RDF 1.1 source, exactly as written.
 *
 * Every rewrite gets a {@link TransformationContext} of its own: the {@link ClusterSolver} in it is
 * stateful, and the pipeline is asynchronous, so two concurrent rewrites sharing one context would
 * interleave.
 */

/** A configured pipeline, ready to rewrite queries. */
export interface QueryRewriter {
  /**
   * Rewrites a SPARQL query or update string.
   * @param query - The query or update to rewrite
   * @returns the rewritten query
   */
  rewriteQuery: (query: string) => Promise<string>;
  /**
   * Rewrites a query or update that is already in algebra form, shaped like the one `rewriteQuery` prints.
   * @param operation - The operation to rewrite
   * @returns the rewritten operation
   */
  rewriteOperation: (operation: Algebra.Operation) => Promise<Algebra.Operation>;
}

/**
 * Whether a triple term is an RDF one, which `<<( … )>>` can spell.
 * @param term - The triple term to check
 * @returns whether it is
 */
function isRdfTripleTerm(term: RDF.BaseQuad): boolean {
  return triplePositions.every(position => term[position].termType === 'Variable' ||
    (rangeOfPosition(position).has(term[position].termType) &&
      (term[position].termType !== 'Quad' || isRdfTripleTerm(term[position]))));
}

/**
 * Writes a non-RDF triple term as the `TRIPLE()` building it, `<<( … )>>` spelling RDF triple terms only.
 * @param c - The transformation context
 * @param term - The term to write
 * @returns the expression building it
 */
function tripleTermExpression(c: TransformationContext, term: RDF.Term): Algebra.Expression {
  if (term.termType !== 'Quad' || isRdfTripleTerm(term)) {
    return c.AF.createTermExpression(term);
  }
  return c.AF.createOperatorExpression('triple', [ term.subject, term.predicate, term.object ]
    .map(component => tripleTermExpression(c, component)));
}

/**
 * Makes the aggregates of a group read what its keys are bound to rather than the keys themselves. `toAst` writes an
 * extend binding a key directly below the group as `GROUP BY (expr AS ?key)`, a variable Jena and Oxigraph do not bind
 * where aggregates read.
 * @param c - The transformation context
 * @param group - The group to rewrite
 * @param nextVar - Coins the fresh variable a key's expression is bound to when that expression is no variable
 * @returns the group, its aggregates reading no key bound directly below it
 */
function readKeyBindingsInAggregates(
  c: TransformationContext,
  group: Algebra.Group,
  nextVar: () => RDF.Variable,
): Algebra.Group {
  const keys = new Set(group.variables.map(variable => variable.value));
  const aggregatedVariableNames = collectVariableNames(c.astTransformer, group.aggregates);
  const renames = new Map<string, string>();
  const rebindKeyChain = (operation: Algebra.Operation): Algebra.Operation => {
    if (operation.type !== Algebra.Types.EXTEND || !keys.has(operation.variable.value)) {
      return operation;
    }
    const input = rebindKeyChain(operation.input);
    const { variable, expression } = operation;
    if (aggregatedVariableNames.has(variable.value)) {
      if (expression.subType !== Algebra.ExpressionTypes.TERM || expression.term.termType !== 'Variable') {
        // The fresh variable is no key, so `toAst` ends the GROUP BY conditions above it, writing its extend as BIND.
        const freshVariable = nextVar();
        renames.set(variable.value, freshVariable.value);
        const freshVariableExtend = c.AF.createExtend(input, freshVariable, expression);
        return c.AF.createExtend(freshVariableExtend, variable, c.AF.createTermExpression(freshVariable));
      }
      renames.set(variable.value, expression.term.value);
    }
    return input === operation.input ? operation : c.AF.createExtend(input, variable, expression);
  };
  const input = rebindKeyChain(group.input);
  return renames.size === 0 ?
    group :
    c.AF.createGroup(input, group.variables, renameVariables(c, group.aggregates, renames));
}

/**
 * Rewrites an operation into the form `toAst` prints with the same meaning on every engine: a non-RDF triple term
 * becomes the `TRIPLE()` raising for it, and aggregates read what group keys are bound to.
 * @param c - The transformation context
 * @param operation - The operation to rewrite
 * @returns the rewritten operation
 */
function rewriteForPrinting(c: TransformationContext, operation: Algebra.Operation): Algebra.Operation {
  const nextVar = freshVarGenerator(markVariableNamesUsed(c, operation));
  return algebraUtils.mapOperationSub<'unsafe', typeof operation>(operation, {
    [Algebra.Types.GROUP]: { transform: group => readKeyBindingsInAggregates(c, group, nextVar) },
  }, { expression: { term: {
    transform: expression => tripleTermExpression(c, expression.term),
  }}});
}

/** The updates that write without reading, so that the pipeline has nothing to run over. */
const updateTypesWithoutQueryPart = new Set<string>([
  Algebra.Types.LOAD,
  Algebra.Types.CLEAR,
  Algebra.Types.CREATE,
  Algebra.Types.DROP,
  Algebra.Types.ADD,
  Algebra.Types.MOVE,
  Algebra.Types.COPY,
  Algebra.Types.NOP,
]);

/** The operations a query's solution-modifier chain can be made of, the query form among them. */
type SolutionModifier =
  Algebra.Ask | Algebra.Construct | Algebra.Describe | Algebra.Project |
  Algebra.Distinct | Algebra.Reduced | Algebra.Slice | Algebra.From;

/**
 * Rebuilds one solution modifier over the rewritten operation below it.
 * @param c - The transformation context of this rewrite
 * @param solutionModifier - The modifier that was peeled off
 * @param rewritten - What now stands where its input stood
 * @returns the rebuilt modifier
 */
function rebuildSolutionModifier(
  c: TransformationContext,
  solutionModifier: SolutionModifier,
  rewritten: Algebra.Operation,
): Algebra.Operation {
  switch (solutionModifier.type) {
    case Algebra.Types.PROJECT:
      return c.AF.createProject(rewritten, solutionModifier.variables);
    case Algebra.Types.CONSTRUCT:
      return c.AF.createConstruct(rewritten, solutionModifier.template);
    case Algebra.Types.DESCRIBE:
      return c.AF.createDescribe(rewritten, solutionModifier.terms);
    case Algebra.Types.ASK:
      return c.AF.createAsk(rewritten);
    case Algebra.Types.DISTINCT:
      return c.AF.createDistinct(rewritten);
    case Algebra.Types.REDUCED:
      return c.AF.createReduced(rewritten);
    case Algebra.Types.SLICE:
      return c.AF.createSlice(rewritten, solutionModifier.start, solutionModifier.length);
    case Algebra.Types.FROM:
      return c.AF.createFrom(rewritten, solutionModifier.default, solutionModifier.named);
  }
}

/**
 * Runs the pipeline over one query part, the restrictions checked first.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param queryPart - The pattern of a query, or the `WHERE` of an update
 * @returns the rewritten query part
 * @throws Error if the query part asks something the rewriting is not defined for
 */
async function rewriteQueryPart(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  queryPart: Algebra.Operation,
): Promise<Algebra.Operation> {
  assertUserQueryIsSupported(queryPart);
  let rewritten = queryPart;
  for (const transformation of transformations) {
    rewritten = await transformation(c, rewritten);
  }
  return rewritten;
}

/**
 * Rewrites the `WHERE` of an update, leaving what it writes to the RDF 1.1 source as the user wrote it.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param deleteInsert - The update to rewrite
 * @returns the update, over the rewritten `WHERE`
 */
async function rewriteUpdateWhere(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  deleteInsert: Algebra.DeleteInsert,
): Promise<Algebra.Operation> {
  // `INSERT DATA` and `DELETE DATA` name their triples outright: there is no query part to rewrite.
  if (deleteInsert.where === undefined) {
    return deleteInsert;
  }
  const rewrittenWhere = await rewriteQueryPart(c, transformations, deleteInsert.where);
  // What the templates write goes to the source, the RDF 1.2 graph the WHERE read being virtual.
  return c.AF.createDeleteInsert(deleteInsert.delete, deleteInsert.insert, rewrittenWhere);
}

/**
 * Rewrites every query part of a parsed query or update, rebuilding what stands over each on top of the
 * result.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param operation - The parsed user query or update
 * @returns the rewritten query, modifiers as the user wrote them
 */
async function rewriteParsedQuery(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  operation: Algebra.Operation,
): Promise<Algebra.Operation> {
  if (operation.type === Algebra.Types.COMPOSITE_UPDATE) {
    const rewrittenUpdates: Algebra.Operation[] = [];
    // Sequentially: the updates share one context, whose ClusterSolver is stateful.
    for (const update of operation.updates) {
      rewrittenUpdates.push(await rewriteParsedQuery(c, transformations, update));
    }
    return c.AF.createCompositeUpdate(rewrittenUpdates);
  }
  if (operation.type === Algebra.Types.DELETE_INSERT) {
    return rewriteUpdateWhere(c, transformations, operation);
  }
  // The query form ends the chain, so its input is the pattern itself rather than another modifier.
  if (queryFormTypes.has(operation.type)) {
    const pattern = (<Algebra.Single> operation).input;
    return rebuildSolutionModifier(
      c,
      <SolutionModifier> operation,
      await rewriteQueryPart(c, transformations, pattern),
    );
  }
  if (solutionModifierTypes.has(operation.type)) {
    return rebuildSolutionModifier(
      c,
      <SolutionModifier> operation,
      await rewriteParsedQuery(c, transformations, (<Algebra.Single> operation).input),
    );
  }
  // An update that writes without reading, or a bare pattern a caller handed to `rewriteOperation`.
  if (updateTypesWithoutQueryPart.has(operation.type)) {
    return operation;
  }
  return rewriteQueryPart(c, transformations, operation);
}

/**
 * Creates a rewriter applying the given transformations, in order, to every query handed to it.
 * @param transformations - The pipeline, for instance the one
 * {@link createDefaultTransformationPipeline} builds
 * @param options - What to configure the context of every rewrite with.
 * @returns the rewriter
 * @throws Error if the options are invalid
 * @example
 * const rewriter = createQueryRewriter([
 *   rewriteNonRecursivePathsTransformation(),
 *   unfoldingTransformation(mappingFromConstructQueries([ construct ])),
 *   filterFalseTransformation(),
 * ]);
 * const sparql11Query = await rewriter.rewriteQuery('SELECT * WHERE { ?s ?p ?o }');
 */
export function createQueryRewriter(
  transformations: readonly QueryTransformation[],
  options: TransformationContextOptions = {},
): QueryRewriter {
  const resolvedOptions = resolveTransformationContextOptions(options);
  return {
    async rewriteQuery(query: string): Promise<string> {
      const c = createTransformationContext(resolvedOptions);
      const operation = parseQuery(c, query);
      markVariableNamesUsed(c, operation);
      const rewritten = await rewriteParsedQuery(c, transformations, operation);
      return c.generator.generate(toAst(rewriteForPrinting(c, rewritten)));
    },
    async rewriteOperation(operation: Algebra.Operation): Promise<Algebra.Operation> {
      const c = createTransformationContext(resolvedOptions);
      markVariableNamesUsed(c, operation);
      // A copy, since passes may rewrite in place and the operation is the caller's.
      return rewriteForPrinting(c, await rewriteParsedQuery(c, transformations, deepCopy(c, operation)));
    },
  };
}

/**
 * The pipeline to reach for when you have no reason to build your own.
 *
 * The order is not a preference, it is what each step needs to see. Paths are expanded *before* the
 * unfolding, which only knows triple patterns. Empty results are pruned after every step that can
 * produce one, so the next step has less to walk. The pushdown drives terms into the leaves and the
 * pull-up floats the binds it leaves behind back out, in that order, because the pushdown is what creates
 * them. `nullifyJoinOverIncompatibleBounds` comes last, after `removeProjections` and `pullUpExtends`: it
 * reads each join operand's top-level `EXTEND` chain and halts at a `PROJECT`, so anywhere earlier it sees
 * nothing at all. Under a projection `removeProjections` keeps, such as one in an EXISTS, it sees nothing either.
 *
 * The blank node materialisations are absent: they are a choice about the data source rather than an optimisation.
 * @param mapping - The mapping to unfold, from {@link mapping!mappingFromConstructQueries}
 * @param options - What to configure the unfolding with
 * @returns the pipeline, to hand to {@link createQueryRewriter}
 * @example
 * const rewriter = createQueryRewriter(createDefaultTransformationPipeline(
 *   mappingFromConstructQueries([ tripleTermConstruct, nonTripleTermConstruct ]),
 * ));
 */
export function createDefaultTransformationPipeline(
  mapping: Mapping,
  options: UnfoldingOptions = {},
): QueryTransformation[] {
  return [
    rewriteNonRecursivePathsTransformation(),
    unfoldingTransformation(mapping, options),
    filterFalseTransformation(),
    pushDownAssertionsTransformation(),
    filterFalseTransformation(),
    pullUpExtendsTransformation(),
    filterFalseTransformation(),
    removeProjectionsTransformation(),
    nullifyJoinOverIncompatibleBoundsTransformation(),
    filterFalseTransformation(),
  ];
}
