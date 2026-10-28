import type * as RDF from '@rdfjs/types';
import { unifyTerms } from '../utils/assertions.js';

/**
 * Represents a set of possible values for a variable.
 * Supports union (combining possibilities) and disjunction (finding common values).
 */
export class VariableSet {
  /** If true, the variable has no fixed set of values (any value is possible) */
  public isNoFixed: boolean;
  /** The set of possible values (only meaningful if isNoFixed is false) */
  public values: RDF.Term[];

  public constructor(...values: RDF.Term[]) {
    this.isNoFixed = false;
    this.values = values;
  }

  /**
   * Creates a VariableSet representing an unbounded variable.
   * @returns A VariableSet where any value is possible
   */
  public static createNoFixed(): VariableSet {
    const res = new VariableSet();
    res.isNoFixed = true;
    return res;
  }

  /**
   * Computes the union of two VariableSets (all possible values from both).
   * If either set is unbounded, the result is unbounded.
   * @param other - The other VariableSet
   * @returns A new VariableSet with combined values
   */
  public union(other: VariableSet): VariableSet {
    if (this.isNoFixed || other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    return new VariableSet(
      ...this.values,
      ...other.values.filter(otherVal => !this.values.some(x => x.equals(otherVal))),
    );
  }

  /**
   * Computes the intersection of two VariableSets (values present in both).
   * If one set is unbounded, returns the bounded set's values.
   * @param other - The other VariableSet
   * @returns A new VariableSet with common values
   */
  public disjunct(other: VariableSet): VariableSet {
    if (this.isNoFixed && other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    if (this.isNoFixed) {
      return new VariableSet(...other.values);
    }
    if (other.isNoFixed) {
      return new VariableSet(...this.values);
    }
    return new VariableSet(
      ...this.values.filter(value => other.values.some(x => x.equals(value))),
    );
  }

  /**
   * Checks if a term is compatible with this set of possible values: a variable always is, any other term
   * when it unifies with one of them, so that a triple term over variables matches the triple terms it can be.
   * @param term - The term to check
   * @returns True if the term could match this VariableSet
   */
  public termIsCompatible(term: RDF.Term): boolean {
    return this.isNoFixed || term.termType === 'Variable' || this.values.some(x => unifyTerms(x, term) !== undefined);
  }
}
