import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';

/**
 * @fileoverview Blank node transformation utilities.
 *
 * Since underlying RDF 1.1 datasets cannot consistently reference blank nodes,
 * this module provides transformations that convert internal blank node
 * representation to either:
 * 1. Typed literals with a special datatype
 * 2. IRIs with a special prefix
 *
 * Both approaches allow blank nodes to be consistently identified across
 * query results while maintaining the semantics of "same inputs = same node".
 */

/**
 * How deeply nested a triple term argument of `<internal://blank>` is encoded, since a SPARQL expression cannot
 * recurse. Only the object of a triple term can itself be one, so 2 encodes a triple term whose object may itself be
 * a triple term whose object is not. A more deeply nested triple term errors the identity, leaving the node unbound.
 * Each level adds three encodings to the expression of every variable argument.
 */
const TRIPLE_TERM_ARGUMENT_DEPTH = 2;

/**
 * Transforms an internal blank node expression into a deterministic expression.
 *
 * The expression `<internal://blank>(?var1, ?var2, ...)` is converted to an
 * expression that consistently produces the same value for the same variable bindings.
 *
 * The output encodes each variable's value with its type information:
 * - IRIs: `,iri,<escaped-value>`
 * - Literals with lang+dir: `,literal@D,<value>,<lang>,<dir>`
 * - Literals with lang: `,literal@,<value>,<lang>`
 * - Plain/typed literals: `,literal,<value>,<datatype>`
 * - Triple terms: `,triple` followed by the encodings of its subject, predicate and object,
 *   nested up to {@link TRIPLE_TERM_ARGUMENT_DEPTH}
 * - Unbound variables: `,unbound`, which no bound value gives
 *
 * The result is unambiguous: every part starts with its tag, values have their commas escaped,
 * and `,triple` is followed by exactly three parts.
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param hashFunc - Optional hash function to shorten the output
 * @returns The transformed expression
 */
function expressionForConsistentConstruction(
  c: TransformationContext,
  expression: Algebra.NamedExpression,
  hashFunc?: 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512',
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  /**
   * Encodes a term that is an IRI or a literal: a big if on which kind it is.
   * @param termExpression - An expression giving the term, like `?v` or `OBJECT(?t)`.
   * @returns The encoding, which errors when the term is a triple term or unbound.
   */
  function encodeIriOrLiteral(termExpression: Algebra.Expression): Algebra.Expression {
    // We assume the term is never a bnode since we explicitly disallow BNODES.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('isiri', [ termExpression ]),
      AF.createOperatorExpression('concat', [
        expressionLiteral(',iri,'),
        escapeUserInput(AF.createOperatorExpression('str', [ termExpression ])),
      ]),
      AF.createOperatorExpression('if', [
        // We now know it is a literal
        AF.createOperatorExpression('haslangdir', [ termExpression ]),
        AF.createOperatorExpression('concat', [
          expressionLiteral(',literal@D,'),
          escapeUserInput(AF.createOperatorExpression('str', [ termExpression ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('lang', [ termExpression ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('langdir', [ termExpression ])),
        ]),
        AF.createOperatorExpression('if', [
          // We now know it is a literal
          AF.createOperatorExpression('haslang', [ termExpression ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal@,'),
            escapeUserInput(AF.createOperatorExpression('str', [ termExpression ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('lang', [ termExpression ])),
          ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal,'),
            escapeUserInput(AF.createOperatorExpression('str', [ termExpression ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('str', [
              AF.createOperatorExpression('datatype', [ termExpression ]),
            ])),
          ]),
        ]),
      ]),
    ]);
  }

  /**
   * Encodes a term that can also be a triple term, through the encodings of its subject, predicate and object.
   * @param termExpression - An expression giving the term, like `?v` or `OBJECT(?t)`.
   * @param tripleTermDepth - How deeply nested a triple term is encoded; a more deeply nested one errors.
   * @returns The encoding, which errors when the term is unbound.
   */
  function encodeTerm(termExpression: Algebra.Expression, tripleTermDepth: number): Algebra.Expression {
    if (tripleTermDepth === 0) {
      return encodeIriOrLiteral(termExpression);
    }
    // In RDF 1.2 only the object of a triple term can itself be a triple term.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('istriple', [ termExpression ]),
      AF.createOperatorExpression('concat', [
        expressionLiteral(',triple'),
        encodeIriOrLiteral(AF.createOperatorExpression('subject', [ termExpression ])),
        encodeIriOrLiteral(AF.createOperatorExpression('predicate', [ termExpression ])),
        encodeTerm(AF.createOperatorExpression('object', [ termExpression ]), tripleTermDepth - 1),
      ]),
      encodeIriOrLiteral(termExpression),
    ]);
  }

  function mapArgument(argument: RDF.Term): Algebra.Expression {
    const argumentExpression = AF.createTermExpression(argument);
    // A constant is always bound, and BOUND only accepts a variable. Only a triple term constant needs ISTRIPLE.
    if (argument.termType !== 'Variable') {
      return argument.termType === 'Quad' ?
        encodeTerm(argumentExpression, TRIPLE_TERM_ARGUMENT_DEPTH) :
        encodeIriOrLiteral(argumentExpression);
    }
    // An unbound variable counts as a value of its own instead of erroring the whole identity, like COALESCE handles
    // an error of its arguments. Not COALESCE(<encoding>, ...): that would also take an error of a bound value,
    // like a triple term nested too deeply, for unbound.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('bound', [ argumentExpression ]),
      encodeTerm(argumentExpression, TRIPLE_TERM_ARGUMENT_DEPTH),
      expressionLiteral(',unbound'),
    ]);
  }

  /**
   * Assert that the input does not use our value separator: `,` -> `\,`
   * Know that this means a string should not end in `\` since then we would also get `\,`
   */
  function escapeUserInput(val: Algebra.Expression): Algebra.Expression {
    const backslashEscaped = AF.createOperatorExpression('replace', [
      val,
      // Regex: matches one backslash
      expressionLiteral('\\\\'),
      // Replacement: outputs two backslashes
      expressionLiteral('\\\\\\\\'),
    ]);
    return AF.createOperatorExpression('replace', [
      backslashEscaped,
      expressionLiteral(','),
      expressionLiteral('\\\\,'),
    ]);
  }

  // ====================== Implementation ========================

  // Ignore non matching
  if (expression.name.value !== EXTENSION_FUNCTION_BNODE) {
    return expression;
  }

  // In case no vars are provided, we always make a new one (you likely never want this though....)
  let value = AF.createOperatorExpression('struuid', []);
  if (expression.args.length > 0) {
    // In the order the arguments are written: removeProjections gives hidden variables fresh names per pattern,
    // so an order read off their names would differ between two patterns constructing the same node.
    value = AF.createOperatorExpression('concat', (<Algebra.TermExpression[]>expression.args)
      .map(expression => mapArgument(expression.term)));
  }

  if (!hashFunc) {
    return value;
  }
  return AF.createOperatorExpression(hashFunc, [ value ]);
}

/**
 * Transforms internal blank nodes to typed literals with a special datatype.
 *
 * This transformation:
 * 1. Converts `<internal://blank>(...)` to `STRDT(computed-value, <internal-bnode-type>)`
 * 2. Rewrites `ISBLANK(x)` to check if the datatype matches the special type
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with blank nodes as typed literals
 *
 * @example
 * // Internal blank node expression becomes:
 * // STRDT(CONCAT(...encoded vars...), <https://sparql-extension.knows.idlab.ugent.be/bnode>)
 */
export function internalBnodeAsSpecialLiteral<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
        const value = expressionForConsistentConstruction(c, expression);
        if (expression === value) {
          return expression;
        }
        return AF.createOperatorExpression('strdt', [
          value,
          AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
        ]);
      },
    }, operator: {
      transform: (expression) => {
        if (expression.operator !== 'isblank') {
          return expression;
        }

        return AF.createOperatorExpression('=', [
          AF.createOperatorExpression('datatype', expression.args),
          AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
        ]);
      },
    }}},
  );
}

/**
 * Transforms internal blank nodes to IRIs with a special prefix.
 *
 * This transformation:
 * 1. Converts `<internal://blank>(...)` to `IRI(CONCAT(prefix, SHA1(computed-value)))`
 * 2. Rewrites `ISBLANK(x)` to check if the IRI starts with the special prefix
 *
 * Using SHA1 keeps the IRI length manageable when blank nodes are nested.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with blank nodes as prefixed IRIs
 *
 * @example
 * // Internal blank node expression becomes:
 * // IRI(CONCAT("https://myInternalBnode.example.org/", SHA1(...encoded vars...)))
 */
export function internalBnodeAsSpecialIri<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
        const value = expressionForConsistentConstruction(c, expression, 'sha1');
        if (expression === value) {
          return expression;
        }
        return AF.createOperatorExpression('iri', [
          AF.createOperatorExpression('concat', [
            AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
            value,
          ]),
        ]);
      },
    }, operator: {
      transform: (expression) => {
        if (expression.operator !== 'isblank') {
          return expression;
        }

        return AF.createOperatorExpression('&&', [
          AF.createOperatorExpression('isiri', expression.args),

          AF.createOperatorExpression('strstarts', [
            AF.createOperatorExpression('str', expression.args),
            AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
          ]),
        ]);
      },
    }}},
  );
}

/**
 * The pipeline step materialising every internal blank node as a typed literal.
 * @returns the transformation
 */
export function internalBnodeAsSpecialLiteralTransformation(): QueryTransformation {
  return internalBnodeAsSpecialLiteral;
}

/**
 * The pipeline step materialising every internal blank node as a prefixed IRI.
 * @returns the transformation
 */
export function internalBnodeAsSpecialIriTransformation(): QueryTransformation {
  return internalBnodeAsSpecialIri;
}
