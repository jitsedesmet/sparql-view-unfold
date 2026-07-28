import { GeneratorBuilder } from '@traqula/core';
import { Generator, sparql12GeneratorBuilder } from '@traqula/generator-sparql-1-2';
import type { Query, SparqlGeneratorContext, Update } from '@traqula/rules-sparql-1-2';
import { datatypeBoolean, datatypeString } from '../utils/rdfDatatypes.js';

/**
 * @fileoverview Custom SPARQL generator with optimized literal output.
 *
 * This module provides a customized SPARQL generator that produces more
 * compact output for common literal patterns used in query rewriting:
 * - Boolean literals (`TRUE`, `FALSE`) are output without datatype annotation
 * - String literals are output without explicit xsd:string datatype
 */

/**
 * Custom rule for generating RDF literals with optimized output.
 * Produces shorter output for boolean and string literals.
 */
const literalRule = sparql12GeneratorBuilder.getRule('rdfLiteral');

const alternativeLiteralGenerator: typeof literalRule = {
  name: 'rdfLiteral',
  gImpl: $ => (ast, c) => {
    const type = ast.langOrIri;
    const value = ast.value.toUpperCase();
    if (typeof type === 'object' && type.value === datatypeBoolean.value && (
      value === 'TRUE' || value === 'FALSE'
    )) {
      c.astFactory.printFilter(ast, () => $.PRINT_WORD(value));
    } else if (typeof type === 'object' && type.value === datatypeString.value) {
      c.astFactory.printFilter(ast, () => $.PRINT_WORD('"', ast.value, '"'));
    } else {
      literalRule.gImpl($)(ast, c);
    }
  },
};

const ownGeneratorBuilder = GeneratorBuilder.create(sparql12GeneratorBuilder)
  .patchRule(alternativeLiteralGenerator);
type OwnGenerator = ReturnType<(typeof ownGeneratorBuilder)['build']>;

/**
 * Custom SPARQL 1.2 generator with optimized literal output.
 * Extends the standard generator to produce more compact SPARQL
 * for boolean and string literals commonly used in rewritten queries.
 */
export class MyGenerator extends Generator {
  private readonly myGenerator: OwnGenerator = ownGeneratorBuilder.build();

  /**
   * Generates a SPARQL query string from an AST.
   * @param ast - The query or update AST to generate
   * @param context - Optional generation context settings
   * @returns The generated SPARQL string
   */
  public override generate(ast: Query | Update, context?: Partial<SparqlGeneratorContext>): string {
    return this.myGenerator.queryOrUpdate(ast, { ...this.defaultContext, ...context });
  }
}
