# Cross-engine SPARQL 1.2 benchmark

This directory contains a small system to benchmark the query-rewriting approach of
this library against **native SPARQL 1.2 evaluation**, across multiple SPARQL engines.

## What it measures

For a SPARQL 1.2 user query (using RDF 1.2 triple terms / `rdf:reifies`) there are two
ways to get an answer:

1. **rewriting** — rewrite the query into an equivalent **SPARQL 1.1** query with this
   library and run it over the *materialized RDF 1.1* representation
   (`data/BKR-Reification.ttl`, `data/BKR-Singleton.ttl`, …).
   This works on **any** SPARQL 1.1 engine.
2. **native** — run the SPARQL 1.2 query directly over the *native RDF 1.2* data.
   This only works on engines that support SPARQL 1.2.

The runner records execution time and row counts for every engine/approach, and checks
each result against a reference answer for correctness.

## Which engines support SPARQL 1.2? (survey, July 2026)

SPARQL 1.2 / RDF 1.2 are **W3C Working Drafts** (not yet Recommendations; the
RDF-star WG is chartered until April 2027). Triple terms use the new
`<<( s p o )>>` syntax with `rdf:reifies` (the old RDF-star `<< s p o >>` reifier
syntax is being retired). The engines usable for an automated SPARQL 1.2 benchmark are:

| Engine | SPARQL 1.2 native | New `<<( )>>` syntax | Min version | How to drive it |
|---|---|---|---|---|
| **Comunica** | ✅ full | ✅ | 5.0.0 (Jan 2026) | npm library (`@comunica/query-sparql*`) — used in-process here |
| **Apache Jena / Fuseki** | ✅ full (default) | ✅ | 4.10+ (rec. 5.x/6.x) | Java, Fuseki HTTP SPARQL endpoint |
| **Oxigraph** | ✅ full | ✅ | 0.5.0 (2025) | Rust binary / Docker HTTP SPARQL endpoint |
| Eclipse RDF4J | ⚠️ old `<< >>` only | ❌ | — | (cannot run the new syntax) |
| Ontotext GraphDB | ⚠️ old `<< >>` only | ❌ | — | inherits RDF4J limitation |
| QLever, Blazegraph, Stardog, Virtuoso, MillenniumDB | ❌ SPARQL 1.1 only | ❌ | — | not usable for native SPARQL 1.2 |

So the three engines this benchmark targets are **Comunica**, **Apache Jena/Fuseki**
and **Oxigraph** — all three implement the new triple-term syntax, `{| |}` annotation
shorthand and the `VERSION 1.2` declaration.

Verified directly (2026-08-27): **Fuseki 6.2.0** parses and evaluates the new
`<<( s p o )>>` syntax natively and returns triple terms in SPARQL Results JSON
via the `"type": "triple"` extension — confirmed with a `<<( )>>`-constructing
`SELECT` against a running instance. One correction to the version guidance
above: **Fuseki 6.2.0's class files require a Java 21+ runtime** — it fails to
start under Java 17 (`UnsupportedClassVersionError`, class file version 65 vs.
Java 17's 61). Earlier Fuseki releases (e.g. the 4.10.x line) target older
bytecode and work with Java 11/17; only the newest 6.x line needs Java 21.

- SPARQL 1.2 Query WD: <https://www.w3.org/TR/sparql12-query/>
- SPARQL 1.2 test suite: <https://w3c.github.io/rdf-tests/sparql/sparql12/>
- Comunica 5.0 (SPARQL 1.2): <https://comunica.dev/blog/2026-01-07-release_5_0/>
- Oxigraph 0.5 (RDF 1.2): <https://github.com/oxigraph/oxigraph/blob/main/CHANGELOG.md>
- Jena `syntaxSPARQL_12`: `jena-arq/.../org/apache/jena/query/Syntax.java`

## Files

| File | Purpose |
|---|---|
| `engines.ts` | `BenchEngine` interface + `ComunicaEngine` (in-process, cancellable), `OxigraphEngine` (one-shot child process, killed on timeout — Oxigraph's `Store.query` is synchronous), `JenaEngine` (manages its own long-lived `fuseki-server.jar` child process, restarted only when the requested dataset file changes — see "Adding Jena / Fuseki" below) and `SparqlHttpEngine` (any *externally managed* SPARQL HTTP endpoint: a Fuseki/Oxigraph server you started yourself, used by `cli.ts`'s `--fuseki`/`--oxigraph` flags). |
| `oxiOneShot.mjs` | Loads one Turtle file, runs one query with Oxigraph, prints canonicalized JSON results. Run in a child process by `OxigraphEngine` so a hard wall-clock timeout can be enforced by killing it. |
| `starQuery.ts` | Converts BKR-star `<< s p o >>` queries into RDF 1.2 `rdf:reifies <<( s p o )>>` form. Not needed for the actual pipeline below — the parser auto-desugars `<< >>` — kept for `test/bench.test.ts`. |
| `config.ts` | Maps each reification pattern (`reification` → `BKR-Reification.ttl`/`BKR-R_*.rq`, `singleton` → `BKR-Singleton.ttl`/`BKR-S_*.rq`) to its CONSTRUCT mappers, materialized dataset and hand-written baseline query, and builds benchmark cases from `queries/BKR-star_*.rq`. |
| `runner.ts` | `rewriteToSparql11(mappers, query, withProjectionRemoval?)` (the core rewrite call — the third argument selects the standard pipeline or the standard pipeline plus `removeProjections`) plus a simpler single-engine `runBenchmark()`/`formatRecords()` used by `cli.ts`. |
| `cli.ts` | Simple CLI entry point for ad-hoc runs against the **full** multi-GB datasets or external Fuseki/Oxigraph endpoints (see below). Does not do scale subsetting. |
| `makeSubset.mjs` | Streams a full multi-GB dataset once and writes 4 smaller self-contained subsets (`xs`/`s`/`m`/`l`) that always include the closure of every benchmark query's target entities plus a uniform random noise sample, so results are comparable across scales. **This is what the actual experiment run below uses** — the full datasets (13–17GB) cannot be loaded into an in-memory store. |
| `run.ts` | The real orchestrator: for every engine × scheme × scale it runs both the rewritten query and the hand-written baseline over the *same* subset, records timing/correctness/status, and writes a results JSON for `plot.mjs`. |
| `plot.mjs` | Turns a results JSON into hand-rolled SVG figures (time-by-query, scaling, overhead, correctness) per scheme × engine, saved under `results/figures/`. |

The harness itself is validated by `test/bench.test.ts` on small in-memory datasets
(no multi-GB data needed).

## Running the real experiment (subset-based)

```bash
# 1. Generate subsets once per scheme (streams the full dataset twice; ~10 min each)
node --max-old-space-size=8000 test/bench/makeSubset.mjs \
  test/statics/REF-Benchmark/BKR/data/BKR-Reification.ttl test/bench/subsets reification
node --max-old-space-size=8000 test/bench/makeSubset.mjs \
  test/statics/REF-Benchmark/BKR/data/BKR-Singleton.ttl   test/bench/subsets singleton

# 2. Run the benchmark (give Node extra heap for the `m` scale's in-memory N3 store)
NODE_OPTIONS="--max-old-space-size=16000" npx tsx test/bench/run.ts \
  --engines comunica,oxigraph,jena --schemes reification,singleton --scales xs,s,m \
  --reps 1 --timeout 30000 --out test/bench/results/results.json

# 3. Plot
node test/bench/plot.mjs test/bench/results/results.json test/bench/results/figures
```

`--engines` accepts `comunica`, `oxigraph` and/or `jena` (see "Adding Jena / Fuseki"
below for the one-time setup `jena` needs — it manages its own Fuseki server
process, no external service to stand up by hand).

`test/bench/results/reification.json` / `singleton.json` and the SVGs under
`results/figures/` in this repo are the actual output of the run described below.

## Simple / ad-hoc runs (`cli.ts`, full datasets or external endpoints)

```bash
npx tsx test/bench/cli.ts --pattern reification --limit 5
```

This rewrites the BKR-star queries and runs them with Comunica over the *full*
materialized RDF 1.1 dataset (no subsetting) — only practical for a handful of
cases (`--limit`), since the full datasets are 13–17GB. Stand up Fuseki/Oxigraph
endpoints with the dataset pre-loaded to benchmark those too:

```bash
# Apache Jena Fuseki (Java 21+)
java -jar fuseki-server.jar --file data/BKR-Reification.ttl /bkr

# Oxigraph (Docker)
docker run -p 7878:7878 -v "$PWD/data:/data" docker.io/oxigraph/oxigraph \
  serve --location /data

npx tsx test/bench/cli.ts --pattern reification \
  --fuseki   http://localhost:3030/bkr/sparql \
  --oxigraph http://localhost:7878/query \
  --json results.json
```

| Flag | Meaning |
|---|---|
| `--pattern <name>` | `reification` (default) or `singleton`. |
| `--limit <N>` | Only run the first N query cases. |
| `--fuseki <url>` | Add an Apache Jena/Fuseki SPARQL endpoint. |
| `--oxigraph <url>` | Add an Oxigraph SPARQL endpoint. |
| `--json <path>` | Also write the raw records as JSON. |

## Adding Jena / Fuseki

`jena` is now a first-class engine for `run.ts` (the subset-based orchestrator),
alongside `comunica`/`oxigraph`. Unlike `SparqlHttpEngine` (used by `cli.ts`'s
`--fuseki`/`--oxigraph` flags, which talk to a server *you* already started and
loaded), `JenaEngine` manages its own `fuseki-server.jar` child process: it
starts it lazily on the first query against a given dataset file
(`--file=<path> --port=<port> /ds`, an in-memory dataset loaded at startup —
same idea as `OxigraphEngine`'s per-file loading, but Fuseki is a long-lived
HTTP server, so the process is kept running and reused across every query
against that file, and only restarted when `run.ts` moves on to a different
scale/scheme's dataset file). `dispose()` shuts it down; `run.ts` calls it
automatically once an engine's run is done.

Setup (one-time):

```bash
# 1. Download a Fuseki distribution (needs Java 21+ for the 6.x line — see the
#    engine survey above; 4.10.x works with Java 11/17 if 21 isn't available)
curl -LO https://dlcdn.apache.org/jena/binaries/apache-jena-fuseki-6.2.0.tar.gz
tar xzf apache-jena-fuseki-6.2.0.tar.gz

# 2. Point JenaEngine at the jar (only env var actually required)
export JENA_FUSEKI_JAR="$PWD/apache-jena-fuseki-6.2.0/fuseki-server.jar"

# 3. Run as usual
npx tsx test/bench/run.ts --engines jena --schemes reification,singleton \
  --scales xs,s --reps 1 --timeout 30000 --out test/bench/results/jena-run.json
```

| Env var | Meaning | Default |
|---|---|---|
| `JENA_FUSEKI_JAR` | Path to `fuseki-server.jar`. **Required** — `JenaEngine` throws a clear error if unset when it first needs to start a server. | — |
| `JENA_JAVA` | Java binary to invoke. | `java` |
| `JENA_FUSEKI_PORT` | Port the child Fuseki server listens on. | `3131` |
| `JENA_JVM_OPTS` | Extra space-separated JVM args, e.g. `-Xmx4g` for the larger `m`/`l` scale subsets (the default JVM heap can be too small to load an 800MB Turtle file in-memory). | (none) |

`JenaEngine` refuses to query a port that already answers `/$/ping` before it
has started its own child process — it can't otherwise tell whether a
leftover/foreign process on that port holds the dataset it's about to ask for,
so it errors instead of silently querying the wrong data; free the port (or
pick a different one via `JENA_FUSEKI_PORT`) if you see that error.

**Verified working (2026-08-27, xs subset, reification scheme):** startup, the
"reuse the running server across queries against the same file" path, a
genuine client-side timeout (`AbortSignal`-based, same mechanism as
`SparqlHttpEngine`), restart-on-file-switch (reification → singleton), and
`"type": "triple"` JSON canonicalization for RDF 1.2 triple-term-valued
projections all check out.

**⚠️ Before trusting Jena's results for anything, read "Adding Jena as a third
engine" below in full — Fuseki 6.2.0 has a real correctness bug (a
triple-term-valued variable's binding gets silently dropped across certain
sub-`SELECT` joins) that makes the `rewriting`/`standard` approach's fast,
`ok`-status results wrong on this benchmark's queries more often than not.
`pushDownAssertions` measured clean; `standard` and (rarely) even
`removeProjections` did not.**

## Results (2026-07-28, xs/s/m subsets, 30s timeout, 1 rep)

Ran both reification schemes across Comunica and Oxigraph, 12 BKR-star queries ×
**3 approaches** × 3 scales × 2 engines = 216 rows per scheme. The three approaches:

1. `rewriting` — the standard rewrite pipeline (`operationTransform` +
   `transformFilterFalse` + `nullifyJoinOverIncompatibleBounds` + `transformFilterFalse`).
2. `rewriting+removeProjections` — the same pipeline with
   [`removeProjections`](../../lib/transformations/removeProjections.ts) appended: it
   anonymizes the variables each mapper's nested sub-`SELECT` hides and then drops the
   `PROJECT` node, flattening the deeply-nested sub-`SELECT`-per-mapper-branch structure
   into a single flat tree of `UNION`/`JOIN`/`FILTER`/`BIND` (see the file's doc comment).
   The hypothesis was that this structural simplification might help engines that
   handle nested sub-`SELECT`s poorly plan the query better.
3. `materialized` — the hand-written baseline query on the same subset.

**Headline finding — neither rewriting variant ever completes within the
timeout, on either engine, at any scale, for either scheme, and
`removeProjections` makes *no measurable difference*: the two variants have
byte-for-byte identical timeout/error counts in every (engine, scheme)
bucket** (0/288 "ok" for `rewriting` and 0/288 "ok" for
`rewriting+removeProjections`, across both result sets combined):

| | rewriting | rewriting+removeProjections | materialized |
|---|---|---|---|
| reification / comunica | 0/36 ok, 36 timeout | 0/36 ok, 36 timeout | 16/36 ok, 20 timeout |
| reification / oxigraph | 0/36 ok, 12 timeout, 24 error | 0/36 ok, 12 timeout, 24 error | 11/36 ok, 1 timeout, 24 error |
| singleton / comunica   | 0/36 ok, 36 timeout | 0/36 ok, 36 timeout | 33/36 ok, 3 timeout |
| singleton / oxigraph   | 0/36 ok, 12 timeout, 24 error | 0/36 ok, 12 timeout, 24 error | 12/36 ok, 0 timeout, 24 error |

Spot-checked on a single query (`reification/A-Q1`, `xs` scale): `removeProjections`
does structurally simplify the query — 3415 → 2827 characters, the nested
`{ SELECT ... WHERE { ... } }` blocks collapse into a flat `UNION` of `BGP`s with
fresh (`?v_N`) variable names — but both the flat and nested forms still exceed
30s on both Comunica and Oxigraph on this dataset size. The bottleneck is the
*join plan* over the reification star-join (reconstructing every reified
statement, a wide 4-way star join, before any selectivity from the outer
query's constants can prune it), not the presence of sub-`SELECT`s per se, so
removing them doesn't help. This reproduces and extends the earlier finding
(see `plan.md` at the repo root): Comunica spends the timeout window
reconstructing every reification statement via that wide star-join, and
Oxigraph's block1 is fast in isolation but the full rewritten query
cross-products its nested subqueries — both blow past 30s on real data sizes,
even though the same rewriting logic returns instantly and correctly on small
synthetic data (verified separately: the multi-pattern variable-collision fix
from the `PURE GAV` refactor is confirmed correct — see the merge commit — the
remaining problem is purely a query-planning/performance one, not a
correctness one).

Materialized-query median latency (Comunica, ms) scales roughly linearly with
subset size, as expected:

| scale | reification (quads) | avg ms | singleton (quads) | avg ms |
|---|---|---|---|---|
| xs | ~298k | 3404 | ~301k | 451 |
| s  | ~671k | 2289 | ~709k | 764 |
| m  | ~2.2M | 9865 | ~2.2M | 2065 |

Oxigraph's materialized queries that *do* complete are noticeably faster than
Comunica's (single/double-digit ms vs. hundreds), but only ~30% of Oxigraph
runs completed at all (see below).

## `pushDownAssertions` (2026-08-20, xs/s subsets, 30s timeout, 1 rep)

`origin/main` replaced the earlier `substituteVarsThatArePreBoundToTerms`
prototype (which never fired on this benchmark — see git history) with
[`pushDownAssertions`](../../lib/transformations/pushDownAssertions.ts): a
`UNION`-aware, `FILTER`-aware pass that pushes `FILTER(sameTerm(?x, c))`
constraints down into the patterns that use `?x`, substituting the term into
BGPs, pruning `VALUES` rows, and emptying `UNION` branches that can never bind
the variable. It was merged into this branch and wired in as a fourth
approach, `rewriting+pushDownAssertions`
([`runner.ts`](runner.ts)), and re-run on the reification and singleton
schemes across both engines at the `xs`/`s` scales
(`results/pushdown-run.json`, figures in `results/figures-pushdown/`).

**Two bugs surfaced and were fixed before any timing was meaningful:**

1. `pushDownAssertions` alone can produce syntactically invalid SPARQL 1.1:
   when it statically empties a `UNION` branch, the surviving branch can end
   up as a bare sub-`SELECT` directly followed by sibling `BIND`s with no
   wrapping `{ }` around the sub-`SELECT` — a shape the standard pipeline
   never produces and the generator serializes as `Parse error: Expecting -->
   } <-- but found --> 'BIND' <--`. Every single benchmark query hit this
   (every rewritten triple pattern has a reification/non-reification `UNION`,
   and constants routinely empty one arm). Fixed by appending
   `removeProjections` to the pipeline as a required workaround (see the doc
   comment on `WITH_PUSH_DOWN_ASSERTIONS_TRANSFORMATIONS` in `runner.ts`) —
   flattening the offending `PROJECT` node avoids the shape entirely.
2. Oxigraph errored on *every* row, including `materialized` — unrelated to
   pushdown: the merge picked up a new `oxigraph` devDependency that hadn't
   been `yarn install`ed yet (`Cannot find package 'oxigraph'`). Fixed by
   reinstalling.

**With both fixed, `rewriting+pushDownAssertions` still has byte-for-byte
identical pass/fail outcomes to plain `rewriting` in every (scheme, engine)
bucket** — 0/24 "ok" everywhere, same timeout/error split:

| | rewriting / +removeProjections / +pushDownAssertions | materialized |
|---|---|---|
| reification / comunica | 0/24 ok, 24 timeout (×3, identical) | 11/24 ok, 13 timeout |
| reification / oxigraph | 0/24 ok, 12 timeout, 12 error (×3, identical) | 11/24 ok, 1 timeout, 12 error |
| singleton / comunica   | 0/24 ok, 24 timeout (×3, identical) | 22/24 ok, 2 timeout |
| singleton / oxigraph   | 0/24 ok, 12 timeout, 12 error (×3, identical) | 12/24 ok, 0 timeout, 12 error |

So within the benchmark's 30s SLA, it changes nothing. But pass/fail hides
*how far* a query got, so `reification/A-Q1` (xs scale, Comunica) was probed
directly at a 120s timeout instead of 30s:

| approach | Comunica | Oxigraph |
|---|---|---|
| `rewriting` (standard) | still running after 120s | still running after 120s |
| `rewriting+pushDownAssertions` | **41.5s, correct (3 rows)** | still running after 120s |

This is a real, large speedup on Comunica — over 2.9x faster (>120s down to
41.5s) — but the mechanism explains both why it helps here and why it can't
help most queries. `A-Q1`'s second triple pattern (`<< s p o >>
provenir:derives_from ?source`) has a literal-bound object; `pushDownAssertions`
proves the reification-reconstruction arm of that pattern's `UNION` can never
satisfy the constraint (a reified statement's constructed predicate is always
`rdf:reifies`, never `derives_from`) and deletes it outright, then substitutes
the bound object straight into the surviving arm's triple pattern — turning an
unbound-predicate scan into an indexed lookup. That's a genuine win, just not
the *dominant* cost: `A-Q1`'s *first* triple pattern (the actual `<< s p o
>>`, with no baseline binding) still needs the wide, unselective 4-way
star-join reconstruction of every reified statement in the dataset, and
`pushDownAssertions` leaves that arm completely untouched, because the
constraint it satisfies (`SAMETERM(?m_p, rdf:reifies)`) is *unconditionally*
true for that arm — there's no term left over to push further down. Queries
whose selective constants land on the *reification* pattern itself (the
`F-Q*` queries, which filter `SUBJECT()`/`PREDICATE()`/`OBJECT()` of the
constructed triple term against literal IRIs) get zero benefit even in
principle: pushing those constants into the `rdf:subject`/`rdf:predicate`/
`rdf:object` legs of the star join would require pushing *through* the
`<<( )>>` construction and extraction functions, which this version of
`pushDownAssertions` does not do (confirmed by diffing the rewritten
`F-Q4` query before/after: the star-join arms are byte-identical). Oxigraph
shows no improvement even on `A-Q1` — consistent with its established failure
mode being nested-subquery cross-products at the whole-query level, not
purely the cost of one `UNION` arm.

**Bottom line: `pushDownAssertions` is a real optimization, correctly
implemented for the constraints it targets, but the dominant cost in this
benchmark's rewritten queries is a constraint it cannot reach — pushing a
bound term through triple-term construction/extraction into the reification
star-join's legs remains the open problem.**

### Update: triple-term pushdown (2026-08-25, same xs/s subsets, 30s timeout, 1 rep)

`origin/main` gained exactly the missing piece flagged above: `#34`/`#35`
("Feat/assert variable access", "Materialise triple terms") extend
`pushDownAssertions` with a *pin lattice* over triple-term shapes, so a
conjunct can now be about `SUBJECT(?o)`/`PREDICATE(?o)`/`OBJECT(?o)` — not just
`?o` itself — and gets pushed/materialized accordingly (see the very thorough
[`report.md`](../../report.md) on main for the design). Merged into this
branch (no conflicts) and re-run unchanged
(`results/pushdown2-run.json`, figures in `results/figures-pushdown2/`).

**One more quirk surfaced, unrelated to the new triple-term logic itself —
and not a bug in this library.** The library's custom generator
([`lib/generator/generator.ts`](../../lib/generator/generator.ts)) emits the
`xsd:boolean` shorthand (`FILTER(FALSE)`/`FILTER(TRUE)`) upper-cased. That is
spec-compliant: per the SPARQL grammar notes
(https://www.w3.org/TR/sparql12-query/#sparqlGrammar), "Keywords are matched
in a case-insensitive manner with the exception of the keyword `a`" — so
`BooleanLiteral` is case-insensitive like any other keyword, not the
exception. **Oxigraph's installed build (`oxigraph@0.5.9`) rejects the
uppercase form anyway** (`error at N:M: expected ENCODE_FOR_URI` — a generic
fallback message from deep in its expression grammar), while accepting
lowercase `true`/`false`; a direct repro against the installed WASM binary
confirms it (`FILTER(TRUE)` and `FILTER(True)` both error, only
`FILTER(true)` parses) — and, oddly, Oxigraph's own tagged source for this
version defines `BooleanLiteral` with the case-insensitive `i()` keyword
helper, so the published build appears to disagree with its own grammar
source, not only with the spec. Comunica's parser is lenient and never
surfaced this. It started mattering *here* because the new triple-term
reasoning now statically proves 10/12 benchmark queries' "already a native
quad" `UNION` branch empty and materializes that as a literal `FILTER(FALSE)`
— 10/12 cases vs. 0/12 under `standard`/`removeProjections` — so every one of
those newly-pruned branches hit this Oxigraph quirk (pushed Oxigraph's
`rewriting+pushDownAssertions` error count from 12/24 to 22/24 per scheme,
with no matching drop in `standard`). Worked around with a narrow text-level
post-processing step scoped to exactly the shape the generator produces
(`FILTER ( TRUE|FALSE )` → lowercased), applied only to the query text sent to
engines in `rewriteToSparql11` — see the doc comment on
`lowercaseBooleanLiterals` in [`runner.ts`](runner.ts). The generator itself
is untouched, since its output was correct all along.

**With that fixed, the pass/fail picture within the 30s SLA is *still*
byte-for-byte identical** to both the original `pushDownAssertions` run and
plain `rewriting` — 0/24 ok on Comunica, and Oxigraph's `rewriting+pushDownAssertions`
error/timeout split (12/12 per scheme) now matches `rewriting`/`removeProjections`
exactly (no longer inflated by the generator bug, but not reduced either).

The two structural probes from the original investigation were re-run at a
120s timeout with the triple-term-aware pushdown:

| case | approach | Comunica | Oxigraph |
|---|---|---|---|
| `reification/A-Q1` | `rewriting` (standard) | still running after 120s | still running after 120s |
| `reification/A-Q1` | `rewriting+pushDownAssertions` | **36.4s, correct (3 rows)** — unchanged mechanism (predicate-arm pruning), same order of magnitude as before | still running after 120s |
| `reification/F-Q4` | `rewriting` (standard) | still running after 120s | still running after 120s |
| `reification/F-Q4` | `rewriting+pushDownAssertions` | **still running after 120s** | still running after 120s |

`F-Q4` is the interesting negative result: its rewritten query *did* change
structurally this time (confirmed by diffing standard vs. pushdown output —
no longer byte-identical, unlike the original finding). Every reification
`UNION`'s non-reified/"native quad" branch is now statically proven empty via
the triple-term shape (`ISTRIPLE(?o)` implied by the ground triple-term
constants contradicts that branch's own `!ISTRIPLE(?o)` guard, so it collapses
to `FILTER(FALSE)`). But that pruned branch was already the *cheap* side of
each `UNION` (a single unconstrained triple pattern) — the expensive side (the
4-way reification star-join: `?st rdf:type Statement . ?st rdf:subject ?s .
?st rdf:predicate ?p . ?st rdf:object ?o . BIND(<<( ?s ?p ?o )>> AS ?target)`)
is left completely untouched, because the constant comparison
(`SAMETERM(SUBJECT(?target), const)`) still sits as a `FILTER` *above* the
`BIND` that constructs `?target`, rather than being substituted through it
into `?s`/`?p`/`?o` directly. That confirms the diagnosis from the original
investigation was exactly right: pushing through triple-term
construction/extraction is necessary but not sufficient — the win here comes
from proving a sibling branch empty, not from turning the star-join into an
indexed lookup, and the star-join is still what dominates the cost. The
author's own [`report.md`](../../report.md) marks this precisely: "EXTEND
transfer (`BIND(<<( ?a ?b ?c )>> AS ?o)` and `BIND(subject(?o) AS ?x)`)" as
still open (phase 5).

**Updated bottom line: the triple-term extension is real, additional progress
— it makes `pushDownAssertions` correctly prove more `UNION` branches empty —
but it still doesn't reach the specific pattern this benchmark is bottlenecked
on. Until pushdown can substitute a bound term through a `BIND(<<(...)>> AS
?o)` back into the triple pattern that feeds it (turning the reification
star-join's legs into indexed lookups), no version of `pushDownAssertions`
will change this benchmark's 30s pass/fail outcome.**

### Update: phase 5 operation rules (2026-08-26, same xs/s subsets, 30s SLA + 120s probes, 1 rep)

`origin/main` landed exactly the piece the previous update called out as
missing: `#36` ("Feat/phase 5 operation rules") adds `pruneValues`, EXTEND
transfer through `BIND(<<( ?a ?b ?c )>> AS ?o)` / `BIND(SUBJECT(?o) AS ?x)`,
and the GRAPH/MINUS cases — closing every phase `report.md` had marked open.
Merged cleanly (no conflicts); full suite green (394 passed, 1 skipped).
Re-run unchanged (`results/pushdown3-run.json`, figures in
`results/figures-pushdown3/`).

**Within the 30s SLA, the reification scheme is still 0/24 ok on both
engines for every rewriting variant — unchanged.** But `singleton/oxigraph`
moved for the first time: `rewriting+pushDownAssertions` went from 0/24 to
**6/24 ok** (`A-Q2`, `A-Q3`, `A-Q4`, `F-Q1`, `F-Q4`, `F-Q5`, all at `xs`),
with no change on `standard`/`removeProjections` or on Comunica for either
scheme. One of those (`A-Q2`) now finishes in under a second.

**That 6/24 can't be scored against `materialized`, though — not because of
a rewriter bug, but because of a pre-existing mismatch in the benchmark
corpus itself**, only now exposed because these queries finally finish
instead of timing out. The shared canonical query
([`BKR-star_A-Q2.rq`](../statics/REF-Benchmark/BKR/queries/BKR-star_A-Q2.rq))
and the reification baseline
([`BKR-R_A-Q2.rq`](../statics/REF-Benchmark/BKR/queries/BKR-R_A-Q2.rq)) agree
on the same constants (`bkr_meta:C0543467-INST bkr_sn:TREATS
bkr_meta:C0178292-INST`), but the singleton baseline
([`BKR-S_A-Q2.rq`](../statics/REF-Benchmark/BKR/queries/BKR-S_A-Q2.rq)) asks
about an unrelated fact (`meta:C0012963 sn:STIMULATES meta:C0598981`) — same
shape of query, different sample data, not even the same relation. Checked
this holds for `F-Q4` too and confirmed which side is real: in
`singleton-xs.ttl`, `bkr:META_C0040300-INST` (the star query's subject) is
used 16700 times, `umls:META_C0040300` (the baseline's subject) exactly
once — the star query is asking about substantial, real data in this
dataset, the singleton baseline query just happens to ask about something
else. `pushDownAssertions` returning 20004/3386 rows for `F-Q4`/`F-Q5` where
`materialized` returns 0 is this mismatch becoming visible, not a wrong
answer; see the new "Other findings" entry below. Filed as a benchmark-corpus
issue, isolated to `BKR-S_*.rq`, unrelated to this session's changes.

**The reification scheme is where phase 5's claim can actually be checked**,
since its baseline files do use the star query's own constants. Re-probed
`A-Q1` and `F-Q4` at 120s:

| case | approach | Comunica | Oxigraph |
|---|---|---|---|
| `reification/A-Q1` | `standard` | still running after 120s | still running after 120s |
| `reification/A-Q1` | `pushDownAssertions` | 40.7s, correct (3 rows) — unchanged mechanism, same order of magnitude as the two earlier runs (41.5s, then 36.4s) | still running after 120s |
| `reification/F-Q4` | `standard` | still running after 120s | still running after 120s |
| `reification/F-Q4` | `pushDownAssertions` | **119.1s, 20004 rows** — first time this case has ever finished | still running after 120s |

`F-Q4`'s `materialized` baseline (Oxigraph, 722ms) also returns exactly
**20004** rows, confirming the pushdown result is correct, not a regression.
Diffing the rewritten query against `standard` shows the mechanism directly:
where `standard` still has `?p0_mi_t rdf:subject ?p0_mi_s` (an unconstrained
scan, the constant checked afterwards in a `FILTER`), the phase-5 build
emits `?v_3 rdf:subject <...META_C0040300-INST> .` — the ground term
substituted straight into the star-join's `subject`/`predicate`/`object`
legs, on all three reification arms. That is precisely the "EXTEND transfer"
`report.md` described as the missing piece, and it now measurably turns
three unindexed scans into three indexed lookups per arm — the reason
`F-Q4` moved from *no engine finishes it even at 120s* to *Comunica finishes
it, correctly, at 119.1s*.

It still doesn't clear this benchmark's 30s SLA, and Oxigraph still can't
finish it at 120s either (consistent with Oxigraph's established
whole-query nested-subquery cost, orthogonal to this). But the specific gap
the previous update identified — pushing a bound term *through*
triple-term construction/extraction into the star-join's legs — is now
implemented and demonstrably works.

**Updated bottom line: phase 5 closes the gap the previous update
identified — the star-join legs are genuinely indexed now, not just the
sibling `UNION` branch — and it produces a real, validated (matches
`materialized` exactly) improvement on `F-Q4` from "unbounded" to 119s.
That's not yet under this benchmark's 30s SLA, so the practical pass/fail
conclusion for the reification scheme is still unchanged; closing the
remaining ~90s is a join-ordering/engine-planning question now, not a
missing rewrite capability. `pushDownAssertions` has no correctness issues
of its own in either scheme — the one apparent regression found
(`singleton`'s 20004/3386-row results) traces to a pre-existing benchmark
corpus mismatch, not the rewriter.**

## Adding Jena as a third engine (2026-08-27, xs/s subsets, 30s SLA, 1 rep)

`jena` (Fuseki 6.2.0, Java 21) is now wired into `run.ts` as a first-class
engine (see "Adding Jena / Fuseki" above for the `JenaEngine` design and
setup). Re-ran the same xs/s sweep used for every update above, this time
with `--engines jena` only (`results/jena-run.json`) — Comunica/Oxigraph
numbers are unchanged from the phase 5 update.

**Headline result: on `pushDownAssertions`, Jena clears this benchmark's 30s
SLA on almost every case — 22/24 reification, 22/24 singleton — where
Comunica and Oxigraph have been stuck at 0/24 through every update above.**
Median latency 1.7s (reification) / 3.0s (singleton), worst case 13.9s, all
comfortably inside the SLA. Verified correct: for every one of the 18
reification cases where both `pushDownAssertions` and `materialized`
completed, their row counts match exactly (0 mismatches) — this is a *real*,
validated pass/fail change for the reification scheme, the first this
benchmark has seen (every earlier update's "still 0/24, unchanged" line no
longer holds once Jena is one of the engines).

**But this comes with a serious correctness caveat that has to be read before
the numbers above mean anything: Jena/ARQ 6.2.0 has a real bug that makes the
plain `rewriting` (`standard`) approach silently wrong, not just slow.**
Across both schemes, `rewriting` reports `ok` status on **48/48** cases (it
*never* times out on Jena) — which looks, at a glance, like Jena trivially
solves the whole benchmark. It doesn't: checked against `materialized` on the
18 comparable reification cases, `rewriting`'s row count is wrong on **11 of
18 (61%)** — always by silently returning too few rows (typically 0 where the
correct answer is nonzero: `A-Q1` 0 vs. 3, `B-Q1` 0 vs. 5, `F-Q1` 0 vs. 2,
etc.), never an HTTP error or a timeout. `removeProjections` is *mostly* but
not *entirely* immune (1 mismatch of its own: `reification/A-Q3` at `s`
scale, 0 vs. 1) — only `pushDownAssertions` was clean across every comparable
case in this run.

Root-caused with a minimal, portable repro (isolated outside this repo's
query shapes, directly against a plain Fuseki instance):

```sparql
PREFIX : <urn:>
SELECT ?tt ?b ?g WHERE {
  { SELECT ?g ?tt WHERE { ?g :hasX ?x . BIND( <<( ?x :p :o )>> AS ?tt ) } }
  { SELECT ?g ?b WHERE { ?g :hasB ?b } }
}
```
Run standalone, the first block's `?tt` (an RDF 1.2 triple-term value
constructed by `<<( )>>` inside a `BIND`) is returned correctly. Joined
against the sibling `{ SELECT ?g ?b ... }` block on the shared `?g` — exactly
the shape every mapper branch in this benchmark's rewritten queries
produces — the join still finds the right rows (`?g`/`?b` come back correct),
but **`?tt`'s binding silently disappears from every result row**, with no
error. It doesn't matter whether the projected variable is renamed
(`?tt AS ?a`), has a function applied to it (`SUBJECT(?tt) AS ?a`, `?x IN
?tt`, ...), or not — the trigger is purely "a triple-term-valued variable
from a joined sub-`SELECT`'s projection, at an outer join boundary". Confirmed
directly on this benchmark's actual `reification/A-Q1` query too: both
`p0` and `p1`'s sub-`SELECT` blocks independently return the right rows (and
share exactly the 3 expected `?uq_g_0` join values — confirmed by
restricting `p0` with an explicit `FILTER (?uq_g_0 IN (...))`), but the
literal join of the two full, unrestricted blocks (`standard`'s actual
shape) returns 0 rows; a version of the query with `p0`'s inner `UNION`
removed instead returns the right *count* of rows but with the
triple-term-derived `?uq_s`/`?uq_p`/`?uq_o` columns all unbound — same bug,
different visible symptom depending on exact structure. This is not a
correctness issue in this library or in `pushDownAssertions`/
`removeProjections` — it's an ARQ evaluation bug that happens to be
*structurally* dodged (not intentionally worked around) by whichever
pipeline flattens away the sub-`SELECT` boundary the triple term crosses.
No existing report of this was found in a quick search of Jena's issue
tracker; consider filing it upstream if this is going to be relied on.

**Practical implication for reading `jena-run.json` (or any future Jena run):
don't trust `rewriting`'s (`standard`) row counts or its "0/N timeouts" as a
pass signal — cross-check against `materialized` or `pushDownAssertions`.**
`run.ts`'s own `correct` field gets this backwards for Jena specifically: it
uses `rewriting` as the reference answer (reasonable when `rewriting` reliably
either gets the right answer or times out, which held for every engine before
Jena), so on Jena's data the *wrong* fast `rewriting` result is trivially
"correct" against itself while the *right* `pushDownAssertions`/`materialized`
results get marked `correct: false` against it — exactly backwards. Not
changed in `run.ts` here, since fixing the reference-selection strategy in
general (e.g. preferring `materialized` when available, or majority vote
across approaches) is a broader methodology question outside this session's
scope — flagging it so it isn't misread from the raw JSON.

**Bottom line: Jena is now available for `run.ts`, and on the one pipeline
verified trustworthy on it (`pushDownAssertions`), it comfortably clears the
30s SLA where Comunica/Oxigraph cannot — a genuinely different practical
result for the reification scheme. But `standard`'s apparent 100% "ok" rate on
Jena is an illusion caused by a real Jena/ARQ correctness bug, not a rewriter
achievement, and even `removeProjections` isn't fully safe from it — only
`pushDownAssertions` measured clean in this run.**

### Other findings (engine/data quirks, not rewriter bugs)

- **Two of the 24 hand-written baseline query files were missing a `PREFIX
  rdf:` declaration** (`BKR-R_B-Q3.rq`, `BKR-S_A-Q4.rq`). Comunica's parser
  tolerated the undeclared prefix; Oxigraph's stricter parser correctly
  rejected it (`error at 8:14: expected one of Prefix not found`). **Fixed**
  by adding the missing `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>`
  line to both files (matching each file's existing prefix style) — confirmed
  in the run above: `singleton/A-Q4 materialized` on Oxigraph now succeeds
  (previously `error`).
- **The `s`/`m` scale subsets (random noise-sampled from the real
  multi-GB datasets) contain at least one malformed percent-encoded IRI**
  (literal `%%-`) that Oxigraph's Turtle parser rejects
  (`Invalid IRI percent encoding '%%-'`) while N3 (used by Comunica) accepts
  it silently — this is a pre-existing data-quality issue in the source BKR
  Turtle dumps, surfaced by noise sampling; it explains most of Oxigraph's
  `error` rows at `s`/`m` scale (xs mostly avoided sampling it). Not fixed —
  it's in the source data, not something this benchmark generates.
- **The `BKR-S_*.rq` (singleton scheme) baseline query files test different
  sample facts than the shared `BKR-star_*.rq` queries they're nominally the
  baseline for**, for at least `A-Q2`/`A-Q3`/`A-Q4`/`F-Q1`/`F-Q4`/`F-Q5`
  (found via the phase 5 update above, once `pushDownAssertions` made these
  queries fast enough to actually return an answer instead of timing out).
  The reification baseline files (`BKR-R_*.rq`) use the exact same constants
  as the star query; the singleton ones don't — e.g. `F-Q4`'s star/`BKR-R`
  constant `bkr:META_C0040300-INST` occurs 16700 times as a subject in
  `singleton-xs.ttl`, while `BKR-S_F-Q4.rq`'s `umls:META_C0040300` occurs
  once. Pre-existing in the benchmark corpus, not something this session or
  `pushDownAssertions` introduced; it just was never observable before
  because the singleton rewritten queries always timed out on both sides of
  the comparison. Not fixed — it's a discrepancy in the shipped `.rq` files,
  out of scope here; flagging it so a future correctness comparison for the
  singleton scheme isn't misread as a rewriter bug.
- The **correctness heat-strip figures show mostly "?" (unknown), not "✓/✗"**:
  because the standard `rewriting` approach never completes, `run.ts` has no
  reference answer to compare `materialized` or `rewriting+removeProjections`
  against, so `correct` is `null` rather than `false`. This is *not* evidence
  of an incorrect result — see the separate small-scale correctness
  verification above. A meaningful correctness figure would need either a much
  longer timeout or a fix to the rewritten query's join plan. (Two heat-strips
  are generated per scheme × engine: `..._correctness_materialized.svg` and
  `..._correctness_proj-removed.svg`.)

## Extending

- **New engine**: implement `BenchEngine` (or reuse `SparqlHttpEngine` for any
  standards-compliant HTTP endpoint you start/load yourself) and add it to
  `makeEngine()` in `run.ts` (or the engine list in `cli.ts`). If the engine
  needs its own long-lived external process (like `JenaEngine`'s Fuseki child
  process), implement optional `dispose(): Promise<void>` on `BenchEngine` so
  `run.ts` can shut it down once it's done with that engine.
- **New reification pattern**: add an entry to `PATTERNS` in `config.ts` with its
  CONSTRUCT mappers, materialized dataset filename and baseline query prefix, then
  generate its subsets with `makeSubset.mjs` (check whether its data structure
  needs its own `isClosureSeed` branch, like `singleton` does).
