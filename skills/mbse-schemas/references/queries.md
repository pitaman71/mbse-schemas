# Querying with transactions

To find, filter, traverse and write data, give `store.transaction` an expression: a transaction whose `mutations` are
its terms. Its terms pass on a stream of *frames*: each frame binds the symbols that the terms before it declared,
each symbol to one object. A pattern's *spec* says what must be true of a frame. A map keeps the frames where it
holds, and an upsert or an update writes it where it does not. The transaction gives back the frames at the end of its
chain, and, like every transaction, writes all or nothing. Frames, terms and their design are
[FEA-027: mutations as queries](mbse:mbse-basis/docs/features/FEA-027.md) and
[CAP-138: mutation expressions over frame streams](mbse:mbse-basis/docs/capabilities/CAP-138.md).

## The terms

*Why*: a query written as terms over frames is data, run the same by every store, and a map works on each frame alone,
so a transaction can be sharded and run in parallel
([CAP-144: transactions sharded and run in parallel](mbse:mbse-basis/docs/capabilities/CAP-144.md)). *How*: a
transaction starts from one empty frame. `mutations` takes its first term, and each term's `then` takes the next, each
a list of one entry callback whose call chooses the term (`map`, `upsert`, `update`, `reduce`, `partition`). Any term
may come first, except that a term may refer only to symbols that a term before it binds; a symbol a frame already
binds keeps its object.

- **`map`** (`symbols([pattern])`, `then`) binds each symbol the frame lacks, in the order declared, to every object of
  the symbol's schema that the store reaches from its singletons, one frame for each match where the spec holds. A map
  with no spec gives the cross product.
  - Python: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.2) · TypeScript: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.2)
  - Python: [TXN-07: Map and update](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-07) · TypeScript: [TXN-07: Map and update](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-07)
- **`upsert`** (`key`, `exists([pattern])`, `then`) binds symbols as a map does; where it finds nothing, it creates the
  object, and then writes the spec wherever it does not hold. Installs are upserts, and so is every document.
  [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md).
  - Python: [T10.1: A transaction as an expression](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.1) · TypeScript: [T10.1: A transaction as an expression](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.1)
  - Python: [T10.6: Writing from frames](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.6) · TypeScript: [T10.6: Writing from frames](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.6)
- **`update`** (`apply([pattern])`, `then`) writes its spec over each frame where it does not hold; every symbol it
  names must already be bound.
  - Python: [T10.6: Writing from frames](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.6) · TypeScript: [T10.6: Writing from frames](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.6)
- **`reduce`** (`symbols([collector])`, `then`) drops the collector's symbols and keeps each remaining frame once.
  **`partition`** (`branches`, `first`, `last`, `none`, `then`) runs every branch, or only the first or the last
  (`first`, `last`), or `none` where it has no branches, and joins the frames they end with.
  - Python: [T10.5: Reduce and partition](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.5) · TypeScript: [T10.5: Reduce and partition](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.5)
  - Python: [TXN-08: Reduce and partition](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-08) · TypeScript: [TXN-08: Reduce and partition](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-08)

`store.transaction` gives back the frames its chain ends with, each a mapping from symbol to object: with no terms,
one empty frame; where nothing matches, none. A transaction can be built first, with
`store.Mutations.OfTransaction(...)`, then run, or written out as a journal's entry
([serialization.md](serialization.md)).

## Patterns

A pattern's `symbols` maps each symbol name to one of these
([CAP-137: patterns of symbols, variables and specs](mbse:mbse-basis/docs/capabilities/CAP-137.md)):

- **A schema**: the symbol ranges over that schema's objects, every object of a reference object schema that the store
  reaches, or every named schema of a meta-schema's kind (as installs do).
  - Python: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.2) · TypeScript: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.2)
- **A singleton's schema**: the symbol binds the singleton itself, with no spec needed.
  - Python: [T10.3: Following an adjacency](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.3) · TypeScript: [T10.3: Following an adjacency](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.3)
- **A reference**, made by `References.of(store, x)` or read from a request: the symbol binds the one object the
  reference designates, or none, and its spec writes that object's schema's members. Where the store holds nothing
  there, a map gives no frame and an upsert creates nothing; the spec is still written, by the schema the reference's
  path implies, so that a store holding only the schemas (a client's) writes it and the store holding the data runs
  it. A path the schemas cannot follow is refused when the spec is written.
  [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md).
  - Python: [T10.3: Following an adjacency](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.3) · TypeScript: [T10.3: Following an adjacency](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.3)
  - Python: [REF-09: A pattern's symbol given a reference in place of a schema](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-09) · TypeScript: [REF-09: A pattern's symbol given a reference in place of a schema](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-09)

A symbol has exactly one of a schema and a reference.

## The spec

`spec([...])` takes callbacks, one per item, each given the frame, whose symbols take the builders' calls for the
objects they bind. In a map the spec filters; in an upsert or an update it is written. Either way it means the same,
and its items apply in order ([CAP-143: specs declarative, no read-modify-write](mbse:mbse-basis/docs/capabilities/CAP-143.md)):

- **Property values**: a property given a value holds where it has that value; given none (`None`, `null`), where it
  is absent, and writing it clears the property.
  - Python: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.2) · TypeScript: [T10.2: Map: symbols ranging over a schema's objects](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.2)
  - Python: [T10.4: Absence as a filter](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.4) · TypeScript: [T10.4: Absence as a filter](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.4)
- **Entries, only through an object's named adjacency**: a list of linked symbols (the peer shorthand), or entry
  callbacks setting links and properties; for a keyed adjacency, a mapping from key to entry. A linked object may be
  defined in place, and in a map that matches *through* one. A counted object is linked through a symbol that binds
  it, never as the object itself.
  - Python: [T10.3: Following an adjacency](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.3) · TypeScript: [T10.3: Following an adjacency](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.3)
  - Python: [TXN-02: Mappings for keyed adjacencies](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-02) · TypeScript: [TXN-02: Mappings for keyed adjacencies](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-02)
- **Absence**: an adjacency's `remove`, given an entry, removes every entry agreeing with it, and `clear` removes
  every entry. Either holds where what it removes is already absent: a map binds the objects that lack the entry, and
  run again it writes nothing. Removing an owning entry deletes what it owns. An entry's property may be cleared, but
  not its link. [CAP-140: entries removed through a spec](mbse:mbse-basis/docs/capabilities/CAP-140.md).
  - Python: [T10.4: Absence as a filter](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.4) · TypeScript: [T10.4: Absence as a filter](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.4)
  - Python: [TXN-14: Removing entries through a spec](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-14) · TypeScript: [TXN-14: Removing entries through a spec](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-14)

## Handing frames on

- `References.of(store, frame)` gives a frame's reference, the reference of each object it binds, which a response
  can carry and `References.resolve(store, ref)` turns back into the frame; each can start a query of its own, as a
  symbol's reference. A relation entry has a reference too, and every reference is written and read as any value is.
  - Python: [T10.7: Handing frames on](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.7) · TypeScript: [T10.7: Handing frames on](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.7)
  - Python: [REF-05: A frame a transaction gave back: each symbol's object, resolved to the frame](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-05) · TypeScript: [REF-05: A frame a transaction gave back: each symbol's object, resolved to the frame](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-05)
  - Python: [REF-04: A relation entry by its relation's path and all its links and properties](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-04) · TypeScript: [REF-04: A relation entry by its relation's path and all its links and properties](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-04)
  - Python: [REF-07: A reference written and read back as a value](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-07) · TypeScript: [REF-07: A reference written and read back as a value](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-07)
- A frame can act as a *witness*, carrying the property values an object holds and the relation entries that make it
  hold, each object given by its reference. The executor's frames carry neither; a service writes them
  ([CAP-131: frames witness values and entries](mbse:mbse-basis/docs/capabilities/CAP-131.md)).
  - Python: [REF-08: A frame as a witness](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-08) · TypeScript: [REF-08: A frame as a witness](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-08)
- **A counted object has no reference**, an upsert's included, nor a frame or an entry that binds or links one. A map
  finds only what the store reaches from its singletons. To designate an object, make it a singleton's or an owner's
  ([CAP-133: no durable references to counted objects](mbse:mbse-basis/docs/capabilities/CAP-133.md)).
  - Python: [REF-03: A counted object has no reference, nor a frame that binds one](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-03) · TypeScript: [REF-03: A counted object has no reference, nor a frame that binds one](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-03)

## Limits and traps

- **Entries change only through an object's named adjacency.** There is no relation-level verb; an anonymous adjacency
  is not a member, so a spec cannot write it.
  - Python: [VAL-15: An anonymous adjacency lets an object fill a link, with no member and nothing held](mbse:mbse-schemas/python3/tests/08_Validators.ipynb#VAL-15) · TypeScript: [VAL-15: An anonymous adjacency lets an object fill a link, with no member and nothing held](mbse:mbse-schemas/typescript5/tests/08_Validators.ipynb#VAL-15)
- **No expressions yet.** Until mbse-expressions evaluates them
  ([CAP-142: expressions evaluated in queries](mbse:mbse-basis/docs/capabilities/CAP-142.md)), the executor refuses
  `requires`, variables, a reduce that collects and a partition both `first` and `last`, before writing anything.
  Filter by spec, or in your own code over the frames given back.
  - Python: [T10.8: What it does not do yet](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.8) · TypeScript: [T10.8: What it does not do yet](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.8)
  - Python: [TXN-09: What a transaction refuses before it runs (a symbol no term before binds](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-09) · TypeScript: [TXN-09: What a transaction refuses before it runs (a symbol no term before binds](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-09)
- **A change to an existing schema is seen only at commit.** A transaction that adds a property to a schema writes no
  object with that property: write the data in a second transaction
  ([CAP-124: writes all-or-nothing in transactions](mbse:mbse-basis/docs/capabilities/CAP-124.md)).
  - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
  - Python: [TXN-05: A transaction's proposals](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-05) · TypeScript: [TXN-05: A transaction's proposals](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-05)
- **A spec that clears and then inserts does not hold afterward**, so it writes again on every run, and the store ends
  the same ([CAP-174: a spec that clears then inserts holds when re-run](mbse:mbse-basis/docs/capabilities/CAP-174.md)).
  - Python: [TXN-14: Removing entries through a spec](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-14) · TypeScript: [TXN-14: Removing entries through a spec](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-14)
- **An upsert finds an object by its identity, never by a property that may change.** Name what it must find again
  as a singleton, or as an owned object by its owner and key (its owner's symbol, and a spec inserting the owner's
  entry under that key, linking the object's symbol), or by its reference, and write the rest. An upsert that finds an
  object by a property a later transaction changes finds nothing when a journal is replayed again, and makes a second
  one. A counted object has no identity: give what a journal must find again an owner or a singleton, and replay a
  journal in its order ([CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md)).
  - Python: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.3) · TypeScript: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.3)
  - Python: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/python3/tests/34_Provenance.ipynb#PRV-06) · TypeScript: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/typescript5/tests/34_Provenance.ipynb#PRV-06)
  - Python: [TXN-06: store.transaction](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-06) · TypeScript: [TXN-06: store.transaction](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-06)
- **No partial writes.** A transaction that raises, or that is refused when it ends (an owned object with no owner),
  writes nothing. Transactions on one store do not nest.
  - Python: [TXN-11: A transaction's imperative scope](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-11) · TypeScript: [TXN-11: A transaction's imperative scope](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-11)
