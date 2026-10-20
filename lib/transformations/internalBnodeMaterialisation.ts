import { Algebra } from '@traqula/algebra-transformations-1-2';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { holdsExpression } from '../utils/expressionHelpers.js';
import { DF } from '../utils/rdfDatatypes.js';

/**
 * @fileoverview What an internal blank node `<internal://blank>(…)` becomes, as a SPARQL expression over its encoding.
 * Both the SPARQL encoding and the extension function computing it materialise through it, so both give the same node.
 */

/** The tag each argument's encoding starts with; only an engine constructs a blank node. */
export const internalBnodeEncodingTags = <const> {
  iri: ',iri',
  literal: ',literal',
  triple: ',triple',
  blankNode: ',bnode',
  unbound: ',unbound',
};

/** What an internal blank node becomes, and how `ISBLANK` recognises it. */
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
}

const internalBnodeDatatype = DF.namedNode(DT_INTERNAL_BNODE);
const iriPrefixLiteral = DF.literal(IRI_PREFIX_BNODE);
const internalBnodeFunctionName = DF.namedNode(EXTENSION_FUNCTION_BNODE);

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
};

/**
 * Creates an internal blank node `<internal://blank>(…)`, its identity given by its arguments.
 * @param AF - The algebra factory to create it with.
 * @param args - The arguments identifying it.
 * @returns The named expression.
 */
export function internalBnodeExpression(
  AF: TransformationContext['AF'],
  args: Algebra.Expression[],
): Algebra.NamedExpression {
  return AF.createNamedExpression(internalBnodeFunctionName, args);
}

/**
 * Whether a named expression constructs an internal blank node.
 * @param expression - The named expression to check.
 * @returns Whether it calls `<internal://blank>`.
 */
export function isInternalBnode(expression: Algebra.NamedExpression): boolean {
  return expression.name.value === EXTENSION_FUNCTION_BNODE;
}

/** The expression callbacks of {@link internalBnodeExpressionCallbacks}. */
interface InternalBnodeExpressionCallbacks {
  named: { transform: (named: Algebra.NamedExpression) => Algebra.Expression };
  operator: { transform: (operator: Algebra.OperatorExpression) => Algebra.Expression };
}

/**
 * The expression callbacks materialising internal blank nodes and rewriting `ISBLANK` to recognise them.
 * @param c - The transformation context.
 * @param materialisation - What the internal blank nodes become.
 * @param encodeArguments - Gives the encoding of an internal blank node with arguments, already materialised.
 * @returns The callbacks, for the `expression` of `algebraUtils.mapOperationSub`.
 */
export function internalBnodeExpressionCallbacks(
  c: TransformationContext,
  materialisation: InternalBnodeMaterialisation,
  encodeArguments: (named: Algebra.NamedExpression) => Algebra.Expression,
): InternalBnodeExpressionCallbacks {
  return {
    named: { transform: (named) => {
      if (!isInternalBnode(named)) {
        return named;
      }
      // Without arguments, a fresh identity each time.
      const encoding = named.args.length === 0 ? c.AF.createOperatorExpression('struuid', []) : encodeArguments(named);
      return materialisation.materialiseEncodingExpression(c, encoding);
    } },
    operator: { transform: operator => operator.operator === 'isblank' ?
      materialisation.isMaterialisedExpression(c, operator.args) :
      operator },
  };
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
