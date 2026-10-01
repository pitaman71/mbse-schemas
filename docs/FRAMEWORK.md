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
               reference objects when marked `.ref()`, and otherwise value (embedded) objects; see Value objects and
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

A property whose schema is an `OfObject` holds an *embedded object*: a read-only record of that schema's properties,
with no identity and no adjacencies, copied by value and written nested in its owner's snapshot. An embedded object's
schema must not declare adjacencies, however it is held (directly, through a union branch or an intersection part).
A property whose schema is an `OfUnion` holds a union value: a record whose properties are the union's branches, holding
exactly one of them. A property whose schema is an `OfIntersection` holds an intersection value: a record whose
properties are the intersection's parts, holding each of them. `Visitors.OfUnion` and `Visitors.OfIntersection` read
and write them like an embedded object's properties (`properties`, `has`, `property`, `clear`), and writing a union's
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

Uniqueness gives only an upper bound. Requiring at least one entry is a separate constraint (see Open questions).

### Equality

Equality is defined by the schema, never by host-language `==`, and ordering only for ordered native types. See
[`EQUALITY.md`](EQUALITY.md) for the rules, hashing, ordering, the `Comparison` module, and the edge cases still to
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
  adjacency via that link, `unique(...)` clauses over the entries seen, embedded objects' properties recursively,
  that a union value holds exactly one of its branches and an intersection value every one of its parts, each with a
  value of its type. The validator is a visitor: objects write
  themselves into it through `accept`. `Validators.properties_of(value)` returns the property values any object writes when
  visited, for other modules and packages that read objects (e.g. mbse-expressions' evaluators).

- `Comparison` : for each schema element `OfX`, `Comparison.OfX` implements `Visitors.OfX`, records the value written
  into it, and compares it with another recording: `a.compare(b)` returns -1, 0, 1, or `None` when incomparable. See
  `EQUALITY.md`.

- `Adapters` : translate between a language's own type declarations and schemas, so they are specific to each
  language. Python has `Adapters.Dataclasses`: `FromDataclass(cls)` returns the `OfObject` a dataclass describes and
  `ToDataclass(schema, name)` returns a new dataclass, both through `ast` trees rather than source text;
  `FromDataclass.model(*classes)` and `ToDataclass.model(schemas)` translate several at once. Only types are
  translated. Native fields are properties. A container of dataclasses (`set[X]`, `list[X]`, `dict[K, X]`) is a
  relation with links `owner` and `item`, plus `index: int` or `key: K` with `unique(item)` for lists and dicts: the
  owner's adjacency is the field, and each element class gets an adjacency via `item`. Adjacencies declare which
  object schemas may fill a link, so writing a class finds a container's element type by reverse lookup, and writes
  fields only for adjacencies via a relation's first link. Defaults, mandatoriness and nested classes (embedded
  objects) are left out or refused.

## Proxies

- `Proxies` : for each schema element `OfX`, `Proxies.OfX.Data` defines how the schema can be stored in memory as schema-independent types, and `Proxies.OfX.Builder`, like every builder, implements `Visitors.OfX`. Proxies themselves do not implement `Visitors`; if they have an interface for traversal, it is `Visitable` (a proxy accepts a visitor), not `Visitor`. `Proxies.OfX.Builder.validate` can be used to check the current state of the configured item. Validation is never implicit: it runs only when the caller invokes it.

## Serialization

Both in-memory objects and mutations (see `Mutations`) are serializable.

Over the wire, object content carries no schema. Association of an object with a schema is done dynamically, starting
from the expected root schema, which is why deserializers such as `Plain.FromPlain(builders)(schema, ...)` take it as an
argument, and continuing through property types and the branch written with each union value. Links are untyped, so a serialized
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
- An embedded object is written nested, as a mapping of its properties. Union and intersection values are written the
  same way, keyed by branch or part name: a union value `{"phone": {"number": "1"}}` has exactly one key, and decoding
  rejects any other count; an intersection value `{"stamp": {...}, "audit": {...}}` has a key per part, and a missing
  part is for `Validators` to report.
- Only a `create` mutation creates an object. A reference never creates one.

- `Plain` : for each schema element `OfX`, `Plain.ToPlain.OfX` and `Plain.FromPlain.OfX` implement `Visitors.OfX` and
  convert between values and plain data (dicts, lists, strings, numbers, booleans, null). `Plain.ToPlain(schema, value)`
  and `Plain.FromPlain(builders)(schema, plain)` dispatch on the schema's kind. `Schemas.OfNative` converts natives to forms plain
  data can hold (`bytes` as base64 text; non-finite floats as the strings `NaN`, `Infinity`, `-Infinity`), so text
  encodings never handle that themselves. An object's plain form includes its
  adjacencies; linked objects appear as transaction symbol references, not nested content. Deserializing a snapshot
  that references an object it does not contain is an error.
  An object snapshot is `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to plain
  values and adjacency names to lists of entries; an entry maps the other links to references and the entry properties
  to plain values (the object's own link is implied). A reference is `{"$ref": symbol, "$schema": name}`. Symbols are
  assigned in the order objects are first referenced. `Plain.ToPlain.OfObject` includes only the root, so its references
  are unresolved; `Plain.ToPlain.Reachable` includes every object reachable through adjacencies. An entry appears under
  each object it links; on deserialization the duplicate is elided.
- `JSON` : `JSON.ToJSON(schema, value)` returns JSON text and `JSON.FromJSON(builders)(schema, text)` rebuilds values;
  both mirror `Plain` (`.OfNative`, `.OfObject`, `.Reachable`). Output is strict JSON (RFC 8259) with key order kept;
  input with NaN / Infinity literals or duplicate keys is rejected.
- `YAML` : `YAML.ToYAML` / `YAML.FromYAML(builders)`, mirroring `JSON`. Requires PyYAML (the `yaml` extra), imported
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
  parser. The framework's own YAML rules are identical: one document, string keys, no duplicate keys, no tags except
  `!`, `!!str`, `!!seq` and `!!map`, and no undefined aliases.
- Bytes are decoded as UTF-8, UTF-16 or UTF-32, detected as JSON specifies (RFC 8259 and its predecessors) for both
  JSON and YAML input. Undecodable bytes give `input is not valid <encoding>`.

## Value objects and reference objects

Reference object schemas (`.ref()` and its rules, the first two bullets) are implemented; value objects with
identities and adjacencies are designed, not yet implemented. The design lifts the rule that an embedded object has no
identity and no adjacencies, so that an object can be composed of parts that take part in relations (a component's
ports, a schema's properties). The terms replace "embedded object" and "object" throughout once implemented.

- **Every object has an identity**, and any object can be linked by relations. What distinguishes the two kinds is
  ownership, and the schema says which kind it describes: `Schemas.OfObject.Builder().ref()` marks a *reference object
  schema*; an object schema without it is a *value object schema*. A singleton's schema is a reference object schema.
- **A reference object** stands on its own: a snapshot writes it once among its `objects`, under its symbol. A
  snapshot's root is a reference object, and `Proxies.Builders.<Name>()` makes only reference objects. A reference
  object schema is never a property's type, directly or as a union's branch or an intersection's part held by a
  property, nor an entry property's: `validate()` reports it ("a reference object schema cannot be a property's
  type"). Reference objects are reached through relations only.
- **A value object** is held by a property whose schema is a value object schema, and belongs to that one owner, a
  reference object or another value object. Union and intersection values are value objects, and so are the objects they hold.
  `Visitable.owner()` gives a value object's owner, and None for a reference object.
- **A value object may have adjacencies**, and its entries link it like any object. The rule "an embedded object cannot
  have adjacencies" is dropped. A value object's schema follows from its owner's, so a value object schema needs no
  registration, and a link to a value object carries no `$schema`: `{"$ref": "s3"}`.
- **Ownership is exclusive and deep.** Editing a value object through its owner's builder keeps its identity. Setting
  it into another owner, or `clone()` of its owner, copies it with a new identity, with the entries among the copied
  objects (re-linked to the copies) and a copy of each entry that links them to objects outside. Clearing the property,
  or replacing its value, removes the value object and every entry linking it.
- **Entry properties may be value objects, never reference objects.** Such a value object is owned by its entry.
- **Value objects are written nested**, inside their owner, with their adjacencies nested in them as a reference
  object's are. A value object that something links to carries its symbol, `"home": {"$id": "s3", "number": "1"}`,
  and is referred to by it, `{"$ref": "s3"}`; one that nothing links to is written as embedded objects are now. Symbols are assigned in first-reference order, value objects and reference objects alike.
- **Reachability goes through value objects**: their entries are followed as a reference object's are, and an object
  reached that is a value object brings in the reference object that owns it, which is where it is written.
- **Decoding** rebuilds a value object through its owner's builder, and finds it again to link it with
  `Builders.member(instance, name)`, the value an instance holds in a property (a union's branch, an intersection's
  part); a `$ref` to an `$id` resolves to that value object.
- **Value objects compare deeply**: by their properties, recursively, and by their entries, whose links to reference
  objects compare by identity and to value objects deeply. Their identity does not take part. Reference objects
  compare by identity when linked.
- **Proxies keep value objects read-only**, with adjacencies set through the owner's builder, e.g.
  `.home(lambda r: r.number("1").ports(lambda x: x.port(p)))`.

## Unions and intersections by name

These replace the earlier design, in which a union's branches were chosen by predicates and written as
`{"$branch": index, "$value": value}`, and an intersection's parts merged into one value.

- **Every union branch and every intersection part has a name.** Names are required, unique within their union or
  intersection, and are property names, subject to the same rules (see reserved names under Open questions).
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

## Native types

Native types and their widths are implemented; the meta-schemas that write them over the wire are designed below.

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

Designed, not yet implemented. Schemas are data: each schema kind's data has a meta-schema, `Schemas.OfX.Schema`, so
schemas are written, read, validated and compared like any other objects. Native types are written as their tokens
and widths (see Native types).

- **A module holds named schemas.** `Schemas.Module` is a reference object schema: a set of named schemas, one per
  entry of its `schemas` relation, whose properties are the `name` and the `schema`, a value object. A snapshot of
  schemas is a snapshot of a module.
- **Within a module, schemas are value objects, nested inline.** An object schema's properties and adjacencies, a
  union's branches and an intersection's parts are relations of the schema's value object, written nested in it.
- **A property's type is an inline schema or a name**: a union with the branches `inline` (a value object of any
  schema kind) and `named` (a string, resolved within the module, then in the registry). Shared and recursive schemas
  refer to each other by name; a relation that an adjacency names is named the same way.
- **Meta-schemas are defined in code and registered by name** (`Schemas.OfNative`, `Schemas.OfObject`, ...), never read
  from data, and their builders implement `Visitors.OfX`, so `Plain.FromPlain` rebuilds schemas as it rebuilds any
  objects. They are separate from the DSL builders, whose methods (`properties(*specs)`) would clash with the visitor
  protocols (`properties(callback)`).

## Expressions

Constraints, planned, are serializable expressions. Expressions are a separate
package, [mbse-expressions](https://github.com/pitaman71/mbse-expressions), which depends on this one: its expressions
are ordinary objects with registered meta-schemas, so this package serializes, validates and compares them like any
others. See its `docs/EXPRESSIONS.md` for the expression kinds, the core vocabulary and evaluation.

Nothing in this package evaluates expressions: a union value names its branch, so neither decoding nor validation needs
an evaluator. Anything here that comes to evaluate constraints will take an evaluator from its caller rather than
import one, so the dependency keeps pointing one way.

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
| Schema data equality | `==` | `.equals()` |
| Errors | built-in `TypeError`, `ValueError`, `AttributeError`, `KeyError`, `LookupError`, `NotImplementedError`; `Errors.DecodeError` | built-in `TypeError`; the others and `DecodeError` exported from `Errors`, with the same names |
| Callable entry points | `Plain.ToPlain(...)`, `Plain.FromPlain(builders)(...)` (objects with `__call__`) | functions with the per-kind forms attached |
| Keyword arguments | `ToJSON(..., indent=2)` | options objects: `ToJSON(..., { indent: 2 })` |
| Dynamic proxies | `__getattr__` | `Proxy`; JavaScript protocol probes (`then`, `toJSON`, symbols) are not schema lookups |
| Object identity | `id(self)` | a counter, never reused |
| Incomparable (`Comparison`) | `None` | `null` |
| JSON | `json` with strict options | own reader and writer reproducing Python's output; ints and floats kept distinct |
| YAML | PyYAML (optional extra), YAML 1.2 core loader | `yaml` package loader, own block emitter; the same quoting rules |

## Open questions

Findings from the test plans (`python3/tests/TestPlan.md`, `typescript5/tests/TestPlan.md`) that need a design decision:

- Reserved names (F2): property and adjacency names that collide with binding members (e.g. `create`, `accept`, or
  names starting with `_` in Python; `constructor`, `toString`, `then` in JavaScript) cannot be set through the DSL or
  read as attributes in some bindings, and `validate()` accepts them. Should schemas reject names that any target language reserves, or should bindings rename them?
- Concurrent builders (F4): two builders over the same object each hold a copy; the last `update()` wins and drops
  entries the other added. Is that the intended semantics of `update()`?
- Cloning self-loops (F5): `clone()` copies entries with the clone in place of the source, so a self-loop's clone
  links back to the original rather than to itself. Intended?
- Snapshots whose two ends disagree (F13) are accepted and restore the union of both ends' entries. Should
  deserialization reject them instead of leaving it to validation?

- `Factories.Directory` global singleton: namespacing/versioning of global names, collision policy, and isolation for tests.
- Where constraints are attached to a schema (e.g. an `OfObject`- or `OfRelation`-level list of expressions) and how
  they are declared in the builder DSL.
- Equality edge cases listed in `EQUALITY.md` are proposals; confirm them.
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
  - Unions: `.branches(lambda b: b.name('phone').of(spec), ...)`, in declaration order.
  - Intersections: `.parts(lambda p: p.name('stamp').of(spec), ...)`.
  - `validate()` on each `Schemas.OfX.Data` returns a list of problems (empty when valid).
- `Schemas.OfAny.Data` is currently the union of the schema kinds' data (`OfNative`, `OfObject`, `OfUnion`,
  `OfIntersection`). There is no separate "any value" kind yet.
- Reading an object's entries back (e.g. a contact's phones), and removing an entry through a builder.
- Mixing implementations: may the same schema be used through both `Proxies` and generated bindings in one program, and
  may instances pass between them? Intended to be legal under controlled conditions, not yet specified.
- Is "an owned child must be part of an ownership chain rooted in an object with a directory entry" still a
  well-formedness rule under symbol-based serialization?
- Labeling objects outside snapshots: tools other than serializers (diffs, audit logs, debug dumps) have only
  `identity()`, an opaque in-memory value (`id(self)` in Python), to name an object. Snapshots label objects with
  symbols, but those are internal to a serialization. Should the framework expose a reusable, stable labeling, for
  example the symbol numbering `Plain.ToPlain.Reachable` would assign, or a symbol table tools can share? Seen in the
  tutorial's audit-log diff (`python3/tutorials/08_Tools_For_Every_Schema.ipynb`), which prints a raw object id.

### Resolved

- Nothing is mandatory except as specified by a constraint: properties are optional by default, and mandatory
  participation in a relation is expressed as a constraint (directory membership is required by well-formedness).
- `OfValue` is not a base class; renamed `OfAny`.
- Object-valued properties hold embedded objects: read-only values with no identity and no adjacencies, written
  nested. Objects with identity are reached through relations.
- Union branches and intersection parts are named, and their values are records keyed by those names, in proxies and
  over the wire; there are no branch predicates (see Unions and intersections by name). Intersections as registered
  object schemas (objects with identity composed from aspects) are a later step.
- `OfNative` wire conversion (including for literals in expressions) belongs to `Schemas.OfNative`.
- Builder finalization is `create()` / `clone()` / `update()`; none validate.
- Validation, including well-formedness, runs only when the caller invokes it.
- `Schemas.OfX.Schema` is the meta-schema for `Schemas.OfX.Data`.
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
- JSON and YAML are implemented as `JSON.ToJSON` / `JSON.FromJSON(builders)` and `YAML.ToYAML` /
  `YAML.FromYAML(builders)`; YAML loads with the YAML 1.2 core schema.
- Non-finite floats are plain strings `NaN`, `Infinity`, `-Infinity`, so JSON output stays strict.
- Serialization goes through one plain-data form, `Plain.ToPlain(schema, value)` / `Plain.FromPlain(builders)(schema, plain)`;
  JSON and YAML are thin text encodings of it.
- `JSON.ToJSON(schema, value)` / `JSON.FromJSON(builders)(schema, text)` take the schema explicitly, dispatch on its kind
  (equivalent to `JSON.ToJSON.OfX(...)`), and produce/consume a snapshot.
- Sub-structure arguments throughout the builder pattern are `Spec`s: a direct value, or a callable that takes and returns
  the corresponding builder (e.g. `of(...)` takes `Schemas.OfAny.Spec`; `as_native` takes `Schemas.OfNative.Spec`).
- Both in-memory objects and mutations are serializable, so JSON/YAML cover both.
- Implementations are equivalent: same API names and messages, byte-identical JSON, and a shared conformance corpus
  checked by each implementation's CONF suite (see Language bindings).
- Data is validated by `Validators.Validate(registry)`, only when the caller asks; builders do not validate.
- Values are compared by `Comparison.OfX` visitors, one per `Visitors.OfX`: `a.compare(b)` is -1, 0, 1, or `None`
  when incomparable. Only `int`, `float`, `str` and `bytes` are ordered.
- Decoding errors are normalized: every problem in decoded data raises `Errors.DecodeError` (a `ValueError`) with a
  one-line reason and a text or path location, identical across bindings except YAML syntax errors (see Decoding
  errors).
- `Plain.FromPlain` is constructed with the builders of the implementation to build with, e.g.
  `Plain.FromPlain(Proxies.Builders)(schema, plain)`.
- Reachability is its own visitor, `Reachable.of(root)`, which returns the root and every object reachable through
  adjacencies in first-reference order. `Plain.ToPlain.Reachable` uses it.
- Over the wire, object content carries no schema. Association with a schema is dynamic, starting from the expected
  root schema (hence `FromPlain(builders)(schema, ...)` takes it) and continuing through property types and the
  branch written with each union value. Serialized references to linked objects carry the object's schema name.
