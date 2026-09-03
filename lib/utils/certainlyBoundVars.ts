import type * as RDF from '@rdfjs/types';
import type { Algebra as A, Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils, ExpressionTypes, Types } from '@traqula/algebra-transformations-1-2';
import {
  emptyRange,
  graphRange,
  objectRange,
  predicateRange,
  RangeSet,
  serviceNameRange,
  subjectRange,
  tripleTermRange,
} from '../RangeSet.js';
import { constructedTermOf } from './expressionHelpers.js';
import type { SSet } from './setUtils.js';
import { differenceSets, intersectSets, isSubsetOf, unionSets } from './setUtils.js';

/**
 * What an operation binds, as one structure: its **key set is exactly the variables in scope** - what
 * `SELECT *` expands to, the `pVars` - and the range stored for one is the term types it can hold *when it
 * is bound*.
 *
 * Key presence and range are independent on purpose, which is what makes the merge sound. A key at
 * {@link emptyRange} is a variable in scope that provably never binds, and it has to stay a key:
 * `pVars(Empty_S) := S`, never the empty set, or `SELECT *` scoping changes silently.
 *
 * One case deliberately drops a key rather than bottoming its range: a `FILTER(!bound(?x))` takes `?x` out
 * of scope, which is what the `pVars` this replaced did too. The bottom range would say it more precisely,
 * but (FBndII) reads *absence* as its emptiness proof, so moving it would change what the assertion
 * pushdown concludes. Worth revisiting once the bottom has consumers.
 */
export class VRanges extends Map<string, RangeSet> {
  /**
   * The term types `name` can be bound to here.
   * @param name - The variable to look up
   * @returns its range, {@link emptyRange} when it is not in scope at all, since a variable this operation
   * cannot bind takes no value in any of its solutions
   */
  public rangeOf(name: string): RangeSet {
    return this.get(name) ?? emptyRange;
  }

  /**
   * Whether no solution here binds `name`: it is out of scope, or in scope with a range no term satisfies.
   * @param name - The variable to check
   * @returns whether it never binds; anything reading assertions against an operation wants those two as one
   * fact, `bound(?x)` being false either way
   */
  public neverBinds(name: string): boolean {
    return this.rangeOf(name).size === 0;
  }

  /**
   * Whether some solution here can bind `name`: it is in scope and has a term left to take. The dual of
   * {@link neverBinds}, for the licences and guards that read the fact positively.
   * @param name - The variable to check
   * @returns whether it can bind
   */
  public canBind(name: string): boolean {
    return !this.neverBinds(name);
  }

  /**
   * Brings `name` into scope and narrows what is known about it: the variable has to satisfy both.
   * @param name - The variable to narrow
   * @param range - The term types it also has to satisfy
   */
  public narrow(name: string, range: RangeSet): void {
    this.set(name, (this.get(name) ?? objectRange).meet(range));
  }

  /**
   * Brings `names` into scope without saying anything about the terms they take.
   * @param names - The variables to bring into scope
   */
  public addAtTop(names: Iterable<string>): void {
    for (const name of names) {
      if (!this.has(name)) {
        this.set(name, objectRange);
      }
    }
  }
}

/**
 * What an operation binds: the variables every solution of it binds, and the scope with a range per
 * variable ({@link VRanges}).
 */
export interface CPMeta {
  cVars: SSet;
  vRanges: VRanges;
}

export type CPOp<T extends Algebra.Operation = Algebra.Operation> = T & { metadata: CPMeta };

/**
 * The ranges of the operands an operation *merges* - a BGP, a JOIN: a union of the variables in scope, but
 * an intersection of their ranges where possible.
 *
 * Only an operand that binds the variable *certainly* narrows it: its binding is in every solution, so
 * whatever else merges has to agree with it. Where no operand is certain the ranges **unite** instead, one
 * of them possibly being what leaves the variable unbound.
 * @param inputs - The metadata of the operands
 * @returns the merged ranges
 */
function intersectRanges(inputs: readonly CPMeta[]): VRanges {
  const result = new VRanges();
  const allNames = unionSets(inputs.map(input => new Set(input.vRanges.keys())));
  for (const name of allNames) {
    const certainlyBoundBranches = inputs.filter(input => input.cVars.has(name));
    if (certainlyBoundBranches.length > 0) {
      for (const input of certainlyBoundBranches) {
        result.narrow(name, input.vRanges.rangeOf(name));
      }
    } else {
      const binders = inputs.filter(input => input.vRanges.has(name));
      result.set(name, new RangeSet(binders.flatMap(input => [ ...input.vRanges.rangeOf(name) ])));
    }
  }
  return result;
}

/**
 * The ranges of the branches an operation *chooses between*: a variable takes the type of whichever branch
 * produced the solution, so the ranges are unioned.
 * @param inputs - The metadata of the branches
 * @returns the united ranges, a branch that does not have the variable in scope contributing nothing rather
 * than the top
 */
function unionRanges(inputs: readonly CPMeta[]): VRanges {
  const result = new VRanges();
  const names = unionSets(inputs.map(input => new Set(input.vRanges.keys())));
  for (const name of names) {
    const binders = inputs.filter(input => input.vRanges.has(name));
    result.set(name, new RangeSet(binders.flatMap(input => [ ...input.vRanges.rangeOf(name) ])));
  }
  return result;
}

/**
 * Narrows the range of every variable of `term` by the position it occupies, recursing into a triple term
 * with the positions of its components.
 * @param target - The ranges to narrow
 * @param term - The term to read
 * @param range - The range the term itself occupies
 */
function narrowTermRanges(target: VRanges, term: RDF.Term, range: RangeSet): void {
  if (term.termType === 'Variable') {
    target.narrow(term.value, range);
  } else if (term.termType === 'Quad') {
    narrowTermRanges(target, term.subject, subjectRange);
    narrowTermRanges(target, term.predicate, predicateRange);
    narrowTermRanges(target, term.object, objectRange);
  }
}

/**
 * The ranges a single quad pattern imposes on the variables it holds, which are exactly its scope.
 * @returns its ranges
 */
function patternRanges(pattern: { subject: RDF.Term; predicate: RDF.Term; object: RDF.Term; graph: RDF.Term }):
VRanges {
  const result = new VRanges();
  narrowTermRanges(result, pattern.subject, subjectRange);
  narrowTermRanges(result, pattern.predicate, predicateRange);
  narrowTermRanges(result, pattern.object, objectRange);
  narrowTermRanges(result, pattern.graph, graphRange);
  return result;
}

/**
 * The range of the target of a `BIND(e AS ?t)`: what the expression can possibly evaluate to.
 * @param expression - The expression of the EXTEND
 * @param input - The metadata of its input
 * @returns the range; only the shapes that decide a term type are read, everything else being the top
 * anyway and this only ever being asked to narrow
 */
function expressionRange(expression: Algebra.Expression, input: CPMeta): RangeSet {
  if (expression.subType === ExpressionTypes.TERM) {
    // A variable the input does not have in scope is never bound, so neither is the target: the bottom
    // {@link VRanges.rangeOf} reports for it is exactly right.
    return expression.term.termType === 'Variable' ?
      input.vRanges.rangeOf(expression.term.value) :
      new RangeSet([ expression.term.termType ]);
  }
  if (expression.subType === ExpressionTypes.OPERATOR && expression.operator === 'triple') {
    return tripleTermRange;
  }
  return objectRange;
}

/** Drops the `metadata` of the operation it is applied to, whatever that metadata holds. */
const dropMetadata = { transform: (copy: { metadata?: unknown }): unknown => {
  delete copy.metadata;
  return copy;
} };

/** Drops the metadata of every operation, no matter its type. */
const dropAllMetadata = Object.fromEntries(Object.values(Types).map(type => [ type, dropMetadata ]));

/**
 * Returns a copy of `op` without any cached metadata, the state {@link withCpVars} recomputes from. Since
 * every operation is copied, the tree it is given is left untouched.
 * @param op - The operation to strip
 * @returns the stripped copy
 */
export function withoutCpVars<T extends Algebra.Operation>(op: T): T {
  return algebraUtils.mapOperation<'unsafe', T>(op, dropAllMetadata);
}

/**
 * Whether constructing this triple term is guaranteed to yield a term rather than an evaluation error.
 * @param term - The triple term being constructed
 * @param vRanges - What the input binds
 * @returns whether every component is certainly a term its position admits
 */
function constructionCannotFail(term: RDF.BaseQuad, vRanges: VRanges): boolean {
  function admits(component: RDF.Term, position: RangeSet): boolean {
    if (component.termType === 'Variable') {
      // Every termType the variable can still take has to be one the position admits. The bottom range
      // would pass that vacuously, so it is ruled out first: nothing binds the variable there, and a
      // construction over something that never has a value is not one to call infallible.
      return vRanges.canBind(component.value) &&
        [ ...vRanges.rangeOf(component.value) ].every(type => position.has(type));
    }
    if (component.termType === 'Quad') {
      // A quad can be in this position and that quad construction cannot fail.
      return position.has('Quad') && constructionCannotFail(component, vRanges);
    }
    return position.has(component.termType);
  }
  return admits(term.subject, subjectRange) &&
    admits(term.predicate, predicateRange) &&
    admits(term.object, objectRange) &&
    // A triple term has no graph: the slot is an RDF/JS artefact and is always the default graph. A quad
    // with a real one is not something `<<( … )>>` can construct, so nothing here calls it infallible.
    term.graph.termType === 'DefaultGraph';
}

/**
 * The operation with its certainly and possibly bound variables assigned, computed by dynamic programming:
 * callers are responsible for keeping the metadata up to date when they manipulate the operation.
 * @param op - The operation to annotate
 * @returns the same operation, with its metadata attached
 */
export function withCpVars<T extends Algebra.Operation>(op: T): CPOp<T> {
  function asCPVars<T extends Algebra.Operation>(op: T): CPOp<T> {
    const casted = <CPOp<T>> op;
    if (!Object.hasOwn(op, 'metadata')) {
      casted.metadata = <any> {};
      if (!casted.metadata.cVars) {
        casted.metadata.cVars = new Set<string>();
      }
      if (!casted.metadata.vRanges) {
        casted.metadata.vRanges = new VRanges();
      }
    }
    return casted;
  }
  const casted = <T & { metadata?: Partial<CPMeta> }> op;
  if (casted.metadata !== undefined && casted.metadata.cVars !== undefined &&
    casted.metadata.vRanges !== undefined) {
    return <CPOp<T>> casted;
  }
  const resOp = asCPVars<T>(op);
  switch (resOp.type) {
    case Types.BGP: {
      const patterns = resOp.patterns.map(pattern => withCpVars(pattern).metadata);
      resOp.metadata.cVars = unionSets(patterns.map(pattern => pattern.cVars));
      // Every pattern of a BGP has to match at once, so a variable occurring in several of them takes
      // the one type all of its occurrences admit.
      resOp.metadata.vRanges = intersectRanges(patterns);
      return resOp;
    } case Types.PATTERN: {
      resOp.metadata.cVars = unionSets([ resOp.subject, resOp.predicate, resOp.object, resOp.graph ].map(termVars));
      resOp.metadata.vRanges = patternRanges(resOp);
      return resOp;
    } case Types.PATH: {
      const vars = unionSets([ resOp.subject, resOp.object, resOp.graph ].map(termVars));
      resOp.metadata.cVars = vars;
      // A path says nothing about the type of its endpoints - `?lit ^:p ?s` legitimately starts at a
      // literal, and a zero-length path returns whatever the other end held - so only the graph narrows.
      const ranges = new VRanges();
      ranges.addAtTop(vars);
      for (const name of termVars(resOp.graph)) {
        ranges.narrow(name, graphRange);
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.JOIN: {
      const inputs = resOp.input.map(input => withCpVars(input));
      resOp.metadata.cVars = unionSets(inputs.map(input => input.metadata.cVars));
      // Note the inversion against `cVars`: a join *merges* compatible mappings, so a variable several
      // operands can bind holds one value satisfying all of them - the ranges intersect where the
      // certainties unite. (For a union it is the other way around, see below.)
      resOp.metadata.vRanges = intersectRanges(inputs.map(input => input.metadata));
      return resOp;
    } case Types.UNION: {
      // A variable is only certain when every branch binds it, but any branch may bind it.
      const inputs = resOp.input.map(input => withCpVars(input));
      resOp.metadata.cVars = intersectSets(inputs.map(input => input.metadata.cVars));
      // The other half of the inversion: a solution comes from exactly *one* branch, so the value of a
      // variable is whatever that branch gave it - the ranges unite where the certainties intersect.
      resOp.metadata.vRanges = unionRanges(inputs.map(input => input.metadata));
      return resOp;
    } case Types.MINUS: {
      // The right-hand side of a MINUS contributes no binding at all to the result, not even a
      // possible one - its variables are out of scope above it.
      const left = withCpVars(resOp.input[0]);
      resOp.metadata.cVars = new Set(left.metadata.cVars);
      resOp.metadata.vRanges = new VRanges(left.metadata.vRanges);
      return resOp;
    } case Types.LEFT_JOIN: {
      // OPTIONAL only certainly binds whatever its left-hand (required) side binds.
      const [ left, right ] = resOp.input.map(input => withCpVars(input));
      resOp.metadata.cVars = new Set(left.metadata.cVars);
      // Where the left binds the variable *certainly* it is the left that decides its value in every
      // solution, the right hand side only ever contributing a compatible mapping. Where it does not, a
      // mapping of the left leaving it unbound merges with one of the right that binds it, so the right's
      // range is reachable too and the two unite. The key sets unite either way, which is what keeps the
      // scope of the OPTIONAL right.
      const ranges = new VRanges(left.metadata.vRanges);
      for (const [ name, range ] of right.metadata.vRanges) {
        if (!left.metadata.cVars.has(name)) {
          ranges.set(name, new RangeSet([ ...ranges.rangeOf(name), ...range ]));
        }
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.PROJECT: {
      const projected = new Set(resOp.variables.map(variable => variable.value));
      const input = withCpVars(resOp.input);
      resOp.metadata.cVars = intersectSets([ input.metadata.cVars, projected ]);
      // A projection only drops variables, so what it keeps still takes the values the input gave it -
      // and dropping one is now dropping its key, which is what takes it out of scope.
      resOp.metadata.vRanges = new VRanges(
        [ ...input.metadata.vRanges ].filter(([ name ]) => projected.has(name)),
      );
      return resOp;
    } case Types.GROUP: {
      // Only the grouping keys and the aggregate targets survive the grouping. A key is certain only
      // when the input binds it certainly: grouping on an unbound variable yields a group in which it
      // stays unbound. An aggregate may raise an evaluation error, so its target is never certain.
      const keys = new Set(resOp.variables.map(variable => variable.value));
      const input = withCpVars(resOp.input);
      // COUNT is the one aggregate that cannot fail: it counts the bound, non-error values of its
      // argument, so it yields an integer.
      // All others can end up with an error value leaving their target unbound.
      resOp.metadata.cVars = unionSets([
        intersectSets([ input.metadata.cVars, keys ]),
        new Set(resOp.aggregates
          .filter(aggregate => aggregate.aggregator === 'count')
          .map(aggregate => aggregate.variable.value)),
      ]);
      // A grouping key keeps holding the value of the input; an aggregate computes a new one, of a type
      // this does not track (COUNT is an integer, MIN takes the type of whichever row won), so it is top.
      // Only the keys and the aggregate targets stay in scope, and an aggregate writing over a key wins.
      const ranges = new VRanges([ ...input.metadata.vRanges ].filter(([ name ]) => keys.has(name)));
      for (const aggregate of resOp.aggregates) {
        ranges.set(aggregate.variable.value, objectRange);
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.VALUES: {
      // A VALUES variable is certainly bound only if every row provides a value for it.
      resOp.metadata.cVars = new Set(resOp.variables
        .filter(variable => resOp.bindings.every(binding => binding[variable.value] !== undefined))
        .map(variable => variable.value));
      // The column is spelled out, so its range is exactly the types it holds - the tightest this gets.
      // An all-UNDEF column lands on the bottom: declared by the VALUES, so in scope, yet never bound.
      const ranges = new VRanges();
      for (const variable of resOp.variables) {
        ranges.set(variable.value, new RangeSet(resOp.bindings
          .map(binding => binding[variable.value])
          .filter(value => value !== undefined)
          .map(value => value.termType)));
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.EXTEND: {
      const input = withCpVars(resOp.input);
      const certain = new Set(input.metadata.cVars);
      const ranges = new VRanges(input.metadata.vRanges);
      // Maybe the var we will create is also certain. Read through {@link constructedTermOf}, so that the
      // two spellings of one construction - `<<( s p o )>>` and the `TRIPLE(s, p, o)` the parser keeps
      // distinct from it - are the same fact here.
      const constructed = constructedTermOf(resOp.expression);
      if (constructed !== undefined &&
          // If it is a var, and that var is certain, we also certain
          isSubsetOf(termVars(constructed), certain) &&
          // A triple-term construction is the one term expression that can *fail*: it raises an
          // evaluation error - leaving the target unbound - when a component is not a term the position
          // it lands in admits. Where the ranges of the components rule that out, and a ground one rules
          // it out by itself, the construction is as certain as any other term.
          (constructed.termType !== 'Quad' ||
            constructionCannotFail(constructed, input.metadata.vRanges))) {
        certain.add(resOp.variable.value);
      }
      resOp.metadata.cVars = certain;
      // The EXTEND brings its target into scope, and what the expression yields overrides whatever the
      // input had to say about it - binding an already bound variable is an error, not a narrowing.
      ranges.set(resOp.variable.value, expressionRange(resOp.expression, input.metadata));
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.FILTER: {
      // The variables of an EXISTS stay inside it, so a filter never adds a possible binding.
      // However: depending on the filter, we can say something on vars being present.
      // Also filters pVars and cVars for `!bound(?x)`
      // Keep in mind: Filter False is a special case.
      const input = withCpVars(resOp.input);
      const unbound = variablesImpliedUnboundBy(resOp.expression);
      resOp.metadata.cVars = differenceSets(unionSets([
        input.metadata.cVars,
        variablesImpliedBoundBy(resOp.expression),
      ]), unbound);
      // A filter only drops solutions, so what survives still holds what the input put there. What the
      // *condition* narrows is the business of the pushdown, which reads it into an assertion instead.
      // A `!bound(?x)` takes `?x` out of scope entirely, as it did out of `pVars` - see the note in the
      // file header on why this is not the bottom range instead.
      const ranges = new VRanges(input.metadata.vRanges);
      for (const name of unbound) {
        ranges.delete(name);
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.GRAPH: {
      // Asserting on the graph variable selects one graph, so it is in scope above the GRAPH.
      const input = withCpVars(resOp.input);
      const graphVars = termVars(resOp.name);
      resOp.metadata.cVars = unionSets([ input.metadata.cVars, graphVars ]);
      // The graph variable is bound to the name of a graph, which is a NamedNode or a BlankNode - the
      // join with `{?g ↦ uᵢ}` binds it in every solution, so that much always holds.
      //
      // What the *pattern* says about it only holds on top of that where the pattern binds it certainly.
      // Where it does not, the solutions leaving it unbound down there take the graph name and nothing
      // else, so `P`'s range does not narrow: `GRAPH ?g { OPTIONAL { VALUES ?g { "l" } } }` binds `?g` to
      // a graph name whenever the OPTIONAL misses, where intersecting reports it as never bound at all.
      const ranges = new VRanges(input.metadata.vRanges);
      for (const name of graphVars) {
        if (input.metadata.cVars.has(name)) {
          ranges.narrow(name, graphRange);
        } else {
          ranges.set(name, graphRange);
        }
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    } case Types.SERVICE: {
      // A SILENT service that fails is replaced by a single empty solution, so no variable is certain.
      const input = withCpVars(resOp.input);
      resOp.metadata.cVars = resOp.silent ? new Set<string>() : new Set(input.metadata.cVars);
      const ranges = new VRanges(input.metadata.vRanges);
      for (const name of termVars(resOp.name)) {
        ranges.narrow(name, serviceNameRange);
      }
      resOp.metadata.vRanges = ranges;
      return resOp;
    }
    case Types.DISTINCT:
    case Types.REDUCED:
    case Types.SLICE:
    case Types.ORDER_BY:
    case Types.FROM: {
      // These only drop or reorder solutions, they never change which variables a solution binds.
      const input = withCpVars((<A.Single> <A.Operation> resOp).input);
      resOp.metadata.cVars = new Set(input.metadata.cVars);
      resOp.metadata.vRanges = new VRanges(input.metadata.vRanges);
      return resOp;
    }
    case Types.ASK:
    case Types.INV:
    case Types.NPS:
    case Types.ADD:
    case Types.COMPOSITE_UPDATE:
    case Types.CLEAR:
    case Types.CONSTRUCT:
    case Types.COPY:
    case Types.DELETE_INSERT:
    case Types.CREATE:
    case Types.DESCRIBE:
    case Types.DROP:
    case Types.EXPRESSION:
    case Types.LINK:
    case Types.LOAD:
    case Types.MOVE:
    case Types.ONE_OR_MORE_PATH:
    case Types.ALT:
    case Types.ZERO_OR_MORE_PATH:
    case Types.ZERO_OR_ONE_PATH:
    case Types.NOP:
    case Types.SEQ:
      // Everything without solution mappings of its own.
      resOp.metadata.cVars = new Set<string>();
      resOp.metadata.vRanges = new VRanges();
      return resOp;
  }
}

/**
 * What an operation binds, which is {@link withCpVars} read for its answer rather than for its side effect
 * of caching one - what every pass reading licences off the plan actually wants.
 * @param op - The operation to read
 * @returns its metadata
 */
export function cpMetaOf(op: Algebra.Operation): CPMeta {
  return withCpVars(op).metadata;
}

/**
 * Collects the variables a filter condition can only hold for when they are bound.
 * @param expression - The condition to read
 * @param agg - The variables collected so far, filled in by the recursion
 * @returns those variables
 */
function variablesImpliedBoundBy(expression: A.Expression, agg = new Set<string>()): Set<string> {
  if (expression.subType !== ExpressionTypes.OPERATOR) {
    return agg;
  }
  // Every conjunct of a `&&` has to hold, so each of them contributes.
  if (expression.operator === '&&') {
    for (const arg of expression.args) {
      variablesImpliedBoundBy(arg, agg);
    }
    return agg;
  }
  if (expression.operator === 'bound' || expression.operator === 'sameterm') {
    for (const arg of expression.args) {
      if (arg.subType === ExpressionTypes.TERM && arg.term.termType === 'Variable') {
        agg.add(arg.term.value);
      }
    }
  }
  return agg;
}

/**
 * Collects the variables a filter condition can only hold for when they are *unbound*.
 * @param expression - The condition to read
 * @param agg - The variables collected so far, filled in by the recursion
 * @returns those variables
 */
function variablesImpliedUnboundBy(expression: A.Expression, agg = new Set<string>()): SSet {
  if (expression.subType !== ExpressionTypes.OPERATOR) {
    return agg;
  }
  if (expression.operator === '&&') {
    for (const arg of expression.args) {
      variablesImpliedUnboundBy(arg, agg);
    }
    return agg;
  }
  if (expression.operator === '!') {
    for (const arg of expression.args) {
      if (arg.subType === ExpressionTypes.OPERATOR && arg.operator === 'bound') {
        for (const nested of arg.args) {
          if (nested.subType === ExpressionTypes.TERM && nested.term.termType === 'Variable') {
            agg.add(nested.term.value);
          }
        }
      }
    }
  }
  return agg;
}

/**
 * Collects the variables in an RDF term, recursing into quoted triples.
 * @param term - The term to read
 * @returns its variables
 */
export function termVars(term: RDF.Term): Set<string> {
  if (term.termType === 'Variable') {
    return new Set([ term.value ]);
  }
  if (term.termType === 'Quad') {
    return unionSets([ termVars(term.subject), termVars(term.predicate), termVars(term.object) ]);
  }
  return new Set<string>();
}
