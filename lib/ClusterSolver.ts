import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from './consts.js';
import type { Pin, PinMeet } from './datastructures/TermClusterSet.js';
import { meetShapes, TermClusterSet, triplePositions } from './datastructures/TermClusterSet.js';
import { objectRange, RangeSet } from './RangeSet.js';
import type { RangedVar } from './utils/RangedVar.js';
import { DF } from './utils/rdfDatatypes.js';
import { isRdfQuad, isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/** A raw term that is either a concrete term (not a variable) or a ranged variable. */
export type RawTerm = Exclude<RDF.Term, RDF.Variable> | RangedVar;

/**
 * A raw term that is not a triple term, which is what a *pin* holds.
 *
 * Not the solver refusing triple terms: one is not a value the way an IRI is but a **shape**, which
 * {@link ClusterSolver.assertTerm} decomposes a group into, so it lives one level up on
 * {@link TermClusterSet}'s lattice rather than in the leaves of it.
 */
export type RawBasicTerm = Exclude<RawTerm, RDF.BaseQuad>;

/**
 * The meet of the two pins one group of the unfolding is asked to carry at once: two terms are the term
 * equality they always were, and two shapes unify position by position ({@link meetShapes}).
 * @param left - One of the two pins
 * @param right - The other
 * @returns what the group is left with plus what the meet entailed, or `false` on a contradiction - which a
 * shape meeting a term always is, no {@link RawBasicTerm} being a triple term
 */
function meetSolverPins(left: Pin<RawBasicTerm>, right: Pin<RawBasicTerm>): PinMeet<RawBasicTerm> | false {
  if (left.kind === 'triple' || right.kind === 'triple') {
    return left.kind === 'triple' && right.kind === 'triple' ? meetShapes(left, right) : false;
  }
  return left.term.equals(right.term) ? { pin: left, entailed: []} : false;
}

/**
 * Whether the variable came from the user query, as against from the mapping being unfolded into it.
 *
 * The user query is renamed under {@link VAR_PREFIX_USER_QUERY} before any rewriting happens, so carrying
 * that prefix is what the two sides are told apart by - the whole prefix, a variable named `?uqx` being a
 * mapping variable like any other.
 * @param variable - The variable to classify
 * @returns whether it is a user query variable
 */
function isUserQueryVar(variable: RangedVar): boolean {
  return variable.value.startsWith(VAR_PREFIX_USER_QUERY);
}

/**
 * Solver for determining variable equality clusters during query rewriting.
 *
 * When rewriting a triple pattern against a mapping head, variables from both sides may need to be unified.
 * The solver tracks which variables are equivalent, what concrete terms they may be bound to, and which
 * expressions their value has to satisfy.
 *
 * Since a triple term the mapping head writes is a **shape** whose three positions are groups in their own
 * right ({@link assertTerm}) rather than a value a group is pinned to, the structure is a DAG, which
 * {@link resolvedTermOf} reads a term back off and the occurs check of {@link TermClusterSet} keeps well
 * founded.
 * @example
 * // Given mapping head: ?t rdf:reifies <<( ?s ?p ?o )>>
 * // And triple pattern: ?x rdf:reifies <<( ?x ?y ?z )>>
 * // The solver determines: ?t = ?x = ?s, ?y = ?p, ?z = ?o
 */
export class ClusterSolver extends TermClusterSet<RangedVar, RawBasicTerm> {
  /** Maps group ID to the expressions its value has to satisfy - read through {@link getExpressions}. */
  protected groupToExpressions: Record<number, Algebra.Expression[]>;
  /**
   * Static expression validations where no variable group is involved. These occur when an expression must
   * equal a concrete term.
   */
  protected staticExpressionValidation: { expression: Algebra.Expression; term: RawTerm }[];

  public constructor() {
    super(variable => variable.value, meetSolverPins);
    this.clear();
  }

  /** Resets the solver to its initial state. Call this before processing a new triple pattern. */
  public override clear(): void {
    super.clear();
    this.groupToExpressions = {};
    this.staticExpressionValidation = [];
  }

  /**
   * Narrows the group of a variable to the range that variable carries.
   * @param variable - The variable whose range to register
   * @throws Error if the narrowed range leaves the group nothing to be
   */
  protected handleVarRange(variable: RangedVar): void {
    const range = variable.range;
    const group = this.getGroup(variable);
    if (range !== undefined && group !== undefined && !this.narrowRange(group, range)) {
      const groupTerm = this.resolvedTermOf(group);
      throw new Error(`The range [${[ ...range.values() ].join(', ')}] of ${JSON.stringify(variable.value)} leaves nothing for its group, fixed to ${JSON.stringify(groupTerm)}`);
    }
  }

  /**
   * Registers an equality constraint between two terms, variables or expressions - the main entry point for
   * adding constraints.
   * @param from - Term, variable, or expression (typically from the mapping head)
   * @param to - Term or variable (typically from the triple pattern)
   * @throws Error if the terms do not match, or the constraints conflict
   */
  public register(from: RDF.Term | Algebra.Expression, to: RDF.Term): void {
    if (isRdfTerm(from) && !isRdfVar(from) && isRdfTerm(to) && !isRdfVar(to)) {
      // Two terms, neither are vars. Two *triple* terms never reach here - the unfolding recurses into a
      // pair of them rather than registering it - so what the equality compares is a pair of values.
      if (from.equals(to)) {
        return;
      }
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    } else if (isRdfVar(from) && isRdfVar(to)) {
      // Two vars
      this.mergeGroups(from, to);
    } else if (isRdfVar(from)) {
      // `from` is var - `to` is not
      const varGroup = this.getGroup(from);
      this.registerTermToGroup(varGroup, to);
    } else if (isRdfVar(to)) {
      // `to` is var, `from` is not
      const varGroup = this.getGroup(to);
      if (isRdfTerm(from)) {
        this.registerTermToGroup(varGroup, from);
      } else {
        // It is an expression
        this.registerExpressionToGroup(varGroup, from);
      }
    } else {
      // Neither `from` nor `to` is a var. First condition would have checked this in case `from` is a term.
      const expression = <Exclude<typeof from, RDF.Term>> from;
      // The one branch that writes without going through a group, so the only one with a `touch` of its own.
      this.touch();
      // TODO: decide statically whether the expression can produce this term at all, rather than leaving
      //   every such pair to the `sameTerm` the rewriting emits.
      this.staticExpressionValidation.push({
        expression,
        term: to,
      });
    }
  }

  protected override createEmptyGroup(): number {
    const group = super.createEmptyGroup();
    this.groupToExpressions[group] = [];
    return group;
  }

  protected override createGroup(variable: RangedVar): number {
    const group = super.createGroup(variable);
    this.groupToRange[group] = new RangeSet(variable.range ?? objectRange);
    return group;
  }

  /**
   * Gets or creates a group for a variable, registering its range when the group is new.
   * @param variable - The variable to get/create a group for
   * @returns the group ID
   */
  public override getGroup(variable: RangedVar): number {
    const oldNum = this.cleanNumber;
    const group = super.getGroup(variable);
    if (oldNum !== this.cleanNumber) {
      this.handleVarRange(variable);
    }
    return group;
  }

  /**
   * Registers an expression the group's value has to equal.
   *
   * TODO: narrow the group by what the expression can produce - the term type an operator returns is a range
   * like any other, and one that no longer meets the group's is a contradiction the rewriting currently
   * leaves to evaluation.
   * @param group - The group ID
   * @param expression - The expression every value of the group equals
   */
  protected registerExpressionToGroup(group: number, expression: Algebra.Expression): void {
    this.touch();
    this.groupToExpressions[group].push(expression);
  }

  /**
   * Registers a concrete term binding to a group: the throwing wrapper around {@link assertTerm} the
   * unfolding needs, a mapping head asking one group to be two terms at once being a broken mapping rather
   * than an ordinary contradiction.
   * @param group - The group ID
   * @param term - The term to bind, a triple term included
   * @throws Error if the term conflicts with an existing binding or range
   */
  protected registerTermToGroup(group: number, term: RawTerm): void {
    // Read before asserting: a failed assertion leaves the set in a state no caller may read - narrowed
    // ranges and all - so what the message reports is the state the caller handed over.
    const curTerm = this.resolvedTermOf(group);
    const curRange = this.rangeOf(group);
    if (!this.assertTerm(group, term)) {
      throw new Error(curTerm === undefined ?
        `Cannot assign Term ${JSON.stringify(term)} to a group with range [${[ ...curRange.values() ].join(', ')}]` :
        `Cannot match Term ${JSON.stringify(curTerm)} with term ${JSON.stringify(term)}`);
    }
  }

  /**
   * Asserts that every value of the group equals the term.
   *
   * A triple term is not pinned but **decomposed**: the group takes the shape of one, and each position is
   * asserted onto the group that position is - the same unification the rest of the mapping head goes
   * through. Three things come with that: a second triple term on the group unifies with the first rather
   * than being reported unequal, every position is held to the range it can have, and the occurs check
   * refuses `?y ≡ <<( ... ?y )>>`.
   * @param group - The group to assert on
   * @param term - The term every value of the group equals
   * @returns `false` on a contradiction, after which the solver holds no meaningful state
   */
  private assertTerm(group: number, term: RawTerm): boolean {
    if (!isRdfQuad(term)) {
      return this.setTerm(group, term);
    }
    // A triple term states no graph, so a quad that names one is not a value any group can take.
    if (term.graph.termType !== 'DefaultGraph') {
      return false;
    }
    const children = this.assertTriplePin(group);
    if (children === false) {
      return false;
    }
    return triplePositions.every((position) => {
      const component = term[position];
      // Merging a position may merge further groups, so every step reads the ids through the set again -
      // which `unifyGroups` and `setTerm` both do for the group they are handed.
      return isRdfVar(component) ?
        this.unifyGroups(children[position], this.getGroup(component)) :
        this.assertTerm(children[position], component);
    });
  }

  /**
   * The term every value of the group equals, reading a *shape* back as the triple term it stands for.
   *
   * Every position is whatever fixes it, or else the mapping variable naming it - the same variable the
   * mapping body binds, which is what lets the `BIND(<<( ?mi_s ?mi_p ?mi_o )>> AS ?uq_o)` this feeds name
   * values the subselect really projects.
   * @param group - The group to look up
   * @returns the term, or `undefined` when nothing fixes the group, or when a position of its shape is fixed
   * by nothing and named by nothing
   */
  public resolvedTermOf(group: number): RawTerm | undefined {
    const pin = this.pinOf(group);
    if (pin?.kind !== 'triple') {
      return pin?.term;
    }
    // Terminates on the occurs check: a group reaching itself through the pins is a contradiction, and
    // the constraint solving refuses to settle in such a state.
    const children = this.childrenOf(group)!;
    const [ subject, predicate, object ] = triplePositions.map(position =>
      this.resolvedTermOf(children[position]) ?? this.mappingVarsOf(children[position])[0]);
    if (subject === undefined || predicate === undefined || object === undefined) {
      return undefined;
    }
    // Every position was held to the range it admits while the shape was built, so this really is a
    // triple term - which the types of a data factory have no way of knowing.
    return DF.quad(<RDF.Quad_Subject> subject, <RDF.Quad_Predicate> predicate, <RDF.Quad_Object> object);
  }

  /**
   * The variables of the *mapping* in a group, as against the user query variables the rewriting binds from
   * them.
   * @param group - The group to look up
   * @returns its mapping variables, ordered by {@link sortClusters} so that the first is the one every
   * rewrite names the group by
   */
  public mappingVarsOf(group: number): readonly RangedVar[] {
    return this.valuesOf(this.resolveGroup(group)).filter(value => !isUserQueryVar(value));
  }

  /**
   * Carries the expressions of the disappearing group over - it is no longer reachable, so the constraints it
   * holds would otherwise be lost. Ranges and terms are merged by {@link TermClusterSet} itself.
   * @param oldGroup - The group disappearing
   * @param newGroup - The group surviving
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    super.migrateGroupData(oldGroup, newGroup);
    this.groupToExpressions[newGroup].push(...this.groupToExpressions[oldGroup]);
    delete this.groupToExpressions[oldGroup];
  }

  /**
   * Merges the groups of two mapping variables.
   * @param from - One of the variables
   * @param to - The other
   * @returns the ids involved, or `undefined` when both were already in one group
   * @throws Error when the two are fixed to different terms: a mapping head asking one group to be two terms
   * at once is broken, rather than the ordinary contradiction it is for an assertion conjunction
   */
  public override mergeGroups(from: RangedVar, to: RangedVar):
    { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    const merged = super.mergeGroups(from, to);
    if (merged?.conflict === true) {
      throw new Error(`Cannot unify ${JSON.stringify(from.value)} with ${JSON.stringify(to.value)}: they are fixed to different terms`);
    }
    return merged;
  }

  /**
   * Sorts the variables within each cluster, mapping variables first and by name within each of the two.
   *
   * The mapping variables coming first is what {@link resolvedTermOf} and the rewriting read a cluster by:
   * the first variable of a cluster is the one the subselect really projects, so a user query variable
   * landing there would name a variable nothing binds. It is ordered on `isUserQueryVar` rather than
   * left to the names, which only happen to sort that way while the prefixes both start where they do.
   *
   * Sorts the lists in place, which is a write like any other: what a group's first value is decides what
   * every read of it names, so the stamp has to move on even though the members themselves do not change.
   */
  public sortClusters(): void {
    this.touch();
    for (const groupVars of Object.values(this.groupToValues)) {
      groupVars.sort((a, b) =>
        (isUserQueryVar(a) ? 1 : 0) - (isUserQueryVar(b) ? 1 : 0) ||
        a.value.localeCompare(b.value));
    }
  }

  /**
   * Gets the cluster information for a variable.
   * @param from - The variable to look up
   * @returns the term its cluster is bound to (if any), the other variables in the cluster, and the group ID
   */
  public getCluster(from: RDF.Variable): { term: RawTerm | undefined ; vars: RDF.Variable[]; group: number } {
    const varGroup = this.getGroup(from);
    return {
      term: this.resolvedTermOf(varGroup),
      vars: this.valuesOf(varGroup).filter(value => !value.equals(from)),
      group: varGroup,
    };
  }

  /**
   * Gets all expressions that must equal the given variable's value.
   * @param from - The variable to look up
   * @returns the expressions
   */
  public getExpressions(from: RDF.Variable): Algebra.Expression[] {
    const varGroup = this.getGroup(from);
    return this.groupToExpressions[varGroup];
  }

  /**
   * Gets all expression-to-term equality checks with no variable involved.
   * @returns the expression-term pairs to validate
   * @example
   * //   UQ: ?s <p> <<(?s a "b")>>
   * //   MH: <x> <p> ?y
   * //   --> ?s = <x> = subject(?y) ;
   * //   AND ALSO: predicate(?y) = rdf:type ; object(?y) = "b"
   */
  public getStaticExpressionValidation(): typeof this.staticExpressionValidation {
    return this.staticExpressionValidation;
  }
}
