import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { TermClusterSet } from './datastructures/TermClusterSet.js';
import { objectRange } from './RangeSet.js';
import { RewriteNoMatchError } from './RewriteNoMatchError.js';
import type { RangedVar } from './utils/RangedVar.js';
import { isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/**
 * Solver for determining variable equality clusters during query rewriting.
 *
 * When rewriting a triple pattern against a mapping head, variables from both sides may need to be unified.
 * The solver tracks which variables are equivalent, what concrete terms they may be bound to, and which
 * expressions their value has to satisfy.
 *
 * Since a triple term the mapping head writes is a **shape** whose three positions are groups in their own
 * right ({@link assertTerm}) rather than a value a group is pinned to, the structure is a DAG, which
 * {@link fixedTermOf} reads a term back off and the occurs check of {@link TermClusterSet} keeps well
 * founded.
 * @example
 * // Given mapping head: ?t rdf:reifies <<( ?s ?p ?o )>>
 * // And triple pattern: ?x rdf:reifies <<( ?x ?y ?z )>>
 * // The solver determines: ?t = ?x = ?s, ?y = ?p, ?z = ?o
 */
export class ClusterSolver extends TermClusterSet<RangedVar> {
  /** Maps group ID to the expressions its value has to satisfy - read through {@link getExpressions}. */
  protected groupToExpressions: Record<number, Algebra.Expression[]>;
  /**
   * Static expression validations where no variable group is involved. These occur when an expression must
   * equal a concrete term.
   */
  protected staticExpressionValidation: { expression: Algebra.Expression; term: RDF.Term }[];
  /** The names of the user query's variables: those {@link register} met on its user query side. */
  private userQueryVariableNames: Set<string>;

  public constructor() {
    super(variable => variable.value, variable => variable);
    this.clear();
  }

  /** Resets the solver to its initial state. Call this before processing a new triple pattern. */
  public override clear(): void {
    super.clear();
    this.groupToExpressions = {};
    this.staticExpressionValidation = [];
    this.userQueryVariableNames = new Set();
  }

  /**
   * Whether the variable came from the user query rather than from the mapping.
   * @param variable - The variable to classify
   * @returns whether it is a user query variable
   */
  private isUserQueryVar(variable: RangedVar): boolean {
    return this.userQueryVariableNames.has(variable.value);
  }

  /**
   * Narrows the group of a variable to the range that variable carries.
   * @param variable - The variable whose range to register
   * @throws RewriteNoMatchError if the narrowed range leaves the group nothing to be
   */
  protected handleVarRange(variable: RangedVar): void {
    const range = variable.range;
    const group = this.getGroup(variable);
    if (range !== undefined && group !== undefined && !this.narrowRange(group, range)) {
      const groupTerm = this.fixedTermOf(group);
      throw new RewriteNoMatchError(`The range [${[ ...range.values() ].join(', ')}] of ${JSON.stringify(variable.value)} leaves nothing for its group, fixed to ${JSON.stringify(groupTerm)}`);
    }
  }

  /**
   * Registers that a term or expression of the mapping head equals a term of the user query's pattern. A
   * variable on the user query side is classified as the user query's, every other one as the mapping's.
   * @param mappingSide - Term, variable, or expression of the mapping head
   * @param userQuerySide - Term or variable of the triple pattern
   * @throws RewriteNoMatchError if the terms do not match, or the constraints conflict
   */
  public register(mappingSide: RDF.Term | Algebra.Expression, userQuerySide: RDF.Term): void {
    if (isRdfVar(userQuerySide) && !this.userQueryVariableNames.has(userQuerySide.value)) {
      this.touch();
      this.userQueryVariableNames.add(userQuerySide.value);
    }
    if (isRdfTerm(mappingSide) && !isRdfVar(mappingSide) && isRdfTerm(userQuerySide) && !isRdfVar(userQuerySide)) {
      // Two terms, neither are vars. Two *triple* terms never reach here - the unfolding recurses into a
      // pair of them rather than registering it - so what the equality compares is a pair of values.
      if (mappingSide.equals(userQuerySide)) {
        return;
      }
      throw new RewriteNoMatchError(`Cannot match Term ${JSON.stringify(mappingSide)} with term ${JSON.stringify(userQuerySide)}`);
    } else if (isRdfVar(mappingSide) && isRdfVar(userQuerySide)) {
      // Two vars
      this.mergeGroups(mappingSide, userQuerySide);
    } else if (isRdfVar(mappingSide)) {
      // `mappingSide` is var - `userQuerySide` is not
      const varGroup = this.getGroup(mappingSide);
      this.registerTermToGroup(varGroup, userQuerySide);
    } else if (isRdfVar(userQuerySide)) {
      // `userQuerySide` is var, `mappingSide` is not
      const varGroup = this.getGroup(userQuerySide);
      if (isRdfTerm(mappingSide)) {
        this.registerTermToGroup(varGroup, mappingSide);
      } else {
        // It is an expression
        this.registerExpressionToGroup(varGroup, mappingSide);
      }
    } else {
      // Neither side is a var. The first condition would have caught a `mappingSide` that is a term.
      const expression = <Exclude<typeof mappingSide, RDF.Term>> mappingSide;
      // The one branch that writes without going through a group, so the only one with a `touch` of its own.
      this.touch();
      // TODO: decide statically whether the expression can produce this term at all, rather than leaving
      //   every such pair to the `sameTerm` the rewriting emits.
      this.staticExpressionValidation.push({
        expression,
        term: userQuerySide,
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
    this.groupToRange[group] = variable.range ?? objectRange;
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
   * unfolding needs, a group asked to be two terms at once matching nothing at all.
   * @param group - The group ID
   * @param term - The term to bind, a triple term included
   * @throws RewriteNoMatchError if the term conflicts with an existing binding or range
   */
  protected registerTermToGroup(group: number, term: RDF.Term): void {
    // Read before asserting: a failed assertion leaves the set in a state no caller may read - narrowed
    // ranges and all - so what the message reports is the state the caller handed over.
    const curTerm = this.fixedTermOf(group);
    const curRange = this.rangeOf(group);
    if (!this.assertTerm(group, term)) {
      throw new RewriteNoMatchError(curTerm === undefined ?
        `Cannot assign Term ${JSON.stringify(term)} to a group with range [${[ ...curRange.values() ].join(', ')}]` :
        `Cannot match Term ${JSON.stringify(curTerm)} with term ${JSON.stringify(term)}`);
    }
  }

  /**
   * The term a group is fixed to, a shape read back with every position nothing fixes named by its mapping variable:
   * the one the mapping body binds, so that `BIND(<<( ?s ?p ?o )>> AS ?y)` names values the subselect projects.
   * @param group - The group to look up
   * @returns the term, or `undefined` when nothing fixes the group, or a position of its shape is fixed by nothing
   * and named by nothing
   */
  public fixedTermOf(group: number): RDF.Term | undefined {
    return this.resolvedTermOf(group, this.firstMappingVarOf);
  }

  /**
   * The mapping variable naming a group.
   * @param group - The group to name
   * @returns the variable, or `undefined` when no mapping variable is in it
   */
  private readonly firstMappingVarOf = (group: number): RDF.Variable | undefined => this.mappingVarsOf(group)[0];

  /**
   * The variables of the *mapping* in a group, as against the user query variables the rewriting binds from
   * them.
   * @param group - The group to look up
   * @returns its mapping variables, ordered by {@link sortClusters} so that the first is the one every
   * rewrite names the group by
   */
  public mappingVarsOf(group: number): readonly RangedVar[] {
    return this.valuesOf(this.resolveGroup(group)).filter(value => !this.isUserQueryVar(value));
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
   * @throws RewriteNoMatchError when the two are fixed to different terms, which no solution can satisfy
   */
  public override mergeGroups(from: RangedVar, to: RangedVar):
    { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    const merged = super.mergeGroups(from, to);
    if (merged?.conflict === true) {
      throw new RewriteNoMatchError(`Cannot unify ${JSON.stringify(from.value)} with ${JSON.stringify(to.value)}: they are fixed to different terms`);
    }
    return merged;
  }

  /**
   * Sorts the variables within each cluster, mapping variables first and by name within each of the two.
   *
   * The mapping variables coming first is what {@link fixedTermOf} and the rewriting read a cluster by:
   * the first variable of a cluster is the one the subselect really projects, so a user query variable
   * landing there would name a variable nothing binds. It is ordered on {@link isUserQueryVar} rather than
   * left to the names, which carry no sign of the side they are on.
   *
   * Sorts the lists in place, which is a write like any other: what a group's first value is decides what
   * every read of it names, so the stamp has to move on even though the members themselves do not change.
   */
  public sortClusters(): void {
    this.touch();
    for (const groupVars of Object.values(this.groupToValues)) {
      groupVars.sort((a, b) =>
        (this.isUserQueryVar(a) ? 1 : 0) - (this.isUserQueryVar(b) ? 1 : 0) ||
        a.value.localeCompare(b.value));
    }
  }

  /**
   * Gets the cluster information for a variable.
   * @param from - The variable to look up
   * @returns the term its cluster is bound to (if any), the other variables in the cluster, and the group ID
   */
  public getCluster(from: RDF.Variable): { term: RDF.Term | undefined ; vars: RDF.Variable[]; group: number } {
    const varGroup = this.getGroup(from);
    return {
      term: this.fixedTermOf(varGroup),
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
