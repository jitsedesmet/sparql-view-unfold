import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from './consts.js';
import { rewriteSinglePattern } from './transformations/index.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import { collectVariableNames, renameVariables } from './utils.js';

/**
 * Whether a GROUP node sits at the top of the operation's Extend / Filter / OrderBy chain.
 *
 * This matters for {@link queryTransform}: the extra outer EXTEND nodes it adds for variable renaming must
 * not be visible to `toAst`'s `translateAlgProject`, which flattens all Extend nodes, replaces intermediate
 * aggregate variables by their aggregate expressions, and pushes any unused one into the WHERE clause -
 * producing invalid SPARQL such as `BIND(COUNT(?o) AS ?count)`.
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
 * Transforms a SPARQL query by applying the configured mappings and transformations - the main entry point
 * for query rewriting.
 *
 * It parses the query, strips any outer DISTINCT/REDUCED and the Project, prefixes the user query variables
 * with `uq_`, applies each transformation in order, and then wraps the result back up: an EXTEND per
 * original variable name, the Project, and the stripped modifier.
 * @param c - The transformation context containing the mapping and the factories
 * @param input - The SPARQL query string to transform
 * @param transformations - Transformation functions to apply in order
 * @returns the transformed SPARQL query string
 * @example
 * const result = queryTransform(context, 'SELECT * WHERE { ?s ?p ?o }', [ operationTransform ]);
 */
export function queryTransform(
  c: TransformContext,
  input: string,
  transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[],
): string {
  const algebra = parseQuery(c, input);

  // Peel off a DISTINCT or REDUCED modifier so we can reach the inner Project.
  // SELECT DISTINCT/REDUCED produce Distinct/Reduced(Project(...)) in the algebra.
  const isDistinct = algebra.type === 'distinct';
  const isReduced = algebra.type === 'reduced';
  const innerAlgebra: Algebra.Operation = (isDistinct || isReduced) ? algebra.input : algebra;

  let transformedAlgebra = innerAlgebra;
  if (innerAlgebra.type === 'project') {
    transformedAlgebra = innerAlgebra.input;
  }
  transformedAlgebra = prefixVarsInOperation(c, transformedAlgebra, VAR_PREFIX_USER_QUERY);
  for (const transformation of transformations) {
    transformedAlgebra = transformation(c, transformedAlgebra);
  }

  if (innerAlgebra.type === 'project') {
    // Because of the variable renaming, when we group,
    // we need to group as part of a subquery and then rename afterwards.
    if (hasGroupInTopLevelChain(transformedAlgebra)) {
      const uqVariables = innerAlgebra.variables
        .map(v => c.DF.variable(`${VAR_PREFIX_USER_QUERY}${v.value}`));
      transformedAlgebra = c.AF.createProject(transformedAlgebra, uqVariables);
    }

    // Wrap the transformedAlgebra in extends to the originalVar names and project those
    for (const variable of innerAlgebra.variables) {
      transformedAlgebra = c.AF.createExtend(
        transformedAlgebra,
        variable,
        c.AF.createTermExpression(c.DF.variable(`${VAR_PREFIX_USER_QUERY}${variable.value}`)),
      );
    }
    transformedAlgebra = c.AF.createProject(transformedAlgebra, innerAlgebra.variables);
  }

  if (isDistinct) {
    transformedAlgebra = c.AF.createDistinct(transformedAlgebra);
  } else if (isReduced) {
    transformedAlgebra = c.AF.createReduced(transformedAlgebra);
  }

  const transformedAst = toAst(transformedAlgebra);
  return c.generator.generate(transformedAst);
}

/**
 * Rewrites a single BGP pattern and namespaces every internal (non user-query) variable it introduces, so
 * that sibling patterns in the same BGP cannot collide.
 *
 * {@link rewriteSinglePattern} always produces the same internal variable names for a given mapping, and
 * some of them are projected out of the pattern's subselect and so visible at the JOIN level - where they
 * would be unified across patterns, yielding incorrect (usually empty) results. Only the `uq_` variables
 * are meant to be shared between patterns, being the natural join keys.
 * @param c - The transformation context
 * @param pattern - The pattern to rewrite
 * @param patternIndex - The index that namespaces this pattern's internal variables
 * @returns the rewritten pattern
 */
function rewritePatternWithUniqueScope(
  c: TransformContext,
  pattern: Algebra.Pattern,
  patternIndex: number,
): Algebra.Operation {
  const rewritten = rewriteSinglePattern(c, pattern, c.mapping);
  const renames: Record<string, RDF.Variable> = {};
  for (const name of collectVariableNames(c.astTransformer, rewritten)) {
    if (!name.startsWith(VAR_PREFIX_USER_QUERY)) {
      renames[name] = c.DF.variable(`p${patternIndex}_${name}`);
    }
  }
  return renameVariables(c, rewritten, renames);
}

/**
 * Rewrites every BGP of an operation into a join of its unfolded patterns.
 * @param c - The transformation context
 * @param input - The operation to rewrite
 * @returns the rewritten operation
 */
export function operationTransform(c: TransformContext, input: Algebra.Operation): Algebra.Operation {
  // Counter shared across every BGP of the query so that the internal variables of
  // distinct pattern rewrites never collide — not even across sibling BGPs that are
  // later combined by a JOIN/LEFT JOIN (e.g. a pattern and an OPTIONAL block).
  let patternCounter = 0;
  const transformed = algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Algebra.Types.BGP]: { transform: input =>
      c.AF.createJoin(
        input.patterns.map(pattern => rewritePatternWithUniqueScope(c, pattern, patternCounter++)),
        true,
      ),
    }},
  );
  return transformed;
}
