<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)

# Open-world modeling

How mbse-schemas could let a model grow by independent extension, as KerML and SysML v2 models do, without giving up
the exactness an interface contract needs. This is a proposal: nothing in it is built, and each part is significant
work in both implementations. It is part of the design in the [framework design](FRAMEWORK.md), whose Open questions
point here.

## Where mbse-schemas stands

Under the open-world assumption, what a model does not state is not thereby false, and a type may gain subtypes and
properties that its author never saw. mbse-schemas is open in some ways and closed in others.

- **Closed in shape.** An object holds only the properties and adjacencies its schema declares: decoding refuses any
  other key (`DecodeError`: "'x' has no property or adjacency 'foo'") and validation reports one ("x.foo: not a
  property of 'Contact'"). A union value holds exactly one of its named branches. Every name must resolve.
- **Open in content.** Nothing is mandatory except as specified by a constraint, no cardinality is assumed, and
  checking is three-valued: a constraint over a value that is absent, or a parameter that is unbound, is unknown, not
  false.
- **Open-ended over time.** Schemas are data, built by builders, held in stores, reflected as objects, cloned and
  edited. The vocabulary is never frozen; it changes by editing.

KerML is the reverse: open in shape (any type may be specialized, and an instance may be classified by types declared
later) and logically open (a model is a set of assertions, and anything not contradicted may hold), but mandatory by
default (a multiplicity left out is generally `[1]`), and its union and intersection are relationships on declared
types, over their extents, rather than constructors of data.

What mbse-schemas lacks is **independent extension**: a module that does not own a schema adding a subtype of it, or a
property to it, without editing it, so that data written for the original stays valid and the extension is still
recognized as one. The three parts below provide it.

## Decided

- **Name resolution stays closed.** A name resolves within its module, then in its store, or is refused. Openness
  comes from where declarations may be made, never from accepting names that resolve nowhere.
- **Intersections are the mechanism of inheritance.** A schema that inherits the properties and adjacencies of
  another is an intersection with a part for each schema it inherits and a part for its own properties.
- **Each part is a member.** Proxies and generated classes have a member for each union branch and each intersection
  part (`x.Vehicle.mass`), and the wire form is per part (see Unions and intersections by name in the framework
  design). Parts do not merge. A flat intersection (0.9) reads its parts' properties as its own (`x.mass`), but it is
  held, written and compared per part all the same: flat is how code reads it, not what it is.
- **Types fix shape; constraints narrow values.** Subtyping never narrows a property's type; a narrower property is a
  constraint on the part that holds it.

## 1 · Intersections as subtyping

`Car = Vehicle & CarOwn`, a part `Vehicle` and a part `CarOwn` holding `Car`'s own properties, is how a `Car` inherits
from `Vehicle`. Because each part is a member, inheritance is composition with projection, as in Go's struct
embedding, not subsumption:

- **Upcast is projection.** `car.Vehicle` is a `Vehicle` value; it is what is passed, held or linked wherever a
  `Vehicle` is expected. Nothing makes an intersection acceptable in place of one of its parts.
- **Downcast is the owner.** `car.Vehicle.owner()` is the `Car`. Which schema the owner has is how a reader tells
  which specialization a `Vehicle` belongs to.
- **Adjacencies are inherited already.** A value object's schema may declare adjacencies however it is held, an
  intersection part included, so a `Car`'s `Vehicle` part holds `Vehicle`'s relation entries and is linked like any
  `Vehicle`.
- **Narrowing is a constraint.** SysML's redefinition (`:>> mass`) becomes a constraint on `Vehicle.mass` that `Car`
  requires, kept beside the schema as other constraints are.
- **Multiple inheritance is more parts**, and a mixin is a part.
- **The wire form does not change.** A `Car` is never written where a `Vehicle` is expected; its `Vehicle` part is,
  and a linked value object is already written nested, with its `$id`. No schema tag is needed, and existing corpora
  stay byte-identical.
- **Every target language has it.** A record with a member per part needs no class inheritance, so C structs and
  SystemVerilog `struct`s express it as directly as Python and TypeScript classes do.

### To decide

- **Reference intersections.** A reference object schema cannot be an intersection's part held by a property, and a
  store builds only object schemas marked `.ref()`, so an entity cannot be an intersection. Either `.ref()` applies to
  an `OfIntersection`, and `store.Car()` builds one, or the idiom is a reference object whose one property holds an
  intersection value. The first is proposed.
- **Extents.** Whether a store's `extent("Vehicle")` includes the `Vehicle` parts of `Car`s. For open-world queries it
  must; mbse-patterns' queries and predicates bound to `Vehicle` then match `Car`s by their parts.
- **Diamonds.** If `Car = Vehicle & Insured` and `Insured` holds a `Vehicle` too, a `Car` holds two `Vehicle`s, as a
  C++ class holds two copies of a base it inherits twice without `virtual`. Proposed: documented, not prevented;
  sharing one needs a link, not a part.
- **Flat intersections.** A flat `Car` reads `car.mass` as SysML's `Car :> Vehicle` does, which makes it the natural
  form for inheritance, but projection needs the part itself. Whether a flat intersection's proxies and generated
  classes still expose each part (`car.Vehicle`) for upcasting, under a name that cannot collide with a property, is
  to decide; proposed: they do. A flat intersection requires its parts' property names to be distinct, so a
  specialization that declares a name its supertype declares must stay unpacked, which narrowing by constraint
  (above) makes rare.
- **Equality.** A `Car` is not equal to a `Vehicle` with the same properties, since the schema is part of a value;
  `car.Vehicle` compares as a `Vehicle`.

## 2 · Undeclared properties

Today an undeclared property is refused when decoding and reported when validating. Five policies are possible:

1. **Closed**, today's: refused. It catches misspelled names and drift between implementations.
2. **Dropped**: ignored when read. It loses data on a round trip and breaks byte-identity; not proposed.
3. **Preserved**: kept as plain data, written back as read, and reported by validation as an *unknown*, not a
   problem ("x.foo: not declared by 'Contact'"). An old reader passes newer data through intact, and a misspelled name
   is still visible. Protobuf's unknown fields and JSON Schema's `additionalProperties: true` work so.
4. **Typed extension slot**: a schema declares that it accepts undeclared properties, and of which schema
   (`.extensible(schema)`), as JSON Schema's `additionalProperties: <schema>` does. Open only where declared.
5. **Extension properties**: a module that does not own a schema declares a property for it, an element of its own
   (`safety.asil : ASIL`, for `Vehicle`), and data carries it under its qualified name (`"safety.asil": "D"`). Reading
   resolves the name as schema names resolve, within the module and then in the store, and validates the value
   against the declared type; a name that resolves nowhere falls back to policy 3. RDF's properties, protobuf's
   extensions and KerML's type featuring work so.

Proposed: a reading and validation policy with three settings, **closed** (the default), **preserve** (3) and
**extensible** (5, then 3). Policy 5 also answers SysML v2's metadata: `#Safety` with `asil = D` becomes an extension
property declared by a profile module, with nothing added to the schema it annotates.

### To decide

- **Where the policy is set**: per store, per call (`FromPlain`, `Validate`), per schema, or several.
- **Decoding.** Decoding refuses undeclared keys before anything is built; policies 3 and 5 move that check, for
  object keys at least, to validation.
- **Order on the wire.** Preserved and extension properties are written after declared ones; in the order read, or
  sorted by name, which keeps the two implementations byte-identical with less effort. Sorted is proposed.
- **Qualified names.** Whether extension properties must be qualified (`safety.asil`) so that a property later added
  to the schema itself cannot collide with one. Proposed: yes, and a qualified name is never a declared property's.
- **Equality.** Whether preserved properties take part in comparing data. Today undeclared data does not
  ([Equality](EQUALITY.md)); preserved data is what was read, so proposed: they do, extension properties by their
  declared type and preserved ones as plain data.
- **Members.** Proxies raise on a name the schema does not declare, and generated classes have no member for one. Both
  need an accessor for extension properties and a member for preserved ones (`extras`), named so that it cannot
  collide with a property.
- **Unions.** A union value whose branch is not declared cannot be read as one of its branches. Under policy 3 it is
  preserved, opaque, and validation gives unknown.
- **Relation entries.** Whether entries may carry preserved or extension properties too, or only objects.
- **Predicates.** A predicate may refer to an extension property, which has a type; a preserved property is untyped
  data, and a predicate over one is unknown.

## 3 · Evolution that keeps data valid

Because nothing is mandatory, many edits to a schema keep every value written under it valid: the model can grow
while existing data stays good. Other edits do not. Classified:

| Keeps existing data valid | Does not |
|---|---|
| adding a property or an adjacency | adding an intersection part (a missing part is reported) |
| adding a union branch | adding a `unique` clause |
| adding a parameter, where nothing depends on it | narrowing a type, a width or an extent |
| adding a description | removing or renaming anything |
| declaring an extension property (part 2) | changing a property's type |

### To decide

- **Checked compatibility.** A function that classifies the difference between two versions of a schema by this
  table, so that a tool, a reviewer or an agent can tell whether an edit keeps data valid before making it. It belongs
  beside `Schemas.equivalent` and the tutorial on evolving schemas (When requirements change).
- **Provenance of clones.** A cloned schema has no relation to its source: it is copied, not specialized, and no
  `Vehicle` is a clone's part. A `derived from` relation over reflected schemas would make cloning traceable, short of
  subtyping.
- **Edits as data.** Schema edits are mutations of schema objects; under the journals planned for mbse-journals they
  are serializable and replayable, so the history of a specification's formalization (which constraint was tightened,
  which branch was added, when, by whom) is itself data.

## The work entailed

Each item is built in both implementations, with the same names and messages, and tested in the shared cases.

- **Reference intersections**: builders, stores, proxies, bindings, snapshots, validation and comparison; the
  meta-schema for `OfIntersection` gains `ref`; new conformance corpora.
- **Extents over parts**: stores' extents and `Reachable`; mbse-patterns' queries and their planner.
- **Undeclared-property policies**: decoding (`Plain`, `JSON`, `YAML`), validation, proxies, bindings, generated
  classes, equality and hashing ([Equality](EQUALITY.md)), and a corpus for each policy.
- **Extension properties**: a new element and its meta-schema, resolution through modules and stores, modules writing
  and reading them, mbse-expressions' and mbse-patterns' access to them.
- **Compatibility**: the classifier and its cases; tutorial 9 extended in both languages.
- **The SysML v2 bridge**, when it comes: `:>` to a part, `:>>` to a constraint, `variation` to a union, metadata to
  extension properties; `:>` with flat intersections where SysML code reads inherited features as its own; KerML's
  `unions` to a flat union, its branch names synthesized, since a flat union reads untagged as KerML's does; and
  `differences`, `disjoint from` and `all` to constraints.

---

<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Conformance corpus →](../conformance/README.md)
