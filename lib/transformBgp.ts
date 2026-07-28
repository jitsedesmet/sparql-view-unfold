import type * as RDF from '@rdfjs/types';
import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/index.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import { collectVariableNames, renameVariables } from './utils.js';

/**
 * Returns true when a GROUP node exists at the top of the operation's
 * Extend / Filter / OrderBy chain.
 *
 * This matters for `queryTransform`: when the user query contains a GROUP BY,
 * extra outer EXTEND nodes added for variable renaming must not be visible to
 * `toAst`'s `translateAlgProject`. That function flattens all Extend nodes and
 * replaces intermediate aggregate variables (e.g. `var0`) with their aggregate
 * expressions. Any unused flattened Extend gets pushed into the WHERE clause via
 * `putExtensionsInGroup`, producing invalid SPARQL such as
 * `BIND(COUNT(?o) AS ?count)`.
 *
 * Wrapping the grouped sub-tree in a subSELECT (Project) before adding the outer
 * EXTEND renames isolates the aggregate from the outer scope and avoids the issue.
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
 * Transforms a SPARQL query by applying the configured mappings and transformations.
 *
 * This is the main entry point for query rewriting. It:
 * 1. Parses the input query
 * 2. Strips any outer DISTINCT/REDUCED modifier, then the Project
 * 3. Prefixes user query variables with "uq_"
 * 4. Applies each transformation in order
 * 5. Wraps the result with EXTEND operations to map back to original variable names
 * 6. Re-applies the Project and any stripped DISTINCT/REDUCED modifier
 * 7. Generates the output SPARQL string
 *
 * **GROUP BY queries**: when the user query contains a GROUP BY (detected by
 * `hasGroupInTopLevelChain`), the transformed algebra is first wrapped in a
 * subSELECT projecting the `uq_`-prefixed result variables. This prevents
 * `toAst` from incorrectly serialising aggregate alias Extend nodes as
 * `BIND(aggregate AS var)` in the WHERE clause.
 *
 * @param c - The transformation context containing mappings and factories
 * @param input - The SPARQL query string to transform
 * @param transformations - Array of transformation functions to apply in order
 * @returns The transformed SPARQL query string
 *
 * @example
 * const result = queryTransform(context, 'SELECT * WHERE { ?s ?p ?o }', [operationTransform]);
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
  transformedAlgebra = prefixVarsInOperation(c, transformedAlgebra, 'uq_');
  for (const transformation of transformations) {
    transformedAlgebra = transformation(c, transformedAlgebra);
  }

  if (innerAlgebra.type === 'project') {
    // Because of the variable renaming, when we group,
    // we need to group as part of a subquery and then rename afterwards.
    if (hasGroupInTopLevelChain(transformedAlgebra)) {
      const uqVariables = innerAlgebra.variables.map(v => c.DF.variable(`uq_${v.value}`));
      transformedAlgebra = c.AF.createProject(transformedAlgebra, uqVariables);
    }

    // Wrap the transformedAlgebra in extends to the originalVar names and project those
    for (const variable of innerAlgebra.variables) {
      transformedAlgebra = c.AF.createExtend(
        transformedAlgebra,
        variable,
        c.AF.createTermExpression(c.DF.variable(`uq_${variable.value}`)),
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
 * Rewrites a single BGP pattern and namespaces every internal (non user-query)
 * variable it introduces so that sibling patterns in the same BGP cannot collide.
 *
 * `rewriteSinglePattern` always produces the same internal variable names for a
 * given mapping (`m_s`, `m_o`, `mi_*`, unification vars, ...). When two patterns
 * of a BGP are joined, these internal variables — some of which are projected out
 * of the pattern's subselect and are therefore visible at the JOIN level — would
 * be unified across patterns, yielding incorrect (usually empty) results.
 *
 * User-query variables carry the `uq_` prefix and are the *only* variables that
 * are meant to be shared between patterns (they are the natural join keys). We
 * therefore rename every other variable with a per-pattern prefix, keeping the
 * rename consistent within the pattern's subtree so scoping is preserved.
 */
function rewritePatternWithUniqueScope(
  c: TransformContext,
  pattern: Algebra.Pattern,
  patternIndex: number,
): Algebra.Operation {
  const rewritten = rewriteSinglePattern(c, pattern, c.mapping);
  const renames: Record<string, RDF.Variable> = {};
  for (const name of collectVariableNames(c.astTransformer, rewritten)) {
    if (!name.startsWith('uq_')) {
      renames[name] = c.DF.variable(`p${patternIndex}_${name}`);
    }
  }
  return renameVariables(c, rewritten, renames);
}

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
