# Inconsistencies, code quality and optimization notes

Findings from reviewing the code on `main` after the triple-term pushdown work (`b52ae3f..22fee37`),
collected while condensing the documentation.

**Status:** every item below has been worked. Each was independently confirmed against the code before
being changed, and each fix is one commit on `docs/condense-jsdoc`. One item (4.6) was measured and
**rejected** - its premise did not hold. Section 6 records findings that came *out* of that work and are
not yet fixed.

Verified at `3c4f4cf`: `yarn test` 403 passed / 1 skipped / no type errors, `yarn lint` clean,
`yarn doc:check` 0 errors, `yarn build` succeeds.

## 1. Correctness / soundness hazards

### 1.3 `AssertionConjunction.of` ignores the result of `assert` - fixed, `bbbccf3`

Confirmed. Two of the eight callers hand `of` a genuine subset; the other six (via `placeOverTargets`,
`admissibleOnMinusRhs`) hand it weakened and `entailedByReading` conjuncts, so the comment's subset
argument did not cover them. A contradiction is still unreachable - everything passed is *entailed* by
one satisfiable Θ - but nothing checked. `of` now throws on a `false` from `assert`, matching
`rootVarOfBare`; the precondition is restated in the JSDoc.

### 1.4 A weak assertion with an access target is silently dropped - fixed, `2844319`

Confirmed, and unreachable today as described (`asWeakAssertion` requires a ground term,
`asWeakenedConjunct` returns `undefined` for edges). Now throws.

The "Related" suggestion was **wrong as written** and was not implemented as stated: the
"weak ⇔ pinned group" invariant is false - a weak *termType* assertion narrows a group's range without
ever pinning it, so that check would fire immediately. What `get` actually depends on is one step
weaker - a weak member is *alone* in its group - and that does hold: the only route into a shared group
is `assertUnify`, which marks both sides strong first. That is what is now asserted, on the `adopt` path
of `assertWeakly`.

### 1.5 Ignored booleans - fixed, `79f6053`

Confirmed: `split` really does guarantee the conjunction cannot mention `graphVar`, so `false` is
unreachable - but the conjunction is then pushed into the pattern, so a `false` would propagate the
unreadable state. Now guarded and throws.

Despite the plural heading, this was the only instance in the file. The other bare calls are an `every`
callback whose `false` is the intended answer (`rowSatisfies`), and `Map.set`/`Set.add`, which return
the collection rather than a success flag.

## 2. Naming and API inconsistencies

### 2.1 `RangeSet.disjunct` computes the *conjunction* - fixed, `8f2d390`

Confirmed; renamed to **`meet`** rather than `intersect`, because `RangeSet.ts` is the file that
establishes the lattice vocabulary (`objectRange` is "the *top*", `emptyRange` "the *bottom*") and the
consumers already speak it (`meetShapes`, `meetTermPins`, `PinMeet`). 7 call sites across 6 files.
See 6.1 for the same defect in another class.

### 2.2 The package's public API does not include its entry points - fixed, `df6979c`

Confirmed by importing the built `dist/esm/lib/index.js`: the three entry points were genuinely
unreachable. Fixed by widening the surface. `lib/index.ts` now also exports `operationTransform`,
`queryTransform`, `createPartialContext`, `transformContextFromConstructs`, and the types needed to
*name* those signatures (`TransformContext`, `Mapping`, `MappingHead`). `lib/transformations/index.ts`
gained the four missing modules. No collisions. `parseQuery`/`prefixVarsInOperation` stay internal.
The fileoverview `@example` went back to a package-root import.

### 2.3 Stale symbol references in documentation - fixed, `3f05a92`

The three named links were already gone. The preventative check is now in place: `yarn doc:check`
(`typedoc --emit none`) with `validation.invalidLink` and `treatValidationWarningsAsErrors`.

Enabling it surfaced **8 more** unresolvable links the documentation pass had missed, all the same
failure mode - a `{@link X}` naming a symbol the file does not import. All fixed, mostly by qualifying
the target (`{@link utils/certainlyBoundVars!VRanges}`); `splitClique` is module-private, so no link
syntax can reach it and it became a code span.

Two things worth knowing about the check. `yarn doc` was **already broken** before this - `typedoc.json`
pointed `entryPoints` at `engines/*` and `packages/*`, leftovers from the upstream Traqula monorepo that
do not exist here, and `typedoc` exited non-zero with "Failed to find any packages". It now builds.
And the coverage is 92%, measured: **111 of 121 links are validated**. The blind spot is doc comments on
module-private top-level declarations, which have no doc page to attach a link to - had the original
`completePatternRewrite` typo been on a private helper, this check would not have caught it.

### 2.4 `'uq'` prefix test is one character short - fixed, `529d644`

The code defect is confirmed, but **the stated symptom is backwards and unreachable**:

- `queryTransform` prefixes *every* user variable with `uq_` before any rewriting, so a user's `?uqx`
  arrives as `?uq_uqx`. Verified empirically: `?uqx` and `?x` rewrite to byte-identical output. The
  latent defect is reachable only through the exported `operationTransform`/`rewriteSinglePattern`,
  which take already-prefixed algebra by contract.
- `mappingVarsOf` *filters out* names starting with `uq`, so a bare `uqx` was treated as a **user query**
  variable, not as a mapping one. The fix moves it into the mapping set - the opposite of the prediction.

Prefixes are now `VAR_PREFIX_USER_QUERY` / `VAR_PREFIX_MAPPING` / `VAR_PREFIX_MERGED_HEAD` in
`consts.ts`, and classification goes through one `isUserQueryVar` predicate.

`sortClusters` **is** load-bearing - `collectTriplePatternBinds` takes `cluster.vars.at(0)` as the
mapping variable and emits a BIND naming it, so a user variable sorting first would name a variable the
subselect does not project. It now sorts on an explicit rank from the same predicate, with the name
comparison only as a tiebreaker. Two regression tests, both verified to fail against the old code.

### 2.5 `ClusterSolver.migrateGroupData` does not call `super` - fixed, `79ff057`

Confirmed; `super` call added first, matching the sibling override. Ordering is not behaviourally
load-bearing (the solver's step touches only `groupToExpressions`, which no ancestor writes), but
super-first matches the inner-to-outer order the hook already lives in. Every other extension hook in the
hierarchy already chains correctly. The contract is now stated on the base method. See 6.2.

### 2.6 Unused `TransformContext` parameters - fixed, `83386ae`

Confirmed - `c` is unused directly and transitively in both. **Dropped the parameter** rather than
routing through `c.astTransformer`, because that route is not faithful: both functions deliberately walk
only the top EXTEND spine and stop at the first non-`extend` node (that early stop *is* the semantics of
"direct" extensions), while `transformObject`/`visitObject` traverse the whole tree;
`deleteVarExtensionsInPlace` also mutates in place and must return a new root. It would have been a
behaviour change dressed as a refactor.

5 call sites, not 3. Dropping `c` also left it dead in three private helpers in
`nullifyJoinOverIncompatibleBounds.ts` that only threaded it onward; those were cleaned up too, rather
than recreating the same smell one level up.

### 2.7 `createJoin` flatten flag is inconsistent - fixed, `9162e80`

Both halves real. The flatten default is **`true`** (`createJoin(input, flatten = true)`), so the
omission was purely stylistic - and `true` is also what the site wants, since `mergeBGPsOfJoin` only ever
sees an already-flat join. Made explicit. The slice was correct for the reason given; the loop now tracks
the insertion point in the array it indexes, so the coincidence is no longer load-bearing.

(Minor correction: the review implies other bare calls exist. The call at line 622 does pass `false`,
just on its closing line. This was the only one.)

## 3. Open questions left in the code

Not addressed - these are design questions, not defects. Left as-is, deliberately.

- `AssertionConjunction.intoPattern`'s `TODO` about whether `asWritten` is needed (the D6 question from
  `task-for-agent.md`).
- `pushIntoLeftJoin`: the substitution in the filter might reveal more information.
- `ClusterSolver.register` / `registerExpressionToGroup`: deciding statically whether an expression can
  produce a term.
- `substituteInExpression`: assertions never propagate into an `EXISTS` pattern.
- `RangeSet.serviceNameRange` is documented as an assumption rather than something a spec states.

## 4. Runtime optimizations

Every item was benchmarked before and after, and every data-structure change was validated by running the
old and new implementations side by side and asserting agreement - across the test suite *and* a seeded
fuzz, because the suite's conjunctions turned out to be far too small to exercise these paths.

### 4.1 `TermClusterSet.hasCycle()` runs after every single constraint - fixed, `485e35a`

Confirmed, and worse than described: the roots were *every* live group, and the check was 93-99% of the
total time on conjunctions of 1000-2000 assertions, growing quadratically.

Only the second shortcut was implemented. "Skip when no group carries a triple pin" is sound (child edges
exist only under a `triple` pin) but needs its own index and buys nothing when triple terms *are*
present - the touched-groups shortcut subsumes it.

Soundness of the touched-groups DFS: a cycle in the graph after a run that contains no group the run
pinned or merged uses only unchanged edges, so it existed before - contradiction with acyclicity on
entry. The entry invariant is not free, though: a run that gives up early on a contradiction never
reaches the check and can leave a cycle behind. So an `acyclic` flag now tracks it, and the check falls
back to rooting at every group when it is false - making the fast path equivalent in *all* states, not
only reachable ones.

Validated: 1009 comparisons across the suite (all of which took the shortcut), plus 22 632 in a fuzz that
deliberately kept using contradicted sets - 6752 of those exercising the fallback, 2011 real cycles,
0 disagreements. Result: quadratic → linear, 21× to 540× at n=2000.

### 4.2 `TermClusterSet.isPinChild` is a linear scan per removal - fixed, `66f5764`

Confirmed. `groupToPin` has a key for *every* group ever created, not just pinned ones, so the scan was
over all live groups, allocating an object and up to three `resolveGroup` walks each.

The item's "maintained in `place` and `unite`" list was incomplete - the load-bearing site is
**`migrateGroupData`**, because the index is keyed by *resolved* group and `unite` writes the merge
history before calling it. Full list: `place`, `unite`, `migrateGroupData`, `dropGroup`, `clear`,
`copyInto` (deep, since the values are Sets). The index is deliberately an over-approximation - lookups
verify each candidate against the actual pin - so maintenance only owes it never to *lose* an owner.

Validated: the suite only makes 40 such calls, so the fuzz is what matters - 4000 seeds × 150 steps,
comparing indexed vs. scan for every group after every step: **18 991 055 comparisons, 0 disagreements**.
Result: linear → constant, 24× to 215× on removal.

### 4.3 `AssertionConjunction` recomputes its decomposition - fixed, `7e56755`, then reverted, `3e3e032`

Confirmed by counting: 1056 `readingsPerGroup` calls across the suite = 752 `conjuncts` + 235
`patternValues` + 69 `equatedReadings`, i.e. every one runs its own BFS. 33% are on a conjunction whose
state has not changed since the previous walk.

`conjuncts()` was **not** cached, against the item's advice - measured hit rate was 0/1560 on the
benchmark and 57/695 (7.6%, an upper bound) across the relevant tests, because every `of`/`split`/
residual hands it a fresh object. It would have added the whole `strength`/`bound`/`unbound` invalidation
surface for nothing.

Invalidation is by **globally unique revision stamp** on `ClusterSet`, compared by the memo, rather than
by mutators calling `invalidate()`. A global counter rather than a per-set one makes *swapping* the set
detectable, not just writing to it - which removes `adopt`/`normalisedFor`/`transferred` from the
invalidation surface entirely. There is no mutator anyone has to remember: the memo validates itself.
`readingsPerGroup` now returns readonly types, so mutating the shared memo is a compile error.

Validated: 351 hits / 705 misses across the suite and 242 771 checked hits in fuzz, 0 disagreements, with
a negative control (making `touch()` a no-op makes the fuzz fail) proving the harness is sensitive.
Result: ~3-5% end-to-end.

Both this and 4.5 were taken back off the branch by `3e3e032`, the two of them being the whole of the
revision/`touch` mechanism, to be reviewed as a PR of their own: the stamp is load-bearing for whatever
reads it next, and the argument for why nothing has to invalidate it is worth reading on its own rather
than among a dozen unrelated fixes. Nothing else on the branch needed it - see 4.4.

### 4.4 `groupConjuncts` ↔ `writesAnything` recursion - fixed, `38f5d47`

Confirmed, and **reachable from a plain SPARQL query**, not just the internal API - the item's "depth is
small in practice" understates it. Measured call counts are exactly `9·2^(d-1) − 2`; a nested-accessor
filter at depth 20 took ~4 s in `pushDownAssertions`, and 1-2 million `groupConjuncts` calls.

Scoped **per walk** rather than per revision, deliberately deviating from 4.3's mechanism: a group's
conjuncts depend on `this.strength`, and `assertBound` promotes a weak member to strong without any write
reaching `touch()` - a revision-stamped memo would go stale there.

That is also why it survived `3e3e032` whole: never having read the stamp, it lost only the read-only
signatures 4.3 had given it.

Validated: 1467 memo lookups across the suite (matching the baseline call count exactly) and ~1.44M in
fuzz, 0 disagreements, output byte-identical at every depth. Result: 4 s → 2.6 ms at depth 20; no
measurable change at the depth ≤ 2 the suite actually uses.

### 4.5 `namedMembers` sorts on every call - fixed, `1473bd9`, then reverted, `3e3e032`

Confirmed: 2848 calls per pushdown pass over only 12 distinct revisions - 87.6% re-sort a group at a
state already sorted. The item's caller list is incomplete and mis-weighted: the dominant caller is
`representativeMemberOf` at 85% (via `get` and `rebuildingSubstitution`), not the decomposition.

Neither offered route was taken. "Sort once per decomposition" covers only the 15% from the walk -
`get`/`rebuildingSubstitution` have no decomposition in hand. "Sorted on insertion" would change ordering
inside the generic `ClusterSet`, which `ClusterSolver` also uses. A revision-stamped memo per group
covers every caller with no ordering change anywhere.

The comparator was **not** touched: with the memo the sort runs ~1/8 as often, so `localeCompare`'s share
evaporates on its own and is not worth an ordering-equivalence proof on a load-bearing order.

Validated: 4506 hits / 1589 misses across the suite, 40 000 fuzz queries byte-identical, 0 disagreements.
Result: 6-8% on the pushdown pass; `namedMembers` went from 4.9% to 0.7% of the profile.

(Note: an earlier profile in this document's own working notes put `namedMembers` at 24.5%. That was
measured before 4.3 and 4.4 landed and is stale.)

### 4.6 Every pass copies the whole tree twice - **rejected, no commit**

(a) and (b) are true. **(c) is false, and it is the whole premise.** Those two are the only
`withoutCpVars` callers in the repo, and no pipeline runs more than one of them - `standardTransformations`
and the `eval.test.ts` pipeline each contain `nullifyUnbindableVars` once and `pushDownAssertions` never.
So *k = 1*: the current code does 2 strips, and a runner stripping once at each end also does 2.
**Saving in the real pipeline: exactly zero.**

The contract change it asks for is also backwards. Both passes were audited and are already clean - they
leave 0 stale nodes, and for `nullifyUnbindableVars` that is structural (`createFilterFalse` wraps rather
than drops, and a FILTER has its input's `cVars`). The problem is the *other* eight passes: Traqula's
`TransformerObject.cloneObj` clones a `Set` as `Object.assign(Object.create(Set.prototype), set)` - a
prototype husk with no internal slots - so every pass that omits `shallowKeys: {'metadata'}` silently
corrupts the metadata it carries. `operationTransform` hands `nullifyUnbindableVars` a tree with 28
corrupted nodes. **The entry `withoutCpVars` is the pipeline's only defence**, not redundant work: stub
it out and every configuration dies with `Method Set.prototype.values called on incompatible receiver`.

Stripping cost is 5.15% of `queryTransform` (CPU profile, 400 iterations), so 5.2% is the ceiling for
removing *all* of it. The one safe variant - dropping the exit strip only - is byte-identical but
measures neutral-to-negative, because the metadata then survives into passes that deep-clone it. Real
headroom is elsewhere: the SPARQL generator's trailing-whitespace regexes are 35.6% and Traqula's
`cloneObj`/`transformObject` another 12.5%. See 6.3.

### 4.7 `rowSatisfies` clones the full conjunction per VALUES row - fixed, `f4fff8c`

Confirmed: 60-67% of the pushdown pass on a 10 000-row VALUES block. (The suite never sees it - only 49
rows ever reach `pruneValues` in the whole suite.)

Soundness of the pre-filter: a rejected row binds a column whose group carries a term pin to a different
term, and the full check's `meetTermPins` is literally the same `term.equals` predicate - so if it
reaches that column it fails, and if it does not, an earlier column already failed. Deliberately *not*
rejected, to stay provable: UNDEF entries (`get` treats `strength === undefined` as strong while
`assertUnbound` checks `=== 'strong'`, and that asymmetry made the shortcut unprovable), accessor pins,
unification edges, and shapes - all of which yield a `triple` pin or an access target rather than a term.

Validated: 42 292 fuzz rows with 18 272 rejections, 0 disagreements; 30 000 generated queries
byte-identical across 6 seeds. Result: 2.3× to 3.3× where a term pin exists, unchanged where none does
(the pin list is built once per VALUES, so the no-pin case pays only an empty `every`).

### 4.8 `collectAssertions` has an unbounded fixpoint loop - fixed, `3c4f4cf`

Termination holds, but **not for the reason this document gave**. "The substitution grows monotonically"
is false: values *change*, they do not only accumulate - a clique member substitutes to its
representative and a merge re-picks it, a later pin replaces the representative by a term, and
`assertUnbound` removes an entry outright.

What actually holds is a finite chain per variable, now written into the code: a variable enters the
substitution at most once (strength is one-way, and `assertUnbound` moves it to the absorbing U⟨?x⟩,
after which any strong assertion is a contradiction that ends the collection); an unpinned group's
representative only moves lexicographically earlier, at most `|names|` times; a pin is final, and shapes
are the same argument per position, with the occurs check keeping the shape graph acyclic. No round can
coin a new variable.

Both options were taken, and the bound is derived rather than invented. `substitutionGrew` throws unless
every per-round change is one of the allowed steps - the strong check, since it makes a regression loud
at the first round instead of hanging. The cap `size * (size + 2)` covers the one thing a local check
cannot see, a loop kept alive by ever more new variables, and is read straight off the chains above.

Observed: the whole suite peaks at **2 iterations** (1 productive round, 12% of its bound); random fuzz
reached 3 once in 6019 calls; a deliberately constructed pin chain reached 13 iterations at `size` 12
against a bound of 168 (7%). Both guards were verified to fire when deliberately broken, and neither
fires on any real input.

## 5. Documentation pass - what changed

For the record, since it touches nearly every file:

- Every function/method now has a short summary (1-2 sentences) plus `@param`/`@returns`. Detail that
  is about *how* a body works moved into the body as line comments; detail that restated an invariant
  three times over was cut.
- Long-form prose was kept only where the argument is genuinely load-bearing and non-obvious:
  the `@fileoverview` of `pushDownAssertions.ts` and `assertionConjunction.ts`, the class docs of
  `AssertionConjunction`, `TermClusterSet` and `AssertionClusterSet`, and
  `AssertionConjunction.intoPattern` / `normalisedFor` / `transferred`.
- `@param` tags were dropped (rather than expanded) on functions taking a destructured options object,
  because `jsdoc/check-param-names` then demands one tag per property.
- The notation the codebase already used (`Θ`, `A⟨?x ≡ c⟩`, `W⟨…⟩`, `T⟨a : τ⟩`, `B⟨?x⟩`, `U⟨?x⟩`,
  `σ_{…}`) was kept and made consistent across the files that had drifted into spelling it out.
- Net effect: `lib/` went from 8270 to 8033 lines, comment lines from 3301 to 3063 - and that is *net*
  of the docs added to previously undocumented functions. No behaviour change.

## 6. Found while fixing the above - not yet addressed

### 6.1 `VariableSet.disjunct` is the same defect as 2.1

`lib/transformations/variableSet.ts:50`. The method computes an intersection ("values present in both",
per its own doc) while the class header advertises "Supports union (combining possibilities) and
disjunction (finding common values)". One caller,
`lib/transformations/nullifyJoinOverIncompatibleBounds.ts:232`. Left alone because 2.1 scoped itself to
`RangeSet` and this is a separate class, but it is the identical naming bug.

### 6.2 `TermClusterSet.carriesInformation` does not chain, while its neighbour `isLive` does

`TermClusterSet.ts:401` vs `:411` (`super.isLive(group) || …`). Arguably fine - it is a boolean predicate
whose base returns a constant `false` that an override legitimately *replaces* rather than extends - but
it is the same "two hooks of the same shape disagree" pattern as 2.5.

### 6.3 `cloneObj` corrupts `Set` metadata, and eight passes rely on being stripped

The one that matters. Traqula's `TransformerObject.cloneObj` clones a `Set` as
`Object.assign(Object.create(Set.prototype), set)`, producing an object with the prototype but none of
the internal slots - any method call on it throws `called on incompatible receiver`. Only
`nullifyUnbindableVars` and `pushDownAssertions` pass `shallowKeys: {'metadata'}`; `filterFalse`,
`removeProjections`, `joinValuesToFilter`, `extendsToValues`, `serviceCallMerge`, `pathTransformation`,
`pushUpBoundedFromUnion` and `operationTransform` do not, and silently produce corrupted metadata -
28 nodes of it after `operationTransform` on the standard pipeline's own test query.

Nothing observable breaks today only because the two passes that *read* metadata strip and recompute it
on entry. That is load-bearing correctness resting on an undocumented accident, and it is what makes 4.6
impossible. Either fix `cloneObj` upstream, or pass `shallowKeys` consistently, or state the invariant.

### 6.4 The `require` half of the `exports` map does not work

`package.json` has `"type": "module"` and the CJS build emits `dist/cjs/**/*.js` with no
`dist/cjs/package.json` `{"type":"commonjs"}` marker, so `require('./dist/cjs/lib/index.js')` fails.
Pre-existing and unrelated to 2.2 - it reproduces on modules that were exported before that change.
