import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from './consts.js';
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
import { createTransformationContext, parseQuery, prefixVarsInOperation } from './transformContext.js';
import type { TransformationContext } from './transformContext.js';
import type { Mapping, QueryTransformation } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';
import { queryFormTypes, solutionModifierTypes } from './utils/solutionModifierChain.js';

/**
 * @fileoverview The pipeline runner: a list of {@link QueryTransformation}s applied to a query in order.
 *
 * Around that list sits the bookkeeping every rewrite needs and no single pass should have to know about.
 * The pipeline runs over the *query part* of what it is handed - the pattern below a query's solution
 * modifiers, the `WHERE` of an update - whose variables are renamed under {@link VAR_PREFIX_USER_QUERY}
 * first, so that a mapping variable and a user variable of the same name cannot be unified by accident.
 * Everything standing over that part is rebuilt on top of the result, one rule per operation.
 *
 * **Which form the query has matters only at the top.** A `SELECT` gets its projection rebuilt over an
 * `EXTEND` per projected variable, restoring the name the user wrote; an `ASK` has no names to restore; a
 * `CONSTRUCT` template and the terms of a `DESCRIBE` name variables the pattern below binds, so they are
 * renamed along with it rather than restored.
 *
 * **An update's templates are left as they stand**, renamed and no more. Its `WHERE` reads the RDF 1.2
 * graph the mapping denotes and so is rewritten, but that graph is virtual and nothing can be written to
 * it: what the update inserts and deletes goes to the RDF 1.1 source, exactly as written.
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
   * Rewrites a query or update that is already in algebra form.
   * @param operation - The operation to rewrite
   * @returns the rewritten operation
   */
  rewriteOperation: (operation: Algebra.Operation) => Promise<Algebra.Operation>;
}

/**
 * Whether a GROUP node sits at the top of the operation's Extend / Filter / OrderBy chain.
 *
 * This matters for the projection rebuilding below: the extra outer EXTEND nodes it adds for variable
 * renaming must not be visible to `toAst`'s `translateAlgProject`, which flattens all Extend nodes, replaces
 * intermediate aggregate variables by their aggregate expressions, and pushes any unused one into the WHERE
 * clause - producing invalid SPARQL such as `BIND(COUNT(?o) AS ?count)`.
 * @param op - The operation to inspect
 * @returns whether the query groups, in which case the grouped sub-tree is wrapped in a subSELECT first
 */
function hasGroupInTopLevelChain(op: Algebra.Operation): boolean {
  if (op.type === Algebra.Types.GROUP) {
    return true;
  }
  if (
    op.type === Algebra.Types.EXTEND ||
    op.type === Algebra.Types.FILTER ||
    op.type === Algebra.Types.ORDER_BY
  ) {
    return hasGroupInTopLevelChain((<{ input: Algebra.Operation }>op).input);
  }
  return false;
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
 * Rebuilds the projection of a `SELECT` over the rewritten pattern, restoring the variable names the user
 * wrote.
 * @param c - The transformation context of this rewrite
 * @param project - The projection that was peeled off
 * @param rewritten - The rewritten pattern, binding the prefixed variables
 * @returns the projection, over an `EXTEND` per projected variable
 */
function rebuildProjection(
  c: TransformationContext,
  project: Algebra.Project,
  rewritten: Algebra.Operation,
): Algebra.Operation {
  let rebuilt = rewritten;
  // Because of the variable renaming, when we group,
  // we need to group as part of a subquery and then rename afterwards.
  if (hasGroupInTopLevelChain(rebuilt)) {
    rebuilt = c.AF.createProject(rebuilt, project.variables
      .map(variable => c.DF.variable(`${VAR_PREFIX_USER_QUERY}${variable.value}`)));
  }
  for (const variable of project.variables) {
    rebuilt = c.AF.createExtend(
      rebuilt,
      variable,
      c.AF.createTermExpression(c.DF.variable(`${VAR_PREFIX_USER_QUERY}${variable.value}`)),
    );
  }
  return c.AF.createProject(rebuilt, project.variables);
}

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
      return rebuildProjection(c, solutionModifier, rewritten);
    case Algebra.Types.CONSTRUCT:
      // The template names the variables the pattern binds, which are now the prefixed ones. Which name a
      // template variable carries is invisible in the triples it constructs, so renaming beats restoring.
      return c.AF.createConstruct(
        rewritten,
        prefixVarsInOperation(c, solutionModifier.template, VAR_PREFIX_USER_QUERY),
      );
    case Algebra.Types.DESCRIBE:
      // Same again: a described variable has to be one the rewritten query projects.
      return c.AF.createDescribe(
        rewritten,
        prefixVarsInOperation(c, solutionModifier.terms, VAR_PREFIX_USER_QUERY),
      );
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
 * Runs the pipeline over one query part, its variables renamed and the restrictions checked first.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param queryPart - The pattern of a query, or the `WHERE` of an update
 * @returns the rewritten query part, binding the prefixed variables
 * @throws Error if the query part asks something the rewriting is not defined for
 */
async function rewriteQueryPart(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  queryPart: Algebra.Operation,
): Promise<Algebra.Operation> {
  assertUserQueryIsSupported(queryPart);
  let rewritten = prefixVarsInOperation(c, queryPart, VAR_PREFIX_USER_QUERY);
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
  // The templates name the variables the WHERE binds, which are now the prefixed ones. What they write is
  // untouched otherwise: it goes to the source, the RDF 1.2 graph the WHERE read being virtual.
  const prefixTemplate = (template?: Algebra.Pattern[]): Algebra.Pattern[] | undefined =>
    template && prefixVarsInOperation(c, template, VAR_PREFIX_USER_QUERY);
  return c.AF.createDeleteInsert(
    prefixTemplate(deleteInsert.delete),
    prefixTemplate(deleteInsert.insert),
    rewrittenWhere,
  );
}

/**
 * Rewrites every query part of a parsed query or update, rebuilding what stands over each on top of the
 * result.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param operation - The parsed user query or update
 * @returns the rewritten query, modifiers and projected variable names as the user wrote them
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
 * @returns the rewriter
 * @example
 * const rewriter = createQueryRewriter([
 *   rewriteNonRecursivePathsTransformation(),
 *   unfoldingTransformation(mappingFromConstructQueries([ construct ])),
 *   filterFalseTransformation(),
 * ]);
 * const sparql11Query = await rewriter.rewriteQuery('SELECT * WHERE { ?s ?p ?o }');
 */
export function createQueryRewriter(transformations: readonly QueryTransformation[]): QueryRewriter {
  return {
    async rewriteQuery(query: string): Promise<string> {
      const c = createTransformationContext();
      const rewritten = await rewriteParsedQuery(c, transformations, parseQuery(c, query));
      return c.generator.generate(toAst(rewritten));
    },
    async rewriteOperation(operation: Algebra.Operation): Promise<Algebra.Operation> {
      return rewriteParsedQuery(createTransformationContext(), transformations, operation);
    },
  };
}

/**
 * The pipeline to reach for when you have no reason to build your own.
 *
 * The order is not a preference, it is what each step needs to see. Paths are expanded *before* the
 * unfolding, which only knows triple patterns. `FILTER(FALSE)` is collapsed after every step that can
 * produce one, so the next step has less to walk. The pushdown drives terms into the leaves and the
 * pull-up floats the binds it leaves behind back out, in that order, because the pushdown is what creates
 * them. `nullifyJoinOverIncompatibleBounds` comes last, after `removeProjections` and `pullUpExtends`: it
 * reads each join operand's top-level `EXTEND` chain and halts at a `PROJECT`, so anywhere earlier it sees
 * nothing at all.
 *
 * {@link transformations/nullifyUnbindableVars!nullifyUnbindableVars} is deliberately absent - nothing the
 * unfolding generates gives it anything to decide - and so are the blank node materialisations, which are
 * a choice about the data source rather than an optimisation.
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
