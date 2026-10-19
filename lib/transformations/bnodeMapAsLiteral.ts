import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { triplePositions } from '../datastructures/TermClusterSet.js';
import { literalRange, objectRange, RangeSet, rangeOfPosition, subjectRange, tripleTermRange } from '../RangeSet.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { componentOf } from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import {
  cpMetaOf,
  expressionRange,
  termCertainlyEvaluates,
  VRanges,
  withoutCpVars,
} from '../utils/certainlyBoundVars.js';
import {
  constructedTermOf,
  createBooleanExpression,
  holdsExpression,
  unstableOperators,
} from '../utils/expressionHelpers.js';
import { differenceSets, isSubsetOf } from '../utils/setUtils.js';
import { freshVarGenerator, markVariableNamesUsed } from '../utils.js';

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
 * The scope of an expression nothing is known about.
 * @returns A fresh scope in which no variable is certainly bound or has a known range.
 */
function createUnknownScope(): CPMeta {
  return { cVars: new Set(), vRanges: new VRanges() };
}

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
 * - Arguments that are unbound or error, as a BIND would leave them unbound: `,unbound`, which no value gives
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param scope - What the solutions the expression is evaluated over bind; nothing is known by default.
 * @returns The encoding, or `STRUUID()` when there are no arguments
 */
function encodeInternalBnode(
  c: TransformationContext,
  expression: Algebra.NamedExpression,
  scope: CPMeta = createUnknownScope(),
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  function ifTermIs(
    operator: string,
    termExpression: Algebra.Expression,
    then: Algebra.Expression,
    otherwise: Algebra.Expression,
  ): Algebra.Expression {
    const test = AF.createOperatorExpression(operator, [ termExpression ]);
    return AF.createOperatorExpression('if', [ test, then, otherwise ]);
  }

  /**
   * Concatenates strings, splicing in the parts of one that is a CONCAT itself.
   * @param parts - The strings, all simple literals.
   * @returns Their concatenation, or the one part there is.
   */
  function concat(parts: Algebra.Expression[]): Algebra.Expression {
    const spliced = parts.flatMap(part =>
      part.subType === Algebra.ExpressionTypes.OPERATOR && part.operator === 'concat' ? part.args : [ part ]);
    return spliced.length === 1 ? spliced[0] : AF.createOperatorExpression('concat', spliced);
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
    const iriEncoding = concat([ expressionLiteral(',iri,'), escaped('str') ]);
    // An IRI or a blank node, which is disallowed, so an IRI.
    if (isSubsetOf(range, subjectRange)) {
      return iriEncoding;
    }
    // The tag, the value and what follows it, so STR of the term is written once rather than per kind of literal. A
    // base direction is `ltr` or `rtl`, which needs no escaping.
    const literalEncoding = concat([
      ifTermIs(
        'haslang',
        termExpression,
        ifTermIs('haslangdir', termExpression, expressionLiteral(',literal@D,'), expressionLiteral(',literal@,')),
        expressionLiteral(',literal,'),
      ),
      escaped('str'),
      expressionLiteral(','),
      ifTermIs(
        'haslang',
        termExpression,
        concat([
          escaped('lang'),
          ifTermIs(
            'haslangdir',
            termExpression,
            concat([ expressionLiteral(','), AF.createOperatorExpression('langdir', [ termExpression ]) ]),
            expressionLiteral(''),
          ),
        ]),
        escapeUserInput(AF.createOperatorExpression('str', [
          AF.createOperatorExpression('datatype', [ termExpression ]),
        ])),
      ),
    ]);
    if (isSubsetOf(range, literalRange)) {
      return literalEncoding;
    }
    // A triple term left in the range is nested too deeply: STR of its datatype errors on it.
    return ifTermIs('isiri', termExpression, iriEncoding, literalEncoding);
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
   * A component of a triple term: as written for a written triple term, else read through its accessor.
   * @param termExpression - An expression giving the triple term, like `?t` or `<<( ?s ?p ?o )>>`.
   * @param position - The component to give.
   * @returns The expression giving the component, and the term types it can be.
   */
  function componentExpressionOf(
    termExpression: Algebra.Expression,
    position: TriplePosition,
  ): [Algebra.Expression, RangeSet] {
    const component = termExpression.subType === Algebra.ExpressionTypes.TERM ?
      componentOf(termExpression.term, position) :
      undefined;
    if (component !== undefined) {
      // Only encoded once constructed, so the component is a term its position admits.
      return [ AF.createTermExpression(component), rangeOfWritten(component).meet(rangeOfPosition(position)) ];
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
    if (!(depth > 0) || !range.has('Quad')) {
      return encodeIriOrLiteral(termExpression, range);
    }
    const tripleTermEncoding = concat([
      expressionLiteral(',triple'),
      ...triplePositions.map(position => encodeTerm(...componentExpressionOf(termExpression, position), depth - 1)),
    ]);
    if (isSubsetOf(range, tripleTermRange)) {
      return tripleTermEncoding;
    }
    return ifTermIs(
      'istriple',
      termExpression,
      tripleTermEncoding,
      encodeIriOrLiteral(termExpression, new RangeSet(differenceSets(range, tripleTermRange))),
    );
  }

  /**
   * Gives `,unbound` where an argument errors instead of its encoding, which would error the whole identity.
   * @param argument - The argument, like `?v` or `STR(?v)`.
   * @param encoding - Its encoding.
   * @returns The encoding, or `,unbound` when the argument errors.
   */
  function orUnbound(argument: Algebra.Expression, encoding: Algebra.Expression): Algebra.Expression {
    // Not COALESCE(<encoding>, ...): that would also take an error encoding a value, like a triple term nested too
    // deeply, for one of the argument. BOUND is false exactly when a variable is unbound, and SAMETERM of an
    // expression and itself only errors when the expression does.
    const evaluates = argument.subType === Algebra.ExpressionTypes.TERM && argument.term.termType === 'Variable' ?
      AF.createOperatorExpression('bound', [ argument ]) :
      AF.createOperatorExpression('coalesce', [
        AF.createOperatorExpression('sameterm', [ argument, argument ]),
        createBooleanExpression(c, false),
      ]);
    return AF.createOperatorExpression('if', [ evaluates, encoding, expressionLiteral(',unbound') ]);
  }

  /**
   * Encodes one argument, which can be any expression, as a BIND to a variable followed by the variable would be.
   * @param argument - The argument, like `?v`, `<<( ?s ?p ?o )>>` or `STR(?v)`.
   * @returns The encoding, `,unbound` when the argument errors.
   * @throws Error if the argument is no term and differs each time it is evaluated, as its encoding evaluates it
   * more than once
   */
  function encodeArgument(argument: Algebra.Expression): Algebra.Expression {
    const depth = c.tripleTermArgumentDepth;
    const term = constructedTermOf(argument);
    if (term === undefined) {
      if (holdsExpression(argument, held =>
        held.subType === Algebra.ExpressionTypes.OPERATOR && unstableOperators.has(held.operator))) {
        throw new Error('An argument of <internal://blank> like RAND() is only supported in a BIND or FILTER.');
      }
      return orUnbound(argument, encodeTerm(argument, expressionRange(argument, scope), depth));
    }
    const termExpression = AF.createTermExpression(term);
    const encoding = encodeTerm(termExpression, rangeOfWritten(term), depth);
    return termCertainlyEvaluates(term, scope) ? encoding : orUnbound(termExpression, encoding);
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
  return concat(expression.args.map(encodeArgument));
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
  if (!holdsExpression(op, held => (held.subType === Algebra.ExpressionTypes.NAMED && isInternalBnode(held)) ||
    (held.subType === Algebra.ExpressionTypes.OPERATOR && held.operator === 'isblank'))) {
    return op;
  }
  const { AF } = c;
  const coinArgumentVariable = freshVarGenerator(markVariableNamesUsed(c, op), 'mBnodeArgument');
  const expressionKey = new Set([ 'expression' ]);

  /**
   * Materialises the internal blank nodes in an expression and rewrites its `ISBLANK`s.
   * @param expression - The expression to transform.
   * @param materialise - Materialises one internal blank node, whose arguments are transformed already.
   * @returns The transformed expression.
   */
  function materialiseInExpression(
    expression: Algebra.Expression,
    materialise: (named: Algebra.NamedExpression) => Algebra.Expression,
  ): Algebra.Expression {
    return algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: {
      existence: { preVisitor: () => ({ continue: false }), transform: (existence) => {
        existence.input = materialiseAll(existence.input, false);
        return existence;
      } },
      named: { transform: named => isInternalBnode(named) ? materialise(named) : named },
      operator: { transform: operator =>
        operator.operator === 'isblank' ? isMaterialisedBnode(operator.args) : operator },
    }});
  }

  /**
   * Materialises the internal blank nodes in the expression of an EXTEND or FILTER, binding each argument that is no
   * term to a fresh variable of its input first, so it is evaluated once rather than in every branch of its encoding.
   * @param operation - The EXTEND or FILTER, a copy of its own that is changed in place.
   * @param rangesInput - Its input as it was, to read the ranges off; absent where they do not hold.
   * @returns The operation.
   */
  function materialiseExpressionOf(
    operation: Algebra.Extend | Algebra.Filter,
    rangesInput?: Algebra.Operation,
  ): Algebra.Extend | Algebra.Filter {
    operation.expression = materialiseInExpression(operation.expression, (named) => {
      const args = named.args.map((argument) => {
        if (constructedTermOf(argument) !== undefined) {
          return argument;
        }
        const variable = coinArgumentVariable();
        operation.input = AF.createExtend(operation.input, variable, argument);
        rangesInput &&= AF.createExtend(rangesInput, variable, argument);
        return AF.createTermExpression(variable);
      });
      const scope = rangesInput && cpMetaOf(rangesInput);
      return materialiseEncoding(encodeInternalBnode(c, AF.createNamedExpression(named.name, args), scope));
    });
    return operation;
  }

  /**
   * Materialises the internal blank nodes in an operation or in the pattern of an EXISTS.
   * @param operation - The operation to transform.
   * @param withRanges - Whether the ranges of an input hold for the expression over it, not so in an EXISTS.
   * @returns The transformed operation.
   */
  function materialiseAll<O extends Algebra.Operation>(operation: O, withRanges: boolean): O {
    // The ranges are read off the original input, a copy without metadata the post-order traversal is done with, so
    // the metadata reading them caches never lands on the result.
    const ofExtendOrFilter = {
      preVisitor: () => ({ ignoreKeys: expressionKey }),
      transform: (copy: Algebra.Extend | Algebra.Filter, original: Algebra.Extend | Algebra.Filter) =>
        materialiseExpressionOf(copy, withRanges ? original.input : undefined),
    };
    return algebraUtils.mapOperation<'unsafe', O>(withRanges ? withoutCpVars(operation) : operation, {
      [Algebra.Types.EXTEND]: ofExtendOrFilter,
      [Algebra.Types.FILTER]: ofExtendOrFilter,
      // Any other expression, like the condition of an OPTIONAL, gets every branch.
      [Algebra.Types.EXPRESSION]: {
        preVisitor: () => ({ continue: false }),
        transform: expression =>
          materialiseInExpression(expression, named => materialiseEncoding(encodeInternalBnode(c, named))),
      },
    });
  }

  return materialiseAll(op, true);
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
