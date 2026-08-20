import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformContext } from '../transformContext.js';
import type { AssertionConjunct, AssertionFilter } from '../utils/assertionConjunction.js';
import {
  AssertionConjunction,
  collectAssertions,
  conjunctVars,
  isAssertionFilter,
  weakenedConjunct,
} from '../utils/assertionConjunction.js';
import type { Assertions, StrongAssertion } from '../utils/assertions.js';
import {
  assertBound,
  assertStrong,
  assertWeak,
  impliesBound,
  isAssertableTerm,
  substituteInPattern,
  substituteInTerm,
} from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { withCpVars, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { sameTermExpression } from '../utils/expressionHelpers.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { substituteInExpression } from '../utils/partialExpressionEvaluation.js';
import { DF } from '../utils/rdfDatatypes.js';
import { unionSets } from '../utils/setUtils.js';

/**
 * @fileoverview Assertion filter pushdown.
 *
 * An earlier rewriting stage produces queries carrying *assertion filters* of the form
 * `FILTER(sameTerm(?x, <ex://p>))` - fixing one variable to one term - and `FILTER(sameTerm(?x, ?y))` -
 * unifying two variables. Left where they are, they only discard rows at the end. Pushed down, they
 * eliminate work: they substitute into BGPs (fewer triple matches, and a repeated variable in one pattern
 * instead of two free ones), prune VALUES rows and columns, delete whole UNION branches, and can turn an
 * OPTIONAL into a plain join.
 *
 * Rule names in parentheses refer to Figure 2 of Schmidt et al., "Foundations of SPARQL Query
 * Optimization" (https://dl.acm.org/doi/pdf/10.1145/1804669.1804675). Writing A⟨?x ≡ c⟩ for
 * `σ_{sameTerm(?x, c)}`, two properties drive the design:
 *
 * - **The assertion implies `bnd(?x)`**, so (FBndII) - `?x ∉ pVars(A) ⟹ σ_{?x≡c}(A) ≡ ∅` - is the only
 *   emptiness rule needed, and `bound(?x)` folds to `true` during substitution.
 * - **It is `sameTerm`, not `=`**, which is what makes substituting the term into a pattern sound:
 *   `?x = "01"^^xsd:integer` holds of the term `"1"^^xsd:integer`, so `=` would drop solutions. An `=`
 *   against an IRI is the one exception - `=` only raises a type error when both arguments are literals,
 *   so against an IRI it *is* `sameTerm` - and it travels as an assertion.
 *
 * Assertions travel in the five states of {@link AssertionConjunction} - all in the *same* conjunction and
 * handled by the same swap, since their rules differ per operation rather than per pass, and one
 * variable's assertion may be strong while another's is not. {@link AssertionConjunction.normalisedFor}
 * converts between them at every step.
 *
 * The bound form, `FILTER(bound(?x))`, is the one that fixes no term. It moves for two reasons: it decides
 * the same emptiness and structural rules the strong form does - which is what turns an OPTIONAL binding
 * `?x` into a plain join - and it *completes* a weak assertion it meets on the way into a strong one.
 *
 * ## What a unification adds
 *
 * `sameTerm(?x, ?y)` is not an assertion about a variable: it is an *edge* between two of them, and a
 * chain of such edges makes a **clique** of variables that all have to be equal. Three things follow, and
 * they are the whole difference between this pass and the per-variable one it grew out of.
 *
 * **A clique is substituted to its representative** - the lexicographically first member - rather than to
 * a term: `?s ?p ?o FILTER(sameTerm(?s, ?o))` becomes `?o ?p ?o . BIND(?o AS ?s)`. That BIND is mandatory,
 * not cosmetic: substituting takes `?s` out of the pattern, and every rewrite here has to preserve `pVars`
 * exactly. Picking the *lexicographically first* member rather than, say, the one the enclosing PROJECT
 * keeps is what makes the pass idempotent - re-running it re-derives the same representative and absorbs
 * what it finds instead of stacking a second copy.
 *
 * **Splitting a clique means splitting its edges, never its variables.** A clique is transitively closed,
 * so any spanning tree of it is equivalent to the whole; what a rule pushes down plus what it keeps on top
 * has to span it again ({@link splitClique}). Splitting *variables* is what loses information: `?x ≡ ?y`
 * under `GROUP BY ?x` decomposes into two singletons and evaporates, where the right answer is that the
 * plan is empty, `?y` being out of scope above the GROUP.
 *
 * **Weak ⇔ pinned group.** Every member of an anchorless clique is strong, and a rule that cannot take the
 * whole edge drops it rather than demoting it, because there is no sound weak form of a clique - see
 * {@link AssertionConjunction}. What travels in its place is what the edge *entails*: every member of a
 * clique is bound, so B⟨?x⟩ goes down on the licence that already exists for it even where the edge itself
 * stays on top. That is what collapses `A₁ ⟕ A₂ FILTER(sameTerm(?y, ?z))` into a join.
 *
 * ## The traversal
 *
 * The pass is a pre-order traversal, so an assertion filter is handled *before* what is below it, and
 * each step only describes how the filter swaps places with the operation it sits on. The result of that
 * swap is traversed in turn, so a filter that sank into a union branch is met again there and keeps
 * sinking on its own. What travels is the whole conjunction that still holds - an {@link AssertionFilter}
 * - so a plan with several assertions is rewritten in one traversal, substituting into each BGP once. A
 * filter the conjunction passes is *absorbed* into it rather than swapped with, which is what keeps
 * re-running the pass from stacking a second copy of what it derived.
 *
 * Every rewrite here preserves `pVars` exactly, never shrinks `cVars`, and preserves the multiplicity of
 * every surviving mapping. That invariant is what lets the licences be read off the metadata of the
 * operations below without recomputing anything as they are rewritten.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/**
 * Pushes every assertion filter (`FILTER(sameTerm(?x, c))`, `FILTER(sameTerm(?x, ?y))`) in `op` as deep as
 * possible, and into every branch that permits it - for a join, that may be both sides at once.
 *
 * @example
 * // Before:
 * // SELECT * WHERE { { ?x :p ?y } UNION { ?z :q ?w } FILTER(sameTerm(?x, <ex://a>)) }
 * // After (the right branch can never bind ?x, so it becomes empty):
 * // SELECT * WHERE {
 * //   { <ex://a> <ex://p> ?y BIND(<ex://a> AS ?x) } UNION { ?z <ex://q> ?w FILTER(false) }
 * // }
 *
 * @example
 * // Before:
 * // SELECT * WHERE { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }
 * // After:
 * // SELECT * WHERE { ?o ?p ?o . BIND(?o AS ?s) }
 */
export function pushDownAssertions<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const callbacks: Parameters<typeof algebraUtils.mapOperationPreOrder<'unsafe', T>>[1] = Object.fromEntries(
    Object.values(Algebra.Types).map(type => [ type, (copy: Algebra.Operation) => keep(copy) ]),
  );
  callbacks[Algebra.Types.FILTER] = (filter: Algebra.Filter) => pushFilter(c, filter);
  // Starting from a copy without metadata gives us both a tree of our own to rewrite and the guarantee
  // that what `withCpVars` hands us describes the plan as it is now.
  //
  // And clearing it again on the way out, for the same reason: what the traversal cached describes the
  // plan at the moment it passed, which the rewrites below it have since changed. This may *not* be done
  // inside `mapOperationPreOrder` - `keepMetadata` is how an assertion filter hands its conjunction to the
  // `pushFilter` that meets it next, and how a `reTransform` keeps the work it has already done.
  return withoutCpVars(algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(op), callbacks));
}

/**
 * Handles one filter met by the traversal. One carrying assertions is split first (SDecompI): the
 * assertions travel on their own, and what is left of the condition stays on top with the strong ones
 * substituted into it (FReord).
 */
function pushFilter(c: TransformContext, filter: Algebra.Filter): PreOrderMappingReturn {
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
  return pushAssertions(c, assertions, filter.input);
}

/** Swaps an assertion filter carrying Θ with the operation `op` right below it, per Figure 2. */
function pushAssertions(
  c: TransformContext,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const normalised = assertions.normalisedFor(cpVars(op));
  if (normalised === undefined) {
    return empty(c, op);
  }
  if (normalised.size === 0) {
    return keep(op);
  }
  return swapWith(c, normalised, op);
}

/**
 * The rule per operation, for a conjunction {@link AssertionConjunction.normalisedFor} has already read in
 * terms of that operation.
 *
 * Wherever the weak form is licensed, an assertion that cannot travel strongly is *demoted* rather than
 * left behind - that is the difference between reaching a BGP and stopping at the join above it. Only
 * where no form may pass does it stay on top. The unbound and bound forms have nothing below them to
 * demote to, and neither has a clique edge, so they either pass as themselves or stay.
 */
function swapWith(
  c: TransformContext,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const { AF } = c;
  switch (op.type) {
    // A BGP and a path bind all of their variables, so normalisation has made every assertion that reaches
    // them strong - and a clique reaching one is substituted to its representative, which turns two free
    // variables of a pattern into the same one.
    case Algebra.Types.BGP: {
      return keep(substituteIntoPatterns(c, op, assertions.strongSubstitution()));
    }
    case Algebra.Types.PATH: {
      return keep(substituteIntoPath(c, op, assertions.strongSubstitution()));
    }
    // The one leaf where all of the forms do real work, since a VALUES column may be UNDEF.
    case Algebra.Types.VALUES: {
      return keep(pruneValues(c, op, assertions));
    }

    // (FUPush) holds unconditionally for every form - a solution of a union comes from exactly one
    // branch - so every branch gets the conjunction and keeps sinking on its own.
    case Algebra.Types.UNION: {
      return keep(AF.createUnion(op.input.map(branch => assertionFilter(c, branch, assertions)), false));
    }
    case Algebra.Types.FILTER: {
      // The conjunction we manage absorbs the assertions of the filter we pass (SDecompI),
      const collected = collectAssertions(c, op.expression, assertions, cpVars(op.input).cVars);
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
        // The RHS takes the *weak* form of what we know strongly about a term, and nothing else at all.
        // Since we know from the LHS that `sameTerm(?x, c)`, the RHS can only remove mappings of the LHS
        // if either ?x is not bound there, or it is bound to c - any other RHS mapping is incompatible and
        // so removes nothing anyway. That argument needs the LHS to *have* ?x bound, which is exactly what
        // the weak and unbound forms do not give us: under those, an RHS mapping binding ?x to another
        // term can still remove an LHS mapping that leaves it free. A clique has no weak form to send in
        // the first place, and the term is what the argument turns on: an anchor both sides agree on.
        assertionFilter(c, right, weakenedTerms(assertions)),
      ));
    }
    case Algebra.Types.GROUP: {
      // An assertion on a grouping key selects whole groups, which is the same as selecting the
      // solutions those groups are formed from - including, for the weak and unbound forms, the group
      // the solutions leaving the key unbound form, which is exactly the group the strong and bound
      // forms rule out. Anything else has to stay above: filtering before
      // the aggregation would change the aggregate. A key takes its `pVars` from the input, so an
      // unbound assertion pushed below still takes the variable out of scope, as it did on top.
      // An edge with one endpoint outside the keys is one of those: kept on top, where normalisation
      // correctly empties the plan, the other endpoint being out of scope above the GROUP.
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
    // Congruence: these do not touch which variables a solution binds.
    // For the projection, dom(Θ) ⊆ variables holds, since pVars of a projection is what it projects.
    case Algebra.Types.PROJECT: {
      // Can push since we know we are projected. (by pvars checks)
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
 * Substitutes the assertions into a BGP, re-binding the substituted variables.
 *
 * All variables of a BGP are certainly bound, so the only thing left to check is whether the terms can
 * occupy the positions they land in. BGPs are duplicate-free and substituting only restricts which
 * solutions exist - renaming a variable to the representative of its clique included - so multiplicities
 * are preserved.
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
  return bindAssertedTerms(c, c.AF.createBgp(substituted), assertions);
}

/**
 * Substitutes the assertions into a property path, re-binding the substituted variables.
 *
 * Unlike a BGP, a path may legitimately have a literal in its subject slot (`?lit ^:p ?s`), so only the
 * graph position is checked. Paths are not duplicate-free, but substituting only restricts the set of
 * start nodes and leaves the witness count of every surviving pair untouched.
 */
function substituteIntoPath(c: TransformContext, path: Algebra.Path, assertions: Assertions): Algebra.Operation {
  const subject = substituteInTerm(path.subject, assertions, 'object');
  const object = substituteInTerm(path.object, assertions, 'object');
  const graph = substituteInTerm(path.graph, assertions, 'graph');
  if (subject === undefined || object === undefined || graph === undefined) {
    return emptyOperation(c, path);
  }
  return bindAssertedTerms(c, c.AF.createPath(subject, path.predicate, object, graph), assertions);
}

/**
 * Prunes the rows of a VALUES that contradict the assertions, and drops the columns they decide.
 *
 * A unification decides a column against *another column of the same row*: under A⟨?x ≡ ?y⟩ the rows where
 * the two differ are dropped, the representative's column is kept, and the other one is re-bound from it.
 * Every member of a clique that gets here is a variable of the VALUES, since normalisation would otherwise
 * have emptied the plan by (FBndII).
 *
 * Row-level filtering keeps duplicate rows duplicated, so multiplicities are preserved.
 */
function pruneValues(c: TransformContext, values: Algebra.Values, assertions: AssertionConjunction): Algebra.Operation {
  const substitution = assertions.strongSubstitution();
  // The forms that require the row to provide a value at all - a row leaving one of them UNDEF, which it
  // expresses by not carrying the column, is pruned.
  const requiredBound = [ ...assertions.boundImpliedBy() ];
  const newBindings: Algebra.Values['bindings'] = [];
  for (const binding of values.bindings) {
    if (requiredBound.every(name => binding[name] !== undefined)) {
      const newRow: typeof newBindings[0] = {};
      let isPruned = false;
      for (const [ variable, value ] of Object.entries(binding)) {
        const assertion = assertions.get(variable);
        if (assertion === undefined) {
          // We do not assert on this var
          newRow[variable] = value;
        } else if (assertion.subType === 'unbound') {
          // The row binds a column that has to be unbound.
          if (value !== undefined) {
            isPruned = true;
            break;
          }
        } else if (assertion.subType === 'bound') {
          // Any value satisfies B⟨?x⟩, and since the row keeps deciding which one, the column stays.
          newRow[variable] = value;
        } else {
          // A⟨?x ≡ c⟩ or W⟨?x ≡ c⟩ against the term, and A⟨?x ≡ ?rep⟩ against whatever this row put in `?rep`.
          // The row does carry `?rep`: a clique implies B⟨?rep⟩, so `requiredBound` above already dropped
          // the rows leaving it UNDEF.
          const requiredValue = assertion.term.termType === 'Variable' ? binding[assertion.term.value] : assertion.term;
          if (value === undefined || requiredValue.equals(value)) {
            if (assertion.subType === 'weak') {
              // Weak and term val is undefined or correct
              newRow[variable] = value;
            }
            // The strong form decides the column outright, so it is dropped here and re-bound below (using BIND).
          } else {
            // The row binds a column to a term not allowed.
            isPruned = true;
            break;
          }
        }
      }
      if (!isPruned) {
        newBindings.push(newRow);
      }
    }
  }
  // Zero rows means empty sequence which we write as the empty operation.
  if (newBindings.length === 0) {
    return emptyOperation(c, values);
  }
  // Zero columns is allowed: `VALUES () { () () () }` - it contributes one empty solution mapping per
  // row. With exactly one row that is the same as the empty BGP.
  const remainingVars = values.variables.filter((variable) => {
    const decided = assertions.get(variable.value)?.subType;
    return decided !== 'strong' && decided !== 'unbound';
  });
  const pruned = remainingVars.length === 0 && newBindings.length === 1 ?
    c.AF.createBgp([]) :
    c.AF.createValues(remainingVars, newBindings);
  return bindAssertedTerms(c, pruned, substitution);
}

/**
 * Pushes the assertions through an EXTEND (BIND).
 *
 * Asserting the variable the BIND targets is the interesting case:
 * `σ_{?x≡c}(Extend(A,?x,e)) ≡ Extend(σ_{sameTerm(e,c)}(A), ?x, c)`. Both sides keep exactly the solutions
 * of `A` for which `e` evaluates to `c` - an error in `e` makes `sameTerm(e,c)` error, which a filter
 * treats as false, matching the dropped unbound case.
 *
 * Whenever `e` is a *term*, that is not shortcut to constant folding, because whatever `?x` had to be
 * equal to, the thing the BIND copies into it has to be equal to below. Everything the conjunction says
 * about `?x` {@link AssertionConjunction.transferred | transfers} onto that term there, and the four
 * combinations of what it was equal to with what now carries it are one rule:
 *
 * - `BIND(?z AS ?t)` under A⟨?t ≡ c⟩ leaves A⟨?z ≡ c⟩ below, so a *renaming* propagates an assertion;
 * - `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩ leaves A⟨?z ≡ ?y⟩ below, so it propagates a unification too, and
 *   either may then reach a BGP;
 * - `BIND(:c AS ?t)` under A⟨?t ≡ d⟩ is the ground comparison `c ≡ d`, decided here;
 * - `BIND(:c AS ?t)` under A⟨?t ≡ ?y⟩ leaves A⟨?y ≡ :c⟩ below - a constant BIND is what pins a clique the
 *   assertions had found no term for, so every variable it unified reaches its pattern as `:c`.
 *
 * Transferring rather than deleting matters: `?x` has to leave Θ before descending (an EXTEND target is
 * not bound below itself), and simply dropping it would drop the edges of a clique it happened to be the
 * representative of.
 *
 * Only the forms that imply `bnd(?x)` do any of that. W⟨?x ≡ c⟩ on the BIND target is also satisfied by
 * the solutions where `e` errored and left `?x` unbound, so it says nothing about `e` and stays above the
 * EXTEND, as do B⟨?x⟩ and U⟨?x⟩ - which are about the EXTEND's own binding rather than about `e`.
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
  const { cVars } = cpVars(extend.input);
  // SPARQL spec keeps BINDing an in-scope variable explicitly undefined. We assume it errors,
  // so in `bind(e AS ?x)` ?x is not bound below the EXTEND. It has to leave Θ before descending,
  // or the (FBndII) check at the top of the swap wrongly yields empty.
  const { inside: notAboutTarget, outside: aboutTarget } = assertions.split(name => name !== target);

  // A BIND of a term - a variable it copies, or a constant it fixes the target to - carries below the
  // EXTEND whatever the target carries above it, so Θ transfers onto it.
  // TODO(next time): here is where restrictions on triple terms could be transferred.
  let replacementTerm: RDF.Term | undefined;
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    if (expression.term.termType === 'Variable') {
      // BIND(?x as ?x) we see only valid if ?x not in pvars of input, so, `?x` remains unbound -> NOP
      if (expression.term.value !== target) {
        replacementTerm = expression.term;
      }
    } else if (isAssertableTerm(expression.term)) {
      replacementTerm = expression.term;
    }
  }

  // If we know the expression, and we have something to say about the target, and we NEED the target to be bounded:
  //   BIND(:c as ?x) -- :c is a assertableTerm or var; ?x is asserted that it should be bound
  if (replacementTerm !== undefined && assertionOfTarget !== undefined && impliesBound(assertionOfTarget)) {
    const below = assertions.transferred(target, replacementTerm);
    if (below === undefined) {
      // The two terms the target had to be at once, or two cliques pinned to different ones.
      return empty(c, extend);
    }
    // `?z ≡ c` holds below, so binding `?x` straight to `c` is the same as binding it to `?z`; and where
    // the transfer was a clique membership, `?z` is written as the representative it substitutes to.
    return keep(AF.createExtend(
      assertionFilter(c, extend.input, below),
      extend.variable,
      substituteInExpression(c, expression, below.strongSubstitution(), cVars),
    ));
  }

  if (assertionOfTarget?.subType === 'strong' && isAssertableTerm(assertionOfTarget.term)) {
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
          substituteInExpression(c, expression, notAboutTarget.strongSubstitution(), cVars),
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
      substituteInExpression(c, expression, notAboutTarget.strongSubstitution(), cVars),
    ),
    aboutTarget,
  ));
}

/**
 * Pushes the assertions through a GRAPH, which is transparent rather than a barrier.
 *
 * SPARQL evaluates it as a union over the named graphs, each joined with the binding of the graph
 * variable (§18.5): `Graph(?g,P) ≡ ⋃_{(uᵢ,Gᵢ) ∈ named} ( ⟦P⟧_{Gᵢ} ⋈ {?g↦uᵢ} )`, and every rule below is
 * read off that.
 *
 * An assertion on a variable other than `?g` distributes over the union by (FUPush) and then into the
 * left argument of each join by (FJPush), licensed by the *second* disjunct since
 * `?x ∉ pVars({?g↦uᵢ}) = {?g}`. That leaves no precondition, and holds for all of the forms alike - so a
 * conjunction saying nothing about `?g`, which is the common case, travels into `P` whole and leaves the
 * GRAPH itself alone.
 *
 * An assertion on `?g` itself selects the single named graph `c` - every other `uᵢ` only contributes
 * solutions binding `?g` to `uᵢ ≠ c` - leaving `⟦P⟧_c ⋈ {?g↦c}`. Only a *term* can do that: a clique over
 * `?g` says only that it equals some other variable, which names no graph statically, so the edges
 * *touching* `?g` stay above - the sub-clique over the rest of its members travels like anything else.
 * Both halves of the selection need care:
 *
 * - `?g` may occur *inside* `P`, where it was the join that dropped the solutions binding it to another
 *   term. So `P` gets the assertion too, in the **weak** form: it need not bind `?g`, and where it binds
 *   it certainly, normalisation promotes it back on arrival.
 * - `{?g↦c}` has to be put back, since `Graph(c,P)` over an IRI binds nothing and `?g` would otherwise
 *   leave `pVars`/`cVars`. Which construct expresses that join depends on what `P` binds, and getting it
 *   wrong is an error rather than a wrong answer: `Extend` raises on an already bound variable, so it may
 *   only be used where `P` cannot bind `?g` at all.
 *
 * A `c` outside `?g`'s range - a Literal, say - matched nothing, and normalisation has already emptied
 * the plan for it before anything reaches here.
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

  if (assertedGraphName?.subType === 'strong' && isAssertableTerm(assertedGraphName.term) &&
    // A term outside `?g`'s range has already emptied the plan in `normalisedFor`, so what can still be
    // asserted here is a graph name: a NamedNode, or the BlankNode a dataset may equally name a graph by.
    // Only the first can be written back - `createGraph` names a graph by a Variable or a NamedNode - so
    // the second falls through to the general path below rather than being treated as an emptiness.
    assertedGraphName.term.termType === 'NamedNode') {
    // Read before the rewrite, which preserves the scope exactly and never shrinks `cVars`.
    const { cVars, vRanges } = cpVars(graph.input);
    // `?g` travels on into the pattern, in the *weak* form: `P` need not bind it at all, and the join
    // with `{?g ↦ c}` is what would have dropped the solutions binding it to anything else.
    const graphIndependentAssertions = assertions.split(name => name !== graphVar).inside;
    graphIndependentAssertions.assertTerm(graphVar, assertedGraphName.term, false);
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
  const inside: AssertionConjunct[] = [];
  const kept: AssertionConjunct[] = [];
  for (const conjunct of singleVariableConjuncts(assertions)) {
    if (conjunct.name === graphVar) {
      kept.push(conjunct);
    } else {
      inside.push(conjunct);
    }
  }
  // A clique is split by its *edges*: the sub-clique over the members that are not `?g` goes into `P`
  // whole, even when the clique's representative is `?g` and no edge of its star could travel as it
  // stands. `?g ≡ ?s ≡ ?t` pushes `?s ≡ ?t` down and keeps a single edge back to `?g` here, which is
  // what spans the clique again. The pattern *connects* what it takes: a condition not mentioning `?g`
  // moves through `⋃ᵢ (⟦P⟧_uᵢ ⋈ {?g ↦ uᵢ})` untouched, so it still holds of every solution up here.
  for (const clique of assertions.cliques()) {
    const placed = splitClique(clique, [ clique.filter(name => name !== graphVar) ], [ true ]);
    inside.push(...placed.intoTarget[0]);
    kept.push(...placed.kept);
  }
  return keep(assertionFilter(
    c,
    AF.createGraph(assertionFilter(c, graph.input, AssertionConjunction.of(inside)), graphName),
    AssertionConjunction.of(kept),
  ));
}

/**
 * Pushes the assertions into the operands of a JOIN their licence holds for (FJPush).
 *
 * The licence is per *variable*: `L(?x, Aᵢ) ≔ ?x ∈ cVars(Aᵢ) ∨ ∀ j ≠ i . Aⱼ never binds ?x`. Under it the
 * value `?x` takes in a merged mapping is the one `Aᵢ` gave it, so a condition over variables that all
 * satisfy it evaluates the same on the operand as on the join. The second disjunct is easy to forget but
 * does real work.
 *
 * An assertion goes into *every* operand it is licensed for - the join already enforces that all operands
 * agree on the variable, so an assertion certain on one side is free on the others and shrinks both
 * inputs. That is sideways information passing rather than a push.
 *
 * What no operand is licensed for is **demoted** rather than left behind: `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)`
 * holds unconditionally, since a merged mapping binds `?x` exactly when one of its halves does. So the
 * weak form enters every operand regardless, and only a strong assertion no operand is licensed for stays
 * on top. That is what gets an assertion below a join over two optional-bound variables, where it can
 * still collapse back to the strong form deeper down. The unbound form rides along on the same identity.
 *
 * B⟨?x⟩ takes the same licence as the strong form and for the same reason - under it, `?x` is bound in
 * the merged mapping exactly when it is bound in the one operand that can bind it - but it has no weaker
 * form to fall back on. The very identity that carries W and U through is what it fails: a merged mapping
 * binds `?x` when *either* half does, so an operand leaving it unbound may still be part of a solution
 * that binds it. Unlicensed, it stays on top.
 *
 * A clique is placed by {@link splitClique} instead, on the same licence read over both endpoints of an
 * edge at once. Since an edge needs a single operand binding *both* of its endpoints, what the operands
 * are is part of the licence: the BGPs among them are merged into one first ({@link mergeBGPsOfJoin}).
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
  const operands = join.input.map(operand => cpVars(operand));
  function licensed(index: number, name: string): boolean {
    return operands[index].cVars.has(name) || operands.every((other, otherIndex) =>
      otherIndex === index || other.vRanges.neverBinds(name));
  }

  const operandAssertions: AssertionConjunct[][] = join.input.map(() => []);
  const kept: AssertionConjunct[] = [];
  // For every assertion about a single variable, find out where it can go.
  for (const conjunct of singleVariableConjuncts(assertions)) {
    const { name, assertion } = conjunct;
    let placedStrongly = false;
    const assertionImpliesBound = impliesBound(assertion);
    for (const [ index ] of join.input.entries()) {
      if (assertionImpliesBound && licensed(index, name)) {
        operandAssertions[index].push(conjunct);
        placedStrongly = true;
      } else if (operands[index].vRanges.canBind(name)) {
        const demoted = weakenedConjunct(conjunct);
        // Bound assertion knows no weak form and cannot be pushed
        if (demoted !== undefined) {
          operandAssertions[index].push(demoted);
        }
      }
    }
    // The weak and unbound forms are always consumed by the join; the two that imply `bound(?x)` only
    // when some operand took them in.
    if (assertionImpliesBound && !placedStrongly) {
      kept.push(conjunct);
    }
  }
  // Every operand pushing a sub-clique of its own also *connects* the sub-clique: the equality between two variables
  // it binds certainly is what join compatibility already enforces on the output.
  for (const clique of assertions.cliques()) {
    const placed = splitClique(
      clique,
      join.input.map((_, index) => clique.filter(name => licensed(index, name))),
      join.input.map(() => true),
    );
    for (const [ index, pushed ] of placed.intoTarget.entries()) {
      operandAssertions[index].push(...pushed);
    }
    kept.push(...placed.kept);
  }

  return keep(assertionFilter(
    c,
    c.AF.createJoin(join.input.map((operand, index) =>
      assertionFilter(c, operand, AssertionConjunction.of(operandAssertions[index]))), false),
    AssertionConjunction.of(kept),
  ));
}

/**
 * @return undefined in case nothing can be merged.
 */
function mergeBGPsOfJoin(c: TransformContext, join: Algebra.Join): Algebra.Operation | undefined {
  let indexOfFirst = -1;
  const bgps: Algebra.Bgp[] = [];
  const notBgps: Algebra.Operation[] = [];
  for (const [ index, branch ] of join.input.entries()) {
    if (branch.type === 'bgp') {
      bgps.push(branch);
      if (indexOfFirst === -1) {
        indexOfFirst = index;
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
  return c.AF.createJoin([ ...notBgps.slice(0, indexOfFirst), merged, ...notBgps.slice(indexOfFirst) ]);
}

/**
 * Pushes the assertions into a LEFT JOIN (OPTIONAL).
 *
 * The structural win comes first: `?x ∉ pVars(A₁) ⟹ σ_{?x≡c}(A₁ ⟕ A₂) ≡ A₁ ⋈ σ_{?x≡c}(A₂)`.
 * Only the forms implying `bound(?x)` trigger it - what they rule out is precisely the solutions
 * leaving `?x` unbound, which with `?x ∉ pVars(A₁)` is every solution the anti-join half of the left join
 * produces. The weak and unbound forms are satisfied by exactly those, so they keep the OPTIONAL. A clique
 * triggers it through the B⟨?x⟩ it entails of every one of its members, which is why a unification over a
 * right-only variable collapses the OPTIONAL even when the edge itself has to stay above it.
 *
 * Otherwise (FLPush) sends the licensed assertions into `A₁`, and `?x ∈ cVars(A₁) ∩ cVars(A₂)`
 * additionally licenses replicating into `A₂`: any `μ₂` compatible with a surviving `μ₁` binds `?x`
 * (certain) to `c`, so the pruned rows of `A₂` never removed anything.
 *
 * The LHS always takes at least the weak form: `σ_W(A₁ ⟕ A₂) ≡ σ_W(σ_W(A₁) ⟕ A₂)`, because a `μ₁`
 * violating W produces output violating W in both halves. The RHS does not - if `A₁` leaves `?x` unbound
 * and `A₂` binds it to another term, the merged solution is the one W discards, and pruning `A₂` would
 * instead let the unmatched `μ₁` through the anti-join half.
 *
 * B⟨?x⟩ has no weak form to fall back on either, so an unlicensed one simply stays on top: `A₂` may be
 * what binds `?x`, so a `μ₁` leaving it unbound cannot be dropped from `A₁`. Neither has a clique edge.
 */
function pushIntoLeftJoin(
  c: TransformContext,
  leftJoin: Algebra.LeftJoin,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const [ left, right ] = leftJoin.input;
  const leftVars = cpVars(left);

  if ([ ...assertions.boundImpliedBy() ].some(name => leftVars.vRanges.neverBinds(name))) {
    // Our filter asserts that one of variables ONLY appearing on RHS is bound, thus, the LeftJoin becomes Join.
    const joined = AF.createJoin([ left, right ], true);
    const rebuilt = leftJoin.expression === undefined ? joined : AF.createFilter(joined, leftJoin.expression);
    return { ...keepMetadata, newValue: assertionFilter(c, rebuilt, assertions), reTransform: true };
  }

  const rightVars = cpVars(right);
  function licensedLeft(name: string): boolean {
    return leftVars.cVars.has(name) || rightVars.vRanges.neverBinds(name);
  }
  function licensedRight(name: string): boolean {
    return leftVars.cVars.has(name) && rightVars.cVars.has(name);
  }
  const intoLeft: AssertionConjunct[] = [];
  const intoRight: AssertionConjunct[] = [];
  const kept: AssertionConjunct[] = [];
  for (const conjunct of singleVariableConjuncts(assertions)) {
    const { name, assertion } = conjunct;
    if (impliesBound(assertion) && licensedLeft(name)) {
      intoLeft.push(conjunct);
      if (licensedRight(name)) {
        intoRight.push(conjunct);
      }
    } else {
      // Not licensed as itself, but the weaker forms always are on the left - except B⟨?x⟩, which has none.
      // It stays here as well, since the right hand side can still introduce a binding that violates it.
      const demoted = leftVars.vRanges.canBind(name) ? weakenedConjunct(conjunct) : undefined;
      if (demoted !== undefined) {
        intoLeft.push(demoted);
      }
      kept.push(conjunct);
    }
  }
  // Only what goes into the LHS *connects* the clique back up: the RHS push is a replication of what the
  // LHS already enforces, and the anti-join half of a left join enforces nothing between the two sides.
  for (const clique of assertions.cliques()) {
    const placed = splitClique(
      clique,
      [ clique.filter(licensedLeft), clique.filter(licensedRight) ],
      [ true, false ],
    );
    intoLeft.push(...placed.intoTarget[0]);
    intoRight.push(...placed.intoTarget[1]);
    kept.push(...placed.kept);
  }

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
      leftAssertions.strongSubstitution(),
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
 * Places one clique over the targets of a join-like operation: each target takes the sub-clique of the
 * members it licenses, and the edges connecting what no single target covered stay on top.
 *
 * Splitting *edges* rather than variables is the whole point (see the file overview). For `w ≡ x ≡ y ≡ z`
 * over a join with `cVars(LHS) ⊇ {w,x}` and `cVars(RHS) ⊇ {y,z}` no single operand is licensed for the whole
 * clique, yet each takes half of it, and one edge between the halves is enough to put it back together:
 * `σ_{x≡y}( σ_{w≡x}(L) ⋈ σ_{y≡z}(R) )`.
 *
 * Two targets whose sub-cliques *share* a member need no such edge, and that is what `connects` records:
 * a member both operands are licensed for is certainly bound in both (the alternative licence -
 * `?x ∉ pVars` of every other operand - excludes it from all but one), so join compatibility already
 * enforces the equality that would connect them. It does not for a left join's right hand side, where the
 * anti-join half enforces nothing between the sides, so that target does not connect.
 *
 * A target licensed for a single member gets no edge, but still B⟨?x⟩ - strictly weaker than any edge, and
 * so always sound.
 *
 * @param members - The members of the clique, as variable names.
 * @param licensedPer - Per target, the members it is licensed for.
 * @param connects - Per target, whether it enforces the equalities its sub-clique states on the output
 *   of the operation, so that they need not be restated above it.
 */
function splitClique(members: string[], licensedPer: string[][], connects: boolean[]): {
  intoTarget: AssertionConjunct[][];
  kept: AssertionConjunct[];
} {
  const edgesPerBranch = licensedPer.map(licensed => cliqueStar(licensed));
  const intoTarget: AssertionConjunct[][] = licensedPer.map((licensed, index) => edgesPerBranch[index].length > 0 ?
    edgesPerBranch[index].map(([ member, hub ]) => unification(member, hub)) :
    // Means licensed.size is 0 or 1
    licensed.map(name => ({ name, assertion: assertBound() })));

  // Union-find over the members, joined by every sub-clique that both went somewhere and holds above.
  const spanningTree = new Map(members.map(name => [ name, name ]));

  function rootOf(name: string): string {
    let root = name;
    while (spanningTree.get(root) !== root) {
      root = spanningTree.get(root)!;
    }
    return root;
  }

  for (const [ branchIdx, edges ] of edgesPerBranch.entries()) {
    if (connects[branchIdx]) {
      for (const [ member, representative ] of edges) {
        spanningTree.set(rootOf(member), rootOf(representative));
      }
    }
  }

  // One edge from every component that is not the representative's back to the representative: together
  // with the sub-cliques that were placed, that spans the clique again.
  const cliqueRep = members[0];
  const kept: AssertionConjunct[] = [];
  const spanned = new Set([ rootOf(cliqueRep) ]);
  for (const member of members) {
    const root = rootOf(member);
    if (!spanned.has(root)) {
      spanned.add(root);
      kept.push(unification(member, cliqueRep));
    }
  }
  return { intoTarget, kept };
}

/**
 * The spanning star of a clique: every member but the first, paired against that first one. Empty for a
 * clique of fewer than two members, which is exactly when there is nothing left to equate.
 */
function cliqueStar(members: string[]): [ string, string ][] {
  const sorted = [ ...members ].sort((left, right) => left.localeCompare(right));
  return sorted.slice(1).map(member => [ member, sorted[0] ]);
}

/** The conjunct A⟨?x ≡ ?representative⟩: one edge of a clique. */
function unification(name: string, representative: string): AssertionConjunct {
  return { name, assertion: assertStrong(DF.variable(representative)) };
}

/** The conjuncts of Θ that are about a single variable, which is everything but the edges of a clique. */
function singleVariableConjuncts(assertions: AssertionConjunction): AssertionConjunct[] {
  return assertions.conjuncts().filter(conjunct => conjunctVars(conjunct).length === 1);
}

/**
 * The assertions of Θ that fix a variable to a *term*, weakened - the only ones that may enter the right
 * hand side of a MINUS.
 */
function weakenedTerms(assertions: AssertionConjunction): AssertionConjunction {
  return AssertionConjunction.of(assertions.conjuncts()
    .filter(({ assertion }) => assertion.subType === 'strong' && isAssertableTerm(assertion.term))
    .map(({ name, assertion }) => <AssertionConjunct> {
      name,
      assertion: assertWeak((<StrongAssertion> assertion).term),
    }));
}

/** The certainly and possibly bound variables of an operation, computed once and cached on it. */
function cpVars(op: Algebra.Operation): CPMeta {
  return withCpVars(op).metadata;
}

/** Hands a value to the traversal, keeping the metadata of everything in it intact. */
function keep(newValue: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue };
}

/**
 * Replaces an operation the assertions rule out by the empty solution multiset, and stops the
 * traversal from descending into what it replaced - nothing under it can contribute anything.
 */
function empty(c: TransformContext, replaced: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue: emptyOperation(c, replaced), continue: false };
}

/**
 * Builds the empty solution multiset that replaces an operation the assertions rule out.
 *
 * `FILTER(FALSE)` is this codebase's empty operation ({@link createFilterFalse}). Keeping the replaced
 * operation as its input is what makes the node carry its `pVars`, as the invariant requires:
 * `pVars(Empty_S) := S`, never `∅`, or `SELECT *` scoping changes silently.
 * {@link transformFilterFalse} does the structural normalisation afterwards (`Empty ∪ A ≡ A`, ...).
 */
function emptyOperation(c: TransformContext, replaced: Algebra.Operation): Algebra.Operation {
  return createFilterFalse(c, replaced);
}

/**
 * Re-binds the variables the assertions substituted away, so that the rewrite preserves `pVars` and
 * `cVars` exactly. This EXTEND is mandatory: dropping it breaks the invariant, and breaks `SELECT *`.
 *
 * For a clique that is `BIND(?rep AS ?x)`, which `withCpVars` reads back as `?x ∈ cVars` from
 * `?rep ∈ cVars`, so the rewrite does not shrink `cVars` either.
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
