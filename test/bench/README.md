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
| **Comunica** | ✅ full | ✅ | 5.0.0 (Jan 2026) | npm library (`@comunica/query-sparql*`) — long-lived worker process here |
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
| `runner.ts` | `rewriteToSparql11(mappers, query, variant)` — the core rewrite call, async as `QueryRewriter.rewriteQuery` is, where `variant` selects one of the four pipelines — plus `sameSolutions()` and a simpler single-engine `runBenchmark()`/`formatRecords()` used by `cli.ts`. |
| `config.ts` | Maps each reification pattern (`reification` → `BKR-Reification.ttl`/`BKR-R_*.rq`, `singleton` → `BKR-Singleton.ttl`/`BKR-S_*.rq`) to its CONSTRUCT mappers, materialized dataset and hand-written baseline query, and builds cases from `queries/BKR-star_*.rq`. |
| `engines.ts` | `BenchEngine` interface + `ComunicaEngine` (a long-lived worker process per dataset, so the store is loaded and indexed once and the engine stays warm, while a query whose join state outgrows the heap costs one `error` row instead of the whole sweep; in-process for the in-memory stores the unit tests use), `OxigraphEngine` (one-shot child process, killed on timeout — Oxigraph's `Store.query` is synchronous), `JenaEngine` (manages its own long-lived `fuseki-server.jar` child process, restarted only when the dataset file changes) and `SparqlHttpEngine` (any *externally managed* SPARQL HTTP endpoint, used by `cli.ts`). |
| `oxiOneShot.mjs` | Loads one Turtle file, runs one query with Oxigraph, prints canonicalized JSON. Run as a child process by `OxigraphEngine` so a hard wall-clock timeout can be enforced by killing it. |
| `comunicaWorker.mjs` | A long-lived Comunica worker driven by `ComunicaEngine` over newline-delimited JSON: it loads and indexes the dataset once, then answers every query against it. The separate process is about memory, not cancellation — Comunica buffers join state that no cap on the output stream can bound, and a `FATAL ERROR: Reached heap limit` is not catchable, so an unbounded query has to be able to die without taking the run with it. Timeouts are handled inside the worker, so they cost the budget but not the loaded store. |
| `makeSubset.mjs` | Streams a full multi-GB dataset once and writes four self-contained subsets (`xs`/`s`/`m`/`l`), each containing the full closure of every benchmark query's target entities plus a uniform random noise sample, so results are comparable across scales. The full datasets (13–17GB) cannot be loaded into an in-memory store, so this is what the real run uses. |
| `plot.mjs` | Turns a results JSON into hand-rolled SVG figures (time-by-query, scaling, overhead, correctness) per scheme × engine. No dependencies. |
| `cli.ts` | Ad-hoc single-pipeline runs against the **full** datasets or SPARQL endpoints you started yourself. No scale subsetting. |
| `jena-bug.md` | Write-up of the ARQ triple-term bug found through this benchmark: repro, root cause, which build fixes it and how that was verified. |

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
# Jena: use a build with the triple-term fix (see "Known issues"); 6.2.0 answers the
# plain `rewriting` pipeline wrongly and no release carries the fix yet.
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
  queries, fast, and wrong. Root cause and repro in [`jena-bug.md`](jena-bug.md).
  This is why the correctness reference is the hand-written baseline and not
  `rewriting`: against the baseline the bug shows up as `rewriting` being marked
  incorrect, which is the truth.

  It also makes Jena's `rewriting` column unusable as a *cost* measurement, since a
  wrong empty answer is cheap: 44 of its 48 `ok` rows return zero rows and 21 are
  graded incorrect, all 15 of the reification ones. Read Jena's cost off the pipelines
  that flatten the sub-`SELECT`s away, whose 18 remaining mismatches are 15 singleton
  baselines and 3 reification attributions rather than this bug.

  **Fixed upstream** on Jena's `main` (commit `e9f7445a`, 2026-08-29) and verified in
  the `6.3.0-SNAPSHOT` nightly of 2026-09-22, which answers all 10 affected `xs` cells
  exactly as the baseline does. Still in no release — 6.2.0 is the latest — so the
  benchmark drives that nightly, and `jena-bug.md` records which build and what was
  checked. Anyone running against a different build should re-verify rather than assume
  either state.
- **Eight of the twelve `BKR-S_*.rq` (singleton) baseline files ask a different question than
  the `BKR-star_*.rq` query they are nominally the baseline for.** `B-Q2`, `F-Q1`, `F-Q4` and
  `F-Q5` use `umls:` IRIs — e.g. `F-Q4`'s star constant `bkr:META_C0040300-INST` occurs 16,700
  times as a subject in `singleton-xs.ttl`, while `BKR-S_F-Q4.rq`'s `umls:META_C0040300` occurs
  once — so they match nothing; `A-Q2` and `A-Q3` ask about different concepts altogether;
  `A-Q4` omits the `?source_inst rdf:type ?source_cl` pattern; and `A-Q1` projects
  `?st_s_inst ?st_p_inst ?st_o_inst`, binding the singleton property node where the star query
  binds the base predicate. Pre-existing in the shipped corpus. Rewriting each of the eight to
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
  matching statements, one with 1,767 sources, paired with themselves) — so no engine here
  finishes it within the budget: Oxigraph times out on all five approaches, Jena's answer is
  over the 268MB response cap, and Comunica's own hand-written baseline times out. But the
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
5 approaches, 1 rep, 300 s budget. The Jena and Oxigraph rows were run on 2026-09-11/12, after
`filterFalse` learned to collapse statically empty branches through sub-`SELECT`s; the
Comunica rows were re-run on 2026-09-14 on Comunica 5.4.0 (see the History table). The 96
rewritten queries are byte-for-byte identical between the two runs, and correctness is graded per
engine, so the two sets of rows sit together safely. `results.json` holds them; `plot.mjs`
regenerates the figures. 470 `ok`, 236 censored at the budget, 14 `error` — all Jena `F-Q3`
responses over the 268MB cap. Comunica's four worker aborts on `reification/F-Q3` are gone.

Because so much is censored, **comparisons below are paired**: two approaches are compared
only on the (engine, scheme, scale, query) cells where both produced a real measurement,
and "rescued" counts the cells one finished and the other did not. Comparing raw medians
across approaches would reward failure, since the slowest queries are the ones that drop out.

### The pipelines rank in order, and `pullUpExtends` strictly dominates

| Comparison | paired cells | A faster | median A/B | A rescues | B rescues |
|---|---|---|---|---|---|
| `pullUpExtends` vs `pushDownAssertions` | 102 | **100** | **0.72** | **2** | 1 |
| `pullUpExtends` vs `rewriting` | 60 | 51 | **0.29** | 44 | 4 |
| `pushDownAssertions` vs `rewriting` | 60 | 46 | 0.42 | 43 | 4 |
| `removeProjections` vs `rewriting` | 60 | 22 | **1.78** | 2 | 4 |

`pullUpExtends` wins 100 of 102 head-to-head cells against `pushDownAssertions`, is ~28%
faster at the median, and finishes 2 queries the pushdown pipeline cannot (`reification/A-Q2`
and `A-Q4` at `s` on Oxigraph). The one query only the pushdown pipeline finishes is
`singleton/F-Q2` at `xs` on Oxigraph, in 277 s — noise at the edge of the budget, since an
earlier run had it the other way round. It is the pipeline to use.

**`removeProjections` on its own is a net regression** — about 1.8× *slower* than plain
`rewriting` at the median, and faster on only 22 of 60 cells. It does finish 2 queries plain
`rewriting` cannot (`reification/B-Q3` and `F-Q5` at `xs` on Comunica, both above 250 s); the 4
queries plain `rewriting` finishes and it does not are Jena's `F-Q3` cells, where `rewriting`
returns an empty and wrong answer quickly because of the ARQ bug. It earns its place only as the enabler that lets
`pushDownAssertions` see through the nested sub-`SELECT`s; judged as a standalone
optimization it is a pessimization. (Until Traqula 1.3.1 it was also the workaround that kept
the pushdown's output parseable; see `runner.ts`.)

### What the rewriting can answer at all

Queries answered within the budget, out of 48 per engine:

| Engine | `materialized` | `rewriting` | `+removeProjections` | `+pushDownAssertions` | `+pullUpExtends` |
|---|---|---|---|---|---|
| Jena | 45 | 48* | 44 | 44 | 44 |
| Oxigraph | 46 | **0** | **0** | 19 | **20** |
| Comunica | 46 | 16 | 18 | 40 | **40** |

On Oxigraph the unoptimized rewriting answers *nothing* in 300 s; the pushdown pipelines
take it to 20/48. On Comunica it goes 16 → 40. This is the practical case for the
optimizations: without them the rewriting approach is not merely slow on two of the three
engines, it is unusable. (*Jena's 48 is not a success — see the correctness section.)

### The honest cost: ~13× the hand-written query

Against the `materialized` baseline, `pullUpExtends` is **61× slower at the median** over the
103 cells where both finish, and the baseline additionally answers 34 queries the rewriting
cannot. That headline mixes two very different schemes, though:

| Scheme | paired cells | median `pullUpExtends` / `materialized` | baseline-only |
|---|---|---|---|
| `reification` | 49 | **12.89×** | 16 |
| `singleton` | 54 | 128.69× | 18 |

Most `singleton` baselines ask a different question than their star query — often one with no
answer at all, which is cheap to establish (see the correctness section) — so the singleton
ratio measures that, not the rewriting. `reification`, whose baselines are faithful, is the
honest figure: about **13×** across the three engines (14× in the previous run). It varies a lot
per engine: on Comunica 5.4.0 alone it is 33.5×, down from 37.8× on 5.3.0, because the upgrade
sped up the rewritten queries as well as the hand-written ones. Rewriting buys you a SPARQL 1.2
interface over RDF 1.1 data without touching the data; it does not buy you the performance of
a query written against the storage layout. An order of magnitude is the price at these scales.

### What the `filterFalse` change did

`pushDownAssertions` proves some `UNION` branches statically empty — in 20 of the 24 cases the
"already a native triple term" branch. Until `filterFalse` could see past a
sub-`SELECT`, such a branch survived into the query text as a `FILTER(FALSE)` over a full
`?s ?p ?o` pattern. None does now, and the change reaches further than those 20 cases: all 48
pushdown and pull-up rewrites got shorter (`singleton/B-Q2` under `pullUpExtends` went from 82
lines to 43), while `rewriting` and `+removeProjections` are byte-for-byte unchanged. No answer
changed on any cell that finished in both runs.

- **Jena and Oxigraph:** no measurable effect. Statuses and answers are identical, and the
  median time ratio per pipeline between the two runs is 0.90–1.03. The only status changes
  are two Oxigraph pushdown queries trading places at the 300 s boundary.
- **Comunica** (measured on 5.3.0, before the upgrade described next): that run was ~15% slower
  across the board, hand-written baselines included, so its raw times are not comparable with the
  run before it. Nothing in the harness changed,
  and the only dependency change, traqula 1.2 → 1.3, was ruled out by an interleaved A/B on the
  same queries. Normalized by each case's own baseline instead, `pushDownAssertions` and
  `pullUpExtends` improved on `reification` (0.85 and 0.82 at `xs`, 0.97 and 0.87 at `s`),
  against 1.05 and 1.10 for `rewriting` and `+removeProjections`, whose query text did not
  change — which also bounds the noise of this measure. On `singleton` the same measure reads
  1.14/0.94 at `xs` and 1.12/1.28 at `s`, but it divides by baselines that mostly answer a
  different question, so it carries little weight. Coverage fell by two or three queries per
  pipeline: seven of the nine queries that dropped out had finished within 35 s of the budget
  before, and the other two run *faster* with the new rewrite when timed in isolation
  (`reification/B-Q1` pushdown at `s`: 125 s → 120 s; `singleton/B-Q2` pull-up at `s`:
  142 s → 121 s), so they are the slower run, not the rewrite.

### Comunica 5.4.0

Comunica 5.4.0 caps a join's cardinality estimate by the variables its inputs share, where 5.3.0
multiplied the inputs' cardinalities (scaled only by a structural selectivity heuristic). The
Comunica rows were re-run on it with nothing else changed, and no answer changed on any cell that
finished on both versions.

| Comunica, out of 240 cells | `ok` | censored | `error` |
|---|---|---|---|
| 5.3.0 | 138 | 98 | 4 |
| 5.4.0 | **160** | 80 | **0** |

22 queries now finish within the budget and none stopped finishing; the four `error`s were the
`reification/F-Q3` worker aborts, which are now ordinary timeouts. Queries answered out of 48 per
approach: `materialized` 44 → 46, `rewriting` 11 → 16, `+removeProjections` 11 → 18,
`+pushDownAssertions` 35 → 40, `+pullUpExtends` 37 → 40.

The hand-written baselines gained the most, because several of them had hit exactly the bad join
order: `reification/F-Q2` at `s` went from 262 s to 8.1 s, and `A-Q4` and `A-Q3` at `xs` from 109 s
and 81 s to 4.5 s and 3.8 s. The rewritten queries sped up too. On `reification` the median ratio
(5.4.0 / 5.3.0, over cells finished on both) is 0.58 for `rewriting`, 0.52 for
`+removeProjections`, 0.70 for `+pushDownAssertions` and 0.68 for `+pullUpExtends`, against 0.84
for the baselines; on `singleton` all five sit at 0.83–0.96, largely within this host's ~15%
run-to-run variation. The largest single gains are `singleton/B-Q3` at `xs` under `pullUpExtends`
(149 s → 1.5 s) and `reification/B-Q1` at `s` under `pullUpExtends` (253 s → 13 s); the worst
slowdown is 1.28× (`reification/F-Q4` at `xs` under `pushDownAssertions`, 110 s → 141 s).

Because the baselines themselves changed this much, the baseline-normalized comparison used for
the `filterFalse` change above does not carry across versions; the ratios here compare raw
times per cell.

### Correctness: 138 mismatches, none of them the rewriter

Every `correct: false` row traces to a known defect in the corpus or an engine, with nothing
left over. Some rows have two causes — a Jena ARQ row on a defective singleton baseline, say —
and each is counted once, under the first cause in this order:

| Cause | Rows |
|---|---|
| Graded against the fallback reference on Jena, where `rewriting` is the buggy one | 3 |
| `F-Q1`/`F-Q2` baselines use `SELECT *`, so they also bind the structural node | 34 |
| Jena's ARQ triple-term bug (affects `rewriting` and `+removeProjections`) | 33 |
| Singleton baselines ask a different question than their star query | 68 |

The last row was previously described as the singleton baselines using different sample
constants. Checking every case by content shows that is only part of it: `B-Q2`, `F-Q1`,
`F-Q4` and `F-Q5` use `umls:` IRIs (`meta:C0040300`, `sn:PART_OF`) that the data does not
contain, so they match nothing; `A-Q2` and `A-Q3` ask about different concepts altogether;
`A-Q4` omits the star query's `?source_inst rdf:type ?source_cl` pattern, counting 51,661
where the answer is 0 at `xs` and 169 at `s`; and `A-Q1` projects
`?st_s_inst ?st_p_inst ?st_o_inst`, binding the singleton property node where the star query
binds the base predicate. Rewriting each of those eight baselines to ask what its star query
asks, over the IRIs the data uses, makes it return exactly the `pullUpExtends` answer at both
scales — 16 of 16, including `A-Q3`'s single row at `s`.

The `SELECT *` row: `F-Q1`'s star query and its baseline both use `SELECT *`, but the
reification baseline must name the statement node (`?st`) to walk the encoding, so it projects
a variable the RDF 1.2 query has no counterpart for. Both return the same 2 solutions with
identical `?o1`/`?source` bindings; the baseline rows just carry an extra `st=...`, and the
multiset comparison — correctly — calls that a difference. Verified by diffing the actual
rows. (Singleton `F-Q1` rows land here too by the counting order, though their baseline fails
for the namespace reason above first.)

The fallback row is the reference biting on Jena: when the baseline itself fails (`F-Q4` at
`s` times out), the reference falls back to `rewriting`, which on Jena returns 0 rows because
of the ARQ bug, so the three pipelines that return the right 20,004 rows are marked wrong.
Rare, but it is the one case where `correct` inverts, and it is why `referenceApproach` is
recorded on every row.

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
| 2026-09-09 | Comunica moved into a worker process after `reification/F-Q3` OOM-killed two sweeps; the first complete 300 s run. |
| 2026-09-11 | `filterFalse` collapses statically empty branches through sub-`SELECT`s, so no rewrite carries a dead `FILTER(FALSE)` branch any more; the 300 s run above re-run on top of it. |
| 2026-09-14 | Traqula 1.3.1 fixes the generator's sub-`SELECT`-followed-by-`BIND` output (no benchmark query text changed). Comunica upgraded to 5.4.0 and its rows re-run: 22 more queries finish, and the `F-Q3` worker aborts became timeouts. |
| 2026-09-23 | The library's pipeline API replaced by factories and an async `QueryRewriter`, and the harness ported onto it. With `generalizedRdfView: true` the rewrites are the measured ones: 72 of 96 byte-identical, the other 24 (`standard`) identical but for internal variable names. Re-run on that basis. |
| 2026-09-23 | Jena moved from 6.2.0 to the `6.3.0-SNAPSHOT` nightly, the first build carrying the ARQ triple-term fix, verified on all 10 affected cells. Its rows are being re-measured on it, so that the plain `rewriting` column measures the rewriting rather than the bug; the Results above still hold the 6.2.0 rows. |

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
