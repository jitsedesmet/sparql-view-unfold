import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { unifyTerms } from '../utils/assertions.js';
import { termVars } from '../utils/certainlyBoundVars.js';
import { bindAssertedTerms, createFilterFalse, projectSolutionExistence } from '../utils/operationhelpers.js';
import { termIsStaticTerm } from '../utils/typeGuards.js';
import { freshVarGenerator, markVariableNamesUsed } from '../utils.js';

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
 * - **ZeroOrOne** (`path?`): UNION with the zero length match, DISTINCT over subject and object
 *
 * Coined variables are claimed against the names in use, and unfold as any other user query variable.
 * A path inside a `SERVICE` is left to its endpoint, the unfolding leaving that pattern as it stands.
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
 * // ?s ex:knows ?path_0 . ?path_0 ex:name ?o
 *
 * @example
 * // ex:knows|ex:worksWith becomes:
 * // { ?s ex:knows ?o } UNION { ?s ex:worksWith ?o }
 */
export function rewriteNonRecursivePaths<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  const { AF, DF } = c;
  const fresh = freshVarGenerator(markVariableNamesUsed(c, op), 'path_');

  /**
   * Gives an expanded path set semantics: a DISTINCT projection onto the variables of its subject, object and graph.
   * @param operation - The expanded path
   * @param path - The path it expands
   * @returns the projection, or an existence check when there are no variables
   */
  function overSubjectAndObject(operation: Algebra.Operation, path: Algebra.Path): Algebra.Operation {
    const visible = variablesOf(path.subject, path.object, path.graph);
    if (visible.length === 0) {
      return AF.createDistinct(projectSolutionExistence(c, operation));
    }
    return AF.createDistinct(AF.createProject(operation, visible));
  }

  /**
   * Matches a term against every [node](https://www.w3.org/TR/sparql12-query/#defn_nodeSet) of the graph.
   * @param term - The variable or triple pattern to match
   * @param graph - The graph to read the nodes from
   * @returns the distinct bindings of the term's variables
   */
  function nodes(term: RDF.Term, graph: RDF.Term): Algebra.Operation {
    const predicate = fresh();
    const other = fresh();
    const asObject = AF.createBgp([ AF.createPattern(other, predicate, term, graph) ]);
    // A triple term is never a subject.
    const matches = term.termType === 'Quad' ?
      asObject :
      AF.createUnion([ AF.createBgp([ AF.createPattern(term, predicate, other, graph) ]), asObject ]);
    return AF.createDistinct(AF.createProject(matches, variablesOf(term)));
  }

  /**
   * The variables of some terms, each once.
   * @param terms - The terms to read
   * @returns their variables, in the order the terms hold them
   */
  function variablesOf(...terms: RDF.Term[]): RDF.Variable[] {
    return [ ...new Set(terms.flatMap(term => [ ...termVars(term) ])) ].map(name => DF.variable(name));
  }

  /**
   * The [zero length match](https://www.w3.org/TR/sparql12-query/#defn_evalPP_ZeroOrOnePath) of a path, generalised
   * to triple pattern endpoints: the unified endpoints, ranging over the nodes of the graph unless unification
   * grounds them.
   * @param path - The path whose endpoints to unify
   * @returns the match, or `undefined` when the endpoints never denote one term
   */
  function zeroLengthMatch(path: Algebra.Path): Algebra.Operation | undefined {
    const unification = unifyTerms(path.subject, path.object);
    if (unification === undefined) {
      return undefined;
    }
    const { unifier, unified } = unification;
    return bindAssertedTerms(c, termIsStaticTerm(unified) ? AF.createBgp([]) : nodes(unified, path.graph), unifier);
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
    if (pathOp.type === Algebra.Types.ZERO_OR_ONE_PATH) {
      // Equal ground endpoints: the zero length match is the one solution the path can give.
      if (termIsStaticTerm(subject) && subject.equals(object)) {
        return AF.createBgp([]);
      }
      const oneLength = resolvePathOp(pathOp.path, path);
      const zeroLength = zeroLengthMatch(path);
      return overSubjectAndObject(zeroLength ? AF.createUnion([ oneLength, zeroLength ]) : oneLength, path);
    }
    // If (pathOp.type === 'ZeroOrMorePath' || pathOp.type === 'OneOrMorePath') {
    // Throw new Error('Cannot transform recursive paths');
    return AF.createPath(subject, pathOp, object, path.graph);
    // }
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.PATH]: { transform: pathOp => resolvePathOp(pathOp.predicate, pathOp) },
      [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    },
  );
}

/**
 * The pipeline step expanding every non-recursive property path outside a `SERVICE` into the BGPs and UNIONs
 * the unfolding can read.
 * @returns the transformation
 */
export function rewriteNonRecursivePathsTransformation(): QueryTransformation {
  return rewriteNonRecursivePaths;
}
