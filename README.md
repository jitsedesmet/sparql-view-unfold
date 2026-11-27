# SPARQL view unfolding

[![CI](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml/badge.svg)](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml)

A *view* is a set of SPARQL CONSTRUCT queries over your data.
This library answers SPARQL queries over a view,
by rewriting them into queries over your data that any SPARQL engine can run.
Your data stays as it is.

It was built to run SPARQL 1.2 queries, triple terms and all, over RDF 1.1 data:
the view says how the RDF 1.1 data represents RDF 1.2, and the rewritten query is plain SPARQL 1.1.
Our [SEMANTiCS 2026 demo paper](https://2026-semantics-rewriting.jitsedesmet.be/) explains the idea,
and you can [try the demo](https://2026-query-rewriting.demo.jitsedesmet.be/).
[ARCHITECTURE.md](ARCHITECTURE.md) explains the code.

## Usage

```bash
npm install sparql-view-unfold
```

Turn the view's CONSTRUCT queries into a *mapping*, the form the rewriter reads,
then build a rewriter and rewrite your query:

```typescript
import {
  createDefaultTransformationPipeline,
  createQueryRewriter,
  mappingFromConstructQueries,
} from 'sparql-view-unfold';

const mapping = mappingFromConstructQueries([
  // Every RDF 1.1 reification is a triple term reified by its statement node.
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
   CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE {
     ?t rdf:type rdf:Statement ; rdf:subject ?s ; rdf:predicate ?p ; rdf:object ?o .
   }`,
  // Every data triple is kept as is. The filter tells the rewriter that these hold no triple terms.
  `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }`,
]);

const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mapping));

const sparql11Query = await rewriter.rewriteQuery(`
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`);
```

Run `sparql11Query` on your RDF 1.1 data with any SPARQL 1.1 engine.
Your data must not hold blank nodes: skolemise them into IRIs first (see [Restrictions](#restrictions)).
A rewriter keeps no state between queries, so build it once and reuse it.

### Options

- **Count each view triple once.**
  By default, a triple the view's `WHERE` clause finds twice counts twice,
  so a `COUNT(*)` can be higher than over the view itself.
  `createDefaultTransformationPipeline(mapping, { preserveCardinality: true })` counts it once.
  That is slower, or much faster when the view finds many duplicates.
- **Generalized RDF.**
  A view triple with a term where RDF does not allow one, such as a literal subject, is left out, as a CONSTRUCT would.
  `mappingFromConstructQueries(views, { generalizedRdfView: true })` keeps it.
  The rewritten query builds the view's triple terms with `TRIPLE()`,
  so it then needs an engine whose `TRIPLE()` takes any term, such as Comunica with `rdfVariant: 'generalizedRdf'`.
- **Engines that extend SPARQL.**
  The rewriter assumes the SPARQL operator tables, for example that `STR(?x)` gives a literal.
  If your engine extends an operator, pass an [`expressionRange`](https://jitsedesmet.github.io/sparql-view-unfold/)
  to `createQueryRewriter` and `mappingFromConstructQueries`.
- **Your own pipeline.**
  `createDefaultTransformationPipeline` returns the list of transformations the rewriter runs, in order.
  Add to it, as the next sections do,
  or build your own from the `…Transformation()` functions in the [API documentation](https://jitsedesmet.github.io/sparql-view-unfold/).
  The order matters: ARCHITECTURE.md says why.

### Blank nodes in a view

A view cannot use `BNODE()`: the rewritten query runs parts of a view more than once,
and `BNODE()` gives a new node each time.
Use `<internal://blank>(?a, ?b, …)` instead: the same arguments always give the same node.
End the pipeline with `internalBnodeAsSpecialIriTransformation()`, which turns those nodes into IRIs,
or with `internalBnodeAsSpecialLiteralTransformation()` for literals.
Without it, the rewritten query calls `<internal://blank>`, which no engine knows.
These build the node in SPARQL, which handles triple terms up to two levels deep.
With Comunica, let the engine build them instead, at any depth:

```typescript
import { QueryEngine } from '@comunica/query-sparql-file';

const rewriter = createQueryRewriter([
  ...createDefaultTransformationPipeline(mapping),
  internalBnodeAsSpecialIriTransformation({ encodedByExtensionFunction: true }),
]);
const bindings = await new QueryEngine().queryBindings(await rewriter.rewriteQuery(query), {
  sources,
  extensionFunctions: internalBnodeExtensionFunctions(),
});
```

### Provenance

Why is an answer an answer?
For a `SELECT` over a view, the rewriter can tell you which triples of your data each answer rests on.
It follows [SPARQLprov](https://doi.org/10.14778/3484224.3484235).

Take this data, in `colleagues.ttl`:

```turtle
@prefix : <ex://> .
:alice :knows :bob .
:bob :worksAt :ugent , :imec .
:carol :worksAt :ugent , :imec .
:dave :worksAt :ugent .
```

The view below keeps every triple, and adds a `:colleague` triple between two people who work at the same place.
It produces `:bob :colleague :carol` in two ways: through UGent and through imec.
Each way is a *derivation*: one solution of the view's `WHERE` clause.
Getting the provenance of a query takes three steps:

1. `provenanceCapturingQuery(query)` rewrites the query to also select how each answer was derived.
   It returns that query, and the prefix of the variables that hold the provenance.
2. Rewrite that query over the *provenance view*, which `provenanceMappingFromConstructQueries(view)` builds,
   and run it on your data.
   The provenance view is the view plus, for each derivation, the view triple it produces (`provenance:derivationOf`)
   and the data triples it matched (`provenance:derivedFrom`).
3. `decodeProvenance(rows, prefix)` turns the rows into a *polynomial* per row: a formula over derivations.
   Some rows are not answers, so check `isAnswer` (more below).

A derivation is an IRI that holds its solution,
so `createDerivationDecoder(view)` can read it back into the data triples it matched and the view triples it produces,
without another query.

```typescript
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string';
import {
  createDefaultTransformationPipeline,
  createDerivationDecoder,
  createQueryRewriter,
  decodeProvenance,
  internalBnodeAsSpecialIriTransformation,
  internalBnodeExtensionFunctions,
  polynomialToString,
  provenanceCapturingQuery,
  provenanceMappingFromConstructQueries,
} from 'sparql-view-unfold';

const view = [
  'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  'PREFIX : <ex://> CONSTRUCT { ?x :colleague ?y } WHERE { ?x :worksAt ?org . ?y :worksAt ?org . FILTER(?x != ?y) }',
];

// The pipeline ends by turning derivations and other internal nodes into IRIs.
const rewriter = createQueryRewriter([
  ...createDefaultTransformationPipeline(provenanceMappingFromConstructQueries(view)),
  internalBnodeAsSpecialIriTransformation({ encodedByExtensionFunction: true }),
]);
const capture = provenanceCapturingQuery('PREFIX : <ex://> SELECT ?c WHERE { :alice :knows ?f . ?f :colleague ?c }');
const rows = await new QueryEngine().queryBindings(await rewriter.rewriteQuery(capture.query), {
  sources: [ 'colleagues.ttl' ],
  extensionFunctions: internalBnodeExtensionFunctions(),
});
const answers = decodeProvenance(await rows.toArray(), capture.provenanceVariablePrefix);

// Write a derivation as the data triples it matched.
const decodeDerivation = createDerivationDecoder(view);
const sourcesOf = (derivation: RDF.Term): string =>
  `[${decodeDerivation(derivation).sourceTriples.map(triple => termToString(triple)).join(', ')}]`;

for (const { answer, polynomial, isAnswer } of answers) {
  console.log(termToString(answer.get('c')), isAnswer, polynomialToString(polynomial, sourcesOf));
}
```

This prints:

```text
ex://carol true (([<<ex://bob ex://worksAt ex://imec>>, <<ex://carol ex://worksAt ex://imec>>] ⊕ [<<ex://bob ex://worksAt ex://ugent>>, <<ex://carol ex://worksAt ex://ugent>>]) ⊗ [<<ex://alice ex://knows ex://bob>>])
ex://dave true ([<<ex://alice ex://knows ex://bob>>] ⊗ [<<ex://bob ex://worksAt ex://ugent>>, <<ex://dave ex://worksAt ex://ugent>>])
```

Carol is an answer because Alice knows Bob, *and* Bob works with Carol at imec *or* at UGent.
The other operators come from other parts of a query:

| Operator | Meaning | Comes from |
|---|---|---|
| `a ⊗ b` | needs both | a join |
| `a ⊕ b` | either is enough | `UNION`, or two derivations of one view triple |
| `a ⊖ b` | `a`, unless `b`; `b` is `0` when nothing matched | `MINUS`, `NOT EXISTS`, `OPTIONAL`, and `EXISTS` as `a ⊖ (a ⊖ b)` |
| `δ(a)` | a group computed from `a` | `GROUP BY` |
| `1` | needs no view triple | `VALUES`, `SERVICE` |

The rows also hold *non-answers*: the rows a `MINUS` or `NOT EXISTS` removed,
and for an `OPTIONAL` that matched, the row without the match.
Their `isAnswer` is `false`, and their polynomial says why.

To compute with a polynomial, `evaluatePolynomial(polynomial, semiring, valueOf)`
gives each derivation a value with `valueOf`, and combines those values as the semiring says for each operator.
For example, `countingSpmSemiring` with `() => 1` counts the ways an answer is derived: 2 for Carol.
[ARCHITECTURE.md](ARCHITECTURE.md#provenance) lists the limits.

## Restrictions

| Restriction | If you break it |
|---|---|
| No `+` or `*` property path in the query (`?`, `\|`, `/`, `^` and `!` are fine) | The rewrite throws. |
| No `GRAPH` in the query | The rewrite throws. |
| No `BNODE`, `RAND`, `UUID` or `STRUUID` in a view (`NOW` is fine) | Building the mapping throws. |
| No blank nodes in your data: skolemise them into IRIs first | **Silently wrong answers**: the rewritten query loses the triples reached through a blank node. |

Some queries work, but mean something you might not expect:

- `DESCRIBE` describes the resources in your data, not in the view.
- In an update, only the `WHERE` reads the view.
  `INSERT` and `DELETE` write to your data exactly as written: the view itself cannot be written to.
- Nothing inside a `SERVICE` is rewritten: the endpoint answers over its own data.

## API

The [API documentation](https://jitsedesmet.github.io/sparql-view-unfold/) has every function and transformation.
These are the ones to start from:

| Function | What it does |
|---|---|
| `mappingFromConstructQueries(views, options?)` | Builds the mapping of a view. |
| `createDefaultTransformationPipeline(mapping, options?)` | The transformations to use when you have no reason to pick your own. |
| `createQueryRewriter(transformations, options?)` | Builds a rewriter that runs those transformations in order. |
| `rewriter.rewriteQuery(query)` | Rewrites a query string. `rewriteOperation` does the same for [Traqula](https://github.com/comunica/traqula) algebra. |
| `provenanceMappingFromConstructQueries(views, options?)` | Builds the provenance view of a view. |
| `provenanceCapturingQuery(query)` | Rewrites a `SELECT` to also select how each answer was derived. |
| `decodeProvenance(rows, provenanceVariablePrefix)` | Turns the rows of that query into a polynomial per answer or non-answer. |
| `evaluatePolynomial(polynomial, semiring, valueOf)` | Computes a value from a polynomial, such as a count. |
| `createDerivationDecoder(views, options?)` | Reads a derivation back into its solution, and the triples it matched and produces. |

## Cite

If you are using or extending sparql-view-unfold as part of a scientific publication,
we would appreciate a citation of our [article](https://2026-semantics-rewriting.jitsedesmet.be/).

```bibtex
@inproceedings{De_Smet_Demonstration_of_RDF_2026,
    address = {Ghent, BE},
    author = {De Smet, Jitse and Jakubowski, Maxime},
    booktitle = {Companion Volume of the 22nd International Conference on Semantic Systems (SEMANTiCS-C 2026)},
    month = sep,
    publisher = {CEUR-WS.org},
    series = {CEUR Workshop Proceedings},
    title = {{Demonstration of RDF and SPARQL 1.2 Interoperability through Query Rewriting}},
    url = {https://2026-semantics-rewriting.jitsedesmet.be/},
    volume = {4293},
    year = {2026}
}
```

## License

Everything is [MIT licensed](LICENSE.txt) except where noted otherwise, notably,
the `/test/statics/REF-Benchmark` folder is copied from the [REF-Benchmark](https://github.com/dgraux/RDFStarObservatory) repository,
and is [Apache licensed](test/statics/REF-Benchmark/LICENSE).
