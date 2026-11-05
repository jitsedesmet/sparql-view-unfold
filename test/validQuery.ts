import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { QueryRewriter } from '../lib/queryRewriter.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import type { TransformationContext } from '../lib/transformContext.js';
import { createTransformationContext } from '../lib/transformContext.js';

type QueryCodec = Pick<TransformationContext, 'generator' | 'parser'>;

/**
 * Checks that a query is valid SPARQL by parsing it, which throws on, e.g., a `BIND` whose variable is in scope.
 * @param c - The context holding the parser
 * @param query - The query to check
 * @returns the query, unchanged
 */
export function assertValidQuery(c: Pick<QueryCodec, 'parser'>, query: string): string {
  c.parser.parse(query);
  return query;
}

/**
 * Generates the query of an operation and checks that it is valid SPARQL.
 * @param c - The context holding the generator and parser
 * @param operation - The operation to generate
 * @returns the generated query
 */
export function generateValidQuery(c: QueryCodec, operation: Algebra.Operation): string {
  return assertValidQuery(c, c.generator.generate(toAst(operation)));
}

/**
 * A {@link createQueryRewriter} whose `rewriteQuery` also checks that what it returns is valid SPARQL.
 * @param transformations - The pipeline to rewrite with
 * @param options - What to configure the context with
 * @returns the checking rewriter
 */
export function createValidatingQueryRewriter(
  ...[ transformations, options ]: Parameters<typeof createQueryRewriter>
): QueryRewriter {
  const rewriter = createQueryRewriter(transformations, options);
  const { parser } = createTransformationContext(options);
  return {
    ...rewriter,
    rewriteQuery: async query => assertValidQuery({ parser }, await rewriter.rewriteQuery(query)),
  };
}
