# Cross-engine SPARQL 1.2 benchmark

This directory benchmarks the query-rewriting approach of this library against the two
alternatives a user actually has, across three SPARQL engines.

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
| `rewriting` | `operationTransform` → `transformFilterFalse` → `nullifyJoinOverIncompatibleBounds` → `transformFilterFalse` |
| `rewriting+removeProjections` | the above, then `removeProjections` (flattens the nested sub-`SELECT`s each mapper branch is wrapped in) |
| `rewriting+pushDownAssertions` | the above, then `pushDownAssertions` (pushes `FILTER(sameTerm(?x, c))` into the triple patterns that use `?x`, turning a free position into an indexed lookup) |
| `rewriting+pullUpExtends` | the above, then `pullUpExtends` twice (floats the `BIND`s the pushdown leaves at every leaf back up, or drops them) |

See `runner.ts` for the exact composition and why `removeProjections` is a *required*
step of the pushdown pipeline rather than an optional extra.

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
  row *is* the reference.
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
| **Comunica** | ✅ full | ✅ | 5.0.0 (Jan 2026) | npm library (`@comunica/query-sparql*`) — used in-process here |
| **Apache Jena / Fuseki** | ✅ full (default) | ✅ | 4.10+ (rec. 5.x/6.x) | Java, Fuseki HTTP SPARQL endpoint |
| **Oxigraph** | ✅ full | ✅ | 0.5.0 (2025) | Rust binary / WASM, one-shot child process here |
| Eclipse RDF4J | ⚠️ old `<< >>` only | ❌ | — | (cannot run the new syntax) |
| Ontotext GraphDB | ⚠️ old `<< >>` only | ❌ | — | inherits RDF4J limitation |
| QLever, Blazegraph, Stardog, Virtuoso, MillenniumDB | ❌ SPARQL 1.1 only | ❌ | — | not usable for native SPARQL 1.2 |

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
| `runner.ts` | `rewriteToSparql11(mappers, query, variant)` — the core rewrite call, where `variant` selects one of the four pipelines — plus `sameSolutions()` and a simpler single-engine `runBenchmark()`/`formatRecords()` used by `cli.ts`. |
| `config.ts` | Maps each reification pattern (`reification` → `BKR-Reification.ttl`/`BKR-R_*.rq`, `singleton` → `BKR-Singleton.ttl`/`BKR-S_*.rq`) to its CONSTRUCT mappers, materialized dataset and hand-written baseline query, and builds cases from `queries/BKR-star_*.rq`. |
| `engines.ts` | `BenchEngine` interface + `ComunicaEngine` (in-process, cancellable), `OxigraphEngine` (one-shot child process, killed on timeout — Oxigraph's `Store.query` is synchronous), `JenaEngine` (manages its own long-lived `fuseki-server.jar` child process, restarted only when the dataset file changes) and `SparqlHttpEngine` (any *externally managed* SPARQL HTTP endpoint, used by `cli.ts`). |
| `oxiOneShot.mjs` | Loads one Turtle file, runs one query with Oxigraph, prints canonicalized JSON. Run as a child process by `OxigraphEngine` so a hard wall-clock timeout can be enforced by killing it. |
| `makeSubset.mjs` | Streams a full multi-GB dataset once and writes four self-contained subsets (`xs`/`s`/`m`/`l`), each containing the full closure of every benchmark query's target entities plus a uniform random noise sample, so results are comparable across scales. The full datasets (13–17GB) cannot be loaded into an in-memory store, so this is what the real run uses. |
| `plot.mjs` | Turns a results JSON into hand-rolled SVG figures (time-by-query, scaling, overhead, correctness) per scheme × engine. No dependencies. |
| `cli.ts` | Ad-hoc single-pipeline runs against the **full** datasets or SPARQL endpoints you started yourself. No scale subsetting. |
| `jena-bug.md` | Write-up of the ARQ triple-term bug found through this benchmark (fixed upstream). |

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
export JENA_FUSEKI_JAR=/path/to/apache-jena-fuseki-6.2.0/fuseki-server.jar
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

`--engines` accepts `comunica`, `oxigraph` and/or `jena`.

## Adding Jena / Fuseki

Unlike `SparqlHttpEngine` (used by `cli.ts`, which talks to a server *you* started and
loaded), `JenaEngine` manages its own `fuseki-server.jar` child process: it starts one
lazily on the first query against a given dataset file (`--file=<path> --port=<port> /ds`,
an in-memory dataset loaded at startup), keeps it running across every query against that
file, and restarts it only when `run.ts` moves on to a different scale/scheme. `run.ts`
calls `dispose()` once an engine's run is done.

```bash
# 1. Download a Fuseki distribution (6.x needs Java 21+; 4.10.x works with Java 11/17)
curl -LO https://dlcdn.apache.org/jena/binaries/apache-jena-fuseki-6.2.0.tar.gz
tar xzf apache-jena-fuseki-6.2.0.tar.gz

# 2. Point JenaEngine at the jar (the only env var actually required)
export JENA_FUSEKI_JAR="$PWD/apache-jena-fuseki-6.2.0/fuseki-server.jar"
```

| Env var | Meaning | Default |
|---|---|---|
| `JENA_FUSEKI_JAR` | Path to `fuseki-server.jar`. **Required** — `JenaEngine` throws a clear error if unset when it first needs a server. | — |
| `JENA_JAVA` | Java binary to invoke. | `java` |
| `JENA_FUSEKI_PORT` | Port the child Fuseki server listens on. | `3131` |
| `JENA_JVM_OPTS` | Extra space-separated JVM args, e.g. `-Xmx8g` for the larger subsets (the default heap cannot load an 800MB Turtle file in-memory). | (none) |

`JenaEngine` refuses to query a port that already answers `/$/ping` before it has started
its own child: it cannot tell whether a leftover process on that port holds the dataset it
is about to ask for, so it errors rather than silently querying the wrong data.

## Known issues in the corpus and the engines

Each of these was found through this benchmark and is *not* a rewriter bug. They are
listed here because every one of them can be misread as one.

- **Fuseki 6.2.0 drops triple-term bindings across a sub-`SELECT` join** — the plain
  `rewriting` pipeline returns 0 rows on Jena with an `ok` status for most of these
  queries, fast, and wrong. Root cause and repro in [`jena-bug.md`](jena-bug.md);
  **fixed upstream** on Jena's `main` (commit `e9f7445a`, 2026-08-29), not yet in a
  release. This is why the correctness reference is the hand-written baseline and not
  `rewriting`: against the baseline the bug shows up as `rewriting` being marked
  incorrect, which is the truth. Anyone running against a build newer than 6.2.0 should
  re-verify rather than assume the caveat still applies.
- **The `BKR-S_*.rq` (singleton) baseline files test different sample facts than the
  `BKR-star_*.rq` queries they are nominally the baseline for**, for at least
  `A-Q2`/`A-Q3`/`A-Q4`/`F-Q1`/`F-Q4`/`F-Q5` — e.g. `F-Q4`'s star constant
  `bkr:META_C0040300-INST` occurs 16,700 times as a subject in `singleton-xs.ttl`, while
  `BKR-S_F-Q4.rq`'s `umls:META_C0040300` occurs once. Pre-existing in the shipped corpus.
  Since the baseline is now the correctness reference, a singleton `correct: false` on one
  of those cases is this discrepancy, not a rewriting error; the reification baselines
  (`BKR-R_*.rq`) use the same constants as the star queries and are unaffected.
- **Two baseline files were missing a `PREFIX rdf:` declaration** (`BKR-R_B-Q3.rq`,
  `BKR-S_A-Q4.rq`). Comunica's parser tolerated it; Oxigraph's correctly rejected it.
  **Fixed** in both files.
- **The source BKR Turtle dumps contained malformed percent-encoded IRIs** (literal
  `%%-`), which Oxigraph's parser rejects — a whole-file load failure — while N3 accepts
  them silently. **Fixed** in `skolemize.ts`, which now drops quads carrying a
  syntactically invalid IRI (checked recursively into triple-term components and literal
  datatypes) and logs them to `<output>.dropped.ttl`. 120 quads out of 82,432,741 were
  dropped, all the same defect; Oxigraph's `error` rows went from 96/192 to 0/192.
- **Oxigraph 0.5.9 rejects the spec-compliant uppercase `FILTER(FALSE)`** our generator
  emits, accepting only lowercase `false`. Worked around by lowercasing that exact shape in
  the query text sent to engines (`runner.ts`'s `lowercaseBooleanLiterals`); the generator
  is left alone, since its output is correct. Only started mattering once
  `pushDownAssertions` gained triple-term support and began proving `UNION` branches
  statically empty.

## Results

<!-- RESULTS -->

## History

Earlier runs and their write-ups live in git history rather than in this file; the
results JSON and figures of superseded runs are not kept, since `plot.mjs` regenerates
figures from any results JSON. In summary:

| Date | What changed |
|---|---|
| 2026-07-28 | First run: Comunica + Oxigraph, three approaches, 30 s budget. |
| 2026-08-20 → 08-26 | `pushDownAssertions` added and extended (triple-term support, phase-5 operation rules). |
| 2026-08-27 | Jena added as a third engine; the ARQ triple-term bug found (`jena-bug.md`). |
| 2026-09-02 | Invalid-IRI data cleanup; full pipeline regenerated from the cleaned dumps. |
| 2026-09-03 | `pullUpExtends` added as a fourth pipeline; budget raised to 60 s. |
| 2026-09-07 | Reference switched from `rewriting` to the hand-written baseline, timeouts rendered as censored, dataset size recorded for every engine, budget raised to 300 s. |

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
