With the assertionPushDown implemented, leaf nodes now have a lot of static assignments of the form `?s ?p ?o . BIND(?s as ?x)`.
We do this in the assertionPushdown because we want to be safe in relation to the cVars/ pVars of every operation.
However, at any depth, the variable might not be required. As such, what we can do is pull up the assignemnt over many operations.
This has to be done with special care not to break semantic corectness of operations and once again with special care for the cVars and pVars.


For example, an operation like:
```sparql
SELECT * {
  { ?s ?p ?o . BIND (<ex://a> as ?x) }
  { ?a ?b ?c }
}
```

can be optimized to:
```sparql
SELECT * {
  ?s ?p ?o .
  ?a ?b ?c
  BIND(<ex://a> as ?x)
}
```

Simply because within the JOIN, the branch bringing the 'extend' is the only branch that has `?x` in it's pVars.

If another branch within the JOIN would have `?x` in the pVars, but not cVars, we would be able to weakly assert the value of `?x` in that other branch.
Of course, special care would need to be taken such that assertions introduced in this operation are not reasserting information that we have asserted before -- thus creating endless or very expensive loops.

In case an BIND is the child of a Projection that does not project the variable created, we can drop the bind altogether,

A lot of code written for pushDown assertion can be reused here. Since we are not yet following semantic versioning, breaking changes are possible, and you can feel free to optimize code for reuse.

The `foundations or SPARQL optimization.pdf`, but also the code already present form a good basis of SPARQL knowledge to bring this task to a good end.
