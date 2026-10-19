import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { holdsExpression } from '../utils/expressionHelpers.js';
import { DF } from '../utils/rdfDatatypes.js';

/**
 * @fileoverview What an internal blank node `<internal://blank>(…)` becomes, shared by its SPARQL encoding and by the
 * extension function computing it, so that both give the same node.
 */

/** The tag each argument's encoding starts with; only an engine constructs a blank node. */
export const internalBnodeEncodingTags = <const> {
  iri: ',iri',
  literal: ',literal',
  triple: ',triple',
  blankNode: ',bnode',
  unbound: ',unbound',
};

/** What an internal blank node becomes, both as a SPARQL expression and as the term an engine gives. */
export interface InternalBnodeMaterialisation {
  /**
   * The SPARQL expression materialising an encoding.
   * @param c - The transformation context.
   * @param encoding - The expression giving the encoding.
   * @returns The expression giving the node.
   */
  materialiseEncodingExpression: (c: TransformationContext, encoding: Algebra.Expression) => Algebra.Expression;
  /**
   * The SPARQL expression `ISBLANK` becomes, true for a materialised node only.
   * @param c - The transformation context.
   * @param args - The arguments of the `ISBLANK`.
   * @returns The test.
   */
  isMaterialisedExpression: (c: TransformationContext, args: Algebra.Expression[]) => Algebra.Expression;
  /**
   * The term an encoding is materialised as.
   * @param encoding - The encoding.
   * @returns The node.
   */
  materialiseEncoding: (encoding: string) => Promise<RDF.Term>;
}

const internalBnodeDatatype = DF.namedNode(DT_INTERNAL_BNODE);
const iriPrefixLiteral = DF.literal(IRI_PREFIX_BNODE);
const textEncoder = new TextEncoder();

/**
 * The SHA-1 of a string, as SPARQL's `SHA1` gives it.
 * @param value - The string, hashed as UTF-8.
 * @returns The hash in lowercase hexadecimal.
 */
async function sha1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', textEncoder.encode(value));
  return [ ...new Uint8Array(digest) ].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Materialises an internal blank node as a literal of a special datatype, its encoding as value. */
export const specialLiteralMaterialisation: InternalBnodeMaterialisation = {
  materialiseEncodingExpression: ({ AF }, encoding) =>
    AF.createOperatorExpression('strdt', [ encoding, AF.createTermExpression(internalBnodeDatatype) ]),
  // DATATYPE errors on any other term than a literal, so it is asked of a literal only.
  isMaterialisedExpression: ({ AF }, args) => AF.createOperatorExpression('&&', [
    AF.createOperatorExpression('isliteral', args),
    AF.createOperatorExpression('=', [
      AF.createOperatorExpression('datatype', args),
      AF.createTermExpression(internalBnodeDatatype),
    ]),
  ]),
  materialiseEncoding: async encoding => DF.literal(encoding, internalBnodeDatatype),
};

/** Materialises an internal blank node as a prefixed IRI, the SHA-1 of its encoding keeping nested ones short. */
export const specialIriMaterialisation: InternalBnodeMaterialisation = {
  materialiseEncodingExpression: ({ AF }, encoding) => AF.createOperatorExpression('iri', [
    AF.createOperatorExpression('concat', [
      AF.createTermExpression(iriPrefixLiteral),
      AF.createOperatorExpression('sha1', [ encoding ]),
    ]),
  ]),
  isMaterialisedExpression: ({ AF }, args) => AF.createOperatorExpression('&&', [
    AF.createOperatorExpression('isiri', args),
    AF.createOperatorExpression('strstarts', [
      AF.createOperatorExpression('str', args),
      AF.createTermExpression(iriPrefixLiteral),
    ]),
  ]),
  materialiseEncoding: async encoding => DF.namedNode(`${IRI_PREFIX_BNODE}${await sha1(encoding)}`),
};

/**
 * Whether a named expression constructs an internal blank node.
 * @param expression - The named expression to check.
 * @returns Whether it calls `<internal://blank>`.
 */
export function isInternalBnode(expression: Algebra.NamedExpression): boolean {
  return expression.name.value === EXTENSION_FUNCTION_BNODE;
}

/**
 * Whether an operation holds anything materialising internal blank nodes rewrites.
 * @param op - The operation to check.
 * @returns Whether it holds an internal blank node or an `ISBLANK`.
 */
export function holdsInternalBnodeOrIsBlank(op: Algebra.Operation): boolean {
  return holdsExpression(op, held => (held.subType === Algebra.ExpressionTypes.NAMED && isInternalBnode(held)) ||
    (held.subType === Algebra.ExpressionTypes.OPERATOR && held.operator === 'isblank'));
}
