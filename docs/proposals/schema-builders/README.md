# Schema builders as visitors (proposal)

This follows [FRAMEWORK.md, Schema builders align with their meta-schemas](../../FRAMEWORK.md#resolved), and the
user's rules: every schema object is a reference object, and every reference is a relation. A property holds a value
of any kind: a scalar, a container, a value object, or any nesting of them.
[Builders.py](Builders.py) holds the proposed meta-schemas and builders, in Python, on top of `Schemas.OfX.Data`, which
is unchanged. [examples.py](examples.py) runs them, and every meta-schema and example schema validates
(`cd python3 && uv run python ../docs/proposals/schema-builders/examples.py`).

## The meta-schemas

Every meta-schema (`Meta.X`, which becomes `Schemas.OfX.Schema`) is a reference object schema.

- **Kinds.** `Schemas.Schema` has `name` and `description`, and owns `parameters`.
  - `Schemas.Type` refines it. Scalar, Object, Union, Intersection, Container, Apply and Any refine `Type`.
  - Relation and Predicate refine `Schema` directly; they are not types.
- **Members.** `Schemas.Typed` has a `description` and a `type`. Property, Parameter, Symbol and Member (a branch or
  a part) refine it. A member's name is a property of the entry that links it to its owner (`HasProperty.name`, ...).
- **Other schema objects.** Adjacency, Argument, Term (refined by `Form`) and Module.
- **Names, by exception.** Within a schema, its relation's links and properties are named by string, not referred
  to: an adjacency's `me` and a relation's `uniques` are properties holding names.
- **Properties hold values:** a kind's `name`, `description`, `ref`, `pattern`, `singleton`, `flat`, `layout`,
  `format`, `token`, an adjacency's `me`, a relation's `uniques`, an argument's `value`, a form's `dialect`, `kind` and `attributes` (a container), and the `name`
  of a member relation's entry.
- **References are relations,** each with an adjacency named on the side that declares it, and anonymous on the
  other:

| Relation | Links | Adjacency | Entries |
|---|---|---|---|
| Typing | typed, schema | Typed.`type` | one per typed |
| Refines | refinement, refined | Scalar/Object/Container.`refines` | one |
| Indexing, Containing | container, index / element | Container.`index`, `element` | one |
| Applying | application, applied | Apply.`of` | one |
| AnyOf | any, schema | Any.`types` | a list |
| Relating | adjacency, relation | Adjacency.`relation` | one |
| Binding, ArgumentTerm | argument, parameter / term | Argument.`parameter`, `term` | one |
| Requires | predicate, term | Predicate.`requires` | one |
| BitWidth, ByteWidth | scalar, width | Scalar.`bits`, `bytes` | one; a width is a term |
| HasParameter, HasProperty, HasAdjacency, HasBranch, HasPart, HasSymbol, HasLink | owner, member; property `name` | `parameters`, `properties`, `adjacencies`, `branches`, `parts`, `symbols`, `links` | a member has one owner, and is named within it |
| HasArgument | owner, argument | Apply.`arguments` | an argument has one owner |
| Operands | form, operand | Form.`operands` | a list |
| Defines | module, schema; property `name` | Module.`schemas` | a schema has one module, and is named within it |

"One" is a `unique` clause on the relation, which the builder enforces. Inserting a second entry raises, so you remove
the first one; inserting an entry already held is elided.

## The builders

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over `Meta.X`, in VISITOR_PATTERN.md's form:

- **Members:**
  - `osv.<propName>` and `osv.<propName>(cb)`, a `Visitors.OfProperty`. A container-valued property (a form's
    attributes) hands over a `Visitors.OfContainer`.
  - `osv.<adjName>` and `osv.<adjName>(cb: Callback[OfAdjacency])`, an adjacency with `insert`, `remove`,
    `as_iterable` and iteration. Its value form is an iterable of entries.
- **Entries.** `env.<linkName>(spec)` links:
  - the referent given;
  - or a referent built through the callback: new, or, if the entry already links one, that one updated in place,
    as a reference object is.

  Read without a call, a link gives the referent, read-only.
- **`as_*`:**
  - `as_schema()` returns `Meta.X`, and every member's `as_schema()` returns its meta-schema property or adjacency;
  - `as_properties` and `as_adjacencies` follow the meta-schema's order;
  - `as_identity()` reads the identity, and `as_identity(x)` writes it. Every schema object is a reference object,
    so it gets an identity when it is created: the one written, else its name for a named kind, else a UUID.
    `update()` keeps an object's identity, unless one is written, which renames it.
- **Data.** Each member is adapted to however the data stores it:
  - a dict of members by name, or a tuple;
  - a field holding the referent;
  - an argument by its parameter's name;
  - a width given as an int, which reads as a literal form.
- **Derivation happens at finalization.** A refinement takes its token, `ref`, index and element in `_finalize`; no
  member write has a side effect.

## Building in a store

No reference object is built outside a store, and that includes schema objects. The canonical form is
`store.moduleName.[...moduleName].schemaName(cb: Specs.Callback[Visitors.OfX])`. It returns the object.

```python
store = Store()
Person = store.Schemas.Object(lambda o: (
    o
    .name("crm.Person")
    .ref(True)
    .properties([
        lambda t: t.name("given_name").type([Text]),
        lambda t: t.name("age").type([Int]),
    ])
))
ada = store.crm.Person(lambda c: c.given_name("Ada").age(36))  # create
store.crm.Person(ada, lambda c: c.age(37))                     # update: the object first
twin = store.crm.Person(ada)                                   # clone
```

- **Identities.** The store gives every schema object built in it an identity, including members built with it. A
  named schema's identity is its name; anything else gets a UUID. The store refuses an identity that another of its
  schema objects already has.
- **Registration.** A named schema is registered under its name, so `store.crm.Person` resolves right after it is
  created. A rename re-registers it under the new name.
- **Data.** For data, the call goes to the proxy builder.

## Old clause → new

With VISITOR_PATTERN.md's shorthands:
- a property takes its value whole, and its type must match exactly;
- an adjacency of a relation with two links takes an iterable (the peer shorthand). Each item is either the object to
  link, or a callback taking `OfThem.Visitor`, which sets three things:
  - the entry's properties: `t.name(...)`, a member's name, which its entry carries;
  - its link: `t.property(age)`, linking an object that exists;
  - the linked object's members: `t.type([T])`, building a new object, or updating the linked one if the link is set
    first.

  Every relation between schema objects has two links. Where the relation allows only one entry, the shorthand
  replaces it.

| Old | New |
|---|---|
| `.properties(lambda p: p.name("x").of(T))` | `.properties([lambda t: t.name("x").type([T])])`; one built first, `.properties([lambda t: t.name("x").property(x)])` |
| `.of(T)` on a property, parameter, symbol, branch, part | `.type([T])`, the evaluation type, a schema that exists (`[S.OfScalar.Data(int)]`) |
| `.relations(lambda a: a.name("n").of(R).me("l"))` | `.adjacencies([lambda t: t.name("n").relation([R]).me("l")])`; an anonymous one has no `name` |
| `.links("a", "b")` | `.links([lambda t: t.name("a"), lambda t: t.name("b")])`, a link's type following from the adjacencies that fill it |
| `.unique("a")`, `.unique("a", "b")` | `.uniques("a")`, `.uniques(["a", "b"])`; several clauses, `.uniques([["a"], ["b", "c"]])` |
| `.refines(T)` | `.refines([T])` |
| `.bits(8)` / `.bits(term)` | `.bits([term])`; 8 is `Form.Builder().kind("literal").attributes({"value": 8}).create()` |
| `.index(T)`, `.element(T)`, `.of(T)` on an application | `.index([T])`, `.element([T])`, `.of([T])` |
| `.arguments(width=8)` | `.arguments(lambda adv: adv.insert(lambda env: env.argument(lambda a: a.parameter([width]).value(8))))` |
| `.requires(term)` | `.requires([term])` |
| `.ref()`, `.ref(pattern)` | `.ref(True)`, `.ref(True).pattern(pattern)` |
| `.flat()`, `.dense()` | `.flat(True)`, `.layout("dense")` |
| `.type(int)`, `.token(fmt, name)` on a scalar | `.token("int")`, `.format(fmt).token(name)` |
| `S.OfAny.Builder().as_scalar(...)` selector | `OfAny.Builder().types([T, U])` |
| `.entry(spec)`, `OfEntry.Builder` | gone: a relation's `links` and `properties` are its own |

## Points for your review

Decided:
- an int width reads as `Form("literal", {"value": 8})` ("leave it that way. forms may go away but not yet");
- "all schema objects are reference objects and all reference objects get an ID on creation";
- "`type` *never* needs to be provided on the symbol. that relationship is inferred from adjacencies";
- the exception for names within a schema: `me` and `uniques`;
- the canonical form of building in a store: a call with a callback creates, an object and a callback update, an
  object alone clones.

## Work items

1. **Wire format.** Modules and Plain read and write schemas through these meta-schemas like any other model, as
   linked reference objects, and the conformance corpora are regenerated.
2. **Modules in the store.** A module is an object in the store, alongside schemas and data. The module named by a
   schema's prefix (`crm`) defines it through `Defines`.
3. **Cloning owned members.** A member has one owner, so cloning a schema clones its members, with new identities,
   instead of sharing them.
4. **Landing.** The meta-schemas, builders and store move into `Schemas.py` and `Proxies.py`, with the shorthands in
   proxies too, mirrored in TypeScript. The call sites migrate to the canonical form.
5. **The meta-schemas in the store.** `Meta` is built at import, outside any store. Each store should hold the
   meta-schemas, as stores register `Schemas.Module` today.
