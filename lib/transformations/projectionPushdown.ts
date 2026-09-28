import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { withoutCpVars } from '../utils/certainlyBoundVars.js';
import { demandedVariablesOfInputs, variablesInScope } from '../utils/demand.js';
import { bareVariableOf } from '../utils/expressionHelpers.js';
import { groupBelowTopLevelChain } from '../utils/operationhelpers.js';
import { unionSets } from '../utils/setUtils.js';
import { solutionModifierChainOf } from '../utils/solutionModifierChain.js';
import { collectVariableNames, renameVariables } from '../utils.js';

/**
 * @fileoverview Projection pushdown: deleting the binds nothing reads, and renaming away the ones that only
 * copy a variable nothing else reads.
 *
 * After the pushdown and the pull-up, a rewritten query is still a JOIN of UNION groups, and every one of
 * them binds the variable the groups join on through a variable-to-variable `BIND`. The pull-up cannot
 * float those any higher - every sibling binds the same user variable, so its (C1) fails - and a join on a
 * variable computed by a `BIND` leaves an engine no index to look the other side up in. This pass turns
 *
 * ```sparql
 * { { ?v_7 :writes ?v_8 . BIND(?v_7 AS ?v_6) } UNION { ?v_10 :hasAuthor ?v_9 . BIND(?v_9 AS ?v_6) }
 *   BIND(?v_6 AS ?uq_s) }
 * -- into
 * { ?uq_s :writes ?v_8 } UNION { ?v_10 :hasAuthor ?uq_s }
 * ```
 *
 * so that the join key is a variable of the triple patterns themselves.
 *
 * ## The rules
 *
 * One top-down traversal carries the demand `D` of {@link utils/demand}: the variables something above
 * reads. At an `EXTEND(?y := e)` over `A`:
 *
 * - **drop** when `?y ∉ D`. `Extend` is total - one solution in, one out - so deleting it changes the
 *   multiset only in `?y`, which nothing reads. That holds for any `e`, unstable ones included.
 * - **rename** when `e` is a bare `?x` with `?y ∈ D`, `?x ∉ D`, and `?y` occurring *nowhere* in `A`:
 *   substitute `?y` for `?x` throughout `A` and delete the bind.
 * - **keep** otherwise: a bind of a constant, or one equating two variables that are both read.
 *
 * One exception comes from the generator rather than from the semantics: **a grouped SELECT keeps its
 * select expressions and its projection as they are.** `toAst` prints the EXTEND / FILTER / ORDER_BY chain
 * above a GROUP as the select expressions, `HAVING` and `ORDER BY` of one SELECT, and it prints an aggregate
 * only as the expression of a bind of that chain which the projection lists - `SELECT (COUNT(?x) AS ?c)` is
 * `EXTEND(?c := ?agg)` over the GROUP. Deleting that bind loses the aggregate, and for a GROUP without keys
 * the grouping with it; unlisting it gets the bind printed into the WHERE as the invalid
 * `BIND(COUNT(?x) AS ?c)`; dropping another select expression but listing its variable selects a variable
 * that is not grouped on. Below the GROUP the rules apply as ever, the demand reaching it through the keys
 * and the aggregates.
 *
 * ## Why a rename is sound
 *
 * If `?y` does not occur in `A`, renaming `?x` to `?y` is injective on the variables of `A`, and SPARQL
 * evaluation commutes with it: `[[A[?x→?y]]]` is `{ μ[?x→?y] | μ ∈ [[A]] }`. `Extend(A, ?y, ?x)` adds
 * `?y ↦ μ(?x)` exactly when `?x` is bound, and leaves `?y` unbound where it is not, so
 * `[[A[?x→?y]]] = π₋ₓ [[Extend(A, ?y, ?x)]]` as bags - the two differ in `?x` alone, which is dead.
 *
 * **The capture check is syntactic on purpose**, and stronger than the pull-up's (C1), which reads the
 * ranges. `?y` may never bind in `A` and still be *read* there - by a `FILTER(!bound(?y))`, or by an
 * `EXISTS` mentioning it - and renaming `?x` to `?y` would hand that reader `?x`'s value. Being syntactic
 * is also what lets the renaming ignore scope: a sub-SELECT's projection and an `EXISTS` pattern are
 * renamed with the rest of `A`, which is sound because nothing in `A` can be captured.
 *
 * ## The invariant
 *
 * At every operation `n`, `π_D [[n′]] = π_D [[n]]` as bags. {@link utils/demand!demandedVariablesOfInputs}
 * picks each input's demand so that this carries up through the operation, and a drop or a rename carries
 * it by the arguments above. At the root `D` is what the query reads - the projection of a `SELECT`, the
 * template of a `CONSTRUCT` - so the answer does not change. Nothing *below* the root keeps its `pVars`:
 * the source of a rename leaves scope where the bind stood, which is the point.
 *
 * ## The traversal
 *
 * The demand and the licences are read on the tree as it was handed over, never on the one being built:
 * `D` and the ranges stay valid because a rename only ever takes a variable outside `D` out of scope - a
 * join key is demanded, so it is never renamed. What travels down beside `D` is the **renaming** the
 * binds above decided, from the name in the input to the variable the output writes, applied to every
 * leaf and expression as the tree is rebuilt. A rename at `EXTEND(?y := ?x)` extends it with `?x ↦` the
 * variable `?y` itself became, so a chain of copies collapses onto the outermost demanded name in one pass.
 *
 * Nothing is rewritten *inside* an `EXISTS` or a `SERVICE`: both are renamed along with what they stand
 * in, which the capture check keeps sound, and neither is entered. An `EXISTS` pattern binds variables the
 * outer solution already fixes, so what a rename in there would mean is a question of its own; a `SERVICE`
 * is the endpoint's to evaluate.
 *
 * ## Where it runs
 *
 * Last, over the flat tree `removeProjections` leaves: that is where the benchmark's binds are, every
 * sub-SELECT having been dissolved into the join it stood in. The pipeline runner hands it the demand of
 * the query it peeled the query part out of (an {@link types!EnclosingQuery}); without one - a bare
 * pattern - everything in scope at the root is demanded, which renames nothing at the top of the tree.
 */

/** What the output writes in place of a variable of the input, by the input variable's name. */
type VariableRenaming = Readonly<Record<string, RDF.Variable>>;

/** What stays fixed across one run of the pass. */
interface ProjectionPushdownTraversal {
  c: TransformationContext;
  /**
   * The solution modifiers at the top of what the pass was handed, the query's own projection among them,
   * whose variable list is part of the answer and so is never struck.
   */
  querySolutionModifiers: ReadonlySet<Algebra.Operation>;
}

/**
 * Deletes every `BIND` whose variable nothing reads, and renames away every `BIND(?x AS ?y)` whose `?x`
 * nothing else reads.
 * @param c - The transformation context
 * @param op - The operation to rewrite
 * @param demandedVariables - The variables what stands above `op` reads of it; everything `op` has in
 * scope when omitted
 * @returns the rewritten operation
 * @example
 * // Before: SELECT ?s WHERE { ?v :p ?o . BIND(?v AS ?s) BIND(:c AS ?unread) }
 * // After:  SELECT ?s WHERE { ?s :p ?o }
 */
export function projectionPushdown<T extends Algebra.Operation>(
  c: TransformationContext,
  op: T,
  demandedVariables?: ReadonlySet<string>,
): T {
  // Entering through `withoutCpVars` guarantees that what the licences read describes the tree as it is
  // handed over, and leaving through it clears what they cached: the leaves are reused, metadata and all.
  const entered = withoutCpVars(op);
  const traversal: ProjectionPushdownTraversal = {
    c,
    querySolutionModifiers: solutionModifierChainOf(entered),
  };
  const rewritten = pushDemandInto(traversal, entered, demandedVariables ?? variablesInScope(entered), {});
  return <T> withoutCpVars(rewritten);
}

/**
 * Rewrites one operation of the input tree, and everything below it, under the demand and renaming the
 * operations above it decided.
 * @param traversal - What stays fixed across the pass
 * @param op - The operation of the input tree
 * @param demanded - The variables something above it reads, by their names in the input
 * @param renaming - What the output writes in place of the variables of the input
 * @returns the rewritten operation
 */
function pushDemandInto(
  traversal: ProjectionPushdownTraversal,
  op: Algebra.Operation,
  demanded: ReadonlySet<string>,
  renaming: VariableRenaming,
): Algebra.Operation {
  const { c } = traversal;
  const demandedOfInputs = demandedVariablesOfInputs(c, op, demanded);
  const rewriteInput = (input: Algebra.Operation, inputIndex: number): Algebra.Operation =>
    pushDemandInto(traversal, input, demandedOfInputs[inputIndex], renaming);
  const renameVariable = (variable: RDF.Variable): RDF.Variable => renamedVariable(renaming, variable);
  const renameExpression = (expression: Algebra.Expression): Algebra.Expression =>
    applyRenaming(c, renaming, expression);
  switch (op.type) {
    case Algebra.Types.EXTEND:
      return pushDemandIntoExtend(traversal, op, demanded, demandedOfInputs[0], renaming);
    case Algebra.Types.PROJECT:
      return c.AF.createProject(
        rewriteInput(op.input, 0),
        projectedVariablesToKeep(traversal, op, demanded).map(renameVariable),
      );
    case Algebra.Types.DISTINCT:
      return c.AF.createDistinct(rewriteInput(op.input, 0));
    case Algebra.Types.REDUCED:
      return c.AF.createReduced(rewriteInput(op.input, 0));
    case Algebra.Types.SLICE:
      return c.AF.createSlice(rewriteInput(op.input, 0), op.start, op.length);
    case Algebra.Types.FROM:
      return c.AF.createFrom(rewriteInput(op.input, 0), op.default, op.named);
    case Algebra.Types.ORDER_BY:
      return c.AF.createOrderBy(rewriteInput(op.input, 0), op.expressions.map(renameExpression));
    case Algebra.Types.FILTER:
      return c.AF.createFilter(rewriteInput(op.input, 0), renameExpression(op.expression));
    case Algebra.Types.GROUP:
      return c.AF.createGroup(
        rewriteInput(op.input, 0),
        op.variables.map(renameVariable),
        op.aggregates.map(aggregate => applyRenaming(c, renaming, aggregate)),
      );
    case Algebra.Types.GRAPH:
      return c.AF.createGraph(rewriteInput(op.input, 0), applyRenaming(c, renaming, op.name));
    case Algebra.Types.UNION:
      return c.AF.createUnion(op.input.map(rewriteInput), false);
    case Algebra.Types.JOIN:
      return c.AF.createJoin(op.input.map(rewriteInput), false);
    case Algebra.Types.LEFT_JOIN:
      return c.AF.createLeftJoin(
        rewriteInput(op.input[0], 0),
        rewriteInput(op.input[1], 1),
        op.expression === undefined ? undefined : renameExpression(op.expression),
      );
    case Algebra.Types.MINUS: {
      const minus = c.AF.createMinus(rewriteInput(op.input[0], 0), rewriteInput(op.input[1], 1));
      if (op.graphScopeVar !== undefined) {
        minus.graphScopeVar = renameVariable(op.graphScopeVar);
      }
      return minus;
    }
    case Algebra.Types.ASK:
      return c.AF.createAsk(rewriteInput(op.input, 0));
    case Algebra.Types.CONSTRUCT:
      return c.AF.createConstruct(
        rewriteInput(op.input, 0),
        op.template.map(pattern => applyRenaming(c, renaming, pattern)),
      );
    case Algebra.Types.DESCRIBE:
      return c.AF.createDescribe(
        rewriteInput(op.input, 0),
        op.terms.map(term => applyRenaming(c, renaming, term)),
      );
    case Algebra.Types.DELETE_INSERT:
      return c.AF.createDeleteInsert(
        op.delete?.map(pattern => applyRenaming(c, renaming, pattern)),
        op.insert?.map(pattern => applyRenaming(c, renaming, pattern)),
        op.where === undefined ? undefined : rewriteInput(op.where, 0),
      );
    case Algebra.Types.COMPOSITE_UPDATE:
      return c.AF.createCompositeUpdate(op.updates.map(rewriteInput));
    case Algebra.Types.SERVICE:
    case Algebra.Types.BGP:
    case Algebra.Types.PATTERN:
    case Algebra.Types.PATH:
    case Algebra.Types.VALUES:
    case Algebra.Types.NOP:
    case Algebra.Types.EXPRESSION:
    case Algebra.Types.ALT:
    case Algebra.Types.INV:
    case Algebra.Types.LINK:
    case Algebra.Types.NPS:
    case Algebra.Types.SEQ:
    case Algebra.Types.ONE_OR_MORE_PATH:
    case Algebra.Types.ZERO_OR_MORE_PATH:
    case Algebra.Types.ZERO_OR_ONE_PATH:
    case Algebra.Types.LOAD:
    case Algebra.Types.CLEAR:
    case Algebra.Types.CREATE:
    case Algebra.Types.DROP:
    case Algebra.Types.ADD:
    case Algebra.Types.MOVE:
    case Algebra.Types.COPY:
      // A leaf, or a SERVICE that is renamed along with everything else but not entered.
      return applyRenaming(c, renaming, op);
  }
}

/**
 * Rewrites an `EXTEND`: dropping it when nothing reads its variable, renaming its source away when it only
 * copies a variable nothing else reads, and keeping it otherwise.
 * @param traversal - What stays fixed across the pass
 * @param extend - The bind of the input tree
 * @param demanded - The variables something above it reads
 * @param demandedOfInput - What {@link demandedVariablesOfInputs} demands of its input
 * @param renaming - What the output writes in place of the variables of the input
 * @returns the rewritten operation, which is the rewritten input itself unless the bind is kept
 */
function pushDemandIntoExtend(
  traversal: ProjectionPushdownTraversal,
  extend: Algebra.Extend,
  demanded: ReadonlySet<string>,
  demandedOfInput: ReadonlySet<string>,
  renaming: VariableRenaming,
): Algebra.Operation {
  const { c } = traversal;
  if (groupBelowTopLevelChain(extend.input) !== undefined) {
    // A select expression of a grouped SELECT, kept whatever the demand says - keeping a bind is always
    // sound - and so is what it reads: `toAst` prints an aggregate in this shape or not at all.
    return keepExtend(traversal, extend, unionSets([
      demandedOfInput,
      collectVariableNames(c.astTransformer, extend.expression),
    ]), renaming);
  }
  const targetName = extend.variable.value;
  if (!demanded.has(targetName)) {
    // Dead: `Extend` is total, so deleting it changes nothing but the one column nothing reads.
    return pushDemandInto(traversal, extend.input, demandedOfInput, renaming);
  }
  const copiedVariable = bareVariableOf(extend.expression);
  if (copiedVariable !== undefined &&
    !demanded.has(copiedVariable.value) &&
    !collectVariableNames(c.astTransformer, extend.input).has(targetName)) {
    // The input is written with the target in place of the source. The target may itself have been renamed
    // by a bind further up, and the source then takes that name too, which is what collapses a chain.
    return pushDemandInto(traversal, extend.input, demandedOfInput, {
      ...renaming,
      [copiedVariable.value]: renamedVariable(renaming, extend.variable),
    });
  }
  return keepExtend(traversal, extend, demandedOfInput, renaming);
}

/**
 * Rebuilds an `EXTEND` that stays, over its rewritten input.
 * @param traversal - What stays fixed across the pass
 * @param extend - The bind of the input tree
 * @param demandedOfInput - What to demand of its input
 * @param renaming - What the output writes in place of the variables of the input
 * @returns the bind, renamed, over the rewritten input
 */
function keepExtend(
  traversal: ProjectionPushdownTraversal,
  extend: Algebra.Extend,
  demandedOfInput: ReadonlySet<string>,
  renaming: VariableRenaming,
): Algebra.Operation {
  return traversal.c.AF.createExtend(
    pushDemandInto(traversal, extend.input, demandedOfInput, renaming),
    renamedVariable(renaming, extend.variable),
    applyRenaming(traversal.c, renaming, extend.expression),
  );
}

/**
 * Whether a projection is that of a grouped SELECT, whose EXTEND / FILTER / ORDER_BY chain stands on a
 * GROUP - a shape the pass leaves as it is, see the file header.
 * @param project - The projection to check
 * @returns whether it is a grouped SELECT
 */
function isGroupedSelect(project: Algebra.Project): boolean {
  return groupBelowTopLevelChain(project.input) !== undefined;
}

/**
 * The variables a projection keeps listing: all of them for the query's own, whose list is part of the
 * answer, and for a grouped SELECT; the ones something above reads for any other sub-SELECT.
 * @param traversal - What stays fixed across the pass
 * @param project - The projection of the input tree
 * @param demanded - The variables something above it reads
 * @returns the variables to list, by their names in the input
 */
function projectedVariablesToKeep(
  traversal: ProjectionPushdownTraversal,
  project: Algebra.Project,
  demanded: ReadonlySet<string>,
): RDF.Variable[] {
  if (traversal.querySolutionModifiers.has(project) || isGroupedSelect(project)) {
    return project.variables;
  }
  const demandedProjected = project.variables.filter(variable => demanded.has(variable.value));
  // SPARQL has no empty projection, and a sub-SELECT nothing reads from still counts: its solutions
  // multiply those it joins with. So it keeps listing what it listed.
  return demandedProjected.length > 0 ? demandedProjected : project.variables;
}

/**
 * The variable the output writes in place of one of the input.
 * @param renaming - What the output writes in place of the variables of the input
 * @param variable - The variable of the input
 * @returns its replacement, or the variable itself when it is not renamed
 */
function renamedVariable(renaming: VariableRenaming, variable: RDF.Variable): RDF.Variable {
  return Object.hasOwn(renaming, variable.value) ? renaming[variable.value] : variable;
}

/**
 * Writes the renaming into a leaf, an expression or a template, copying it only when there is something to
 * rename.
 * @param c - The transformation context
 * @param renaming - What the output writes in place of the variables of the input
 * @param object - What to rename
 * @returns the renamed copy, or `object` itself for an empty renaming
 */
function applyRenaming<T extends object>(c: TransformationContext, renaming: VariableRenaming, object: T): T {
  return Object.keys(renaming).length === 0 ? object : renameVariables(c, object, renaming);
}

/**
 * The pipeline step deleting the binds nothing reads and renaming away the ones that only copy a variable
 * nothing else reads, seeded with what the query reads of the part it is handed.
 * @returns the transformation
 */
export function projectionPushdownTransformation(): QueryTransformation {
  return (c, operation, enclosingQuery) => projectionPushdown(c, operation, enclosingQuery?.demandedVariables);
}
