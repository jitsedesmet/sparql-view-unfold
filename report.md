# Triple terms in `AssertionConjunction` — design study

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
-- becomes
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

Verified against the installed traqula: both the pattern and the `BIND` generate and re-parse exactly,
so no parser/generator work is needed.

> **State of play (2026-08-24).** Phases **0** (`ac6d447`, #31), **1** (`e18a8dd`, #32), **2** (the pin
> lattice) and **3** (accesses and term types) are on `main`; phase **4** (materialisation) is in the
> working tree, and the example at the top of this file is what the pass now produces. The sections
> below say so where they describe something that now exists. Phase 5 (what is left of the operation
> rules) is open — see the per-operation table in `task-for-agent.md` for which of its rows are done.

The algebraic ground under all of this is Schmidt, Meier, Lausen, ["Foundations of SPARQL Query
Optimization"](https://dl.acm.org/doi/pdf/10.1145/1804669.1804675) (ICDT 2010): the pass is (FElimI)/(FElimII) — discharge an equality by substituting
it — carried across the whole algebra rather than only under a projection that drops the variable, with
the (FBnd\*) rules deciding emptiness and the (F\*Push) side conditions supplying the licences. Triple
terms extend the right-hand side of the elimination from a *term* to a *shape*.

## 1. Design (settled)

**Conjuncts are about an *access*, not a variable.** An access is a variable read through a chain of
accessors: `?x`, `subject(?x)`, `object(subject(?x))`. `AssertionConjunct` becomes
`{ access, assertion }`, the RHS of a strong/weak assertion becomes `Access | RDF.Term`, and A/W/B/U
all keep their meaning. `U`/`B` stay restricted to accesses of length 0 (`BOUND` takes a `Var`).

**One new form: `T⟨?x : τ⟩`** — originally `isTRIPLE(?x)`, the degenerate shape, "a triple term, nothing
known about its parts". Implies bound, has a weak form, absorbed by anything stronger. Generalised in
review to all four term-type predicates (`isIRI`/`isURI`, `isBLANK`, `isLITERAL`, `isTRIPLE`), which are
one fact — a narrowing of the group's range — and so one form. It costs one distinction: the *asserted*
part of a range, which has to be written back, against the *derived* part, which holds wherever the group
is written and must not be. That belongs to Θ rather than to the lattice, so it lives in
`AssertionClusterSet`, the subclass Θ is built on.

**Groups get a pin lattice.** `TermClusterSet`'s `groupToTerm` becomes
`{kind:'term', term} | {kind:'triple', subject, predicate, object}`, the three being *group ids*.
`compareTerm` (equal / contradiction) becomes `meetPins` (equal / contradiction / **decompose into child
unifications**), reporting what it decided as a list of `GroupConstraint`. That is syntactic
unification, and it gives the #30 interop for free: the shape sits on the *group*, so unifying `?o`
with `?x` makes everything known about `subject(?o)` known about `subject(?x)`.

**Unconstrained positions are anonymous groups**, not fresh variables. Keeps `size`/`names`/`order`
clean, and lets a shape be serialised without naming what it does not know.

**Serialising Θ never coins a variable.** A shape writes back as `isTRIPLE(?o)` plus one
`sameTerm(position(?o), …)` per informative position — the form it was read from, so the pass stays
idempotent. Writing `sameTerm(?o, <<( ?s ?o_p ?o_o )>>)` instead would be a wrong-answer bug: the
derived variables are unbound wherever the filter sits, so the condition would error and drop
everything.

**Variables are coined only when writing into a pattern**, named `${anchor}_${s|p|o}` against the
whole query's pre-transformation variable list, suffixed only on collision. The anchor is the
*group's* canonical name (term pin → first named member → shortest access path), memoised per group in
one pass-scoped map — so two materialisation sites of the same group agree and both operands of a join
still join on the position. **Done** (`derivedVarNamer`), with one thing this study did not settle: a
shape *no* position of which says anything is left as the condition `isTRIPLE(?o)` rather than written
out, since writing it would coin three variables to state what that condition states with none.

**The weak/strong line is unchanged**, restated: *a conjunct mentioning one variable has a weak form,
one mentioning two does not*. `!bound(?o) || sameTerm(subject(?o), :a)` is fine;
`sameTerm(subject(?o), ?s)` is a clique edge and travels as `T⟨?o⟩` where the edge cannot go.

**Shapes substitute into patterns, never into expressions** — an open shape in an expression would
mention unbound derived variables. `strongSubstitution()` splits into `patternSubstitution(namer)` and
`expressionSubstitution()` (ground pins and clique representatives only). **Done**, the first of the two
as `intoPattern(namer)`, which hands back what the pattern cannot take along with what it can.

**Occurs check.** `?o ≡ <<( ?o … )>>` is unsatisfiable → empty operation. Also the termination
argument for resolving a group to a term.

**Ranges, in two places that meet in `normalisedFor`.** On the group (`groupToRange`, lifted down from
`ClusterSolver` — still to do) and on the operation (`vRanges` — **done**). This is what makes nesting
run only down the `object` chain, and it gives emptiness rules for the *existing* forms too
(`?s ?p ?o FILTER(sameTerm(?s, "lit"))`, which `normalisedFor` now decides).

The operation half carries the scope with it: `vRanges` is a `VRanges extends Map<string, RangeSet>`
whose **key set is `pVars`**, the range per key being the term types the variable takes *when bound*.
`pVars ⊇ keys(vRanges)` is structural rather than hand-kept, and the bottom range is expressible — *in
scope, never binds* — which `neverBinds` reads as one fact together with *out of scope*, and which
`nullifyUnbindableVars` turns into a type-level emptiness proof. It also sharpens (FBndII): the paper
empties on `?x ∉ pVars(A)`, this empties one level finer, on nothing being left for `?x` to take.
Ranges unite over UNION branches and intersect over the JOIN operands that bind **certainly** — an
operand that may leave the variable unbound must not narrow it, or `{ VALUES (?x) { (UNDEF) } } . {
VALUES (?x) { ("l") } }` is called unbindable. `graphRange` admits a BlankNode.

**Scope may grow by derived variables; metadata is cleared on the way out** — the clearing is **done**
(`withoutCpVars(result)` at the end of the pass, not inside `mapOperationPreOrder`, whose
`keepMetadata` is load-bearing during the traversal). Safe to read stale-but-grown metadata mid-pass: a
derived name never enters Θ, so no licence is ever about one.

**`BIND(<<( … )>> AS ?o)` keeps `?o` in `cVars`** via `vRanges` — **done**: the construction cannot
error when every component is bound and `range(c₁) ⊆ {IRI, bnode}`, `range(c₂) ⊆ {IRI}`
(`constructionCannotFail`). Ground triple terms are admitted outright, which also settled the
`isAssertableTerm` TODO.

## 2. Files

| file | change |
|---|---|
| `datastructures/TermClusterSet.ts` | pin lattice, `meetPins`, work-list merge, occurs check, `carriesInformation` must count child references (else a pin dangles) |
| `datastructures/AssertionClusterSet.ts` | the subclass Θ is built on: its meet, and the asserted half of a group's range |
| `utils/assertions.ts` | `Access`; recognisers for `subject/predicate/object` equalities and `istriple`; accessor builders; ~~`isAssertableTerm` admits ground quads~~ **done** |
| `utils/assertionConjunction.ts` | conjuncts over accesses, path walking in `assert`, `toExpression`, the two substitutions, `boundImpliedBy` covers named children |
| `utils/partialExpressionEvaluation.ts` | substitution argument becomes a view (`resolve`, `isTriple`); fold accessors and `istriple` — without this the filter's own residual never folds and the pass is not idempotent |
| `utils/certainlyBoundVars.ts` | ~~`vRanges` + the EXTEND rule~~ **done** (as the `pVars` merge) |
| `transformations/pushDownAssertions.ts` | pattern substitution + namer, `pruneValues`, `transferred` through triple-term/accessor BINDs, ~~metadata strip~~ (strip done) |
| `ClusterSolver.ts` | follow-up: drop the `Quad` exclusion, resolve its TODO at line 191 |

## 3. Phasing

0. ~~`vRanges` in `CPMeta` + metadata clearing~~ — **done, `ac6d447` (#31)**. Landed as the `pVars`
   merge, and grew two consumers of the bottom range: the emptiness rules in `normalisedFor` (a strong
   member out of range empties, a weak one collapses to U⟨?x⟩) and the new `nullifyUnbindableVars`.
1. ~~Ground triple terms — `isAssertableTerm`, ground `sameTerm` folding.~~ — **done, `e18a8dd` (#32)**.
   The `sameTerm` fold needed no change: RDF/JS `Quad.equals` already decides two ground triple terms.
2. ~~Pin lattice — data-structure level, unit-testable alone.~~ **done (working tree)**, together with
   the per-group ranges, which is where the confinement of nesting to the `object` chain actually lives.
3. ~~Accesses + `T⟨?x⟩` — Θ round-trips through a condition; nothing written into patterns yet.~~
   **done (working tree)**. A shape reaching a BGP stays a condition over it (`structural()`), which is
   what phase 4 takes over.
4. ~~Materialisation — namer, `patternSubstitution`, `bindAssertedTerms`. Target example works here.~~
   **done (working tree)**, as `intoPattern`. `bindAssertedTerms` needed no change; what did grow a rule
   of its own is the *residual*, which asks what the materialised pattern enforces rather than which form
   a conjunct has, and which comes back from the same call for that reason.
5. Operation rules — `pruneValues`, EXTEND transfer (`BIND(<<( ?a ?b ?c )>> AS ?o)` and
   `BIND(subject(?o) AS ?x)`, the `TODO(next time)` at `pushDownAssertions.ts:455`), shape-weakening in
   `splitClique`, the GRAPH and MINUS cases.

**Evaluation harness — checked and in use** (the triple-term fixtures are in
`test/statics/assertionPushdown.ttl` as of phase 1) on `n3@2` and `@comunica/query-sparql-file@5.3` (upgraded from 5.1.3
for this). Turtle `<<( :a :b :c )>>` parses to a `Quad` object; triple-term patterns with variables,
`SUBJECT(…)`, `isTRIPLE(…)` and `<<( ?s ?p ?o )>>` in a `BIND` all evaluate; an accessor on a
non-triple or unbound argument errors into `false`, so the row is dropped rather than the query
throwing, including under the weak form `!bound(?o) || sameTerm(SUBJECT(?o), :a)`; and an ill-typed
construction (`<<( ?o ?p ?s )>>` with a literal `?o`) leaves the target unbound as the spec requires —
5.1.3 built a generalised quad instead, which is why the version moved.

## 4. Decisions

**Scope: all of it, in this PR.** `vRanges` included; EXTEND transfer included (a pushdown *through*
the BIND is what lets a shape keep travelling, so leaving it out would cut the feature short); every
operation rule that is in the context of a triple-term assertion is in scope. The phases above are
commit boundaries, not PR boundaries.

**`FILTER(sameTerm(?o, <<( ?a ?b ?c )>>))` is recognised**, and written back in accessor form. The two
are equivalent as filter conjuncts (they differ only in error vs `false`, which a FILTER identifies),
so this is the same kind of non-verbatim round-trip the pass already does for the other forms.

**VALUES pruning** — prune *rows* by asserting the row into a clone of Θ (uniform over terms, cliques
and shapes: a ground triple-term value decomposes against a shape by itself); drop a *column* iff Θ can
rebuild its value from the columns that survive. That last condition is the general form of what the
code does today, and it is where the shape case differs from the strong-term case:

```sparql
VALUES (?o ?s) { (<<( :a :b :c )>> :a) (<<( :d :e :f )>> :d) }   FILTER(sameTerm(subject(?o), ?s))
```

keeps both rows, with *different* `?o` — there is no single term to re-bind, so the column stays. But

```sparql
VALUES (?o ?s ?p ?x) { … }   FILTER(sameTerm(?o, <<( ?s ?p ?x )>>))
```

does drop `?o` and re-bind it from the three surviving columns. Whether that is reached by rewriting
the per-variable `switch` or by extending it is the implementor's call — the rewrite is more uniform,
the existing evaluation tests are the thing to keep green either way.
