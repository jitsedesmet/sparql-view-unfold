import type * as RDF from '@rdfjs/types';
import type { Patch } from '@traqula/core';
import type { RangedVar } from './RangedVar.js';

/** Whether an object is an RDF term, i.e. has a `termType`. */
export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

/** Whether an object is an RDF Quad (triple term). */
export function isRdfQuad(obj: object): obj is RDF.Quad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

/** Whether an object is an RDF Variable (potentially with range). */
export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

type StaticTermPrimitive =
    | Exclude<RDF.Term, RDF.Quad | RDF.Variable>
    | Patch<RDF.Quad, {
      subject: Exclude<RDF.Quad['subject'], RDF.Variable>;
      predicate: Exclude<RDF.Quad['predicate'], RDF.Variable>;
      object: Exclude<RDF.Quad['object'], RDF.Variable>;
      graph: Exclude<RDF.Quad['graph'], RDF.Variable>;
    }>;

/** Whether a term is fully static, i.e. contains no variables, recursing into Quads. */
export function termIsStaticTerm(term: RDF.Term): term is StaticTermPrimitive {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}
