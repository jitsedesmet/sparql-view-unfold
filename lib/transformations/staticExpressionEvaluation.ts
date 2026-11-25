import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { ExpressionEngine } from '@comunica/expressions-sparql';
import type { IExpressionEngine } from '@comunica/types';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { QueryTransformation } from '../types.js';
import { foldsToConstantTerm } from '../utils/expressionHelpers.js';

/**
 * @fileoverview Folds fully static expressions through Comunica's standalone expression engine.
 *
 * Where {@link utils/partialExpressionEvaluation!constantFoldOperator} hand-folds the few operators the
 * pushdown depends on, this pass hands *any* static operator expression - `1 + 2`, `CONCAT("a", "b")`,
 * `STRLEN("abc")` - to Comunica's reference implementation and writes back the term it evaluates to.
 * `@comunica/utils-algebra` builds its algebra directly on `@traqula/algebra-transformations-1-2`, so this
 * project's expressions can be fed to the evaluator without conversion. The evaluator is asynchronous, hence
 * a standalone pass rather than a fold inside the synchronous substitution.
 */

/**
 * The pipeline step folding every fully static expression to the term it evaluates to.
 * @param engine - The engine evaluating the expressions, whose function overload cache is shared across rewrites
 * @returns the transformation
 */
export function simplifyStaticExpressionsTransformation(
  engine: IExpressionEngine = new ExpressionEngine(),
): QueryTransformation {
  return (c, operation) => {
    // The binding is empty: a static expression has no variable left to substitute.
    const emptyBindings = new BindingsFactory(c.DF).bindings();
    const context = new ActionContext().set(KeysInitQuery.rdfVariant, c.generalizedRdf ? 'generalizedRdf' : 'rdf');

    // A post-order walk visits an operator after its arguments, so a static argument has already been folded
    // to a term by the time its operator is seen: {@link foldsToConstantTerm} then decides staticness from
    // the direct arguments alone. Because `NOW()` never folds, anything reading it is left standing too.
    return algebraUtils.mapOperationAsync<'unsafe', Algebra.Operation>(operation, {
      [Algebra.Types.EXPRESSION]: {
        transform: async(expression) => {
          if (foldsToConstantTerm(expression)) {
            try {
              const evaluator = await engine.createEvaluator(expression, context);
              return c.AF.createTermExpression(await evaluator.evaluate(emptyBindings));
            } catch {
              // An error is not `false` in every context (`COALESCE(Error, false, true)`), so a raising
              // expression is left standing.
            }
          }
          return expression;
        },
      },
    });
  };
}
