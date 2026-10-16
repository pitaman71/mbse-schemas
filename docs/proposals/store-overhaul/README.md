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

## Decided here

As the user decided (2026-10-16), on the questions put to them:

1. **The meta-schemas are the kinds**, one for each kind of schema: "the only meta-schemas we should have are:
   stores.Meta.OfX for every OfX in stores.Schemas.OfX", reached as "`store.Schemas.Meta.OfX`" ("is correct"):
   `store.Schemas.Meta.OfObject`, `.OfScalar`, `.OfRelation`, and so on, each a store's own.
2. **The base of every kind**: "`Meta.Schema` becomes `store.Schemas.Meta.Schema`".
3. **`Meta.Type` and `Meta.Typed` leave mbse-schemas**: "these can be defined using builder DSL as normal (not meta)
   union schemas in Expressions.Framework".
4. **A union's branches and an intersection's parts are relations**: "`Meta.Member` -> relation meta-schemas" `HasBranch`
   and `HasPart`, each entry carrying the member's name and description and linking its type.
5. **Properties stay objects**: "properties remain an object because they can have a description too".
6. **Modules are an ordinary schema**: "`Meta.Module` : normal schema `Schemas.OfModule`", which is also the namespace
   of identities (Object identity, Decided, 2).
7. **`Argument`, `Term` and `Form` go** in this overhaul: "drop whenever you think is best".
8. **The basic scalars are an ordinary union**: "normal schema `Schemas.OfBool`, `Schemas.OfBytes` ... which become
   variants of `Schemas.OfScalar`" (reading (b): `Schemas.OfScalar` a union whose branches are the five).
9. **Every finer scalar is a domain, in mbse-expressions**: "all scalars are domains and users may define domains and
   dialects containing domains"; "a scalar schema can have > 1 domain"; "width is a property of the domain, not the
   schema". A user defines no scalar schema of their own.
10. **Each kind declares an adjacency a module links**: "2 = (i)": a module's `schemas` adjacency is declared on each
    kind, not once on `Schemas.Meta.Schema` (which would need a union to declare adjacencies).

## Order of work

Each step lands on main as its own release, with both gates at 100%, the corpora regenerated and conformance passing,
so that main stays current and no branch waits on another.

1. **Per-store meta-schemas (0.14.0).** A store builds its own meta-schemas and basic scalars when it is made, and the
   module-level `Builders.Meta` goes. The kinds are renamed `Schemas.Meta.OfX` (1, 2). A builder finds its members
   through its store's meta-schema, so the members an extension adds (Schema extension, Decided, 18) are each store's
   own, not added to a shared class. `Builders.extend`, the framework store, and the framework entries of 0.12.1 and
   0.12.2 go; `store.extend` is the only extension. EXT is rewritten: round trips between stores with the same
   extensions and with differing ones (Schema extension, Decided, 23).
   *Breaks*: every `Builders.Meta.X` (386 uses in 86 files: library, tests, tutorials, the skill, docs) and every
   `Builders.extend`.
2. **What leaves (0.15.0).** `Argument`, `Term`, `Form`, `OfApply`, `requires`, `bits` and `bytes`, and the value
   parameters (7; Schema extension, Decided, 5 to 7). `Meta.Type` and `Meta.Typed` go (3).
   *Breaks*: PAR (parametrics) and every test of forms, widths, applications and predicates' `requires`.
3. **Scalars and members (0.16.0).** `Schemas.OfScalar` becomes the union of the five basic scalars (8, 9); user
   scalar schemas, `token` and `format` go. Branches and parts become `HasBranch` and `HasPart` (4).
   *Breaks*: every user-defined scalar in tests, examples and tutorials; the module format of unions and
   intersections.
4. **Object identity (0.17.0).** `Schemas.OfIdentity`, containers, modules as namespaces (6), `store.Instances` and
   `as_instance`, `Schema@Path/Suffix` on the wire.
   *Breaks*: the snapshot format, so every corpus and every hand-written snapshot in the tests.

Then mbse-expressions redrafts its framework model on per-store extension (`Expressions.install(store)`, through
`store.extend`), with domains, dialects and `DefinesDomains` as the user described.

## Open, for the user

1. **What `Schemas.Meta.Schema` is.** A union of the kinds can be a type, but with 10 it declares no adjacency, and the
   kinds no longer refine it. What does it hold or type: the name and description every kind has?
2. **Building through the new names.** Does `store.Schemas.Meta.OfObject(lambda o: ...)` build an object schema, as
   `store.Schemas.Object(...)` does today? And does reading `store.Schemas.OfInt` (no call) give the schema object
   itself, so code links it without `Builders.Meta`?
3. **Applying a type parameter.** mbse-schemas keeps the parameters that denote schemas (`List[T]`, Schema extension,
   Decided, 14), but `OfApply`, which applied them, goes. How is `List[Int]` written?
4. **Scalars without tokens.** Each basic scalar maps to each language's host type by its own name, so `token` is not
   needed for them; with user scalar schemas gone, `format` (dates, UUIDs) becomes a domain. Agreed?
5. **When `Schema@` is inferred.** "omit `Schema@` when it can be inferred from context": I propose where a link's
   other end has one schema that may fill it, and within an object's own entry, which names its schema.
6. **A path given to a link.** Your `e.domain(Int32)` passed a path. With `as_instance`, a link is given the instance
   (`e.domain(store.Instances.Expressions.Dialects.Basic.as_instance('Int32'))`); should a link also accept a path to
   an instance?
7. **The order.** Four releases, as above, or fewer, larger ones?
