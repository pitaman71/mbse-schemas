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

4. A schema with no name of its own, defined in a spec where it is linked: `S.OfContainer(lambda c: ...)`, "as
   drafted", over a link-scoped form (`t.schema(lambda k: k.OfContainer(...))`). Inside a spec it creates nothing: it
   records a definition, which the executor makes where it writes the link, and finds holding where an equal one is
   linked there.

5. Which writes the extension check applies to, with `store.extend` gone: "Framework schemas, always". Any transaction,
   an install's, a snapshot read's or an imperative scope's, may only add members to a schema the store was made holding,
   each under a name it neither has nor a refinement of it declares; a store's own schemas change freely everywhere.
   Chosen over the check `store.extend` made, on every schema the store held before an install began, which would have
   kept one module's schemas from another's install but stopped a snapshot read from changing an existing schema.

6. The suites whose subject is the imperative schema builders (BLD, SCH, parts of STO) keep building schemas with them,
   since that API stays (the bootstrap and data use it); their shared fixtures move into installs. Every other suite,
   the tutorials, the examples, the corpus, the skill and the README define their schemas in installs: "that's an
   acceptable compromise".

## Stages

- **4i-1, defining schemas by transaction**: the executor and the spec recorders cover every kind and member the drafts
  use (a relation's links, a union's branches, a container's index and element, a definition where it is linked by
  `txn.Schemas.OfX(cb)`), and a symbol's schema is given as `txn.Schemas.OfX` (78); tests in both languages.
  As built: `store.transaction(install)` hands the install a transaction whose names, but its own members, are the
  store's schemas (`txn.Schemas`, `txn.Paths`); while a spec is recorded, `txn.Schemas.OfX(cb)` records a definition
  that one link may link, made with that link and found holding where an equal one is linked; an entry given in a list
  or mapping whose callback gives no link defines the object it links, as a builder's does; a link takes a list of one,
  as a link's builder does; a recorded property's value is finished as a builder finishes it (a container's builder
  built), which the recorder lost before. Probing found these; with them, `Schemas.install` as drafted runs in a store
  and writes nothing, and the Mutations draft's union branches are given as lists, which the builders take, not as
  mappings (a branch's relation has two properties). INS-01 to INS-03 cover them.
- **4i-2, the framework installs itself**: `Schemas.install`, `Paths.install` and `Mutations.install` replace
  `Builders._plain()`, `Paths.schemas` and `Mutations.schemas`, read by the bootstrap when a store is made; a test
  reads each again as a transaction in a store and finds it writes nothing.
  As built: the drafts beside this file are the modules' `install` now, and are kept as the proposal reviewed; where the
  modules differ, the modules hold. The bootstrap (`Builders._Bootstrap`, TypeScript's `Bootstrap`) reads each install
  as it is built: its upsert makes each symbol's schema object through its kind's builder, then calls each spec item on
  builders of the symbols it touches, updating them after it; `txn.Schemas.OfX` is a kind, which, called, builds one
  where it is linked, and names what is made; `txn.Paths.OfRoot` names what an earlier install made. Before the template
  exists, a keyed adjacency given a mapping is keyed by `name`, which every keyed relation's entries are. The framework's
  schemas are those `_plain()`, `Paths.schemas` and `Mutations.schemas` made, compared one by one, but for
  `Mutations.Payload`, named (63 mutation schemas), and `Mutations.Branching` and `Requiring`, whose relations keep their
  empty unique clause (`uniques([])`, entries a set), as before. Making a store takes about 23 ms in Python (15 ms
  before), 26 ms in TypeScript. INS-04 runs each framework install as a transaction in a made store, which writes
  nothing.
- **4i-3, extensions as installs**: `store.extend` goes; the extension check applies to what any transaction writes to
  a schema the store was made holding; EXT rewritten.
  As built (Decided, 5): `store.extend` and its bookkeeping go; a store's `_permit` checks every update of a framework
  schema, in any transaction, and lets the entries of an extension's relations change freely, as the store's own; the
  store's transaction gives each schema builder the members a transaction added to its plain schema when it ends, as
  `extend` did. The check's "which it inherits" goes with what it checked: a framework schema refines none, and none can
  come to, since `refines` only changes where the check allows. EXT is rewritten, every extension an `install(txn)`:
  EXT-02 checks framework schemas (a refinement of a refinement declaring a name, the store's own refining
  `Schemas.OfObject`), and EXT-03 extends one in an imperative scope.
- **4i-4, everything else migrates**: the corpus, the examples, the README, the skill, the tutorials and every test
  notebook define their schemas in a module-scope `install(txn)`, in batches, each with both gates at 100%; then the
  dependents, mbse-expressions and mbse-programs.
  As built so far:
  - the conformance corpus: each case's schemas a module-scope install written out (`rooted`, `address_book`, ...,
    `patterns`), its schema helpers (`_text`, `_list`, `_basics`) gone; each case runs its installs, then its data in a
    transaction of its own. The corpora are unchanged, byte for byte, in both languages;
  - a spec takes a schema object's builder's shorthands (`uniques("a")`), and writes a pattern's own spec over the
    symbols it declares, which name schemas the store holds: a pattern over schemas an install defines is installed
    after it (the corpus's `patterns`, after `address_book`). INS-03 covers both.
  - the examples: AddressBook, FamilyTree, Serialization, TextEncodings and University define their schemas in a
    module-scope `install`, their schema helpers (University's `text`) gone; SchemaBuilders, whose subject is the
    builders, keeps them (Decided, 6).
  - the README's example and the TypeScript package's, and the skill: each complete program defines its schemas in an
    install, the cheat sheets add the install beside the builder calls a spec makes, and the guidance (SKILL.md, 8;
    modeling.md, schemas.md) teaches installs; removing a member and cloning a version stay the builders', since an
    install only adds (4j) and does not clone.
  - the tutorials, in both languages: each case study's schemas an install, a second install adding to them where a
    case extends a schema (tutorials 2, 4, 5 and 9); tutorial 2's three steps are one install whose symbols link each
    other; tutorial 9's evolutions are installs, its version a builder's clone, and its table lists removing through a
    transaction as designed, not built (4j); its union and intersection, symbols of an install, are named
    (`crm.Reach`, `crm.Stamps`). Converted by three agents from a brief and tutorial 1, reviewed and re-executed.

