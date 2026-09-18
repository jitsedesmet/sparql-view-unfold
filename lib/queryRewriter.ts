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
import { solutionModifierChainOf } from './utils/solutionModifierChain.js';

/**
 * @fileoverview The pipeline runner: a list of {@link QueryTransformation}s applied to a query in order.
 *
 * Around that list sits the bookkeeping every rewrite needs and no single pass should have to know about.
 * The user query's variables are renamed under {@link VAR_PREFIX_USER_QUERY} before anything runs, so that
 * a mapping variable and a user variable of the same name cannot be unified by accident; the query's own
 * solution modifiers - {@link solutionModifierChainOf} - are peeled off first and rebuilt afterwards, one
 * rule per query form.
 *
 * **Which form the query has matters only at the top.** A `SELECT` gets its projection rebuilt over an
 * `EXTEND` per projected variable, restoring the name the user wrote; an `ASK` has no names to restore; a
 * `CONSTRUCT` template and the terms of a `DESCRIBE` name variables the pattern below binds, so they are
 * renamed along with it rather than restored. Updates never reach here, the precheck rejecting them.
 *
 * Every rewrite gets a {@link TransformationContext} of its own: the {@link ClusterSolver} in it is
 * stateful, and the pipeline is asynchronous, so two concurrent rewrites sharing one context would
 * interleave.
 */

/** A configured pipeline, ready to rewrite queries. */
export interface QueryRewriter {
  /**
   * Rewrites a SPARQL query string.
   * @param query - The query to rewrite
   * @returns the rewritten query
   */
  rewriteQuery: (query: string) => Promise<string>;
  /**
   * Rewrites a query that is already in algebra form.
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

/**
 * The operations that say what a query *answers with*. Exactly one of them is the query's own, and it ends
 * the chain: a `PROJECT` below it is a sub-SELECT, part of the pattern the pipeline rewrites.
 */
const queryFormTypes = new Set<string>([
  Algebra.Types.PROJECT,
  Algebra.Types.ASK,
  Algebra.Types.CONSTRUCT,
  Algebra.Types.DESCRIBE,
]);

/** The operations a query's solution-modifier chain can be made of, the query form among them. */
type SolutionModifier =
  Algebra.Ask | Algebra.Construct | Algebra.Describe | Algebra.Project |
  Algebra.Distinct | Algebra.Reduced | Algebra.Slice | Algebra.From;

/**
 * Splits a parsed query into the solution modifiers at its top and the pattern below them.
 * @param root - The parsed user query
 * @returns the modifiers, outermost first, and the pattern the pipeline runs over
 */
function peelSolutionModifiers(root: Algebra.Operation): {
  solutionModifiers: SolutionModifier[];
  pattern: Algebra.Operation;
} {
  const sealedChain = solutionModifierChainOf(root);
  const solutionModifiers: SolutionModifier[] = [];
  let iter = root;
  let reachedQueryForm = false;
  while (!reachedQueryForm && sealedChain.has(iter)) {
    solutionModifiers.push(<SolutionModifier> iter);
    reachedQueryForm = queryFormTypes.has(iter.type);
    iter = (<Algebra.Single> iter).input;
  }
  return { solutionModifiers, pattern: iter };
}

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
 * Runs the pipeline over the pattern of a query, rebuilding the solution modifiers it was peeled out of.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param operation - The parsed user query
 * @returns the rewritten query, modifiers and projected variable names as the user wrote them
 */
async function rewriteParsedQuery(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  operation: Algebra.Operation,
): Promise<Algebra.Operation> {
  assertUserQueryIsSupported(operation);

  const { solutionModifiers, pattern } = peelSolutionModifiers(operation);

  let rewritten = prefixVarsInOperation(c, pattern, VAR_PREFIX_USER_QUERY);
  for (const transformation of transformations) {
    rewritten = await transformation(c, rewritten);
  }

  // Innermost modifier first, so each is rebuilt over what its own input became.
  for (const solutionModifier of [ ...solutionModifiers ].reverse()) {
    // TODO: could we use a mapOperation instead? Maybe starting from:
    //  `new Transformer({continue: false, copy: false})
    //  .transformNode(continue on solution modifiers and perform their mapping)
    rewritten = rebuildSolutionModifier(c, solutionModifier, rewritten);
  }
  return rewritten;
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
