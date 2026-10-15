import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';

/** Shared DataFactory instance for creating RDF terms */
export const DF = new DataFactory();

/** XSD namespace URI */
export const xsd = 'http://www.w3.org/2001/XMLSchema#';

/** XSD boolean datatype as a NamedNode */
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);

/** XSD string datatype as a NamedNode */
export const datatypeString = DF.namedNode(`${xsd}string`);

/**
 * Creates a triple term, its caller vouching that each position holds a term that position admits.
 * @param subject - The subject
 * @param predicate - The predicate
 * @param object - The object
 * @returns the triple term
 */
export function tripleTerm(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term): RDF.Quad {
  return DF.quad(<RDF.Quad_Subject> subject, <RDF.Quad_Predicate> predicate, <RDF.Quad_Object> object);
}
