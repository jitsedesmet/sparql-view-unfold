import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import { withoutCpVars } from '../utils/certainlyBoundVars.js';
import type { EnclosingScope } from '../utils/existenceScope.js';
import { mapExistenceExpressions, topLevelScope } from '../utils/existenceScope.js';
import { conjunctionOf } from '../utils/expressionHelpers.js';
import { unionSets } from '../utils/setUtils.js';
import { collectVariableNames, freshVarGenerator, renameVariables } from '../utils.js';

/**
 * @fileoverview Keeps every `EXISTS` correlated with the solution it is evaluated against, ahead of the
 * unfolding.
 *
 * The unfolding binds the variables of a triple pattern with a `BIND` over the mapping body. Inside an
 * `EXISTS`, a variable the enclosing solution binds is not the pattern's to bind: substituting the solution
 * into the pattern leaves a `BIND` of a term (SPARQL 1.1 §18.6 does not define it), and Comunica drops such
 * a `BIND`, losing the correlation altogether. So before the unfolding, such a variable is renamed out of
 * every triple pattern it occurs in, and read back by a `FILTER(sameTerm(?outer, ?local))` over that
 * pattern instead. A condition reads the enclosing solution the same way whether it is substituted or
 * injected, so the rewrite means one thing on every engine.
 *
 * That only works where the enclosing solution certainly binds the variable: where it is unbound, the
 * pattern has to bind it, for the rest of the `EXISTS` to join on. A variable the enclosing scope only
 * possibly binds therefore splits the `EXISTS` on `bound(?x)`, into a copy where it is certainly bound and
 * one where it is renamed apart, being the pattern's own there.
 */

/**
 * The variables of the triple patterns of an operation, those of nested `EXISTS` patterns included and
 * those inside a `SERVICE` excluded.
 * @param c - The transformation context
 * @param op - The operation to read
 * @returns the variable names
 */
function patternVariables(c: TransformationContext, op: Algebra.Operation): Set<string> {
  const names = new Set<string>();
  algebraUtils.visitOperation(op, {
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    [Algebra.Types.PATTERN]: { visitor: (pattern) => {
      for (const name of collectVariableNames(c.astTransformer, pattern)) {
        names.add(name);
      }
    } },
  });
  return names;
}

/**
 * Renames the given variables out of every BGP they occur in, outside nested `EXISTS` patterns, `SERVICE`s
 * and the projections hiding them, and asserts each renamed variable to equal its original over that BGP.
 * @param c - The transformation context
 * @param freshVariable - Coins the local variable a renamed one becomes
 * @param op - The pattern of an `EXISTS`
 * @param correlated - The variables the enclosing solution certainly binds
 * @returns the pattern, reading those variables only in conditions
 */
function correlatePatterns(
  c: TransformationContext,
  freshVariable: () => RDF.Variable,
  op: Algebra.Operation,
  correlated: ReadonlySet<string>,
): Algebra.Operation {
  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(op, {
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    [Algebra.Types.PROJECT]: {
      preVisitor: () => ({ continue: false }),
      transform: project => c.AF.createProject(
        correlatePatterns(c, freshVariable, project.input, new Set(project.variables
          .map(variable => variable.value).filter(name => correlated.has(name)))),
        project.variables,
      ),
    },
    [Algebra.Types.BGP]: { transform: (bgp) => {
      const renames: Record<string, RDF.Variable> = {};
      for (const name of collectVariableNames(c.astTransformer, bgp)) {
        if (correlated.has(name)) {
          renames[name] = freshVariable();
        }
      }
      const correlations = Object.entries(renames).map(([ name, local ]) => c.AF.createOperatorExpression(
        'sameterm',
        [ c.AF.createTermExpression(c.DF.variable(name)), c.AF.createTermExpression(local) ],
      ));
      return correlations.length === 0 ?
        bgp :
        c.AF.createFilter(renameVariables(c, bgp, renames), conjunctionOf(c, correlations));
    } },
    // A nested EXISTS was correlated with its own scope already.
    [Algebra.Types.EXPRESSION]: { preVisitor: expression =>
      ({ continue: expression.subType !== Algebra.ExpressionTypes.EXISTENCE }) },
  });
}

/**
 * Correlates one `EXISTS` and the ones nested in its pattern with the scope it is evaluated in.
 * @param c - The transformation context
 * @param freshVariable - Coins the local variables
 * @param existence - The `EXISTS` or `NOT EXISTS`
 * @param scope - The scope it is evaluated in
 * @returns the expression taking its place: the correlated `EXISTS`, or an `IF(bound(?x), …, …)` over two
 * where the scope only possibly binds a variable of its patterns
 */
function correlateExistence(
  c: TransformationContext,
  freshVariable: () => RDF.Variable,
  existence: Algebra.ExistenceExpression,
  scope: EnclosingScope,
): Algebra.Expression {
  const possiblyUnbound = [ ...patternVariables(c, existence.input) ]
    .find(name => scope.possiblyBound.has(name) && !scope.certainlyBound.has(name));
  if (possiblyUnbound !== undefined) {
    const variable = c.DF.variable(possiblyUnbound);
    // Where it is unbound, it is a variable of the pattern like any other, renamed apart from the scope.
    const whereUnbound = c.AF.createExistenceExpression(
      existence.not,
      renameVariables(c, existence.input, { [possiblyUnbound]: freshVariable() }),
    );
    return c.AF.createOperatorExpression('if', [
      c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(variable) ]),
      correlateExistence(c, freshVariable, existence, {
        ...scope,
        certainlyBound: unionSets([ scope.certainlyBound, new Set([ possiblyUnbound ]) ]),
      }),
      correlateExistence(c, freshVariable, whereUnbound, scope),
    ]);
  }
  const nestedCorrelated = correlateExistencePatternsWithin(c, freshVariable, existence.input, scope);
  return c.AF.createExistenceExpression(
    existence.not,
    correlatePatterns(c, freshVariable, nestedCorrelated, scope.certainlyBound),
  );
}

/**
 * Correlates every `EXISTS` of an operation with the scope it is evaluated in.
 * @param c - The transformation context
 * @param freshVariable - Coins the local variables
 * @param op - The operation
 * @param enclosing - The scope the operation is evaluated in
 * @returns the operation, its `EXISTS` patterns binding no variable the enclosing solution binds
 */
function correlateExistencePatternsWithin(
  c: TransformationContext,
  freshVariable: () => RDF.Variable,
  op: Algebra.Operation,
  enclosing: EnclosingScope,
): Algebra.Operation {
  return mapExistenceExpressions(op, enclosing, (existence, scope) =>
    correlateExistence(c, freshVariable, existence, scope));
}

/**
 * Rewrites every `EXISTS` of a user query outside a `SERVICE` so that no triple pattern in it names a
 * variable the solution it is evaluated against binds, a condition reading that variable instead.
 * @param c - The transformation context
 * @param op - The user query, its paths expanded
 * @returns the query, whose unfolding keeps every `EXISTS` correlated
 */
export function correlateExistencePatterns<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  const freshVariable = freshVarGenerator(
    collectVariableNames(c.astTransformer, op),
    `${VAR_PREFIX_USER_QUERY}exists_`,
  );
  return withoutCpVars(<T> correlateExistencePatternsWithin(c, freshVariable, withoutCpVars(op), topLevelScope));
}
