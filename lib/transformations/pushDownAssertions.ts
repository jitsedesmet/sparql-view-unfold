import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformContext } from '../transformContext.js';
import type { AssertionFilter } from '../utils/assertionConjunction.js';
import {
  AssertionConjunction,
  collectAssertions,
  isAssertionFilter,
} from '../utils/assertionConjunction.js';
import type { Access, AssertionConjunct, Assertions } from '../utils/assertions.js';
import {
  accessId,
  asTransferSource,
  assertBound,
  assertStrong,
  assertTermType,
  compareAccesses,
  variablesReadByConjunct,
  hasTarget,
  impliesBound,
  targetIsAccess,
  isAssertableTerm,
  isBareAccess,
  substituteInPattern,
  substituteInTerm,
  variablesOfTransferSource,
  asWeakenedConjunct,
} from '../utils/assertions.js';
import { cpMetaOf, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { booleanConstantOf, sameTermExpression } from '../utils/expressionHelpers.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { substituteInExpression } from '../utils/partialExpressionEvaluation.js';
import { unionSets } from '../utils/setUtils.js';
import type { DerivedVarNamer } from '../utils.js';
import { collectVariableNames, derivedVarNamer } from '../utils.js';

/**
 * @fileoverview Assertion filter pushdown.
 *
 * An earlier rewriting stage produces queries carrying *assertion filters*: `FILTER(sameTerm(?x, :p))`
 * fixing one variable to one term, and `FILTER(sameTerm(?x, ?y))` unifying two. Left where they are, they
 * only discard rows at the end; pushed down, they substitute into BGPs, prune VALUES rows and columns,
 * delete UNION branches, and can turn an OPTIONAL into a plain join.
 *
 * Rule names in parentheses refer to Figure 2 of Schmidt et al., "Foundations of SPARQL Query
 * Optimization" (https://dl.acm.org/doi/pdf/10.1145/1804669.1804675). Writing A⟨?x ≡ c⟩ for
 * `σ_{sameTerm(?x, c)}`, two properties drive the design: the assertion implies `bound(?x)`, so
 * (FBndII) is the only emptiness rule needed; and it is `sameTerm` rather than `=`, which is what makes
 * substituting the term into a pattern sound.
 *
 * ## What a unification adds
 *
 * `sameTerm(?x, ?y)` is an *edge* between two variables, and a chain of edges makes a **clique** that all
 * have to be equal. A clique is substituted to its lexicographically first member - `?s ?p ?o
 * FILTER(sameTerm(?s, ?o))` becomes `?o ?p ?o . BIND(?o AS ?s)`, the BIND being what keeps `pVars` exact -
 * and splitting one means splitting its *edges*, never its variables ({@link splitClique}): a clique is
 * transitively closed, so what a rule pushes down plus what it keeps has to span it again. There is no
 * sound weak form of a clique, so a rule that cannot take a whole edge sends down what the edge *entails*
 * instead - every member is bound - which is what collapses an OPTIONAL over a right-only variable.
 *
 * ## What a triple term adds
 *
 * `sameTerm(SUBJECT(?o), ?s)` is about one *position* of `?o`, so a conjunct is about an {@link Access} and
 * what a group carries is a **shape** rather than only a term. Three consequences run through the rules:
 *
 * - **A shape is not a term, but it is a pattern.** Where a term substitutes, a shape is *materialised*
 *   ({@link AssertionConjunction.intoPattern}): written out as a triple term whose positions hold what
 *   Θ has for them and a variable coined for the rest, with a `BIND` handing the variable back the
 *   value the pattern took. Only a pattern may take one (S3), so what no pattern states stays a condition.
 * - **A shape is a range statement.** A group carrying one holds a `Quad`, and no subject, predicate or
 *   graph position does, which is what confines the nesting of shapes to the `object` chain.
 * - **An edge may read through an accessor**, and then a clique is a clique of *readings* of one value,
 *   which splits over the targets on the licence of the one variable each reading goes through.
 *
 * ## The traversal
 *
 * A pre-order traversal, so an assertion filter is handled *before* what is below it, and each step only
 * describes how the filter swaps places with the operation it sits on. The result of that swap is
 * traversed in turn, so a filter that sank into a union branch keeps sinking on its own. What travels is
 * the whole conjunction that still holds, so a plan with several assertions is rewritten in one traversal.
 *
 * Every rewrite here preserves `pVars` exactly, never shrinks `cVars`, and preserves the multiplicity of
 * every surviving mapping - which is what lets the licences be read off the metadata of the operations
 * below without recomputing anything as they are rewritten.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/**
 * Pushes every assertion filter in `rootOp` as deep as possible, and into every branch that permits it -
 * for a join, that may be both sides at once.
 *
 * **Takes the root of a query, not a subtree of one.** Materialising a shape coins variables for the
 * positions nothing names, and the only thing keeping a coined name off a variable of the query is that
 * every variable of the query was collected before the pass ran. Nothing else in the pass cares, the
 * licences being read per operation, so this is the one precondition it has.
 * @param c - The transformation context
 * @param rootOp - The root of the query to rewrite
 * @returns the rewritten query
 * @example
 * // Before:
 * // SELECT * WHERE { { ?x :p ?y } UNION { ?z :q ?w } FILTER(sameTerm(?x, <ex://a>)) }
 * // After (the right branch can never bind ?x, so it becomes empty):
 * // SELECT * WHERE {
 * //   { <ex://a> <ex://p> ?y BIND(<ex://a> AS ?x) } UNION { ?z <ex://q> ?w FILTER(false) }
 * // }
 * @example
 * // Before: SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }
 * // After:  SELECT * WHERE { ?o ?p ?o . BIND(?o AS ?s) }
 */
export function pushDownAssertions<T extends Algebra.Operation>(c: TransformContext, rootOp: T): T {
  const callbacks: Parameters<typeof algebraUtils.mapOperationPreOrder<'unsafe', T>>[1] = Object.fromEntries(
    Object.values(Algebra.Types).map(type => [ type, (copy: Algebra.Operation) => keep(copy) ]),
  );
  // One namer for the whole pass, over every variable of the query as it stands *before* anything is
  // rewritten (D4). Both halves of that matter: a materialised position has to get the same name
  // wherever it is written, and a name coined against a part of the tree would collide with a variable
  // in the part that has not been met yet - which is also why this takes the root, see above.
  const namer = derivedVarNamer(collectVariableNames(c.astTransformer, rootOp));
  callbacks[Algebra.Types.FILTER] = (filter: Algebra.Filter) => pushFilter(c, namer, filter);
  // Starting from a copy without metadata gives both a tree of our own to rewrite and the guarantee that
  // what `withCpVars` hands us describes the plan as it is now - and it is cleared again on the way out
  // for the same reason, the rewrites having since changed what the traversal cached. Not *inside*
  // `mapOperationPreOrder`: `keepMetadata` is how a filter hands its conjunction to the next `pushFilter`.
  return withoutCpVars(algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(rootOp), callbacks));
}

/**
 * Handles one filter met by the traversal: one carrying assertions is split first (SDecompI), so that the
 * assertions travel on their own and what is left of the condition stays on top with the strong ones
 * substituted into it (FReord).
 * @param c - The transformation context
 * @param namer - Coins the variables a materialised shape needs
 * @param filter - The filter met by the traversal
 * @returns what the traversal should put in its place
 */
function pushFilter(c: TransformContext, namer: DerivedVarNamer, filter: Algebra.Filter): PreOrderMappingReturn {
  if (!isAssertionFilter(c, filter)) {
    return keep(filter);
  }
  const { assertions, residual, contradictory } = filter.metadata.assertions;
  if (contradictory) {
    // One variable cannot be two terms at once, so nothing below this can contribute anything.
    return empty(c, filter.input);
  }
  if (residual !== undefined) {
    // Leave behind the residual, we continue with remaining
    return keep(c.AF.createFilter(assertionFilter(c, filter.input, assertions), residual));
  }
  return pushAssertions(c, namer, assertions, filter.input);
}

/**
 * Swaps an assertion filter carrying Θ with the operation `op` right below it, per Figure 2.
 * @param c - The transformation context
 * @param namer - Coins the variables a materialised shape needs
 * @param assertions - The conjunction to push
 * @param op - The operation the filter sits on
 * @returns what the traversal should put in its place
 */
function pushAssertions(
  c: TransformContext,
  namer: DerivedVarNamer,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const normalised = assertions.normalisedFor(cpMetaOf(op));
  if (normalised === undefined) {
    return empty(c, op);
  }
  if (normalised.size === 0) {
    return keep(op);
  }
  return swapWith(c, namer, normalised, op);
}

/**
 * The rule per operation, for a conjunction {@link AssertionConjunction.normalisedFor} has already read in
 * terms of that operation.
 *
 * Wherever the weak form is licensed, an assertion that cannot travel strongly is *demoted* rather than
 * left behind - that is the difference between reaching a BGP and stopping at the join above it. The
 * unbound and bound forms have nothing to demote to, and neither has a clique edge, so they either pass as
 * themselves or stay.
 * @param c - The transformation context
 * @param namer - Coins the variables a materialised shape needs
 * @param assertions - The conjunction to place
 * @param op - The operation the filter sits on
 * @returns what the traversal should put in its place
 */
function swapWith(
  c: TransformContext,
  namer: DerivedVarNamer,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const { AF } = c;
  switch (op.type) {
    // A BGP and a path bind all of their variables, so normalisation has made every assertion reaching
    // them strong, and a clique is substituted to its representative. Every leaf is handed the *same*
    // conjunction; what differs is what each can pay off with the rewrite it makes, and so what has to
    // be restated over it. A pattern settles what a pattern can state - a term, an equality, a shape -
    // and no more, `isIRI(?x)` staying; a VALUES row settles everything at once ({@link pruneValues}).
    case Algebra.Types.BGP: {
      return keep(rewritePattern(c, assertions, namer, substitution => substituteIntoPatterns(c, op, substitution)));
    }
    case Algebra.Types.PATH: {
      return keep(rewritePattern(c, assertions, namer, substitution => substituteIntoPath(c, op, substitution)));
    }
    // The one leaf where all of the forms do real work, since a VALUES column may be UNDEF.
    case Algebra.Types.VALUES: {
      // After normalisation every conjunct is about a column of this VALUES anyway - a variable it does
      // not declare can never be bound here - but the split makes that a fact of this rewrite rather
      // than an invariant read off another one.
      const columns = new Set(op.variables.map(variable => variable.value));
      const { inside, outside } = assertions.split(name => columns.has(name));
      return keep(assertionFilter(c, pruneValues(c, op, inside), outside));
    }

    // (FUPush) holds unconditionally for every form - a solution of a union comes from exactly one
    // branch - so every branch gets the conjunction and keeps sinking on its own.
    case Algebra.Types.UNION: {
      return keep(AF.createUnion(op.input.map(branch => assertionFilter(c, branch, assertions)), false));
    }
    case Algebra.Types.FILTER: {
      // The conjunction we manage absorbs the assertions of the filter we pass (SDecompI),
      const collected = collectAssertions(c, op.expression, assertions, cpMetaOf(op.input).cVars);
      if (collected === undefined) {
        return empty(c, op);
      }
      const below = assertionFilter(c, op.input, collected.assertions);
      return collected.residual === undefined ?
      // Nothing stays here, so the (bigger) conjunction has to be handed back to keep sinking.
          { ...keepMetadata, newValue: below, reTransform: true } :
        keep(AF.createFilter(below, collected.residual));
    }
    case Algebra.Types.EXTEND: {
      return pushIntoExtend(c, op, assertions);
    }
    case Algebra.Types.GRAPH: {
      return pushIntoGraph(c, op, assertions);
    }
    case Algebra.Types.JOIN: {
      return pushIntoJoin(c, c.AF.createJoin(op.input, true), assertions);
    }
    case Algebra.Types.LEFT_JOIN: {
      return pushIntoLeftJoin(c, op, assertions);
    }
    case Algebra.Types.MINUS: {
      // A mapping μ ∈ LHS is removed if:
      // ∃ μ' ∈ RHS . (μ and μ' are compatible) && (dom(μ) and dom(μ') are not disjoint)
      const [ left, right ] = op.input;
      return keep(AF.createMinus(
        // FMPush: the output is a subset of the LHS, so filtering it here is filtering the output.
        assertionFilter(c, left, assertions),
        // The RHS takes only the weakened form of what the LHS holds strongly ({@link admissibleOnMinusRhs}).
        assertionFilter(c, right, admissibleOnMinusRhs(assertions)),
      ));
    }
    case Algebra.Types.GROUP: {
      // An assertion on a grouping key selects whole groups, which is the same as selecting the solutions
      // those groups are formed from. Anything else stays above: filtering before the aggregation would
      // change the aggregate. An edge with one endpoint outside the keys is one of those, and kept on top
      // normalisation correctly empties the plan, that endpoint being out of scope above the GROUP.
      const groupsOn = new Set(op.variables.map(variable => variable.value));
      const { inside, outside } = assertions.split(name => groupsOn.has(name));
      if (inside.size === 0) {
        return keep(assertionFilter(c, op, assertions));
      }
      return keep(assertionFilter(
        c,
        AF.createGroup(assertionFilter(c, op.input, inside), op.variables, op.aggregates),
        outside,
      ));
    }
    // Congruence: these do not touch which variables a solution binds. For the projection,
    // dom(Θ) ⊆ variables holds - not because a filter may not name what the projection drops, but because
    // `normalisedFor` has already met Θ with the `vRanges` of this operation, and a variable it does not
    // project never binds here: the strong forms empty the plan there and the rest are dropped, so nothing
    // naming one is left to push.
    case Algebra.Types.PROJECT: {
      return keep(AF.createProject(assertionFilter(c, op.input, assertions), op.variables));
    }
    case Algebra.Types.DISTINCT: {
      return keep(AF.createDistinct(assertionFilter(c, op.input, assertions)));
    }
    case Algebra.Types.REDUCED: {
      return keep(AF.createReduced(assertionFilter(c, op.input, assertions)));
    }
    case Algebra.Types.ORDER_BY: {
      return keep(AF.createOrderBy(assertionFilter(c, op.input, assertions), op.expressions));
    }
    case Algebra.Types.FROM: {
      return keep(AF.createFrom(assertionFilter(c, op.input, assertions), op.default, op.named));
    }
    default: {
      // A barrier. SLICE and a GROUP over a non-key are genuine ones - filtering before a slice changes
      // which rows fall in the window, filtering before an aggregation changes the aggregate - and
      // SERVICE is one by scoping decision: pushing into it is sound, but SILENT turns endpoint failure
      // into a single empty solution, so it has to be a replication rather than a move.
      return keep(assertionFilter(c, op, assertions));
    }
  }
}

/**
 * Substitutes the assertions into a BGP, {@link rewritePattern} putting back what that takes out.
 *
 * All variables of a BGP are certainly bound, so the only thing left to check is whether the terms can
 * occupy the positions they land in. BGPs are duplicate-free and substituting only restricts which
 * solutions exist, so multiplicities are preserved.
 * @param c - The transformation context
 * @param op - The BGP to substitute into
 * @param assertions - The substitution to write in
 * @returns the rewritten BGP, or the empty operation when a term can no longer occupy its position
 */
function substituteIntoPatterns(
  c: TransformContext,
  op: Algebra.Bgp,
  assertions: Assertions,
): Algebra.Operation {
  const substituted: Algebra.Pattern[] = [];
  for (const pattern of op.patterns) {
    const replacement = substituteInPattern(c, pattern, assertions);
    if (replacement === undefined) {
      // Empty when e.g. pushing literal in subject position
      return emptyOperation(c, op);
    }
    substituted.push(replacement);
  }
  return c.AF.createBgp(substituted);
}

/**
 * Substitutes the assertions into a property path, {@link rewritePattern} putting back what that takes out.
 *
 * Unlike a BGP a path may legitimately have a literal in its subject slot (`?lit ^:p ?s`), so only the
 * graph position is checked. Paths are not duplicate-free, but substituting only restricts the set of
 * start nodes and leaves the witness count of every surviving pair untouched.
 * @param c - The transformation context
 * @param path - The path to substitute into
 * @param assertions - The substitution to write in
 * @returns the rewritten path, or the empty operation when a term can no longer occupy its position
 */
function substituteIntoPath(c: TransformContext, path: Algebra.Path, assertions: Assertions): Algebra.Operation {
  const subject = substituteInTerm(path.subject, assertions, 'object');
  const object = substituteInTerm(path.object, assertions, 'object');
  const graph = substituteInTerm(path.graph, assertions, 'graph');
  if (subject === undefined || object === undefined || graph === undefined) {
    return emptyOperation(c, path);
  }
  return c.AF.createPath(subject, path.predicate, object, graph);
}

/**
 * Rewrites a pattern under Θ: the substitution written into it, the re-binding of every variable that
 * took out of it, and a condition for what a pattern cannot state.
 *
 * The three come from one call ({@link AssertionConjunction.intoPattern}) because they are one decision;
 * `substituteInto` is the only thing a BGP and a property path differ in. The condition goes on the
 * pattern, below the re-binding, and is written against the values the pattern holds rather than against
 * the accesses Θ reads them by: `isIRI(OBJECT(?o))` becomes `isIRI(?o_o)`, a condition over a variable
 * the pattern binds and one an engine can push into the scan.
 * @param c - The transformation context
 * @param assertions - The conjunction to write into the pattern
 * @param namer - Coins the variables a materialised shape needs
 * @param substituteInto - Writes the substitution into the pattern, checking the positions its own kind of
 * pattern can hold
 * @returns the rewritten pattern, its condition and its re-bindings
 */
function rewritePattern(
  c: TransformContext,
  assertions: AssertionConjunction,
  namer: DerivedVarNamer,
  substituteInto: (substitution: Assertions) => Algebra.Operation,
): Algebra.Operation {
  const { substitution, residual, asWritten } = assertions.intoPattern(namer);
  const pattern = substituteInto(substitution);
  // Read against what the pattern now binds, which is what decides `sameTerm(?x, ?x)` for it. Placing the
  // condition below the re-binding rather than above needs no check: a name the substitution re-binds
  // cannot reach the condition at all, every strong member's access having resolved to the value written
  // for it. So it reads what the pattern itself binds, and belongs as deep as that goes.
  const condition = residual.size === 0 ?
    undefined :
    substituteInExpression(c, residual.toExpression(c), asWritten, cpMetaOf(pattern).cVars);
  // A conjunct the values decide - `bound(?x)` of a variable the pattern writes, say - leaves nothing to
  // ask. `false` is not the mirror of this and keeps its filter: that is the empty operation, which
  // {@link transformFilterFalse} normalises away afterwards.
  const settled = condition === undefined || booleanConstantOf(condition) === true;
  return bindAssertedTerms(c, settled ? pattern : c.AF.createFilter(pattern, condition), substitution);
}

/**
 * Prunes the rows of a VALUES that Θ rules out, and drops the columns what stays can rebuild.
 *
 * **A row is a solution mapping**: it names the term each of its columns holds, and says of the columns it
 * does not carry that they are unbound. So asserting a row into a copy of Θ decides every form at
 * once, and a row Θ survives is a row that satisfies it - which is what sets this apart from the
 * pattern rules, a pattern stating what it can match where a row *is* the answer. Row-level filtering keeps
 * duplicate rows duplicated, so multiplicities are preserved.
 *
 * The clone that costs is taken only for the rows {@link agreesWithPins} could not already rule out.
 * @param c - The transformation context
 * @param values - The VALUES to prune
 * @param assertions - The conjunction to prune it by
 * @returns the pruned VALUES with a re-binding per dropped column, or the empty operation when no row
 * survives
 */
function pruneValues(c: TransformContext, values: Algebra.Values, assertions: AssertionConjunction): Algebra.Operation {
  const substitution = assertions.rebuildingSubstitution();
  // A column stays unless something else carries what it held: the re-binding rebuilds it, or U⟨?x⟩
  // says there is nothing left to hold.
  const isRebuilt = (name: string): boolean =>
    substitution.has(name) || assertions.get(name)?.subType === 'unbound';
  const newBindings: Algebra.Values['bindings'] = [];
  const pins = termPinsOn(assertions, values.variables);
  for (const binding of values.bindings) {
    // TermPinsOn is wayyy cheaper then rowSatisfies
    if (agreesWithPins(pins, binding) && rowSatisfies(assertions, values.variables, binding)) {
      newBindings.push(Object.fromEntries(
        Object.entries(binding).filter(([ name ]) => !isRebuilt(name)),
      ));
    }
  }
  // Zero rows means empty sequence which we write as the empty operation.
  if (newBindings.length === 0) {
    return emptyOperation(c, values);
  }
  // Zero columns is allowed: `VALUES () { () () () }` - it contributes one empty solution mapping per
  // row. With exactly one row that is the same as the empty BGP.
  const remainingVars = values.variables.filter(variable => !isRebuilt(variable.value));
  const pruned = remainingVars.length === 0 && newBindings.length === 1 ?
    c.AF.createBgp([]) :
    c.AF.createValues(remainingVars, newBindings);
  return bindAssertedTerms(c, pruned, substitution);
}

/** A column of a VALUES and the term Θ pins it to. */
interface ColumnPin {
  /** The name of the column */
  name: string;
  /** The term every value of it equals */
  term: RDF.Term;
}

/**
 * The term each column of a VALUES is pinned to, for the columns Θ pins to one.
 *
 * Taken once per VALUES so that {@link agreesWithPins} can turn away the rows that disagree with a pin
 * without paying for the clone {@link rowSatisfies} takes. The weak form counts: a row binding the column
 * to a term satisfies the `bound` half of `¬bnd(?x) ∨ ?x ≡ c`, which leaves the pin to answer for.
 *
 * Only a *term* pin is read. A group pinned to a shape, or one that is merely equated with another column,
 * is left to the full check - the pre-filter has to be exact about what it turns away, not complete.
 * @param assertions - The conjunction to read the pins off
 * @param variables - The columns of the VALUES
 * @returns the pinned columns and the term each is pinned to
 */
function termPinsOn(
  assertions: AssertionConjunction,
  variables: readonly RDF.Variable[],
): ColumnPin[] {
  const pins: ColumnPin[] = [];
  for (const variable of variables) {
    const assertion = assertions.get(variable.value);
    if (assertion !== undefined && hasTarget(assertion) && !targetIsAccess(assertion.term)) {
      pins.push({ name: variable.value, term: assertion.term });
    }
  }
  return pins;
}

/**
 * Whether a row could satisfy Θ as far as its {@link termPinsOn | term pins} go, which is the cheap half of
 * {@link rowSatisfies}.
 *
 * **Sound because a pin is the same equality either way round.** Asserting the term a row holds onto a group
 * already pinned to a term meets the two pins, and that meet is `term.equals` and nothing else, so a row
 * disagreeing with a pin is a row the full check has to reject - whichever column it reaches first. Nothing
 * a row asserts can move a group off a term pin either: a merge keeps the pin it met, or fails. A row this
 * lets through is still checked in full, so being generous costs only the check it was going to pay for
 * anyway - an unbound column, a column Θ says nothing about, and a shape all go that way.
 * @param pins - The term pins of the columns
 * @param binding - The row to check
 * @returns whether the row agrees with every pin it holds a term for
 */
function agreesWithPins(
  pins: readonly ColumnPin[],
  binding: Algebra.Values['bindings'][number],
): boolean {
  return pins.every(({ name, term }) => {
    const value = binding[name];
    return value === undefined || term.equals(value);
  });
}

/**
 * Whether the solution mapping one row of a VALUES stands for satisfies Θ.
 *
 * Asserted into a copy rather than read against it per variable, which is what makes the rule uniform over
 * the forms. Every column is asserted, the ones Θ says nothing about included, since a column Θ
 * reaches only through the shape of another one is decided by the row that holds it.
 * @param assertions - The conjunction to satisfy
 * @param variables - The columns of the VALUES
 * @param binding - The row to check
 * @returns whether the row satisfies the conjunction
 */
function rowSatisfies(
  assertions: AssertionConjunction,
  variables: readonly RDF.Variable[],
  binding: Algebra.Values['bindings'][number],
): boolean {
  const attempt = assertions.clone();
  return variables.every((variable) => {
    const value = binding[variable.value];
    return value === undefined ?
      attempt.assertUnbound(variable.value) :
      attempt.assertTerm(variable.value, value, true);
  });
}

/**
 * Pushes the assertions through an EXTEND (BIND).
 *
 * Asserting the variable the BIND targets is the interesting case:
 * `σ_{?x=c}(Extend(A,?x,e)) == Extend(σ_{sameTerm(e,c)}(A), ?x, c)`. Whenever `e` is something
 * Θ can *name* ({@link asTransferSource}), everything the conjunction says about `?x`
 * {@link AssertionConjunction.transferred | transfers} onto it below, which is one rule covering every
 * combination of what `?x` had to equal with what now carries it:
 *
 * - `BIND(?z AS ?t)` under A⟨?t ≡ c⟩ leaves A⟨?z ≡ c⟩ below, so a renaming propagates an assertion;
 * - `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩ propagates a unification, which may then reach a BGP;
 * - `BIND(:c AS ?t)` under A⟨?t ≡ ?y⟩ pins a clique the assertions had found no term for;
 * - `BIND(SUBJECT(?o) AS ?t)` leaves what was said about `?t` on the *access* below, giving `?o` a shape;
 * - `BIND(<<( ?a ?b ?c )>> AS ?t)` under a shape on `?t` is that shape taken apart, so `sameTerm(SUBJECT(
 *   ?t), :a)` reaches the pattern binding `?a` as `sameTerm(?a, :a)`.
 *
 * Only the forms that imply `bound(?x)` do any of that: W⟨?x ≡ c⟩ is also satisfied by the solutions where
 * `e` errored and left `?x` unbound, so it says nothing about `e`, and neither does U⟨?x⟩.
 * @param c - The transformation context
 * @param extend - The EXTEND the filter sits on
 * @param assertions - The conjunction to place
 * @returns what the traversal should put in its place
 */
function pushIntoExtend(
  c: TransformContext,
  extend: Algebra.Extend,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const target = extend.variable.value;
  const expression = extend.expression;
  const assertionOfTarget = assertions.get(target);
  // The expression is evaluated over the input of the EXTEND, wherever this rewrite ends up putting it.
  const { cVars } = cpMetaOf(extend.input);
  // SPARQL spec keeps BINDing an in-scope variable explicitly undefined. We assume it errors,
  // so in `bind(e AS ?x)` ?x is not bound below the EXTEND. It has to leave Θ before descending,
  // or the (FBndII) check at the top of the swap wrongly yields empty.
  const { inside: notAboutTarget, outside: aboutTarget } = assertions.split(name => name !== target);

  // A BIND of something Θ can name carries below the EXTEND whatever the target carries above it, so Θ
  // transfers onto it. A source *reading the target* is not one of them: `BIND(?x AS ?x)` binds nothing,
  // the target being unbound below itself, and a construction mentioning it reads a variable that is
  // equally unbound there - so there is nothing down there for Θ to be about.
  const sourceTransfer = asTransferSource(expression);
  const exprWithFollowUp = sourceTransfer === undefined || variablesOfTransferSource(sourceTransfer).has(target) ?
    undefined :
    sourceTransfer;

  // If we know the expression, and we have something to say about the target, and we NEED the target to be bounded:
  //   BIND(:c as ?x) -- :c is a assertableTerm or var; ?x is asserted that it should be bound
  if (exprWithFollowUp !== undefined && assertionOfTarget !== undefined && impliesBound(assertionOfTarget)) {
    const below = assertions.transferred(target, exprWithFollowUp);
    if (below === undefined) {
      // The two terms the target had to be at once, or two cliques pinned to different ones.
      return empty(c, extend);
    }
    // `?z ≡ c` holds below, so binding `?x` straight to `c` is the same as binding it to `?z`; and where
    // the transfer was a clique membership, `?z` is written as the representative it substitutes to.
    return keep(AF.createExtend(
      assertionFilter(c, extend.input, below),
      extend.variable,
      substituteInExpression(c, expression, below.expressionSubstitution(), cVars),
    ));
  }

  if (assertionOfTarget?.subType === 'strong' && !targetIsAccess(assertionOfTarget.term) &&
    isAssertableTerm(assertionOfTarget.term)) {
    // BIND(expr as ?x) -- ?x is strongly asserted and pinned to a assertable term.
    // We know we have a strong target assertion, against a ground term, and a compound expression.
    const term = assertionOfTarget.term;
    // For a compound expression, `sameTerm(e, c)` is a multi-variable condition: it needs the full
    // (FJPush) side condition quantified over vars(e), not the single variable licence this pass uses,
    // so it is left here for a generic filter pushdown.
    return keep(AF.createExtend(
      AF.createFilter(
        assertionFilter(c, extend.input, notAboutTarget),
        sameTermExpression(
          c,
          substituteInExpression(c, expression, notAboutTarget.expressionSubstitution(), cVars),
          term,
        ),
      ),
      extend.variable,
      AF.createTermExpression(term),
    ));
  }

  // Anything that could not transfer stays here:
  // the weak, bound and unbound forms, and a clique the BIND gives no term to copy into.
  return keep(assertionFilter(
    c,
    AF.createExtend(
      assertionFilter(c, extend.input, notAboutTarget),
      extend.variable,
      substituteInExpression(c, expression, notAboutTarget.expressionSubstitution(), cVars),
    ),
    aboutTarget,
  ));
}

/**
 * Pushes the assertions through a GRAPH, which is transparent rather than a barrier.
 *
 * SPARQL evaluates it as a union over the named graphs, each joined with the binding of the graph variable
 * (section 18.5): `Graph(?g,P) == union over (u_i, G_i) of ( [[P]]_{G_i} join {?g -> u_i} )`. An assertion
 * on a variable other than `?g` distributes over that union by (FUPush) and into each join by (FJPush), so
 * it travels into `P` whole. An assertion fixing `?g` to a term selects the single named graph, which needs
 * both halves put back: `P` gets the assertion in the *weak* form, since it need not bind `?g` itself, and
 * `{?g -> c}` is joined back on so that `?g` does not leave `pVars`.
 * @param c - The transformation context
 * @param graph - The GRAPH the filter sits on
 * @param assertions - The conjunction to place
 * @returns what the traversal should put in its place
 */
function pushIntoGraph(
  c: TransformContext,
  graph: Algebra.Graph,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const graphName = graph.name;
  const graphVar = graphName.termType === 'Variable' ? graphName.value : undefined;

  // The name is already a single graph, so every assertion simply travels into the pattern.
  if (graphVar === undefined) {
    return keep(AF.createGraph(assertionFilter(c, graph.input, assertions), graphName));
  }
  const assertedGraphName = assertions.get(graphVar);

  if (assertedGraphName?.subType === 'strong' && !targetIsAccess(assertedGraphName.term) &&
    isAssertableTerm(assertedGraphName.term) &&
    // A term outside `?g`'s range has already emptied the plan in `normalisedFor`, so what can still be
    // asserted here is a graph name: a NamedNode, or the BlankNode a dataset may equally name a graph by.
    // Only the first can be written back - `createGraph` names a graph by a Variable or a NamedNode - so
    // the second falls through to the general path below rather than being treated as an emptiness.
    assertedGraphName.term.termType === 'NamedNode') {
    // Read before the rewrite, which preserves the scope exactly and never shrinks `cVars`.
    const { cVars, vRanges } = cpMetaOf(graph.input);
    // `?g` travels on into the pattern, in the *weak* form: `P` need not bind it at all, and the join
    // with `{?g ↦ c}` is what would have dropped the solutions binding it to anything else.
    const graphIndependentAssertions = assertions.split(name => name !== graphVar).inside;
    // The split kept back every conjunct reading `?g`, so nothing in there constrains it and the pin lands
    // on a group of its own. A contradiction would leave the conjunction in the unreadable state a failed
    // narrowing documents, and this pushes it into the pattern, so it is raised rather than ignored.
    if (!graphIndependentAssertions.assertTerm(graphVar, assertedGraphName.term, false)) {
      throw new Error(`Unreachable: ?${graphVar} is not read by the conjunction it is pinned in`);
    }
    const selected = AF.createGraph(
      assertionFilter(c, graph.input, graphIndependentAssertions),
      assertedGraphName.term,
    );

    if (cVars.has(graphVar)) {
      // Every solution of `P` binds `?g` - and the weak assertion, promoted to the strong one down there,
      // has already fixed it to `c` - so joining `{?g ↦ c}` back on would change nothing.
      return keep(selected);
    }
    if (vRanges.canBind(graphVar)) {
      // `P` binds `?g` in some solutions and not others, so the join has to stay one: an EXTEND raises an
      // error on a variable that is already bound. A single row binding `?g` to `c` *is* `{?g ↦ c}`.
      // Read as `canBind` rather than as scope: `?g` may be *declared* below and bindable by nothing
      // there, and then no solution of `P` can be the one the EXTEND would raise on.
      // This JOIN is required because we DO NOT CHANGE pVars/ cVars.
      // TODO(future): we could provide a transformation that recognizes a BIND/VALUES join with a cVar join
      return keep(AF.createJoin([ selected, AF.createExtend(
        AF.createBgp([]),
        c.DF.variable(graphVar),
        AF.createTermExpression(assertedGraphName.term),
      ) ], false));
    }
    // `P` never binds `?g`, so the join only ever adds the binding, which is what an EXTEND does.

    return keep(bindAssertedTerms(c, selected, new Map([[ graphVar, assertedGraphName.term ]])));
  }

  // Only a term that can *name* a graph in the algebra selects one. Everything else - nothing asserted, a
  // clique over `?g`, or a BlankNode graph name - travels into the pattern except for what mentions `?g`,
  // which stays above. Since `?g ∈ cVars(Graph)`, the weak and
  // bound forms cannot be what is asserted here: normalisation has already promoted or dropped them.
  //
  // The pattern is the one target, licensed for every variable but `?g` and *connecting* what it takes:
  // a condition not mentioning `?g` moves through `⋃ᵢ (⟦P⟧_uᵢ ⋈ {?g ↦ uᵢ})` untouched, so it still holds
  // of every solution up here. It may bind `?g` whatever it is told, the GRAPH binding it in every
  // solution, so a conjunct about `?g` stays - and a group is split by its *edges*, so the sub-group over
  // the readings that do not go through `?g` goes down whole even when its representative is `?g`:
  // `?g ≡ ?s ≡ ?t` pushes
  // `?s ≡ ?t` and keeps one edge back to `?g` here, which is what spans the group again.
  const placed = placeOverTargets(assertions, [{
    licensed: name => name !== graphVar,
    admitsWeakened: name => name !== graphVar,
    mayBind: () => true,
    connects: true,
  }]);
  return keep(assertionFilter(
    c,
    AF.createGraph(assertionFilter(c, graph.input, AssertionConjunction.of(placed.intoTarget[0])), graphName),
    AssertionConjunction.of(placed.kept),
  ));
}

/**
 * Pushes the assertions into the operands of a JOIN their licence holds for (FJPush).
 *
 * The licence is per variable: `L(?x, A_i) := ?x in cVars(A_i) or no other operand ever binds ?x`. Under it
 * the value `?x` takes in a merged mapping is the one `A_i` gave it, so a condition over licensed variables
 * evaluates the same on the operand as on the join - and an assertion goes into *every* operand it is
 * licensed for, which is sideways information passing rather than a push. What no operand is licensed for
 * is demoted rather than left behind, `σ_W(A1 join A2) == σ_W(A1) join σ_W(A2)` holding
 * unconditionally; B⟨?x⟩ has no such form and stays on top when unlicensed.
 * @param c - The transformation context
 * @param join - The JOIN the filter sits on
 * @param assertions - The conjunction to place
 * @returns what the traversal should put in its place
 */
function pushIntoJoin(
  c: TransformContext,
  join: Algebra.Join,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const merged = mergeBGPsOfJoin(c, join);
  if (merged !== undefined) {
    // A different operation now, so the conjunction is handed back rather than placed against the one
    // the licences were about to be read off.
    return { ...keepMetadata, newValue: assertionFilter(c, merged, assertions), reTransform: true };
  }

  // Read before any rewriting: every rewrite preserves pVars and never shrinks cVars, so these licences
  // stay valid while the operands are rewritten.
  const operands = join.input.map(operand => cpMetaOf(operand));
  // An operand takes what it certainly binds, or what nothing else can bind; it takes the weakened form
  // of anything else it can bind, which the join consumes; and it *connects* what it takes, join
  // compatibility being what enforces an equality between two accesses it binds on the output.
  const placed = placeOverTargets(assertions, operands.map((operand, index) => ({
    licensed: name => operand.cVars.has(name) ||
      operands.every((other, otherIndex) => otherIndex === index || other.vRanges.neverBinds(name)),
    admitsWeakened: name => operand.vRanges.canBind(name),
    mayBind: name => operand.vRanges.canBind(name),
    connects: true,
  })));

  return keep(assertionFilter(
    c,
    c.AF.createJoin(join.input.map((operand, index) =>
      assertionFilter(c, operand, AssertionConjunction.of(placed.intoTarget[index]))), false),
    AssertionConjunction.of(placed.kept),
  ));
}

/**
 * Merges the BGP operands of a join into one, since an edge needs a single operand binding both of its
 * accesses and so what the operands are is part of the licence.
 * @param c - The transformation context
 * @param join - The join to merge
 * @returns the merged join, or `undefined` when fewer than two operands are BGPs
 */
function mergeBGPsOfJoin(c: TransformContext, join: Algebra.Join): Algebra.Operation | undefined {
  // An index into `notBgps`: how many non-BGP operands the first BGP was preceded by, so the merged BGP
  // goes back where the first of them stood and the operand order the join had is kept.
  let insertionPoint = -1;
  const bgps: Algebra.Bgp[] = [];
  const notBgps: Algebra.Operation[] = [];
  for (const branch of join.input) {
    if (branch.type === 'bgp') {
      bgps.push(branch);
      if (insertionPoint === -1) {
        insertionPoint = notBgps.length;
      }
    } else {
      notBgps.push(branch);
    }
  }
  if (bgps.length < 2) {
    return undefined;
  }
  const merged = c.AF.createBgp(bgps.flatMap(bgp => bgp.patterns));
  if (notBgps.length === 0) {
    return merged;
  }
  return c.AF.createJoin([ ...notBgps.slice(0, insertionPoint), merged, ...notBgps.slice(insertionPoint) ], true);
}

/**
 * Pushes the assertions into a LEFT JOIN (OPTIONAL).
 *
 * The structural win comes first: `?x not in pVars(A1)` makes `σ_{?x=c}(A1 leftjoin A2)` a plain
 * `A1 join σ_{?x=c}(A2)`, since what the assertion rules out is precisely the solutions the anti-join
 * half produces. Only the forms implying `bound(?x)` trigger it, a clique through the B⟨?x⟩ it entails of
 * every member. Otherwise (FLPush) sends the licensed assertions into `A1`, and `?x in cVars(A1) and
 * cVars(A2)` additionally licenses replicating into `A2`. Only the left takes a weakened form: if `A1`
 * leaves `?x` unbound and `A2` binds it elsewhere, pruning `A2` would let the unmatched mapping through the
 * anti-join half instead.
 * @param c - The transformation context
 * @param leftJoin - The LEFT JOIN the filter sits on
 * @param assertions - The conjunction to place
 * @returns what the traversal should put in its place
 */
function pushIntoLeftJoin(
  c: TransformContext,
  leftJoin: Algebra.LeftJoin,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const [ left, right ] = leftJoin.input;
  const leftVars = cpMetaOf(left);

  if ([ ...assertions.boundImpliedBy() ].some(name => leftVars.vRanges.neverBinds(name))) {
    // Our filter asserts that one of variables ONLY appearing on RHS is bound, thus, the LeftJoin becomes Join.
    const joined = AF.createJoin([ left, right ], true);
    const rebuilt = leftJoin.expression === undefined ? joined : AF.createFilter(joined, leftJoin.expression);
    return { ...keepMetadata, newValue: assertionFilter(c, rebuilt, assertions), reTransform: true };
  }

  const rightVars = cpMetaOf(right);
  // (FLPush) on the left, and `?x ∈ cVars(A₁) ∩ cVars(A₂)` on the right - which implies the left's
  // licence, so the replication only ever happens beside a push the LHS already took.
  //
  // Only the left takes a weakened form, and only the left *connects* what it takes: the RHS push is a
  // replication of what the LHS enforces, and the anti-join half enforces nothing between the sides.
  // The right may still *bind* what it was not told, which is what keeps a weak conjunct above the left
  // join where a join consumes it.
  const placed = placeOverTargets(assertions, [
    {
      licensed: name => leftVars.cVars.has(name) || rightVars.vRanges.neverBinds(name),
      admitsWeakened: name => leftVars.vRanges.canBind(name),
      mayBind: name => leftVars.vRanges.canBind(name),
      connects: true,
    },
    {
      licensed: name => leftVars.cVars.has(name) && rightVars.cVars.has(name),
      admitsWeakened: () => false,
      mayBind: name => rightVars.vRanges.canBind(name),
      connects: false,
    },
  ]);
  const [ intoLeft, intoRight ] = placed.intoTarget;
  const kept = placed.kept;

  const leftAssertions = AssertionConjunction.of(intoLeft);
  // Every candidate μ₁ binds the variables strongly asserted in intoLeft to their term once those are
  // pushed into A₁, so substituting them into the left join condition is sound.
  // The condition is only ever evaluated on a merged `μ₁ ∪ μ₂` - the anti-join half keeps a `μ₁` exactly
  // when no compatible `μ₂` satisfies it - so both sides are bound wherever it is asked anything.
  const expression = leftJoin.expression === undefined ?
    undefined :
    substituteInExpression(
      c,
      leftJoin.expression,
      leftAssertions.expressionSubstitution(),
      unionSets([ leftVars.cVars, rightVars.cVars ]),
    );
  // TODO: the substitution in the filter might reveal more information that we could use!
  return keep(assertionFilter(
    c,
    AF.createLeftJoin(
      assertionFilter(c, left, leftAssertions),
      assertionFilter(c, right, AssertionConjunction.of(intoRight)),
      expression,
    ),
    AssertionConjunction.of(kept),
  ));
}

/**
 * One place a conjunction can be pushed into: an operand of a join, a side of a left join, the pattern of a
 * GRAPH. Four questions, which is the whole of what those rules differ in.
 */
interface PushTarget {
  /**
   * (FJPush)'s side condition read per variable - `?x in cVars(A_i) or no other operand ever binds ?x` - or
   * whatever the operation's own version of it is. Under it the value `?x` takes in a solution of the
   * operation is the one this target gave it.
   */
  licensed: (name: string) => boolean;
  /** Whether a conjunct this target is not licensed for may still enter it in the weakened form. */
  admitsWeakened: (name: string) => boolean;
  /**
   * Whether a solution of this target can bind the variable, and so can be what violates a conjunct it was
   * not given. A target that never binds `?x` needs no copy of one about `?x`.
   */
  mayBind: (name: string) => boolean;
  /**
   * Whether what this target takes it also *enforces* on the output, so that it need not be restated above
   * the operation. False for the right hand side of a left join, whose anti-join half keeps a mapping that
   * nothing matched.
   */
  connects: boolean;
}

/**
 * Places a conjunction over the targets of an operation: each takes what it is licensed for, the weakened
 * form of what it is not, and the readings of a group it is licensed for.
 *
 * One routine for the join, the left join and the GRAPH, whose licences - (FJPush), (FLPush) and the join
 * with `{?g -> u_i}` of section 18.5 - are stated where their targets are built. A conjunct is discharged
 * rather than restated above in the two ways the identities give: one implying `bound(?x)` by a target that
 * took it *and* connects it, and a weak or unbound one by every target that may bind `?x` having taken it.
 * @param assertions - The conjunction to place
 * @param targets - The places it can go
 * @returns the conjuncts per target, and what has to be restated above the operation
 */
function placeOverTargets(assertions: AssertionConjunction, targets: PushTarget[]): {
  intoTarget: AssertionConjunct[][];
  kept: AssertionConjunct[];
} {
  const intoTarget: AssertionConjunct[][] = targets.map(() => []);
  const kept: AssertionConjunct[] = [];
  for (const conjunct of assertions.unaryConjuncts()) {
    const [ name ] = variablesReadByConjunct(conjunct);
    const impliesItIsBound = impliesBound(conjunct.assertion);
    const weakened = asWeakenedConjunct(conjunct);
    let enforced = false;
    let toldEveryBinder = true;
    for (const [ index, target ] of targets.entries()) {
      if (impliesItIsBound && target.licensed(name)) {
        intoTarget[index].push(conjunct);
        enforced ||= target.connects;
      } else if (weakened !== undefined && target.admitsWeakened(name)) {
        intoTarget[index].push(weakened);
      } else {
        toldEveryBinder &&= !target.mayBind(name);
      }
    }
    if (!(impliesItIsBound ? enforced : toldEveryBinder)) {
      kept.push(conjunct);
    }
  }
  for (const readings of assertions.equatedReadings()) {
    const placed = splitClique(
      readings,
      targets.map(target => readings.filter(reading => target.licensed(reading.name))),
      targets.map(target => target.connects),
    );
    for (const [ index, pushed ] of placed.intoTarget.entries()) {
      intoTarget[index].push(...pushed);
    }
    kept.push(...placed.kept);
  }
  return { intoTarget, kept };
}

/**
 * Places one {@link AssertionConjunction.equatedReadings | group} over the targets of a join-like
 * operation: each takes the readings it licenses, and the edges connecting what no single target covered
 * stay on top.
 *
 * Splitting *edges* rather than readings is the point. For `w ≡ x ≡ y ≡ z` over a join with `cVars(LHS)`
 * holding `{w,x}` and `cVars(RHS)` holding `{y,z}` no operand is licensed for the whole group, yet each
 * takes half of it and one edge between the halves puts it back together. Two targets that *share* a
 * reading need no such edge, which is what `connects` records: a reading both are licensed for goes through
 * a variable certainly bound in both, so join compatibility already enforces the equality.
 * @param readings - The ways of reading the group, its representative first
 * @param licensedPer - Per target, the readings it is licensed for
 * @param connects - Per target, whether it enforces the equalities its sub-group states on the output
 * @returns the conjuncts per target, and the edges that have to stay above the operation
 */
function splitClique(readings: readonly Access[], licensedPer: Access[][], connects: boolean[]): {
  intoTarget: AssertionConjunct[][];
  kept: AssertionConjunct[];
} {
  const edgesPerBranch = licensedPer.map(licensed => cliqueStar(licensed));
  const intoTarget: AssertionConjunct[][] = licensedPer.map((licensed, index) => edgesPerBranch[index].length > 0 ?
    edgesPerBranch[index].map(([ representative, hub ]) => unification(representative, hub)) :
    // Means licensed.size is 0 or 1
    licensed.map(reading => entailedByReading(reading)));

  // Union-find over the readings, joined by every sub-group that both went somewhere and holds above.
  const spanningTree = new Map(readings.map(reading => [ accessId(reading), accessId(reading) ]));

  function rootOf(reading: Access): string {
    let root = accessId(reading);
    while (spanningTree.get(root) !== root) {
      root = spanningTree.get(root)!;
    }
    return root;
  }

  for (const [ branchIdx, edges ] of edgesPerBranch.entries()) {
    if (connects[branchIdx]) {
      for (const [ reading, representative ] of edges) {
        spanningTree.set(rootOf(reading), rootOf(representative));
      }
    }
  }

  // One edge from every component that is not the representative's back to the representative: together with the
  // sub-groups that were placed, that spans the group again.
  const representative = readings[0];
  const kept: AssertionConjunct[] = [];
  const spanned = new Set([ rootOf(representative) ]);
  for (const reading of readings) {
    const root = rootOf(reading);
    if (!spanned.has(root)) {
      spanned.add(root);
      kept.push(unification(reading, representative));
    }
  }
  return { intoTarget, kept };
}

/**
 * The spanning star of a group: every reading but the first, paired against that first one.
 * @param readings - The readings to span
 * @returns the edges, empty for fewer than two readings, which is exactly when there is nothing to equate
 */
function cliqueStar(readings: Access[]): [ Access, Access ][] {
  const sorted = [ ...readings ].sort(compareAccesses);
  return sorted.slice(1).map(reading => [ reading, sorted[0] ]);
}

/**
 * The conjunct A⟨a ≡ representative⟩: one edge of a group.
 * @param reading - The reading to equate
 * @param representative - The reading it is equated to
 * @returns the edge
 */
function unification(reading: Access, representative: Access): AssertionConjunct {
  return { access: reading, assertion: assertStrong(representative) };
}

/**
 * What a target licensed for a single reading of a group still learns from it: everything that *taking that
 * reading* entails, which is all that is left when the equality it was part of cannot travel (S6).
 * @param reading - The single reading the target is licensed for
 * @returns B⟨?x⟩ for a variable, and for a position that what it is read through is a triple term
 */
function entailedByReading(reading: Access): AssertionConjunct {
  return isBareAccess(reading) ?
      { access: reading, assertion: assertBound() } :
      { access: readThrough(reading), assertion: assertTermType('Quad') };
}

/**
 * The access one position short of this one - what it is read through, which it proves a triple term.
 * @param reading - The reading to shorten
 * @returns the shorter access
 */
function readThrough(reading: Access): Access {
  return { name: reading.name, positions: reading.positions.slice(0, -1) };
}

/**
 * The assertions of Θ that may enter the right hand side of a MINUS: the ones about a single variable
 * that Θ holds *strongly*, weakened.
 *
 * A surviving mapping of the LHS binds `?x` to a value, so an RHS mapping can only remove it by not binding
 * `?x` or binding it to that same value - which is why a shape and a term type travel here as readily as a
 * term does. The argument needs the LHS to *have* `?x` bound, which is exactly what the weak form does not
 * give, hence {@link impliesBound} rather than "says something about a value".
 * @param assertions - The conjunction to filter
 * @returns what may be asserted on the right hand side
 */
function admissibleOnMinusRhs(assertions: AssertionConjunction): AssertionConjunction {
  return AssertionConjunction.of(assertions.unaryConjuncts()
    .filter(({ assertion }) => impliesBound(assertion))
    .map(conjunct => asWeakenedConjunct(conjunct))
    .filter(conjunct => conjunct !== undefined));
}

/**
 * Hands a value to the traversal, keeping the metadata of everything in it intact.
 * @param newValue - What to put in place of the operation
 * @returns the traversal's instruction
 */
function keep(newValue: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue };
}

/**
 * Replaces an operation the assertions rule out by the empty solution multiset, and stops the traversal
 * from descending into what it replaced - nothing under it can contribute anything.
 * @param c - The transformation context
 * @param replaced - The operation being replaced
 * @returns the traversal's instruction
 */
function empty(c: TransformContext, replaced: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue: emptyOperation(c, replaced), continue: false };
}

/**
 * Builds the empty solution multiset that replaces an operation the assertions rule out.
 * @param c - The transformation context
 * @param replaced - The operation being replaced, kept as the input so that the node carries its `pVars`:
 * `pVars(Empty_S) := S`, never the empty set, or `SELECT *` scoping changes silently
 * @returns the `FILTER(FALSE)` that is this codebase's empty operation, which
 * {@link transformFilterFalse} normalises structurally afterwards
 */
function emptyOperation(c: TransformContext, replaced: Algebra.Operation): Algebra.Operation {
  return createFilterFalse(c, replaced);
}

/**
 * Re-binds the variables the assertions substituted away, so that the rewrite preserves `pVars` and `cVars`
 * exactly. This EXTEND is mandatory: dropping it breaks the invariant, and breaks `SELECT *`.
 * @param c - The transformation context
 * @param op - The operation the substitution was written into
 * @param assertions - The substitution that was written in
 * @returns the operation with one EXTEND per substituted variable
 */
function bindAssertedTerms(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: Assertions,
): Algebra.Operation {
  let result = op;
  for (const [ name, term ] of assertions) {
    result = c.AF.createExtend(result, c.DF.variable(name), c.AF.createTermExpression(term));
  }
  return result;
}

/**
 * The assertion filter over `op`, carrying the conjunction it stands for as its metadata so that the
 * traversal does not have to read it back out of the condition it builds.
 * @param c - The transformation context
 * @param op - The operation to filter
 * @param assertions - The conjunction the filter carries
 * @returns the filter, or `op` itself when the conjunction says nothing
 */
function assertionFilter(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: AssertionConjunction,
): Algebra.Operation {
  if (assertions.size === 0) {
    return op;
  }
  const filter = <AssertionFilter> c.AF.createFilter(op, assertions.toExpression(c));
  filter.metadata = { assertions: { assertions, residual: undefined, contradictory: false }};
  return filter;
}
