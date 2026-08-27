# GAV unfolding and optimization

A library for defining a single GAV mapping as a construct query with one triple template in the head and a body.
A user query targeting the global schema is rewritten to instead target the local schemata by unfolding each triple pattern.

The idea is explained in our [under review, in works paper targeting AMW](https://2026-amw-rewriting.jitsedesmet.be/),
and a [under review demo paper targeting SEMANTiCS](https://2026-semantics-rewriting.jitsedesmet.be/), based on a previous version of this repo.

A conceptual overview of rewriting, specifically targeting the RDF 1.1/1.2 interoperability case is given:
![Schematic overview of query rewriting](assets/schematic-plan.png)

## Overview

Given a query Q without recursive paths and mapping with head H and body B:
1. Rewrite the paths to triple patterns without any paths: `./lib/transformations/pathTransformation.ts`
2. For each triple pattern in the user query, unfold the mapping body within it
  2.1 Unify the mapping head and the body so you get groups of equality between expressions, mapping head variables and triple term variables.
  2.2 B' = FILTER(B) with the equality of mapping head vars that are equal (using rewriteToSingleVar we replace them later)
  2.3 B' = FILTER(B') with the other constraints on the vars we found (equality with a static term)
  2.4 B' = EXTEND(B') with how the triple term vars are constructed from the mapping head vars
  2.5 B' = FILTER(B') assert the triple term vars are assigned.
  2.6 B' = PROJECT(B') what remains accessible are only the triple terms vars
3. rewrite B' to replace equality (sameTerm) between many variables with a single variable that represents this equality.
In case one of the variables is normally constructed using an EXTEND, a FILTER is used instead of a second EXTEND
(`collapseDuplicateExtends`), so the same variable is never bound twice.
4. Replace variables that are assigned to static terms with those terms, again special care is needed when they are used in certain operations such as expressions.
5. group constraints together using pushDownRestrictions, which pushes restrictions down and distributes JOIN over UNION
  5.1 push the assertions down with `pushDownAssertions`: both the `FILTER(sameTerm(?x, term))` constraints of 2.3,
  which substitute their term into the patterns they reach and empty the branches that cannot bind the variable,
  and the `FILTER(sameTerm(?x, ?y))` unifications of 2.2 that 3 left behind, which substitute one variable for the other.
  A chain of unifications is a *clique* of variables that all have to be equal, and it is substituted to the
  lexicographically first member of the clique, with a `BIND` per member replacing the ones it substituted away
  (`?s ?p ?o FILTER(sameTerm(?s, ?o))` becomes `?o ?p ?o . BIND(?o AS ?s)`, keeping `pVars` and `cVars` unchanged).
  The two interact: a term meeting a clique fixes every variable in it at once.
  Two invariants that are not guessable from the code, and are argued for in the `@fileoverview` of the pass:
  a clique is split by *edges* rather than by variables, so that what is pushed down plus what is kept on top spans it
  again; and the weak form (`!bound(?x) || sameTerm(?x, term)`) only exists for a clique pinned to a term,
  a clique without one travelling as the `bound(?x)` it entails of each of its members instead.
6. Prune invalid constraint groups, replacing them with filter false.
  This involves statically evaluating the expression equalities, using both the ClusterSolver (I think), as range and domain of known operations,
  but also using comunica's expression evaluator to evaluate static expressions and optimize the query.
  Certain operations might be fruitful to implement specific prune algorithms for,
  like word equations testing literal concatenations are possible given a variable.
7. optimize filter False expressions by letting them walk up.

To check:
1. projections may cause some engines to behave weird. In that case we should remove projections.
2. Merge service calls. Services can handle a variable amound of computation, given that, we can compose them in various ways.

## How It Works

The rewriter transforms each triple pattern in your BGP (Basic Graph Pattern) into a UNION of subselects, one for each mapping:

![Query rewriting visualization](assets/query-rewritten.jpg)

### Key Architecture Points

1. **Mapping Structure**: Each mapping is a SPARQL CONSTRUCT with:
   - **Head** (template): The RDF 1.2 pattern (can contain triple terms)
   - **Body** (WHERE): The equivalent RDF 1.1 pattern (must be SPARQL 1.1 compatible)

2. **Variable Clustering**: When a user query matches a mapping, variables are unified using a ClusterSolver that determines which variables must be equal and what values they're bound to.

3. **Transformation Pipeline**: Multiple optimization passes can be applied:
   - `operationTransform`: Core BGP-to-UNION rewriting
   - `pushDownAssertions`: Push `sameTerm`/unification assertions down into patterns
   - `transformFilterFalse`: Remove impossible branches (FILTER FALSE)
   - `nullifyJoinOverIncompatibleBounds`: Detect incompatible join conditions
   - `pushUpBoundedFromUnion`: Hoist common bindings out of UNIONs

## Mapping Constraints

- **Single triple in head**: Each mapping must have exactly one triple in the CONSTRUCT template
- **No blank nodes in head**: Use variables instead; blank node templates are supported for skolemization
- **No BNODE() function in body**: Blank node creation in the mapping body is not allowed

## Blank Node Handling (Skolem Functions)

Since underlying RDF 1.1 datasets cannot consistently reference blank nodes across queries, this library supports four skolem types in mapping heads:

1. **TemplateIri**: Construct IRIs from variable values
2. **TemplateLiteral**: Construct typed literals from variable values
3. **TemplateBlank**: Construct consistent blank node identities
4. **TemplateQuad**: Construct triple terms

For TemplateBlank, since actual blank nodes cannot be consistently referenced, the library provides transformations to represent them as:

- [sparql extension function](https://www.w3.org/TR/sparql12-query/#extensionFunctions) `https://sparql-extension.knows.idlab.ugent.be/bnodeConsistent` that can create blank nodes matching the implementation described above.
- **Typed literals**: `internalBnodeAsSpecialLiteral()` - Uses a special datatype
- **Prefixed IRIs**: `internalBnodeAsSpecialIri()` - Uses SHA1 hashing for manageable length

Both approaches ensure "same inputs = same identity" semantics.

## SPARQL Quirks

There is also a [working draft for RDF 1.2 interoperability](https://w3c.github.io/rdf-interop/spec/) describing standard mappings between RDF 1.1 and RDF 1.2.

**Empty groups produce one binding**: An empty group `{}` emits a single binding with no variables bound ([spec reference](https://www.w3.org/TR/sparql11-query/#emptyGroupPattern)).

- `SELECT * {}` → 1 binding
- `SELECT * { {} UNION {} }` → 2 bindings
- `SELECT * { FILTER(FALSE) }` → 0 bindings

This means a mapping that doesn't match uses `FILTER(FALSE)` (zero results), not an empty group.

## Benchmarking across SPARQL engines

The [`test/bench`](test/bench) directory contains a system that benchmarks the
rewriting approach against **native SPARQL 1.2 evaluation** on multiple engines,
using the BKR reification benchmark datasets.

Only three well-known engines currently implement SPARQL 1.2 with the new RDF 1.2
triple-term syntax (`<<( s p o )>>` / `rdf:reifies`): **Comunica** (≥ 5.0),
**Apache Jena/Fuseki** (≥ 4.10, default syntax) and **Oxigraph** (≥ 0.5). RDF4J and
GraphDB only support the older RDF-star `<< >>` syntax, while QLever, Blazegraph,
Stardog and Virtuoso are SPARQL 1.1 only. SPARQL 1.2 / RDF 1.2 remain W3C Working
Drafts as of mid-2026.

```bash
# Comunica only (in-process, no external services):
npx tsx test/bench/cli.ts --pattern reification --limit 5

# Also benchmark Fuseki / Oxigraph endpoints that have the dataset loaded:
npx tsx test/bench/cli.ts --pattern reification \
  --fuseki http://localhost:3030/bkr/sparql \
  --oxigraph http://localhost:7878/query --json results.json
```

See [`test/bench/README.md`](test/bench/README.md) for the full engine survey and
instructions. The harness is validated by `test/bench.test.ts`.

## API Reference

### Core Functions

| Function                                          | Description                                    |
|---------------------------------------------------|------------------------------------------------|
| `transformContextFromConstructs(mappings)`        | Create a context from CONSTRUCT query strings  |
| `queryTransform(context, query, transformations)` | Rewrite a query with the given transformations |
| `operationTransform(context, operation)`          | Core BGP rewriting transformation              |

### Optimization Transformations

| Transformation                         | Description                                                                                                                                                                                                                        |
|-----------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `nullifyJoinOverIncompatibleBounds`    | Replace incompatible join branches with FILTER(FALSE)                                                                                                                                                                             |
| `pushUpBoundedFromUnion`               | Hoist common bindings out of UNION branches                                                                                                                                                                                       |
| `pushDownAssertions`                   | Push assertion filters (`FILTER(sameTerm(?x, c))`) as deep as possible: substitute the term into BGPs and paths, prune VALUES rows, empty UNION branches that cannot bind the variable, and turn an OPTIONAL over an asserted variable into a plain join |
| `rewriteNonRecursivePaths`             | Expand property paths into BGPs                                                                                                                                                                                                   |
| `transformFilterFalse`                 | Remove FILTER(FALSE) branches and simplify                                                                                                                                                                                        |

### Blank Node Transformations

| Transformation                  | Description                             |
|---------------------------------|-----------------------------------------|
| `internalBnodeAsSpecialLiteral` | Represent blank nodes as typed literals |
| `internalBnodeAsSpecialIri`     | Represent blank nodes as prefixed IRIs  |

## License

Everything is [MIT licensed](LICENSE.txt) except where noted otherwise, notably,
the `/test/statics/REF-Benchmark` folder is copied from the [REF-Benchmark](https://github.com/dgraux/RDFStarObservatory) repository,
and is [Apache licenced](test/statics/REF-Benchmark/LICENSE).
