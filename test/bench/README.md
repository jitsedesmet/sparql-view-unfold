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

Four rewrite pipelines are measured, each a superset of the one before it, so the
difference between two adjacent bars is the contribution of one transformation:

| Approach | Pipeline |
|---|---|
| `rewriting` | `unfolding` → `filterFalse` → `nullifyJoinOverIncompatibleBounds` → `filterFalse` |
| `rewriting+removeProjections` | the above, then `removeProjections` (flattens the nested sub-`SELECT`s each mapper branch is wrapped in) |
| `rewriting+pushDownAssertions` | the above, then `pushDownAssertions` (pushes `FILTER(sameTerm(?x, c))` into the triple patterns that use `?x`, turning a free position into an indexed lookup) |
| `rewriting+pullUpExtends` | the above, then `pullUpExtends` twice (floats the `BIND`s the pushdown leaves at every leaf back up, or drops them) |

Each name above is the `<stem>Transformation()` factory of that stem; see `runner.ts` for the exact
composition, and for why `removeProjections` stays a step of the pushdown pipelines even though
Traqula 1.3.1 no longer needs it to keep their output parseable.

None of the four is the pipeline `createDefaultTransformationPipeline` builds, which is what a user of
the library gets by default: that one expands property paths first, runs `pullUpExtends` once and
`nullifyJoinOverIncompatibleBounds` last. The ladder here is built to isolate one pass at a time, not
to be the recommended configuration.

### How the mappers are read

The mappings are built with `generalizedRdfView: true`, so a solution binding a head variable to a
term the position of a *standard* RDF graph could not hold - a literal subject, a blank node predicate
- keeps its triple instead of being filtered out. This is not the library's default, and it is not the
honest reading of this corpus either: BKR data is standard RDF.

It is set because the guards are worth measuring on their own rather than folding into every other
number here. Turning them on costs 352 `isIRI`/`isBlank` filters across the 96 rewrites this
benchmark measures, and with the flag as it stands 72 of those 96 are byte-identical to the queries
every result below was measured on. The remaining 24 are the `standard` variant, the only one that
keeps the sub-`SELECT`s the unfolding produces, and they differ by nothing but the name each internal
variable carries. Quantifying the guards is the next experiment, not a footnote to this one.

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
- **`correctAsSet`** (LUBM and OAEI rows only) compares the *distinct* rows. It differs from
  `correct` only when an answer repeats a row more often than the reference does.
- **`quads`** is the size of the subset the row ran against, measured per file and shared
  by every engine; it is the x-axis of the scaling plot.

A note on `reps`: the default is 1, so `medianMs` is a single sample and there is no
warm-up. Query-to-query ratios within one run are the signal here; small differences
between runs are not.

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
| `plot.mjs` | Turns a results JSON into hand-rolled SVG figures (time-by-query, scaling, overhead, correctness) per scheme × engine. No dependencies. |
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
  --engines jena,oxigraph,comunica --schemes reification,singleton --scales xs,s \
  --reps 1 --timeout 300000 --out test/bench/results/results.json

# 3. Plot
node test/bench/plot.mjs test/bench/results/results.json test/bench/results/figures
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
views' included.

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
- **Virtuoso has limits compiled in that the unoptimised rewrites exceed:**
  - the SQL a query is translated into may have at most 10,000 lines (SP031);
  - a compiled query may hold about 65,000 state slots (SQ156, "Query too large");
  - an answer may have at most 2,097,151 rows (SR078);
  - a `CONSTRUCT` may build at most 2,097,150 triples (D1CTX), so it cannot materialise LUBM's identity view
    from `u50` on.

  These limits account for 81 of Virtuoso's 83 errors. The other two are `early_registration`'s
  `pullUpExtends` rewrite at both OAEI scales, which Virtuoso rejects ("Alias ?uq_s is defined twice"). That
  is the correlated `BIND` described under "Where the optimisations do not help".
- **Blazegraph 2.1.6 overflows its stack on the plain rewriting of OAEI** (19 queries) after about 50 s.
  With a 64 MB thread stack, the same query ran past 400 s without an answer, so the default stack was
  kept and the error is reported as such. On LUBM its optimiser orders Q04's lone `emailAddress`,
  `telephone` and `name` patterns, which are joined only through `BIND`-computed variables, first. That
  makes a cross product of about 10¹² rows, which no budget covers.
- **GraphDB 11.5 runs out of heap on some `removeProjections` rewrites at 12 GB and at 40 GB alike.** It
  then kills itself. Its start script passes `-XX:OnOutOfMemoryError=kill -9`, and by default it writes a
  heap dump the size of the heap into the store's directory. The harness switches the dumps off, caps the heap at
  36 GB, and starts a new server for the next query. In the full run these queries timed out before
  reaching the cap.

## Results

720 rows: 3 engines × 2 schemes × 2 scales (`xs` ≈ 300k quads, `s` ≈ 680k) × 12 queries ×
5 approaches, 1 rep, 300 s budget. **Comunica 5.4.0** was measured on 2026-09-23/24; **Oxigraph 0.5.11**
on its native server over an on-disk store on 2026-10-01, replacing the WebAssembly build the first run
used; and **Jena `6.3.0-SNAPSHOT`** (the first build with ARQ's triple-term fix) on TDB2 on 2026-10-03,
replacing its in-memory run. `results.json` holds them; `plot.mjs` regenerates the figures. All of it
was run once more with `preserveCardinality` on: see "With `preserveCardinality`" at the end.
624 `ok` and 96 censored at the budget: 75 of the timeouts are Comunica's, 11 Oxigraph's (all but one on
`F-Q3`, whose answer is 8,490,234 rows: Oxigraph takes 301 s just to send it, measured with curl) and 10
Jena's (`F-Q3`, and the `F-Q4` baseline). No row errors: answers are streamed, so the 8.5-million-row
`F-Q3` answers that once overran the harness's response cap are read in full.

Because so much is censored, **comparisons below are paired**: two approaches are compared
only on the (engine, scheme, scale, query) cells where both produced a real measurement,
and a "rescue" counts a cell where one finished and the other did not. A censored row is a
lower bound, so averaging one in would flatter whichever approach fails more often.

### The pipelines rank in order

| Comparison | cells | faster | median ratio | rescues | reverse rescues |
|---|---|---|---|---|---|
| `pullUpExtends` vs `pushDownAssertions` | 133 | 122 | 0.80 | 2 | 1 |
| `pullUpExtends` vs `rewriting` | 110 | 103 | 0.17 | 25 | 1 |
| `pushDownAssertions` vs `rewriting` | 110 | 103 | 0.23 | 24 | 1 |
| `removeProjections` vs `rewriting` | 106 | 64 | 0.97 | 2 | 5 |

The pushdown is worth roughly a 4× speed-up over the plain rewriting and the pull-up another 1.25× on
top, and between them they turn 25 queries that never finish into queries that do. The reverse
rescues all sit at the budget's edge: `F-Q3` on Jena, whose 8.5-million-row answer takes every
pipeline 190–300 s, so whether a run lands inside the budget is close to chance, and for
`removeProjections` also one Oxigraph `singleton/A-Q3`.

`removeProjections` on its own is neutral: 0.97, helping in 64 of 106 cells. It is worth keeping as a
rung because it is what the pushdown needs (a `FILTER` cannot be driven into a pattern hidden behind a
sub-`SELECT`), not for what it does alone.

### What the rewriting can answer at all

Queries answered within the budget, of 48 per cell (12 queries × 2 schemes × 2 scales):

| Engine | baseline | `rewriting` | `+removeProjections` | `+pushDownAssertions` | `+pullUpExtends` |
|---|---|---|---|---|---|
| Jena | 44 | 48 | 44 | 47 | 47 |
| Oxigraph | 46 | 46 | 45 | 46 | 46 |
| Comunica | 46 | 17 | 19 | 41 | 42 |

On Comunica the optimisation passes are the difference between a usable approach and an unusable
one: it goes from 17 to 42. Jena and native Oxigraph answer nearly everything either way; what they
miss is `F-Q3`, which sits at the budget (and Jena's `F-Q4` baseline, which on TDB2 takes over 300 s).
Oxigraph's WebAssembly build, which the first run used, answered **nothing** inside 300 s without the
pushdown, and 25 queries with it: the rewrites themselves did not change, the engine did.

### The honest cost: ~7× the hand-written query, and it is a floor rather than a multiple

On the cells where the pull-up rewrite finished *and* returned the baseline's answer:

| Scheme | cells | median cost |
|---|---|---|
| reification | 58 | **7.3×** |
| singleton | 21 | 218.6× |

Per engine on reification: Oxigraph **3.4×** (20 cells), Jena 7.9× (18), Comunica 39.4× (20).
The singleton figure is inflated by baselines that answer a different, mostly empty question
fast — see the correctness section.

The more useful observation is that the multiple is not stable, because the *rewrite* is what
is stable. Across the graded-correct cells:

| Engine | baseline times | pull-up times | rank correlation |
|---|---|---|---|
| Jena | 0.006 – 152.2 s (×25,361) | 0.06 – 5.5 s (×94) | ρ = −0.07 |
| Comunica | 0.03 – 8.3 s (×259) | 1.3 – 126.3 s (×98) | ρ = 0.41 |
| Oxigraph | 0.004 – 4.4 s (×1,106) | 1.3 – 7.5 s (×6) | ρ = 0.12 |

The hand-written queries span four orders of magnitude; the rewrites of those same queries
span one or two, and barely track them. A rewritten query costs what its own shape costs,
close to independently of how hard the question was. So the approach is ruinous on a cheap
query — Jena answers `reification/B-Q1` at `s` in 7 ms, where the pull-up rewrite of the
same question takes 2.5 s (355×) and the plain rewriting 10.1 s (1,439×) — and competitive or
better on an expensive one.

It does win outright, all on Jena/reification, and not marginally. On Oxigraph the rewrite beats the
baseline in no cell:

| | baseline | `+pullUpExtends` | rows |
|---|---|---|---|
| `F-Q4` xs | > 300 s | 4.2 s (**> 72×**) | 20,004 |
| `F-Q4` s | > 300 s | 3.9 s (> 77×) | 20,004 |
| `F-Q5` xs | 152.2 s | 2.1 s (71×) | 3,386 |
| `F-Q5` s | 151.8 s | 2.7 s (56×) | 3,386 |
| `A-Q4` xs | 0.5 s | 0.1 s (4×) | 1 |
| `A-Q3` xs | 0.3 s | 0.1 s (2×) | 0 |
| `F-Q2` xs | 0.1 s | 0.09 s (1.5×) | 0 |

`F-Q4` and `F-Q5` are won by the *plain* rewriting too (over 14× and 14× at `xs`), so this is not
the optimiser rescuing a bad rewrite — those two hand-written baselines are simply worse
queries than what the unfolding produces.

### Scaling

Median time multiplier from `xs` to `s`, which is ×2.6 the quads, on cells where both finished:

| Approach | cells | × time |
|---|---|---|
| baseline | 68 | 1.17 |
| `rewriting` | 49 | 2.28 |
| `+removeProjections` | 47 | 2.31 |
| `+pushDownAssertions` | 64 | 1.63 |
| `+pullUpExtends` | 65 | 1.65 |

The hand-written queries are nearly flat over this range, being index lookups against a
constant. The plain rewriting grows faster than the data; the pushdown-based pipelines grow
at about half that rate, so those passes improve the growth rate and not just the constant.

### Correctness: 182 mismatches, none of them the rewriter, and only two causes

483 of the 720 rows carry a verdict (a row is ungraded when nothing finished to compare
against, or when it *is* the reference). 182 disagree with the baseline, and they reduce
to two causes — the engine-defect category is gone, Jena's ARQ bug having been fixed:

| Cause | rows |
|---|---|
| Nine `singleton` baselines asking a different question | 158 |
| `reification/F-Q1`: `SELECT *` over different variable sets | 24 |

`F-Q1` is not a wrong answer at all. Both sides return the same 2 rows, but the baseline is a
`SELECT *` over the RDF 1.1 shape, so its `*` includes the reification node `?st` — a variable
the RDF 1.2 query has no equivalent for, since the whole point of the view is that the
statement node is not part of it. The solutions differ as *bindings* while agreeing as
answers.

The singleton cases are documented under "Known issues": corrected by hand, the 16 cells of the
first eight match the rewriting exactly. The ninth, `F-Q3`, could only be graded once answers were
streamed: its baseline returns nothing, while every rewrite returns the 8,490,234 rows the reification
baseline returns.

The strongest evidence that nothing here is the rewriter's: on Jena and on native Oxigraph, every
pipeline that finishes produces the **identical** set of mismatching cells, the same 19 on both
engines. A rewriting bug would show up in the pipelines that transform more, and it does not.

## LUBM and OAEI Conference

Two workloads with no triple terms in them, run through the same harness, the same four
pipelines and the same mapping options as StarBench (`generalizedRdfView: true`, and
`preserveCardinality` off). They exercise what StarBench does not: many views for one target, and
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

A rewritten query can repeat a row that the materialised graph, being a set, holds once. This happens
because the rewriting runs without `preserveCardinality`: a LUBM student who is a `GraduateStudent`
and also takes a course is a `Student` twice. So rows carry `correctAsSet` next to `correct`. Where
`correct` is false and `correctAsSet` is true, the mismatch is duplicates only, and that is expected
in this configuration. Every workload was also run once with `preserveCardinality` on
(`--preserve-cardinality`), which removes those duplicates: see "With `preserveCardinality`" below.

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
npx tsx test/bench/timeMaterialization.ts            # each engine materialising the views, below
NODE_OPTIONS=--max-old-space-size=12000 npx tsx test/bench/run.ts \
  --engines oxigraph,jena,qlever,comunica --schemes lubm,oaei --reps 1 --timeout 60000 \
  --out test/bench/results/workloads.json
npx tsx test/bench/timeMaterialization.ts --break-even test/bench/results/workloads.json
# Every workload with each view's triples counted once. Each run writes its own file, and
# results/results-preserve-cardinality.json is the three concatenated (LUBM, StarBench, OAEI).
NODE_OPTIONS=--max-old-space-size=12000 npx tsx test/bench/run.ts --preserve-cardinality --reps 1 \
  --engines oxigraph,jena,qlever,comunica --schemes lubm --timeout 60000 --out test/bench/results/bench-pc-lubm.json
NODE_OPTIONS="--max-old-space-size=12000 --expose-gc" npx tsx test/bench/run.ts --preserve-cardinality --reps 1 \
  --engines oxigraph,jena,comunica --schemes reification,singleton --scales xs,s --timeout 300000 \
  --out test/bench/results/bench-pc-starbench.json
NODE_OPTIONS=--max-old-space-size=12000 npx tsx test/bench/run.ts --preserve-cardinality --reps 1 \
  --engines oxigraph,jena,qlever,comunica --schemes oaei --timeout 60000 --out test/bench/results/bench-pc-oaei.json
```

### Results

3,770 rows (LUBM 1,170, OAEI 2,600) on four engines, 1 rep, 60 s budget, measured on 2026-10-01/02:
Oxigraph 0.5.11, Jena `6.3.0-SNAPSHOT` on TDB2 and QLever (master `8303d22`) on their native servers over
on-disk stores, and Comunica 5.4.0 over HDT (through `@comunica/query-sparql-hdt` 5.0.1). Oxigraph's LUBM
block and both of Jena's were re-run after the harness started restarting a server after every
timed-out query (see "Setting up the engines"): before that, six Oxigraph rows failed with
`fetch failed` right after a timeout. Jena's re-run matched its first run within 2% (median), with one
row near the budget flipping to a timeout. QLever's `u250` and `u500` blocks were measured on 2026-10-02.
The rows whose answers used to overrun the harness's response cap (Jena's LUBM Q06 at `u50` and `u100`,
QLever's Q02, Q06 and Q14 from `u50` on) were re-measured on 2026-10-03, once answers were streamed.
Virtuoso, GraphDB and Blazegraph were added on 2026-10-14. Their rows are in "Three more engines" below,
and the tables until then cover the first four engines.

| | LUBM ok / timeout / error | OAEI ok / timeout / error |
|---|---|---|
| Oxigraph | 187 / 73 (36 not run) / 0 | 646 / 4 / 0 |
| Jena | 156 / 104 (62 not run) / 0 | 640 / 10 / 0 |
| QLever | 220 / 4 (2 not run) / 166 | 390 / 0 / 260 |
| Comunica | 108 / 152 (103 not run) / 0 | 559 / 91 / 0 |

"Not run" rows timed out at a smaller LUBM scale. The errors:

- **QLever has no `sameTerm`** ("Built-in function "sameterm" not yet implemented"), which the plain
  rewriting and `removeProjections` use for every constant: 416 rows, all of those two pipelines. The
  pushdown removes the `sameTerm` filters, so its pipelines run.
- **QLever runs out of its 12 GB query memory on LUBM Q09** from `u10` on (10 rows).

Comparisons are paired and count rescues, as for StarBench above.

#### No wrong answers

Of these four engines' 2,151 graded rows, **none differs from the reference as a set of rows**. Virtuoso, added
later, gives 105 wrong answers. All of them come from its own bugs (see "Three more engines"). The 334 LUBM rows that fail
the multiset comparison are duplicates only, which is what running without `preserveCardinality`
against a set-valued reference predicts. The OAEI answers match exactly, since every competency question
is `SELECT DISTINCT`.

This proves less for OAEI than the count suggests. The reference is empty for 23 of the 65 queries on
`d100` and 31 on `eswc`, because the sources either lack those facts or have no view producing them.
There, the check shows only that the rewriting finds nothing too. That includes
`early_registration`, whose rewrite deserves a caveat of its own (below).

#### The ladder has StarBench's shape: the pushdown carries it

| | LUBM: cells | faster | median | rescues | OAEI: cells | faster | median | rescues |
|---|---|---|---|---|---|---|---|---|
| `removeProjections` vs `rewriting` | 47 | 22 | 1.01 | 0–9 | 333 | 263 | 0.96 | 10–3 |
| `pushDownAssertions` vs `removeProjections` | 47 | 47 | 0.10 | 126–0 | 343 | 343 | 0.01 | 174–0 |
| `pullUpExtends` vs `pushDownAssertions` | 173 | 162 | 0.80 | 1–0 | 517 | 441 | 0.72 | 2–0 |
| `pullUpExtends` vs `rewriting` | 56 | 56 | 0.06 | 118–0 | 336 | 333 | 0.01 | 183–0 |

- **`pushDownAssertions` is where the gain is.** It is 10–100× faster than the step before, faster in
  every one of the 390 paired cells, and it rescues 300 cells without losing one. It is also what makes
  the query small: LUBM Q09 goes from 488,628 characters (1,428 `UNION`s, 1,758 triple patterns) to
  13,900, and `pullUpExtends` takes it to 7,610 (34 `UNION`s, 52 patterns).
- **`removeProjections` alone does nothing for speed**, and on LUBM it loses 9 cells the plain
  rewriting finishes.

Queries answered, of 13 (LUBM) and 65 (OAEI), materialised views · `rewriting` · `+removeProjections` ·
`+pushDownAssertions` · `+pullUpExtends`:

| Scale | Oxigraph | Jena | QLever | Comunica |
|---|---|---|---|---|
| LUBM `u1` | 13 · 13 · 12 · 13 · 13 | 13 · 10 · 10 · 10 · 10 | 13 · 0 · 0 · 13 · 13 | 13 · 7 · 7 · 12 · 12 |
| LUBM `u10` | 13 · 12 · 8 · 12 · 12 | 13 · 9 · 9 · 9 · 9 | 13 · 0 · 0 · 12 · 12 | 13 · 0 · 0 · 5 · 5 |
| LUBM `u50` | 10 · 5 · 1 · 11 · 11 | 13 · 0 · 0 · 9 · 9 | 13 · 0 · 0 · 12 · 12 | 12 · 0 · 0 · 3 · 3 |
| LUBM `u100` | 6 · 0 · 0 · 11 · 11 | 13 · 0 · 0 · 5 · 5 | 13 · 0 · 0 · 12 · 12 | 11 · 0 · 0 · 2 · 3 |
| LUBM `u250` | — | — | 13 · 0 · 0 · 11 · 11 | — |
| LUBM `u500` | — | — | 13 · 0 · 0 · 11 · 11 | — |
| OAEI `eswc` | 65 · 64 · 64 · 65 · 65 | 65 · 63 · 63 · 65 · 65 | 65 · 0 · 0 · 65 · 65 | 65 · 63 · 62 · 65 · 65 |
| OAEI `d100` | 65 · 64 · 64 · 65 · 65 | 65 · 63 · 62 · 64 · 65 | 65 · 0 · 0 · 65 · 65 | 65 · 19 · 28 · 63 · 64 |

#### Against the materialised views: it depends on the engine more than on the workload

The `materialized` column answers the same question with the views already computed, in a store of
their own. Median of `pullUpExtends` over the source against it, on cells where both finished:

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| Oxigraph | 1.20× | 0.88× | 0.58× | 0.51× | — | — | 1.00× | 0.80× |
| Jena | 4.2× | 53× | 292× | 606× | — | — | 0.86× | 0.86× |
| QLever | 11.8× | 16.1× | 18.1× | 31.9× | 70× | 106× | 1.92× | 1.74× |
| Comunica | 32× | 13.8× | 19.5× | 31.9× | — | — | 1.50× | 2.50× |

- **OAEI is vocabulary translation, and there the rewriting runs at parity:** 1.14× over all 519 cells,
  faster than the materialised query on Jena and Oxigraph. 18 of the 65 queries are rewritten into
  queries that are empty by construction (no view produces what they ask for), which every engine
  answers in milliseconds.
- **LUBM is reasoning, and there it costs, and the cost grows with the data** on Jena, QLever and
  Comunica. Jena is the extreme: most of its materialised queries stay at milliseconds up to `u100`,
  its rewrites grow with the data, and only 5 of 13 still finish at `u100`. The difference is fan-out. An
  OAEI term has at most one view per source; a LUBM class like `Person` or `Student` has dozens of ways
  to be derived, and the entailed facts are exactly what the queries ask for.
- **Oxigraph is the exception: it answers the materialised views more slowly than the rewrite.** LUBM Q01
  takes it 55 s on the views at `u100` and 0.3 s rewritten; at `u100` six of its 13 materialised queries
  finish and eleven rewrites do. Q01 is "graduate students taking `GraduateCourse0`". Over the views
  Oxigraph apparently starts from every graduate student; the pushed-down rewrite has the course as a
  constant in each branch, and Oxigraph starts there. Its scans are also slow: reading the 274,699
  `takesCourse` triples of `u10` takes it 7–9 s, through the server or its own command line, where Jena
  needs 0.5 s.

#### What materialising costs, per engine

The comparison above assumes the views already exist. Views that change, or that live only briefly,
have to be built again each time. `timeMaterialization.ts` measures that for every engine, doing all of
it itself: running every view's `CONSTRUCT` against its own store of the source, then loading the output
into a fresh store of its own, the way it loads data fastest. Starting the server on the source store is
not counted, because the rewriting needs it too. Measured once, on 2026-09-30/10-01, and for Virtuoso,
GraphDB and Blazegraph on 2026-10-14; `results/materialization.json` holds the numbers.

Doing it inside the database with one `INSERT { GRAPH … } WHERE { … }` per view is slower on every engine
that supports it, at LUBM `u10` (`results/materialization-methods-u10.json`): QLever 74 s against 16 s,
Jena 131 s against 35 s, Oxigraph 159 s against 153 s. Comunica cannot write, so it builds an HDT file
and its index from its own `CONSTRUCT` output. Of the engines added later:
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

Running the views is most of it up to `u250`: at `u100` it is 92 s of QLever's 125 and 246 s of Jena's 390,
at `u250` 226 s of QLever's 378. At `u500` QLever's index build catches up, 716 s of its 1,489: it grew 4.7×
from `u250` for twice the data, the views 3.4×.
Comunica's grows far faster than the data, 22× from `u10` to `u50` and another 3.5× to `u100`, so
`timeMaterialization.ts` no longer runs it at those two scales unless asked to (`--include-slow`).
Virtuoso's `INSERT`s are slow because it runs unvectorised (see "Setting up the engines"): 9.1 M triples
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

These are fresh stores loaded from the `CONSTRUCT` output. An empty Virtuoso database takes 59 MB and an
empty GraphDB repository about 65 MB, which is most of their small sizes. Virtuoso has no row at `u50` and
`u100`, where it can only `INSERT` into the source's store. That store's file grows in large steps and
reuses free pages, so its growth (585 MB at `u50`, 149 MB at `u100`) does not measure the views.

LUBM's views take 1.36× the source, because the reasoning adds entailed triples; OAEI's take a third
of it, keeping only what maps into ekaw.

**After how many queries does building the views pay off?** The build time over the average per-query
saving against `pullUpExtends`, per engine, with that engine's own build time and query times
(`timeMaterialization.ts --break-even`):

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| Jena | ≤ 1 | ≤ 2 | ≤ 7 | ≤ 11 | — | — | 134 | 13 |
| QLever | 6 | 14 | 27 | 26 | ≤ 41 | ≤ 108 | 110 | 38 |
| Comunica | ≤ 2 | ≤ 17 | ~365 | ~1,302 | — | — | 13 | ≤ 10 |
| Oxigraph | 11 | ≤ 259 | never | never | — | — | never | 298 |
| Virtuoso | 13 | 56 | ≤ 249 | ≤ 623 | — | — | 5 | ≤ 16 |
| GraphDB | ≤ 1 | ≤ 2 | ≤ 6 | ≤ 11 | — | — | ≤ 5 | ≤ 4 |
| Blazegraph | ≤ 1 | ≤ 2 | ≤ 7 | ≤ 14 | — | — | ≤ 2 | ≤ 2 |

A timed-out rewrite counts at the 60 s budget, which understates the saving: those counts are upper
bounds (≤). Where materialised queries timed out as well (~, and Oxigraph's "never" at `u50`/`u100`),
the two errors pull in opposite directions. For Oxigraph, most of the materialised queries that time out
are ones its rewrites answer in 2–16 s, so materialising does not pay there either way.

So **the number of queries a view can serve before building it pays off rises with the data on every
engine**, because building gets more expensive faster than the saving per query grows. How far it rises
depends on the engine. Jena's rewrites slow down so much with LUBM's fan-out that building still pays off
within a dozen queries at `u100`. QLever builds fast, but its rewrites slow down from 12× to 70× its
materialised queries between `u1` and `u250`, and to 106× at `u500`, so its pay-off point rises from 6
queries at `u1` to at most 41 at `u250` and at most 108 at `u500`. Comunica's 14-hour build needs over a thousand. On Oxigraph the materialised views
are no faster to query, so building never pays off at all. On OAEI, where the rewriting runs at parity,
building takes 10 to 298 queries to pay off, and never on Oxigraph at `eswc`.

The three engines added later follow the same rule: the closer an engine's rewrites come to its own
materialised views, the longer building them takes to pay off.
- **GraphDB and Blazegraph pay off within 14 queries everywhere**, like Jena, because their rewrites run
  at 5–73× their materialised views on LUBM.
- **Virtuoso needs the most queries of the three**: 56 at `u10`, up to 623 at `u100`. Its rewrites stay
  within 2.5× its views, and its unvectorised `INSERT` takes an hour at `u100`.

#### Where the optimisations do not help, and why

- **Joins on `BIND`-computed variables across `UNION` groups.** After every pass, each query pattern
  is still a `UNION` with one branch per view, and each branch binds the shared variable through a
  `BIND` (`?v_7 cmt:writePaper ?v_8 . BIND(?v_7 AS ?v_6)`). Joining such groups gives an engine no
  index to look the other side up in, and none of the four engines distributes the join over the
  branches. Examples:
  - **LUBM Q09** (student, advisor, course: three typed variables joined in a triangle) fails from
    `u10` on with every pipeline on every engine (timeouts, and QLever's memory limit), while the
    materialised query takes 0.16 s (QLever) to 47 s (Comunica) at `u10`. Most of that is duplicates:
    with `preserveCardinality` Oxigraph and QLever answer it at every scale (below).
  - **Jena answers none of LUBM Q02, Q07 and Q09** with any pipeline at any scale (without
    `preserveCardinality`).
  - **OAEI `is_author_of_paper`** on Jena `d100`: `pullUpExtends` takes 47 s, *slower* than the
    plain rewriting's 28 s, against 1.0 s on the materialised views.
- **Identical `UNION` branches are not merged.** Where one view reaches a source predicate through a
  `UNION` and another reaches it directly, both branches survive. `is_author_of_paper`'s rewrite
  reads `cmt:writePaper`, `confOf:writes` and `edas:hasRelatedPaper` twice each.
- **The unoptimised rewrites are too big for the engines.** Without the pushdown, a LUBM rewrite
  has up to 575 k characters and takes up to a minute just to rewrite (Q02 and Q09). At `u50` the plain
  rewriting finishes 5 queries on Oxigraph and none elsewhere; at `u100`, none anywhere.
- **`EXISTS` inside a `BIND` is rewritten into a correlated `BIND`** (OAEI `early_registration`). The
  pattern inside the `EXISTS` ends in `BIND(?v_0 AS ?uq_s)` while `?uq_s` is already bound outside
  it, which SPARQL's substitution semantics leave undefined. The engines accept it, but the
  reference is empty at both scales, so this benchmark cannot say whether the answer would be
  right. Treat it as unverified.
- **Comunica and QLever stay at 1.5–2.5× the materialised views on OAEI** where Jena and Oxigraph are
  at parity: they pay more per `UNION` branch.

#### Three more engines: Virtuoso, GraphDB and Blazegraph

2,730 more rows, 910 per engine, measured on 2026-10-14 with the same protocol: LUBM `u1`–`u100`, OAEI
`eswc` and `d100`, 60 s budget, 1 rep. The engines are Virtuoso 7.2.17 (open source, run unvectorised),
GraphDB 11.5.1 Free (heap capped at 36 GB) and Blazegraph 2.1.6 RC. Each runs as its native server over an
on-disk store of its own (see "Setting up the engines"). None of them has RDF 1.2, so none runs StarBench.
Each one's reference answers agree with Jena's, Oxigraph's and QLever's at every scale.

| | LUBM ok / timeout / error | OAEI ok / timeout / error |
|---|---|---|
| Virtuoso | 148 / 55 (39 not run) / 57 | 515 / 109 / 26 |
| GraphDB | 124 / 136 (94 not run) / 0 | 577 / 73 / 0 |
| Blazegraph | 82 / 178 (130 not run) / 0 | 393 / 236 / 21 |

Queries answered **correctly**, of 13 (LUBM) and 65 (OAEI), in the column order used above:
materialised views · `rewriting` · `+removeProjections` · `+pushDownAssertions` · `+pullUpExtends`.

| Scale | Virtuoso | GraphDB | Blazegraph |
|---|---|---|---|
| LUBM `u1` | 13 · 0 · 0 · 13 · 13 | 13 · 13 · 2 · 8 · 8 | 13 · 0 · 0 · 6 · 6 |
| LUBM `u10` | 13 · 0 · 0 · 12 · 12 | 13 · 8 · 2 · 5 · 5 | 13 · 0 · 0 · 4 · 5 |
| LUBM `u50` | 13 · 0 · 0 · 11 · 11 | 13 · 0 · 2 · 4 · 5 | 13 · 0 · 0 · 2 · 3 |
| LUBM `u100` | 13 · 0 · 0 · 11 · 11 | 13 · 0 · 2 · 3 · 5 | 13 · 0 · 0 · 2 · 2 |
| OAEI `eswc` | 65 · 12 · 2 · 65 · 64 | 65 · 64 · 42 · 64 · 64 | 65 · 0 · 35 · 62 · 62 |
| OAEI `d100` | 65 · 12 · 2 · 63 · 62 | 65 · 64 · 33 · 58 · 58 | 65 · 0 · 0 · 51 · 53 |

Median of `pullUpExtends` against the materialised views, on cells where both answered correctly (cell
counts in parentheses):

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|
| Virtuoso | 1.44× (13) | 2.48× (12) | 1.44× (11) | 2.31× (11) | 1.00× (64) | 1.00× (62) |
| GraphDB | 19× (8) | 5.2× (5) | 19× (5) | 41× (5) | 1.29× (64) | 1.28× (58) |
| Blazegraph | 39× (6) | 11× (5) | 16× (3) | 73× (2) | 1.20× (62) | 1.45× (53) |

- **Virtuoso gives the only wrong answers in the benchmark, and they are its bugs** (see "Known issues").
  - 105 of its 481 graded answers are wrong as a set: 103 on OAEI and the plain rewriting's only two answers
    on LUBM. All of them come from the plain rewriting or `removeProjections`.
  - Every answer after the pushdown is right.
  - Those two pipelines hit its compiled-in limits too. On LUBM they answer nothing correctly; on OAEI, 12
    and 2 queries.
  - With the pushdown, Virtuoso comes closest of the seven engines to its own materialised views. On LUBM,
    `pullUpExtends` runs at 1.4–2.5× them and still answers 11 of 13 at `u100`. On OAEI it runs at parity.
  - Running unvectorised slows its materialised queries as well, so that ratio compares like with like.
- **On GraphDB the plain rewriting does best on LUBM's smallest scales.** It is the only engine on which
  the unoptimised rewrite answers all 13 LUBM queries at `u1`, in 1.6–11 s, Q09 included.
  - The pushdown is faster wherever both finish (median 0.28× on LUBM, 0.03× on OAEI).
  - But it loses 7 LUBM cells the plain rewriting answers, and rescues 4. Q02, Q05, Q07, Q08 and Q09 time out after
    the pushdown at `u1`.
  - From `u50` on, the plain rewriting answers nothing and the optimised ones answer 3–5 queries.
  - `removeProjections` is GraphDB's worst pipeline: it loses 11 LUBM and 53 OAEI cells to the plain
    rewriting. Some of them ran it out of heap in the smoke tests; in this run they timed out first.
- **Blazegraph answers nothing without the pushdown on LUBM, and nothing with the plain rewriting on
  OAEI.**
  - On OAEI, 19 of those plain-rewriting queries overflow its stack.
  - The pushdown rescues 113 OAEI cells and every LUBM cell it answers.
  - Even then, it answers 2 of 13 LUBM queries at `u100`, at 73× its materialised views. It orders joins of
    `BIND`-computed variables badly, as Q04 shows (see "Known issues").

## With `preserveCardinality`

Every row above runs the rewriting without `preserveCardinality`. With it, the unfolding wraps each
triple pattern's `UNION` of derivations in a `SELECT DISTINCT`, so the rewrite reads the virtual
graph as the set it is. Whether that is worth paying for depends on whether the views produce
duplicates in the first place:

- **LUBM produces many.** A fact that several views derive comes out once per view: a `GraduateStudent`
  is a `Person` through a dozen derivations, and a query joining such patterns multiplies the copies.
  LUBM Q02 returns 3.0 million rows at `u500` where the answer has 1,284, and Q09 exhausts QLever's
  12 GB from `u10` on.
- **OAEI produces some.** Its four sources overlap: `ekaw:authorOf` comes from 7 views,
  `ekaw:Paper_Author` from 10 and `ekaw:Paper` from 11, and two pairs (`cmt-ekaw#1` and `#3`,
  `confOf-ekaw#4` and `#5`) derive the same triple from the same source property.
- **StarBench produces none.** Its views are already a set: without `preserveCardinality` the
  rewrites' row counts equal the sound baselines' in all 352 cells. Each `DISTINCT` has nothing to
  remove, so it can only cost.

All three were re-run that way on 2026-10-05/06 with the same engines, scales and budgets: 4,490 rows
in `results/results-preserve-cardinality.json` (LUBM 1,170, StarBench 720, OAEI 2,600), each marked
`preserveCardinality: true`. The rewrites are 5–35% longer, with 2–6 `DISTINCT`s in a StarBench
rewrite, and take no longer to rewrite. The `materialized` rows, whose query does not change, were
measured again in the same runs as a control for drift between runs. Their median ratio to the
earlier run is 0.96–1.02 on LUBM and OAEI, except Oxigraph's LUBM at 1.17. On StarBench it is 1.17
(Comunica), 1.23 (Jena) and 1.25 (Oxigraph), so up to a quarter of a StarBench slowdown below can
be the machine rather than the `DISTINCT`s. The comparison inside each run, further down, is free of
that.

**No answer changed, except to become right.** Wherever both runs finished, StarBench and OAEI return
the same number of rows in every cell. Every graded OAEI answer is still exact, since every OAEI
query is `SELECT DISTINCT`. On LUBM, all 459 graded rows now equal the reference as multisets,
against 102 of 436 without it: the 334 duplicate-only mismatches are gone.

### LUBM: wins where duplicates multiply, losses where a big pattern meets a selective one

The full pipeline (`pullUpExtends`) against itself without `preserveCardinality`, over every LUBM scale:

| Engine | answered | rescued – lost | paired | median time ratio | faster · slower |
|---|---|---|---|---|---|
| Oxigraph | 47 → 52 | 5 – 0 | 47 | 1.32 | 8 · 30 |
| Jena | 33 → 35 | 2 – 0 | 33 | 0.91 | 11 · 7 |
| QLever | 71 → 76 | 7 – 2 | 69 | 1.07 | 20 · 26 |
| Comunica | 23 → 24 | 1 – 0 | 23 | 1.02 | 6 · 9 |

"Faster" and "slower" count paired cells that moved by more than a quarter. On QLever, per query:

| QLever, `pullUpExtends` | `u100` without | `u100` with | `u500` without | `u500` with |
|---|---|---|---|---|
| Q02 | 3.5 s (123,882 rows) | 1.6 s (264) | 53.3 s (3.0 M) | 6.5 s (1,284) |
| Q06 | 32.6 s (6.6 M) | 6.5 s (1.05 M) | not run | 28.7 s (5.2 M) |
| Q09 | out of memory | 8.5 s (27,247) | out of memory | 40.8 s (136,165) |
| Q05 | 8.9 s (5,625) | 25.4 s (719) | 14.6 s (5,625) | > 60 s |
| Q13 | 8.6 s (6,472) | 22.4 s (472) | 22.4 s (32,441) | > 60 s |
| Q14 | 6.0 s (795,970) | 4.1 s (795,970) | 18.9 s (4.0 M) | 20.2 s (4.0 M) |

- **Where duplicates multiplied through joins, deduplicating first wins**, by up to 77× (Oxigraph's
  Q09 at `u1`, 13.1 s to 0.17 s). Q09 now finishes at every scale on Oxigraph (2.4 s at `u10`, 35 s at
  `u100`) and, through the full pipeline, on QLever up to `u500`, where it ran out of memory before. Jena answers Q07 at `u1` and Q08
  at `u10` for the first time.
- **Where a large pattern meets a selective one, deduplicating first loses.** Q05 asks for the `Person`s
  who are members of one department, and Q13 for one university's alumni. Without `DISTINCT` the engine
  joins each derivation of `Person` with the selective pattern and keeps few rows. With it, it must first
  deduplicate every `Person` in the data, so the time follows the data while the answer stays the same:
  QLever's Q05 takes 1.0, 3.2, 12, 25 and 58 s from `u1` to `u250` for the same 719 rows, and its Q13 at
  `u250` slows down 4.3×. Q04
  (`Professor`s of one department) behaves the same way, more mildly.
- **Queries with no duplicates pay a little** for the extra `DISTINCT`s (Q14, Q01). On Comunica, five
  plain `removeProjections` rows at `u1` that finished in 44–54 s now overrun the 60 s budget.

**The pay-off point barely moves**:

| Engine | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` |
|---|---|---|---|---|---|---|
| Jena | ≤ 1 → ≤ 1 | ≤ 2 → ≤ 2 | ≤ 7 → ≤ 7 | ≤ 11 → ≤ 11 | — | — |
| QLever | 6 → 9 | 14 → 16 | 27 → 23 | 26 → 24 | ≤ 41 → 31 | ≤ 108 → ≤ 90 |
| Comunica | ≤ 2 → 7 | ≤ 17 → ≤ 17 | ~365 → ~359 | ~1,302 → ~1,252 | — | — |
| Oxigraph | 11 → never | ≤ 259 → never | never | never | — | — |

So duplicates are not why the pay-off fell when answers started being streamed (27 queries at `u50` from
48 before, on QLever). That fall came from which queries are counted. Before streaming, the answers too
large for the response cap were left out. Streaming let them in, and Q06, with 3.3 million rows where
the answer has 0.5 million, saved 14 s a query at `u50`. With `preserveCardinality` that saving shrinks
to 0.5 s. But Q05 and Q13 each save 8 s more than before, and Q09 now counts too (4.5 s), so the
average saving stays about the same: 2.8 s against 2.4 s. The 48 measured before streaming was high
because the expensive queries were left out, not because duplicates were inflating the costs.

On Oxigraph, deduplication tips small scales towards the rewrite. Its rewrites now beat its own
materialised views at `u1` (median 0.2×) and `u10` (0.7×), so building them never pays off at any scale.

### OAEI: overlapping views, so deduplicating mostly wins

The full pipeline against itself without `preserveCardinality`, over both datasets:

| Engine | answered | rescued – lost | paired | median time ratio | faster · slower | total, paired cells |
|---|---|---|---|---|---|---|
| Oxigraph | 130 → 130 | 0 – 0 | 130 | 1.00 | 28 · 22 | 31 s → 25 s |
| Jena | 130 → 130 | 0 – 0 | 130 | 0.80 | 53 · 20 | 72 s → 17 s |
| QLever | 130 → 130 | 0 – 0 | 130 | 1.13 | 30 · 35 | 18 s → 10.5 s |
| Comunica | 129 → 129 | 1 – 1 | 128 | 1.00 | 41 · 34 | 158 s → 114 s |

Most OAEI queries take a few milliseconds, where the per-cell ratio is noise; the totals carry the
signal. QLever's totals need a caveat: its `materialized` queries also got faster in this run (5.2 s
to 3.8 s in total), so much of its drop is the run.

- **Where overlapping views meet in a join, deduplicating first wins.** `is_author_of_paper` joins
  `Paper_Author`, `authorOf` and `Paper`, all three duplicated. At `d100` it goes from 47.5 s to 1.7 s
  on Jena, 8.8 s to 1.1 s on QLever and 6.3 s to 1.2 s on Oxigraph, and Comunica answers it in 16.7 s
  where it timed out before. `assigned_reviewer_author_of_review` and `topic_of_paper` gain 2–4× on
  Jena and Comunica.
- **Comunica also loses some.** At `d100`, `external_reviewer` goes from 4.7 s to 11.3 s and
  `early_registration` from 26.5 s to a timeout. Its two least-optimised steps took 52–59 s on 19
  (`rewriting`) and 28 (`removeProjections`) queries, and the extra `DISTINCT`s push all of them past
  the 60 s budget.

Since materialising builds the same views, faster rewrites push the pay-off point later:

| Engine | OAEI `eswc` | `d100` |
|---|---|---|
| Jena | 134 → never | 13 → 117 |
| QLever | 110 → 79 | 38 → 108 |
| Comunica | 13 → 33 | ≤ 10 → ≤ 13 |
| Oxigraph | never → never | 298 → 2,227 |

QLever's `eswc` moves the other way because its materialised queries ran faster this time.

### StarBench: the views are already a set, so the `DISTINCT`s only cost

The full pipeline against itself without `preserveCardinality`, over both schemes and scales, 300 s
budget:

| Engine | answered | rescued – lost | paired | median time ratio | faster · slower | `materialized` control |
|---|---|---|---|---|---|---|
| Oxigraph | 46 → 48 | 2 – 0 | 46 | 1.55 | 0 · 36 | 1.25 |
| Jena | 47 → 48 | 1 – 0 | 47 | 1.31 | 1 · 28 | 1.23 |
| Comunica | 42 → 40 | 0 – 2 | 40 | 1.53 | 0 · 29 | 1.17 |

Almost nothing gets faster. The cost grows along the pipeline: the median ratio per step, from
`rewriting` through `removeProjections` and `pushDownAssertions` to `pullUpExtends`, is 1.30, 1.28,
1.44 and 1.55 on Oxigraph, 1.05, 1.05, 1.12 and 1.31 on Jena, and 1.27, 1.21, 1.30 and 1.53 on
Comunica. A comparison inside each run, free of the drift, says the same: `pullUpExtends` takes
0.21 → 0.26 of plain `rewriting`'s time on Oxigraph, 0.13 → 0.22 on Jena and 0.15 → 0.22 on Comunica.
The `DISTINCT`s mostly eat what the later steps gain.

- **The cost is the boundary, not the deduplication.** In `singleton/F-Q1`, the `derives_from` pattern
  becomes a `SELECT DISTINCT` subquery. Without it, the `REGEX` filter on `?source` and the join with
  the selective first pattern cut that pattern down early. With it, the engine first computes and
  deduplicates every `derives_from` triple. On Oxigraph that is 2.0 s to 8.6 s at `s`.
- **The worst cells** are 4.6× on Oxigraph (`reification/F-Q5`, `xs`), 4.4× (`singleton/F-Q1`) and
  3.3–3.5× (`singleton/B-Q3`); 2.3× on Jena (`reification/F-Q4`, `s`); and 3.1× on Comunica
  (`reification/A-Q3`, `s`, 39 s to 123 s). Comunica's `singleton/B-Q2` at `s` goes from 80 s to
  over 300 s.
- **Rescues and losses are budget-edge noise.** On Oxigraph and Jena all but one are `F-Q3`, whose
  8.5-million-row answer takes most of the 300 s to send (Oxigraph's go both ways). Every one of
  Comunica's eleven losses over the four steps took 215–295 s before, except `singleton/B-Q2` above.

So `preserveCardinality` buys correct multiplicities where views overlap, and there it often pays for
itself. Where the views are already a set, it has nothing to buy, yet the full pipeline still pays
1.3–1.55× for it in median, partly drift, and loses much of what `pullUpExtends` gains.

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
