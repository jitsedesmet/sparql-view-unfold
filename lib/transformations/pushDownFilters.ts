import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import type { QueryTransformation } from '../types.js';
import { bindConstructionOf, readerAdmitsConstruction, substituteConstruction } from '../utils/bindSubstitution.js';
import { cpMetaOf } from '../utils/certainlyBoundVars.js';
import { keep, mapPreOrderInExistenceScopes } from '../utils/existenceScopes.js';
import {
  booleanConstantOf,
  conjunctionOf,
  isStableExpression,
  splitConjunction,
} from '../utils/expressionHelpers.js';
import {
  filterByConjunction,
  groupingKeysOf,
  withInput,
} from '../utils/operationhelpers.js';
import {
  everyOperandBindsCertainly,
  graphPatternDecides,
  innerJoinUnderRejectingFilter,
  operandDecidesVariables,
} from '../utils/pushdownLicences.js';
import type { SSet } from '../utils/setUtils.js';
import { isSubsetOf, partition, unionSets } from '../utils/setUtils.js';
import { variablesRequiredBoundBy } from '../utils/unboundRejection.js';
import { collectVariableNames } from '../utils.js';

/**
 * @fileoverview Generic filter pushdown, by the rules of Figure 2 of Schmidt et al., "Foundations of SPARQL Query
 * Optimization": each conjunct of a condition sinks on its own as deep as it reads the same values.
 *
 * Only a stable conjunct reading a variable moves: an unstable one would be asked a different number of times, and
 * one reading nothing says the same everywhere.
 */

/** One conjunct of a condition, with the variables it reads. */
interface Conjunct {
  /** The conjunct itself. */
  expression: Algebra.Expression;
  /** The variables it reads, cached since every licence reads them. */
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
  return mapPreOrderInExistenceScopes(c, op, { callbacks: context => ({
    [Algebra.Types.FILTER]: (filter: Algebra.Filter) => keep(sinkFilter(context, filter)),
    [Algebra.Types.LEFT_JOIN]: (leftJoin: Algebra.LeftJoin) => keep(sinkOptionalCondition(context, leftJoin)),
  }) });
}

/**
 * Pairs an expression with the variables it reads.
 * @param c - The transformation context
 * @param expression - The conjunct
 * @returns the conjunct with its reads
 */
function conjunctOf(c: TransformationContext, expression: Algebra.Expression): Conjunct {
  return { expression, reads: collectVariableNames(c.astTransformer, expression) };
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
): [Conjunct[], Conjunct[]] {
  return partition(
    splitConjunction(condition).map(expression => conjunctOf(c, expression)),
    conjunct => conjunct.reads.size > 0 && isStableExpression(c, conjunct.expression) && licence(conjunct),
  );
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
  return filterByConjunction(c, op, conjuncts.map(conjunct => conjunct.expression));
}

/**
 * Moves what may move of a filter's condition one operation down, the rest staying where the filter is.
 * @param c - The transformation context
 * @param filter - The filter met by the traversal
 * @returns what takes its place
 */
function sinkFilter(c: TransformationContext, filter: Algebra.Filter): Algebra.Operation {
  const [ moving, staying ] = splitCondition(c, filter.expression);
  return moving.length === 0 ? filter : filterOver(c, sinkInto(c, moving, filter.input), staying);
}

/**
 * Swaps conjuncts with the operation right below them, each entering the inputs the operation's rule licenses.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place, each one that may move
 * @param op - The operation they stand on
 * @returns the operation with the conjuncts placed
 */
function sinkInto(c: TransformationContext, conjuncts: Conjunct[], op: Algebra.Operation): Algebra.Operation {
  switch (op.type) {
    case Algebra.Types.FILTER: {
      // Two filters are one conjunction, so what may move of the lower one travels on with ours.
      const [ moving, staying ] = splitCondition(c, op.expression);
      return filterOver(c, sinkInto(c, [ ...conjuncts, ...moving ], op.input), staying);
    }
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.ORDER_BY:
    case Algebra.Types.FROM:
      return sinkIntoSingleInput(c, conjuncts, op, () => true);
    case Algebra.Types.UNION:
      return withInput(op, op.input.map(branch => filterOver(c, branch, conjuncts)));
    case Algebra.Types.MINUS:
      return withInput(op, [ filterOver(c, op.input[0], conjuncts), op.input[1] ]);
    case Algebra.Types.PROJECT:
      return sinkIntoSingleInput(c, conjuncts, op, projectionLicence(c, op));
    case Algebra.Types.GROUP: {
      // A conjunct on keys alone selects whole groups. That needs a key, as a keyless GROUP groups an empty input.
      const keys = groupingKeysOf(op);
      return sinkIntoSingleInput(c, conjuncts, op, conjunct => isSubsetOf(conjunct.reads, keys));
    }
    case Algebra.Types.GRAPH: {
      const { cVars } = cpMetaOf(c, op.input);
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
 * What a sub-SELECT lets into its WHERE clause: a conjunct reading only what it projects or never binds below.
 * @param c - The transformation context
 * @param project - The projection of the sub-SELECT
 * @returns whether a conjunct may enter it
 */
function projectionLicence(c: TransformationContext, project: Algebra.Project): (conjunct: Conjunct) => boolean {
  const projected = new Set(project.variables.map(variable => variable.value));
  const { vRanges } = cpMetaOf(c, project.input);
  return conjunct => [ ...conjunct.reads ].every(name => projected.has(name) || vRanges.neverBinds(name));
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
  op: Algebra.Operation & Algebra.Single,
  licence: (conjunct: Conjunct) => boolean,
): Algebra.Operation {
  const [ licensed, remaining ] = partition(conjuncts, licence);
  return filterOver(c, withInput(op, filterOver(c, op.input, licensed)), remaining);
}

/**
 * Sinks conjuncts below a `BIND(e AS ?x)`, writing `e` into those reading `?x`; one that cannot read `e` stays above.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param extend - The BIND they stand on
 * @returns the BIND with the conjuncts placed
 */
function sinkIntoExtend(c: TransformationContext, conjuncts: Conjunct[], extend: Algebra.Extend): Algebra.Operation {
  const bind = bindConstructionOf(c, extend);
  const { cVars } = cpMetaOf(c, extend.input);
  const below: Conjunct[] = [];
  const kept: Conjunct[] = [];
  for (const conjunct of conjuncts) {
    if (!conjunct.reads.has(bind.variable.value)) {
      below.push(conjunct);
    } else if (readerAdmitsConstruction(conjunct.expression, bind)) {
      const expression = substituteConstruction(c, conjunct.expression, bind, cVars);
      // A conjunct the construction decides to be true asks nothing any more.
      if (booleanConstantOf(expression) !== true) {
        below.push(conjunctOf(c, expression));
      }
    } else {
      kept.push(conjunct);
    }
  }
  return filterOver(c, withInput(extend, filterOver(c, extend.input, below)), kept);
}

/**
 * Sinks every conjunct into each JOIN operand deciding every variable it reads (FJPush).
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param join - The JOIN they stand on
 * @returns the JOIN with the conjuncts placed
 */
function sinkIntoJoin(c: TransformationContext, conjuncts: Conjunct[], join: Algebra.Join): Algebra.Operation {
  const operands = join.input.map(operand => cpMetaOf(c, operand));
  // Per conjunct, per operand: whether the operand decides what the conjunct reads.
  const decides = conjuncts.map(conjunct =>
    operands.map((_, operandIndex) => operandDecidesVariables(conjunct.reads, operandIndex, operands)));
  const rebuilt = c.AF.createJoin(join.input.map((operand, operandIndex) =>
    filterOver(c, operand, conjuncts.filter((_, index) => decides[index][operandIndex]))), false);
  return filterOver(c, rebuilt, conjuncts.filter((_, index) => !decides[index].includes(true)));
}

/**
 * Sinks conjuncts into an OPTIONAL, which becomes a JOIN under one rejecting what only its right side binds.
 * Otherwise each enters the left side where it decides it (FLPush), and the right side too where both bind it
 * certainly.
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
  const operands = [ cpMetaOf(c, left), cpMetaOf(c, right) ];
  const requiredBound = unionSets(conjuncts.map(conjunct => variablesRequiredBoundBy(conjunct.expression)));
  const innerJoin = innerJoinUnderRejectingFilter(c, leftJoin, requiredBound, operands[0]);
  if (innerJoin !== undefined) {
    return sinkInto(c, conjuncts, innerJoin);
  }
  const [ intoLeft, kept ] = partition(conjuncts, conjunct => operandDecidesVariables(conjunct.reads, 0, operands));
  const intoRight = intoLeft.filter(conjunct => everyOperandBindsCertainly(conjunct.reads, operands));
  return filterOver(c, sinkOptionalCondition(c, c.AF.createLeftJoin(
    filterOver(c, left, intoLeft),
    filterOver(c, right, intoRight),
    leftJoin.expression,
  )), kept);
}

/**
 * Moves the conjuncts of an OPTIONAL's condition into its right side where that side decides what they read.
 * @param c - The transformation context
 * @param leftJoin - The OPTIONAL whose condition to sink
 * @returns the OPTIONAL with what moved of its condition on its right side
 */
function sinkOptionalCondition(c: TransformationContext, leftJoin: Algebra.LeftJoin): Algebra.LeftJoin {
  if (leftJoin.expression === undefined) {
    return leftJoin;
  }
  const [ left, right ] = leftJoin.input;
  const operands = [ cpMetaOf(c, left), cpMetaOf(c, right) ];
  const [ moving, staying ] = splitCondition(c, leftJoin.expression, conjunct =>
    operandDecidesVariables(conjunct.reads, 1, operands));
  if (moving.length === 0) {
    return leftJoin;
  }
  const condition = staying.length === 0 ? undefined : conjunctionOf(c, staying.map(conjunct => conjunct.expression));
  return c.AF.createLeftJoin(left, filterOver(c, right, moving), condition);
}

/**
 * The pipeline step pushing every filter condition as deep into the plan as it keeps its meaning.
 * @returns the transformation
 */
export function pushDownFiltersTransformation(): QueryTransformation {
  return pushDownFilters;
}
