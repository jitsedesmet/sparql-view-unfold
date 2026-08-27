/**
 * @fileoverview SPARQL Query Rewriting for RDF 1.2 over RDF 1.1.
 *
 * Rewrites SPARQL 1.2 queries - which may contain triple terms and other RDF 1.2 features - into equivalent
 * SPARQL 1.1 queries that can be executed against RDF 1.1 data sources.
 *
 * **Mappings** are SPARQL CONSTRUCT queries defining how RDF 1.2 data is represented in RDF 1.1: the
 * template (head) shows the RDF 1.2 pattern, the WHERE clause (body) the equivalent RDF 1.1
 * representation. Each triple pattern of the user query is then rewritten to a UNION of subselects, one per
 * mapping that could produce matching data.
 * @module query-rewriting-1-2
 * @see {@link https://w3c.github.io/rdf-interop/spec/} RDF 1.2 Interoperability Spec
 * @example
 * import { operationTransform, queryTransform, transformContextFromConstructs } from 'query-rewriting-1-2';
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
export * from './transformations/index.js';
