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
| Eclipse RDF4J | ⚠️ old `<< >>` only | ❌ | — | (cannot run the new syntax) |
| Ontotext GraphDB | ⚠️ old `<< >>` only | ❌ | — | inherits RDF4J limitation |
| **QLever** | ❌ SPARQL 1.1 only | ❌ | — | C++ server over its own index here; runs the LUBM and OAEI workloads only |
| Blazegraph, Stardog, Virtuoso, MillenniumDB | ❌ SPARQL 1.1 only | ❌ | — | not usable for native SPARQL 1.2 |

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

`--engines` accepts `comunica`, `oxigraph`, `jena` and `qlever`; QLever skips StarBench, which needs SPARQL 1.2.

## Setting up the engines

Every engine answers from data it has loaded and indexed once, the way it is built to be used, and is then
queried warm:

| Engine | Server | Store | Loaded with |
|---|---|---|---|
| Oxigraph | `oxigraph serve-read-only` | RocksDB on disk | `oxigraph load` (its bulk loader) |
| Jena | `fuseki-server.jar --tdb2 --loc` | TDB2 on disk | `tdb2.tdbloader --loader=parallel` |
| QLever | `qlever-server` | its index on disk | `qlever-index` |
| Comunica | `comunicaWorker.mjs` | HDT (LUBM, OAEI), in-memory N3 store (StarBench) | `rdf2hdt`, or parsing the Turtle |

The three servers share `ManagedServerEngine` (`engines.ts`). It bulk-loads a store beside each data file the
first time that file is queried (`lubm-u10.nt` → `lubm-u10.oxigraph/`, `lubm-u10.tdb2/`, `lubm-u10.qlever/`),
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

## Results

720 rows: 3 engines × 2 schemes × 2 scales (`xs` ≈ 300k quads, `s` ≈ 680k) × 12 queries ×
5 approaches, 1 rep, 300 s budget. **Comunica 5.4.0** was measured on 2026-09-23/24; **Oxigraph 0.5.11**
on its native server over an on-disk store on 2026-10-01, replacing the WebAssembly build the first run
used; and **Jena `6.3.0-SNAPSHOT`** (the first build with ARQ's triple-term fix) on TDB2 on 2026-10-03,
replacing its in-memory run. `results.json` holds them; `plot.mjs` regenerates the figures.
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
in this configuration.

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

Of 2,151 graded rows, **none differs from the reference as a set of rows**. The 334 LUBM rows that fail
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
not counted, because the rewriting needs it too. Measured once, on 2026-09-30/10-01;
`results/materialization.json` holds the numbers.

Doing it inside the database with one `INSERT { GRAPH … } WHERE { … }` per view is slower on every engine
that supports it, at LUBM `u10` (`results/materialization-methods-u10.json`): QLever 74 s against 16 s,
Jena 131 s against 35 s, Oxigraph 159 s against 153 s. Comunica cannot write, so it builds an HDT file
and its index from its own `CONSTRUCT` output.

| Build time | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| QLever | 5.6 s | 16 s | 64 s | 125 s | 378 s | 25 min | 3.5 s | 6.4 s |
| Jena | 8.2 s | 32 s | 178 s | 390 s | — | — | 5.3 s | 11 s |
| Oxigraph | 11 s | 144 s | 951 s | 41 min | — | — | 3.1 s | 23 s |
| Comunica | 15 s | 650 s | 4.0 h | 14.2 h | — | — | 4.5 s | 30 s |

Running the views is most of it up to `u250`: at `u100` it is 92 s of QLever's 125 and 246 s of Jena's 390,
at `u250` 226 s of QLever's 378. At `u500` QLever's index build catches up, 716 s of its 1,489: it grew 4.7×
from `u250` for twice the data, the views 3.4×.
Comunica's grows far faster than the data, 22× from `u10` to `u50` and another 3.5× to `u100`, so
`timeMaterialization.ts` no longer runs it at those two scales unless asked to (`--include-slow`).

The materialised views on disk, against 3.1 GB of N-Triples at LUBM `u100`, measured as the disk
actually allocated to each engine's store of them (TDB2 preallocates sparse files several times larger):

| Store | LUBM `u1` | `u10` | `u50` | `u100` | `u250` | `u500` | OAEI `eswc` | `d100` |
|---|---|---|---|---|---|---|---|---|
| N-Triples | 23 MB | 294 MB | 1.5 GB | 3.1 GB | 7.8 GB | 15.6 GB | 4.3 MB | 58 MB |
| Jena (TDB2) | 20 MB | 251 MB | 1.3 GB | 2.7 GB | — | — | 5.2 MB | 60 MB |
| Oxigraph | 12 MB | 136 MB | 708 MB | 1.4 GB | — | — | 3.7 MB | 41 MB |
| QLever | 2.1 MB | 23 MB | 122 MB | 244 MB | 610 MB | 1.2 GB | 0.8 MB | 7.3 MB |
| HDT + index (Comunica) | 1.2 MB | 16 MB | 91 MB | 189 MB | — | — | 0.3 MB | 3.8 MB |

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

#### Where the optimisations do not help, and why

- **Joins on `BIND`-computed variables across `UNION` groups.** After every pass, each query pattern
  is still a `UNION` with one branch per view, and each branch binds the shared variable through a
  `BIND` (`?v_7 cmt:writePaper ?v_8 . BIND(?v_7 AS ?v_6)`). Joining such groups gives an engine no
  index to look the other side up in, and none of the four engines distributes the join over the
  branches. Examples:
  - **LUBM Q09** (student, advisor, course: three typed variables joined in a triangle) fails from
    `u10` on with every pipeline on every engine (timeouts, and QLever's memory limit), while the
    materialised query takes 0.16 s (QLever) to 47 s (Comunica) at `u10`.
  - **Jena answers none of LUBM Q02, Q07 and Q09** with any pipeline at any scale.
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
