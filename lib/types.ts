import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Patch } from '@traqula/core';

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
