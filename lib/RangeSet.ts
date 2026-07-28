import type * as RDF from '@rdfjs/types';

/**
 * A set of RDF term types that represents valid types for a position.
 * Supports computing the disjunction (intersection) of two ranges.
 *
 * @example
 * const subjectRange = new RangeSet(['BlankNode', 'NamedNode']);
 * const objectRange = new RangeSet(['Quad', 'NamedNode', 'BlankNode', 'Literal']);
 * const combined = subjectRange.disjunct(objectRange);
 * // Result: ['BlankNode', 'NamedNode']
 */
export class RangeSet extends Set<RDF.Term['termType']> {
  /**
   * Computes the intersection of this range with another range.
   * Returns a new RangeSet containing only term types present in both sets.
   * @param other - The other RangeSet to intersect with
   * @returns A new RangeSet with the intersection of term types
   */
  public disjunct(other: RangeSet): RangeSet {
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }
}

/**
 * Valid term types for the subject position of a triple.
 * Per RDF spec: subjects can be BlankNodes or NamedNodes.
 */
export const subjectRange = new RangeSet([ 'BlankNode', 'NamedNode' ]);

/**
 * Valid term types for the predicate position of a triple.
 * Per RDF spec: predicates can only be NamedNodes.
 */
export const predicateRange = new RangeSet([ 'NamedNode' ]);

/**
 * Valid term types for the object position of a triple.
 * Per RDF spec: objects can be Quads (triple terms), NamedNodes, BlankNodes, or Literals.
 */
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);
