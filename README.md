# SPARQL view unfolding

[![CI](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml/badge.svg)](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml)

Answers SPARQL 1.2 queries posed over views, by rewriting them into queries over the data those views are
defined on.

A view is a SPARQL CONSTRUCT query — a GAV mapping: its template says which triples the view holds, its
WHERE clause how they are found in your data. The rewriter *unfolds* that view into every triple pattern of
a user query, handing you back a query any SPARQL engine can answer, and a chain of optimisations then cuts the resulting query complexity to something worth executing, again generating a query any engine can execute.

Running SPARQL 1.2 queries — triple terms and all — against RDF 1.1 data one case it was built for, and
the one the example below uses: a view says how your RDF 1.1 data can conceptually be mapped to RDF 1.2, and the rewrite hands you plain SPARQL 1.1. The idea is explained in our
[demo paper targeting SEMANTiCS](https://2026-semantics-rewriting.jitsedesmet.be/).

> **Alpha.** The API is a context plus a list of transformation functions, and is being reworked into a
> rewriter holding a pipeline. Expect it to change.

## Installation

```bash
npm install sparql-view-unfold
```

## Usage

```typescript
import {
  operationTransform,
  pullUpExtends,
  queryTransform,
  removeProjections,
  transformContextFromConstructs,
  transformFilterFalse,
} from 'sparql-view-unfold';

const context = transformContextFromConstructs([
  // Every RDF 1.1 reification is a triple term reified by its statement node.
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
   CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE {
     ?t rdf:type rdf:Statement ; rdf:subject ?s ; rdf:predicate ?p ; rdf:object ?o .
   }`,
  // Every other triple is itself.
  `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }`,
]);

const sparql11Query = queryTransform(
  context,
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
   SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`,
  [ operationTransform, transformFilterFalse, pullUpExtends, removeProjections ],
);
```

`operationTransform` is the rewriting; everything after it is optimisation, applied in the order you list
it. Put `rewriteNonRecursivePaths` before it if your queries use paths, and `pushDownAssertions` after it
for a flat query rather than nested sub-selects. Every transformation is a
`(context, operation) => operation` over [Traqula](https://github.com/comunica/traqula) algebra, so they
apply to algebra you already hold just as well. The full list is in the
[API documentation](https://jitsedesmet.github.io/sparql-view-unfold/).

## Restrictions

These give **wrong answers silently**, so check them before trusting the output:

- A recursive property path (`+`, `*`) is left in place, and so is evaluated against the underlying data,
  unmapped. The other path operators are fine.
- `GRAPH` unfolds the pattern inside it but drops the graph variable.
- A blank node in the underlying data cannot be referenced across the sub-queries the unfolding produces.
  Skolemise before querying.
- Cardinality is not preserved: the unfolded query is a bag, so `COUNT(*)` can disagree with the mapped
  graph. This can be fixed by using a single mapping using `?s ?p ?o` as a head and wrapping the body in `DICTINCT(?s ?p ?o)`.

A mapping is checked, and throws: its template holds exactly one triple, its head holds no blank node, and
its body does not call `BNODE()`. To construct a blank node identity, call `<internal://blank>(?a, ?b, …)`
in the body and add `internalBnodeAsSpecialIri` or `internalBnodeAsSpecialLiteral` to your chain.

## License

Everything is [MIT licensed](LICENSE.txt) except where noted otherwise, notably,
the `/test/statics/REF-Benchmark` folder is copied from the [REF-Benchmark](https://github.com/dgraux/RDFStarObservatory) repository,
and is [Apache licenced](test/statics/REF-Benchmark/LICENSE).
