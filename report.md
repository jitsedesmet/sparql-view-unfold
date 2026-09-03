# Pulling assignments up — design report

```sparql
SELECT * { { ?s ?p ?o . BIND(:a AS ?x) } { ?a ?b ?c } }
-- becomes
SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(:a AS ?x) }
```

`pushDownAssertions` leaves an `EXTEND` behind at *every* leaf it substitutes into
(`bindAssertedTerms`), because that is the only way it can preserve `pVars`/`cVars` exactly without
knowing what is above it. This pass is the other half: once the whole plan is visible, most of those
re-bindings are not needed where they stand, and each one that rises turns a per-solution assignment on
a scan into one assignment on a smaller intermediate result — or disappears.

One new pass, `lib/transformations/pullUpExtends.ts`, exported as `pullUpExtends(c, op)`.

**Status.** Phase 1 (§9) is implemented; §§2–4 below describe what it does. Where the implementation
departed from this design, the paragraph says so and `agent-task.md` carries the argument. Phases 2–4 are
still design.

## 1. What floats

A **floatable bind** is an `Extend(A, ?x, e)` whose expression `e` is **stable**: a pure function of the
variables it reads, giving the same answer every time it is asked about the same values. Write
`V = vars(e)`. Stability, not simplicity, is what the rules need — nothing below cares how big `e` is.

- **Term expressions** (`ExpressionTypes.TERM`) — a ground term, a variable, or a triple term with
  variables in it. Exactly what `bindAssertedTerms` and the clique substitution emit (`BIND(:a AS ?x)`,
  `BIND(?o AS ?s)`, `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`), so they are the pass's bread and butter, and
  free to re-evaluate anywhere — which is what makes their pull-up unconditionally a win (§4, *cost*)
  and makes them the only ones worth substituting back for `?x` (§3).
- **Stable operator expressions** (`ExpressionTypes.OPERATOR`) — `BIND(CONCAT(?a, "x") AS ?y)`,
  `BIND(STR(?s) AS ?x)`, anything built from deterministic builtins. Same licences, different cost.

A bind is **certain** when it cannot leave `?x` unbound. `withCpVars`' `EXTEND` case already decides it:
`?x ∈ cVars(Extend(A, ?x, e))` iff `e` is a term expression, `V ⊆ cVars(A)`, and — for a triple-term
construction, which *can* raise an evaluation error when a component does not fit its position — the
ranges of the components rule that error out (`constructionCannotFail`). Certainty has exactly one job
here, the `bound(?x)` fold of §3; nothing else needs it.

**Never stable**, so never floats: `RAND`, `UUID`, `STRUUID`, `BNODE` — §17.4.2.14 fixes a blank node per
solution mapping *and* argument, so a row a join copies gets one node below the join and several above it.
`NOW` *is* stable, "all calls … in any one query execution must return the same value" (§17.4.5.1), which
is the one place this predicate parts ways with the `isStaticExpression` it replaced (§7).
`ExpressionTypes.NAMED` is opaque and unstable unless allowlisted, `EXTENSION_FUNCTION_BNODE`
(`internal://blank`, the internal form of the `bnodeConsistent` extension function the README documents)
being the first entry: "same inputs = same identity" is exactly stability. `ExpressionTypes.EXISTENCE` is
a **`TODO`**, as it is in the pushdown: it is stable per solution, but it reads `vars(P)` of a nested
pattern rather than anything visible in the expression tree, and it is evaluated against the active
graph. Nothing holding an `EXISTS` floats until that is worked out. Note that this is about a bind
*holding* one; a bind floating past a `FILTER(EXISTS { … })` that does not read it is a different
question, and §3 answers it yes. `AGGREGATE` and `WILDCARD` cannot
occur in a `BIND`.

**The unit is the chain, not the node.** Peel the maximal `EXTEND` chain at the top of a subtree into an
ordered list of binds and decide them together, the way a conjunction of filters is decided together.
Each is tested on its own: the ones that rise go above in their original relative order, the ones that
stay are re-planted below in theirs. A bind that stays does **not** block the ones *above* it — it still
binds its variable below the operation, so a later bind depending on it simply carries an ordinary (C2)
obligation on that variable. It **does** block the ones below it: the partition moves every riser past
every stayer that stood above it, and two binds may only swap when neither reads the other's variable. A
stayer reading a riser's `?x` substitutes it (§3) or pins the riser; a riser reading a stayer's `?y` pins
outright, since it would go from reading `?y` unbound to reading it bound.

## 2. The invariant, and the three side conditions

**The invariant is local, and there is no global target.** Every rewrite is one swap,
`Op1(Op2(…))` ⟶ `Op2(Op1(…))`, preserving the solution multiset, `pVars` and `cVars` **at the node the
swap is anchored at**. Below that node nothing is preserved and nothing needs to be: `Op1` without the
bind has a smaller `pVars`, which is the point. Reaching the outer `PROJECT` is an outcome, not a goal.

Hoisting `op(…, Extend(A, ?x, e), …)` into `Extend(op(…, A, …), ?x, e)` needs:

- **(C1) No capture.** No solution reaching the re-planted `EXTEND` may already bind `?x`: every *other*
  input `B` must satisfy `B.vRanges.neverBinds(?x)` unless it carries the identical bind (§4, *merge*),
  and `op` must not introduce `?x` itself — a `GRAPH ?x`, an aggregate target. A `PROJECT` listing `?x`
  is not a blocker: strike it from the list and rise (§4).

  This is an evaluation-time condition, not a syntactic one. Nothing forbids `?x` being in scope in `A`,
  and no engine should refuse an `Extend` over an input that has it in scope; what the spec leaves
  *undefined* is `Extend(μ, ?x, e)` for a μ that already **binds** `?x`, which this codebase reads as
  "must not happen, the engine crashes". So `neverBinds` — out of scope, or in scope with an empty range
  — is the right reading, and an all-`UNDEF` `VALUES` column is a legitimate hoist target.

  One caveat that belongs to *generation* rather than to the rules: §10.1 forbids a `BIND` whose variable
  "has been used in the group graph pattern up to the point of use in BIND", which is broader than the
  grammar's rule about the immediately preceding `TriplesBlock` (§19.7) and broad enough to cover the
  operand that has `?x` in scope while never binding it. Nothing in the algebra breaks; it is where to
  look if the generator ever rejects this pass's output, and the guard would then be
  `algebraUtils.inScopeVariables` at the re-plant site rather than a stricter licence.

  One thing `neverBinds` should see and does not: `withCpVars` leaves the ranges under a `FILTER(FALSE)`
  alone, so an operand with no solutions still reports `?x` as bindable. `transformFilterFalse` runs
  first and collapses a join with an empty operand to a scope-free `FILTER(FALSE)` anyway; what it
  leaves is the `PROJECT` over an empty input its own `TODO` names, and collapsing that the same way
  costs nothing when the multiset is empty either way.

- **(C2) Same inputs — read on the ranges.** Every `?y ∈ V` must take the same value above `op` as it
  did in `A`; `e` being stable then makes it produce the same value, bound or errored. This is about
  values, not legality, so it is the pushdown's `licensed` predicate read the other way round:
  `?y ∈ A.cVars ∨ ∀ other inputs B: B.vRanges.neverBinds(?y)`. Ground `e` satisfies it vacuously;
  `V = {?s}` with `?s ∈ cVars(A)` is the interesting case, and is why `BIND(f(?s) AS ?x)` is licensed to
  rise out of a join on `?s`.
- **(C3) Row correspondence.** `op` must produce solutions in 1-1 multiset correspondence whether the
  bind is applied below or above, and must not *read* `?x` — or `?x` must be substituted away first.

All three are decided from the `CPMeta` of the inputs *before* any rewriting, and all three read the
ranges rather than the key set — `neverBinds` throughout, never `has`.

## 3. Substituting `e` back for `?x`

**Sound almost everywhere.** If `e` errors, the original leaves `?x` unbound and the reader evaluates an
unbound variable — a type error; the substituted version evaluates `e` and raises the *same* type error.
SPARQL does not distinguish them, and the special forms that handle errors specially (`COALESCE`, `IF`,
`||`, `&&`) treat unbound and errored alike. Two exceptions:

- **`bound(?x)`** reads unboundness instead of propagating it, and takes a bare `Var`, so `bound(e)` is
  not grammatical. It folds to `true` only for a **certain** bind (§1); otherwise the hoist blocks.
- **A condition holding an `EXISTS` / `NOT EXISTS` *and reading `?x`*** is a barrier, and a `TODO` rather
  than a rule: `μ` is substituted into the nested *pattern*, where an expression cannot go and an unbound
  `?x` stays a variable that matches anything. `substituteInExpression` leaves `EXISTENCE` untouched for
  the same reason — the pushdown does not send assertions through one either, and carries the same
  `TODO`. A condition whose `EXISTS` does *not* mention `?x` is no barrier at all, and the implementation
  says so: the nested pattern is evaluated against a solution mapping that does not hold `?x` either way,
  so the hoist changes nothing about it. `collectVariableNames` sees into the pattern, so the reads test
  answers this for free — which is why the relaxation §9 filed under phase 4 arrived with phase 1.

**Wanted only when free.** Substitution is the price of hoisting past a reader, not a bonus. With `k`
occurrences of `?x` in the reader, one evaluation of `e` per row becomes `k+1` — `k` in the reader plus
one in the hoisted bind. So: **term expression → always substitute** (free, and `substituteInExpression`
constant-folds on top); **any other stable expression → never substitute, block the hoist**. Little is
lost, since a bind that cannot pass its reader gets re-planted directly above it, where it already was.

This lands on the existing API rather than fighting it: `AssertionView.resolve` maps an `Access` to an
`RDF.Term`, so `substituteInExpression` expresses exactly the term case and nothing else. Feed it
`resolve: ?x ↦ e`, and `bound: {?x}` only for a certain bind. Both exceptions have to be decided *before*
that call rather than by it — an uncertain bind comes back as the ungrammatical `bound(<:a>)`, an `EXISTS`
comes back untouched. A general substitute-an-expression-for-a-variable helper is one we never write.

**A third precondition the implementation added.** `e` is written into a reader that *stays where it is*,
so it has to mean down there what it meant up here. If another bind of the same chain is also leaving and
stood **below** this one, a variable of `V` that it used to supply is unbound at the reader's position,
and the substitution changes the answer. So: substitute only when no departing bind below this one writes
a variable `e` reads. Vacuous for a ground `e`, which is the overwhelming majority, and the same fact is
what makes the *stayers* of a chain need the substitution in the first place (§1, last paragraph) — the
one place this design under-specified and the implementation had to close.

## 4. Per-operation rules

(C1) and (C2) have content only where an operation has several inputs; on the single-input rows they hold
vacuously and what decides is the *readers* — a condition, an ordering expression, a projection list.

| Operation | Bind may rise | Licence, beyond (C1)+(C2) |
| --- | --- | --- |
| `FILTER` | yes | condition must not mention `?x`, or `e` is a term expression and substitutes in (§3). **A condition whose `EXISTS` reads `?x` is a barrier (`TODO`, §3); one that does not is not.** |
| `EXTEND` | — | not a swap: the chain is one unit, see §1. |
| `PROJECT` | **drop** if `?x ∉ variables`; else yes | to rise, `V ⊆ variables`, and `?x` is struck from `variables` — not for (C1), which the projection satisfies either way, but so the sub-`SELECT` does not carry an always-unbound column and the metadata stays honest. `pVars` at the swap is unchanged: `(variables \ {?x}) ∪ {?x}`. Pointless at the root, where there is nothing above to rise to — and worse than pointless, so the rise is *blocked* there (see below the table). The drop is not. The main drop site. |
| `GROUP` | **drop** if `?x` is neither a key, nor read by an aggregate, nor an aggregate target; else barrier | second drop site. The reads matter: an `aggregates` entry is a `BoundAggregate`, an `expression` over the input beside the `variable` it writes, so `GROUP BY ?k (SUM(?x) AS ?s)` reads an `?x` that is neither key nor target. A refinement for a constant key is deferred to phase 4. |
| `DISTINCT` / `REDUCED` | yes | unconditional: `e` is a deterministic function of the row, so the extra column never refines the equivalence classes. |
| `ORDER_BY` | yes | expressions must not mention `?x` (or substitute, §3). `EXTEND` maps element-wise and preserves the sequence. |
| `SLICE` | yes | unconditional — `EXTEND` is a bijection on rows and preserves order. One of the few places the pull-up goes where the pushdown may not. |
| `FROM` | yes | congruent. |
| `JOIN` | yes | (C1)/(C2) over the siblings, *or* a sibling carries the identical bind (**merge**, below). Cardinality-increasing, so subject to the cost gate below. |
| `LEFT_JOIN`, from the **LHS** | yes | `R.vRanges.neverBinds(?x)`; the condition is treated like a `FILTER`. Cost gate applies. The "or `R` carries the identical bind" case is the `LEFT_JOIN` merge, which belongs to phase 2 and is not implemented. |
| `LEFT_JOIN`, from the **RHS** | no | hoisting would bind `?x` on the unmatched left rows, where it must stay unbound. Drop-only (§5). |
| `MINUS`, from the **LHS** | yes | `R.vRanges.neverBinds(?x)` — an `R` that binds `?x` changes both the compatibility and the domain-disjointness test, though `pVars(Minus) = pVars(L)` means it never reaches the re-planted bind. (C2) is vacuous, as in `UNION`: the output mapping *is* `μ_L`. |
| `MINUS`, from the **RHS** | no | RHS bindings are out of scope above. Droppable when `L.vRanges.neverBinds(?x)`: then `?x` is in neither test. |
| `UNION` | only when **every** branch floats the same bind | same `?x`, `e` structurally equal and stable — and no (C2) condition, since a union merges nothing: the solution above *is* the branch solution, so `e` is asked about the same μ either way. Hoisting from one branch alone would bind `?x` in the others' solutions; adding it to the others instead would *grow* `cVars(union)`, a wrong answer rather than a conservative one. Subsumes `pushUpBoundedFromUnion`. |
| `GRAPH ?g` | yes | `?x ≠ ?g`, and `?g ∉ V` unless `?g ∈ A.cVars` — `?g` is bound by the join *outside* the pattern. A bind *of* `?g` is not merely blocked: that outside join makes it a graph selection, `Graph(?g, Extend(P, ?g, :a)) ≡ Extend(Graph(:a, P), ?g, :a)`, which is phase 4. |
| `SERVICE` | no | barrier, as in the pushdown: `SILENT` turns endpoint failure into one empty solution, where the hoisted bind would still bind `?x`. Carries a `TODO(future)` in the code, as `pushIntoGraph` does — letting a non-`SILENT` service release a bind is sound and reduces what is shipped to the endpoint. |
| `BGP`, `PATH`, `VALUES` | — | leaves. |

**Merge: when a sibling carries the bind too.** (C1) would block

```sparql
{ ?s :p ?o . BIND(f(?s) AS ?x) } { ?s :p2 ?a . BIND(f(?s) AS ?x) }
```

but the join is only enforcing an equality that already holds. Let `S` be the operands carrying a
structurally equal, stable `BIND(e AS ?x)`. If **`V ⊆ O.cVars` for every `O ∈ S`**, join compatibility
forces every `?y ∈ V` to one value across the merge, `e` is stable, so every carrier computed the same
`?x`: that component of the compatibility test is a tautology and the copies collapse into one. Where the
survivor goes is the *cost* question, and the gate below answers it.

```
Join(Extend(A, ?x, e), Extend(B, ?x, e))  ≡  Extend(Join(A, B), ?x, e)
```

with (C1) still required of the operands not in `S`. Multiplicity is untouched — no pair of rows was
being rejected on `?x` — and the hoisted `EXTEND` is certain iff `V ⊆ cVars(Join)`, which the condition
gives. This is one rule with the single-carrier hoist, not a second one: at `|S| = 1` it reduces to
(C2)'s first disjunct. It extends to `LEFT_JOIN` under `V ⊆ cVars(L) ∩ cVars(R)`, where the anti-join
half computes `e` on `μ_L` either way, but that half always deserves a second look — phase 2.

**The cost gate.** A term expression is free to re-evaluate, so its pull-up is a pure win everywhere. A
`f(?s)` is not: `JOIN` and `LEFT_JOIN` may *increase* cardinality, so a hoisted bind can be evaluated
more often than the original. Every other operation in the table is cardinality-non-increasing (a
`GRAPH ?g` evaluates its pattern once per graph either way, and a `UNION` puts the branch solution
straight through, so `|A| + |B|` evaluations stay `|A| + |B|`), so the gate is narrow:

> Past a `JOIN` or `LEFT_JOIN`, only a term expression rises.

**An earlier draft of this section exempted the merge**, on the grounds that it "deletes an evaluation
outright". It does not, and the arithmetic is worth writing out. Hoisting a merged bind gives
`Extend(Join(A, B), ?x, e)`: `|A ⋈ B|` evaluations, against the `|A| + |B|` the two copies cost. That is
a win on a selective join and a rout on one that fans out — two operands of a thousand rows sharing one
`?s` join to a million, turning 2 000 evaluations into 1 000 000. The merge is a *better-odds* bet than
the single-carrier hoist, its budget being `|A| + |B|` rather than `|A|`, but it is the same bet, and the
policy here is not to take it.

What the merge *can* do at no risk is delete the duplicates and leave the survivor where it stands:
`|A|` evaluations, better than `|A| + |B|` whatever the join does. So the rule splits by what the
expression costs rather than by how many carriers there are — a term construction rises, anything else
collapses in place — and only the *hoist* half needs (C1), nothing being re-planted above the join in the
other.

It stays a trade rather than a truth, and nothing in the algebra tells us which way a given join goes.
Revisit if cardinality estimates ever reach this pass.

**Nothing rises into the query's own solution modifiers.** A restriction the implementation had to add,
and a syntactic one rather than a semantic one: the `PROJECT` rise applied at the query's own projection
yields `Extend(Project(…))`, which is sound algebra that `toAst` cannot render, SPARQL having nowhere to
write a `BIND` above a `SELECT` or between it and its `LIMIT`. So the chain of
`ASK`/`CONSTRUCT`/`DESCRIBE`/`PROJECT`/`DISTINCT`/`REDUCED`/`SLICE`/`ORDER_BY`/`FROM` at the top of
whatever the pass is handed is sealed against *rises*; *drops* still fire there, which is what keeps the
main drop site working. It costs nothing: the row above already calls that hoist pointless, and §5's
`queryTransform` strips the outer projection before any transformation runs, so the sealed chain is
usually empty. A sub-`SELECT` is untouched by it, so the `PROJECT`, `DISTINCT`, `SLICE` and `ORDER_BY`
rows are still reachable from a parsed query; `FROM` is the one that is not, SPARQL admitting it only at
the top of a query, and it is exercised against a hand-built algebra instead.

**`pVars`/`cVars` discipline.** Every hoist is a swap in the sense of §2: `?x` leaves the
`vRanges`/`cVars` of the operation it rose past, and the re-planted `EXTEND` puts it back before
anything can observe the difference.

## 5. Dropping, the one rewrite that is not a swap

A drop deletes the bind instead of moving it, so `?x` does not come back: the anchor moves up to the
operation that discards it, and it is there that `pVars` and the solution multiset must be unchanged.
Dropping is sound because `Extend` is total when `A` never binds `?x` — one solution in, one out — so
the multiset is unchanged modulo `?x`.

The `PROJECT` and `GROUP` drops fire only when a bind has floated to be a *direct* child of the drop
site, which misses the common `OPTIONAL { … BIND(:a AS ?x) }` under a projection that never wanted `?x`.
The general form is a top-down `needed` analysis, run before the bottom-up pull:

```
needed(root)  = every variable in pVars(root), unless the caller says otherwise
needed(child) = needed(op) ∪ variablesRead(op) ∪ ⋃ { pVars(sibling) : op is join/leftJoin/minus }
```

This is the paper's projection pushing (§III) read as an analysis rather than as a rewrite: (PJPush) and
(PLPush) push `S ∪ (pVars(A₁) ∩ pVars(A₂))` into both operands and (PMPush) that same intersection into
the right of a `MINUS`, because a variable bound in one operand silently acts as a join key with the
other and because `MINUS`' disjointness test reads the *domain*, not the values. A floating bind with
`?x ∉ needed` is dropped wherever it stands, including the `LEFT_JOIN` and `MINUS` right-hand sides.
Phase 2.

The "unless the caller says otherwise" is a loose end: `queryTransform` strips the query's outer `PROJECT`
before running any transformation and re-adds it afterwards, so a bind that floats to the root is always
re-planted, never dropped, even when the final `SELECT ?a ?b` discards it. Passing `pullUpExtends` that
variable list closes it.

## 6. When the pull is blocked: transfer and weak assertion

Two moves remain when a `JOIN` sibling `B` has `?x` in scope and does not carry the identical bind.

- **Transfer (strong).** If `?x ∈ B.cVars`, `B` supplies `?x` on every solution and join compatibility
  already forces it to equal `e`. So `Join(Extend(A, ?x, e), B) ≡ Join(A, σ_{?x ≡ e}(B))` — the `EXTEND`
  is deleted, not moved. Ground `e` only.
- **Weak assertion.** If `?x ∈ B.vRanges` but `?x ∉ B.cVars`, the bind can neither move nor be deleted,
  but `W⟨?x ≡ e⟩` holds of every solution of `B` that reaches the join, so it may be asserted into `B`.

Both emit assertion filters that `pushDownAssertions` pushes down and re-materialises as `EXTEND`s at
`B`'s leaves, which this pass would pick up again. The strong transfer is monotone — it strictly
decreases the `EXTEND` count, and the copy it re-creates in `B` then rises over a join whose siblings no
longer bind `?x`. The weak assertion is not: it would re-emit the same filter forever, and needs an
idempotence guard: `collectAssertions` over `B`'s top filter chain, read back out of the *condition* —
`assertionFilter` does tag its filters with `metadata.assertions`, but `pushDownAssertions` strips every
`metadata` on the way out, so none of it survives into this pass.

**Phase 1 ships neither.** Pure pull-up plus drop has no loop risk at all: every rewrite either deletes
an `EXTEND` or strictly decreases its depth, so one bottom-up traversal is a fixpoint.

## 7. Architecture and reuse

- **Traversal:** the post-order `algebraUtils.mapOperation` with a per-type `transform`, which runs
  after the children — leaves first, working up, the mirror of the pushdown's `mapOperationPreOrder`. By
  the time a node is visited its children have already floated everything they can to their own top, so
  the floating list is just the `EXTEND` chain at the top of each input: no custom recursion, and no
  second pass to reach a fixpoint.
- **New shared util** `lib/utils/extendChain.ts`: `peelExtends(c, op) → { core, binds }` and
  `replantExtends(c, core, binds)`. Generalises `directExtensions` (Literal/NamedNode only, loses order)
  and `deleteVarExtensionsInPlace` (in-place, name-list based) from `lib/utils.ts`. The second died with
  `pushUpBoundedFromUnion`, which is **deleted**, its `UNION` rule being the row in §4; the first stays
  where it is, `nullifyJoinOverIncompatibleBounds` being its other caller. A `ChainBind` also carries the
  `EXTEND` node it was read off, which is what lets a licence ask what holds *where the bind is
  evaluated*: `?y ∈ cVars` of the whole input is also satisfied by a bind further up the chain writing
  `?y`, and that is precisely a `?y` this bind reads unbound.
- **Two predicates**, both needing tests of their own since every rule leans on them.
  `isStableExpression(c, e)` is the former `isStaticExpression` without its "no variables" clause: the
  same `bnode`/`rand`/`uuid`/`struuid` walk and the same `NAMED`/`EXISTENCE`/`AGGREGATE`/`WILDCARD`
  rejections, with `now` off the list (§1) and the `NAMED` allowlist on it. Nothing called
  `isStaticExpression`, so this is a generalisation in place rather than a second predicate.
  `expressionsEqual(a, b)`, for the merge and the `UNION` rule, is ours: the algebra ships no structural
  equality — `Canonicalizer` only renames blank nodes — so it is a structural walk, not
  generate-and-compare.
- **Reused as-is:** `withCpVars`/`withoutCpVars`/`CPMeta`/`VRanges` for every licence - with `cpMetaOf`,
  the "read it, do not annotate with it" wrapper both passes had grown privately, lifted into
  `certainlyBoundVars.ts` so that they share one;
  `substituteInExpression` for §3; `collectVariableNames` for "does this expression mention `?x`" and
  for `vars(e)`.
- **Metadata hygiene:** moving a node invalidates the cached `CPMeta` of everything it moved past. Enter
  through `withoutCpVars`, delete the metadata of every node this pass rebuilds, and read `cpMetaOf` only
  off inputs as `mapOperation` hands them back. The likeliest source of a subtle bug; give it a test. In
  the end it needed no deletion at all: everything the pass emits is built fresh through the factory, so
  the only cached metadata that survives sits on the cores nothing moved, where it is still true — and
  the test asserts no `metadata` is left on the way out.

## 8. Pipeline placement

The chain the tests and the benchmark run, with `pullUpExtends` inserted in front of its last step:

```
operationTransform → pushDownAssertions → transformFilterFalse
  → nullifyJoinOverIncompatibleBounds → nullifyUnbindableVars → transformFilterFalse
  → pullUpExtends → removeProjections
```

- **After `transformFilterFalse`**, which collapses the empty operands (C1) would otherwise trip on.
- **Before `removeProjections`**, which deletes the `PROJECT` nodes the drop rule reads.
- **Before `transformExtendsToValues`** wherever a caller adds it — it is not in that chain — since it
  turns `Extend(BGP([]), ?x, t)` into a `VALUES` this pass no longer recognises as a bind.

## 9. Phases and tests

1. **Phase 1, shipped** — `peelExtends`/`replantExtends`, `isStableExpression`/`expressionsEqual`, the congruent
   operations (`FILTER`, `DISTINCT`, `REDUCED`, `ORDER_BY`, `SLICE`, `FROM`, `GRAPH`), `JOIN` with the
   merge rule and the cost gate, `LEFT_JOIN` LHS, `MINUS` LHS, the all-branch `UNION` rule, and the two
   syntactic drop sites. Term and stable operator expressions both. Delete `pushUpBoundedFromUnion`.
2. **Phase 2** — the `needed` analysis and general dropping, including `LEFT_JOIN`/`MINUS` RHS; the
   `LEFT_JOIN` merge.
3. **Phase 3** — transfer and weak assertion, flag-gated, with the idempotence guard.
4. **Phase 4, edge cases** — the `GROUP`-over-a-constant-key hoist (`Group(A, keys \ {?x}, aggs)`,
   blocked when `keys = {?x}`, since a keyless `GROUP` over the empty input yields one group where
   `GROUP BY ?x` yields none); `NAMED` allowlisting, and `EXISTS` in a *bind* (the condition half of it
   landed with phase 1, §3);
   substituting a non-term `e` where
   `k = 1` and `?x` is dead above, which is break-even and deletes a node but needs §5's analysis.

Tests, mirroring `test/pushDownAssertions.test.ts`: a case per row of §4, the *negative* ones included —
a sibling with `?x` in scope carrying a different expression, a `UNION` branch that does not carry the
bind, `BIND(RAND() AS ?x)` staying put, a `FILTER` reading a computed `?x`, a chain whose *outer* bind
stays and reads the inner one that would rise (§1), a `GROUP` whose aggregate reads the bind it does not
name (§4), and a join whose carriers share `?x` over a `?y ∈ V` that is not certain on both sides, which
must **not** merge. Both merge examples, one per `|S|`. **Idempotence** (`pullUpExtends ∘ pullUpExtends =
pullUpExtends`). A **fixpoint check against `pushDownAssertions`**, so the pair provably does not
oscillate. And evaluation tests in
`test/eval.test.ts` for `OPTIONAL`, `MINUS`, `UNION` and a sub-`SELECT`, since those are where a wrong
`cVars` silently changes `SELECT *` without any test on the generated string noticing.

Phase 1 shipped all of that as 60 cases in `test/pullUpExtends.test.ts` and 5 in `test/eval.test.ts`,
with the scope invariant, idempotence and metadata check folded into the assertion helper so that every
case pays for them. Two things the generated string cannot show, and which are asserted on the algebra
instead: the `GRAPH` rules, since `toAst` writes an `EXTEND` at the top of a graph pattern exactly as it
writes one that rose past the `GRAPH`; and the `FROM` rule, which no parsed query can reach.
