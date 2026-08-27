Main has support for variable assertion pushdown where a variable is asserted to equal a static term (#28, #29),
and the variable clique assertion where many variables equal each-other but are not necessarily bound to a term (#30).
This is our extension of the algebraic rewriting framework of Schmidt, Meier, Lausen, ["Foundations of SPARQL
Query Optimization"](https://dl.acm.org/doi/pdf/10.1145/1804669.1804675) (ICDT 2010), whose Figure 2 the rule
names throughout the code refer to: the pushdown is its
filter elimination (FElimI/FElimII) carried across the whole algebra rather than only under a projection
that drops the eliminated variable, licensed by the (F*Push) side conditions and bounded by (FBndI)-(FBndIV).

In this PR we aim to extend that filter pushdown with support for triple terms.
E.g.:

```sparql
SELECT * {
   ?s ?p ?o
   FILTER(sameTerm(subject(?o), ?s))
}
```
Can be optimized to:
```sparql
SELECT * {
  ?s ?p <<( ?s ?fresh1 ?fresh2 )>> .
  BIND(<<( ?s ?fresh1 ?fresh2 )>> AS ?o) .
}
```

Of course, this feature should interop with the term assertion and variable unification.
So if a unified group of variables gets asserted, this information would also travel down as such.

Support for Strong and Weak Variables might also be required for effective push down (just like we have now).

Start by creating a study of how our `AssertionConjunction` structure should be updated.
Look whether we can reuse e.g. TermClusterSet given some changes.
Write your finding in `report.md` in the root of this repo so I can properly review.

## Progress

That study is `report.md`, and `task-for-agent.md` is the implementation contract it was turned into.
Two of its phases are already on main:

* **#31 `ac6d447`** — phase 0: `vRanges` on `CPMeta`, which absorbed `pVars` as its key set, plus the
  emptiness rules that reads (in `normalisedFor` and in the new `nullifyUnbindableVars` pass) and the
  metadata clearing at the end of the pushdown.
* **#32 `e18a8dd`** — phase 1: ground triple terms are assertable, and `BIND(<<( :a :b :c )>> AS ?t)`
  binds `?t` certainly.

Phases **2** (the pin lattice on `TermClusterSet`, with the per-group ranges) and **3** (accesses and
term types) landed as **#34 `c15adc9`**: Θ holds shapes, round-trips them through a condition, and the
pass carries them across the algebra.

Phase **4** (materialisation) is in the working tree, and with it the example above is what the pass
produces: a shape reaching a BGP or a path is written into it as a triple term, its positions filled in
with what Θ has for them and a variable coined for the rest (`derivedVarNamer`), with the mandatory
`BIND` handing the variable back the value the pattern took. What no pattern can state — which *kind* of
term a position holds, a position no pattern reached — comes back from the same call as a condition to
put over it (`intoPattern`).

Review pushed step 3 past its brief in one respect: T⟨?x⟩ became T⟨?x : τ⟩ over all four term-type
predicates (`isIRI`/`isURI`, `isBLANK`, `isLITERAL`, `isTRIPLE`), since they are one fact — a narrowing
of a group's range — and everything written for `isTRIPLE` held of them word for word.

Phase **5** (the per-operation rules) landed as **#36 `9a95be5`**, in three commits:

* **VALUES** — a row is a solution mapping, so it is asserted into a clone of Θ rather than read per
  variable: that decides the positions of a triple term a row holds as readily as the term itself, and
  leaves nothing to restate above the VALUES. A column is dropped wherever what stays rebuilds its
  value, which for a shape is the triple term written out of the columns holding its positions.
* **JOIN / LEFT JOIN / GRAPH** — a clique of variables and an edge into a position are one thing: a
  group Θ can read more than one way. `splitClique` splits those *readings* over the targets, and a
  target licensed for one reading gets what reading it entails — B⟨?x⟩ for a variable, `isTRIPLE(?o)` for
  a position of one, which is the S6 case an edge placed whole could not reach.
* **EXTEND** — Θ transfers onto anything it can name: a term, an access (`BIND(SUBJECT(?o) AS ?x)`), or
  the construction `BIND(<<( ?a ?b ?c )>> AS ?t)`, which is taken apart position by position. Two things
  came with it: B⟨?x⟩ on the target was being dropped rather than restated, which was a wrong answer;
  and the construction rule forced follow-up 6, since the pass writes such a BIND itself at every
  materialisation and so meets the rule on its own output.

Phase **7**, the last one, is the unfolding side of the same unification. A triple term a *mapping
head* writes is no longer a value the solver pins a group to but a shape whose three positions are
groups of their own, the way the assertion conjunction has held one since phase 2, and the term is read
back off that shape for the `BIND` the rewriting emits. Two triple terms reaching one group therefore
unify position by position rather than being reported unequal for being spelt with different variables -
the TODO it was about - and the positional ranges and the occurs check come with it. The one visible
change: a position of the head triple term that the pattern decides is written into the construction.

Everything in `report.md` is now built. See the status table and the per-operation table in
`task-for-agent.md`.
