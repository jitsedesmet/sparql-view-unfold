import type * as RDF from '@rdfjs/types';
import { triplePositions } from '../datastructures/TermClusterSet.js';
import { rangeOfPosition } from '../RangeSet.js';
import type { RangedVar } from './RangedVar.js';

/**
 * Whether an object is an RDF term, i.e. has a `termType`.
 * @param obj - The object to check
 * @returns whether it is a term
 */
export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

/**
 * Whether an object is an RDF Quad (triple term).
 * @param obj - The object to check
 * @returns whether it is a quad, narrowed to `RDF.BaseQuad` - a `termType` tells nothing about the terms
 * its positions hold, and `RDF.BaseQuad` is the narrowing that works, `RDF.Quad` leaving it standing in the
 * negative branch where "not a triple term" is what the caller is after
 */
export function isRdfQuad(obj: object): obj is RDF.BaseQuad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

/**
 * Whether an object is an RDF Variable (potentially with range).
 * @param obj - The object to check
 * @returns whether it is a variable
 */
export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

/**
 * Whether a term is fully static, i.e. contains no variables, recursing into Quads.
 * @param term - The term to check
 * @returns whether it is variable-free
 */
export function termIsStaticTerm(term: RDF.Term): boolean {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}

/**
 * Whether a term is one a VALUES row can hold: an IRI, a literal, or a triple term of those that its positions
 * admit. Binding such a term cannot fail.
 * @param term - The term to check
 * @returns whether it is such a term
 */
export function termIsDataBlockValue(term: RDF.Term): term is RDF.NamedNode | RDF.Literal | RDF.Quad {
  if (term.termType === 'Quad') {
    return term.graph.termType === 'DefaultGraph' && triplePositions.every(position =>
      rangeOfPosition(position).has(term[position].termType) && termIsDataBlockValue(term[position]));
  }
  return term.termType === 'NamedNode' || term.termType === 'Literal';
}
