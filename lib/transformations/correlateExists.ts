import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import type { Assertion } from '../utils/assertions.js';
import { access, assertStrong, assertWeak, conjunctAsExpression } from '../utils/assertions.js';
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
 * every triple pattern, `BIND` and `VALUES` binding it - the zero length match of a `?` path is a `BIND` - and
 * read back by a condition over that operation instead: `sameTerm(?local, ?outer)`, or `!bound(?local) ||
 * sameTerm(?local, ?outer)` where the operation may leave the local unbound. A condition reads the enclosing
 * solution the same way whether it is substituted or injected, so the rewrite means one thing on every engine.
 *
 * That only works where the enclosing solution certainly binds the variable: where it is unbound, the
 * pattern has to bind it, for the rest of the `EXISTS` to join on. A variable the enclosing scope only
 * possibly binds therefore splits the `EXISTS` on `bound(?x)`, into a copy where it is certainly bound and
 * one where it is renamed apart, being the pattern's own there.
 */

/**
 * The variables the triple patterns, `BIND`s and `VALUES` of an operation bind, those of nested `EXISTS`
 * patterns included and those inside a `SERVICE` excluded.
 * @param c - The transformation context
 * @param op - The operation to read
 * @returns the variable names
 */
function boundVariables(c: TransformationContext, op: Algebra.Operation): Set<string> {
  const names = new Set<string>();
  algebraUtils.visitOperation(op, {
    [Algebra.Types.SERVICE]: { preVisitor: () => ({ continue: false }) },
    [Algebra.Types.PATTERN]: { visitor: (pattern) => {
      for (const name of collectVariableNames(c.astTransformer, pattern)) {
        names.add(name);
      }
    } },
    [Algebra.Types.EXTEND]: { visitor: (extend) => {
      names.add(extend.variable.value);
    } },
    [Algebra.Types.VALUES]: { visitor: (values) => {
      for (const variable of values.variables) {
        names.add(variable.value);
      }
    } },
  });
  return names;
}

/**
 * Renames the given variables out of every operation binding them - a BGP, a `BIND`, a `VALUES` - outside nested
 * `EXISTS` patterns, `SERVICE`s and the projections hiding them, and reads each back over that operation:
 * A⟨?local ≡ ?x⟩ over a BGP, which binds it, and W⟨?local ≡ ?x⟩ over the others, whose local left unbound joins
 * with any solution.
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
  /**
   * Renames the correlated ones of the variables an operation binds apart, and reads them back over it.
   * @param binder - The operation
   * @param boundNames - The variables it binds
   * @param renamed - The operation binding the locals instead
   * @param assertion - How a local is read back, strongly or weakly
   * @returns the operation itself where it binds none of them, a filter over its renamed copy otherwise
   */
  const readBack = (
    binder: Algebra.Operation,
    boundNames: Iterable<string>,
    renamed: (renames: Record<string, RDF.Variable>) => Algebra.Operation,
    assertion: (target: RDF.Variable) => Assertion,
  ): Algebra.Operation => {
    const renames: Record<string, RDF.Variable> = Object.fromEntries([ ...boundNames ]
      .filter(name => correlated.has(name))
      .map(name => [ name, freshVariable() ]));
    const conditions = Object.entries(renames).map(([ name, local ]) =>
      conjunctAsExpression(c, { access: access(local.value), assertion: assertion(c.DF.variable(name)) }));
    return conditions.length === 0 ? binder : c.AF.createFilter(renamed(renames), conjunctionOf(c, conditions));
  };
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
    [Algebra.Types.BGP]: { transform: bgp => readBack(
      bgp,
      collectVariableNames(c.astTransformer, bgp),
      renames => renameVariables(c, bgp, renames),
      assertStrong,
    ) },
    // Only the variable it binds is renamed: its expression reads the enclosing solution like any condition.
    [Algebra.Types.EXTEND]: { transform: extend => readBack(
      extend,
      [ extend.variable.value ],
      renames => c.AF.createExtend(extend.input, renames[extend.variable.value], extend.expression),
      assertWeak,
    ) },
    [Algebra.Types.VALUES]: { transform: values => readBack(
      values,
      values.variables.map(variable => variable.value),
      renames => renameVariables(c, values, renames),
      assertWeak,
    ) },
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
  const possiblyUnbound = [ ...boundVariables(c, existence.input) ]
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
