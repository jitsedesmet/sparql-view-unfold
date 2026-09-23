export const tripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?t a rdf:Statement ;
       rdf:Subject ?s ;
       rdf:Predicate ?p ;
       rdf:Object ?o ;
}
`;

export const nonTripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT WHERE {
  ?s ?p ?o .
}
`;

/**
 * Maps singleton properties to RDF 1.2 triple terms.
 * A singleton property (?prop) represents a unique occurrence of a property relationship
 * that carries annotations via rdf:singletonPropertyOf.
 */
export const singletonPropertyConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?prop rdf:reifies <<( ?s ?trueProp ?o )>>
} WHERE {
  ?s ?prop ?o .
  ?prop rdf:singletonPropertyOf ?trueProp .
}
`;

/**
 * Maps every triple to a triple term reified by its own predicate.
 *
 * Contrived as a mapping, but it is the smallest head that writes one variable both at the top level and
 * inside its triple term, which is what lets a pattern *decide a position* of that triple term: fixing
 * the reifier fixes the predicate of the value it reifies.
 */
export const predicateReifierConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?p rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?s ?p ?o .
}
`;

/**
 * Maps non-singleton triples (excluding singleton property predicates and their metadata)
 * to normal form for use alongside singletonPropertyConstruct.
 */
export const nonSingletonTripleConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  FILTER ( !isTriple(?o) ) .
  FILTER NOT EXISTS { ?p rdf:singletonPropertyOf ?trueProp . }
  FILTER NOT EXISTS { ?s rdf:singletonPropertyOf ?trueProp . }
}
`;

/**
 * Maps RDF reification (rdf:Statement / rdf:subject / rdf:predicate / rdf:object) to
 * RDF 1.2 triple terms (rdf:reifies).  Used as a mapper for BKR-Reification.ttl.
 */
export const bkrReificationConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?t rdf:type rdf:Statement ;
     rdf:subject ?s ;
     rdf:predicate ?p ;
     rdf:object ?o .
}
`;

/**
 * Passes through all triples that are NOT part of the reification structure itself
 * (rdf:type rdf:Statement, rdf:subject, rdf:predicate, rdf:object).  Annotation
 * property triples attached to the reification node (e.g. ?t derives_from ?source)
 * are kept because they are needed to answer annotation queries in RDF 1.2 form.
 *
 * Used alongside bkrReificationConstruct for BKR-Reification.ttl.
 */
export const bkrNonReificationConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  FILTER ( !isTriple(?o) ) .
  FILTER ( ?p != rdf:subject && ?p != rdf:predicate && ?p != rdf:object ) .
  FILTER ( ?p != rdf:type || ?o != rdf:Statement ) .
}
`;

/**
 * Non-singleton pass-through for BKR-Singleton.ttl.  Unlike nonSingletonTripleConstruct,
 * this variant does NOT exclude triples whose SUBJECT is a singleton property, because in
 * BKR data the singleton predicate blank node also appears as a subject carrying
 * annotation properties (e.g. ?singleton derives_from ?source).  Those must be preserved
 * in the RDF 1.2 view so annotation queries can match `?t derives_from ?source` where
 * `?t rdf:reifies <<( ?s ?p ?o )>>`.
 */
export const bkrNonSingletonConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  FILTER ( !isTriple(?o) ) .
  FILTER NOT EXISTS { ?p rdf:singletonPropertyOf ?trueProp . }
  FILTER ( ?p != rdf:singletonPropertyOf ) .
}
`;

export const testQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  :t rdf:reifies <<( :me :name ?name )>> .
  :t :statedBy :govBE .
  ?s ?p ?o .
  ?s1 ?s1 ?o1 .
}`;

export const expectedQuery = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    SELECT ( OBJECT( ?m_o ) AS ?uq_name ) WHERE {
      {
        {
          {
            {
              {
                {
                  SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
                    FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
                  }
                }
                BIND( ?mi_t AS ?m_s )
                BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
                BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
              }
              UNION {
                {
                  SELECT ?mi_o ?mi_p ?mi_s WHERE {
                    ?mi_s ?mi_p ?mi_o .
                  }
                }
                BIND( ?mi_s AS ?m_s )
                BIND( ?mi_p AS ?m_p )
                BIND( ?mi_o AS ?m_o )
              }
              FILTER ( SAMETERM( ?m_s , <https://example.com/t> ) )
            }
            FILTER ( SAMETERM( ?m_p , <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ) )
          }
          FILTER ( SAMETERM( <https://example.com/me> , SUBJECT( ?m_o ) ) )
        }
        FILTER ( SAMETERM( <https://example.com/name> , PREDICATE( ?m_o ) ) )
      }
      FILTER ( ISTRIPLE( ?m_o ) )
    }
  }
  {
    SELECT ( "dummy" AS ?mExists0 ) WHERE {
      {
        {
          {
            {
              SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
                FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
              }
            }
            BIND( ?mi_t AS ?m_s )
            BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
            BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
          }
          UNION {
            {
              SELECT ?mi_o ?mi_p ?mi_s WHERE {
                ?mi_s ?mi_p ?mi_o .
              }
            }
            BIND( ?mi_s AS ?m_s )
            BIND( ?mi_p AS ?m_p )
            BIND( ?mi_o AS ?m_o )
          }
          FILTER ( SAMETERM( ?m_s , <https://example.com/t> ) )
        }
        FILTER ( SAMETERM( ?m_p , <https://example.com/statedBy> ) )
      }
      FILTER ( SAMETERM( ?m_o , <https://example.com/govBE> ) )
    }
  }
  {
    SELECT ( ?m_o AS ?uq_o ) ( ?m_p AS ?uq_p ) ( ?m_s AS ?uq_s ) WHERE {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
            FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
          }
        }
        BIND( ?mi_t AS ?m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
        BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
      }
      UNION {
        {
          SELECT ?mi_o ?mi_p ?mi_s WHERE {
            ?mi_s ?mi_p ?mi_o .
          }
        }
        BIND( ?mi_s AS ?m_s )
        BIND( ?mi_p AS ?m_p )
        BIND( ?mi_o AS ?m_o )
      }
    }
  }
  {
    SELECT ( ?m_o AS ?uq_o1 ) ( ?m_p AS ?uq_s1 ) WHERE {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
            FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
          }
        }
        BIND( ?mi_t AS ?m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
        BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
      }
      UNION {
        {
          SELECT ?mi_o ?mi_p ?mi_s WHERE {
            ?mi_s ?mi_p ?mi_o .
          }
        }
        BIND( ?mi_s AS ?m_s )
        BIND( ?mi_p AS ?m_p )
        BIND( ?mi_o AS ?m_o )
      }
      FILTER ( SAMETERM( ?m_p , ?m_s ) )
    }
  }
}`;

export const expectedQueryToValues = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    SELECT ( OBJECT( ?m_o ) AS ?uq_name ) WHERE {
      {
        {
          {
            {
              {
                {
                  SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
                    ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
                    FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
                  }
                }
                BIND( ?mi_t AS ?m_s )
                BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
                BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
              }
              UNION {
                {
                  SELECT ?mi_o ?mi_p ?mi_s WHERE {
                    ?mi_s ?mi_p ?mi_o .
                  }
                }
                BIND( ?mi_s AS ?m_s )
                BIND( ?mi_p AS ?m_p )
                BIND( ?mi_o AS ?m_o )
              }
              FILTER ( SAMETERM( ?m_s , <https://example.com/t> ) )
            }
            FILTER ( SAMETERM( ?m_p , <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ) )
          }
          FILTER ( SAMETERM( <https://example.com/me> , SUBJECT( ?m_o ) ) )
        }
        FILTER ( SAMETERM( <https://example.com/name> , PREDICATE( ?m_o ) ) )
      }
      FILTER ( ISTRIPLE( ?m_o ) )
    }
  }
  {
    SELECT ( "dummy" AS ?mExists0 ) WHERE {
      {
        {
          {
            {
              SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
                ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
                FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
              }
            }
            BIND( ?mi_t AS ?m_s )
            BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
            BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
          }
          UNION {
            {
              SELECT ?mi_o ?mi_p ?mi_s WHERE {
                ?mi_s ?mi_p ?mi_o .
              }
            }
            BIND( ?mi_s AS ?m_s )
            BIND( ?mi_p AS ?m_p )
            BIND( ?mi_o AS ?m_o )
          }
          FILTER ( SAMETERM( ?m_s , <https://example.com/t> ) )
        }
        FILTER ( SAMETERM( ?m_p , <https://example.com/statedBy> ) )
      }
      FILTER ( SAMETERM( ?m_o , <https://example.com/govBE> ) )
    }
  }
  {
    SELECT ( ?m_o AS ?uq_o ) ( ?m_p AS ?uq_p ) ( ?m_s AS ?uq_s ) WHERE {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
            FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
          }
        }
        BIND( ?mi_t AS ?m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
        BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
      }
      UNION {
        {
          SELECT ?mi_o ?mi_p ?mi_s WHERE {
            ?mi_s ?mi_p ?mi_o .
          }
        }
        BIND( ?mi_s AS ?m_s )
        BIND( ?mi_p AS ?m_p )
        BIND( ?mi_o AS ?m_o )
      }
    }
  }
  {
    SELECT ( ?m_o AS ?uq_o1 ) ( ?m_p AS ?uq_s1 ) WHERE {
      {
        {
          SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
            ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
            FILTER ( ( ( ISBLANK( ?mi_s ) || ISIRI( ?mi_s ) ) && ISIRI( ?mi_p ) ) )
          }
        }
        BIND( ?mi_t AS ?m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
        BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
      }
      UNION {
        {
          SELECT ?mi_o ?mi_p ?mi_s WHERE {
            ?mi_s ?mi_p ?mi_o .
          }
        }
        BIND( ?mi_s AS ?m_s )
        BIND( ?mi_p AS ?m_p )
        BIND( ?mi_o AS ?m_o )
      }
      FILTER ( SAMETERM( ?m_p , ?m_s ) )
    }
  }
}`;

/**
 * Maps standard RDF 1.1 reification (`rdf:subject`, not the capitalised spelling of
 * {@link tripleTermConstruct}) to triple terms reified by the statement node.
 */
export const rdfReificationConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?t rdf:type rdf:Statement ;
     rdf:subject ?s ;
     rdf:predicate ?p ;
     rdf:object ?o .
}
`;

/** Passes through every triple that is not reification structure, complementing {@link rdfReificationConstruct}. */
export const nonReificationTripleConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  FILTER ( !isTriple(?o) ) .
  FILTER ( ?p != rdf:subject && ?p != rdf:predicate && ?p != rdf:object ) .
  FILTER ( ?p != rdf:type || ?o != rdf:Statement ) .
}
`;
