import type * as RDF from '@rdfjs/types';
import type { Patch, Typed } from '@traqula/core';
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

/** Whether an object is the default graph. */
export function isRdfDefaultGraph(obj: object): obj is RDF.DefaultGraph {
  return isRdfTerm(obj) && obj.termType === 'DefaultGraph';
}

/** Whether an object is a Typed structure: a string `type`, and a string `subType` if present at all. */
export function isTyped(obj: object): obj is Typed {
  return 'type' in obj && typeof obj.type === 'string' && (
    !('subType' in obj) || typeof obj.subType === 'string'
  );
}

export type StaticTermPrimitive =
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
