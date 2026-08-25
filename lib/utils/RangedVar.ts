import type * as RDF from '@rdfjs/types';
import type { RangeSet } from '../RangeSet.js';

/**
 * A variable type extended with an optional range constraint.
 * The range specifies which term types are valid for this variable
 * based on its position in a triple pattern (subject, predicate, object).
 */
export type RangedVar = RDF.Variable & { range?: RangeSet };
