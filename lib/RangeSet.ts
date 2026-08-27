import type * as RDF from '@rdfjs/types';

/**
 * The term types a position or a variable may hold, ordered by set inclusion.
 * @example
 * const subjectRange = new RangeSet(['BlankNode', 'NamedNode']);
 * subjectRange.meet(objectRange); // RangeSet(['BlankNode', 'NamedNode'])
 */
export class RangeSet extends Set<RDF.Term['termType']> {
  /**
   * The term types this range and another both admit.
   * @param other - The range to meet with
   * @returns a new range holding their intersection
   */
  public meet(other: RangeSet): RangeSet {
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }
}

/** The term types the subject position of a triple admits: BlankNodes and NamedNodes. */
export const subjectRange = new RangeSet([ 'BlankNode', 'NamedNode' ]);

/** The term types the predicate position of a triple admits: NamedNodes only. */
export const predicateRange = new RangeSet([ 'NamedNode' ]);

/**
 * The term types the object position of a triple admits: Quads (triple terms), NamedNodes, BlankNodes and
 * Literals.
 *
 * Every term an RDF triple can hold anywhere occurs here, so this is the *top* of the lattice: the range of
 * something nothing is known about, and the value a missing entry stands for wherever ranges are stored per
 * variable or per group.
 */
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);

/**
 * The term types a graph name admits: NamedNodes and BlankNodes.
 *
 * The SPARQL grammar only allows an IRI to be written in a `GRAPH` clause, but a variable there (`GRAPH
 * ?g`) can still bind to a BlankNode graph name, so this cannot be narrowed to NamedNode.
 */
export const graphRange = new RangeSet([ 'NamedNode', 'BlankNode' ]);

/** Valid term types for a triple term, which only ever occupies an object position. */
export const tripleTermRange = new RangeSet([ 'Quad' ]);

/**
 * The term types the name of a `SERVICE` admits, where it is a variable.
 *
 * TODO: verify. Unlike every other range here this is an **assumption**, not something a spec states.
 */
export const serviceNameRange = new RangeSet([ 'NamedNode' ]);

/**
 * The range no term satisfies, the *bottom* of the lattice: a variable that provably never takes a value.
 *
 * Reached by narrowing two ranges with nothing in common - `?x` a Literal here and a NamedNode there -
 * which proves the operation binding it yields no solutions at all. Distinct from a variable that is simply
 * absent: bottom says the variable is in scope and never bound, where absent says it is not in scope. See
 * {@link utils/certainlyBoundVars!VRanges}.
 */
export const emptyRange = new RangeSet([]);

/**
 * The range of the position a triple term holds its component in.
 * @param position - The position to read
 * @returns the term types it admits
 */
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
