import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { EXTENSION_FUNCTION_BNODE_ENCODING } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { DF } from '../utils/rdfDatatypes.js';
import type { InternalBnodeMaterialisation } from './internalBnodeMaterialisation.js';
import { internalBnodeEncodingTags, internalBnodeExpressionCallbacks } from './internalBnodeMaterialisation.js';

/**
 * @fileoverview Internal blank nodes encoded by an extension function of the engine, like Comunica's
 * `extensionFunctions`, rather than in SPARQL. The function gets the evaluated arguments, so it encodes a triple term
 * of any depth, and the query materialises its encoding as the SPARQL encoding's.
 */

/** Extension functions by the IRI they are called by, the shape of Comunica's `extensionFunctions` context entry. */
export type ExtensionFunctions = Record<string, (args: RDF.Term[]) => Promise<RDF.Term>>;

/** Subject and predicate of the triple term an argument that evaluates is wrapped in. */
export const boundArgumentMarker = DF.namedNode('internal://blank/argument');

/** What an argument that is unbound or errors is passed as. */
export const unboundArgumentMarker = DF.namedNode('internal://blank/unbound');

const encodingFunctionName = DF.namedNode(EXTENSION_FUNCTION_BNODE_ENCODING);

/**
 * Materialises each internal blank node from the encoding {@link internalBnodeExtensionFunctions} gives. An engine
 * errors the call when an argument errors, so each argument `e` is wrapped as
 * `COALESCE(TRIPLE(<…argument>, <…argument>, e), <…unbound>)`.
 * @param c - The transformation context.
 * @param op - The operation to transform.
 * @param materialisation - What the internal blank nodes become, which `ISBLANK` is rewritten to recognise.
 * @returns The transformed operation.
 */
export function materialiseInternalBnodesByExtensionFunction<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  materialisation: InternalBnodeMaterialisation,
): T {
  const { AF } = c;
  const boundMarkerExpression = AF.createTermExpression(boundArgumentMarker);
  const unboundMarkerExpression = AF.createTermExpression(unboundArgumentMarker);
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(op, {}, {
    expression: internalBnodeExpressionCallbacks(c, materialisation, named =>
      AF.createNamedExpression(encodingFunctionName, named.args.map(argument =>
        AF.createOperatorExpression('coalesce', [
          AF.createOperatorExpression('triple', [ boundMarkerExpression, boundMarkerExpression, argument ]),
          unboundMarkerExpression,
        ])))),
  });
}

/**
 * Writes a string as its length and itself, as the SPARQL encoding does.
 * @param value - The string.
 * @returns The field, `,<length>:<string>`, the length in characters as `STRLEN` counts them.
 */
function field(value: string): string {
  return `,${[ ...value ].length}:${value}`;
}

/**
 * Encodes a term an argument evaluated to as the SPARQL encoding does, and a blank node by its label.
 * @param term - The term.
 * @returns Its encoding.
 * @throws Error if the term is a variable or the default graph, which no expression evaluates to
 */
function encodeTerm(term: RDF.Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return `${internalBnodeEncodingTags.iri}${field(term.value)}`;
    case 'Literal':
      return `${internalBnodeEncodingTags.literal}${field(term.value)}${field(term.datatype.value)}${
        field(term.language)}${field(term.direction ?? '')}`;
    case 'Quad':
      return `${internalBnodeEncodingTags.triple}${encodeTerm(term.subject)}${encodeTerm(term.predicate)}${
        encodeTerm(term.object)}`;
    case 'BlankNode':
      return `${internalBnodeEncodingTags.blankNode}${field(term.value)}`;
    default:
      throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE_ENCODING}> cannot evaluate to a ${term.termType}.`);
  }
}

/**
 * Encodes an argument as {@link materialiseInternalBnodesByExtensionFunction} wrapped it.
 * @param argument - The wrapped argument.
 * @returns Its encoding, `,unbound` where it was unbound or errored.
 * @throws Error if the argument is not wrapped
 */
function encodeArgument(argument: RDF.Term): string {
  if (argument.equals(unboundArgumentMarker)) {
    return internalBnodeEncodingTags.unbound;
  }
  if (argument.termType === 'Quad' && argument.subject.equals(boundArgumentMarker)) {
    return encodeTerm(argument.object);
  }
  throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE_ENCODING}> has to be wrapped as ` +
    `materialiseInternalBnodesByExtensionFunction does, which ${argument.termType} ${argument.value} is not.`);
}

/**
 * The extension function encoding internal blank nodes for a step given `{ encodedByExtensionFunction: true }`.
 * @returns The function, for Comunica's `extensionFunctions` context entry.
 */
export function internalBnodeExtensionFunctions(): ExtensionFunctions {
  return {
    [EXTENSION_FUNCTION_BNODE_ENCODING]: async args => DF.literal(args.map(encodeArgument).join('')),
  };
}
