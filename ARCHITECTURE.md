# Architecture

How a SPARQL 1.2 query over views becomes a query over the data those views are defined on - in the case
this was built for, how a SPARQL 1.2 query becomes a SPARQL 1.1 one. For what the package *does*, read the
[README](README.md); this file is for someone about to change the code.

![Schematic overview of query rewriting](assets/schematic-plan.png)

## The mapping

A mapping is a GAV expression written as a SPARQL CONSTRUCT: the template (**head**) says which triples the
view holds, the WHERE clause (**body**) how they are found in the data - for the interoperability case, an
RDF 1.2 pattern and its RDF 1.1 representation. `transformContextFromConstructs`
(`lib/transformContext.ts`) turns a set of them into one `Mapping`. A single mapping keeps its own head,
which pins the positions its head writes constants in and so lets the unfolding decide more about a
pattern; several are merged behind the generic `?m_s ?m_p ?m_o` head, as an EXTEND per head position over a
UNION of the bodies, projected onto the three.

## The rewriting, step by step

Given a query Q and a mapping with head H and body B:

1. **Rewrite the paths** to triple patterns — `lib/transformations/pathTransformation.ts`.
2. **Unfold B into each triple pattern of Q** — `lib/transformations/rewriteSinglePattern.ts`. H is unified
   with the pattern (`lib/ClusterSolver.ts`), giving groups of equality between expressions, head variables
   and triple term variables. B is then filtered with the equalities between head variables, filtered again
   with the constraints on them, extended with how the pattern's variables are built from the head
   variables, filtered once more to assert those really are assigned — reading `SUBJECT`/`PREDICATE`/
   `OBJECT` of a non-triple-term raises, leaving the BIND target unbound rather than rejecting the solution
   — and projected onto the pattern's own variables.

   ![Query rewriting visualization](assets/query-rewritten.jpg)

3. **Collapse equality between variables** into one variable representing it, a FILTER standing in where a
   second EXTEND would bind a variable twice.
4. **Substitute variables assigned to static terms** by those terms, with care where an operation rather
   than a pattern reads them.
5. **Group the constraints** — `lib/transformations/pushDownAssertions.ts`, over
   `lib/utils/assertionConjunction.ts`. It pushes restrictions down and distributes JOIN over UNION: both
   the term assertions of step 2, which substitute into the patterns they reach and empty the branches that
   cannot bind the variable, and the unifications step 3 left behind. A chain of unifications is a *clique*
   of variables that must be equal, substituted to its lexicographically first member with a BIND per
   member it replaced. Two invariants argued for in the pass's `@fileoverview`: a clique is split by
   *edges*, so that what is pushed down and what stays on top together span it again; and the weak form
   (`!bound(?x) || sameTerm(?x, term)`) exists only for a clique pinned to a term.
6. **Prune the groups that cannot be satisfied** into `FILTER(FALSE)`, from the solver's ranges and from
   Comunica's expression evaluator folding the static expressions
   (`lib/utils/staticExpressionEvaluation.ts`).
7. **Let the `FILTER(FALSE)`s walk up**, absorbing what stands over them —
   `lib/transformations/filterFalse.ts`.

`pullUpExtends` is the mirror of step 5: it floats the BINDs the pushdown left at the leaves back up and
deletes the ones nothing above reads.

## Variable prefixes

Three prefixes in `lib/consts.ts`, and a fourth coined in `lib/transformBgp.ts`:

- `uq_` — every user query variable, renamed before anything runs. This is the **only** prefix the
  rewriting classifies on: a variable in a cluster carries it exactly when it came from the user query, and
  every other variable in that cluster belongs to the mapping.
- `mi_` — every mapping variable, head and body alike, so a mapping cannot collide with the query it is
  unfolded into.
- `m_` — the three variables of the generic head several mappings are merged into.
- `p<n>_` — added per triple pattern, so that the internal variables a pattern's sub-select projects are
  not unified with those of its siblings. Only the `uq_` variables are meant to be shared, being the
  natural join keys.

## Blank nodes

An RDF 1.1 dataset cannot reference a blank node consistently across queries, so a mapping that has to
*construct* a blank node identity calls `<internal://blank>(?a, ?b, …)`: same inputs, same identity. Two
transformations in `lib/transformations/bnodeMapAsLiteral.ts` materialise it, as a typed literal or as a
prefixed IRI whose length SHA-1 keeps manageable.

## Worth knowing

**An empty group produces one binding.** `{}` emits a single binding with nothing bound
([spec](https://www.w3.org/TR/sparql11-query/#emptyGroupPattern)), so a mapping that does not match becomes
`FILTER(FALSE)`, never an empty group.

There is a [working draft for RDF 1.2 interoperability](https://w3c.github.io/rdf-interop/spec/) describing
standard mappings between RDF 1.1 and RDF 1.2.

## Still to settle

- **Named graphs**, and updates: both are silently mishandled rather than rejected (see the README's
  restrictions). The GRAPH rules in `pushDownAssertions` and `pullUpExtends` exist and are tested, so what
  is left is semantic.
- **A pattern no mapping can produce** should unfold to `FILTER(FALSE)`; it raises instead.
- **`removeProjections`** helps many engines and hurts some, and deserves a study rather than the anecdote
  it rests on.
- **Cardinality**: deduplicating a mapping body would make the unfolded query a set, at a cost.
- **Merging SERVICE calls**: a service can absorb a variable amount of computation, so there is a
  composition to choose; `transformServiceCallPushUp` makes one choice.
