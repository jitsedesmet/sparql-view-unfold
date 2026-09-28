import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformationContext } from '../transformContext.js';
import { collectVariableNames } from '../utils.js';
import { cpMetaOf, termVars } from './certainlyBoundVars.js';
import type { SSet } from './setUtils.js';
import { differenceSets, intersectSets, unionSets } from './setUtils.js';

/**
 * @fileoverview Demand analysis: which variables of an operation something above it reads.
 *
 * This is the required-variables analysis relational optimisers prune columns with, ported to SPARQL's
 * partial solution mappings. It runs top-down and carries one set, the **demand** `D`: the variables whose
 * values something above the operation reads. A variable outside `D` is *dead* there, and a rewrite may
 * change or remove its binding freely, as long as it keeps `π_D` of the solution multiset - duplicates
 * included - exactly as it was.
 *
 * {@link demandedVariablesOfInputs} is one step of it: the demand of an operation in, the demand of each
 * of its inputs out. It picks each input's demand so that the operation's output restricted to `D`
 * depends only on its inputs restricted to theirs, which is the induction step of the soundness argument.
 * Three rows are worth spelling out:
 *
 * - **A merge demands its join keys.** `JOIN`, `LEFT_JOIN` and `MINUS` decide compatibility on the
 *   variables two operands can both bind, so those are demanded of every operand that can bind them,
 *   whether anything above reads them or not. They are read off the ranges, `VRanges.canBind`, rather than
 *   off the scope: an operand in whose solutions a variable never binds cannot make a merge fail on it.
 * - **A deduplication demands everything.** `DISTINCT`, `REDUCED` and `COUNT(DISTINCT *)` compare whole
 *   solutions, and a column that distinguishes two of them - an unstable `BIND(RAND() AS ?r)` - changes
 *   how many survive.
 * - **An expression demands every variable it mentions**, those inside a nested `EXISTS` pattern
 *   included. That over-approximates what a correlated `EXISTS` reads, and needs no correlation analysis.
 *
 * The analysis reads only the `CPMeta` of the operation's inputs, which {@link cpMetaOf} computes once,
 * bottom-up, and caches - so walking a whole tree with it takes one top-down pass and no fixpoint.
 */

/**
 * The operations a query part is peeled out from under by the pipeline runner. Each reads a set of the
 * part's variables fixed by the query text, whatever the part turns out to bind.
 */
export type QueryPartReader =
  Algebra.Project | Algebra.Ask | Algebra.Construct | Algebra.Describe | Algebra.DeleteInsert;

/**
 * The variables an operation has in scope: what `SELECT *` over it expands to.
 * @param op - The operation to read
 * @returns the names of those variables
 */
export function variablesInScope(op: Algebra.Operation): SSet {
  return new Set(cpMetaOf(op).vRanges.keys());
}

/**
 * The variables of its query part that a query form or an update reads: the projection of a `SELECT`,
 * none for an `ASK`, the template of a `CONSTRUCT`, the described variables of a `DESCRIBE` and both
 * templates of a `DELETE`/`INSERT`.
 * @param c - The transformation context
 * @param reader - The query form or update standing over the query part
 * @returns the names of the variables it reads
 */
export function variablesReadOfQueryPart(c: TransformationContext, reader: QueryPartReader): SSet {
  switch (reader.type) {
    case Algebra.Types.PROJECT:
      return new Set(reader.variables.map(variable => variable.value));
    case Algebra.Types.ASK:
      // An ASK reads whether there is a solution at all, which is only the multiset being empty or not.
      return new Set<string>();
    case Algebra.Types.CONSTRUCT:
      return collectVariableNames(c.astTransformer, reader.template);
    case Algebra.Types.DESCRIBE:
      return new Set(reader.terms
        .filter(term => term.termType === 'Variable')
        .map(variable => variable.value));
    case Algebra.Types.DELETE_INSERT:
      return unionSets([
        collectVariableNames(c.astTransformer, reader.delete ?? []),
        collectVariableNames(c.astTransformer, reader.insert ?? []),
      ]);
  }
}

/**
 * The variables of its input a `GROUP` reads: its keys, and whatever its aggregate expressions mention.
 * @param c - The transformation context
 * @param group - The grouping to read
 * @returns the names of the variables it reads, the aggregate targets - written rather than read - excluded
 */
export function variablesReadByGrouping(c: TransformationContext, group: Algebra.Group): SSet {
  const readByGrouping = new Set(group.variables.map(variable => variable.value));
  // An aggregate is a `BoundAggregate`, an expression over the input beside the variable it writes, so
  // `GROUP BY ?k (SUM(?x) AS ?s)` reads an `?x` that is neither key nor target.
  for (const aggregate of group.aggregates) {
    for (const readVariable of collectVariableNames(c.astTransformer, aggregate.expression)) {
      readByGrouping.add(readVariable);
    }
  }
  return readByGrouping;
}

/**
 * Whether a grouping holds a `COUNT(DISTINCT *)`, the one aggregate that reads every variable of the
 * solutions it counts rather than the ones its expression names.
 * @param group - The grouping to read
 * @returns whether it counts distinct whole solutions
 */
function countsDistinctSolutions(group: Algebra.Group): boolean {
  return group.aggregates.some(aggregate =>
    aggregate.distinct && aggregate.expression.subType === Algebra.ExpressionTypes.WILDCARD);
}

/**
 * The join keys of each operand of a merge: the variables it can bind that at least one other operand can
 * bind too.
 * @param operands - The operands of the `JOIN`, `LEFT_JOIN` or `MINUS`
 * @returns one set per operand, indexed as the operands are
 */
function joinKeysPerOperand(operands: readonly Algebra.Operation[]): SSet[] {
  const bindablePerOperand = operands.map((operand) => {
    const { vRanges } = cpMetaOf(operand);
    return new Set([ ...vRanges.keys() ].filter(name => vRanges.canBind(name)));
  });
  const operandsThatCanBind = new Map<string, number>();
  for (const bindable of bindablePerOperand) {
    for (const name of bindable) {
      operandsThatCanBind.set(name, (operandsThatCanBind.get(name) ?? 0) + 1);
    }
  }
  return bindablePerOperand.map(bindable =>
    new Set([ ...bindable ].filter(name => (operandsThatCanBind.get(name) ?? 0) > 1)));
}

/**
 * The variables a list of expressions reads, nested `EXISTS` patterns included.
 * @param c - The transformation context
 * @param expressions - The expressions to read
 * @returns the names of those variables
 */
function variablesReadByExpressions(c: TransformationContext, expressions: readonly Algebra.Expression[]): SSet {
  return unionSets(expressions.map(expression => collectVariableNames(c.astTransformer, expression)));
}

/**
 * One step of the demand analysis: given what is demanded of an operation, what is demanded of each of its
 * inputs.
 * @param c - The transformation context
 * @param op - The operation, whose inputs' `CPMeta` the join keys are read off
 * @param demanded - The variables something above the operation reads
 * @returns the demand of each input, indexed as the operation holds them: `[input]` for a single input,
 * one per operand of a `JOIN`/`UNION`/`LEFT_JOIN`/`MINUS`, one per update of a composite one, `[where]`
 * for a `DELETE`/`INSERT` that has one, and `[]` for a leaf
 */
export function demandedVariablesOfInputs(
  c: TransformationContext,
  op: Algebra.Operation,
  demanded: ReadonlySet<string>,
): ReadonlySet<string>[] {
  switch (op.type) {
    case Algebra.Types.PROJECT:
      // Tighter than the projection itself, and sound because a deduplication above demands everything.
      return [ intersectSets([ demanded, variablesReadOfQueryPart(c, op) ]) ];
    case Algebra.Types.ASK:
    case Algebra.Types.CONSTRUCT:
    case Algebra.Types.DESCRIBE:
      return [ variablesReadOfQueryPart(c, op) ];
    case Algebra.Types.DELETE_INSERT:
      return op.where === undefined ? [] : [ variablesReadOfQueryPart(c, op) ];
    case Algebra.Types.COMPOSITE_UPDATE:
      // Every update decides what it reads of its own WHERE.
      return op.updates.map(() => new Set<string>());
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
      return [ variablesInScope(op.input) ];
    case Algebra.Types.SLICE:
    case Algebra.Types.FROM:
      return [ demanded ];
    case Algebra.Types.ORDER_BY:
      return [ unionSets([ demanded, variablesReadByExpressions(c, op.expressions) ]) ];
    case Algebra.Types.FILTER:
      return [ unionSets([ demanded, collectVariableNames(c.astTransformer, op.expression) ]) ];
    case Algebra.Types.UNION:
      return op.input.map(() => demanded);
    case Algebra.Types.JOIN:
      return joinKeysPerOperand(op.input).map(joinKeys => unionSets([ demanded, joinKeys ]));
    case Algebra.Types.LEFT_JOIN: {
      const readByCondition = variablesReadByExpressions(c, op.expression === undefined ? [] : [ op.expression ]);
      return joinKeysPerOperand(op.input).map(joinKeys => unionSets([ demanded, joinKeys, readByCondition ]));
    }
    case Algebra.Types.MINUS: {
      // The right-hand side contributes nothing to a solution, only a compatible mapping sharing a variable
      // with it: what is demanded of it is the join keys and nothing above. The graph-scope marker names a
      // variable bound outside the MINUS that the engine has to special-case, so it is kept on both sides.
      const [ joinKeysOfLeft, joinKeysOfRight ] = joinKeysPerOperand(op.input);
      const graphScopeVariables = new Set(op.graphScopeVar === undefined ? [] : [ op.graphScopeVar.value ]);
      return [
        unionSets([ demanded, joinKeysOfLeft, graphScopeVariables ]),
        unionSets([ joinKeysOfRight, graphScopeVariables ]),
      ];
    }
    case Algebra.Types.EXTEND: {
      const demandedWithoutTarget = differenceSets(demanded, new Set([ op.variable.value ]));
      // A bind nothing reads reads nothing itself: it is dead, and so is whatever only it needed.
      if (!demanded.has(op.variable.value)) {
        return [ demandedWithoutTarget ];
      }
      return [ unionSets([ demandedWithoutTarget, collectVariableNames(c.astTransformer, op.expression) ]) ];
    }
    case Algebra.Types.GROUP:
      // Only the keys and the aggregates see the input: nothing above a GROUP reads any other variable of it.
      return [ countsDistinctSolutions(op) ? variablesInScope(op.input) : variablesReadByGrouping(c, op) ];
    case Algebra.Types.GRAPH:
      return [ unionSets([ demanded, termVars(op.name) ]) ];
    case Algebra.Types.SERVICE:
      // Opaque: what the endpoint evaluates is not ours to prune.
      return [ variablesInScope(op.input) ];
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
      return [];
  }
}
