import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { triplePositions } from '../datastructures/TermClusterSet.js';
import { literalRange, objectRange, RangeSet, rangeOfPosition, subjectRange, tripleTermRange } from '../RangeSet.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { constructionCannotFail, cpMetaOf, VRanges, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { differenceSets, isSubsetOf } from '../utils/setUtils.js';

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

/** The scope of an expression nothing is known about: no variable is certainly bound or has a known range. */
const unknownScope: CPMeta = { cVars: new Set(), vRanges: new VRanges() };

/**
 * Whether a named expression constructs an internal blank node.
 * @param expression - The named expression to check.
 * @returns Whether it calls `<internal://blank>`.
 */
function isInternalBnode(expression: Algebra.NamedExpression): boolean {
  return expression.name.value === EXTENSION_FUNCTION_BNODE;
}

/**
 * Encodes the arguments of an internal blank node into a string that is equal exactly when the arguments are,
 * whatever branches their ranges leave out.
 *
 * The output encodes each argument's value with its type information:
 * - IRIs: `,iri,<escaped-value>`
 * - Literals with lang+dir: `,literal@D,<value>,<lang>,<dir>`
 * - Literals with lang: `,literal@,<value>,<lang>`
 * - Plain/typed literals: `,literal,<value>,<datatype>`
 * - Triple terms: `,triple` followed by the encodings of its subject, predicate and object
 * - Unbound variables: `,unbound`, which no bound value gives
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param scope - What the solutions the expression is evaluated over bind; nothing is known by default.
 * @returns The encoding, or `STRUUID()` when there are no arguments
 */
function encodeInternalBnode(
  c: TransformationContext,
  expression: Algebra.NamedExpression,
  scope: CPMeta = unknownScope,
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  /**
   * Encodes a term that is an IRI or a literal, testing which one only where its range admits both.
   * @param termExpression - An expression giving the term, like `?v` or `OBJECT(?t)`.
   * @param range - The term types the term can be.
   * @returns The encoding, which errors when the term is unbound or a triple term.
   */
  function encodeIriOrLiteral(termExpression: Algebra.Expression, range: RangeSet): Algebra.Expression {
    const escaped = (operator: string): Algebra.Expression =>
      escapeUserInput(AF.createOperatorExpression(operator, [ termExpression ]));
    const iriEncoding = AF.createOperatorExpression('concat', [ expressionLiteral(',iri,'), escaped('str') ]);
    // An IRI or a blank node, which is disallowed, so an IRI.
    if (isSubsetOf(range, subjectRange)) {
      return iriEncoding;
    }
    const literalEncoding = AF.createOperatorExpression('if', [
      AF.createOperatorExpression('haslangdir', [ termExpression ]),
      AF.createOperatorExpression('concat', [
        expressionLiteral(',literal@D,'),
        escaped('str'),
        expressionLiteral(','),
        escaped('lang'),
        expressionLiteral(','),
        escaped('langdir'),
      ]),
      AF.createOperatorExpression('if', [
        AF.createOperatorExpression('haslang', [ termExpression ]),
        AF.createOperatorExpression('concat', [
          expressionLiteral(',literal@,'),
          escaped('str'),
          expressionLiteral(','),
          escaped('lang'),
        ]),
        AF.createOperatorExpression('concat', [
          expressionLiteral(',literal,'),
          escaped('str'),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('str', [
            AF.createOperatorExpression('datatype', [ termExpression ]),
          ])),
        ]),
      ]),
    ]);
    if (isSubsetOf(range, literalRange)) {
      return literalEncoding;
    }
    // A triple term left in the range is nested too deeply: the literal branch errors on it.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('isiri', [ termExpression ]),
      iriEncoding,
      literalEncoding,
    ]);
  }

  /**
   * Encodes a triple term from the encodings of its components.
   * @param componentEncodings - The encodings of its subject, predicate and object.
   * @returns The encoding.
   */
  function encodeTripleTerm(componentEncodings: Algebra.Expression[]): Algebra.Expression {
    return AF.createOperatorExpression('concat', [ expressionLiteral(',triple'), ...componentEncodings ]);
  }

  /**
   * The term types a term as written can be: its own, or what the scope admits for a variable.
   * @param term - The term, like `?v` or `<ex://c>`.
   * @returns Its range, every term type for a variable out of scope in case an engine binds what the ranges miss.
   */
  function rangeOfWritten(term: RDF.Term): RangeSet {
    return term.termType === 'Variable' ?
      scope.vRanges.get(term.value) ?? objectRange :
      new RangeSet([ term.termType ]);
  }

  /**
   * A component of a triple term: as written when the triple term is written and cannot fail to construct, else read
   * through its accessor.
   * @param termExpression - An expression giving the triple term, like `?t` or `<<( ?s ?p ?o )>>`.
   * @param position - The component to give.
   * @returns The expression giving the component, and the term types it can be.
   */
  function componentOf(termExpression: Algebra.Expression, position: TriplePosition): [Algebra.Expression, RangeSet] {
    if (termExpression.subType === Algebra.ExpressionTypes.TERM && termExpression.term.termType === 'Quad' &&
      constructionCannotFail(termExpression.term, scope.vRanges)) {
      const component = termExpression.term[position];
      return [ AF.createTermExpression(component), rangeOfWritten(component) ];
    }
    return [ AF.createOperatorExpression(position, [ termExpression ]), rangeOfPosition(position) ];
  }

  /**
   * Encodes a term, a triple term through its components, unrolled `depth` triple terms deep.
   * @param termExpression - An expression giving the term, like `?v`, `OBJECT(?t)` or `<<( ?s ?p ?o )>>`.
   * @param range - The term types the term can be.
   * @param depth - How many nested triple terms are still unrolled; a deeper one errors.
   * @returns The encoding, which errors when the term is unbound.
   */
  function encodeTerm(termExpression: Algebra.Expression, range: RangeSet, depth: number): Algebra.Expression {
    if (depth <= 0 || !range.has('Quad')) {
      return encodeIriOrLiteral(termExpression, range);
    }
    const tripleTermEncoding = encodeTripleTerm(triplePositions.map(position =>
      encodeTerm(...componentOf(termExpression, position), depth - 1)));
    if (isSubsetOf(range, tripleTermRange)) {
      return tripleTermEncoding;
    }
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('istriple', [ termExpression ]),
      tripleTermEncoding,
      encodeIriOrLiteral(termExpression, new RangeSet(differenceSets(range, tripleTermRange))),
    ]);
  }

  function encodeArgument(argument: RDF.Term): Algebra.Expression {
    const encoding = encodeTerm(AF.createTermExpression(argument), rangeOfWritten(argument), c.tripleTermArgumentDepth);
    // BOUND only accepts a variable, and a triple term with an unbound variable errors, as constructing it does.
    if (argument.termType !== 'Variable' || scope.cVars.has(argument.value)) {
      return encoding;
    }
    // An unbound variable counts as a value of its own instead of erroring the whole identity, like COALESCE handles
    // an error of its arguments. Not COALESCE(<encoding>, ...): that would also take an error of a bound value,
    // like a triple term nested too deeply, for unbound.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('bound', [ AF.createTermExpression(argument) ]),
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

  // In case no vars are provided, we always make a new one (you likely never want this though....)
  if (expression.args.length === 0) {
    return AF.createOperatorExpression('struuid', []);
  }
  // In the order the arguments are written: removeProjections gives hidden variables fresh names per pattern,
  // so an order read off their names would differ between two patterns constructing the same node.
  return AF.createOperatorExpression('concat', (<Algebra.TermExpression[]>expression.args)
    .map(argument => encodeArgument(argument.term)));
}

/**
 * Materialises every internal blank node in an operation and rewrites `ISBLANK` to recognise what they became.
 * One in the expression of an EXTEND or FILTER is encoded with the ranges of its input, except inside an EXISTS,
 * which binds what it is asked for beyond those ranges.
 * @param c - The transformation context
 * @param op - The operation to transform
 * @param materialiseEncoding - Turns the encoding of an internal blank node into the term it becomes.
 * @param isMaterialisedBnode - Turns the arguments of an `ISBLANK` into the test for such a term.
 * @returns The transformed operation
 */
function materialiseInternalBnodes<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  materialiseEncoding: (encoding: Algebra.Expression) => Algebra.Expression,
  isMaterialisedBnode: (args: Algebra.Expression[]) => Algebra.Expression,
): T {
  // What is materialised holds no internal blank node or ISBLANK, so the second traversal skips it.
  const materialised = new WeakSet<Algebra.Expression>();
  function materialise(expression: Algebra.NamedExpression, scope?: CPMeta): Algebra.Expression {
    const term = materialiseEncoding(encodeInternalBnode(c, expression, scope));
    materialised.add(term);
    return term;
  }
  function materialiseOver(expression: Algebra.Expression, input: Algebra.Operation): Algebra.Expression {
    let scope: CPMeta | undefined;
    return algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: {
      existence: { preVisitor: () => ({ continue: false }) },
      named: { transform: named => isInternalBnode(named) ? materialise(named, scope ??= cpMetaOf(input)) : named },
    }});
  }

  // The ranges are read off the original input, which the post-order traversal already copied: reading caches
  // metadata on an operation, which a traversal cannot copy.
  const materialisedWithRanges = algebraUtils.mapOperation<'unsafe', T>(withoutCpVars(op), {
    [Algebra.Types.EXTEND]: { transform: (extend, original) => {
      extend.expression = materialiseOver(extend.expression, original.input);
      return extend;
    } },
    [Algebra.Types.FILTER]: { transform: (filter, original) => {
      filter.expression = materialiseOver(filter.expression, original.input);
      return filter;
    } },
    // Only an EXISTS holds an operation, and it is not entered.
    [Algebra.Types.EXPRESSION]: { preVisitor: () => ({ continue: false }) },
  });
  return algebraUtils.mapOperationSub<'unsafe', T>(materialisedWithRanges, {}, { expression: {
    // What is left gets every branch.
    named: { transform: named => isInternalBnode(named) ? materialise(named) : named },
    operator: {
      preVisitor: operator => materialised.has(operator) ? { continue: false } : {},
      transform: operator => operator.operator === 'isblank' ? isMaterialisedBnode(operator.args) : operator,
    },
  }});
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
  return materialiseInternalBnodes(
    c,
    op,
    encoding => AF.createOperatorExpression('strdt', [
      encoding,
      AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
    ]),
    args => AF.createOperatorExpression('=', [
      AF.createOperatorExpression('datatype', args),
      AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
    ]),
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
  return materialiseInternalBnodes(
    c,
    op,
    encoding => AF.createOperatorExpression('iri', [
      AF.createOperatorExpression('concat', [
        AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
        AF.createOperatorExpression('sha1', [ encoding ]),
      ]),
    ]),
    args => AF.createOperatorExpression('&&', [
      AF.createOperatorExpression('isiri', args),
      AF.createOperatorExpression('strstarts', [
        AF.createOperatorExpression('str', args),
        AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
      ]),
    ]),
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
