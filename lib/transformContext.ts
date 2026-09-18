/* eslint-disable jsdoc/check-param-names */
import type * as RDF from '@rdfjs/types';
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra, ContextConfigs } from '@traqula/algebra-transformations-1-2';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { ClusterSolver } from './ClusterSolver.js';
import { MyGenerator } from './generator/generator.js';
import { isRdfTerm } from './utils/typeGuards.js';

/**
 * The factories and the solver every transformation works through.
 *
 * It holds no mapping: a mapping reaches the one pass that needs it through the closure
 * {@link transformations/unfolding!unfoldingTransformation} creates. It is built fresh per rewrite, the
 * {@link ClusterSolver} being stateful and the pipeline asynchronous.
 */
export interface TransformationContext {
  /** SPARQL parser for parsing query strings */
  parser: Parser;
  /** SPARQL generator for converting algebra back to query strings */
  generator: Generator;
  /** Factory for creating AST nodes */
  astFactory: AstFactory;
  /** Factory for creating algebra operations and expressions */
  AF: AlgebraFactory;
  /** RDF data factory for creating terms */
  DF: DataFactory;
  /** Transformer for traversing and modifying AST/algebra structures */
  astTransformer: AstTransformer;
  /** Solver for variable clustering and unification during rewriting */
  clusterSolver: ClusterSolver;
  /**
   * Coins the variable a pattern that binds nothing projects, SPARQL having no sub-ASK and no empty
   * projection. It is the one variable the unfolding lets out of a pattern's sub-SELECT, so every call
   * hands back a name no other pattern of this rewrite uses.
   */
  coinExistenceVariable: () => RDF.Variable;
}

/**
 * Parses a SPARQL query string into its algebra representation, with blank nodes converted to variables.
 *
 * Not in quad mode: a `GRAPH` then survives as an operation of its own rather than as the graph component
 * of every pattern below it, which is what lets the GRAPH rules of the passes - and the precheck of
 * {@link userQueryRestrictions!assertUserQueryIsSupported} - see it at all.
 * @param context - Object containing the parser
 * @param query - SPARQL query string to parse
 * @param quads - Whether to parse in quad mode, every pattern carrying its graph
 * @returns the parsed algebra operation
 */
export function parseQuery(
  { parser }: Pick<TransformationContext, 'parser'>,
  query: string,
  config: ContextConfigs,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: false, blankToVariable: true, ...config });
}

/**
 * Prefixes all variable names in an operation, so that patterns combined later cannot collide.
 * @param context - Object containing astTransformer and DF
 * @param obj - The object to transform
 * @param prefix - The prefix to add to all variable names
 * @returns the object with all variables prefixed
 */
export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformationContext, 'astTransformer' | 'DF'>,
  obj: T,
  prefix: string,
): T {
  return <T> astTransformer.transformObject(obj, (obj) => {
    if (isRdfTerm(obj) && obj.termType === 'Variable') {
      return DF.variable(prefix + (obj).value);
    }
    // Values.bindings uses string keys for variable names — rename those too.
    if ('type' in obj && obj.type === 'values' && 'bindings' in obj) {
      const valuesOp = <Algebra.Values> obj;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ prefix + key, value ]),
      ));
    }
    return obj;
  });
}

/**
 * Creates a {@link TransformationContext} with a solver of its own, one rewrite's worth of state.
 * @returns the context
 */
export function createTransformationContext(): TransformationContext {
  const DF = new DataFactory();
  let existenceVariablesCoined = 0;
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraFactory(),
    DF,
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
    // Since we prefix with `m` we know it will not name-clash
    coinExistenceVariable: () => DF.variable(`mExists${existenceVariablesCoined++}`),
  };
}
