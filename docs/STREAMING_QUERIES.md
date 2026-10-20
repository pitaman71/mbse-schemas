<!-- nav -->
[← Serialization](SERIALIZATION.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)

# Mutations as Queries

If we invest in patterns now rather than deferring them to a separate repo, I think we can combine predicate logic, constraint expressions into a streaming query language that efficiently expresses compute that scales all the way up beyond cluster level and all the way down to hardware logic gate level.

It can also comprehensively and efficiently capture data streams as:

- snapshots (memory and wire format)
- journals (memory and wire format)
- queries
- distributed-compute-in-query

(Plan to) set aside existing design + implementation of Schemas.OfPredicate across all mbse-* repos. Create a replacement `mbse-schemas.Schemas.OfPattern`.

## Frame streams

In the course of streaming query execution, mutator kinds consume and produce streams of frames. Mutation expressions comprise nested terms with operations that modify the frame stream between consumption and production. A query evaluator recursively evaluates each term, passing computed frame stream to each successive term. 

In this context, a `Schemas.OfPattern` with multiple symbols has a default interpretation as a cross-product over the sets of reference objects bindable to each symbol. A pattern's spec or a constraint reduces query complexity in a manner that the query executor should automatically exploit.

In this context, a `Schemas.OfPattern` with multiple variables has a default interpretation as a cross-product over the sets of values assignable to each variable. A constraint reduces query complexity in a manner that the query executor should automatically exploit.

With `Schemas.OfPattern` the schema level declares the shape of a pattern and the instance level is used as frames (matches, effectively) for the pattern. In a frame:
- for each variable, assigns a value of the corresponding schema (as an instance of `Schemas.OfVariable`)
- for each symbol, binds a reference object that exists or is "putative" (as an instance of `Schemas.OfSymbol`) 

The frame stream is a stream of formatted frames (as instances of `Schemas.OfPattern`) each of which associates one or more named "symbols" with reference objects (which may or may not already exist) and zero or more named "variables" bearing schema-governed values.

The frame stream's shape, as defined by the symbols and variables that should be present, will have a shape that may be passed on from its parent during evaluation or may have symbols and variables added or removed.

Various kinds of terms in the mutation kind vocabulary can:

- directly address existing symbols
- pass symbols along
- add or remove symbols with upsert semantics
- route entries according to pattern conditions
- programmatically map or reduce frames in the stream
- add or remove variables

## Cascading frame streams

The mutation vocabulary is biased towards treating the frame stream as a cascade. Symbols and variables in the parent frame stream are by default passed along to the child frame stream. This means that each mutation term has its own compute complexity which is a function of the compute complexity of its parent. This cascade is denoted "streaming compute complexity".

Mutation kinds either:
- pass all symbols and variables through from parent to child without adding any new symbols or variables, 1:1 compute complexity from parent to child
- add a symbol or variable, adds a product term to the parent's compute complexity
- remove a symbol or variable, which removes a product term from the parent's compute complexity.

## Distributed Streaming Queries

The unit of distributed compute is a frame which binds symbols to reference objects and assigns schema-governed values to variables. Pattern expressions describe a completely scalable, implicitly transactional flow over:

- binding symbols to existing objects in permanent persistent store
- fetching property values and adjacency entries from permanent persistent store
- retaining property values and adjacency entries in a transactional view cache/replica
- fetching property values and adjacency entries from the store
- computing values via expressions over property values and adjacency entries
- proposing objects that must be upserted
- finding extant objects by identity, property values, and adjacency entries present in a transactional view cache/replica
- fetching extant objects by identity, property values, and adjacency entries permanent persistent store
- sending updates to extant objects' property values and adjacency entries to a transactional view cache/replica
- forwarding updates to extant objects' property values and adjacency entries permanent persistent store
- sending creations to new objects' property values and adjacency entries to a transactional view cache/replica
- forwarding creations to new objects' property values and adjacency entries permanent persistent store

A mutation kind that adds a symbol is said to "inject" that symbol into the frame stream. Such mutations reference "symbol patterns". Similarly a mutation that adds a variable is said to "inject" that variable into the frame stream. Such mutations reference "variable patterns". "project" is used in a complementary sense.

## Patterns : symbols, variables, boundary constraints

`Schemas.OfPattern` comprises three things:
- a list of symbol declarations (as `Schemas.OfSymbol`) which in an instance will be "bound" to a reference object 
- a list of variable declarations (as `Schemas.OfVariable`) which in an instance will be "assigned" to a schema-governed value 
- zero or more fused constraint expressions (as `Schemas.OfConstraint`) over symbol visitors and variable visitors

`Schemas.OfSymbol` declares one symbol:
- must provide a symbol name
- may provide `schema`: reference object schema for that symbol (`schema: Schemas.OfObject`)
- may provide `schema`'s singleton: a symbol whose schema is a singleton's binds it
In some contexts, `schema` may be optional or mandatory.

`Schemas.OfVariable` declares one variable: 
- must provide a variable name
- may provide `schema` : value schema for that variable (`schema: Schemas.OfAny`)

- `Schemas.OfPattern.requires`: constraint expressions (`Schemas.OfConstraint`) over a frame

## Spec

A pattern's `spec` says what must hold of a frame: property values the symbols' objects have, and relation entries that
link them, written in the builders' notation over the frame's symbols, `lambda _: _.bob.name("Bob").knows([_.ada])`. In
a match it filters; in an upsert it is written where it does not hold. It replaces locators; a symbol whose schema is a
singleton's binds that singleton ([Object identity](OBJECT_IDENTITY.md), Decided, 76 to 78).

## Putative objects

Temporary "putative" reference objects can be created and injected into the frame stream. By default putative reference objects exist only during the transaction and are not committed to persistent store. By appending a `Mutations.OfUpsert` and naming the bound symbol (via a trivially simple `exists` clause), the symbol is no longer putative and the new reference object will be upserted.

## Value Expressions and Constraints

`Schemas.OfExpression` is used to define the shape of an expression in terms of:
- a pattern (as Schemas.OfPattern)
- `symbols` defined by the pattern are considered free
- `variables` defined by the pattern are considered free
- `requires` defined by the pattern qualify frames as legal/illegal
- a result schema governing the result value computed when the expression is evaluated (as Schemas.OfAny)
- the root term of an expression, which expects a single frame argument

The `Schemas.OfPattern` defines the shape of frames it expects in terms of free variables and free symbols. The syntax of the expression root expects a single argument frame. This frame must map each symbol (of the pattern) to a read-only `Visitors.OfObject` and must map each variable (of the pattern) to a read-only `Visitors.OfAny`.

Expression dialects are not defined in `mbse-schemas`. Therefore
`mbse-schemas.Schemas.OfExpression` is a placeholder (for extension by `mbse-expressions`) that captures an expression. 
This refinement enables `Schemas.OfExpression` to represent value formulas, and so `Schemas.OfConstraint` boolean predicate formulas. Combine this with lambda notation and `Expressions.FromFunction`, and a very concise shorthand with little or no change to existing builder/visitor functionality should be feasible.

`Schemas.OfConstraint` is a variant of `Schemas.OfExpression` in which the result schema is `Schemas.OfBool`. It is used by Schemas.OfPattern to capture a fused (boolean) constraint over symbol/variable/property/value visitor expressions in a predicate-logic format. This constraint defines whether a particular frame matches or fails to match the pattern.

## Mutation structure

A mutation nests, roughly, as:

```
Mutations.OfTransaction [ -> Mutations.OfShard ] -> Mutations.OfTerm -> Mutations.OfPattern -> Mutations.OfObject -> Mutations.OfAdjacency -> Mutations.OfProperty
```

- `Mutations.OfTransaction` is the root: its uid and its one chain of terms, `Mutations.OfAll` first.
- `Mutations.OfShard` is strictly optional: the query executor's division of the work, which it allocates; never in what
  a program submits nor in what a journal records ([Object identity](OBJECT_IDENTITY.md), Decided, 53, 56).
- `Mutations.OfTerm`: one term of the chain (`OfAll`, `OfMap`, `OfReduce`, `OfPartition`, `OfUpdate`, `OfUpsert`). Each
  term has just one pattern; `Mutations.OfPartition` forks the chain where paths must diverge.
- `Mutations.OfPattern`: the pattern's symbols, each the address of the mutations under it: a symbol names the object,
  located once in the pattern, so no verb carries a `ref` of its own.
- `Mutations.OfObject`: the mutations of the object one symbol binds.
- `Mutations.OfAdjacency`: that object's adjacencies, their entries inserted, removed or edited, each entry's links and
  properties through `Mutations.OfEntry` (`AsLink`, `AsProperty`). Entries change only through an adjacency: the
  relation-level verbs, `Mutations.OfRelation.*` on a relation's whole extent, go for now.
- `Mutations.OfProperty`: the value verbs (`Set`, `Clear`, `AsAny`, ...), nesting into value objects, unions,
  intersections and containers as they do today.

The verbs are what a program's builders write: a mutation builder is given whenever a property is called with a
callback, `<object_path>.<propName>(cb)` or `<rel_entry_path>.<propName>(cb)` ([Object identity](OBJECT_IDENTITY.md),
Decided, 58).

## Mutation Expressions

Mutations are expressed as nested expressions, where each term expresses a streaming query using predicate logic. 

Every mutation expression term: 

- has a `then` clause containing at most one nested subterm
- has other clauses that direct evaluation of the mutation expression, its effects on the frame stream, and on transactional commits to persistent store (as variant-specific uses of `Schemas.OfPattern`).

In a nested mutation expression term, if symbol 'S' is already present in the consumed frame stream (e.g. defined by any of its ancestors), it is considered a reference to that inherited symbol, not a rebinding of the symbol to some other object.

A "query executor" evaluates these expressions over streams of frames. 

The query executor:
- recursively executes the mutation expression term's subterm
- for each mutation expression term, produces a stream of frames that it passes to the term's subterm
- consumes a stream of frames from its parent at each recursive call
- may filter the frame stream
- may upsert objects into the frame stream
- may update objects

The vocabulary of `Mutations.OfX.Y` tracks the vocabulary of Schema kinds: that is there exists a `Mutations.OfX.Y` for every schema kind X and every modification verb Y. `Mutations.OfX.Y` are serializable via meta schema.

The mutation vocabulary uses `Schemas.OfPattern` across its quantifier term vocabulary.

`Mutations.OfAll` is a universal quantifier with optional fused selection. This is the only term that may be used as the root of a mutation expression. The `over` clause's symbols may refer to any kind of reference object ([Object identity](OBJECT_IDENTITY.md), Decided, 84): each ranges over the extant objects of its schema, a singleton's binding the singleton (77), and the frames are their cross product, filtered by the pattern's spec and constraints.

```python
Mutations.OfAll.over(Schemas.OfPattern)
Mutations.OfAll.then(Mutations.OfTerm)
```

Normally the symbols and variables injected by every ancestor term in a mutation expression (`OfAll`'s `over`, `OfMap`, `OfReduce`, `OfUpsert`'s `exists`) are accumulated during recursive evaluation and passed through to descendants. There are three mutation kinds which route and/or multiplex the frame stream: `Mutations.OfPartition`, `Mutations.OfMap`, and `Mutations.OfReduce`

`Mutations.OfMap` programmatically expands each frame in the consumed frame stream into zero or more frames in the produced frame stream. 

```python
# associate case : add one symbol to every frame in stream
# symbol binds to an existing object(s) via visitor spec expression
# for any frame in the consumed stream, if the pattern's constraint cannot be satisfied for that frame, no frames are produced from that frame
# if association is not unique, complexity multiplies
#
# pred.requires : describes object to find and associate
# pred.spec : may give property values and links to other symbols
Mutations.OfMap.as_symbols(pred: Schemas.OfPattern).then(Mutations.OfTerm)
```

```python
# spread case : add one variable to every frame in the stream
# every feasible value gets its own assignment
# for any frame in the consumed stream, if the pattern's constraint cannot be satisfied for that frame, no frames are produced from that frame
# complexity multiplies by size of feasible/domain values
# a value computed from the frame is the case of exactly one feasible value: complexity 1:1
#
# pred.requires : describes values to enumerate
# pred.requires : may use literal or constraint expression
Mutations.OfMap.as_variables(pred: Schemas.OfPattern).then(Mutations.OfTerm)
```

`Mutations.OfReduce` programmatically groups frames within a stream according to a user-provided bucketing metric: the variable or symbol it creates is the metric, and its values are the buckets.

`Schemas.OfCollector` wraps a pattern so that it can be used as a collector expression: one that gives access to certain duplicated symbols and/or variables being collected. `Visitors.OfCollector` is nearly identical to `Visitors.OfPattern` except that the designated symbols and variables are duplicated with the suffixes appended to their names.

```python
...Schemas.OfCollector(lambda co: co
    .pattern(Schemas.OfPattern)
    .symbols([name: str...])
    .variables([name: str...])
    .commutative() # optional; a collector declaring neither is rejected for now by validation
    .associative() # optional
    .suffixes({ current: str, next: str })
    .computes(Schemas.OfExpression)
)

# drop-symbol case : drop one symbol from every frame in the consumed stream
# this may create apparent duplicates, keep only unique frames
# pred: has neither `suffixes` nor `computes` clause
Mutations.OfReduce.as_symbols(pred: Schemas.OfCollector).then(Mutations.OfTerm)

# drop-variable case : drop one variable, collate by all unique frames left
# this may create apparent duplicates, keep only unique frames
# pred: has neither `suffixes` nor `computes` clause
Mutations.OfReduce.as_variables(pred: Schemas.OfCollector).then(Mutations.OfTerm)

# collect-symbols case :
# pred: must provide at least one `suffixes` and/or `computes` clause
# frames from the consumed stream are grouped according to assigned values to variables and object references bound to non-collected symbols
# then, for each group, a cumulative (and putative) reference object 
# is built:
# - initially a deep copy of the object bound to the designated
# symbol by the first frame in the group
# - incremental via a programmer-specified "collector" expression 
# applied repeatedly to all but the first frame in the group.
#
# The created object is putative, meaning it will not be upserted at
# the end of the frame stream, unless the programmer also provides
# a Mutations.OfUpsert to do so.
Mutations.OfReduce.as_symbols(pred: Schemas.OfCollector).then(Mutations.OfTerm)

# collect-variables case :
# pred: must provide at least one `suffixes` and/or `computes` clause
# frames from the consumed stream are grouped according to object references bound to symbols and values assigned to non-collected variables
# then an added variable is assigned a value computed via a 
# programmer-provided "collector" expression:
# - initially assigned the same value assigned to designated variable
# by the first frame in the group
# - incremental via a programmer-specified "collector" expression 
# applied repeatedly to all but the first frame in the group.
#
Mutations.OfReduce.as_variables(pred: Schemas.OfCollector).then(Mutations.OfTerm)
```

`Mutations.OfPartition` routes the frame stream. Using this at the root is either a schema violation or a validation error. Each branch represents a conditional arm. `first` and `last` specify that at most one arm with matching condition should be recursively executed. If `first` and `last` are both called it is a validation error. If neither are called every branch with matching condition is recursively executed. If no branch has a matching condition and the `none` clause is present, that one is recursively executed.

`Mutations.OfBranch` pairs a condition constraint with a mutation sub-clause.

```python
Mutations.OfPartition.first() # dispatch to first matching branch
Mutations.OfPartition.last() # dispatch to last matching branch
Mutations.OfPartition.branches([Mutations.OfBranch])
Mutations.OfPartition.none(Mutations.OfTerm)

Mutations.OfBranch.requires([constraints: Schemas.OfConstraint])
Mutations.OfBranch.then(Mutations.OfTerm)
```

The 'fork' form above, which lacks `expect` and `then` clauses on `Mutations.OfPartition`, recursively executes every conditionally activated branch as executing in parallel. The end of the mutation expression term tree is treated as a terminal where frames are disposed. Alternatively, 
`Mutations.OfPartition` can represent a fork-join pair where the final frame stream across all executed paths are joined and then passed to a follow-up mutation clause. The `none` `expect` `then` clauses must be provided.

Mutations.OfPartition.expect(Schemas.OfPredicate) # optional join schema
Mutations.OfBranch.then(Mutations.OfTerm)


`Mutations.OfUpdate` is used to update properties and adjacencies for symbols already in the frame stream. Using this at the root is either a schema violation or a validation error. 

```python
Mutations.OfUpdate # update, only used below root
Mutations.OfUpdate.apply(pred: Schemas.OfPattern)
Mutations.OfUpdate.then(Mutations.OfTerm)
```

`Mutations.OfUpsert` is used to upsert frames each of which contains zero or more new objects. Using this at the root is either a schema violation or a validation error. Any symbol declared in `exists` which is not present in the frame stream is considered a reference that must be upserted. If the pattern's spec finds the object, that object will be bound, otherwise a new object is created and bound, and the spec written.

```python
Mutations.OfUpsert # upsert, only used below root
Mutations.OfUpsert.key(key: str) # optional: tells apart the counted objects one upsert creates from one frame
Mutations.OfUpsert.exists(Schemas.OfPattern)
Mutations.OfUpsert.then(Mutations.OfTerm)
```

An owned object an upsert finds or creates is placed by its spec's owning entry, which gives its whole path: owner,
owning adjacency and the ownership entry's keys; its path is its identity, and `key` takes no part. A counted object an upsert
creates is identified by the frame that reached the upsert, its `key` and the symbol it is created for, so that running
the expression again finds it rather than creating another ([Object identity](OBJECT_IDENTITY.md), Decided, 60, 61 and
63).

- `Mutations.OfTerm` a schema-governed union of the terms a child may be: `Mutations.OfMap`, `Mutations.OfReduce`, `Mutations.OfPartition`, `Mutations.OfUpdate`, `Mutations.OfUpsert` (`Mutations.OfAll` is the root only)

## Resolved

We cannot abandon mutation verbs as they are already essential for creating or modifying value objects. `Exists` as a top level mutation type goes away.

It's possible mutation verbs are no longer needed in the specific case of counted reference objects, because we can now name every object that needs to be created or updated with a symbol. However, I am concerned about syntax bloat, particularly in cases such as nested expression terms.

Within a mutation expression, objects created through a symbol are named by their symbol. A counted object has no identity beyond the document that writes it, and sharding is the executor's, never recorded; see [Object identity](OBJECT_IDENTITY.md) (Decided, 55 to 57).

A pattern's spec subsumes visitor paths and locators, and is serializable, being mutations ([Object identity](OBJECT_IDENTITY.md), Decided, 76).

---

<!-- nav -->
[← Serialization](SERIALIZATION.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)
