/* eslint-disable jsdoc/check-param-names */
import type * as RDF from '@rdfjs/types';
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { AlgebraTemplateFactory } from './AlgebraTemplateFactory.js';
import { ClusterSolver } from './ClusterSolver.js';
import { MyGenerator } from './generator/generator.js';
import type { Mapping, MappingHead } from './types.js';
import { certainlyBoundVariables } from './utils/certainlyBoundVars.js';
import { isRdfTerm } from './utils/typeGuards.js';
import { collectVariableNames } from './utils.js';

/**
 * The context object passed through all transformation operations.
 * Contains all necessary factories, parsers, and the active mappings.
 */
export interface TransformContext {
  /** SPARQL parser for parsing query strings */
  parser: Parser;
  /** SPARQL generator for converting algebra back to query strings */
  generator: Generator;
  /** Factory for creating AST nodes */
  astFactory: AstFactory;
  /** Extended algebra factory with template creation methods */
  AF: AlgebraTemplateFactory;
  /** RDF data factory for creating terms */
  DF: DataFactory;
  /** Transformer for traversing and modifying AST/algebra structures */
  astTransformer: AstTransformer;
  /** Solver for variable clustering and unification during rewriting */
  clusterSolver: ClusterSolver;
  /** The active mappings to apply during transformation */
  mapping: Mapping;
}

/**
 * Parses a SPARQL query string into algebra representation.
 * Enables quad mode and converts blank nodes to variables.
 * @param context - Object containing the parser
 * @param query - SPARQL query string to parse
 * @returns The parsed algebra operation
 */
export function parseQuery(
  { parser }: Pick<TransformContext, 'parser'>,
  query: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: true, blankToVariable: true });
}

/**
 * Prefixes all variable names in an operation with the given prefix.
 * Used to avoid variable name collisions when combining multiple patterns.
 * @param context - Object containing astTransformer and DF
 * @param obj - The object to transform
 * @param prefix - The prefix to add to all variable names
 * @returns The object with all variables prefixed
 */
export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformContext, 'astTransformer' | 'DF'>,
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
 * Prefixes all variables in a mapping (both head and body) with the given prefix.
 * @param c - Partial context with astTransformer and DF
 * @param mapping - The mapping to transform
 * @param prefix - The prefix to add (e.g., "m0_" for first mapper)
 * @returns A new mapping with all variables prefixed
 */
export function prefixMappingVars(
  c: Pick<TransformContext, 'astTransformer' | 'DF'>,
  mapping: Mapping,
  prefix: string,
): Mapping {
  return {
    head: prefixVarsInOperation(c, mapping.head, prefix),
    body: prefixVarsInOperation(c, mapping.body, prefix),
  };
}

/**
 * Converts a SPARQL CONSTRUCT query string into a Mapping object.
 *
 * The CONSTRUCT query must have exactly one triple in the template (head).
 * The WHERE clause becomes the mapping body, wrapped in a projection of
 * the variables used in the head. Since a CONSTRUCT only instantiates its
 * template when all of the template's variables are bound, a FILTER(BOUND(?x))
 * is added for every head variable that is not already certainly bound.
 *
 * @param context - Partial context with parser, AF, and astTransformer
 * @param constructQuery - SPARQL CONSTRUCT query string
 * @returns A Mapping with the template as head and WHERE clause as body
 * @throws Error if the construct has != 1 template triple
 * @throws Error if the head contains blank nodes
 * @throws Error if the body uses the BNODE() function
 */
export function constructToMapper(
  { parser, AF, astTransformer, DF }: Pick<TransformContext, 'parser' | 'AF' | 'astTransformer' | 'DF'>,
  constructQuery: string,
): Mapping {
  const construct = <Algebra.Construct> parseQuery({ parser }, constructQuery);
  if (construct.template.length !== 1) {
    throw new Error(`Mappers should have only a single mapping head, found ${construct.template.length}:
${JSON.stringify(construct.template, null, 2)}`);
  }
  const validPositions: [
    MappingHead['subject']['termType'][],
    MappingHead['predicate']['termType'][],
    MappingHead['object']['termType'][],
  ] = [[ 'Variable', 'NamedNode' ], [ 'Variable', 'NamedNode' ], [ 'NamedNode', 'Variable', 'Literal', 'Quad' ]];
  const template = construct.template[0];
  function checkQuadHeadValidity(quad: RDF.BaseQuad): void {
    const spoQuad = [ quad.subject, quad.predicate, quad.object ];
    for (const [ idx, toCheckTerm ] of spoQuad.entries()) {
      if (!(<string[]> validPositions[idx]).includes(toCheckTerm.termType)) {
        throw new Error(`Invalid Template, cannot use ${toCheckTerm.termType} in this position.`);
      }
      if (toCheckTerm.termType === 'Quad') {
        checkQuadHeadValidity(toCheckTerm);
      }
    }
  }
  checkQuadHeadValidity(template);
  const head: MappingHead = <MappingHead> AF.createPattern(template.subject, template.predicate, template.object);
  // Get used vars to create the proper projection
  const usedVars = collectVariableNames(astTransformer, head);
  // A CONSTRUCT only instantiates its template when every variable in that template is bound,
  // so solutions leaving a head variable unbound do not belong to the mapping.
  // Variables that are certainly bound already need no filter.
  const certainlyBound = certainlyBoundVariables(construct.input, { extendBinds: true });
  const mustBeBound = [ ...usedVars.keys() ].filter(name => !certainlyBound.has(name));
  const filteredInput = mustBeBound.length === 0 ?
    construct.input :
    AF.createFilter(construct.input, mustBeBound
      .map(name => AF.createOperatorExpression('bound', [ AF.createTermExpression(DF.variable(name)) ]))
      .reduce((acc, expr) => AF.createOperatorExpression('&&', [ acc, expr ])));
  const body = AF.createProject(filteredInput, [ ...usedVars.keys() ].map(x => DF.variable(x)));
  // Body should not call bnode function (you should not create blank nodes in mapping body)
  algebraUtils.visitOperationSub(body, {}, {
    expression: { operator: { visitor: (operatorExpression) => {
      if (operatorExpression.operator === 'bnode') {
        throw new Error('BNODE function cannot be used in mapping body');
      }
    } }},
    // Mapping body may contain any path
  });
  return {
    head,
    body,
  };
}

/**
 * Creates a partial TransformContext without mappers.
 * Used as a base for creating full contexts with different mapper configurations.
 * @returns A context object with all components except mappers
 */
export function createPartialContext(): Omit<TransformContext, 'mapping'> {
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraTemplateFactory(),
    DF: new DataFactory(),
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
  };
}

/**
 * Creates a complete TransformContext from an array of CONSTRUCT query strings.
 * Each CONSTRUCT query becomes a mapper with its variables prefixed (m0_, m1_, etc.).
 *
 * @param mappers - Array of SPARQL CONSTRUCT query strings defining the mappings
 * @returns A complete TransformContext ready for query transformation
 * @example
 * const context = transformContextFromConstructs([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... }',
 *   'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }'
 * ]);
 */
export function transformContextFromConstructs(mappers: readonly string[]): TransformContext {
  const c = createPartialContext();

  const manyMappings: Mapping[] = mappers.map(contr => prefixVarsInOperation(c, constructToMapper(c, contr), 'mi_'));
  if (manyMappings.length === 1) {
    // Console.log(manyMappings[0].head);
    // console.log(c.generator.generate(toAst(manyMappings[0].body), c));
    return {
      ...c,
      mapping: manyMappings[0],
    };
  }
  const vars = [ c.DF.variable('m_s'), c.DF.variable('m_p'), c.DF.variable('m_o') ];
  const [ varS, varP, varO ] = vars;

  const mappedBodies = manyMappings.map((mapping) => {
    const { head, body } = mapping;
    let newBody: Algebra.Operation = body;
    const curPos = [ head.subject, head.predicate, head.object ];
    for (const [ idx, headVar ] of vars.entries()) {
      newBody = c.AF.createExtend(newBody, headVar, c.AF.createTermExpression(curPos[idx]));
    }
    return newBody;
  });

  const mergedMapping: Mapping = {
    head: <MappingHead> c.AF.createPattern(varS, varP, varO),
    body: c.AF.createProject(c.AF.createUnion(mappedBodies), [ varS, varP, varO ]),
  };

  // Console.log(c.generator.generate(toAst(mergedMapping.body), c));

  return {
    mapping: mergedMapping,
    ...c,
  };
}
