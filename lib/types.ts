import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Patch } from '@traqula/core';
import type { TransformationContext } from './transformContext.js';

export type MappingHead = Patch<Algebra.Pattern, {
  subject: RDF.NamedNode | RDF.Variable;
  predicate: RDF.NamedNode | RDF.Variable;
  object: RDF.NamedNode | RDF.Variable | RDF.Literal | MappingHead;
}>;

/**
 * A mapping between Global and Sources.
 * Defined using SPARQL CONSTRUCT as a GAV expression.
 */
export interface Mapping {
  /** The template pattern to construct (single triple) */
  head: MappingHead;
  /** The projected query body pattern that matches source data */
  body: Algebra.Project;
}

/**
 * One step of a query rewriting pipeline: an operation in, the rewritten operation out.
 *
 * The runner awaits every step, so a synchronous pass is a `QueryTransformation` as it stands - only the
 * passes that call an engine (`simplifyStaticExpressions`) need the promise.
 */
export type QueryTransformation = (
  context: TransformationContext,
  operation: Algebra.Operation,
) => Algebra.Operation | Promise<Algebra.Operation>;
