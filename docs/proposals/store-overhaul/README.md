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
- **Object identity** ([Object identity, Decided](../../OBJECT_IDENTITY.md#decided)): `Schema@Path/Suffix`, a module
  path (the schema by default) and a suffix, `Schema@` written only in `Exists` (Object identity, Decided, 8); `store.Instances.<path>
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
    module path `Schemas.Meta` (Object identity, Decided, 2 and 3), and `store.Schemas.Meta.OfObject` reads it.
14. **Building is through the plain schema's own name**: "`store.Schemas.Object(...)` should be
    `store.Schemas.OfObject(...)`". Calling `store.Schemas.OfObject(lambda o: ...)` builds an object schema (level 1),
    an instance of `Schemas.OfObject` (level 2); the level-2 schemas are named `Schemas.OfObject`, `Schemas.OfScalar`,
    and so on, not `Schemas.Object`. A program reads a schema of level 2 or 3 to link or extend it: level 2 to extend
    (`Schemas.OfScalar`), never level 3. (This revises "(b)", chosen when level 2 and 3 were not yet told apart.)
15. **Reading a path gives the schema it names** ("yes"): `store.Schemas.OfInt` (level 1), `store.Schemas.OfScalar`
    (level 2); called, a path builds through it, as `store.Schemas.OfScalar(...)` does. So code links and extends
    schemas without `Builders.Meta`, and with no string (P-015).
16. **Code names a store's schema by the store's path**, "(a)": `.schema([store.Schemas.OfInt])`, each use naming its
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
22. **A scalar has no `token`, `format` or `refines`**, as the user chose (2026-10-16): "Drop both (Recommended)",
    `token` and `format` leave `Schemas.OfScalar`, and each basic scalar maps to each language's host type by its own
    name; a format (dates, UUIDs) becomes a domain in mbse-expressions (9). With exactly five scalars a scalar has
    nothing to refine, so `refines` leaves `Schemas.OfScalar` too, "Yes, remove it (Recommended)"; objects and
    containers keep it.
23. **A user scalar in tests, tutorials and examples becomes the basic scalar**, "The basic scalar (Recommended)": a
    property typed by a user scalar (an `Email`, a `Date`) is typed by the basic scalar it refined (`Schemas.OfStr`),
    the finer meaning moving to the property's description; a case that teaches scalar refinement is rewritten or cut.
24. **Schema, never "type"**, as the user decided (2026-10-16): "the term "type" has no meaning in mbse-*", and "it looks
    like you are using 'type' in multiple places where it really should be 'schema'". What has a schema names it
    `schema`: the builders' `.schema([X])` becomes `.schema([X])` (a property, a symbol, a branch, a part), the data's
    `type` field `schema`, `OfAny`'s `types` `schemas`, and `Schemas.HasSchema`, linking `typed` to `schema`, becomes
    `Schemas.HasSchema`, linking `member` to `schema`; messages and documents say schema. A host language's own type
    (`OfScalar.Data.type`, `host()`: Python's `int`, TypeScript's `BigInt`) stays, qualified as the host's.

As the user decided (2026-10-22), on what remains after 4i, item by item as they answered it:

25. **Step 4's goal**: "Our main goal right now is to stabilize mbse-schemas to allow schemas, models, and code to be
    developed. That should be the goal of step 4."
26. **Step 5 ports the dependents**: "If we do not have a step 5 defined yet, it should be focused on porting all of
    the `mbse-*` dependencies over to the stabilized `mbse-schemas`." The dependents leave 4h for it.
27. **Deferred**: subsequent snapshots and optimizing the installs' size ("1, 3. correct, defer"). Deleting an object
    no entry owns, and the meta-schemas as linked objects (META_SCHEMAS.md, phase 5) with generated code (phase 6):
    "not sure the case exists, will exist, or should exist". 4j removes entries only: "4j : implement removing
    entries, but defer deleting objects to a later phase".
28. **Bindings are lazy**: "parameter, argument bindings of any kind are super lazy", settling Open, 1, when a binding
    is applied.
29. **Where constraints attach** (FRAMEWORK.md, Open questions): "not built yet, coming soon". Parametrics beyond what
    is built "needs design, may come up after" it.
30. **Open-world modeling, parametrics and the meta-schemas as linked objects** (FRAMEWORK.md, Open questions;
    META_SCHEMAS.md): "needs design, not particularly urgent at the moment".
31. **4l: the dataclass adapter writes an install** ("sounds good"), so that it depends on the transaction's spec, not
    on the builders 4k rewrites, and may be built before 4k. It is called inside the caller's own module-scope
    install, which gives it the transaction, its uid set by the caller:

    ```python
    def install(txn):
        """The order-entry schemas, read from their dataclasses."""
        return FromDataclass.install(txn.uid("models/1"), lambda m: m.name("models"), Order, Line)
    ```

    `FromDataclass.install(txn, module, *classes)` returns `txn.mutations([...])`, as a written install does. `module`
    is a `Specs.Callback[Visitors.OfObject]` written on the module's symbol, of `txn.Schemas.OfModule`, found by its
    name or made, as a snapshot's module is (4f-6); the adapter adds an entry of its `schemas` for each class, linking
    the class's symbol under the class's name. Each class, and each relation the adapter infers, is a symbol of the
    install, since a definition in place is linked once only (Installing schemas, Decided, 4). Called outside a
    transaction, a factory returning an install, was offered and set aside: it departs from the module-scope
    `install(txn)`, has no transaction to name the store's schemas from, and would make up the uid.
    `FromDataclass.model(...)`, which returns schema objects made outside any store, goes: "yes remove
    FromDataclass.model". The order: "Do 4j, 4l, then release".

As the user decided (2026-10-26), on 4k, after a survey of how schema objects are read (about 300 field reads in each
language; the public read API, `as_schema()`, `store.registered(...)` and field reads, unchanged by any option short of
retiring the dataclasses):

32. **The commit-time rule is kept, and 4k is tech debt**: "yes keep the commit-time rule and log 4k as tech debt". A
    change to a schema object that existed before a transaction is seen only once that transaction commits (Object
    identity, Decided, 96, now the lasting rule, not a limitation awaiting 4k); data that uses the change is written in
    a transaction after it, as an install's data and a snapshot's (Decided, 101) are. Reading schema objects through the
    store (the survey's options: through read-only builders; schema objects as store data; or schema state copied on
    write through `Visitors.OfStore`, with what a user's own reads see within a transaction) is tech debt, internal,
    to be done without changing that rule (TODO.md). Step 4 so ends with 4h.

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
3. **Scalars and members (0.18.0).** User scalar schemas, `token`, `format` and a scalar's `refines` go (8, 9, 22, 23). Branches and parts become `HasBranch` and `HasPart` (4).
   `Schemas.OfScalar` has exactly the five instances (8).
   *Breaks*: every user-defined scalar in tests, examples and tutorials; the module format of unions and
   intersections.
3b. **Schema, never "type" (0.19.0).** The rename 24 lists, in both languages, messages and documents included.
   *Breaks*: every `.schema([...])` (1671 in 126 files), `OfAny`'s `types`, the wire's `Schemas.HasSchema` entries and the
   `HasBranch` and `HasPart` link, and every message that said type.
4. **Object identity, patterns and mutation expressions.** As [Object identity](../../OBJECT_IDENTITY.md) (Decided, 1 to
   63) and [Mutations as queries](../../STREAMING_QUERIES.md) now describe them: three modes of identity (a singleton by
   its global name, an owned object by its path, a counted object by nothing beyond a document, or, created by an
   upsert, by its frame, key and symbol); patterns (`Schemas.OfPattern`) replacing predicates; mutations as expressions
   over streams of frames, every write in a transaction; `as_identity` gone. Worked on the branch `object-identity`,
   landed on main when released. Its goal, as the user set it (2026-10-22, Decided, 25): "to stabilize mbse-schemas to
   allow schemas, models, and code to be developed".
   *Breaks*: `HasInstance`, `OfObject.pattern`, `store.Instances.<schema>(keys)`, `as_identity`; every write outside
   `store.mutation` (about 1200 build calls in 214 cells of the Python notebooks alone, and as many in TypeScript's, the
   tutorials, examples, skill and README included); `Schemas.OfPredicate`; the mutation vocabulary (`Exists` and the
   relation verbs go); the snapshot and Reachable formats, so every corpus; and in the dependents, mbse-patterns (built
   on `OfPredicate`), mbse-expressions' and mbse-programs' corpora.
   In stages, each committed with both gates at 100% and pushed to the branch:
   - **4a, the vocabulary** (done, on main): `owner()`, `.pattern(...)` on key properties, the path schemas, a path on
     demand.
   - **4b, data objects by path** (done, `1513108`, on the branch): ownership filled at build, lookup by keys, paths on
     the wire. Decided 37 to 63 reverse part of it, which 4c undoes.
   - **4c, the three modes in memory** (37, 40, 41, 43, 47, 48, 55; done, on the branch, released as 0.20.0):
     `HasInstance`, `OfObject.pattern`, the `local-name-N` keys, the directories and `store.Instances.<schema>(keys)` go;
     an object whose schema declares no `owner()` is counted, held only by what links it, the language collecting it;
     `as_identity` goes; validation refuses an `owner()` adjacency a counted schema can fill; removing an owning entry
     deletes the owned object, cascading. On the wire, still 4b's format: a counted object is numbered within the
     document that writes it, `{"$ref": {"n": ...}}`. Tests whose root-level objects must be found move them under a
     singleton directory. As built:
     - an object is counted where its schema is no singleton and declares no `owner()` adjacency. `Paths.of` refuses
       it ("a 'X' is counted: it has no path"), and `store.Instances.<name>` gives singletons only, refusing a call ("no
       singleton named 'X': an owned object is found through its owners' adjacencies, a counted one only through what
       links it");
     - `as_identity` goes from data, value objects, their builders and link members, and `Stores.Store.restore` with
       it; schema builders keep theirs until 4g. A proxy is told apart in memory by a serial number, never written;
     - nothing is owned by a counted object: an entry that would make one an owner is refused when it is added, and
       `Validators` reports a counted schema's adjacency that another schema's `owner()` adjacency makes an owner;
     - removing an owning entry deletes the owned object when the outermost write ends, unless it is owned again by
       then: every entry it is in is removed, so in turn what it owned. A refused write leaves nothing pending for the
       next;
     - a document numbers counted objects `{"n": k}` in the order it meets them from the root, which is 0, lists them
       `{"n": k, "schema": ..., "properties": ...}` and refers to them `{"$ref": {"n": k}}`; reading always makes them
       anew, even in the store that holds the originals. A log numbers them in the order it defines them, and writes
       only the data its singletons reach; the conformance corpus holds each case's data under a singleton,
       `Corpus.Root`, so. YAML quotes the key `'n'`, which a YAML 1.1 reader takes for false;
     - the tutorials retell case study 6 with counted contacts and addresses, numbered, and point to owned objects for
       lasting names; case study 8's audit log labels linked objects by their values.
   Done in this order, so that `Schemas` is stable early (Object identity, Decided, 68): 4d, 4g, then 4e and 4f.
   - **4d, patterns** (STREAMING_QUERIES.md, Patterns and Spec; Value expressions and constraints; Object identity,
     Decided, 66, 67, 76 to 78): `Schemas.OfPattern`, `OfVariable`, `OfExpression` and its boolean variant `OfConstraint`
     (placeholders mbse-expressions refines), `OfCollector` (rejected by validation where it declares neither
     `.commutative()` nor `.associative()`, 62); built, validated and written as every schema is. `Schemas.OfPredicate`
     goes (67). A symbol is found as a singleton by its schema, or through its pattern's `spec` (76, 77), which
     replaced the locators a first build made (64 to 75, superseded). Done, released as 0.21.0; `spec` is built in 4e, with the
     mutation builders that record it. As built
     (FRAMEWORK.md, Resolved, Patterns, has the choices made for the user's review):
     - the meta-schemas `Schemas.OfPattern`, `OfVariable`, `OfExpression` and `OfCollector`; the relations
       `Schemas.HasVariable`, `Requiring`, `Matching`, `Resulting` and `Computing`, `HasSymbol` now a pattern's;
     - `store.Schemas.OfConstraint(...)` builds an expression of the store's `OfBool`; a pattern's `requires` builds
       constraints, which it owns; a collector's names are text lists, its `suffixes` a map;
     - the corpus's `module` case has a pattern with a variable and a constraint, an expression and a collector in
       place of its predicate; the suite PAT tests them, in both languages.
   - **4g, schema objects** (17, 29, 69, 70, 80, 81, 82): a named schema's identity is its path, and its members' paths
     continue it; derived identities go; an unnamed schema has no identity, and is written nested in the one object that
     links it; an unnamed schema linked from more than one place is refused; a value schema may hold itself (82,
     superseding 72); schema objects' keys on the wire become paths. `as_identity` leaves the schema builders. Done,
     released as 0.21.0. As built:
     - a path is a `Paths.OfRoot` value from the root module, the singleton `"."`, through each module and then the
       schema by name (`{"i": "schemas", "o": "", "properties": {"name": ...}}`), then through the keyed adjacency that
       owns each member (`properties`, `adjacencies`, `parameters`, `symbols`, `variables`, `links`). `Paths.of(x)` gives
       a schema object's as a data object's; one with no name of its own, or what it holds, or one no store holds, has
       none (`LookupError`). `store.held(path)` takes the value or its plain form; `B.identity_of`, the schema builders'
       `as_identity` and the store's identity table go;
     - the store records, as it holds a schema object, what links each object it links that has no name of its own,
       refusing a second ("... with no name of its own is linked by one schema object alone, and another links it
       already: name it to share it"); a clone has its own of each. A name is registered once, of any kind, and a module
       and a schema do not share a path ("the path 'crm.Contact' names another schema object already"), so tutorial 9
       and the skill version as `crm.v2.Contact` (Object identity, Decided, 83);
     - `validate()` refused a value schema that holds itself (72), which made the framework's own `Paths` and
       `Mutations` invalid; 72 was then removed (82), and a value schema may hold itself again;
     - a log refers to a schema object by its path and defines it by its path, its kind and its properties
       (`Mutations.OfObject.Def`, as it was then); a member's `exists` places it in its owner at once, as an owned data
       object's does. One with no name of its own is defined where it is linked, by the link's
       `Mutations.OfObject.Def` (its kind, its properties and its own entries), its own entries nested in it, each leaving out the link it fills. Read again, a log makes nothing: a
       nested definition is made where the object it is written with is new, or held no such entry before. The
       corpora grow about threefold, every reference to a schema object now a path, until 4f replaces the log;
     - tests, examples and the corpus name the schemas they share, and SNP-02, BLD-03 and BLD-10 test paths in
       place of identities.
   - **4e, mutation expressions and the in-memory executor** (38, 42, 44, 46, 50, 56 to 63; done, released as 0.22.0): the mutation vocabulary as
     Decided 59 nests it, `Mutations.OfTransaction` → `Mutations.OfTerm` (`OfMap`, `OfReduce`, `OfPartition`,
     `OfUpdate`, `OfUpsert`) → `Mutations.OfPattern` → `Mutations.OfObject` → `Mutations.OfAdjacency` (`OfEntry`) →
     `Mutations.OfProperty`, `Exists` and the relation verbs gone; `store.mutation(cb)`, its builders those a property
     call with a callback gives (58); a sequential executor over frames, upserts finding owned objects by path (60) and
     counted ones by frame, key and symbol through a weak index (61, 63); a transaction that raises undone entirely; every
     write outside one refused (44), so every caller moves into transactions here. In two stages (88), 4e-1 in three
     commits, each with both gates at 100%: the vocabulary and specs, the overlay (89, 96), and the executor with
     `store.transaction`. The first, as built:
     - a kind union (97): a link's schema may be a union of reference object schemas; the peer shorthand's visitor and
       an entry builder have its branches as members, each building an object of its kind through the link, or linking
       one given. A link that declares a reference object schema builds that one, and a data link to a schema object
       (a term's pattern) builds it with its meta-schema's builder (`Store._meta_builder`);
     - mappings for keyed adjacencies (FRAMEWORK.md, Resolved), in the schema builders, the proxies and specs;
     - the terms (93): `Mutations.OfTransaction` (`uid`, `mutations`), the kind union `Mutations.OfTerm` (`map`,
       `reduce`, `partition`, `update`, `upsert`), `OfMap` and `OfReduce` (`symbols`, `variables`, `then`),
       `OfPartition` (`first`, `last`, `branches`, `none`, `then`), `OfBranch` (`requires`, `then`), `OfUpdate`
       (`apply`, `then`), `OfUpsert` (`key`, `exists`, `then`), each a reference object linked by a relation
       (`Mutations.HasRoot`, `Then`, `MapsSymbols`, ...); a reference may name a symbol;
     - a store holds a schema object with no name of its own weakly, and what links one weakly too (94);
     - `PatternBuilder.spec([...])`: each callback given the frame, its symbols recording visitors (`Transactions`),
       its record, a `Mutations.OfPattern` as plain data, kept in the pattern's `spec`; a link refers to a symbol, a
       path, or an object it defines (`Mutations.OfObject.Def`). It is not written in a log until 4f.

     Settled while building it, for the user's review: `map`'s and `reduce`'s `as_symbols` and `as_variables` (91) are
     `symbols` and `variables`, since a schema member may not start with `as_` (the visitor protocol's); a spec is
     recorded per symbol as `as_property` and `as_adjacency` members, an adjacency's `insert` entries leaving out the
     object's own link, rather than through relation-level verbs.

     The second, as built: the overlay (89, 96), opened by `store._transacting()`, which `store.transaction` will use.
     - While it is open, a data object's property values and entry tables, a value object's values and a store's
       framework entries are read from a copy, made when first written; the copies are written into the objects when it
       commits, and dropped where it raises.
     - A builder's update of a schema object the store held when the transaction began is checked for what it would link
       (81), and applied when it commits, in the order first deferred. A later builder of that object begins from what
       the one before it made. A schema object the transaction created changes at once.
     - Where it raises, or an update at commit is refused, the store's registries (schemas, singletons, key numbers,
       modules, placements, the objects it holds, named or not) are restored, and the updates applied at commit undone.
     - It refuses a transaction within one (50). The decoders (`Plain.FromPlain`, a log's reader) each write in a
       transaction of their own (90).

     The third, as built: `store.transaction(spec)`, `spec` a `Mutations.OfTransaction` or a callback building one, and
     a sequential executor (`Transactions`).
     - Before it writes anything, it checks the expression: each term refers only to symbols a term before it binds
       (85), the symbols after a partition being those every branch binds; and it refuses expressions (87): a pattern's
       `requires` and variables, a map's or a reduce's `variables`, a reduce that collects (`suffixes`, `computes`), a
       branch's `requires`, a partition both `first` and `last`.
     - Its stream starts as one frame, empty, and each term makes the frames it passes on through `then`; it gives the
       frames its chain ends with, each the objects its symbols bind, by symbol (a dict; a `Map` in TypeScript). It
       runs in the overlay (stage two), so that a transaction that raises writes nothing.
     - A map binds each symbol its frame lacks, in the order the pattern declares them, to every object of its schema
       that the store reaches from its singletons (`store.extent`) and whose spec holds, one frame each; a singleton's
       symbol binds the singleton (77). While a symbol is bound, the spec's entries that link a symbol not yet bound
       are left out; the frame is then checked against the whole spec.
     - An upsert binds the same way, and where nothing is found, creates the object. A counted object it created from
       the same frame, for the same symbol and `key`, it finds again first, through a weak index (63); an owned object
       is found by the spec's entries in its owning adjacency, where the spec gives one there (60). It then writes its
       spec over each frame where it does not hold.
     - An update writes its spec over each frame where it does not hold: a property's value set or cleared, an entry
       added where none it holds matches, replacing the one entry an adjacency holds at most, and an object an entry
       defines (`def`) made.
     - A reduce drops its collector's symbols, keeping each frame left once. A partition runs every branch, none
       requiring constraints yet, or its first or last; its `none` where it has no branch; and passes what they end
       with, joined, to its `then`.

     Settled while building it, for the user's review: a symbol of a schema object, which 86's `install(txn)` needs,
     was refused at first, and became a stage of its own before 4e-2 ("yes, proceed"); a map finds only what the store reaches from its
     singletons, so a counted object linked from none (a term, a note no one links) is found only by the upsert that
     made it; an upsert that finds several objects binds each, as a map does.

     The fourth, as built: schema objects in transactions (86). A symbol may be of a meta-schema
     (`store.Schemas.OfObject`, `OfRelation`, ...); it ranges over the named schema objects of that kind the store
     holds, the framework's left out. The executor reads every object through its visitor, a schema object's builder,
     read-only, which sees what the transaction open has made of it (96), and data's proxy; it writes a schema object
     through its meta-schema's builder, whose update of one that existed waits for commit. An upsert finds a schema
     object by the name its spec gives, as it finds an owned object by its owning entry: a module's install, run again,
     finds its schemas and extends them where the spec gives more. A symbol's schema is given as the store's
     (`store.Schemas.OfObject`), not yet `txn.Schemas` (78).
   - **4e-2, every write within a transaction** (44, 98), as built so far:
     - a transaction's imperative scope (98): `with store.transaction():` in Python, `store.transaction(() => ...)`
       given a function of no arguments in TypeScript, which gives back what the function returns; builders write
       within it as anywhere, in the overlay, all or nothing; one within another is refused;
     - a write outside a transaction of its store is refused ("a store is written only within a transaction
       (store.transaction)"), checked where a reference object's values or an entry table is first written, and where
       a schema object is held; exempt are building a transaction's expression, `store.Mutations.*` (94), making the
       store, and a transaction's commit;
     - the library's own writes join the transaction open, else open one of their own: the decoders (90), whose writes
       are now all within it;
     - `store.extend` is a transaction of its own, committed before the extension ends, so that what it changes in the
       schemas the store held is checked as an extension's when it is written; refused, it writes nothing;
     - every caller writes within transactions, in both languages: the corpus builders, the examples, the tutorials
       (tutorial 1 introduces them, tutorial 2 says why a schema that existed changes when its transaction ends, and
       tutorial 9 makes a schema change as a transaction's expression), the skill and every suite. A test's fixture is
       one transaction; where a case reads a schema it changed that existed before (96), or what ownership settles
       when a transaction ends, each write has a transaction of its own; another store's writes have their own.
       While the callers moved, the refusal was behind a switch, removed with the last of them.

     Settled while building it, for the user's review: a decoder within a transaction joins it, so that a refused
     decode there leaves what it wrote before the refusal to the transaction, which the caller may let raise (4e-3
     makes the join a savepoint, which drops it). One transaction was first open at a time across every store; each
     store has its own now (Decided, 99), its overlay kept on the store.
   - **4e-3, `Visitors.OfStore` and `Proposals`** (Object identity, Decided, 100): `Stores.Store` renamed
     `Visitors.OfStore` and `Proxies._Store` `Proxies.OfStore`; every data access through the protocol; the overlay
     refactored into `Proposals`, which implements it over a store or over another `Proposals` (a savepoint), the
     decoders writing within a savepoint of the transaction open. Tech debt, retained: schema objects are read field by
     field, outside the protocol. As built:
     - `Visitors.OfStore` adds `values(holder, write)` and `entries(holder, write)` to the catalog's methods: an object's
       property values, and its entry tables by relation and then by key, as the store has them; `write` asks for them
       to write, which only a transaction may. `Proxies.OfStore` gives them through the proposals open on it, else
       through what it holds as committed (`_committed`: each object's own values and tables, and the entries linking
       the schemas it was made holding, which it keeps itself); every read and write of an object's data, a proxy's,
       an entry's, a decoder's, the executor's, goes through them. `Stores.Combined`, deprecated, refuses both: an
       object's data is its own store's;
     - `Proposals.OfStore`, a module of its own in both languages, holds a transaction's writes over a base, what the
       store holds as committed or other proposals: a holder's values and tables are copied from the base when first
       written, and read through to it until then; the catalog's methods are the store's. Committed, a transaction's
       applies the schema updates that waited (96) and writes into the store; a savepoint's writes into its
       transaction's proposals, its waiting updates added to theirs. Aborted, the store's registries are restored to
       where the proposals began, and the ownership left to settle truncated there;
     - `_joined` (the decoders', the adapters') opens a transaction where none is open, else a savepoint, so that a
       refused decode within a transaction leaves it as it was. The decoders check what they are given before writing,
       so the savepoint is what keeps it so as they change;
     - TXN-12 covers the proposals and savepoints, STO-06 the combined stores' refusals; no corpus changed.
   - **4f, the wire** (45, 51, 55, 56; done, released as 0.22.0): a store's snapshot is made of transactions; a journal holds transactions as
     submitted, replayed by executing them; a Reachable document is one transaction, its counted objects numbered within
     it, owned objects and singletons referred to by path. The corpora are regenerated, the JSON byte-identical between
     the languages.

     Proposed and approved (Object identity, Decided, 101 to 103):
     - **A transaction on the wire is its expression, nested.** A document is read by executing it, so its own form
       cannot be a transaction: each term is written where the one before links it (`mutations`, `then`, `branches`,
       `none`), a relation of one other link written as that link's object, the peer shorthand the builders take; each
       pattern where its term links it, its symbols' schemas by path and its spec as recorded (Transactions):

       ```python
       store.transaction(lambda t: t.uid("6f1c4e2a-…").mutations([lambda m: m.upsert(lambda u: u.exists([lambda p: p
           .symbols({"book": Book, "ada": Person})
           .spec([lambda _: _.book.contacts({"ada": _.ada}), lambda _: _.ada.name("Ada")])]))]))
       ```

       (The example was first approved in its wire form; it is shown here as the builders write it, as the user asked:
       "Never use wire format in examples".)

       `ToPlain(store).Transaction(tx)` writes one, `FromPlain(store).Transaction(plain)` builds its expression, which
       `store.transaction(...)` executes. A journal is a list of them, replayed by executing each in order.
     - **The spec's verbs become the mutation schemas** (P-018: "ToPlain writes a log as it writes any value"): an
       object's `as_property` and `as_adjacency`; an adjacency's `insert`, `remove` and `clear`; an entry's `as_link`
       and `as_property`; a link's `set` (a `ref` by symbol or path, or a `def`) and `clear`; and the value verbs as
       they are. The log's top-level verbs go (`exists`, `as_property` with its `ref`, a relation's `insert`, `remove`,
       `clear` and `as_entries`, `Mutations.Log` and `Mutations.Reference`): what they wrote, a spec writes.
     - **A store's snapshot is two transactions** (101): the first upserts its modules and schemas, each a symbol of
       its meta-schema, found by name (86), a schema object with no name of its own defined where it is linked
       (`Mutations.OfObject.Def`); the second its data, each object a singleton reaches a symbol: a singleton's binds the
       singleton, an owned object's is placed by its owner's entry (60), a counted object's created. Schemas come first
       so that a schema the store held before is extended when the first commits (96), before data uses it.
       `FromPlain(store).Snapshot(transactions, ignored)` executes them in order, each a transaction of its own, or a
       savepoint of the one open; what an extension the store lacks gives is ignored and reported, as now (19).
     - **A Reachable document is one transaction** (51): one upsert whose symbols are the counted objects reachable
       from the root, the root first; owned objects and singletons it links are refs by path, not written, and reading
       aborts where one is missing. `ToPlain(...).OfObject` is the same with the root alone. Reading gives the root.
     - **A document's symbols are its numbering** (55): the objects it writes are symbols named by their number in the
       order it meets them, the root `0`, and a reference to one is its symbol (`Mutations.OfObject.Ref`).
     - **A counted object an upsert names is found only by what made it** (102): by the frame, key and symbol it was
       created for (61, 63), never by its spec, which 4e still does; a document's upsert is keyed by its uid, so reading
       one gives new counted objects (55), and replaying the same transaction while they are held finds them again.
     - **Imperative-scope transactions** (98) have no expression, so they have no form on the wire (103).
     - The corpora are regenerated, byte-identical between the languages; `ToPlain`/`FromPlain`'s entry points keep
       their names, and the decoders their savepoints.

     Built in stages: 4f-1, a counted object found only by what made it, and the spec's verbs as schemas; 4f-2, a
     transaction on the wire; 4f-3, Reachable documents; 4f-4, snapshots, the log's verbs removed and the corpora
     regenerated; 4f-5, pattern specs on the wire; 4f-6, modules in snapshots and an adjacency's `clear`.
     - **4f-1, as built**: an upsert finds a counted object only in what it made before, for the same frame, key and
       symbol (102), and otherwise creates one; TXN-06 shows a second note made beside one with its text. The spec's
       verbs are schemas beside the log's, which 4f-4 removes: `Mutations.OfObject` (`as_property`, and
       `as_adjacency`, `Mutations.OfObject.AsAdjacency`), `Mutations.OfAdjacency` (`insert` and `remove`, each a list of
       `Mutations.OfEntry`), `Mutations.OfObject.Def`'s `mutations`, and `Mutations.OfPattern`, a spec item, mapping
       each symbol to its object's mutations; there are 67 mutation schemas. MUT-06 builds a spec through them, reads
       and writes it as any value, and finds a pattern's record the same.

       Found while building it, for the user's review: a payload (a property's value) is written bare on the wire, in
       a spec as in the log, where its target's schema interprets it; its schema here is a value of any schema, which
       `Plain` writes tagged (`{"str": "Ada"}`). So a spec, like a log, is described by its schemas but not read
       through them as any value is; MUT-06 pins the difference. Reading a payload bare would need a value schema
       interpreted by another's, which no kind has. A pattern's `spec` is not yet a property of `Schemas.OfPattern`,
       so a snapshot left it out until 4f-5, which writes it.
     - **4f-2, as built**: `Plain.ToPlain(store).Transaction(tx)` writes a transaction's expression nested
       (SERIALIZATION.md, Transactions on the wire), generically from the schemas of its terms and of the schema
       objects they link; `Plain.FromPlain(store).Transaction(plain)` builds it through the store's builders, each
       nested object defined through its link by name (`e.branch(cb)`), its kind (`e.upsert(cb)`), or, where several
       schemas fill the link, its schema's builder (`{"Schemas.OfUnion": ...}`); a pattern's builder takes a spec as
       recorded. Every transaction the Python suite executes was, while building it, written, read back, written again
       the same and executed from what was read, with every case passing. The executor refuses, before it runs, a spec
       that removes entries or clears an entry's link or property, which only one read from the wire can give; a term
       linked from two places is refused when written. TXN-13 covers it.
     - **4f-3, as built**: `Plain.ToPlain(store).Reachable(schema, root, uid)` and `.OfObject` write a document, one
       transaction (SERIALIZATION.md, Documents), built as an expression and written as a transaction on the wire; the
       old `{"root", "objects"}` form and its decoder are gone. `FromPlain(store).Reachable` and `.OfObject` read it
       through `FromPlain(store).Transaction` and execute it with `Transactions._execute(store, tx, joined=True)`,
       within the open transaction as a savepoint, the root's schema checked within it. The reader checks a pattern's
       spec against its symbols' schemas before anything runs: each symbol the pattern's, each member's shape and name,
       each value decoded at its path, each reference to a symbol of the pattern, each path's shape; so a refused
       document writes nothing, and no builder is asked for before every value is checked (PLN-14). The executor
       matches equal entries one to one, the k-th a spec gives the k-th held, where it took any match. Tests read a
       document through `view` (and write one through `document`), test helpers; the examples through `members`. The
       README's example, which still wrote outside a transaction, writes within them. Findings F6 and F13 are resolved
       and PLN-11b, which pinned F13, goes.

       Settled while building it, for the user's review:
       - A document with no uid is keyed afresh by each read, so that reading it gives new counted objects (55), and
         two documents cannot share a counted object through the symbol `"0"`; one under a uid is keyed by it (102).
       - An object's document refuses a root linked to a counted object, which it could neither hold nor refer to; it
         was written with a dangling reference before. Its link to a singleton, an owned object or a schema object is
         a path.
       - A document holds what is reachable through the objects it holds: a counted object linked only through an
         owned object it refers to is not written, with that owned object's entries.
       - An owned root whose owning adjacency has no name is refused (`wts.Clause`): its document could not give the
         entry that owns it. A document of a schema the store does not hold, as the dataclass adapter's, is refused:
         it names schemas by path. DC-03 pins that until the adapter builds through a store.
       - Reading a Reachable document into a store without the owned objects it refers to refuses: a document carrying
         owned objects is a store's snapshot (51), which 4f-4 makes of transactions.
       - The read-time messages for an entry name the adjacency (`an entry of 'out' has no link 'colour'`), which an
         unnamed relation lacks.
     - **4f-4, as built**: `Plain.ToPlain(store).Snapshot()` writes two transactions (SERIALIZATION.md, Snapshots), each
       one upsert: the store's schemas, each named schema object a symbol of its meta-schema, an unnamed one defined
       where it is linked; then its data, each singleton and what the singletons reach, in the order met, a symbol.
       Each entry is written once, from the first symbol holding it. `Plain.FromPlain(store).Snapshot(snapshot,
       ignored)` executes them in order, each a transaction of its own or a savepoint of the one open, and gives the
       data the last binds. The log's writer and reader, and its verbs (`Mutations.Log`, `Reference`,
       `OfObject.Exists`, the relation verbs, `AsProperty`'s `ref`, `Def`'s `path`, `properties` and `inserts`), are
       gone: there are 60 mutation schemas. The corpora are regenerated, the JSON byte-identical between the languages.
       MUT, SNP, IDN-07 and EXT-05 are rewritten for them; every corpus store read back writes the same snapshot, which
       the old writer, kept as an oracle while building, confirmed.

       Settled while building it, for the user's review:
       - The executor finds a schema object an upsert names by its registered name, the store's own included, and
         creates one it does not find with that name, so that what links it before its spec is written links a named
         schema (86); a module's `install`, run again, relies on the same (4i).
       - An object owned through an anonymous adjacency (`wts.Clause`) is placed by its owner's entry that a symbol
         bound before it gives (60), found there or created.
       - A singleton declared on a schema after it was registered gets its instance then, as one registered with it
         does: a snapshot's schemas transaction declares it after the name.
       - A schema the store was made holding is a symbol only to write the entries of an extension's relations it
         holds, and then only its name and those entries.
       - Reading a snapshot always ignores what an extension the store lacks needs, reporting it where `ignored` is
         given. Since an entry is written from an end that holds it, what is ignored is now a member a schema the store
         was made holding lacks (`Schemas.OfScalar has no adjacency 'tags'`) or an entry's property such a relation
         lacks (`an entry of 'schema' has no property 'why'`); "no object an entry links declares an adjacency through
         which to add it" is gone.
       - What a snapshot read gives is its data, the singletons first: CONF-04 and the portability check validate the
         data but the corpus's root, which holds each case's objects through a relation no case's schema declares.
       - Not written: a pattern's `spec`, which is not a property of `Schemas.OfPattern` (4f-1); 4f-5 writes it.
   - **4f-5, pattern specs on the wire**: a pattern's `spec` is written and read wherever the pattern is, in a store's
     snapshot, a document and a transaction's expression (by now only the last, as recorded), so that a snapshot
     carries every pattern whole. It is not a property of `Schemas.OfPattern` (4f-1), which is to be settled when it
     starts. Required by the user: "plan must include writing pattern specs". Built before 0.22.0, completing 4f.
     As built: a verb of its own, `Mutations.OfObject.Spec`, the third branch of an
     object's mutations, holding a list of `Mutations.OfPattern` as recorded, payloads bare; 61 mutation schemas. A
     store's snapshot gives it after a pattern's members, where the pattern is a symbol or defined where it is linked; a
     transaction's expression writes a pattern's spec as before, nested. The executor writes it where the pattern holds
     another, in place of it, and leaves it where it holds; the reader checks its shape (a list of mappings of symbols
     to lists), refusing it on any schema but `Schemas.OfPattern`, and leaves what it says to be checked when the
     pattern is executed. The corpus's `module` case gives its pattern a spec, so the corpora carry one, byte-identical
     between the languages; SNP-04 and SNP-05 cover it.

     Settled while building it, for the user's review: a verb, not a property of `Schemas.OfPattern`, since a pattern's
     builder's `spec` is a call that records callbacks, and a property's value would be written tagged, where a spec's
     payloads are bare (4f-1); and its values are not decoded when read, since its symbols are the pattern's, which the
     same transaction defines.
   - **4f-6, what 4f's approval names and 4f-4 left out**, found on checking 4f against it point by point: a store's
     snapshot "upserts its modules and schemas", and an adjacency's verbs are "`insert`, `remove` and `clear`". As
     built: the first transaction's symbols are the root module, then what each module holds, in the order it holds it,
     a module's contents following it, a schema no module holds last; a module is found by its path, the root module by
     none (its spec clears its name), so that reading a snapshot makes modules and schemas in the order each module held
     them, an empty module and a module's description included. 4f-4 wrote schemas only, and lost an empty module and
     every module's own properties: a regression from the log, which wrote modules first, that no test caught.
     `Mutations.OfAdjacency.Clear` is the third adjacency verb (62 mutation schemas); it is read as any spec's verb and,
     as `remove`, refused when it runs (until 4j, which runs both). SNP-01, SNP-03, SNP-04, MUT-01, MUT-04 and TXN-13 cover them; the corpora
     are regenerated, byte-identical. With 4f-6, 4f is done.
   - **4j, removing entries through a spec, as built** (released as 0.23.0) (the user, 2026-10-22: "4j : implement removing entries, but
     defer deleting objects to a later phase"; Decided, 27): an adjacency's `remove` and `clear` in a spec run, and an
     entry's property cleared, where the executor refused them (4f-2). A spec writes them in the calls a builder's
     adjacency takes, `_.ada.knows(lambda a: a.remove(lambda e: e.known(_.bob)))` and `a.clear()`, recorded as
     `Mutations.OfAdjacency.Remove` and `Clear`; a builder's adjacency, data's and a schema object's, gains `clear()`
     (`Visitors.OfAdjacency`, VISITOR_PATTERN.md), so that both take the same calls. An install removes a member of
     the store's own schemas, `_.Contact.name("crm.Contact").properties(lambda a: a.remove(lambda e:
     e.name("nickname")))`, as tutorial 9 and the skill show.

     The semantics, fixed by the agent and approved by the user (2026-10-22: "approved"), the builders' new `clear()`
     included; a spec that clears then inserts is tech debt ("note as tech debt"; TODO.md):
     - `remove` removes from the adjacency each entry that agrees with an entry given: every link and property the
       removal gives equals the entry's. In a keyed adjacency (entries keyed by `name`), an entry given by its name
       removes that entry. An entry given that matches none removes nothing, and is no error.
     - `clear` removes every entry the adjacency holds.
     - A spec holds of a frame (what an upsert's match, a map's binding and a re-run see) where what it removes is
       absent, as well as what it inserts held: so an install or transaction that removes, run again, writes nothing,
       and a map whose spec removes binds the objects that lack the entry.
     - Clearing an entry's property, in an entry inserted, is allowed: the entry is inserted without it.
     - Clearing an entry's link, in an entry inserted or removed, is still refused before the transaction runs, since
       every link other than the object's own is set: "a spec's entry clears a link: every link of an entry but its
       object's own is set".
     - The extension check ("Framework schemas, always") still refuses removing a member of a schema the store was made
       holding ("an extension only adds members to 'Schemas.OfObject': it removes or replaces what 'properties'
       holds"): removal applies to the store's own schemas and to data. Where the member is absent, the spec holds and
       nothing is written, so nothing is refused.
     - Removing an owning entry deletes what it owned, cascading, as a builder's removal does (Object identity,
       Decided, 48). Deleting an object no entry owns stays deferred (Decided, 27).

     Found while building it, for the user's review:
     - A spec's verbs apply in the order it gives them, each where it does not hold. A spec that clears an adjacency and
       then inserts into it (`a.clear().insert(...)`) does not hold where the adjacency holds just what it inserts, so
       run again it removes the entry and inserts it again: the store ends as it was, but it writes. Open: whether a
       spec's `clear` should hold where the adjacency holds only what the same spec inserts after it.
     - A schema builder's `remove(entry)`, given an entry it holds of a union's branches or an intersection's parts (a
       record), removed every record, since an entry whose fields were not written agreed with any; an entry held now
       agrees only with itself (BLD-09). The executor removes through the object's builder, entry by entry.
     - An owning entry that a spec removes does not identify the object it would own, as an inserted one does (60).
     - A spec read from the wire whose adjacency verb is none of `insert`, `remove` and `clear` is refused when read.

     TXN-04, TXN-13, TXN-14 (new), INS-05 (new), PRX-11, BLD-09, VIS-01 and VIS-03 cover it, in both languages; the
     corpora are unchanged.
   - **Every deferral has a stage.** The user, on finding pattern specs noted but unscheduled: "It feels like we are
     leaking details from the plan." Whatever a stage leaves undone is entered here, with the stage that does it,
     never only in an as-built note. Proposed placements, for the user's review:
     - pattern specs on the wire (4f-1, 4f-4): 4f-5, built;
     - a symbol's schema given as `txn.Schemas.OfObject`, not the store's (78; 4e-1): 4i, whose `install(txn)` needs it;
     - removing entries through a spec: an adjacency's `remove` and `clear`, and clearing an entry's link or property,
       which the executor refuses before it runs (4f-2): 4j, after 4i, built (4j, as built, above). Deleting an object no entry owns (designed, not
       built; tutorial 9) is deferred past step 4, as the user decided (2026-10-22): "4j : implement removing entries,
       but defer deleting objects to a later phase";
     - parameters as a module, `Parametrics`, installed before use, in place of every kind's names only
       (docs/PARAMETRICS.md, as the user rewrote it; [Parametrics as a module](../parametrics/README.md)): 4m, "before
       4k or any other 4*", in two stages, 4m-1 and 4m-2; built (Parametrics as a module, Stages, as built), released as 0.24.0;
     - references to objects, relation entries and frames, one format (`References`; [References](../references/README.md)):
       4n, "right now", before 4k and 4h; built (References, Stages, as built); Paths overlap it meanwhile, deprecated,
       their removal tech debt (no stage yet: the workspace's TODO.md, "Eliminate Paths");
     - Parametrics' bindings' adjacencies, `values` and `objects`: dropped, no stage, as the user (2026-10-22): "lines 30 and 31 of docs/PARAMETRICS.md are no longer needed since `Parametrics.OfParameters` was introduced";
     - schema objects read field by field, outside the visitor protocol (tech debt retained in 4e-3): first 4k; taken
       out of step 4 as tech debt (Decided, 32; TODO.md), the commit-time rule kept;
     - the dataclass adapter defining its schemas in a store, not outside one (DC-03; 4f-3), which the plan pointed to
       a `TODO.md` that does not exist: 4l, independent of 4k, as an install (Decided, 31); built, released as 0.23.0. **4l, as built**:
       `FromDataclass.install(txn, module, *classes)` returns `txn.mutations([...])`, one upsert whose symbols are the
       module (`txn.Schemas.OfModule`, its spec what `module` writes, found by its name or made), each class
       (`OfObject`, named `<module>.<Class>`, a reference object) and each relation it infers (`OfRelation`, named
       `<module>.<Class><Field>`), each found by its name or made; the module's spec adds an entry of its `schemas` for
       each class, linking the class's symbol under the class's name, and a relation is placed in the module by its
       name, as the store places every named schema. A container of scalars is defined where its property links it.
       The spec is built through the recorder's fluent calls, never wire format. Run again, it writes nothing (DC-08).
       `FromDataclass.model(...)` is gone, and so is `FromDataclass(source)`, which gave one class's schema made outside
       any store, the same gap; `FromDataclass.ast` and the reverse direction, `ToDataclass`, stay as they were. Settled
       while building it, for the user's review: the schemas' names need the module's path when the spec is recorded, so
       the adapter reads it by calling `module` on a module's builder outside any store, which it never creates, and
       refuses a module given no name, or one that is not a path. Two gaps it found, closed in both languages on
       merging (INS-03): a member of the transaction's builder, called (`txn.uid(...)`), gave the builder, which names no
       schemas, and now gives the transaction back, so that `txn.uid(...).Schemas` names the store's; and an entry
       given a value for a link that no one schema fills (a module's `schemas`, whose `schema` link any kind fills:
       `m.schemas({"Order": _.Order})`) was refused, looking for the linked object's members, and is now taken by the
       link. The adapter names the store's schemas from `txn` and gives the module's entries as a mapping.
       DC is rewritten to the API (DC-03's gap closed), with DC-08 for the install.
     - evaluating expressions, a pattern's `requires` and variables, a branch's `requires`, a collecting reduce, which
       the executor refuses (87): step 5, in mbse-expressions, as 87 says;
     - helpers that build models through the builders, which P-019 forbids ("Do not invent another DSL by wrapping
       builder syntax"), beyond the schema helpers 4i-4 removes with installs: the corpus's data helpers (`_put`,
       `_write`), and test helpers that build mutations or data (MUT's `entry` and `spec`, and their kin): written out in
       fluent syntax, in 4i-4, beside the installs (done: the corpus's, University's and the test suites');
     - a journal, settled: a list of transactions on the wire, replayed by executing each, with no call of its own, is
       the journal, built as designed (the user: "journal as a transaction list: yes that is built as designed");
     - subsequent snapshots (SERIALIZATION.md, step 3; META_SCHEMAS.md, "not built yet"): after step 4, as the user
       decided ("after 4"); deferred (Decided, 27);
     - deleting an object no entry owns: deferred, whether it is needed at all open (Decided, 27).
   - **4i, `install`** (Object identity, Decided, 86: "`store.extend` is basically replaced by this new `install`
     convention"): every module that defines schemas does so in a module-scope `install(txn)`, its definitions and
     extensions symbols of meta-schemas that an upsert finds by name or creates; `store.extend` goes, and every caller,
     the framework's own modules, the tests and the tutorials, migrates; the dependents in their port, step 5 (Installing
     schemas, Decided, 7). Not to be passed over: the
     user, on finding it unscheduled after 4f, "There is no gap. You just decided to ignore Decided 86. It doesn't have
     to be done now, but soon. One of the last things that must be done for schemas to be stabilized." Built after 4f
     and before 4h; how the meta-schemas themselves are installed, which a transaction's symbols are typed by, is to be
     proposed for the user's review when it starts. Proposed and decided in [Installing schemas](../install/README.md)
     (the framework's own modules drafted there, a bootstrap reading them, "everything" migrating), built in four
     stages, 4i-1 to 4i-4, listed there; done, released as 0.23.0.
   - **4h, the last release** of step 4: mbse-schemas stabilized. The dependents are step 5's (Decided, 26).
   Releases (question 8, renumbered by the reorder, proposed for the user's review): 0.20.0 after 4c, 0.21.0 after 4d
   and 4g (released), 0.22.0 after 4e and 4f (4f-5 and 4f-6 included; released), each landing the branch on main. 4i
   follows 0.22.0, as the user decided: "go ahead and release 0.22.0 then go straight to 4i". 0.23.0 after 4i, 4j and 4l, as the user
   decided: "Do 4j, 4l, then release". 0.24.0 after 4m, since removing the
   core's parameters breaks dependents ("yes, proceed"). 4e builds only the in-memory, sequential executor
   (question 11).
5. **The dependents ported** (Decided, 26): every `mbse-*` repository that depends on mbse-schemas moves to the
   stabilized mbse-schemas, its schemas installs (Installing schemas, Decided, 7). mbse-expressions refines
   `OfExpression` and `OfConstraint`, evaluates what the executor refuses (87), and redrafts its framework model (below);
   mbse-programs' corpora become Reachable transactions; mbse-patterns, built on `OfPredicate`, moves to `OfPattern`
   (STREAMING_QUERIES.md). Each is proposed for the user's review when it starts.

### Example: a transaction, as 4e would build it

The user's sketch, `store.transaction(lambda xact: xact.uid("6f1c4e2a-…").mutations([...]))`, in the structure Decided
59 gives, its builders those a property call with a callback gives (58); the details are 4e's to settle:

```python
store.mutation(lambda t: t
    .uid("6f1c4e2a-0000-4000-8000-000000000001")
    .then(lambda all_: all_.over(FEATURES)            # OfAll: the singleton wts.Features, as symbol `features`
        .then(lambda up: up.exists(DEFINITION)        # OfUpsert: `defn`, located at features.dir({name: "DEF-693"})
            .then(lambda u: u.apply(TITLE)))))        # OfUpdate: defn's title set through its property's builder
```

Then, in step 5, mbse-expressions redrafts its framework model on per-store extension, its schemas defined by its own
`install(txn)` (86; 4i), with domains, dialects and `DefinesDomains` as the user described.

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

- A property of an extended schema (`store.extend`) holds a container where its type is one, as a term's
  `attributes` did; BLD-06 now builds its map-valued property, and a template matching one by value, through
  `store.extend`.
- A scalar refines another of the same token, whatever else, and `refines` of something not a type is reported as
  "refines something not a type" (it was "refines nothing", an application of nothing).

PAR keeps two cases (declaring and writing parameters); `Check`'s outcome moved to VAL-16. The corpus's `module` group
keeps its parametric schemas, with parameters as names, and loses its widths, applications and `requires`.

## Step 3, as built (0.18.0)

A scalar schema is one of the five basic scalars (8, 22): a store refuses to build another, `token`, `format` and a
scalar's `refines` are removed, each basic scalar maps to its host type by its name, and a value of any type is
tagged with its basic scalar's tag (`int`). User scalars in tests, tutorials and examples became the basic scalar
(23). A union's branches and an intersection's parts are entries of `Schemas.HasBranch` and `Schemas.HasPart` (4),
linking the type and carrying `name` and `description`; `Schemas.Member` and its builder are gone, and the corpora
lose every member object and its `Typing` entry.

Found and fixed while building it: a snapshot did not write an extension's entry that only a store's own schema
reached (a tag written from a basic scalar's end): such entries are now written, and what they link that has no name
of its own follows them (EXT-05).

Found, for the user:

- **A property an extension adds to `Schemas.OfScalar` can hold no value.** The store's own scalars change only
  through `store.extend`, which only adds members, so `HasDomain` and other extensions of scalars are adjacencies,
  whose entries are written from either end (EXT-04 now adds its `unit` property to `Schemas.OfObject`).

## Step 3b, as built (0.19.0)

"Type" is gone from the API, the wire and the messages (24): `.schema([X])` builds a member's link to its schema, the
data's field is `schema`, `OfAny` holds `schemas`, `Schemas.Typing` is `Schemas.HasSchema` (`member`, `schema`), the
link of `HasBranch` and `HasPart` entries is `schema`, and a derived identity ends `#schema`. Tests, tutorials, the skill
and the documents' current sections say schema; a scalar's host type keeps its name, and quoted decisions their
wording. The corpora change in every relation key and link that said type.

## Step 4a, as built

`Schemas.OfAdjacency` has `owner`, validated as Object identity, Decided, 14 says: a relation of two links, with a
clause holding the owner's link and not the owned's and one holding the owned's and not the owner's. A property has
`pattern`, validated as a naming pattern on text. The keyed relations between schema objects (`HasProperty`, ...,
`Defines`) mark their members' ends `owner()`; `Schemas.HasInstance` links an object schema to its objects, keyed by
`name`. Every store holds `Paths.OfRoot`, `Paths.OfEntry`, `Paths.OfTarget` and `Paths.Next`, its own, a key's value a
bool, an int or text so that it is written bare; `Paths.of(obj)` reads a proxy's path off its ownership entries back to
a singleton. Nothing else changes: objects keep their identities until 4b, and the corpora are unchanged (IDN-01 to 04).

## Step 4b, as built

Data objects are identified by their paths (Object identity, Decided, 31 to 36). An object whose schema declares an
`owner()` adjacency is owned at build: when the outermost builder's write ends, one created without an owner is given
the one singleton that can own it, its keys the next its naming patterns give past every number held, and otherwise
the write raises, naming the ownership missing (IDN-05). An object whose schema declares none is its schema's, through
`Schemas.HasInstance`, under a key its naming pattern gives, else its local name lowercased, a dash and a number
(`contact-1`); there are no UUIDs, and the schema holds the object while the store lives (STO-02). `as_identity()` is
the path, read-only on builders as on data (STO-08); `by_identity` is gone, and an object is found by calling an
adjacency with keys, `features.dir({"name": "DEF-693"})`, or through `store.Instances` (IDN-06). The Reachable format
lists each object with its path and its schema's name, a reference being `{"$ref": path}`; reading builds each owner
before what it owns and adds each ownership entry from the path's last step (IDN-07). In a log, data is defined by its
path and its schema's name and referred to by its path; schema objects keep their `Module.Schema/ID` keys until 4c.
The corpora are regenerated, the JSON byte-identical between the languages.

Points settled while building, for the user's review:

- A schema the store registers but no module defines (as the dataclass adapter makes them) has the path its dotted
  name spells, so that its objects' paths read back (IDN-06, DC).
- A snapshot that lists an object nothing references is read: each listing names its schema, which is why the old
  refusal ("nothing references this object, so its schema is unknown") existed. Listing one path twice is refused.
- A lookup by keys skips an entry that lacks one of them, rather than raising (IDN-05).
- Python's YAML writer quotes strings the YAML 1.1 specification's float pattern matches, such as `.` (a root module's
  path) and `1.2.3`, as TypeScript's already did (YML-02, CONF-03).
- In TypeScript, keys are given as an object literal, `features.dir({ name: "DEF-693" })` (docs/EQUIVALENCE.md).

## Open, for the user

1. *Settled by Decided, 28*: bindings are "super lazy". Was: **Deferred: when a binding is applied.** "I don't think we need to force the issue of eager or on-demand binding":
   whether `Parameters.Apply` is a record in the store or an operation, and so when a `Parameters.Bind` takes effect,
   is left open. Under object identity (step 4), a path's builder given an identity the store holds visits that object,
   and otherwise makes one; the present code clones on `store.crm.Contact(obj)` until then.
2. *Settled by 22.*
3. *Settled by Object identity, Decided, 8:* `Schema@` only in `Exists`, one directory per module. Step 4 then tells
   apart what shares a `ModulePath/Suffix` today across kinds: a predicate's parameter and symbol of one name
   (`crm.Kinds.x`), and a module named as a schema is (`crm.Contact`, holding `crm.Contact.v2`).
4. **A path given to a link.** Your `e.domain(Int32)` passed a path. With `as_instance`, a link is given the instance
   (`e.domain(store.Instances.Expressions.Dialects.Basic.as_instance('Int32'))`); should a link also accept a path to
   an instance? The user (2026-10-22): "I think this already works: `Visitors.OfEntry.<linkName>(spec:
   Specs.Callback[Visitors.OfObject])`". As built, that callback writes a new object at the link (an entry's
   `course(lambda c: c.code("CS101"))` makes a second Course beside an existing CS101): it finds none. An existing
   object is linked by giving the object, or, in a transaction, the symbol a pattern binds to it. Still open: whether a
   link should also find one by a path.
5. *Superseded by 8.*
6. *Settled by Object identity, Decided, 58*: a mutation's builders are those a property call with a callback gives.
7. *Settled by Object identity, Decided, 55 and 61*: a counted object is numbered within the document that writes it,
   or, created by an upsert, identified by its frame, key and symbol; nothing re-states a transaction's index.
8. *Approved*: 0.20.0 after 4c, 0.21.0 after 4f, 0.22.0 after 4g, each landing the branch on main; renumbered by the
   reorder to 0.21.0 after 4d and 4g, 0.22.0 after 4e and 4f (Order of work, Releases).
9. *Settled*: a transaction is a mutation expression only. The store's builders do not write inside one on their own
   (a `.build(...)` handing the callback the store was proposed and refused: it "circumvents the entire streaming query
   language"); writes are made by the property builders a term's pattern gives (Object identity, Decided, 58), which are
   the same fluent calls:

   ```python
   store.mutation(lambda t: t
       .uid("6f1c4e2a-0000-4000-8000-000000000002")
       .then(lambda all_: all_
           .over(lambda p: p.symbol(lambda y: y.name("features").path(FEATURES)))
           .then(lambda up: up
               .exists(lambda p: p.symbol(lambda y: y
                   .name("defn")
                   .schema(Definition)
                   .path(lambda x: x.start("features").step("dir", {"name": "DEF-693"}))))
               .then(lambda u: u
                   .apply(lambda p: p.object("defn", lambda d: d.title("Has 88 keys")))))))
   ```

   (`.symbol`, `.path(... .start(...).step(...))` and `.object` are names for 4e to settle.) Every test, tutorial,
   example and skill block that builds moves into such expressions in 4e.
10. *Settled*: `Schemas.OfPredicate` goes, in 4d ("OfPredicate goes away, consider that decided"; Object identity,
    Decided, 67).
11. *Agreed*: 4e builds only the in-memory, sequential executor; distributed execution, and with it shards, is later
    work, the design (56, 57, 62) keeping it possible.
12. *Settled*: "if returning something is useful for testing purposes, do it. Regular programs probably will not."
    `store.mutation` returns the frames that reached the end of its chain, each binding the transaction's symbols to
    the objects they found or made; a test reads what it built from them (holding them keeps their counted objects
    alive), and a program may ignore them.
