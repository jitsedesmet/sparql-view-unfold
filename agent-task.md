# Agent task — the 0.0.0 API, one PR per phase

The repository is technically strong and its API is not. This task turns the current
"call `queryTransform` with a context and a list of functions" surface into a **pipeline of
transformations** over a query, and turns the README from a research sketch into a package README.

We are not under semantic versioning yet: **breaking changes are fine and expected**. Optimise for
code reuse, and wherever a name has to be chosen, choose the longer one that says what the thing is.

The target API:

```typescript
import {
  createQueryRewriter,
  mappingFromConstructQueries,
  unfoldingTransformation,
  rewriteNonRecursivePathsTransformation,
  filterFalseTransformation,
  pushDownAssertionsTransformation,
  pullUpExtendsTransformation,
} from 'traqula-sparql-1-2-rewriter';

const rewriter = createQueryRewriter([
  rewriteNonRecursivePathsTransformation(),
  unfoldingTransformation(
    mappingFromConstructQueries([ tripleTermConstruct, nonTripleTermConstruct ]),
    { preserveCardinality: false },
  ),
  filterFalseTransformation(),
  pushDownAssertionsTransformation(),
  filterFalseTransformation(),
  pullUpExtendsTransformation(),
  filterFalseTransformation(),
]);

const sparql11Query = await rewriter.rewriteQuery(userQuery);
```

---

# A. Shared ground

## A.1 Orientation — read these before writing anything

- `lib/index.ts`, `lib/transformContext.ts`, `lib/transformBgp.ts` — the surface being replaced.
- `lib/transformations/index.ts` — the `@fileoverview` listing every pass, one paragraph each.
- `lib/consts.ts` — the three variable prefixes and why two of them are load-bearing.
- `test/integration.test.ts` — the end-to-end contract: a query over mapped RDF 1.2 data and the
  rewritten query over the RDF 1.1 data must agree. This is what proves a change correct.
- `test/queryConsts.ts` — the mappings and queries every test is written against.

If an (untracked) `traqula/` checkout is present, its `engines/*` and `packages/*` are symlinked into
`node_modules/@traqula/*`; after editing traqula sources run `yarn build:ts` inside `traqula/`,
because the symlinks resolve to `dist/esm` rather than to the `.ts` files.

## A.2 House rules, inherited by every PR

- Each phase is one PR. `yarn lint` and `yarn test` clean before it is done.
- Never weaken an existing test to make a change pass. If an expectation must change, the PR says in
  one line why the new expectation is the right one.
- Do not leave dead code behind "in case it is useful". Delete it; git remembers.
- Prefer reusing what exists over writing a second version of it. Several of the phases below are
  explicitly about reuse — `unstableOperators`, `solutionModifierChainOf`, `createFilterFalse`.

## A.3 Code style

These are the conventions the repository is written in. They are not suggestions — they get
re-written by hand in review when they are not followed, so getting them right the first time saves a
round trip.

### Names

**Prefer long descriptive names** for functions, variables, types and fields over short one-word
names that do not capture what the thing is or does.

- Reject: `settle`, `assemble`, `Candidate`, `below`, `group`.
- Write: `settlePartition`, `assembleRewrittenNode`, `FloatingBind`, `scopeBelowBind`, `mustLeaveWith`.

This holds **even where nearby existing code is terser** — `keep`, `empty` and `swapWith` in
`pushDownAssertions.ts` are the kind of name not to imitate. Match the surrounding code's *comment
density and idiom*, but not its short names.

On finishing a file, re-read every identifier and ask whether the name alone says what it is. Rename
the ones that do not.

**A function lives in the file most relevant to it**, not in whichever file first needed it. A
generic expression predicate belongs in `lib/utils/expressionHelpers.ts` even when only one pass
calls it; a helper two passes both grew belongs in `lib/utils/`. Check this before declaring a file
done.

*Why:* the codebase explains *why* in prose and expects the code itself to say *what*. An opaque name
forces a reader to the definition to learn something the call site should already have told them.

### JSDoc

A JSDoc block is **one or two sentences** saying what the thing does, followed by `@param` for each
parameter and `@returns`. Nothing longer. This applies to the README and ARCHITECTURE.md too: nobody
reads documentation that is too long.

This does **not** mean deleting the reasoning — this repo values the *why*. Relocate it:

- a rule-specific argument becomes a **short comment in the function body**, right above the decision
  it justifies;
- a pass-wide argument belongs in the file's **`@fileoverview`**, which is a file header rather than a
  symbol's JSDoc and stays as long as it needs to be.

*Why:* the doc block is what a reader sees hovering a call site; an argument several paragraphs long
buries the one sentence they came for.

### Control flow and TypeScript

- **Positive nesting** inside a loop body: `if (ok) { … }`, not `if (!ok) { continue; } …`. An early
  `return` that skips *whole work* — a function with nothing to do at all — is the different case and
  is welcome.
- **`if`/`else` over a multi-line ternary.** A ternary that does not fit on one line becomes a
  statement.
- **Two sequential `if`s with the same body** become one `if` with a compound condition.
- **No `!` non-null assertion.** Test the value explicitly, even where the surrounding argument proves
  it cannot be `undefined`.
- **Exhaustive `switch` with no `default`** over a closed union, so a new member is a compile error
  rather than a silent fall-through.
- **Let inference work**: no redundant type annotation on a callback parameter the signature already
  fixes.
- Short intent comments at the point of the decision are welcome on top of the prose. **A comment
  must state its condition the right way round** — one that reads as the opposite of its branch is a
  defect.

## A.4 Conventions this task introduces

- **Every pipeline step is a factory** named `<descriptiveStem>Transformation()`, returning a
  `QueryTransformation`. It takes arguments only where it has something to configure; the others
  still take `()`, so a pipeline reads as a uniform list.
- **Argument order stays `(context, operation)`**, matching all twelve existing passes. The factory
  is what users see; the order inside it is invisible to them, and changing it is pure churn.
- **The mapping is not in the context.** It reaches the unfolding through the closure
  `unfoldingTransformation(mapping)` creates, which is the whole point of the redesign.
- **A fresh context per `rewriteQuery` call.** `ClusterSolver` is stateful (`clear()` at the top of
  `rewriteSinglePattern`), and the pipeline is now async — two concurrent `rewriteQuery` calls
  sharing one context would interleave and corrupt each other.

---

# Phase 1 — The mapping as a value

Today `transformContextFromConstructs` both builds the mapping and builds the context, and rejects a
CONSTRUCT template with more than one triple. The mapping becomes a value of its own, and the
multi-triple case becomes the caller-facing convenience it should always have been.

### Files

- `lib/mapping.ts` (new) — everything about turning CONSTRUCT queries into a `Mapping`.
- `lib/types.ts` — `Mapping`, `MappingHead` unchanged.
- `lib/transformContext.ts` — loses `constructToMapper` and `transformContextFromConstructs`.

### Work

1. `mappingFromConstructQueries(constructQueries: readonly string[]): Mapping`, the single public
   entry point. Per query: parse, then **split a template of N triples into N mappings sharing one
   body** — a CONSTRUCT instantiates every template triple per solution, so the split produces
   exactly the same set of triples. Document that equivalence in one sentence.
2. Validate each single-triple head with the existing position check (`Variable`/`NamedNode` in
   subject and predicate; `NamedNode`/`Variable`/`Literal`/`Quad` in object, recursing into a Quad).
3. Keep the existing `FILTER(bound(?x))` per head variable that `withCpVars` does not already prove
   certainly bound, and the projection onto the head variables.
4. **Reject unstable functions in the body** by reusing `unstableOperators` from
   `lib/utils/expressionHelpers.ts` (`bnode`, `rand`, `uuid`, `struuid`) instead of the ad-hoc
   `bnode`-only check. `NOW` stays allowed — SPARQL 1.1 §17.4.5.1 fixes it per query execution.
   Error messages name the offending function.
5. **`internal://blank` (`EXTENSION_FUNCTION_BNODE`) is the function a mapping body writes**, there
   being no second public spelling of it. Document that IRI instead of the
   `https://sparql-extension.knows.idlab.ugent.be/bnodeConsistent` the README used to name.
6. Merge several mappings into the generic `?m_s ?m_p ?m_o` head exactly as
   `transformContextFromConstructs` does today (an `EXTEND` per head position, then a `UNION` of the
   bodies, then a `PROJECT`). **A single mapping keeps its specific head** — that is the decided
   behaviour and the better unfolding.

### Tests — `test/mapping.test.ts`

- A two-triple template becomes a mapping equivalent to passing the two CONSTRUCTs separately.
- A body using `RAND`/`UUID`/`STRUUID`/`BNODE` is rejected, one test each; `NOW` is accepted.
- One mapping keeps its head; two mappings merge to `?m_s ?m_p ?m_o`.

### Done

`mappingFromConstructQueries` is the only way to build a `Mapping`, and no test constructs a context
to get one.

---

# Phase 2 — The pipeline

### Files

- `lib/queryRewriter.ts` (new) — `QueryTransformation`, `createQueryRewriter`, the default pipeline.
- `lib/transformContext.ts` — `TransformationContext` without `mapping`.
- `lib/transformBgp.ts` — `operationTransform` becomes the body of `unfoldingTransformation`.
- every file in `lib/transformations/` — a factory export each.
- `lib/AlgebraTemplateFactory.ts` — **deleted**; it is an empty subclass of `AlgebraFactory`, and the
  context field becomes a plain `AlgebraFactory`.
- `lib/index.ts`, and every test that imports the old surface.

### Work

1. ```typescript
   export type QueryTransformation = (
     context: TransformationContext,
     operation: Algebra.Operation,
   ) => Algebra.Operation | Promise<Algebra.Operation>;
   ```
   The runner awaits each step, so a synchronous pass needs no wrapping.
2. Rename `TransformContext` to `TransformationContext` and drop its `mapping` field. Mechanical
   across ~20 files; the local name `c` may stay.
3. A factory per pass, wrapping the existing function unchanged:
   `rewriteNonRecursivePathsTransformation`, `unfoldingTransformation(mapping, options)`,
   `filterFalseTransformation`, `pushDownAssertionsTransformation`, `pullUpExtendsTransformation`,
   `removeProjectionsTransformation`, `nullifyJoinOverIncompatibleBoundsTransformation`,
   `nullifyUnbindableVarsTransformation`, `extendsToValuesTransformation`,
   `joinValuesToFilterTransformation`, `serviceCallPushUpTransformation`,
   `internalBnodeAsSpecialLiteralTransformation`, `internalBnodeAsSpecialIriTransformation`,
   `simplifyStaticExpressionsTransformation`.
4. `createQueryRewriter(transformations: readonly QueryTransformation[]): QueryRewriter` with
   - `rewriteQuery(query: string): Promise<string>` — parse, precheck (Phase 3), peel, prefix, run
     the pipeline, rebuild, generate;
   - `rewriteOperation(operation: Algebra.Operation): Promise<Algebra.Operation>` — the same over
     algebra, for callers already holding one.

   A fresh `TransformationContext` per call (A.4).
5. `unfoldingTransformation(mapping, options)` closes over the mapping and calls what is now
   `operationTransform`, passing the mapping down to `rewriteSinglePattern`. `options` is
   `{ preserveCardinality?: boolean }`, default `false`; Phase 5 gives it meaning.
6. `lib/index.ts` exports the rewriter, the factories, `mappingFromConstructQueries`, the `Mapping`
   and `QueryTransformation` types, and the consts. `queryTransform`, `operationTransform`,
   `transformContextFromConstructs` and `createPartialContext` are **removed** from the public API.

### Tests

Every existing test moves to the new API. No expected output changes in this phase — that is the
check that the refactor is behaviour-preserving.

---

# Phase 3 — Restrictions, checked before anything runs

Two restrictions currently produce **silently wrong queries**, measured:

- `SELECT * { ?s <ex://p>+ ?o }` passes through un-unfolded, querying the RDF 1.1 data directly and
  bypassing the mapping entirely.
- `SELECT * { GRAPH ?g { ?s <ex://p> ?o } }` loses the GRAPH altogether and projects an `?uq_g` that
  nothing binds.

### Work

1. `parseQuery` switches to `toAlgebra(ast, { quads: false, blankToVariable: true })`, so a `GRAPH`
   survives as an operation of its own rather than as the graph component of every pattern below it.
   `pullUpExtends` and `pushDownAssertions` already have tested GRAPH rules that this reaches.
2. `assertUserQueryIsSupported(operation)` — one `visitOperation` pass, run at the top of
   `rewriteQuery`/`rewriteOperation`, throwing on:
   - a `ZeroOrMore` or `OneOrMore` property path;
   - a `GRAPH` operation. Named-graph semantics under unfolding are not settled, and rejecting is the
     honest answer until they are.

   Each error names the restriction and points at the README section.
3. The mapping-side restrictions (Phase 1 step 4) stay where they are, on mapping construction.

### Tests

- `test/restrictions.test.ts`: `+`, `*`, and `GRAPH` each rejected with a message naming them;
  `?`, `|`, `/`, `^`, `!(…)` all still accepted.
- **Five expectations in `test/pushDownAssertions.test.ts` change** — all GRAPH-related, all measured:
  `is transparent for GRAPH…`, `empties a GRAPH whose name is asserted to be a literal`,
  `promotes back to the strong form at a GRAPH…`, `substitutes it into a pattern carrying a graph of
  its own`, `empties a graph-carrying pattern that would need one in its subject position`.
  The last two are *about* quad-carrying patterns, so keep an explicit quads-parsing helper for them.
  Nothing else in the 542-test suite moves.

---

# Phase 4 — Restore: a pattern that cannot match unfolds to FILTER(FALSE)

This is a **regression to repair, not a feature to invent.** With a single mapping whose head pins a
position, a user pattern with a different constant there makes `ClusterSolver.register` throw
`Cannot match Term …` out of `rewriteQuery`. There is no `try`/`catch` anywhere in `lib` except in
`staticExpressionEvaluation.ts`.

```
mapping: CONSTRUCT { <ex://a> ?p ?o } WHERE { ?p <ex://src> ?o }
query:   SELECT * { <ex://b> <ex://p> ?o1 . <ex://b> <ex://q> ?o2 }
  ->  currently throws; must unfold to the empty solution multiset
```

### History — read this before writing anything

- `cfe54de` (2025-09-18) introduced the fallback in `mapPattern`; `8953421` (2025-09-29, "fix
  generation of empty results using FILTER(false)") gave it the right semantics:
  ```js
  const mappedPatterns = c.mappers.map((mapper) => {
    try {
      return rewriteSinglePattern(c, pattern, mapper);
    } catch {
      return createFilterFalse(c);
    }
  });
  ```
- `2552de3` "Refactor to PURE GAV and correct unfolding in accordance to theory (#21)" (2026-07-28)
  deleted it. **Collateral damage**: dropping the *per-mapper* fallback is right once there is one
  mapping per pattern, but the no-match case did not go away with it. That same commit's README
  addition names the intended replacement — step 6, "Prune invalid constraint groups, replacing them
  with filter false" — which was never built.
- **Prior art to lift**: the unmerged branch `origin/refactor/rewrite-to-BGP-level`, commit `26238d1`
  "perf+fix: reduce DFS overhead and harden error handling" (2026-04-15), already introduces a
  `RewriteNoMatchError` and converts every `ClusterSolver` throw site to it, precisely so that a
  `TypeError` is never silently turned into `FILTER(FALSE)`. That commit is **not** an ancestor of
  `main` — read it with `git show 26238d1` and reuse the design.

A pattern that cannot match a mapping is ordinary, not exceptional. With several mappings the merged
`?m_s ?m_p ?m_o` head turns the clash into a filter instead, which is why only the single-mapping
path — the one the head decision keeps alive — shows it.

### Work

Reinstate `RewriteNoMatchError` (every `ClusterSolver` throw that means "these cannot be unified"
becomes one) and catch **that type only** in `rewriteSinglePattern`, returning
`createFilterFalse(...)`. A bare `catch` would swallow genuine bugs — which is exactly what `26238d1`
was written to stop.

### Tests

The query above unfolds to `FILTER(FALSE)`; an unrelated error still propagates; an integration test
over a store where the mapping and the query disagree on a constant. Note that
`test/clusterSolver.test.ts` asserts `register` *throws* and keeps passing either way — which is why
this regression went unnoticed for a year, and why the new test must go through the rewriter.

---

# Phase 5 — Cardinality correctness

The unfolded query treats the virtual RDF 1.2 graph as a **bag**: two solutions of the mapping body
producing the same triple are counted twice, where the mapped graph is a set.

### Work

`unfoldingTransformation(mapping, { preserveCardinality: true })` wraps the mapping body in a
`DISTINCT` over the head's own variables — which is the set of constructed triples, the head being
injective in its variables. With several mappings the head is already the merged `?m_s ?m_p ?m_o`, so
the same `DISTINCT` also removes a triple two different mappings both produce.

Default `false`. Document, in one sentence, that it is **hugely costly** and why.

### Tests

- A mapping body whose solutions repeat a triple: counts differ with the flag off and agree with it on.
- An integration test comparing `COUNT(*)` on mapped data against the rewritten query, both ways.

---

# Phase 6 — Every query form

Measured: `ASK`, `CONSTRUCT` and `DESCRIBE` already come out correct, because the `uq_` renaming is
invisible in their results — `CONSTRUCT` carries `?uq_s ?uq_o` consistently through its template, and
`DESCRIBE ?uq_s` is sound because the sub-SELECT projects `?uq_s`. What is missing is the guarantee.

### Work

Make the peeling in `rewriteQuery` explicit per form rather than "whatever is not a `PROJECT` falls
through": reuse `solutionModifierChainOf` (`lib/utils/solutionModifierChain.ts`) to find the sealed
chain, and handle `SELECT` (rebuild the projection with the renaming EXTENDs, as today), `ASK`,
`CONSTRUCT` and `DESCRIBE` each by name, with an exhaustive `switch`. An update (`INSERT`/`DELETE`)
has its `WHERE` rewritten like any pattern and its templates only renamed: the RDF 1.2 graph they would
write to is virtual, so what they write goes to the RDF 1.1 source as written.

### Tests

Integration tests per form, comparing against the mapped data: `ASK` true and false, `CONSTRUCT` with
a template variable, `DESCRIBE ?x`, and each with `LIMIT`/`OFFSET` where the form allows it.

---

# Phase 7 — The default pipeline, and the nullify passes

Measured, on a query built to trigger it (two patterns pinning `?s` to `<ex://a>` and `<ex://b>`):
`nullifyJoinOverIncompatibleBounds` is **inert where it currently sits** and collapses the whole query
to `FILTER(FALSE)` only when it runs **after `removeProjections` and `pullUpExtends`** — it reads each
join operand's top-level `EXTEND` chain and its recursion halts at `PROJECT`, so binds still inside a
sub-SELECT are invisible to it. The optimisation is real and currently missed by everything.

### Work

1. `createDefaultTransformationPipeline(mapping, options?): QueryTransformation[]`:
   ```
   rewriteNonRecursivePathsTransformation()
   unfoldingTransformation(mapping, options)
   filterFalseTransformation()
   pushDownAssertionsTransformation()
   filterFalseTransformation()
   pullUpExtendsTransformation()
   filterFalseTransformation()
   removeProjectionsTransformation()
   nullifyJoinOverIncompatibleBoundsTransformation()
   filterFalseTransformation()
   ```
2. In `nullifyJoinOverIncompatibleBounds`: delete the `/^[mr]/u` branch — it predates
   `rewritePatternWithUniqueScope`, which renames mapping variables to `p0_mi_…`, so the regex matches
   nothing — and delete the unused `_restrictProjectUsingBindOrFilter`.
3. `nullifyUnbindableVars` stays exported and **out of** the default: its proof is a type-range one
   that nothing else can make, but nothing the unfolding generates has an empty range today. Say
   exactly that in its `@fileoverview`.
4. **`removeProjections` is not a workaround.** It is an optimisation that helps many engines and
   needs further study. Delete the `TODO: remove once comunica#1734 is merged` comment in
   `test/integration.test.ts` and any documentation repeating that claim.

### Tests

- Regression: the conflicting-constants query rewrites to `SELECT … { FILTER(FALSE) }`.
- The integration suite runs on `createDefaultTransformationPipeline` — verified to pass all 26.

---

# Phase 8 — The documentation

### Work

1. **`README.md`** becomes a package README, in the shape of the Traqula engine READMEs
   (`node_modules/@traqula/parser-sparql-1-2/README.md` is the model): title and badge, two or three
   sentences of what it does, **Installation**, **Import** (ESM and CJS), **Usage** (the pipeline
   example at the top of this document, and a second showing
   `createDefaultTransformationPipeline`), **Restrictions**, a compact API table, **License**.
2. **Restrictions** section, one line each: no `+` or `*` in the user query; no `GRAPH`; no unstable
   functions (`BNODE`, `RAND`, `UUID`, `STRUUID`) in a mapping body; no blank nodes in the RDF 1.1
   dataset unless skolemised; a mapping head holds exactly one triple (and
   `mappingFromConstructQueries` splits a larger template for you). Each says what happens when
   violated — an error from the precheck, or wrong answers.
3. **`ARCHITECTURE.md`** (new) takes the seven-step algorithm, `assets/schematic-plan.png`,
   `assets/query-rewritten.jpg`, the SPARQL-quirks notes and the "to check" list. The README links it
   once. Keep it tight: it is a map, not a paper.
4. Document `<internal://blank>` concisely: the IRI, that it yields the same blank node identity for
   the same inputs, and the two transformations that materialise it (`internalBnodeAsSpecialLiteral`,
   `internalBnodeAsSpecialIri`).
5. **Delete the stale claims**: the four skolem template types (`TemplateIri`, `TemplateLiteral`,
   `TemplateBlank`, `TemplateQuad`) no longer exist — `AlgebraTemplateFactory` was an empty subclass
   and Phase 2 removes it; `substituteVarsThatArePreBoundToTerms` in the API table is not an export.
6. `typedoc.json`: `"name": "Traqula"` becomes this package's name.
7. The AMW and SEMANTiCS paper links stay, in the README intro.

### Done

A reader who has never seen the repository can install it, write a pipeline, and know what they are
not allowed to ask of it — without reading a paper.

---

# Not in scope

- **Packaging.** `"private": "true"`, the package name, the version and `lsd:module` are left exactly
  as they are; publishing is a separate decision.
- **Named-graph semantics.** Phase 3 rejects `GRAPH`; deciding what unfolding inside one means is
  future work, noted in ARCHITECTURE.md.
- **Making `nullifyJoinOverIncompatibleBounds` see through `PROJECT`**, which would free it from
  depending on `removeProjections`. Worth doing; not now.
