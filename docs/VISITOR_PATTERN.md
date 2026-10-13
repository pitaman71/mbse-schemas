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
def as_Y(self, cb: Specs.Callback[Visitors.OfY]) -> Self: ...
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

## Specs as queries

A widely used callback pattern that can serve either as a mutator or a limited value-matching query.

```
Specs.Callback[V in Visitors.Of*] = Visitors.DataType[V] | Callable[[V], V]
```

## Mutability

- the mutableness of a visited object is a mode of the visitor itself
- value objects are mutable only during construction or cloning

- One protocol per kind: `Visitors.OfX` both reads and writes (`get`, `set`, `clear`, `insert`, ...); whether a write
  takes effect is the visitor's mode. There is no separate `Mutators.OfX`.
- Data instances (such as Proxies.OfX.Data) visit read-only, and their named members and the scalar dunders
  (`str(card.name)`, Scalar accessors) are the compact read-only interface that allows analysis expressions
  to be compactly and efficiently written without '.get' operators.
- Builders (such as Proxies.OfX.Builder and <generated>.OfX.Builder) can be configured to permit or forbid writes.
- A visitor hands its mode to the child visitors it hands over (`<propName>`, `as_value`, `as_scalar`, `<adjName>`,
  `as_adjacencies`, ...); a value object is writable only under a builder that is constructing or cloning it; a link's
  target (`<linkName>`) is read-only through an entry (Seams).
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
- children of a visitor: inherit its mode; value objects follow their owner's construction or cloning; a link's
  target is read-only through an entry: an entry's builder relinks (`env.<linkName>(spec)`), and an object is edited
  through its own builder.
- a link member on a data instance is the linked instance itself (`entry.phone is p`); data instances are callable, so
  that calling one, a write, raises.
- one member both getter and setter on data instances and builders (`ent.linkName` read, `ent.linkName(spec)` write):
  Python's `__getattr__`/`__call__`; in TypeScript a `Proxy` with a function target, its `name` and `length` hidden, and
  generated declarations for the static types.
- reading inside a builder: readback of pending writes must be guaranteed
- journals (TODO.md, Journals): a journal that records writes implements the whole protocol, readback of pending writes included.

## Scalar accessors

```python
av: Visitors.OfAny
av.as_scalar[ScalarT](self, cb: Specs.Callback[Visitors.OfScalar[ScalarT]]) -> Visitors.OfAny: ...
av.clear() -> None : ...

pv: Visitors.OfProperty

pv.as_value(self, cb: Specs.Callback[Visitors.OfAny]) -> Visitors.OfProperty:...

# shorthand
pv.as_scalar[ScalarT] = Visitors.OfAny.as_scalar[ScalarT]
pv.as_object = Visitors.OfAny.as_object  # for conciseness: as_value already reaches it
pv.get() -> ScalarT | None : ...  # pass-through to as_scalar, as the dunders are: card.street3.get() is None

sv: Visitors.OfScalar[ScalarT]

sv.get() -> ScalarT | None : ...
sv.set(value_: ScalarT) -> None : ...

# alias for parent (any) clear
sv.clear() -> None : ...
```

## Property accessors

```python
# assumed
osv: Visitors.OfObject

osv.as_identity() -> str: ...
osv.as_identity(id_: str) -> None: ...

# visit a specific property (schema aware)
osv.<propName> -> Visitors.OfProperty: ...
osv.<propName>(cb: Specs.Callback[Visitors.OfProperty]) -> Visitors.OfObject: ...

# iterate over all properties (schema unaware)
osv.as_properties -> Iterable[Visitors.OfProperty]
osv.as_properties(cb: Specs.Callback[Visitors.OfProperty]) -> Visitors.OfObject: ...

# explicit `get` on scalar returns native-typed value; as_scalar has no attribute form
card.name.as_scalar(lambda s: names.append(s.get()) or s)  # "Ada", or None when absent

# implicit `set` or `clear` on scalar
b.name.as_scalar(lambda s: s.clear())
b.name.as_scalar(lambda s: s.set("Ada")) # a write, through a Spec's callable form
b.name.as_scalar("Ada")            # shorthand for `set`, through a Spec's value form

# dunder shorthands = syntactic sugar over `get`, on Visitors.OfScalar and, passing through as_scalar, on
# Visitors.OfProperty
# raise when not set or mistyped: each needs the scalar's own type (int() an int, str() a str, ...)
# bool : same as others, not semantically overloaded with "is_valid"
int(card.age)
float(card.weight)
str(card.name)
bool(card.vip)
bytes(card.photo)

# TypeScript: [Symbol.toPrimitive] and valueOf, as far as they reach (EQUIVALENCE.md)
```

## Adjacency accessors

```python
# iterate over adjacency entries (schema aware)
osv.<adjName> -> Visitors.OfAdjacency: ...  # also an Iterable[Visitors.OfEntry]
osv.<adjName>(Specs.Callback[Visitors.OfAdjacency]) -> Visitors.OfObject: ...

# iterate over all adjacencies (schema unaware); an adjacency is edited through what this hands over
osv.as_adjacencies(cb: Specs.Callback[Visitors.OfAdjacency]) -> Visitors.OfObject: ...
```

## OfAdjacency accessors

```python
adv: Visitors.OfAdjacency

adv.select(spec: Specs.Callback[Visitors.OfEntry], cb: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency ...
adv.insert(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...
adv.remove(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...
```

## Other kinds

```python
# as_scalar's siblings, for the other kinds of value
av.as_object(cb: Specs.Callback[Visitors.OfObject]) -> Visitors.OfAny: ...
av.as_union(cb: Specs.Callback[Visitors.OfUnion]) -> Visitors.OfAny: ...
av.as_intersection(cb: Specs.Callback[Visitors.OfIntersection]) -> Visitors.OfAny: ...

# a union's branches and an intersection's parts are members giving the visitor of their own type's kind, Visitors.OfY:
# OfScalar, OfObject, OfUnion or OfIntersection (shape.circle.radius); a branch the union does not hold reads empty
uv: Visitors.OfUnion
uv.<branchName> -> Visitors.OfY: ...
uv.<branchName>(cb: Specs.Callback[Visitors.OfY]) -> Visitors.OfUnion: ...  # writing one branch clears the others
iv: Visitors.OfIntersection
iv.<partName> -> Visitors.OfY: ...
iv.<partName>(cb: Specs.Callback[Visitors.OfY]) -> Visitors.OfIntersection: ...

# a match's symbols are members
pdv: Visitors.OfPredicate
pdv.<symbolName> -> Visitors.OfObject: ...
```

## OfEntry accessors

```python
env: Visitors.OfEntry

# accessors
env.<linkName> : Visitors.OfObject
env.<linkName>(spec: Specs.Callback[Visitors.OfObject]) -> Visitors.OfEntry: ...
env.<propName> : Visitors.OfProperty
env.<propName>(spec: Specs.Callback[Visitors.OfProperty]) -> Visitors.OfEntry: ...

# an entry's properties are walked without knowing the schema through its schema, env.as_schema()
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
