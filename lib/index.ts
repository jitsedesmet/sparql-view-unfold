/**
 * @fileoverview SPARQL Query Rewriting for RDF 1.2 over RDF 1.1.
 *
 * Rewrites SPARQL 1.2 queries - which may contain triple terms and other RDF 1.2 features - into equivalent
 * SPARQL 1.1 queries that can be executed against RDF 1.1 data sources.
 *
 * A **mapping** is one or more SPARQL CONSTRUCT queries: the template (head) shows the RDF 1.2 pattern, the
 * WHERE clause (body) the equivalent RDF 1.1 representation. A **pipeline** of transformations is then run
 * over the user query, the first of which unfolds that mapping into every triple pattern and the rest of
 * which optimise what comes out.
 * @module sparql-view-unfold
 * @see {@link https://w3c.github.io/rdf-interop/spec/} RDF 1.2 Interoperability Spec
 * @example
 * import {
 *   createQueryRewriter,
 *   filterFalseTransformation,
 *   mappingFromConstructQueries,
 *   unfoldingTransformation,
 * } from 'sparql-view-unfold';
 *
 * const rewriter = createQueryRewriter([
 *   unfoldingTransformation(mappingFromConstructQueries([
 *     'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... RDF 1.1 pattern ... }',
 *   ])),
 *   filterFalseTransformation(),
 * ]);
 * const sparql11Query = await rewriter.rewriteQuery('SELECT * WHERE { ?x rdf:reifies <<( ?s ?p ?o )>> }');
 */
export * from './consts.js';
export { mappingFromConstructQueries } from './mapping.js';
export type { MappingOptions } from './mapping.js';
export { createDefaultTransformationPipeline, createQueryRewriter } from './queryRewriter.js';
export type { QueryRewriter } from './queryRewriter.js';
export type { TransformationContext } from './transformContext.js';
export type { Mapping, MappingHead, QueryTransformation } from './types.js';
export * from './transformations/index.js';
