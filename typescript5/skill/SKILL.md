---
name: mbse-schemas
description: Model structured data and interfaces once, as a neutral, language-independent schema (objects, relations with properties, unions, intersections, containers), then build, serialize (JSON/YAML), validate, compare and query instances in Python or TypeScript. Use when formalizing an interface or data model (MBSE/SysML blocks and associations, interface control documents, API or data-exchange models, data models shared across languages), or when writing code that imports mbse.Schemas.Framework or @mbse/schemas/Framework.
---

# mbse-schemas

A schema here is data, not a class: an object in a store, built with the same fluent calls as the data it describes.
It is a semantically normalized formalization of an interface: shared objects are linked by relations, values are held
by properties and containers, nothing is implicit, and one schema means the same thing in every language. Python
(`mbse.Schemas.Framework`) and TypeScript (`@mbse/schemas/Framework`) implement the same API, name for name, and write
byte-identical JSON. What it can do is mbse-basis'
[schema-driven data features](mbse:mbse-basis/docs/features/README.md#schema-driven-data),
[FEA-025: serialization behavior conventions in schema](mbse:mbse-basis/docs/features/FEA-025.md) to
[FEA-037: the framework built on its own protocols](mbse:mbse-basis/docs/features/FEA-037.md), and their capabilities.

This skill says why and when to do each thing, and how in general terms, in the names both implementations share. Each
how links its case in the tutorials or tests of each language, where it runs, with its output: read the one for your
language. Where the languages spell a thing differently, [In each language](#in-each-language) says so.

## When to use it
<!-- no case: says when to use the package, not how -->

- You need one description of an interface or data model that several programs, languages or tools must agree on.
- The data is a graph: shared objects, relationships with their own attributes, inverse navigation, cycles.
- You are formalizing an MBSE model (blocks, ports, associations, multiplicities, variants, parameters) outside a
  modeling tool.

It is a poor fit for one-off, tree-shaped records used by a single program, where a plain class is simpler. Why the mbse
repositories exist, and this one's part: [Why the mbse repositories exist](mbse:mbse-schemas/MBSE.md).

## Practices that prevent most mistakes

1. **Everything is built in a store, and a module defines its schemas in an install.** *Why*: a schema written as
   data in a store is one description that every program and language reads alike; an install that finds before it
   makes can run at every start, and another can add to it. *When*: always; a program makes the stores it needs, and
   each is separate from the others. *How*: make a store (`Builders.Store`); write a module-scope `install(txn)` that
   returns one upsert whose symbols are the schemas it defines, each of its kind (`txn.Schemas.OfObject`), and whose
   spec writes each with the builders' fluent calls (`.name(...)`, `.ref(...)`, `.properties(...)`); run it with
   `store.transaction(install)`. Its symbols may link each other in any order; run again, it finds them by name and
   writes nothing. Build data with `store.<dotted name>(...)`, and pass the store to every serializer and validator.
   Stores share nothing: objects move between them as documents or snapshots, and `Proxies.store_of(x)` gives the
   store an object belongs to.
   [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md),
   [CAP-161: isolated stores, with no global registry](mbse:mbse-basis/docs/capabilities/CAP-161.md).
   - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
   - Python: [T02.1: The schemas](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.1) · TypeScript: [T02.1: The schemas](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.1)
   - Python: [INS-01: A module's install defines its schemas, each kind a symbol of its meta-schema](mbse:mbse-schemas/python3/tests/32_Installs.ipynb#INS-01) · TypeScript: [INS-01: A module's install defines its schemas, each kind a symbol of its meta-schema](mbse:mbse-schemas/typescript5/tests/32_Installs.ipynb#INS-01)
   - Python: [STO-03: Stores are isolated; objects move between them as snapshots](mbse:mbse-schemas/python3/tests/20_Stores.ipynb#STO-03) · TypeScript: [STO-03: Stores are isolated; objects move between them as snapshots](mbse:mbse-schemas/typescript5/tests/20_Stores.ipynb#STO-03)
2. **Link shared objects with relations; hold values in containers.** *Why*: a list of shared objects copies them,
   can't be navigated back from, and has nowhere for a fact about the link itself (a label, a date). *When*: a
   collection. *How*: objects that stand on their own (reference objects) are linked by a relation of two links or
   more, whose entries may carry properties; each object sees the relation through an adjacency, which names the link
   it fills (`.me(...)`). Values one owner holds (a list, a dict, a tensor) are a property holding a container, its
   index and element schemas given where it is linked.
   [CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md).
   - Python: [T02.1: The schemas](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.1) · TypeScript: [T02.1: The schemas](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.1)
   - Python: [T02.4: Shared addresses: one entry, two views](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.4) · TypeScript: [T02.4: Shared addresses: one entry, two views](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.4)
   - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
   - Python: [T04.1: One relation, two adjacencies on the same schema](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.1) · TypeScript: [T04.1: One relation, two adjacencies on the same schema](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.1)
3. **Reference object or value object.** *Why*: a thing with identity must be shared, not copied; a value must be
   copied, never shared. *When*: each object schema. *How*: mark a reference object schema with `.ref(...)`: it is
   built on its own and reached through relations. Any other object schema is a value object's: held by a property, a
   container or an entry, copied with its owner, never linked, and without adjacencies.
   [CAP-154: value objects and reference objects](mbse:mbse-basis/docs/capabilities/CAP-154.md).
   - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
   - Python: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.4) · TypeScript: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.4)
   - Python: [EMB-09: Value objects hold containers of their own](mbse:mbse-schemas/python3/tests/14_Embedded.ipynb#EMB-09) · TypeScript: [EMB-09: Value objects hold containers of their own](mbse:mbse-schemas/typescript5/tests/14_Embedded.ipynb#EMB-09)
4. **Nothing is mandatory; absent is not a value.** *Why*: old data lacks new properties, and "unset" must differ
   from `""`, `0` or false. *When*: reading any property. *How*: an absent property's `get()` reads as none (`None`,
   `null`), which no property holds as a value, and an absent one is left out of what is written; clear a value
   through its visitor (`as_value`, then `clear()`). Cardinality is a relation's `unique` clauses (`.uniques(...)`),
   which name its links and properties: an upper bound only, and a set of entries where a clause is declared. "At
   least one" is a constraint, written with mbse-patterns.
   [CAP-025: nothing mandatory but by constraint](mbse:mbse-basis/docs/capabilities/CAP-025.md),
   [CAP-155: `unique` clauses on relation schemas govern relation cardinality](mbse:mbse-basis/docs/capabilities/CAP-155.md),
   [CAP-152: relation constraint terms as mandatory, possible, or forbidden entry patterns](mbse:mbse-basis/docs/capabilities/CAP-152.md).
   - Python: [T01.6: "Not set" reads as None](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.6) · TypeScript: [T01.6: "Not set" reads as null](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.6)
   - Python: [T02.6: Entries form a set, because the relation says so](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.6) · TypeScript: [T02.6: Entries form a set, because the relation says so](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.6)
   - Python: [T05.2: Reading unique(S)](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.2) · TypeScript: [T05.2: Reading unique(S)](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.2)
5. **Read through visitors; change through builders, within a transaction.** *Why*: a change can touch several
   objects at once, so it is assembled in one place and takes effect at one moment, all of it or none. *When*: every
   write, to a schema or to data. *How*: an object is read-only; each member is its property's visitor, read with
   `get()`. One call builds: given a callback it creates, given an object and a callback it updates that object,
   given an object alone it clones it. Entries are inserted and removed through an adjacency's visitor (`insert`,
   `remove`, which removes every entry agreeing with a template, and `clear`), or given as a list of what they link
   (the peer shorthand). An adjacency iterates its entries, each link the linked object itself; `project(name)` gives
   each entry's link or property, and `at(key)` the entry by the key its relation declares. Write within
   `store.transaction`; a write outside one is refused, and one that raises writes nothing. A schema that existed
   before a transaction changes when it ends, so write data of a schema you extend in the next one.
   [CAP-107: one visitor protocol reads and writes data](mbse:mbse-basis/docs/capabilities/CAP-107.md),
   [CAP-124: writes all-or-nothing in transactions](mbse:mbse-basis/docs/capabilities/CAP-124.md),
   [CAP-125: imperative transaction scope](mbse:mbse-basis/docs/capabilities/CAP-125.md).
   - Python: [T01.3: Making contacts](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.3) · TypeScript: [T01.3: Making contacts](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.3)
   - Python: [T01.4: Instances are read-only](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.4) · TypeScript: [T01.4: Instances are read-only](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.4)
   - Python: [T01.5: Changing things: one call, three meanings](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.5) · TypeScript: [T01.5: Changing things: one call, three meanings](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.5)
   - Python: [T02.3: Adding entries](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.3) · TypeScript: [T02.3: Adding entries](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.3)
   - Python: [T03.1: Removing an entry](mbse:mbse-schemas/python3/tutorials/03_Moving_House.ipynb#T03.1) · TypeScript: [T03.1: Removing an entry](mbse:mbse-schemas/typescript5/tutorials/03_Moving_House.ipynb#T03.1)
   - Python: [T03.4: What an update replaces](mbse:mbse-schemas/python3/tutorials/03_Moving_House.ipynb#T03.4) · TypeScript: [T03.4: What an update replaces](mbse:mbse-schemas/typescript5/tutorials/03_Moving_House.ipynb#T03.4)
   - Python: [PRX-19: An adjacency is a tuple of its entries](mbse:mbse-schemas/python3/tests/03_Proxies.ipynb#PRX-19) · TypeScript: [PRX-19: An adjacency is a tuple of its entries](mbse:mbse-schemas/typescript5/tests/03_Proxies.ipynb#PRX-19)
   - Python: [BLD-13: Proxies: a container property's value given whole](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-13) · TypeScript: [BLD-13: Proxies: a container property's value given whole](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-13)
   - Python: [TXN-11: A transaction's imperative scope](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-11) · TypeScript: [TXN-11: A transaction's imperative scope](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-11)
6. **Scalars are exact, and there are five.** *Why*: coercion is where data silently changes meaning between
   languages. *When*: every property of a value. *How*: a store's basic scalars, `store.Schemas.OfBool`, `OfInt`,
   `OfFloat`, `OfStr` and `OfBytes`, are its only scalar schemas; `1`, `1.0` and true are different values, and none
   is converted; a path names the schema, which `as_schema()` gives where an object is wanted. A finer scalar (a
   date, a 32-bit int) is a domain, mbse-expressions'; until then, give the property its basic scalar and say what it
   means in its description. Builders take any value; the validators and the serializers refuse a value of another
   scalar.
   [CAP-156: the five basic scalars with boundless domains](mbse:mbse-basis/docs/capabilities/CAP-156.md).
   - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
   - Python: [T01.7: Builders don't check values](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.7) · TypeScript: [T01.7: Builders don't check values](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.7)
   - Python: [T06.4: Serializers check values](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.4) · TypeScript: [T06.4: Serializers check values](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.4)
   - Python: [SCH-02: The scalar schemas are the basic scalars every store holds, or given as data by host type](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-02) · TypeScript: [SCH-02: The scalar schemas are the basic scalars every store holds, or given as data by host type](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-02)
7. **Validate when you ask.** *Why*: building is cheap and may pass through incomplete states; a check on every
   assignment would refuse them, and stop at the first problem. *When*: before you trust data, and when a schema is
   done. *How*: `schema.validate()` lists a schema's problems; `Validators.Validate(store)(schema, value)` checks a
   value and its entries, and `.Reachable(schema, root)` everything connected to it, each problem with a path.
   `Validators.Check` gives an outcome that may also be unknown. Decoding does not validate.
   [CAP-160: data validated against its schema on request](mbse:mbse-basis/docs/capabilities/CAP-160.md).
   - Python: [T01.2: Checking the schema, when you ask](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.2) · TypeScript: [T01.2: Checking the schema, when you ask](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.2)
   - Python: [T05.3: Good data](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.3) · TypeScript: [T05.3: Good data](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.3)
   - Python: [T05.4: Bad data, all of it at once](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.4) · TypeScript: [T05.4: Bad data, all of it at once](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.4)
   - Python: [T05.8: Validating a single value](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.8) · TypeScript: [T05.8: Validating a single value](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.8)
   - Python: [VAL-16: Check gives an Outcome: its problems and unknowns, and whether the data holds](mbse:mbse-schemas/python3/tests/08_Validators.ipynb#VAL-16) · TypeScript: [VAL-16: Check gives an Outcome: its problems and unknowns, and whether the data holds](mbse:mbse-schemas/typescript5/tests/08_Validators.ipynb#VAL-16)
8. **Give what must be found again an identity.** *Why*: an object found again by loading, or designated in a
   request, needs a name that outlives the program; a counted object has none, beyond a document's number. *When*: an
   object is updated in place, shared between programs, or referred to. *How*: a singleton (`.singleton(...)`) is
   found by its global name; an owned object, linked to its owner by a keyed relation whose adjacency is marked
   `.owner(...)`, by its owner's path and its key, which a naming pattern on the key can give; everything else is
   counted. `store.singleton(...)` gives a singleton, `store.Instances` finds one by its global name, and any
   adjacency looks its entries up by their keys. Designate an object, a relation entry or a frame with a reference,
   `References.of(store, x)`, a value written and read as any is, and find what it designates with
   `References.resolve`; a counted object has none.
   [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md),
   [CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md),
   [CAP-133: no durable references to counted objects](mbse:mbse-basis/docs/capabilities/CAP-133.md).
   - Python: [T09.3: Unique customer IDs: a directory](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.3) · TypeScript: [T09.3: Unique customer IDs: a directory](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.3)
   - Python: [T06.1: One object](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.1) · TypeScript: [T06.1: One object](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.1)
   - Python: [T10.7: Handing frames on](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.7) · TypeScript: [T10.7: Handing frames on](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.7)
   - Python: [IDN-05: An object built without an owner is given the one its schema allows](mbse:mbse-schemas/python3/tests/29_Identity.ipynb#IDN-05) · TypeScript: [IDN-05: An object built without an owner is given the one its schema allows](mbse:mbse-schemas/typescript5/tests/29_Identity.ipynb#IDN-05)
   - Python: [IDN-06: Lookup by keys](mbse:mbse-schemas/python3/tests/29_Identity.ipynb#IDN-06) · TypeScript: [IDN-06: Lookup by keys](mbse:mbse-schemas/typescript5/tests/29_Identity.ipynb#IDN-06)
   - Python: [REF-03: A counted object has no reference, nor a frame that binds one](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-03) · TypeScript: [REF-03: A counted object has no reference, nor a frame that binds one](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-03)
9. **Grow schemas by installs; refine, version and generate them as data.** *Why*: a schema changes as requirements
   do, and every program must see one change, not copies. *When*: adding, removing or narrowing members, versioning, or
   making schemas from another description. Load [Designing and extending schemas](references/schemas.md).
   [FEA-031: schemas as extensible data](mbse:mbse-basis/docs/features/FEA-031.md).
   - Python: [T09.1: Adding a property](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.1) · TypeScript: [T09.1: Adding a property](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.1)
   - Python: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.1) · TypeScript: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.1)
10. **Ask the store with a transaction's expression.** *Why*: a query written as data runs the same in every
   language and store, and an upsert that finds before it creates can run again harmlessly. *When*: finding,
   filtering, traversing or writing data by a pattern. Load [Querying with transactions](references/queries.md).
   [FEA-027: mutations as queries](mbse:mbse-basis/docs/features/FEA-027.md).
   - Python: [T10.1: A transaction as an expression](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.1) · TypeScript: [T10.1: A transaction as an expression](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.1)
11. **Exchange data as documents, journals and snapshots, strictly.** *Why*: what one program writes, another must
   read exactly, never by guessing. *When*: saving, loading, sending or replaying data. Load
   [Saving, loading and exchanging data](references/serialization.md).
   [CAP-128: graphs sent as one-transaction documents](mbse:mbse-basis/docs/capabilities/CAP-128.md).
   - Python: [T06.2: A whole graph](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.2) · TypeScript: [T06.2: A whole graph](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.2)
   - Python: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.3) · TypeScript: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.3)
12. **Keep history with Provenance.** *Why*: who changed what, when and from where, must be data in the store, made
   the same way when a journal is replayed. *When*: an app must attribute or audit writes. *How*: install `Provenance`
   after the app's own install, and `Provenance.extend` the schemas whose objects it links to their records. Give each
   transaction's expression its `uid`, `when` (UTC ISO 8601 text), `session` (an `id`, `who`, `locale`, `device`) and
   `where`; a service sets them from the request, the session and identity from the token it validated. An
   imperative write gets placeholders. An object's links to its records are anonymous: read them from the record's
   side, with a map whose symbol is given the object's reference.
   [CAP-134: transactions recorded with provenance](mbse:mbse-basis/docs/capabilities/CAP-134.md),
   [CAP-135: provenance records reproducible and attributable](mbse:mbse-basis/docs/capabilities/CAP-135.md),
   [CAP-177: sessions and identities from a validated token](mbse:mbse-basis/docs/capabilities/CAP-177.md),
   [CAP-178: an object's provenance read through its own named adjacencies](mbse:mbse-basis/docs/capabilities/CAP-178.md).
   - Python: [T12.1: Who changed what: provenance](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.1) · TypeScript: [T12.1: Who changed what: provenance](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.1)
   - Python: [T12.2: An object's records, read from the record's side](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.2) · TypeScript: [T12.2: An object's records, read from the record's side](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.2)
   - Python: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/python3/tests/34_Provenance.ipynb#PRV-06) · TypeScript: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/typescript5/tests/34_Provenance.ipynb#PRV-06)
13. **Write tools once, for every schema.** *Why*: a tool written per class must be rewritten for each; one written
   against the visitor protocol and the schemas as data works for any. *When*: documentation, audit logs, dumps,
   generators, comparisons. *How*: walk a schema's members (`properties`, `adjacencies`, `links`, `uniques`); read any
   object with `as_schema()`, `as_properties` and `as_adjacencies(...)`; list what is connected to an object with
   `Reachable.of`; compare values under their schema with `Comparison`, which says equal, ordered or incomparable.
   [CAP-107: one visitor protocol reads and writes data](mbse:mbse-basis/docs/capabilities/CAP-107.md),
   [CAP-111: equality and ordering defined by the schema](mbse:mbse-basis/docs/capabilities/CAP-111.md).
   - Python: [T08.1: Tool 1: a data dictionary, generated from schemas](mbse:mbse-schemas/python3/tutorials/08_Tools_For_Every_Schema.ipynb#T08.1) · TypeScript: [T08.1: Tool 1: a data dictionary, generated from schemas](mbse:mbse-schemas/typescript5/tutorials/08_Tools_For_Every_Schema.ipynb#T08.1)
   - Python: [T08.2: Tool 2: reading any object, through the visitor protocol](mbse:mbse-schemas/python3/tutorials/08_Tools_For_Every_Schema.ipynb#T08.2) · TypeScript: [T08.2: Tool 2: reading any object, through the visitor protocol](mbse:mbse-schemas/typescript5/tutorials/08_Tools_For_Every_Schema.ipynb#T08.2)
   - Python: [T04.5: Everything connected: Reachable.of](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.5) · TypeScript: [T04.5: Everything connected: Reachable.of](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.5)
   - Python: [CMP-05: Objects are equal when their declared properties are, and are otherwise incomparable](mbse:mbse-schemas/python3/tests/13_Comparison.ipynb#CMP-05) · TypeScript: [CMP-05: Objects are equal when their declared properties are, and are otherwise incomparable](mbse:mbse-schemas/typescript5/tests/13_Comparison.ipynb#CMP-05)
14. **Pass randomness in.** *Why*: data drawn from a source the program holds is the same in both languages, today
   and later, from the same seed; a store holds none. *When*: anything draws pseudorandom values. *How*: make a
   source, `Stores.PCG32(seed)`, split it by a key for each use (`split(key)`), and give it to what draws.
   [PRI-013: nondeterminism passed in](mbse:mbse-basis/docs/PRINCIPLES.md#PRI-013).
   - Python: [RND-02: A split stream is determined by the seed and the key alone](mbse:mbse-schemas/python3/tests/21_Random.ipynb#RND-02) · TypeScript: [RND-02: A split stream is determined by the seed and the key alone](mbse:mbse-schemas/typescript5/tests/21_Random.ipynb#RND-02)
   - Python: [RND-03: A source is given to what draws from it; a store holds none](mbse:mbse-schemas/python3/tests/21_Random.ipynb#RND-03) · TypeScript: [RND-03: A source is given to what draws from it; a store holds none](mbse:mbse-schemas/typescript5/tests/21_Random.ipynb#RND-03)

## Load the reference for your task
<!-- no case: a table routing each task to its reference -->

| Task | Read |
|---|---|
| Decide how to model something: MBSE, UML, ORM or JSON Schema concepts mapped to schema elements | [Modeling with mbse-schemas](references/modeling.md) |
| Design new schemas, or extend, version, refine or generate existing ones; values of any schema; parameters | [Designing and extending schemas](references/schemas.md) |
| Find, filter, traverse or write data with a transaction's expression: terms, patterns, specs, frames and their references | [Querying with transactions](references/queries.md) |
| Save, load or exchange data: documents, journals, snapshots and strict decoding | [Saving, loading and exchanging data](references/serialization.md) |
| Constraints over data: mandatory, possible or forbidden entries | the separate [mbse-patterns](https://github.com/pitaman71/mbse-patterns) package, and its skill |
| Expressions and value domains | the separate [mbse-expressions](https://github.com/pitaman71/mbse-expressions) package, and its skill |

## In each language

The two implementations are equivalent: the same names, results, messages and JSON. Where a language forces a
difference (mbse-schemas' [Equivalence of the implementations](mbse:mbse-schemas/docs/EQUIVALENCE.md)), each case shows its own:

- **Scalars.** Python's host types are `int`, `float`, `str`, `bool` and `bytes`; TypeScript's are `BigInt`,
  `Number`, `String`, `Boolean` and `Uint8Array`, and an int is a `bigint` (`7n`), where `7` is a float. Absent is
  `None` in Python, `null` in TypeScript. Python's `True` is no int, though its `bool` subclasses `int`.
  - Python: [T01.6: "Not set" reads as None](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.6) · TypeScript: [T01.6: "Not set" reads as null](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.6)
  - Python: [T04.2: Building a family from either side](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.2) · TypeScript: [T04.2: Building a family from either side](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.2)
  - Python: [SCH-03: to_plain / from_plain: exact scalars, both directions](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-03) · TypeScript: [SCH-03: to_plain / from_plain: exact scalars, both directions](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-03)
- **Reading a scalar.** Python reads a member with `str(...)`, `int(...)` or `get()`, and a member compares, orders
  and hashes as its value; but `bool()` of a member is its value, raising where it is absent, so ask `get()` for
  presence. TypeScript reads with `` `${...}` ``, `BigInt(...)` or `get()`, and compares once read
  (`x.name.get() === "Ada"`): a member is a callable `Proxy`, never `===` a scalar, and always truthy.
  - Python: [T01.3: Making contacts](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.3) · TypeScript: [T01.3: Making contacts](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.3)
  - Python: [VIS-06: Scalar dunders](mbse:mbse-schemas/python3/tests/02_Visitors.ipynb#VIS-06) · TypeScript: [VIS-06: Scalar sugar](mbse:mbse-schemas/typescript5/tests/02_Visitors.ipynb#VIS-06)
- **The store and its builders.** Python makes a store with `Builders.Store()` and writes within
  `with store.transaction():`; TypeScript with `new Builders.Store()`, declared `any`, its callbacks annotated
  `(x: any) =>`, and writes within `store.transaction(() => ...)`, which gives back what the function returns. A
  schema builder is `Builders.OfObject.Builder(schema, store=store)` in Python, `new Builders.OfObject.Builder(schema,
  true, store)` in TypeScript.
  - Python: [T01.5: Changing things: one call, three meanings](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.5) · TypeScript: [T01.5: Changing things: one call, three meanings](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.5)
  - Python: [T09.2: A second version, side by side](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.2) · TypeScript: [T09.2: A second version, side by side](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.2)
- **Plain data.** Python's plain mappings are `dict`s; TypeScript's are `Map`s, as are a transaction's frames, and a
  map given whole may be a `Map` or a record. TypeScript's decoders return `unknown`: cast the result.
  - Python: [T06.1: One object](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.1) · TypeScript: [T06.1: One object](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.1)
  - Python: [T10.1: A transaction as an expression](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.1) · TypeScript: [T10.1: A transaction as an expression](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.1)
- **Errors and names.** TypeScript's `ValueError`, `AttributeError`, `KeyError`, `LookupError` and `DecodeError` are
  classes in `@mbse/schemas/Framework/Errors`; `TypeError` is JavaScript's. In both, names starting with `_`, and a
  builder's own methods (`create`, `clone`, `update`), are never members.
  - Python: [T06.5: Loading errors: DecodeError](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.5) · TypeScript: [T06.5: Loading errors: DecodeError](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.5)
  - Python: [PRX-04: Finding F2 (pinned): names that collide with builder or instance members](mbse:mbse-schemas/python3/tests/03_Proxies.ipynb#PRX-04) · TypeScript: [PRX-04: Finding F2 (pinned): names that collide with builder or instance members](mbse:mbse-schemas/typescript5/tests/03_Proxies.ipynb#PRX-04)
- **Traps of both.** A relation has two links or more, and a value object no adjacencies. Setting a value object into
  a property or an entry copies it (`Proxies.owner_of(x)` gives the object it belongs to); edit one in place through
  a callback. A schema builder's value properties take exactly their schema's values (a reference object schema is
  marked with true, never `1`), and a reference to another schema object is a list of what it links, even where only
  one is allowed.
  - Python: [SCH-13: OfRelation.validate covers link, property and uniqueness problems](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-13) · TypeScript: [SCH-13: OfRelation.validate covers link, property and uniqueness problems](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-13)
  - Python: [EMB-09: Value objects hold containers of their own](mbse:mbse-schemas/python3/tests/14_Embedded.ipynb#EMB-09) · TypeScript: [EMB-09: Value objects hold containers of their own](mbse:mbse-schemas/typescript5/tests/14_Embedded.ipynb#EMB-09)
  - Python: [BLD-06: Property shorthands](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-06) · TypeScript: [BLD-06: Property shorthands](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-06)
- **Adapters.** Python's `Adapters.Dataclasses` writes an install from a program's dataclasses
  (`FromDataclass.install`) and dataclasses from schemas (`ToDataclass`); TypeScript has none, since an adapter
  translates its own language's type declarations
  ([CAP-162: Python dataclasses translated to and from schemas](mbse:mbse-basis/docs/capabilities/CAP-162.md)).
  - Python: [DC-09: A program's dataclasses as its schemas, end to end](mbse:mbse-schemas/python3/tests/16_Dataclasses.ipynb#DC-09)
  - Python: [DC-08: An install: its module found by its name or made, described](mbse:mbse-schemas/python3/tests/16_Dataclasses.ipynb#DC-08)

## Learn it by example
<!-- no case: points to the tutorials and the test plan as a whole -->

The tutorials teach it in twelve case studies, from a contact card to keeping a store's history, each a notebook
committed with its outputs and run as a test: [Python](mbse:mbse-schemas/python3/tutorials/README.md) and
[TypeScript](mbse:mbse-schemas/typescript5/tutorials/README.md). The test plan,
[Test plan — python3](mbse:mbse-schemas/python3/tests/TestPlan.md), lists every case.
