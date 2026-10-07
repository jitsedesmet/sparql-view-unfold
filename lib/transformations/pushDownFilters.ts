import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { bindConstructionOf, readerAdmitsConstruction, substituteConstruction } from '../utils/bindSubstitution.js';
import { cpMetaOf } from '../utils/certainlyBoundVars.js';
import {
  booleanConstantOf,
  conjunctionOf,
  isStableExpression,
  splitConjunction,
} from '../utils/expressionHelpers.js';
import { keep, mapOperationPreOrderKeepingMetadata } from '../utils/metadataKeepingTraversal.js';
import type { SingleInputOperation } from '../utils/operationhelpers.js';
import { groupingKeysOf, rebuildMinus, rebuildOverInput } from '../utils/operationhelpers.js';
import {
  everyOperandBindsCertainly,
  graphPatternDecides,
  innerJoinUnderRejectingFilter,
  operandDecidesVariables,
} from '../utils/pushdownLicences.js';
import type { SSet } from '../utils/setUtils.js';
import { unionSets } from '../utils/setUtils.js';
import { variablesRequiredBoundBy } from '../utils/unboundRejection.js';
import { collectVariableNames } from '../utils.js';

/**
 * @fileoverview Generic filter pushdown.
 *
 * Where {@link pushDownAssertions} moves the `sameTerm` assertions of a condition, this moves any condition:
 * split into its conjuncts (SDecompI), each sinks on its own as deep as it reads the same values, by the
 * rules of Figure 2 of Schmidt et al., "Foundations of SPARQL Query Optimization", writing `vars(R)` for
 * the variables a conjunct reads:
 *
 * - through a DISTINCT, REDUCED, ORDER BY or FROM, and into every branch of a UNION (FUPush) and the left of
 *   a MINUS (FMPush), unconditionally;
 * - through a PROJECT that keeps every variable of `vars(R)` or never binds it below, a GROUP whose keys
 *   cover `vars(R)`, a GRAPH whose pattern certainly binds the graph variable `R` reads, and a BIND that
 *   `R` does not read or can read the construction of instead;
 * - into every JOIN operand deciding `vars(R)` (FJPush), the left of an OPTIONAL deciding it (FLPush) and
 *   its right too where both sides bind `vars(R)` certainly;
 * - turning an OPTIONAL into a JOIN under a conjunct rejecting what only its right side binds, and sinking
 *   the conjuncts of its own condition into its right side where that side decides what they read.
 *
 * Only a *stable* conjunct reading a variable moves: an unstable one would be asked a different number of
 * times, and one reading nothing says the same everywhere. An EXISTS stays too, and the traversal leaves
 * its pattern alone.
 */

/** One conjunct of a condition, with the variables it reads. */
interface Conjunct {
  /** The conjunct itself. */
  expression: Algebra.Expression;
  /** `vars(R)`, cached since every licence reads it. */
  reads: SSet;
}

/**
 * Pushes every filter condition in `op` as deep into the plan as it keeps its meaning.
 * @param c - The transformation context
 * @param op - The operation to rewrite
 * @returns the rewritten operation
 * @example
 * // Before: SELECT * WHERE { { SELECT DISTINCT ?x { ?x :p ?y } } ?x :q ?z FILTER(?x > 5) }
 * // After:  SELECT * WHERE { { SELECT DISTINCT ?x { ?x :p ?y FILTER(?x > 5) } } ?x :q ?z FILTER(?x > 5) }
 */
export function pushDownFilters<T extends Algebra.Operation>(c: TransformationContext, op: T): T {
  return mapOperationPreOrderKeepingMetadata(op, {
    [Algebra.Types.FILTER]: (filter: Algebra.Filter) => keep(sinkFilter(c, filter)),
    [Algebra.Types.LEFT_JOIN]: (leftJoin: Algebra.LeftJoin) => keep(sinkOptionalCondition(c, leftJoin)),
  });
}

/**
 * Splits a condition into the conjuncts that move and those that stay where the condition is.
 * @param c - The transformation context
 * @param condition - The condition to split
 * @param licence - What else a conjunct needs to move
 * @returns the moving and the staying conjuncts, each in the order the condition holds them
 */
function splitCondition(
  c: TransformationContext,
  condition: Algebra.Expression,
  licence: (conjunct: Conjunct) => boolean = () => true,
): { moving: Conjunct[]; staying: Conjunct[] } {
  const moving: Conjunct[] = [];
  const staying: Conjunct[] = [];
  for (const expression of splitConjunction(condition)) {
    const conjunct = { expression, reads: collectVariableNames(c.astTransformer, expression) };
    const mayMove = conjunct.reads.size > 0 && isStableExpression(c, expression) && licence(conjunct);
    (mayMove ? moving : staying).push(conjunct);
  }
  return { moving, staying };
}

/**
 * Splits conjuncts by the licence of the place they could move to.
 * @param conjuncts - The conjuncts to split
 * @param licence - Whether a conjunct may move there
 * @returns the licensed and the remaining conjuncts
 */
function splitByLicence(
  conjuncts: readonly Conjunct[],
  licence: (conjunct: Conjunct) => boolean,
): { licensed: Conjunct[]; remaining: Conjunct[] } {
  const licensed: Conjunct[] = [];
  const remaining: Conjunct[] = [];
  for (const conjunct of conjuncts) {
    (licence(conjunct) ? licensed : remaining).push(conjunct);
  }
  return { licensed, remaining };
}

/**
 * Filters an operation by the conjunction of the given conjuncts.
 * @param c - The transformation context
 * @param op - The operation to filter
 * @param conjuncts - The conjuncts to filter by
 * @returns the filter, or `op` itself when there are no conjuncts
 */
function filterOver(
  c: TransformationContext,
  op: Algebra.Operation,
  conjuncts: readonly Conjunct[],
): Algebra.Operation {
  return conjuncts.length === 0 ?
    op :
    c.AF.createFilter(op, conjunctionOf(c, conjuncts.map(conjunct => conjunct.expression)));
}

/**
 * Moves what may move of a filter's condition one operation down, the rest staying where the filter is.
 * @param c - The transformation context
 * @param filter - The filter met by the traversal
 * @returns what takes its place
 */
function sinkFilter(c: TransformationContext, filter: Algebra.Filter): Algebra.Operation {
  const { moving, staying } = splitCondition(c, filter.expression);
  return moving.length === 0 ? filter : filterOver(c, sinkInto(c, moving, filter.input), staying);
}

/**
 * Swaps conjuncts with the operation right below them: each enters the inputs the operation's rule licenses
 * it for, and stays above the operation when there are none.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place, each one that may move
 * @param op - The operation they stand on
 * @returns the operation with the conjuncts placed
 */
function sinkInto(c: TransformationContext, conjuncts: Conjunct[], op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  switch (op.type) {
    case Algebra.Types.FILTER: {
      // Two filters are one conjunction, so what may move of the lower one travels on with ours.
      const { moving, staying } = splitCondition(c, op.expression);
      return filterOver(c, sinkInto(c, [ ...conjuncts, ...moving ], op.input), staying);
    }
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
      // A sub-SELECT is printed from its DISTINCT down as one, so only what its projection lets in passes.
      return sinkIntoSingleInput(c, conjuncts, op, op.input.type === Algebra.Types.PROJECT ?
        projectionLicence(op.input) :
          () => true);
    case Algebra.Types.ORDER_BY:
    case Algebra.Types.FROM:
      return rebuildOverInput(c, op, filterOver(c, op.input, conjuncts));
    case Algebra.Types.UNION:
      return AF.createUnion(op.input.map(branch => filterOver(c, branch, conjuncts)), false);
    case Algebra.Types.MINUS:
      return rebuildMinus(c, op, filterOver(c, op.input[0], conjuncts), op.input[1]);
    case Algebra.Types.PROJECT:
      return sinkIntoSingleInput(c, conjuncts, op, projectionLicence(op));
    case Algebra.Types.GROUP: {
      // A conjunct on keys alone selects whole groups. That needs a key, since a keyless GROUP makes a group
      // of an empty input, and every moving conjunct reads at least one variable to be a key.
      const keys = groupingKeysOf(op);
      return sinkIntoSingleInput(c, conjuncts, op, conjunct => [ ...conjunct.reads ].every(name => keys.has(name)));
    }
    case Algebra.Types.GRAPH: {
      const { cVars } = cpMetaOf(op.input);
      return sinkIntoSingleInput(c, conjuncts, op, conjunct => graphPatternDecides(conjunct.reads, op.name, cVars));
    }
    case Algebra.Types.EXTEND:
      return sinkIntoExtend(c, conjuncts, op);
    case Algebra.Types.JOIN:
      return sinkIntoJoin(c, conjuncts, op);
    case Algebra.Types.LEFT_JOIN:
      return sinkIntoOptional(c, conjuncts, op);
    default:
      // A leaf, or a barrier: a SLICE picks its window before the filter, a SERVICE may fail SILENTly.
      return filterOver(c, op, conjuncts);
  }
}

/**
 * What a sub-SELECT lets into its WHERE clause: a conjunct reading what it projects or never binds below,
 * since a variable it drops is unbound above it. An aggregating one only lets in a conjunct on projected
 * grouping keys, which sinks below the GROUP: `toAst` would print anything left above it into the WHERE clause.
 * @param project - The projection of the sub-SELECT
 * @returns whether a conjunct may enter it
 */
function projectionLicence(project: Algebra.Project): (conjunct: Conjunct) => boolean {
  const projected = new Set(project.variables.map(variable => variable.value));
  const group = groupBelowSelectClause(project.input);
  if (group !== undefined) {
    const keys = groupingKeysOf(group);
    return conjunct => [ ...conjunct.reads ].every(name => projected.has(name) && keys.has(name));
  }
  const { vRanges } = cpMetaOf(project.input);
  return conjunct => [ ...conjunct.reads ].every(name => projected.has(name) || vRanges.neverBinds(name));
}

/**
 * The GROUP of an aggregating sub-SELECT, below the ORDER BY, select expressions and HAVING of its projection.
 * @param projectInput - The input of the projection
 * @returns the GROUP, or `undefined` when the sub-SELECT does not aggregate
 */
function groupBelowSelectClause(projectInput: Algebra.Operation): Algebra.Group | undefined {
  let current = projectInput;
  while (current.type === Algebra.Types.EXTEND || current.type === Algebra.Types.FILTER ||
    current.type === Algebra.Types.ORDER_BY) {
    current = current.input;
  }
  return current.type === Algebra.Types.GROUP ? current : undefined;
}

/**
 * Places conjuncts on the input of an operation where licensed, and above the operation otherwise.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param op - The operation they stand on
 * @param licence - Whether a conjunct reads the same below the operation
 * @returns the operation with the conjuncts placed
 */
function sinkIntoSingleInput(
  c: TransformationContext,
  conjuncts: Conjunct[],
  op: SingleInputOperation,
  licence: (conjunct: Conjunct) => boolean,
): Algebra.Operation {
  const { licensed, remaining } = splitByLicence(conjuncts, licence);
  return filterOver(c, rebuildOverInput(c, op, filterOver(c, op.input, licensed)), remaining);
}

/**
 * Sinks conjuncts below a `BIND(e AS ?x)`: one not reading `?x` as it is, one reading it with the
 * construction `e` written in, and one that cannot read the construction stays above.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param extend - The BIND they stand on
 * @returns the BIND with the conjuncts placed
 */
function sinkIntoExtend(c: TransformationContext, conjuncts: Conjunct[], extend: Algebra.Extend): Algebra.Operation {
  const bind = bindConstructionOf(extend);
  const { cVars } = cpMetaOf(extend.input);
  const below: Conjunct[] = [];
  const kept: Conjunct[] = [];
  for (const conjunct of conjuncts) {
    if (!conjunct.reads.has(bind.variable.value)) {
      below.push(conjunct);
    } else if (readerAdmitsConstruction(conjunct.expression, bind)) {
      const expression = substituteConstruction(c, conjunct.expression, bind, cVars);
      // A conjunct the construction decides to be true asks nothing any more.
      if (booleanConstantOf(expression) !== true) {
        below.push({ expression, reads: collectVariableNames(c.astTransformer, expression) });
      }
    } else {
      kept.push(conjunct);
    }
  }
  return filterOver(c, c.AF.createExtend(filterOver(c, extend.input, below), extend.variable, extend.expression), kept);
}

/**
 * Sinks every conjunct into each JOIN operand deciding every variable it reads (FJPush), so that one
 * certainly bound on several sides prunes all of them.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param join - The JOIN they stand on
 * @returns the JOIN with the conjuncts placed
 */
function sinkIntoJoin(c: TransformationContext, conjuncts: Conjunct[], join: Algebra.Join): Algebra.Operation {
  const operands = join.input.map(operand => cpMetaOf(operand));
  const intoOperand: Conjunct[][] = operands.map(() => []);
  const kept: Conjunct[] = [];
  for (const conjunct of conjuncts) {
    const deciding = operands.map((_, index) => index)
      .filter(index => operandDecidesVariables(conjunct.reads, index, operands));
    for (const index of deciding) {
      intoOperand[index].push(conjunct);
    }
    if (deciding.length === 0) {
      kept.push(conjunct);
    }
  }
  return filterOver(
    c,
    c.AF.createJoin(join.input.map((operand, index) => filterOver(c, operand, intoOperand[index])), false),
    kept,
  );
}

/**
 * Sinks conjuncts into an OPTIONAL: all of them into its JOIN half when one rejects what the left side never
 * binds, and otherwise into the left side where it decides them (FLPush), copied into the right side where
 * both bind them certainly.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param leftJoin - The OPTIONAL they stand on
 * @returns the OPTIONAL, or the JOIN it became, with the conjuncts placed
 */
function sinkIntoOptional(
  c: TransformationContext,
  conjuncts: Conjunct[],
  leftJoin: Algebra.LeftJoin,
): Algebra.Operation {
  const [ left, right ] = leftJoin.input;
  const operands = [ cpMetaOf(left), cpMetaOf(right) ];
  const requiredBound = unionSets(conjuncts.map(conjunct => variablesRequiredBoundBy(conjunct.expression)));
  const innerJoin = innerJoinUnderRejectingFilter(c, leftJoin, requiredBound, operands[0]);
  if (innerJoin !== undefined) {
    return sinkInto(c, conjuncts, innerJoin);
  }
  const { licensed: intoLeft, remaining: kept } = splitByLicence(conjuncts, conjunct =>
    operandDecidesVariables(conjunct.reads, 0, operands));
  const { licensed: intoRight } = splitByLicence(intoLeft, conjunct =>
    everyOperandBindsCertainly(conjunct.reads, operands));
  return filterOver(c, sinkOptionalCondition(c, c.AF.createLeftJoin(
    filterOver(c, left, intoLeft),
    filterOver(c, right, intoRight),
    leftJoin.expression,
  )), kept);
}

/**
 * Moves the conjuncts of an OPTIONAL's condition into its right side where that side decides what they read:
 * the condition is asked of a merged solution, which holds those values as the right side gave them.
 * @param c - The transformation context
 * @param leftJoin - The OPTIONAL whose condition to sink
 * @returns the OPTIONAL with what moved of its condition on its right side
 */
function sinkOptionalCondition(c: TransformationContext, leftJoin: Algebra.LeftJoin): Algebra.LeftJoin {
  if (leftJoin.expression === undefined) {
    return leftJoin;
  }
  const [ left, right ] = leftJoin.input;
  const operands = [ cpMetaOf(left), cpMetaOf(right) ];
  const { moving, staying } = splitCondition(c, leftJoin.expression, conjunct =>
    operandDecidesVariables(conjunct.reads, 1, operands));
  if (moving.length === 0) {
    return leftJoin;
  }
  return c.AF.createLeftJoin(
    left,
    filterOver(c, right, moving),
    staying.length === 0 ? undefined : conjunctionOf(c, staying.map(conjunct => conjunct.expression)),
  );
}

/**
 * The pipeline step pushing every filter condition as deep into the plan as it keeps its meaning.
 * @returns the transformation
 */
export function pushDownFiltersTransformation(): QueryTransformation {
  return pushDownFilters;
}
