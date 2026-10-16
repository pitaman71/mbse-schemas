# Store overhaul (plan, for review)

What the user decided after 0.13.0, gathered into one plan before any code: what changes, in which order, and what each
step breaks. Every step is a breaking change (a minor version below 1.0). It records the decisions not yet recorded
elsewhere (below, "Decided here"), and cites those that are.

## The decisions it carries out

- **Extension is per store, and no schema object is shared across stores** ([Schema extension, Decided,
  23](../../SCHEMA_EXTENSION.md#decided)): "MBSE does not currently support cross-store references for any kind or any
  purpose, for now, period." There is no framework store and no `Builders.extend`.
- **What leaves mbse-schemas** (Schema extension, Decided, 5 to 7, 14): `requires`, `OfApply` and its arguments
  (`ArgumentTerm`), `Form` and terms in schemas, a scalar's `bits` and `bytes`, and the value parameters, all to
  mbse-expressions or mbse-patterns.
- **Object identity** ([Object identity, Decided](../../OBJECT_IDENTITY.md#decided)): `Schema@Path/Suffix`, a container
  (a module, or another named reference object; the schema by default) and a suffix; `store.Instances.<path>
  .as_instance(suffix)`; `Schemas.OfIdentity` an object.
- **P-015** (mbse-basis): a concrete reference is programmatic; `as_instance` "is the one and only one api location
  where the identity of an object can be used to reference the object".

## Levels

As the user confirmed ("that is correct and worth recording as you explained"), the terms of this plan:

| Level | Example | What it is |
|---|---|---|
| 0 | a contact, the int `3` | data |
| 1 | `Contact`, `OfInt`, a predicate `AtLeastOnePhone` | schemas, instances of level 2 |
| 2 | `Schemas.OfObject`, `Schemas.OfScalar`, `Schemas.OfPredicate` | the plain schemas of schemas, whose instances are schemas |
| 3 | `Schemas.Meta.OfObject`, ... | the meta-schemas, describing level 2 |

Level 3 is code: "meta-schemas return to being completely static dataclasses, never read or written just exchanged by
reference". A level-2 schema refers to its level-3 dataclass as an object refers to its class; no store holds one, so
their being one per process does not share a schema object across stores (Schema extension, Decided, 23).

What mbse-schemas has called the meta-schemas until now (`Builders.Meta.Object`, named `Schemas.Object`, and so on) is
level 2. **Every extension adds to level 2, never to level 3**: `HasDomain` adds `domains` to `Schemas.OfScalar`,
mbse-patterns' `requires` an adjacency to `Schemas.OfPredicate`, each a plain schema; no meta-schema is extended. An
extension of level 2 still changes the members a level-1 object has (`OfInt.domains`), through its builder (Schema
extension, Decided, 18), per store.

## Decided here

As the user decided (2026-10-16), on the questions put to them:

1. **The meta-schemas (level 3) are one for each kind of schema**, static dataclasses (Levels): "the only meta-schemas we should have are:
   stores.Meta.OfX for every OfX in stores.Schemas.OfX", reached as "`store.Schemas.Meta.OfX`" ("is correct"):
   `store.Schemas.Meta.OfObject`, `.OfScalar`, `.OfRelation`, and so on, each a store's own, each describing the plain
   schema (level 2) of the same name, `Schemas.OfObject` and so on.
2. **No base of every kind**: "`Meta.Schema` becomes `store.Schemas.Meta.Schema`", then, asked what it would be for:
   "`Schemas.Meta.Schema` - unnecessary, I hope". `Meta.Schema` goes.
3. **`Meta.Type` and `Meta.Typed` leave mbse-schemas**: "these can be defined using builder DSL as normal (not meta)
   union schemas in Expressions.Framework".
4. **A union's branches and an intersection's parts are relations**: "`Meta.Member` -> relation meta-schemas" `HasBranch`
   and `HasPart`, each entry carrying the member's name and description and linking its type.
5. **Properties stay objects**: "properties remain an object because they can have a description too".
6. **Modules are an ordinary schema**: "`Meta.Module` : normal schema `Schemas.OfModule`", which is also the namespace
   of identities (Object identity, Decided, 2).
7. **`Argument`, `Term` and `Form` go** in this overhaul: "drop whenever you think is best".
8. **The basic scalars are the five instances of `Schemas.OfScalar`**: "normal schema `Schemas.OfBool`,
   `Schemas.OfBytes` ... which become variants of `Schemas.OfScalar`", read with the levels ("yes"): each a level-1
   schema, an instance of the plain schema `Schemas.OfScalar` (level 2), which has exactly these five. They type scalar
   data: a property, a container's index and element, an entry property; decoding, validation and comparison;
   codegen's host types; and the `schema` end of mbse-expressions' `HasDomain`.
9. **Every finer scalar is a domain, in mbse-expressions**: "all scalars are domains and users may define domains and
   dialects containing domains"; "a scalar schema can have > 1 domain"; "width is a property of the domain, not the
   schema". A user defines no scalar schema of their own.
10. **Each kind declares an adjacency a module links**: "2 = (i)": a module's `schemas` adjacency is declared on each
    kind, not once on a base of every kind (which would need a union to declare adjacencies).
11. **Building and serialization stay as they are**: "building / serialization should be almost untouched other than
    identity itself".
12. **A type parameter is applied by binding it**, not by `OfApply` ([Parametrics](../../PARAMETRICS.md)), in two
    steps:
    - `store.Parameters.Bind(lambda b: b.target(positive).formal(Symbols.T).actual(...))` "constructs an object and
      returns it. The object represents the substitution without actually applying it": one parameter, its `formal`,
      and the value bound to it, its `actual`.
    - "`store.Transforms.Apply(bound: store.Parameters.Bind)` does the actual substitution work", named
      `Parameters.Apply` ("make it `Parameters.Apply` instead of `Transforms.Apply`"), giving a new object of the
      target's kind: a schema bound gives a schema (`List[T]`, a list of ints), a function a function.
    - It finds the parameter "using schema-unaware traversal, of course": the visitor protocol's `as_properties` and
      `as_adjacencies`, through the target's own structure.
13. **`Schemas.Meta` is a module**, holding the meta-schemas as its instances: "Make `Meta` a module, put the meta schema
    (as instances) underneath it", "Actually `Schemas.Meta`". A meta-schema's identity is `Schemas.Meta/OfObject`, its
    container the module `Schemas.Meta` (Object identity, Decided, 2 and 3), and `store.Schemas.Meta.OfObject` reads it.
14. **Building is through the plain schema's own name**: "`store.Schemas.Object(...)` should be
    `store.Schemas.OfObject(...)`". Calling `store.Schemas.OfObject(lambda o: ...)` builds an object schema (level 1),
    an instance of `Schemas.OfObject` (level 2); the level-2 schemas are named `Schemas.OfObject`, `Schemas.OfScalar`,
    and so on, not `Schemas.Object`. A program reads a schema of level 2 or 3 to link or extend it: level 2 to extend
    (`Schemas.OfScalar`), never level 3. (This revises "(b)", chosen when level 2 and 3 were not yet told apart.)
15. **Reading a path gives the schema it names** ("yes"): `store.Schemas.OfInt` (level 1), `store.Schemas.OfScalar`
    (level 2); called, a path builds through it, as `store.Schemas.OfScalar(...)` does. So code links and extends
    schemas without `Builders.Meta`, and with no string (P-015).
16. **Code names a store's schema by the store's path**, "(a)": `.type([store.Schemas.OfInt])`, each use naming its
    store, rather than a path rooted in no store.
17. **One store, which registers by building**: asked what `register` does now and whether a store of proxies is still
    needed, "I agree Proxies.OfStore might also be redundant so merge into one": a store registers a named schema as a
    side effect of building it, `register` is no public API, and `Builders.Store` is the one store, a store of proxies
    being its implementation. No store registers another's schema (decision 23).
18. **`Stores.Combined` is deprecated**: "`Stores.Combined` can stay but it is deprecated", since it was made to reach
    objects of one store from another's roots, which decision 23 rules out.
19. **Reading a snapshot made with extensions the store lacks**: "Store that has different extensions than the snapshot
    should ignore any mutation sub-clause whose meaning is ambiguous without the missing extension. Ignored schemas and
    such should be collected during reading and available to the caller if desired." A store never writes the schemas it
    was made holding, so an extension's additions to them are what a snapshot cannot carry: a property such a schema
    lacks, a property of an entry of such a relation, and an entry no linked object can hold where one of them is of
    such a schema are ignored, each kept, with its path and why, in the list given to `Snapshot(log, ignored)`. What an
    extension builds is written and read like any schema; a member another schema lacks is still a malformed snapshot.
20. **A schema's parameters are names only**, "Names only (Recommended)": a parameter is a declared name (`T`), a
    symbol (P-015) standing for a schema; its `type` goes with the value parameters, which move to mbse-expressions, and
    `Parameters.Bind` and `Parameters.Apply` (12) bind parameters later.
21. **`Schemas.Meta` is deferred**, "Defer it (Recommended)": nothing reads level 3 yet, so 13 is built when something
    needs to name a meta-schema.

## Order of work

Each step lands on main as its own release, with both gates at 100%, the corpora regenerated and conformance passing,
so that main stays current and no branch waits on another.

1. **Per-store schemas of schemas (0.14.0).** A store builds its own level 2, its basic scalars and its mutation
   schemas when it is made (level 3 is static code), and the module-level `Builders.Meta` goes. The level-2 schemas are
   named `Schemas.OfX` and built through them (14); a path given where an object is expected is the schema it names,
   and `as_schema()` gives it (15, 16). A builder of a level-1 schema finds its members through its store's level-2
   schema, so the members an extension adds (Schema extension, Decided, 18) are each store's own, not added to a shared
   class. `Builders.extend` and the framework store go; `store.extend` is the only extension, and the schemas a store
   was made holding change only through it (their entries are the store's own, as 0.12.1 kept them). EXT is
   rewritten: an extension extends one store, and round trips between stores with the same extensions.
   `Meta.Schema` goes with `Meta.Type` and `Meta.Typed` in step 2, the abstract bases together.
   *Breaks*: every `Builders.Meta.X` (386 uses in 86 files: library, tests, tutorials, the skill, docs), every
   `Builders.extend`, `Schemas.OfX.Schema`, the module-level mutation schemas (`Mutations.Log`, ...), and every call that
   builds a schema, `store.Schemas.Object(...)` and its kin (1854 in 87 files), which becomes
   `store.Schemas.OfObject(...)`; the wire's schema keys (`Schemas.OfObject/crm.Contact`).
2. **What leaves (0.17.0).** `Argument`, `Term`, `Form`, `OfApply`, `requires`, `bits` and `bytes`, and the value
   parameters (7; Schema extension, Decided, 5 to 7). `Meta.Schema`, `Meta.Type` and `Meta.Typed` go (2, 3), and
   `Schemas.Meta` (13) is built, holding level 3's names.
   *Breaks*: PAR (parametrics) and every test of forms, widths, applications and predicates' `requires`.
2a. **One store (0.15.0).** `register` leaves the public API and `Proxies.OfStore` with it (17); a test's "another
   store of the same schemas" builds its schemas there, or reads them from a snapshot. Steps 2 to 4 follow as 0.17.0 to
   0.19.0, after 0.16.0 (18, 19).
3. **Scalars and members (0.18.0).** User scalar schemas, `token` and `format` go (8, 9). Branches and parts become `HasBranch` and `HasPart` (4).
   `Schemas.OfScalar` has exactly the five instances (8).
   *Breaks*: every user-defined scalar in tests, examples and tutorials; the module format of unions and
   intersections.
4. **Object identity (0.19.0).** `Schemas.OfIdentity`, containers, modules as namespaces (6), `store.Instances` and
   `as_instance`, `Schema@Path/Suffix` on the wire.
   *Breaks*: the snapshot format, so every corpus and every hand-written snapshot in the tests.

Then mbse-expressions redrafts its framework model on per-store extension (`Expressions.install(store)`, through
`store.extend`), with domains, dialects and `DefinesDomains` as the user described.

## Step 1, as built (0.14.0)

Each store is made holding its own plain schemas of schemas, basic scalars and mutation schemas (`Builders._plain`,
`Mutations.schemas`); `Builders.extend`, the framework store and the shared `Builders.Meta` are gone. A builder's
members are its class's and its store's extensions' (`_members_`, `_table()`), so an extension of one store is seen in
no other. A store refuses a change to a schema it was made holding outside `store.extend`. Paths are references by name
(`Proxies._Named` and `_deref`; TypeScript's `_named`), resolved where an object is expected: links,
`store.Schemas.OfX(existing, ...)`, a builder's original, and Plain's and Validators' entry points; `as_schema()` gives
the schema. Every store says which schemas it was made holding (`framework`), a store of proxies none, and
`Stores.Combined` takes a name each store holds for its own built-in as the first's. Tests, tutorials, examples, the
skill and the corpora are migrated; both gates are at 100%, the corpora byte-identical, and Node 22 to 26 and
portability pass.

Found while building it, for the user:

- **A schema registered in another store.** Settled by 17 (step 2a): no public `register`.
- **A snapshot read into a store without its extensions.** Settled by 19. (The domain "without its `schemas`
  adjacency" reported here was a misreading: the object looked at was a schema, not the domain, which kept its entry.
  What failed was a property an extension added to `Schemas.OfScalar`, refused as a malformed snapshot.)

## Step 2a, as built (0.15.0)

`register` is private (`_register`): a store registers a named schema as it builds it, and nothing else does. The store
of proxies is `Proxies._Store`, the implementation of `Builders.Store`, which is the one store; `Proxies.OfStore` is
gone. Tests, examples and a tutorial that registered one store's schemas into another now read them from its snapshot,
which writes a store's schemas (`Plain.FromPlain(other).Snapshot(Plain.ToPlain(store).Snapshot())`), and name the other
store's schemas by its paths (`other.Card`). Both READMEs' examples are rewritten in the canonical form.

Found and fixed while building it: a container selected through a schema builder with a callback writing nothing was
not written, so a set relation's `uniques` (one empty clause) was read back from a snapshot as an open relation. A
selected container is now written, empty until written further, as a proxy's is (SNP-05, BLD-06).

Found, for the user:

- **The dataclass adapter** builds its schemas outside any store, so its test registers them with the private
  `_register` until the adapter builds through a store's builders (TODO.md).
- **An empty inner container read into an object that exists** is treated as omitted and keeps what the object held
  (`[[], ['b']]` read over `[['a'], []]` gives `[['a'], ['b']]`): reading into a store that holds the object merges
  element by element, and an empty container is not told from an absent one.
- **A store's snapshot fails on data it cannot write**: a value of any type holding a value object of an unregistered
  (unnamed) schema has no name to be tagged with, so `Plain.ToPlain(store).Snapshot()` raises for the whole store.

## 0.16.0, as built

`Stores.Combined` is documented as deprecated (18), with no runtime warning, which the two languages could not give
alike. `Plain.FromPlain(store).Snapshot(log, ignored)`, and `JSON.FromJSON` and `YAML.FromYAML`'s, ignore what 19 says
and add each to `ignored`, where given, as `{"path": ..., "reason": ...}` (TypeScript's `Plain.Ignored`): EXT-05 reads
an extended store's snapshot into a store without the extension, and SNP-05 a property `Schemas.OfObject` lacks, now
ignored where it was refused.

## Step 2, as built (0.17.0)

Parameters are names only (20): `OfParameter` has a `description` and no `type`. `OfApply`, `Argument`, `Form` (and
its `Term`), a scalar's `bits` and `bytes`, a predicate's `requires`, `Schemas.structure`, `Schemas.Evaluate` and
`Schemas.equivalent` are removed, with their relations; so are the abstract bases `Schemas.Schema`, `Type` and
`Typed`: each kind declares its own `name`, `description` and `parameters`, and each declares the adjacencies of every
relation it is at an end of (10), so a type's six anonymous adjacencies are each its own. `Schemas.Meta` is not built
(21). Two changes follow from the removal:

- A property an extension adds holds a container where its type is one, as a term's `attributes` did; BLD-06 now
  builds its map-valued property, and a template matching one by value, through `store.extend`.
- A refinement's scalar narrows by token alone, and `refines` of something not a type is reported as "refines
  something not a type" (it was "refines nothing", an application of nothing).

PAR keeps two cases (declaring and writing parameters); `Check`'s outcome moved to VAL-16. The corpus's `module` group
keeps its parametric schemas, with parameters as names, and loses its widths, applications and `requires`.

## Open, for the user

1. **Deferred: when a binding is applied.** "I don't think we need to force the issue of eager or on-demand binding":
   whether `Parameters.Apply` is a record in the store or an operation, and so when a `Parameters.Bind` takes effect,
   is left open. Under object identity (step 4), a path's builder given an identity the store holds visits that object,
   and otherwise makes one; the present code clones on `store.crm.Contact(obj)` until then.
2. **Scalars without tokens.** Each basic scalar maps to each language's host type by its own name, so `token` is not
   needed for them; with user scalar schemas gone, `format` (dates, UUIDs) becomes a domain. Agreed?
3. **When `Schema@` is inferred.** "omit `Schema@` when it can be inferred from context": I propose where a link's
   other end has one schema that may fill it, and within an object's own entry, which names its schema.
4. **A path given to a link.** Your `e.domain(Int32)` passed a path. With `as_instance`, a link is given the instance
   (`e.domain(store.Instances.Expressions.Dialects.Basic.as_instance('Int32'))`); should a link also accept a path to
   an instance?
5. **The order.** Four releases, as above, or fewer, larger ones?
