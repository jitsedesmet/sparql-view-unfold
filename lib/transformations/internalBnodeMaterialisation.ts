import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import {
  DT_INTERNAL_BNODE,
  EXTENSION_FUNCTION_BNODE,
  EXTENSION_FUNCTION_DERIVATION,
  IRI_PREFIX_BNODE,
  IRI_PREFIX_DERIVATION,
} from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { holdsExpression } from '../utils/expressionHelpers.js';
import { DF, tripleTerm } from '../utils/rdfDatatypes.js';

/**
 * @fileoverview What an internal blank node `<internal://blank>(…)` and a derivation `<internal://derivation>(…)`
 * become, as SPARQL expressions over the encoding of their arguments, and how that encoding is read back.
 * Both the SPARQL encoding and the extension function computing it materialise through here, so both give the same
 * term.
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
const derivationFunctionName = DF.namedNode(EXTENSION_FUNCTION_DERIVATION);

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

/**
 * Creates the identity of a derivation, `<internal://derivation>(index, …)`, which materialises as an IRI
 * {@link decodeDerivationIri} reads back.
 * @param AF - The algebra factory to create it with.
 * @param constructIndex - The index of the CONSTRUCT whose body the derivation is a solution of.
 * @param values - The values of that body's variables, in a fixed order.
 * @returns The named expression.
 */
export function derivationExpression(
  AF: TransformationContext['AF'],
  constructIndex: number,
  values: Algebra.Expression[],
): Algebra.NamedExpression {
  return AF.createNamedExpression(derivationFunctionName, [
    AF.createTermExpression(DF.literal(String(constructIndex))),
    ...values,
  ]);
}

/**
 * Whether a named expression constructs the identity of a derivation.
 * @param expression - The named expression to check.
 * @returns Whether it calls `<internal://derivation>`.
 */
export function isDerivation(expression: Algebra.NamedExpression): boolean {
  return expression.name.value === EXTENSION_FUNCTION_DERIVATION;
}

/**
 * The IRI a derivation materialises as: the prefix, its CONSTRUCT's index, `/`, and the encoding of its values, which
 * `ENCODE_FOR_URI` makes safe in an IRI. Unlike an internal blank node, it is not hashed, so it can be decoded.
 * @param c - The transformation context.
 * @param derivation - The `<internal://derivation>(index, …)` call.
 * @param encodeArguments - Gives the encoding of a named expression's arguments.
 * @returns The expression giving the IRI.
 * @throws Error if the index is not a constant
 */
function derivationIriExpression(
  c: TransformationContext,
  derivation: Algebra.NamedExpression,
  encodeArguments: (named: Algebra.NamedExpression) => Algebra.Expression,
): Algebra.Expression {
  const { AF } = c;
  const [ constructIndex, ...values ] = derivation.args;
  if (constructIndex?.subType !== Algebra.ExpressionTypes.TERM) {
    throw new Error(`The first argument of <${EXTENSION_FUNCTION_DERIVATION}> has to be the index of a CONSTRUCT.`);
  }
  const prefix = AF.createTermExpression(DF.literal(`${IRI_PREFIX_DERIVATION}${constructIndex.term.value}/`));
  return AF.createOperatorExpression('iri', [ values.length === 0 ?
    prefix :
    AF.createOperatorExpression('concat', [
      prefix,
      AF.createOperatorExpression('encode_for_uri', [
        encodeArguments(AF.createNamedExpression(derivation.name, values)),
      ]),
    ]) ]);
}

/**
 * Reads back the values an encoding of arguments was made from, as the SPARQL encoding and the extension function
 * write it: per argument a tag, then its fields, each written as `,<length>:<string>`.
 * @param encoding - The encoding.
 * @returns The value of each argument, `undefined` where it was unbound.
 * @throws Error if the string is no such encoding
 */
export function decodeArguments(encoding: string): (RDF.Term | undefined)[] {
  // Lengths count characters as STRLEN does, so by code point.
  const characters = [ ...encoding ];
  let position = 0;
  const fail = (): never => {
    throw new Error(`Not an encoding of arguments at character ${position}: ${encoding}`);
  };

  function readTag(): string {
    let end = position + 1;
    while (end < characters.length && /[a-z]/u.test(characters[end])) {
      end++;
    }
    const tag = characters.slice(position, end).join('');
    position = end;
    return tag;
  }

  function readField(): string {
    const colon = characters.indexOf(':', position);
    const length = characters.slice(position + 1, colon).join('');
    if (characters[position] !== ',' || colon < 0 || !/^\d+$/u.test(length) ||
      colon + 1 + Number(length) > characters.length) {
      fail();
    }
    position = colon + 1 + Number(length);
    return characters.slice(colon + 1, position).join('');
  }

  function readTerm(): RDF.Term | undefined {
    switch (readTag()) {
      case internalBnodeEncodingTags.iri:
        return DF.namedNode(readField());
      case internalBnodeEncodingTags.literal: {
        const [ value, datatype, language, direction ] = [ readField(), readField(), readField(), readField() ];
        if (language === '') {
          return DF.literal(value, DF.namedNode(datatype));
        }
        if (direction === '') {
          return DF.literal(value, language);
        }
        return DF.literal(value, { language, direction: <RDF.DirectionalLanguage['direction']> direction });
      }
      case internalBnodeEncodingTags.triple: {
        const [ subject, predicate, object ] = [ readTerm(), readTerm(), readTerm() ];
        return subject && predicate && object ? tripleTerm(subject, predicate, object) : fail();
      }
      case internalBnodeEncodingTags.blankNode:
        return DF.blankNode(readField());
      case internalBnodeEncodingTags.unbound:
        return undefined;
      default:
        return fail();
    }
  }

  const values: (RDF.Term | undefined)[] = [];
  while (position < characters.length) {
    values.push(readTerm());
  }
  return values;
}

/** A derivation IRI read back: which CONSTRUCT the derivation is a solution of, and its values. */
export interface DerivationIriParts {
  /** The index of the CONSTRUCT whose body the derivation is a solution of. */
  constructIndex: number;
  /** The value of each of that body's variables, `undefined` where it was unbound. */
  values: (RDF.Term | undefined)[];
}

/**
 * Reads back what a derivation IRI was made from.
 * @param iri - The IRI a derivation materialised as.
 * @returns The index of its CONSTRUCT and its values, or `undefined` if the IRI is no derivation.
 * @throws Error if the IRI has the prefix of a derivation, but not its encoding
 */
export function decodeDerivationIri(iri: string): DerivationIriParts | undefined {
  if (!iri.startsWith(IRI_PREFIX_DERIVATION)) {
    return undefined;
  }
  const parts = /^(\d+)\/(.*)$/su.exec(iri.slice(IRI_PREFIX_DERIVATION.length));
  if (parts === null) {
    throw new Error(`Not a derivation IRI: ${iri}`);
  }
  return { constructIndex: Number(parts[1]), values: decodeArguments(decodeURIComponent(parts[2])) };
}

/** The expression callbacks of {@link internalBnodeExpressionCallbacks}. */
export interface InternalBnodeExpressionCallbacks {
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
      if (isDerivation(named)) {
        return derivationIriExpression(c, named, encodeArguments);
      }
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
 * @returns Whether it holds an internal blank node, a derivation or an `ISBLANK`.
 */
export function holdsInternalIdentityOrIsBlank(op: Algebra.Operation): boolean {
  return holdsExpression(op, held =>
    (held.subType === Algebra.ExpressionTypes.NAMED && (isInternalBnode(held) || isDerivation(held))) ||
    (held.subType === Algebra.ExpressionTypes.OPERATOR && held.operator === 'isblank'));
}
