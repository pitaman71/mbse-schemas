<!-- nav -->
[← 10 · Asking the store: mutations as queries (TypeScript)](../typescript5/tutorials/10_Asking_The_Store.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)

# Schemas Framework

A framework that allows programmers to encode data structure schema
with a robust language-independent schema algebra using an in-language DSL.

Given a schema, bindings for a wide variety of
programming languages such as Python, Typescript, C++, SystemVerilog, etc.
can be automatically and deterministically generated.

All bindings also support "dynamic" implementations which allow programs to
be written that forego the code-generation step entirely, using lazily typed
proxies as the in-memory representation.

## Elements

The schema elements include:

- `OfAny` : where a schema of any kind is expected; `Schemas.OfAny.Value`, the kind of a value of any schema, unrestricted
            or restricted to the schemas an `OfAny.Builder` selects (Resolved, "`OfAny` returns"), its value wrapped on
            the wire by its kind and schema where a bare one would be ambiguous (Resolved, "A restricted `OfAny` never
            guesses its schema")
- `OfScalar` : a scalar value, of one of the five basic scalars a store holds, `Schemas.OfBool`, `Schemas.OfInt`,
               `Schemas.OfFloat`, `Schemas.OfStr` and `Schemas.OfBytes` (see Scalars below). In Python their
               host types are `bool`, `int`, `float`, `str` and `bytes`.
               Conversion between the scalar format and the over-the-wire format is the responsibility of `Schemas.OfScalar`.
- `OfObject` : named properties list where each property's schema is described by `OfAny`. An `OfObject` schema describes
               reference objects when marked `.ref()`, and otherwise value objects; see Value objects and
               reference objects. An `OfObject` schema may declare
               a singleton global name; that single instance is created implicitly, must always exist, and is referenced
               by its global name. Properties are optional: nothing is mandatory except as specified by a constraint.
- `OfRelation` : describes a relationship between objects (must be objects not values)
                 with a named link for each linked object. No particular cardinality
                 is assumed unless declared by `unique` clauses (see Cardinality below). Relations completely subsume maps/dictionaries and pointers: since entries
                 carry properties, a map `a -> [key] -> b` is represented as a relation with
                 links `a` and `b` and property `key`.
                 A relation has two links or more: values that belong to one owner, a contact's own phone
                 numbers, are a container (`OfContainer`), held by a property. Data that several objects share
                 is an `OfObject`, linked to each.
- `OfProperty` : a property of an object or a relation's entries: its `name` and `schema`, an `OfAny`. An object's or
                 relation's `properties` map each name to its `OfProperty`, in declared order, so a property's schema is
                 `schema.properties['home'].schema`.
- `OfParameter` : a parameter a schema of any kind declares: its `name` and `description`, a symbol standing for what
                  is bound where the schema is referred to (see Parametrics).
- `OfAdjacency` : declares that a particular `OfObject` is adjacent to an `OfRelation` via
                  a particular link name. Relations name their links without schemas
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
                     declare the same property, even with different schemas.
- `OfContainer` : elements of an element schema, each at an index of an index schema, both `OfAny`: dense by position for
                  an integer-like index, a dict for any other hashable one, or entry-like elements; `.dense()` or
                  `.sparse()` set its layout (see Lists, and Resolved, Containers).

A list, a dict, a map or a tensor of values is a container, held by a property (see Lists).

*Replaced:* the builder clauses above (`.links('contact', 'address')`, `.relations(...)`) were the old builders',
removed in phase 3 of the meta-schemas overhaul; the schema builders build every schema in a store (Resolved, "Schema
builders align with their meta-schemas"; [Meta-schemas overhaul, The meta-schemas and their builders, as
built](META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built)).

Every element may be described: each kind of schema, each property, adjacency, union branch and intersection
part takes `.description(text)` on its builder, and its data holds `description`, text or none. A description is
documentation, for people and for generated code; validation reports one that is not text, and no validation,
conversion or comparison of data reads it. A scalar's description is part of the scalar, as its name is.

A property whose schema is an `OfObject` holds a *value object*: a read-only record of that
schema's properties that belongs to its owner, copied with it and written nested in its owner's snapshot. It has no
identity, and its schema declares no adjacencies, however it is held (directly, through a union branch, an
intersection part, a container or an entry); see Value objects and reference objects.
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

Whether a relation's entries form a set or a list depends on `unique`. A relation with a `unique` clause holds a set:
adding an entry equal to an existing one (see `EQUALITY.md`) is silently elided. One without is *open*: from each
end its entries are a list, in the order added, equal entries kept, their index their position. `.unique()`, a
clause naming nothing, constrains nothing else and makes a relation a set.

No cardinality is assumed by default. A relation declares cardinality with zero or more `unique(S)` clauses, where `S`
is a set of its links and properties. `unique(S)` means that the links and properties not in `S`, taken together,
determine the values of `S`: any two entries that agree on everything outside `S` must also agree on `S`.
Equivalently, the links and properties outside `S` form a key. Each clause is a separate constraint, so any combination of keys can be expressed.
Seen from one link, `me`, a clause whose complement holds `me` keys the entries by the rest of that complement:
`Schemas.OfRelation.Data.keys(me)` lists those keys in declaration order, and `key(me)` is the first, which an
adjacency is indexed by (`at`) and its entries sorted by on the wire.

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

Equality is defined by the schema, never by host-language `==`, and ordering only for ordered scalars. See
[Equality](EQUALITY.md) for its definition, hashing, ordering, the `Comparison` module, and the edge cases still to
confirm.

## Builder pattern

*Replaced:* this section, and the builder clauses quoted in older parts of this document (`.of(...)`,
`.relations(...)`, `.links(...)`, `.unique(...)`, `.ref()`, `.flat()`, `.dense()`, `.parameters(spec, ...)`,
`.bits(32)`), describe the old schema builders, removed in phase 3 of the meta-schemas overhaul. Schema builders that
are visitors of their meta-schemas, built in a store, replaced them (Resolved, "Schema builders align with their
meta-schemas"; [Meta-schemas overhaul, The meta-schemas and their builders, as
built](META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built)). Finalizing by `create()`, `clone()` and
`update()`, and that none of these validate, still hold.

The schema must itself be serializable. For that reason, a model implemented as `Schemas.OfX.Data` will have two additional classes:
`Schemas.OfX.Builder` and `Schemas.OfX.Schema`. `Schemas.OfX.Schema` is the meta-schema that defines `Schemas.OfX.Data`.

`Schemas.OfX.Builder` - takes an optional instance of `Schemas.OfX.Data` as the sole argument, stores the data as mutable shallow copies
separate from the optional instance, and exposes accessor methods that the caller can use to modify the schema. The builder is finalized by one of:

- `create()` : returns a new `Schemas.OfX.Data` built from the builder state. Only valid when no source instance was given.
- `clone()` : returns a new `Schemas.OfX.Data` built from the builder state, leaving the source instance untouched. Only valid when a source instance was given.
- `update()` : writes the builder state back into the source instance and returns it. Only valid when a source instance was given.

None of these validate; validation happens only when the caller asks for it.

`Schemas.OfAny.Builder` is the builder used wherever a schema of any kind is expected (e.g. a property's schema). It
selects the kind through `as_<kind>` methods, e.g. `as_scalar(str)` for `OfScalar`.

Finalizing a `Schemas.OfAny.Builder` after an `as_<kind>` call yields that kind's data, e.g. `Schemas.OfScalar.Data`
after `as_scalar(str)`, not a `Schemas.OfAny.Data` wrapping it.

Builder methods are fluent: they return the builder itself (`self`).

Throughout the builder pattern, an argument that describes a sub-structure is a `Spec`: an auxiliary type that is either
a direct value or a callable that takes and returns the corresponding builder. For example:

- A property's `of(...)` takes a `Schemas.OfAny.Spec`: either a `Schemas.OfAny.Data` or a
  `Callable[[Schemas.OfAny.Builder], Schemas.OfAny.Builder]`.
- A scalar is one of the store's basic scalars, linked by its path (`.schema([store.Schemas.OfStr])`): a store
  builds no other scalar schema (Scalars).

Anonymous sub-schemas are created inline by passing a lambda that receives a builder, e.g.
`prop.name('street1').of(lambda t: t.as_scalar(str))`, where `t` is a `Schemas.OfAny.Builder`. The lambda only
configures the builder; it is not part of the resulting schema, which stays serializable.

Instances of a user schema follow the same pattern. With the dynamic (proxy) implementation (see `python3/mbse/Schemas/Examples/AddressBook.py` and `typescript5/src/Examples/AddressBook.ts`):

- A schema is named by its builder: `store.Schemas.OfObject(lambda o: o.name('crm.Contact'))`, on any kind of schema.
  A name is identifiers separated by dots, the part before the last dot its namespace; `validate()` reports any other.
- `store = Builders.Store()` makes a store (see Stores), the one kind there is, and a named schema built in it is
  registered under its name as it is built; nothing else registers a schema ([Store overhaul, Decided,
  17](proposals/store-overhaul/README.md#decided-here)).
- `store.Name(optional instance)` returns a builder for that schema with one member per property (e.g.
  `.street1('foo')`), finalized by `create()` / `clone()` / `update()` as above.
- Relation entries are inserted through the object builder's adjacencies, never through a relation builder (none is
  exposed to the caller). An adjacency is a member, called with a `Spec` given the adjacency's visitor, whose
  `insert` takes a `Spec` for the entry. The object fills its own link (`me`); the entry builder sets the other links
  and the entry properties. A link takes an existing object or a `Spec` that builds a new one; the lambda form requires
  the new object's schema to be inferred unambiguously from the relation and link:

  ```python
  .addresses(lambda a: a.insert(lambda x: x.address(addr1).label('work')))
  .phones(lambda a: a.insert(lambda x: x.phone(lambda y: y.number('+447700900123')).label('mobile')))
  ```
- Each member takes a `Specs.Callback` like any other builder argument: a value, or a callable that takes the
  property's visitor:

  ```python
  .street1('foo')
  # equivalent to
  .street1(lambda p: p.as_scalar(lambda v: v.set('foo')))
  ```

- A property is cleared (made absent) through its value's visitor: `.street2(lambda p: p.as_value(lambda v: v.clear()))`.
- Data instances are visitors too, read-only: a property is a member, its visitor (`addr1.street1`), read compactly
  through the scalar dunders (`str(addr1.street1)`) or `get()`. Changes go through a builder. A property that is not
  set has a `get()` of `None` (`null` in TypeScript): no property holds `None` as a value, so it means absent.

To make schemas fully serializable, `Schemas.OfX.Builder` must implement `Visitors.OfX`.

This is known as the "builder pattern" and must be followed by proxies, generated code, expression models, etc.

## Implementation

Implementation is strictly typed in all languages - parameters, returns, etc.

- `Visitors` : for each schema element `OfX`, `Visitors.OfX` is the one protocol through which code reads and writes a
  value of kind X, knowing its schema or not ([The visitor pattern](VISITOR_PATTERN.md); Resolved, The visitor
  pattern). Data instances (`Proxies.OfX.Data`) implement it read-only, builders writable. An object's properties and
  adjacencies, an entry's links and properties, a union's branches and an intersection's parts are members named after
  them: read, a member is the child visitor; called with a `Specs.Callback` (a value, or a callable taking the
  visitor), it writes or visits through it and returns the visitor it is a member of. Methods are named `as_*`, each
  returning the visitor it was called on, and every protocol has `as_schema()`. Reads never raise and every callback is
  called, a visitor of an absent value or of another kind reading as empty; the one raise is a write the visitor's mode
  or the value forbids (`Errors.ReadOnlyError`). `Readers.OfX` is the read-only view, a type for code that must not
  write; `Specs.Callback` is what members and `as_*` methods take.
- `Schemas` : for each schema element `OfX`, `Schemas.OfX.Data` is used to capture a schema. Schemas may be named (registered by a name in a store) or appear inline without a name.
- `Stores` : the catalog every store has, and stores combined; `Visitors.OfStore` is the protocol of a store, the root
  object through which schemas, builders and objects are located (see Stores). Everything that looks a schema up by name takes a store.

- `Mutations` : for each schema element `OfX`, `Mutations.OfX` is used to represent incremental changes to anything that has a schema,
  including schemas themselves (via their meta-schemas). Mutation schemas scale with the number of schema elements, not with the number of user schemas.
  The vocabulary for each kind is the obvious set for that kind (e.g. creating and deleting an `OfObject`, setting its
  properties, adding and removing `OfRelation` entries).

- `Validators` : `Validators.Validate(store)(schema, value)` checks data against its schema and returns a list of
  problems, each with a path (e.g. `Student#0.enrollments[1].credits: expected int, got bool`). `.Reachable(schema, root)`
  checks everything reachable from the root. It is constructed with the store that looks schemas up by name, and runs
  only when the caller asks. It checks the schemas' own `validate()`, exact scalars
  of properties and entry properties, that every linked object's schema declares an adjacency via its link,
  `unique(...)` clauses over the entries seen, value objects' properties and entries recursively, and that an
  intersection value holds every one of its parts, each with a value of its schema. It reads the value through the
  visitor protocol (`Readers.OfObject`), through its schema, as other modules and packages that read objects do (e.g.
  mbse-expressions' evaluators). `Validators.Check(store)` checks the same and also reports what it cannot decide.

- `Comparison` : for each schema element `OfX`, `Comparison.OfX(schema, value)` holds a value read through the visitor
  protocol (`Readers.OfX`), or a scalar, and compares it with another: `a.compare(b)` returns -1, 0, 1, or `None` when
  incomparable. See `EQUALITY.md`.

- `Builders` : schemas as data. Each kind's builder (`Schemas.OfX.Builder`, a `Visitors.OfObject` over its plain schema,
  its store's `Schemas.OfX`) and the store, `Builders.Store`, in which schemas and data are built, and which is made
  holding its own plain schemas of schemas and basic scalars ([Store overhaul,
  Levels](proposals/store-overhaul/README.md#levels)). See Meta-schemas.

- `Mutations` : the schemas of the mutations a transaction applies, and of transactions themselves
  ([SERIALIZATION.md](SERIALIZATION.md), Transactions on the wire): `Plain.ToPlain(store).Snapshot()` writes a store as
  two transactions, and `Plain.FromPlain(store).Snapshot(snapshot)` reads one.

- `Adapters` : translate between a language's own type declarations and schemas, so they are specific to each
  language. Python has `Adapters.Dataclasses`: `FromDataclass.install(txn, module, *classes)` writes the schemas
  dataclasses describe into the transaction a module-scope `install(txn)` is given, and returns `txn.mutations([...])`
  as a written install does ([Store overhaul, Decided, 31](proposals/store-overhaul/README.md#decided-here)): `module`,
  a callback writing a `Schemas.OfModule` (`lambda m: m.name("models")`), is found by its name or made, and each class
  and each relation the adapter infers is a symbol of the install, named after the module (`models.Order`), each class
  defined in the module under its own name; run again, it writes nothing. `ToDataclass(schema, name)` returns a new
  dataclass, and `ToDataclass.model(schemas)` several; both directions go through `ast` trees rather than source text.
  Only the classes' declarations are translated. Scalar fields are properties, and so are lists and dicts of scalars, nested or not: each holds a
  container, by an int index (dense) or by its scalar key (sparse for an int key), written back as `list[E]` and
  `dict[K, E]`. A container of dataclasses (`set[X]`, `list[X]`, `dict[K, X]`) is a
  relation with links `owner` and `item`, plus `index: int` or `key: K` with `unique(item)` for lists and dicts: the
  owner's adjacency is the field, and each element class gets an adjacency via `item`. Adjacencies declare which
  object schemas may fill a link, so writing a class finds a container's element schema by reverse lookup, and writes
  fields only for adjacencies via a relation's first link. Defaults, mandatoriness and nested classes (value
  objects) are left out or refused.

## Stores

A store is the root object of a body of data: it holds named schemas, and the data reachable from its roots. Code
locates schemas, builders and objects through a store, never through a global. Implemented in `Builders.Store`;
envisioned also for generated (language-optimized) data structures, SQL and noSQL databases, and in-memory cache
slices.

- **`Visitors.OfStore` is the protocol** (Object identity, Decided, 100; `Stores.Store` before), which every
  implementation of the framework meets:
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
- **Stores combine (deprecated: [Store overhaul, Decided, 18](proposals/store-overhaul/README.md#decided-here)).**
  `Stores.Combined(*stores)` is one store of several: each name belongs to the one store that
  registers it (a name two register for different schemas is refused; one they register for the same schema, as
  every store of proxies registers the meta-schemas, is the first's), which gives its schema, builds its objects and
  reads their members; its singletons are all of theirs, and an extent is the owning store's and what every store's
  singletons reach, and combined stores combine again.
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
- **Every store holds the framework's schemas.** A `Builders.Store` holds the meta-schemas, the basic scalars
  (`Schemas.OfBool`, `Schemas.OfInt`, ...) and the mutation schemas, and builds schema objects as it builds data
  (Resolved, "Schema builders align with their meta-schemas"; [Meta-schemas overhaul, The meta-schemas and their
  builders, as built](META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built)).
- **A store links only the schema objects it holds.** A builder in a store refuses a link to a schema object the store
  does not hold, built outside any store or in another: "A reference object no store built is strictly forbidden"
  (Resolved, "Schema builders align with their meta-schemas": the wire format), and schema objects are reference
  objects. A store's basic scalars are its own, linked by its paths (`store.Schemas.OfInt`, and so on); another
  scalar, a form or any other schema object is built in the store that links it. No schema object is shared across
  stores ([Schema extension, Decided, 23](SCHEMA_EXTENSION.md#decided)).
- **Schemas are extended, not redefined.** A module's install adds members to the schemas a store holds, its plain
  schemas of schemas included ([Installing schemas](proposals/install/README.md)). A schema the store was made holding
  only gains members, in any transaction, and changes no other way; a store's own schemas change freely ([Installing
  schemas, Decided, 5](proposals/install/README.md#decided); [Schema extension](SCHEMA_EXTENSION.md)).
- **A proxy knows its store.** `Proxies.store_of(value)` gives the store a proxy belongs to, and a placed value
  object's is its owner's.
- **Everything that looks schemas up takes a store**: `Plain.ToPlain(store)` and `Plain.FromPlain(store)`, the JSON and
  YAML forms, `Validators.Validate(store)`, a store's snapshots, and a
  builder inferring the schema of an object it creates through a link (from the store's schemas).
- **Queries are an extension.** The protocol locates schemas, builders, singletons and extents; selecting objects by a
  condition belongs to [mbse-patterns](https://github.com/pitaman71/mbse-patterns), whose queryable store protocol adds
  `select` and whose `Scan` answers queries over any store's extents, with mbse-expressions' expressions as the
  conditions. A store that can answer a query scalarly (a database) implements `select` itself.

## Proxies

- `Proxies` : for each schema element `OfX`, `Proxies.OfX.Data` holds a value in memory as schema-independent types,
  and `Proxies.OfX.Builder` builds one; both implement `Visitors.OfX`, data instances read-only, builders writable.
  Validation is never implicit: it runs only when the caller invokes it.
- **Objects read alike, whatever implements them.** A proxy's property is a member, its visitor (`contact.name`, read
  compactly as `str(contact.name)` or `contact.name.get()`), and so is an adjacency, the adjacency's visitor, which
  iterates its entries in order (`contact.phones`, a tuple in Python and an array in TypeScript). An entry is one
  object, shared by the objects it links, whose links are the linked objects themselves and whose properties are
  members (`entry.owner`, `entry.phone`, `entry.label`), read-only. Generated code (mbse-codegen-*) will have the same
  members, so code that reads objects works on proxies and generated code alike, as Resolved specifies
  (Adjacencies): an entry is a `Proxies.OfEntry.Data`. Any iterable will do; a set sorted by a comparator, which
  would serve retrieval, is an open question. A proxy's adjacency (`Proxies.OfAdjacency.Data`) also has
  `project(name)`, each entry's link or property `name` in order, and `at(key)`, the entry with the key its relation
  declares from this end (`Schemas.OfRelation.Data.key`), a `KeyError` for none and a `TypeError` where the relation
  declares none (in TypeScript it replaces the array's own `at(index)`). On the wire, an entry is written in its
  adjacency's form, without the link the adjacency implies, and an adjacency's entries are written sorted by that key
  where every entry holds it as values of one ordered scalar (booleans false first, numbers by value, strings by code
  point), and in the order they were added otherwise (a key holding a link, an entry without one).

## Generated code

`Proxies` gives any registered schema dynamic instances. Code generation (phase 6 of [the meta-schemas
overhaul](META_SCHEMAS.md)) will give each schema the same parts as typed code: `<schemaName>.Data`, the instance form;
`<schemaName>.Builder`, the mutator form, implementing `Visitors`; and `<schemaName>.Schema`, the schema itself
(Resolved, The visitor pattern). `Bindings`, which bound a program's own classes to schemas through the old protocol,
was removed with it.

## Serialization

Both in-memory objects and mutations (see `Mutations`) are serializable.

Over the wire, object content carries no schema. Association of an object with a schema is done dynamically, starting
from the expected root schema, which is why deserializers such as `Plain.FromPlain(store)(schema, ...)` take it as an
argument, and continuing through property schemas and the branch written with each union value. Links are untyped, so
each object a document holds is a symbol naming its schema, by the schema's path, beside what its spec gives of it, and
a reference to it is its symbol, or, to an object the document does not hold, its path (`Mutations.OfObject.Ref`;
docs/OBJECT_IDENTITY.md, Decided, 51 and 55).
Consequently, a reference object written in a document must have a schema the store holds.

A transaction is a flat sequence of mutations. Mutations may be nested; transactions are not.

- A data object is a singleton, owned, or counted (docs/OBJECT_IDENTITY.md, Decided, 37). A singleton's path is its
  global name alone; an owned object's runs from a singleton through the entries that own it, each through an
  adjacency marked `owner()` and keyed by its relation's key properties. Paths are not local to a transaction or a
  snapshot: a later one refers to the same object by the same path, and loading a path the store already holds
  updates that object through its builder (Resolved, Reference identity, on update): what the snapshot holds is
  written, and what it omits is kept. A counted object, which neither is, has no identity beyond the document that
  writes it: the document makes it a symbol, named by its number in the order it meets objects from the root, which
  is `"0"`, and reading a document builds its counted objects anew (55, 102). A schema object is referred to by its path
  too, from the root module, the singleton `"."` (Object identity, Decided, 80 and 81); one with no name of its own has
  none, and is defined where the one object that links it links it (`Mutations.OfObject.Def`).
- Paths name only reference objects, never values or entries. They are deprecated in favor of References (Resolved,
  References), which designate objects, relation entries and frames alike; the wire still writes a path.
- A value object is written nested, as a mapping of its properties and its adjacencies, without a key. Union and intersection values are written the
  same way, keyed by branch or part name: a union value `{"phone": {"number": "1"}}` has exactly one key, and decoding
  rejects any other count; an intersection value `{"stamp": {...}, "audit": {...}}` has a key per part, and a missing
  part is for `Validators` to report.
- Only a `create` mutation creates an object. A reference never creates one.

- `Plain` : for each schema element `OfX`, `Plain.ToPlain.OfX` and `Plain.FromPlain.OfX` implement `Visitors.OfX` and
  convert between values and plain data (dicts, lists, strings, numbers, booleans, null). `Plain.ToPlain(store)(schema,
  value)` and `Plain.FromPlain(store)(schema, plain)` dispatch on the schema's kind; the store names the schemas of the
  objects written, and builds the objects read. `Schemas.OfScalar` converts scalars to forms plain
  data can hold (`bytes` as base64 text; non-finite floats as the strings `NaN`, `Infinity`, `-Infinity`), so text
  encodings never handle that themselves. A reference object is written in a document, one transaction
  (docs/OBJECT_IDENTITY.md, Decided, 51; docs/SERIALIZATION.md, Documents): one upsert whose symbols are the objects
  the document holds, numbered in the order it meets them from the root, `"0"`, each naming its schema by path, and
  whose spec gives each one's properties (`as_property`) and its named adjacencies' entries (`as_adjacency`, `insert`),
  each entry once, from the first object the document holds that holds it, sorted by the key its relation declares
  where its values are ordered; an entry's links refer to a symbol or a path, the object's own implied.
  `Plain.ToPlain(store).OfObject` holds the root alone, and refuses a root that links a counted object;
  `Plain.ToPlain(store).Reachable` holds the root and the counted objects reachable from it, through the objects it
  holds. Either takes a uid, which keys the upsert. Reading a document executes it, within the store's open transaction
  as a savepoint: a singleton's symbol binds the singleton, an owned object's the object its owning entry names, a
  counted object's a new one (or, under a uid read again while held, the one it made), each written where the document
  does not hold, the k-th entry equal to a given one the k-th such entry held. A container is written inside its owner,
  as its arrangement writes it (Resolved, Containers). A store's snapshot is two transactions, its schemas, then its
  data (docs/OBJECT_IDENTITY.md, Decided, 101; docs/SERIALIZATION.md, Snapshots).
- `JSON` : `JSON.ToJSON(store)(schema, value)` returns JSON text and `JSON.FromJSON(store)(schema, text)` rebuilds values;
  both mirror `Plain` (`.OfScalar`, `.OfObject`, `.Reachable`). Output is strict JSON (RFC 8259) with key order kept;
  input with NaN / Infinity literals or duplicate keys is rejected.
- `YAML` : `YAML.ToYAML(store)` / `YAML.FromYAML(store)`, mirroring `JSON`. Requires PyYAML (the `yaml` extra), imported
  only when used. Loading follows the YAML 1.2 core schema rather than PyYAML's YAML 1.1 defaults: only `true` /
  `false` are booleans, `010` is ten, `1:30` and unquoted dates are strings. Duplicate keys, multiple documents,
  non-string keys and non-plain values (e.g. `!!binary`, `!!set`) are rejected. Dumping quotes any string a YAML 1.1
  or 1.2 reader would misread and never emits aliases.
- JSON and YAML are thin text encodings of `Plain` data.

### Decoding errors

Every problem in the data being decoded raises `Errors.DecodeError`, a subclass of `ValueError`. This covers
`JSON.loads`, `YAML.loads`, `Plain.FromPlain`, `JSON.FromJSON`, `YAML.FromYAML` and `Schemas.OfScalar.Data.from_plain`.
Mistakes in the calling program keep their usual classes, e.g. a root schema that is not an object schema raises
`TypeError`.

- `reason` is one line of text with no location in it.
- The location is `line` and `column` for text (1-based, counted in code points), or `path` for plain data, e.g.
  `$.mutations[0].upsert.exists[0].spec[0]["0"][1].as_property.mutations[0].set.value`. Keys that are not identifiers are written in brackets, as JSON
  strings. A problem may have no location, e.g. undecodable bytes.
- The message is `line 3, column 7: reason`, or `$.path: reason`, or just the reason.
- If text has several problems, the first in the text is reported. A document is checked in a fixed order that every
  binding follows: its expression as it is read, member by member, then, for each pattern, its spec, symbol by symbol:
  each member's shape and name, each value against its schema, each reference to a symbol or a path's shape.
- Nothing is written when a `DecodeError` is raised: a document is checked before its transaction runs, and what only
  running finds (a path to nothing) undoes what it wrote.
- Reasons and locations are identical in every binding, with one exception. For YAML syntax errors (and for
  constructs that one parser accepts and another rejects), the reason text and location come from each binding's
  parser. The framework's own YAML profile is identical: one document, string keys, no duplicate keys, no tags except
  `!`, `!!str`, `!!seq` and `!!map`, and no undefined aliases.
- Bytes are decoded as UTF-8, UTF-16 or UTF-32, detected as JSON specifies (RFC 8259 and its predecessors) for both
  JSON and YAML input. Undecodable bytes give `input is not valid <encoding>`.

## Value objects and reference objects

Implemented, except where a bullet says otherwise. This lifts the earlier decision that a value object has no identity
and no adjacencies, so that an object can be composed of parts that have lists of their own (a component's ports, a
schema's properties). Links target reference objects only (Resolved, The visitor pattern: "value objects cannot be
referenced by entries"). The terms are to replace "value object" and "object" throughout the API's messages and these
documents.

- **A reference object can be linked by relations** and has an identity if it is a singleton or owned
  (docs/OBJECT_IDENTITY.md, Decided, 37); a value object has none, and is known by its owner and the property holding
  it. What distinguishes the two kinds is
  ownership, and the schema says which kind it describes: `Schemas.OfObject.Builder().ref()` marks a *reference object
  schema*; an object schema without it is a *value object schema*. A singleton's schema is a reference object schema.
- **A reference object** stands on its own: a document writes it once, as a symbol, and refers to it by its symbol or
  its path. A
  document's root is a reference object, and a store's builders (`store.<Name>()`) make only reference objects. A reference
  object schema is never a property's schema, directly or as a union's branch or an intersection's part held by a
  property, nor an entry property's: `validate()` reports it ("a reference object schema cannot be a property's
  type"). Reference objects are reached through relations only.
- **A value object** is held by a property whose schema is a value object schema, and belongs to that one owner, a
  reference object or another value object. Union and intersection values are value objects, and so are the objects they hold.
  `Proxies.owner_of(value)` gives a value object's owner, and None for a reference object.
- **A value object has no adjacencies**: entries never link value objects, which are never shared. `validate()`
  reports a value object schema's adjacency ("a value object schema has no adjacencies: entries never link value
  objects, which are never shared"). Its lists are containers, held by its properties. A value object's schema follows
  from its owner's, so a value object schema needs no registration. Writers, proxies and `Validators` refuse a link to
  a value object ("a link targets a reference object, never a value object").
- **Ownership is exclusive and deep.** Editing a value object through its owner's builder keeps it, the same object.
  Setting it into another owner, or `clone()` of its owner, copies it, with what it holds. Clearing the property, or
  replacing its value, removes the value object.
- **Entry properties may be value objects, never reference objects.** Such a value object is owned by the object that
  added its entry, is written nested in the entry, and keys and compares the entry by its properties.
- **Value objects are written nested**, inside their owner, with their containers nested in them, and carry no key:
  nothing links to them. Decoding rejects a reference that is not `{"$ref": path}`.
- **Decoding** rebuilds a value object through its owner's builder. `Store.member(instance, name)` reads the value an
  instance holds in a property (a union's branch, an intersection's part).
- **Value objects compare deeply**: by their properties, recursively, containers included. They have no identity.
  Reference objects compare by identity when linked.
- **Proxies keep value objects read-only**, written through the owner's builder, e.g.
  `.home(lambda p: p.as_object(lambda r: r.number("1")))`.

## Unions and intersections by name

These replace the earlier design, in which a union's branches were chosen by predicates and written as
`{"$branch": index, "$value": value}`, and an intersection's parts merged into one value.

- **Every union branch and every intersection part has a name.** Names are required, unique within their union or
  intersection, and are property names, named as properties are (see reserved names under Open questions).
- **Unpacked, a union is an object with exactly one of its variants present, and an intersection an object with all of
  its parts present.** This holds in proxies and over the wire (`Plain`, `JSON`, `YAML`): a union value is written
  `{"circle": {"radius": 2}}`, and an intersection value `{"Named": {"name": "a"}, "Dated": {"date": "..."}}`. A proxy
  reads a variant as a property (`shape.circle`) and a part the same way (`x.Named.name`), unless the schema is flat
  (below). The wire form is always per branch and per part.
- **A union or an intersection may be flat**, a configuration of its schema (`.flat()`, written `"flat": true` in a
  module), which proxies and generated bindings alike honor, so that code reads either the same way. A flat union's
  value reads as its branch's value (`card.reach` is the `Mail` or the `Call`, `ticket.code` the `int` or the
  `str`), told apart by schema; a builder takes a branch's value and picks the branch by its schema, and a Spec as before.
  A flat intersection's value reads its parts' properties as its own (`ticket.stamp.at`), and its builder sets them in
  their part. `validate()` requires a flat union's branches to be told apart by schema (distinct scalars, distinct
  schemas) and a flat
  intersection's parts to be object schemas whose properties have distinct names. Values are held, written, read,
  validated, compared and visited in the unpacked form, by branch and by part: flat is how code reads and builds them.
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
- **Intersections are how a schema inherits** another's properties and adjacencies, a part for each. Using them as
  subtyping, upcast by projecting a part and downcast by its owner, is proposed in [Open-world
  modeling](OPEN_WORLD.md).

## Lists

A list, a dict, a map or a tensor of values, value objects among them, is a property holding a container,
`OfContainer` (Resolved, Containers, as the user decided, reversing the earlier "a list is a one-link relation").
Reference objects are never kept in containers: a collection of them is a relation, which has two links or more.

- **A container holds elements by index**: `p.name("tags").of(lambda t: t.as_container(lambda c:
  c.index(Int).element(Text)))`. Dense by position for an integer-like index (an int, or a value object of ints for a
  tensor), a dict for any other hashable index, and entry-like elements otherwise; `.dense()` or `.sparse()` sets the
  layout where the index has a total order.
- **Elements belong to the owner.** A value object a container holds is copied with its owner, edited in place, and
  removed with its element.
- **Proxies read a container through `Visitors.OfContainer`**: `at(index)` gives an element's `Visitors.OfAny`,
  `as_entries` each element with its index, `as_ordered` an iterator over the positions of a dense or sparse
  container, `as_dict` a dict's elements; a builder writes through the same visitors, and `remove(index)`.
- **Over the wire**, a dense container is an array (nested, or flat with its shape, for a tensor), a sparse one its
  blocks, a dict by text a mapping, and any other an array of `{"index", "element"}` (Serialization).
- **Validation** checks each element at the path `label.tags[0]`; **comparison** is element by element, by index;
  containers of different index or element schemas are incomparable (Equality).
- **An open relation's entries are a list** from each end, in the order added, equal entries kept; with a `unique`
  clause a relation holds a set (Cardinality).
- **No bound is part of a list.** An array's size, a capacity or a tensor's shape is a constraint on the schema of a
  container's index, which constraints (planned) will express; until then nothing checks it.

## Scalars

Scalars are implemented, and written over the wire by their meta-schema (see Meta-schemas).

- **The scalar schemas are the five basic scalars** (since 0.18.0; [Store overhaul, Decided, 8, 9, 22 and
  23](proposals/store-overhaul/README.md#decided-here)): `Schemas.OfBool`, `Schemas.OfInt`, `Schemas.OfFloat`,
  `Schemas.OfStr` and `Schemas.OfBytes`, which every store is made holding, each its own. Each maps to each
  language's host type by its own name; a value of any schema is tagged with its basic scalar's tag (`int`, `str`, ...,
  the names of mbse-expressions' Basic dialect). A store builds no other scalar schema ("a store builds no scalar
  schema"), and a scalar has no `token`, `format` or `refines`: every finer scalar, a date or an `int32`, is a domain,
  mbse-expressions', which may associate several with one basic scalar.
- **`OfScalar.Data` holds its name**: a host type given to it (`Schemas.OfScalar.Data(int)`, `new
  Schemas.OfScalar.Data(BigInt)`) is shorthand for the basic scalar's name. Data no store builds may name another
  (`Schemas.OfScalar.Data(name="Word")`): its host type, `type`, is none, `host()` and converting a value raise `TypeError` ("the
  scalar 'Word' is not a basic scalar"), decoding raises `Errors.DecodeError`, and `validate()` reports it.
- **A scalar has no width** (since 0.17.0; [Store overhaul](proposals/store-overhaul/README.md), Decided, 20): a width,
  and how the bits are interpreted (signedness, encoding, float format, text encoding), are a domain's, which
  mbse-expressions associates with a scalar schema ([Schema extension](SCHEMA_EXTENSION.md), section 2).

## Meta-schemas

Schemas are data: each schema kind's data has a meta-schema, `Schemas.OfX.Schema`, a value object schema, so schemas
are written, read, validated and compared like any other objects.

Every schema object is a reference object of its meta-schema, held by its store, and every reference between schema
objects is a relation: the meta-schemas, their builders and the store are described as built in [Meta-schemas
overhaul, The meta-schemas and their builders, as
built](META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built). Every named schema is in a module, a schema
object too, named by its dotted path (Resolved, "Schema builders align with their meta-schemas": the initial snapshot). A store, its schemas included, is
written as its snapshot, two transactions ([SERIALIZATION.md](SERIALIZATION.md), Snapshots); the old `Modules` and their
inline wire form are removed.

- **A schema may hold itself**, as a node holds a list of nodes, or a container a container of itself. Validating it
  reports each problem once, for every kind whose values hold others'. (Object identity's Decided 72, which refused a
  value schema that holds itself, was built in 4g and then removed: "let any term tree be recursive", Decided, 82.)

## A store's schemas as a module

Codegen and other transforms (mbse-patterns) match schemas, not data. `Schemas.OfStore.root_module()` (phase 5 of [the
meta-schemas overhaul](META_SCHEMAS.md)) will return the hierarchical `Schemas.OfModule` of the schemas a store
registers, by module-qualified name, as linked objects; it replaces `Reflection`, removed with the old protocol, and
`Paths` went with it (Resolved, The visitor pattern). A store's basic scalars are its own and never written; a
snapshot refers to them by key (`Schemas.OfScalar/Schemas.OfInt`).

## Expressions

Constraints are serializable expressions: `Schemas.OfConstraint`, an `Schemas.OfExpression` of boolean result, over a
pattern's frames (`Schemas.OfPattern`; Resolved, Patterns), whose terms are mbse-expressions'. Expressions are a
separate package, [mbse-expressions](https://github.com/pitaman71/mbse-expressions), which
depends on this one: its expressions are ordinary objects with registered meta-schemas, so this package serializes,
validates and compares them like any others. See its `docs/EXPRESSIONS.md` for the expression kinds, the core vocabulary
and evaluation.

Nothing in this package evaluates expressions: a union value names its branch, so neither decoding nor validation needs
an evaluator. Anything here that comes to evaluate constraints will take an evaluator from its caller rather than
import one, so the dependency keeps pointing one way.

## Parametrics

Status: parameters are a module, `Parametrics`, normal schemas and one extension, installed before use
([PARAMETRICS.md](PARAMETRICS.md); [Parametrics as a module](proposals/parametrics/README.md), Decided, 1 to 4; Store
overhaul 4m): declaring parameters, each for a value or for an object, validating them and writing them are built;
storing bindings is not yet (open). Since 0.17.0 applying a schema to arguments, terms, widths, evaluators and
equivalence after substitution are gone from mbse-schemas: they are mbse-expressions' ([Store
overhaul](proposals/store-overhaul/README.md), Decided, 20; [Schema extension](SCHEMA_EXTENSION.md), Decided, 5 to 7).
The decisions below stand for wherever binding is built.

A parameter is a variable of a schema, or of anything else that declares it, that is determined where that element is
referred to, not by data. mbse-patterns' symbols are the other kind of variable: a predicate's symbol ranges over a
store's data, and its parameters are given where the predicate is applied. In the terms of
[MBSE.md](https://github.com/pitaman71/mbse-basis/blob/main/MBSE.md#what-a-specification-is-made-of), an argument is a value constraint (`rows = 3`) and a parameter
without one is an unrestricted variable, so inferring a shape (a concatenation's length, the sum of its parts') is
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
- **At a reference**, named arguments (positional ones went: `OfApply` binds by name only, Resolved), partial binding, arguments that depend on the referring
  element's own parameters, and equality after substitution, each to the extent possible.
- **Unknown is an outcome of validation.** Data checked against a schema whose unbound parameters it depends on is
  neither valid nor invalid there.
- **A term in a schema is written as a nested form**, `Schemas.Form`: mbse-expressions' `Terms.Form` is this class.
  (Superseded: since 0.17.0 mbse-schemas holds no term; Store overhaul, Decided, 20.)

### Built

- **`Schemas.OfParameter` is an element**, like a property: a `name` and a `description`, a symbol (mbse-basis P-015)
  standing for what is bound where the definition is referred to (Store overhaul, Decided, 20: "Names only"). It is not
  a kind of schema, since no property's value is a parameter; a parameter compares by what it holds.
- **`Parametrics`, installed before use** (`store.transaction(Parametrics.install)`; Store overhaul 4m): a set of
  parameters, `Parametrics.OfParameters`, holds each through `Parametrics.Defines`, keyed by its name; a parameter is
  for a value of a schema (`for_value`, `Parametrics.ForValue`) or for an object of an object schema (`for_object`,
  `Parametrics.ForObject`), exactly one (Parametrics as a module, Decided, 1 and 2). Every kind of schema declares one
  set, `.parameters([txn.Parametrics.OfParameters(...)])` (`Parametrics.HasParameters`, unique in both directions), the
  extension adding the adjacency to each kind. A parameter's scope is its binder, inline schemas nested in it included.
  `BindsValue` and `BindsObject` are defined (Decided, 3); no kind has their adjacencies yet (open).
- **Validation moved to `Parametrics.Defines`** (Decided): `Parametrics.validate(store, defn)` reports reserved names,
  bad descriptions, a parameter for neither or both of a value and an object, a pattern's names used as both a symbol
  or a variable and a parameter, and a definition with more than one set or a set with more than one definition. A
  kind's `validate()` does not see parameters (fixed by the agent, for the user's review).
- **A store's snapshot writes them** ([SERIALIZATION.md](SERIALIZATION.md)): a set is data, written with the store's
  data, its parameters defined where its entries link them; the definition's `parameters` entry is written once. A
  store without `Parametrics` reads such a snapshot ignoring what needs it (Store overhaul, Decided, 19).
- **Validation evaluates nothing.** `Validators.Check(store)(schema, value)` reports problems and `unknowns`; its
  `Outcome` is three-valued, though nothing it checks is unknown yet (Validators).

### Moved out

Since Store overhaul 4m, out of the core into `Parametrics`: `Schemas.HasParameter`, every kind's built-in
`parameters`, the data classes' `parameters`, the builders' `parameters` member and the checks of `validate()` on them.

0.17.0:

`OfApply` and its arguments (`Argument`), terms (`Schemas.Form`), a scalar's widths (`bits`, `bytes`), a predicate's
`requires`, typed and value parameters, `Schemas.structure`, `Schemas.Evaluate` and `Schemas.equivalent` are removed
(Store overhaul, Decided, 20; Schema extension, Decided, 5 to 7). Binding a schema's parameters is
`store.Parameters.Bind` and `store.Parameters.Apply` ([Parametrics](PARAMETRICS.md); Store overhaul, Decided, 12),
built in mbse-expressions with value parameters, terms and domains; a predicate's constraint is mbse-patterns'.

### Later, elsewhere

- mbse-expressions: binding (`Parameters.Bind`, `Parameters.Apply`), value parameters, terms and domains (widths);
  schemas as binders, so that `free` sees their parameters; an evaluator for terms.
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
| Scalar host types (of the basic scalars) | `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` |
| Scalar values | `int`, `float`, `str`, `bool`, `bytes` | `bigint`, `number`, `string`, `boolean`, `Uint8Array` |
| Plain mappings | `dict` | `Map<string, PlainData>` (order-preserving for every key) |
| Lists in proxies | `tuple` | a callable `Proxy` over a frozen array |
| Keyed lists in proxies | `Mapping` (`m[key]`, iterates keys) | `Map`-shaped (`m.get(key)`, iterates entries) |
| Schema data equality | `==` | `.equals()` |
| Errors | built-in `TypeError`, `ValueError`, `AttributeError`, `KeyError`, `LookupError`, `NotImplementedError`; `Errors.DecodeError` | built-in `TypeError`; the others and `DecodeError` exported from `Errors`, with the same names |
| Callable entry points | `Plain.ToPlain(store)(...)`, `Plain.FromPlain(store)(...)` (objects with `__call__`) | functions with the per-kind forms attached |
| Keyword arguments | `ToJSON(..., indent=2)` | options objects: `ToJSON(..., { indent: 2 })` |
| Dynamic proxies | `__getattr__`, `__call__` | a `Proxy` with a function target, its `name` and `length` hidden; JavaScript protocol probes (`then`, `toJSON`, symbols) are not schema lookups |
| Scalar sugar | dunders (`str(card.name)`, `int(...)`) | `[Symbol.toPrimitive]` and `valueOf` (`` `${card.name}` ``, `+card.age`) |
| Lookup by keys | `adjacency({"name": "DEF-693"})`: any mapping | `adjacency({ name: "DEF-693" })`: an object literal |
| Incomparable (`Comparison`) | `None` | `null` |
| JSON | `json` with strict options | own reader and writer reproducing Python's output; ints and floats kept distinct |
| YAML | PyYAML (optional extra), YAML 1.2 core loader | `yaml` package loader, own block emitter; the same quoting |

## Open questions

- **Where constraints attach.** A specification is constraints attached to the parts of a system they constrain, each
  held by a property named `requires` ([MBSE.md](https://github.com/pitaman71/mbse-basis/blob/main/MBSE.md#what-a-specification-is-made-of)); mbse-patterns'
  predicates already hold theirs so. Which scopes a constraint attaches to (a schema, a property, a relation, an
  interface, a whole specification), and how attached constraints combine into one conjunction, is not decided.
  The elements that bind parameters (see Parametrics) are likely the same scopes.
- **Open-world modeling**: independent extension of schemas a module does not own, by intersections as subtyping
  (reference intersections, extents over parts), policies for undeclared properties (preserved, or extension
  properties declared elsewhere), and evolution that keeps data valid. A proposal, with its decisions and the work
  it entails, in [Open-world modeling](OPEN_WORLD.md). A restricted `OfAny` refuses a value of a schema outside its
  restriction, which open-world modeling "would require different handling" for (Resolved, "`OfAny` returns").
- **Parametrics**, beyond the proposal (see Parametrics): schema parameters now or later; equality of differently
  written applications that substitute alike (`Matrix(n, n)` and `Square(n)`); and what proxies accept for data
  whose shape depends on an unbound parameter.

Findings from the test plans (`python3/tests/TestPlan.md`, `typescript5/tests/TestPlan.md`) that need a design decision:

- Reserved names (F2): names starting with `$` are reserved for the wire format, and `as_` for the visitor protocol
  (see Resolved). Other property and adjacency names that collide with a visitor's own members (e.g. `create`, or
  names starting with `_`; `then` in JavaScript) cannot be set through a builder's member or read as members in some
  bindings, and `validate()` accepts them. Should schemas reject names that any target language reserves, or should bindings rename them?
- Concurrent builders (F4): two builders over the same object each hold a copy; the last `update()` wins and drops
  entries the other added. Is that the intended semantics of `update()`?
- Cloning self-loops (F5): `clone()` copies entries with the clone in place of the source, so a self-loop's clone
  links back to the original rather than to itself. Intended?
- *Resolved in 4f-3*: snapshots whose two ends disagree (F13) were accepted, restoring the union of both ends'
  entries; a document or a snapshot now writes each entry once, so its ends cannot disagree.

- Containers (Resolved, Containers): V5 is built with the choices listed there for the user's review (the names on
  the wire, the writer's option for several int indices, comparison and validation, `Visitors.OfIterator` as the one
  name where the draft in [Visitor pattern](VISITOR_PATTERN.md) also says `Visitors.OfPosition`), which await
  confirmation; still open: whether a dense container's shape is a constraint (Parametrics) or data.
- Equality edge cases listed in `EQUALITY.md` are proposals; confirm them.
- Multi-object snapshot naming: confirm `Plain.ToPlain(store).Reachable(schema, value)` /
  `Plain.FromPlain(store).Reachable(schema, plain)` (still marked PROPOSED in the example).
- Snapshot determinism: must two serializations of the same state produce identical output? Entries are now written
  with links and properties in the relation's declared order, and an adjacency's entries sorted by its key where the
  key is of ordered values, and objects keep their identities, but objects are written in first-reference order, and
  other adjacencies' entry order depends on history, so a round trip can reorder entries, and with them the objects
  (PLN-08; the `FamilyTree` and `University` examples compare snapshots up to that order). Full determinism would need
  a canonical order for entries keyed by links, or not keyed at all.
- Uniqueness is global to a relation, but `Validators.Validate(...).Reachable` checks it only over the entries
  reachable from what was validated. Entries in another component that share only property values can go unchecked.
  Is a relation-wide check needed?
- `Schemas.OfAny.Data` is currently the union of the schema kinds' data (`OfScalar`, `OfObject`, `OfUnion`,
  `OfIntersection`). There is no separate "any value" kind yet.
- Reading an object's entries back (e.g. a contact's phones), and removing an entry through a builder.
- Is "an owned child must be part of an ownership chain rooted in an object with a directory entry" still a
  well-formedness constraint under identity-based serialization?

### Resolved

- **A restricted `OfAny` never guesses its schema** (0.26.3), as the user decided, in mbse-basis
  [PRI-025: never guess the schema](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md#PRI-025), [PRI-026: serialization through the visitor
  protocol](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md#PRI-026), [CAP-069: wire format shorthand
  (scalars)](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-069) and [CAP-070: wire format shorthand
  (containers)](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-070). The rules, every point of them:
  1. "Never guess the schema": what a value is, is never inferred from the shape of its data. A reader tracks the
     expected schema as context while traversing wire data, and the wire names a value's schema wherever that context
     leaves it open (PRI-025).
  2. "serialization is handled via visitor protocol", and a reader tracks the expected schema as context while
     traversing wire data. "The wire format *usually* tracks each recursion by the writer while traversing in-memory
     data which has the effect of wrapping unions explicitly. Shorthands permit these wrappers to be skipped in cases
     where the correct behavior can be unambiguously and trivially inferred from context by a reader that already
     knows the expected schema. This makes the format more concise and resilient to errors from humans and agents in
     the loop." (PRI-026)
  3. "in the scalar case of a `Schemas.OfAny` that represents a specific scalar (such as `Schemas.OfScalar` ->
     `Schemas.OfInt`) the wire format may omit the implied union wrapper(s) e.g. `1` instead of
     `{ "scalar": { "int": 1 } }` provided the written form unambiguously aligns with the schema (e.g. `scalar` -> `int`)
     and the reader must tolerate this optionality of representation": from `OfAny` through `OfScalar` to `OfInt`, "up
     to 2 wrapper levels" (CAP-069).
  4. "in the container case of a `Schemas.OfAny` that represents a specific container (e.g. `Schemas.OfContainer`)
     the wire format may omit the implied union wrapper `[ "dog", "cat", "mouse" ]` instead of
     `{ "container": [ "dog", "cat", "mouse" ] }` and the reader must tolerate this optionality of representation"
     (CAP-070).
  5. An unrestricted `OfAny` ([CAP-071](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-071)) is not designed, and is left as
     it was: tagged by one level, `{"int": 1}`, `{"Phone": {...}}`.

  As built, for an `OfAny` restricted to any number of schemas, of any kinds ([Serialization, A restricted `OfAny` on
  the wire](SERIALIZATION.md#a-restricted-ofany-on-the-wire)):
  - **The writer** wraps a value by its kind, then its schema: `{"scalar": {"str": "x"}}`,
    `{"object": {"crm.Phone": {...}}}`, `{"union": {"Code": {...}}}`, `{"intersection": {"Stamp": {...}}}`, a scalar
    named by its basic scalar's tag and any other schema by its registered name; unless the shorthand is trivially
    unambiguous: exactly one of the restriction's schemas takes the plain form written (`Schemas.plain_forms`), so
    that `1`, `1.5` and `true` stay bare among Bool, Int, Float, Str and Bytes, while `"x"`, bytes (base64 text) and a
    non-finite float (`"NaN"`) are wrapped; and the bare form does not itself read as a wrapper (a mapping of one key,
    a kind's name: a value object whose one property is `object` is wrapped). Path keys (Bool, Int, Str) stay bare,
    and no corpus changed.
  - **The kind names** are `scalar`, `object`, `union`, `intersection` and `container`, `Visitors.OfAny`'s
    `as_<kind>` without `as_`, as CAP-069 and CAP-070 name two of them.
  - **A container**: CAP-070's example omits the schema level, `{"container": [...]}`; that form is written where
    the restriction leaves one container schema, and where it holds several, the schema is wrapped too,
    `{"container": {"Tags": [...]}}`. Every other kind always names its schema, as CAP-069 has
    `{"scalar": {"int": 1}}`.
  - **The reader**, knowing the expected schema, always accepts the wrapper, checking that its kind and schema are of
    the restriction, and accepts the bare shorthand only where exactly one of the restriction's schemas takes its
    plain form; otherwise it refuses, never guessing, with these messages, identical in both languages, at the path of
    the value: "several of this value's schemas take a bare str: it is wrapped by its kind and schema, never guessed";
    "a value of any schema takes the plain form of one of its schemas, got list"; "a value of any schema is wrapped by
    its kind, one of ['container', 'intersection', 'object', 'scalar', 'union'], got 'tensor'" (a mapping of one key
    where none of its schemas is a mapping); "no object schema is one of this value's schemas"; "'Cell' is not one of
    this value's object schemas"; "a value wrapped as 'union' is {schema: value}".
  - A value read as one of several schemas of its kind is built standalone, through the store's builder of its
    registered name, and assigned as a value, as an unrestricted `OfAny`'s is, since a Spec would not tell which of
    them to build (this also reads a bare list where the restriction holds a list and a dict by text).
  - **Validation** no longer refuses a restriction whose schemas share a plain form: the wrapper tells them apart.
    This supersedes, in "`OfAny` returns" below, "a restricted one is invalid where two of its types share a plain
    form that cannot be told apart"; "a value is written bare where only one of those types fits its plain form,
    tagged otherwise" (now wrapped by kind and schema, not tagged by schema alone); and "where the restriction leaves
    one object schema the value can be, it is written bare" (now bare where that schema is the only one taking a
    mapping). A value of a schema of no name that would have to be wrapped by its schema is refused when written, as
    an unrestricted `OfAny`'s is ("a value of any schema is of a registered schema").

- **Provenance** ([Provenance](proposals/provenance/README.md)), as the user decided (2026-10-26), from the
  proposal "I believe adding `Schemas.OfTransaction` will allow the services to handle almost all of transaction
  bookkeeping, provided locale and/or geolocation provided by the UI for transactions executed for an interactive
  user session." The rule, every point of it:
  1. A module of its own, "Make a new module `mbse-schemas.Provenance`", installed before use, as `Parametrics` is:
     `Provenance.OfTransaction`, `OfSession`, `OfIdentity`, `OfWhere`, `InSession`, `Who`, `CreatedBy`, `ModifiedBy`
     and their directories, the singletons `Provenance.Transactions`, `Sessions` and `Identities`.
  2. No expression in the record: "No, but record the transaction's uuid which can be cross-referenced": a record is
     keyed by its transaction's `uid`.
  3. Every transaction that writes is recorded; "Use placeholder data as needed and log tech debt to get it right":
     one without an expression or a session (an imperative scope) gets placeholder data (a `uid` the store makes,
     `when` at commit, the identity `unknown`), tech debt.
  4. "yes ISO8601 text for now": `when` is UTC ISO 8601 text until a date domain exists.
  5. "App code should itself decide which reference object schemas get provenance and which do not": the app's
     install calls `Provenance.extend(txn, schemas)`, which gives each schema anonymous adjacencies to `CreatedBy` and
     `ModifiedBy`; the executor links only objects of the schemas extended.
  6. "The token probably should not be part of the transaction record itself. The session id is part of the
     transaction record and that can be used to cross-reference token if necessary": a service writes the session's
     `id` and `who` into the expression before executing and journaling it; neither holds the token.
  7. "Let's make `Provenance.OfSession` explicit": a session, owned by `Provenance.Sessions`, keyed by its `id`, each
     transaction linked to its one session by `InSession`.
  8. "locale, device, who/identity belong to the session. when belongs on the transaction": a session holds its
     `locale`, `device` and `started`, and one identity through `Who`; a transaction holds its `when` and, "yes, move
     where to the transaction", its geolocation `where`. `Mutations.OfTransaction` gains `when`, `session` (`id`,
     `who`, `locale`, `device`) and `where`; the executor writes the records from them at commit, in the same
     transaction, the session and identity made on demand, so that a replayed journal makes the same records, found
     again by `uid`.
  9. "I was not expecting that relation to track the journal, just the tail": `ModifiedBy` holds one entry per object,
     the latest write, replaced by each later one.
  Built (2026-10-26), both languages, as [Provenance, Stages, as built](proposals/provenance/README.md#stages-as-built)
  says: `Provenance.install(txn)`, `Provenance.extend(txn, schemas)`, a transaction of its own after the app's install
  (`store.transaction(lambda t: Provenance.extend(t, [t.work.Comment]))`), `Mutations.OfTransaction`'s `when`,
  `session` and `where` on the wire, and the store's record of each transaction that creates or writes an object, at
  its commit, within it. What the decisions left open is settled in [Fixed by the agent, for the user's
  review](proposals/provenance/README.md#fixed-by-the-agent-for-the-users-review); the placeholder records are tech
  debt (TODO.md).
- **References** (step 4n of the store overhaul; [References](proposals/references/README.md)), as the user proposed
  and decided (2026-10-23), from writing client code whose requests start from "an identifier for an object or relation
  entry": "I believe these are all downstream of there not being a consolidated well-defined format for object and
  relation entry references." The rule, every point of it:
  1. Three value schemas, `References.OfObject` ("instances designate a singleton or other non-counted reference
     object"), `References.OfEntry` ("instances designate a relation entry") and `References.OfFrame`, in
     `Framework/References.py` and `.ts`, every store holding them, its own.
  2. A counted object has no reference, an upsert's included: "remove References.OfUpserted entirely from the
     prototype" (2026-10-23), since Object identity, Decided, 61 and 63, which gave an upsert-made counted object a
     durable identity, "are trying to create durable references to counted objects that by design should not be
     necessary or exist" (40, 55); retiring them from the executor is tech debt (TODO.md), "the purpose of this phase is
     to create durable references for client code". `References.OfObject` is a value object whose one property is `path`
     (`Paths.OfRoot`: a singleton, an owned object, a schema object). A frame or an entry that binds or links a counted
     object has no reference either.
  3. A frame's reference has no pattern: "take pattern out of frame ref entirely"; it "maps symbol names to
     `References.OfObject` and variable names to values" (`binds`, `variables`). A stream of them "is what is passed by
     the mutation executor from call to call and what will be transferred from services to UI". A frame is also a
     witness: `assigns`, the property values an object holds (`References.OfProperties`: the object's reference and
     its property values), and `entries`, relation entries (`References.OfEntry`), each by its objects' references,
     "by its identity not symbol"; the executor's frames carry neither.
  4. Paths stay for now: "temporarily leave Paths as having overlapping function with References, mark them as
     deprecated where they appear in the docs, tutorials, examples in favor of References, and log tech debt to
     eliminate Paths later". The wire's `$ref` keeps writing a path; the corpora do not change.
  5. An entry is designated "by all links and properties": its relation's path, each link a `References.OfObject`,
     each property its value.
  6. Built "right now": 4n, before 4k and 4h.
  7. A pattern's symbol may be given a reference instead of a schema, "(a) allow a symbol to have a reference instead
     of a schema" (2026-10-23), so that a query starts from one object: no syntax bound a symbol to a given object
     since the spec replaced locators (Object identity, Decided, 76). It generalizes 77 ("singletons are denoted by
     their schema"): a symbol given a `References.OfObject` binds what it designates, one object, or none where the
     store holds none; chosen over a spec item asserting identity (`_.x.is_([ref])`), which would range over the
     symbol's schema first. `References.install` extends `Schemas.OfSymbol` with `reference`, a symbol having exactly
     one of `schema` and `reference`; `.symbols({"x": ref})` records it. The symbol's schema, for writing its spec
     items, comes from context, as the user decided ("yes, just 1 now"; a client store holds the schemas but not the
     server's data): where the store holds the object the reference designates, that object's schema; otherwise the
     schema the reference's path implies, followed through the schemas alone. The path's singleton names a singleton,
     which exactly one schema declares; each entry step goes through the current schema's adjacency `i` to its
     relation, and the next schema is the one that declares the `owner()` adjacency `o` on that relation's other link;
     the last step's schema is the symbol's. Where the path cannot be followed (an unknown singleton, an adjacency the
     schema lacks, a link no one schema fills), writing a member of the symbol is refused with a message naming the
     step, and so is such a spec read from the wire (`DecodeError`). Nothing else changes: the wire form, a symbol's
     exactly-one rule, the executor's binding (it resolves the reference when it runs; a reference to nothing still
     gives no frame), Paths, counted objects.

  `References.of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back;
  `References.resolve(store, reference)` gives what it designates, or None where the store holds none. A symbol given
  a reference binds, in a map or an upsert's `exists`, what `References.resolve` gives, one frame for each frame it
  receives, or none; its spec filters or is written as any symbol's; `References.validate(pattern)` refuses a symbol
  given both a schema and a reference, or neither. What the agent fixed in building it, for the user's review, is in
  the proposal (Fixed by the agent).
- **Mappings for keyed adjacencies** (step 4e of the store overhaul; [Schema extension](SCHEMA_EXTENSION.md),
  Injection), as the user proposed and decided ("I like your idea", "yes that seems sensible"): an adjacency whose
  relation has exactly two links and one property may be given a mapping in place of the peer-shorthand list. For such
  a relation the adjacency's visitor is "a flat union of the Entry visitor and the Object visitor": it "exposes and
  delegates the properties of both the entry and the linked object as well as adjacencies of the linked object itself".
  Each item, in order, is one entry: its key is the value of the entry's property, and its value is given to that flat
  visitor, a callback called with it, the property already written, any other value given to the one member that
  accepts it (the entry's other link, or one of the linked object's properties and adjacencies), refused where none
  does or several do. `{"ada": Person}` and `{"ada": lambda s: s.schema([Person])}` are both `[lambda s:
  s.name("ada").schema([Person])]`. It inserts entries, as the list form does; keys being distinct, entries sharing a
  property value need the list form. In TypeScript a mapping is a `Map` or a record. Not a wrapper: one rule of the
  builder protocol, for every builder and schema ("wrapping fluent builder syntax is forbidden").
- **Versioning schema names** (0.21.0, step 4g of the store overhaul; [Object identity](OBJECT_IDENTITY.md), Decided,
  83), as the user decided ("(a) is preferable"): a module and a schema do not share a path, so a version is part of a
  name as a module of its own, `crm.v2.Contact` beside `crm.Contact`; `crm.Contact.v2` beside `crm.Contact`, whose
  module `crm.Contact` would be at the schema's path, is refused. (Before 4g the module silently took the schema's
  place in `crm`, and a snapshot lost the schema.) Snapshots refer to schemas by path, so a program that registers a
  schema under another name than the writer's cannot read its snapshots (tutorial 9 reads old data in a store of its
  own, under the writer's name).
- **Patterns** (0.21.0, step 4d of the store overhaul; [Object identity](OBJECT_IDENTITY.md), Decided, 66, 67 and 76 to
  78; [Mutations as queries](STREAMING_QUERIES.md), Patterns and Value expressions and constraints), as the user
  decided: `Schemas.OfPattern` replaces `Schemas.OfPredicate`, which goes. A pattern declares its symbols
  (`Schemas.HasSymbol`), each with an optional reference object schema, its variables (`Schemas.HasVariable`), each with
  an optional value schema, and its constraints, in order (`Schemas.Requiring`); `Schemas.OfExpression` has a pattern
  (`Schemas.Matching`) and a result schema (`Schemas.Resulting`), its terms mbse-expressions'; `Schemas.OfConstraint`
  builds an expression whose result is the store's `Schemas.OfBool`; `Schemas.OfCollector` has a pattern, the names it
  collects, `commutative`, `associative`, `suffixes` and what it `computes` (`Schemas.Computing`). Each is a schema
  object, built, validated and written in a store's snapshot as every one is. A pattern's `spec`, which replaces
  locators (76), is to come. Choices made in building it, for the user's review:
  - a flag is written `.commutative(True)`, as `.ref(True)` and `.owner(True)` are;
  - a symbol's and a variable's schemas are optional, as the design has them ("may provide"); what a term requires of
    them, and of a collector's `suffixes` and `computes`, is 4e's;
  - `Catalog.schema` names the kind it refuses: "'X' is a pattern; no pattern builder is exposed", "a value schema"
    for a union, an intersection or a container.
- **Schema, never "type"** (0.19.0; [Store overhaul, Decided, 24](proposals/store-overhaul/README.md#decided-here);
  mbse-basis V-026), as the user decided: "the term "type" has no meaning in mbse-*". What has a schema names it
  `schema`: `.schema([X])` (a property, a symbol, a branch, a part), the data's `schema` field, `OfAny`'s `schemas`, and
  `Schemas.HasSchema` linking `member` to `schema` (`Schemas.Typing`, linking `typed` to `schema`, until then); the
  messages say schema ("a reference object schema cannot be a property's schema", "a value of any schema"), and a
  derived identity ends `#schema`. A host language's own type, a scalar's `type` and `host()`, keeps its name.
- **A scalar is one of the five basic scalars** (0.18.0; [Store overhaul, Decided, 8, 9, 22 and
  23](proposals/store-overhaul/README.md#decided-here)), as the user decided: `token` and `format` leave
  `Schemas.OfScalar`, "Drop both (Recommended)", each basic scalar mapping to each language's host type by its own
  name, a format (dates, UUIDs) becoming a domain in mbse-expressions; a scalar's `refines` goes too, "Yes, remove it
  (Recommended)", objects and containers keeping it; and a user scalar in tests, tutorials and examples becomes "The
  basic scalar (Recommended)", its finer meaning moving to the property's description. Built:
  - a store refuses to build a scalar schema, and `validate()` reports scalar data that names no basic scalar;
  - an extension may add adjacencies to `Schemas.OfScalar`, whose entries a store's own scalars hold, written in a
    snapshot from either end (EXT-05); a property an extension adds to it can hold no value, since the store's own
    scalars only gain members.
- **A union's branches and an intersection's parts are relation entries** (0.18.0; [Store overhaul, Decided,
  4](proposals/store-overhaul/README.md#decided-here)), as the user decided, "`Meta.Member` -> relation meta-schemas":
  an entry of `Schemas.HasBranch` or `Schemas.HasPart` links the owner and the member's type, and carries its `name`
  and `description`; `Schemas.Member` and its builder are gone. The owner and the name determine the entry; a type may
  be linked by several. A branch has no identity of its own, and an unnamed type takes the first to link it's
  (`crm.Shape#branches.1`, SNP-02). Builders write them as before (`t.name("p").schema([A]).description("...")`).

- **Parameters are names only** (0.17.0; [Store overhaul, Decided, 20 and
  21](proposals/store-overhaul/README.md#decided-here)), as the user decided. A schema's parameters are "Names only
  (Recommended)": a parameter is a declared name, a symbol (mbse-basis P-015) standing for a schema; its `type` goes
  with the value parameters, which move to mbse-expressions, and `Parameters.Bind` and `Parameters.Apply` (Store
  overhaul, Decided, 12) bind parameters later. `Schemas.Meta` is "Defer it (Recommended)": nothing reads level 3
  yet. Carried out with [Schema extension](SCHEMA_EXTENSION.md), Decided, 5 to 7 (`requires` "moves out of
  mbse-schemas all the way out to `mbse-patterns`"; "all bindings will need to move into mbse-expressions"; `Form`
  "should go"):
  - `OfApply`, `Argument`, `Form` and its `Term`, a scalar's `bits` and `bytes`, a predicate's `requires`, a
    parameter's `type`, `Schemas.structure`, `Schemas.Evaluate` and `Schemas.equivalent` are removed, with their
    relations (`Applying`, `HasArgument`, `Binding`, `ArgumentTerm`, `Operands`, `Requires`, `BitWidth`,
    `ByteWidth`);
  - the abstract bases `Schemas.Schema`, `Type` and `Typed` go: each kind declares its own `name`, `description`,
    `parameters` and the adjacencies of every relation it is at an end of (Store overhaul, Decided, 10);
  - a property an extension adds to a schema holds a container where its type is one (BLD-06), as a term's
    `attributes` did.
- **Schema builders align with their meta-schemas** (2026-10-14), as the user decided. FRAMEWORK.md requires "To make
  schemas fully serializable, `Schemas.OfX.Builder` must implement `Visitors.OfX`", which the schema builders do not:
  their fluent clauses are a second API beside the meta-schemas, and 15 of them collide with the members the
  meta-schemas name. The user: "If the meta-schema does not align with visitor and proxy builder, the framework is
  broken"; "Visitor protocols should only name members `as_*`", and `as_*` names are refused as property and link
  names (V1). This comes next, before the dependents (META_SCHEMAS.md, Plan), since mbse-expressions "cannot be
  written correctly without it". How each collision is resolved is to be proposed for the user's review. The user
  then decided:
  - "Schemas.OfX.{Builder, Data, Schema} are necessarily bespoke"
  - "Schemas.OfX.Builder must implement Visitors.OfX"
  - "Visitors.OfX should support the usage examples in @VISITOR_PATTERN.md as faithfully as possible. This should have
    little to no effect on the `Schemas.OfX.Data` and `Schemas.OfX.Schema`."
  - "Dataclasses do not have to implement Visitors or Readers" (the user's correction of "... Visitors or Builders",
    which they "mistyped"); "the `properties` member of the dataclass can be a list of adjacency entries or whatever
    the underlying storage model is".
  - an object schema's `properties`, which the meta-schema lists as a container while the builder's member is an
    adjacency: "the Data class can store `Schemas.OfObject.Data.properties` any way it wants.
    `Schemas.OfObject.Builder` must be smart enough to wrap that adjacency in an a class that adapts your storage choice
    to the Visitors.OfAdjacency protocol. If that means `Schemas.OfObject.Data.properties` ends up being
    `List[Schemas.HasProperty.EntryData]` so be it".
  - "NO LONGER A GOAL: correct implementation of Schemas.OfX.{Builder, Data, Schema} will be a lot easier and cleaner
    if the bespoke Schemas.OfX.Data classes use members the same way that proxies do to store properties and relation
    adjacencies"
  - the form: "@worktrees/meta-schemas/mbse-schemas/docs/VISITOR_PATTERN.md is the correct form": an adjacency's
    `insert` hands over an entry, whose link to the member is a member (`e.property(...)`).
  - references: "we should use references and desist fudging them, at least at the builder/visitor/meta-schema
    surface"; "we already decided at least one time to make schema objects references. all of them."; "refines is
    100% a relation, at least on the builder/visitor/meta-schema surface"; a width is not an int but a relation to a
    term ("why are 'bits' and 'bytes' taking ints instead of being relations to a term?"; Superseded by Parameters are names only (0.17.0): a scalar
    has no width). A property is not limited to
    scalars: it "has as schema which must be OfAny and that can hold scalars, containers, value objects, or any nesting
    thereof"; what refers to another schema object is a relation.
  - a property's type: `e1.type(lambda adj: adj.insert(lambda e2: e2.schema(Contact)))`; "For Schemas.OfProperty.type
    we can interpret `.schema` as designating its evaluation type. So OfScalar(int) would do": a link to a type takes
    a schema that exists, not a callback that builds one.
  - a relation's links: "`type` *never* needs to be provided on the symbol. that relationship is inferred from
    adjacencies": a link is named, and its type follows from the adjacencies that fill it.
  - an exception to referring by reference: "I think we need to make an exception to the rule that we never refer to a
    schema by its string name. Creating objects for symbols is making me nuts." An adjacency's `me` names the link
    it fills, and a relation's `uniques` name its links and properties, as in the user's example (`.me("knower")`,
    `.uniques("since")`).
  - [Serialization](SERIALIZATION.md), the user's (2026-10-15), supersedes any conflicting policy here: "the contents of
    this new doc should supersede any conflicting policy", including the two entries below and the section
    Serialization; it is kept apart from this document for now ("Let's not merge it into FRAMEWORK.md just yet").
  - the initial snapshot ([Serialization](SERIALIZATION.md), step 2), as the user decided (2026-10-15), on defaults
    the user was offered:
    1. "approved": a `Schemas.Module` is a reference object whose identity is its dotted path (`crm.sales`); a module
       defines the modules within it through `Defines`, as it defines schemas (`Schemas.Module` refines
       `Schemas.Schema`), with no relation of its own for nesting;
    2. "approved": a `Defines` entry's name is the last part of the path (`Person` in `crm`); the schema keeps its name;
    3. to 5., on schemas without a prefix, modules made automatically, and the identity of an unnamed schema object no
       other owns: "create a modular organization such that al schemas are contained in some module". As built: a
       schema's dotted name places it in the modules its path names, nested, made as schemas are; a schema without a
       prefix is in the store's root module; an unnamed schema object (an inline type, a term) is in the module of
       the object that first links it, its identity derived from that link (`crm.Person.tags#type`);
    6. "agreed": the framework's schemas (the meta-schemas, the basic scalars, the mutation schemas), which every store
       holds, are never written, only referred to; any other schema the store does not hold is a fatal error;
    7. "agreed": a log is read back by applying each mutation through the store's builders, `Exists` creating only a new
       identity, payloads read by their target's schema;
    8. "agreed": the old module writer and reader stay until this step replaces them; the corpora switch to logs at its
       end, compared across the languages.
  - serialization policy, revised (2026-10-15), as the user decided, superseding the snapshot form in Serialization
    (`{"root", "objects"}`, every reference object keyed and referred to by `$ref`) and settling how objects the
    builders rebuild on read are written:
    - "ToPlain does the work"
    - "all objects may be written nested whether value or reference"
    - "reference objects are only written in 'defnition form' the first time they are encountered. subsequent
      encounters are written in 'reference form' as identity"
    - "for a snapshot, ToPlain writes modules with schemas nested, then named singletons, then objects reachable via
      pattern identity, then the remaining reference objects"
  - the wire format of schemas, written and read through the meta-schemas (docs/proposals/schema-builders/WIRE.md
    holds the questions and their options), as the user decided (2026-10-15):
    1. an unnamed schema object's identity is derived from its owner and its name (`crm.Person.age`), given on
       creation, and changes when it is renamed;
    2. "strictly forbidden", which the user corrected: "A reference object no store built is strictly forbidden. Values
       can be built anywhere anytime." (an earlier reading here, "every type is built in the store", was wrong);
       asked whether a scalar schema (`S.OfScalar.Data(int)`) counts as a value, built anywhere, or as a reference object
       like every other schema object, the user chose the latter: a scalar schema is built in a store;
       and, asked whether every store should hold the basic scalars (`bool`, `int`, `float`, `str`, `bytes`) as named
       schemas from the start, as it holds the meta-schemas, so that programs link them and logs refer to them by name,
       never foreign: "yes", named "Schemas.OfBool, Schemas.OfInt, ... no need to invent an alternate convention"
       (`Schemas.OfBool`, `Schemas.OfInt`, `Schemas.OfFloat`, `Schemas.OfStr`, `Schemas.OfBytes`, after the basic tokens;
       since 0.18.0 the only scalar schemas, Store overhaul, Decided, 22);
    3. what the builders rebuild on every read (an int width read as a literal form, an application's arguments,
       shared forms): "I think this is only value objects so (c)": written nested, as values;
    4. the declaration order of a schema object's members: a position property on their entries;
    5. modules in the old format are no longer read;
    6. "dotted paths indicate module nesting": `crm.sales.Order` is `Order` in module `sales` in module `crm`;
    7. and 8. a module's references to schemas it does not hold, and data's references to the meta-schemas: "schema
       handshake should be an explicit on any store connection, as a preparatory step for migrations".
  - building in a store: "no reference object can ever be built outside of a store!", schema objects included; a
    module is an object in a store, "alongside schemas and data". "This is the new canonical form for store-centric
    building: `store.moduleName.[...moduleName].schemaName(cb: Specs.Callback[Visitors.OfX])`".
  - shortcuts are refused: a member's write has no side effect besides it, and none of the meta-schemas' references
    are left as names or values.
  - proposed in building, for the user's review: docs/proposals/schema-builders/ (the meta-schemas as reference objects
    and relations, and the builders over them).
  - "Schemas.OfObject.Builder is a Visitors.OfObject which has a member for each data property or adjacency and methods
    `as_*` as required by Visitors.OfObject"; e.g. "Schemas.OfObject.Data.name : str", "Schemas.OfObject.Builder.name(name:
    str) # sets property .name", and "Schemas.OfObject.Builder.properties(cb: Specs.Callback[Visitors.OfAdjacency])":
    a schema's properties are an adjacency, its members objects linked to it, which answers META_SCHEMAS.md's phase 5
    question 2 (members as reference objects, not value objects keyed by name). A member that is neither a data
    property nor an adjacency is not a builder's.
  - which member lists are adjacencies and which containers (a container holds values by index; an adjacency is a
    relation's entries linking reference objects): proposed in building, an adjacency where the elements are members
    with identity, an object's `properties` (as decided) and `adjacencies` (anonymous ones included), every kind's
    `parameters`, a union's `branches`, an intersection's `parts`, a predicate's `symbols`, a relation entry's `links`
    and `properties`; a container where they are values, a relation's `uniques` and an `OfAny`'s `types`. The user:
    "apply arguments is probably an adjacency because expression terms are ref objects".

- **Refinement, identities and relations** (2026-10-14), as the user decided, for mbse-expressions' framework and
  dialects as model (mbse-basis P-018):
  - refinement: the user is "open to adding Schemas.Refines as a relation all its own"; "Refinement across the scalar
    vs. container vs. object boundary fails validation"; an "instance of a refinement is an instance of what it
    refines"; "narrowing allowed if it can be statically confirmed by validation". A one-part intersection, which the
    user called "trivial refinement", is what `Refines` states. Built as a builder clause, `.refines(schema)`, on
    scalar, object and container schemas (SCH-24), until schemas are linked objects (phase 5) and it becomes a relation
    of its own:
    - an object refinement has the refined schema's properties and adjacencies, named and anonymous, before its own,
      and follows later changes to them; it may redeclare one narrower, a property with a type that refines the
      inherited one (or a scalar of the same token within its widths, or a container whose index and element each
      narrow), an adjacency only with the same relation and link. It is a reference object schema exactly where what
      it refines is one. Its objects fill the refined schema's links, and the refined schema's extent holds them.
    - a scalar refinement has the refined token and widths within the refined ones; a container refinement, an index
      and an element that each narrow the refined ones. (Superseded since 0.18.0 for scalars: only objects and
      containers refine; Store overhaul, Decided, 22.)
    - validation refuses a refinement of another kind, of itself, and what it cannot confirm narrows ("cannot be
      confirmed"). Modules write `refines` and a refinement's own members only.
    - proposed in building, for the user's review: refinement of unions, intersections, values of any type and
      applications is refused for now, as a refinement of another kind would be.
  - identity: "change policy to allow an object's identity to be read + written by `as_identity`. Builder will
    allocate only if it's not set in the pre-existing object or by the fluent clauses". This supersedes, in part,
    "Reference identity" (below): a program may now set an identity, such as an operator's global ID
    (`Basic.Operators.Add`). Built (STO-08): a builder's `as_identity(identity)` writes it, and `as_identity()` reads
    the one written, else the source's; `create()` and `clone()` give one only where none is written, and `update()`
    renames the object. An identity no other live object of its schema has, which its naming pattern gives where it
    has one; a singleton's is its global name; data instances and value objects refuse a write. (Superseded for data
    since 0.20.0: a program writes no identity, and data has no `as_identity`; Object identity, Decided, 43. Schema
    objects keep theirs until step 4g of the store overhaul.)
  - domains: "domains refine scalar schemas" (mbse-expressions' value domains). (Superseded: a domain is
    mbse-expressions' object, associated with a basic scalar, which has none of its own; Store overhaul, Decided, 9.)
  - relations: "mbse-schemas.Schemas.OfRelation is by default a all-directional link. Anonymous adjacencies allow for
    some adjacencies to be omitted." An entry "may be rejected if the linked object is of the wrong type. That's
    exactly why we have anonymous adjacencies at all. They still participate in type checking even though they omit
    access from the adjacent object to the relation." Built: an adjacency declared with no name
    (`r.of(Owns).me("item")`) is anonymous; the object may fill the link, and has no member and holds nothing for it.
    Validation accepts a linked object whose schema declares the link, named or anonymous (VAL-15), and modules write
    an anonymous adjacency with no name. Their absence was a bug: an object could fill a link only through a named
    adjacency, a member it may not need.

- **Containers** (planned: [Meta-schemas overhaul](META_SCHEMAS.md), V5), as the user decided, superseding in part
  The meta-schemas overhaul ("Relations completely subsume collections ... subsumes OfIndexed and requires 1-ary
  relations", and the one-link relations and lists that followed from it): the user, "very close to deciding to
  re-bifurcate OfRelation and OfContainer (formerly OfIndexed)", wrote in [Visitor pattern](VISITOR_PATTERN.md),
  Containers, and answered:
  - "Schemas.OfContainer is one of the variants under Schemas.OfAny and has an element type and an index type both of
    which are Schemas.OfAny"; "OfRelation must have at least two links and can have any number of properties"; the
    "metaschema for both is nearly identical";
  - "OfContainer with a total order on its index schema becomes an array/list in the target language", "or else
    OfContainer with a hashable index schema becomes an dict/map the target language", "or else OfContainer becomes
    of entries in the target language"; for a dict, "yes the value is the element";
  - "Schemas.OfContainer should allow '.dense()' or '.sparse()' only one of which may be configured. Dense stores
    entries in a packed array, sparse is an associative store of dense blocks/sectors"; "dense and sparse are a
    container schema prop, not a type schema prop"; with neither, a container is dense for an integer-like index (an
    int, or a value object of ints) and a dict for any other hashable one: "dense default for integer-like only: yes",
    correcting the first answer ("yes, sensible default"), under which every container by text would have been an
    array; `.dense()` and `.sparse()` take any index with a total order;
  - "multiple int indices for tensor data is critical", while the user is "less interested in string indices";
  - "a container entry is latent. probably will not have its own class. A Visitors.OfIterator - that will be
    necessary, but reached from Visitors.OfContainer not Visitors.OfAdjacency";
  - "unique is only for relations, not containers"; relations keep "insertion order";
  - a container's wire form "follows dense/sparse": a dense one written as an array of its elements, a sparse one as
    its blocks, each a start index and its run of elements ("yes. adjacent blocks may merge but are not required to do
    so"); a dict whose index is not a string, which a JSON object cannot key, "degrades to a map of entry-like
    elements", each pairing an index with its element; a dense container of several int indices is written nested
    or flat with its shape, "runtime configurable on the writer, and the loader should detect and adapt sensibly";
  - "containers are allowed to nest" ("yes nesting of containers is okay"), a container's element or a value object
    it holds being a container in turn; "containers with different index types are incomparable";
  - `Visitors.OfContainer` holds the ordered accessors drafted under `Visitors.OfAdjacency` (`as_ordered`, positions,
    `as_item`, `prepend`, `append`): "correct";
  - reloading a snapshot rewrites a container property as any property, element by element in order, extending it
    past its end, and relations keep matching their entries by value ("exactly", Reference identity, on update);
  - built as one unit with the new adjacency API (`as_iterable`, `insert`, `remove`) and the removal of `select`,
    since the ordered API needs containers and `select` its replacement.

  Choices made in building it, for the user's review:
  - a dense container of int indices holds every index from 0 to its last, an element absent at some (`null` on the
    wire), its length the positions; one of several ints, every cell of the box its indices span; one by another
    ordered index (text), its elements present, sorted, written as entry-like elements;
  - on the wire: a sparse block is `{"at": index, "items": [...]}`, an entry-like element `{"index": ..., "element":
    ...}`, a flat tensor `{"shape": [...], "items": [...]}`; the writer's option is `ToPlain(store, flat=True)` (and
    JSON's and YAML's); a value object index is written as its mapping;
  - an index is given as a scalar, or for a value object index as a tuple (an array in TypeScript) of its properties in
    declaration order; an element is read and written through its `Visitors.OfAny`, and `as_container(cb)` on a builder
    writes the container at once, as `as_object(cb)` does a value object, so an empty container round-trips;
  - an iterator inserts (`prepend`, `append`, and `as_item` past an end) only into a dense or sparse container of int
    indices, moving the elements after the insertion up by one;
  - comparison (`Comparison.OfContainer`, and containers held as values): containers whose element types differ are
    incomparable too, as their index types' are; others are equal when they hold equal elements at the same indices,
    in any order (a dict's insertion order is not compared), and otherwise incomparable, never ordered; uniqueness
    compares containers the same way. Validation checks each element present under the element schema, reported at
    its index, `card.tags[2]`, `card.grid[[0, 1]]`, `card.phones['home'].number`;
  - the dataclasses adapter: `list[N]` holds a container by an int index, dense, and `dict[K, N]` one by `K`, sparse
    where `K` is `int`, so a dict's keys are not padded into positions; a container by any other scalar index is
    written back as a `dict`, and one by a value object index (a tensor) has no field type;
  - a relation has two links or more: `validate()` refuses fewer ("a relation has two links or more, got 1; a list of
    values is a container"), the check in `OfEntry.validate()`; and, since entries never link value objects, a value
    object schema has no adjacencies ("a value object schema has no adjacencies: entries never link value objects,
    which are never shared"), which makes the check that an entry's value object has none redundant, so it went;
  - the meta-schemas' member lists are properties holding containers by position of value objects with the fields the
    entries held, so a module's wire form for them is unchanged; a module's `schemas` are a container by name whose
    elements are the definitions, written as a mapping in the order the schemas were given (no longer sorted), and
    `Modules.module` refuses two schemas of one name; modules now compare by the schemas they hold;
  - the Lists suite (LST) is removed, its cases covered by CNT or gone with one-link relations; the conformance
    corpus's `lists` case keeps its name and holds containers instead;
  - not yet: reading a container whose index is neither ordered nor hashable from a snapshot (its index would have to
    be built as a standalone value object).

- **`OfAny` returns** (after Containers), as the user decided: "Now that we have re-introduced containers, OfAny
  seems to have purpose again", choosing, of the options put to them, "3": keep `Visitors.OfAny`, `Schemas.OfAny.Builder`
  and `Schemas.OfAny.Spec`, and `Schemas.OfAny.Data`, and add `OfAny` as a kind, a value of any type, so that a
  container may hold values of mixed kinds. This amends The meta-schemas overhaul's "`Schemas.OfAny` ... go[es]": only
  the meta-schema `Schemas.OfAny.Schema` (a type written inline or `named`) goes, when types become links in phase 5.
  - `Visitors.OfAny` visits a value of any kind: a property's value (`as_value`), and a container's every element
    (`at(i)`);
  - `Schemas.OfAny.Builder` builds a type of any kind inline (`t.as_scalar(str)`, `t.as_container(...)`), and
    `Schemas.OfAny.Spec` is what `of(...)`, `.index(...)` and `.element(...)` take;
  - the new kind is a distinct marker kind, `Schemas.OfAny.Value`, and `Schemas.OfAny.Data` stays the union of the
    kinds' data (the user: "yes" to "a distinct marker kind (say `Schemas.OfAny.Value`) ... and leave `OfAny.Data` as
    the union"); there is no `as_any`, the user asking "why would `as_any` live on `Schemas.OfAny.Builder`?" and
    correcting the two signatures: "`Schemas.OfAny.Builder.as_scalar(int|float|str|...) -> Schemas.OfAny.Builder`"
    and "`Visitors.OfAny.as_scalar(spec: Specs.Callback[Visitors.OfScalar]) -> Visitors.OfAny`";
  - proposed in building, for the user's review: `Schemas.OfAny.Builder`'s own `as_<kind>` calls restrict it, each
    adding a subschema: none selected is an unrestricted `OfAny` (`lambda t: t`), one is that kind's data, as before
    (the common case), and several an `OfAny` restricted to them (`t.as_scalar(int).as_scalar(str).as_object(Phone)`);
  - on the wire a value of any type is tagged by its kind and type, as `Schemas.Form.Value` tags a scalar
    (`{"int": 3}`), except where the schema narrows it: "there are some situations in which the type of OfAny can be
    inferred from its schema, in which case wrapping the value over the wire is just wasted characters", the
    situation being, of those put to the user, "(b)": an `OfAny` may be restricted to a set of types
    (`t.as_scalar(int).as_scalar(str).as_object(Phone)`), and a value is written bare where only one of those types
    fits its plain form, tagged otherwise (*superseded*: wrapped by its kind and schema, Resolved, "A restricted
    `OfAny` never guesses its schema");
  - "a value object of any [type] must be a registered schema", so that its name can be written and read back;
  - values of any type compare and validate under the kind and type they hold: equal only under the same kind and
    type, otherwise incomparable, as Equality has values of different kinds; validation checks each value against
    the kind it says it is ("yes");
  - an unrestricted `OfAny` always tags, since every type is possible ("yes");
  - a restricted one is invalid where two of its types share a plain form that cannot be told apart, as a flat union
    is where its branches are not told apart by type ("yes"; *superseded*: valid, the wrapper tells them apart,
    Resolved, "A restricted `OfAny` never guesses its schema");
  - a value of a type outside the restriction is refused when written and when read ("yes - but for open-world, which
    we are not yet undertaking, this would require different handling");
  - a value object is tagged by its schema's registered name, `{"crm.Phone": {...}}`, as a scalar is by its token's
    name (since 0.18.0, its basic scalar's tag), but "only when the value object's schema is not clear from the parent schema": where the restriction leaves
    one object schema the value can be, it is written bare (*superseded*: bare where that schema is the only one
    taking a mapping, Resolved, "A restricted `OfAny` never guesses its schema").
  - "The common case is that a schema path through OfAny will already be configured with a subschema before any
    objects are created with that schema": a restricted `OfAny`, whose values are written bare (where unambiguous,
    since 0.26.3) and built through the visitors as any value of their type is, with nothing added to them. "The idea of assigning a value to OfAny where
    that schema has not yet been restricted has secondary value as a step towards open-world, which we are not fully
    undertaking at this time"; it "does require tagging over the wire and extra arguments or fluent clauses along the
    way. But be careful not to clutter the api supporting this secondary scenario": an unrestricted `OfAny` takes a
    scalar, or a value given as itself (a value object, union value, intersection value or container, which carries
    its schema, copied), and refuses a Spec, which has no schema to build by; no visitor gains a method or argument;
  - "`Visitors.OfX.as_any` - no visitor should have this method"; nor has the schema builder one (above).
  - proposed in building, for the user's review: where a value of any type is held, a Spec of another kind than the
    value held is handed an empty visitor, so that it neither replaces the value nor fails a read; with nothing held,
    a restricted `OfAny` builds the one type of that kind it allows, and an unrestricted one hands a Spec an empty
    visitor that refuses writes ("... give a value, which carries its schema, not a Spec"); a restricted value's type
    is checked when written to a snapshot (a scalar's, which builders do not check) and on assignment (a value's); a
    standalone value is adopted by the first object it is assigned to and copied by every later one; and
    `Proxies.OfObject.Builder` given a value object schema directly refuses it ("build a value through its owner, or
    standalone through the store").
  - a value of any type is built where its schema is known, and assigned as a value: `store.builder(name)` (and
    `store.<Name>()`) builds a standalone value of a registered value object, union, intersection or container schema,
    whose `create()` gives a value, copied when assigned, in place of refusing ("a value object is built through its
    owner"); the user: "yes" to relaxing that refusal rather than adding a method or an argument. Decoding writes an
    unrestricted `OfAny`'s tagged value the same way.
  - proposed in building, for the user's review, so that mbse-expressions' terms (value objects, as the user decided
    there, "2 = Y") can be written and read on their own: `ToPlain(store)(schema, value)` and
    `FromPlain(store)(schema, plain)` take a standalone value of a value object, union, intersection, container or
    `OfAny` schema, `ToPlain(store).Value` and `FromPlain(store).Value` being the per-kind forms. The value is written
    nested, as a property holding it writes it (`{"number": "+44"}`; tagged, `{"Phone": {...}}`, only where an
    unrestricted `OfAny` holds it), and read back through the store's builder of its schema, which the store
    registers. A reference object schema still takes a snapshot, and `.OfObject` still refuses a value object schema.

- **Reference identity** ([Visitor pattern](VISITOR_PATTERN.md), "Reference Identity", as the user wrote it), refining
  The visitor pattern's "global name, otherwise a UUID" (superseded since 0.20.0 by [Object identity](OBJECT_IDENTITY.md),
  Decided, 1 to 36: an identity is the object's path, read off its ownership; there are no UUIDs, an object its schema
  owns being keyed by its local name and a number where it has no naming pattern; `by_identity` gives way to lookup by
  keys; a snapshot lists each object with its path and its schema's name, and a reference is its path alone; and in
  turn since 0.20.0 by its Decided, 37 to 55: an object is a singleton, owned, or counted, a counted object having no
  identity beyond the document that numbers it; `Schemas.HasInstance`, naming patterns on object schemas, the
  local-name-and-number keys, `as_identity` and `Stores.Store.restore` are gone):
  - a reference object with a global name (`.singleton("foo")`) uses it on the wire; a reference object schema may
    instead give a naming pattern to `.ref()` (`.ref(r'FEA-(\d+\d\d)')`, the number "extend[ing] on the left"); one
    declared with `.ref()` alone has a UUID given by `.create()` or `.clone()`; on the wire every identity is
    "qualified with the schema's registered name and module name", a qualification "only appropriate for over the
    wire"; `validate()` refuses a schema with both a global name and a naming pattern;
  - "The choice of formatted name and registration with the implied directory must happen automatically anytime a
    named reference object is created or copied" ("No user serviceable parts inside"): "there is one directory store
    per schema", "one directory per schema within each store"; "allocated IDs are strictly increasing (even in the
    presence of yet to be designed deletions)", so loading a snapshot advances a schema's counter past every ID it
    reads ("yes");
  - programs read an identity through `Visitors.OfObject.as_identity` and find an object by `Stores.by_identity`
    (its arguments below); they "cannot set or modify their identity", so decoding is the one writer of a loaded
    object's identity, and "on snapshot load, repeated appearance of the same ID is interpreted as update";
  - the qualified form is the schema's registered name, `/`, then the name (`"crm.Feature/FEA-001"`), a global name
    written alone, being unique in a store ("that is fine"); `by_identity` finds every live object of the store, through a
    weak directory, not only its data ("yes, every live object");
  - `as_identity()` and `by_identity` both take the unqualified name, "at the cost of prepending a schema parameter to
    by_identity": `store.by_identity("crm.Feature", "FEA-001")`;
  - in snapshots, identities replace the symbols, as the objects' keys and in `$ref`, and references keep `$schema` ("okay
    to keep $schema for now");
  - a UUID is random, so where output must be reproducible (the conformance corpus, tests of exact text, the tutorials'
    outputs) schemas take naming patterns, whose counters are deterministic, and UUIDs are tested by their shape and
    round trips ("a"), rather than stores drawing UUIDs from a seeded source, which "a random source is given to
    whatever draws from it, not held by a store" rules out;
  - on update, "merging should naturally fall out of the builder pattern. property access should notice that the
    pre-existing object already has that property and return a builder on that property, etc.": decoding writes into
    a live object through its builder, editing a property's value object in place, and what the snapshot omits is
    kept, not cleared. Reloading must not add entries ("reloading them adds entries is not desirable"), and entries
    without a key are matched by "overwriting what is present in the order being co-visited". Until relations were
    split from containers (Containers, above; one-link relations are gone, and a container is rewritten element by
    element), that held for one-link relations, whose entries are their owner's alone and whose order a snapshot
    carries: the i-th row overwrites the i-th entry held, in the order a snapshot writes
    them, and rows past those are added. A relation of two links or more has no order to co-visit, an entry sitting
    in a list at each end, so a row is the entry held that agrees with its links and properties, the k-th equal row
    the k-th such entry, and is added where none agrees ("finish V4 that way"). Builders keep every object's entries
    in their order through an update, so that positions hold;
  - "for value objects as_identity should return None", and so does any visitor without an identity (an empty one, a
    builder of an object not yet created): "it feels like None/null is a better representative of no identity, but I
    don't have a strong opinion", so it was taken.

  Choices made in building it, for the user's review:
  - `Schemas.Module` is a reference object schema with the naming pattern `module-(\d+)`, so that the meta-schemas'
    own snapshots are reproducible; `Modules.module` creates the module, which gives it its identity, then fills it
    from its snapshot;
  - a naming pattern is literal text around one group of digits, `\d+` followed by `\d`s for its minimum width
    (`FEA-(\d+\d\d)`); `validate()` refuses any other ("naming pattern 'X' is not literal text around one group of
    digits"), and a name is matched by that split, ASCII digits only, rather than by a regular expression, whose
    dialects differ between languages; numbers are never given twice in a store, even once their objects are gone;
  - decoders create an object of a snapshot's identity through `Stores.Store.restore(name, identity)`, a builder whose
    `create()` gives that identity; a program's `create()` always gets a new one. Creating an identity that is live
    is refused ("a 'X' with the identity 'Y' is already live; update it"); one whose object is gone may be created
    again;
  - a visitor of nothing (an absent value, another kind, a member the schema lacks) has no schema, `as_schema()` None,
    as it has no identity; presence is tested by `as_schema()`, an identity being absent from every value object;
  - snapshot key errors: "a 'X' is keyed by its identity qualified by its schema's name, e.g. 'X/<name>'", "the
    singleton 'X' is keyed by its global name 'G'", and "'N' is not a name 'X''s naming pattern 'P' gives".

- **The visitor pattern** ([Visitor pattern](VISITOR_PATTERN.md), which holds the protocol as the user designed it), as
  the user decided, finding that the framework had the pattern backwards: "the Visitors interface is supposed to expose
  an api to the caller to access a data structure whose schema the calling code may or may not know in advance";
  "Analysis and transformation algorithms accept a visitor as an argument and use the visitor - and also possibly
  knowledge of the schema at coding/compilation time - to access the values/objects/properties/relations/etc."; the
  serializers' writers "implementing the visitors protocol" are "precisely backwards"; and "`Visitable.accept` is a
  hallucination". So:
  - one protocol per kind, `Visitors.OfX`, reads and writes ("one interface, not one class definition"); builders
    implement it ("Builders implement Visitors - full stop"), and so do data instances: "with these changes I think we
    can declare that data instances also implement Visitors", the changes being named members (`osv.<propName>`,
    `env.<linkName>`) and `Specs.Callback[V] = Visitors.DataType[V] | Callable[[V], V]`, a value or a callable, which
    serves "either as a mutator or a limited value-matching query"; `Visitors.DataType[Visitors.OfAdjacency]` is
    `Iterable[Visitors.OfEntry]`, "with implied 'insert' semantics (not replace)"; an adjacency member reads as a
    "`Visitors.OfAdjacency` that is also iterable"; the scalar dunders (`int`, `float`, `str`, `bool`, `bytes`) are
    sugar over `get`, raise when the value is not set or of another type, and pass through from
    `Visitors.OfProperty` ("bonus points if they can also be called on Visitors.OfProperty directly (pass thru via
    as_scalar)"), TypeScript's `[Symbol.toPrimitive]` going as far as it reaches; unions, intersections and
    predicates take the member style, a branch or a part giving the visitor of its type's kind directly (the
    `Visitors.OfProperty` between being "an implementation detail"; "symmetry with properties isn't particularly
    important"); `Visitors.OfAny` has `clear()`, which `Visitors.OfScalar.clear()` aliases; a link member on a data
    instance is the linked instance itself, data instances being callable so that calling one, a write, raises ("yes"); `as_scalar`, `as_value` and
    `as_adjacencies` gain no attribute form ("no"; "as scalar has no attribute form"), so a
    scalar is read compactly through the property's dunders (`str(card.name)`), and its presence through
    `Visitors.OfProperty.get()`, a pass-through to `as_scalar` (the user chose it, "1", over an `as_scalar` attribute
    form and equality as presence). (Before that, the user had agreed
    that data instances not implement it, correcting "and so do data instances", which I had inferred.) There is no
    separate mutator protocol;
  - code generation generates, for every schema, the analogues of a proxy: "`<schemaName>.Data` - instance form",
    "`<schemaName>.Builder` - mutator form implementing Visitors", "`<schemaName>.Schema` - alias for schema itself";
    so `Bindings`, which bound a program's own classes to schemas through their states, goes ("yes, remove Bindings"),
    and so do `Paths` ("yes, remove Paths"), ahead of V4, and `Reflection` ("yes, remove Reflections"), whose part
    `root_module()` takes in phase 5; `Validators.properties_of` and `entries_of` go, the protocol reading properties
    and entries;
  - "the mutableness of a visited object is a mode of the visitor itself": builders "can be configured to permit or
    forbid writes", a visitor hands its mode to the child visitors it hands over, except a link's target, read-only through an
    entry, an object being edited through its own builder ("the 'children inherit their parent's mode' was overly
    simplified"), and
    "value objects are mutable only during construction or cloning"; writer methods return nothing, and a write the
    mode or the value forbids raises; a read-only static view of each protocol (`Readers.OfX`) types the code that
    must not write; a builder's visitor reads back its pending writes ("must be guaranteed");
  - `Visitors.OfObject` and `Visitors.OfEntry` "may only define methods named `as_Y`", so "no schema-defined property,
    adjacency, or link may be named `as_*`", which `validate()` refuses; every `Visitors.OfX` has `as_schema()`, in
    place of conveniences such as `OfProperty.name` and `OfObject.has`, so `Schemas.OfEntry` (and its meta-schema)
    "must exist"; an object's identity is a scalar, `as_identity`;
  - relations are modified "entirely" through `Visitors.OfAdjacency` (`select`, since replaced by `as_iterable`;
    `insert`, `remove`), whose `remove` removes "all that match"; relation operations are the visitor protocol's, not
    an expression dialect's ("Relation operators do not belong in Expressions.Basic. They never did");
  - anything that has a builder has a `Spec`, "a callable taking and returning that builder", or "an instance of the
    built object" (mbse-basis P-004, amended);
  - `OfScalar` "completely displaces" `OfNative`, in `Schemas` and `Visitors`: a module writes `{"scalar": {"format":
    ..., "token": ...}}` (superseded since 0.18.0: a scalar has no token; Store overhaul, Decided, 22);
  - a reference object is named by its global name if it has one, otherwise by "a UUID on creation by `.create()` or
    `.clone()` that is saved on the wire" (refined by Reference identity: a naming pattern may take the UUID's place;
    superseded since 0.20.0 by Object identity: no UUIDs); "value objects are never shared"; "value objects cannot be referenced by
    entries"; a value object may have adjacencies only to one-link relations, of "zero or more" properties (since
    Containers, above, a value object has none: its lists are containers); "Paths go away";
  - `.ref()` declares a reference object schema, and an object schema without it is a value object schema ("drop the
    `.value()` for now");
  - `Schemas.OfPredicate` (superseded since 0.21.0 by `Schemas.OfPattern`; Resolved, Patterns), after mbse-patterns'
    predicate: its symbols, its parameters and its constraint as a
    `Schemas.Form`, mbse-schemas knowing no dialect; finding matches and `Patterns.Stores.update`, which returns a
    certificate ("a compact record ... that can be used to track the effect of the write in a lazy distributed
    system"), are mbse-patterns'.
  - `Schemas.OfEntry` is an element the relation holds, carrying the entries' links and properties (the user agreed to
    that description), and it follows the pattern of every element: "`Schemas.OfEntry.Builder` is responsible fo[r]
    building `Schemas.OfEntry.Data`", with a `Spec`, and `Schemas.OfRelation.Data.entry` holds what it builds, as
    `Schemas.OfObject.Data.adjacencies` holds what `Schemas.OfAdjacency.Builder` builds (the user, on an entry built
    on each read instead: "no idea why you would hallucinate something rather than follow the pattern"). Its links
    and properties are by name, in declaration order. "It's okay for the `links` and `properties` adjacencies to stay
    where they are": a relation's module form keeps its `links` and `properties` lists, and the relation's builder
    its `.links(...)` and `.properties(...)`, which declare the entry schema.
  - a predicate's symbols and an entry's links are both `Schemas.OfSymbol`s, after the user's "maybe
    `HasSymbols(Schemas.OfPredicate, Schemas.OfSymbol)` and `HasLinks(Schemas.OfEntry, Schemas.OfSymbol)`" (phase 5's
    meta-relations; until then, lists): a symbol is a name with an optional reference object schema, which a
    predicate's symbols require and an entry's links may leave unset;
  - a predicate's `requires` is one `Schemas.Form` ("one form"; Superseded by Parameters are names only (0.17.0): `requires` is mbse-patterns').
  - a member is written by calling it, never by assignment: "refuse all direct writes to properties and adjacencies"
    on a builder, as on a data instance, so that assigning to any visitor's member raises `AttributeError` in both
    languages rather than being silently lost (mbse-basis P-002);
  - scalar equality stays idiomatic, the user's concern being "the loss of language-idiomatic equality between scalars
    including strings", and their decision the recommendation they accepted ("I accept your recommendation"): in Python
    a scalar visitor compares, orders and hashes as its value (`card.name == "Ada"`, `card.age < 40`), sugar over
    `get()` as the dunders are, a value of another kind comparing by its identity, a read-only visitor hashable and a
    writable one not; TypeScript, where `===` cannot be overloaded, compares a scalar once read
    (`card.name.get() === "Ada"`), `==` converting but not being the idiom; data instances' scalar members stay
    visitors in both languages, not primitives;
  - the protocol is VISITOR_PATTERN.md's, as the user streamlined it; the user decided its gaps so:
    `Proxies.OfX.Data` and `Proxies.OfX.Builder` implement it; the old protocol is removed before the new one is built,
    "no side by side period", since keeping both could make the new surface act like the old; the spec is "intentionally
    exception free", so reads never raise, and the one raise is a write that the visitor's mode or the value forbids;
    and every callback is always called ("If they don't always call the callback, there is no way to set the value"),
    the visitor it is given reporting an absent value, or a value of another kind, as empty.

  It supersedes: mbse-basis P-004 as it stood (amended); here, "Objects outside snapshots are named by paths (0.8.2)",
  The meta-schemas overhaul's "we can keep paths", and decision C in mbse-expressions; and, in the sections above, what
  the reverse protocol built (`accept`, `Plain`'s writers and `Validators`' and `Comparison`'s recorders implementing
  `Visitors`, `Bindings.accept`, `Reflection`'s `accept`), value objects that links target, and `Paths`. It is built:
  links that target only reference objects, and value objects' adjacencies to one-link relations only (since gone:
  Containers, above), in META_SCHEMAS.md's V1, and the protocol itself, with `Bindings`, `Paths` and `Reflection` removed, in V2 and V3.

- **The meta-schemas overhaul** ([Meta-schemas overhaul](META_SCHEMAS.md), which plans it; its collections superseded
  by Containers, above), as the user decided: of
  what the 8 to 11 Oct exploration (the `scalars` branch) learned, "definitely re-apply ASAP": "Dictionary of
  registered schemas lives as a relation on OfModule (possibly nestably)", "Meta-schemas use relations instead of
  hallucinated containers", and "Relations completely subsume collections : Adaptive storage for relation adjacencies
  as list, set, dict, etc. subsumes OfIndexed and requires 1-ary relations". The decisions the exploration recorded for
  these, as the user made them there, and those made since:
  - a relation may have one link, its entries holding values for their one owner, as the user decided ("eliminating
    OfIndexed necessitates (a)"): a list of plain values is a one-link relation whose entries hold a value, which no
    second object stands for;
  - "whether it is a set or a list depends entirely on the use of `unique`. Absent unique, it's an open relation": a
    relation with a `unique` clause holds a set of entries (an entry equal to one held is one entry), keyed from an
    end as `OfRelation.Data.key` gives; a relation without one is open, and from each end its entries are a list, in
    the order added, equal entries kept, its index their position ("index is implied"), stored nowhere. `.unique()`,
    naming nothing, makes a relation a set;
  - a list is declared inline in its adjacency ("you can use lambda builder shorthand within the adjacency so the
    relation doesn't need a separate decl"): `r.name("tags").me("owner").of(lambda rel:
    rel.links("owner").properties(text("value")))`. Code generators name such a relation where they need one;
  - "relation entries may be written on every named adjacency. If for any reason entries appear for the same relation
    on multiple lists, deserialization must dedup the entries according to `unique` if present or value if not": in a
    relation with a `unique` clause, entries equal by value are one; in an open relation, the k-th entry equal to a
    given one in one list is the k-th in another, so equal entries the lists repeat are not merged;
  - "make the adjacency handle it": iterating an adjacency gives its entries, and "adjacency offers projections for
    links and values", as amended: projection is a method, `project(name)` ("perhaps projection should be a method
    `.project(name)` rather than an attribute of the adjacency"), and lookup by key is `at(key)` (a `KeyError` for
    none), so no link or property name collides with anything; the adjacency member stays a tuple (a frozen array) of
    its entries, indexed by position, as "Adjacencies, as specified" (below) requires. An adjacency's key is the
    complement of the first `unique(S)` clause, in declaration order, whose complement holds the owner's link, less
    that link; with no such clause, or an empty key, there is no `at`;
  - `Paths` reads `unique(S)` backwards (`S` as the key), which the user confirmed is wrong; it reads keys as
    adjacencies do, and paths keep naming objects for transforms ("we can keep paths");
  - an adjacency's entries are written as an array of entries, sorted by their key where a `unique` clause gives one
    and its values are ordered, and in the order added otherwise; there are no compact forms (`["a", "b"]`, `{"k": v}`);
  - in codegen, "a relation whose properties boil down to a tuple of integer-like-things should be automatically
    promoted to an indexable. Similar cases may be inferred if unambiguous for map, dict, etc."; a promoted indexable
    iterates over entries, "to keep it simple";
  - "a value object held by an entry cannot have adjacencies" "should go": a one-link relation's entry is written once,
    with its owner, so a value object it holds is written once too, and may have adjacencies of its own;
  - extents go "completely away in favor of shape constraints", which the user confirmed for this overhaul ("agreed"):
    a bound on an index, a capacity or a tensor's shape is a constraint on the type of the property that keys the
    entries, not part of the schema; a parameter bound into such a constraint gives a tensor's shape (Parametrics);
  - the schema model's own lists need only a consistent order ("declaration order or key sorted order, as long as it's
    consistent"), and the user chose declaration order: a schema's member lists (parameters, properties, links,
    branches, parts, adjacencies, uniques, applications' arguments, and a form's attributes and arguments) are open
    relations, in declaration order, so that a schema read back equals the one built; only a module's schemas are
    keyed by name and sorted by it; reading refuses a member name listed twice;
  - `OfApply` binds by name only ("OfApply - bind by name only"), kept in this overhaul ("yes"): positional arguments
    go, `.arguments` takes them by name (Superseded by Parameters are names only (0.17.0): `OfApply` is mbse-expressions');
  - every schema is a reference object of its kind's meta-schema, and every reference to a schema is a link, through
    meta-relations (`Properties`, `Adjacencies`, `Applies`, `Parameters`, `Typing`, `Defines`, and a union's branches
    and an intersection's parts while those kinds remain); `Schemas.Module.Entry`, `Schemas.Module.Definition`,
    `Schemas.OfAny` (amended: its meta-schema only, `OfAny` returns, below), `Modules.reference` and `resolve`, and
    `Stores.META` go;
  - a link builds its target with a schema given as itself, `.<link>.of(schema, spec)`, never by name or inferred
    (the exploration's "builder notation for ambiguously typed link targets", which the meta-schemas need: a
    property's type is a link that schemas of several kinds may fill);
  - "any relation, even a meta-relation, is stored as adjacencies which can be added later"; the ends at which a
    schema is referred to are anonymous adjacencies (TODO.md, "Anonymous adjacencies": "it denotes the relation has no
    storage on the object. It merely denotes that this object may participate in a particular link `me` of the
    designated relation"), built in this overhaul for any relation, as the user agreed ("yes");
  - a module is an `OfModule` that defines schemas by `Defines(module, name, schema)`, and may define modules, so that
    modules nest; a schema defined through nested modules is named with their names "qualified with dots", as the user
    decided. A module is written as an object snapshot of the schemas it defines and the unnamed schemas they reach.
    "`Schemas.OfStore.root_module()` returns an instance of hierarchical `Schemas.OfModule` which registers schemas by
    module-qualified name" ("yes, add root_module");
  - Basic's operations on lists change with it, as the user decided: mbse-expressions' EXPRESSIONS.md, Resolved,
    "Basic's collection operations go now".

  What follows from these, as built (phase 4, `OfIndexed` removed): `Schemas.OfIndexed`, its meta-schema
  (`Schemas.Indexed`) and its extents; `Visitors.OfIndexed`, `OfItem` and `as_indexed`; `Proxies.OfIndexed.Map`;
  `Validators.ListRecord`; the keyed wire forms, and with them `OfScalar.Data.to_key` and `from_key`; and, since
  extents were all that validation evaluated, `Validators.Check` and `Validate` take no evaluator and `Validators.Scope`
  goes, while `Schemas.equivalent` keeps one. `Outcome.unknowns` stays, empty until something undecidable is checked
  again (a shape constraint, open-world data).

  It excludes what that exploration built for the open-world and scalars overhaul, which is deferred: undeclared
  properties preserved and plain numbers, `OfName`, `Specializes`, and the removal of `OfUnion`, `OfIntersection` and
  `OfScalar`. Nothing of it is built.

- **A `python3` token names a basic type** (0.10), as the user decided: a `python3` token that is not a basic type's
  name should not be configurable in `OfScalar`. Validation reports one ("python3 has no type 'decimal.Decimal'"), as
  it does an unknown `basic` name, in both implementations. Code generators then never meet a Python scalar they
  cannot hold. (Superseded since 0.18.0: a scalar has no token; [Store overhaul, Decided, 22](proposals/store-overhaul/README.md#decided-here).)

- **Adjacencies, as specified:** "adjacencies are always stored in a class under the name of the adjacency and must
  store an Iterable over full relation entries, such as `Proxies.OfEntry.Data` or generated equivalent." So: the one
  member, named after the adjacency, in every implementation, proxies and every mbse-codegen-* alike; it holds an
  Iterable (a tuple, a frozen array, or any other: the type is not part of the contract); each item is a full entry,
  every link the owner's own included, and its properties, an object of `Proxies.OfEntry.Data` or of the generated
  entry class. Only the wire form leaves out the link the adjacency implies (0.8.3, 0.9.1).

- Unions and intersections may be flat (0.9), configured on the schema so that proxies and generated bindings agree:
  a flat union reads as its branch's value, told apart by type, as Python's `A | B` or TypeScript's `A | B` would hold
  it, and a flat intersection's parts' properties as its own. The wire form stays per branch and per part, so decoding
  needs no inference.

- A property that is not set reads as `None` (0.8.4), not an error, on proxies, value objects and entries, so that code
  reads proxies and generated classes alike: no property holds `None` as a value, so `None` means absent, and absent
  properties are still left out of what is written. Reading a name the schema does not declare still raises.

- Adjacencies are members (0.8.3): a proxy reads an adjacency as the entries it holds, and an entry's links and
  properties as attributes, as generated classes will, so that code reads either without change.

- Objects outside snapshots are named by paths (0.8.2): `Paths.of(store)`, from the store's named roots by route,
  keyed by unique properties where a relation declares them. Snapshots keep their symbols. (Superseded by The visitor
  pattern: `Paths` is removed.)
- Nothing is mandatory except as specified by a constraint: properties are optional by default, and mandatory
  participation in a relation is expressed as a constraint (directory membership is required by well-formedness).
- `OfValue` is not a base class; renamed `OfAny`.
- Parameters (0.7): every kind of schema declares `OfParameter`s, `OfApply` applies a parametric schema to arguments,
  and a term (a `Schemas.Form`, or a dialect's term) may stand where a width does (and where an extent's bound did,
  until extents went with `OfIndexed`). A parameter is a
  variable whose binder is the schema; data of an application is data of its applied schema (`Schemas.structure`). See
  Parametrics, which also lists what is not built yet. (Superseded by Parameters are names only (0.17.0): a parameter is a name, and applications,
  terms and widths are mbse-expressions'.)
- Stores of different implementations combine, by name (0.7.3): `Stores.Combined(*stores)`, each name its one store's,
  the singletons all of theirs and the extents what they all reach. A store itself still has one implementation.
- Reflection (0.8): a schema is a reference object of its kind's meta-schema, the module form's, and writes its module
  form with its name; `Reflection.of(store)` holds the schemas a store registers and those they refer to. It replaces
  0.7.2's catalog and the elements bound as objects of their own, linked by relations: a predicate selects schemas
  itself, reading and comparing what is within them as values, and a store's named schemas are its roots, so nothing
  lists them again. A scalar's token is written `token`, so that `name` is a schema's name in every kind. (Superseded
  by The visitor pattern: `Reflection` is removed, and `root_module()` takes its part in phase 5.)
- Evaluation (0.7.1): terms are evaluated by an evaluator the caller gives, in lexical scopes; `Validators.Check` gives
  problems and unknowns, three-valued; `Schemas.equivalent` is equality after substitution. With extents gone,
  validation evaluates no term, and `Check` takes no evaluator; nothing it checks is unknown until something
  undecidable is checked again (a shape constraint, open-world data), so `Outcome.unknowns` stays, empty.
- Every element may be described (0.6): schemas, properties, adjacencies, branches and parts hold an optional
  `description`, written in modules and read back. So that a property can hold one, a property is an element,
  `OfProperty.Data`, and `properties` maps a name to it rather than to its type, as a union's or intersection's
  `properties` maps a name to its branch or part.
- Names starting with `$` are reserved for the wire format's markers (`$ref`, `$schema`, `$id`): `validate()` reports
  a property, adjacency, link, branch or part name that starts with `$` ("name '$ref' is reserved: names starting with
  '$' belong to the wire format"). It depends on the schema alone, so no data can collide with a marker.
- Object-valued properties hold value objects: read-only values owned by their owner, written
  nested; they have identities and may have adjacencies. Reference objects are reached through relations.
- Union branches and intersection parts are named, and their values are records keyed by those names, in proxies and
  over the wire; there are no branch predicates (see Unions and intersections by name). Intersections as registered
  object schemas (objects with identity composed from aspects) are a later step.
- `OfScalar` wire conversion (including for literals in expressions) belongs to `Schemas.OfScalar`.
- Builder finalization is `create()` / `clone()` / `update()`; none validate.
- A program's own classes take part through `Bindings`: a binding pairs a reference object schema with `read`, `make`
  and `assign`, and the framework gives the rest (`accept`, builders, a store), so classes and proxies are
  interchangeable wherever a `Visitable` and its builders are expected. (Superseded by The visitor pattern: `Bindings`
  is removed, and code generation gives each schema its `Data`, `Builder` and `Schema`.)
- Validation, including well-formedness, runs only when the caller invokes it.
- `Schemas.OfX.Schema` is the meta-schema for `Schemas.OfX.Data`; a module of schemas is an object of
  `Schemas.Module.Schema`, translated by `Modules` (see Meta-schemas).
- Mutations apply to anything with a schema; one vocabulary per schema kind.
- A map `a -> [key] -> b` is a relation with links `a`, `b` and property `key`; named references work the same way.
- A relation has two links or more (Resolved, Containers); values that belong to one owner are a container.
- No relation builder is exposed to the caller; entries are added through adjacency accessors on the object builder,
  which take an entry `Spec`, e.g. `.addresses(lambda x: x.address(addr1).label('work'))`. A link takes an existing
  object or a `Spec` that builds a new one.
- An object's serialized form includes its adjacencies; linked objects appear as symbol references, not nested content.
- Deserializing a snapshot that references an object it does not contain is an error.
- Relation links are untyped names (`.links('contact', 'address')`); objects declare adjacencies with
  `.relations(lambda adj: adj.name(...).of(Relation).me(link))`.
- Lists, dicts, maps and tensors of values, value objects among them, are containers, held by properties (see Lists).
  Reference objects are never kept in containers: collections of them are relations of two links or more.
- Cardinality is declared with `unique(S)` clauses; ownership is `unique(parent)`; a relation with a `unique` clause
  holds a set and duplicates are elided, and one without is open, its entries a list from each end.
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
- Stores replace the `Factories` design and every registry: a store (`Visitors.OfStore`) locates schemas, builders,
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
  the visitor; a value object first calls the visitor's `identify(value)` with itself. (Superseded by The visitor
  pattern: data instances and builders implement `Visitors`, and `Visitable` is removed.)
- Schemas may be named or inline; inline (anonymous) sub-schemas are created with the lambda-builder notation.
- `Schemas.OfAny.Builder` selects a kind via `as_<kind>` methods (e.g. `as_scalar`).
- `Visitors.OfAny.as_<kind>` takes a callback that receives the kind's visitor and returns `self`; chained calls dispatch on
  the value's actual kind.
- Visitors never return child visitors; they pass them to callbacks. Non-query visitor methods return `self`.
  (Superseded by The visitor pattern: a member read is the child visitor, and writer methods return nothing.)
- A `Schemas.OfAny.Builder` configured with `as_<kind>` finalizes to that kind's data (e.g. `Schemas.OfScalar.Data`).
- Builder methods are fluent and return `self`.
- Instances of a registered schema are built through `store.Name(optional instance)` (the dynamic implementation,
  `Proxies.OfStore`), which has one fluent setter per property.
- Instance properties are read as ordinary attributes (e.g. `addr1.street1`), read-only; changes go through a builder.
  A property that is not set reads as `None` (`null` in TypeScript).
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
  the corresponding builder (e.g. `of(...)` takes `Schemas.OfAny.Spec`; `as_scalar` takes `Schemas.OfScalar.Spec`).
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
[← 10 · Asking the store: mutations as queries (TypeScript)](../typescript5/tutorials/10_Asking_The_Store.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)
