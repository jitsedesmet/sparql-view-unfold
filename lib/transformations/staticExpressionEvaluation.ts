/* eslint-disable import/no-nodejs-modules -- Components.js is bootstrapped from Node's module resolution */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ActorExpressionEvaluatorFactory } from '@comunica/bus-expression-evaluator-factory';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { ComponentsManager } from 'componentsjs';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { foldsToConstantTerm } from '../utils/expressionHelpers.js';

/**
 * @fileoverview Folds fully static expressions through Comunica's Expression Evaluator.
 *
 * Where {@link utils/partialExpressionEvaluation!constantFoldOperator} hand-folds the few operators the
 * pushdown depends on, this pass hands *any* static operator expression - `1 + 2`, `CONCAT("a", "b")`,
 * `STRLEN("abc")` - to Comunica's reference implementation and writes back the term it evaluates to.
 * `@comunica/utils-algebra` builds its algebra directly on `@traqula/algebra-transformations-1-2`, so this
 * project's expressions can be fed to the evaluator without conversion. The evaluator is asynchronous, hence
 * a standalone pass rather than a fold inside the synchronous substitution.
 */

/** The IRI the default Comunica configuration gives its runner. */
const RUNNER_IRI = 'urn:comunica:default:Runner';

let factoryPromise: Promise<ActorExpressionEvaluatorFactory> | undefined;

/**
 * Builds the default Comunica expression evaluator factory, wired with every function actor.
 * @returns the factory, able to build an evaluator for a single expression
 */
async function buildExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
  // The whole runner is instantiated - not the factory alone - because the function actors register on
  // their bus as a side effect of construction, and the factory reads that bus through a mediator.
  // `@comunica/query-sparql-file` is the module that has all of them installed.
  const require = createRequire(join(process.cwd(), 'package.json'));
  const mainModulePath = dirname(require.resolve('@comunica/query-sparql-file/package.json'));
  const configPath = require.resolve('@comunica/config-query-sparql/config/config-default.json');

  const manager = await ComponentsManager.build({ mainModulePath, typeChecking: false });
  await manager.configRegistry.register(configPath);
  const runner: { actors: unknown[] } = await manager.instantiate(RUNNER_IRI);
  const factory: unknown = runner.actors.find(actor =>
    typeof (<{ name?: unknown }> actor).name === 'string' &&
    (<{ name: string }> actor).name.includes('expression-evaluator-factory'));
  if (factory === undefined) {
    throw new Error('No expression evaluator factory actor in the default Comunica configuration');
  }
  return <ActorExpressionEvaluatorFactory> factory;
}

/**
 * The default Comunica expression evaluator factory, built once and cached across calls.
 * @returns the shared factory
 */
async function getExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
  factoryPromise ??= buildExpressionEvaluatorFactory();
  return factoryPromise;
}

/**
 * Prepares a function that evaluates a static expression over a fresh, shared Comunica action context.
 * @param c - The transformation context, for its data factory
 * @returns an evaluator returning the resulting term, or `undefined` when evaluation raises
 */
async function prepareStaticEvaluator(
  c: TransformationContext,
): Promise<(expression: Algebra.Expression) => Promise<RDF.Term | undefined>> {
  const factory = await getExpressionEvaluatorFactory();
  const emptyBindings = new BindingsFactory(c.DF).bindings();
  const context = new ActionContext({
    [KeysInitQuery.queryTimestamp.name]: new Date(),
    [KeysInitQuery.dataFactory.name]: c.DF,
    [KeysInitQuery.functionArgumentsCache.name]: {},
  });
  return async(expression) => {
    try {
      const action = <Parameters<ActorExpressionEvaluatorFactory['run']>[0]>
        <unknown> { algExpr: expression, context };
      const evaluator = await factory.run(action, undefined);
      // The binding is empty: a static expression has no variable left to substitute.
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
  const evaluate = await prepareStaticEvaluator(c);

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
