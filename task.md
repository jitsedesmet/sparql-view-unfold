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

Left to do: what is left of the per-operation rules (phase 5) — MINUS, GRAPH and now BGP/PATH are done,
VALUES and JOIN/LEFT JOIN are partly done, and EXTEND is open. See the status table and the
per-operation table in `task-for-agent.md`.
