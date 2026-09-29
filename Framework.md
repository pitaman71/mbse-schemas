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
- `OfNative` : a native value in the current programming language. For example in Python `int`, `float`, `string`, `bool`, `bytes`.
               Conversion between the native format and the over-the-wire format is the responsibility of `Schemas.OfNative`.
- `OfObject` : named properties list where each property has type described by `OfAny`. An `OfObject` schema may declare
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
- `OfUnion` : of two or more OfX schemas (must be the same kind) that can be discriminated by a predicate which must be provided
              as a serializable expression (see `Expressions`).
- `OfIntersection` : of two or more OfX schemas (must be the same kind). Used to implement object and aspect oriented structures.
                     It is an error for the intersected schemas to conflict, e.g. two `OfObject`s declaring the same
                     property with different types.

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

A relation's entries form a set: adding an entry equal to an existing one (see Equality) is silently elided.

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

Uniqueness gives only an upper bound. Requiring at least one entry is a separate constraint (see Open questions).

### Equality

Equality is defined by the schema, never by host-language `==`. It is used for keys, for `eq` / `ne` / `in` in expressions,
and anywhere else values are compared. Two values are compared under a schema:

- `OfNative` : defined by `Schemas.OfNative` as equality of the canonical wire form. Values of different native types are
  never equal (`1`, `1.0` and `true` are distinct).
- `OfObject` held as a property value : every schema-declared property is either absent in both or present and equal
  in both. Properties not declared by the schema
  (e.g. extra data held by a dynamic proxy) do not participate.
- Linked objects in a relation entry : compared by identity, not structure.
- `OfUnion` : same branch and equal under that branch's schema. The branch is the first whose predicate matches, in
  declaration order.
- `OfIntersection` : equal under every constituent schema.
- `OfAny` : same runtime schema and equal under it.

Because linked objects compare by identity and only relations can form cycles, structural equality always terminates.

Every binding must provide a hash consistent with this equality, for enforcing keys. Hashes need not match across bindings.

Ordering (`lt`, `le`, `gt`, `ge`) is not universal: it is defined only for ordered `OfNative` types.

Proposed resolutions for edge cases (to confirm):

- Floats compare by canonical bit pattern: all NaNs are canonicalized and equal each other, and `-0.0` differs from `0.0`.
  This makes `eq` on floats differ from IEEE `==`.
- `OfNative` numeric types must fully specify width and signedness, so equality is the same in every binding. A value
  that does not fit its type is invalid, not unequal.
- Strings compare by code point with no Unicode normalization.
- Object identity holds only within one loaded graph. Objects from two separately loaded graphs can be matched through
  their key in a singleton's directory; objects without one cannot be matched.

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
- `as_native` takes a `Schemas.OfNative.Spec`: either one of the supported native types directly (e.g. `str`) or a
  `Callable[[Schemas.OfNative.Builder], Schemas.OfNative.Builder]`.

Anonymous sub-schemas are created inline by passing a lambda that receives a builder, e.g.
`prop.name('street1').of(lambda t: t.as_native(str))`, where `t` is a `Schemas.OfAny.Builder`. The lambda only
configures the builder; it is not part of the resulting schema, which stays serializable.

Instances of a user schema follow the same pattern. With the dynamic (proxy) implementation (see `schemas/Examples/AddressBook.py`):

- `Proxies.register('Name', schema)` registers a schema under a global name. The name is a string, so it need not be a
  valid identifier in any host language (e.g. dotted or versioned names).
- `Proxies.Builders.Name(optional instance)` returns a builder for that schema with one fluent setter per property
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
- `Schemas` : for each schema element `OfX`, `Schemas.OfX.Data` is used to capture a schema. Schemas may be named (registered by a global name in `Factories.Directory`) or appear inline without a name.
- `Factories` : for each schema element `OfX`, `Factories.OfX` is an interface for constructing an instance of schema element `OfX` and for fetching the corresponding schema itself. `Factories.Directory` describes a singleton object used to register schemas by a global name, which results in the creation of a singleton factory for that schema, and obtain the corresponding factory by a global name. `Factories.Directory` is also the sole source for `Visitors`: client code obtains visitors through `Factories` rather than instantiating classes that implement `Visitors` itself. This does not restrict which classes implement the `Visitors` protocol: builders and serializers (e.g. `Plain`, `JSON`) do. Proxies do not implement `Visitors`.

- `Mutations` : for each schema element `OfX`, `Mutations.OfX` is used to represent incremental changes to anything that has a schema,
  including schemas themselves (via their meta-schemas). Mutation types scale with the number of schema elements, not with the number of user schemas.
  The vocabulary for each kind is the obvious set for that kind (e.g. creating and deleting an `OfObject`, setting its
  properties, adding and removing `OfRelation` entries).

- `Validators` : `Validators.Validate(registry)(schema, value)` checks data against its schema and returns a list of
  problems, each with a path (e.g. `Student#0.enrollments[1].credits: expected int, got bool`). `.Reachable(schema, root)`
  checks everything reachable from the root. It is constructed with a registry that looks schemas up by name (e.g.
  `Proxies.Builders`), and runs only when the caller asks. It checks the schemas' own `validate()`, exact native types
  of properties and entry properties, that every link is set and filled by an object whose schema declares an
  adjacency via that link, and `unique(...)` clauses over the entries seen. The validator is a visitor: objects write
  themselves into it through `accept`.

## Proxies

- `Proxies` : for each schema element `OfX`, `Proxies.OfX.Data` defines how the schema can be stored in memory as schema-independent types, and `Proxies.OfX.Builder`, like every builder, implements `Visitors.OfX`. Proxies themselves do not implement `Visitors`; if they have an interface for traversal, it is `Visitable` (a proxy accepts a visitor), not `Visitor`. `Proxies.OfX.Builder.validate` can be used to check the current state of the configured item. Validation is never implicit: it runs only when the caller invokes it.

## Serialization

Both in-memory objects and mutations (see `Mutations`) are serializable.

Over the wire, object content carries no schema. Association of an object with a schema is done dynamically, starting
from the expected root schema, which is why deserializers such as `Plain.FromPlain(builders)(schema, ...)` take it as an
argument, and continuing through property types and union discriminator predicates. Links are untyped, so a serialized
reference to a linked object carries that object's schema name alongside its symbol. Consequently, an object that is
linked from another object must have a named (registered) schema.

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
- Only a `create` mutation creates an object. A reference never creates one.

- `Plain` : for each schema element `OfX`, `Plain.ToPlain.OfX` and `Plain.FromPlain.OfX` implement `Visitors.OfX` and
  convert between values and plain data (dicts, lists, strings, numbers, booleans, null). `Plain.ToPlain(schema, value)`
  and `Plain.FromPlain(builders)(schema, plain)` dispatch on the schema's kind. `Schemas.OfNative` converts natives to forms plain
  data can hold (e.g. `bytes`), so text encodings never handle that themselves. An object's plain form includes its
  adjacencies; linked objects appear as transaction symbol references, not nested content. Deserializing a snapshot
  that references an object it does not contain is an error.
  An object snapshot is `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to plain
  values and adjacency names to lists of entries; an entry maps the other links to references and the entry properties
  to plain values (the object's own link is implied). A reference is `{"$ref": symbol, "$schema": name}`. Symbols are
  assigned in the order objects are first referenced. `Plain.ToPlain.OfObject` includes only the root, so its references
  are unresolved; `Plain.ToPlain.Reachable` includes every object reachable through adjacencies. An entry appears under
  each object it links; on deserialization the duplicate is elided.
- `JSON` : for each schema element `OfX`, `JSON.ToJSON.OfX` implements `Visitors.OfX` and when called, serializes the data structure to a JSON representation. `JSON.FromJSON.OfX` implements `Visitors.OfX` and when called, deserializes the data structure from a JSON representation.
  Both take the schema explicitly: `JSON.ToJSON(schema, value)` and `JSON.FromJSON(schema, json)`. The top-level
  `JSON.ToJSON` / `JSON.FromJSON` dispatch on the schema's kind, e.g. `JSON.ToJSON(IntlAddress, addr1)` is equivalent to
  `JSON.ToJSON.OfObject(IntlAddress, addr1)`. Serializing a value this way produces a snapshot, not a transaction.
  An object's serialized form includes its adjacencies; linked objects appear as symbol references, not nested content.
- `YAML` : similar to JSON
- JSON and YAML are thin text encodings of `Plain` data.

## Expressions

- `Expressions.OfAny` : generic expression
- `Expressions.OfLiteral` : literal expression in native-language format; conversion to and from the over-the-wire format is the
  responsibility of `Schemas.OfNative`
- `Expressions.OfOperation` : function call over an initially open function vocabulary with string names

Every binding must implement a core vocabulary of operations. The core vocabulary is chosen so that any core expression
can also be interpreted as a constraint (e.g. by a solver or as a SystemVerilog constraint): operations are pure,
deterministic, and total, with no side effects or unbounded iteration.

- Literals and property/path access
- Comparison: `eq`, `ne`, `lt`, `le`, `gt`, `ge`
- Boolean: `and`, `or`, `not`, `implies`
- Kind/type test: `is`
- Presence test: `has` (whether an optional property is present)
- Arithmetic: `add`, `sub`, `mul`, `neg`
- Collections: `count`, `in`, and bounded quantifiers `all` / `any` over an object's adjacency entries

Union discriminator predicates must use only the core vocabulary. Operation names outside it are extensions that a binding may
or may not support.

Expressions are serializable and therefore follow the `Expressions.X.Data` `Expressions.X.Schema` `Expressions.X.Builder` format.

## Open questions

- `Factories.Directory` global singleton: namespacing/versioning of global names, collision policy, and isolation for tests.
- Core expression vocabulary above is a proposal; confirm the exact set.
- Where constraints are attached to a schema (e.g. an `OfObject`- or `OfRelation`-level list of expressions) and how
  they are declared in the builder DSL.
- Equality edge cases listed under Equality are proposals; confirm them. In particular, fixed width and signedness for
  numeric `OfNative` types conflicts with unbounded native types such as Python `int`.
- Multi-object snapshot naming: confirm `Plain.ToPlain.Reachable(schema, value)` /
  `Plain.FromPlain(builders).Reachable(schema, plain)` (still marked PROPOSED in the example).
- `Plain.ToPlain` still looks up the schemas of non-root objects in the `Proxies` registry. Should it also be
  constructed with an implementation's registry, like `FromPlain`?
- Snapshot determinism: must two serializations of the same state produce identical output? Entries are now written
  with links and properties in the relation's declared order, but symbols are numbered in first-reference order, and
  entry order within an adjacency depends on history, so a round trip can renumber symbols (see the `FamilyTree` and
  `University` examples, which compare snapshots up to renumbering). Full determinism would need a canonical entry
  order.
- Uniqueness is global to a relation, but `Validators.Validate(...).Reachable` checks it only over the entries
  reachable from what was validated. Entries in another component that share only property values can go unchecked.
  Is a relation-wide check needed?
- Is `Factories` an interface, with `Proxies` as its dynamic implementation and generated bindings as typed
  implementations of the same shape (`register`, `Builders.<Name>`)?
- Builder syntax proposed by the draft `Schemas.py`, to confirm:
  - `unique` clauses: `.unique('parent', 'key')`, one call per clause.
  - Singletons: `Schemas.OfObject.Builder().singleton('GlobalName')`.
  - Unions: `.branches(lambda b: b.of(spec).when(predicate), ...)`, in declaration order.
  - Intersections: `.of(spec, spec, ...)`.
  - `validate()` on each `Schemas.OfX.Data` returns a list of problems (empty when valid).
- `Schemas.OfAny.Data` is currently the union of the schema kinds' data (`OfNative`, `OfObject`, `OfUnion`,
  `OfIntersection`). There is no separate "any value" kind yet.
- Not yet drafted: the meta-schemas (`Schemas.OfX.Schema`), and schema builders implementing `Visitors.OfX` so that
  schemas themselves serialize.
- Reading an object's entries back (e.g. a contact's phones), and removing an entry through a builder.
- Mixing implementations: may the same schema be used through both `Proxies` and generated bindings in one program, and
  may instances pass between them? Intended to be legal under controlled conditions, not yet specified.
- Is "an owned child must be part of an ownership chain rooted in an object with a directory entry" still a
  well-formedness rule under symbol-based serialization?

### Resolved

- Nothing is mandatory except as specified by a constraint: properties are optional by default, and mandatory
  participation in a relation is expressed as a constraint (directory membership is required by well-formedness).
- `OfValue` is not a base class; renamed `OfAny`.
- Union discriminators are serializable expressions, not lambdas; the branch is the first matching predicate in
  declaration order.
- `OfNative` wire conversion (including for `Expressions.OfLiteral`) belongs to `Schemas.OfNative`.
- Builder finalization is `create()` / `clone()` / `update()`; none validate.
- Validation, including well-formedness, runs only when the caller invokes it.
- `Schemas.OfX.Schema` is the meta-schema for `Schemas.OfX.Data`.
- Conflicting `OfIntersection` constituents are an error.
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
- There is no array-like element (`OfIndexed` was removed); all collections are relations.
- Cardinality is declared with `unique(S)` clauses; ownership is `unique(parent)`; relation entries form a set and
  duplicates are elided.
- An object may have more than one owner.
- Entries linking a deleted object vanish with it.
- Singletons declare a global name in their `OfObject` schema, exist implicitly, and are referenced by that name.
- Object identity on the wire uses transaction-local string symbols with a checkable 1:1 mapping; only `create` creates
  objects.
- Transactions are flat; mutations may be nested.
- "Sole source for `Visitors`" means client code obtains visitors via `Factories`; other classes may implement
  `Visitors`.
- `clone()` copies the source's adjacency entries to the clone.
- Building a new object inline through a link (`x.phone(lambda y: ...)`) requires an unambiguous inference of its
  schema: exactly one registered object schema may declare an adjacency to that relation via that link; otherwise it
  is an error. Pass an existing object instead when inference is ambiguous.
- Builders and serializers implement `Visitors`; proxies do not. Proxies implement `Visitors.Visitable`: `identity()`,
  `schema_name()`, and `accept(visitor)`, which writes the object's properties and adjacency entries into the visitor.
- Schemas may be named or inline; inline (anonymous) sub-schemas are created with the lambda-builder notation.
- `Schemas.OfAny.Builder` selects a kind via `as_<kind>` methods (e.g. `as_native`).
- `Visitors.OfAny.as_<kind>` takes a callback that receives the kind's visitor and returns `self`; chained calls dispatch on
  the value's actual kind.
- Visitors never return child visitors; they pass them to callbacks. Non-query visitor methods return `self`.
- A `Schemas.OfAny.Builder` configured with `as_<kind>` finalizes to that kind's data (e.g. `Schemas.OfNative.Data`).
- Builder methods are fluent and return `self`.
- Instances of a registered schema are built through `Proxies.Builders.Name(optional instance)` (dynamic implementation),
  which has one fluent setter per property.
- Instance properties are read as ordinary attributes (e.g. `addr1.street1`), read-only; changes go through a builder.
  Reading a property that is not set raises an error.
- Instance setters take a `Spec`: `.street1('foo')` is equivalent to `.street1(lambda v: v.set('foo'))`.
- A property is cleared with `.street2(lambda v: v.clear())`.
- Serialization goes through one plain-data form, `Plain.ToPlain(schema, value)` / `Plain.FromPlain(builders)(schema, plain)`;
  JSON and YAML are thin text encodings of it.
- `JSON.ToJSON(schema, value)` / `JSON.FromJSON(schema, json)` take the schema explicitly, dispatch on its kind
  (equivalent to `JSON.ToJSON.OfX(...)`), and produce/consume a snapshot.
- Sub-structure arguments throughout the builder pattern are `Spec`s: a direct value, or a callable that takes and returns
  the corresponding builder (e.g. `of(...)` takes `Schemas.OfAny.Spec`; `as_native` takes `Schemas.OfNative.Spec`).
- Both in-memory objects and mutations are serializable, so JSON/YAML cover both.
- Data is validated by `Validators.Validate(registry)`, only when the caller asks; builders do not validate.
- `Plain.FromPlain` is constructed with the builders of the implementation to build with, e.g.
  `Plain.FromPlain(Proxies.Builders)(schema, plain)`.
- Reachability is its own visitor, `Reachable.of(root)`, which returns the root and every object reachable through
  adjacencies in first-reference order. `Plain.ToPlain.Reachable` uses it.
- Over the wire, object content carries no schema. Association with a schema is dynamic, starting from the expected
  root schema (hence `FromPlain(builders)(schema, ...)` takes it) and continuing through property types and union discriminator
  predicates. Serialized references to linked objects carry the object's schema name.
