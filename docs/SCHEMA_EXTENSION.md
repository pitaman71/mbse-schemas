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

Moving `.bits` and `.bytes` means associating a domain to a scalar schema:

RELATION Expressions.Framework.HasDomain(schema=Schemas.OfScalar, domain=Expressions.Framework.Domain)

Representing scalar values:

PROPERTY [Expressions.Framework.Value] Expressions.Dialects.Basic.AsIntValue(int)
PROPERTY [Expressions.Framework.Value] Expressions.Dialects.Basic.AsFloatValue(float)
...

3. relocating things in mbse-schemas

Definitely:

- constraining the size of Schemas.OfScalar : move to mbse-expressions via `HasDomain` per above
- allowing schemas to define parameters on definition and bind them to expressions on instantiation : keep in mbse-schemas except for typing via `HasDomain`
- allowing Schemas.OfScalar (maybe others) to be bound to an expression

4. parameters

In mbse-schemas, a parameter can only denote a schema
In mbse-expressions, a parameter can denote a schema or a domain

5. signatures

OBJECT Expressions.Framework.Function
PROPERTY [Expressions.Framework.Function] Expressions.Framework.HasName('str')
RELATION Expressions.Framework.HasFormal(function: Expressions.Framework.Function, name: str, schema: Schemas.OfAny)
RELATION Expressions.Framework.HasResult(function: Expressions.Framework.Function, schema: Schemas.OfAny)

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
13. "expressions only deal in scalars. All object/relation functionality is moving up to mbse-patterns". Containers of
    scalars stay: "quantifiers over containers - starting with map/reduce - should be included". Terms were first made
    reference objects ("terms are reference objects"), so that other packages' relations could link them; reviewing the
    framework model's draft, the user undid that ("undoing decision 13 might be the right track"): terms are values,
    an expression one nested value held by a reference object, its root, which is all that is linked. "call terms may
    name their function", bound by its name and its arguments' types; "`HasSchema` annotates the root, never a
    subterm" (superseded by 21: a root has no schema); "`requires` is moving out to mbse-patterns anyway"; and the losses, sharing a subterm and linking one from
    outside, are not a problem ("I don't think the losses are a problem"). Kinds are a union again (decision 3).
14. Parameters (section 4): "parameters that denote domains are moved to mbse-expressions entirely"; mbse-schemas
    keeps parameters that denote schemas (`List[T]`), so today's value parameters (`Matrix(rows, cols)`, a `Word`'s
    width `w`) move with their bindings.
15. Constraining a type parameter: "We can start with level 0 but I do want to plan for level 2. But not today."
    Level 0: a generic signature (`add[T](a: T, b: T) -> T`) states its shape only, and binding a call to a registered
    intrinsic is the constraint. Level 2, planned: a parameter's optional bound, the schemas its value must refine
    (`T refines Integer`), so that inference rejects a call before binding. Relations between parameters (promotion)
    and results computed from them (SystemVerilog widths) go to intrinsics that compute the result's schema; modeling
    type-level computation is off the table.
16. Two levels, "Two levels (Recommended)": `Builders.extend(name, cb)`, once per process, extends the framework
    schemas, and what it builds joins the framework every store holds, made before or after, unwritten in snapshots;
    `store.extend(cb)` extends the schemas one store holds. A framework schema changes only through `Builders.extend`;
    ordinary updates of a store's own schemas stay unrestricted. The name makes it idempotent: extending again under it
    does nothing.
17. Adjacencies are named "in both directions unless otherwise stated". A schema object fills a link only where its
    schema, a meta-schema, declares an adjacency to it, so `HasDomain(schema=Schemas.OfScalar.Schema, ...)` extends a
    meta-schema: "this becomes a problem of extending meta-schemas".
18. Extending a meta-schema, with no "alternative out of schema mechanism": a member a meta-schema gains becomes a member
    of its schemas' builder, added at runtime (in Python and TypeScript, which allow it), its value held on the schema
    object; an added adjacency's entries are shared with the objects they link, each held in the index of every object
    it links, as a proxy's are, so both ends see one entry. As built: such an adjacency is to a relation of two links and
    no properties; a proxy links a schema object its store holds; validation and reachability do not follow a link into
    a schema object, which is not data.
19. A framework schema, held by every store, is never written: the entries a store's data makes that link one are kept
    by that store, keyed by the framework schema, a reference object with a stable identity ("yes"), and read through
    that store's builders. Each store sees its own; a builder of a framework schema may write those entries, and
    nothing else about it.
20. A dialect's vocabulary (its domains, functions and intrinsics, data installed in a store): "yes to the handshake,
    fallback to adding if fails". A store connection's handshake names the dialects both sides install, and a snapshot
    does not write their vocabulary; where the handshake fails, the vocabulary is written.
21. Domains: a scalar schema has a domain, `HasDomain(schema=Schemas.OfScalar, domain=Expressions.Framework.Domain)`
    ("Moving `.bits` and `.bytes` means associating a domain to a scalar schema", section 2); domains stay objects. A
    term has a domain ("variables are implicitly bound to terms and terms have a domain"). Revised 2026-10-16: an
    expression's root no longer has a schema, so `HasSchema(root=Expressions.Framework.Root, schema=Schemas.OfY)`, and
    the domain reached through it in two steps ("a two-step association using your new expression-root ref obj"), are
    gone.
22. Formals are objects (`Function` → `HasFormal`, with an index → `Formal` → `FormalType` → schema), since a
    meta-schema's adjacency is to a relation of two links and no properties: "yes that's a compromise".
23. Extension is per store, and no schema object is shared across stores (2026-10-16; revises the "per process" part
    of 2, and 16 and 19, which rested on a misunderstood question: "I misunderstood the original question"):
    - Schemas are not copied: "yes, we do not copy schemas, that remains true". An extension modifies the schema
      objects of the store it extends.
    - "A process can theoretically have multiple stores, though for the moment that is only practically useful for
      testing (and maybe not strictly necessary). If a single program/process has multiple stores it must handle
      correlation of reference objects externally. MBSE does not currently support cross-store references for any
      kind or any purpose, for now, period."
    - Round trips: "this definition of per-store not per-process is ideal. You can test round-trips where both sides
      have the same schema extensions applied *or* round-trips where the two sides have differing extensions applied."
    - "no shared schema objects across stores, so no ambiguity": the meta-schemas and the basic scalars too are each
      store's own, so there is no framework store and no process-wide extension (`Builders.extend` goes).

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Serialization →](SERIALIZATION.md)
