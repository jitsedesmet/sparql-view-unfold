import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { cpMetaOf } from './certainlyBoundVars.js';
import { unionSets } from './setUtils.js';

/**
 * @fileoverview The scope an `EXISTS` is evaluated in.
 *
 * SPARQL evaluates `EXISTS { P }` against the solution `μ` of the operation holding it - by substituting
 * `μ` into `P` (SPARQL 1.1 §18.6), or by injecting it as initial bindings, depending on the engine and the
 * spec revision. Either way a variable of `P` that `μ` may bind is not a variable of `P` alone, and a pass
 * reading `P` as a query of its own - concluding that a variable nothing in `P` binds is unbound, binding
 * one with a `BIND` - changes what the `EXISTS` answers.
 */

/** The variables the solution an `EXISTS` is evaluated against may bind, and those it binds certainly. */
export interface EnclosingScope {
  possiblyBound: ReadonlySet<string>;
  certainlyBound: ReadonlySet<string>;
}

/** The scope of the query itself, which nothing encloses. */
export const topLevelScope: EnclosingScope = { possiblyBound: new Set(), certainlyBound: new Set() };

/**
 * The scope the expressions of an operation are evaluated in: what its operands bind, a `LEFT JOIN`'s
 * condition reading both of them, on top of what encloses the operation.
 * @param op - The operation holding the expressions
 * @param enclosing - The scope the operation itself is evaluated in
 * @returns the scope
 */
function scopeOfExpressionsOf(op: Algebra.Operation, enclosing: EnclosingScope): EnclosingScope {
  const input: unknown = (<{ input?: unknown }> op).input;
  const operands = (Array.isArray(input) ? input : [ input ]).map(operand => cpMetaOf(<Algebra.Operation> operand));
  return {
    possiblyBound: unionSets([ enclosing.possiblyBound, ...operands.map(operand => new Set(operand.vRanges.keys())) ]),
    certainlyBound: unionSets([ enclosing.certainlyBound, ...operands.map(operand => operand.cVars) ]),
  };
}

/**
 * Maps every `EXISTS` and `NOT EXISTS` of an operation outside a `SERVICE` - whose endpoint evaluates it -
 * handing each the scope it is evaluated in. An `EXISTS` nested in the pattern of another is left to the
 * mapper, which knows what that pattern adds to the scope.
 * @param op - The operation to map
 * @param enclosing - The scope the operation is evaluated in
 * @param mapper - What takes the place of an existence expression, given the scope it is evaluated in
 * @returns the mapped operation
 */
export function mapExistenceExpressions<T extends Algebra.Operation>(
  op: T,
  enclosing: EnclosingScope,
  mapper: (existence: Algebra.ExistenceExpression, scope: EnclosingScope) => Algebra.Expression,
): T {
  const mapExpressionOf = <E extends Algebra.Expression>(holder: Algebra.Operation, expression: E): E =>
    algebraUtils.mapOperationSub<'unsafe', E>(expression, {}, { [Algebra.Types.EXPRESSION]: {
      [Algebra.ExpressionTypes.EXISTENCE]: {
        preVisitor: () => ({ continue: false }),
        transform: existence => mapper(existence, scopeOfExpressionsOf(holder, enclosing)),
      },
    }});
  return algebraUtils.mapOperation<'unsafe', T>(op, {
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    [Algebra.Types.FILTER]: { transform: filter =>
      Object.assign(filter, { expression: mapExpressionOf(filter, filter.expression) }) },
    [Algebra.Types.EXTEND]: { transform: extend =>
      Object.assign(extend, { expression: mapExpressionOf(extend, extend.expression) }) },
    [Algebra.Types.LEFT_JOIN]: { transform: leftJoin =>
      Object.assign(leftJoin, { expression: leftJoin.expression && mapExpressionOf(leftJoin, leftJoin.expression) }) },
    [Algebra.Types.ORDER_BY]: { transform: orderBy =>
      Object.assign(orderBy, { expressions: orderBy.expressions.map(key => mapExpressionOf(orderBy, key)) }) },
    [Algebra.Types.GROUP]: { transform: group =>
      Object.assign(group, { aggregates: group.aggregates.map(aggregate => mapExpressionOf(group, aggregate)) }) },
    // The pattern of an EXISTS is the mapper's to traverse.
    [Algebra.Types.EXPRESSION]: { preVisitor: expression =>
      ({ continue: expression.subType !== Algebra.ExpressionTypes.EXISTENCE }) },
  });
}
