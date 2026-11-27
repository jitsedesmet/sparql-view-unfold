# Architecture

How a SPARQL 1.2 query over views becomes a query over the data those views are defined on — in the case
this was built for, how a SPARQL 1.2 query becomes a SPARQL 1.1 one. For what the package *does*, read the
[README](README.md); this file is for someone about to change the code.

![Schematic overview of query rewriting](assets/schematic-plan.png)

## The mapping

A mapping is a GAV expression written as a SPARQL CONSTRUCT: the template (**head**) says which triples the
view holds, the WHERE clause (**body**) how they are found in the data — for the interoperability case, an
RDF 1.2 pattern and its RDF 1.1 representation. `mappingFromConstructQueries`
(`lib/mapping.ts`) turns a set of them into a single `Mapping`:

- a template of N triples is split into N mappings over one body — a CONSTRUCT instantiates every template
  triple per solution, so the split denotes the same graph;
- one mapping **keeps its own head**, which pins the positions the head writes constants in, and lets the
  unfolding decide far more about a pattern;
- several are merged behind the generic `?m_s ?m_p ?m_o` head: an EXTEND per head position, a UNION of the
  bodies, a PROJECT onto the three.

The body also gets what SPARQL 1.1 §16.2 asks of a CONSTRUCT: a `FILTER(bound(?x))` per head variable the
body does not certainly bind, and a type test per head variable whose `vRanges` range exceeds what its head
position admits (`rangeOfPosition`: any term in a `generalizedRdfView`); a BIND's range is what its expression's
operators give, so `BIND(IRI(…) AS ?s)` needs none. Both read one template triple, so both happen *before* the
merge — after it the head is three plain variables and a triple term is a BIND whose interior nothing re-reads,
which is exactly the case the type tests are for. The unfolding of a generalized RDF view also sets
`TransformationContext.generalizedRdf`, so the later passes read a triple term the query builds as a generalized
one (`rangeOfPosition(position, c.generalizedRdf)`).

## The rewriting, step by step

Given a query Q without recursive paths and a mapping with head H and body B:

1. **Rewrite the paths** to triple patterns without any paths — `lib/transformations/pathTransformation.ts`.
2. **For each triple pattern of Q, unfold B into it** — `lib/transformations/rewriteSinglePattern.ts`:
   1. unify H with the pattern, giving groups of equality between expressions, head variables and triple
      term variables (`lib/ClusterSolver.ts`), each held to what its position of H admits;
   2. `B' = FILTER(B)` with the equality between head variables that have to be equal;
   3. `B' = FILTER(B')` with the other constraints found on those variables (equality with a static term);
   4. `B' = FILTER(B')` with `isTRIPLE(x)` per `SUBJECT(x)`/`PREDICATE(x)`/`OBJECT(x)` the binds of step 5 read:
      on a non-triple-term these raise, and a raising BIND leaves its target unbound rather than rejecting the
      solution (`bindEvaluationGuards`);
   5. `B' = EXTEND(B')` with how the pattern's variables are constructed from the head variables;
   6. `B' = PROJECT(B')` onto the pattern's own variables.

   A pattern that cannot be unified with H at all raises `RewriteNoMatchError` and unfolds to
   `FILTER(FALSE)`, the empty solution multiset.

   ![Query rewriting visualization](assets/query-rewritten.jpg)

3. **Collapse equality between variables** into a single variable representing it. Where one of them is
   normally constructed by an EXTEND, a FILTER is used instead of a second EXTEND, so no variable is ever
   bound twice.
4. **Substitute variables assigned to static terms** by those terms, with care where they are read by an
   operation rather than by a pattern.
5. **Group the constraints** with `pushDownAssertions` (`lib/transformations/pushDownAssertions.ts`, over
   `lib/utils/assertionConjunction.ts`), which pushes restrictions down and distributes JOIN over UNION. It
   moves both the `FILTER(sameTerm(?x, term))` constraints of 2.3, which substitute their term into the
   patterns they reach and empty the branches that cannot bind the variable, and the
   `FILTER(sameTerm(?x, ?y))` unifications of 2.2 that step 3 left behind, which substitute one variable
   for the other. A chain of unifications is a *clique* of variables that all have to be equal; it is
   substituted to the lexicographically first member, with a BIND per member replacing the ones it
   substituted away (`?s ?p ?o FILTER(sameTerm(?s, ?o))` becomes `?o ?p ?o . BIND(?o AS ?s)`, keeping
   `pVars` and `cVars` unchanged). The two interact: a term meeting a clique fixes every variable in it at
   once. It also moves the type tests of the mapping (`isIRI(?x) || isBLANK(?x)`), which hold of every member
   of a clique alike and are dropped wherever the plan already confines the variable to those types.

   Two invariants that are not guessable from the code, and are argued for in the pass's `@fileoverview`:
   a clique is split by *edges* rather than by variables, so that what is pushed down plus what is kept on
   top spans it again; and the weak form (`!bound(?x) || sameTerm(?x, term)`) only exists for a clique
   pinned to a term, a clique without one travelling as the `bound(?x)` it entails of each of its members.
6. **Prune the constraint groups that cannot be satisfied**, replacing them with `FILTER(FALSE)`. This uses
   the `ClusterSolver` as range and domain of the known operations, and Comunica's expression evaluator to
   fold static expressions (`lib/transformations/staticExpressionEvaluation.ts`). Specific prune algorithms
   would be fruitful for some operations — word equations testing whether a literal concatenation is
   possible given a variable, for instance.
7. **Let the `FILTER(FALSE)`s walk up**, absorbing what stands over them — `transformFilterFalse`.

A `SERVICE` is evaluated by its endpoint over that endpoint's own data, so its answer does not depend on the
data the mapping is defined over: steps 1 and 2 leave it as it stands. The later
steps are equivalences over any data and may still rewrite inside it.

`pullUpExtends` is the mirror of step 5: it floats the BINDs the pushdown left at the leaves back up the
plan and deletes the ones nothing above reads.

## Variable names

Nothing is told apart by its name. The `ClusterSolver` learns which variables are the user query's from the
side of `register` they arrive on; every other variable in a cluster is the mapping's. Names still have to
differ, since the solver keys variables by name and a mapping body shares a scope with the binds of its
pattern.

The context holds every variable name in use in the rewrite (`usedVariableNames`), seeded with the whole
query, and every pass coining a name claims it there. The unfolding renames a mapping variable whose name is
in use under `mi_`; the generic head of merged mappings is `?m_s ?m_p ?m_o` (`lib/consts.ts`).

Nothing namespaces the *patterns* apart: each is unfolded into a sub-SELECT projecting only its own (user
query) variables, so the mapping variables of two patterns are in two scopes already. The one variable
leaving a sub-SELECT is the existence variable a pattern binding nothing projects in place of an empty
projection (`mExists0`, `mExists1`, …), which is never bound.

## Blank nodes

An RDF 1.1 dataset cannot reference a blank node consistently across queries, so a mapping that has to
*construct* a blank node identity uses the extension function `<internal://blank>(?a, ?b, …)`: same inputs,
same identity. An argument can be any expression, and one that is unbound or errors counts as a value of its own,
as a `BIND` would leave it, so a node is still built, one that differs from every node built from a value.

Every string in an encoding is written with its length, so it needs no escaping. A triple term argument is encoded
through its components, up to the context's `tripleTermArgumentDepth` (2) deep since an expression cannot recurse;
a deeper one leaves the node unbound. Outside an `OPTIONAL` condition, which has no input to bind it in, an
argument that is no term is bound to a fresh variable first, so it is evaluated once, and the encoding leaves out
the branches the `vRanges` and `cVars` of the input rule out. Two transformations materialise it —
`internalBnodeAsSpecialLiteralTransformation` as a typed literal, `internalBnodeAsSpecialIriTransformation` as a
prefixed IRI whose length SHA-1 keeps manageable, each through its `InternalBnodeMaterialisation`.

With `encodedByExtensionFunction`, an extension function of the engine, `<internal://blank/encoding>`, gives the
encoding from the evaluated arguments instead, at any depth, and the same materialisation turns it into the node
(`lib/transformations/bnodeExtensionFunction.ts`). An engine errors the call when an argument errors, so each argument
`e` is wrapped as `COALESCE(TRIPLE(<internal://blank/argument>, <internal://blank/argument>, e), <internal://blank/unbound>)`.

## Provenance

`lib/provenance.ts` builds two things.
The README explains what they are for and how to read the result; the limits are at the end of this section.

**The provenance view** (`provenanceMappingFromConstructQueries`).
A *derivation* is one solution of a view's `WHERE` clause.
Each view CONSTRUCT is rewritten into one over the same `WHERE` clause that gives every solution an identifier:
`BIND(<internal://blank>(provenance:construct0, ?var1, ?var2, …) AS ?derivation)`,
a blank node built from the CONSTRUCT's index and all variables of its `WHERE` clause.
Its template links `?derivation` by `derivationOf` to every triple the original template produces,
and by `derivedFrom` to every triple pattern of the `WHERE` clause that each solution matches
(so not those inside a `UNION`, `OPTIONAL` and the like).

**The rewritten query** (`provenanceCapturingQuery`).
The provenance of an answer is a *polynomial*: a formula of ⊗ (join), ⊕ (union), ⊖ (difference) and δ (aggregate),
with derivations at the leaves.
The rewrite adds a column for every operator of the query, named after its place in the polynomial.
For `SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }`:

| Column | What it holds |
|---|---|
| `?prov_sum` | the answer; several rows can give the same answer, and its provenance is their ⊕ (`sum`) |
| `?prov_sum_product` | the join (⊗, `product`) of the two triple patterns |
| `?prov_sum_product_1_sum` | the first triple pattern, which can match several derivations (`sum`) |
| `?prov_sum_product_1_sum_statement` | one derivation of `:alice :knows ?f` |
| `?prov_sum_product_2_sum`, `…_2_sum_statement` | the same for `?f :colleague ?c` |

A `statement` column holds a derivation.
A `one` column holds `1`, for a row of a `VALUES` or `SERVICE`, which needs no derivation.
Every other column holds an ID of the solution its operator produced:
a blank node built from the column name and the solution's values.
`decodeProvenance` (`lib/provenancePolynomial.ts`) groups the rows by those IDs to rebuild the polynomial.

A triple pattern turns into the lookup `?d provenance:derivationOf <<( s p o )>>`, a pattern over the provenance view.
That is why the rewrite runs before the unfolding: the unfolding then handles those lookups like any other pattern.

**Differences.**
`a ⊖ b` keeps every row of `a`, together with the derivations of the rows of `b` that remove it.
The removed rows are kept, so that the README's `isAnswer: false` rows can show why they were removed.
It is written as `a OPTIONAL { b }`.
One catch: when `a` leaves a variable unbound that `b` binds, the OPTIONAL fills it in from `b`.
If `a` returns `?x` unbound and `b` returns `?x = :carol`, the row would then claim `?x = :carol`.
So such a variable is saved under another name before the OPTIONAL and restored after it: unbound stays unbound.

- `MINUS` is a difference whose OPTIONAL also asks that the two rows share a bound variable.
  A `MINUS` that shares no variable removes nothing, and stays just its left side.
- `NOT EXISTS { b }` over `a` is `a ⊖ b`.
  Only a `NOT EXISTS` (or `EXISTS`) that does not depend on the outer row is rewritten; the limits below list the others.
- `OPTIONAL` is the matched rows plus the unmatched ones: `(a ⊗ b) ⊕ (a ⊖ b)`.
- `EXISTS { b }` over `a` is `a ⊖ (a ⊖ b)`.
  `a ⊖ b` is the rows of `a` without a match in `b`, and taking those away from `a` leaves the ones with a match.
  Each row of `a` is only compared with the rows built from that same row,
  so `a` is computed once and its columns are reused.

**Aggregates.**
The rewritten query has a row per derivation, so aggregating it directly would count derivations, not solutions.
So a `GROUP BY` subquery runs twice: once without provenance to compute the answers,
and once with provenance, joined to the answers on the group variables.
`LIMIT` and `OFFSET` work the same way.
A group variable that may be unbound is joined on a stand-in value, so that unbound only matches unbound.

**Limits.**

- Only `SELECT` is supported, without `RAND`, `BNODE`, `UUID` or `STRUUID`:
  the rewritten query runs parts of the query more than once, and these functions would answer differently each time.
- `OPTIONAL` repeats its left side, and `GROUP BY`, `LIMIT` and `OFFSET` their subquery.
  Each nesting so doubles the rewritten query.
- `LIMIT` and `OFFSET` return the same answers as without provenance, but not in `ORDER BY` order.
  An answer's provenance also mentions the solutions with the same values that the `LIMIT` cut off.
- Inside `GROUP BY`, `LIMIT` and `OFFSET`, a view triple counts once, however many derivations it has.
  So a `COUNT` can differ from a run without provenance, unless that run uses `preserveCardinality`.
- An `EXISTS` still filters, but adds nothing to the polynomial, in two cases:
  when it is part of a larger expression,
  and when it uses an outer variable that its own pattern may leave unbound, such as `?x` in
  `FILTER EXISTS { ?y :worksAt ?o FILTER(?y != ?x) }`.
- `derivedFrom` does not list the source triples matched inside a `UNION`, `OPTIONAL`, `MINUS`, sub-`SELECT`,
  `GROUP BY`, `GRAPH`, `SERVICE` or property path of a view's `WHERE` clause.
- Identical `SERVICE` solutions count once: they cannot be told apart.

## SPARQL quirks worth knowing

There is a [working draft for RDF 1.2 interoperability](https://w3c.github.io/rdf-interop/spec/) describing
standard mappings between RDF 1.1 and RDF 1.2.

**An empty group produces one binding.** `{}` emits a single binding with nothing bound
([spec](https://www.w3.org/TR/sparql11-query/#emptyGroupPattern)):

- `SELECT * {}` → 1 binding
- `SELECT * { {} UNION {} }` → 2 bindings
- `SELECT * { FILTER(FALSE) }` → 0 bindings

So a mapping that does not match becomes `FILTER(FALSE)`, never an empty group.

**An EXISTS sees the solution μ it is evaluated for.** SPARQL 1.2 starts every group of its pattern, also in a
sub-SELECT, from μ ([ContextSolution](https://www.w3.org/TR/sparql12-query/#defn_evalContextSolution)); above a GROUP
only its keys and aggregates remain. A pass reading ranges runs through `rewriteInExistenceScopes`, which rewrites each
pattern with μ as `existenceScope` once the pass has placed the EXISTS. The unfolding moves no EXISTS, so it uses
`rewriteInExistenceScopesBeforePass`, which leaves the mapping bodies alone. `filterFalse` prunes each pattern where its
bottom-up walk meets the operation evaluating it (`rewriteExistenceExpressionsOf`), whose operands it has pruned.

A BIND of a variable μ binds is undefined ([Extend](https://www.w3.org/TR/sparql12-query/#defn_extend)), so per
variable `?o` of μ (`outerBinding`):

| μ binds `?o` | unfolding (`BIND(?mi_s AS ?o)`)                             | `removeProjections`  |
|--------------|-------------------------------------------------------------|----------------------|
| certainly    | `FILTER(sameTerm(?mi_s, ?o))` instead                       | keeps the name       |
| maybe        | UNION of that FILTER and `{ … FILTER(!BOUND(?o)) } BIND(…)` | keeps the projection |
| not          | the BIND                                                    | renames              |

Each variable μ may bind doubles the subquery. The pushdown writes no term for a variable of μ, and `pullUpExtends`
moves no BIND of one.

## Still to settle

- **Named graphs.** `GRAPH` is rejected by the precheck: what unfolding a mapping *inside* a named graph
  means is not decided. The GRAPH rules in `pushDownAssertions` and `pullUpExtends` are there and tested,
  so the work left is semantic rather than mechanical.
- **`removeProjections`.** Dropping inner projections helps many engines and hurts some; it is in the
  default pipeline and deserves a proper study rather than the anecdote it rests on.
- **`nullifyJoinOverIncompatibleBounds` seeing through a `PROJECT`**, which would free it from having to
  run after `removeProjections`.
- **Merging SERVICE calls.** A service can absorb a variable amount of computation, so there is a
  composition to choose; `transformServiceCallPushUp` makes one choice.
- **Pruning derivation lookups.**
  Every CONSTRUCT of the provenance view produces `derivationOf` triples,
  so the lookup `?d provenance:derivationOf <<( :alice :knows ?f )>>` is unfolded against all of them,
  also those whose triples can never be `:alice :knows …`.
  Those branches only come up empty when the query runs.
  Checking the triple term while rewriting would drop them.
- **Provenance across SERVICE.**
  A `SERVICE` row counts as needing no view triple (`1`).
  Asma et al., "Native Provenance Computation for Federated and Non-Federated SPARQL Queries"
  (https://doi.org/10.4230/TGDK.4.1.4), show how the remote endpoint could return provenance too.
