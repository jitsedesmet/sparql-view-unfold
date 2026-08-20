import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TransformContext } from '../transformContext.js';

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
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param hashFunc - Optional hash function to shorten the output
 * @returns The transformed expression
 */
function expressionForConsistentConstruction(
  c: TransformContext,
  expression: Algebra.NamedExpression,
  hashFunc?: 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512',
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  // Return a big if
  function mapVariable(variable: RDF.Variable): Algebra.Expression {
    const varAsExpr = AF.createTermExpression(variable);
    // We assume the var is never bound to a bnode since we explicitly disallow BNODES.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('isiri', [ varAsExpr ]),
      AF.createOperatorExpression('concat', [
        expressionLiteral(',iri,'),
        escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
      ]),
      AF.createOperatorExpression('if', [
        // We now know it is a literal
        AF.createOperatorExpression('haslangdir', [ varAsExpr ]),
        AF.createOperatorExpression('concat', [
          expressionLiteral(',literal@D,'),
          escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('langdir', [ varAsExpr ])),
        ]),
        AF.createOperatorExpression('if', [
          // We now know it is a literal
          AF.createOperatorExpression('haslang', [ varAsExpr ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal@,'),
            escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
          ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal,'),
            escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('str', [
              AF.createOperatorExpression('datatype', [ varAsExpr ]),
            ])),
          ]),
        ]),
      ]),
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
    // Make a big concat of conditionals
    value = AF.createOperatorExpression('concat', (<Algebra.TermExpression[]>expression.args)
      .sort((a, b) => (<RDF.Variable> a.term).value.localeCompare((<RDF.Variable> b.term).value))
      .map(expression => mapVariable(<RDF.Variable> expression.term)));
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
export function internalBnodeAsSpecialLiteral<T extends Algebra.Operation>(c: TransformContext, op: T): T {
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
export function internalBnodeAsSpecialIri<T extends Algebra.Operation>(c: TransformContext, op: T): T {
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
