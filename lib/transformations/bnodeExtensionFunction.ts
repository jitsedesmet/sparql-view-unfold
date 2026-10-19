import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { EXTENSION_FUNCTION_BNODE, IRI_BOUND_BNODE_ARGUMENT, IRI_UNBOUND_BNODE_ARGUMENT } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { DF } from '../utils/rdfDatatypes.js';
import type { InternalBnodeMaterialisation } from './internalBnodeMaterialisation.js';
import {
  holdsInternalBnodeOrIsBlank,
  internalBnodeEncodingTags,
  isInternalBnode,
  specialIriMaterialisation,
  specialLiteralMaterialisation,
} from './internalBnodeMaterialisation.js';

/**
 * @fileoverview Internal blank nodes computed by an extension function of the engine, like Comunica's
 * `extensionFunctions`, rather than spelled out in SPARQL.
 *
 * The function gets the evaluated arguments, so it encodes a triple term of any depth. An engine errors the call when
 * an argument errors, so {@link internalBnodeAsExtensionFunction} wraps each argument to arrive either way.
 */

/** Extension functions by the IRI they are called by, the shape of Comunica's `extensionFunctions` context entry. */
export type ExtensionFunctions = Record<string, (args: RDF.Term[]) => Promise<RDF.Term>>;

const boundArgumentMarker = DF.namedNode(IRI_BOUND_BNODE_ARGUMENT);
const unboundArgumentMarker = DF.namedNode(IRI_UNBOUND_BNODE_ARGUMENT);

/**
 * Wraps each argument `e` of `<internal://blank>` as `COALESCE(TRIPLE(<…argument>, <…argument>, e), <…unbound>)`, so a
 * value arrives as a triple term and an unbound or erroring argument as an IRI no value is wrapped as.
 * @param c - The transformation context.
 * @param op - The operation to transform.
 * @param materialisation - What the internal blank nodes become, which `ISBLANK` is rewritten to recognise.
 * @returns The operation, for the matching {@link ExtensionFunctions} to evaluate.
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
      throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE}> cannot evaluate to a ${term.termType}.`);
  }
}

/**
 * Encodes an argument as {@link internalBnodeAsExtensionFunction} wrapped it.
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
  throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE}> has to be wrapped by ` +
    `internalBnodeAsExtensionFunction, which ${argument.termType} ${argument.value} is not.`);
}

/**
 * The extension function materialising internal blank nodes.
 * @param materialisation - What the internal blank nodes become.
 * @returns The function, by the IRI it is called by.
 */
function internalBnodeExtensionFunctions(materialisation: InternalBnodeMaterialisation): ExtensionFunctions {
  return {
    // Without arguments, a fresh identity each time, as `STRUUID()` gives in SPARQL.
    [EXTENSION_FUNCTION_BNODE]: async args =>
      materialisation.materialiseEncoding(args.length === 0 ? crypto.randomUUID() : args.map(encodeArgument).join('')),
  };
}

/**
 * The extension function for `internalBnodeAsSpecialLiteralTransformation({ evaluatedByExtensionFunction: true })`.
 * @returns The function, for Comunica's `extensionFunctions` context entry.
 */
export function internalBnodeAsSpecialLiteralExtensionFunctions(): ExtensionFunctions {
  return internalBnodeExtensionFunctions(specialLiteralMaterialisation);
}

/**
 * The extension function for `internalBnodeAsSpecialIriTransformation({ evaluatedByExtensionFunction: true })`.
 * @returns The function, for Comunica's `extensionFunctions` context entry.
 */
export function internalBnodeAsSpecialIriExtensionFunctions(): ExtensionFunctions {
  return internalBnodeExtensionFunctions(specialIriMaterialisation);
}
