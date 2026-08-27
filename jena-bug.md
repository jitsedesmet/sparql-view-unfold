# Apache Jena / ARQ: triple-term binding lost across a sub-`SELECT` join boundary

## Audience

This file is a handoff to whoever picks up the fix — it is **not** about this
repository's code. The bug lives in Apache Jena (specifically ARQ, Jena's
SPARQL query engine), a separate upstream project
(<https://github.com/apache/jena>). Nothing in *this* repo needs to change to
fix it; this repo is where the bug was found (as a side effect of adding Jena
as a third engine to `test/bench/`), and `test/bench/README.md`'s "Adding
Jena as a third engine" section has the full context of how it surfaced
there, including its practical impact on that benchmark. This file is the
self-contained version for someone who is going to go fix Jena itself.

## Summary

Tested against **Apache Jena Fuseki 6.2.0** (requires Java 21+; run via
`java -jar fuseki-server.jar --file <data.ttl> --port <port> /ds`, queried
over the SPARQL 1.1/1.2 HTTP protocol at `/ds/sparql`).

When a sub-`SELECT` projects a variable that holds an **RDF 1.2 / RDF-star
triple term** (a value constructed with `<<( s p o )>>`, e.g. via
`BIND(<<( ?s ?p ?o )>> AS ?tt)`), and that sub-`SELECT` is then **joined
against a sibling graph pattern** at the enclosing level, the triple-term
variable's binding is **silently dropped** from every result row. The join
itself is otherwise correct — the shared join variable(s) correctly restrict
the result set to the right rows, and no error is raised — but the
triple-term-valued variable comes back unbound, as if it had never been
bound at all.

This is a genuine correctness bug: the query returns a result set with the
right *shape* and *row count*, silently missing data in one column, with no
warning, error, or difference in HTTP status. A caller has no way to detect
this from the response alone.

## Minimal reproduction

Data (`data.ttl`):

```turtle
@prefix : <urn:> .
:g1 :hasX "x1" .
:g1 :hasB "b1" .
```

Start Fuseki loaded with it:

```bash
java -jar fuseki-server.jar --file data.ttl --port 3134 /ds
```

**Query A — no join, just the sub-`SELECT` alone (correct):**

```sparql
PREFIX : <urn:>
SELECT ?g ?tt WHERE {
  ?g :hasX ?x .
  BIND( <<( ?x :p :o )>> AS ?tt )
}
```

Result — `?tt` is correctly bound to the constructed triple term:

```json
{
  "g": { "type": "uri", "value": "urn:g1" },
  "tt": {
    "type": "triple",
    "value": {
      "subject": { "type": "literal", "value": "x1" },
      "predicate": { "type": "uri", "value": "urn:p" },
      "object": { "type": "uri", "value": "urn:o" }
    }
  }
}
```

**Query B — the same block, wrapped as a sub-`SELECT` and joined against a
sibling `?g :hasB ?b` pattern (buggy):**

```sparql
PREFIX : <urn:>
SELECT * WHERE {
  { SELECT ?g ?tt WHERE { ?g :hasX ?x . BIND( <<( ?x :p :o )>> AS ?tt ) } }
  ?g :hasB ?b .
}
```

Result — the join correctly finds the one matching row (`?g`/`?b` are
right), but **`?tt` is entirely missing from the binding**, not merely
unbound-but-present:

```json
{
  "g": { "type": "uri", "value": "urn:g1" },
  "b": { "type": "literal", "value": "b1" }
}
```

Expected: the same row, with `?tt` present and bound exactly as in Query A.

## What does and doesn't trigger it (isolated by direct testing against a running Fuseki 6.2.0)

- **Requires** the triple-term-valued variable's `BIND` to be inside a
  **sub-`SELECT`** (i.e. behind a nested `{ SELECT ... }` projection
  boundary). Removing the sub-`SELECT` — leaving a plain `{ }` group with the
  same `BIND`, joined the same way — makes the bug disappear; `?tt` comes
  back correctly bound. This is the single necessary condition, isolated by
  A/B testing with everything else held constant.
- **Requires** the sub-`SELECT` to be joined against *something else* at the
  outer level. Run alone (Query A above), it is correct.
- **Does not require** the join partner to itself be a sub-`SELECT` — a
  plain triple pattern as the sibling (`?g :hasB ?b .`, no wrapping
  `{ SELECT }`) reproduces it identically.
- **Does not require** `UNION`, `FILTER`, or any function
  (`SUBJECT()`/`PREDICATE()`/`OBJECT()`/`ISTRIPLE()`) applied to the
  triple-term variable — a bare, un-renamed, unmodified projected variable
  (`?tt`, not even `?tt AS ?a`) is enough.
- **Does not require** any particular data scale — reproduces on a
  2-triple dataset exactly as on a ~300k-triple real-world dataset (where it
  was originally noticed).
- Symptom can vary slightly by exact query structure: in the query above the
  variable is dropped entirely from the row's key set (not merely
  `null`/absent-value). In at least one more complex variant (see the
  "Real-world context" section below), the same underlying mechanism instead
  produced a row set with the *correct count* but with several
  triple-term-derived columns all unbound — so a fix should be verified
  against both shapes, not just the minimal repro above.

## Suspected area

This smells like a join/merge-implementation issue in ARQ's algebra
execution for `(join (project ...) ...)` — most likely wherever solutions
from an evaluated sub-`SELECT` (materialized bindings, possibly returned as
a `QueryIterator`/`Binding` sequence produced via `OpExecutor`/
`QueryEngineMain`) get merged with the outer join's other side (nested-loop
join, hash join, or the `Substitute`/index-join optimizations ARQ applies
depending on cardinality — worth checking whether disabling those
optimizations, e.g. forcing a plain nested-loop join, makes the bug
disappear, which would point squarely at one specific join strategy).
`Node_Triple` (Jena's internal representation of an RDF 1.2 triple term) may
not be round-tripping correctly through whatever binding-merge path is taken
specifically when the value crosses a sub-`SELECT`'s result-materialization
boundary — e.g. a `Var`-to-`Node` map or a `BindingBuilder` step that
special-cases or mishandles `Node_Triple` values, or a scope/rename step for
sub-`SELECT` variables that doesn't preserve them correctly. This is a
hypothesis to guide where to start looking, not a confirmed root cause —
please verify against the actual ARQ source rather than assuming it.

## Task

1. **Reproduce** the bug against a Jena checkout (`git clone
   https://github.com/apache/jena`), using either the SPARQL HTTP protocol
   (as above) or, more directly for debugging, Jena's Java APIs
   (`QueryExecutionFactory`/`RDFConnection` over an in-memory `Dataset`) so
   you can step through ARQ's evaluation with a debugger.
2. **Find the root cause** in ARQ's join execution / sub-`SELECT` evaluation
   code (see "Suspected area" above for a starting point — confirm or
   correct that hypothesis against the actual code, don't assume it).
3. **Write regression test(s)** in Jena's existing test suite (ARQ has
   extensive JUnit coverage for RDF-star / RDF 1.2 triple-term support —
   find the relevant test package, e.g. around triple-term evaluation,
   `BIND`, or sub-`SELECT`/join execution, and match its existing style).
   Cover at minimum:
   - The minimal repro above (sub-`SELECT` projecting a triple-term `BIND`,
     joined against a sibling triple pattern) — assert the triple-term
     column is present and correctly bound in the result.
   - The same shape joined against a sibling *sub-`SELECT`* rather than a
     plain triple pattern (confirm this is also covered, since it's the more
     common shape in generated/rewritten SPARQL).
   - A negative control: the same `BIND` *without* a sub-`SELECT` wrapping it
     (should already pass — guards against a regression that makes the fix
     too broad).
4. **Implement the fix** in ARQ. Keep it as narrowly scoped as the actual
   root cause allows — this is evaluation-correctness code, so prefer a
   precise fix over a broad one that might mask the symptom without
   addressing the cause.
5. **Verify no regressions**: run Jena's full ARQ test suite (`mvn test` in
   the relevant module, or the project's usual build) before calling this
   done, not just the new regression tests.
6. If, after investigation, this turns out to already be a known/reported
   issue, or you find it's actually expected/spec-compliant behavior for
   some subtle reason, report that finding back instead of forcing a fix —
   a search of Jena's GitHub issues for this exact symptom came up empty
   before this file was written, but that search was not exhaustive.

## Real-world context (for background only — not required reading to fix the bug)

This was found while adding Jena as a benchmark engine in
[jitsedesmet/2025-query-rewriting-1-2](.), a SPARQL 1.2-to-1.1 query
rewriting library. Its benchmark rewrites SPARQL 1.2 queries (that use RDF
1.2 triple terms) into semantically-equivalent SPARQL 1.1 queries against a
materialized RDF 1.1 representation, and one of its three rewrite pipelines
(`standard`, the least-optimized one, before an optional flattening pass
removes the nested sub-`SELECT`s) happens to structurally match this bug's
trigger shape exactly: it wraps each source pattern in its own sub-`SELECT`,
several of which construct a triple term via `BIND(<<( s p o )>> AS ?o)`,
then implicit-joins those sub-`SELECT`s together. Full investigation,
numbers (this bug made 61% of a benchmark's comparable "successful" results
on Jena silently wrong rather than merely slow), and the more complex
real-query variant of the repro are in `test/bench/README.md`, section
"Adding Jena as a third engine (2026-08-27, ...)". None of that context is
needed to fix the ARQ bug itself — it's here in case it's useful for
understanding why this was being looked for in the first place, or for
picking additional realistic test-case shapes.
