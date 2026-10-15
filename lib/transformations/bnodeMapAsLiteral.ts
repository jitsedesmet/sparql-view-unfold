import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import { objectRange, RangeSet, tripleTermRange } from '../RangeSet.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { cpMetaOf, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { isSubsetOf } from '../utils/setUtils.js';

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
 * - Triple terms: `,triple` followed by the encodings of its subject, predicate and object,
 *   nested up to the `tripleTermArgumentDepth` of the context
 * - Unbound variables: `,unbound`, which no bound value gives
 *
 * The result is unambiguous: every part starts with its tag, values have their commas escaped,
 * and `,triple` is followed by exactly three parts.
 *
 * A term only gets the branches its range admits: no `,triple` branch where it cannot be a triple term, no
 * `ISTRIPLE` test where it can only be one, and no `BOUND` test for a variable bound in every solution. Either way
 * the same value gives the same encoding.
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param scope - What the solutions the expression is evaluated over bind, if known. Without it, a variable can
 * be any term and may be unbound.
 * @param hashFunc - Optional hash function to shorten the output
 * @returns The transformed expression
 */
function expressionForConsistentConstruction(
  c: TransformationContext,
  expression: Algebra.NamedExpression,
  scope: CPMeta | undefined,
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
   * @param range - The term types the term can be, deciding which branches the encoding needs.
   * @param tripleTermDepth - How deeply nested a triple term is encoded; a more deeply nested one errors.
   * @returns The encoding, which errors when the term is unbound or outside its range.
   */
  function encodeTerm(termExpression: Algebra.Expression, range: RangeSet, tripleTermDepth: number):
  Algebra.Expression {
    if (tripleTermDepth === 0 || !range.has('Quad')) {
      return encodeIriOrLiteral(termExpression);
    }
    // In RDF 1.2 only the object of a triple term can itself be a triple term.
    const tripleTermEncoding = AF.createOperatorExpression('concat', [
      expressionLiteral(',triple'),
      encodeIriOrLiteral(AF.createOperatorExpression('subject', [ termExpression ])),
      encodeIriOrLiteral(AF.createOperatorExpression('predicate', [ termExpression ])),
      encodeTerm(AF.createOperatorExpression('object', [ termExpression ]), objectRange, tripleTermDepth - 1),
    ]);
    if (isSubsetOf(range, tripleTermRange)) {
      return tripleTermEncoding;
    }
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('istriple', [ termExpression ]),
      tripleTermEncoding,
      encodeIriOrLiteral(termExpression),
    ]);
  }

  function mapArgument(argument: RDF.Term): Algebra.Expression {
    const argumentExpression = AF.createTermExpression(argument);
    // A constant is always bound, and BOUND only accepts a variable. Its range is its own term type.
    if (argument.termType !== 'Variable') {
      return encodeTerm(argumentExpression, new RangeSet([ argument.termType ]), c.tripleTermArgumentDepth);
    }
    const encoding = encodeTerm(
      argumentExpression,
      scope?.vRanges.rangeOf(argument.value) ?? objectRange,
      c.tripleTermArgumentDepth,
    );
    if (scope?.cVars.has(argument.value)) {
      return encoding;
    }
    // An unbound variable counts as a value of its own instead of erroring the whole identity, like COALESCE handles
    // an error of its arguments. Not COALESCE(<encoding>, ...): that would also take an error of a bound value,
    // like a triple term nested too deeply, for unbound.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('bound', [ argumentExpression ]),
      encoding,
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
 * Materialises the internal blank nodes in the expression of every EXTEND and FILTER, knowing what the input of
 * that operation binds.
 *
 * An EXISTS is not entered: it substitutes the solution it is asked for into its pattern, binding variables that
 * pattern's ranges do not cover.
 * @param c - The transformation context
 * @param op - The operation to transform
 * @param materialise - Materialises one internal blank node, given what the solutions it is evaluated over bind.
 * @returns The transformed operation, its other internal blank nodes left for a pass without ranges.
 */
function materialiseWithInputRanges<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  materialise: (expression: Algebra.NamedExpression, scope: CPMeta) => Algebra.Expression,
): T {
  const { AF } = c;

  /**
   * Materialises the internal blank nodes of one expression, outside any EXISTS in it.
   * @param expression - The expression of the EXTEND or FILTER.
   * @param input - The operation the expression is evaluated over.
   * @returns The expression with those blank nodes materialised.
   */
  function inExpression(expression: Algebra.Expression, input: Algebra.Operation): Algebra.Expression {
    let scope: CPMeta | undefined;
    return algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: {
      existence: { preVisitor: () => ({ continue: false }) },
      named: { transform: (named) => {
        if (named.name.value !== EXTENSION_FUNCTION_BNODE) {
          return named;
        }
        // Read off a copy: reading caches metadata on the operation, which a traversal cannot copy.
        scope ??= cpMetaOf(withoutCpVars(input));
        return materialise(named, scope);
      } },
    }});
  }

  return algebraUtils.mapOperation<'unsafe', T>(op, {
    [Algebra.Types.EXTEND]: { transform: extend =>
      AF.createExtend(extend.input, extend.variable, inExpression(extend.expression, extend.input)) },
    [Algebra.Types.FILTER]: { transform: filter =>
      AF.createFilter(filter.input, inExpression(filter.expression, filter.input)) },
    // Only an EXISTS holds an operation, and it is not entered.
    [Algebra.Types.EXPRESSION]: { preVisitor: () => ({ continue: false }) },
  });
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
  function materialise(expression: Algebra.NamedExpression, scope?: CPMeta): Algebra.Expression {
    const value = expressionForConsistentConstruction(c, expression, scope);
    if (expression === value) {
      return expression;
    }
    return AF.createOperatorExpression('strdt', [
      value,
      AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
    ]);
  }
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    materialiseWithInputRanges(c, op, materialise),
    {},
    { expression: { named: {
      // What is left has no ranges at hand, like one in an EXISTS or in the condition of an OPTIONAL.
      transform: expression => materialise(expression),
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
  function materialise(expression: Algebra.NamedExpression, scope?: CPMeta): Algebra.Expression {
    const value = expressionForConsistentConstruction(c, expression, scope, 'sha1');
    if (expression === value) {
      return expression;
    }
    return AF.createOperatorExpression('iri', [
      AF.createOperatorExpression('concat', [
        AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
        value,
      ]),
    ]);
  }
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    materialiseWithInputRanges(c, op, materialise),
    {},
    { expression: { named: {
      // What is left has no ranges at hand, like one in an EXISTS or in the condition of an OPTIONAL.
      transform: expression => materialise(expression),
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
