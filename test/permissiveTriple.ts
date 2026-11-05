import { TermFunctionTriple } from '@comunica/actor-function-factory-term-triple/lib/TermFunctionTriple.js';
import { TermFunctionBase } from '@comunica/bus-function-factory';
import { ActionContextKey } from '@comunica/core';
import { DefaultGraph, Quad } from '@comunica/utils-expression-evaluator';

/** The context entry comunica/comunica#1886 adds; `generalizedRDF` lets `TRIPLE()` build any triple term. */
export const rdfVariantKey = new ActionContextKey<string>('@comunica/actor-init-query:rdfVariant');

// Shim of comunica/comunica#1886 for the Comunica version in use.
// TODO: once a Comunica release includes comunica/comunica#1886, bump Comunica to it and delete this file and the
//   devDependencies only it needs: @comunica/actor-function-factory-term-triple, @comunica/bus-function-factory
//   and @comunica/utils-expression-evaluator. Then take the `rdfVariant` key in integration.test.ts from that
//   release, and check that staticExpressionEvaluation.ts passes the same one.
TermFunctionTriple.prototype.applyOnTerms = function(this: TermFunctionTriple, args, exprEval) {
  if (exprEval.context.get(rdfVariantKey) === 'generalizedRDF') {
    return new Quad(<any> args[0], <any> args[1], <any> args[2], new DefaultGraph());
  }
  return TermFunctionBase.prototype.applyOnTerms.call(this, args, exprEval);
};
