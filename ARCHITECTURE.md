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
position admits (`generalizedRdfView` turns those off). Both read one template triple, so both happen
*before* the merge — after it the head is three plain variables and a triple term is a BIND whose interior
nothing re-reads, which is exactly the case the type tests are for.

## The rewriting, step by step

Given a query Q without recursive paths and a mapping with head H and body B:

1. **Rewrite the paths** to triple patterns without any paths — `lib/transformations/pathTransformation.ts`.
2. **For each triple pattern of Q, unfold B into it** — `lib/transformations/rewriteSinglePattern.ts`:
   1. unify H with the pattern, giving groups of equality between expressions, head variables and triple
      term variables (`lib/ClusterSolver.ts`);
   2. `B' = FILTER(B)` with the equality between head variables that have to be equal;
   3. `B' = FILTER(B')` with the other constraints found on those variables (equality with a static term);
   4. `B' = EXTEND(B')` with how the pattern's variables are constructed from the head variables;
   5. `B' = FILTER(B')` asserting those variables really are assigned — reading `SUBJECT`/`PREDICATE`/
      `OBJECT` of a non-triple-term raises, which would leave the BIND target unbound rather than reject
      the solution;
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
   once.

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

`pullUpExtends` is the mirror of step 5: it floats the BINDs the pushdown left at the leaves back up the
plan and deletes the ones nothing above reads.

## Variable prefixes

Three prefixes, in `lib/consts.ts`, and two of them are load-bearing:

- `uq_` — every variable of the user query, renamed before anything runs. This is the **only** prefix the
  rewriting classifies on: a variable in a cluster carries it exactly when it came from the user query, and
  every other variable in that cluster belongs to the mapping.
- `mi_` — every variable of a mapping, head and body alike, so a mapping cannot collide with the query it
  is unfolded into.
- `m_` — the three variables of the generic head several mappings are merged into.

Nothing namespaces the *patterns* apart: each is unfolded into a sub-SELECT projecting only its own (user
query) variables, so the mapping variables of two patterns are in two scopes already. Only the `uq_`
variables are meant to be shared between patterns, being the natural join keys. The one exception is the
existence variable a pattern binding nothing projects in place of an empty projection — that one leaves the
sub-SELECT, so the context coins it (`mExists0`, `mExists1`, …), holding the count for the whole rewrite.
Two patterns sharing it would share a join key, and a `MINUS` decides compatibility on exactly the
variables its two sides share.

## Blank nodes

An RDF 1.1 dataset cannot reference a blank node consistently across queries, so a mapping that has to
*construct* a blank node identity uses the extension function `<internal://blank>(?a, ?b, …)`: same inputs,
same identity. Two transformations materialise it — `internalBnodeAsSpecialLiteral` as a typed literal,
`internalBnodeAsSpecialIri` as a prefixed IRI whose length SHA-1 keeps manageable.

## SPARQL quirks worth knowing

There is a [working draft for RDF 1.2 interoperability](https://w3c.github.io/rdf-interop/spec/) describing
standard mappings between RDF 1.1 and RDF 1.2.

**An empty group produces one binding.** `{}` emits a single binding with nothing bound
([spec](https://www.w3.org/TR/sparql11-query/#emptyGroupPattern)):

- `SELECT * {}` → 1 binding
- `SELECT * { {} UNION {} }` → 2 bindings
- `SELECT * { FILTER(FALSE) }` → 0 bindings

So a mapping that does not match becomes `FILTER(FALSE)`, never an empty group.

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
