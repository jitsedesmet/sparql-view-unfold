# Cross-engine SPARQL 1.2 benchmark

This directory benchmarks the query-rewriting approach of this library against the two
alternatives a user actually has, across three SPARQL engines.

It runs three workloads. **StarBench** (the BKR reification benchmark) is what most of this file is
about: SPARQL 1.2 queries over RDF 1.1 data. **LUBM** and **OAEI Conference** are plain SPARQL 1.1
workloads added next to it, one doing reasoning by rewriting and one translating between
vocabularies. They are described in [LUBM and OAEI Conference](#lubm-and-oaei-conference).

## What it measures

A SPARQL 1.2 user query (RDF 1.2 triple terms / `rdf:reifies`) against data that is
physically stored as RDF 1.1 can be answered in two ways:

1. **rewriting** — rewrite the query into an equivalent **SPARQL 1.1** query with this
   library, using the CONSTRUCT mappers that expose the RDF 1.1 data as an RDF 1.2 view,
   and run that over the materialized RDF 1.1 data. Works on any SPARQL 1.1 engine.
2. **materialized** — hand-write a SPARQL 1.1 query directly against the RDF 1.1
   representation. This is what people do today, and it is the bar the rewriting has to
   be judged against: it is both the speed target and the correctness oracle.

Four rewrite pipelines are measured, each the one before it plus one transformation, so the
difference between two adjacent bars is the contribution of that transformation:

| Approach | Pipeline |
|---|---|
| `rewriting` | `unfolding` → `filterFalse` → `nullifyJoinOverIncompatibleBounds` → `filterFalse` |
| `rewriting+removeProjections` | the above, then `removeProjections` (flattens the nested sub-`SELECT`s each mapper branch is wrapped in) |
| `rewriting+pushDownAssertions` | `rewriting`, then `pushDownAssertions` → `filterFalse` → `removeProjections` (pushes `FILTER(sameTerm(?x, c))` into the triple patterns that use `?x`, turning a free position into an indexed lookup) |
| `rewriting+pullUpExtends` | `rewriting`, then `pushDownAssertions` → `filterFalse` → `pullUpExtends` → `filterFalse` → `removeProjections` → `pullUpExtends` (floats the `BIND`s the pushdown leaves at every leaf back up, or drops them) |

Each name above is the `<stem>Transformation()` factory of that stem; see `runner.ts` for the exact
composition, and for why `removeProjections` stays a step of the pushdown pipelines even though
Traqula 1.3.1 no longer needs it to keep their output parseable.

In the two pushdown pipelines `removeProjections` runs after the pushdown, not before it, so it also
flattens whatever the pushdown leaves. A further `removeProjections` at the end of either pipeline
(or one more `removeProjections` → `pullUpExtends` round after the last pass) changes none of the 204
rewrites (102 queries, `preserveCardinality` off and on). The sub-`SELECT`s that remain are the
`SELECT DISTINCT` that `preserveCardinality` adds around each view pattern, and the aggregates of
StarBench's A-Q3 and A-Q4, which `removeProjections` keeps by design.

None of the four is the pipeline `createDefaultTransformationPipeline` builds, which is what a user of
the library gets by default: that one expands property paths first, runs `pullUpExtends` once and
`nullifyJoinOverIncompatibleBounds` last. The ladder here is built to isolate one pass at a time, not
to be the recommended configuration.

### How the mappers are read

The mappings are built with the standard RDF view (`generalizedRdfView: false`), the library's default.
A solution that binds a head variable to a term a standard RDF graph cannot hold in that position, such
as a literal subject or a blank-node predicate, is filtered out by `isIRI`/`isBlank` guards. BKR, LUBM
and OAEI are standard RDF, so the guards never remove a row; what they cost is part of every number here.

Runs before the campaign of 2026-10-22 used `generalizedRdfView: true`, which leaves the guards out (see
"History"). Against that setting, the standard view changes the StarBench rewrites only in the two
pipelines before the pushdown. It changes 9 of the 13 LUBM rewrites and 19 of the 65 OAEI ones at every
rung. `run.ts` uses the standard view; `--rdf-views standard,generalized` runs both back to back.

## Reading the output

Every row in the results JSON is one (engine, scheme, scale, query, approach)
measurement. Three fields decide how to read it:

- **`status`** is `ok`, `timeout` or `error`. A `timeout` row is **censored**, not
  missing: the query took *at least* `timeoutMs`, and nothing more is known. The plots
  draw it at the budget, hatched and marked `≥`, and dash any aggregate that contains
  one. This matters more than it sounds — the slowest runs are exactly the ones that
  time out, so dropping them makes an approach look *better* the more often it fails,
  and lets a scaling line fall as the dataset grows.
- **`correct`** compares this approach's solution multiset against the case's reference
  answer, and **`referenceApproach`** says which approach supplied it: the hand-written
  `materialized` baseline, or `rewriting` as a fallback when the case has no baseline or
  the baseline itself failed. The baseline is plain SPARQL 1.1 over plain RDF 1.1 with no
  triple terms anywhere, which makes it the one query in the set that an engine's RDF 1.2
  support cannot get wrong. `null` means unknown — no reference could be computed, or the
  row *is* the reference. On LUBM and OAEI the reference is the original query over the
  materialised views instead (see [How the reference is built](#how-the-reference-is-built)).
- **`correctAsSet`** compares the *distinct* rows. It differs from `correct` only when an answer repeats a
  row more often than the reference does.
- **`preserveCardinality`** is `true` on a rewriting run with that option, and absent otherwise.
  **`generalizedRdfView`** is `false` on a rewriting run with the standard RDF view, and absent on one run
  with the generalised view. Neither is set on a `materialized` row, whose query does not depend on them.
- **`quads`** is the size of the subset the row ran against, measured per file and shared
  by every engine; it is the x-axis of the scaling plot.

A note on `reps`: `--reps 3 --reps-below 10000` runs a query three times if its first run took under
10 s, and once otherwise. `medianMs` is the median of the runs and `minMs` the fastest. Without the flags a
query runs once, with no warm-up. Query-to-query ratios within one run are the signal here; small
differences between runs are not.

## Which engines support SPARQL 1.2? (survey, July 2026)

SPARQL 1.2 / RDF 1.2 are **W3C Working Drafts** (not yet Recommendations; the RDF-star WG
is chartered until April 2027). Triple terms use the new `<<( s p o )>>` syntax with
`rdf:reifies`; the old RDF-star `<< s p o >>` reifier syntax is being retired but still
parses, which is why the BKR-star query files can be fed to the rewriter verbatim.

| Engine | SPARQL 1.2 native | New `<<( )>>` syntax | Min version | How to drive it |
|---|---|---|---|---|
| **Comunica** | ✅ full | ✅ | 5.0.0 (Jan 2026) | npm library (`@comunica/query-sparql*`) — long-lived worker process here |
| **Apache Jena / Fuseki** | ✅ full (default) | ✅ | 4.10+ (rec. 5.x/6.x) | Java, Fuseki HTTP SPARQL endpoint over TDB2 here |
| **Oxigraph** | ✅ full | ✅ | 0.5.0 (2025) | Rust binary, its HTTP server over an on-disk store here |
| Eclipse RDF4J | ✅ from 6.0 | ✅ from 6.0 | 6.0.0 | (not driven here) |
| **Ontotext GraphDB** | ⚠️ old `<< >>` only | ❌ | — | 11.5 still on RDF4J 5.3; Java server over its repository here; runs the LUBM and OAEI workloads only |
| **QLever** | ❌ SPARQL 1.1 only | ❌ | — | C++ server over its own index here; runs the LUBM and OAEI workloads only |
| **Blazegraph** | ❌ own RDF* (RDR) only | ❌ | — | Java server over its journal here; runs the LUBM and OAEI workloads only |
| **Virtuoso** | ❌ SPARQL 1.1 only | ❌ | — | C server over its database here; runs the LUBM and OAEI workloads only |
| Stardog, MillenniumDB | ❌ SPARQL 1.1 only | ❌ | — | not usable for native SPARQL 1.2 |

Verified directly (2026-08-27): **Fuseki 6.2.0** parses and evaluates `<<( s p o )>>`
natively and returns triple terms in SPARQL Results JSON via the `"type": "triple"`
extension. Its class files require a **Java 21+** runtime (it fails to start under Java 17
with `UnsupportedClassVersionError`, class file version 65 vs. 61); the 4.10.x line targets
older bytecode and works with Java 11/17.

- SPARQL 1.2 Query WD: <https://www.w3.org/TR/sparql12-query/>
- SPARQL 1.2 test suite: <https://w3c.github.io/rdf-tests/sparql/sparql12/>
- Comunica 5.0 (SPARQL 1.2): <https://comunica.dev/blog/2026-01-07-release_5_0/>
- Oxigraph 0.5 (RDF 1.2): <https://github.com/oxigraph/oxigraph/blob/main/CHANGELOG.md>
- Jena `syntaxSPARQL_12`: `jena-arq/.../org/apache/jena/query/Syntax.java`

## Files

| File | Purpose |
|---|---|
| `run.ts` | The orchestrator: for every engine × scheme × scale it runs the four pipelines and the baseline over the *same* subset, grades them against the reference answer, and writes the results JSON. Flushes after every row, so an interrupted run still leaves usable JSON. |
| `runner.ts` | `rewriteToSparql11(mappers, query, variant)` — the core rewrite call, async as `QueryRewriter.rewriteQuery` is, where `variant` selects one of the four pipelines — plus `sameSolutions()` and a simpler single-engine `runBenchmark()`/`formatRecords()` used by `cli.ts`. |
| `config.ts` | Maps each reification pattern (`reification` → `BKR-Reification.ttl`/`BKR-R_*.rq`, `singleton` → `BKR-Singleton.ttl`/`BKR-S_*.rq`) to its CONSTRUCT mappers, materialized dataset and hand-written baseline query, and builds cases from `queries/BKR-star_*.rq`. Also lists the LUBM and OAEI workloads (`WORKLOADS`): their views, queries, and each scale's source and materialised-views files. |
| `engines.ts` | `BenchEngine` interface + `ComunicaEngine` (a long-lived worker process per dataset, so the store is loaded and indexed once and the engine stays warm, while a query whose join state outgrows the heap costs one `error` row instead of the whole sweep; in-process for the in-memory stores the unit tests use), the native servers `OxigraphEngine`, `JenaEngine` and `QLeverEngine` (see "Setting up the engines") and `SparqlHttpEngine` (any *externally managed* SPARQL HTTP endpoint, used by `cli.ts`). |
| `comunicaWorker.mjs` | A long-lived Comunica worker driven by `ComunicaEngine` over newline-delimited JSON: it loads and indexes the dataset once, then answers every query against it. The separate process is about memory, not cancellation — Comunica buffers join state that no cap on the output stream can bound, and a `FATAL ERROR: Reached heap limit` is not catchable, so an unbounded query has to be able to die without taking the run with it. Timeouts are handled inside the worker, so they cost the budget but not the loaded store. Given an `.hdt` file (the LUBM and OAEI data), it queries through Comunica's HDT engine instead of loading a store. |
| `makeSubset.mjs` | Streams a full multi-GB dataset once and writes four self-contained subsets (`xs`/`s`/`m`/`l`), each containing the full closure of every benchmark query's target entities plus a uniform random noise sample, so results are comparable across scales. The full datasets (13–17GB) cannot be loaded into an in-memory store, so this is what the real run uses. |
| `plot.mjs` | Turns a results JSON into hand-rolled SVG figures (time-by-query, scaling, overhead, correctness) per scheme × engine, for the rewrites with `preserveCardinality` off, or on with `--preserve-cardinality`. No dependencies. |
| `overview/` | `analyse.mjs` turns `results/results.json` into the paired comparisons of "Results", and `build.mjs` inlines them into `template.html`, a self-contained results page. Both outputs are gitignored. |
| `cli.ts` | Ad-hoc single-pipeline runs against the **full** datasets or SPARQL endpoints you started yourself. No scale subsetting. |
| `workloads/<name>/` | The LUBM and OAEI workloads: `prepare.sh` downloads or generates the data into a gitignored `data/`, and the committed `views.rq` and `queries/*.rq` are what the benchmark runs. `workloads/toNTriples.mjs` merges and skolemises the source files; `workloads/common.sh` holds the steps both scripts share. |
| `materializeViews.ts` | Runs every view of a workload over its source data with Jena and writes the union, the graph the reference answers come from. Each view's result is cross-checked against Oxigraph's (or QLever's, with `--check qlever`), and nothing is written unless the two agree. |
| `timeMaterialization.ts` | Times every engine materialising every workload's views itself and measures the result's size on disk, the up-front cost the `materialized` approach pays and the rewriting does not. Writes `results/materialization.json`; with `--break-even`, works out after how many queries that cost pays off. |

Figures are **not committed** — they are regenerated from the results JSON with
`plot.mjs` (`test/bench/results/figures/` is gitignored). The harness itself is validated
by `test/bench.test.ts` on small in-memory datasets, no multi-GB data needed.

## Running the experiment

```bash
# 1. Generate subsets once per scheme (streams the full dataset twice; ~10 min each)
node --max-old-space-size=8000 test/bench/makeSubset.mjs \
  test/statics/REF-Benchmark/BKR/data/BKR-Reification.ttl test/bench/subsets reification
node --max-old-space-size=8000 test/bench/makeSubset.mjs \
  test/statics/REF-Benchmark/BKR/data/BKR-Singleton.ttl   test/bench/subsets singleton

# 2. Run (see below on choosing --timeout; jena first so complete data lands early)
# Engines: see "Setting up the engines"
export JENA_FUSEKI_JAR=/path/to/apache-jena-fuseki-6.3.0-SNAPSHOT/fuseki-server.jar
NODE_OPTIONS="--max-old-space-size=12000 --expose-gc" npx tsx test/bench/run.ts \
  --engines jena,oxigraph,comunica --schemes reification,singleton --scales xs,s --timeout 300000 \
  --rdf-views standard --paired-cardinality --reps 3 --reps-below 10000 \
  --out test/bench/results/starbench.json

# 3. Plot, and build the results page (once every run is in results.json; see "Results")
node test/bench/plot.mjs test/bench/results/results.json test/bench/results/figures
node test/bench/overview/analyse.mjs && node test/bench/overview/build.mjs
```

**Choosing `--timeout` is the single biggest lever on how much signal the run
produces**, because the interesting queries sit far above any conservative budget. At the
`xs` scale on Comunica the plain `rewriting` pipeline needs **184–289 s** per query, and
`pushDownAssertions`/`pullUpExtends` need **45–73 s**. A 60 s budget therefore censors
*every* `rewriting` measurement outside Jena — which is how earlier runs of this benchmark
ended up with zero valid data points for the approach the whole comparison is about.
300 s is the smallest budget that measures all four pipelines at `xs`; below ~100 s only
the pushdown-based ones survive. Budget accordingly: a full 3-engine × 2-scheme × 2-scale
sweep at 300 s is a many-hour run.

`--engines` accepts `comunica`, `oxigraph`, `jena`, `qlever`, `blazegraph`, `virtuoso` and `graphdb`; all but
Comunica, Oxigraph and Jena skip StarBench, which needs SPARQL 1.2.

## Setting up the engines

Every engine answers from data it has loaded and indexed once, the way it is built to be used, and is then
queried warm:

| Engine | Server | Store | Loaded with |
|---|---|---|---|
| Oxigraph | `oxigraph serve-read-only` | RocksDB on disk | `oxigraph load` (its bulk loader) |
| Jena | `fuseki-server.jar --tdb2 --loc` | TDB2 on disk | `tdb2.tdbloader --loader=parallel` |
| QLever | `qlever-server` | its index on disk | `qlever-index` |
| Blazegraph | `blazegraph.jar` (NanoSparqlServer) | its journal on disk | `DataLoader` |
| Virtuoso | `virtuoso-t` | its database on disk | `ld_dir` and `rdf_loader_run` |
| GraphDB | `graphdb -s` | its repository on disk, one GraphDB home per store | `importrdf preload` |
| Comunica | `comunicaWorker.mjs` | HDT (LUBM, OAEI), in-memory N3 store (StarBench) | `rdf2hdt`, or parsing the Turtle |

The servers share `ManagedServerEngine` (`engines.ts`). It bulk-loads a store beside each data file the
first time that file is queried (`lubm-u10.nt` → `lubm-u10.oxigraph/`, `lubm-u10.tdb2/`, `lubm-u10.qlever/`, ...),
untimed, and reuses it on every later run. It starts one server at a time, restarts it when the store changes,
and gives the server the query budget too (plus 2 s), so a query the harness gave up on stops using the CPU
the next one is measured on. A server refuses to start on a port that already answers queries, since a
leftover process there may hold other data. QLever caches query results, which the pipelines' shared
subqueries would hit, so its cache is cleared before every query.

**Oxigraph.** Take the `oxigraph` binary of a release (<https://github.com/oxigraph/oxigraph/releases>;
0.5.11 is the one measured) and put it on `PATH` or point `OXIGRAPH_BIN` at it.

**Jena.** Use a Fuseki build carrying ARQ's triple-term fix (Jena main `e9f7445a`, 2026-08-29). On 6.2.0 and
earlier, a sub-SELECT projecting a triple term loses that binding when it is joined against a sibling
pattern, which silently empties the plain `rewriting` pipeline's answers. No release carries the fix yet, so
take the nightly. The jar also holds the TDB2 loader. Fuseki 6.x needs Java 21+.

```bash
SNAP=https://repository.apache.org/content/repositories/snapshots/org/apache/jena/jena-fuseki-server/6.3.0-SNAPSHOT
mkdir -p apache-jena-fuseki-6.3.0-SNAPSHOT
curl -sL "$SNAP/jena-fuseki-server-6.3.0-20260922.051646-31.jar" \
  -o apache-jena-fuseki-6.3.0-SNAPSHOT/fuseki-server.jar   # check the dir for a newer one
export JENA_FUSEKI_JAR="$PWD/apache-jena-fuseki-6.3.0-SNAPSHOT/fuseki-server.jar"
```

`/$/server` on a running Fuseki reports the build's version, which is worth checking before trusting a Jena
row.

**QLever.** Its packages need Ubuntu 22.04 or later. On an older system, build it in a conda environment,
which brings its own compiler (GCC 13; GCC 14 fails on QLever's concepts) and libraries, and needs no root:

```bash
micromamba create -p ~/opt/qlever-env -c conda-forge gxx_linux-64=13 gcc_linux-64=13 cmake ninja \
  libboost-devel=1.86 icu jemalloc zstd openssl liburing libuuid mold pkg-config
git clone https://github.com/ad-freiburg/qlever.git && mkdir qlever/build && cd qlever/build
micromamba run -p ~/opt/qlever-env bash -c 'cmake -DCMAKE_BUILD_TYPE=Release -DLOGLEVEL=INFO \
  -DUSE_PARALLEL=true -D_NO_TIMING_TESTS=ON -DCOMPILER_SUPPORTS_MARCH_NATIVE=FALSE \
  -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=mold -Wl,-rpath,$CONDA_PREFIX/lib" -DCMAKE_CXX_FLAGS=-Wno-psabi \
  -DCMAKE_C_COMPILER=$CC -DCMAKE_CXX_COMPILER=$CXX -GNinja .. && cmake --build . --target qlever-index qlever-server'
export QLEVER_BIN_DIR="$PWD"
```

**Blazegraph.** Take `blazegraph.jar` of the last build, 2.1.6 RC (2020; nothing has been released since), from
<https://github.com/blazegraph/database/releases> and point `BLAZEGRAPH_JAR` at it. It runs on Java 21. The
store is set up as a plain triple store, with no quads, inference, full-text index or statement identifiers;
the server writes a `rules.log` into the store's directory. The time budget goes with each query
(`maxQueryTimeMillis`), and a query that exceeds it fails.

**Virtuoso.** Take the generic Linux build of the open-source edition
(`virtuoso-opensource.x86_64-generic_glibc25-linux-gnu.tar.gz`; 7.2.17 is the one measured) from
<https://github.com/openlink/virtuoso-opensource/releases>, unpack it, and point `VIRTUOSO_HOME` at it. The
loader is driven through its `isql` client, which needs `libncurses.so.5`. Ubuntu 20.04 has only version 6;
without root, take version 5 from conda-forge and wrap `isql`:

```bash
micromamba create -p ~/opt/virtuoso-env -c conda-forge ncurses=5.9
printf '#!/bin/sh\nLD_LIBRARY_PATH=$HOME/opt/virtuoso-env/lib exec $VIRTUOSO_HOME/bin/isql "$@"\n' > isql.sh
chmod +x isql.sh && export VIRTUOSO_ISQL="$PWD/isql.sh"
```

Three of Virtuoso's defaults would corrupt rows without an error, so the engine overrides them:

- **Its default graph** is the union of every graph it holds, its own system graphs included (2,500 triples),
  which an identity view would copy. The data goes into the graph `urn:bench`, and every query names it as
  its default graph.
- **A query that runs out of its budget is answered with what it found so far**, as `206 Partial Content`.
  The engine reports that as an error, never as an answer.
- **Answers are capped** at 1,048,576 rows by the endpoint, unless the request asks for more (`maxrows`); the
  ini's `ResultSetMaxRows` can only lower that cap. Every query asks for the harness's own cap, 50 million rows,
  and an answer that is cut off anyway (it carries an `X-SPARQL-MaxRows` header) is reported as an error.
  Virtuoso cannot send more than 2,097,151 rows in one answer, and a bigger one fails (SR078). Every reference
  answer up to LUBM u100 is smaller than that, but a rewriting that repeats rows can exceed it.

It also gets more memory to compile a query in (`MaxMemPoolSize`, 400 MB by default, now 16 GB): the plain
rewriting's queries ran out of 2 GB. Two more limits are raised for materialising the views:
- the largest array a vectored query may build (`MaxVectorSize`, now 4 million): LUBM `u10`'s identity view
  needs 1.27 million;
- the transaction log one update may write (`TransactionAfterImageLimit`, 50 MB by default, now 20 GB): an
  `INSERT … WHERE` of the views over LUBM `u10` exceeds the default. Two more limits the rewritten queries hit cannot be raised, as they are
compiled into Virtuoso: the length of the SQL a SPARQL query is translated into (SP031, 10,000 lines) and the
state a compiled query may hold (SQ156, "Query too large").

It runs **unvectorised** (`VectorSize = 1`, default 1000), which corrects one Virtuoso bug at a cost in speed.
With vectors, a join over UNIONs whose branches BIND the join variable uses, in some branches, values another
branch computed. It loses and invents rows: LUBM Q04, Q08 and Q09 after pushDownAssertions, for example. The
wrong answers change with the vector size, and only 1 gives the right ones. Unvectorised, the rewritten queries
run about 5× slower on LUBM and about 20× slower on OAEI. The setting applies to every store, the materialised
views' included. Unvectorised execution has a bug of its own, which only the `preserveCardinality` rewrites hit:
a join of three or more `SELECT DISTINCT` subqueries loses rows (see "Known issues"). No vector size answers
every rewrite correctly, and the benchmark keeps 1, which gets every answer right without `preserveCardinality`.

A second bug has no setting that fixes it. A `FILTER(sameTerm(?v, C))` over a UNION whose branches BIND `?v` to
different constants is compiled as if every branch had bound `C`, so the filter keeps all the branches. The
plain rewriting and removeProjections hit it on most LUBM and OAEI queries. Those answers are measured and
graded wrong.

**GraphDB.** Take the distribution (`graphdb-<version>-dist.zip`; 11.5.1 is the one measured) from Ontotext's
Maven repository,
<https://maven.ontotext.com/repository/owlim-releases/com/ontotext/graphdb/graphdb/11.5.1/graphdb-11.5.1-dist.zip>,
unpack it, and point `GRAPHDB_HOME` at it. Since 11.0 even the Free edition needs a licence, which Graphwise
sends on registering at its download page. It may come as base64 text; GraphDB reads only the decoded file
(`base64 -d licence.txt > graphdb.license`), and `GRAPHDB_LICENSE` names it. The Free licence states one CPU
core, though the server is not pinned to one. GraphDB's defaults would change the answers, so the repository
overrides them: its default ruleset (RDFS-Plus) derives the very facts the LUBM views derive, so it runs with
`empty`, and a query that runs out of its budget would by default return what it found so far, so it fails
instead. The server's heap is capped at 36 GB (`GDB_MAX_MEM`), not the JVM's default of a quarter of the
machine's memory. Some rewritten queries run GraphDB out of heap at 12 GB and at 40 GB alike; GraphDB then kills
itself, the cell is an error saying so, and the next cell starts a new server. 36 GB leaves the rest of a 48 GB
machine enough that the heap cap, not the kernel's OOM killer, stops such a query. Its heap dumps, the size of
the heap, are switched off.

| Env var | Meaning | Default |
|---|---|---|
| `OXIGRAPH_BIN` | The `oxigraph` binary. | `oxigraph` |
| `OXIGRAPH_PORT` | Port of the Oxigraph server. | `3132` |
| `JENA_FUSEKI_JAR` | Path to `fuseki-server.jar`. **Required** for Jena. | — |
| `JENA_JAVA` | Java binary. | `java` |
| `JENA_FUSEKI_PORT` | Port of the Fuseki server. | `3131` |
| `JENA_JVM_OPTS` | Extra space-separated JVM arguments, for the server and the loader. | (none) |
| `QLEVER_BIN_DIR` | Directory holding `qlever-index` and `qlever-server`. | on `PATH` |
| `QLEVER_PORT` | Port of the QLever server. | `3133` |
| `QLEVER_MEMORY` | Memory QLever's queries may use. | `12GB` |
| `BLAZEGRAPH_JAR` | Path to `blazegraph.jar`. **Required** for Blazegraph. | — |
| `BLAZEGRAPH_JAVA` | Java binary. | `java` |
| `BLAZEGRAPH_PORT` | Port of the Blazegraph server. | `3134` |
| `BLAZEGRAPH_JVM_OPTS` | Extra space-separated JVM arguments, for the server and the loader. | (none) |
| `VIRTUOSO_HOME` | Directory of the Virtuoso build (holding `bin/virtuoso-t`). **Required** for Virtuoso. | — |
| `VIRTUOSO_ISQL` | Virtuoso's `isql` client, or a wrapper around it. | `$VIRTUOSO_HOME/bin/isql` |
| `VIRTUOSO_PORT` | HTTP port of the Virtuoso server. | `3135` |
| `VIRTUOSO_SQL_PORT` | SQL port of the Virtuoso server, which `isql` uses. | `3136` |
| `VIRTUOSO_BUFFERS` | Virtuoso's page buffers, of 8 KB each. | `1360000` (about 11 GB) |
| `GRAPHDB_HOME` | Directory of the GraphDB distribution. **Required** for GraphDB. | — |
| `GRAPHDB_LICENSE` | GraphDB's licence file, decoded. **Required** for GraphDB's server. | — |
| `GRAPHDB_PORT` | Port of the GraphDB server. | `3137` |
| `GDB_JAVA_OPTS` | Extra JVM arguments for GraphDB's server and loader (read by GraphDB's own scripts). | (none) |
| `GDB_MAX_MEM` | Heap cap (`-Xmx`) of GraphDB's server. | `36g` |
| `RDF2HDT` | hdt-cpp's `rdf2hdt`, for the workloads' HDT copies. | `rdf2hdt` |

## Known issues in the corpus and the engines

Each of these was found through this benchmark and is *not* a rewriter bug. They are
listed here because every one of them can be misread as one.

- **Nine of the twelve `BKR-S_*.rq` (singleton) baseline files ask a different question than
  the `BKR-star_*.rq` query they are nominally the baseline for.** `B-Q2`, `F-Q1`, `F-Q3`, `F-Q4` and
  `F-Q5` use `umls:` IRIs — e.g. `F-Q4`'s star constant `bkr:META_C0040300-INST` occurs 16,700
  times as a subject in `singleton-xs.ttl`, while `BKR-S_F-Q4.rq`'s `umls:META_C0040300` occurs
  once — so they match nothing; `A-Q2` and `A-Q3` ask about different concepts altogether;
  `A-Q4` omits the `?source_inst rdf:type ?source_cl` pattern; and `A-Q1` projects
  `?st_s_inst ?st_p_inst ?st_o_inst`, binding the singleton property node where the star query
  binds the base predicate. Pre-existing in the shipped corpus. Rewriting each of the first eight to
  ask what its star query asks makes it return exactly the rewriting's answer at `xs` and `s`,
  so a singleton `correct: false` on one of those cases is this, not a rewriting error. The
  reification baselines (`BKR-R_*.rq`) use the same constants and structure as the star queries
  and are unaffected.
- **Two baseline files were missing a `PREFIX rdf:` declaration** (`BKR-R_B-Q3.rq`,
  `BKR-S_A-Q4.rq`). Comunica's parser tolerated it; Oxigraph's correctly rejected it.
  **Fixed** in both files.
- **The source BKR Turtle dumps contained malformed percent-encoded IRIs** (literal
  `%%-`), which Oxigraph's parser rejects — a whole-file load failure — while N3 accepts
  them silently. **Fixed** in `skolemize.ts`, which now drops quads carrying a
  syntactically invalid IRI (checked recursively into triple-term components and literal
  datatypes) and logs them to `<output>.dropped.ttl`. 120 quads out of 82,432,741 were
  dropped, all the same defect; Oxigraph's `error` rows went from 96/192 to 0/192.
- **The `F-Q1`/`F-Q2` baselines use `SELECT *`, so they bind one variable more than the
  star query does** — the reification baseline has to name the statement node (`?st`) to
  walk the encoding, and the singleton one likewise. The solutions agree on every shared
  variable; the extra binding alone makes the multiset comparison report a difference, so a
  `correct: false` on `F-Q1`/`F-Q2` is this, not a rewriting error. Pre-existing in the
  shipped corpus, same class as the singleton-constants issue above.
- **Comunica 5.3.0 exhausted its heap on the pushdown and pull-up rewrites of
  `reification/F-Q3`; 5.4.0 no longer does.** It took down two full sweeps before being contained (the second 16.5
  hours in), because `FATAL ERROR: Reached heap limit` is a process abort, not a catchable
  exception, and `--timeout` cannot save it: the OOM can arrive before the timer fires, and
  once the heap is exhausted the event loop no longer gets to run it. This is why
  `ComunicaEngine` evaluates through a worker process: the abort now costs one `error` row per
  rewrite. `F-Q3` is genuinely heavy — its answer is 8,490,234 rows at both `xs` and `s` (2,131
  matching statements, one with 1,767 sources, paired with themselves) — so it sits at the
  budget on every engine: Jena and Oxigraph deliver the rewrites' answers in 190–300 s when they
  finish at all, their hand-written baselines time out, and so does Comunica's. But the
  *crash* is Comunica's join plan, found with its physical query plan logger. Version 5.3.0
  estimates a join as the product of its inputs, so the four-pattern statement group comes out
  at ~10¹⁵ rows (really 2,131); that makes it hash-join the two unrestricted `derives_from`
  groups first — 589,249,104 pairs — and it cannot bind-join into them instead, because its
  bind-join actor refuses any input containing a `BIND` or `GROUP`. Comunica 5.4.0 caps
  join estimates by the shared variables (#1792) and estimates that group at 2,133; together
  with the `filterFalse` change above it streams the rewrite in under 1.5GB and runs out
  of budget like the baseline, so these cells are now timeouts rather than errors.
- **Oxigraph 0.5.9 rejects the spec-compliant uppercase `FILTER(FALSE)`** our generator
  emits, accepting only lowercase `false`. Worked around by lowercasing that exact shape in
  the query text sent to engines (`runner.ts`'s `lowercaseBooleanLiterals`); the generator
  is left alone, since its output is correct. It mattered while `pushDownAssertions` left
  the `UNION` branches it proved statically empty behind as `FILTER(FALSE)`; now that
  `filterFalse` collapses those through sub-`SELECT`s, none of the benchmark
  rewrites contains a boolean-literal `FILTER`, and the workaround stays only as a guard.
- **Virtuoso 7.2.17 drops a `sameTerm` filter over a `UNION` whose branches bind its variable to
  different constants.** For `{ … BIND(ekaw:Paper AS ?o) } UNION { … BIND(ekaw:Document AS ?o) }
  FILTER(sameTerm(?o, ekaw:Paper))`, its compiler fixes `?o` to `ekaw:Paper` everywhere. The filter
  becomes `ekaw:Paper = ekaw:Paper`, and every branch passes. `?o = ekaw:Paper` is compiled correctly.
  The plain rewriting and `removeProjections` filter every constant this way, so on OAEI 103 of their
  answers are wrong, and on LUBM both of the plain rewriting's answers are wrong. The pushdown removes
  those filters, and all of its answers are right. No setting changes this. The wrong answers are
  measured and graded as wrong.
- **Virtuoso's vectorised execution joins `UNION`s that `BIND` the join variable wrongly.** Some branches
  compute the join with the values another branch bound. The answer changes with the vector size, and only
  `VectorSize = 1` is right. With the default (1000), LUBM Q04, Q08 and Q09 after the pushdown lose and
  invent rows: Q04 at `u1` gives 672 rows where the reference has 306. The benchmark runs Virtuoso
  unvectorised (see "Setting up the engines"), which costs it 5–20× on these queries.
- **Unvectorised, Virtuoso joins three or more `SELECT DISTINCT` subqueries wrongly, and loses rows.**
  Over OAEI `eswc`,

  ```sparql
  SELECT DISTINCT ?s ?o WHERE {
    { SELECT DISTINCT ?s    WHERE { ?s a conference:Track } }
    { SELECT DISTINCT ?o ?s WHERE { ?o conference:has_tracks ?s } }
    { SELECT DISTINCT ?o    WHERE { ?o a conference:Conference_volume } }
  }
  ```

  returns 1 row at `VectorSize = 1` and the right 4 at the default 1000, as Oxigraph does. Any two of the
  three subqueries are joined correctly, and so are the three without their `DISTINCT`s. Only the
  `preserveCardinality` rewrites are built this way: with it, the pushdown's answers to LUBM Q02, Q07 and
  Q09 and to four OAEI queries (`is_author_of_paper`, `track_of_conference`, `tutorial_of_conference`,
  `workshop_of_conference`) lose rows, 38 cells in all. They are measured and graded wrong.
- **Virtuoso has limits compiled in that the unoptimised rewrites exceed:**
  - the SQL a query is translated into may have at most 10,000 lines (SP031);
  - a compiled query may hold about 65,000 state slots (SQ156, "Query too large");
  - an answer may have at most 2,097,151 rows (SR078);
  - a `CONSTRUCT` may build at most 2,097,150 triples (D1CTX), so it cannot materialise LUBM's identity view
    from `u50` on.

  In the campaign, these limits account for 92 of Virtuoso's 94 errors with `preserveCardinality` off and
  32 of 40 with it on. The rest are all `early_registration`, which is the correlated `BIND` described
  under "Where the optimisations do not help":
  - Virtuoso rejects its `pullUpExtends` rewrite at both OAEI scales, with either setting ("Alias ?uq_s is
    defined twice").
  - With the option on, the other three pipelines fail with an internal optimiser error ("subq ot was
    supposed to be found").
- **Blazegraph 2.1.6 overflows its stack on the plain rewriting of OAEI** (19 queries) after about 50 s.
  With `preserveCardinality` on, the `DISTINCT` subqueries nest the plans deeper: its stack overflows on 22
  `removeProjections` rewrites (14 LUBM, 8 OAEI) and on 2 plain OAEI rewrites.
  With a 64 MB thread stack, the same query ran past 400 s without an answer, so the default stack was
  kept and the error is reported as such. On LUBM its optimiser orders Q04's lone `emailAddress`,
  `telephone` and `name` patterns, which are joined only through `BIND`-computed variables, first. That
  makes a cross product of about 10¹² rows, which no budget covers.
- **GraphDB 11.5 runs out of heap on some `removeProjections` rewrites at 12 GB and at 40 GB alike.** It
  then kills itself. Its start script passes `-XX:OnOutOfMemoryError=kill -9`, and by default it writes a
  heap dump the size of the heap into the store's directory. The harness switches the dumps off, caps the heap at
  36 GB, and starts a new server for the next query. In the full run these queries timed out before
  reaching the cap.

## LUBM and OAEI Conference

Two workloads with no triple terms in them, run through the same harness, the same four
pipelines and the same mapping options as StarBench (the standard RDF view, and `preserveCardinality` off
and on). They exercise what StarBench does not: many views for one target, and
answers that only exist through the views. Being plain RDF 1.1, they also run on QLever, which has no
RDF 1.2 support.

### LUBM: reasoning by rewriting

The virtual graph is the LUBM data **plus everything the ontology entails from it**, so a query
over the views answers as a query over the saturated graph would. `compileOntology.mjs` compiles
the ontology into 239 non-recursive CONSTRUCT views over the asserted data. None reads another's
output, so no recursion arises.

- **One identity view**, `CONSTRUCT WHERE { ?s ?p ?o }`, carries the asserted data itself.
- **Hierarchies, inverses, domains and ranges** come from `univ-benchQL.owl`, the OWL 2 QL version
  of the ontology in [ontop/iswc2014-benchmark](https://github.com/ontop/iswc2014-benchmark). The
  subsumptions between classes and properties are closed transitively once, and each class or
  property gets one view per asserted class or property that implies it. For instance `ub:headOf`
  yields `worksFor` and `memberOf`, and `ub:memberOf` also comes from `member` read backwards.
- **The defined classes** (`Chair`, `Dean`, `Director`, `Employee`, `Student`,
  `TeachingAssistant`) come from the original `univ-bench.owl`. The QL version keeps only half of
  each definition, `Chair ⊑ ∃headOf.Department`, which derives nothing. Without the other half no
  `Chair` would exist at all, since the generator never asserts one. Each definition becomes views
  with a conjunctive body (`?x ub:headOf ?y . ?y a ub:Department`) for the class and all its
  superclasses.

The data comes from the UBA 1.7 generator with seed 0, at 1, 10, 50 and 100 universities:

| Scale | Source triples | Materialised views |
|---|---|---|
| `u1` | 100,543 | 137,722 |
| `u10` | 1,272,575 | 1,735,299 |
| `u50` | 6,654,562 | 9,072,553 |
| `u100` | 13,405,381 | 18,273,926 |
| `u250` (QLever only) | 33,342,911 | 45,454,558 |
| `u500` (QLever only) | 66,731,200 | 90,968,587 |

`u250` and `u500` run on QLever only (`scaleEngines` in `config.ts`). `u250` is about where QLever needs five
minutes to materialise the views (6.3 measured); the other engines pass that point at `u100` (Jena, 6.5
minutes) or well below it (Oxigraph between `u10` and `u50`, Comunica below `u10`). `u500` takes QLever
further, once: `prepare.sh` stops at `u250`. It was made by generating universities 250–499 (UBA
`-univ 250 -index 250 -seed 0`), adding them to `u250`, and building its views with
`materializeViews.ts --check qlever`, Jena's views checked against QLever's because Oxigraph would take
over 11 hours there.

Every generated university depends only on the seed and its index, so each scale contains the smaller
ones. The harness uses this: a query that timed out at one scale is recorded as a timeout at the larger
ones without being run (its `error` says so). **All 13 queries return exactly the published LUBM(1) answer counts on the
materialised views**, which shows the compiled views are complete for this query set.

The queries are the standard ones as written in `Ontop/OntopQueries.txt` of that repository
(Apache-2.0; the file is missing Q9's closing brace, which `queries/Q09.rq` restores).

### OAEI Conference: several sources for one target vocabulary

The [populated conference dataset](https://framagit.org/IRIT_UT2J/conference-dataset-population)
(Thiéblin et al., Semantic Web 12, 2021) holds five conference ontologies with instance data, and
CONSTRUCT queries generated from their reference alignments. Here the target is **ekaw**, fed by
**cmt, confOf, conference and edas** together. The four shipped `<source>-ekaw.sparql` files give
148 views, so one ekaw class or property can have up to one view per source: that is the `UNION`
fan-out this workload is about. The queries are the 65 competency questions in their ekaw version.
`workloads/oaei/views.rq` and `workloads/oaei/queries/` are copied from that repository (LGPL-2.1)
by `prepare.sh`.

The scales are `data_100` (`d100`, 1,368,540 triples, every instance shared across the ontologies)
and `eswc` (123,170 triples, the real ESWC 2018 data, anonymised). Their materialised views hold
468,139 and 36,664 triples. Instance IRIs differ per ontology, so the reference is the materialised
views and never ekaw's own data.

### How the reference is built

Neither workload has a query written against its source data, which is what StarBench grades
against. Here the reference is the **original query over the materialised views**:
`materializeViews.ts` runs every view over the source data with Jena, checks each view's number of
distinct triples against Oxigraph's, and writes the union. It streams every view's output to disk, so
it handles LUBM's 18 million materialised triples at `u100`. This is also what the `materialized` approach
measures, so for these workloads it means "compute the views ahead of time and query the result".
That is a genuine alternative to rewriting, but a different comparison from StarBench's
"hand-written query over the same data".

Without `preserveCardinality`, a rewritten query can repeat a row that the materialised graph, being a set,
holds once: a LUBM student who is a `GraduateStudent` and also takes a course is a `Student` twice. So rows
carry `correctAsSet` next to `correct`. Where `correct` is false and `correctAsSet` is true, the mismatch is
duplicates only, which is expected with the option off. With it on, the duplicates are gone (see "What
`preserveCardinality` changes" under "Results").

All source data is skolemised before use (`toNTriples.mjs`), because the rewriter does not allow
blank nodes in its source. Comunica reads HDT copies of the data rather than loading it into memory.
StarBench's Turtle stays in-memory, since HDT cannot hold triple terms, so Comunica's times are
comparable within a workload but not across workloads. The three servers each query a store they
bulk-loaded from the same N-Triples (see "Setting up the engines"), the materialised views in a store of
their own.

### Left out, and why

- **LUBM Q11.** It needs `subOrganizationOf` to be transitive, and a transitive closure is
  recursive, which a non-recursive view cannot express.
- **Eight "there is some" axioms of the LUBM ontology**, such as `Student ⊑ ∃takesCourse.Course`.
  They assert that an unnamed individual exists, and a view cannot produce one without inventing a
  node for it. None of the 13 queries needs one.
- **One OAEI view** (`edas-ekaw` #30, `?s ekaw:paperInVolume _:o2`). A mapping head admits no blank
  node, and with skolemised data there is nothing for one to stand for.
- **Nothing else from OAEI had to go.** The dataset's alignments include transitive correspondences
  (inexpressible without recursion) and EDOAL `not` (which becomes a `MINUS`), but none of them are
  among the views into ekaw. The one `MINUS` here is in a query (`external_reviewer`).
- **Not yet run:** WD-AMC (Wikidata in three metadata encodings), the BKR n-ary and qualifier
  encodings that come with it, and the view setups of Le et al. (WWW 2011).

### Running them

```bash
# The engines as in "Setting up the engines": JENA_FUSEKI_JAR, OXIGRAPH_BIN, QLEVER_BIN_DIR, RDF2HDT
test/bench/workloads/lubm/prepare.sh                 # ~25 GB in workloads/lubm/data
test/bench/workloads/oaei/prepare.sh                 # ~350 MB in workloads/oaei/data
npx tsx test/bench/timeMaterialization.ts            # each engine materialising the views
# One engine at a time, nothing else heavy on the machine; QLever also gets u250,u500 (see config.ts).
for engine in qlever jena oxigraph virtuoso graphdb blazegraph comunica; do
  NODE_OPTIONS=--max-old-space-size=12000 npx tsx test/bench/run.ts --engines $engine --schemes lubm,oaei \
    --scales u1,u10,u50,u100,u250,u500,eswc,d100 --timeout 60000 \
    --rdf-views standard --paired-cardinality --reps 3 --reps-below 10000 \
    --out test/bench/results/workloads-$engine.json
done
# results/results.json is these files and StarBench's (see "Running the experiment") concatenated.
npx tsx test/bench/timeMaterialization.ts --break-even test/bench/results/results.json
```

## Results

One campaign, measured 2026-10-22 → 10-26 on commit `9249d80` (the rewriter at `20181c2`), with the same
harness and settings for every engine and workload: 12,996 rows in `results/results.json`.

- **Views:** the standard RDF view (`generalizedRdfView: false`), the library's default.
- **`preserveCardinality`:** every rewrite ran with it off and on, back to back (`--paired-cardinality`). Which
  of the two runs first alternates from query to query. The `materialized` row is shared by both.
- **Repeats:** a query whose first run takes under 10 s runs three times and reports the median
  (`--reps 3 --reps-below 10000`). A slower query, and a timeout, run once.
- **Budget:** 60 s per query for LUBM and OAEI, 300 s for StarBench. A LUBM query that timed out at one
  scale is not run at the larger ones, separately for each `preserveCardinality` setting.
- **Engines and scales:** all seven on LUBM `u1`–`u100` and OAEI `eswc`/`d100`, QLever also on LUBM
  `u250`/`u500`. StarBench `xs`/`s` runs on Oxigraph, Jena and Comunica, the engines with RDF 1.2. Versions
  and settings are as in "Setting up the engines".
- A testbed restart on 2026-10-25 cut off Comunica's StarBench `singleton`/`s` block. That block was re-run
  whole on 10-26, since a block's rows are graded only when it ends.

Absolute times are lower than in earlier runs, the `materialized` ones included, because fast queries now
report the median of three warm runs. Compare ratios within this run, not times across runs.

**How the numbers below are made.** Every comparison is paired: two variants of the same query at the same
scale.
- A ratio is the geometric mean of the time ratios over the queries both variants answered. `÷4` is four
  times faster, `×4` four times slower, and `≈1` within 10%, about the drift between runs.
- A query that one side answered and the other timed out on counts as a win, but adds no ratio.
- A query that either side failed on with an engine error is left out.
- Unless a table says otherwise, the rewrites are the ones with `preserveCardinality` off.

`test/bench/overview/` turns `results.json` into these numbers, and into the self-contained results page
the team reads:

```bash
node test/bench/overview/analyse.mjs           # -> test/bench/overview/overview-data.json
node test/bench/overview/build.mjs             # -> test/bench/overview/overview.out.html
```

### Each pass, against the pipeline without it

All scales of a workload pooled. In parentheses: queries answered before → after the pass.

| Engine | Workload | `+removeProjections` | `+pushDownAssertions` | `+pullUpExtends` |
|---|---|---|---|---|
| Oxigraph | LUBM | ×1.8 (20→12) | ÷78 (12→46) | ≈1 (46→46) |
| Oxigraph | OAEI | ≈1 (128→128) | ÷187 (128→130) | ≈1 (130→130) |
| Oxigraph | StarBench reification | ×1.1 (24→24) | ÷4.0 (24→24) | ≈1 (24→24) |
| Oxigraph | StarBench singleton | ×1.1 (23→23) | ÷4.3 (23→24) | ÷1.3 (24→23) |
| Jena | LUBM | ÷1.3 (19→19) | ÷9.0 (19→34) | ÷1.4 (34→34) |
| Jena | OAEI | ÷1.2 (126→125) | ÷49 (125→129) | ÷1.2 (129→130) |
| Jena | StarBench reification | ÷1.2 (24→22) | ÷5.3 (22→23) | ÷1.4 (23→24) |
| Jena | StarBench singleton | ÷1.1 (24→22) | ÷4.7 (22→23) | ÷1.5 (23→24) |
| QLever | LUBM | — (0→0) | — (0→71) | ÷1.4 (71→71) |
| QLever | OAEI | — (0→0) | — (0→130) | ÷1.4 (130→130) |
| Virtuoso | LUBM | — (2→0) | — (0→47) | ≈1 (47→47) |
| Virtuoso | OAEI | ×9.6 (90→42) | ÷1,151 (42→128) | ≈1 (128→126) |
| GraphDB | LUBM | ÷5.4 (22→8) | ÷1.9 (8→20) | ÷2.6 (20→23) |
| GraphDB | OAEI | ÷2.2 (128→75) | ÷24 (75→121) | ÷1.4 (121→122) |
| Blazegraph | LUBM | — (0→0) | — (0→14) | ÷2.0 (14→16) |
| Blazegraph | OAEI | — (0→34) | ÷629 (34→113) | ÷1.6 (113→115) |
| Comunica | LUBM | ≈1 (6→7) | ÷29 (7→22) | ÷1.5 (22→23) |
| Comunica | OAEI | ≈1 (67→84) | ÷952 (84→128) | ÷1.3 (128→128) |
| Comunica | StarBench reification | ≈1 (11→12) | ÷5.2 (12→22) | ÷1.6 (22→22) |
| Comunica | StarBench singleton | ≈1 (4→5) | ÷7.5 (5→18) | ÷1.3 (18→19) |

- **`pushDownAssertions` is the pass that makes the rewrite work**, on every engine and workload: ÷24 to
  ÷1,151 on OAEI, ÷1.9 to ÷78 on LUBM, ÷4.0 to ÷7.5 on StarBench. Where the rewrite failed, it makes
  queries answerable:
  - QLever answers nothing without it, because it has no `sameTerm` and the pushdown removes those filters.
  - On LUBM, Virtuoso and Blazegraph also answer nothing without it.
  - Comunica goes from 12 to 22 StarBench reification queries and from 5 to 18 singleton ones.
- **`pullUpExtends` adds ÷1.2 to ÷2.6** on the engines that gain from it. It is neutral on Virtuoso, and on
  Oxigraph except for StarBench singleton (÷1.3).
- **`removeProjections` alone does not help, and on some engines it hurts.** It is a rung because the
  pushdown needs it: a `FILTER` cannot be driven into a pattern hidden behind a sub-`SELECT`. On its own it
  loses answers:
  - GraphDB: LUBM 22 → 8, OAEI 128 → 75.
  - Virtuoso on OAEI: 90 → 42. Its compiled-in state-slot limit (SQ156) rejects 24 of the flattened
    queries, and 64 time out.
  - Oxigraph on LUBM: 20 → 12.

### What each engine answers within the budget

Queries answered, all scales pooled (a query at two scales counts twice): reference · `rewriting` ·
`+removeProjections` · `+pushDownAssertions` · `+pullUpExtends`, then `+pullUpExtends` with
`preserveCardinality` on in parentheses, of the total.

| Engine | LUBM | OAEI | StarBench reification | StarBench singleton |
|---|---|---|---|---|
| Oxigraph | 43 · 20 · 12 · 46 · 46 (50) / 52 | 130 · 128 · 128 · 130 · 130 (130) / 130 | 23 · 24 · 24 · 24 · 24 (24) / 24 | 24 · 23 · 23 · 24 · 23 (24) / 24 |
| Jena | 52 · 19 · 19 · 34 · 34 (36) / 52 | 130 · 126 · 125 · 129 · 130 (130) / 130 | 20 · 24 · 22 · 23 · 24 (24) / 24 | 24 · 24 · 22 · 23 · 24 (24) / 24 |
| QLever | 78 · 0 · 0 · 71 · 71 (76) / 78 | 130 · 0 · 0 · 130 · 130 (130) / 130 | — | — |
| Virtuoso | 52 · 2 · 0 · 47 · 47 (51) / 52 | 130 · 90 · 42 · 128 · 126 (127) / 130 | — | — |
| GraphDB | 52 · 22 · 8 · 20 · 23 (52) / 52 | 130 · 128 · 75 · 121 · 122 (129) / 130 | — | — |
| Blazegraph | 52 · 0 · 0 · 14 · 16 (20) / 52 | 130 · 0 · 34 · 113 · 115 (118) / 130 | — | — |
| Comunica | 49 · 6 · 7 · 22 · 23 (24) / 52 | 130 · 67 · 84 · 128 · 128 (129) / 130 | 22 · 11 · 12 · 22 · 22 (22) / 24 | 24 · 4 · 5 · 18 · 19 (19) / 24 |

- **OAEI is answered almost completely** after the pushdown: 113 to 130 of 130 on every engine.
- **On LUBM the engine decides.** The full pipeline answers 71 of 78 on QLever and 47 of 52 on Virtuoso,
  but only 16 to 34 of 52 on Blazegraph, Comunica, GraphDB and Jena. With `preserveCardinality` on, GraphDB
  answers all 52 (see below).
- **Some references time out where the rewrite answers.** Oxigraph's own materialised query times out on
  Q02, Q03, Q05, Q08, Q09 and Q10 at `u50`/`u100`, and Comunica's on three LUBM cells. On Jena, the
  hand-written StarBench queries for reification `F-Q3` and `F-Q4` take over 300 s.

### Against the reference

`+pullUpExtends` against the reference per scale: the materialised views for LUBM and OAEI, the
hand-written query over the same data for StarBench. In parentheses: queries both answered.

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` | reif. `xs` | reif. `s` | sing. `xs` | sing. `s` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Oxigraph | ×1.4 (13) | ≈1 (12) | ×1.4 (9) | ÷1.2 (5) | — | — | ≈1 (65) | ÷1.4 (65) | ×6.6 (12) | ×10 (11) | ×778 (3) | ×1,540 (3) |
| Jena | ×5.7 (10) | ×59 (9) | ×194 (9) | ×362 (6) | — | — | ≈1 (65) | ×1.3 (65) | ×3.7 (10) | ×10 (10) | ×108 (3) | ×273 (3) |
| QLever | ×13 (13) | ×13 (12) | ×16 (12) | ×24 (12) | ×46 (11) | ×76 (11) | ×2.1 (65) | ×1.9 (65) | — | — | — | — |
| Virtuoso | ×4.5 (13) | ×4.9 (12) | ×5.3 (11) | ×4.3 (11) | — | — | ×1.4 (64) | ×1.4 (62) | — | — | — | — |
| GraphDB | ×12 (8) | ×19 (5) | ×55 (5) | ×80 (5) | — | — | ×1.8 (64) | ×2.0 (58) | — | — | — | — |
| Blazegraph | ×20 (6) | ×66 (5) | ×13 (3) | ×19 (2) | — | — | ×2.7 (62) | ×2.2 (53) | — | — | — | — |
| Comunica | ×39 (12) | ×51 (5) | ×36 (3) | ×57 (3) | — | — | ×3.1 (65) | ×3.2 (63) | ×33 (11) | ×25 (11) | ×17 (3) | ×37 (3) |

- **OAEI is vocabulary translation, and there the full pipeline runs close to the materialised views:**
  - at par on Oxigraph and Jena;
  - within 1.4× on Virtuoso;
  - 2 to 3 times slower on QLever, GraphDB, Blazegraph and Comunica, which pay more per `UNION` branch.

  Each query touches a few of the 148 views, and the pushdown turns them into indexed lookups.
- **LUBM is reasoning by rewriting, and its cost depends on the engine.** It runs:
  - at par on Oxigraph;
  - about 5 times slower on Virtuoso;
  - on QLever, 13 times slower at `u1`, growing to 76 times at `u500`;
  - on Jena, 6 times slower at one university, growing to 362 times at a hundred.

  The difference from OAEI is fan-out. An OAEI term has at most one view per source, while a LUBM class
  like `Person` or `Student` has dozens of derivations, and the entailed facts are what the queries ask for.
- **Oxigraph answers its own materialised views more slowly than the rewrite at the larger LUBM scales.**
  At `u100` its materialised query answers 7 of 13 queries, and its rewrite 10; at `u50`, 10 and 11. Earlier runs traced this to
  plan choice:
  - Over the views, Oxigraph starts Q01 from every graduate student.
  - In the pushed-down rewrite, the course is a constant in each branch, and Oxigraph starts there.
- **On StarBench the hand-written query stays ahead.** For reification the rewrite runs 3.7 to 10 times
  behind it on Jena and Oxigraph, and 25 to 33 times on Comunica. For singleton only `B-Q1`, `B-Q3` and
  `F-Q2` can be compared, since the other nine reference queries ask a different question (see "Known
  issues"). Those three read the singleton encoding through a constant in milliseconds, hence ratios in
  the hundreds and thousands.
- With `preserveCardinality` on, the picture is the same, except for GraphDB and Virtuoso (see "What
  `preserveCardinality` changes").

### What materialising costs, per engine

The comparison above assumes the views already exist. Views that change, or that live only briefly, have to
be built again each time. `timeMaterialization.ts` measures that for every engine. Each engine does all of
it itself:
- it runs every view's `CONSTRUCT` against its own store of the source;
- it loads the output into a fresh store of its own, the way it loads data fastest.

Starting the server on the source store is not counted, because the rewriting needs it too. The build was
measured once, on 2026-09-30/10-01, and for Virtuoso, GraphDB and Blazegraph on 2026-10-14; the rewriter
does not affect it, so the campaign did not re-measure it. `results/materialization.json` holds the
numbers.

Doing it inside the database with one `INSERT { GRAPH … } WHERE { … }` per view is slower on every engine
that supports it, at LUBM `u10` (`results/materialization-methods-u10.json`): QLever 74 s against 16 s,
Jena 131 s against 35 s, Oxigraph 159 s against 153 s. Comunica cannot write, so it builds an HDT file
and its index from its own `CONSTRUCT` output. Of the other three engines:
- **GraphDB is the exception.** Its `INSERT` is 1.5–2× faster than its own `CONSTRUCT` and load at every
  scale, so its build times below are the `INSERT`s.
- **Virtuoso can only use `INSERT` from LUBM `u50` on.** A `CONSTRUCT` answer is capped at 2,097,150
  triples (D1CTX, compiled in), and the identity view alone is larger there. Below that, its `CONSTRUCT`
  and load is faster (126 s against 344 s at `u10`), except at OAEI `eswc`, where creating a fresh
  database dominates (12 s against 3.0 s).
- **Blazegraph keeps triples, not named graphs**, so it is only timed with `CONSTRUCT` and load.

The table shows the faster of the two for each engine.

| Build time | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| QLever | 5.6 s | 16 s | 64 s | 125 s | 378 s | 25 min | 3.5 s | 6.4 s |
| Jena | 8.2 s | 32 s | 178 s | 390 s | — | — | 5.3 s | 11 s |
| Oxigraph | 11 s | 144 s | 951 s | 41 min | — | — | 3.1 s | 23 s |
| Comunica | 15 s | 650 s | 4.0 h | 14.2 h | — | — | 4.5 s | 30 s |
| Virtuoso | 22 s | 126 s | 30 min | 65 min | — | — | 3.0 s | 33 s |
| GraphDB | 12 s | 56 s | 231 s | 435 s | — | — | 7.0 s | 22 s |
| Blazegraph | 12 s | 67 s | 318 s | 666 s | — | — | 5.7 s | 15 s |

**Where the build time goes:**
- Up to `u250`, running the views is most of it: at `u100`, 92 s of QLever's 125 and 246 s of Jena's 390;
  at `u250`, 226 s of QLever's 378.
- At `u500`, QLever's index build catches up: 716 s of its 1,489. The build grew 4.7× from `u250` for twice
  the data, while running the views grew 3.4×.
- Comunica's build grows far faster than the data: 22× from `u10` to `u50`, and another 3.5× to `u100`. So
  `timeMaterialization.ts` no longer runs it at those two scales unless asked to (`--include-slow`).
- Virtuoso's `INSERT`s are slow because it runs unvectorised (see "Setting up the engines"): 9.1 M triples
  take 30 min at `u50`, and 18.3 M take 65 min at `u100`.

The materialised views on disk, against 3.1 GB of N-Triples at LUBM `u100`, measured as the disk
actually allocated to each engine's store of them (TDB2 preallocates sparse files several times larger):

| Store | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| N-Triples | 23 MB | 294 MB | 1.5 GB | 3.1 GB | 7.8 GB | 15.6 GB | 4.3 MB | 58 MB |
| Jena (TDB2) | 20 MB | 251 MB | 1.3 GB | 2.7 GB | — | — | 5.2 MB | 60 MB |
| Oxigraph | 12 MB | 136 MB | 708 MB | 1.4 GB | — | — | 3.7 MB | 41 MB |
| QLever | 2.1 MB | 23 MB | 122 MB | 244 MB | 610 MB | 1.2 GB | 0.8 MB | 7.3 MB |
| HDT + index (Comunica) | 1.2 MB | 16 MB | 91 MB | 189 MB | — | — | 0.3 MB | 3.8 MB |
| Virtuoso | 92 MB | 210 MB | — | — | — | — | 59 MB | 59 MB |
| GraphDB | 74 MB | 159 MB | 564 MB | 1.1 GB | — | — | 69 MB | 90 MB |
| Blazegraph | 15 MB | 193 MB | 917 MB | 1.9 GB | — | — | 4.2 MB | 38 MB |

These are fresh stores loaded from the `CONSTRUCT` output.
- An empty Virtuoso database takes 59 MB and an empty GraphDB repository about 65 MB, which is most of
  their small sizes.
- Virtuoso has no row at `u50` and `u100`, where it can only `INSERT` into the source's store. That store's
  file grows in large steps and reuses free pages, so its growth (585 MB at `u50`, 149 MB at `u100`) does
  not measure the views.

LUBM's views take 1.36× the source, because the reasoning adds entailed triples; OAEI's take a third
of it, keeping only what maps into ekaw.

**After how many queries does building the views pay off?** The count is the build time divided by the
average saving per query against `+pullUpExtends`. Each engine uses its own build time and query times,
over the queries neither side errored on, with timeouts counted at the budget
(`timeMaterialization.ts --break-even results/results.json`). Each cell shows `preserveCardinality` off →
on:

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| Oxigraph | 9 → never | ≤ 620 → never | never | never | — | — | 490 → 877 | 552 → never |
| Jena | ≤ 1 | ≤ 2 | ≤ 8 | ≤ 11 | — | — | 117 → 1,149 | 11 → 82 |
| QLever | 6 → 9 | 16 → 17 | 29 → 22 | 28 → 30 | ≤ 39 → 37 | ≤ 105 → ≤ 91 | 103 → 75 | 37 → 124 |
| Virtuoso | 13 → 203 | ≤ 20 → 413 | ≤ 222 → 922 | ≤ 700 → ≤ 3,512 | — | — | 5 → 9 | ≤ 16 → ≤ 30 |
| GraphDB | ≤ 1 → 64 | ≤ 2 → 30 | ≤ 6 → 23 | ≤ 11 → 22 | — | — | ≤ 5 → 666 | ≤ 4 → ≤ 22 |
| Blazegraph | ≤ 1 | ≤ 2 | ≤ 7 | ≤ 14 | — | — | ≤ 2 | ≤ 2 |
| Comunica | ≤ 2 → 7 | ≤ 17 | ~364 → ~357 | ~1,299 → ~1,243 | — | — | 14 → 33 | ≤ 9 → ≤ 13 |

How to read the bounds:
- **≤:** the rewrite timed out on some queries, so the saving is understated and the count is an upper
  bound.
- **~:** the materialised query timed out on some queries as well, so the two errors pull in opposite
  directions.
- **never:** the rewrite is faster on average.

What the table shows:
- **Building pays off within a few dozen queries in most cells.** The median over the 44 cells is about 14
  queries, with `preserveCardinality` off.
- **The pay-off point rises with the data on every engine.** Building gets more expensive faster than the
  saving per query grows.
- **Jena, GraphDB and Blazegraph pay off within 14 queries on LUBM.** Their rewrites run far behind their
  materialised views.
- **Comunica needs over a thousand queries at `u100`,** because its build takes 14 hours.
- **On Oxigraph, building never pays off from LUBM `u50` up.** There its rewrite is faster than its own
  materialised views.
- **`preserveCardinality` moves the pay-off point later where it speeds the rewrite up.** That is GraphDB
  on LUBM, Virtuoso, and Jena on OAEI.

### Are the answers right?

All four pipelines and all workloads together, `preserveCardinality` off / on:

| Engine | answered | exact | repeats | wrong | ungraded | broken ref. |
|---|---|---|---|---|---|---|
| Oxigraph | 829 / 841 | 659 / 750 | 83 / 0 | 0 / 0 | 14 / 16 | 73 / 75 |
| Jena | 802 / 816 | 645 / 738 | 82 / 0 | 0 / 0 | 2 / 2 | 73 / 76 |
| QLever | 402 / 411 | 286 / 411 | 116 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Virtuoso | 482 / 523 | 300 / 346 | 76 / 0 | **106 / 177** | 0 / 0 | 0 / 0 |
| GraphDB | 519 / 655 | 471 / 655 | 48 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Blazegraph | 292 / 306 | 278 / 306 | 14 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Comunica | 578 / 553 | 503 / 515 | 37 / 0 | 0 / 0 | 0 / 0 | 38 / 38 |

Column meanings:
- **exact:** the same rows, the same number of times.
- **repeats:** the same rows, some repeated more often.
- **ungraded:** the reference timed out, so there is nothing to grade against.
- **broken ref.:** the answer differs from a StarBench reference that is itself broken.

- **Every wrong answer is a Virtuoso bug, and there are two** (see "Known issues"):
  - Pipelines 1–2: it drops `FILTER(sameTerm(?o, C))` over a `UNION` whose branches bind `?o` to different
    constants. Many OAEI queries come back with the whole union.
  - With `preserveCardinality` on, at pipelines 3–4: joining three or more `SELECT DISTINCT` subqueries
    loses rows at `VectorSize = 1`. That accounts for 38 answers.

  No other engine gives a wrong answer, on any workload or pipeline.
- **Repeats are expected with `preserveCardinality` off, and all of them are LUBM's.** A fact the ontology
  derives in several ways comes out once per derivation. With the option on they are gone: every graded
  LUBM and OAEI answer is exact, on every engine but Virtuoso.
- **Ungraded answers still match in size.**
  - Oxigraph's ungraded LUBM answers are queries whose own materialised reference timed out (see above).
    With `preserveCardinality` on, their row counts match the references of the engines that answered.
  - Where a hand-written StarBench reference timed out, the plain rewrite stands in as the reference, and
    that row itself counts as ungraded. These are Jena's reification `F-Q3` and `F-Q4`, and Oxigraph's
    `F-Q3` at `s`. Their sizes match every other engine's.
- **The broken references are StarBench's own** (see "Known issues"):
  - Nine singleton queries ask a different question.
  - The `F-Q1` and `F-Q2` references of both encodings return one variable too many (`SELECT *`).

  All 373 answers graded against them return the same number of rows on every engine and every pipeline.
  The nine singleton queries are also left out of every time comparison with the reference.
- **The OAEI check proves less than its count suggests.** The reference is empty for 23 of the 65
  queries on `d100` and 31 on `eswc`, because the sources lack those facts or no view produces them.
  There, the check only shows that the rewrite finds nothing either.

### What `preserveCardinality` changes

With the option, the unfolding wraps each triple pattern's `UNION` of derivations in a `SELECT DISTINCT`,
so the rewrite reads the virtual graph as the set it is. Whether that is worth paying for depends on
whether the views produce duplicates:
- **LUBM produces many.** A fact that several views derive comes out once per view, and a query joining
  such patterns multiplies the copies. QLever's Q02 returns 3.0 million rows at `u500` where the answer has
  1,284.
- **OAEI produces some.** Its four sources overlap: `ekaw:authorOf` comes from 7 views, `ekaw:Paper_Author`
  from 10 and `ekaw:Paper` from 11.
- **StarBench produces none.** Its views are already a set, so each `DISTINCT` has nothing to remove.

The full pipeline with the option on against off, paired query by query. In parentheses: queries where on
is faster · where off is faster (by more than 10%). Then queries answered off → on:

| Engine | LUBM | OAEI | StarBench reification | StarBench singleton |
|---|---|---|---|---|
| Oxigraph | ÷1.1 (15 · 19), 46 → 50 | ≈1 (14 · 19), 130 → 130 | ×1.2 (0 · 20), 24 → 24 | ×1.4 (1 · 20), 23 → 24 |
| Jena | ÷1.1 (17 · 13), 34 → 36 | ≈1 (30 · 32), 130 → 130 | ×1.4 (1 · 19), 24 → 24 | ×1.4 (1 · 21), 24 → 24 |
| QLever | ×1.1 (23 · 38), 71 → 76 | ×1.2 (16 · 86), 130 → 130 | — | — |
| Virtuoso | ÷2.7 (38 · 1), 47 → 51 | ≈1 (29 · 14), 126 → 127 | — | — |
| GraphDB | ÷1.9 (45 · 7), 23 → 52 | ÷1.5 (63 · 33), 122 → 129 | — | — |
| Blazegraph | ÷1.2 (10 · 8), 16 → 20 | ≈1 (23 · 48), 115 → 118 | — | — |
| Comunica | ≈1 (10 · 11), 23 → 24 | ≈1 (30 · 46), 128 → 129 | ×1.3 (1 · 21), 22 → 22 | ×1.2 (1 · 15), 19 → 19 |

- **GraphDB is where it matters: it answers all 52 LUBM queries instead of 23.**
  - Its query plan (`FROM onto:explain`) shows why. Without the option, GraphDB distributes a join over the
    rewrite's top-level `UNION`s (24 × 7 = 168 joins for Q05).
  - Each of those joins shares no variable, only two `BIND(?v AS ?uq_x)`s, so it becomes a cross product
    compared afterwards.
  - A `SELECT DISTINCT` subquery is a boundary that stops the distribution. Q05's pushdown times out at every
    scale without the option, and takes 0.4 s at `u1` and 29 s at `u100` with it.
- **Virtuoso runs LUBM 2.7 times faster with it, but in the form that loses rows** (the 38 answers above).
- **On LUBM's other engines it wins where duplicates multiply and loses where a large pattern meets a
  selective one.** On QLever, for example:
  - **Wins:** Q09, which runs out of QLever's 12 GB of query memory from `u10` on without the option,
    takes 2.8 s at `u10` and 41 s at `u500` with it. Q02 at `u500` goes from 47.9 s (3.0 M rows) to 5.6 s
    (1,284).
  - **Losses:** Q05 asks for the `Person`s who are members of one department. With the option, QLever must
    first deduplicate every `Person` in the data, so the time follows the data while the answer stays
    719 rows: 1.0, 3.4, 12, 18 and 44 s from `u1` to `u250`, and a timeout at `u500`. Q13 (one university's
    alumni) behaves the same way.
  - The two roughly cancel out: ÷1.1 to ×1.1 per engine.
- **On OAEI it wins where overlapping views meet in a join.** `is_author_of_paper` joins `Paper_Author`,
  `authorOf` and `Paper`, all three duplicated. At `d100`:
  - Jena: 59 s → 2.4 s.
  - QLever: 9.6 s → 1.2 s.
  - Oxigraph: 5.9 s → 1.7 s.
  - Comunica answers it in 17 s, where it timed out without the option.

  Elsewhere OAEI is close to neutral. QLever pays ×1.2 overall.
- **On StarBench it only costs:** 1.2 to 1.4 times slower on all three engines, with no answer changed.
  - The cost shows at the last rung: `+pullUpExtends` gains ÷1.1 to ÷1.6 with the option off, and only
    ÷1.05 to ÷1.3 with it on.
  - A `DISTINCT` subquery is a boundary that filters and joins cannot cross. In `singleton/F-Q1`, the
    `derives_from` pattern becomes such a subquery, so the engine computes and deduplicates every
    `derives_from` triple before the selective `REGEX` filter and the join can cut it down.

### Where the optimisations do not help, and why

- **Joins on `BIND`-computed variables across `UNION` groups.** After every pass, each query pattern is
  still a `UNION` with one branch per view, and each branch binds the shared variable through a `BIND`
  (`?v_7 cmt:writePaper ?v_8 . BIND(?v_7 AS ?v_6)`). Joining such groups gives an engine no index to look
  the other side up in, and no engine distributes the join over the branches usefully (GraphDB's attempt
  makes cross products, above). Examples:
  - **LUBM Q09** (student, advisor, course: three typed variables joined in a triangle). Without
    `preserveCardinality`, every pipeline fails on every engine from `u10` on: timeouts, and QLever's
    memory limit. The materialised query takes 0.16 s (QLever) to 42 s (Comunica) at `u10`. With the
    option, QLever answers it at every scale and Oxigraph up to `u50`.
  - **Jena answers none of LUBM Q02, Q07 and Q09** with any pipeline at any scale without
    `preserveCardinality`, and only Q07 (and Q02's plain rewriting) at `u1` with it.
  - **OAEI `is_author_of_paper`** on Jena `d100`: `+pullUpExtends` takes 59 s, slower than the plain
    rewriting's 27 s, against 0.8 s on the materialised views.
- **Identical `UNION` branches are not merged.** Where one view reaches a source predicate through a
  `UNION` and another reaches it directly, both branches survive. `is_author_of_paper`'s rewrite
  reads `cmt:writePaper`, `confOf:writes` and `edas:hasRelatedPaper` twice each.
- **The unoptimised rewrites are too big for the engines.** Without the pushdown, a LUBM rewrite runs to
  hundreds of thousands of characters. From `u50` on, the two pipelines before the pushdown answer 4 LUBM
  cells in total across all seven engines, all of them GraphDB's `+removeProjections`.
- **`EXISTS` inside a `BIND` is rewritten into a correlated `BIND`** (OAEI `early_registration`).
  - The pattern inside the `EXISTS` ends in `BIND(?v_0 AS ?uq_s)`, while `?uq_s` is already bound outside
    it, which SPARQL's substitution semantics leave undefined.
  - Most engines accept it. Virtuoso rejects it at `+pullUpExtends` ("Alias ?uq_s is defined twice"). With
    the option on, it fails at the other pipelines with an internal optimiser error.
  - The reference is empty at both scales, so this benchmark cannot say whether the answer would be right.
    Treat it as unverified.
- **Blazegraph orders joins of `BIND`-computed variables badly** (see "Known issues"). Even after the
  pushdown it answers 16 of 52 LUBM cells, and its stack overflows on the deeply nested plans before it.

## History

Earlier runs and their write-ups live in git history rather than in this file; the
results JSON and figures of superseded runs are not kept, since `plot.mjs` regenerates
figures from any results JSON. In summary:

| Date | What changed |
|---|---|
| 2026-07-28 | First run: Comunica + Oxigraph, three approaches, 30 s budget. |
| 2026-08-20 → 08-26 | `pushDownAssertions` added and extended (triple-term support, phase-5 operation rules). |
| 2026-08-27 | Jena added as a third engine; an ARQ triple-term bug found and reported upstream. |
| 2026-09-02 | Invalid-IRI data cleanup; full pipeline regenerated from the cleaned dumps. |
| 2026-09-03 | `pullUpExtends` added as a fourth pipeline; budget raised to 60 s. |
| 2026-09-07 | Reference switched from `rewriting` to the hand-written baseline, timeouts rendered as censored, dataset size recorded for every engine, budget raised to 300 s. |
| 2026-09-09 | Comunica moved into a worker process after `reification/F-Q3` OOM-killed two sweeps; the first complete 300 s run. |
| 2026-09-11 | `filterFalse` collapses statically empty branches through sub-`SELECT`s, so no rewrite carries a dead `FILTER(FALSE)` branch any more; the 300 s run above re-run on top of it. |
| 2026-09-14 | Traqula 1.3.1 fixes the generator's sub-`SELECT`-followed-by-`BIND` output (no benchmark query text changed). Comunica upgraded to 5.4.0 and its rows re-run: 22 more queries finish, and the `F-Q3` worker aborts became timeouts. |
| 2026-09-23 | The library's pipeline API replaced by factories and an async `QueryRewriter`, and the harness ported onto it. With `generalizedRdfView: true` the rewrites are the measured ones: 72 of 96 byte-identical, the other 24 (`standard`) identical but for internal variable names. Re-run on that basis. |
| 2026-09-23 → 09-24 | Jena moved to the `6.3.0-SNAPSHOT` nightly, the first build carrying the ARQ triple-term fix, and all 720 rows re-measured in one run on it. 32 Jena answers went from a fast wrong empty result to the baseline's, which raised the reification cost from ~13× to 20.3× and steepened the whole ladder: `pullUpExtends` vs `rewriting` on Jena went 0.45 → 0.15, and `removeProjections`, which the bug had made look like a pessimisation at 2.36, came out at 0.90. Every remaining mismatch is a corpus defect, identical across all four pipelines. |
| 2026-09-24 → 09-25 | LUBM (ontology compiled into 239 views, 1 and 10 universities) and OAEI Conference (148 views from four sources into ekaw, `data_100` and `eswc`) added as workloads, graded against the original query over the materialised views; Comunica reads their data as HDT. 60 s budget. |
| 2026-09-28 | The cost of materialising the LUBM and OAEI views with Jena measured (`timeMaterialization.ts`): 1.7–17 s to build, and 0.3× (OAEI) to 1.36× (LUBM) the source's size. |
| 2026-09-29 → 10-02 | The engines moved to native servers over on-disk stores they bulk-load once: Oxigraph's 0.5.11 binary instead of its WebAssembly build, Jena on TDB2 instead of an in-memory dataset, and QLever added for LUBM and OAEI. A server also stops a query shortly after its budget and is restarted after every timeout. LUBM grew to 50 and 100 universities. Every engine now materialises the views itself, and the pay-off point is worked out with its own build time. LUBM and OAEI re-measured on all four engines, StarBench re-measured on Oxigraph, where the plain rewriting went from answering nothing to 44 of 48 queries. |
| 2026-10-02 | LUBM `u250` (250 universities, 33 million triples) added for QLever only, about where its materialisation takes five minutes: 6.3 minutes, paying off after 63 queries. |
| 2026-10-02 | LUBM `u500` (67 million triples) run once on QLever: materialisation takes 25 minutes and pays off after 169 queries. `materializeViews.ts` now gzips its intermediate files and can check Jena's views against QLever (`--check qlever`), and materialisation requests no longer use `fetch`, whose five-minute header timeout Jena's `CONSTRUCT` of 67 million triples overran. |
| 2026-10-03 | Answers are streamed: each binding is read and canonicalised as it arrives, so no answer becomes one giant string and the 268MB response cap is gone. Every row it had cut off re-measured, and Jena's StarBench block re-run on TDB2. Large answers now count: QLever's LUBM pay-off falls to 27 queries at `u50` and at most 108 at `u500` (from 48 and 169), and `singleton/F-Q3`'s baseline turns out to be a ninth that asks a different question. |
| 2026-10-05 | LUBM run once with `preserveCardinality` on all four engines (`--preserve-cardinality`): every graded answer exactly right, Q09 answered on Oxigraph and QLever at every scale, Q05 and Q13 up to 4× slower on QLever. The pay-off point barely moves (QLever 23 queries at `u50`, at most 90 at `u500`), which shows that the drop after streaming came from the large answers entering the average, not from duplicates. |
| 2026-10-05 → 10-06 | StarBench and OAEI run once with `preserveCardinality` too. StarBench's views are already a set, so its `DISTINCT`s only cost: the full pipeline is 1.31–1.55× slower in median (up to a quarter of it drift between runs), mostly because each `DISTINCT` subquery is a boundary filters and joins cannot cross. OAEI's views overlap, so deduplicating mostly wins (`is_author_of_paper` 28× faster on Jena) and the pay-off point moves later (Jena 13 → 117 queries at `d100`). No answer changed. |
| 2026-10-13 → 10-14 | Virtuoso 7.2.17, GraphDB 11.5.1 Free and Blazegraph 2.1.6 RC added on LUBM and OAEI, with server-wide settings only (Virtuoso unvectorised, because its vectorised joins give wrong answers; GraphDB's heap at 36 GB). The only wrong answers in the benchmark are Virtuoso's: 105 from its `sameTerm` bug, all without the pushdown. With the pushdown, Virtuoso runs at 1.4–2.5× its materialised views on LUBM and at parity on OAEI; GraphDB and Blazegraph run at up to 41× and 73× on LUBM and pay off within 14 queries. |
| 2026-10-21 | Virtuoso, GraphDB and Blazegraph run once with `preserveCardinality` too. GraphDB's pushdown then answers all 13 LUBM queries at every scale (23 → 52 cells): its query plans show it splitting the flattened rewrite's joins into cross products, which the `DISTINCT` subqueries prevent. Virtuoso halves its LUBM time but loses rows on 38 cells, to a bug in joining three `SELECT DISTINCT` subqueries unvectorised. Blazegraph barely moves. |
| 2026-10-22 → 10-26 | One campaign replaces every earlier result. All seven engines and three workloads ran on the same commit and settings: the standard RDF view (`generalizedRdfView: false`, now `run.ts`'s default too), `preserveCardinality` off and on back to back for each query (`--paired-cardinality`), and the median of three runs for queries under 10 s (`--reps 3 --reps-below 10000`). Grading keeps a hash of each answer instead of its rows, so StarBench's 8.5-million-row answers no longer exhaust memory. `results.json` holds both settings, 12,996 rows, and `results-preserve-cardinality.json` is gone. `timeMaterialization.ts --break-even` counts each setting apart. `overview/` builds the results page from it. The pushdown carries the ladder on every engine and workload. The only wrong answers are Virtuoso's 283. StarBench's broken references are graded as such. Building the views pays off after a median of about 14 queries. |

## Extending

- **New engine**: implement `BenchEngine` (or reuse `SparqlHttpEngine` for any
  standards-compliant HTTP endpoint you start and load yourself) and add it to
  `makeEngine()` in `run.ts`. If it owns a long-lived external process (like
  `JenaEngine`'s Fuseki child), implement the optional `dispose()` so `run.ts` can shut
  it down.
- **New reification pattern**: add an entry to `PATTERNS` in `config.ts` with its CONSTRUCT
  mappers, materialized dataset filename and baseline query prefix, then generate its
  subsets with `makeSubset.mjs` (check whether its data structure needs its own
  `isClosureSeed` branch, like `singleton` does).
- **New pipeline**: add a `RewriteVariant` in `runner.ts`, its composition, an entry in
  `run.ts`'s `approaches` list, and a colour in `plot.mjs`'s `COLORS`.
