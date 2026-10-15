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
import { freshVarGenerator } from './utils.js';

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
  /** Every variable name in use in this rewrite, which every coined name is claimed against. */
  usedVariableNames: Set<string>;
  /**
   * Coins the variable a pattern that binds nothing projects, SPARQL having no sub-ASK and no empty
   * projection.
   */
  coinExistenceVariable: () => RDF.Variable;
  /**
   * How many triple terms deep an argument of `<internal://blank>` is encoded, since an expression cannot recurse.
   * A more deeply nested one leaves the node unbound.
   */
  tripleTermArgumentDepth: number;
}

/** What a rewrite configures of its {@link TransformationContext}. */
export type TransformationContextOptions = Partial<Pick<TransformationContext, 'tripleTermArgumentDepth'>>;

/**
 * Parses a SPARQL query or update string into its algebra representation, with blank nodes converted to
 * variables.
 *
 * A query is parsed out of quad mode, so that a `GRAPH` survives as an operation of its own rather than as
 * the graph component of every pattern below it, which is what lets the GRAPH rules of the passes see it at
 * all. An update has an algebra only in quad mode, so it gets one, and
 * {@link userQueryRestrictions!assertUserQueryIsSupported} reads the graph of each pattern instead.
 * @param context - Object containing the parser
 * @param query - SPARQL query or update string to parse
 * @param config - What to override of that, `quads` above all
 * @returns the parsed algebra operation
 */
export function parseQuery(
  { parser }: Pick<TransformationContext, 'parser'>,
  query: string,
  config: ContextConfigs = {},
): Algebra.Operation {
  const ast = parser.parse(query);
  return toAlgebra(ast, { quads: ast.type === 'update', blankToVariable: true, ...config });
}

/**
 * Creates a {@link TransformationContext} with a solver of its own, one rewrite's worth of state.
 * @param options - What to configure, a `tripleTermArgumentDepth` of 2 by default.
 * @returns the context
 * @throws Error if the `tripleTermArgumentDepth` is not a non-negative integer
 */
export function createTransformationContext(
  { tripleTermArgumentDepth = 2 }: TransformationContextOptions = {},
): TransformationContext {
  if (!Number.isInteger(tripleTermArgumentDepth) || tripleTermArgumentDepth < 0) {
    throw new Error(`The tripleTermArgumentDepth must be a non-negative integer, not ${tripleTermArgumentDepth}.`);
  }
  const DF = new DataFactory();
  const usedVariableNames = new Set<string>();
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraFactory(),
    DF,
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
    usedVariableNames,
    coinExistenceVariable: freshVarGenerator(usedVariableNames, 'mExists'),
    tripleTermArgumentDepth,
  };
}
