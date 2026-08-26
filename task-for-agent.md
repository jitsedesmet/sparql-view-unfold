# Implementation task: triple term assertions in the pushdown

## Goal

`pushDownAssertions` currently moves assertions about a variable's *value* (`sameTerm(?x, c)`,
`sameTerm(?x, ?y)`, `bound`, `!bound`). Extend it to assertions about a triple term's *structure*, so
that

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
```

is rewritten to

```sparql
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

and interoperates with the existing term assertions and variable cliques: asserting a structure on one
member of a clique must assert it on all of them.

`report.md` is the design study this comes from — read it first, it is short. This file is the
implementation contract: everything below is decided, not up for re-litigation, except where it says
"your call".

## Where this stands (branch `feat/phase-5-operation-rules`, 2026-08-25)

**Every step is in the codebase.** D1 to D6 below describe what is *there*, not what to build; read
them as the foundation the rest stands on, and **the code as the authority** — review renamed a good deal
of it, and where this file and a symbol disagree, the symbol wins.

| step | where | in the tree |
|---|---|---|
| 0 | `ac6d447` (#31), main | `vRanges` on `CPMeta`, holding scope and term types in one structure; the emptiness rules it decides in `normalisedFor`; `nullifyUnbindableVars`; the metadata clearing of D6. |
| 1 | `e18a8dd` (#32), main | ground triple terms: `isAssertableTerm` admits them, and `withCpVars` calls `BIND(<<( :a :b :c )>> AS ?t)` certainly bound (`constructionCannotFail`). |
| 2 | `c15adc9` (#34), main | the pin lattice of D3, plus the per-group ranges of D5.3 — `Pin`, `TriplePin`, `meetPins`, `GroupConstraint`, the work-list merge, the occurs check, anonymous groups, `groupToRange` lifted down from `ClusterSolver`. |
| 3 | `c15adc9` (#34), main | accesses and T⟨?x : τ⟩ (D1, D2), the recognisers, `toExpression`, the folds of S7. Θ round-trips through a condition; nothing is written into patterns yet. |
| 3+ | `c15adc9` (#34), main | **beyond the plan**: all four term-type predicates rather than `isTRIPLE` alone (D2), and `AssertionClusterSet`, which is where the asserted half of a group's range lives. |
| 4 | `6a3f2fa` (#35), main | materialisation (D4): `derivedVarNamer`, `intoPattern` (the substitution and what it leaves behind), and the namer threaded through the pass. The target example works. |
| 5 | branch `feat/phase-5-operation-rules` | the operation rules: the VALUES row rule, `equatedReadings` + S6 in `splitClique`, and the EXTEND transfer - which forced 6 (see below). |

**Everything in the plan is built.** What is left is the optional 7
(`ClusterSolver`). The per-operation table below says what each row came to.

Step 2 is not separable from step 3 in the build: `AssertionConjunction` is the only caller of
`TermClusterSet`'s comparator, so the lattice and the conjunction that meets pins on it land together.

### What phase 4 decided that this file left open

`structuralPartOfConjunction` is gone. The plan's two methods landed as **one**, `intoPattern(namer)`,
handing back the substitution and the residual together: the residual is defined against the values that
substitution writes, so deciding them apart is deciding one thing twice. It asks **what the materialised
pattern enforces** rather than which *form* a conjunct has: an equality holds where both
sides are written — the same term or the same variable twice, which in a BGP is the join compatibility a
repeated variable already states — T⟨a : Quad⟩ holds where `a` is written as a triple term, and nothing
else a pattern can state. That is what keeps the residual in step with the substitution as more of Θ
becomes writable.

The one judgement call: **a shape no position of which says anything is not written**
(`shapeIsWorthWriting`). Writing it coins three variables to state that the value is a triple term,
which is what `isTRIPLE(?o)` states while coining none — and `isTRIPLE(?o)` and
`sameTerm(SUBJECT(?o), SUBJECT(?o))` are the one fact reached two ways (D2), so they have to be the one
plan. Below a shape that *is* written, every nested one is written with it, the three variables costing
nothing beyond the position they already sit in. That is why materialising replaces *most* of the
remainder rather than all of it.

`cVars` survives the re-binding by the one thing that makes a triple-term construction certain
(`constructionCannotFail`): the components are bound by the pattern the `BIND` wraps, and each is a term
its position admits **because the pattern is the narrowing** — a variable written into the subject slot
of a triple term has the range of that slot in the operation below, whatever range it had before. So
`?s ?p ?o . ?y :q ?x FILTER(sameTerm(SUBJECT(?o), ?x))` keeps `?o` certain although `?x` was an object
everywhere before the rewrite.

### Two mistakes this phase made, so that the next does not

Both were caught late and neither was a missing rule — the rule was right and the code around it drifted.

* **A recogniser that fails is invisible.** What the pass writes back for an assertion it cannot move
  *is* the condition it read, so a broken recogniser produces the same plan as a correct one with nowhere
  to push. `asAccess` inverted a length test and stopped recognising accessors entirely; only two tests
  noticed, the ones where the assertion travelled. Test recognition directly — `collectAssertions` with
  `residual === undefined` — not only through the plan.
* **A weak assertion may not enter the RHS of a MINUS**, and the subType test that used to enforce that
  stopped doing so when the forms grew a strength *field* beside the strength *subType*. Read
  `impliesBound`, which is the property the argument rests on, never a list of subTypes. Wrong answers,
  found by an evaluation test rather than a structural one.

### What phase 5 found, so that the next reader does not re-derive it

**6 is not optional: 5 forces it.** Transferring an assertion through `BIND(<<( ?a ?b ?c )>> AS ?o)` is
the last row of the EXTEND rule, and the pass *writes* such a BIND itself at every materialisation. So
the pass met its own output: the residual it left above the re-binding read the re-bound variable
(`isIRI(OBJECT(?o))`), and the next run pushed that through the re-binding and wrote it differently
(`isIRI(?o_o)`) - the "applying the transformation twice" test, failing on a rewrite that was sound both
times. There is no way to have the transfer and stay a fixpoint without writing the residual against the
values the pattern holds, so 6 landed with 5, by the mechanism 6 prescribed: a substitution over the
condition after `toExpression` (`intoPattern`'s third return, `asWritten`) rather than a name injected
into Θ. Not that a coined name may never *reach* Θ: it does, one step later, when the pass reads its own
condition back against the pattern that binds it - which is the rule D6 is really about, and which two
things of its own make load-bearing here. A residual folds (`bound(?o_p)` is `true` over the pattern
that writes `?o_p`, and Θ has no state for a conjunct that is no longer one), and a coined name put into
a group would have Θ state the equality the pattern already states.

It settled one thing 6 left open: **where the rewritten condition goes**. Reading only the pattern's own
variables, it sits directly on the pattern, *below* the re-binding - which is where the next run would
push it anyway, and what makes the two runs agree. A condition still reading a re-bound variable (a weak
member, which is never written into a pattern and so never resolved to a value) stays above it. The
filter carries no `AssertionConjunctionMeta`, deliberately: what it says is about the values the pattern
wrote, where Θ is about the accesses, and the two are no longer the same statement.

**A row of a VALUES is a solution mapping, not a pattern**, which is why its rule discharges Θ whole
where a BGP leaves a residual. Asserting the row into a clone decides every form at once, so the
per-variable `switch` went away rather than growing a case.

**An reading is licensed by the one variable it reads through**, which is what made `splitClique`
generalise cleanly: `variablesReadByConjunct` over an edge is the two roots, and a reading has exactly
one, so the per-target licence is unchanged in form. `placeAccessConjunct` and the split between
`cliques` / `accessConjuncts` / `singleVariableConjuncts` all collapsed into `equatedReadings` +
`unaryConjuncts`.

## Grounding

Schmidt, Meier, Lausen, ["Foundations of SPARQL Query
Optimization"](https://dl.acm.org/doi/pdf/10.1145/1804669.1804675) (ICDT 2010) is the algebraic ground
this pass stands on, and every rule name in parentheses in the code refers to its Figure 2. The PDF is
not in the repo (`*.pdf` is ignored) — fetch it from the link. Four groups of it are load-bearing here,
and the new work extends them rather than replacing them:

* **(FElimI) / (FElimII)** (Lemma 4) — `π_{S∖{?x}}(σ_{?x=?y}(A)) ≡ π_{S∖{?x}}(A^{?y}_{?x})`, and the
  same for a constant `c`. This is *the* rule the pass generalises, in three directions. The paper needs
  `A` in the `⋈`/`∪`/triple-pattern fragment with `?x, ?y ∈ cVars(A)`, where this pass descends through
  the whole algebra and carries the four strengths precisely so it can keep going where that no longer
  holds. The paper needs the enclosing projection to drop `?x`, so it cannot appear on one side and not
  the other; this pass keeps `?x` by re-binding it instead (the mandatory `BIND(?rep AS ?x)`, the `JOIN`
  with `{?g ↦ c}` in `pushIntoGraph`), which is what "preserves `pVars` exactly" means throughout
  `pushDownAssertions.ts`. And triple terms extend the right-hand side from a *term* to a **shape**,
  which is materialised into a pattern rather than substituted (S3).
* **(FBndI)–(FBndIV)** — the four `bnd(?x)` rules, read off `cVars` and `pVars`. They decide the
  emptiness and the collapses: A and B empty by (FBndII), U empties by (FBndIII), B vanishes by (FBndI)
  and U by (FBndIV). `T⟨?x⟩` implies `bnd(?x)` and so triggers exactly the same set.
* **(FUPush), (FMPush), (FJPush), (FLPush)** — the pushing licences. (FJPush)'s side condition,
  `∀?x ∈ vars(R): ?x ∈ cVars(A₁) ∨ ?x ∉ pVars(A₂)`, is literally the licence `splitClique` reads per
  conjunct; an accessor conjunct is licensed on its **root names** for exactly this reason (D1).
* **(FLBndI) / (FLBndII)** — for `?x ∈ cVars(A₂) ∖ pVars(A₁)`, `σ_{¬bnd(?x)}(A₁ ⟕ A₂) ≡ A₁ ∖ A₂` and
  `σ_{bnd(?x)}(A₁ ⟕ A₂) ≡ A₁ ⋈ A₂`. The second is what collapses a left join over a structurally
  asserted variable into a join (S5), since a shape implies `bnd` of its root.

The refinement this repo adds on top: the paper's rules read `?x ∉ pVars(A)` as their emptiness proof,
where `vRanges` decides the finer *type*-level fact — in scope, and no term left to take. See D5.

## Orientation (read before writing code)

| file | why |
|---|---|
| `lib/utils/assertionConjunction.ts` | Θ, the conjunction that travels. Its file comment states the invariants you must preserve, and its table the states an assertion can be in. |
| `lib/utils/assertions.ts` | the `Access`, the five assertion forms, their recognisers and builders, substitution into terms/patterns |
| `lib/datastructures/ClusterSet.ts`, `TermClusterSet.ts` | the union-find Θ is built on, and the pin lattice over it |
| `lib/datastructures/AssertionClusterSet.ts` | the subclass Θ uses: its `meetPins`, and the *asserted* half of a group's range as against the derived half. Read this before writing anything that reports what Θ says. |
| `lib/transformations/pushDownAssertions.ts` | the pass; its file comment explains the rules per operation |
| `lib/utils.ts` | `derivedVarNamer`, which names a materialised position, and `collectVariableNames`, which is what it is kept off (D4) |
| `lib/utils/certainlyBoundVars.ts` | `cVars`/`vRanges` metadata, computed by dynamic programming — `vRanges` is scope *and* term types in one (D5) |
| `lib/transformations/nullifyUnbindableVars.ts` | the type-level emptiness proof step 0 added; a range consumer to keep working |
| `lib/utils/partialExpressionEvaluation.ts` | substitution into expressions + constant folding |
| `lib/RangeSet.ts`, `lib/ClusterSolver.ts` | positional term-type ranges, already used by the rewriting side |
| Schmidt et al., *Foundations of SPARQL Query Optimization* | the equivalences every rule name refers to; see **Grounding** above |

The codebase documents *why* rather than *what*, in dense prose, with the rule names of Schmidt et al.
Match that: every new rule you add needs the argument for its soundness written next to it.

## Design (decided)

### D1 — conjuncts are about an *access*, not a variable

```
export type TriplePosition = 'subject' | 'predicate' | 'object';
/** A variable read through a chain of accessors: `?x`, `subject(?x)`, `object(subject(?x))`. */
export interface Access { name: string; positions: readonly TriplePosition[] }
export function accessId(a: Access): string { return [ a.name, ...a.positions ].join('.'); }
```

* `AssertionConjunct` becomes `{ access, assertion }`; today's `{ name, assertion }` is
  `positions: []`.
* The RHS of a strong/weak assertion becomes `Access | RDF.Term`. Normalise a *variable* RHS to the
  zero-length `Access` so there is only one spelling; `variablesReadByConjunct` and `splitClique` currently match
  on `term.termType === 'Variable'`.
* `bound` / `unbound` stay restricted to `positions.length === 0` — `BOUND` takes a `Var` by grammar,
  and the subject of a triple term is always bound.
* `variablesReadByConjunct(conjunct)` returns the **root names** of both sides. Everything downstream
  (`asWeakenedConjunct`, `split`, the join/left-join licences) already reads only that and must keep
  doing so.

### D2 — one new form, `T⟨?x : τ⟩`

Originally `T⟨?x⟩ ≔ isTRIPLE(?x)`: the degenerate shape, "a triple term, nothing known about its parts".
It **implies bound** (so it joins `strong` and `bound` in `impliesBound`, and triggers (FBndII) and the
OPTIONAL→JOIN collapse), it **has a weak form** (`!bound(?x) || isTRIPLE(?x)`), it is absorbed by
anything stronger, and it contradicts `U⟨?x⟩` and any pin to a non-quad term.

**Generalised, post-review, to all four term-type predicates** — `isIRI` / `isURI`, `isBLANK`,
`isLITERAL`, `isTRIPLE` — as one form `T⟨?x : τ⟩`, because every word of the paragraph above holds of
each of them: they are one fact, "the group `?x` names holds this kind of term", which is a narrowing of
the group range D5.3 already put on the lattice. `isTRIPLE` keeps nothing special: which positions a
triple term has is the business of the accesses that read them, and `assertTriplePin` narrows to the same
`{Quad}` from the other side. `isNUMERIC` is *not* one of them — it asks after the datatype of a literal
rather than after the kind of term, so there is no range for it to narrow.

The one thing the generalisation needs that a single `isTRIPLE` did not: a group has to remember which
part of its range was **asserted** as against **derived**. That a subject holds no literal, or that a
group pinned to an IRI is one, holds wherever the group is written, so restating it would say nothing and
would grow the condition on every pass; only what a condition asserted has to survive the round trip.

That is not a fact about groups, though - it is about writing them back out, which only Θ ever does. So
it lives in `AssertionClusterSet`, the subclass of `TermClusterSet` that Θ is built on, the way
`ClusterSolver` holds `groupToExpressions`: `assertedRangeOf` / `assertTermTypeRange` beside the
inherited `rangeOf` / `narrowRange`, migrated on a merge like any other per-group state. The subclass
also owns `meetTermPins`, being the set whose meet it is. **Override `clone`** in any such subclass -
`TermClusterSet.clone` builds a set of its own class, so an inherited clone silently drops whatever the
subclass added, and Θ clones on every `split`, `weakened` and `normalisedFor`.

### D3 — groups are pinned to a shape, not a term

In `TermClusterSet`, generalise `groupToTerm`:

```
type Pin = { kind: 'term'; term: RDF.Term } | { kind: 'triple'; children: [ number, number, number ] };
```

Children are **group ids**, so a position nobody named is an *anonymous group*: it exists, unifies, and
contributes nothing to `size` / `names` / `conjuncts` until a named variable joins it.

* `compareTerm: (a, b) => boolean` becomes `meetPins: (a, b) => PinMeet | false` — equal / contradiction
  / **decompose**. What a meet reports is one list of `GroupConstraint`, `{ kind: 'unify' }` or
  `{ kind: 'pin' }`, which is the same pair of things the work list handles; two lists of pairs only had
  the drain transliterate them back. `ClusterSolver` meets terms and calls anything else broken.
* Drain them through a **work list** (`resolveAllConstraints`), never recursion: merging children can
  merge further children, and re-entering `mergeGroups` from inside `migrateGroupData` corrupts the
  caller's state.
* `carriesInformation(group)` must also be true when the group **is a child of a live pin**. Otherwise
  `remove()` drops a group a pin still points at and the child id dangles. This is the sharpest trap in
  the change.
* **Occurs check**: pinning `g` to a shape reachable from `g`, or a merge that closes a cycle in the
  child DAG, is a contradiction (`false`). Without it, resolving a group to a term does not terminate.

### D4 — representatives and derived variable names

Each group has one canonical **representative**, memoised per group:

```
representative(g) = its term pin, else its lexicographically first named member,
            else the lexicographically first access path reaching it from a named group
```

Use it for *everything*: the accessor form written into a condition, the representative a clique
substitutes to, and the name of a materialised position. A group reachable two ways (`?x` and
`object(?o)`; an anonymous child of two shapes) must render identically everywhere.

A materialised position is named `${representative}_${s|p|o}`, with a numeric suffix **only** on collision
(`?x_s`, then `?x_s0`). The taken set is collected **once from the whole query before the pass runs**
(`collectVariableNames` in `lib/utils.ts`, as `removeProjections` does). Keep the memo in one
pass-scoped map keyed by `${representative(g)}_${p}`, threaded as a per-pass context so
`assertionConjunction.ts` stays context-free — `patternSubstitution(namer)` takes it as an argument.
(In the tree that method is `intoPattern(namer)`, which hands back the residual with it.)

**Half of this already exists.** `AssertionConjunction.readingsPerGroup` computes exactly the
representative above — every group reachable from a named variable, with the readings of it,
representative first, settled shortest-path-then-lexicographic. `conjuncts()` is built on it, which is why a condition and a
materialised name cannot disagree about which access a group is read by. Phase 4 needs the *namer* and
the substitution, not the representative.

Two materialisation sites of the same group **must** produce the same name: that is how the LHS and RHS
of a join keep joining on a position after both were substituted. It is sound because the position is
functionally determined by the variable they already joined on. Do **not** use `freshVarGenerator` —
its sequential naming depends on call order. Add a `derivedVarNamer(existing)` sibling in
`lib/utils.ts`.

### D5 — `vRanges` (in the tree, step 0)

`CPMeta` is `{ cVars, vRanges }`. `vRanges` is a `VRanges extends Map<string, RangeSet>` that carries
`pVars` and the term types in one structure: its **key set is the scope** — what `SELECT *` expands to —
and the range stored per key is the term types the variable can hold *when bound*. `pVars ⊇
keys(vRanges)` is therefore structural rather than hand-kept, which is what closed the two places it was
already violated (PROJECT copied every input range while `pVars` intersected; SERVICE returned an empty
map while `pVars` united).

Key presence and range are independent on purpose, and that is what makes a third state expressible: a
key at `emptyRange` is a variable **in scope that provably never binds**, where absence is out of scope.
`VRanges.rangeOf` reports the bottom for both and `neverBinds` / `canBind` are what every consumer
reads, because `bnd(?x)` is false either way. A missing entry is not "any type": `addAtTop` is how a
variable enters at `objectRange`.

One deliberate exception, documented in the file header: `FILTER(!bound(?x))` **deletes** the key rather
than bottoming its range, because (FBndII) reads absence as its emptiness proof.

| operation | rule |
|---|---|
| PATTERN | per position, intersected over every occurrence, recursing into triple terms with the nested positions; a graph variable takes `graphRange` |
| BGP | intersect per variable over patterns |
| PATH | endpoints `objectRange` (a path may start at a literal), graph as above |
| JOIN | **intersect** per variable — but only over the operands that bind it **certainly**; where none is certain the ranges **unite** |
| UNION | **union** per variable over the branches that have it in scope |
| LEFT JOIN | left's range for what the left binds *certainly*; united with the right's otherwise |
| MINUS | left's |
| VALUES | the term types actually present in the column; an all-UNDEF column lands on the bottom |
| EXTEND | input's, plus the target: a term expression gives its own type, a triple-term construction `{Quad}`, anything else top |
| FILTER, PROJECT, DISTINCT, REDUCED, SLICE, ORDER BY, FROM | pass through (PROJECT drops the keys it does not project; FILTER drops a `!bound` key) |
| GRAPH | input's, plus `?g` → `graphRange` |
| GROUP aggregates | top |
| SERVICE | keeps its pattern's ranges; a variable endpoint is assumed an IRI |

Note the inversion against `cVars`: **UNION unions where `cVars` intersects, JOIN intersects where
`cVars` unions** — easy to get backwards, and the reason is written down at `intersectRanges`. Note also
that only a **certain** binder narrows: intersecting the range of an operand that may leave the variable
*unbound* reports `{ VALUES (?x) { (UNDEF) } } . { VALUES (?x) { ("l") } }` as unbindable, where the join
binds `?x` to `"l"`. And `graphRange` is `{NamedNode, BlankNode}`: a dataset may name a graph by a blank
node, the grammar only restricting what may be *written* in a `GRAPH` clause.

Three things read the ranges, two of them already:

1. **`cVars` through a triple-term BIND.** `BIND(<<( c₁ c₂ c₃ )>> AS ?o)` is certainly bound when every
   `cᵢ` is bound and `range(c₁) ⊆ {NamedNode, BlankNode}`, `range(c₂) ⊆ {NamedNode}` — i.e. the
   construction cannot error (`constructionCannotFail`, recursing into nested constructions and
   requiring a default graph). Without this the re-binding the pass emits drops `?o` out of `cVars` and
   degrades every later assertion about it. A ground well-formed triple term is admitted outright.
2. **Emptiness per variable, in `normalisedFor({ cVars, vRanges })`.** It returns `undefined` when a
   member implying `bnd` cannot bind — (FBndII) read one level finer than `?x ∉ pVars` — and prunes W/U
   where their `!bound(?x)` disjunct carries them. A member pinned to a term outside a *non*-empty range
   is the same rule for one term rather than all of them: **strong** empties the plan, **weak** loses its
   right disjunct and collapses to U⟨?x⟩. So `?s ?p ?o FILTER(sameTerm(?s, "lit"))` is decided here
   rather than at the BGP, and no rewrite downstream needs a term-type check of its own — which is what
   let `pushIntoGraph` drop its hardcoded NamedNode one. The order is pinned by a test: a `cVars`
   promotion to strong happens *before* the out-of-range split, so that case empties rather than
   collapsing.
3. **Emptiness per group — yours to add, with step 2.** Lift `groupToRange` down from
   `ClusterSolver.ts:43` into the shared base and intersect the plan range into each group's range;
   `normalisedFor` then also returns `undefined` when a group empties or no longer admits its pin. This
   is what confines nesting to the `object` chain: a `triple` pin on a subject or predicate child is an
   immediate contradiction, for the same reason a `Literal` pin on a subject is.

### D6 — metadata

* The scope — the key set of `vRanges` — may grow by derived variables. That is fine: a licence is
  always about a name in Θ, Θ only ever holds query variables, and a derived name is never written into
  a condition, so no licence is ever about one.
* **Metadata is cleared on both sides of the traversal** (step 0):
  `withoutCpVars(mapOperationPreOrder(withoutCpVars(op), …))` at `pushDownAssertions.ts:134`. Do **not**
  drop metadata inside `mapOperationPreOrder` — `keepMetadata` (`pushDownAssertions.ts:102`) is how
  `assertionFilter` hands a conjunction to the `pushFilter` that meets it, and how `reTransform: true`
  keeps its work.

## Soundness rules you must not break

**S1 — the accessor form is a filter conjunct, not an expression.** `sameTerm(subject(?o), ?s)` and
`sameTerm(?o, TRIPLE(?s, ?p, ?q))` differ for a bound non-triple `?o`: the first errors, the second is
`false`. They agree *as conjuncts of a FILTER*, which identifies error with `false` — the same
identification the pass already makes. So Θ may only ever be placed as a filter condition (or as a
disjunct under `!bound(root) ||`, where `false || error = error` still drops the row).

**S2 — never serialise a shape as `sameTerm(?o, <<( … )>>)`.** The derived variables are unbound
wherever the filter sits, so the condition would error and drop every row. `toExpression` emits, per
shape-pinned group: `isTRIPLE(representative)` when no position is informative, otherwise one
`sameTerm(position(representative), …)` per informative position (which already entails `isTRIPLE`).

**S3 — never substitute an open shape into an expression.** Split `strongSubstitution()` into
`patternSubstitution(namer)` (materialises shapes, used by BGP/PATH/re-binding; `intoPattern` in the tree) and
`expressionSubstitution()` (ground pins and clique representatives only, used by `collectAssertions`,
`pushIntoExtend`, `pushIntoLeftJoin`). A fully ground shape may substitute anywhere.

**S4 — a conjunct weakens iff it mentions exactly one variable.** `!bound(?o) || sameTerm(subject(?o), :a)`
and `!bound(?o) || isTRIPLE(?o)` are fine; `sameTerm(subject(?o), ?s)` is a clique edge and does not
weaken. `asWeakenedConjunct` keeps its current shape, reading
`variablesReadByConjunct(conjunct).length === 1`.
Same generalisation for `weakenedTerms` (the MINUS RHS): its argument turns on the two sides agreeing
on the value, and equal values have equal subjects, so any *unary* predicate on the value is admissible.

**S5 — a strong shape implies `bound` of its root and of every named child**, transitively.
`boundImpliedBy` must reflect that; it is what collapses an OPTIONAL over a structurally asserted
variable into a join.

**S6 — a shape that cannot travel whole may travel weakened down the pin lattice.** A target licensed
for `?o` but not for `?s` still gets `T⟨?o⟩`. This is the shape analogue of `splitClique` giving a
target `B⟨?x⟩` when it cannot take an edge.

**S7 — the accessor folds are what make the pass idempotent.** In
`partialExpressionEvaluation.ts`, fold `subject/predicate/object` against a known shape and against a
literal quad term expression, fold `istriple`, fold `triple(a,b,c)` of three constants. Without them,
the residual of the very filter that produced the assertion never folds to `true` and re-running the
pass stacks a second copy. The substitution argument becomes a view (`resolve(access)`,
`isTriple(access)`) rather than a bare `Map`.

## Per-operation work in `pushDownAssertions.ts`

| operation | change | state |
|---|---|---|
| BGP / PATH | `patternSubstitution`; `bindAssertedTerms` gains the quad case. `canOccupy` already refuses a quad outside object position. | **done**, as `intoPattern`. `bindAssertedTerms` needed no change — a quad is a term expression like any other. What stays on top is the residual half of it: a kind of term, and a position no pattern reached. |
| VALUES | prune *rows* by asserting the row into a clone of Θ (a ground triple-term value decomposes against a shape by itself); drop a *column* iff Θ can rebuild its value from the columns that survive. Worked examples in `report.md` §4. Whether you rewrite the per-variable `switch` or extend it is **your call** — keep the existing evaluation tests green. | **done.** The `switch` is gone: `rowSatisfies` asserts the whole row into a clone, which decides every form at once, so nothing is restated above the VALUES any more. The column half is `rebuildingSubstitution` — `strongSubstitution` with the shapes written out of the variables that already read their positions, coining nothing (S3). |
| UNION, PROJECT, DISTINCT, REDUCED, ORDER BY, FROM, FILTER, GROUP | nothing beyond D1 | **done.** |
| GRAPH | a shape pin on `?g` is a contradiction — state it as a *range* fact (`graphRange` is `{NamedNode, BlankNode}`, no `Quad`) and let `normalisedFor` empty the plan, the way the term case now does; `pushIntoGraph` no longer type-checks terms itself | **done.** The one `termType` test left in `pushIntoGraph` asks whether a term can be *written* as a graph name (`createGraph` takes a Variable or a NamedNode), not whether it is one. |
| JOIN / LEFT JOIN | licences already read `variablesReadByConjunct`; generalise `splitClique` to groups and add S6 | **done.** `equatedReadings()` hands over every group with more than one way of reading it, representative first, and `splitClique` splits its edges over the targets on the licence of the one variable each reading reads through. The ≤1-licensed fallback is `entailedByReading`: B⟨?x⟩ for a bare reading, T⟨read-through : Quad⟩ for a position of one (S6). |
| MINUS | `weakenedTerms` per S4 | **done**, as `admissibleOnMinusRhs`. It filters on `impliesBound`: a weak assertion may **not** go right, and doing so was a wrong answer. |
| EXTEND | `transferred` gains: `BIND(<<( ?a ?b ?c )>> AS ?o)` under a shape on `?o` transfers onto `?a ?b ?c`; `BIND(subject(?o) AS ?x)` transfers onto the access. | **done**, as `asTransferSource` + `restatedAgainst`: a source is a term, an access, or a construction of three of those, and the last is taken apart position by position. It also fixed a wrong answer of its own: B⟨?x⟩ on the target was *dropped* by the transfer, where it says the expression produced a value — `readableAgainst` restates it on the source. And it forced follow-up 6, see above. |

Also recognise `FILTER(sameTerm(?o, <<( ?a ?b ?c )>>))` and `FILTER(isTRIPLE(?o))` as assertions —
**done**, and generalised: all four term-type predicates, `isURI` reading as `isIRI`. The construction is
written back in accessor form, so it does not round-trip verbatim — that is accepted (S1).

## Work plan (one commit each, one PR)

0. ~~`vRanges` in `CPMeta` + the metadata clearing of D6.~~ **Done — `ac6d447` (#31).** It grew two
   consumers of the bottom range beyond the plan: the out-of-range rules in `normalisedFor`, and
   `nullifyUnbindableVars`, a type-level emptiness proof where `nullifyJoinOverIncompatibleBounds` is a
   term-level one.
1. ~~Ground triple terms: `isAssertableTerm` admits ground quads, `sameTerm` folds between two of them,
   `withCpVars` calls a ground triple-term BIND certain.~~ **Done — `e18a8dd` (#32).** The `sameTerm`
   fold needed no code: RDF/JS `Quad.equals` already decides two ground triple terms in
   `constantFoldOperator`.
2. ~~The pin lattice (D3). Unit-testable at the data-structure level.~~ **Done.** It grew
   the per-group ranges of D5.3 with it, since a shape *is* a range statement and the positional range of
   a child is what confines nesting to the `object` chain. `meetPins` takes two `Pin`s rather than two
   terms (a `Pin` is not a `Term`), and reports what it decided as a list of `GroupConstraint`: a ground
   triple term meeting a shape decides each position, which is an assignment rather than a unification,
   and the work list handles both. `remove` now
   asks `isLive` rather than `carriesInformation` alone, so that a group a live pin points at survives.
3. ~~Accesses and `T⟨?x⟩` (D1, D2), recognisers, `toExpression`, the folds of S7. At the end of this
   commit Θ round-trips through a condition; nothing is written into patterns yet.~~ **Done.**
   Beyond the plan: `asAssertionConjuncts` returns a *list* of conjuncts, since
   `sameTerm(?o, <<( ?a ?b ?c )>>)` is three of them; `conjuncts()` enumerates the *readings* of every
   group reachable from a named variable, which is what makes a shape decompose into conditions and
   reconstruct from them; and the BGP/PATH/VALUES rules keep `structural()` on top, since a rewrite that
   discharges Θ by substituting terms cannot carry what a shape says. Then, in commits of their own:
   the four term-type predicates as one form; `AssertionClusterSet`; and the fixes the review turned up.
4. ~~Materialisation: D4, `patternSubstitution`, `bindAssertedTerms`.~~ **Done**, as `intoPattern`. The namer is
   `derivedVarNamer` in `lib/utils.ts`, threaded from `pushDownAssertions` — which collects the taken
   names off the whole query before rewriting anything — down to the BGP and PATH rules. The residual
   grew a rule of its own, and the shape that is not worth writing is where this file was
   underspecified: see "What phase 4 decided" above.
5. ~~The operation rules in the table above.~~ **Done**, in three commits: the VALUES row rule, the
   reading generalisation of `splitClique` with S6, and the EXTEND transfer.
6. ~~Follow-up, optional: read a materialised position through the variable the pattern wrote for it -
   `isIRI(?o_o)` where the residual said `isIRI(OBJECT(?o))`.~~ **Done, and not optional after all** — 5
   forces it, see "What phase 5 found". By the mechanism this file prescribed: a substitution over the
   condition after `toExpression`, against the values `intoPattern` wrote (`asWritten`), never a coined
   name in Θ. It also decides *where* the condition goes — on the pattern, below the re-binding, wherever
   it no longer reads a re-bound variable — which is what makes a second run write the same plan.
7. Follow-up, optional: `ClusterSolver` drops the `Quad` exclusion from `RawBasicTerm` and resolves its
   TODO at line 191 — the mapping head `?t rdf:reifies <<( ?s ?p ?o )>>` against a pattern binding a
   triple term is the same unification problem.

## Tests

Extend the four layers that now exist; keep every current test green (**378 passing, 1 skipped** after
step 5, from the 359 step 4 left, the 344 steps 0 to 3 left and the 261 the first two left).

* `test/termClusterSet.test.ts` (new in step 2) — the pin lattice on its own: pins, shapes, the
  decomposition of a ground triple term against one, the positional ranges, the occurs check both ways,
  and the liveness of a group a live pin points at. Its `meetPins` is a *double* of the real one, typed
  `RDF.Term` rather than `any` deliberately: an `any` there once hid a rename the compiler would
  otherwise have caught.
* `test/assertionConjunction.test.ts` — decomposition, congruence, ground-meets-shape, the occurs check,
  T⟨?x : τ⟩ absorption and contradiction, and `conditionOf` round-trips for every form. The `conditionOf`
  helper serialises Θ through the generator, which is exactly the check that S2 holds. Also the two that
  guard the asserted/derived line: a clone keeps what was asserted, and a range worked out from the plan
  is never written back.
* `test/assertionConjunction.test.ts`, `materialisation` — what Θ writes into a pattern and what it
  keeps back: a coined position, a named one, a nested shape, a weak member (never written), the shape
  that is not worth writing, and the namer's memo and its collision suffix.
* `test/pushDownAssertions.test.ts` — the structural rules as generated SPARQL, which is where a
  suppression or a serialisation shows; and the two meta-tests that must keep passing: *"applying the
  transformation twice yields the same result as once"* — add every new form to its list, a chain above
  all — and *"leaves the input tree untouched"*.
* the `semantic equivalence (evaluation)` block — the real safety net, and the only layer that caught
  the MINUS bug. The data is in `test/statics/assertionPushdown.ttl`: `:a`/`:b`/`:c` `:says` a triple
  term, `:d` says a non-triple term, and `:e`/`:f` `:nests` one triple term inside another. Extend it
  under a **fresh predicate** — several tests assert exact row counts over `:says`.

Phase 4 added two of its own: two operands of a join that both materialise the same shape and have to
keep joining on it (which is what the shared namer buys, over the fresh `:holds` / `:mirrors`
predicates), and a kind of term left standing over a pattern that materialised the position it is about.

What is already covered there, so you can tell a regression from a gap: a shape pushed weakly into a
join operand that never binds the variable; a shape over a VALUES with an UNDEF column; a shape on the
RHS of a MINUS, and a *weak* one that must not go there; a shape under an OPTIONAL that the implied
`bound` collapses into a join; an asserted variable bound to something that is not a triple term, which
returns nothing rather than erroring; a chain two levels deep, through `sameTerm` and through `=`; and
an `isTRIPLE` that the accessor beside it entails, which must not be written back.

### Environment facts (verified, do not re-derive)

* traqula generates **and re-parses** both `?s ?p <<( ?s ?o_p ?o_o )>>` and
  `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`; `SUBJECT(…)` round-trips as the `subject` operator. No
  parser/generator work is needed.
* On `@comunica/query-sparql-file@5.3` (upgraded for this) and `n3@2`: Turtle `<<( … )>>` parses to a
  `Quad`; triple-term patterns, `SUBJECT`, `isTRIPLE` and `<<( ?s ?p ?o )>>` in a `BIND` all evaluate;
  an accessor on a non-triple or unbound argument errors into `false` so the row is dropped; an
  ill-typed construction leaves its target unbound as the spec requires.

## Out of scope

* Propagating assertions into the pattern of an `EXISTS` (pre-existing TODO).
* Pushing into `SERVICE` (deliberate barrier) or through `SLICE`.
* Generalising `sameTerm` recognition to `=` — see the warning at `asStrongAssertion`.
* Any depth cap on nesting. Chains are bounded by the number of groups and the occurs check handles the
  rest.

## Conventions

* `yarn` (v1). The pre-commit hook runs build + `eslint .` + the full suite; all three must pass.
* Never weaken an existing invariant silently. If a rewrite you add cannot preserve `pVars` exactly or
  cannot avoid shrinking `cVars`, say so in the commit message and in the doc comment.
* If you find that a decision in this file is wrong, stop and report it rather than working around it —
  most of them are load-bearing for soundness, not style.
