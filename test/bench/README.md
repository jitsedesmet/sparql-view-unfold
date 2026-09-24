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
# Jena: see "Adding Jena / Fuseki" on which build to use
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
# 1. Get a Fuseki build (6.x needs Java 21+; 4.10.x works with Java 11/17).
#    Use a build carrying ARQ's triple-term fix (Jena main `e9f7445a`, 2026-08-29):
#    on 6.2.0 and earlier, a sub-SELECT projecting a triple term loses that binding
#    when it is joined against a sibling pattern, which silently empties the plain
#    `rewriting` pipeline's answers. No release carries the fix yet, so until one
#    does, take the nightly:
SNAP=https://repository.apache.org/content/repositories/snapshots/org/apache/jena/jena-fuseki-server/6.3.0-SNAPSHOT
mkdir -p apache-jena-fuseki-6.3.0-SNAPSHOT
curl -sL "$SNAP/jena-fuseki-server-6.3.0-20260922.051646-31.jar" \
  -o apache-jena-fuseki-6.3.0-SNAPSHOT/fuseki-server.jar   # check the dir for a newer one

# 2. Point JenaEngine at the jar (the only env var actually required)
export JENA_FUSEKI_JAR="$PWD/apache-jena-fuseki-6.3.0-SNAPSHOT/fuseki-server.jar"
```

`/$/server` on a running Fuseki reports the build's version, which is worth checking
before trusting a Jena row.

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
5 approaches, 1 rep, 300 s budget, all measured in one run on 2026-09-23/24 against
**Jena `6.3.0-SNAPSHOT`** (the first build with ARQ's triple-term fix), **Oxigraph 0.5.9** and
**Comunica 5.4.0**. `results.json` holds them; `plot.mjs` regenerates the figures.
478 `ok`, 224 censored at the budget, 18 `error` — all Jena `F-Q3`, whose answer is 8,490,234
rows and overruns the harness's 268MB response cap. The censoring is not spread evenly: 149 of
the timeouts are Oxigraph's and 75 Comunica's, and Jena times out on nothing.

Because so much is censored, **comparisons below are paired**: two approaches are compared
only on the (engine, scheme, scale, query) cells where both produced a real measurement,
and a "rescue" counts a cell where one finished and the other did not. A censored row is a
lower bound, so averaging one in would flatter whichever approach fails more often.

### The pipelines rank in order, and every comparison is now unanimous

| Comparison | cells | faster | median ratio | rescues | reverse rescues |
|---|---|---|---|---|---|
| `pullUpExtends` vs `pushDownAssertions` | 105 | 98 | 0.70 | 6 | 0 |
| `pullUpExtends` vs `rewriting` | 61 | **61** | 0.15 | 50 | 0 |
| `pushDownAssertions` vs `rewriting` | 61 | **61** | 0.24 | 44 | 0 |
| `removeProjections` vs `rewriting` | 61 | 49 | 0.92 | 2 | 0 |

Not one cell in the table goes the other way: no pipeline is ever rescued by the one below
it. The pushdown is worth roughly a 4× speed-up over the plain rewriting and the pull-up
another 1.4× on top, and between them they turn 50 queries that never finish into queries
that do.

`removeProjections` on its own is close to neutral — 0.92, helping in 49 of 61 cells. It is
worth keeping as a rung because it is what the pushdown needs (a `FILTER` cannot be driven
into a pattern hidden behind a sub-`SELECT`), not for what it does alone.

### What the rewriting can answer at all

Queries answered within the budget, of 48 per cell (12 queries × 2 schemes × 2 scales):

| Engine | baseline | `rewriting` | `+removeProjections` | `+pushDownAssertions` | `+pullUpExtends` |
|---|---|---|---|---|---|
| Jena | 46 | 44 | 44 | 44 | 44 |
| Oxigraph | 46 | **0** | **0** | 20 | 25 |
| Comunica | 46 | 17 | 19 | 41 | 42 |

On Oxigraph the optimisation passes are not a speed-up, they are the difference between a
usable approach and an unusable one: without them it answers **nothing at all** inside 300 s.
Comunica goes from 17 to 42. Jena answers everything either way — its four `error` rows per
pipeline are `F-Q3` overrunning the response cap, not the engine failing.

### The honest cost: ~20× the hand-written query, and it is a floor rather than a multiple

On the cells where the pull-up rewrite finished *and* returned the baseline's answer:

| Scheme | cells | median cost |
|---|---|---|
| reification | 48 | **20.3×** |
| singleton | 17 | 121.1× |

Per engine on reification: Jena **5.8×** (20 cells), Comunica 39.4× (20), Oxigraph 619.9× (8).
The singleton figure is inflated by baselines that answer a different, mostly empty question
fast — see the correctness section.

The more useful observation is that the multiple is not stable, because the *rewrite* is what
is stable. Across the graded-correct cells:

| Engine | baseline times | pull-up times | rank correlation |
|---|---|---|---|
| Jena | 0.01 – 287.4 s (×35,922) | 0.09 – 3.5 s (×40) | ρ = 0.32 |
| Comunica | 0.03 – 8.3 s (×259) | 1.3 – 126.3 s (×98) | ρ = 0.41 |
| Oxigraph | 0.02 – 0.5 s (×24) | 16.3 – 276.0 s (×17) | ρ = 0.37 |

The hand-written queries span four orders of magnitude; the rewrites of those same queries
span one or two, and barely track them. A rewritten query costs what its own shape costs,
close to independently of how hard the question was. So the approach is ruinous on a cheap
query — Jena answers `reification/B-Q1` at `s` in 12 ms, where the pull-up rewrite of the
same question takes 1.1 s (94×) and the plain rewriting 6.6 s (546×) — and competitive or
better on an expensive one.

It does win outright, on 6 cells, all Jena/reification, and not marginally:

| | baseline | `+pullUpExtends` | rows |
|---|---|---|---|
| `F-Q4` xs | 287.4 s | 2.8 s (**104×**) | 20,004 |
| `F-Q4` s | 243.7 s | 3.5 s (70×) | 20,004 |
| `F-Q5` xs | 76.8 s | 1.4 s (55×) | 3,386 |
| `F-Q5` s | 76.1 s | 2.4 s (32×) | 3,386 |
| `A-Q4` xs | 0.3 s | 0.1 s (4×) | 1 |
| `A-Q3` xs | 0.2 s | 0.1 s (2×) | 0 |

`F-Q4` and `F-Q5` are won by the *plain* rewriting too (26× and 12× at `xs`), so this is not
the optimiser rescuing a bad rewrite — those two hand-written baselines are simply worse
queries than what the unfolding produces.

### Scaling

Median time multiplier from `xs` to `s`, which is ×2.6 the quads, on cells where both finished:

| Approach | cells | × time |
|---|---|---|
| baseline | 69 | 1.11 |
| `rewriting` | 25 | 2.13 |
| `+removeProjections` | 26 | 2.26 |
| `+pushDownAssertions` | 48 | 1.52 |
| `+pullUpExtends` | 52 | 1.53 |

The hand-written queries are nearly flat over this range, being index lookups against a
constant. The plain rewriting grows faster than the data; the pushdown-based pipelines grow
at about half that rate, so those passes improve the growth rate and not just the constant.

### Correctness: 134 mismatches, none of them the rewriter, and only two causes

340 of the 720 rows carry a verdict (a row is ungraded when nothing finished to compare
against, or when it *is* the reference). 134 disagree with the baseline, and they now reduce
to two causes — the engine-defect category is gone, Jena's ARQ bug having been fixed:

| Cause | rows |
|---|---|
| Eight `singleton` baselines asking a different question | 116 |
| `reification/F-Q1`: `SELECT *` over different variable sets | 18 |

`F-Q1` is not a wrong answer at all. Both sides return the same 2 rows, but the baseline is a
`SELECT *` over the RDF 1.1 shape, so its `*` includes the reification node `?st` — a variable
the RDF 1.2 query has no equivalent for, since the whole point of the view is that the
statement node is not part of it. The solutions differ as *bindings* while agreeing as
answers.

The singleton cases are documented under "Known issues": corrected by hand, all 16 of them
match the rewriting exactly.

The strongest evidence that nothing here is the rewriter's: on Jena, all four pipelines now
produce the **identical** set of 17 mismatching cells. A rewriting bug would show up in the
pipelines that transform more, and it does not.

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
