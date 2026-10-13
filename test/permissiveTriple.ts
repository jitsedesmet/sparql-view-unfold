import { TermFunctionTriple } from '@comunica/actor-function-factory-term-triple/lib/TermFunctionTriple.js';
import { TermFunctionBase } from '@comunica/bus-function-factory';
import { ActionContextKey } from '@comunica/core';
import { DefaultGraph, Quad } from '@comunica/utils-expression-evaluator';

/** The context entry comunica/comunica#1886 adds; `generalizedRDF` lets `TRIPLE()` build any triple term. */
export const rdfVariantKey = new ActionContextKey<string>('@comunica/actor-init-query:rdfVariant');

// Shim of comunica/comunica#1886 for the Comunica version in use; drop it once a release carries that PR.
TermFunctionTriple.prototype.applyOnTerms = function(this: TermFunctionTriple, args, exprEval) {
  if (exprEval.context.get(rdfVariantKey) === 'generalizedRDF') {
    return new Quad(<any> args[0], <any> args[1], <any> args[2], new DefaultGraph());
  }
  return TermFunctionBase.prototype.applyOnTerms.call(this, args, exprEval);
};
