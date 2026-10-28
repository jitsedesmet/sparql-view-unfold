import type * as RDF from '@rdfjs/types';
import { isSubsetOf } from './utils/setUtils.js';

/**
 * The term types a position or a variable may hold, ordered by set inclusion. A range is not changed once built,
 * so one can be shared.
 * @example
 * const subjectRange = new RangeSet(['BlankNode', 'NamedNode']);
 * subjectRange.meet(objectRange); // RangeSet(['BlankNode', 'NamedNode'])
 */
export class RangeSet extends Set<RDF.Term['termType']> {
  /** Whether the range is built, after which it is never changed. */
  private readonly built: boolean;

  /**
   * @param termTypes - The term types the range holds
   */
  public constructor(termTypes?: Iterable<RDF.Term['termType']>) {
    super(termTypes);
    this.built = true;
  }

  public override add(termType: RDF.Term['termType']): this {
    if (this.built) {
      throw new Error('A range is not changed once built');
    }
    return super.add(termType);
  }

  public override delete(): boolean {
    throw new Error('A range is not changed once built');
  }

  public override clear(): void {
    throw new Error('A range is not changed once built');
  }

  /**
   * The term types this range and another both admit.
   * @param other - The range to meet with
   * @returns their intersection, which is one of the two where it narrows the other
   */
  public meet(other: RangeSet): RangeSet {
    if (isSubsetOf(this, other)) {
      return this;
    }
    if (isSubsetOf(other, this)) {
      return other;
    }
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }

  /**
   * The term types any of some ranges admits.
   * @param ranges - The ranges to join
   * @returns a new range holding their union
   */
  public static join(ranges: Iterable<RangeSet>): RangeSet {
    return new RangeSet([ ...ranges ].flatMap(range => [ ...range ]));
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

/** The term types of a literal: Literals only. */
export const literalRange = new RangeSet([ 'Literal' ]);

/** The term types of an IRI: NamedNodes only. */
export const iriRange = new RangeSet([ 'NamedNode' ]);

/** The term types of a blank node: BlankNodes only. */
export const blankNodeRange = new RangeSet([ 'BlankNode' ]);

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
 * The range of one term type.
 * @param termType - The term type
 * @returns the range holding only that term type
 */
export function rangeOfTermType(termType: RDF.Term['termType']): RangeSet {
  switch (termType) {
    case 'NamedNode': {
      return iriRange;
    }
    case 'Literal': {
      return literalRange;
    }
    case 'BlankNode': {
      return blankNodeRange;
    }
    case 'Quad': {
      return tripleTermRange;
    }
    default: {
      return new RangeSet([ termType ]);
    }
  }
}

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

/**
 * The term types a SPARQL condition names with a predicate of its own, and so the ones an assertion can be
 * about. `isNUMERIC` is not one: it asks after the datatype of a literal rather than after a kind of term.
 */
export type AssertableTermType = 'BlankNode' | 'Literal' | 'NamedNode' | 'Quad';

/** The predicate a condition states a term type with, which is also how one is written back. */
export const termTypePredicates: Readonly<Record<AssertableTermType, string>> = {
  NamedNode: 'isiri',
  BlankNode: 'isblank',
  Literal: 'isliteral',
  Quad: 'istriple',
};

/** The term types, in the order a term type test writes them, so that one range is always written one way. */
export const assertableTermTypes = <AssertableTermType[]> Object.keys(termTypePredicates);

/**
 * The term type a predicate states, `isURI` reading as the `isIRI` it is a synonym of.
 * @param operator - The operator of a unary condition
 * @returns the term type it states, or `undefined` for anything that is not one of them
 */
export function asAssertableTermType(operator: string): AssertableTermType | undefined {
  const termAssertion = operator === 'isuri' ? 'isiri' : operator;
  return assertableTermTypes.find(termType => termTypePredicates[termType] === termAssertion);
}
