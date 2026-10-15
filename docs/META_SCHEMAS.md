<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)

# Meta-schemas overhaul

How mbse-schemas' lists become relations and its meta-schemas become linked objects, so that the schema model is
built from the same constructs it offers: objects, relations and their entries. This is the plan of the work. What is
decided is in the [framework design](FRAMEWORK.md), Resolved, "The meta-schemas overhaul" and "Schema builders align
with their meta-schemas", which this does not restate. V1 to V5 are built, and so is phase 1 of the schema builders
(Plan): the meta-schemas as reference objects and relations, their builders and the store, in Python, which
[The meta-schemas and their builders, as built](#the-meta-schemas-and-their-builders-as-built) describes. The rest is
not. It changes the module format, so every repository that reads schemas adapts.

## Why

- **One construct for many.** A list, a dict, a map and a relation's entries are four ways to hold a variable number
  of things. `OfIndexed` holds the first three apart from relations, with its own builders, visitors, wire forms,
  validation and comparison, and every code generator renders both.
- **Meta-schemas without invented containers.** A module holds its schemas in `Schemas.Module.Entry` value objects,
  and a type is `Schemas.OfAny`, a union of the kinds and `named`: containers that exist only to hold schemas, which
  the schema model would not offer a modeler. As linked objects, schemas refer to each other by relations, as any
  model does.
- **Modules as relations.** A module defines its schemas by a relation, `Defines`, so that modules can nest, and a
  module's dictionary of schemas is entries like any other.

## Where it comes from

An exploration on 8 to 11 Oct 2026, the `scalars` branch, built this together with the open-world and scalars
overhaul, which is deferred. Its commits are the reference, not a source: they do not apply to `main` without the
deferred open-world reading (slice 1, `e19d9e7`), so each phase below is built again.

| Phase | Reference commits on `scalars` | Left out |
|---|---|---|
| 1, 2 | `55edeb4` (slice 2), `eea1ece` (3a) | `e19d9e7` (slice 1, open-world reading) |
| 3, 4 | `d676953` (3c), `4748680` (3d) | |
| 5 | `1011f1f`, `b73fbf4`, `47054d1` (4a steps 1, 2 and 4) | `35d2743`, `4e3cdca`, `ad2e389` (`OfName`, `Specializes`, values classified, subsumption) |

## Plan

mbse-schemas first, in a workspace (`polyrepo.py workspace <dir> --branch meta-schemas --edit mbse-schemas`), in
phases that each keep both implementations equivalent and at 100% coverage, the corpora, test plans, tutorials and
skill regenerated. No release comes between phases.

**Reordered after V5** (2026-10-14), as the user decided: asked whether it "would be less risky for us to park the
meta-schemas work and bring the dependent libraries up to compliance", they agreed ("yes") to this order: phase 6
(dependents, in dependency order: mbse-expressions, mbse-programs, mbse-patterns, mbse-codegen-python) and phase 7
(the release, 0.11.0, of V1 to V5 and `OfAny`) come next; phase 5 (meta-schemas as linked objects) is parked until
after the release, its design draft (below) kept for review.

**Reordered again** (2026-10-14), as the user decided: the schema builders do not implement `Visitors.OfX`, which
FRAMEWORK.md requires ("To make schemas fully serializable, `Schemas.OfX.Builder` must implement `Visitors.OfX`"),
and "If the meta-schema does not align with visitor and proxy builder, the framework is broken". The user: "stop
mbse-expressions work because it cannot be written correctly without it". Aligning the schema builders and data
with their meta-schemas comes next, before the dependents (FRAMEWORK.md, Resolved, "Schema builders align with their
meta-schemas").

**Invariants relaxed to the branch** (2026-10-14), as the user decided ("that is okay - we can relax to the
branch/issue level"): while the builders align, a commit on `overhauls/meta-schemas` may change one language only,
or fall short of 100% coverage, so that work can go in parallel; the branch passes every gate again before it lands.
The work, from docs/proposals/schema-builders/: phase 1, the Python core (the meta-schemas, builders and store in
`Framework/Builders.py`, beside the old builders, and the shorthands in proxies), serial; phase 2, in parallel, the
TypeScript core, the wire format (Modules and Plain through the meta-schemas, modules in the store), the migration of
call sites, and the docs; phase 3, the old builders removed, the corpora regenerated, every gate passed.

0. **Decisions recorded** (this document; FRAMEWORK.md, Resolved; mbse-expressions' EXPRESSIONS.md, Resolved;
   mbse-basis V-025).
1. **Adjacencies that project**: `OfRelation.Data.keys(me)` and `key(me)`; an adjacency member stays a tuple (a frozen
   array) of its entries, with `project(name)` and `at(key)`; entries written sorted by their key; `Paths` reading
   `unique(S)` the right way round.
2. **One-link relations and lists as relations**: a relation of one link; an open relation (no `unique`) is a list,
   `.unique()` naming nothing makes a set; reading counts an entry written under several ends once; value objects held
   by a one-link relation's entries may have adjacencies; lists declared inline in their adjacency.
3. **The meta-schemas' lists as adjacencies**, in declaration order (the module format changes); a module's schemas
   keyed by name; `OfApply` binding by name only.
4. **`OfIndexed` removed**, with `Proxies.OfIndexed.Map`, the list visitors and records, the keyed wire forms and
   extents; `Check` and `Validate` evaluating no term; the dataclasses adapter mapping `list[N]` and `dict[K, N]` to
   one-link relations. The Lists suite is rewritten.
   After phase 4, the user found the visitor pattern backwards (FRAMEWORK.md, Resolved, The visitor pattern; the
   [Visitor pattern](VISITOR_PATTERN.md)), which phases V1 to V4 build before phase 5, whose meta-schemas are read and
   written through it. Decision C's first step in mbse-expressions is reverted: relation operations are the visitor
   protocol's, not Basic's.

- V1. **Schema-level changes** (built): `validate()` refuses `as_*` names; `Schemas.OfEntry`, with its meta-schema, a
  `Schemas.OfEntry.Builder` building the `Schemas.OfEntry.Data` that `Schemas.OfRelation.Data.entry` holds; `OfNative` renamed `OfScalar`, written `{"scalar": {"format": ...,
  "token": ...}}`; a link targets only reference objects, and a value object has adjacencies only to one-link
  relations; `Schemas.OfSymbol`, a predicate's symbol and an entry's link; `Schemas.OfPredicate`, a module definition
  of its own (`predicate`), registered by name. A link may
  have a schema, which `validate()` checks and modules write; `Validators` does not yet check a link's target against
  it.
- V2 and V3 (built), one phase, with no side-by-side period ("G1 (a) no side by side period"): the old protocol and `accept`
  are deleted first, so that nothing of them shapes the new one, and the commits in between do not pass.
  - V2. **The visitor protocol**: `Visitors.OfX` as [Visitor pattern](VISITOR_PATTERN.md) declares it, and
    `Specs`, and the read-only views `Readers.OfX`; `Proxies.OfX.Data` (read-only) and `Proxies.OfX.Builder`
    implement it, a builder reading back its pending writes.
  - V3. **Consumers pull**: `Plain`, `JSON`, `YAML`, `Validators`, `Comparison`, `Reachable` and `Modules` read and
    write through the protocol; `Bindings`, `Paths` and `Reflection` are removed, and so are `Validators.properties_of`
    and `entries_of`. With them goes what V1 left without a use: `Comparison`'s paths between value objects (`OfLink` compares by identity only), and the state's references
  in a value object's entries (`Bindings`, "no snapshot holds the value"), which only a two-link relation of a value
  object, now invalid, could hold.
- V4. **Identity**, as FRAMEWORK.md, Resolved, "Reference identity" decides: a reference object named by its global name,
  by a name its schema's `.ref(pattern)` gives, or by a UUID, given by `create()` or `clone()` and never by the program;
  one directory per schema in each store, its numbers strictly increasing, which loading advances; the identity saved
  on the wire, qualified by the schema's registered name, as the object's key in a snapshot and in the links to it, a
  repeated identity loading as an update; `as_identity()` None where there is none; `Stores.by_identity(id)`, `validate()`
  refusing a global name with a pattern (`Paths` went in V3); the qualified form `"crm.Feature/FEA-001"`, a global name
  alone; `as_identity()` and `store.by_identity(schema_name, name)` unqualified; identities as snapshot keys and in
  `$ref`, `$schema` kept; patterns wherever output must be reproducible.
- V5. **Containers**, as FRAMEWORK.md, Resolved, "Containers" decides, reversing phases 2 to 4's collections, one unit:
  built so far: `Schemas.OfContainer`, its meta-schema and modules (SCH-23, MOD-08); `Visitors.OfContainer` and
  `OfIterator`, proxies, snapshots, validation and comparison (CNT); the dataclasses adapter (DC); relations of two
  links or more, every one-link relation (the meta-schemas' lists, a module's schemas, tests, tutorials, the corpus,
  the skill) a container; the adjacency API, `as_iterable`, `insert` and `remove`, with `select` removed. V5 is built;
  - `Schemas.OfContainer`, a variant of `OfAny`, with an index type and an element type, each an `OfAny`, and
    `.dense()` or `.sparse()`, at most one, defaulting to dense for an index with a total order and to a dict for a
    hashable one; several int indices for tensors; its meta-schema beside `OfRelation`'s; `validate()` refusing both
    `.dense()` and `.sparse()`, and an index of neither kind given either;
  - `OfRelation` of two links or more: a one-link relation becomes a container-typed property (a contact's numbers, a
    value object's lists, the meta-schemas' own lists, a module's schemas), `unique` for relations only, a relation's
    entries in insertion order;
  - `Visitors.OfContainer` and `Visitors.OfIterator` (positions, `as_item` extending a writable container at its ends,
    `prepend` and `append` there), and `Readers` to match; `Visitors.OfAdjacency` for relations only, `as_iterable`,
    `insert` and `remove`, with `select` removed, its uses read through `as_iterable`;
  - Proxies: dense containers as packed arrays, sparse ones as blocks, dicts by index;
  - the wire form: a dense container as an array of its elements, nested or flat with its shape for several int
    indices as the writer is configured, the loader detecting which; a sparse one as its blocks (a start index and a
    run; adjacent blocks may merge); a dict by index, or as entry-like elements where its index is not a string;
    containers nesting; reloading rewrites a container element by element, and relations match entries by value
    (Reference identity, on update);
  - `Validators`, `Comparison`, `Reachable`, `Modules` and the dataclasses adapter (`list[N]`, `dict[K, N]` to
    containers); the corpus, the Lists suite, tests, tutorials, the skill and the docs.

  Before it is built, the open points in FRAMEWORK.md's Open questions ("Containers") are settled.

5. **Meta-schemas as linked objects**: links built with a schema given as itself (`.<link>.of(schema, spec)`);
   `Schemas.OfAny.Schema` removed, a type given as itself (`Visitors.OfAny`, `Schemas.OfAny.Builder` and `Data` kept,
   and `OfAny` added as a kind, a value of any type: FRAMEWORK.md, Resolved, "`OfAny` returns"); every schema a
   reference object of its kind's meta-schema, every reference to one a link through a meta-relation, the ends at which
   a schema is referred to anonymous adjacencies (built here, for any relation, as TODO.md's "Anonymous adjacencies");
   `OfModule` and `Defines`, nestable, names qualified with dots; `Schemas.OfStore.root_module()`, the root module,
   registering schemas by module-qualified name, in place of `Reflection`; modules written as snapshots;
   `Schemas.Module`, `Modules.reference` and `resolve`, and `Stores.META` removed.
6. **Dependents**, each pinning the workspace's mbse-schemas:

   | Repository | Adapts |
   |---|---|
   | mbse-expressions | evaluators binding each symbol to a `Readers.OfObject` and reading through it, relations through `Visitors.OfAdjacency` (decision C superseded, its first step reverted); an enum's members and a packed domain's codes as one-link relations; Basic's collection operations over lists reconsidered with the protocol |
   | mbse-patterns | `Predicates` lists (`_LIST`, `GIVEN`) as relations; `Modules.reference` and `resolve` replaced by links; meta-schema names in `Reflection` (`Schemas.Indexed` gone, `Schemas.Module` changed); transforms keyed by identity, `Paths` gone; `Schemas.OfPredicate` taken as its predicates' model; finding matches and `Stores.update` with its certificate |
   | mbse-programs | `Syntax`'s `as_indexed`; `OfApply` arguments by name; the conformance corpora regenerated, since a syntax node's children are written sorted by their key (`property`, `index`) since phase 1 (CONF-01) |
   | mbse-codegen-python | `Types` without `OfIndexed` and `Proxies.OfIndexed.Map`; a relation keyed by integer-like properties promoted to an indexable, and to a dict or map where unambiguous; `Codegen.Defined`'s `unique(output, name)` corrected for the right reading, `unique(node)`, without which its paths are positional since phase 1 (TYP-03); for every schema, the analogues of a proxy, `<SchemaName>.Data`, `<SchemaName>.Builder` implementing `Visitors` and `<SchemaName>.Schema`, in place of `Bindings` |

   The dependents' suites are run in the workspace after each phase, and what a phase breaks is listed above. After
   phase 1, mbse-patterns passes unchanged. Phase 2 breaks nothing more, though a dependent's relation that has no
   `unique` clause and relied on equal entries being elided now keeps them, which its tests may not show: each
   dependent's relations are reviewed for it here. Phase 3 dropped the members' meta-schemas with the scalars branch
   (restored: FRAMEWORK.md, Meta-schemas, "Each member keeps its own meta-schema"), and moved a schema's lists to
   adjacencies, which predicates read with `get` and `has` (mbse-patterns' TRF-07, mbse-codegen-python's TYP-02 and
   SKL-02); mbse-expressions' first step of decision C, `get` and `has` of an adjacency and `project`, was built then
   to keep them evaluating, and its removals stay here. After it, the dependents fail only as after phase 1.

7. **The release**: mbse-schemas 0.11.0 and a minor version of each dependent, landed together
   (`polyrepo.py land <dir>`).

## The meta-schemas and their builders, as built

Phase 1 of the schema builders (Plan), as FRAMEWORK.md, Resolved, "Schema builders align with their meta-schemas"
decides it, built in Python as `Framework.Builders`
([the builders' module](../python3/mbse/Schemas/Framework/Builders.py)), beside the old builders, on top of
`Schemas.OfX.Data`, which is unchanged, and run by [suite BLD](../python3/tests/25_Builders.ipynb). The proposal it
came from, the old clause → new table and the work items left are in
[Schema builders as visitors](proposals/schema-builders/README.md).

### The meta-schemas

Every meta-schema, `Builders.Meta.X` (`Builders.OfX.Schema`, which becomes `Schemas.OfX.Schema` when they land), is a
reference object schema named `Schemas.X`, so every schema object is a reference object (Resolved: "we already decided
at least one time to make schema objects references. all of them.").

- **Kinds.** `Schemas.Schema` has the properties `name` and `description`, and owns `parameters`.
  - `Schemas.Type` refines it, and `Scalar`, `Object`, `Union`, `Intersection`, `Container`, `Apply` and `Any` refine
    `Type`: only a type is anything's type, refined, indexed, contained, applied or allowed.
  - `Relation` and `Predicate` refine `Schema` directly; they are not types.
- **Members.** `Schemas.Typed` has a `description` and a `type`; `Property`, `Parameter`, `Symbol` and `Member` (a
  union's branch or an intersection's part) refine it. A member's name is not its own: it is the `name` property of the
  entry that links it to its owner (`HasProperty`, ...), since a member is named within its owner.
- **Other schema objects.** `Adjacency` (a `description`, and `me`), `Argument` (a `value`), `Term`, refined by `Form`
  (`dialect`, `kind`, `attributes`), and `Module`, with the naming pattern `module-(\d+)` and nothing but its
  `schemas`.
- **Properties hold values** (Resolved: a property "has as schema which must be OfAny and that can hold scalars,
  containers, value objects, or any nesting thereof"): a kind's `name` and `description`, a scalar's `format` and
  `token`, an object schema's `ref`, `pattern` and `singleton`, a union's or intersection's `flat`, a container's
  `layout`, a relation's `uniques` (a container of containers of names), a member's and an adjacency's `description`,
  an adjacency's `me`, an argument's `value`, a form's `dialect`, `kind` and `attributes` (a container by name), and
  the `name` of a keyed relation's entry.
- **Names, by exception** (Resolved, "I think we need to make an exception ..."): within a schema, its relation's links
  and properties are named by string, never referred to: an adjacency's `me` and a relation's `uniques` are properties
  holding names.
- **Every reference is a relation** of two links, `Schemas.<Relation>`, with an adjacency named at the end that
  declares it and an anonymous one at the end referred to (Resolved, "Refinement, identities and relations": an
  anonymous adjacency lets an object fill a link, with no member). A type is referred to by every relation whose
  second end is `Type`, so `Schemas.Type` declares seven anonymous adjacencies, which each kind inherits.

| Relation | Links: first, second (their schemas) | Named at the first | Constraint, as `unique` clauses state it |
|---|---|---|---|
| Typing | typed (Typed), schema (Type) | `Typed.type` | one: `unique(schema)`, the typed determines its schema |
| Refines | refinement (Type), refined (Type) | `Scalar.refines`, `Object.refines`, `Container.refines` | one |
| Indexing, Containing | container (Container), index / element (Type) | `Container.index`, `Container.element` | one |
| Applying | application (Apply), applied (Type) | `Apply.of` | one |
| AnyOf | any (Any), schema (Type) | `Any.types` | none: open, a list in declaration order |
| Relating | adjacency (Adjacency), relation (Relation) | `Adjacency.relation` | one |
| Binding, ArgumentTerm | argument (Argument), parameter (Parameter) / term (Term) | `Argument.parameter`, `Argument.term` | one |
| Requires | predicate (Predicate), term (Term) | `Predicate.requires` | one |
| BitWidth, ByteWidth | scalar (Scalar), width (Term) | `Scalar.bits`, `Scalar.bytes` | one; a width is a term |
| HasParameter | owner (Schema), parameter (Parameter); property `name` | `Schema.parameters` | keyed: `unique(owner)`, `unique(parameter)` |
| HasProperty | owner (Schema), property (Property); `name` | `Object.properties`, `Relation.properties` | keyed |
| HasAdjacency | owner (Object), adjacency (Adjacency); `name` | `Object.adjacencies` | keyed |
| HasBranch, HasPart | owner (Union / Intersection), branch / part (Member); `name` | `Union.branches`, `Intersection.parts` | keyed |
| HasSymbol, HasLink | owner (Predicate / Relation), symbol / link (Symbol); `name` | `Predicate.symbols`, `Relation.links` | keyed |
| HasArgument | owner (Apply), argument (Argument) | `Apply.arguments` | owned: `unique(owner)`, the argument determines its owner |
| Operands | form (Form), operand (Term) | `Form.operands` | none: a list |
| Defines | module (Module), schema (Schema); `name` | `Module.schemas` | keyed |

"One" is `unique(second)`: the first end determines the second, so the adjacency holds at most one entry. "Keyed" is
`unique(owner)` and `unique(member)`, with the entry's `name`: the member and its name determine the owner, and the
owner and the name the member (Cardinality, in FRAMEWORK.md). A relation's links and properties are its own
(`Relation.links`, `Relation.properties`), with no entry schema between: `Schemas.OfEntry` has no meta-schema here.

### The builders

Each `Builders.OfX.Builder` is a writable `Visitors.OfObject` over `Meta.X`, in [Visitor pattern](VISITOR_PATTERN.md)'s
form (Resolved: "Schemas.OfX.Builder must implement Visitors.OfX"); read-only, it reads the data it is given and refuses
every write.

- **Members.** `osv.<propName>`, a `Visitors.OfProperty`, and `osv.<adjName>`, a `Visitors.OfAdjacency` with `insert`,
  `remove`, `as_iterable` and iteration over its entries; called with a `Specs.Callback`, each writes or visits through
  it and returns the builder. A container-valued property (a form's `attributes`) hands over a `Visitors.OfContainer`.
  An entry's link to its referent is a member, `env.<linkName>`: called, it links the referent given, or builds one
  through the callback, new, or the one the entry links, updated in place; read, it gives the referent, read-only.
  Members, terms, arguments and an adjacency's relation are built through a link; a type, a refined schema, an index,
  an element, an applied schema and an argument's parameter are linked as objects that exist (Resolved: "a link to a
  type takes a schema that exists, not a callback that builds one").
- **Shorthands** ([Visitor pattern](VISITOR_PATTERN.md)): a property takes its value whole, of exactly its type
  (`.ref(True)`, `.layout("dense")`); an adjacency takes an iterable, each item an entry, the object to link, or a
  callback taking `OfThem.Visitor`, which writes the entry's `name`, its link (`t.property(p)`), and the linked object's
  members (`t.type([T])`). Where a relation allows one entry, the shorthand replaces it, and `insert` raises until it
  is removed; an entry linking a referent held is elided.
- **`as_*`.** `as_schema()` is `Meta.X`, and a member's `as_schema()` its property or adjacency in `Meta.X`;
  `as_properties` and `as_adjacencies` follow the meta-schema's order; `as_identity()` reads the identity and
  `as_identity(x)` writes it, `update()` keeping the object's own unless one is written, which renames it.
- **The data stores members its own way** (Resolved: "the Data class can store `Schemas.OfObject.Data.properties` any
  way it wants"), and the builder adapts each adjacency to it: a dict of members by name, or a tuple in order; a field
  holding the referent; an application's arguments by their parameter's name; a width the data holds as an int read as
  the literal form `Form("literal", {"value": 8})`. A keyed member's name is written to the member's data.
- **Derivation happens at finalization**, in `_finalize`: a refinement takes the token, `ref`, index and element of what
  it refines unless it is given them. No member's write has a side effect besides it (Resolved: "shortcuts are
  refused"), so `.singleton(...)` no longer sets `ref`.
- **Finalizing** is `create()`, `clone()` or `update()`, as the old builders' are; none validate. A clone clones the
  members it owns, each with an identity of its own; an object schema's inherited members stay shared.

### Building in a store

`Builders.Store` is a `Proxies.OfStore` that also holds schema objects, and the canonical form of building is
`store.moduleName.[...moduleName].schemaName(cb)` (Resolved: "This is the new canonical form for store-centric
building"): a callback creates, an object and a callback update, an object alone clones, and the call returns the
object. `store.Schemas.<Kind>(...)` builds a schema object, for `Scalar`, `Object`, `Union`, `Intersection`,
`Container`, `Apply`, `Any`, `Relation`, `Predicate`, `Property`, `Parameter`, `Symbol`, `Member`, `Adjacency` and
`Form`; any other registered name builds data, through the proxy builder.

- **The meta-schemas are in every store**, registered under their names, but for `Schemas.Module`, which every store of
  proxies holds in its old form (`Stores.META`) until the wire format moves.
- **Identities.** Every schema object gets one on creation (Resolved: "all schema objects are reference objects and all
  reference objects get an ID on creation"): the one written, else a named schema's name, else a UUID; members built
  with a schema get theirs too. The store refuses an identity another of its schema objects holds.
- **Registration.** A named schema is registered under its name as it is created, so `store.crm.Person(...)` builds
  data right after `store.Schemas.Object(lambda o: o.name("crm.Person") ...)`; a renamed schema is registered again
  under its new name.

Not built yet (the [work items](proposals/schema-builders/README.md#work-items)): modules in the store, defining
schemas through `Defines`; schemas written and read through these meta-schemas (`Modules`, `Plain`); TypeScript; and
the landing in `Schemas.py` and `Proxies.py`, with the old builders removed (Plan, phase 3).

## Phase 5 design: the draft's questions

The phase 5 draft (Plan; as FRAMEWORK.md, Resolved, "The meta-schemas overhaul" decides it) put eight points, each
with a question, for review. The schema builders answer most of them; each point says how, or that it is still open.

1. **What a schema is in memory.** Answered: `Schemas.OfX.Data` stays, bespoke, and its builder is the linked view of
   it, a visitor of its meta-schema that adapts the data's storage (Resolved, "Schema builders align with their
   meta-schemas": "Schemas.OfX.{Builder, Data, Schema} are necessarily bespoke", "little to no effect on the
   `Schemas.OfX.Data` and `Schemas.OfX.Schema`"; The builders, above). The data are not proxies and need not implement
   the visitors ("Dataclasses do not have to implement Visitors or Readers"). How the linked form goes over the wire is
   point 7.
2. **Which elements are objects.** Answered: every schema of every kind and every member is a reference object, the
   members linked to their owner by relations (Resolved, the same entry, which answers this question by name; The
   meta-schemas, above). As built, the member relations are `Has*`, a member's name is its entry's, and terms and
   arguments are reference objects too.
3. **The type links.** Built as separate relations, not one `Typing` with a `role`: `Typing`, `Indexing`,
   `Containing`, `Applying`, `AnyOf`, `Relating`, and `Refines`, `Binding`, `ArgumentTerm`, `Requires`, `BitWidth` and
   `ByteWidth` (The meta-schemas, above); the user named the referred end of `Typing` and `AnyOf` `schema` (Resolved:
   `e2.schema(Contact)`). The other relations' names and splits were proposed in building and await the user's review.
4. **Anonymous adjacencies.** Answered and built, for any relation (Resolved, "Refinement, identities and relations";
   VAL-15); the meta-schemas declare one at every end referred to. A snapshot writing an entry under its named ends
   only, and `Reachable` following named adjacencies, wait for the wire format (point 7).
5. **Identities.** Superseded in part: a schema object's identity is the one written, else a named schema's name, else
   a UUID (Building in a store, above), so a named schema's name is its identity, as the draft did not propose. Only
   `Schemas.Module` has a naming pattern. Whether module snapshots are made reproducible by naming patterns, as the
   draft proposed, is still open, with the wire format.
6. **Modules and names.** The meta-relation is built, `Defines(module, name, schema)` (Resolved: "a module is an object
   in a store, alongside schemas and data"); modules in the store, nesting (`Defines` defines schemas, not yet
   modules), `root_module()` and qualified names are not. Still open: Open questions, "Resolving qualified names".
7. **The wire.** Still open, and the next work item (Schema builders as visitors, Work items, 1): Modules and Plain read
   and write schemas through these meta-schemas as linked reference objects, and `Schemas.Module`, `Modules.reference`
   and `resolve`, `Stores.META` and `Schemas.OfAny.Schema` go, as Resolved, "The meta-schemas overhaul" decides.
8. **Building a link's target inline.** Answered for types by the later decision: a link to a type takes a schema that
   exists, never a callback that builds one (Resolved, "Schema builders align with their meta-schemas", a property's
   type). A link whose target is of one kind (a member, a term, an argument, an adjacency's relation) builds it
   through that kind's builder, so no schema is given; `.<link>.of(schema, spec)`, which Resolved, "The meta-schemas
   overhaul" records, is not built.

## Open questions

- **A value object held by an entry of a relation of two or more links, with adjacencies.** The entry is written under
  each object it links, so the value object is too, with one `$id`; reading would count the copies as one object, as
  it counts the entry once. Until then, only a one-link relation's entries may hold value objects with adjacencies.
- **Sparse integer keys.** Settled by containers (V5): a container is `.dense()` or `.sparse()`, so codegen need not
  infer an indexable from a relation's keys.
- **Resolving qualified names.** A name qualified with dots names a schema through nested modules; whether an
  unqualified name resolves outward through the enclosing modules before the store, or only within its own module, is
  to be settled in phase 5. Name resolution stays closed either way: a name resolves or is refused.
- **Shape constraints bound to parameters.** Extents go, and a shape is a constraint on the type of the property that
  keys a relation's entries; how a parameter (Parametrics) is bound into such a constraint, to give a tensor's shape,
  is the Parametrics work's.

---

<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)
