import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { certainlyBoundVariables } from '../utils/certainlyBoundVars.js';
import { collectVariableNames } from '../utils.js';

/**
 * Within this file we manipulate queries in such a way that we are able to create prunable structures.
 * This means we try to get unions and filters down as much as possible and create a structure like:
 * FILTER( A JOIN B ) -> then we can evaluate expressions and try and prune these kind of branches.
 * Since many conditions need to hold at once for the branch to pass - so contradictions become likely.
 *
 * We use: https://arxiv.org/pdf/0812.3788 (Schmidt et al., "Foundations of SPARQL Query Optimization").
 * The relevant SPARQL Algebra (SA) equivalences from Figure 1 are:
 *
 * IV. Distributivity (hold unconditionally):
 *   JUDistR: (A U B) JOIN C == (A JOIN C) U (B JOIN C)
 *   JUDistL: A JOIN (B U C) == (A JOIN B) U (A JOIN C)
 *
 * V. Filter decomposition:
 *   SUPush:   FILTER_R(A U B) == FILTER_R(A) U FILTER_R(B)
 *   SDecompI: FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))
 *
 * VI. Filter pushing (hold if vars(R) subset of safeVars(A)):
 *   SJPush: FILTER_R(A JOIN B) == FILTER_R(A) JOIN B
 *   SMPush: FILTER_R(A \ B)    == FILTER_R(A) \ B      (minus)
 *   SLPush: FILTER_R(A LJ B)   == FILTER_R(A) LJ B     (left join)
 *
 * The primary transformation implemented here is the distributivity of JOIN over UNION
 * (JUDistL / JUDistR). Pushing JOIN as deep into the plan as possible turns a
 * `JOIN(rest, UNION(b1, b2))` into `UNION(JOIN(b1, rest), JOIN(b2, rest))`, exposing per-branch
 * structures that later passes (e.g. nullifyJoinOverIncompatibleBounds, transformFilterFalse)
 * can prune independently.
 *
 * FILTERs are then pushed down as far as possible:
 * - SUPush distributes a FILTER over the branches of a UNION, so a filter sitting above a
 *   (freshly distributed) UNION sinks into every branch, right on top of that branch's JOIN.
 * - SJPush + SDecompI split the condition on `&&` and route each conjunct into the first JOIN
 *   operand whose {@link safeVars} superset the conjunct's variables.
 *
 * Combining these, `FILTER( JOIN(rest, UNION(b1, b2)) )` becomes
 * `UNION( FILTER(JOIN(b1, rest)), FILTER(JOIN(b2, rest)) )`: exactly the prunable
 * `FILTER( A JOIN B )` shape described above, per branch.
 *
 * Because {@link algebraUtils.mapOperation} rewrites bottom-up, a JOIN is distributed into a UNION
 * *before* the FILTER above it is visited, so the FILTER transform already sees a UNION as its input
 * and SUPush kicks in.
 */
export function pushDownRestrictors<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.JOIN]: {
      transform: join => distributeJoinOverUnion(c, join),
    },
    [Algebra.Types.FILTER]: {
      transform: filter => pushFilter(c, filter.expression, filter.input),
    },
  });
}

/**
 * Applies the distributivity of JOIN over UNION (JUDistL / JUDistR).
 *
 * `JOIN(o_1, ..., UNION(b_1, ..., b_k), ..., o_n)` becomes
 * `UNION(JOIN(b_1, rest), ..., JOIN(b_k, rest))` where `rest` are the remaining join operands.
 * The rewrite is applied recursively so that a JOIN containing several UNIONs is fully expanded
 * into a single UNION over union-free JOINs.
 *
 * Because JOIN is commutative (JComm), we place the (former union) branch first in every produced
 * JOIN, keeping the remaining operands in their original relative order.
 *
 * @param c - The transformation context
 * @param join - The JOIN operation to distribute
 * @returns A UNION of JOINs when a UNION operand is present, otherwise the original JOIN
 */
function distributeJoinOverUnion(c: TransformContext, join: Algebra.Join): Algebra.Operation {
  const { AF } = c;
  const unionIndex = join.input.findIndex(input => input.type === Algebra.Types.UNION);
  if (unionIndex === -1) {
    return join;
  }
  const union = <Algebra.Union> join.input[unionIndex];
  const rest = join.input.filter((_, index) => index !== unionIndex);

  const branches = union.input.map((branch, branchIndex) => {
    // Clone the shared operands for every branch except the first to avoid aliasing the same
    // algebra objects across multiple output branches (later passes mutate in place).
    const restForBranch = branchIndex === 0 ? rest : rest.map(operand => cloneOperation(operand));
    const branchJoin = AF.createJoin([ branch, ...restForBranch ], true);
    // A branch (or one of the remaining operands) may itself contain another UNION.
    return distributeJoinOverUnion(c, branchJoin);
  });

  return AF.createUnion(branches, true);
}

/**
 * Recursively pushes a filter condition down as far as possible (SUPush + SJPush + SDecompI).
 *
 * - **UNION input (SUPush)**: `FILTER_R(A U B) == FILTER_R(A) U FILTER_R(B)`. The condition is
 *   distributed into every branch and pushing continues recursively inside each branch. The
 *   condition is deep-cloned per branch to avoid aliasing the same expression object across the
 *   produced branches (later passes mutate algebra in place).
 * - **JOIN input (SJPush + SDecompI)**: the condition is split on `&&` and each conjunct routed to
 *   the first operand whose {@link safeVars} superset the conjunct's variables. Conjuncts that fit
 *   no single operand stay in a FILTER wrapping the JOIN.
 * - **anything else**: the filter is left in place as `FILTER_R(input)`.
 *
 * @param c - The transformation context
 * @param expression - The filter condition to push down
 * @param input - The operation the filter is applied to
 * @returns The rewritten operation with the condition pushed down where sound
 */
function pushFilter(
  c: TransformContext,
  expression: Algebra.Expression,
  input: Algebra.Operation,
): Algebra.Operation {
  const { AF } = c;
  if (input.type === Algebra.Types.UNION) {
    // SUPush: distribute the filter into each branch, cloning the expression to keep branches
    // independent, then keep pushing inside every branch.
    return AF.createUnion(
      input.input.map((branch, branchIndex) => pushFilter(
        c,
        branchIndex === 0 ? expression : cloneExpression(c, expression),
        branch,
      )),
      false,
    );
  }
  if (input.type === Algebra.Types.JOIN) {
    return pushFilterThroughJoin(c, expression, input);
  }
  return AF.createFilter(input, expression);
}

/**
 * Pushes a filter condition into a JOIN (SJPush) after splitting it on conjunctions (SDecompI).
 *
 * Each top level conjunct is routed to the first JOIN operand whose {@link safeVars} superset the
 * conjunct's variables - the precondition required by (SJPush). Conjuncts that cannot be assigned to
 * a single operand remain in a FILTER wrapping the JOIN.
 *
 * @param c - The transformation context
 * @param expression - The filter condition to push
 * @param join - The JOIN the filter is applied to
 * @returns The JOIN with conjuncts pushed into operands, wrapped in a residual FILTER if needed
 */
function pushFilterThroughJoin(
  c: TransformContext,
  expression: Algebra.Expression,
  join: Algebra.Join,
): Algebra.Operation {
  const { AF } = c;
  const conjuncts = splitConjunction(expression);
  const operandSafeVars = join.input.map(operand => certainlyBoundVariables(operand));

  const remaining: Algebra.Expression[] = [];
  for (const conjunct of conjuncts) {
    const conjunctVars = collectVariableNames(c.astTransformer, conjunct);
    const targetIndex = operandSafeVars.findIndex(safe => isSubsetOf(conjunctVars, safe));
    if (targetIndex === -1) {
      remaining.push(conjunct);
    } else {
      join.input[targetIndex] = AF.createFilter(join.input[targetIndex], conjunct);
    }
  }

  if (remaining.length === 0) {
    return join;
  }
  // What could not be pushed into a single operand stays in a (recombined) filter above the JOIN.
  return AF.createFilter(join, conjunctionOf(c, remaining));
}

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`, so each conjunct can be pushed independently.
 *
 * @param expression - The filter expression to split
 * @returns The list of top level conjuncts (a single element list when there is no `&&`)
 */
function splitConjunction(expression: Algebra.Expression): Algebra.Expression[] {
  if (
    expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === '&&'
  ) {
    return expression.args.flatMap(arg => splitConjunction(arg));
  }
  return [ expression ];
}

/**
 * Combines a non-empty list of expressions back into a single conjunction (`&&`).
 * @param c - The transformation context
 * @param expressions - The conjuncts to combine (must contain at least one element)
 * @returns A single expression equivalent to the conjunction of the inputs
 */
function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

/**
 * Deep-clones an algebra operation by mapping it with no transformations.
 * {@link algebraUtils.mapOperation} copies every node it visits, so this yields an independent tree.
 * @param op - The operation to clone
 * @returns An independent copy of the operation
 */
function cloneOperation(op: Algebra.Operation): Algebra.Operation {
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {});
}

/**
 * Deep-clones a filter expression so it can be attached to several UNION branches without aliasing.
 * @param c - The transformation context (provides the AST transformer used for the deep copy)
 * @param expression - The expression to clone
 * @returns An independent copy of the expression
 */
function cloneExpression(c: TransformContext, expression: Algebra.Expression): Algebra.Expression {
  return <Algebra.Expression> c.astTransformer.transformObject(expression, object => object);
}

/**
 * Tests whether every element of `subset` is contained in `superset`.
 */
function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}
