<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Serialization →](SERIALIZATION.md)

# Schema extension

1. Schema extension

- Store already has a module lookup function but Visitors it returns must be read-only. 
- Store needs an alternate module function `Store.extend(v: Callable[[Mutators.OfModules], Mutators.OfModules])` where the callback gets writeable mutators
- `Store` must confirm that all mutations are extensions and refinements, not redefinitions of the existing schemas. It may do so in the passed builders or when `v` returns as a validation pass
- at the moment, modification of existing schema items seems to be limited entirely to adding adjacencies and properties

*Proposed (agent's notes, for review):*

Allowing existing schemas to gain adjacencies and properties sidesteps the more general questions of union,
intersection and multiple refinement: two packages that each extend `Schemas.Scalar` (one adds `bit_width`, another
`unit`) simply both add members to it, and every scalar may have both; no schema needs two parents. It covers open
families too: a link's accepted types are inferred from the adjacencies that declare it, so a dialect's new term kind
declares an adjacency on, say, `Arguments`' `argument` link and may fill it from then on, with no union to open.

```python
store.extend(lambda m: (
    m.Expressions.BitWidth(lambda r: r.links([
        lambda t: t.name("scalar").type([Builders.Meta.Scalar]),
        lambda t: t.name("width").type([Term]),
    ]).uniques("scalar")),
    m.Schemas.Scalar(Builders.Meta.Scalar, lambda o: o.adjacencies([      # an extension: a member added,
        lambda t: t.name("bit_width").relation([BitWidth]).me("scalar"),   # nothing redefined
    ])),
))
Word = store.Schemas.Scalar(lambda s: s.name("Word").token("int").bit_width([...]))  # the same builder, a new member
```

What the check would accept and refuse:

- **May add:** properties and adjacencies to an existing object schema; properties to a relation's entries; perhaps
  branches to a union, if unions stay.
- **May not:** retype or remove a member, or change `ref`, `pattern`, `singleton`, `uniques`, a relation's links or a
  scalar's token. Adding a link to an existing relation is refused too: every entry it holds would lack the link.
- **Names:** an added member may not take a name the schema already has, its inherited members included (through
  `refines`), nor one another extension added, nor one a schema refining it declares (a refinement inherits the
  extension).
- **Existing objects** gain the member, absent until written. In declaration order (mbse-basis P-001) added members
  follow the schema's own, in the order they were added.
- **Per process.** An extension modifies the extended schema itself, framework schemas included
  (`Builders.Meta.Scalar`, one object every store in the process shares), so it holds for every store in the process.
  A package extends once, at import, and extending again with what is already there changes nothing. Tests of the
  mechanism extend schemas the test builds; a case that extends a framework schema comes last in its suite, since
  the cases of a notebook share its process.
- **Snapshots** need no new vocabulary: an extension is `insert` mutations on the extended schema's `HasProperty` and
  `HasAdjacency` entries (docs/SERIALIZATION.md). The writer, which writes no framework schema today, writes the
  extensions of framework schemas and still assumes their own members; a reading store applies them through the same
  check, which serves as a schema handshake.

2. Extension

Moving `.bits` and `.bytes`:

RELATION Expressions.Framework.HasSchema(term=Expressions.Framework.Term, schema=Schemas.OfY)
RELATION Expressions.Framework.HasDomain(schema=Schemas.OfScalar, domain=Expressions.Framework.Domain)
RELATION Expressions.Framework.HasFormalParam(callable: Expressions.Framework.Callable, name: str, domain: Expressions.Framework.Domain)

Representing scalar values:

PROPERTY [Expressions.Framework.Value] Expressions.Dialects.Basic.AsIntValue(int)
PROPERTY [Expressions.Framework.Value] Expressions.Dialects.Basic.AsFloatValue(float)
...

3. relocating things in mbse-schemas

Definitely:

- constraining the size of Schemas.OfScalar : move to mbse-expressions via `HasSchema` and `HasDomain`
- allowing schemas to define parameters on definition and bind them to expressions on instantiation : keep in mbse-schemas except for typing via `HasDomain`
- allowing Schemas.OfScalar (maybe others) to be bound to an expression

4. parameters

In mbse-schemas, a parameter can only denote a schema
In mbse-expressions, a parameter can denote a schema or a domain

5. signatures

OBJECT Expressions.Framework.Function
PROPERTY [Expressions.Framework.Function] Expressions.Framework.HasName('str')
RELATION Expressions.Framework.HasFormal(function: Expressions.Framework.Function, name: str, schema: Schemas.OfAny)
RELATION Expressions.Framework.HasResult(function: Expressions.Framework.Function, Schemas.OfAny)

6. intrinsics

mbse-expressions will also introduce the ability to register native functions ("intrinsics") that implement modeled callable formal signatures and to which modeled callable terms bind.

PROPERTY [Expressions.Framework.Intrinsic] Expressions.Framework.HasNative(cb: Callable) # should be named reference objs

## Decided

As the user decided (2026-10-15), on the questions put to them:

1. The extension check's rules above: "yes your rules are fine".
2. An extension modifies the original schema objects: "I figured the original schema objects would get modified";
   per process, as above ("yes to the first": tests extend schemas they build, a framework one last).
3. Unions: "continue using Unions for kinds for now and posit unification for the future" (of unions with branches
   and intersections).
4. Defaults: codegen "would work with or without the additional schema info from mbse-expressions, and if absent
   should assume the most universal default. in the case of size, that makes a scalar without a domain basically
   plain data".
5. `requires` "moves out of mbse-schemas all the way out to `mbse-patterns` using the new extension mechanism".
6. "all bindings will need to move into mbse-expressions": `OfApply` and its arguments, literal values and terms
   (`ArgumentTerm`), with mbse-schemas declaring `parameters` only ("it matches well enough").
7. `Form` "should go" from mbse-schemas.
8. Scalar values, formal parameters and intrinsics: see section 2.
9. "printers and parsers go through Visitor just like everything else" (mbse-basis P-018); only intrinsics'
   implementations are code, each found through its named reference object (`AsIntrinsic`).
10. "free variables are just free variables": each dialect (Python, Excel, MATLAB, ...) "selectively permit[s] access
    to global context by free vars".
11. Signatures: `Same` and `Overloaded` are "specific names that resolve function binding". A signature is a
    `Function`, named, with formals and a result, each typed by a schema; several functions may share a name, and a call
    binds to one by its name and its arguments' types. Intrinsics, native functions registered against named reference
    objects, implement them (sections 4 and 5).
12. "any expression dialect can define scalar domains that make sense. the scalar types defined in mbse-schemas aren't
    special and could potentially go away".
13. "expressions only deal in scalars. All object/relation functionality is moving up to mbse-patterns". "terms are
    reference objects", which the relations other packages add can link (`HasSchema`, mbse-patterns' `requires`).
    Containers of scalars stay: "quantifiers over containers - starting with map/reduce - should be included".
14. Parameters (section 4): "parameters that denote domains are moved to mbse-expressions entirely"; mbse-schemas
    keeps parameters that denote schemas (`List[T]`), so today's value parameters (`Matrix(rows, cols)`, a `Word`'s
    width `w`) move with their bindings.
15. Constraining a type parameter: "We can start with level 0 but I do want to plan for level 2. But not today."
    Level 0: a generic signature (`add[T](a: T, b: T) -> T`) states its shape only, and binding a call to a registered
    intrinsic is the constraint. Level 2, planned: a parameter's optional bound, the schemas its value must refine
    (`T refines Integer`), so that inference rejects a call before binding. Relations between parameters (promotion)
    and results computed from them (SystemVerilog widths) go to intrinsics that compute the result's schema; modeling
    type-level computation is off the table.

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Serialization →](SERIALIZATION.md)
