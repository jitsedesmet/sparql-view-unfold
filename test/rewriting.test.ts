import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import type { expect as Expect } from 'vitest';
import { transformExtendsToValues } from '../lib/transformations/extendsToValues.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import {
  transformContextFromConstructs,
} from '../lib/transformContext.js';
import {
  expectedQuery,
  expectedQueryToValues,
  nonTripleTermConstruct,
  predicateReifierConstruct,
  testQuery,
  tripleTermConstruct,
} from './queryConsts.js';

describe('dummy', () => {
  function transformQueryUsingConstructs(
    userQuery: string,
    mappers: string[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): string {
    const transformerContext = transformContextFromConstructs(mappers);
    return queryTransform(transformerContext, userQuery, transformations);
  }

  function testConstructMappers(
    expect: typeof Expect,
    userQuery: string,
    expectedQuery: string,
    mappers: string[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): void {
    expect(transformQueryUsingConstructs(userQuery, mappers, transformations).trim())
      .toEqual(expectedQuery.trim());

    // Const _expectedAst = parser.parse(expectedQuery);
    // const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
    // const _me = 2;
  }

  it('chain of unification through triple pattern', ({ expect }) => testConstructMappers(
    expect,
    'SELECT * { ?s <ex://p> <<(?s a "b")>> }',
    `SELECT ( ?uq_s AS ?s ) WHERE {
  SELECT ( <ex://x> AS ?uq_s ) WHERE {
    {
      {
        ?p0_mi_y ?p0_mi_y ?p0_mi_y .
        FILTER ( SAMETERM( <ex://x> , SUBJECT( ?p0_mi_y ) ) )
      }
      FILTER ( SAMETERM( <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> , PREDICATE( ?p0_mi_y ) ) )
    }
    FILTER ( SAMETERM( "b" , OBJECT( ?p0_mi_y ) ) )
  }
}`,
    [ 'CONSTRUCT { <ex://x> <ex://p> ?y } WHERE { ?y ?y ?y }' ],
  ));

  // A mapping head writing a triple term, unified with a pattern that binds it as a whole: the head
  // triple term is decomposed into a shape, and read back off it as the term the BIND constructs.
  it('mapping head triple term bound to a pattern variable', ({ expect }) => testConstructMappers(
    expect,
    'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT * { ?x rdf:reifies ?y }',
    `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
  SELECT ( ?p0_mi_t AS ?uq_x ) ( <<( ?p0_mi_s ?p0_mi_p ?p0_mi_o )>> AS ?uq_y ) WHERE {
    ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
    ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p0_mi_s .
    ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p0_mi_p .
    ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p0_mi_o .
  }
}`,
    [ tripleTermConstruct ],
  ));

  // Every position of that shape is a group of its own, so a position the pattern decides is written
  // into the constructed triple term rather than left to the variable naming it.
  it('a decided position is written into the constructed triple term', ({ expect }) => testConstructMappers(
    expect,
    `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
     PREFIX : <ex://>
     SELECT * { :knows rdf:reifies ?y }`,
    `SELECT ( ?uq_y AS ?y ) WHERE {
  SELECT ( <<( ?p0_mi_s <ex://knows> ?p0_mi_o )>> AS ?uq_y ) WHERE {
    ?p0_mi_s ?p0_mi_p ?p0_mi_o .
    FILTER ( SAMETERM( ?p0_mi_p , <ex://knows> ) )
  }
}`,
    [ predicateReifierConstruct ],
  ));

  it('simple pass through', ({ expect }) => testConstructMappers(
    expect,
    'SELECT * { ?s <ex://p> ?o }',
    `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  SELECT ( ?p0_mi_o AS ?uq_o ) ( ?p0_mi_s AS ?uq_s ) WHERE {
    ?p0_mi_s <ex://p> ?p0_mi_o .
  }
}`,
    [ 'CONSTRUCT WHERE { ?s <ex://p> ?o  }' ],
  ));

  // A SLICE (LIMIT/OFFSET) wraps the Project in the algebra, so it must be peeled to reach the
  // Project for variable renaming and re-applied afterwards - otherwise the outer projection is
  // skipped and columns keep their internal `uq_` names.
  it('pass through with LIMIT/OFFSET', ({ expect }) => testConstructMappers(
    expect,
    'SELECT * { ?s <ex://p> ?o } LIMIT 10 OFFSET 5',
    `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  SELECT ( ?p0_mi_o AS ?uq_o ) ( ?p0_mi_s AS ?uq_s ) WHERE {
    ?p0_mi_s <ex://p> ?p0_mi_o .
  }
}
LIMIT 10 OFFSET 5`,
    [ 'CONSTRUCT WHERE { ?s <ex://p> ?o  }' ],
  ));

  // A SLICE combined with DISTINCT must re-wrap in the right order: Slice(Distinct(Project(...))).
  it('pass through with DISTINCT and LIMIT', ({ expect }) => testConstructMappers(
    expect,
    'SELECT DISTINCT * { ?s <ex://p> ?o } LIMIT 10',
    `SELECT DISTINCT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  SELECT ( ?p0_mi_o AS ?uq_o ) ( ?p0_mi_s AS ?uq_s ) WHERE {
    ?p0_mi_s <ex://p> ?p0_mi_o .
  }
}
LIMIT 10`,
    [ 'CONSTRUCT WHERE { ?s <ex://p> ?o  }' ],
  ));

  it('simple', ({ expect }) =>
    testConstructMappers(expect, testQuery, expectedQuery, [ tripleTermConstruct, nonTripleTermConstruct ]));

  // TODO: and also push down VALUES constraint
  it('simple & toVALUES', ({ expect }) => testConstructMappers(
    expect,
    testQuery,
    expectedQueryToValues,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    [ operationTransform, transformExtendsToValues ],
  ));

  // It('simple & optimizeBinds', ({ expect }) => testConstructMappers(
  //   expect,
  //   testQuery,
  //   expectedQueryOptimizedBounds,
  //   [ tripleTermConstruct, nonTripleTermConstruct ],
  //   [ operationTransform, substituteVarsThatArePreBoundToTerms ],
  // ));
  //
  // it('simple & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => testConstructMappers(
  //   expect,
  //   testQuery,
  //   expectedQueryOptimizedBoundsAndEmptyRes,
  //   [ tripleTermConstruct, nonTripleTermConstruct ],
  //   [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
  // ));
  //
  // it('spo with blank in mapping head', ({ expect }) => {
  //   expect(() => transformQueryUsingConstructs(
  //     'SELECT * { { ?s <http://ex.org/a> ?a ; <http://ex.org/b> ?b } UNION { ?s <http://ex.org/b> ?b2 } }',
  //     [ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
  //   )).toThrow('Mapping head may not contain blank nodes');
  // });

//   It('sps with blank in mapping head', ({ expect }) => {
//     expect(() => transformQueryUsingConstructs(
//       `SELECT * { ?s ?p ?s }`,
//       [ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
//     )).toThrow();
//   });
//
//   it('sps with bnode creation in mapping body', ({ expect }) => {
//     expect(() => transformQueryUsingConstructs(
//       `SELECT * { ?s ?p ?s }`,
//       [ `CONSTRUCT { ?s ?p ?b } WHERE { ?s ?p ?o. EXTEND(bnode() as ?b) }` ],
//     )).toThrow();
//   });
//
//   it('handle no matching query', ({ expect }) => testConstructMappers(
//     expect,
//     `SELECT * { ?s <ex://a> ?o }`,
//     `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
//   {
//     FILTER ( FALSE )
//   }
//   UNION {
//     FILTER ( FALSE )
//   }
// }`,
//     [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
//   ));
//
//   it('handle no matching query & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => testConstructMappers(
//     expect,
//     `SELECT * { ?s <ex://a> ?o }`,
//     `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
//   FILTER ( FALSE )
// }`,
//     [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
//     [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
//   ));
//
//   it('pushUpBinds', ({ expect }) => testConstructMappers(
//     expect,
//     `SELECT * { ?s ?p ?o }`,
//     `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_s WHERE {
//         ?m0_s <ex://b> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o ?m1_s WHERE {
//         ?m1_s <ex://b> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( ?m1_s AS ?uq_s )
//   }
//   BIND( <ex://b> AS ?uq_p )
// }`,
//     [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://b> ?o }` ],
//     [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse, pullUpExtends ],
//   ));
//
//   it('no join optimization', ({ expect }) => testConstructMappers(
//     expect,
//     `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
//     `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//     BIND( <ex://a> AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://b> <ex://b> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://b> AS ?uq_p )
//     BIND( <ex://b> AS ?uq_s )
//   }
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//   }
// }`,
//     [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://b> ?o }` ],
//     [ operationTransform, transformFilterFalse ],
//   ));
//
//   describe('join over union optimizations', () => {
//     it('join optimization no-prune union branch', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//     BIND( <ex://a> AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://b> <ex://b> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://b> AS ?uq_p )
//     BIND( <ex://b> AS ?uq_s )
//   }
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://b> ?o }` ],
//       [ operationTransform, transformFilterFalse ],
//     ));
//
//     it('join optimization prune union branch', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//     BIND( <ex://a> AS ?uq_s )
//   }
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://b> ?o }` ],
//       [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
//     ));
//
//     it('join optimization 1', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//     BIND( <ex://a> AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://a> <ex://b> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://b> AS ?uq_p )
//     BIND( <ex://a> AS ?uq_s )
//   }
//   {
//     {
//       SELECT ?m0_o WHERE {
//         <ex://a> <ex://a> ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://a> AS ?uq_p )
//   }
//   UNION {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://a> <ex://b> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://b> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://a> <ex://b> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
//       [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
//     ));
//
//     it('nullifyJoinOverIncompatibleBounds - adding simple filter', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p WHERE {
//         VALUES ?m0_p {
//           <ex://c>
//         }
//         <ex://a> ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
//   {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://b> <ex://c> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
//       [
//         operationTransform,
//         transformFilterFalse,
//         nullifyJoinOverIncompatibleBounds,
//         transformFilterFalse,
//       ],
//     ));
//
//     it('nullifyJoinOverIncompatibleBounds - adding simple filter and optimizing',
//     ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p WHERE {
//         VALUES ?m0_p {
//           <ex://c>
//         }
//         <ex://a> ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
//   {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://b> <ex://c> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
//       [
//         operationTransform,
//         transformFilterFalse,
//         nullifyJoinOverIncompatibleBounds,
//         transformFilterFalse,
//         substituteVarsThatArePreBoundToTerms,
//       ],
//     ));
//
//     it('nullifyJoinOverIncompatibleBounds - adding || filter', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p WHERE {
//         VALUES ?m0_p {
//           <ex://c>
//           <ex://d>
//         }
//         <ex://a> ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//   }
//   {
//     {
//       SELECT ?m1_o WHERE {
//         <ex://b> <ex://c> ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
//   UNION {
//     {
//       SELECT ?m2_o WHERE {
//         <ex://b> <ex://d> ?m2_o .
//       }
//     }
//     BIND( ?m2_o AS ?uq_o )
//     BIND( <ex://d> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://d> ?o }` ],
//       [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
//     ));
//
//     it('nullifyJoinOverIncompatibleBounds - adding || filter on 2 vars', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p WHERE {
//         VALUES ?m0_o {
//           <ex://c>
//           <ex://d>
//         }
//         VALUES ?m0_p {
//           <ex://c>
//           <ex://d>
//         }
//         <ex://a> ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//   }
//   {
//     {
//       SELECT ( "dummy" AS ?dummy ) WHERE {
//         <ex://b> <ex://c> <ex://c> .
//       }
//     }
//     BIND( <ex://c> AS ?uq_o )
//     BIND( <ex://c> AS ?uq_p )
//   }
//   UNION {
//     {
//       SELECT ( "dummy" AS ?dummy ) WHERE {
//         <ex://b> <ex://d> <ex://d> .
//       }
//     }
//     BIND( <ex://d> AS ?uq_o )
//     BIND( <ex://d> AS ?uq_p )
//   }
// }`,
//       [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> <ex://c> }`, `CONSTRUCT WHERE { <ex://b> <ex://d> <ex://d> }` ],
//       [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
//     ));
//   });
//
//   describe('paths', () => {
//     it('algebra transformation on paths', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * {
//     ?s1 <ex://a> ?o1 .
//     ?s2 <ex://a>/<ex://b> ?o2.
//     ?s3 ^<ex://a> ?o3 .
//     ?s4 <ex://a> | <ex://b> ?o4 .
//     ?s5 !<ex://a> ?o5 .
//     ?s6 <ex://a>? ?o6 .
//     ?s7 <ex://a>* ?o7 .
//     ?s8 <ex://a>+ ?o8 .
//     ?s9 !(^<ex://a>|<ex://b>) ?o9 .
//
//     ?s10 <ex://a> | ^<ex://b> ?o10 .
// }`,
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o10 AS ?o10 ) ( ?uq_o2 AS ?o2 ) ( ?uq_o3 AS ?o3 )
//       ( ?uq_o4 AS ?o4 ) ( ?uq_o5 AS ?o5 ) ( ?uq_o6 AS ?o6 ) ( ?uq_o7 AS ?o7 ) ( ?uq_o8 AS ?o8 )
//       ( ?uq_o9 AS ?o9 ) ( ?uq_s1 AS ?s1 )
//       ( ?uq_s10 AS ?s10 ) ( ?uq_s2 AS ?s2 ) ( ?uq_s3 AS ?s3 ) ( ?uq_s4 AS ?s4 ) ( ?uq_s5 AS ?s5 ) ( ?uq_s6 AS ?s6 )
//       ( ?uq_s7 AS ?s7 ) ( ?uq_s8 AS ?s8 ) ( ?uq_s9 AS ?s9 ) WHERE {
//   ?uq_s1 <ex://a> ?uq_o1 .
//   ?uq_s2 <ex://a> ?uq_var0 .
//   ?uq_var0 <ex://b> ?uq_o2 .
//   ?uq_o3 <ex://a> ?uq_s3 .
//   ?uq_s4 (<ex://a>|<ex://b>) ?uq_o4 .
//   ?uq_s5 (!(<ex://a>)) ?uq_o5 .
//   ?uq_s6 (<ex://a>?) ?uq_o6 .
//   ?uq_s7 (<ex://a>*) ?uq_o7 .
//   ?uq_s8 (<ex://a>+) ?uq_o8 .
//   ?uq_s9 (!(<ex://b>|^<ex://a>)) ?uq_o9 .
//   ?uq_s10 (<ex://a>|(^<ex://b>)) ?uq_o10 .
// }`,
//       [],
//       [],
//     ));
//
//     it('algebra transformation on paths only leaving * and +', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * {
//     ?s1 <ex://a> ?o1 .
//     ?s2 <ex://a>/<ex://b> ?o2.
//     ?s3 ^<ex://a> ?o3 .
//     ?s4 <ex://a> | <ex://b> ?o4 .
//     ?s5 !<ex://a> ?o5 .
//     ?s6 <ex://a>? ?o6 .
//     ?s7 <ex://a>* ?o7 .
//     ?s8 <ex://a>+ ?o8 .
//     ?s9 !(^<ex://a>|<ex://b>) ?o9 .
//
//     ?s10 <ex://a> | ^<ex://b> ?o10 .
//     ?s5 !(<ex://a>|<ex://b>) ?o5 .
// }`,
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o10 AS ?o10 ) ( ?uq_o2 AS ?o2 ) ( ?uq_o3 AS ?o3 ) ( ?uq_o4 AS ?o4 )
//       ( ?uq_o5 AS ?o5 ) ( ?uq_o6 AS ?o6 ) ( ?uq_o7 AS ?o7 ) ( ?uq_o8 AS ?o8 ) ( ?uq_o9 AS ?o9 ) ( ?uq_s1 AS ?s1 )
//       ( ?uq_s10 AS ?s10 ) ( ?uq_s2 AS ?s2 ) ( ?uq_s3 AS ?s3 ) ( ?uq_s4 AS ?s4 ) ( ?uq_s5 AS ?s5 ) ( ?uq_s6 AS ?s6 )
//       ( ?uq_s7 AS ?s7 ) ( ?uq_s8 AS ?s8 ) ( ?uq_s9 AS ?s9 ) WHERE {
//   ?uq_s1 <ex://a> ?uq_o1 .
//   ?uq_s2 <ex://a> ?uq_var0 .
//   ?uq_var0 <ex://b> ?uq_o2 .
//   ?uq_o3 <ex://a> ?uq_s3 .
//   {
//     ?uq_s4 <ex://a> ?uq_o4 .
//   }
//   UNION {
//     ?uq_s4 <ex://b> ?uq_o4 .
//   }
//   {
//     ?uq_s5 ?rewrite_0 ?uq_o5 .
//     FILTER ( ( ?rewrite_0 NOT IN ( <ex://a> ) ) )
//   }
//   {
//     ?uq_s6 <ex://a> ?uq_o6 .
//   }
//   UNION {
//     {
//       SELECT DISTINCT ?uq_s6 WHERE {
//         {
//           ?uq_s6 ?p_uq_s6 ?o_uq_s6 .
//         }
//         UNION {
//           ?o_uq_s6 ?p_uq_s6 ?uq_s6 .
//         }
//       }
//     }
//     BIND( ?uq_s6 AS ?uq_o6 )
//   }
//   ?uq_s7 (<ex://a>*) ?uq_o7 .
//   ?uq_s8 (<ex://a>+) ?uq_o8 .
//   {
//     ?uq_s9 ?rewrite_1 ?uq_o9 .
//     FILTER ( ( ?rewrite_1 NOT IN ( <ex://b> ) ) )
//   }
//   UNION {
//     ?uq_o9 ?rewrite_2 ?uq_s9 .
//     FILTER ( ( ?rewrite_2 NOT IN ( <ex://a> ) ) )
//   }
//   {
//     ?uq_s10 <ex://a> ?uq_o10 .
//   }
//   UNION {
//     ?uq_o10 <ex://b> ?uq_s10 .
//   }
//   {
//     ?uq_s5 ?rewrite_3 ?uq_o5 .
//     FILTER ( ( ?rewrite_3 NOT IN ( <ex://a> , <ex://b> ) ) )
//   }
// }`,
//       [],
//       [ rewriteNonRecursivePaths ],
//     ));
//   });
//
//   it('does not emit infinite recursion', ({ expect }) => testConstructMappers(
//     expect,
//     `SELECT * { ?s ?p ?s }`,
//     `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   FILTER ( FALSE )
// }`,
//     [ `CONSTRUCT { ?s ?p <<( ?s ?x ?y )>> } WHERE { ?s ?p ?x , ?y . }` ],
//   ));
//
//   it('works on simple transforms using mappers', ({ expect }) => testMappers(
//     expect,
//     `SELECT * { ?s <ex://a> ?o }`,
//     `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
//   {
//     FILTER ( FALSE )
//   }
//   UNION {
//     FILTER ( FALSE )
//   }
// }`,
//     // [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
//     [{
//       head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.namedNode('ex://b'), c.DF.variable('o')),
//       body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  <ex://b> ?o }'),
//     }, {
//       head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.namedNode('ex://c'), c.DF.variable('o')),
//       body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  <ex://c> ?o }'),
//     }],
//   ));
//
//   describe('templates', () => {
//     it('templateIris', ({ expect }) => testMappers(
//       expect,
//       `SELECT * { ?s ?p <ex://a> }`,
//       `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p <ex://b> .
//         FILTER ( ( <ex://a> = IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) ) )
//       }
//     }
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_p ?m1_s WHERE {
//         ?m1_s ?m1_p <ex://c> .
//         FILTER ( ( <ex://a> = IRI( CONCAT( "example://" , STR( ?m1_s ) ) ) ) )
//       }
//     }
//     BIND( ?m1_p AS ?uq_p )
//     BIND( ?m1_s AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m2_p ?m2_s WHERE {
//         ?m2_s ?m2_p <ex://c> .
//         FILTER ( ( <ex://a> = IRI( CONCAT( STR( ?m2_s ) ) ) ) )
//       }
//     }
//     BIND( ?m2_p AS ?uq_p )
//     BIND( ?m2_s AS ?uq_s )
//   }
//   UNION {
//     FILTER ( FALSE )
//   }
// }`,
//       [{
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
//           [ 'ex://', c.DF.variable('s') ],
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
//       }, {
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
//           [ 'example://', c.DF.variable('s') ],
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
//       }, {
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
//           [ c.DF.variable('s') ],
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
//       }, {
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createMappingHead(
//           c.DF.variable('s'),
//           c.DF.variable('p'),
//           c.DF.namedNode('ex://d'),
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
//       }],
//     ));
//
//     it('templateLiteral generates STRDT with datatype argument', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p ?o }',
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p <ex://b> .
//     }
//   }
//   BIND( STRDT( CONCAT( "ex://" , STR( ?m0_s ) ) , <http://www.w3.org/2001/XMLSchema#string> ) AS ?uq_o )
//   BIND( ?m0_p AS ?uq_p )
//   BIND( ?m0_s AS ?uq_s )
// }`,
//       [{
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateLiteral(
//           [ 'ex://', c.DF.variable('s') ],
//           c.DF.namedNode('http://www.w3.org/2001/XMLSchema#string'),
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p <ex://b> }'),
//       }],
//     ));
//
//     it('nested TemplateQuad in head matches nested triple term in user query', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?y <<( <ex://a> <ex://b> ?z )>> }',
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) ( ?uq_z AS ?z ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p <ex://a> .
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_p AS ?uq_y )
//   BIND( IRI( CONCAT( STR( ?m0_s ) ) ) AS ?uq_z )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.DF.variable('s'),
//           c.DF.variable('p'),
//           c.AF.createMappingHead(
//             c.DF.namedNode('ex://a'),
//             c.DF.namedNode('ex://b'),
//             c.AF.createTemplateIri([ c.DF.variable('s') ]),
//           ),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
//       }],
//     ));
//
//     it('template mapping simple', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p ?o }',
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p <ex://b> .
//     }
//   }
//   BIND( IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) AS ?uq_o )
//   BIND( ?m0_p AS ?uq_p )
//   BIND( ?m0_s AS ?uq_s )
// }`,
//       [{
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
//           [ 'ex://', c.DF.variable('s') ],
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
//       }],
//     ));
//
//     it('template sps', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s  ?p ?s }',
//       `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p <ex://b> .
//       FILTER ( ( ?m0_s = IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) ) )
//     }
//   }
//   BIND( ?m0_p AS ?uq_p )
//   BIND( ?m0_s AS ?uq_s )
// }`,
//       [{
//         head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
//           [ 'ex://', c.DF.variable('s') ],
//         )),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
//       }],
//     ));
//
//     it('two templates equal all', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?x ?x }',
//       `SELECT ( ?uq_x AS ?x ) WHERE {
//   {
//     SELECT ?m0_p WHERE {
//       {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) ) )
//       }
//       FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_o ) , STR( ?m0_p ) ) ) ) )
//     }
//   }
//   BIND( ?m0_p AS ?uq_x )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
//           c.DF.variable('p'),
//           c.AF.createTemplateIri([ c.DF.variable('o'), c.DF.variable('p') ]),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//     ));
//
//     it('template with containing var being bound', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x <ex://a> ?y }',
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_p ?m0_s WHERE {
//       {
//         BIND( <ex://a> AS ?m0_p )
//       }
//       ?m0_s ?m0_p ?m0_o .
//     }
//   }
//   BIND( IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//     ));
//
//     it('two templates but not equal to each other', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?y ?y }',
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p ?m0_o .
//       FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_o ) ) ) ) )
//     }
//   }
//   BIND( IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) AS ?uq_x )
//   BIND( ?m0_p AS ?uq_y )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
//           c.DF.variable('p'),
//           c.AF.createTemplateIri([ c.DF.variable('o') ]),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//     ));
//
//     it('quad in mapping head', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?y ?z }',
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) ( ?uq_z AS ?z ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p <ex://a> .
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_p AS ?uq_y )
//   BIND( TRIPLE( <ex://a> , <ex://b> , IRI( CONCAT( STR( ?m0_s ) ) ) ) AS ?uq_z )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.DF.variable('s'),
//           c.DF.variable('p'),
//           c.AF.createMappingHead(
//             c.DF.namedNode('ex://a'),
//             c.DF.namedNode('ex://b'),
//             c.AF.createTemplateIri([ c.DF.variable('s') ]),
//           ),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
//       }],
//     ));
//
//     it('template equals term through connecting TP var', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?p ?x }',
//       `SELECT ( ?uq_p AS ?p ) ( ?uq_x AS ?x ) WHERE {
//   {
//     SELECT ?m0_p WHERE {
//       ?m0_s ?m0_p <ex://a> .
//       FILTER ( ( <ex://apple> = IRI( CONCAT( STR( ?m0_s ) ) ) ) )
//     }
//   }
//   BIND( ?m0_p AS ?uq_p )
//   BIND( <ex://apple> AS ?uq_x )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateIri([ c.DF.variable('s') ]),
//           c.DF.variable('p'),
//           c.DF.namedNode('ex://apple'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
//       }],
//     ));
//
//     it('does not generate conditions twice on group through connecting var', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?x ?x ?x }',
//       `SELECT ( ?uq_x AS ?x ) WHERE {
//   {
//     SELECT ( "dummy" AS ?dummy ) WHERE {
//       {
//         BIND( <ex://apple> AS ?m0_p )
//       }
//       ?m0_s ?m0_p <ex://a> .
//       FILTER ( ( <ex://apple> = IRI( CONCAT( STR( ?m0_s ) ) ) ) )
//     }
//   }
//   BIND( <ex://apple> AS ?uq_x )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateIri([ c.DF.variable('s') ]),
//           c.DF.variable('p'),
//           c.DF.namedNode('ex://apple'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
//       }],
//     ));
//
//     it('blankNode template generation', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p1 ?o1 ; ?p2 ?o2 }',
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o2 AS ?o2 ) ( ?uq_p1 AS ?p1 ) ( ?uq_p2 AS ?p2 ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o1 )
//     BIND( ?m0_p AS ?uq_p1 )
//     BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o ?m1_p ?m1_s WHERE {
//         ?m1_s ?m1_p ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o1 )
//     BIND( ?m1_p AS ?uq_p1 )
//     BIND( ?m1_s AS ?uq_s )
//   }
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o2 )
//     BIND( ?m0_p AS ?uq_p2 )
//     BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
//   }
//   UNION {
//     {
//       SELECT ?m1_o ?m1_p ?m1_s WHERE {
//         ?m1_s ?m1_p ?m1_o .
//       }
//     }
//     BIND( ?m1_o AS ?uq_o2 )
//     BIND( ?m1_p AS ?uq_p2 )
//     BIND( ?m1_s AS ?uq_s )
//   }
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateBlank([ c.DF.variable('s'), c.DF.variable('p') ]),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }, {
//         head: c.AF.createMappingHead(
//           c.DF.variable('s'),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//     ));
//
//     it('blankNode template followed by bnode filter', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o1 )
//     BIND( ?m0_p AS ?uq_p1 )
//     BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
//   }
//   FILTER ( ISBLANK( ?uq_s ) )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateBlank([ c.DF.variable('s'), c.DF.variable('p') ]),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//     ));
//
//     it('blankNode template followed by bnode filter rewritten to term', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o1 )
//     BIND( ?m0_p AS ?uq_p1 )
//     BIND( STRDT( CONCAT( IF( ISIRI( ?m0_s ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?m0_s ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?m0_s ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?m0_s ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?uq_s )
//   }
//   FILTER ( ( DATATYPE( ?uq_s ) = <https://sparql-extension.knows.idlab.ugent.be/bnode> ) )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateBlank([ c.DF.variable('s') ]),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//       [ operationTransform, internalBnodeAsSpecialLiteral ],
//     ));
//
//     it('blankNode template followed by bnode filter rewritten to iri', ({ expect }) => testMappers(
//       expect,
//       'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
//       `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//       }
//     }
//     BIND( ?m0_o AS ?uq_o1 )
//     BIND( ?m0_p AS ?uq_p1 )
//     BIND( IRI( CONCAT( "https://myInternalBnode.example.org/" , SHA1( CONCAT( IF( ISIRI( ?m0_s ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?m0_s ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?m0_s ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?m0_s ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) ) ) ) AS ?uq_s )
//   }
//   FILTER ( ( ISIRI( ?uq_s ) && STRSTARTS( STR( ?uq_s ) , "https://myInternalBnode.example.org/" ) ) )
// }`,
//       [{
//         head: c.AF.createMappingHead(
//           c.AF.createTemplateBlank([ c.DF.variable('s') ]),
//           c.DF.variable('p'),
//           c.DF.variable('o'),
//         ),
//         body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s ?p ?o }'),
//       }],
//       [ operationTransform, internalBnodeAsSpecialIri ],
//     ));
//   });
//
//   describe('bind/values in mapping body on head variables', () => {
//     it('bind in mapping body on head variable - simple query', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://test> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         BIND( <ex://test> AS ?m0_p )
//       }
//       {
//         ?m0_x ?m0_p ?m0_o .
//         BIND( IRI( CONCAT( "http://example.org/" , STR( ?m0_x ) ) ) AS ?m0_s )
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { ?x ?p ?o . BIND(IRI(CONCAT("http://example.org/", STR(?x))) AS ?s) }` ],
//     ));
//
//     it('bind in mapping body when user query has constant subject', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <http://example.org/foo> <ex://test> ?b }`,
//       `SELECT ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o WHERE {
//       {
//         BIND( <ex://test> AS ?m0_p )
//         BIND( <http://example.org/foo> AS ?m0_s )
//       }
//       {
//         ?m0_x ?m0_p ?m0_o .
//         BIND( IRI( CONCAT( "http://example.org/" , STR( ?m0_x ) ) ) AS ?m0_s )
//       }
//     }
//   }
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { ?x ?p ?o . BIND(IRI(CONCAT("http://example.org/", STR(?x))) AS ?s) }` ],
//       [ operationTransform ],
//     ));
//
//     it('bind in mapping body when user query has constant subject & optimize terms', ({ expect }) =>
//       testConstructMappers(
//         expect,
//       `SELECT * { <http://example.org/foo> <ex://test> ?b }`,
//       `SELECT ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o WHERE {
//       {
//         ?m0_x <ex://test> ?m0_o .
//         FILTER ( ( IRI( CONCAT( "http://example.org/" , STR( ?m0_x ) ) ) = <http://example.org/foo> ) )
//       }
//     }
//   }
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { ?x ?p ?o . BIND(IRI(CONCAT("http://example.org/", STR(?x))) AS ?s) }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('values in mapping body on head variable', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?x ?p ?y }`,
//       `SELECT ( ?uq_p AS ?p ) ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_p ?m0_s WHERE {
//       VALUES ?m0_p {
//         <ex://a>
//         <ex://b>
//       }
//       ?m0_s ?m0_p ?m0_o .
//     }
//   }
//   BIND( ?m0_p AS ?uq_p )
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?p { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//     ));
//
//     it('values in mapping body when user query constrains the same variable', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?x <ex://a> ?y }`,
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         BIND( <ex://a> AS ?m0_p )
//       }
//       VALUES ?m0_p {
//         <ex://a>
//         <ex://b>
//       }
//       ?m0_s ?m0_p ?m0_o .
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?p { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//     ));
//
//     it('values in mapping body with user query constant not in VALUES set', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { ?x <ex://c> ?y }`,
//       `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         BIND( <ex://c> AS ?m0_p )
//       }
//       VALUES ?m0_p {
//         <ex://a>
//         <ex://b>
//       }
//       ?m0_s ?m0_p ?m0_o .
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?p { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//     ));
//
//     it('bind in mapping body creates value that must match user constant', ({ expect }) => testConstructMappers(
//       expect,
//       `SELECT * { <ex://differentValue> <ex://p> ?b }`,
//       `SELECT ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o WHERE {
//       {
//         BIND( <ex://p> AS ?m0_p )
//         BIND( <ex://differentValue> AS ?m0_s )
//       }
//       {
//         ?m0_x ?m0_p ?m0_o .
//         BIND( <ex://computedValue> AS ?m0_s )
//       }
//     }
//   }
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { ?x ?p ?o . BIND(<ex://computedValue> AS ?s) }` ],
//     ));
//
//     it('values in mapping body with variable unification (same user var in two positions)', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?x ?x ?y }`,
//         `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?rm0_s_AND_p WHERE {
//       VALUES ?rm0_s_AND_p {
//         <ex://a>
//         <ex://b>
//       }
//       ?rm0_s_AND_p ?rm0_s_AND_p ?m0_o .
//     }
//   }
//   BIND( ?rm0_s_AND_p AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?s { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//       ));
//
//     it('mapping head same var in two positions, user query uses different vars', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?a ?p ?b }`,
//         `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) ( ?uq_p AS ?p ) WHERE {
//   {
//     SELECT ?m0_p ?m0_s WHERE {
//       ?m0_s ?m0_p ?m0_s .
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_s AS ?uq_b )
//   BIND( ?m0_p AS ?uq_p )
// }`,
//         [ `CONSTRUCT WHERE { ?s ?p ?s }` ],
//       ));
//
//     it('optimize terms substitutes variables that appear only in triple patterns', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { <ex://foo> <ex://p> ?o }`,
//         `SELECT ( ?uq_o AS ?o ) WHERE {
//   {
//     SELECT ?m0_o WHERE {
//       <ex://foo> <ex://p> ?m0_o .
//     }
//   }
//   BIND( ?m0_o AS ?uq_o )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('optimize terms substitutes variable in VALUES clause when term is in the set', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?x <ex://a> ?y }`,
//         `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       ?m0_s <ex://a> ?m0_o .
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?p { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('optimize terms emits FILTER(false) when term is not in VALUES set', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?x <ex://c> ?y }`,
//         `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       FILTER ( FALSE )
//     }
//   }
//   BIND( ?m0_s AS ?uq_x )
//   BIND( ?m0_o AS ?uq_y )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES ?p { <ex://a> <ex://b> } ?s ?p ?o . }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('optimize terms prunes rows and removes variable from multi-variable VALUES', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?a <ex://a> ?b }`,
//         `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       VALUES ?m0_s {
//         <ex://x>
//       }
//       ?m0_s <ex://a> ?m0_o .
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES (?p ?s) { (<ex://a> <ex://x>) (<ex://b> <ex://y>) } ?s ?p ?o . }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('optimize terms emits FILTER(false) when term not in multi-variable VALUES set', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?a <ex://c> ?b }`,
//         `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       FILTER ( FALSE )
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//         [ `CONSTRUCT { ?s ?p ?o } WHERE { VALUES (?p ?s) { (<ex://a> <ex://x>) (<ex://b> <ex://y>) } ?s ?p ?o . }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//       ));
//
//     it('terms emits can handle queries using aggregates', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT * { ?a <ex://c> ?b }`,
//         `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_count ?m0_s WHERE {
//       {
//         BIND( <ex://c> AS ?m0_p )
//       }
//       {
//         SELECT ?m0_s ?m0_p ( COUNT( ?m0_o ) AS ?m0_count ) WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//         GROUP BY ?m0_s?m0_p
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_count AS ?uq_b )
// }`,
//         [ `CONSTRUCT { ?s ?p ?count } WHERE {
//   { SELECT ?s ?p (COUNT(?o) AS ?count) { ?s ?p ?o } GROUP BY ?s ?p }
// }` ],
//         [ operationTransform ],
//       ));
//   });
//
//   it('optimize terms emits can handle queries using aggregates', ({ expect }) =>
//     testConstructMappers(
//       expect,
//         `SELECT * { ?a <ex://c> ?b }`,
//         `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_count ?m0_s WHERE {
//       {
//         SELECT ?m0_s ( COUNT( ?m0_o ) AS ?m0_count ) WHERE {
//           ?m0_s <ex://c> ?m0_o .
//         }
//         GROUP BY ?m0_s
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_count AS ?uq_b )
// }`,
//         [ `CONSTRUCT { ?s ?p ?count } WHERE {
//   { SELECT ?s ?p (COUNT(?o) AS ?count) { ?s ?p ?o } GROUP BY ?s ?p }
// }` ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   it('optimize terms substitutes predicate into ORDER BY of a subquery', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://c> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         SELECT ?m0_s ?m0_o WHERE {
//           ?m0_s <ex://c> ?m0_o .
//         }
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?p }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   it('optimize terms propagates substitution through two levels of nested subqueries', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://c> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         SELECT ?m0_s ?m0_o WHERE {
//           SELECT ?m0_s ?m0_o WHERE {
//             ?m0_s <ex://c> ?m0_o .
//           }
//         }
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { { SELECT ?s ?p ?o WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } } } }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   it('optimize terms substitutes predicate in OPTIONAL branch of a subquery', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://c> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       ?m0_s <ex://x> ?m0_o .
//       OPTIONAL {
//         ?m0_s <ex://c> ?m0_o .
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { ?s <ex://x> ?o . OPTIONAL { ?s ?p ?o } }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   it('optimize terms substitutes predicate variable inside FILTER condition of a subquery', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://c> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_o ?m0_s WHERE {
//       {
//         SELECT ?m0_s ?m0_o WHERE {
//           ?m0_s <ex://c> ?m0_o .
//           FILTER ( ( <ex://c> = <ex://c> ) )
//         }
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_o AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(?p = <ex://c>) } }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   it('optimize terms substitutes predicate in aggregate subquery with HAVING', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a <ex://c> ?b }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) WHERE {
//   {
//     SELECT ?m0_count ?m0_s WHERE {
//       {
//         SELECT ?m0_s ( COUNT( ?m0_o ) AS ?m0_count ) WHERE {
//           ?m0_s <ex://c> ?m0_o .
//         }
//         GROUP BY ?m0_s
//         HAVING ( COUNT( ?m0_o ) > "5"^^<http://www.w3.org/2001/XMLSchema#integer> )
//       }
//     }
//   }
//   BIND( ?m0_s AS ?uq_a )
//   BIND( ?m0_count AS ?uq_b )
// }`,
//       [ `CONSTRUCT { ?s ?p ?count } WHERE {
//   { SELECT ?s ?p (COUNT(?o) AS ?count) { ?s ?p ?o } GROUP BY ?s ?p HAVING(COUNT(?o) > 5) }
// }` ],
//       [ operationTransform, substituteVarsThatArePreBoundToTerms ],
//     ));
//
//   describe('user query with GROUP BY aggregation', () => {
//     const spoConstruct = `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }`;
//
//     it('basic group by in user query produces valid subSELECT', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with multiple projected vars', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?p (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s ?p`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_p AS ?p ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ?uq_p ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s?uq_p
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with HAVING', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s HAVING (COUNT(?o) > 5)`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//   }
//   GROUP BY ?uq_s
//   HAVING ( COUNT( ?uq_o ) > "5"^^<http://www.w3.org/2001/XMLSchema#integer> )
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with ORDER BY', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s ORDER BY DESC(?count)`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
//   ORDER BY DESC ( ?uq_count )
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('select DISTINCT with GROUP BY', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT DISTINCT ?s (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s`,
//         `SELECT DISTINCT ( ?uq_s AS ?s ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with unprojected group variable', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?s`,
//         `SELECT ( ?uq_count AS ?count ) WHERE {
//   SELECT ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with multiple aggregates', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (COUNT(?o) AS ?cnt) (SUM(?o) AS ?sm) WHERE { ?s ?p ?o } GROUP BY ?s`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_cnt AS ?cnt ) ( ?uq_sm AS ?sm ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_cnt ) ( SUM( ?uq_o ) AS ?uq_sm ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('group by with substituteVarsThatArePreBoundToTerms optimization', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (COUNT(?o) AS ?count) WHERE { ?s <ex://p> ?o } GROUP BY ?s`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_count AS ?count ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_count ) WHERE {
//     {
//       SELECT ?m0_o ?m0_s WHERE {
//         {
//           ?m0_s <ex://p> ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
//       ));
//   });
//
//   describe('user query with GROUP BY aggregation in subquery', () => {
//     const spoConstruct = `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }`;
//
//     it('inner subquery with GROUP BY projecting aggregate is correctly rewritten', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?c WHERE { { SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s } }`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_c AS ?c ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_c ) WHERE {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('inner subquery with GROUP BY and HAVING is correctly rewritten', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?c WHERE
//         { { SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s HAVING (COUNT(?o) > 3) } }`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_c AS ?c ) WHERE {
//   SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_c ) WHERE {
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//   }
//   GROUP BY ?uq_s
//   HAVING ( COUNT( ?uq_o ) > "3"^^<http://www.w3.org/2001/XMLSchema#integer> )
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('inner subquery with GROUP BY HAVING that does not project the aggregate', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?p WHERE { ?s ?p ?o . { SELECT ?o WHERE { ?s ?p ?o } GROUP BY ?s ?p HAVING (COUNT(?o) > 10) } }`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_p AS ?p ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   {
//     SELECT ?uq_o WHERE {
//       {
//         {
//           SELECT ?m0_o ?m0_p ?m0_s WHERE {
//             ?m0_s ?m0_p ?m0_o .
//             FILTER ( ! ISTRIPLE( ?m0_o ) )
//           }
//         }
//         BIND( ?m0_o AS ?uq_o )
//         BIND( ?m0_p AS ?uq_p )
//         BIND( ?m0_s AS ?uq_s )
//       }
//     }
//     GROUP BY ?uq_s?uq_p
//     HAVING ( COUNT( ?uq_o ) > "10"^^<http://www.w3.org/2001/XMLSchema#integer> )
//   }
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('inner and outer GROUP BY are both rewritten correctly (user example)', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?p WHERE
//         { ?s ?p ?o . { SELECT ?o WHERE { ?s ?p ?o } GROUP BY ?s ?p HAVING (COUNT(?o) > 10) } }
//         GROUP BY ?s ?p HAVING (COUNT(?o) > 5)`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_p AS ?p ) WHERE {
//   SELECT ?uq_s ?uq_p WHERE {
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//     {
//       SELECT ?uq_o WHERE {
//         {
//           {
//             SELECT ?m0_o ?m0_p ?m0_s WHERE {
//               ?m0_s ?m0_p ?m0_o .
//               FILTER ( ! ISTRIPLE( ?m0_o ) )
//             }
//           }
//           BIND( ?m0_o AS ?uq_o )
//           BIND( ?m0_p AS ?uq_p )
//           BIND( ?m0_s AS ?uq_s )
//         }
//       }
//       GROUP BY ?uq_s?uq_p
//       HAVING ( COUNT( ?uq_o ) > "10"^^<http://www.w3.org/2001/XMLSchema#integer> )
//     }
//   }
//   GROUP BY ?uq_s?uq_p
//   HAVING ( COUNT( ?uq_o ) > "5"^^<http://www.w3.org/2001/XMLSchema#integer> )
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('outer aggregate over inner subquery aggregate is correctly rewritten', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s (SUM(?c) AS ?total)
//         WHERE { { SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s } } GROUP BY ?s`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_total AS ?total ) WHERE {
//   SELECT ?uq_s ( SUM( ?uq_c ) AS ?uq_total ) WHERE {
//     SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_c ) WHERE {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//     GROUP BY ?uq_s
//   }
//   GROUP BY ?uq_s
// }`,
//         [ spoConstruct ],
//       ));
//
//     it('inner subquery aggregate is joined with outer BGP (no outer GROUP BY)', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         `SELECT ?s ?c WHERE { ?s ?p ?o . { SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s } }`,
//         `SELECT ( ?uq_s AS ?s ) ( ?uq_c AS ?c ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_p ?m0_s WHERE {
//         ?m0_s ?m0_p ?m0_o .
//         FILTER ( ! ISTRIPLE( ?m0_o ) )
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_p AS ?uq_p )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   {
//     SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_c ) WHERE {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//     GROUP BY ?uq_s
//   }
// }`,
//         [ spoConstruct ],
//       ));
//
//     it(
//       'substituteVarsThatArePreBoundToTerms
//       applies to outer BGP; inner GROUP BY subquery is rewritten independently',
//       ({ expect }) => testConstructMappers(
//         expect,
//         `SELECT ?c WHERE { ?s <ex://p> ?o . { SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s } }`,
//         `SELECT ( ?uq_c AS ?c ) WHERE {
//   {
//     {
//       SELECT ?m0_o ?m0_s WHERE {
//         {
//           ?m0_s <ex://p> ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//     }
//     BIND( ?m0_o AS ?uq_o )
//     BIND( ?m0_s AS ?uq_s )
//   }
//   {
//     SELECT ?uq_s ( COUNT( ?uq_o ) AS ?uq_c ) WHERE {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//           FILTER ( ! ISTRIPLE( ?m0_o ) )
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//     GROUP BY ?uq_s
//   }
// }`,
//         [ spoConstruct ],
//         [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
//       ),
//     );
//   });
//
//   it('service calls can be pushed up on the same service', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?a ?b ?c ; <ex://x> ?y . }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) ( ?uq_c AS ?c ) ( ?uq_y AS ?y ) WHERE {
//   SERVICE <ex://a> {
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_s AS ?uq_a )
//       BIND( ?m0_p AS ?uq_b )
//       BIND( ?m0_o AS ?uq_c )
//     }
//     {
//       {
//         SELECT ?m0_o ?m0_s WHERE {
//           VALUES ?m0_p {
//             <ex://x>
//           }
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_s AS ?uq_a )
//       BIND( ?m0_o AS ?uq_y )
//     }
//   }
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <ex://a> { ?s ?p ?o } }` ],
//       [ operationTransform, transformExtendsToValues, transformServiceCallPushUp ],
//     ));
//
//   it('vALUES clause placed before the triple is pushed inside the SERVICE', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { VALUES ?p { <ex://x> } . ?s ?p ?o }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   SERVICE <ex://a> {
//     VALUES ?uq_p {
//       <ex://x>
//     }
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//   }
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <ex://a> { ?s ?p ?o } }` ],
//       [ operationTransform, transformExtendsToValues, transformServiceCallPushUp ],
//     ));
//
//   it('vALUES clause placed after the triple is pushed inside the SERVICE', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { ?s ?p ?o . VALUES ?p { <ex://x> } }`,
//       `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
//   SERVICE <ex://a> {
//     VALUES ?uq_p {
//       <ex://x>
//     }
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_o AS ?uq_o )
//       BIND( ?m0_p AS ?uq_p )
//       BIND( ?m0_s AS ?uq_s )
//     }
//   }
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <ex://a> { ?s ?p ?o } }` ],
//       [ operationTransform, transformExtendsToValues, transformServiceCallPushUp ],
//     ));
//
//   it('vALUES clause is pushed into a SERVICE that covers multiple joined patterns', ({ expect }) =>
//     testConstructMappers(
//       expect,
//       `SELECT * { VALUES ?p { <ex://x> } . ?a ?p ?c . ?a ?b ?d }`,
//       `SELECT ( ?uq_a AS ?a ) ( ?uq_b AS ?b ) ( ?uq_c AS ?c ) ( ?uq_d AS ?d ) ( ?uq_p AS ?p ) WHERE {
//   SERVICE <ex://a> {
//     VALUES ?uq_p {
//       <ex://x>
//     }
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_s AS ?uq_a )
//       BIND( ?m0_o AS ?uq_c )
//       BIND( ?m0_p AS ?uq_p )
//     }
//     {
//       {
//         SELECT ?m0_o ?m0_p ?m0_s WHERE {
//           ?m0_s ?m0_p ?m0_o .
//         }
//       }
//       BIND( ?m0_s AS ?uq_a )
//       BIND( ?m0_p AS ?uq_b )
//       BIND( ?m0_o AS ?uq_d )
//     }
//   }
// }`,
//       [ `CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <ex://a> { ?s ?p ?o } }` ],
//       [ operationTransform, transformExtendsToValues, transformServiceCallPushUp ],
//     ));
//
//   describe('removeProjections', () => {
//     it('anonymizes variables hidden by a sub-SELECT', ({ expect }) => testConstructMappers(
//       expect,
//       'SELECT ?x WHERE { ?x <http://ex/p> ?w . { SELECT ?w { ?w ?a ?b } } }',
//       `SELECT ( ?uq_x AS ?x ) WHERE {
//   ?uq_x <http://ex/p> ?uq_w .
//   ?uq_w ?v_1 ?v_0 .
// }`,
//       [],
//       [ removeProjections ],
//     ));
//
//     it('coins unique fresh variables across sibling sub-SELECTs', ({ expect }) => testConstructMappers(
//       expect,
//       'SELECT ?x WHERE { { SELECT ?x { ?x ?a ?b } } { SELECT ?x { ?x ?c ?d } } }',
//       `SELECT ( ?uq_x AS ?x ) WHERE {
//   ?uq_x ?v_1 ?v_0 .
//   ?uq_x ?v_3 ?v_2 .
// }`,
//       [],
//       [ removeProjections ],
//     ));
//
//     it('anonymizes a non-projected VALUES variable including its binding key', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         'SELECT ?x WHERE { ?x <http://ex/p> ?y . { SELECT ?y { ?y ?p ?o . VALUES ?o { <http://ex/a> } } } }',
//         `SELECT ( ?uq_x AS ?x ) WHERE {
//   ?uq_x <http://ex/p> ?uq_y .
//   ?uq_y ?v_1 ?v_0 .
//   VALUES ?v_0 {
//     <http://ex/a>
//   }
// }`,
//         [],
//         [ removeProjections ],
//       ));
//
//     it('anonymizes a deeper nesting', ({ expect }) =>
//       testConstructMappers(
//         expect,
//         'SELECT ?x WHERE { ?x <http://ex/p> ?y . { SELECT ?y { ?y ?x ?o . VALUES ?o { <http://ex/a> } . { SELECT ?x { ?x ?p ?y }} } } }',
//               `SELECT ( ?uq_x AS ?x ) WHERE {
//   ?uq_x <http://ex/p> ?uq_y .
//   ?uq_y ?v_3 ?v_2 .
//   VALUES ?v_2 {
//     <http://ex/a>
//   }
//   ?v_3 ?v_5 ?v_4 .
// }`,
//               [],
//               [ removeProjections ],
//       ));
//   });
});
