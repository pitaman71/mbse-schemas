<!-- nav -->
[← 9 · When requirements change: evolving schemas (TypeScript)](../typescript5/tutorials/09_When_Requirements_Change.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)

# Schemas Framework

A framework that allows programmers to encode data structure schema
with a robust language-independent type algebra using an in-language DSL.

Given a schema, bindings for a wide variety of
programming languages such as Python, Typescript, C++, SystemVerilog, etc.
can be automatically and deterministically generated.

All bindings also support "dynamic" implementations which allow programs to
be written that forego the code-generation step entirely, using lazily typed
proxies as the in-memory representation.

## Elements

The schema elements include:

- `OfAny` : a value of any type
- `OfNative` : a native value, whose type is a token `{format, name}` (see Native types below), with an optional width in
               bits or bytes. In Python the host types are `int`, `float`, `str`, `bool` and `bytes`.
               Conversion between the native format and the over-the-wire format is the responsibility of `Schemas.OfNative`.
- `OfObject` : named properties list where each property has type described by `OfAny`. An `OfObject` schema describes
               reference objects when marked `.ref()`, and otherwise value objects; see Value objects and
               reference objects. An `OfObject` schema may declare
               a singleton global name; that single instance is created implicitly, must always exist, and is referenced
               by its global name. Properties are optional: nothing is mandatory except as specified by a constraint.
- `OfRelation` : describes a relationship between objects (must be objects not values)
                 with a named link for each linked object. No particular cardinality
                 is assumed unless declared by `unique` clauses (see Cardinality below). Relations completely subsume maps/dictionaries and pointers: since entries
                 carry properties, a map `a -> [key] -> b` is represented as a relation with
                 links `a` and `b` and property `key`.
                 A relation must not merge a relation and an object: a one-link relation whose entries carry
                 the data (e.g. a contact's phone numbers as entries holding `number`) is not legal. Model the
                 data as an `OfObject` and link it to its owner with a relation.
- `OfProperty` : a property of an object or a relation's entries: its `name` and `type`, an `OfAny`. An object's or
                 relation's `properties` map each name to its `OfProperty`, in declared order, so a property's type is
                 `schema.properties['home'].type`.
- `OfParameter` : a parameter a schema of any kind declares: its `name`, `type` and `description`, a variable determined
                  where the schema is referred to (see Parametrics).
- `OfApply` : a parametric schema applied to arguments, a type whose values are the applied schema's (see Parametrics).
- `OfAdjacency` : declares that a particular `OfObject` is adjacent to an `OfRelation` via
                  a particular link name. Relations name their links without types
                  (`.links('contact', 'address')`); each object declares its adjacencies:
                  `.relations(lambda adj: adj.name('addresses').of(ContactAddresses).me('contact'))`, where
                  `name` is the accessor on the object, `of` the relation, and `me` the link the object fills.
                  Because relations and objects refer to each other, schemas are typically defined in phases:
                  objects first, then relations, then each object's adjacencies added with
                  `Schemas.OfObject.Builder(existing).relations(...).update()`.
- `OfEntry` : describes the contents of entries which must include the links
              and may include properties
- `OfUnion` : of two or more named branches, each an OfX schema (all of the same kind). A value holds exactly one
              branch, by name (see Unions and intersections by name).
- `OfIntersection` : of two or more named parts, each an OfX schema (all of the same kind). Used to implement object and
                     aspect oriented structures. A value holds every part, by name; parts do not merge, so two parts may
                     declare the same property, even with different types.
- `OfIndexed` : a list of items, in order, each a value of one item schema of any kind but a reference object
                schema (see Lists).

Every element may be described: each kind of schema, each property, adjacency, union branch and intersection
part takes `.description(text)` on its builder, and its data holds `description`, text or none. A description is
documentation, for people and for generated code; validation reports one that is not text, and no validation,
conversion or comparison of data reads it. A native's description is part of the native, as its name is.

A property whose schema is an `OfObject` holds a *value object*: a read-only record of that
schema's properties that belongs to its owner, copied with it and written nested in its owner's snapshot. It has an
identity, and its schema may declare adjacencies, however it is held (directly, through a union branch or an
intersection part); see Value objects and reference objects.
A property whose schema is an `OfIndexed` holds a list, whose items belong to the property's owner as its own
value would (see Lists).
A property whose schema is an `OfUnion` holds a union value: a record whose properties are the union's branches, holding
exactly one of them. A property whose schema is an `OfIntersection` holds an intersection value: a record whose
properties are the intersection's parts, holding each of them. `Visitors.OfUnion` and `Visitors.OfIntersection` read
and write them like a value object's properties (`properties`, `has`, `property`, `clear`), and writing a union's
branch clears any other.

Named references are handled entirely by relations with a property (or properties) for the index value.
For example, a global ID directory is a relation linking a singleton directory object to each object, with the ID as a
property of the entry.
In a well-formed database, and at the end of a well-formed mutation transaction, every object whose schema declares a
directory entry has exactly one, under its schema-defined key.

Well-formedness is checked by validation, which runs only when the caller invokes it. It is not checked automatically
at the end of a transaction.

An object may have more than one owner.

When an object is deleted, every relation entry linking it vanishes with it.

Packing is captured separately as a process, steps of which have their own schema.

Relation data must live either on object adjacencies or in a global table, and the choice is implementation defined.

### Cardinality

A relation's entries form a set: adding an entry equal to an existing one (see `EQUALITY.md`) is silently elided.

No cardinality is assumed by default. A relation declares cardinality with zero or more `unique(S)` clauses, where `S`
is a set of its links and properties. `unique(S)` means that the links and properties not in `S`, taken together,
determine the values of `S`: any two entries that agree on everything outside `S` must also agree on `S`.
Equivalently, the links and properties outside `S` form a key. Each clause is a separate constraint, so any combination of keys can be expressed.

- Pure ownership, where each child has at most one parent:
  `.links(parent, child).unique(parent)`
- Keyed ownership, where each child has at most one parent and one key within it (a parent may still have several
  children under the same key):
  `.links(parent, child).properties(key).unique(parent, key)`
- Directory, which is keyed ownership where each key also resolves to at most one child per parent:
  `.links(parent, child).properties(key).unique(parent, key).unique(child)`
- Global ID directory, where each ID resolves to at most one object:
  `.links(directory, object).properties(id).unique(object)`, where `directory` is a singleton
  Adding `.unique(id)` also limits each object to at most one ID.
- `unique` over every link and property of the relation : at most one entry in the relation

Uniqueness gives only an upper bound. Requiring at least one entry is a separate constraint, written with
[mbse-patterns](https://github.com/pitaman71/mbse-patterns): `count(entries(this, 'phones')) >= 1`.

### Equality

Equality is defined by the schema, never by host-language `==`, and ordering only for ordered native types. See
[Equality](EQUALITY.md) for its definition, hashing, ordering, the `Comparison` module, and the edge cases still to
confirm.

## Builder pattern

The schema must itself be serializable. For that reason, a model implemented as `Schemas.OfX.Data` will have two additional classes:
`Schemas.OfX.Builder` and `Schemas.OfX.Schema`. `Schemas.OfX.Schema` is the meta-schema that defines `Schemas.OfX.Data`.

`Schemas.OfX.Builder` - takes an optional instance of `Schemas.OfX.Data` as the sole argument, stores the data as mutable shallow copies
separate from the optional instance, and exposes accessor methods that the caller can use to modify the schema. The builder is finalized by one of:

- `create()` : returns a new `Schemas.OfX.Data` built from the builder state. Only valid when no source instance was given.
- `clone()` : returns a new `Schemas.OfX.Data` built from the builder state, leaving the source instance untouched. Only valid when a source instance was given.
- `update()` : writes the builder state back into the source instance and returns it. Only valid when a source instance was given.

None of these validate; validation happens only when the caller asks for it.

`Schemas.OfAny.Builder` is the builder used wherever a schema of any kind is expected (e.g. a property's type). It
selects the kind through `as_<kind>` methods, e.g. `as_native(str)` for `OfNative`.

Finalizing a `Schemas.OfAny.Builder` after an `as_<kind>` call yields that kind's data, e.g. `Schemas.OfNative.Data`
after `as_native(str)`, not a `Schemas.OfAny.Data` wrapping it.

Builder methods are fluent: they return the builder itself (`self`).

Throughout the builder pattern, an argument that describes a sub-structure is a `Spec`: an auxiliary type that is either
a direct value or a callable that takes and returns the corresponding builder. For example:

- A property's `of(...)` takes a `Schemas.OfAny.Spec`: either a `Schemas.OfAny.Data` or a
  `Callable[[Schemas.OfAny.Builder], Schemas.OfAny.Builder]`.
- `as_native` takes a `Schemas.OfNative.Spec`: either one of the supported native types directly (e.g. `str`, the
  `basic` token `str`) or a `Callable[[Schemas.OfNative.Builder], Schemas.OfNative.Builder]`, whose builder sets a
  host type (`.type(int)`), a token in any format (`.token('ccpp', 'int32_t')`) and a width (`.bits(32)`,
  `.bytes(4)`).

Anonymous sub-schemas are created inline by passing a lambda that receives a builder, e.g.
`prop.name('street1').of(lambda t: t.as_native(str))`, where `t` is a `Schemas.OfAny.Builder`. The lambda only
configures the builder; it is not part of the resulting schema, which stays serializable.

Instances of a user schema follow the same pattern. With the dynamic (proxy) implementation (see `python3/mbse/Schemas/Examples/AddressBook.py` and `typescript5/src/Examples/AddressBook.ts`):

- A schema is named by its builder: `Schemas.OfObject.Builder().name('crm.Contact')`, on any kind of schema. A name
  is identifiers separated by dots, the part before the last dot its namespace; `validate()` reports any other.
- `store = Proxies.OfStore()` makes a store (see Stores), and `store.register(schema)` registers a named schema in it,
  under its name; an unnamed schema is refused.
- `store.Name(optional instance)` returns a builder for that schema with one fluent setter per property
  (e.g. `.street1('foo')`), finalized by `create()` / `clone()` / `update()` as above.
- Relation entries are added through the object builder's adjacency accessors, never through a relation builder
  (none is exposed to the caller). An accessor takes a `Spec` for the entry. The object fills its own link (`me`); the
  entry builder sets the other links and the entry properties. A link takes an existing object or a `Spec` that
  builds a new one; the lambda form requires the new object's schema to be
  inferred unambiguously from the relation and link:

  ```python
  .addresses(lambda x: x.address(addr1).label('work'))
  .phones(lambda x: x.phone(lambda y: y.number('+447700900123')).label('mobile'))
  ```
- Each setter takes a `Spec` like any other builder argument: a direct value, or a callable that takes and returns a
  value builder:

  ```python
  .street1('foo')
  # equivalent to
  .street1(lambda v: v.set('foo'))
  ```

- A property is cleared (made absent) through the value builder: `.street2(lambda v: v.clear())`.
- Instances expose their properties for reading as ordinary attributes (e.g. `addr1.street1`). This access is
  read-only; changes go through a builder. Reading a property that is not set raises an error (`AttributeError` in
  the Python binding).

To make schemas fully serializable, `Schemas.OfX.Builder` must implement `Visitors.OfX`.

This is known as the "builder pattern" and must be followed by proxies, generated code, expression models, etc.

## Implementation

Implementation is strictly typed in all languages - parameters, returns, etc.

- `Visitors` : for each schema element `OfX`, `Visitors.OfX` defines a schema-agnostic interface for a handle that can traverse, analyze, and modify a data structure provided its schema object regardless of whether or not the source for that process knows the schema at compile time. `Visitors.OfAny` dispatches on kind through `as_<kind>(callback)` methods: each passes the kind's visitor to the callback and returns `self`, so calls chain; when reading, only the callback for the value's actual kind runs. More generally, visitors never return child visitors (properties, adjacencies, entries, links, union and intersection values); they pass them to callbacks. Every visitor method that is not a query returns `self`, so calls chain.
- `Schemas` : for each schema element `OfX`, `Schemas.OfX.Data` is used to capture a schema. Schemas may be named (registered by a name in a store) or appear inline without a name.
- `Stores` : `Stores.Store` is the protocol of a store, the root object through which schemas, builders and objects
  are located (see Stores). Everything that looks a schema up by name takes a store.

- `Mutations` : for each schema element `OfX`, `Mutations.OfX` is used to represent incremental changes to anything that has a schema,
  including schemas themselves (via their meta-schemas). Mutation types scale with the number of schema elements, not with the number of user schemas.
  The vocabulary for each kind is the obvious set for that kind (e.g. creating and deleting an `OfObject`, setting its
  properties, adding and removing `OfRelation` entries).

- `Validators` : `Validators.Validate(store)(schema, value)` checks data against its schema and returns a list of
  problems, each with a path (e.g. `Student#0.enrollments[1].credits: expected int, got bool`). `.Reachable(schema, root)`
  checks everything reachable from the root. It is constructed with the store that looks schemas up by name, and runs
  only when the caller asks. It checks the schemas' own `validate()`, exact native types
  of properties and entry properties, that every link is set and filled by an object whose schema declares an
  adjacency via that link, `unique(...)` clauses over the entries seen, value objects' properties and entries
  recursively (a link to a value object is checked against its schema when its owner is validated too),
  that a union value holds exactly one of its branches and an intersection value every one of its parts, each with a
  value of its type. The validator is a visitor: objects write
  themselves into it through `accept`. `Validators.properties_of(value)` returns the property values any object writes when
  visited (a list as a `ListRecord` of its items and keys), and `Validators.entries_of(value)` its entries by adjacency
  (each an `EntryRecord` of its other links' targets and its property values), for other modules and packages that
  read objects (e.g. mbse-expressions' evaluators). `Validators.Check(store, evaluate)` checks the same and also reports
  what it cannot decide, an extent over unbound parameters for one (see Parametrics).

- `Comparison` : for each schema element `OfX`, `Comparison.OfX` implements `Visitors.OfX`, records the value written
  into it, and compares it with another recording: `a.compare(b)` returns -1, 0, 1, or `None` when incomparable. See
  `EQUALITY.md`.

- `Modules` : schemas as data. `Modules.module(store, schemas)` returns an object of the meta-schema
  `Schemas.Module.Schema`, built in `store`, holding named schemas, and `Modules.schemas(store, module)` the schemas it
  holds, by name. See Meta-schemas.

- `Adapters` : translate between a language's own type declarations and schemas, so they are specific to each
  language. Python has `Adapters.Dataclasses`: `FromDataclass(cls)` returns the `OfObject` a dataclass describes and
  `ToDataclass(schema, name)` returns a new dataclass, both through `ast` trees rather than source text;
  `FromDataclass.model(*classes)` and `ToDataclass.model(schemas)` translate several at once. Only types are
  translated. Native fields are properties. A container of dataclasses (`set[X]`, `list[X]`, `dict[K, X]`) is a
  relation with links `owner` and `item`, plus `index: int` or `key: K` with `unique(item)` for lists and dicts: the
  owner's adjacency is the field, and each element class gets an adjacency via `item`. Adjacencies declare which
  object schemas may fill a link, so writing a class finds a container's element type by reverse lookup, and writes
  fields only for adjacencies via a relation's first link. Defaults, mandatoriness and nested classes (value
  objects) are left out or refused.

## Stores

A store is the root object of a body of data: it holds named schemas, and the data reachable from its roots. Code
locates schemas, builders and objects through a store, never through a global. Implemented in `Proxies.OfStore` and
`Bindings.OfStore`; envisioned also for generated (language-optimized) data structures, SQL and noSQL databases, and
in-memory cache slices.

- **`Stores.Store` is the protocol**, which every implementation of the framework meets:
  - `schema(name)`: the object schema registered as `name` (`AttributeError` if none is; `TypeError` for a relation);
    `registered(name)`: the object or relation schema (`LookupError` if none is); `name_of(schema)`: the name a schema
    is registered under (`LookupError` if it is not); `names()`: every registered name, in registration order.
  - `builder(name, instance=None)`: a builder for the object schema `name`, a `Visitors.OfObject` finalized by
    `create()`, or by `clone()` / `update()` of `instance`.
  - `member(instance, name)`: the value an instance holds in its property `name` (a value object, a union's branch).
  - `singleton(name)`: the one instance of the singleton schema whose global name is `name` (`LookupError` if there is
    none).
  - `extent(name)`: the store's reference objects of the schema `name`: those reachable from its singletons, in
    first-reference order.
- **Stores combine.** `Stores.Combined(*stores)` is one store of several: each name belongs to the one store that
  registers it (a name two register is refused), which gives its schema, builds its objects and reads their members;
  its singletons are all of theirs, and an extent is the owning store's and what every store's singletons reach, so the
  objects of one store may link to another's, and combined stores combine again. A transform reads a store of schemas
  (`Reflection.of`) and writes a store of syntax trees (mbse-programs) through one.
- **A random source is given to whatever draws from it** (mbse-patterns' samplers and generators:
  `Generate(store, weights, Stores.PCG32(42))`), not held by a store, which is data access alone. `Stores.Random` is the
  protocol: `next_u32()`, the next 32 random bits, and
  `split(key)`, an independent stream determined by the source's seed and `key` alone, not by what was drawn before.
  `Stores.PCG32(seed, sequence)` is the reference source, specified exactly so that every implementation draws the
  same numbers: PCG-XSH-RR with a 64-bit state, seeded as `pcg32_srandom`; `split(key)` seeds a new PCG32, with the
  same sequence, from FNV-1a 64 of the key's UTF-8 bytes, starting from the offset basis XOR the seed. Any other source
  meets the protocol, at the cost of drawing other numbers.
- **A store's roots are its singletons.** Registering a singleton schema (`.singleton("GlobalName")`) makes its one
  instance, which the store holds for as long as it lives; registering a second schema with the same global name is
  refused ("singleton 'X' is already registered"). A builder refuses to `create()` or `clone()` a singleton schema's
  object ("create() would make a second 'X'; its one instance is store.singleton('GlobalName')"); it is changed by
  `update()`, and decoding a snapshot that holds one updates the store's instance rather than making another.
- **A store's data is what its roots reach**: every reference object reachable from a singleton through relation
  entries (see `Reachable`), with the value objects those own. Everything else built with a store's builders is
  *transient*: it belongs to the store (its schemas, isolation) but lives only while the program holds it, and is
  garbage-collected when it no longer does. Linking a transient object to data makes it data. So a long-lived store
  (a dialect's, say) does not accumulate the objects built with it.
- **Entries live on the objects they link**, each end holding its side; a store keeps no relation tables. An entry
  linking a transient object is reachable only through that object, and goes with it.
- **Stores are isolated.** Each store has its own schemas, objects and entries: two stores may register the same name,
  and an object of one store cannot be linked to, or used as the source of a builder in, another ("the object belongs
  to another store"). Tests and programs make the stores they need. Objects move between stores, or implementations,
  as snapshots.
- **Every store of proxies starts with the meta-schemas registered** (`Stores.META`: `Schemas.Module`, whose schemas
  are value object schemas and need no names), so it can hold modules of schemas (see Meta-schemas). A store of bound
  classes holds only the classes bound to it.
- **A proxy knows its store.** `Proxies.store_of(value)` gives the store a proxy belongs to, and a placed value
  object's is its owner's.
- **Everything that looks schemas up takes a store**: `Plain.ToPlain(store)` and `Plain.FromPlain(store)`, the JSON and
  YAML forms, `Validators.Validate(store)`, `Modules.module(store, ...)` and `Modules.schemas(store, ...)`, and a
  builder inferring the schema of an object it creates through a link (from the store's schemas).
- **Queries are an extension.** The protocol locates schemas, builders, singletons and extents; selecting objects by a
  condition belongs to [mbse-patterns](https://github.com/pitaman71/mbse-patterns), whose queryable store protocol adds
  `select` and whose `Scan` answers queries over any store's extents, with mbse-expressions' expressions as the
  conditions. A store that can answer a query natively (a database) implements `select` itself.

## Proxies

- `Proxies` : for each schema element `OfX`, `Proxies.OfX.Data` defines how the schema can be stored in memory as schema-independent types, and `Proxies.OfX.Builder`, like every builder, implements `Visitors.OfX`. Proxies themselves do not implement `Visitors`; if they have an interface for traversal, it is `Visitable` (a proxy accepts a visitor), not `Visitor`. `Proxies.OfX.Builder.validate` can be used to check the current state of the configured item. Validation is never implicit: it runs only when the caller invokes it.

## Typed bindings

`Proxies` gives any registered schema dynamic instances; `Bindings` gives a program's own classes, written or generated
in its language, the same part in the framework: their instances are `Visitable`, they have builders that implement
`Visitors.OfObject`, and a store rebuilds them from snapshots. It is the core the generated bindings (mbse-python,
mbse-typescript, ...) will share, and mbse-expressions' expressions are its first user.

- **A binding pairs a reference object schema with a class.** `Bindings.Binding(schema, read, make)` is the schema, the
  source of truth, with two functions: `read(instance)` gives an instance's `State`, and `make(state)` builds an
  instance from one; `assign(instance, state)` writes a state into an existing instance, for `update()`.
- **A state is the instance's data in the schema's terms**: each property's value, natives as natives and other values
  (value objects, unions, lists) in their plain form; and each adjacency's entries, each an `Entry` of its links (the
  linked instances) and its properties. The class keeps its own fields; the binding's two functions translate.
- **Everything else is generic.** `Bindings.accept(binding, instance, visitor)` writes an instance through the
  visitor protocols, so the class's `accept` is one line; `Bindings.Builder(binding, instance)` is a
  `Visitors.OfObject` over a state, with every value kind the schema declares (natives checked by type, value objects,
  unions and lists through plain data), `create()`, `clone()` and `update()`; and `Bindings.OfStore(bindings)` is a
  store of bound classes (see Stores), whose builders make the instance of each singleton schema when the store is made. A class's own builder derives from `Bindings.Builder` for its DSL.
- **A binding may declare what the schema cannot**: `fixed` properties, whose value is the class's (a tag, such as an
  expression's `kind`), so that writing another raises; `exclusive` groups of properties, of which a state holds at
  most one, so that writing one clears the others (a literal's value, under the property named after its native type);
  and `implied` adjacencies, whose entries the other ends imply, so that the builder ignores entries added to them.
- **Absent is no value.** A state has no key for an absent property, and a builder drops the keys a class's `read`
  gives without a value (None, null); an entry property without a value is not written. A fixed property is compared
  by value, bytes included, and type-checked first, as every native is.

## Serialization

Both in-memory objects and mutations (see `Mutations`) are serializable.

Over the wire, object content carries no schema. Association of an object with a schema is done dynamically, starting
from the expected root schema, which is why deserializers such as `Plain.FromPlain(store)(schema, ...)` take it as an
argument, and continuing through property types and the branch written with each union value. Links are untyped, so a serialized
reference to a linked reference object carries that object's schema name alongside its symbol. Consequently, a
reference object that is linked from another object must have a named (registered) schema. A reference to a value
object carries no schema, since its owner's schema gives it, and a reference object that only such references reach
carries its schema itself, `{"$schema": "Card", ...}`: an object carries its schema whenever nothing else gives it.

A transaction is a flat sequence of symbol bindings and mutations. Mutations may be nested; transactions are not.

- Objects are identified over the wire by transaction symbols, which are strings. The identity of each object is
  recorded as a direct assignment to its symbol.
- A symbol binding is local to its transaction. A later transaction in the same file refers to the same object by
  repeating the same string.
- The serializer and deserializer are responsible for a precisely 1:1 mapping between in-memory identities and
  symbols. The mapping must be consistent (the same object always gets the same symbol, different objects never share
  one) and checkably so: a deserializer must reject a symbol assigned to two objects or an object assigned two symbols.
- Symbols bind only to objects, never to values or entries.
- Singletons are referenced by their global name and never need a symbol.
- A value object is written nested, as a mapping of its properties and its adjacencies, with its symbol as `$id`
  when something links to it. Union and intersection values are written the
  same way, keyed by branch or part name: a union value `{"phone": {"number": "1"}}` has exactly one key, and decoding
  rejects any other count; an intersection value `{"stamp": {...}, "audit": {...}}` has a key per part, and a missing
  part is for `Validators` to report.
- Only a `create` mutation creates an object. A reference never creates one.

- `Plain` : for each schema element `OfX`, `Plain.ToPlain.OfX` and `Plain.FromPlain.OfX` implement `Visitors.OfX` and
  convert between values and plain data (dicts, lists, strings, numbers, booleans, null). `Plain.ToPlain(store)(schema,
  value)` and `Plain.FromPlain(store)(schema, plain)` dispatch on the schema's kind; the store names the schemas of the
  objects written, and builds the objects read. `Schemas.OfNative` converts natives to forms plain
  data can hold (`bytes` as base64 text; non-finite floats as the strings `NaN`, `Infinity`, `-Infinity`), so text
  encodings never handle that themselves. An object's plain form includes its
  adjacencies; linked objects appear as transaction symbol references, not nested content. Deserializing a snapshot
  that references an object it does not contain is an error.
  An object snapshot is `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to plain
  values and adjacency names to lists of entries; an entry maps the other links to references and the entry properties
  to plain values (the object's own link is implied). A reference is `{"$ref": symbol, "$schema": name}`, or
  `{"$ref": symbol}` to a value object. Symbols are assigned in the order objects are first referenced, value objects
  included. `Plain.ToPlain(store).OfObject` includes only the root, so its references
  are unresolved; `Plain.ToPlain(store).Reachable` includes every object reachable through adjacencies. An entry appears under
  each object it links; on deserialization the duplicate is elided.
- `JSON` : `JSON.ToJSON(store)(schema, value)` returns JSON text and `JSON.FromJSON(store)(schema, text)` rebuilds values;
  both mirror `Plain` (`.OfNative`, `.OfObject`, `.Reachable`). Output is strict JSON (RFC 8259) with key order kept;
  input with NaN / Infinity literals or duplicate keys is rejected.
- `YAML` : `YAML.ToYAML(store)` / `YAML.FromYAML(store)`, mirroring `JSON`. Requires PyYAML (the `yaml` extra), imported
  only when used. Loading follows the YAML 1.2 core schema rather than PyYAML's YAML 1.1 defaults: only `true` /
  `false` are booleans, `010` is ten, `1:30` and unquoted dates are strings. Duplicate keys, multiple documents,
  non-string keys and non-plain values (e.g. `!!binary`, `!!set`) are rejected. Dumping quotes any string a YAML 1.1
  or 1.2 reader would misread and never emits aliases.
- JSON and YAML are thin text encodings of `Plain` data.

### Decoding errors

Every problem in the data being decoded raises `Errors.DecodeError`, a subclass of `ValueError`. This covers
`JSON.loads`, `YAML.loads`, `Plain.FromPlain`, `JSON.FromJSON`, `YAML.FromYAML` and `Schemas.OfNative.Data.from_plain`.
Mistakes in the calling program keep their usual classes, e.g. a root schema that is not an object schema raises
`TypeError`.

- `reason` is one line of text with no location in it.
- The location is `line` and `column` for text (1-based, counted in code points), or `path` for plain data, e.g.
  `$.objects.s0.addresses[1].label`. Keys that are not identifiers are written in brackets, as JSON strings:
  `$.objects["my key"]`. A problem may have no location, e.g. undecodable bytes.
- The message is `line 3, column 7: reason`, or `$.path: reason`, or just the reason.
- If text has several problems, the first in the text is reported. A snapshot is checked in a fixed order that every
  binding follows: its shape, then the references (inferring each object's schema), then each object's keys and
  values in snapshot order, and last any object nothing references.
- Nothing is built when a `DecodeError` is raised: a snapshot's shape, references and native values are all checked
  before any builder is called.
- Reasons and locations are identical in every binding, with one exception. For YAML syntax errors (and for
  constructs that one parser accepts and another rejects), the reason text and location come from each binding's
  parser. The framework's own YAML profile is identical: one document, string keys, no duplicate keys, no tags except
  `!`, `!!str`, `!!seq` and `!!map`, and no undefined aliases.
- Bytes are decoded as UTF-8, UTF-16 or UTF-32, detected as JSON specifies (RFC 8259 and its predecessors) for both
  JSON and YAML input. Undecodable bytes give `input is not valid <encoding>`.

## Value objects and reference objects

Implemented, except where a bullet says otherwise. This lifts the earlier decision that a value object has no identity
and no adjacencies, so that an object can be composed of parts that take part in relations (a component's ports, a
schema's properties). The terms are to replace "value object" and "object" throughout the API's messages and these
documents.

- **Every object has an identity**, and any object can be linked by relations. What distinguishes the two kinds is
  ownership, and the schema says which kind it describes: `Schemas.OfObject.Builder().ref()` marks a *reference object
  schema*; an object schema without it is a *value object schema*. A singleton's schema is a reference object schema.
- **A reference object** stands on its own: a snapshot writes it once among its `objects`, under its symbol. A
  snapshot's root is a reference object, and a store's builders (`store.<Name>()`) make only reference objects. A reference
  object schema is never a property's type, directly or as a union's branch or an intersection's part held by a
  property, nor an entry property's: `validate()` reports it ("a reference object schema cannot be a property's
  type"). Reference objects are reached through relations only.
- **A value object** is held by a property whose schema is a value object schema, and belongs to that one owner, a
  reference object or another value object. Union and intersection values are value objects, and so are the objects they hold.
  `Visitable.owner()` gives a value object's owner, and None for a reference object.
- **A value object may have adjacencies**, and its entries link it like any object. The decision "a value object cannot
  have adjacencies" is dropped. A value object's schema follows from its owner's, so a value object schema needs no
  registration, and a link to a value object carries no `$schema`: `{"$ref": "s3"}`.
- **Ownership is exclusive and deep.** Editing a value object through its owner's builder keeps its identity. Setting
  it into another owner, or `clone()` of its owner, copies it with a new identity, with the entries among the copied
  objects (re-linked to the copies) and a copy of each entry that links them to objects outside. Clearing the property,
  or replacing its value, removes the value object and every entry linking it.
- **Entry properties may be value objects, never reference objects.** Such a value object is owned by the object that
  added its entry, is written nested in the entry, and keys and compares the entry by its properties. It cannot have
  adjacencies, since an entry is written under each object it links ("a value object held by an entry cannot have
  adjacencies").
- **Value objects are written nested**, inside their owner, with their adjacencies nested in them as a reference
  object's are. A value object that something links to carries its symbol, `"home": {"$id": "s3", "number": "1"}`,
  and is referred to by it, `{"$ref": "s3"}`; one that nothing links to has no `$id`. Symbols are
  assigned in first-reference order, value objects and reference objects alike. A reference object that only
  references to its value objects reach carries its own `$schema`.
- **Reachability goes through value objects**: their entries are followed as a reference object's are, and an object
  reached that is a value object brings in the reference object that owns it, which is where it is written.
- **Decoding** rebuilds a value object through its owner's builder, and finds it again to link it with
  `Store.member(instance, name)`, the value an instance holds in a property (a union's branch, an intersection's
  part); a `$ref` to an `$id` resolves to that value object.
- **Value objects compare deeply**: by their properties, recursively, and by their entries, whose links to reference
  objects compare by identity and to value objects deeply. Their identity does not take part. Reference objects
  compare by identity when linked. A link from one value object to another within the two compared objects compares
  by where the target is, the path from the object compared, so that a copy equals its original.
- **Proxies keep value objects read-only**, with adjacencies set through the owner's builder, e.g.
  `.home(lambda r: r.number("1").ports(lambda x: x.port(p)))`.

## Unions and intersections by name

These replace the earlier design, in which a union's branches were chosen by predicates and written as
`{"$branch": index, "$value": value}`, and an intersection's parts merged into one value.

- **Every union branch and every intersection part has a name.** Names are required, unique within their union or
  intersection, and are property names, named as properties are (see reserved names under Open questions).
- **Unpacked, a union is an object with exactly one of its variants present, and an intersection an object with all of
  its parts present.** This holds in proxies and over the wire (`Plain`, `JSON`, `YAML`): a union value is written
  `{"circle": {"radius": 2}}`, and an intersection value `{"Named": {"name": "a"}, "Dated": {"date": "..."}}`. A proxy
  reads a variant as a property (`shape.circle`) and a part the same way (`x.Named.name`). A proxy may later offer an
  intersection's properties flattened (`x.name`), for the names that one part declares or that every part declaring
  them declares with the same type; none does yet. The wire form is always per part.
- **A union value without a branch is no value.** Clearing a union's only branch clears the property, and a writer
  leaves out a union value written with no branch.
- **There are no predicates.** A branch's `when` is dropped: which variant a value holds is data, so decoding and
  validation need no evaluator. Constraints (planned) may still relate a value's properties.
- **Branches are identified by name, not position**, so reordering a union's branches leaves stored data valid.
- **Parts no longer merge.** A property that two parts declare appears under each part, so parts with conflicting
  declarations are no longer an error, and an intersection of unions is a value like any other.
- **Packed forms are the bindings'.** A generated binding may represent a union or intersection the way its language
  does (`std::variant` or RTTI in C++, a tagged union in SystemVerilog, a discriminated union in TypeScript); the
  unpacked form above is the neutral one.

## Lists

A list is a property's value, not a relation: an ordered sequence of items, each a value of the list's item schema.

- **`OfIndexed` holds one item schema**, of any kind: a native, a value object schema, a union, an intersection, or
  another `OfIndexed`. A reference object schema is never an item's schema, for the same reason it is never a
  property's type. The DSL is `t.as_indexed(lambda i: i.of(spec))`.
- **Items belong to the list's owner.** A value object in a list is a value object of the object that holds the list:
  it has an identity, may have adjacencies, is copied and removed with its owner, and is written nested in it. A list
  of value objects is how an object holds a variable number of parts that take part in relations.
- **Lists are ordered; relations are not.** Use a list where order is data (a union's branches, a relation's links,
  the properties of a schema) or where the owner holds values by key (see Keys and extents), and a relation to link
  objects that stand on their own, keyed by an entry property where needed. A positional list may hold equal items.
- **Proxies read a list as a read-only tuple** (a frozen array in TypeScript). A setter takes a list (or tuple) of
  items, each a value, a value object, or the Spec of an item, and replaces the list: `.tags(['a', 'b'])`,
  `.ports([lambda p: p.name('in'), lambda p: p.name('out')])`. Setting a value object into a list copies it, as
  setting it into a property does. A setter also takes a Spec that receives the list's builder, a `Visitors.OfIndexed`
  starting from the items set, to edit items in place, keeping their identities:
  `.ports(lambda l: l.item(0, lambda a: a.as_object(lambda p: p.name('in2'))))`.
- **`Visitors.OfIndexed`** has `items(callback)`, `item(index, callback)`, `append(callback)`, `remove(index)` and
  `clear()`; each callback receives a `Visitors.OfAny` for the item. An item written with no value (a union value with
  no branch) is left out of the list. `item` and `remove` raise `LookupError` for an index the list does not have.
  Removing a value object from a list removes it and every entry linking it.
- **Over the wire, a list is an array** of its items' plain forms, and an empty list is `[]`, distinct from an absent
  property. A value object in a list is written nested, with its `$id` when something links to it, and decoding finds
  it again by its position.
- **Validation** checks each item against the item schema, at the path `label.tags[1]`.
- **Comparison is item by item**: the first pair that is not equal decides, so lists of ordered natives order
  lexicographically, and a list that is a prefix of another is less. Items that are incomparable make the lists
  incomparable, so lists of booleans or of value objects are equal or incomparable.

### Keys and extents

A list may take a key schema, which makes it an associative array: a sparse tensor, a dictionary, a table keyed by a
value. One kind, `OfIndexed`, covers both: `t.as_indexed(lambda i: i.key(spec).of(spec))`.

- **Integer keys are positions.** A list whose key is absent or a native `int` is positional: its keys are
  `minimum`, `minimum + 1`, ... in order, with no holes. Any other key schema makes a *keyed list*: its keys are
  values of the key schema, unique under schema equality (EQUALITY.md), and its items stay in insertion order.
- **A key is a value.** Its schema is of any kind but a reference object schema, and a value object in a key has no
  adjacencies ("a value object in a key cannot have adjacencies"): keys compare by structure, never by identity.
- **An extent bounds a positional list**: `i.extent(minimum=1, maximum=9)` (in TypeScript `i.extent({ minimum: 1n,
  maximum: 9n })`). `minimum` defaults to 0, and `maximum` may be left out. Validation reports a list with more items
  than its extent allows. Only positional lists take an extent, and its `minimum` is at most its `maximum`.
- **The wire form follows the key.** A positional list is an array. A keyed list whose key's text can never start with
  `$` is a mapping from that text to the value: a `float` key as its canonical text (Python's `repr`, or `NaN`,
  `Infinity`, `-Infinity`), a `bool` as `true` or `false`, `bytes` as base64; decoding accepts only that text. Any
  other keyed list, a `str`-keyed one included, is an array of `{"key": key, "value": value}` mappings, since a `str`
  key could be `$ref`. A key that appears twice is a decoding error.
- **Proxies read a keyed list as a read-only mapping** in insertion order (`Proxies.OfIndexed.Map`): `m[key]`,
  `m.get(key)`, `key in m`, `len(m)`, and its keys, values and items. A key is given as a native, a tuple (or list) for
  a list, or a value object, which matches by structure. A setter takes a mapping or a sequence of `(key, value)`
  pairs, each a value, a value object or a Spec; a Spec receives the list's builder, as for any list.
- **`Visitors.OfIndexed` addresses items by key** as well as by position: `pairs(callback)` calls `callback` with a
  `Visitors.OfItem` per item, whose `key(callback)` and `value(callback)` pass a `Visitors.OfAny` (a key read there is
  read-only: `put` and `discard` change keys); `at(key, callback)` passes the value of the item whose key `key` writes;
  `put(key, value)` writes the value of that item, adding it if the list lacks the key; and `discard(key)` removes it.
  `at` and `discard` raise `LookupError` for a key the list does not have. In a positional list the keys are its
  positions, so `put` replaces an item or appends at the next key, and in a keyed list `append` raises `TypeError`.
- **Validation** labels a positional list's items by key (`label.row[1]`) and a keyed list's by position, the key at
  `label.attrs[2].key`. It checks each key against the key schema, reports a key that appears twice, and checks the
  extent.
- **Comparison**: keyed lists are equal when they hold the same keys with equal values, in any order, and
  incomparable otherwise. Positional lists compare as above.

## Native types

Native types and their widths are implemented, and written over the wire by their meta-schema (see Meta-schemas).

- **Native types are tokens, `{format, name}`** (`Schemas.OfNative.Token`). A format is a language or a neutral vocabulary; `basic` is the
  neutral one, with the names `bool`, `int`, `float`, `str` and `bytes` (the names of mbse-expressions' Basic
  dialect). `{format: 'python3', name: 'int'}` and `{format: 'typescript5', name: 'BigInt'}` are the host types of the
  two implementations, and other formats name other languages' types (`{format: 'ccpp', name: 'int32_t'}`). An
  implementation reads `basic` tokens and its own format's; a token in any other format fails to decode
  (`Errors.DecodeError`). Responsible code keeps Basic on one side or both: it holds `basic` tokens in memory, or
  writes them over the wire. Snapshots written that way are byte-identical across implementations, and the conformance
  corpora use only `basic`; a token in a language's format is a deliberate choice to be read by that language only.
- **`OfNative.Data` holds its token**, in memory as on the wire, so a schema can name a type that no implementation
  here has. A host type given to the builder (`as_native(int)` in Python, `as_native(BigInt)` in TypeScript) is
  shorthand for the `basic` token it corresponds to, `{format: 'basic', name: 'int'}`; a token in another format is
  given explicitly. Values are converted through the host type the token maps to, so a schema whose token this
  implementation cannot read describes values it cannot convert. `OfNative.Data.type` is that host type, or none,
  and `host()` raises `TypeError` for a token this implementation cannot read ("the ccpp type 'int32_t' has no type in
  this implementation"); converting a value raises the same, and validating one reports it. The token itself is
  valid: `validate()` reports only a token without a format or a name, or a `basic` name that Basic lacks.
- **A native may have a width**, in bits (`bits`) or in bytes (`bytes`), at most one of them, a positive int. The width
  is size only: how the bits are interpreted (signedness, encoding, float format, text encoding), and so whether a
  value fits, is not the schema's, and values are not checked against it. mbse-expressions' value domains interpret it.

## Meta-schemas

Schemas are data: each schema kind's data has a meta-schema, `Schemas.OfX.Schema`, a value object schema, so schemas
are written, read, validated and compared like any other objects.

- **A module holds named schemas.** `Schemas.Module.Schema` is a reference object schema, registered in every store of
  proxies as `Schemas.Module`, whose `schemas` property is a list of `Schemas.Module.Entry` value objects, each a `name` and a
  `schema`, a `Schemas.Module.Definition`: a union of the schema kinds, `native`, `object`, `union`, `intersection`,
  `indexed`, `apply` and `relation`. A snapshot of schemas is a snapshot of a module.
- **`Modules` translates.** `Modules.module(store, schemas)` returns a module holding named schemas, each under its
  name, built in the store, and `Modules.schemas(store, module)` the schemas a module holds, by name, each read back
  with its name. Both go through the module's plain form.
- **Within a module, schemas are value objects, nested inline**, and their members are lists of value objects, in
  declared order: an object schema's `properties` (`name`, `type`, `description`) and `adjacencies` (`name`,
  `relation`, `me`, `description`), with its `singleton` and `ref`; a union's `branches` and an intersection's `parts`
  (`name`, `type`, `description`); a relation's `links` (strings), `properties` and `uniques` (lists of strings, each
  sorted); a list's `item`, `key` and `extent` (`minimum`, `maximum`, and `terms` for a bound that is a term); and an
  application's `of` and `arguments` (`name`, and a native `value` or a `term`). A native is its token's `format` and
  `name`, its `bits` or `bytes`, and `terms` for a width that is a term. Every kind starts with its `parameters` (as
  properties are written) and ends with its `description`. What is absent, false or empty is left out.
- **A type is a schema of any kind, inline, or a name**: `Schemas.OfAny.Schema`, a union of the kinds and `named`, a
  value object `{"name": ...}` (union branches are of one kind, so a name is a value object too). A property's type is
  `{"native": {"format": "basic", "token": "str"}}` or `{"named": {"name": "Phone"}}`, and an adjacency's relation is
  `Schemas.OfRelation.Ref`, a relation inline or named the same way.
- **Names make schemas shared.** A schema refers by name to a schema in the module, or a registered one, and writes any
  other inline. Reading creates every named schema first, so names resolve to the same schema, recursive references
  included: a name resolves within the module, then in the store. A schema that refers to itself without a name is
  refused, and so are a name that resolves nowhere, a relation named as a type or something else named as a
  relation, and a name a module defines twice.
- **A named schema is written by its name, everywhere.** A schema refers to a named schema by name and writes an
  unnamed one inline, so writing schemas needs no store; reading resolves names, within a module and then in the store.
  A module entry is the one place a named schema is defined: its name, beside its definition, so the kinds'
  meta-schemas hold no name.
- **One type translates alone too.** `Modules.reference(schema)` gives a type's plain form, by name when it has one and
  inline otherwise, and `Modules.resolve(store, definition)` the type it describes, so that other data can refer to
  schemas as a module's members do (mbse-patterns' predicates name their symbols' schemas this way).
- **Meta-schemas are defined in code**, never read from data. Modules are built by the builders of any implementation,
  through `Plain.FromPlain`, and read through the protocols, so the DSL builders, whose methods (`properties(*specs)`)
  would clash with the visitor protocols (`properties(callback)`), are not involved.
- **A schema may hold itself**, as a node holds a list of nodes. Validating it reports each problem once.

## Reflection: schemas as objects

Codegen and other transforms (mbse-patterns) match schemas, not data: a predicate's symbol is declared with the schema
of what it binds, and the predicate itself says which objects match. To bind a schema, a symbol is declared with its
kind's meta-schema, the schema of the module form (`Schemas.OfObject.Schema`, named `Schemas.Object`, and the like for
`Schemas.Native`, `Schemas.Union`, `Schemas.Intersection`, `Schemas.Indexed`, `Schemas.Apply` and `Schemas.Relation`).

- **A schema is a reference object of its kind's meta-schema**: `identity()` (Python's `id`, TypeScript's
  `"schema N"`), `schema_name()` (the meta-schema's name), `owner()` (none) and `accept(visitor)`, which writes its
  module form with its name (a module gives its entry the name): its properties, branches, parts and parameters inline,
  a named schema it refers to by name. `Reflection` supplies `accept`, since this module cannot import `Modules`.
  Everything within a schema is a value, read with `get`, quantified over and compared deeply (mbse-expressions' Basic).
- **`Reflection.of(store)`** is a store whose objects are the schemas `store` registers and the named schemas they refer
  to, found by following the types and relations each refers to: it registers the meta-schemas, and each one's extent
  is the schemas of its kind, in name order (names that tie in the order reached), as the store registers them when
  the extent is asked for, so a schema registered later is among them. It reads no data, and leaves out the
  store's own meta-schemas (`Stores.META`). It builds nothing; schemas are built by their builders.
- **A native's token** is written `format` and `token` in a module (`{"native": {"format": "basic", "token": "str"}}`),
  so that `name` is a schema's name in every kind (0.8).

## Paths

`Paths.of(store)` names every object a store's roots reach, so that diffs, traces and logs name objects across runs
(mbse-patterns' transforms key their steps by paths).

- **Roots are named.** A schema of a store of schemas (`Reflection.of`) is named by its name, and a singleton by its
  global name; the schemas come first, in name order, then the singletons, in global-name order.
- **Other objects are named by route**, the first that reaches them, breadth first through each object's entries
  (adjacencies in their schema's order, entries in order). A step is `/adjacency[key]`: the entry's key is the property
  values that a unique constraint of its relation declares with the object's own link (`phones[label="home"]`), else
  its position (`items[0]`); an entry of a relation of more than two links names the link (`/enrolled[0].course`). A
  key writes a string as JSON does, an integer in decimal and a boolean as `true` or `false`; another type makes the
  key positional.
- **A path survives** a change that does not touch the route: a property set, an object added elsewhere, an entry
  added after a positional one. Renaming a root, or inserting an entry before a positional one, changes the paths
  under it. `paths.find(path)` gives the object at a path; both raise `LookupError` for what they do not hold.

## Expressions

Constraints are serializable expressions, kept beside the schemas in
[mbse-patterns](https://github.com/pitaman71/mbse-patterns), which also validates data against them and queries stores
by them. Expressions are a separate package, [mbse-expressions](https://github.com/pitaman71/mbse-expressions), which
depends on this one: its expressions are ordinary objects with registered meta-schemas, so this package serializes,
validates and compares them like any others. See its `docs/EXPRESSIONS.md` for the expression kinds, the core vocabulary
and evaluation.

Nothing in this package evaluates expressions: a union value names its branch, so neither decoding nor validation needs
an evaluator. Anything here that comes to evaluate constraints will take an evaluator from its caller rather than
import one, so the dependency keeps pointing one way.

## Parametrics

Status: declaring, applying and writing parameters is built (0.7), and so is evaluating them, through an evaluator
the caller gives (0.7.1). What is not built yet is listed below.

A parameter is a variable of a schema, or of anything else that declares it, that is determined where that element is
referred to, not by data. mbse-patterns' symbols are the other kind of variable: a predicate's symbol ranges over a
store's data, and its parameters are given where the predicate is applied. In the terms of
[MBSE.md](../MBSE.md#what-a-specification-is-made-of), an argument is a value constraint (`rows = 3`) and a parameter
without one is an unrestricted variable, so inferring a shape (a concatenation's extent, the sum of its parts') is
resolving constraints.

### Decided

- **No defaults.** A parameter given no argument stays unbound.
- **A parameter is a variable whose binder is a schema** (or, elsewhere, a predicate, a statement, a definition).
  Its `OfParameter` declares it; a reference to it is an ordinary variable, mbse-expressions' `OfVariable` (or a
  dialect's `identifier`), resolved by name to the innermost binder that declares it, as a `let` or an `import`
  resolves its names. A parameter shadows the same name declared further out. (This replaces an earlier decision, that
  a reference holds its parameter by link: within a binder the name resolves to exactly one declaration, which is the
  link, and a reference reads the same in a schema, in an expression and in a module.)
- **Parameters stay parameters in generated code.** Each target language expresses them as its own construct (a C++
  template parameter, a SystemVerilog `parameter`), not as values substituted before generating.
- **At a reference**, named and positional arguments, partial binding, arguments that depend on the referring
  element's own parameters, and equality after substitution, each to the extent possible.
- **Unknown is an outcome of validation.** Data checked against a schema whose unbound parameters it depends on is
  neither valid nor invalid there.
- **A term in a schema is written as a nested form**, `Schemas.Form`: mbse-expressions' `Terms.Form` is this class.

### Built

- **`Schemas.OfParameter` is an element**, like a property: a `name`, a `type` (a schema, or none for a parameter of
  any type) and a `description`. It is not a kind of schema, since no property's value is a parameter. A native's
  parameters are part of it, as its name is; a parameter compares by what it holds.
- **Every kind of schema binds parameters**: `.parameters(spec, ...)`, held in declared order as `parameters`, by name,
  as properties are. A parameter's scope is its binder, inline schemas nested in it included. `validate()` reports
  reserved names and bad types and descriptions; it cannot see which names a term refers to, so a variable no
  enclosing binder declares is for whoever understands the term's dialect to report (mbse-expressions).
- **A term stands where a literal does**: an extent's `minimum` and `maximum` and a native's `bits` and `bytes` each
  take an int or a term. A term is anything with `form()` and `dialect()`, as mbse-expressions' terms are, or a
  `Schemas.Form`: `Form(kind, attributes, arguments, dialect)`, native attributes by name and forms as arguments, the
  dialect given at the root. `Form.of(term)` gives a term's form. `validate()` checks a form's shape and leaves a
  dialect's term to its dialect; bounds compare only when both are ints, and a list's `capacity` needs int bounds.
- **`Schemas.OfApply` refers to a parametric schema with arguments**: a type, built by `.of(schema)` and
  `.argument(name, value)` or `.arguments(*values)` (in the applied schema's parameter order), or `t.as_apply(...)`.
  An argument is a native value or a term. Applying with some arguments leaves the others unbound (partial binding); an
  argument may be a term over a parameter of the application's own (`Square[n] = Matrix(rows=n, cols=n)`, dependent
  arguments). `validate()` reports unknown parameters, literal arguments of the wrong native type and arguments that
  are neither, an application of itself, and the applied schema's own problems. An application is equal to itself
  alone, as other schemas are. mbse-patterns' `OfApply` applies a predicate the same way, so the two share a name.
- **Data of an application is data of its applied schema.** `Schemas.structure(type)` follows applications to the
  schema that gives a type its structure; proxies, snapshots, validation, comparison and bound classes all read and
  write through it, wherever a type stands: a property, an item, a key, a branch, a part, an entry property.
- **Modules write all of it** (see Meta-schemas): a kind's `parameters` first, a width's or bound's term in the
  holder's `terms` (`{"minimum": 1, "terms": {"maximum": {...}}}`), and an application as `{"apply": {"of": ...,
  "arguments": [{"name": "rows", "value": {"int": 3}}, {"name": "cols", "term": {...}}]}}`. A form is
  `{"dialect", "kind", "attributes": [{"name", "value"}], "arguments"}`, each attribute's and argument's native value
  by its basic type (`{"float": "NaN"}`, `{"bytes": "AA=="}`). Reading gives forms back, or what the caller's `make`
  makes of each (`Modules.schemas(store, module, make)`), e.g. a dialect's terms.

- **A term's value comes from an evaluator the caller gives** (`Schemas.Evaluate`, see Expressions):
  `evaluate(term, scope)`, the scope the values of the parameters in scope by name, gives the term's value, or none
  where it is unknown. This package evaluates nothing itself.
- **Scopes are lexical.** Within a schema, its parameters are in scope, and so, for an unnamed schema, are those of the
  schema it stands in; a named schema is a scope of its own. Its own parameters shadow those further out. An
  application's arguments are evaluated in the scope the application stands in and become the values of the applied
  schema's parameters; one with no value leaves its parameter unbound.
- **Checking reports what it cannot decide.** `Validators.Check(store, evaluate)(schema, value)` gives an `Outcome` of
  `problems` and `unknowns`, which `holds` true, false or unknown (None). A positional list's extent is evaluated where
  the list stands: its minimum labels the items, and its bounds decide whether the items fit; where a bound has no value
  (no evaluator, or `evaluate` gives none) whether they fit is unknown ("whether 3 items fit the extent is unknown: its
  maximum has no value"), and a bound that is not an int is a problem. `Validators.Validate(store, evaluate)` gives the
  problems alone: what is unknown is not a problem.
- **Equality after substitution**: `Schemas.equivalent(a, b, evaluate)` follows applications to the schema they apply
  and the values they give its parameters, each application's arguments evaluated with the values given its own
  parameters, so `Square(4)` and `Matrix(4, 4)` are equivalent where `Square[n]` applies `Matrix(n, n)`. Two types are
  equivalent when they apply the same schema (natives by value) with the same parameters bound to the same values; the
  answer is None where it depends on a value that is unknown.

### Not yet built

- **Substitution as an operation**: applying literal arguments to give the schema they determine, for code that
  needs a concrete schema. Nothing needs it yet: validation evaluates in scope, and equivalence compares values.
  Generated code keeps the parameters.
- **Proxies with parametric extents**: a proxy addresses a positional list's items from its extent's minimum, or from
  0 where the minimum is a term (see Open questions).
- **Symbolic equality**: two applications whose arguments are the same unevaluated terms (`Matrix(n, n)` within two
  schemas) are not known to be equivalent.

### Later, elsewhere

- mbse-expressions: schemas as binders, so that `free` and validation's "bound" see their parameters; the free names of
  the terms a schema holds; an evaluator for those terms; a `make` for modules.
- mbse-patterns: a predicate's parameters become `OfParameter`s, and applying one binds its symbols and its parameters
  apart (today both are one positional list). Both are variables the predicate binds; they differ in what
  determines them, data or the application.
- mbse-programs: statements and definitions bind and refer to parameters.
- mbse-codegen-*: a parametric schema as each language's own construct. Where a language has no value parameters
  (Python, TypeScript), how to express one is a parameter of the generating step.

## Language bindings

Two implementations exist: `python3/` and `typescript5/`. Their APIs use the same names (snake_case included), the
same error classes and messages, and produce byte-identical JSON; a shared conformance corpus (`conformance/`) checks
that each reads the other's JSON and YAML back to the same graphs. Generated bindings (typed code per schema) will
live in separate repositories, one per target language (e.g. mbse-cpp, mbse-python, mbse-typescript,
mbse-systemverilog), each depending on this one as mbse-expressions does. Where a language forces a difference,
it is fixed here:

| Concept | Python | TypeScript |
|---|---|---|
| Importing the framework | `from mbse.Schemas.Framework import ...` (the `mbse` namespace package) | `import ... from "@mbse/schemas/Framework"` (the `@mbse` scope) |
| Native host types (for `basic` tokens) | `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` |
| Own token format | `python3` | `typescript5` |
| Native widths | `int` | `bigint` |
| Native values | `int`, `float`, `str`, `bool`, `bytes` | `bigint`, `number`, `string`, `boolean`, `Uint8Array` |
| Plain mappings | `dict` | `Map<string, PlainData>` (order-preserving for every key) |
| Lists in proxies | `tuple` | frozen array |
| Keyed lists in proxies | `Mapping` (`m[key]`, iterates keys) | `Map`-shaped (`m.get(key)`, iterates entries) |
| Schema data equality | `==` | `.equals()` |
| Errors | built-in `TypeError`, `ValueError`, `AttributeError`, `KeyError`, `LookupError`, `NotImplementedError`; `Errors.DecodeError` | built-in `TypeError`; the others and `DecodeError` exported from `Errors`, with the same names |
| Callable entry points | `Plain.ToPlain(store)(...)`, `Plain.FromPlain(store)(...)` (objects with `__call__`) | functions with the per-kind forms attached |
| Keyword arguments | `ToJSON(..., indent=2)` | options objects: `ToJSON(..., { indent: 2 })` |
| Dynamic proxies | `__getattr__` | `Proxy`; JavaScript protocol probes (`then`, `toJSON`, symbols) are not schema lookups |
| Object identity | `id(self)` | a counter, never reused |
| Incomparable (`Comparison`) | `None` | `null` |
| JSON | `json` with strict options | own reader and writer reproducing Python's output; ints and floats kept distinct |
| YAML | PyYAML (optional extra), YAML 1.2 core loader | `yaml` package loader, own block emitter; the same quoting |

## Open questions

- **Where constraints attach.** A specification is constraints attached to the parts of a system they constrain, each
  held by a property named `requires` ([MBSE.md](../MBSE.md#what-a-specification-is-made-of)); mbse-patterns'
  predicates already hold theirs so. Which scopes a constraint attaches to (a schema, a property, a relation, an
  interface, a whole specification), and how attached constraints combine into one conjunction, is not decided.
  The elements that bind parameters (see Parametrics) are likely the same scopes.
- **Parametrics**, beyond the proposal (see Parametrics): type parameters now or later; equality of differently
  written applications that substitute alike (`Matrix(n, n)` and `Square(n)`); and what proxies accept for data
  whose shape depends on an unbound parameter.
- Sparse lists keyed by integers: an `int` key makes a list positional and dense. A sparse integer map needs a key of
  another schema (e.g. a value object holding the index), or a way to mark an `int` key as sparse.

Findings from the test plans (`python3/tests/TestPlan.md`, `typescript5/tests/TestPlan.md`) that need a design decision:

- Reserved names (F2): names starting with `$` are reserved for the wire format (see Resolved). Other property and
  adjacency names that collide with binding members (e.g. `create`, `accept`, or
  names starting with `_` in Python; `constructor`, `toString`, `then` in JavaScript) cannot be set through the DSL or
  read as attributes in some bindings, and `validate()` accepts them. Should schemas reject names that any target language reserves, or should bindings rename them?
- Concurrent builders (F4): two builders over the same object each hold a copy; the last `update()` wins and drops
  entries the other added. Is that the intended semantics of `update()`?
- Cloning self-loops (F5): `clone()` copies entries with the clone in place of the source, so a self-loop's clone
  links back to the original rather than to itself. Intended?
- Snapshots whose two ends disagree (F13) are accepted and restore the union of both ends' entries. Should
  deserialization reject them instead of leaving it to validation?

- Versioning schema names: whether a version is part of a name (`crm.Contact.v2`) or beside it.
- Equality edge cases listed in `EQUALITY.md` are proposals; confirm them.
- Multi-object snapshot naming: confirm `Plain.ToPlain(store).Reachable(schema, value)` /
  `Plain.FromPlain(store).Reachable(schema, plain)` (still marked PROPOSED in the example).
- Snapshot determinism: must two serializations of the same state produce identical output? Entries are now written
  with links and properties in the relation's declared order, but symbols are numbered in first-reference order, and
  entry order within an adjacency depends on history, so a round trip can renumber symbols (see the `FamilyTree` and
  `University` examples, which compare snapshots up to renumbering). Full determinism would need a canonical entry
  order.
- Uniqueness is global to a relation, but `Validators.Validate(...).Reachable` checks it only over the entries
  reachable from what was validated. Entries in another component that share only property values can go unchecked.
  Is a relation-wide check needed?
- Builder syntax proposed by the draft `Schemas.py`, to confirm:
  - `unique` clauses: `.unique('parent', 'key')`, one call per clause.
  - Singletons: `Schemas.OfObject.Builder().singleton('GlobalName')`.
  - Unions: `.branches(lambda b: b.name('phone').of(spec), ...)`, in declaration order.
  - Intersections: `.parts(lambda p: p.name('stamp').of(spec), ...)`.
  - `validate()` on each `Schemas.OfX.Data` returns a list of problems (empty when valid).
- `Schemas.OfAny.Data` is currently the union of the schema kinds' data (`OfNative`, `OfObject`, `OfUnion`,
  `OfIntersection`). There is no separate "any value" kind yet.
- Reading an object's entries back (e.g. a contact's phones), and removing an entry through a builder.
- Is "an owned child must be part of an ownership chain rooted in an object with a directory entry" still a
  well-formedness constraint under symbol-based serialization?

### Resolved

- Objects outside snapshots are named by paths (0.8.2): `Paths.of(store)`, from the store's named roots by route,
  keyed by unique properties where a relation declares them. Snapshots keep their symbols.
- Nothing is mandatory except as specified by a constraint: properties are optional by default, and mandatory
  participation in a relation is expressed as a constraint (directory membership is required by well-formedness).
- `OfValue` is not a base class; renamed `OfAny`.
- Parameters (0.7): every kind of schema declares `OfParameter`s, `OfApply` applies a parametric schema to arguments,
  and a term (a `Schemas.Form`, or a dialect's term) may stand where a width or an extent's bound does. A parameter is a
  variable whose binder is the schema; data of an application is data of its applied schema (`Schemas.structure`). See
  Parametrics, which also lists what is not built yet.
- Stores of different implementations combine, by name (0.7.3): `Stores.Combined(*stores)`, each name its one store's,
  the singletons all of theirs and the extents what they all reach. A store itself still has one implementation.
- Reflection (0.8): a schema is a reference object of its kind's meta-schema, the module form's, and writes its module
  form with its name; `Reflection.of(store)` holds the schemas a store registers and those they refer to. It replaces
  0.7.2's catalog and the elements bound as objects of their own, linked by relations: a predicate selects schemas
  itself, reading and comparing what is within them as values, and a store's named schemas are its roots, so nothing
  lists them again. A native's token is written `token`, so that `name` is a schema's name in every kind (see
  Reflection: schemas as objects).
- Evaluation (0.7.1): terms are evaluated by an evaluator the caller gives, in lexical scopes; `Validators.Check` gives
  problems and unknowns, three-valued; `Schemas.equivalent` is equality after substitution.
- Every element may be described (0.6): schemas, properties, adjacencies, branches and parts hold an optional
  `description`, written in modules and read back. So that a property can hold one, a property is an element,
  `OfProperty.Data`, and `properties` maps a name to it rather than to its type, as a union's or intersection's
  `properties` maps a name to its branch or part.
- Names starting with `$` are reserved for the wire format's markers (`$ref`, `$schema`, `$id`): `validate()` reports
  a property, adjacency, link, branch or part name that starts with `$` ("name '$ref' is reserved: names starting with
  '$' belong to the wire format"), and a keyed list is written as a mapping only when its key's text can never start
  with `$` (float, bool and bytes keys). Both depend on the schema alone, so no data can collide with a marker.
- Object-valued properties hold value objects: read-only values owned by their owner, written
  nested; they have identities and may have adjacencies. Reference objects are reached through relations.
- Union branches and intersection parts are named, and their values are records keyed by those names, in proxies and
  over the wire; there are no branch predicates (see Unions and intersections by name). Intersections as registered
  object schemas (objects with identity composed from aspects) are a later step.
- `OfNative` wire conversion (including for literals in expressions) belongs to `Schemas.OfNative`.
- Builder finalization is `create()` / `clone()` / `update()`; none validate.
- A program's own classes take part through `Bindings`: a binding pairs a reference object schema with `read`, `make`
  and `assign`, and the framework gives the rest (`accept`, builders, a store), so classes and proxies are
  interchangeable wherever a `Visitable` and its builders are expected (see Typed bindings).
- Validation, including well-formedness, runs only when the caller invokes it.
- `Schemas.OfX.Schema` is the meta-schema for `Schemas.OfX.Data`; a module of schemas is an object of
  `Schemas.Module.Schema`, translated by `Modules` (see Meta-schemas).
- Mutations apply to anything with a schema; one vocabulary per schema kind.
- A map `a -> [key] -> b` is a relation with links `a`, `b` and property `key`; named references work the same way.
- A relation must not merge a relation and an object: one-link relations whose entries carry data are not legal.
- No relation builder is exposed to the caller; entries are added through adjacency accessors on the object builder,
  which take an entry `Spec`, e.g. `.addresses(lambda x: x.address(addr1).label('work'))`. A link takes an existing
  object or a `Spec` that builds a new one.
- An object's serialized form includes its adjacencies; linked objects appear as symbol references, not nested content.
- Deserializing a snapshot that references an object it does not contain is an error.
- Relation links are untyped names (`.links('contact', 'address')`); objects declare adjacencies with
  `.relations(lambda adj: adj.name(...).of(Relation).me(link))`.
- Lists are `OfIndexed`, a property's value: ordered items of one item schema, which belong to the list's owner (see
  Lists). Collections of linked objects, maps and keyed lookups are relations.
- Cardinality is declared with `unique(S)` clauses; ownership is `unique(parent)`; relation entries form a set and
  duplicates are elided.
- An object may have more than one owner.
- Entries linking a deleted object vanish with it.
- Singletons declare a global name in their `OfObject` schema, exist implicitly (a store makes the one instance when the
  schema is registered: `store.singleton(name)`), and are referenced by that name. They are a store's roots.
- Object identity on the wire uses transaction-local string symbols with a checkable 1:1 mapping; only `create` creates
  objects.
- Transactions are flat; mutations may be nested.
- A random source is given to what draws from it, not held by a store: a store is data access alone, and a caller
  chooses a seed per draw (0.5; in 0.4, a store was equipped with one when made). PCG32 is the reference source, and
  split streams depend on the seed and key, not on what was drawn.
- A schema's name is its own, set by its builder (`.name('crm.Contact')`), on any kind of schema: identifiers separated
  by dots, the part before the last dot its namespace. A store registers a schema under its name (`register(schema)`),
  so a schema has one name in every store, and a reference to a named schema is written by that name with no store.
- Stores replace the `Factories` design and every registry: a store (`Stores.Store`) locates schemas, builders,
  members, singletons and extents; its data is what its singletons reach, and everything else is transient; it is
  isolated from other stores (see Stores). There is no global registry.
  Queries are mbse-patterns' (`Queries.QueryableStore`, and `Queries.Scan` over any store).
- Constraints are kept beside the schemas, in mbse-patterns (named predicates about a schema, by its registered
  name), not in them: this package does not depend on mbse-expressions, and several sets may apply to one schema.
- `clone()` copies the source's adjacency entries to the clone.
- Building a new object inline through a link (`x.phone(lambda y: ...)`) requires an unambiguous inference of its
  schema: exactly one registered object schema may declare an adjacency to that relation via that link; otherwise it
  is an error. Pass an existing object instead when inference is ambiguous.
- Builders and serializers implement `Visitors`; proxies do not. Proxies implement `Visitors.Visitable`: `identity()`,
  `schema_name()`, `owner()`, and `accept(visitor)`, which writes the object's properties and adjacency entries into
  the visitor; a value object first calls the visitor's `identify(value)` with itself.
- Schemas may be named or inline; inline (anonymous) sub-schemas are created with the lambda-builder notation.
- `Schemas.OfAny.Builder` selects a kind via `as_<kind>` methods (e.g. `as_native`).
- `Visitors.OfAny.as_<kind>` takes a callback that receives the kind's visitor and returns `self`; chained calls dispatch on
  the value's actual kind.
- Visitors never return child visitors; they pass them to callbacks. Non-query visitor methods return `self`.
- A `Schemas.OfAny.Builder` configured with `as_<kind>` finalizes to that kind's data (e.g. `Schemas.OfNative.Data`).
- Builder methods are fluent and return `self`.
- Instances of a registered schema are built through `store.Name(optional instance)` (the dynamic implementation,
  `Proxies.OfStore`), which has one fluent setter per property.
- Instance properties are read as ordinary attributes (e.g. `addr1.street1`), read-only; changes go through a builder.
  Reading a property that is not set raises an error.
- Instance setters take a `Spec`: `.street1('foo')` is equivalent to `.street1(lambda v: v.set('foo'))`.
- A property is cleared with `.street2(lambda v: v.clear())`.
- JSON and YAML are implemented as `JSON.ToJSON(store)` / `JSON.FromJSON(store)` and `YAML.ToYAML(store)` /
  `YAML.FromYAML(store)`; YAML loads with the YAML 1.2 core schema.
- Non-finite floats are plain strings `NaN`, `Infinity`, `-Infinity`, so JSON output stays strict.
- Serialization goes through one plain-data form, `Plain.ToPlain(store)(schema, value)` / `Plain.FromPlain(store)(schema, plain)`;
  JSON and YAML are thin text encodings of it.
- `JSON.ToJSON(store)(schema, value)` / `JSON.FromJSON(store)(schema, text)` take the schema explicitly, dispatch on its
  kind (equivalent to `JSON.ToJSON(store).OfX(...)`), and produce/consume a snapshot.
- Sub-structure arguments throughout the builder pattern are `Spec`s: a direct value, or a callable that takes and returns
  the corresponding builder (e.g. `of(...)` takes `Schemas.OfAny.Spec`; `as_native` takes `Schemas.OfNative.Spec`).
- Both in-memory objects and mutations are serializable, so JSON/YAML cover both.
- Implementations are equivalent: same API names and messages, byte-identical JSON, and a shared conformance corpus
  checked by each implementation's CONF suite (see Language bindings).
- Data is validated by `Validators.Validate(store)`, only when the caller asks; builders do not validate.
- Values are compared by `Comparison.OfX` visitors, one per `Visitors.OfX`: `a.compare(b)` is -1, 0, 1, or `None`
  when incomparable. Only `int`, `float`, `str` and `bytes` are ordered.
- Decoding errors are normalized: every problem in decoded data raises `Errors.DecodeError` (a `ValueError`) with a
  one-line reason and a text or path location, identical across bindings except YAML syntax errors (see Decoding
  errors).
- `Plain.ToPlain` and `Plain.FromPlain` are constructed with a store, which names the schemas written and builds the
  objects read: `Plain.FromPlain(store)(schema, plain)`.
- Reachability is its own visitor, `Reachable.of(root)`, which returns the root and every reference object reachable
  through adjacencies, value objects' included, in first-reference order. `Plain.ToPlain(store).Reachable` uses it.
- Over the wire, object content carries no schema. Association with a schema is dynamic, starting from the expected
  root schema (hence `FromPlain(store)(schema, ...)` takes it) and continuing through property types and the
  branch written with each union value. Serialized references to linked reference objects carry the object's schema
  name; an object carries its own schema when nothing else gives it.

---

<!-- nav -->
[← 9 · When requirements change: evolving schemas (TypeScript)](../typescript5/tutorials/09_When_Requirements_Change.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)
