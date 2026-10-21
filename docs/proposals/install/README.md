# Installing schemas (4i, a draft for review)

[Store overhaul, 4i](../store-overhaul/README.md) carries out Object identity, Decided, 86: "`store.extend` is
basically replaced by this new `install` convention". Every module that defines schemas does so in a module-scope
`install(txn)`, whose transaction upserts them: each schema object a symbol of its meta-schema, found by its name, else
created, and its spec written where it does not hold. Run again, an install finds what it defined and writes nothing;
given more, it extends it.

The two drafts beside this file show the framework's own modules in that form, each schema written out in the
builders' fluent syntax (mbse-basis P-019: "Do not invent another DSL by wrapping builder syntax"), with no helper that
builds part of the model and no table that generates it:

- [Schemas.py](Schemas.py): the plain schemas of schemas (level 2) and the basic scalars, which `Builders._plain()`
  builds today, defined by `Schemas.install`. Level 3, the dataclasses, is unchanged.
- [Mutations.py](Mutations.py): `Mutations.schemas(Text, Int, Path, ...)` becomes `Mutations.install`, the same
  schemas by the same names, each symbol named as today's variable is (`Ref`, `PropertySet`), naming what it uses from the transaction (`txn.Schemas.OfStr`, `txn.Paths.OfRoot`, 78).

`Paths.py` follows `Mutations.py`, four schemas. TypeScript mirrors all three.

## The bootstrap

An install's transaction is typed by the schemas these three define: its terms are `Mutations.OfTransaction` and its
kin, its symbols' schemas are meta-schemas, and its spec is recorded through their members. So the framework's own
installs cannot run as transactions in a store that does not hold them yet.

Proposed: **one definition, two interpreters.** A store is made by reading `Schemas.install`, `Paths.install` and
`Mutations.install`, in that order, through the builders directly: the bootstrap hands each one a `txn` whose upsert
binds each symbol to a builder of its kind (level 3 says which: `txn.Schemas.OfObject` is `ObjectBuilder`), finds it by
name among what it has made, else makes it, and calls each spec callback on those builders, which take the same calls a
spec records. The result is what `_plain()`, `Paths.schemas` and `Mutations.schemas` build today, and the builders'
template (`_TEMPLATE`) is made the same way. In a made store, the same function runs as an ordinary transaction, through
the executor; a test reads every framework install again in a new store and finds that it writes nothing.

Considered and not proposed:

- a kernel written in code, with the installs checked against it: two definitions of every framework schema;
- the framework's schemas left in code as an exception to 86: what the user expects Schemas.py and Mutations.py to show
  is their install.

## What else 4i changes

- **`store.extend` goes.** An extension is a module's install: `store.transaction(Units.install)`. The extension check
  (SCHEMA_EXTENSION.md, Decided, 1) applies to what any transaction writes to a schema the store was made holding: it
  may only gain members.
- **`txn.Schemas.OfX` in a symbol** (78), where the store's own (`store.Schemas.OfObject`) is given today (4e-1).
- **A schema with no name of its own, defined in a spec where it is linked**: `S.OfContainer(lambda c: ...)` in a
  property's schema, as the drafts write lists. Inside a spec it defines one where it is linked, as `Mutations.OfObject.Def`
  does on the wire; it creates nothing on its own.
- **The executor completes what defining schemas needs.** Probing it found that an upsert cannot yet define a
  relation's links (`link 'link' is not set`); every kind and member the drafts use is to be covered, with tests.
- **`Mutations.Payload`**: `Payload`, an `OfAny` linked from many verbs, has no name today. A schema with no name of its
  own is linked from one place (81), so the draft names it, a 63rd mutation schema.

## Questions for the user

1. **The bootstrap**: one definition read by two interpreters, as proposed above?
2. **What migrates to `install`.** SCHEMA_EXTENSION.md, Injection, says "every schema definition must be written in a
   transaction passed to `install` defined at file scope". Proposed: the framework's modules, the conformance corpus,
   the examples, every extension (EXT's, and mbse-expressions' and mbse-programs'), and the README and skill; the test
   notebooks and tutorials keep building schemas within `store.transaction()` where a case is about building them, and
   use an install where a case needs a fixture of schemas. Or does every notebook move to installs too?
3. **A definition where it is linked**: `S.OfContainer(lambda c: ...)` inside a spec, as drafted?

## Decided

As the user decided (2026-10-21), on the questions above:

1. The bootstrap: "yes", one definition read by two interpreters, the builders when a store is made and the executor
   after.
2. What migrates: "everything": every schema definition, in the framework, the corpus, the examples, the README, the
   skill, the tutorials and every test notebook, is written in a module-scope `install(txn)`.
3. Size: Schemas.py more than doubles written out (113 lines to 260, its adjacencies 103 of them): "Worth it. We can
   further optimize later."

Still open: question 3, a definition where it is linked, which the user asked to see an example of.

