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
4. **Object identity (0.20.0).** As [Object identity](../../OBJECT_IDENTITY.md) now describes it: three modes, a
   singleton by its global name, an owned object by its path from a singleton through ownership entries (`owner()`, key
   properties with patterns), a counted object by its transaction's uid and its creation index; every write in a
   transaction; `Schema@` only in `Exists`; `as_identity` gone.
   *Breaks*: every write outside `store.mutation` (about 1200 build calls in 214 cells of the Python notebooks alone,
   and as many in TypeScript's, the tutorials, examples, skill and README included); the snapshot and Reachable
   formats, so every corpus and hand-written snapshot; `.ref(pattern)`, `OfObject.pattern`; `as_identity`; and in the
   dependents, mbse-expressions' and mbse-programs' corpora and their `Reachable` documents.
   In stages, each committed with both gates at 100%, released only at the last:
   - **4a, the vocabulary** (done): `owner()`, `.pattern(...)` on properties, the path schemas, a path on demand.
   - **4b, data objects by path** (done, `1513108`): ownership filled at build, keys generated, lookup by keys, paths on
     the wire. What Object identity, Decided, 37 to 51 reverse of it, 4c to 4e undo: `HasInstance`, `OfObject.pattern`,
     `local-name-N` keys, the schema holding its objects, `as_identity`, and the Reachable list of objects.
   - **4c, transactions in memory** (38, 42, 44, 46, 50): `Mutations.OfTransaction` (`uid`, `mutations`) and
     `Visitors.OfMutation`; `store.mutation(mv)`; every write outside one refused, with a message naming
     `store.mutation`; a transaction that raises undone entirely, from a journal of its writes; ownership settled when
     it ends, an unsettled ownership aborting it (33). Objects keep 4b's identities for this stage, so that only the way
     programs write changes: every test, tutorial, example and skill block moves into transactions here.
   - **4d, counted objects** (37, 39, 40, 41, 43, 46, 47, 48): `HasInstance`, `OfObject.pattern`, the `local-name-N`
     keys, the directories and `store.Instances.<schema>(keys)` go; an object whose schema declares no `owner()` is
     counted, given its transaction's uid and creation index (a clone too), and held by nothing but what links it;
     `as_identity` goes; validation refuses an `owner()` adjacency a counted schema can fill; removing an owning entry
     deletes the owned object, cascading. The tests whose root-level objects must be found move them under a
     singleton directory.
   - **4e, the wire** (45, 49, 51): a store's snapshot is made of transactions; a counted object is referred to as
     `{"$ref": {"tx": ..., "n": ...}}`, `{"$ref": {"n": ...}}` within its own transaction; a Reachable document is one
     transaction under a uid its writer is given, owned objects and singletons referred to by path, a singleton's of no steps. The corpora
     are regenerated, the JSON byte-identical between the languages.
   - **4f, schema objects** (17, 29): their identities are their paths, derived identities go, and their keys on the
     wire are paths too.
   - **4g, the release**: the corpora as 4f leaves them; 0.20.0; the dependents (mbse-expressions, mbse-programs)
     adapt, their corpora as Reachable transactions.

### Transactions, as proposed for 4c

A transaction is written as everything else is, through a builder given to a callback (mbse-basis P-004): the builder
is the `Visitors.OfMutation` of a `Mutations.OfTransaction`, its `uid` set by the program, and the store's builders work
inside the callback, the transaction open:

```python
ada = None

def add_contact(t):
    global ada
    t.uid("6f1c4e2a-0000-4000-8000-000000000001")
    ada = store.crm.Contact(lambda c: c.name("Ada"))  # within the transaction: allowed
    return t

store.mutation(add_contact)
store.crm.Contact(lambda c: c.name("Bob"))  # outside one: refused, naming store.mutation
```

- `store.mutation(mv)` takes the visitor itself too, as any `Spec` may be "an instance of the built object": a
  transaction read from a log is applied as one, its mutations replayed through the store's builders.
- A transaction without a uid raises before it applies anything; the uid is the program's, never drawn.
- Undoing: each primitive write (a property's value, an entry added or removed, an object entered in the store)
  records how to reverse it; a transaction that raises reverses them, last first, and re-raises. A transaction that
  completes discards the journal: nothing is recorded beyond the transaction, as no history is kept.
- In TypeScript the same, `store.mutation((t: any) => { t.uid("..."); ...; return t; })`.

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

1. **Deferred: when a binding is applied.** "I don't think we need to force the issue of eager or on-demand binding":
   whether `Parameters.Apply` is a record in the store or an operation, and so when a `Parameters.Bind` takes effect,
   is left open. Under object identity (step 4), a path's builder given an identity the store holds visits that object,
   and otherwise makes one; the present code clones on `store.crm.Contact(obj)` until then.
2. *Settled by 22.*
3. *Settled by Object identity, Decided, 8:* `Schema@` only in `Exists`, one directory per module. Step 4 then tells
   apart what shares a `ModulePath/Suffix` today across kinds: a predicate's parameter and symbol of one name
   (`crm.Kinds.x`), and a module named as a schema is (`crm.Contact`, holding `crm.Contact.v2`).
4. **A path given to a link.** Your `e.domain(Int32)` passed a path. With `as_instance`, a link is given the instance
   (`e.domain(store.Instances.Expressions.Dialects.Basic.as_instance('Int32'))`); should a link also accept a path to
   an instance?
5. **The order.** Four releases, as above, or fewer, larger ones?
6. **The transaction builder (4c).** As proposed above: a callback given the transaction's builder, the store's
   builders working inside it, the uid set by `t.uid(...)`. Or should the mutations be written as data only
   (`Mutations.OfTransaction` values), the builders being how a program makes them?
7. **Re-stating a counted object in a snapshot (4e).** Objects 0 to 4 of a transaction may be gone when object 5 is
   written, so a snapshot cannot give it its index by position, as a creation's `Exists` does (Object identity,
   Decided, 49). Proposed: a snapshot is one transaction, under a uid its writer is given, holding the schemas, the
   singletons' properties and the owned objects as creations, and each counted object as an `Exists` that names the
   `{"tx", "n"}` it was created with; its entries follow. Or one transaction per original transaction, its `Exists`
   naming their indexes?
8. **Releases within step 4.** 4c alone changes every program that writes; should 0.20.0 be cut after 4e (data
   identity whole), schema objects following as 0.21.0?
