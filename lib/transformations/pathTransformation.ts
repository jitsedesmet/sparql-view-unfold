import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { termVars } from '../utils/certainlyBoundVars.js';
import { createFilterFalse, projectSolutionExistence } from '../utils/operationhelpers.js';

import { isRdfVar } from '../utils/typeGuards.js';
import { collectVariableNames, freshVarGenerator } from '../utils.js';

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
 * - **NPS** (`!(<p1>|<p2>)`): Negated property set (FILTER NOT IN), DISTINCT over subject and object
 * - **ZeroOrOne** (`path?`): UNION with empty match case, DISTINCT over subject and object
 *
 * Coined variables carry {@link VAR_PREFIX_USER_QUERY}, so the unfolding treats them as user query variables.
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
 * // ?s ex:knows ?uq_path_0 . ?uq_path_0 ex:name ?o
 *
 * @example
 * // ex:knows|ex:worksWith becomes:
 * // { ?s ex:knows ?o } UNION { ?s ex:worksWith ?o }
 */
export function rewriteNonRecursivePaths<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  const { AF, DF } = c;
  const fresh = freshVarGenerator(collectVariableNames(c.astTransformer, op), `${VAR_PREFIX_USER_QUERY}path_`);

  /**
   * Gives an expanded path set semantics: a DISTINCT projection onto the variables of its subject, object and graph.
   * @param operation - The expanded path
   * @param path - The path it expands
   * @returns the projection, or an existence check when there are no variables
   */
  function overSubjectAndObject(operation: Algebra.Operation, path: Algebra.Path): Algebra.Operation {
    const visible = [ ...new Set([ path.subject, path.object, path.graph ].flatMap(term => [ ...termVars(term) ])) ]
      .map(name => DF.variable(name));
    if (visible.length === 0) {
      return AF.createDistinct(projectSolutionExistence(c, operation));
    }
    return AF.createDistinct(AF.createProject(operation, visible));
  }

  /**
   * Binds a variable to every [node](https://www.w3.org/TR/sparql12-query/#defn_nodeSet) of the graph.
   * @param variable - The variable to bind
   * @param graph - The graph to read the nodes from
   * @returns the distinct nodes
   */
  function nodes(variable: RDF.Variable, graph: RDF.Term): Algebra.Operation {
    const predicate = fresh();
    const other = fresh();
    return AF.createDistinct(AF.createProject(
      AF.createUnion([
        AF.createBgp([ AF.createPattern(variable, predicate, other, graph) ]),
        AF.createBgp([ AF.createPattern(other, predicate, variable, graph) ]),
      ]),
      [ variable ],
    ));
  }

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
      let linkVar = fresh();
      const operations = [ resolvePathOp(pathOp.input[0], { ...path, object: linkVar }) ];
      for (const subOp of pathOp.input.slice(1, -1)) {
        const newLink = fresh();
        operations.push(resolvePathOp(subOp, { ...path, subject: linkVar, object: newLink }));
        linkVar = newLink;
      }
      operations.push(resolvePathOp(pathOp.input.at(-1)!, { ...path, subject: linkVar }));
      // Create a join of operations with n - 2 new variables to introduce
      return AF.createJoin(operations);
    }
    if (pathOp.type === Algebra.Types.NPS) {
      // https://www.w3.org/TR/sparql12-query/#eval_negatedPropertySet
      const predicate = fresh();
      return overSubjectAndObject(AF.createFilter(
        AF.createBgp([ AF.createPattern(subject, predicate, object, path.graph) ]),
        AF.createOperatorExpression('notin', [
          AF.createTermExpression(predicate),
          ...pathOp.iris.map(x => AF.createTermExpression(x)),
        ]),
      ), path);
    }
    // https://www.w3.org/TR/sparql12-query/#defn_evalPP_ZeroOrOnePath
    if (pathOp.type === Algebra.Types.ZERO_OR_ONE_PATH) {
      if (isRdfVar(subject) && isRdfVar(object)) {
        // The zero length match binds both to one node; a single shared variable needs no BIND.
        return overSubjectAndObject(AF.createUnion([
          resolvePathOp(pathOp.path, path),
          subject.equals(object) ?
            nodes(subject, path.graph) :
            AF.createExtend(nodes(subject, path.graph), object, AF.createTermExpression(subject)),
        ]), path);
      }
      if (!isRdfVar(subject) && !isRdfVar(object)) {
        if (subject.equals(object)) {
          return AF.createBgp([]);
        }
        return overSubjectAndObject(resolvePathOp(pathOp.path, path), path);
      }
      // Only one is a var, the other is term
      const [ variable, term ] =
        <[RDF.Variable, RDF.Term]> (isRdfVar(subject) ? [ subject, object ] : [ object, subject ]);
      return overSubjectAndObject(AF.createUnion([
        resolvePathOp(pathOp.path, path),
        AF.createExtend(AF.createBgp([]), variable, AF.createTermExpression(term)),
      ]), path);
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

/**
 * The pipeline step expanding every non-recursive property path into the BGPs and UNIONs the unfolding can read.
 * @returns the transformation
 */
export function rewriteNonRecursivePathsTransformation(): QueryTransformation {
  return rewriteNonRecursivePaths;
}
