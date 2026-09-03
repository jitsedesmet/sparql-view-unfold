# Agent task — `pullUpExtends`, one PR per phase

`report.md` is the design: it carries the *why*, the soundness arguments and the spec references, and
every `§n` below points into it. `task.md` is the original request.

**How to use this document.** Four phases, four PRs, one agent per PR, in order. Section
[A. Shared ground](#a-shared-ground), house rules (§A.6) and code style (§A.7) included, is read by every
agent; after that, an agent reads **only its own
phase section** and treats the later ones as non-existent. Every phase ends green on its own: it ships
its own tests and keeps every earlier phase's tests passing. Do not start a later phase inside an earlier
PR — if you find yourself needing something listed under a later phase, block the case and leave a
`TODO` naming the phase.

**Breaking changes are allowed.** There is no release yet, so nothing here is bound by semantic
versioning: rename, delete, re-sign or move anything — public exports included — whenever it makes the
API cleaner, the code simpler, or lets shared logic live in one place. §A.6 says what that obliges you
to do; it is a licence to improve the codebase, not to leave it inconsistent.

| PR | Phase | Status | Ships |
| --- | --- | --- | --- |
| 1 | [Phase 1](#phase-1--the-pass) | **shipped** | the pass itself: chain peeling, the two predicates, the congruent operations, `JOIN`/`LEFT_JOIN`/`MINUS`/`UNION`, the two syntactic drops. Deletes `pushUpBoundedFromUnion`. |
| 2 | [Phase 2](#phase-2--the-needed-analysis-and-general-dropping) | open | the top-down `needed` analysis, dropping anywhere, the `LEFT_JOIN` RHS drop, the `LEFT_JOIN` merge. |
| 3 | [Phase 3](#phase-3--transfer-and-weak-assertion) | open | transfer and weak assertion into a sibling, flag-gated, with the idempotence guard. |
| 4 | [Phase 4](#phase-4--edge-cases) | open | the `GROUP`-over-a-constant-key hoist, `EXISTS`, the `NAMED` allowlist, substituting a non-term `e`. |

**The goal in one line.** `pushDownAssertions` leaves a `BIND` behind at every leaf it rewrites
(`bindAssertedTerms`); this pass floats those binds back up the plan and drops the ones nothing reads,
without changing the solution multiset or the `pVars`/`cVars` of the node each move is anchored at.

```sparql
SELECT * { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }
-- must become
SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(<ex://a> AS ?x) }
```

# A. Shared ground

## A.1 Orientation — read these before writing anything

| File | What to take from it |
| --- | --- |
| `lib/transformations/pushDownAssertions.ts` | the mirror pass. Copy its shape: enter and leave through `withoutCpVars`, read licences off `CPMeta`, one `switch` over `Algebra.Types`, a file-level `@fileoverview` explaining the rules. Its `keepMetadata`/`PreOrderMappingReturn` machinery is pre-order only — you do **not** need it. |
| `lib/utils/certainlyBoundVars.ts` | `withCpVars`, `withoutCpVars`, `CPMeta { cVars, vRanges }`, `VRanges.neverBinds/canBind/rangeOf`, `termVars`. Its `EXTEND` case is the definition of *certain* (§1). Note `withCpVars` **mutates** the node it is handed, caching `metadata` on it. |
| `lib/utils/expressionHelpers.ts` | `isStableExpression` and `expressionsEqual` — the two predicates phase 1 put there, in place of the `isStaticExpression` it generalised — plus `splitConjunction`, `booleanConstantOf`, `sameTermExpression`. |
| `lib/utils/partialExpressionEvaluation.ts` | `substituteInExpression(c, expr, view, cVars)` and the `AssertionView` it takes (§A.4). |
| `lib/utils.ts` | `collectVariableNames(c.astTransformer, obj)` and `directExtensions`. (`deleteVarExtensionsInPlace` is gone: phase 1 deleted it with its only caller.) |
| `lib/transformations/removeProjections.ts` | the pattern for carrying information across `mapOperation`: a `Set`/`Map` keyed on the **original** node, since `transform` is handed `(copy, original)`. Phase 2 needs exactly this. |
| `lib/transformations/pullUpExtends.ts` | the pass itself, once phase 1 shipped: the traversal, the `Candidate`/`FloatingBinds` machinery every rule is written against, and the `@fileoverview` carrying the argument for each. |
| `lib/utils/extendChain.ts` | `peelExtends(c, op)` / `replantExtends(c, core, binds)` and the `ChainBind` they trade in. |
| `test/pushDownAssertions.test.ts` | the test harness to mirror: `createPartialContext()`, `parseQuery`, `c.generator.generate(toAst(...)).trim()`, and `toAlgebra(..., { quads: false })` for the `GRAPH` cases. |

## A.2 The invariant and the three side conditions

Every rewrite is one local swap, `Op1(Op2(…))` ⟶ `Op2(Op1(…))`, preserving the solution multiset,
`pVars` and `cVars` **at the node the swap is anchored at**. Below that node nothing is preserved and
nothing needs to be. Reaching the outer `PROJECT` is an outcome, not a goal.

For a bind `?x := e` on input `A` of node `op`, with `V = vars(e)` and the other inputs `B`:

- **(C1) no capture** — every other `B` satisfies `B.vRanges.neverBinds(?x)`, unless `B` carries an
  identical bind (merge), and `op` does not introduce `?x` itself (`GRAPH ?x`, an aggregate writing
  `?x`). Read the **ranges**, never the key set: `?x` merely being *in scope* in `B` is fine — what the
  spec leaves undefined is extending a μ that already **binds** `?x` (§2).
- **(C2) same inputs** — every `?y ∈ V` satisfies `A.cVars.has(?y) || every other B:
  B.vRanges.neverBinds(?y)`. Vacuous for a ground `e`, and vacuous for `UNION`/`MINUS`, which merge
  nothing.
- **(C3) readers** — what the node reads must not see `?x`, or must have `e` substituted into it (§A.4).

All three are read off `withCpVars(input).metadata` for the inputs **as they were handed to you**, chain
included, *before* any rewriting. On a single-input operation (C1)/(C2) hold vacuously and only the
readers decide.

## A.3 Order within a chain

A chain is peeled into an ordered list and decided as a unit. Risers end up above the node, stayers
below it, so a riser that stood **below** a stayer swaps with it. Two binds may only swap when neither
reads the other's variable:

- a **stayer** reading a riser's `?x`: substitute (§A.4) if `e` is a term expression, otherwise pin the
  riser (turn it into a stayer);
- a **riser** reading a stayer's `?y`: pin the riser, always — above the node it would read `?y` bound
  where below it read it unbound.

Pinning can create new violations, so iterate until the partition is stable. It terminates: pinning only
moves binds from *rise* to *stay*.

## A.4 Substituting `e` for `?x` in a reader

Only for a **term expression** `e`; for any other stable expression the hoist blocks instead (the cost
argument is §3). Call:

```ts
substituteInExpression(c, condition, {
  resolve: acc => acc.positions.length === 0 && acc.name === x ? term : undefined,
  bound: certain ? new Set([ x ]) : new Set(),
}, cVars);
```

Three things must be decided **before** that call, not by it:

- a reader containing `bound(?x)` where the bind is **not certain** (`?x ∉ cVars(Extend(A, ?x, e))`,
  which `withCpVars` already computes) blocks the hoist — the helper would emit the ungrammatical
  `bound(<ex://a>)`;
- a reader containing `EXISTS`/`NOT EXISTS` **and reading `?x`** blocks the hoist — the helper returns
  `EXISTENCE` untouched, and the pushdown carries the same `TODO`. One that does not read `?x` is no
  obstacle, `collectVariableNames` seeing into the nested pattern to say so;
- a bind that is *also leaving* and stood **below** this one may not write a variable of `V`. The reader
  stays where it is, so `e` has to mean down there what it meant up here, and a variable a departed bind
  used to supply is unbound at the reader's position. Phase 1 found this the hard way: it is the same
  fact that makes a stayer above a riser need the substitution at all (§A.3).

## A.5 Metadata and traversal discipline

- The pass is one post-order `algebraUtils.mapOperation` with a per-type `transform`: it works back up
  from the descendants, so by the time your callback sees a node, each input already carries at the top
  of itself everything it could float. That is the whole recursion — no custom traversal, no fixpoint
  loop over the tree.
- Enter and leave through `withoutCpVars`, exactly as `pushDownAssertions` does. Entering gives you a
  tree of your own to rewrite and a guarantee that what `withCpVars` reports describes the plan as it
  stands; leaving clears what the rewrites invalidated.
- Read metadata only off inputs as `mapOperation` hands them back, and **delete `metadata` on every node
  you build or mutate**. A stale `CPMeta` that survives a rewrite is the likeliest source of a subtle
  bug; §A.6 requires a test for it.

## A.6 House rules, inherited by every PR

- **Improve what you touch.** No release, no semantic versioning, so a breaking change is a normal
  outcome when it raises quality: delete a pass the new one subsumes, re-sign a function whose shape no
  longer fits, lift logic two passes now share into `lib/utils/`. `task.md` asks for exactly this —
  "a lot of code written for pushDown assertion can be reused here … feel free to optimize code for
  reuse" — so where the pull-up needs something `pushDownAssertions.ts` keeps private (its `licensed`
  predicate, its chain handling), the move is to extract it into a shared helper and have both call it,
  not to copy it.
- **What the licence obliges.** Breaking the *API* is free; breaking *query semantics* is not, and the
  invariant of §A.2 holds through every refactor. A rename or deletion is only done when every call site,
  `lib/index.ts` / `lib/transformations/index.ts`, the `@fileoverview` lists, the `README.md` tables and
  the tests move with it in the same PR. Leave no compatibility shim and no deprecated alias behind.
- `yarn test` green — the new tests and every existing suite. `yarn lint` clean. `yarn build` clean.
- TSDoc with `@param`/`@returns` on every export, and match the comment density of the files around you:
  this repo explains *why* in prose, not *what*. §A.7 says how much of it goes in the doc block.
- Every phase's test file must include the **scope invariant helper**: for each case, `withCpVars` of the
  output has the same `cVars` and the same `vRanges` key set at the root as `withCpVars` of the input.
- Every phase must keep **idempotence** (`pullUpExtends ∘ pullUpExtends = pullUpExtends`) and the
  **no-oscillation** check against `pushDownAssertions` green.

## A.7 Code style

House style, collected from review. `yarn lint` enforces none of it, so it is on the author.

**Naming.** Long, descriptive names for functions, variables, types and fields, over short ones that do
not say what the thing is. `settle`, `assemble`, `Candidate`, `below`, `group` are the kind to reject;
`settlePartition`, `assembleRewrittenNode`, `FloatingBind`, `scopeBelowBind`, `mustLeaveWith` are the kind
to write. This holds even where nearby older code is terser: match the *comment density* of the files
around you, not their abbreviations.

**Placement.** A function lives in the module most relevant to it, not in whichever file first needed it.
A generic predicate over an `Algebra.Expression` belongs in `lib/utils/expressionHelpers.ts` even when one
pass is its only caller today; a helper two passes have each grown privately belongs in `lib/utils/`.

**Doc comments.** A JSDoc block is **1-2 sentences** saying what the thing does, then `@param` for every
parameter and `@returns`. Not a multi-paragraph essay, however good the essay. The reasoning is not
deleted, it is relocated: a rule-specific argument becomes a comment in the *body*, directly above the
decision it justifies, and a pass-wide one belongs in the file's `@fileoverview`, which is a file header
rather than a symbol's JSDoc and stays as long as it needs to be. An `@example` earns its place where the
shape of the argument or the return is easier shown than said.

**Control flow.**

- Positive nesting over a guard that jumps: inside a loop body, prefer `if (ok) { … }` to
  `if (!ok) { continue; } …`. (An early `return` that skips *whole work* — a function that has nothing to
  do at all — is the different case, and is fine.)
- An `if`/`else` statement over a multi-line ternary, wherever the ternary would not fit on one line.
- Two sequential `if`s with the same body are one `if` with a compound condition.

**TypeScript.**

- No `!` non-null assertion. Test the value explicitly, even where the surrounding argument proves it
  cannot be `undefined`.
- No `any` beyond the `<'unsafe', T>` pattern the other passes use.
- Let inference do the work: a callback parameter whose type the signature already fixes is written
  bare, without a redundant annotation.
- A `switch` over a closed union is written **exhaustively, with no `default`**, so that a new member of
  the union becomes a compile error rather than a silent fall-through.

**Comments.** Short ones that name the intent, at the point of the decision, are welcome on top of the
prose — `// Needed for valid grammar`, `// List of equal groups for a var`. A comment has to state its
condition the right way round: one that reads as the opposite of the branch it sits on is a defect.

# Phase 1 — the pass

**Status: shipped.** What follows is what was built, with the three places the implementation departed
from the plan called out in place and marked *deviation*. The argument for each also lives in the
`@fileoverview` of `lib/transformations/pullUpExtends.ts`, which is the document to read next.

**Goal.** A working `pullUpExtends` that floats and drops binds by purely local, syntactic decisions.

**Prerequisite.** None.

### Files

**New** — `lib/utils/extendChain.ts`, `lib/transformations/pullUpExtends.ts`,
`test/pullUpExtends.test.ts`.

**Modified** — `lib/utils/expressionHelpers.ts` (the two predicates); `lib/utils.ts` (deleted
`deleteVarExtensionsInPlace`, whose only caller was the deleted pass — `directExtensions` stays,
`nullifyJoinOverIncompatibleBounds` still calls it); `lib/transformations/index.ts` (exports the new pass,
drops the old one, `@fileoverview` list updated); `test/integration.test.ts` (`standardTransformations`),
`test/rewriting.bench.ts` (**both** chains, not only `withPushdown` — its `standardTransformations` is
documented as "the chain the integration tests run", so the two have to move together) and
`test/eval.test.ts` (the evaluation cases below), all placing `pullUpExtends` in front of
`removeProjections`; `README.md`, which named `pushUpBoundedFromUnion` in the pipeline list and the API
table; `lib/utils/assertions.ts` and `test/rewriting.test.ts`, each carrying one comment naming a symbol
this PR renamed or deleted; `eslint.config.js`, which now ignores `task.md`, `report.md` and this file —
their code blocks are sketches, not sources `parserOptions.project` can type-check.

**Deleted** — `lib/transformations/pushUpBoundedFromUnion.ts`. It is a public export, so this is a
breaking change, which §A.6 licenses: its `UNION` rule becomes one row of the table below, and keeping
both would leave two passes hoisting the same binds by different rules.

### Work

**1. `lib/utils/extendChain.ts`**

```ts
/** One `BIND(expression AS variable)` lifted out of an EXTEND chain. */
export interface ChainBind {
  variable: RDF.Variable;
  expression: Algebra.Expression;
  /** `vars(e)`, cached: every licence reads it. */
  reads: Set<string>;
  /** The EXTEND this was read off, so a caller can ask what holds *where the bind is evaluated*. */
  node: Algebra.Extend;
}

export interface PeeledChain { core: Algebra.Operation; binds: ChainBind[] }

/** Splits the maximal EXTEND chain at the top of `op` off its core. Binds come back in **evaluation
 * order**: `binds[0]` is the innermost, the one closest to `core`. */
export function peelExtends(c: TransformContext, op: Algebra.Operation): PeeledChain;

/** The inverse: rebuilds `AF.createExtend` around `core`, `binds[0]` innermost. */
export function replantExtends(c: TransformContext, core: Algebra.Operation, binds: ChainBind[]): Algebra.Operation;
```

`peelExtends` stops at anything that is not `Algebra.Types.EXTEND`; `replantExtends(c, core, [])` is
`core`. Evaluation order is how every ordering argument in this document is written — do not flip it.

*Deviation.* Two signature changes against the sketch above, both to answer questions the licences turned
out to ask. `peelExtends` takes the context, since `reads` is `collectVariableNames`, which needs the
`astTransformer`. And a `ChainBind` carries the `extendNode` it came off, so that (C2) can be read at the
bind's own position rather than at the top of the chain: `?y ∈ cVars` of the whole input is *also*
satisfied by a bind further up the chain writing `?y`, which is precisely a `?y` this bind reads unbound.
`withCpVars(bind.node)` answers the certainty question of §A.4 for free at the same time.

**2. The two predicates, in `lib/utils/expressionHelpers.ts`** (three, in the end — see
`constructedTermOf` under the deviations)

- `isStableExpression(c, expression)` — `isStaticExpression` without its "no variables" clause: same
  `visitOperationSub` walk, same rejections for `named`/`existence`/`aggregate`/`wildcard`, same operator
  blocklist **minus `now`**, which is stable by §17.4.5.1 (§1). Allowlist exactly one `named`:
  `EXTENSION_FUNCTION_BNODE` from `lib/consts.ts`. `isStaticExpression` had no callers, so it was replaced
  rather than joined; anything wanting the old meaning is `isStableExpression(c, e) &&
  collectVariableNames(c.astTransformer, e).size === 0`.
- `expressionsEqual(a, b)` — structural equality over `Algebra.Expression` for the merge and `UNION`
  rules: recurse on `subType`, compare operators and names, compare terms with `.equals`, compare
  argument lists pairwise and in order, return `false` for `existence` rather than walking a pattern.
  The algebra ships no such helper (`Canonicalizer` only renames blank nodes), so this is ours.

**3. The pass**, `pullUpExtends<T extends Algebra.Operation>(c: TransformContext, op: T): T`. Per node,
in this order: peel every input; read the metadata (§A.2); classify each bind *rise* / *stay* / *drop*
by the table below; settle chain order (§A.3); rebuild the inputs with `replantExtends(c, core_i,
stayers_i)`; rebuild the node with its own edit (a struck `PROJECT` variable, a substituted condition or
ordering expression); replant the risers above it in their original relative order — across inputs,
order by input index then by chain order, and a merged bind is emitted exactly once; delete `metadata`
on everything you built or mutated.

**A fourth edit the sketch above misses**, and the one bug worth naming: a risen term has to be written
into the **chain-mates that stay below it**, not only into what the node itself reads. Without it
`BIND(:a AS ?x) BIND(CONCAT(STR(?x), …) AS ?y)` silently loses `?y` as soon as `?x` rises, `?x` being
unbound where `?y` is now computed. `rebindStayerAfterDepartures` does it, for every bind that left from
*below* the stayer — what left from above it wrote a variable the stayer read as unbound anyway. The same argument
adds one clause to §A.4: `e` may only be written into a reader when no bind that is also leaving, and
stood below this one, writes a variable of `V`.

### Rules

Gate 0 is stability: `isStableExpression(c, e)` or the bind stays. Then (C1), (C2), (C3) of §A.2, then:

| `Algebra.Types` | Phase-1 behaviour |
| --- | --- |
| `FILTER` | rise if the condition does not mention `?x`, or `e` is a term expression and substitutes in. A condition holding an `EXISTS` blocks only where it **reads** `?x` — see the deviation below the table. |
| `PROJECT` | `?x ∉ variables` → **drop**. Else rise when `V ⊆ variables`, striking `?x` from `variables`, so `pVars` at the swap is `(variables \ {?x}) ∪ {?x}` — unchanged — and the sub-`SELECT` carries no always-unbound column. The rise is blocked at the query's *own* projection — see the deviation below the table; the drop is not. |
| `GROUP` | **drop** when `?x` is neither a key, nor an aggregate's `variable`, nor read by any aggregate's `expression`. Otherwise a barrier. `aggregates` are `BoundAggregate`s: an `expression` over the input *beside* the `variable` they write — check both. |
| `DISTINCT`, `REDUCED` | rise, unconditionally. |
| `ORDER_BY` | rise; expressions must not mention `?x`, or substitute (§A.4). A comparator that decides no ordering is then dropped, and the operation with it when none are left — see the deviations. |
| `SLICE` | rise, unconditionally. |
| `FROM` | rise. |
| `GRAPH ?g` | rise when `?x ≠ ?g` and (`?g ∉ V` or `?g ∈ A.cVars`). A bind that *writes* `?g` is a barrier here and an assertion in phase 4 — see its list. |
| `JOIN` | rise under (C1)+(C2), or under the merge rule below. Cost gate applies. |
| `LEFT_JOIN` LHS | rise when `R.vRanges.neverBinds(?x)` and (C2) holds; the condition is treated exactly like a `FILTER`. Cost gate applies. The "or `R` carries the identical bind" half is the `LEFT_JOIN` merge, which [phase 2](#phase-2--the-needed-analysis-and-general-dropping) explicitly ships; phase 1 leaves a `TODO(phase 2)` at the site. |
| `LEFT_JOIN` RHS | never rise, and no drop in this phase — the RHS bindings *are* visible above, so dropping one needs phase 2. |
| `MINUS` LHS | rise when `R.vRanges.neverBinds(?x)`. (C2) is vacuous. |
| `MINUS` RHS | never rise, and no drop in this phase — the drop is licensed by `L.vRanges.neverBinds(?x)` alone, but it ships with the other RHS drops in phase 2. |
| `UNION` | rise **only when every branch's chain carries the same bind**: same `?x`, `expressionsEqual` expressions, stable. Remove it from every branch and emit one above; the §A.3 order check has to pass in *every* branch. No (C2) obligation. Subsumes `pushUpBoundedFromUnion`. |
| `SERVICE` | barrier. Add `// TODO(future): a non-SILENT service could release a bind` — `SILENT` turns endpoint failure into one empty solution, where a hoisted bind would still bind `?x`. |
| `EXTEND` | nothing to do: a chain is one unit, handled by its parent. |
| `BGP`, `PATH`, `VALUES`, the rest | leaves / barriers, no callback needed. |

**Merge (`JOIN`).** Let `S` be the operands whose chain carries a structurally equal, stable `?x := e`.
If `V ⊆ O.cVars` for **every** `O ∈ S`, the copies are provably one value and all but one are redundant.
Where the survivor goes is the cost question below. Do not merge when some carrier does not have all of
`V` certainly bound.

**Cost gate.** Past a `JOIN` or `LEFT_JOIN`, only a term construction rises — see the deviations for why
`|S| ≥ 2` is *not* the exception an earlier draft made it. A merged non-term instead has its duplicates
deleted with the survivor left in place, which is the saving without the bet. Every other row is
cardinality-non-increasing, so no gate there.

### Deviations

**Nothing rises into the query's solution-modifier chain.** The `PROJECT` rise, applied at the query's own
projection, produces `Extend(Project(…))`: legal algebra that `toAst` cannot render, since SPARQL has
nowhere to write a `BIND` above a `SELECT` or between it and its `LIMIT`. So the pass walks the chain of
`ASK`/`CONSTRUCT`/`DESCRIBE`/`PROJECT`/`DISTINCT`/`REDUCED`/`SLICE`/`FROM` at the top of what it is handed
and blocks rises out of those nodes — **drops still fire**, which is what keeps the main drop site working.
An `ORDER_BY` is deliberately *not* on that list: it stands below the projection, so the gap a bind rises
into there is the one a `SELECT` expression is written in, and a query's chain holds no further modifier
below its ordering, so stopping the walk there loses nothing. That is what lets a bind an ordering no
longer reads reach the projection that discards it. Nothing is lost by it: a hoist past the outermost projection has nothing above it to rise
to, and the report says as much ("pointless at the root"). Nothing is lost in the pipeline either,
`queryTransform` stripping that projection before any transformation runs. A sub-`SELECT` is unaffected,
except in the degenerate `{ { SELECT … } }` where its `PROJECT` is *itself* on the chain.

**An `EXISTS` blocks only where it is read.** The table above makes any condition holding one a barrier,
with the relaxation deferred to phase 4. It came for free instead: `collectVariableNames` sees into the
nested pattern, so "does this reader read `?x`" already answers *no* for a `FILTER(EXISTS { … })` that
never mentions `?x` — and a hoist past one changes nothing about how it is evaluated. Making it a full
barrier would have taken extra code to be strictly worse. What stays forbidden, and keeps its
`TODO(phase 4)`, is *writing* a term into an `EXISTS`: an unbound `?x` in a nested pattern is a variable
matching anything, where the term replacing it matches one thing. Phase 4 keeps the rest of its `EXISTS`
item; only the `FILTER` half of it is already done.

**The merge is not exempt from the cost gate.** The plan lets a non-term expression rise past a `JOIN`
when `|S| ≥ 2`, because the merge "deletes an evaluation outright". It does not: hoisting a merged bind
costs `|A ⋈ B|` evaluations against the `|A| + |B|` the two copies cost, which is a win on a selective
join and a rout on one that fans out — two operands of a thousand rows sharing one `?s` join to a
million, so 2 000 evaluations become 1 000 000. That is the same bet the single-carrier hoist makes, on a
larger budget, and the policy is not to take it. So the gate is now *only* about what the expression
costs: a term construction rises, anything else does not. What the merge still does for a non-term is
delete the duplicates and leave the survivor where it stands — `|A|` evaluations rather than `|A| + |B|`,
better whatever the join does, and needing no (C1) since nothing is re-planted above the join.

**One construction, two spellings.** The parser keeps `<<( s p o )>>` and `TRIPLE(s, p, o)` apart — the
first is a term expression holding a Quad, the second an operator expression — and `constantFoldOperator`
only merges them when all three arguments are *ground*. Every rule that asks "is this a term expression"
was therefore answering a question about spelling rather than about the construction, giving the two
different licences. `constructedTermOf(expression)` in `expressionHelpers.ts` is the fold with variables
left in, and the rules read through it: the cost gates on `JOIN`/`LEFT_JOIN`, the substitution gate, and
the `EXTEND` case of `withCpVars`, which decides certainty and so is shared with the pushdown. A
`TRIPLE()` no `<<( … )>>` could spell — a ground component the position cannot hold — is not folded: it
raises, and there is no term to write.

**A reader may take a *position* of the construction.** `AssertionView.resolve` is handed an `Access`,
which is a variable plus a chain of positions, so `SUBJECT(?x)` over `BIND(<<( ?s ?p ?o )>> AS ?x)`
resolves to `?s` rather than to an accessor over a triple term the engine has to build first. Only where
the bind is *certain*: `SUBJECT(?x)` of an unbound `?x` is an error, where the component it would be
replaced by is an ordinary value, so a construction that can fail has the whole term written in instead.

**An `ORDER_BY` cleans what it no longer needs.** Not in the plan, and it belongs here rather than in a
general simplification pass because it is the pull-up's own substitution that creates the opportunity: a
comparator over a risen `?x` becomes the term `?x` was reading, and a comparator with one value across the
whole sequence compares equal on every pair, so removing it leaves the ordering relation exactly as it was
— ties included, which is what a `SLICE` above would be reading. When none are left the `ORDER_BY` goes
too, which is sound because it only *permutes* a sequence
([the definition of `OrderBy`](https://www.w3.org/TR/sparql12-query/#defn_algOrderBy)) and so leaves the
same multiset with
the same scope. `cleanStaticFromOrder` reads the constant variables off the chain below it, which is why
`ORDER BY ?s ?x ?o` over `BIND(:a AS ?x)` loses its middle comparator without `?x` having to move at all.
The rewrites then cascade: a comparator that goes is one fewer reader of `?x`, so the bind rises past the
ordering, and the projection above — which never asked for `?x` — drops it. `SELECT ?s ?p ?o { ?s ?p ?o .
BIND(:a AS ?x) } ORDER BY ?s ?x ?o` comes out as `SELECT ?s ?p ?o { ?s ?p ?o } ORDER BY ?s ?o`, bind and
all, in one post-order pass.

**Nothing rises above the query's own projection, and an `ORDER_BY` is not one of those.** An `EXTEND`
between a `PROJECT` and its `ORDER_BY` is where SPARQL writes a `SELECT` expression — the conversion adds
those before it wraps the `OrderBy` ([§18.3.4.4](https://www.w3.org/TR/sparql12-query/#selExpr) precedes
[§18.3.5](https://www.w3.org/TR/sparql12-query/#convertSolMod), whose own list of modifiers has no step
for them) — so a bind may rise past an ordering and reach the projection that discards it. A consequence
worth knowing when reading a test: `toAst` prints an `EXTEND` in that chain as a `SELECT` expression
either way, so an expected output showing a `BIND` in the select list is not evidence that the bind moved.
`test/eval.test.ts` carries two order-preserving cases, since neither a sorted comparison nor a string
comparison can see an ordering change.

### Tests — `test/pullUpExtends.test.ts`

1. One case per row of the table, positive.
2. Negative: a sibling with `?x` in scope carrying a *different* expression; a `UNION` branch that does
   not carry the bind; `BIND(RAND() AS ?x)` staying put; a `FILTER` reading a computed (non-term) `?x`;
   a `FILTER` whose `EXISTS` reads `?x` (the one that does *not* read it is a **positive** case, see the
   deviations); a chain whose outer bind stays and reads the inner one that would otherwise rise (§A.3);
   a `GROUP` whose aggregate *expression* reads a bind that is neither key nor target; a join whose
   carriers share `?x` over a `?y ∈ V` not certain on both sides, which must **not** merge; a `bound(?x)`
   over an *uncertain* bind, which blocks where a certain one folds to `TRUE`.
3. Merge, both `|S| = 1` and `|S| = 2`.
4. The three checks of §A.6: scope invariant on every case, idempotence, no oscillation against
   `pushDownAssertions`.
5. Unit tests for `isStableExpression` (`now` stable; `rand`/`uuid`/`struuid`/`bnode` not; the one
   allowlisted `named`; `existence` rejected) and for `expressionsEqual`.
6. Evaluation tests in `test/eval.test.ts` over `OPTIONAL`, `MINUS`, `UNION` and a sub-`SELECT`: a wrong
   `cVars` changes what `SELECT *` returns without any string comparison noticing.

What shipped: 60 cases in `test/pullUpExtends.test.ts` and 5 in `test/eval.test.ts`. The three checks of
§A.6 are folded into the `expectTransform` helper rather than written per case, so every string
comparison also asserts the scope invariant, idempotence, and that no `CPMeta` survived the rewrite; the
oscillation check and "leaves the input tree untouched" stand on their own under *discipline*. Two rules
cannot be reached from a parsed query, and are tested against a hand-built algebra or not at all: `FROM`,
which SPARQL admits only at the top of a query, where the modifier chain now seals it — a sub-`SELECT`
keeps every other modifier row reachable — and the §A.3 rule pinning a riser that reads a *stayer above
it*, which §10.1 of the spec forbids writing in the first place.

### Done

House rules (§A.6) — `yarn test`, `yarn lint`, `yarn build` and `yarn doc:check` all green — plus:
`pushUpBoundedFromUnion` gone from `lib/`, from `lib/transformations/index.ts` and from `README.md`, its
`UNION` behaviour covered by a `pullUpExtends` test; the worked example at the top of this document
transforms exactly as written.

# Phase 2 — the `needed` analysis and general dropping

**Goal.** Drop a bind wherever nothing above reads its variable, not only when it has floated to be a
direct child of a `PROJECT` or `GROUP`. This is what catches `OPTIONAL { … BIND(:a AS ?x) }` under a
projection that never wanted `?x`, which phase 1 misses (§5).

**Prerequisite.** Phase 1, which is shipped.

### Files

**New** — `lib/utils/neededVars.ts`. **Modified** — `lib/transformations/pullUpExtends.ts`,
`test/pullUpExtends.test.ts`.

### Work

**1. The analysis.** A top-down walk, run once over the tree the pass already owns (after
`withoutCpVars`), returning what each node's *output* is read for:

```
needed(root)  = every variable in pVars(root), unless the caller says otherwise
needed(child) = needed(op) ∪ variablesRead(op) ∪ ⋃ { pVars(sibling) : op is join/leftJoin/minus }
```

This is the paper's projection pushing (§III) read as an analysis rather than as a rewrite — (PJPush)
and (PLPush) push `S ∪ (pVars(A₁) ∩ pVars(A₂))` into both operands, (PMPush) that intersection into the
right of a `MINUS` — because a variable bound in one operand silently acts as a join key with the other,
and because `MINUS`' disjointness test reads the *domain*, not the values.

`variablesRead(op)` must cover **every** expression the node owns: a `FILTER` condition, an `EXTEND`
expression, `ORDER_BY` expressions, the `LEFT_JOIN` condition, a `GRAPH`/`SERVICE` name, `PROJECT`
variables, and for a `GROUP` both its keys **and** every aggregate's `expression`. Missing one silently
deletes a bind that is read.

```ts
export function neededVariables(
  c: TransformContext, op: Algebra.Operation, atRoot?: Iterable<string>,
): Map<Algebra.Operation, Set<string>>;
```

Key the map on node **identity** in the tree you then traverse, and look it up in the pass with the
`original` argument `mapOperation` hands the `transform` — the pattern `removeProjections` already uses
with `keptProjections`. Do not stash the result on `metadata`.

**2. Options.** Introduce the options object here, so phase 3 only adds a field:

```ts
export interface PullUpOptions {
  /** What the caller will project; everything stays in scope when omitted. */
  projected?: Iterable<string>;
}
export function pullUpExtends<T extends Algebra.Operation>(c: TransformContext, op: T, options?: PullUpOptions): T;
```

`queryTransform` strips the query's outer `PROJECT` before running any transformation and re-adds it
afterwards, so without `projected` a bind that floats to the root is always re-planted, never dropped.
Passing the list closes that (§5); the default must keep phase 1's behaviour exactly. If threading the
list out of `queryTransform` reads better than binding it in a closure at the call site, change
`queryTransform` — §A.6 licenses the signature change, as long as every caller and the README move with
it.

**3. Dropping.** A floating bind with `?x ∉ needed(node)` is dropped wherever it stands, including the
`LEFT_JOIN` RHS. The phase-1 `PROJECT`/`GROUP` drops become special cases of it — keep them working, and
prefer deleting their bespoke code once the general rule covers them. Note that a drop is sound for an
*unstable* `e` too, `Extend` being one row in and one row out whatever it computes; phase 1 gated it with
everything else for uniformity and left a comment saying so, and the general rule is the place to lift
that gate. The `MINUS` RHS drop belongs here
too, but is licensed by `L.vRanges.neverBinds(?x)` rather than by `needed`: `pVars(Minus) = pVars(L)`, so
nothing above can read the variable and the compatibility and disjointness tests are its only readers.

**4. The `LEFT_JOIN` merge.** Extend phase 1's merge rule to a `LEFT_JOIN` whose two sides carry the
identical stable bind, under `V ⊆ cVars(L) ∩ cVars(R)`. Phase 1 left the `TODO(phase 2)` for it on
`floatThroughLeftJoin`, and the machinery is already there: `groupIdenticalBinds` and `letGroupLeave` are
what `floatThroughJoin` merges with, and neither is specific to a `JOIN`. The anti-join half computes `e` on
`μ_L` either way, but it deserves a second look: write the test for an unmatched left row first.

### Tests

- `SELECT ?a { ?a :p ?b OPTIONAL { ?b :q ?c . BIND(:v AS ?x) } }` — the bind is dropped, and `?x` is gone
  from the output.
- Kept because a sibling's `pVars` needs it as a join key; kept because an `ORDER BY`, a `FILTER`, or an
  **aggregate expression** reads it; kept at the root when `projected` is not passed; dropped at the root
  when it is.
- `LEFT_JOIN` merge, positive and negative (a case where only one side has `V` certain).
- The three checks of §A.6, and every phase-1 test still green with default options.

# Phase 3 — transfer and weak assertion

**Goal.** Two moves for the case phase 1 gives up on: a `JOIN` sibling `B` has `?x` in scope and does
not carry the identical bind (§6). Phase 1 covers it with `nothingElseBindsTheVariable`, which simply
pins the bind.

**Prerequisite.** Phases 1–2.

### Work

Add `transferIntoSiblings?: boolean` to `PullUpOptions`, **default `false`**. Nothing changes for
existing callers, and the pipeline of §7 stays as it is.

- **Transfer (strong).** If `?x ∈ B.cVars`, `B` supplies `?x` on every solution and join compatibility
  already forces it to equal `e`: `Join(Extend(A, ?x, e), B) ≡ Join(A, σ_{?x ≡ e}(B))`. The `EXTEND` is
  **deleted**, not moved. Ground `e` only.
- **Weak assertion.** If `?x ∈ B.vRanges` but `?x ∉ B.cVars`, the bind can neither move nor be deleted,
  but `W⟨?x ≡ e⟩` — `¬bound(?x) ∨ sameTerm(?x, c)` — holds of every solution of `B` that reaches the
  join, so it may be asserted into `B` while the bind stays where it is.

Build both with the existing conjunction API rather than by hand:
`AssertionConjunction.of([])`, then `assertTerm(?x, term, /* strong */ true | false)` (it returns `false`
on a contradiction, which means the operand is empty), then `c.AF.createFilter(B, conjunction.toExpression(c))`.

**The guard.** Both emit filters that `pushDownAssertions` will push down and re-materialise as `EXTEND`s
at `B`'s leaves, which this pass then picks up again. The strong transfer is monotone — it strictly
decreases the `EXTEND` count. The weak assertion is not: it would re-emit the same filter forever. Before
emitting one, read `B`'s top filter chain with `collectAssertions` **out of the condition** — the
`metadata.assertions` tag `assertionFilter` writes does not survive `pushDownAssertions`, which strips
every `metadata` on the way out — and skip when the assertion is already there.

### Tests

- Transfer: the `EXTEND` disappears and `B` carries `FILTER(sameTerm(?x, :c))`; the result of the query
  is unchanged (evaluation test).
- Weak: `B` carries `FILTER(!bound(?x) || sameTerm(?x, :c))` and the bind stays.
- **Termination**, the headline test: iterate `pullUpExtends ∘ pushDownAssertions` five times over a
  query that triggers each move and assert the output stabilises by the second iteration.
- The guard in isolation: running the pass twice over a plan that already carries the weak assertion adds
  nothing.
- Flag off by default: every phase-1 and phase-2 test unchanged.

# Phase 4 — edge cases

**Goal.** The four deferrals, independent of each other. One PR, one commit each.

**Prerequisite.** Phases 1–3 (only the fourth item needs phase 2).

- **`GROUP` over a constant key.** A bind of a *ground term* to a grouping key may rise as
  `Group(A, keys \ {?x}, aggs)`. Blocked when `keys = {?x}`: over an empty input a keyless `GROUP` yields
  one group where `GROUP BY ?x` yields none. Test both, including the empty-input case.
- **`EXISTS`.** Give `ExpressionTypes.EXISTENCE` a reads-set — `collectVariableNames` over the nested
  pattern — so (C2) can be decided for `BIND(EXISTS { … } AS ?x)`, and block such a bind from rising past
  `GRAPH`, `FROM` and `SERVICE`, which change the active graph the nested pattern is evaluated against.
  The `FILTER` half of this item is **already done**: phase 1 allows a hoist past a `FILTER` whose
  `EXISTS` does not read `?x`, and substituting into one stays forbidden (see phase 1's deviations). What
  is left is the bind *holding* an `EXISTS`, which `isStableExpression` still rejects outright. Remove the
  two `TODO(phase 4)` markers phase 1 left — one on `isStableExpression`, one on
  `readerAdmitsSubstitution`.
- **`NAMED` allowlist.** Generalise phase 1's `stableNamedFunctions` set, which holds only
  `EXTENSION_FUNCTION_BNODE`, into a documented
  set of extension functions declared stable, with a test that an unlisted one blocks.
- **A bind of the graph variable selects that graph.** `GRAPH ?g { P . BIND(:a AS ?g) }` reads as a
  barrier in phase 1, on (C1) with the `GRAPH` itself as the other binder — but `?g` is unbound *inside*
  the pattern, so the join with `{?g ↦ u}` that a `GRAPH` ends with keeps only the graph named `:a`:
  `Graph(?g, Extend(P, ?g, :a)) ≡ Extend(Graph(:a, P), ?g, :a)`. Both sides are
  `{ μ + {?g ↦ :a} : μ ∈ ⟦P⟧_{G_:a} }`, and an `:a` the dataset does not name gives the empty multiset
  either way. Worth having: it turns a scan of every named graph into one graph, and the bind rises after
  it. Ground `e` only, and only where `P` does not itself bind `?g`. The mirror of `pushIntoGraph`'s rule
  in `pushDownAssertions`, which already selects the single graph from an assertion — this is reading the
  bind *as* that assertion.
- **Substituting a non-term `e`.** Where `?x` occurs exactly once in the reader and is dead above
  (phase 2's `needed`), substituting is break-even and deletes a node. Gate it on both conditions, and
  test that two occurrences still block. The arithmetic, which phase 1 wrote onto
  `readerAdmitsSubstitution`: with `k` occurrences, substituting costs `k` evaluations in the reader plus
  one in the re-planted bind, against the `1` it costs now — so no `k` pays while the bind is re-planted,
  `k = 1` breaks even once the bind can be *dropped* instead, and `k ≥ 2` would need a cost model calling
  `e` cheap, which is the cardinality estimation §4 of the report defers.

Each item ships with the three checks of §A.6.
