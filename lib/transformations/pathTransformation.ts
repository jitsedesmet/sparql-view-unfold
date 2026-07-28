import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse } from '../utils/operationhelpers.js';

import { isRdfVar } from '../utils/typeGuards.js';

/**
 * Counter for generating unique variable names during path rewriting.
 */
let counter = 0;

/**
 * Transformation that rewrites non-recursive property paths into equivalent BGPs and UNIONs.
 *
 * Property paths in SPARQL (like `ex:knows/ex:name` or `ex:knows|ex:worksWith`) are
 * syntactic sugar for more complex patterns. This transformation expands them into
 * their equivalent algebraic form, which is necessary because the mapping-based
 * rewriting operates on individual triple patterns.
 *
 * ## Supported Path Types:
 * - **Link** (`<predicate>`): Simple triple pattern
 * - **Alt** (`path1|path2`): UNION of alternatives
 * - **Seq** (`path1/path2`): JOIN with intermediate variables
 * - **Inv** (`^path`): Swaps subject and object
 * - **NPS** (`!(<p1>|<p2>)`): Negated property set (FILTER NOT IN)
 * - **ZeroOrOne** (`path?`): UNION with empty match case
 *
 * ## Not Fully Supported:
 * - **ZeroOrMore** (`path*`): Returns original (recursive, cannot be fully expanded)
 * - **OneOrMore** (`path+`): Returns original (recursive, cannot be fully expanded)
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with paths expanded
 *
 * @example
 * // ex:knows/ex:name becomes:
 * // ?s ex:knows ?linkvar_0 . ?linkvar_0 ex:name ?o
 *
 * @example
 * // ex:knows|ex:worksWith becomes:
 * // { ?s ex:knows ?o } UNION { ?s ex:worksWith ?o }
 */
export function rewriteNonRecursivePaths<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;

  function resolvePathOp(pathOp: Algebra.PropertyPathSymbol, path: Algebra.Path): Algebra.Operation {
    const { subject, object } = path;
    if (pathOp.type === Algebra.Types.ALT) {
      return AF.createUnion(pathOp.input.map(x => resolvePathOp(x, path)));
    }
    if (pathOp.type === Algebra.Types.LINK) {
      return AF.createBgp([ AF.createPattern(subject, pathOp.iri, object, path.graph) ]);
    }
    if (pathOp.type === Algebra.Types.INV) {
      const switchPath = {
        ...path,
        subject: object,
        object: subject,
      };
      return resolvePathOp(pathOp.path, switchPath);
    }
    if (pathOp.type === Algebra.Types.SEQ) {
      if (pathOp.input.length === 0) {
        return createFilterFalse(c);
      }
      if (pathOp.input.length === 1) {
        return resolvePathOp(pathOp.input[0], path);
      }
      let linkVar = DF.variable(`linkvar_${counter++}`);
      const operations = [ resolvePathOp(pathOp.input[0], { ...path, object: linkVar }) ];
      for (const subOp of pathOp.input.slice(1, -1)) {
        const newLink = DF.variable(`linkvar_${counter++}`);
        operations.push(resolvePathOp(subOp, { ...path, subject: linkVar, object: newLink }));
        linkVar = newLink;
      }
      operations.push(resolvePathOp(pathOp.input.at(-1)!, { ...path, subject: linkVar }));
      // Create a join of operations with n - 2 new variables to introduce
      return AF.createJoin(operations);
    }
    if (pathOp.type === Algebra.Types.NPS) {
      // https://www.w3.org/TR/sparql12-query/#eval_negatedPropertySet
      const predicate = DF.variable(`rewrite_${counter++}`);
      return AF.createFilter(
        AF.createPattern(subject, predicate, object, path.graph),
        AF.createOperatorExpression('notin', [
          AF.createTermExpression(predicate),
          ...pathOp.iris.map(x => AF.createTermExpression(x)),
        ]),
      );
    }
    // https://www.w3.org/TR/sparql12-query/#defn_evalPP_ZeroOrOnePath
    if (pathOp.type === Algebra.Types.ZERO_OR_ONE_PATH) {
      if (isRdfVar(subject) && isRdfVar(object)) {
        // Both are var
        return AF.createUnion([
          resolvePathOp(pathOp.path, path),
          AF.createExtend(
            // Nodes implementation: https://www.w3.org/TR/sparql12-query/#defn_nodeSet
            AF.createDistinct(AF.createProject(
              AF.createUnion([
                AF.createBgp([ AF.createPattern(
                  subject,
                  DF.variable(`p_${subject.value}`),
                  DF.variable(`o_${subject.value}`),
                  path.graph,
                ) ]),
                AF.createBgp([ AF.createPattern(
                  DF.variable(`o_${subject.value}`),
                  DF.variable(`p_${subject.value}`),
                  subject,
                  path.graph,
                ) ]),
              ]),
              [ subject ],
            )),
            object,
            AF.createTermExpression(subject),
          ),
        ]);
      }
      if (!isRdfVar(subject) && !isRdfVar(object)) {
        if (subject.equals(object)) {
          return AF.createBgp([]);
        }
        return resolvePathOp(pathOp.path, path);
      }
      // Only one is a var, the other is term
      const [ variable, term ] =
        <[RDF.Variable, RDF.Term]> (isRdfVar(subject) ? [ subject, object ] : [ object, subject ]);
      return AF.createUnion([
        resolvePathOp(pathOp.path, path),
        AF.createExtend(AF.createBgp([]), variable, AF.createTermExpression(term)),
      ]);
    }
    // If (pathOp.type === 'ZeroOrMorePath' || pathOp.type === 'OneOrMorePath') {
    // Throw new Error('Cannot transform recursive paths');
    return AF.createPath(subject, pathOp, object, path.graph);
    // }
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { path: { transform: pathOp => resolvePathOp(pathOp.predicate, pathOp) }},
  );
}
