/**
 * @fileoverview View unfolding and query optimisation for SPARQL 1.2.
 *
 * Rewrites a SPARQL 1.2 query posed over views into an equivalent query over the data those views are
 * defined on.
 *
 * **Mappings** are SPARQL CONSTRUCT queries defining a view: the template (head) says which triples the
 * view holds, the WHERE clause (body) how they are found in the data. Each triple pattern of the user
 * query is then rewritten to a UNION of subselects, one per mapping that could produce matching data.
 *
 * Running SPARQL 1.2 queries - triple terms and all - against RDF 1.1 data is the case this was built for:
 * a view then says how RDF 1.1 data represents RDF 1.2, and the rewrite hands back plain SPARQL 1.1.
 * @module sparql-view-unfold
 * @see {@link https://w3c.github.io/rdf-interop/spec/} RDF 1.2 Interoperability Spec
 * @example
 * import { operationTransform, queryTransform, transformContextFromConstructs } from 'sparql-view-unfold';
 *
 * const context = transformContextFromConstructs([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... RDF 1.1 pattern ... }'
 * ]);
 * const rewrittenQuery =
 *   queryTransform(context, 'SELECT * WHERE { ?x rdf:reifies <<( ?s ?p ?o )>> }', [ operationTransform ]);
 */
export { operationTransform, queryTransform } from './transformBgp.js';
export { createPartialContext, transformContextFromConstructs } from './transformContext.js';
export type { TransformContext } from './transformContext.js';
export type { Mapping, MappingHead } from './types.js';
export { simplifyStaticExpressions } from './utils/staticExpressionEvaluation.js';
export * from './transformations/index.js';
