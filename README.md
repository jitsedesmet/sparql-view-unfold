# SPARQL view unfolding

[![CI](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml/badge.svg)](https://github.com/jitsedesmet/sparql-view-unfold/actions/workflows/ci.yml)

Answers SPARQL 1.2 queries posed over views, by rewriting them into queries over the data those views are
defined on.

A view is a SPARQL CONSTRUCT query — a GAV mapping: its template says which triples the view holds, its
WHERE clause how they are found in your data. The rewriter *unfolds* that view into every triple pattern of
a user query, handing you back a query any SPARQL engine can answer, and a pipeline of optimisations then
cuts the result down to something worth executing.

Running SPARQL 1.2 queries — triple terms and all — against RDF 1.1 data is one case it was built for, and
the one the examples below use: a view says how your RDF 1.1 data represents RDF 1.2, and the rewrite hands
you plain SPARQL 1.1.

The idea is explained in our [under review, in works paper targeting AMW](https://2026-amw-rewriting.jitsedesmet.be/)
and in an [under review demo paper targeting SEMANTiCS](https://2026-semantics-rewriting.jitsedesmet.be/),
based on a previous version of this repository. [ARCHITECTURE.md](ARCHITECTURE.md) maps the code.

> **Alpha.** Published as `0.0.0-alpha.0`, to claim the name. The API is a rewriter holding a pipeline of
> transformations; expect it to change.

## Installation

```bash
npm install sparql-view-unfold
```

or

```bash
yarn add sparql-view-unfold
```

## Import

Either through ESM import:

```typescript
import { createQueryRewriter } from 'sparql-view-unfold';
```

_or_ CJS require:

```typescript
const createQueryRewriter = require('sparql-view-unfold').createQueryRewriter;
```

## Usage

A mapping is one or more CONSTRUCT queries. Hand them to `mappingFromConstructQueries`, hand the mapping to
`createDefaultTransformationPipeline`, and rewrite:

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
  // Every other triple is itself.
  `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }`,
]);

const rewriter = createQueryRewriter(createDefaultTransformationPipeline(mapping));

const sparql11Query = await rewriter.rewriteQuery(`
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`);
```

A rewriter is reusable and holds no per-query state, so build it once and rewrite many queries with it.

### Building your own pipeline

The default pipeline is a list of transformations, and nothing stops you writing your own. Each step is a
`<stem>Transformation()` factory, so the pipeline reads as a uniform list; only the unfolding takes
arguments, because only it needs the mapping:

```typescript
import {
  createQueryRewriter,
  filterFalseTransformation,
  mappingFromConstructQueries,
  pullUpExtendsTransformation,
  pushDownAssertionsTransformation,
  rewriteNonRecursivePathsTransformation,
  unfoldingTransformation,
} from 'sparql-view-unfold';

const rewriter = createQueryRewriter([
  rewriteNonRecursivePathsTransformation(),
  unfoldingTransformation(mappingFromConstructQueries([ myConstructQuery ]), { preserveCardinality: false }),
  filterFalseTransformation(),
  pushDownAssertionsTransformation(),
  filterFalseTransformation(),
  pullUpExtendsTransformation(),
  filterFalseTransformation(),
]);
```

Order matters and is not a preference: paths are expanded before the unfolding, which only knows triple
patterns, and `nullifyJoinOverIncompatibleBoundsTransformation` sees nothing until `removeProjections` and
`pullUpExtends` have run. [ARCHITECTURE.md](ARCHITECTURE.md) says why for each step.

### Cardinality

By default the unfolded query treats the virtual RDF 1.2 graph as a **bag**: where two solutions of the
mapping body produce the same triple, it is counted twice, and a `COUNT(*)` disagrees with the mapped graph.
`unfoldingTransformation(mapping, { preserveCardinality: true })` deduplicates the mapping body so each
triple is produced once. It is **hugely costly** — every unfolded pattern materialises and sorts its whole
body, where it otherwise streams — so turn it on only when the multiplicity of a solution is part of the
answer you need.

### Generalized RDF

By default the mapping denotes a standard RDF graph: a solution binding a head variable to a term its
position cannot hold — a literal subject, a blank node predicate — instantiates no triple, exactly as the
CONSTRUCT the mapping is written as would not. `mappingFromConstructQueries(constructs, {
generalizedRdfView: true })` keeps those triples instead, for a view that means to present generalized RDF.

### Blank nodes

An RDF 1.1 dataset cannot reference a blank node consistently across queries, so a mapping that has to
construct a blank node identity uses the extension function `<internal://blank>(?a, ?b, …)`: the same inputs
always give the same identity. Add `internalBnodeAsSpecialLiteralTransformation()` or
`internalBnodeAsSpecialIriTransformation()` to your pipeline to materialise those identities as a typed
literal or as a prefixed IRI respectively.

## Restrictions

| Restriction | What happens when you break it |
|---|---|
| No `+` or `*` property path in the user query | The rewrite throws. A recursive path cannot be expanded into triple patterns, so the mapping could not be unfolded into it. `?`, `|`, `/`, `^` and `!(…)` are all fine. |
| No `GRAPH` in the user query | The rewrite throws. What unfolding a mapping inside a named graph means is not settled. |
| No unstable function (`BNODE`, `RAND`, `UUID`, `STRUUID`) in a mapping body | Building the mapping throws, naming the function. A mapping has to denote one fixed graph, and those answer differently on every evaluation. `NOW` is allowed: SPARQL 1.1 §17.4.5.1 fixes it per query execution. |
| A mapping head holds exactly one triple | Nothing — `mappingFromConstructQueries` splits a larger CONSTRUCT template into one mapping per triple for you, which denotes the same graph. |
| No blank nodes in the RDF 1.1 dataset, unless skolemised | **Wrong answers, silently.** A blank node cannot be referenced across the sub-queries the unfolding produces, so triples reached through one are lost. Skolemise them into IRIs before querying. |

`DESCRIBE` is supported, with the caveat inherent to it: a `DESCRIBE` answers with a description of the
data it is run against, so a rewritten one describes its resources in RDF 1.1. It selects the same
resources the query over the mapped data would.

Updates are supported, with the caveat inherent to *them*: only the `WHERE` reads the RDF 1.2 graph, and
only the `WHERE` is rewritten. That graph is virtual, so nothing can be written to it — an `INSERT` or
`DELETE` template goes to the RDF 1.1 source exactly as you wrote it, with its variables bound by the
rewritten `WHERE`. Writing RDF 1.2 through the mapping is a different problem (the view update problem) and
is not what this does.

## API

The tables below are the short version; the generated
[API documentation](https://jitsedesmet.github.io/sparql-view-unfold/) has the full signatures.

| Function | Description |
|---|---|
| `mappingFromConstructQueries(constructQueries, options?)` | Builds the `Mapping` a set of CONSTRUCT query strings denotes. The only way to build one. |
| `createQueryRewriter(transformations)` | Builds a `QueryRewriter` running those transformations, in order. |
| `createDefaultTransformationPipeline(mapping, options?)` | The pipeline to use when you have no reason to build your own. |
| `rewriter.rewriteQuery(query)` | Rewrites a SPARQL query string, asynchronously. |
| `rewriter.rewriteOperation(operation)` | The same over SPARQL algebra, for callers already holding some. |

| Transformation | Description |
|---|---|
| `unfoldingTransformation(mapping, options?)` | The rewriting proper: every triple pattern replaced by the mapping body producing the triples it could match. |
| `rewriteNonRecursivePathsTransformation()` | Expands non-recursive property paths into BGPs and UNIONs. Belongs before the unfolding. |
| `filterFalseTransformation()` | Lets every `FILTER(FALSE)` absorb what stands over it, sub-SELECTs included. |
| `pushDownAssertionsTransformation()` | Pushes `FILTER(sameTerm(?x, c))` as deep as it goes: substituting into BGPs and paths, pruning VALUES rows, emptying UNION branches, turning an OPTIONAL over an asserted variable into a plain join. |
| `pullUpExtendsTransformation()` | Floats every `BIND` as high as the plan allows and drops the ones nothing reads. |
| `removeProjectionsTransformation()` | Removes inner projections, renaming what they hid to keep the scoping. |
| `nullifyJoinOverIncompatibleBoundsTransformation()` | Replaces a join whose branches bind one variable to incompatible terms by `FILTER(FALSE)`. |
| `nullifyUnbindableVarsTransformation()` | The same one level up, for incompatible term *types* rather than terms. Not in the default pipeline. |
| `extendsToValuesTransformation()` | Rewrites a `BIND` of a ground term over the empty BGP, or over a VALUES, into a VALUES. |
| `joinValuesToFilterTransformation()` | Rewrites a JOIN with a VALUES into an equality FILTER, enabling further push-down. |
| `simplifyStaticExpressionsTransformation()` | Folds every fully static expression to the term Comunica's evaluator says it is. |
| `serviceCallPushUpTransformation()` | Merges and hoists SERVICE calls so the endpoint evaluates as much as it can. |
| `internalBnodeAsSpecialLiteralTransformation()` | Materialises constructed blank node identities as typed literals. |
| `internalBnodeAsSpecialIriTransformation()` | Materialises them as prefixed IRIs, SHA-1 keeping the length manageable. |

## License

Everything is [MIT licensed](LICENSE.txt) except where noted otherwise, notably,
the `/test/statics/REF-Benchmark` folder is copied from the [REF-Benchmark](https://github.com/dgraux/RDFStarObservatory) repository,
and is [Apache licenced](test/statics/REF-Benchmark/LICENSE).
