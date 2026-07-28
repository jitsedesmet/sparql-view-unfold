import { DataFactory } from 'rdf-data-factory';

/** Shared DataFactory instance for creating RDF terms */
export const DF = new DataFactory();

/** XSD namespace URI */
export const xsd = 'http://www.w3.org/2001/XMLSchema#';

/** XSD boolean datatype as a NamedNode */
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);

/** XSD string datatype as a NamedNode */
export const datatypeString = DF.namedNode(`${xsd}string`);
