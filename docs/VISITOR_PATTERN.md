<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)

# Visitor pattern

The protocol through which code reads and writes data of any schema, as the user designed it; the decisions it
records are in the [framework design](FRAMEWORK.md), Resolved, "The visitor pattern". Of it, the schema-level
changes are built ([Meta-schemas overhaul](META_SCHEMAS.md), V1): `as_*` names refused, `Schemas.OfScalar`, value objects
never linked, and `Schemas.OfEntry`, `Schemas.OfSymbol` and `Schemas.OfPredicate`.

## Purpose

Enable programmers to write compactly and precisely express schemas, expressions, and patterns:

- as serialization-compatible data
- in terms of operations over schema constructs
- where expressions and patterns do not need a priori understanding or closure of the schema itself
- in a format that is language-neutral
- in a manner that is dialect-extensible with datatypes and operators

## Reminders:

- a constraint is a pair of predicates over the same object symbols
- the evaluator binds each *symbol* to a Visitors.OfObject `osv`

- Visitors.OfObject and Visitors.OfEntry may only define methods named `as_Y` most of which have the form:

```python
def as_Y(self, cb: Callable[[Visitors.OfY], ReturnT]) -> ReturnT: ...
def as_Y(self, cb: Callable[[Visitors.OfY], ReturnT]) -> Iterable[ReturnT]: ...
```

- Builders.OfX now implements Visitors.OfX directly, and so do data instances (such as Proxies.OfX.Data).
- Proxy and generated data instances and builders also have a member for named adjacencies, properties and links.
- Therefore no schema-defined property, adjacency, or link may be named `as_*` by convention to prevent collisions with Visitor methods in the generated data instances and builders.

## Reference vs. Value objects

- the dichotomy between reference and value objects remains declared via `Schemas.OfObject.Builder`: `.ref()` makes a reference object schema, and without it an object schema is a value object schema (`.value()` is dropped for now)
- reference objects may not be used as a property's value schema
- value objects are copied by value, never shared
- reference objects with a global name use that global name on the wire
- reference objects without a global name have a UUID on creation by `.create()` or `.clone()` that is saved on the wire
- Paths go away

## Mutability

- the mutableness of a visited object is a mode of the visitor itself
- value objects are mutable only during construction or cloning

- One protocol per kind: `Visitors.OfX` both reads and writes (`get`, `set`, `clear`, `insert`, ...); whether a write
  takes effect is the visitor's mode. There is no separate `Mutators.OfX`.
- Data instances (such as Proxies.OfX.Data) visit read-only, and also provide a compact read-only interface that allows
  analysis expressions to be compactly and efficiently written without '.get' operators.
- Builders (such as Proxies.OfX.Builder and <generated>.OfX.Builder) can be configured to permit or forbid writes.
- A visitor hands its mode to the child visitors it hands over (`as_property`, `as_value`, `as_adjacencies`,
  `as_linked`, ...); a value object is writable only under a builder that is constructing or cloning it.
- A write through a read-only visitor raises: refuse, never silently lose (mbse-basis P-002).
- Writer methods return nothing: a write that the visitor's mode, or the value itself, forbids raises. A write that
  loses nothing does not: inserting an entry equal to one a set relation holds elides it, and removing where no entry
  agrees removes nothing.
- Each language also declares a read-only static view of each `Visitors.OfX`, `Readers.OfX`, holding its reading
  methods only (a TypeScript interface, a Python `Protocol`). It is a type, not a second implementation: code that must
  not write (evaluators, validators, comparison, codegen's readers) takes a `Readers.OfX`, so that the type checker
  enforces it.
- Patterns.Stores.update(spec: Visitors.OfPredicate, cb: Callable[[Visitors.OfPredicate], Any]) -> Patterns.Stores.Certificate, handing the
  match over writable.
- A `Patterns.Stores.Certificate` is a compact record of an update, possibly including a coherence token of some sort,
  that can be used to track the effect of the write in a lazy distributed system.

## Seams

Where one protocol for reading and writing meets the code around it:

- code that must not write: the read-only static view (`Readers.OfX`), checked by type.
- writes to read-only data: raise, by the visitor's mode.
- children of a visitor: inherit its mode; value objects follow their owner's construction or cloning.
- one member both getter and setter on data instances and builders (`ent.linkName` read, `ent.linkName(spec)` write):
  Python's `__getattr__`/`__call__`; in TypeScript a `Proxy` with a function target, its `name` and `length` hidden, and
  generated declarations for the static types.
- reading inside a builder: readback of pending writes must be guaranteed
- journals (TODO.md, Journals): a journal that records writes implements the whole protocol, readback of pending writes included.

## Scalar accessors

```python
av: Visitors.OfAny
Visitors.OfAny.as_scalar[ScalarT](self, cb: Callable[[Visitors.OfScalar[ScalarT]], ReturnT]) -> ReturnT: ...

pv: Visitors.OfProperty

# shorthand
Visitors.OfProperty.as_scalar[ScalarT] = Visitors.OfAny.as_scalar[ScalarT]
Visitors.OfProperty.as_value(self, cb: Callable[[Visitors.OfAny], ReturnT]) -> ReturnT:...

# Yes, we need to restore OfNative but call it OfScalar
Visitors.OfScalar[ScalarT].has(self) -> bool: ...
Visitors.OfScalar[ScalarT].get(self) -> ScalarT|None: ...

# raises if the value cannot be set or cleared, regardless of prev value
Visitors.OfScalar[ScalarT].set(self, val_: ScalarT) -> None: ...
Visitors.OfScalar[ScalarT].clear(self) -> None: ...
```

## Property and Adjacency accessors

```python
# assumed
osv: Visitors.OfObject

osv.as_identity() -> str: ...
osv.as_identity(id_: str) -> None: ...

# visit a specific property (schema aware)
osv.as_property(name: str, cb: Callable[[Visitors.OfProperty], ReturnT]) -> ReturnT: ...

# iterate over all properties (schema unaware)
osv.as_properties(cb: Callable[[Visitors.OfProperty], ReturnT]) -> Iterable[ReturnT]: ...

# iterate over adjacency entries (schema aware)
osv.as_adjacency(name: str, cb: Callable[[Visitors.OfEntry], ReturnT]) -> Iterable[ReturnT]: ...

# iterate over all adjacencies (schema unaware); an adjacency is edited through what this hands over
osv.as_adjacencies(cb: Callable[[Visitors.OfAdjacency], ReturnT]) -> Iterable[ReturnT]: ...
```

## OfAdjacency accessors

```python
adv: Visitors.OfAdjacency

adv.select(spec: Visitors.OfEntry.Spec, cb: Callable[[Visitors.OfEntry], ReturnT]) -> Iterable[ReturnT] ...
adv.insert(spec: Visitors.OfEntry.Spec) -> None: ...
adv.remove(spec: Visitors.OfEntry.Spec) -> None: ...
```

## OfEntry accessors

```python
env: Visitors.OfEntry

# getters
env.as_linked(name: str, cb: Callable[[Visitors.OfObject], ReturnT]) -> ReturnT: ...
env.as_property(name: str, cb: Callable[[Visitors.OfProperty], ReturnT]) -> ReturnT: ...

# setters
env.as_link(name: str, linked_: Visitors.OfObject.Spec) -> None: ...
env.as_set(name: str, prop_: Visitors.OfProperty.Spec) -> None: ...
```

## Predicates

- `Schemas.OfPredicate` takes mbse-patterns' predicate as its model, moved down to mbse-schemas: it names its symbols,
  each with a referenceable object schema, binds its parameters as any schema does (`Schemas.OfParameter`), and holds
  its constraint (`requires`) as a `Schemas.Form`.
- mbse-schemas has no knowledge of expression dialects: a `Form` is a term's neutral shape (kind, attributes,
  arguments, dialect name), which `validate()` checks as a shape only. Which dialects are legal in a constraint, and
  what a term means, is for the caller's evaluator (`Schemas.Evaluate`), as for `Schemas.equivalent`.
- `Visitors.OfPredicate` visits a match: each symbol bound to an object, handed over as a `Visitors.OfObject`, in the
  match's mode.
- Finding matches in a store, and `Patterns.Stores.update(spec, cb)`, are mbse-patterns' extension of the store (queries are an
  extension); mbse-schemas defines only the types above.

## Another new problem:

Quite a few other convenience methods have been born like OfProperty.name, OfObject.has which are not necessary and whose names introduce possible collisions between the adjacency and property names and Visitor methods. Instead every `Visitors.OfX` will have a method `as_schema() -> Schemas.OfX`


## The protocol in full

The sections above, with the gaps they leave decided (Resolved, The visitor pattern). Every `Visitors.OfX` has
`as_schema()`, the `Schemas.OfX.Data` it visits; `ReturnT` is whatever a callback returns.

```python
Visitors.OfScalar[T]:  as_schema(); has() -> bool; get() -> T | None; set(value: T) -> None; clear() -> None
Visitors.OfAny:        as_schema(); as_scalar(cb) -> ReturnT; as_object(cb) -> ReturnT; as_union(cb) -> ReturnT
                       as_intersection(cb) -> ReturnT
Visitors.OfProperty:   as_schema(); has() -> bool; clear() -> None; as_value(cb: Visitors.OfAny) -> ReturnT
                       as_scalar(cb) -> ReturnT  # shorthand: as_value, then as_scalar
Visitors.OfObject:     as_schema(); as_identity() -> str  # its setter is V4's
                       as_property(spec: Schemas.OfProperty.Spec, cb) -> ReturnT
                       as_properties(cb) -> list[ReturnT]  # the properties present
                       as_adjacency(spec: Schemas.OfAdjacency.Spec, cb: Visitors.OfEntry) -> list[ReturnT]
                       as_adjacencies(cb: Visitors.OfAdjacency) -> list[ReturnT]
Visitors.OfAdjacency:  as_schema(); select(spec: Visitors.OfEntry.Spec, cb) -> list[ReturnT]
                       insert(spec: Visitors.OfEntry.Spec) -> None; remove(spec: Visitors.OfEntry.Spec) -> None
Visitors.OfEntry:      as_schema()  # a Schemas.OfEntry.Data
                       as_linked(link: str, cb: Visitors.OfObject) -> ReturnT
                       as_property(spec: Schemas.OfProperty.Spec, cb) -> ReturnT; as_properties(cb) -> list[ReturnT]
                       as_link(link: str, linked: Visitors.OfObject.Spec) -> None
                       as_set(spec: Schemas.OfProperty.Spec, value: Visitors.OfProperty.Spec) -> None
Visitors.OfUnion:      as_schema(); as_property(spec, cb) -> ReturnT; as_properties(cb) -> list[ReturnT]  # its branches
Visitors.OfIntersection: as_schema(); as_property(spec, cb) -> ReturnT; as_properties(cb) -> list[ReturnT]  # its parts
Visitors.OfPredicate:  as_schema(); as_symbol(name: str, cb: Visitors.OfObject) -> ReturnT  # a match; matching is mbse-patterns'
Readers.OfX:           each protocol's reading methods only
```

- **Who implements it**: `Proxies.OfX.Data`, read-only, and `Proxies.OfX.Builder`, writable unless it is made
  read-only (`.readonly()`). A child visitor has its parent's mode. A builder reads back its pending writes first,
  then its source.
- **No exceptions but one.** Reads never raise. Every callback is called: the visitor it is given reports an absent
  value as empty (`has()` False, `get()` None, `as_properties` and `select` an empty list), and so does a visitor of
  another kind than the value's (`as_object` on a scalar gives an object visitor with no properties), or of a property
  or adjacency the schema lacks. The one raise is a write that the visitor's mode or the value forbids, as
  `Errors.ReadOnlyError` (a `TypeError`): a write in read-only mode, or to a property, link or adjacency the schema
  lacks.
- **Writes**: through a writable visitor, `as_value` and `as_<kind>` write the value they are given, selecting the
  kind; `as_property` on an absent property creates it when written. Code that must know the kind before it chooses
  reads `as_schema()`.
- **Specs name schema elements by name**: a `Schemas.OfProperty.Spec` or `Schemas.OfAdjacency.Spec` names a property
  or an adjacency of the schema by its name; one the schema lacks, or whose type disagrees, gives an empty visitor.
- **`Visitors.OfEntry.Spec`** is a callable taking a writable `Visitors.OfEntry`, a template, and returning it, or an
  existing entry's `Visitors.OfEntry`. `select` gives the entries that agree with every link and property the template
  sets, all of them for an empty template ("selectors at this time are specific not descriptive"); `insert` adds it,
  the owner's own link filled, an equal entry in a set elided; `remove` removes every entry that agrees ("all that
  match").
- **`Visitors.OfObject.Spec` and `Visitors.OfProperty.Spec`**: an existing visitor, whose object is linked or whose
  value is copied, or a callable taking a writable visitor to fill and returning it.
- **An entry's links** are iterated through its schema, `as_schema().links`.

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)
