import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { ExpressionEngine } from '@comunica/expressions-sparql';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
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

/** Built on first use, so that importing the package does not instantiate Comunica's actors. */
let expressionEngine: ExpressionEngine | undefined;

/**
 * Prepares a function evaluating a static expression, under the data factory and RDF variant of the rewrite.
 * @param c - The transformation context
 * @returns an evaluator returning the resulting term, or `undefined` when evaluation raises
 */
function prepareStaticEvaluator(
  c: TransformationContext,
): (expression: Algebra.Expression) => Promise<RDF.Term | undefined> {
  expressionEngine ??= new ExpressionEngine();
  const engine = expressionEngine;
  // The binding is empty: a static expression has no variable left to substitute.
  const emptyBindings = new BindingsFactory(c.DF).bindings();
  const context = new ActionContext()
    .set(KeysInitQuery.dataFactory, c.DF)
    .set(KeysInitQuery.rdfVariant, c.generalizedRdf ? 'generalizedRdf' : 'rdf');
  return async(expression) => {
    try {
      const evaluator = await engine.createEvaluator(expression, context);
      return await evaluator.evaluate(emptyBindings);
    } catch {
      // An error is not `false` in every context (`COALESCE(Error, false, true)`), so a raising expression
      // is left standing; falling through yields `undefined`, read by the caller as "leave it standing".
    }
  };
}

/**
 * Folds every static expression in an operation through the Comunica Expression Evaluator, replacing each
 * static operator subtree with the term it evaluates to.
 * @param c - The transformation context
 * @param operation - The operation to simplify
 * @returns a copy of the operation with its static expressions folded
 */
export async function simplifyStaticExpressions<T extends Algebra.Operation>(
  c: TransformationContext,
  operation: T,
): Promise<T> {
  const evaluate = prepareStaticEvaluator(c);

  // A post-order walk visits an operator after its arguments, so a static argument has already been folded
  // to a term by the time its operator is seen: {@link foldsToConstantTerm} then decides staticness from
  // the direct arguments alone. A raising expression yields `undefined` and is left standing; because
  // `NOW()` never folds, anything reading it keeps a non-constant argument and is left standing too.
  return algebraUtils.mapOperationAsync<'unsafe', T>(operation, {
    [Algebra.Types.EXPRESSION]: {
      transform: async(expression) => {
        if (foldsToConstantTerm(expression)) {
          const term = await evaluate(expression);
          if (term !== undefined) {
            return c.AF.createTermExpression(term);
          }
        }
        return expression;
      },
    },
  });
}

/**
 * The pipeline step folding every fully static expression to the term it evaluates to.
 * @returns the transformation
 */
export function simplifyStaticExpressionsTransformation(): QueryTransformation {
  return simplifyStaticExpressions;
}
