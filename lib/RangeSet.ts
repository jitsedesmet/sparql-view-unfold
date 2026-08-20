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
 *
 * Every term an RDF triple can hold anywhere occurs here, so this is the *top* of the lattice: the
 * range of something nothing is known about, and the value a missing entry stands for wherever ranges
 * are stored per variable or per group.
 */
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);

/**
 * Valid term types for the graph position of a quad.
 * Per RDF spec: graph names are NamedNodes or BlankNodes.
 *
 * The SPARQL grammar only allows an IRI to be written in a `GRAPH` clause, but a variable there
 * (`GRAPH ?g`) can still bind to a BlankNode graph name, so the range cannot be narrowed to NamedNode.
 */
export const graphRange = new RangeSet([ 'NamedNode', 'BlankNode' ]);

/** Valid term types for a triple term, which only ever occupies an object position. */
export const tripleTermRange = new RangeSet([ 'Quad' ]);

/**
 * Valid term types for the name of a `SERVICE`, where it is a variable.
 *
 * TODO: verify. Unlike every other range here this is an **assumption**, not something a spec states.
 */
export const serviceNameRange = new RangeSet([ 'NamedNode' ]);

/**
 * The range no term satisfies, the *bottom* of the lattice: a variable that provably never takes a
 * value. Reached by narrowing two ranges with nothing in common - `?x` a Literal here and a NamedNode
 * there - which proves the operation binding it yields no solutions at all.
 *
 * Distinct from a variable that is simply absent: bottom says the variable is in scope and never bound,
 * where absent says it is not in scope. See {@link VRanges}.
 */
export const emptyRange = new RangeSet([]);

/** The range of the position a triple term holds its component in. */
export function rangeOfPosition(position: 'object' | 'predicate' | 'subject'): RangeSet {
  switch (position) {
    case 'subject': {
      return subjectRange;
    }
    case 'predicate': {
      return predicateRange;
    }
    case 'object': {
      return objectRange;
    }
  }
}
