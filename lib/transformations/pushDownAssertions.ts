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
  impliesBound,
  targetIsAccess,
  isAssertableTerm,
  isBareAccess,
  substituteInPattern,
  substituteInTerm,
  variablesOfTransferSource,
  asWeakenedConjunct,
} from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { withCpVars, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { booleanConstantOf, sameTermExpression } from '../utils/expressionHelpers.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { substituteInExpression } from '../utils/partialExpressionEvaluation.js';
import { unionSets } from '../utils/setUtils.js';
import type { DerivedVarNamer } from '../utils.js';
import { collectVariableNames, derivedVarNamer } from '../utils.js';

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
 * **Weak ⇔ pinned group.** Every member of an unpinned clique is strong, and a rule that cannot take the
 * whole edge drops it rather than demoting it, because there is no sound weak form of a clique - see
 * {@link AssertionConjunction}. What travels in its place is what the edge *entails*: every member of a
 * clique is bound, so B⟨?x⟩ goes down on the licence that already exists for it even where the edge itself
 * stays on top. That is what collapses `A₁ ⟕ A₂ FILTER(sameTerm(?y, ?z))` into a join.
 *
 * ## What a triple term adds
 *
 * `sameTerm(SUBJECT(?o), ?s)` is not about `?o` either: it is about *one position* of it. So a conjunct
 * is about an {@link Access} - a variable read through a chain of accessors - and what a group carries is
 * a **shape**, three groups of its own, rather than only a term. T⟨?x⟩ (`isTRIPLE(?x)`) is the degenerate
 * one, and like the strong form it implies `bnd(?x)`, so it triggers (FBndII) and the OPTIONAL → JOIN
 * collapse (FLBndII) exactly as a term does.
 *
 * Three consequences run through the rules below.
 *
 * **A shape is not a term, but it is a pattern.** Where a term substitutes, a shape is *materialised*:
 * written out as a triple term whose positions hold what Θ has for them and a variable coined for what it
 * has nothing for ({@link AssertionConjunction.intoPattern}), with a `BIND` putting the value
 * back into the variable the pattern took it out of. Only a pattern may take one - the coined variables
 * are bound by the very pattern that writes them, where a condition reading them would error away every
 * row (S3) - so what no pattern states stays a condition over it
 * ({@link AssertionConjunction.intoPattern}).
 *
 * **A shape is a range statement.** A group carrying one holds a `Quad`, and no subject, predicate or
 * graph position does - so `isTRIPLE(?s)` over `?s ?p ?o` empties the plan off the ranges, the same rule
 * that empties `sameTerm(?g, "1")` under a `GRAPH ?g`, and the reason nesting runs down the `object`
 * chain and no further.
 *
 * **An edge may read through an accessor**, and then a clique is a clique of *readings* of one value: a
 * group read both as `?s` and as `SUBJECT(?o)` states that equality exactly as two variables in one group
 * do, so it splits over the targets the same way ({@link splitClique}), on the licence of the one variable
 * each reading goes through. A target licensed for a single reading gets what reading it entails instead -
 * B⟨?x⟩ for a variable, and `isTRIPLE(?o)` for a position of one (S6).
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
 * Pushes every assertion filter (`FILTER(sameTerm(?x, c))`, `FILTER(sameTerm(?x, ?y))`) in `rootOp` as
 * deep as possible, and into every branch that permits it - for a join, that may be both sides at once.
 *
 * **Takes the root of a query, not a subtree of one.** Materialising a shape coins variables for the
 * positions nothing names, and the only thing keeping a coined name off a variable of the query is that
 * every variable of the query was collected before the pass ran. Handed a subtree, the pass cannot see
 * what its ancestors use, and a coined name colliding with one of those would not be a fresh variable at
 * all: whatever the ancestor joins, minuses or optionally binds on that name would start constraining a
 * position of a triple term. Nothing else in the pass cares - the licences are read per operation - so
 * this is the one precondition it has.
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
  // Starting from a copy without metadata gives us both a tree of our own to rewrite and the guarantee
  // that what `withCpVars` hands us describes the plan as it is now.
  //
  // And clearing it again on the way out, for the same reason: what the traversal cached describes the
  // plan at the moment it passed, which the rewrites below it have since changed. This may *not* be done
  // inside `mapOperationPreOrder` - `keepMetadata` is how an assertion filter hands its conjunction to the
  // `pushFilter` that meets it next, and how a `reTransform` keeps the work it has already done.
  return withoutCpVars(algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(rootOp), callbacks));
}

/**
 * Handles one filter met by the traversal. One carrying assertions is split first (SDecompI): the
 * assertions travel on their own, and what is left of the condition stays on top with the strong ones
 * substituted into it (FReord).
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

/** Swaps an assertion filter carrying Θ with the operation `op` right below it, per Figure 2. */
function pushAssertions(
  c: TransformContext,
  namer: DerivedVarNamer,
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
  return swapWith(c, namer, normalised, op);
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
  namer: DerivedVarNamer,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const { AF } = c;
  switch (op.type) {
    // A BGP and a path bind all of their variables, so normalisation has made every assertion that reaches
    // them strong - and a clique reaching one is substituted to its representative, which turns two free
    // variables of a pattern into the same one.
    // A *shape* is written out as the triple term it is, its positions filled in with what Θ has for
    // them and with a variable coined for the rest, so that the pattern states what the condition did:
    // `?s ?p ?o FILTER(sameTerm(SUBJECT(?o), ?s))` becomes `?s ?p <<( ?s ?o_p ?o_o )>>`, and the
    // re-binding below it hands `?o` back the value the pattern took away.
    //
    // Every leaf is handed the *same* conjunction; what differs is what each can pay off with the rewrite
    // it makes, and so what has to be restated over it ({@link AssertionConjunction.intoPattern}). A
    // BGP pays by substituting into its patterns, so it settles what a pattern can state - a term, an
    // equality, a shape - and no more: `isIRI(?x)` is not something a triple pattern says, and stays. A
    // VALUES pays by pruning rows, and a row *is* a solution mapping rather than a pattern to match, so
    // it settles everything Θ says at once and leaves nothing over ({@link pruneValues}).
    case Algebra.Types.BGP: {
      return keep(rewritePattern(c, assertions, namer, substitution => substituteIntoPatterns(c, op, substitution)));
    }
    case Algebra.Types.PATH: {
      return keep(rewritePattern(c, assertions, namer, substitution => substituteIntoPath(c, op, substitution)));
    }
    // The one leaf where all of the forms do real work, since a VALUES column may be UNDEF.
    case Algebra.Types.VALUES: {
      // Every conjunct a row can decide is one about the columns of this VALUES, which after
      // normalisation is every conjunct there is: a variable the VALUES does not declare can never be
      // bound here, so (FBndII) has already emptied the plan or pruned the conjunct. The split is what
      // makes that a fact of this rewrite rather than an invariant read off another one - what mentions
      // anything else stays above, where it holds of the same solutions it held of before.
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
        // the first place, and the term is what the argument turns on: a value both sides agree on.
        assertionFilter(c, right, admissibleOnMinusRhs(assertions)),
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
 * Substitutes the assertions into a BGP. What the substitution takes out of it - the re-binding, and the
 * condition for what a pattern cannot state - is put back by {@link completePatternRewrite}.
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
  return c.AF.createBgp(substituted);
}

/**
 * Substitutes the assertions into a property path, {@link completePatternRewrite} putting back what that takes out.
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
  return c.AF.createPath(subject, path.predicate, object, graph);
}

/**
 * Rewrites a pattern under Θ: the substitution written into it, the re-binding of every variable that
 * took out of it, and a condition for what a pattern cannot state.
 *
 * The three come from the one call ({@link AssertionConjunction.intoPattern}) because they are one
 * decision; `substituteInto` is the only thing a BGP and a property path differ in, each checking the
 * positions its own kind of pattern can hold.
 *
 * The condition is written **against the values the pattern holds** rather than against the accesses Θ
 * reads them by: `isIRI(OBJECT(?o))` over `?s ?p <<( :a ?o_p ?o_o )>>` is `isIRI(?o_o)`, which asks the
 * same of the same value while reading a variable the pattern binds rather than an accessor over one
 * only the re-binding above it does. Cheaper for an engine - a plain variable it can push into the scan
 * - and it is what keeps the pass a fixpoint over its own output, since a condition reading through the
 * re-bound variable is one the next run would push through the re-binding and write this way anyway.
 *
 * **Here and nowhere higher**, which is the whole of why this is a substitution over a condition rather
 * than a rewrite the pass could do wherever it writes one. `?o_s` is bound by the pattern being built
 * here and by nothing else, and whether any pattern writes it is decided *at the leaf*, after the
 * conjunction has been normalised against it: a shape no position of which says anything is left as
 * `isTRIPLE(?o)` and coins nothing, a VALUES discharges the same conjunction by pruning rows, and a
 * barrier or a weak position never writes one at all. A rewrite made on the way *down* - where
 * {@link swapWith} passes the conditions it keeps above an operation - would be naming a variable that
 * the branch below may never bind, and a sibling branch almost certainly will not.
 *
 * **Always on the pattern, below the re-binding**, which needs an argument rather than a check: a name
 * the substitution re-binds cannot reach the condition at all. Every strong member's access resolves to
 * the value written for it, `bound(?x)` of one folds to `true` off the same conjunction, and the forms
 * that are never written - weak and unbound - are never re-bound either. So the condition reads what the
 * pattern itself binds, and belongs where that is: as deep as it goes, with the re-binding left as the
 * last thing the plan does.
 *
 * The filter carries no conjunction of its own, deliberately: what it says is about the values the
 * pattern wrote, where Θ is about the accesses, and the two are no longer the same statement. What reads
 * it next is this pass, on its way past - the condition is read back into a conjunction of its own, and
 * the coined name enters that one the way every name enters one, from a condition read against the very
 * operation it is about (D6, and {@link AssertionConjunction.intoPattern} on why it is written rather
 * than injected).
 */
function rewritePattern(
  c: TransformContext,
  assertions: AssertionConjunction,
  namer: DerivedVarNamer,
  substituteInto: (substitution: Assertions) => Algebra.Operation,
): Algebra.Operation {
  const { substitution, residual, asWritten } = assertions.intoPattern(namer);
  const pattern = substituteInto(substitution);
  // Read against what the pattern now binds, which is what decides `sameTerm(?x, ?x)` for it. The
  // re-binding only ever adds to that, so this holds wherever the condition ends up.
  const condition = residual.size === 0 ?
    undefined :
    substituteInExpression(c, residual.toExpression(c), asWritten, cpVars(pattern).cVars);
  // A conjunct the values decide - `bound(?x)` of a variable the pattern writes, say - leaves nothing to
  // ask. `false` is not the mirror of this and keeps its filter: that is the empty operation, which
  // {@link transformFilterFalse} normalises away afterwards.
  const settled = condition === undefined || booleanConstantOf(condition) === true;
  return bindAssertedTerms(c, settled ? pattern : c.AF.createFilter(pattern, condition), substitution);
}

/**
 * Prunes the rows of a VALUES that Θ rules out, and drops the columns what stays can rebuild.
 *
 * **A row is a solution mapping**, spelled out: it names the term each of its columns holds, and says of
 * the columns it does not carry that they are unbound. So asserting a row into a copy of Θ decides every
 * form at once - the term a strong member is pinned to, the column another one has to agree with, which
 * kind of term it is, the positions a ground triple term decomposes a shape against, and being there at
 * all - and a row Θ survives is a row that satisfies it. Nothing is left for the conjunction to say above
 * the VALUES, which is what sets this apart from the pattern rules: a pattern states what it can match,
 * where a row *is* the answer.
 *
 * A column then goes exactly where what stays rebuilds its value
 * ({@link AssertionConjunction.rebuildingSubstitution}): the term a strong member is pinned to, the
 * representative its clique substitutes to, or the triple term its shape is written out of the columns
 * holding the positions - the case a single column cannot decide, since the rows may hold a different
 * value in each. The `BIND` below puts the variable back, so `pVars` is preserved. U⟨?x⟩ is the one form
 * that takes a column out for good: a column no surviving row binds would otherwise leave `?x` in scope,
 * which is exactly what `!bound(?x)` took it out of.
 *
 * Row-level filtering keeps duplicate rows duplicated, so multiplicities are preserved.
 */
function pruneValues(c: TransformContext, values: Algebra.Values, assertions: AssertionConjunction): Algebra.Operation {
  const substitution = assertions.rebuildingSubstitution();
  // A column stays unless something else carries what it held: the re-binding rebuilds it, or U⟨?x⟩
  // says there is nothing left to hold.
  const isRebuilt = (name: string): boolean =>
    substitution.has(name) || assertions.get(name)?.subType === 'unbound';
  const newBindings: Algebra.Values['bindings'] = [];
  for (const binding of values.bindings) {
    if (rowSatisfies(assertions, values.variables, binding)) {
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

/**
 * Whether the solution mapping one row of a VALUES stands for satisfies Θ.
 *
 * Asserted into a copy of Θ rather than read against it per variable, which is what makes the rule
 * uniform over the forms: what the row says about a column - this term, or no term at all - is exactly
 * what Θ takes, so a conjunction that survives the whole row is one the row satisfies, and one that
 * contradicts it somewhere is a row to drop. The copy is thrown away either way: a conjunction an
 * assertion returned `false` for holds no state a caller may read.
 *
 * Every column is asserted, the ones Θ says nothing about included, since a column Θ reaches only
 * through the shape of another one is decided by the row that holds it rather than by anything said
 * about it directly.
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
 * `σ_{?x≡c}(Extend(A,?x,e)) ≡ Extend(σ_{sameTerm(e,c)}(A), ?x, c)`. Both sides keep exactly the solutions
 * of `A` for which `e` evaluates to `c` - an error in `e` makes `sameTerm(e,c)` error, which a filter
 * treats as false, matching the dropped unbound case.
 *
 * Whenever `e` is something Θ can *name* - a variable it copies, a constant it fixes the target to, an
 * accessor reading a position, or the triple term it builds out of those ({@link asTransferSource}) -
 * that is not shortcut to constant folding, because whatever `?x` had to be equal to, the thing the BIND
 * puts into it has to be equal to below. Everything the conjunction says about `?x`
 * {@link AssertionConjunction.transferred | transfers} onto it there, and every combination of what it
 * was equal to with what now carries it is one rule:
 *
 * - `BIND(?z AS ?t)` under A⟨?t ≡ c⟩ leaves A⟨?z ≡ c⟩ below, so a *renaming* propagates an assertion;
 * - `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩ leaves A⟨?z ≡ ?y⟩ below, so it propagates a unification too, and
 *   either may then reach a BGP;
 * - `BIND(:c AS ?t)` under A⟨?t ≡ d⟩ is the ground comparison `c ≡ d`, decided here;
 * - `BIND(:c AS ?t)` under A⟨?t ≡ ?y⟩ leaves A⟨?y ≡ :c⟩ below - a constant BIND is what pins a clique the
 *   assertions had found no term for, so every variable it unified reaches its pattern as `:c`;
 * - `BIND(SUBJECT(?o) AS ?t)` under anything about `?t` leaves it on the *access* below, which is what
 *   gives a shape to `?o` and lets it travel on into a pattern;
 * - `BIND(<<( ?a ?b ?c )>> AS ?t)` under a *shape* on `?t` is that shape taken apart: what it said about
 *   a position is restated about the variable holding it, so `sameTerm(SUBJECT(?t), :a)` above the BIND
 *   reaches the pattern binding `?a` as `sameTerm(?a, :a)`.
 *
 * Transferring rather than deleting matters: `?x` has to leave Θ before descending (an EXTEND target is
 * not bound below itself), and simply dropping it would drop the edges of a clique it happened to be the
 * representative of.
 *
 * Only the forms that imply `bnd(?x)` do any of that. W⟨?x ≡ c⟩ on the BIND target is also satisfied by
 * the solutions where `e` errored and left `?x` unbound, so it says nothing about `e` and stays above the
 * EXTEND, as does U⟨?x⟩ - which is about the EXTEND's own binding rather than about `e`. B⟨?x⟩ is about
 * `e` after all: it says the expression yielded a value, which the transfer restates as reading the
 * source yielding one.
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

  if (assertedGraphName?.subType === 'strong' && !targetIsAccess(assertedGraphName.term) &&
    isAssertableTerm(assertedGraphName.term) &&
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
 * All of which is what {@link placeOverTargets} does with an operand that answers its four questions this
 * way; an *edge* is split over the same targets by {@link splitClique}. Since an edge needs a single
 * operand binding both of its accesses, what the operands are is part of the licence: the BGPs among them
 * are merged into one first ({@link mergeBGPsOfJoin}).
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
 *
 * The one thing the right hand side settles by *not* being told: where it can never bind `?x` at all, a
 * weak conjunct about `?x` cannot be violated by anything it contributes, so the left hand side taking it
 * is enough and nothing is restated above ({@link placeOverTargets}).
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
 * One place a conjunction can be pushed into: an operand of a join, a side of a left join, the pattern
 * of a GRAPH. Four questions, which is the whole of what those rules differ in.
 */
interface PushTarget {
  /**
   * (FJPush)'s side condition, read per variable: `?x ∈ cVars(Aᵢ) ∨ ∀ j ≠ i . Aⱼ never binds ?x`, or
   * whatever the operation's own version of it is. Under it the value `?x` takes in a solution of the
   * operation is the one this target gave it, so a condition over licensed variables evaluates the same
   * here as it does above.
   */
  licensed: (name: string) => boolean;
  /** Whether a conjunct this target is not licensed for may still enter it in the weakened form. */
  admitsWeakened: (name: string) => boolean;
  /**
   * Whether a solution of this target can bind the variable, and so can be what violates a conjunct it
   * was not given. A target that never binds `?x` needs no copy of one about `?x`: it cannot break it.
   */
  mayBind: (name: string) => boolean;
  /**
   * Whether what this target takes it also *enforces* on the output of the operation, so that it need
   * not be restated above it. False for the right hand side of a left join, whose anti-join half keeps
   * a `μ₁` that no `μ₂` matched and so enforces nothing the right hand side was told.
   */
  connects: boolean;
}

/**
 * Places a conjunction over the targets of an operation: each takes what it is licensed for, the
 * weakened form of what it is not, and the readings of a group it is licensed for - and what no target
 * both took and enforces is restated above the operation.
 *
 * One routine for the join, the left join and the GRAPH, because what those rules differ in is entirely
 * the four questions a {@link PushTarget} answers. Their licences are (FJPush), (FLPush) and the join
 * with `{?g ↦ uᵢ}` of §18.5 respectively, and each is stated where its targets are built.
 *
 * A conjunct is discharged - not restated above - in the two ways the identities give:
 *
 * - one implying `bnd(?x)` by a target that took it **and** connects it: the value it constrains is the
 *   one that target gave the output, so the operation already enforces what the conjunct says;
 * - a weak or unbound one by every target that may bind `?x` having taken it, which is
 *   `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)` read over the targets a solution can come from. That is why the
 *   weak form travels through a join for free and stays above a left join: the right hand side may bind
 *   `?x` and may not be told.
 *
 * B⟨?x⟩ has no weak form at all - weakening it is `¬b ∨ b` - so it is placed where it is licensed and
 * kept where it is not, which falls out of {@link asWeakenedConjunct} handing back nothing for it.
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
 * Places one {@link AssertionConjunction.equatedReadings | group} over the targets of a join-like operation:
 * each target takes the readings it licenses, and the edges connecting what no single target covered
 * stay on top.
 *
 * Splitting *edges* rather than readings is the whole point (see the file overview). For `w ≡ x ≡ y ≡ z`
 * over a join with `cVars(LHS) ⊇ {w,x}` and `cVars(RHS) ⊇ {y,z}` no single operand is licensed for the whole
 * group, yet each takes half of it, and one edge between the halves is enough to put it back together:
 * `σ_{x≡y}( σ_{w≡x}(L) ⋈ σ_{y≡z}(R) )`. A reading through an accessor splits with the rest of them, on
 * the licence of the one variable it goes through: `SUBJECT(?o) ≡ ?s ≡ ?t` gives the operand binding `?s`
 * and `?t` their edge and keeps one back to `SUBJECT(?o)`.
 *
 * Two targets that *share* a reading need no such edge, and that is what `connects` records: a reading
 * both operands are licensed for goes through a variable certainly bound in both (the alternative licence
 * - `?x ∉ pVars` of every other operand - excludes it from all but one), so join compatibility already
 * enforces the equality that would connect them. It does not for a left join's right hand side,
 * where the anti-join half enforces nothing between the sides, so that target does not connect.
 *
 * A target licensed for a single reading gets no edge, but still what reading it entails (S6) - strictly
 * weaker than any edge, and so always sound.
 *
 * @param readings - The ways of reading the group, its representative first.
 * @param licensedPer - Per target, the readings it is licensed for.
 * @param connects - Per target, whether it enforces the equalities its sub-group states on the output
 *   of the operation, so that they need not be restated above it.
 */
function splitClique(readings: Access[], licensedPer: Access[][], connects: boolean[]): {
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
 * The spanning star of a group: every reading but the first, paired against that first one. Empty for a
 * group of fewer than two readings, which is exactly when there is nothing left to equate.
 *
 * The first is the *most direct* reading of the group rather than the lexicographically first, which is
 * the order {@link AssertionConjunction.equatedReadings} hands them over in and the one the conjuncts of Θ
 * are written against - so what a rule pushes down is what the pass would derive from it again.
 */
function cliqueStar(readings: Access[]): [ Access, Access ][] {
  const sorted = [ ...readings ].sort(compareAccesses);
  return sorted.slice(1).map(reading => [ reading, sorted[0] ]);
}

/** The conjunct A⟨a ≡ representative⟩: one edge of a group. */
function unification(reading: Access, representative: Access): AssertionConjunct {
  return { access: reading, assertion: assertStrong(representative) };
}

/**
 * What a target licensed for a single reading of a group still learns from it: everything that *taking
 * that reading* entails, which is all that is left when the equality it was part of cannot travel (S6).
 *
 * For a variable that is B⟨?x⟩ - a group says of each of its members that it is bound, and nothing else
 * about one of them alone. For a position it is that what the position is read *through* is a triple
 * term, which is the same fact one level up: `BOUND` takes a variable by the grammar, and a position of
 * a triple term is bound exactly when the triple term holding it is. So a target that binds `?o` and
 * cannot take `SUBJECT(?o) ≡ ?s` still gets `isTRIPLE(?o)` out of it, where before it got nothing.
 */
function entailedByReading(reading: Access): AssertionConjunct {
  return isBareAccess(reading) ?
      { access: reading, assertion: assertBound() } :
      { access: readThrough(reading), assertion: assertTermType('Quad') };
}

/** The access one position short of this one - what it is read through, which it proves a triple term. */
function readThrough(reading: Access): Access {
  return { name: reading.name, positions: reading.positions.slice(0, -1) };
}

/**
 * The assertions of Θ that may enter the right hand side of a MINUS: the ones about a single variable
 * that Θ holds *strongly*, weakened.
 *
 * A surviving `μ₁` is one the whole conjunction holds of, so it binds `?x` to a value. An RHS `μ₂` can
 * only remove it by being compatible with it, which is either not binding `?x` at all or binding it to
 * that same value - and a unary predicate on a value holds of it however it is reached, equal values
 * having equal types and equal subjects. That is the whole argument, and it is why a shape and a term
 * type travel here as readily as a term does.
 *
 * **It needs `μ₁` to bind `?x`, which is exactly what the weak form does not give.** Under W⟨?x ≡ c⟩ a
 * surviving `μ₁` may leave `?x` unbound, and an RHS `μ₂` binding it to anything at all is then still
 * compatible with it - so filtering that `μ₂` out of the RHS keeps a `μ₁` the MINUS removes, which is a
 * wrong answer rather than a missed rewrite. Hence {@link impliesBound} rather than "says something about
 * a value": it is the one property the argument rests on. B⟨?x⟩ has it too and drops out for want of a
 * weak form, and an edge between two variables is not about one value in the first place.
 */
function admissibleOnMinusRhs(assertions: AssertionConjunction): AssertionConjunction {
  return AssertionConjunction.of(assertions.unaryConjuncts()
    .filter(({ assertion }) => impliesBound(assertion))
    .map(conjunct => asWeakenedConjunct(conjunct))
    .filter(conjunct => conjunct !== undefined));
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
 *
 * For a materialised shape it is `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`, and `cVars` survives that too, by
 * the one thing that makes a triple-term construction certain: it cannot raise an evaluation error
 * (`constructionCannotFail`). Each component is bound - the pattern this wraps is what binds them - and
 * each is a term its position admits, because the pattern *is* the narrowing: a variable written into
 * the subject slot of a triple term has the range of that slot in the operation below, whatever range it
 * had before the shape was written there.
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
