import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { triplePositions } from '../datastructures/TermClusterSet.js';
import { literalRange, RangeSet, rangeOfPosition, subjectRange, tripleTermRange } from '../RangeSet.js';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { componentOf } from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import {
  cpMetaOf,
  rewriteInExistenceScopes,
  termCertainlyEvaluates,
  withoutCpVars,
} from '../utils/certainlyBoundVars.js';
import {
  constructedTermOf,
  createBooleanExpression,
} from '../utils/expressionHelpers.js';
import { differenceSets, isSubsetOf } from '../utils/setUtils.js';
import { freshVarGenerator, markVariableNamesUsed } from '../utils.js';
import { materialiseInternalBnodesByExtensionFunction } from './bnodeExtensionFunction.js';
import type { InternalBnodeMaterialisation } from './internalBnodeMaterialisation.js';
import {
  holdsInternalBnodeOrIsBlank,
  internalBnodeEncodingTags,
  internalBnodeExpressionCallbacks,
  specialIriMaterialisation,
  specialLiteralMaterialisation,
} from './internalBnodeMaterialisation.js';

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
 * Encodes the arguments of an internal blank node into a string that is equal exactly when the arguments are,
 * whatever branches their ranges leave out.
 *
 * The output encodes each argument's value after a tag, writing every string as `,<length>:<string>` so that it
 * needs no escaping:
 * - IRIs: `,iri,<length>:<iri>`
 * - Literals: `,literal` followed by their value, datatype, language and base direction, the last two empty where
 *   they have none
 * - Triple terms: `,triple` followed by the encodings of its subject, predicate and object
 * - Arguments that are unbound or error, as a BIND would leave them unbound: `,unbound`, which no value gives
 *
 * @param c - The transformation context
 * @param expression - The internal blank node expression
 * @param scope - What the solutions the expression is evaluated over bind; nothing is known where it is absent.
 * @returns The encoding
 */
function encodeInternalBnode(
  c: TransformationContext,
  expression: Algebra.NamedExpression,
  scope?: CPMeta,
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  /**
   * Chooses between two expressions by a type test of a term.
   * @param operator - The type test, like `isiri`.
   * @param termExpression - An expression giving the term.
   * @param then - What to give where the test holds.
   * @param otherwise - What to give where it does not.
   * @returns The choice.
   */
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
   * Concatenates strings, splicing in the parts of one that is a CONCAT itself and joining adjacent constants.
   * @param parts - The strings, all simple literals.
   * @returns Their concatenation, or the one part there is.
   */
  function concat(parts: Algebra.Expression[]): Algebra.Expression {
    const joined: Algebra.Expression[] = [];
    for (const part of parts.flatMap(part =>
      part.subType === Algebra.ExpressionTypes.OPERATOR && part.operator === 'concat' ? part.args : [ part ])) {
      const previous = joined.at(-1);
      if (previous?.subType === Algebra.ExpressionTypes.TERM && previous.term.termType === 'Literal' &&
        part.subType === Algebra.ExpressionTypes.TERM && part.term.termType === 'Literal') {
        joined[joined.length - 1] = expressionLiteral(previous.term.value + part.term.value);
      } else {
        joined.push(part);
      }
    }
    return joined.length === 1 ? joined[0] : AF.createOperatorExpression('concat', joined);
  }

  /**
   * Writes a string as its length and itself, which tells where it ends whatever characters it holds.
   * @param value - An expression giving the string, like `STR(?v)`.
   * @returns The field, `,<length>:<string>`.
   */
  function field(value: Algebra.Expression): Algebra.Expression {
    return concat([
      expressionLiteral(','),
      AF.createOperatorExpression('str', [ AF.createOperatorExpression('strlen', [ value ]) ]),
      expressionLiteral(':'),
      value,
    ]);
  }

  /**
   * Encodes a term that is an IRI or a literal, testing which one only where its range admits both.
   * @param termExpression - An expression giving the term, like `?v` or `OBJECT(?t)`.
   * @param range - The term types the term can be.
   * @returns The encoding, which errors when the term is unbound or a triple term.
   */
  function encodeIriOrLiteral(termExpression: Algebra.Expression, range: RangeSet): Algebra.Expression {
    const termFunction = (operator: string): Algebra.Expression =>
      AF.createOperatorExpression(operator, [ termExpression ]);
    const iriEncoding = concat([ expressionLiteral(internalBnodeEncodingTags.iri), field(termFunction('str')) ]);
    // An IRI or a blank node, which is disallowed, so an IRI.
    if (isSubsetOf(range, subjectRange)) {
      return iriEncoding;
    }
    const literalEncoding = concat([
      expressionLiteral(internalBnodeEncodingTags.literal),
      field(termFunction('str')),
      field(AF.createOperatorExpression('str', [ termFunction('datatype') ])),
      field(termFunction('lang')),
      field(termFunction('langdir')),
    ]);
    if (isSubsetOf(range, literalRange)) {
      return literalEncoding;
    }
    // A triple term left in the range is nested too deeply: its DATATYPE errors.
    return ifTermIs('isiri', termExpression, iriEncoding, literalEncoding);
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
    const componentExpression = component === undefined ?
      AF.createOperatorExpression(position, [ termExpression ]) :
      AF.createTermExpression(component);
    // Only encoded once constructed, so the component is a term its position admits.
    return [ componentExpression, c.expressionRange(c, componentExpression, scope).meet(rangeOfPosition(position)) ];
  }

  /**
   * Encodes a term, a triple term through its components, unrolled `depth` triple terms deep.
   * @param termExpression - An expression giving the term, like `?v`, `OBJECT(?t)` or `<<( ?s ?p ?o )>>`.
   * @param range - The term types the term can be.
   * @param depth - How many nested triple terms are still unrolled; a deeper one errors.
   * @returns The encoding, which errors when the term is unbound.
   */
  function encodeTerm(termExpression: Algebra.Expression, range: RangeSet, depth: number): Algebra.Expression {
    if (depth === 0 || !range.has('Quad')) {
      return encodeIriOrLiteral(termExpression, range);
    }
    const tripleTermEncoding = concat([
      expressionLiteral(internalBnodeEncodingTags.triple),
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
    const unbound = expressionLiteral(internalBnodeEncodingTags.unbound);
    return AF.createOperatorExpression('if', [ evaluates, encoding, unbound ]);
  }

  /**
   * Encodes one argument, which can be any expression, as a BIND to a variable followed by the variable would be.
   * @param argument - The argument, like `?v`, `<<( ?s ?p ?o )>>` or `STR(?v)`.
   * @returns The encoding, `,unbound` when the argument errors.
   */
  function encodeArgument(argument: Algebra.Expression): Algebra.Expression {
    const term = constructedTermOf(argument);
    const termExpression = term === undefined ? argument : AF.createTermExpression(term);
    const encoding = encodeTerm(termExpression, c.expressionRange(c, termExpression, scope), c.tripleTermArgumentDepth);
    return term !== undefined && scope !== undefined && termCertainlyEvaluates(term, scope) ?
      encoding :
      orUnbound(termExpression, encoding);
  }

  // ====================== Implementation ========================

  // In the order the arguments are written: removeProjections gives hidden variables fresh names per pattern,
  // so an order read off their names would differ between two patterns constructing the same node.
  return concat(expression.args.map(encodeArgument));
}

/**
 * Materialises every internal blank node in an operation and rewrites `ISBLANK` to recognise what they became.
 * One in an expression over the input of an EXTEND, FILTER, ORDER BY or GROUP is encoded with the ranges of that input,
 * which in the pattern of an EXISTS include the solution it is evaluated for.
 * @param c - The transformation context
 * @param op - The operation to transform
 * @param materialisation - What the internal blank nodes become.
 * @returns The transformed operation
 */
function materialiseInternalBnodes<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  materialisation: InternalBnodeMaterialisation,
): T {
  const { AF } = c;
  const coinArgumentVariable = freshVarGenerator(markVariableNamesUsed(c, op), 'mBnodeArgument');

  /**
   * Materialises the internal blank nodes in an expression and rewrites its `ISBLANK`s.
   * @param expression - The expression to transform.
   * @param encodeArguments - Encodes one internal blank node with arguments, which are materialised already.
   * @returns The transformed expression.
   */
  function materialiseInExpression(
    expression: Algebra.Expression,
    encodeArguments: (named: Algebra.NamedExpression) => Algebra.Expression,
  ): Algebra.Expression {
    return algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expression, {}, { expression: {
      // The pattern of an EXISTS is materialised in its own scope, by `rewriteInExistenceScopes`.
      existence: { preVisitor: () => ({ continue: false }) },
      ...internalBnodeExpressionCallbacks(c, materialisation, encodeArguments),
    }});
  }

  /**
   * Materialises the internal blank nodes in an expression over the input of an operation, binding each argument that
   * is no term to a fresh variable of that input first, so it is evaluated once rather than in every branch of its
   * encoding.
   * @param context - The context to read the ranges of the input in.
   * @param operation - The operation, a copy of its own whose input is changed in place.
   * @returns What materialises an expression over the input.
   */
  function materialiserOverInputOf(
    context: TransformationContext,
    operation: Algebra.Single,
  ): (expression: Algebra.Expression) => Algebra.Expression {
    return expression => materialiseInExpression(expression, (named) => {
      const args = named.args.map((argument) => {
        if (constructedTermOf(argument) !== undefined) {
          return argument;
        }
        const variable = coinArgumentVariable();
        operation.input = AF.createExtend(operation.input, variable, argument);
        return AF.createTermExpression(variable);
      });
      const scope = cpMetaOf(context, operation.input);
      return encodeInternalBnode(context, AF.createNamedExpression(named.name, args), scope);
    });
  }

  /**
   * Materialises the internal blank nodes in an operation, leaving an EXISTS pattern to `rewriteInExistenceScopes`.
   * @param context - The context to read ranges in.
   * @param operation - The operation to transform.
   * @returns The transformed operation.
   */
  function materialiseAll(context: TransformationContext, operation: Algebra.Operation): Algebra.Operation {
    /**
     * Materialises what the expressions an operation evaluates over its input hold.
     * @param key - Where the operation holds them, one expression or a list.
     * @returns The callbacks doing so.
     */
    function overInput(key: 'expression' | 'expressions' | 'aggregates'): {
      preVisitor: () => { ignoreKeys: Set<string> };
      transform: (copy: Algebra.Single) => Algebra.Single;
    } {
      const ignoreKeys = new Set([ key ]);
      return {
        preVisitor: () => ({ ignoreKeys }),
        transform: (copy) => {
          const holder = <Record<typeof key, Algebra.Expression | Algebra.Expression[]>> <unknown> copy;
          const materialise = materialiserOverInputOf(context, copy);
          const held = holder[key];
          holder[key] = Array.isArray(held) ? held.map(materialise) : materialise(held);
          return copy;
        },
      };
    }
    return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(operation, {
      [Algebra.Types.EXTEND]: overInput('expression'),
      [Algebra.Types.FILTER]: overInput('expression'),
      [Algebra.Types.ORDER_BY]: overInput('expressions'),
      [Algebra.Types.GROUP]: overInput('aggregates'),
      // The condition of an OPTIONAL, the one expression left, has no input to bind an argument in, so it gets every
      // branch.
      [Algebra.Types.EXPRESSION]: {
        preVisitor: () => ({ continue: false }),
        transform: expression =>
          materialiseInExpression(expression, named => encodeInternalBnode(context, named)),
      },
    });
  }

  // The ranges cache metadata on the copy, so it starts and ends without any.
  return withoutCpVars(rewriteInExistenceScopes(c, withoutCpVars(op), materialiseAll));
}

/** How a pipeline step materialises internal blank nodes. */
export interface InternalBnodeMaterialisationOptions {
  /** Leave the encoding to {@link transformations/bnodeExtensionFunction!internalBnodeExtensionFunctions}. */
  encodedByExtensionFunction?: boolean;
}

/**
 * The pipeline step materialising every internal blank node as a materialisation does.
 * @param materialisation - What the internal blank nodes become.
 * @param options - Whether an extension function encodes them.
 * @returns the transformation
 */
function internalBnodeMaterialisationTransformation(
  materialisation: InternalBnodeMaterialisation,
  options: InternalBnodeMaterialisationOptions,
): QueryTransformation {
  const materialise = options.encodedByExtensionFunction ?
    materialiseInternalBnodesByExtensionFunction :
    materialiseInternalBnodes;
  return (c, op) => holdsInternalBnodeOrIsBlank(op) ? materialise(c, op, materialisation) : op;
}

/**
 * The pipeline step materialising every internal blank node as a typed literal of a special datatype.
 * @param options - Whether an extension function encodes them.
 * @returns the transformation
 */
export function internalBnodeAsSpecialLiteralTransformation(
  options: InternalBnodeMaterialisationOptions = {},
): QueryTransformation {
  return internalBnodeMaterialisationTransformation(specialLiteralMaterialisation, options);
}

/**
 * The pipeline step materialising every internal blank node as a prefixed IRI.
 * @param options - Whether an extension function encodes them.
 * @returns the transformation
 */
export function internalBnodeAsSpecialIriTransformation(
  options: InternalBnodeMaterialisationOptions = {},
): QueryTransformation {
  return internalBnodeMaterialisationTransformation(specialIriMaterialisation, options);
}
