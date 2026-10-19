import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { EXTENSION_FUNCTION_BNODE } from '../consts.js';
import { createTransformationContext } from '../transformContext.js';
import { DF } from '../utils/rdfDatatypes.js';
import { boundArgumentMarker, unboundArgumentMarker } from './bnodeExtensionFunction.js';
import type { InternalBnodeMaterialisation } from './internalBnodeMaterialisation.js';
import {
  internalBnodeEncodingTags,
  specialIriMaterialisation,
  specialLiteralMaterialisation,
} from './internalBnodeMaterialisation.js';
import { compileExpression } from './staticExpressionEvaluation.js';

/**
 * @fileoverview The extension functions computing internal blank nodes from their evaluated arguments, so a triple
 * term of any depth too. They materialise the encoding through Comunica's Expression Evaluator, with the same
 * expression the SPARQL encoding uses.
 */

/** Extension functions by the IRI they are called by, the shape of Comunica's `extensionFunctions` context entry. */
export type ExtensionFunctions = Record<string, (args: RDF.Term[]) => Promise<RDF.Term>>;

/**
 * Writes a string as its length and itself, as the SPARQL encoding does.
 * @param value - The string.
 * @returns The field, `,<length>:<string>`, the length in characters as `STRLEN` counts them.
 */
function field(value: string): string {
  return `,${[ ...value ].length}:${value}`;
}

/**
 * Encodes a term an argument evaluated to as the SPARQL encoding does, and a blank node by its label.
 * @param term - The term.
 * @returns Its encoding.
 * @throws Error if the term is a variable or the default graph, which no expression evaluates to
 */
function encodeTerm(term: RDF.Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return `${internalBnodeEncodingTags.iri}${field(term.value)}`;
    case 'Literal':
      return `${internalBnodeEncodingTags.literal}${field(term.value)}${field(term.datatype.value)}${
        field(term.language)}${field(term.direction ?? '')}`;
    case 'Quad':
      return `${internalBnodeEncodingTags.triple}${encodeTerm(term.subject)}${encodeTerm(term.predicate)}${
        encodeTerm(term.object)}`;
    case 'BlankNode':
      return `${internalBnodeEncodingTags.blankNode}${field(term.value)}`;
    default:
      throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE}> cannot evaluate to a ${term.termType}.`);
  }
}

/**
 * Encodes an argument as `internalBnodeAsExtensionFunction` wrapped it.
 * @param argument - The wrapped argument.
 * @returns Its encoding, `,unbound` where it was unbound or errored.
 * @throws Error if the argument is not wrapped
 */
function encodeArgument(argument: RDF.Term): string {
  if (argument.equals(unboundArgumentMarker)) {
    return internalBnodeEncodingTags.unbound;
  }
  if (argument.termType === 'Quad' && argument.subject.equals(boundArgumentMarker)) {
    return encodeTerm(argument.object);
  }
  throw new Error(`An argument of <${EXTENSION_FUNCTION_BNODE}> has to be wrapped by ` +
    `internalBnodeAsExtensionFunction, which ${argument.termType} ${argument.value} is not.`);
}

/**
 * The extension function materialising internal blank nodes, compiling the materialisation once on its first call.
 * @param materialisation - What the internal blank nodes become.
 * @returns The function, by the IRI it is called by.
 */
function internalBnodeExtensionFunctions(materialisation: InternalBnodeMaterialisation): ExtensionFunctions {
  const c = createTransformationContext();
  const encodingVariable = DF.variable('encoding');
  const bindingsFactory = new BindingsFactory(DF);
  let materialise: Promise<(bindings: RDF.Bindings) => Promise<RDF.Term>> | undefined;
  return {
    [EXTENSION_FUNCTION_BNODE]: async(args) => {
      materialise ??= compileExpression(
        c,
        materialisation.materialiseEncodingExpression(c, c.AF.createTermExpression(encodingVariable)),
      );
      // Without arguments, a fresh identity each time, as `STRUUID()` gives in SPARQL.
      const encoding = args.length === 0 ? crypto.randomUUID() : args.map(encodeArgument).join('');
      return (await materialise)(bindingsFactory.bindings([[ encodingVariable, DF.literal(encoding) ]]));
    },
  };
}

/**
 * The extension function for `internalBnodeAsSpecialLiteralTransformation({ evaluatedByExtensionFunction: true })`.
 * @returns The function, for Comunica's `extensionFunctions` context entry.
 */
export function internalBnodeAsSpecialLiteralExtensionFunctions(): ExtensionFunctions {
  return internalBnodeExtensionFunctions(specialLiteralMaterialisation);
}

/**
 * The extension function for `internalBnodeAsSpecialIriTransformation({ evaluatedByExtensionFunction: true })`.
 * @returns The function, for Comunica's `extensionFunctions` context entry.
 */
export function internalBnodeAsSpecialIriExtensionFunctions(): ExtensionFunctions {
  return internalBnodeExtensionFunctions(specialIriMaterialisation);
}
