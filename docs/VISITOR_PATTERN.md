<!-- nav -->
[← Serialization](SERIALIZATION.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)

# Visitor pattern

The protocol through which code reads and writes data of any schema, as the user designed it; the decisions it
records are in the [framework design](FRAMEWORK.md), Resolved, "The visitor pattern". It is built ([Meta-schemas
overhaul](META_SCHEMAS.md)): the schema-level changes in V1 (`as_*` names refused, `Schemas.OfScalar`, value objects
never linked, and `Schemas.OfEntry`, `Schemas.OfSymbol` and `Schemas.OfPredicate`), and the protocol, implemented by
proxies and read and written through by every consumer, in V2 and V3. Identity (V4), meta-schemas as linked objects
and `root_module()` (phase 5) and generated code (phase 6) are not built yet.

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
- for value objects as_identity should return None
- Paths go away

## Reference Identity

- reference objects with a singleton name (`.singleton("foo")`) use that global name on the wire, qualified with the schema's registered name and module name as appropriate
- reference objects can alternatively create a naming pattern passing it to `ref` (`.ref("FEA-(\d+\d\d)")`)
- validate will refuse a schema with both a singleton name and a ref naming pattern
- reference objects declared with `.ref()` (no pattern) have a UUID on creation by `.create()` or `.clone()` that is saved on the wire, qualified with the schema's registered name and module name ofc

```python
Feature = (
  Schemas.OfObject.Builder()
  .ref(r'FEA-(\d+\d\d)')
  ...create()
)
```

- The choice of formatted name and registration with the implied directory must happen automatically anytime a named reference object is created or copied
- programs can obtain the identity of any reference object via `Visitors.OfObject.as_identity`
- programs can find a specific reference object with `Stores.by_identity(id)`
- programs cannot set or modify their identity
- there is one directory store per schema within each store
- allocated IDs are strictly increasing (even in the presence of yet to be designed deletions)
- on snapshot load, repeated appearance of the same ID is interpreted as update


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
- a member is written by calling it, never by assignment: assigning to a builder's property or adjacency, or to any
  visitor, raises.
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

# singleton and iterable shorthands - type must match exactly
# all of these set the property value - no merging
osv.<propName>(value_: T) -> Visitors.OfObject: ...  # a value of the property's type: a scalar, a value object, ...
osv.<propName>(value_: Iterable[T | Specs.Callback[Visitors.OfAny]]) -> Visitors.OfObject: ...  # a container's elements
osv.<propName>(value_: Map[str, T | Specs.Callback[Visitors.OfAny]]) -> Visitors.OfObject: ...  # by index
# each element of a container given as an iterable or a map is a value, or a callback writing it through its visitor:
#   c.arguments([lambda e: e.variable(lambda v: v.name("x")), one])

# precisely configure the property value
osv.<propName>(cb: Specs.Callback[Visitors.OfProperty]) -> Visitors.OfObject: ...

# a property, or a container's element, whose value has one kind - an object, a union or an intersection - answers
# that kind's members: its properties, branches or parts, as through as_value and as_object, as_union or
# as_intersection. Read, a member reads the value held (empty where none is); written, it writes the value. A name
# that is not a member is not an attribute (Python: AttributeError; TypeScript: undefined).
osv.<propName>.<memberName> -> Visitors.OfY: ...
#   r.term(lambda t: t.call(lambda c: c.function("add")))
#     for r.term(lambda t: t.as_value(lambda a: a.as_union(lambda u: u.call(lambda c: c.function("add")))))
#   root.term.call.function.get()  # "add"

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

# comparison: a scalar visitor compares, orders and hashes as its value

# read-only visitors are hashable, writable ones not
card.name == "Ada"
card.age < 40
{card.name}

# TypeScript: [Symbol.toPrimitive] and valueOf, as far as they reach (EQUIVALENCE.md); `===` cannot be overloaded,
# so a scalar is compared once read: card.name.get() === "Ada"
```

## Adjacency accessors

```python
# iterate over adjacency entries (schema aware)
osv.<adjName> -> Visitors.OfAdjacency: ...  # also an Iterable[Visitors.OfEntry]

# peer shorthand - me/them with exactly two links
# treat as an insert unless `unique` forbids in which case it replaces
osv.<adjName>(value_: Iterable[OfThem.Visitor]) -> Visitors.OfObject: ...

OfThem.Visitor.<relPropName>(cb: Specs.Callback[OfAny.Visitor]) # set link property
OfThem.Visitor.<relLinkName>(cb: Specs.Callback[OfObject.Visitor]) # set linked object
OfThem.Visitor.<objPropName>(cb: Specs.Callback[OfAny.Visitor]) # set object property on "them"

# entry shorthand - me/them with exactly >2 links or >1 relation properties
# treat as an insert unless `unique` forbids in which case it replaces
osv.<adjName>(value_: Iterable[OfEntry.Spec]) -> Visitors.OfObject: ...

# callback form - precise but verbose edits to the relation
osv.<adjName>(vcb: Specs.Callback[Visitors.OfAdjacency]) -> Visitors.OfObject: ...

# iterate over all adjacencies (schema unaware); an adjacency is edited through what this hands over
osv.as_adjacencies(cb: Specs.Callback[Visitors.OfAdjacency]) -> Visitors.OfObject: ...
```

## OfAdjacency accessors

```python
adv: Visitors.OfAdjacency

# This works for all relations
adv.as_iterable(cb: Specs.Callback[Iterator[Visitors.OfEntry]]) -> Visitors.OfAdjacency: ...

# For containers with `unique` conditions or non-ordered indices, 
# these methods permit modification of the container values
adv.insert(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...
adv.remove(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...

# This version only applies to relations that are
# neither dict-like nor array-like in the current
# programming language
# cb is not called for unapplicable relations
adv.as_ordered(cb: Specs.Callback[Visitors.OfIterator[Visitors.OfEntry]]) -> Visitors.OfAdjacency: ...

# Visitors.OfPosition provides navigation in containers with 
# ordered indices and no `unique`
Visitors.OfIterator[T].first() -> Self : ... # move to beginning position
Visitors.OfIterator[T].last() -> Self : ... # move to beginning position
Visitors.OfIterator[T].next() -> Self : ... # move to next position or "past last"
Visitors.OfIterator[T].prev() -> Self : ... # move to prev position or "before first"

# Visitors.OfPosition may point to an existing item or may point
# to a symbolic position before the first or after the last item.
# For a read-only container, calling this method when pointed
# past the extent of the container results in no call to the cb
# For a writeable container, calling this method when pointed at
# past the extent of the container results in extension of the 
# container at that end and cb is called with a builder
Visitors.OfPosition[T].as_item(cb: Specs.Callback[Visitors.OfEntry]) -> Self : ... # return current item


Visitors.OfPosition[T].prepend(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...
Visitors.OfPosition[T].append(spec: Specs.Callback[Visitors.OfEntry]) -> Visitors.OfAdjacency: ...
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

## Containers

- Schemas.OfContainer is one of the variants under Schemas.OfAny and has an element type and an index type both of which are Schemas.OfAny
- OfRelation must have at least two links and can have any number of properties
- OfContainer with a total order on its index schema becomes an array/list in the target language
- ... or else OfContainer with a hashable index schema becomes an dict/map the target language
- ... or else OfContainer becomes of entries in the target language
- containers are allowed to nest
- containers with different index types are incomparable

## Another new problem:

Quite a few other convenience methods have been born like OfProperty.name, OfObject.has which are not necessary and whose names introduce possible collisions between the adjacency and property names and Visitor methods. Instead every `Visitors.OfX` will have a method `as_schema() -> Schemas.OfX`

---

<!-- nav -->
[← Serialization](SERIALIZATION.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)
