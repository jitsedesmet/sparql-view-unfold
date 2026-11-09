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

/** An operation with conjuncts placed in it, and the conjuncts that stay above it. */
interface Placement {
  /** The operation with the conjuncts that moved placed in its inputs. */
  operation: Algebra.Operation;
  /** The conjuncts that stay above it. */
  kept: Conjunct[];
}

/**
 * Moves what may move of a filter's condition one operation down, the rest staying where the filter is.
 * @param c - The transformation context
 * @param filter - The filter met by the traversal
 * @returns what takes its place
 */
function sinkFilter(c: TransformationContext, filter: Algebra.Filter): Algebra.Operation {
  const input = filter.input.type === Algebra.Types.LEFT_JOIN ?
    joinUnderRejectingCondition(c, filter.input, filter.expression) :
    filter.input;
  const [ moving, staying ] = splitCondition(c, filter.expression);
  if (moving.length === 0) {
    return input === filter.input ? filter : filterOver(c, input, staying);
  }
  // One filter over what stays, so the traversal does not meet the conjuncts that could not move again.
  const { operation, kept } = sinkInto(c, moving, input);
  return filterOver(c, operation, [ ...kept, ...staying ]);
}

/**
 * The JOIN half of an OPTIONAL when a whole condition, also what of it cannot move, rejects its unmatched side.
 * @param c - The transformation context
 * @param leftJoin - The OPTIONAL the condition stands on
 * @param condition - The condition
 * @returns the JOIN half, or the OPTIONAL itself
 */
function joinUnderRejectingCondition(
  c: TransformationContext,
  leftJoin: Algebra.LeftJoin,
  condition: Algebra.Expression,
): Algebra.Operation {
  const requiredBound = variablesRequiredBoundBy(condition);
  return innerJoinUnderRejectingFilter(c, leftJoin, requiredBound, cpMetaOf(c, leftJoin.input[0])) ?? leftJoin;
}

/**
 * Swaps conjuncts with the operation right below them, each entering the inputs the operation's rule licenses.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place, each one that may move
 * @param op - The operation they stand on
 * @returns the operation with the conjuncts placed, and those that stay above it
 */
function sinkInto(c: TransformationContext, conjuncts: Conjunct[], op: Algebra.Operation): Placement {
  switch (op.type) {
    case Algebra.Types.FILTER: {
      // Two filters are one conjunction, so what may move of the lower one travels on with ours.
      const [ moving, staying ] = splitCondition(c, op.expression);
      const placement = sinkInto(c, [ ...conjuncts, ...moving ], op.input);
      return { ...placement, kept: [ ...placement.kept, ...staying ]};
    }
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.ORDER_BY:
    case Algebra.Types.FROM:
      return { operation: withInput(op, filterOver(c, op.input, conjuncts)), kept: []};
    case Algebra.Types.UNION:
      return { operation: withInput(op, op.input.map(branch => filterOver(c, branch, conjuncts))), kept: []};
    case Algebra.Types.MINUS:
      return { operation: withInput(op, [ filterOver(c, op.input[0], conjuncts), op.input[1] ]), kept: []};
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
      return { operation: op, kept: conjuncts };
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
 * Places conjuncts on the input of an operation where licensed, and keeps the others above it.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param op - The operation they stand on
 * @param licence - Whether a conjunct reads the same below the operation
 * @returns the operation with the conjuncts placed, and those that stay above it
 */
function sinkIntoSingleInput(
  c: TransformationContext,
  conjuncts: Conjunct[],
  op: Algebra.Operation & Algebra.Single,
  licence: (conjunct: Conjunct) => boolean,
): Placement {
  const [ licensed, kept ] = partition(conjuncts, licence);
  return { operation: licensed.length === 0 ? op : withInput(op, filterOver(c, op.input, licensed)), kept };
}

/**
 * Sinks conjuncts below a `BIND(e AS ?x)`, writing `e` into those reading `?x`; one that cannot read `e` stays above.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param extend - The BIND they stand on
 * @returns the BIND with the conjuncts placed, and those that stay above it
 */
function sinkIntoExtend(c: TransformationContext, conjuncts: Conjunct[], extend: Algebra.Extend): Placement {
  const [ below, readers ] = partition(conjuncts, conjunct => !conjunct.reads.has(extend.variable.value));
  const kept: Conjunct[] = [];
  if (readers.length > 0) {
    const bind = bindConstructionOf(c, extend);
    const { cVars } = cpMetaOf(c, extend.input);
    for (const conjunct of readers) {
      if (readerAdmitsConstruction(conjunct.expression, bind)) {
        const expression = substituteConstruction(c, conjunct.expression, bind, cVars);
        // A conjunct the construction decides to be true asks nothing any more.
        if (booleanConstantOf(expression) !== true) {
          below.push(conjunctOf(c, expression));
        }
      } else {
        kept.push(conjunct);
      }
    }
  }
  return { operation: below.length === 0 ? extend : withInput(extend, filterOver(c, extend.input, below)), kept };
}

/**
 * Sinks every conjunct into each JOIN operand deciding every variable it reads (FJPush).
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param join - The JOIN they stand on
 * @returns the JOIN with the conjuncts placed, and those that stay above it
 */
function sinkIntoJoin(c: TransformationContext, conjuncts: Conjunct[], join: Algebra.Join): Placement {
  const operands = join.input.map(operand => cpMetaOf(c, operand));
  // Per conjunct, per operand: whether the operand decides what the conjunct reads.
  const decides = conjuncts.map(conjunct =>
    operands.map((_, operandIndex) => operandDecidesVariables(conjunct.reads, operandIndex, operands)));
  const kept = conjuncts.filter((_, index) => !decides[index].includes(true));
  if (kept.length === conjuncts.length) {
    return { operation: join, kept };
  }
  const operation = withInput(join, join.input.map((operand, operandIndex) =>
    filterOver(c, operand, conjuncts.filter((_, index) => decides[index][operandIndex]))));
  return { operation, kept };
}

/**
 * Sinks conjuncts into an OPTIONAL, which becomes a JOIN under one rejecting what only its right side binds.
 * Otherwise each enters the left side where it decides it (FLPush), and the right side too where both bind it
 * certainly.
 * @param c - The transformation context
 * @param conjuncts - The conjuncts to place
 * @param leftJoin - The OPTIONAL they stand on
 * @returns the OPTIONAL, or the JOIN it became, with the conjuncts placed, and those that stay above it
 */
function sinkIntoOptional(c: TransformationContext, conjuncts: Conjunct[], leftJoin: Algebra.LeftJoin): Placement {
  const [ left, right ] = leftJoin.input;
  const operands = [ cpMetaOf(c, left), cpMetaOf(c, right) ];
  const requiredBound = unionSets(conjuncts.map(conjunct => variablesRequiredBoundBy(conjunct.expression)));
  const innerJoin = innerJoinUnderRejectingFilter(c, leftJoin, requiredBound, operands[0]);
  if (innerJoin !== undefined) {
    return sinkInto(c, conjuncts, innerJoin);
  }
  const [ intoLeft, kept ] = partition(conjuncts, conjunct => operandDecidesVariables(conjunct.reads, 0, operands));
  if (intoLeft.length === 0) {
    return { operation: leftJoin, kept };
  }
  const intoRight = intoLeft.filter(conjunct => everyOperandBindsCertainly(conjunct.reads, operands));
  // The OPTIONAL may end up where the traversal does not meet it again, so its own condition sinks here.
  const operation = sinkOptionalCondition(c, withInput(leftJoin, [
    filterOver(c, left, intoLeft),
    filterOver(c, right, intoRight),
  ]));
  return { operation, kept };
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
