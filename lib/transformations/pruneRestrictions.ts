/**
 * We can prune restrictions.
 *
 * 1. isBound filter over certainlyBound var should be removed
 * 2. isBound filter over var constructed by EXTEND gets metadata annotation that the bind enforces range restrictions on the vars used in the expression - get fail fast behavioir of https://www.w3.org/TR/shacl12-rules/#rules-sparql-relationship
 *    * The rule SET form and SPARQL BIND form have different error handling behaviors.
 *    *  An error encountered in SET causes the current solution to be filtered out,
 *    * whereas BIND does not set the variable in the current solution.
 *    * SET(?var := expr) would be the same as SPARQL with BIND(expr AS ?var) followed by FILTER(BOUND(?var)).
 * 3. For a scoped restriction zone, create a clusterSolver that can also detect statical expression evaluation failures
 *     To this end, we might need to depend on comunica expression evaluator. To evaluate expression
 */
