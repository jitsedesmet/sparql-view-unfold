import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { IRI_BOUND_BNODE_ARGUMENT, IRI_UNBOUND_BNODE_ARGUMENT } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { DF } from '../utils/rdfDatatypes.js';
import type { InternalBnodeMaterialisation } from './internalBnodeMaterialisation.js';
import { holdsInternalBnodeOrIsBlank, isInternalBnode } from './internalBnodeMaterialisation.js';

/**
 * @fileoverview Prepares internal blank nodes to be computed by an extension function of the engine, like the ones
 * of {@link comunica!internalBnodeAsSpecialIriExtensionFunctions}, rather than spelled out in SPARQL.
 */

/** Subject and predicate of the triple term an argument that evaluates arrives wrapped in. */
export const boundArgumentMarker = DF.namedNode(IRI_BOUND_BNODE_ARGUMENT);

/** What an argument that is unbound or errors arrives as. */
export const unboundArgumentMarker = DF.namedNode(IRI_UNBOUND_BNODE_ARGUMENT);

/**
 * Wraps each argument `e` of `<internal://blank>` as `COALESCE(TRIPLE(<…argument>, <…argument>, e), <…unbound>)`, since
 * an engine errors the call when an argument errors. A value then arrives as a triple term, an unbound or erroring
 * argument as an IRI no value is wrapped as.
 * @param c - The transformation context.
 * @param op - The operation to transform.
 * @param materialisation - What the internal blank nodes become, which `ISBLANK` is rewritten to recognise.
 * @returns The operation, for the matching extension function to evaluate.
 */
export function internalBnodeAsExtensionFunction<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  materialisation: InternalBnodeMaterialisation,
): T {
  if (!holdsInternalBnodeOrIsBlank(op)) {
    return op;
  }
  const { AF } = c;
  const boundMarkerExpression = AF.createTermExpression(boundArgumentMarker);
  const unboundMarkerExpression = AF.createTermExpression(unboundArgumentMarker);
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(op, {}, { expression: {
    named: { transform: named => isInternalBnode(named) ?
      AF.createNamedExpression(named.name, named.args.map(argument => AF.createOperatorExpression('coalesce', [
        AF.createOperatorExpression('triple', [ boundMarkerExpression, boundMarkerExpression, argument ]),
        unboundMarkerExpression,
      ]))) :
      named },
    operator: { transform: operator => operator.operator === 'isblank' ?
      materialisation.isMaterialisedExpression(c, operator.args) :
      operator },
  }});
}
