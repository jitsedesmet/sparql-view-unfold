/**
 * @fileoverview View unfolding and query optimisation for SPARQL 1.2.
 *
 * Rewrites a SPARQL 1.2 query posed over views into an equivalent query over the data those views are
 * defined on.
 *
 * A **mapping** is one or more SPARQL CONSTRUCT queries defining a view: the template (head) says which
 * triples the view holds, the WHERE clause (body) how they are found in the data. A **pipeline** of
 * transformations is then run over the user query, the first of which unfolds that mapping into every
 * triple pattern and the rest of which optimise what comes out.
 *
 * Running SPARQL 1.2 queries - triple terms and all - against RDF 1.1 data is the case this was built for:
 * a view then says how RDF 1.1 data represents RDF 1.2, and the rewrite hands back plain SPARQL 1.1.
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
