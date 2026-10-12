<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)

# Visitor pattern

The protocol through which code reads and writes data of any schema, as the user designed it; the decisions it
records are in the [framework design](FRAMEWORK.md), Resolved, "The visitor pattern". Nothing in it is built yet.

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
osv.as_property(spec: Schemas.OfProperty.Spec, cb: Callable[[Visitors.OfProperty], ReturnT]) -> ReturnT: ...

# iterate over all properties (schema unaware)
osv.as_properties(cb: Callable[[Visitors.OfProperty], ReturnT]) -> Iterable[ReturnT]: ...

# iterate over adjacency entries (schema aware)
osv.as_adjacency(spec: Schemas.OfAdjacency.Spec, cb: Callable[[Visitors.OfEntry], ReturnT]) -> Iterable[ReturnT]: ...

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
env.as_linked(linkName: str, cb: Callable[[Visitors.OfObject], ReturnT]) -> ReturnT: ...
env.as_property(spec: Schemas.OfProperty.Spec, cb: Callable[[Visitors.OfProperty], ReturnT]) -> ReturnT: ...

# setters
env.as_link(linkName: str, linked_: Visitors.OfObject.Spec) -> None: ...
env.as_set(spec: Schemas.OfProperty.Spec, prop_: Visitors.OfProperty.Spec) -> None: ...
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

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)
