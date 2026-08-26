import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { TermClusterSet } from './datastructures/TermClusterSet.js';
import { objectRange, RangeSet } from './RangeSet.js';
import type { RangedVar } from './utils/RangedVar.js';
import { isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/**
 * A raw term that is either a concrete term (not a variable) or a ranged variable.
 */
type RawTerm = Exclude<RDF.Term, RDF.Variable> | RangedVar;

/**
 * A basic raw term (not a quad/triple term).
 */
export type RawBasicTerm = Exclude<RawTerm, RDF.Quad>;

/**
 * Solver for determining variable equality clusters during query rewriting.
 *
 * When rewriting a triple pattern against a mapping head, variables from both
 * sides may need to be unified. The ClusterSolver tracks which variables are
 * equivalent and what concrete terms they may be bound to.
 *
 * ## Core Concepts:
 * - **Group**: A set of variables that must all have the same value
 * - **Range**: The set of valid term types for a group (narrowed as constraints are added) - like position in triple.
 * - **Term**: A concrete value that a group must equal
 * - **Template**: A computed term (IRI template, etc.) that a group must equal
 *
 * ## DAG Structure:
 * Since triple terms can contain variables, and those variables might be equated
 * to other triple terms, the structure forms a DAG. Triple terms are always
 * resolved last to ensure dependencies are handled correctly.
 *
 * @example
 * // Given mapping head: ?t rdf:reifies <<( ?s ?p ?o )>>
 * // And triple pattern: ?x rdf:reifies <<( ?x ?y ?z )>>
 * // The solver determines: ?t = ?x = ?s, ?y = ?p, ?z = ?o
 */
export class ClusterSolver extends TermClusterSet<RangedVar, RawBasicTerm> {
  /** Maps group ID to the expression that they need to satisfy */
  public groupToExpressions: Record<number, Algebra.Expression[]>;
  /**
   * Static expression validations where no variable group is involved.
   * These occur when an expression must equal a concrete term.
   */
  protected staticExpressionValidation: { expression: Algebra.Expression; term: RawBasicTerm }[];
  /** Counter for generating unique group IDs */

  public constructor() {
    // The unfolding never builds a shape: a mapping head equates terms and variables, and the one place a
    // triple term could be decomposed is the TODO of {@link getStaticExpressionValidation}. So the meet is
    // the term equality it always was, and any other pair is a broken mapping.
    super(variable => variable.value, (a, b) =>
      a.kind === 'term' && b.kind === 'term' && a.term.equals(b.term) ? { pin: a, entailed: []} : false);
    this.clear();
  }

  /**
   * Resets the solver to its initial state.
   * Call this before processing a new triple pattern.
   */
  public override clear(): void {
    super.clear();
    this.groupToExpressions = {};
    this.staticExpressionValidation = [];
  }

  /**
   * Registers the range constraint of a variable to its group.
   * Narrows the group's range to the intersection with the variable's range.
   * @param variable - The variable whose range to register
   * @throws Error if the narrowed range conflicts with an existing term binding
   */
  protected handleVarRange(variable: RangedVar): void {
    const range = variable.range;
    const group = this.getGroup(variable);
    if (range !== undefined && group !== undefined && !this.narrowRange(group, range)) {
      const groupTerm = this.termOf(group);
      throw new Error(`The range of the current group no longer matches the term type ${groupTerm?.termType} of term: ${JSON.stringify(groupTerm?.termType)}`);
    }
  }

  /**
   * Registers an equality constraint between two terms/templates.
   *
   * This is the main entry point for adding constraints. The behavior depends
   * on the types of `from` and `to`:
   * - Two variables: merge their groups
   * - Variable + term: bind the variable's group to the term
   * - Variable + template: add a template constraint to the group
   * - Two terms: validate they are equal (throws if not)
   * - Template + term: add to static validation list
   *
   * @param from - Term, variable, or template (typically from mapping head)
   * @param to - Term or variable (typically from triple pattern)
   * @throws Error if terms don't match or constraints conflict
   */
  public register(from: RDF.Term | Algebra.Expression, to: RDF.Term): void {
    if (isRdfTerm(from) && !isRdfVar(from) && isRdfTerm(to) && !isRdfVar(to)) {
      // Two terms, neither are vars
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
      // Check term types match:
      const expression = <Exclude<typeof from, RDF.Term>> from;
      // TODO; statically check if the expression is even satisfiable.
      // if (expression.subType !== to.termType) {
      //   throw new Error(`Cannot match template of type ${template.subType} with term of type ${to.termType}.
      //   Matching ${JSON.stringify(expression)} with ${JSON.stringify(to)}`);
      // }
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
   * Gets or creates a group for a variable.
   * @param variable - The variable to get/create a group for
   * @returns The group ID
   */
  public override getGroup(variable: RangedVar): number {
    const oldNum = this.cleanNumber;
    const group = super.getGroup(variable);
    if (oldNum !== this.cleanNumber) {
      this.handleVarRange(variable);
    }
    return group;
  }

  protected registerExpressionToGroup(group: number, expression: Algebra.Expression): void {
    // TODO: is it expression satisfiable?
    // const curTerm = this.groupToTerm[group];
    // if (curTerm && curTerm.termType !== template.subType) {
    //   throw new Error(`Cannot match Template ${JSON.stringify(template)} with term ${JSON.stringify(curTerm)}`);
    // }
    // const groupRange = this.groupToRange[group];
    // Const newRange = groupRange.disjunct(new RangeSet([ template.subType ]));
    // if (newRange.size === 0) {
    //   throw new Error(`Cannot assign template ${JSON.stringify(template)}
    //   to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    // }
    // Narrow the groupRange
    // this.groupToRange[group] = newRange;

    this.groupToExpressions[group].push(expression);
  }

  /**
   * Registers a concrete term binding to a group: the throwing wrapper around {@link setTerm} that the
   * unfolding needs, since a mapping head asking one group to be two terms at once is a broken mapping
   * rather than an ordinary contradiction.
   * @param group - The group ID
   * @param term - The term to bind
   * @throws Error if term conflicts with existing binding or range
   */
  protected registerTermToGroup(group: number, term: RawBasicTerm): void {
    const curTerm = this.termOf(group);
    // TODO: validate in the case of triple term by also registering that some variables present might be the same.
    if (curTerm && !curTerm.equals(term)) {
      throw new Error(`Cannot match Term ${JSON.stringify(curTerm)} with term ${JSON.stringify(term)}`);
    }
    const groupRange = this.rangeOf(group);
    if (!groupRange.has(term.termType)) {
      throw new Error(`Cannot assign Term ${JSON.stringify(term)} to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    }
    this.setTerm(group, term);
  }

  /**
   * Carries the expressions of the disappearing group over - it is no longer reachable, so the constraints
   * it holds would otherwise be lost. Ranges and terms are merged by {@link TermClusterSet} itself.
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    this.groupToExpressions[newGroup].push(...this.groupToExpressions[oldGroup]);
    delete this.groupToExpressions[oldGroup];
  }

  /**
   * A mapping head asking one group to be two terms at once is broken, rather than the ordinary
   * contradiction it is for an assertion conjunction, so the conflict {@link TermClusterSet} reports is
   * raised here.
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
   * Sorts variables within each cluster for consistent output.
   * Mapping variables (starting with 'm') are sorted before user query variables ('uq').
   */
  public sortClusters(): void {
    for (const groupVars of Object.values(this.groupToValues)) {
      groupVars.sort((a, b) =>
        // Make sure 'm' (mapping) vars are before 'uq' (user query) vars
        a.value.localeCompare(b.value));
    }
  }

  /**
   * Gets the cluster information for a variable.
   * @param from - The variable to look up
   * @returns Object containing:
   *   - `term`: The concrete term bound to this cluster (if any)
   *   - `vars`: Other variables in the same cluster
   *   - `group`: The cluster's group ID
   */
  public getCluster(from: RDF.Variable): { term: RawBasicTerm | undefined ; vars: RDF.Variable[]; group: number } {
    const varGroup = this.getGroup(from);
    return {
      term: this.termOf(varGroup),
      vars: this.groupToValues[varGroup]
        .filter(x => !x.equals(from)),
      group: varGroup,
    };
  }

  /**
   * Gets all expressions that must equal the given variable's value.
   * @param from - The variable to look up
   * @returns Array of expressions that must equal this variable
   */
  public getExpressions(from: RDF.Variable): Algebra.Expression[] {
    const varGroup = this.getGroup(from);
    return this.groupToExpressions[varGroup];
  }

  /**
   * Gets all static expression validations (expression-to-term equality checks).
   * These are cases where an expression must equal a concrete term with no variable involved.
   * @returns Array of template-term pairs to validate
   *
   * @example
   *   UQ: ?s <p> <<(?s a "b")>>
   *   MH: <x> <p> ?y
   *   --> ?s = <x> = subject(?y) ;
   *   AND ALSO: predicate(?y) = rdf:type ; object(?y) = "b"
   */
  public getStaticExpressionValidation(): typeof this.staticExpressionValidation {
    return this.staticExpressionValidation;
  }
}
